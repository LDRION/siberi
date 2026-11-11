// ── Монетизация бота владельца (приём оплаты ОТ клиентов бота) ───────────────
// Это НЕ оплата подписки нам — это продажи ВНУТРИ бота владельца: премиум-доступ
// и платные товары. Оплата идёт на кошелёк/счёт ВЛАДЕЛЬЦА, не наш.
//
// Как связано: бот строит платёжную ссылку (сейчас — ЮMoney quickpay на кошелёк
// владельца) с меткой `<chatId>_pf_<code>_<ts>`. Клиент платит → ЮMoney шлёт
// HTTP-уведомление на наш per-bot вебхук (тот же, что в «Особые функции») →
// сервер по метке понимает КТО и ЧТО купил → выдаёт (премиум-доступ/товар).
//
// Источник правды — схемы данных (как доставка/баннеры): `paid_settings` (одна
// запись — кошелёк, цена/срок премиума, валюта), `paid_products` (платные
// товары владельца), `entitlements` (что кому выдано). Всё видно и правится в
// «Базе» и mini-app. Архитектура под ЮKassa API — поля уже заложены.
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');

const SETTINGS_SCHEMA = 'paid_settings';
const PRODUCTS_SCHEMA = 'paid_products';
const ENTITLEMENTS_SCHEMA = 'entitlements';

const SETTINGS_DEFAULTS = {
  enabled: false,
  provider: 'yoomoney',          // 'yoomoney' | 'yookassa' (последнее — позже)
  yoomoney_wallet: '',
  yookassa_shop_id: '',          // задел под ЮKassa API
  yookassa_secret: '',
  currency: '₽',
  premium_enabled: false,
  premium_title: 'Премиум',
  premium_price: 0,
  premium_days: 0,               // 0 = навсегда, иначе подписка на N дней
  premium_desc: 'Доступ к премиум-разделам бота.',
  success_text: 'Оплата получена — спасибо! Доступ открыт. 🎉',
  gate_ai: false,       // ИИ-ответы только по премиуму
  free_ai_uses: 0,      // сколько ИИ-ответов бесплатно до премиума
};

const SETTINGS_FIELDS = [
  { name: 'enabled',         label: 'Приём оплаты включён',          type: 'boolean' },
  { name: 'provider',        label: 'Платёжная система',             type: 'text' },
  { name: 'yoomoney_wallet', label: 'Номер кошелька ЮMoney',         type: 'text', description: 'Куда клиенты платят (кошелёк владельца). Пример: 4100xxxxxxxxxx.' },
  { name: 'yookassa_shop_id',label: 'ЮKassa shopId (опц.)',          type: 'text' },
  { name: 'yookassa_secret', label: 'ЮKassa секретный ключ (опц.)',  type: 'text' },
  { name: 'currency',        label: 'Валюта',                        type: 'text' },
  { name: 'premium_enabled', label: 'Продавать премиум-доступ',      type: 'boolean' },
  { name: 'premium_title',   label: 'Название премиума',             type: 'text' },
  { name: 'premium_price',   label: 'Цена премиума',                 type: 'number' },
  { name: 'premium_days',    label: 'Срок премиума, дней (0=навсегда)', type: 'number' },
  { name: 'premium_desc',    label: 'Что даёт премиум',              type: 'text' },
  { name: 'success_text',    label: 'Сообщение после оплаты',        type: 'text' },
  { name: 'gate_ai',         label: 'ИИ-ответы только по премиуму',  type: 'boolean' },
  { name: 'free_ai_uses',    label: 'Бесплатных ИИ-ответов до премиума', type: 'number' },
];

const PRODUCT_FIELDS = [
  { name: 'title',        label: 'Название',          type: 'text', required: true },
  { name: 'price',        label: 'Цена',              type: 'number', required: true },
  { name: 'deliver_text', label: 'Что выдать (текст/ссылка/код)', type: 'text' },
  { name: 'deliver_file', label: 'Файл для выдачи',   type: 'file' },
];

const ENTITLEMENT_FIELDS = [
  { name: 'customer',   label: 'Клиент',       type: 'text' },
  { name: 'tg_id',      label: 'Telegram ID',  type: 'text' },
  { name: 'kind',       label: 'Тип',          type: 'text' },   // 'premium' | 'product'
  { name: 'item',       label: 'Что куплено',  type: 'text' },
  { name: 'amount',     label: 'Сумма',        type: 'number' },
  { name: 'paid_at',    label: 'Оплачено',     type: 'date' },
  { name: 'expires_at', label: 'Действует до', type: 'date' },
  { name: 'status',     label: 'Статус',       type: 'text' },
];

async function ensureSchema(userId, name, label, icon, fields, description) {
  let sd = await UserSchema.findOne({ userId, name });
  if (!sd) sd = await UserSchema.create({ userId, name, label, icon, color: '#f59e0b', description, fields, isActive: true }).catch(() => null);
  return sd;
}

