'use strict';
// ── Кирпич «Запись к мастеру» (детерминированный слой, БЕЗ AI) ───────────────
// Салоны/барбершопы/бьюти: услуги ↔ мастера ↔ недельный график → авто-окна.
// Раньше «Записаться» делалось через aiAction (свободный текст) и ловило мусор
// (service:"Записаться", master:"Назад"). Теперь всё кнопками, детерминированно.
//
// Схемы (заводятся автоматически для booking-ботов, ensureBookingSchemas):
//  • services       — name, description, price, duration(мин), masters(csv кто делает)
//  • masters        — name, specialization, services(csv), mon..sun("10:00-20:00"|""),
//                     slot_minutes(длина приёма, дефолт 60)
//  • master_services— master, service, price, duration  ← ПЕРЕОПРЕДЕЛЕНИЕ цены/длины
//                     у конкретного мастера (у услуги может быть общая цена, а тут
//                     своя). Пусто → берём цену/длину из services.
//  • bookings       — service, master, date(YYYY-MM-DD), time(HH:MM), name, phone,
//                     status, _tg_chat_id
//
// Свободные окна СЧИТАЮТСЯ на лету: недельные часы мастера − уже занятые брони.
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');
const { htmlEscape } = require('./telegramFormat');
const { fmtMoney } = require('./cart');

const S_SERVICES = 'services';
const S_MASTERS = 'masters';
const S_LINKS = 'master_services';
const S_BOOKINGS = 'bookings';

