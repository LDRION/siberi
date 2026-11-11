'use strict';
// ── Кирпич «Карточка товара с добавками» (детерминированный слой, без AI) ──
// Категория → товары кнопками → карточка (состав/цена/категория) → добавки «−/+»
// (максимум 1 каждой) → «В корзину». Добавки берутся из схемы product_extras по
// категории товара. В корзину кладётся «запечённая» строка (Чизбургер + доп. сыр,
// цена = база + добавки) обычной позицией — корзина/оформление/заказ не меняются.
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');
const { htmlEscape } = require('./telegramFormat');
const { fmtMoney } = require('./cart');
const { getBanner } = require('./banners');

const EXTRAS_SCHEMA = 'product_extras';

// Ключ баннера карточки товара в схеме «Баннеры»: card:<recordId>. Позволяет
// прикрепить свою картинку к КОНКРЕТНОЙ карточке (как баннер к любому экрану
// меню). recordId стабилен, с подписями команд не пересекается.
function cardBannerKey(recordId) { return 'card:' + String(recordId); }

async function ensureExtrasSchema(userId) {
  let sd = await UserSchema.findOne({ userId, name: EXTRAS_SCHEMA });
  if (!sd) {
    sd = await UserSchema.create({
      userId, name: EXTRAS_SCHEMA, label: 'Доп-ингредиенты', icon: '🧀', color: '#f59e0b',
      description: 'Модификаторы товара. Тип "add" — платная добавка (сыр, соус: +цена). Тип "remove" — убрать стандартный ингредиент (лук, без цены). «Категория товаров» — к каким позициям применять (пусто = ко всем).',
      fields: [
        { name: 'name', label: 'Название', type: 'text', required: true },
        { name: 'price', label: 'Цена', type: 'number', required: false },
        { name: 'category', label: 'Категория товаров', type: 'text', required: false },
        { name: 'type', label: 'Тип', type: 'text', required: false, description: 'add — платная добавка (+цена); remove — убрать стандартный ингредиент (бесплатно). Пусто = add.' },
      ],
      isActive: true,
    }).catch(() => null);
  } else if (!(sd.fields || []).some((f) => f.name === 'type')) {
    // Бэкфилл поля "type" в уже существующую схему (появилось с удаляемыми
    // ингредиентами) — чтобы у старых productCard-ботов оно тоже было в «Базе».
    sd.fields.push({ name: 'type', label: 'Тип', type: 'text', required: false, description: 'add — платная добавка (+цена); remove — убрать стандартный ингредиент (бесплатно). Пусто = add.' });
    sd.markModified('fields');
    await sd.save().catch(() => {});
  }
  return sd;
}

// Тип модификатора: 'remove' (убрать стандартный ингредиент, бесплатно) или 'add'
// (платная добавка). Терпимо к формулировкам ИИ (remove/убрать/удалить/без).
function modType(raw) {
  return /^\s*(rem|убр|удал|без|minus|снят)/i.test(String(raw || '')) ? 'remove' : 'add';
}

// Модификаторы, применимые к товару категории `category`: категория пустая (ко
// всем) ЛИБО совпадает с категорией товара. Стабильный порядок по createdAt.
// Каждый несёт .type ('add' | 'remove'); у 'remove' цена принудительно 0.
async function applicableExtras(userId, category) {
  const all = await UserRecord.find({ userId, schemaName: EXTRAS_SCHEMA }).sort({ createdAt: 1 }).lean().catch(() => []);
  const cat = String(category || '').trim().toLowerCase();
  return all
    .filter((e) => { const ec = String(e.data?.category || '').trim().toLowerCase(); return !ec || ec === cat; })
    .map((e) => {
      const type = modType(e.data?.type);
      return { id: String(e._id), name: String(e.data?.name || 'Добавка'), price: type === 'remove' ? 0 : (Number(e.data?.price) || 0), type };
    });
}

// Достаёт товар и его поля (title/price/category/детали) из записи каталога.
// schemaName опционален — если не задан (потеря сессии), ищем запись по _id.
async function loadItem(userId, recordId, schemaName = null) {
  const { ObjectId } = require('mongodb');
  let rec = null;
  try {
    const q = { _id: new ObjectId(String(recordId)), userId };
    if (schemaName) q.schemaName = schemaName;
    rec = await UserRecord.findOne(q).lean();
  } catch {}
  if (!rec) return null;
  const sd = await UserSchema.findOne({ userId, name: rec.schemaName }).lean();
  const fields = (sd?.fields || []).filter((f) => !f.name.startsWith('_') && f.type !== 'image' && f.type !== 'file');
  const titleField = fields[0];
  const priceField = fields.find((f) => /цена|price|cost|стоим|сумм|amount/i.test(`${f.name} ${f.label || ''}`)) || fields.find((f) => f.type === 'number');
  const catField = fields.find((f) => /категор|category|раздел|тип/i.test(`${f.name} ${f.label || ''}`));
  const data = rec.data || {};
  const detailFields = fields.filter((f) => f !== titleField && f !== priceField && f !== catField).slice(0, 4);
  return {
    id: String(rec._id),
    schemaName: rec.schemaName,
    title: String(data[titleField?.name] ?? 'Товар'),
    price: priceField ? Number(String(data[priceField.name]).replace(/[^\d.]/g, '')) || 0 : 0,
    category: catField ? String(data[catField.name] || '') : '',
    catLabel: catField?.label || 'Категория',
    details: detailFields.map((f) => ({ label: f.label || f.name, value: data[f.name] })).filter((d) => d.value != null && d.value !== ''),
  };
}