// Заводит все схемы монетизации + одну запись настроек (идемпотентно).
async function ensurePaidSchemas(userId) {
  await ensureSchema(userId, SETTINGS_SCHEMA, 'Оплата в боте', '💠', SETTINGS_FIELDS, 'Настройки приёма оплаты от клиентов бота: кошелёк, премиум-доступ. Одна запись.');
  await ensureSchema(userId, PRODUCTS_SCHEMA, 'Платные товары', '🛍', PRODUCT_FIELDS, 'Цифровые/платные товары бота: название, цена, что выдать после оплаты.');
  await ensureSchema(userId, ENTITLEMENTS_SCHEMA, 'Покупки клиентов', '🔓', ENTITLEMENT_FIELDS, 'Кому что выдано после оплаты (премиум-доступ, товары).');
  let rec = await UserRecord.findOne({ userId, schemaName: SETTINGS_SCHEMA });
  if (!rec) rec = await UserRecord.create({ userId, schemaName: SETTINGS_SCHEMA, data: { ...SETTINGS_DEFAULTS }, metadata: { createdBy: 'user', source: 'telegram' } }).catch(() => null);
  return rec;
}

async function getPaidSettings(userId) {
  const rec = await UserRecord.findOne({ userId, schemaName: SETTINGS_SCHEMA }).lean().catch(() => null);
  if (!rec) return null;
  const s = { ...SETTINGS_DEFAULTS, ...(rec.data || {}) };
  for (const k of ['premium_price', 'premium_days', 'free_ai_uses']) s[k] = Number(s[k]) || 0;
  s.enabled = s.enabled === true || s.enabled === 'true';
  s.premium_enabled = s.premium_enabled === true || s.premium_enabled === 'true';
  s.gate_ai = s.gate_ai === true || s.gate_ai === 'true';
  return s;
}

// Готов ли приём оплаты (включён и есть куда платить).
function isPaymentReady(s) {
  return !!(s && s.enabled && ((s.provider === 'yoomoney' && s.yoomoney_wallet) || (s.provider === 'yookassa' && s.yookassa_shop_id)));
}

// Ссылка на оплату. code: 'premium' | <id товара>. Метка кодирует клиента и товар.
function buildPayLink(s, { chatId, code, amount, title }) {
  const label = `${chatId}_pf_${code}_${Date.now()}`;
  if (s.provider === 'yoomoney' && s.yoomoney_wallet) {
    const target = encodeURIComponent(`${title || 'Оплата'} в боте`);
    return { url: `https://yoomoney.ru/quickpay/confirm?receiver=${encodeURIComponent(s.yoomoney_wallet)}&quickpay-form=shop&targets=${target}&paymentType=AC&sum=${amount}&label=${encodeURIComponent(label)}`, label };
  }
  // ЮKassa API — задел (создание платежа добавим позже); пока без ссылки.
  return { url: '', label };
}

const PAID_LABEL_RE = /^(-?\d{4,})_pf_([A-Za-z0-9]+)_\d+$/;
function parsePaidLabel(label) {
  const m = String(label || '').match(PAID_LABEL_RE);
  return m ? { chatId: m[1], code: m[2] } : null;
}

// Выдаёт покупку клиенту: пишет запись в entitlements. Для премиума с сроком —
// продлевает от текущей даты окончания. Возвращает созданную/обновлённую запись.
async function grantEntitlement(userId, { chatId, tgId, customer, kind, item, amount, days = 0 }) {
  await ensurePaidSchemas(userId);
  const now = new Date();
  let expires = null;
  if (kind === 'premium' && days > 0) {
    // Если премиум уже активен — продлеваем от его окончания.
    const active = await UserRecord.findOne({ userId, schemaName: ENTITLEMENTS_SCHEMA, 'data._tg_chat_id': chatId, 'data.kind': 'premium', 'data.status': 'active' }).sort({ createdAt: -1 }).lean().catch(() => null);
    const base = active?.data?.expires_at && new Date(active.data.expires_at) > now ? new Date(active.data.expires_at) : now;
    expires = new Date(base.getTime() + days * 86400000);
  }
  const rec = await UserRecord.create({
    userId, schemaName: ENTITLEMENTS_SCHEMA,
    data: {
      customer: customer || '', tg_id: String(tgId || chatId), kind, item: item || kind,
      amount: Number(amount) || 0, paid_at: now, expires_at: expires, status: 'active',
      _tg_chat_id: typeof chatId === 'string' && /^-?\d+$/.test(chatId) ? Number(chatId) : chatId,
    },
    metadata: { createdBy: 'ai', source: 'api' },
  }).catch((e) => { console.warn('grantEntitlement:', e.message); return null; });
  return { rec, expires };
}

// Есть ли у клиента активный премиум-доступ.
async function hasActivePremium(userId, chatId) {
  const now = new Date();
  const rec = await UserRecord.findOne({ userId, schemaName: ENTITLEMENTS_SCHEMA, 'data._tg_chat_id': chatId, 'data.kind': 'premium', 'data.status': 'active' }).sort({ createdAt: -1 }).lean().catch(() => null);
  if (!rec) return false;
  const exp = rec.data?.expires_at;
  return !exp || new Date(exp) > now; // без срока = навсегда
}

module.exports = {
  SETTINGS_SCHEMA, PRODUCTS_SCHEMA, ENTITLEMENTS_SCHEMA,
  SETTINGS_DEFAULTS, SETTINGS_FIELDS, PRODUCT_FIELDS,
  ensurePaidSchemas, getPaidSettings, isPaymentReady,
  buildPayLink, parsePaidLabel, grantEntitlement, hasActivePremium,
};
