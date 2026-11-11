// ── Доставка (детерминированный серверный слой) ─────────────────────────────
// Единый источник правды — схема данных `delivery_settings` (label «Доставка»),
// ОДНА запись. Настраивается и в mini-app («Особые функции» / «База»), и промптом.
// Логика доставки в живом боте (часы работы, стоимость, «бесплатно от», мин.
// сумма, самовывоз, подтверждение админом) — детерминированная, НЕ зависит от
// генерации ИИ: активируется сама, когда у бота есть корзина/заказы. Поэтому
// генерацию ботов эта фича не трогает и не ломает.
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');

const DELIVERY_SCHEMA = 'delivery_settings';
const DELIVERY_LABEL = 'Доставка';

// Дефолты — как в примере владельца: «каждый день с 10:00 до 20:00».
const DEFAULTS = {
  enabled: true,
  days: 'Пн,Вт,Ср,Чт,Пт,Сб,Вс',
  hours_from: '10:00',
  hours_to: '22:00',
  tz_offset: 3,
  cost: 0,
  free_from: 0,
  min_order: 0,
  pickup: true,
  zone_text: '',
  zone_map_url: '',
  yandex_api_key: '',
};

const FIELDS = [
  { name: 'enabled',        label: 'Доставка включена',            type: 'boolean' },
  { name: 'days',           label: 'Дни доставки (через запятую)', type: 'text' },
  { name: 'hours_from',     label: 'Доставка с (ЧЧ:ММ)',           type: 'text' },
  { name: 'hours_to',       label: 'Доставка до (ЧЧ:ММ)',          type: 'text' },
  { name: 'tz_offset',      label: 'Часовой пояс (сдвиг от UTC, напр. 3=МСК)', type: 'number' },
  { name: 'cost',           label: 'Стоимость доставки, ₽',        type: 'number' },
  { name: 'free_from',      label: 'Бесплатно от суммы, ₽ (0 = выкл)', type: 'number' },
  { name: 'min_order',      label: 'Мин. сумма заказа, ₽ (0 = выкл)',  type: 'number' },
  { name: 'pickup',         label: 'Разрешить самовывоз',          type: 'boolean' },
  { name: 'zone_text',      label: 'Условия/зоны доставки (текст клиенту)', type: 'text' },
  { name: 'zone_map_url',   label: 'Ссылка на карту зон',          type: 'url' },
  { name: 'yandex_api_key', label: 'Yandex Geocoder API-ключ (опц.)', type: 'text' },
];

const DAY_BY_JS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; // getUTCDay: 0=Вс

async function ensureDeliverySchema(userId, { tzOffset } = {}) {
  let sd = await UserSchema.findOne({ userId, name: DELIVERY_SCHEMA });
  if (!sd) {
    sd = await UserSchema.create({
      userId, name: DELIVERY_SCHEMA, label: DELIVERY_LABEL, icon: '🚚', color: '#10b981',
      description: 'Настройки доставки: дни и часы работы, стоимость, бесплатная доставка от суммы, самовывоз, зоны. Одна запись — редактируйте её.',
      fields: FIELDS, isActive: true,
    }).catch(() => null);
  }
  let rec = await UserRecord.findOne({ userId, schemaName: DELIVERY_SCHEMA });
  if (!rec) {
    const data = { ...DEFAULTS };
    if (typeof tzOffset === 'number') data.tz_offset = tzOffset;
    rec = await UserRecord.create({
      userId, schemaName: DELIVERY_SCHEMA, data,
      metadata: { createdBy: 'user', source: 'telegram' },
    }).catch(() => null);
  }
  return rec;
}