// Рендер карточки → { text, keyboard, item, extras, total } или null.
// selectedIdx — массив/Set индексов выбранных добавок (в порядке applicableExtras).
async function renderCard(userId, recordId, selectedIdx, cur = '₽', schemaName = null) {
  const item = await loadItem(userId, recordId, schemaName);
  if (!item) return null;
  // Свой баннер карточки (если владелец залил картинку, стоя на этой карточке).
  const banner = await getBanner(userId, cardBannerKey(item.id)).catch(() => null);
  const mods = await applicableExtras(userId, item.category); // плоский список, у каждого .type
  const sel = selectedIdx instanceof Set ? selectedIdx : new Set((selectedIdx || []).map(Number));

  // Платные добавки (type=add) увеличивают цену; убранные ингредиенты (type=remove)
  // бесплатны — цена НЕ уменьшается (бургер без лука стоит столько же).
  let total = item.price;
  mods.forEach((e, i) => { if (e.type !== 'remove' && sel.has(i)) total += e.price; });

  const lines = [`🛍 <b>${htmlEscape(item.title)}</b>`, ''];
  for (const d of item.details) lines.push(`${htmlEscape(d.label)}: ${htmlEscape(String(d.value))}`);
  if (item.category) lines.push(`${htmlEscape(item.catLabel)}: ${htmlEscape(item.category)}`);
  lines.push(`Цена: <b>${fmtMoney(item.price, cur)}</b>`);

  const rows = [];
  const additions = mods.map((e, i) => ({ e, i })).filter((x) => x.e.type !== 'remove');
  const removals  = mods.map((e, i) => ({ e, i })).filter((x) => x.e.type === 'remove');

  // ОДНА кнопка = один тумблер (в столбик): тап ставит/снимает ✅. Никаких
  // отдельных «−/+» — вся позиция кликабельна целиком.
  if (additions.length) {
    lines.push('', '➕ <b>Добавки</b> — нажми, чтобы добавить:');
    for (const { e, i } of additions) {
      const on = sel.has(i);
      rows.push([{ text: `${on ? '✅ ' : ''}${e.name} +${e.price}${cur}`, callback_data: `tglbex:${recordId}:${i}:t` }]);
    }
  }
  if (removals.length) {
    lines.push('', '➖ <b>Убрать из состава</b> (бесплатно) — нажми, чтобы убрать:');
    for (const { e, i } of removals) {
      const on = sel.has(i);
      rows.push([{ text: `${on ? '✅ ' : ''}${e.name}`, callback_data: `tglbex:${recordId}:${i}:t` }]);
    }
  }
  if (additions.length || removals.length) lines.push(`\nИтого: <b>${fmtMoney(total, cur)}</b>`);
  rows.push([{ text: `🛒 Добавить в корзину · ${fmtMoney(total, cur)}`, callback_data: `tglbcardadd:${recordId}` }]);

  return { text: lines.join('\n'), keyboard: rows, item, extras: mods, total, banner };
}

// Из товара + выбранных модификаторов собирает «запечённую» позицию корзины.
// Платные добавки (add) идут «+ Сыр» и в цену; убранные ингредиенты (remove) —
// «· без Лук» и цену НЕ меняют.
function composeCartLine(item, selectedMods) {
  const adds = selectedMods.filter((e) => e.type !== 'remove');
  const removes = selectedMods.filter((e) => e.type === 'remove');
  const extrasTotal = adds.reduce((s, e) => s + (Number(e.price) || 0), 0);
  let title = item.title;
  if (adds.length) title += adds.map((e) => ` + ${e.name}`).join('');
  if (removes.length) title += removes.map((e) => ` · без ${e.name}`).join('');
  const id = item.id + (selectedMods.length ? ':' + selectedMods.map((e) => e.id).sort().join(',') : '');
  return { id, title, price: (Number(item.price) || 0) + extrasTotal };
}

module.exports = { EXTRAS_SCHEMA, ensureExtrasSchema, applicableExtras, loadItem, renderCard, composeCartLine, cardBannerKey };