const DAY_FIELDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // index = Date.getUTCDay()
const DAY_RU = { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс' };
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_SLOT_MIN = 60;
const HORIZON_DAYS = 14; // на сколько дней вперёд показываем окна

// ── Схемы ───────────────────────────────────────────────────────────────────
async function ensureBookingSchemas(userId) {
  const want = {
    [S_SERVICES]: {
      label: 'Услуги', icon: '💅', color: '#ec4899',
      description: 'Услуги салона. «Цена»/«Длительность» — общие (мастер может переопределить в «Услуги мастеров»). «Кто делает» — имена мастеров через запятую (пусто = все).',
      fields: [
        { name: 'name', label: 'Название', type: 'text', required: true },
        { name: 'description', label: 'Описание', type: 'text' },
        { name: 'price', label: 'Цена', type: 'number' },
        { name: 'duration', label: 'Длительность, мин', type: 'number' },
        { name: 'masters', label: 'Кто делает (через запятую)', type: 'text' },
      ],
    },
    [S_MASTERS]: {
      label: 'Мастера', icon: '👩‍💼', color: '#8b5cf6',
      description: 'Сотрудники. График — часы работы по дням («10:00-20:00» или пусто = выходной). «Длина приёма» — шаг окон в минутах (по умолчанию 60).',
      fields: [
        { name: 'name', label: 'Имя', type: 'text', required: true },
        { name: 'specialization', label: 'Специализация', type: 'text' },
        { name: 'services', label: 'Услуги, которые делает (через запятую)', type: 'text' },
        { name: 'mon', label: 'Пн (10:00-20:00)', type: 'text' },
        { name: 'tue', label: 'Вт', type: 'text' },
        { name: 'wed', label: 'Ср', type: 'text' },
        { name: 'thu', label: 'Чт', type: 'text' },
        { name: 'fri', label: 'Пт', type: 'text' },
        { name: 'sat', label: 'Сб', type: 'text' },
        { name: 'sun', label: 'Вс', type: 'text' },
        { name: 'slot_minutes', label: 'Длина приёма, мин', type: 'number' },
      ],
    },
    [S_LINKS]: {
      label: 'Услуги мастеров (цены)', icon: '💰', color: '#f59e0b',
      description: 'Своя цена/длительность услуги у конкретного мастера (переопределяет общую из «Услуги»). Нужно только если у мастеров РАЗНЫЕ цены — иначе не заполняй.',
      fields: [
        { name: 'master', label: 'Мастер', type: 'text', required: true },
        { name: 'service', label: 'Услуга', type: 'text', required: true },
        { name: 'price', label: 'Цена', type: 'number' },
        { name: 'duration', label: 'Длительность, мин', type: 'number' },
      ],
    },
    [S_BOOKINGS]: {
      label: 'Записи клиентов', icon: '🗓', color: '#10b981',
      description: 'Записи, созданные ботом. Заполняются автоматически при записи клиента.',
      fields: [
        { name: 'service', label: 'Услуга', type: 'text' },
        { name: 'master', label: 'Мастер', type: 'text' },
        { name: 'date', label: 'Дата', type: 'text' },
        { name: 'time', label: 'Время', type: 'text' },
        { name: 'name', label: 'Клиент', type: 'text' },
        { name: 'username', label: 'Username', type: 'text' },
        { name: 'phone', label: 'Телефон', type: 'text' },
        { name: 'duration', label: 'Длительность, мин', type: 'number' },
        { name: 'status', label: 'Статус', type: 'text' },
      ],
    },
  };
  for (const [name, def] of Object.entries(want)) {
    let sd = await UserSchema.findOne({ userId, name });
    if (!sd) {
      await UserSchema.create({ userId, name, isActive: true, ...def }).catch(() => {});
    } else {
      const have = new Set((sd.fields || []).map((f) => f.name));
      const missing = def.fields.filter((f) => !have.has(f.name));
      if (missing.length) { sd.fields.push(...missing); sd.markModified('fields'); await sd.save().catch(() => {}); }
    }
  }
}

// ── Данные ──────────────────────────────────────────────────────────────────
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const csv = (s) => String(s || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

async function allServices(userId) {
  return UserRecord.find({ userId, schemaName: S_SERVICES }).sort({ createdAt: 1 }).lean().catch(() => []);
}
async function allMasters(userId) {
  return UserRecord.find({ userId, schemaName: S_MASTERS }).sort({ createdAt: 1 }).lean().catch(() => []);
}
async function serviceById(userId, id) {
  try { const { ObjectId } = require('mongodb'); return await UserRecord.findOne({ _id: new ObjectId(String(id)), userId, schemaName: S_SERVICES }).lean(); } catch { return null; }
}
async function masterById(userId, id) {
  try { const { ObjectId } = require('mongodb'); return await UserRecord.findOne({ _id: new ObjectId(String(id)), userId, schemaName: S_MASTERS }).lean(); } catch { return null; }
}

// Мастера, делающие услугу (по services.masters ИЛИ masters.services ИЛИ связке
// master_services). Если НИГДЕ связь не указана — считаем, что делают ВСЕ.
async function mastersForService(userId, svc) {
  const masters = await allMasters(userId);
  const svcName = norm(svc?.data?.name);
  const links = await UserRecord.find({ userId, schemaName: S_LINKS }).lean().catch(() => []);
  const linkMasters = new Set(links.filter((l) => norm(l.data?.service) === svcName).map((l) => norm(l.data?.master)));
  const svcMasterList = new Set(csv(svc?.data?.masters).map(norm));
  const anyLinkInfo = linkMasters.size > 0 || svcMasterList.size > 0 || masters.some((m) => csv(m.data?.services).length);
  const matched = masters.filter((m) => {
    const mName = norm(m.data?.name);
    if (linkMasters.has(mName)) return true;
    if (svcMasterList.has(mName)) return true;
    if (csv(m.data?.services).map(norm).includes(svcName)) return true;
    return false;
  });
  if (matched.length) return matched;
  return anyLinkInfo ? [] : masters; // связей нет вообще → делают все
}

// Услуги, которые делает мастер (обратная сторона).
async function servicesForMaster(userId, master) {
  const services = await allServices(userId);
  const mName = norm(master?.data?.name);
  const links = await UserRecord.find({ userId, schemaName: S_LINKS }).lean().catch(() => []);
  const linkSvcs = new Set(links.filter((l) => norm(l.data?.master) === mName).map((l) => norm(l.data?.service)));
  const mSvcList = new Set(csv(master?.data?.services).map(norm));
  const anyInfo = linkSvcs.size > 0 || mSvcList.size > 0 || services.some((s) => csv(s.data?.masters).length);
  const matched = services.filter((s) => {
    const sName = norm(s.data?.name);
    if (linkSvcs.has(sName)) return true;
    if (mSvcList.has(sName)) return true;
    if (csv(s.data?.masters).map(norm).includes(mName)) return true;
    return false;
  });
  if (matched.length) return matched;
  return anyInfo ? [] : services;
}

// Цена и длительность услуги у мастера: сначала связка master_services, иначе
// общая из services. Возвращает { price, duration }.
async function resolvePriceDuration(userId, svc, master) {
  const svcName = norm(svc?.data?.name);
  const mName = norm(master?.data?.name);
  let price = Number(svc?.data?.price) || 0;
  let duration = Number(svc?.data?.duration) || 0;
  if (mName) {
    const links = await UserRecord.find({ userId, schemaName: S_LINKS }).lean().catch(() => []);
    const l = links.find((x) => norm(x.data?.service) === svcName && norm(x.data?.master) === mName);
    if (l) {
      if (Number(l.data?.price) > 0) price = Number(l.data?.price);
      if (Number(l.data?.duration) > 0) duration = Number(l.data?.duration);
    }
  }
  return { price, duration };
}

// ── Время / слоты ─────────────────────────────────────────────────────────
function localNow(tzOffset = 3) { return new Date(Date.now() + tzOffset * 3600e3); }
function dateKey(d) { return d.toISOString().slice(0, 10); }             // YYYY-MM-DD (по сдвинутой дате)
function weekdayField(dateStr) { return DAY_FIELDS[new Date(dateStr + 'T12:00:00Z').getUTCDay()]; }
function fmtDateRu(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const wd = { 0: 'вс', 1: 'пн', 2: 'вт', 3: 'ср', 4: 'чт', 5: 'пт', 6: 'сб' }[d.getUTCDay()];
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} (${wd})`;
}
function toMin(hhmm) { const m = String(hhmm).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function minToHHMM(x) { return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; }

// Разбор рабочих часов дня: "10:00-20:00" → {start,end} в минутах. Пусто/выходной → null.
function parseHours(str) {
  const s = String(str || '').trim();
  if (!s || /вых|day off|off|-\s*$|^—$/i.test(s)) return null;
  const m = s.match(/(\d{1,2}[:.]?\d{0,2})\s*[-–—]\s*(\d{1,2}[:.]?\d{0,2})/);
  if (!m) return null;
  const norm2 = (t) => { t = t.replace('.', ':'); if (!t.includes(':')) t += ':00'; return toMin(t); };
  const start = norm2(m[1]); const end = norm2(m[2]);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function slotStarts(hours, slotMin) {
  if (!hours) return [];
  const step = Math.max(15, Number(slotMin) || DEFAULT_SLOT_MIN);
  const out = [];
  for (let t = hours.start; t + step <= hours.end; t += step) out.push(minToHHMM(t));
  return out;
}

// Длительность приёма — СЕРВИС-ЦЕНТРИЧНО: берётся из услуги (services.duration или
// переопределение мастера master_services), fallback — master.slot_minutes / 60.
// Именно на столько мастер занят после записи (17:00 на 60мин → 17:00–18:00 занято).
async function apptDuration(userId, svc, master) {
  let dur = 0;
  if (svc) dur = (await resolvePriceDuration(userId, svc, master)).duration;
  if (!dur) dur = Number(master?.data?.slot_minutes) || 0;
  return Math.max(15, dur || DEFAULT_SLOT_MIN);
}

// Свободные окна мастера на дату: график − ЗАНЯТЫЕ ИНТЕРВАЛЫ (по длительности услуги,
// без пересечений) − прошедшее (если сегодня). Шаг сетки = длительность услуги.
async function freeSlots(userId, master, dateStr, tzOffset = 3, svc = null) {
  if (!master) return [];
  const hours = parseHours(master.data?.[weekdayField(dateStr)]);
  if (!hours) return [];
  const dur = await apptDuration(userId, svc, master);
  const mName = norm(master.data?.name);
  const booked = await UserRecord.find({ userId, schemaName: S_BOOKINGS }).lean().catch(() => []);
  // Занятые интервалы: каждая бронь держит мастера [start, start + СВОЯ длительность).
  const busy = booked
    .filter((b) => norm(b.data?.master) === mName && String(b.data?.date) === dateStr && !/отмен|cancel/i.test(b.data?.status || ''))
    .map((b) => { const s = toMin(b.data?.time); return s == null ? null : [s, s + (Number(b.data?.duration) || dur)]; })
    .filter(Boolean);
  const overlaps = (s, e) => busy.some(([bs, be]) => s < be && bs < e);
  let starts = [];
  for (let t = hours.start; t + dur <= hours.end; t += dur) if (!overlaps(t, t + dur)) starts.push(minToHHMM(t));
  const today = dateKey(localNow(tzOffset));
  if (dateStr === today) {
    const nowMin = localNow(tzOffset).getUTCHours() * 60 + localNow(tzOffset).getUTCMinutes();
    starts = starts.filter((t) => toMin(t) > nowMin + 5);
  }
  return starts;
}

// Даты на горизонте, где у мастера (или любого из masters) есть свободное окно.
async function datesWithFreeSlots(userId, masters, tzOffset = 3, svc = null) {
  const out = [];
  const base = localNow(tzOffset);
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const ds = dateKey(new Date(base.getTime() + i * 86400e3));
    let has = false;
    for (const m of masters) { if ((await freeSlots(userId, m, ds, tzOffset, svc)).length) { has = true; break; } }
    if (has) out.push(ds);
  }
  return out;
}

// Мастера, свободные на конкретную дату (для шага выбора мастера).
async function mastersFreeOn(userId, masters, dateStr, tzOffset = 3, svc = null) {
  const out = [];
  for (const m of masters) { if ((await freeSlots(userId, m, dateStr, tzOffset, svc)).length) out.push(m); }
  return out;
}

// ── Рендеры (data → { text, keyboard: callback_data }) ──────────────────────
const BACK = (t = '⬅️ Назад') => [{ text: t, callback_data: 'Назад' }]; // выход в меню (контекстная «Назад»)
const clip = (s, n = 60) => String(s || '').slice(0, n);

// «Наши услуги» — список услуг кнопками, тап → карточка (bksvc:<id>).
async function renderServicesList(userId) {
  const services = await allServices(userId);
  if (!services.length) return { text: 'Услуги скоро появятся 🙂', keyboard: [BACK()] };
  const rows = services.map((s) => [{ text: clip(`${s.data?.name}${s.data?.price ? ` · ${fmtMoney(s.data.price, '₽')}` : ''}`), callback_data: `bksvc:${s._id}` }]);
  rows.push(BACK());
  return { text: '💅 <b>Наши услуги</b>\n\nВыберите услугу — покажу подробности и свободные окна:', keyboard: rows };
}

// Карточка услуги: описание, цена, кто делает, ближайшие окна + «Записаться к <мастер>».
async function renderServiceCard(userId, svcId, tzOffset = 3) {
  const svc = await serviceById(userId, svcId);
  if (!svc) return null;
  const masters = await mastersForService(userId, svc);
  const lines = [`💅 <b>${htmlEscape(svc.data?.name)}</b>`, ''];
  if (svc.data?.description) lines.push(htmlEscape(svc.data.description), '');
  const prices = [];
  for (const m of masters) { const pd = await resolvePriceDuration(userId, svc, m); if (pd.price) prices.push(pd.price); }
  const base = Number(svc.data?.price) || 0;
  const pool = prices.length ? prices : (base ? [base] : []);
  if (pool.length) {
    const min = Math.min(...pool); const max = Math.max(...pool);
    lines.push(min === max ? `💰 Цена: <b>${fmtMoney(min, '₽')}</b>` : `💰 Цена: <b>от ${fmtMoney(min, '₽')}</b>`);
  }
  if (svc.data?.duration) lines.push(`⏱ Длительность: ${htmlEscape(String(svc.data.duration))} мин`);
  if (masters.length) lines.push('', `👩‍💼 Делают: ${masters.map((m) => htmlEscape(m.data?.name)).join(', ')}`);
  const dates = await datesWithFreeSlots(userId, masters, tzOffset, svc);
  const near = [];
  for (const d of dates.slice(0, 2)) for (const m of masters) {
    const fs = await freeSlots(userId, m, d, tzOffset, svc);
    if (fs.length) near.push(`${fmtDateRu(d)} — ${htmlEscape(m.data?.name)}: ${fs.slice(0, 4).join(', ')}`);
  }
  if (near.length) lines.push('', '🕐 <b>Ближайшие окна:</b>', ...near.slice(0, 4));
  const rows = masters.map((m) => [{ text: clip(`📅 Записаться к ${m.data?.name}`), callback_data: `bkc:${svc._id}:${m._id}` }]);
  if (masters.length !== 1) rows.push([{ text: '📅 Записаться (любой мастер)', callback_data: `bkc:${svc._id}` }]);
  rows.push(BACK());
  return { text: lines.join('\n').slice(0, 3900), keyboard: rows };
}

// «Наши мастера» — список мастеров кнопками (bkmst:<id>).
async function renderMastersList(userId) {
  const masters = await allMasters(userId);
  if (!masters.length) return { text: 'Мастера скоро появятся 🙂', keyboard: [BACK()] };
  // В кнопке — ТОЛЬКО имя (специализация/детали внутри карточки, иначе обрезается).
  const rows = masters.map((m) => [{ text: clip(String(m.data?.name || 'Мастер')), callback_data: `bkmst:${m._id}` }]);
  rows.push(BACK());
  return { text: '👩‍💼 <b>Наши мастера</b>\n\nВыберите мастера — покажу услуги, график и окна:', keyboard: rows };
}

// Карточка мастера: специализация, услуги, график, свободные окна + «Записаться».
async function renderMasterCard(userId, mstId, tzOffset = 3) {
  const master = await masterById(userId, mstId);
  if (!master) return null;
  const services = await servicesForMaster(userId, master);
  const lines = [`👩‍💼 <b>${htmlEscape(master.data?.name)}</b>`];
  if (master.data?.specialization) lines.push(htmlEscape(master.data.specialization));
  lines.push('');
  if (services.length) lines.push(`💅 Услуги: ${services.map((s) => htmlEscape(s.data?.name)).join(', ')}`);
  const sched = DAY_ORDER.map((d) => { const h = String(master.data?.[d] || '').trim(); return `${DAY_RU[d]}: ${h && parseHours(h) ? htmlEscape(h) : 'выходной'}`; });
  lines.push('', '🗓 <b>График работы:</b>', ...sched);
  const dates = await datesWithFreeSlots(userId, [master], tzOffset);
  const near = [];
  for (const d of dates.slice(0, 3)) { const fs = await freeSlots(userId, master, d, tzOffset); if (fs.length) near.push(`${fmtDateRu(d)}: ${fs.slice(0, 5).join(', ')}`); }
  if (near.length) lines.push('', '🕐 <b>Свободные окна:</b>', ...near);
  const rows = [[{ text: clip(`📅 Записаться к ${master.data?.name}`), callback_data: `bkm:${master._id}` }], BACK()];
  return { text: lines.join('\n').slice(0, 3900), keyboard: rows };
}

// Визард записи (сессия хранит book = {svcId, mstId, date, time}). Возвращает
// следующий шаг по тому, что уже выбрано. Кнопки короткие (bkw:*) — состояние в сессии.
async function renderBookingStep(userId, book, tzOffset = 3) {
  book = book || {};
  const back = [{ text: '⬅️ Назад', callback_data: 'bkw:back' }];
  // 1) услуга
  if (!book.svcId) {
    let services;
    if (book.mstId) { const m = await masterById(userId, book.mstId); services = m ? await servicesForMaster(userId, m) : await allServices(userId); }
    else services = await allServices(userId);
    if (!services.length) return { text: 'Пока нет услуг для записи.', keyboard: [BACK()] };
    const rows = services.map((s) => [{ text: clip(`${s.data?.name}${s.data?.price ? ` · ${fmtMoney(s.data.price, '₽')}` : ''}`), callback_data: `bkw:s:${s._id}` }]);
    rows.push(BACK('⬅️ В меню'));
    return { text: '💇 <b>Запись</b>\n\nВыберите услугу:', keyboard: rows };
  }
  const svc = await serviceById(userId, book.svcId);
  if (!svc) { book.svcId = null; return renderBookingStep(userId, book, tzOffset); }
  const masters = await mastersForService(userId, svc);
  // 2) дата
  if (!book.date) {
    const pool = book.mstId ? masters.filter((m) => String(m._id) === String(book.mstId)) : masters;
    const dates = await datesWithFreeSlots(userId, pool, tzOffset, svc);
    if (!dates.length) return { text: `😔 На ближайшие ${HORIZON_DAYS} дней свободных окон на «${htmlEscape(svc.data?.name)}» нет. Загляните позже.`, keyboard: [back, BACK('⬅️ В меню')] };
    const rows = dates.map((d) => [{ text: fmtDateRu(d), callback_data: `bkw:d:${d.replace(/-/g, '')}` }]);
    rows.push(back);
    return { text: `💇 <b>${htmlEscape(svc.data?.name)}</b>\n\nВыберите дату:`, keyboard: rows };
  }
  // 3) мастер
  if (!book.mstId) {
    const free = await mastersFreeOn(userId, masters, book.date, tzOffset, svc);
    if (!free.length) { book.date = null; return renderBookingStep(userId, book, tzOffset); }
    const rows = [];
    for (const m of free) { const pd = await resolvePriceDuration(userId, svc, m); rows.push([{ text: clip(`${m.data?.name}${pd.price ? ` · ${fmtMoney(pd.price, '₽')}` : ''}`), callback_data: `bkw:m:${m._id}` }]); }
    rows.push(back);
    return { text: `💇 <b>${htmlEscape(svc.data?.name)}</b> · ${fmtDateRu(book.date)}\n\nВыберите мастера:`, keyboard: rows };
  }
  const master = await masterById(userId, book.mstId);
  if (!master) { book.mstId = null; return renderBookingStep(userId, book, tzOffset); }
  // 4) время
  if (!book.time) {
    const slots = await freeSlots(userId, master, book.date, tzOffset, svc);
    if (!slots.length) { book.mstId = null; return renderBookingStep(userId, book, tzOffset); }
    const rows = [];
    for (let i = 0; i < slots.length; i += 3) rows.push(slots.slice(i, i + 3).map((t) => ({ text: t, callback_data: `bkw:t:${t.replace(':', '')}` })));
    rows.push(back);
    return { text: `💇 <b>${htmlEscape(svc.data?.name)}</b>\n👩‍💼 ${htmlEscape(master.data?.name)} · ${fmtDateRu(book.date)}\n\nВыберите время:`, keyboard: rows };
  }
  // 5) подтверждение
  const pd = await resolvePriceDuration(userId, svc, master);
  const lines = ['✅ <b>Подтвердите запись:</b>', '',
    `💇 Услуга: <b>${htmlEscape(svc.data?.name)}</b>`,
    `👩‍💼 Мастер: <b>${htmlEscape(master.data?.name)}</b>`,
    `📅 Дата: <b>${fmtDateRu(book.date)}</b>`,
    `🕐 Время: <b>${htmlEscape(book.time)}</b>`];
  if (pd.price) lines.push(`💰 Стоимость: <b>${fmtMoney(pd.price, '₽')}</b>`);
  return { text: lines.join('\n'), keyboard: [[{ text: '✅ Записаться', callback_data: 'bkw:ok' }], back], confirm: true };
}

// Создаёт запись в bookings (детерминированно, из выбранного визарда). Хранит
// duration (для непересекающихся окон) и username (для связи с клиентом).
async function createBooking(userId, book, { name = '', username = '', phone = '', chatId = null } = {}) {
  const svc = await serviceById(userId, book.svcId);
  const master = await masterById(userId, book.mstId);
  if (!svc || !master || !book.date || !book.time) return null;
  const dur = await apptDuration(userId, svc, master);
  return UserRecord.create({
    userId, schemaName: S_BOOKINGS,
    data: { service: svc.data?.name || '', master: master.data?.name || '', date: book.date, time: book.time, duration: dur, name, username: String(username || '').replace(/^@+/, ''), phone, status: 'Новая', _tg_chat_id: chatId },
    metadata: { createdBy: 'user', source: 'telegram' },
  }).catch(() => null);
}

// YYYY-MM-DD → DD.MM.YYYY (для человекочитаемых уведомлений).
function fmtDateFull(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(dateStr || '');
}

// Чистая карточка записи ВЛАДЕЛЬЦУ (без эмодзи-мусора; клиент кликабелен — по
// tg://user и @username, т.к. по телефону сейчас общаются реже).
function renderOwnerBooking({ botUsername = '', service = '', master = '', date = '', time = '', name = '', username = '', tgId = '', phone = '' }) {
  const uname = username ? String(username).replace(/^@+/, '') : '';
  const clientName = htmlEscape(name || (uname ? '@' + uname : 'Клиент'));
  const client = tgId ? `<a href="tg://user?id=${tgId}">${clientName}</a>` : clientName;
  const lines = [
    `<b>Новая запись</b>${botUsername ? ` — @${botUsername}` : ''}`, '',
    `Услуга: ${htmlEscape(service)}`,
    `Мастер: ${htmlEscape(master)}`,
    `Когда: ${fmtDateFull(date)}, ${htmlEscape(String(time))}`,
    `Клиент: ${client}${uname ? ` (@${uname})` : ''}`,
  ];
  if (phone) lines.push(`Телефон: ${htmlEscape(phone)}`);
  return lines.join('\n');
}

// Текст-сводка записи для уведомления владельцу/подтверждения клиенту.
async function bookingSummary(userId, book) {
  const svc = await serviceById(userId, book.svcId);
  const master = await masterById(userId, book.mstId);
  const pd = svc && master ? await resolvePriceDuration(userId, svc, master) : { price: 0 };
  return { serviceName: svc?.data?.name || '', masterName: master?.data?.name || '', price: pd.price };
}

module.exports = {
  S_SERVICES, S_MASTERS, S_LINKS, S_BOOKINGS, DAY_RU, DAY_ORDER, HORIZON_DAYS,
  ensureBookingSchemas, allServices, allMasters, serviceById, masterById,
  mastersForService, servicesForMaster, resolvePriceDuration, apptDuration,
  freeSlots, datesWithFreeSlots, mastersFreeOn, parseHours,
  renderServicesList, renderServiceCard, renderMastersList, renderMasterCard,
  renderBookingStep, createBooking, bookingSummary, renderOwnerBooking,
  fmtDateRu, fmtDateFull, norm, csv,
};