// Возвращает конфиг доставки (данные записи, слитые с дефолтами) или null, если
// доставка вообще не настроена (схемы нет — значит бот без доставки).
async function getDeliveryConfig(userId) {
  const rec = await UserRecord.findOne({ userId, schemaName: DELIVERY_SCHEMA }).lean().catch(() => null);
  if (!rec) return null;
  const cfg = { ...DEFAULTS, ...(rec.data || {}) };
  // Числа могут прийти строкой из формы/базы — нормализуем.
  for (const k of ['cost', 'free_from', 'min_order', 'tz_offset']) cfg[k] = Number(cfg[k]) || 0;
  cfg.enabled = cfg.enabled !== false && cfg.enabled !== 'false' && cfg.enabled !== 0;
  cfg.pickup = cfg.pickup !== false && cfg.pickup !== 'false' && cfg.pickup !== 0;
  return cfg;
}

function parseHM(s) {
  const m = String(s || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
}

// Работает ли доставка ПРЯМО СЕЙЧАС (по дню недели и часам в поясе владельца).
// Возвращает { open, reason, today, from, to }.
function isDeliveryOpenNow(cfg, now = new Date()) {
  if (!cfg || !cfg.enabled) return { open: false, reason: 'Доставка временно недоступна.' };
  const local = new Date(now.getTime() + (Number(cfg.tz_offset) || 0) * 3600 * 1000);
  const todayRu = DAY_BY_JS[local.getUTCDay()];
  const daysList = String(cfg.days || '')
    .split(/[,;\s]+/).map((d) => d.trim().slice(0, 2).toLowerCase()).filter(Boolean);
  const dayOk = !daysList.length || daysList.includes(todayRu.toLowerCase());
  if (!dayOk) return { open: false, reason: `Сегодня (${todayRu}) доставки нет.`, today: todayRu };
  const from = parseHM(cfg.hours_from);
  const to = parseHM(cfg.hours_to);
  if (from == null || to == null) return { open: true, today: todayRu }; // часы не заданы — считаем открытой
  const cur = local.getUTCHours() * 60 + local.getUTCMinutes();
  const open = to > from ? (cur >= from && cur < to) : (cur >= from || cur < to); // через полночь
  return {
    open,
    reason: open ? '' : `Доставка работает ${cfg.hours_from}–${cfg.hours_to}. Заказ примем, привезём в рабочие часы.`,
    today: todayRu, from: cfg.hours_from, to: cfg.hours_to,
  };
}

// Стоимость доставки для суммы заказа и способа получения ('pickup' | 'delivery').
function computeDeliveryFee(cfg, subtotal, mode = 'delivery') {
  if (!cfg || mode === 'pickup') return 0;
  const st = Number(subtotal) || 0;
  if (cfg.free_from > 0 && st >= cfg.free_from) return 0;
  return Number(cfg.cost) || 0;
}

// Проходит ли заказ по минимальной сумме. { ok, min }.
function checkMinOrder(cfg, subtotal) {
  const min = Number(cfg?.min_order) || 0;
  return { ok: !min || (Number(subtotal) || 0) >= min, min };
}

// Короткая человекочитаемая сводка условий (для клиента и превью).
function deliveryTerms(cfg) {
  if (!cfg || !cfg.enabled) return '';
  const parts = [];
  if (cfg.free_from > 0) parts.push(`бесплатно от ${cfg.free_from} ₽`);
  if (cfg.cost > 0) parts.push(`доставка ${cfg.cost} ₽`);
  else if (cfg.free_from <= 0) parts.push('доставка бесплатная');
  if (cfg.min_order > 0) parts.push(`мин. заказ ${cfg.min_order} ₽`);
  const hours = (cfg.hours_from && cfg.hours_to) ? `${cfg.days || 'ежедневно'} ${cfg.hours_from}–${cfg.hours_to}` : '';
  let s = parts.join(', ');
  if (hours) s += (s ? '. ' : '') + hours;
  if (cfg.zone_text) s += (s ? '\n' : '') + cfg.zone_text;
  return s;
}

module.exports = {
  DELIVERY_SCHEMA, DELIVERY_LABEL, DEFAULTS, FIELDS,
  ensureDeliverySchema, getDeliveryConfig,
  isDeliveryOpenNow, computeDeliveryFee, checkMinOrder, deliveryTerms,
};
