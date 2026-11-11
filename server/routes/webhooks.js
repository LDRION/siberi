'use strict';
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

const aiService        = require('../AiService');
const Task             = require('../models/Task');
const User             = require('../models/User');
const UserAiConfig     = require('../models/UserAiConfig');
const UserIntegrations = require('../models/UserIntegrations');
const BlockedEndUser   = require('../models/BlockedEndUser');
const UserSchema       = require('../models/UserSchema');
const UserRecord       = require('../models/UserRecord');
const UserAdmin        = require('../models/UserAdmin');
const { triggerEventRules } = require('../notificationProcessor');
const { isDuplicateUpdate } = require('../helpers/dedupeUpdate');
const { aiFailureMessage } = require('../helpers/aiFailureMessage');
const { toTelegramHtml, htmlEscape } = require('../helpers/telegramFormat');
const { cartAdd, cartTotal, cartCount, fmtMoney, extractItem, stripCartButtons, placeCountedCart } = require('../helpers/cart');
const { getBanner, bannerForCommand, sameMenu, sendBannerPhoto, renderStep } = require('../helpers/banners');
const { getDeliveryConfig, isDeliveryOpenNow, computeDeliveryFee, checkMinOrder, deliveryTerms } = require('../helpers/delivery');
const { getPaidSettings, isPaymentReady, buildPayLink, parsePaidLabel, grantEntitlement, hasActivePremium, PRODUCTS_SCHEMA } = require('../helpers/paid');

const ABUSE_THRESHOLD = parseInt(process.env.ABUSE_THRESHOLD) || 50;

// Бесплатный режим (см. routes/tgletbot.js). Должен читаться ОДИНАКОВО в обоих
// файлах: конструктор бесплатный ⇒ живые боты клиентов НЕ должны замолкать по
// истечении доступа владельца. Иначе «на сайте бесплатно, а бот через сутки
// умер» — ровно то, на что жалуются. Вернуть тарифы: TGLB_FREE_MODE=false.
const FREE_MODE = process.env.TGLB_FREE_MODE !== 'false';

// Статусы заказа, считающиеся ЗАВЕРШЁННЫМИ (для «актуальный vs история»).
const ORDER_DONE_STATUSES = ['доставлен', 'выдан', 'завершён', 'завершен', 'отменён', 'отменен', 'выполнен'];
const isOrderDone = (status) => ORDER_DONE_STATUSES.includes(String(status || '').trim().toLowerCase());

// ── Публичный каталог (listSchema): одна страница записей схемы, живьём из БД ──
// Пагинация фиксированными страницами: Telegram жёстко режет сообщения длиннее
// 4096 символов (не доставляет вовсе), поэтому и размер страницы, и длину
// значений ограничиваем — страница гарантированно влезает. Кнопка «Показать
// ещё ▶» листает страницы (см. обработку tglbcat: в вебхуке).
// Уведомление ВЛАДЕЛЬЦУ бота (тому, кто создал его через конструктор) — шлём
// через конструктор-бота @AI_ConstructorBot в его личный чат (там он гарантированно
// достижим). Детерминированно, не через правила уведомлений AI.
async function notifyBotOwner(ownerUser, text, replyMarkup) {
  const token = process.env.TGLETBOT_TOKEN;
  if (!token || !ownerUser?.telegramId) return null;
  const body = { chat_id: ownerUser.telegramId, text: toTelegramHtml(text), parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((x) => x.json()).catch(() => null);
  return r?.result?.message_id || null;
}

// Последний заказ клиента (для уведомления «Где мой заказ» и т.п.): самая свежая
// запись этого чата в любой схеме-заказов — оттуда берём телефон/адрес/время.
async function findLatestOrderForChat(userId, chatId) {
  try {
    const UserSchema = require('../models/UserSchema');
    const UserRecord = require('../models/UserRecord');
    const orderSchemas = await UserSchema.find({
      userId, $or: [{ name: /order|заказ/i }, { label: /заказ|order/i }],
    }).select('name').lean();
    const names = orderSchemas.map((s) => s.name);
    if (!names.length) return null;
    return await UserRecord.findOne({ userId, schemaName: { $in: names }, 'data._tg_chat_id': chatId })
      .sort({ createdAt: -1 }).lean();
  } catch { return null; }
}

// Отправляет клиенту документ (deliver_file товара): http-URL или data-URL.
async function sendDocToChat(token, chatId, fileVal, caption) {
  try {
    if (typeof fileVal !== 'string' || !fileVal) return;
    if (fileVal.startsWith('http')) {
      await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, document: fileVal, caption: caption ? String(caption).slice(0, 1024) : undefined }),
      }).catch(() => {});
      return;
    }
    if (fileVal.startsWith('data:')) {
      const mime = (fileVal.match(/^data:([^;]+);/) || [])[1] || 'application/octet-stream';
      const b64 = fileVal.replace(/^data:[^;]+;base64,/, '');
      const ext = (mime.split('/')[1] || 'bin').slice(0, 5);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (caption) form.append('caption', String(caption).slice(0, 1024));
      form.append('document', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `file.${ext}`);
      await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form }).catch(() => {});
    }
  } catch { /* доставка файла — best-effort */ }
}

// Оплачена платная функция бота (метка <chatId>_pf_<code>_<ts>): выдаём клиенту
// премиум-доступ или товар и уведомляем его. code: 'premium' | <id товара>.
async function grantPaidPurchase(userId, token, { chatId, code }, amount) {
  const s = await getPaidSettings(userId);
  if (!s) return;
  const notify = (text) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', text: toTelegramHtml(text) }),
  }).catch(() => {});

  if (code === 'premium') {
    await grantEntitlement(userId, { chatId, tgId: chatId, kind: 'premium', item: s.premium_title || 'Премиум', amount, days: s.premium_days || 0 });
    await notify(s.success_text || `✅ Оплата получена — доступ «${s.premium_title || 'Премиум'}» открыт! 🎉`);
    return;
  }
  const UserRecordM = require('../models/UserRecord');
  const prod = await UserRecordM.findOne({ _id: code, userId, schemaName: PRODUCTS_SCHEMA }).lean().catch(() => null);
  if (prod) {
    await grantEntitlement(userId, { chatId, tgId: chatId, kind: 'product', item: prod.data?.title || 'Товар', amount });
    await notify(`✅ <b>Оплата получена!</b>\n\n<b>${htmlEscape(prod.data?.title || 'Ваш заказ')}</b>${prod.data?.deliver_text ? `\n\n${htmlEscape(prod.data.deliver_text)}` : ''}`);
    if (prod.data?.deliver_file) await sendDocToChat(token, chatId, prod.data.deliver_file, prod.data?.title);
    return;
  }
  await notify(s.success_text || '✅ Оплата получена — спасибо! 🎉');
}

// Дата-время в местном часовом поясе владельца (tzOffset из его правил уведомлений,
// по умолчанию МСК +3) — как «05.07.2026 18:03».
function formatLocalDateTime(date, tzOffset = 3) {
  const d = new Date(new Date(date).getTime() + tzOffset * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Рассылает уведомление о заказе АДМИНАМ бота ПРЯМО В ЖИВОМ боте (его токеном), с
// кнопкой «Заказ выполнен». Владелец здесь НЕ дублируется — ему уходит отдельное
// уведомление в конструктор. Ограниченные и полноправные админы получают
// одинаково (оба «подтверждают доставки»). Админ, не запускавший бота, просто не
// получит (Telegram 403) — не критично. Возвращает [{chat,message_id}] — по ним
// потом гасим кнопку, когда заказ подтверждён.
async function notifyLiveAdmins(userId, tgToken, ownerTelegramId, text, replyMarkup) {
  const UserAdmin = require('../models/UserAdmin');
  const admins = await UserAdmin.find({ ownerId: userId, platform: 'telegram' }).select('platformUserId').lean().catch(() => []);
  const seen = new Set([String(ownerTelegramId || '')]); // владельца пропускаем
  const messages = [];
  for (const a of admins) {
    const id = a.platformUserId && String(a.platformUserId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const body = { chat_id: id, text: toTelegramHtml(text), parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json()).catch(() => null);
    if (r?.ok && r.result?.message_id) messages.push({ chat: id, message_id: r.result.message_id });
  }
  return messages;
}

// Заказ подтверждён (владельцем в конструкторе ИЛИ админом в живом боте): гасим
// кнопку «Заказ выполнен» у всех уведомлений — у админов (токен живого бота) и у
// владельца (токен конструктора). Идемпотентно, best-effort.
async function grayOrderNotifications(liveToken, orderData, ownerTelegramId) {
  for (const m of (orderData?._admin_msgs || [])) {
    if (!m?.chat || !m?.message_id) continue;
    await fetch(`https://api.telegram.org/bot${liveToken}/editMessageReplyMarkup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: m.chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }),
    }).catch(() => {});
  }
  if (orderData?._owner_msg && ownerTelegramId && process.env.TGLETBOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${process.env.TGLETBOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ownerTelegramId, message_id: orderData._owner_msg, reply_markup: { inline_keyboard: [] } }),
    }).catch(() => {});
  }
}

// Уведомление владельцу (в конструктор) + админам (в живой бот) о заказе, который
// создан НЕ через нативную корзину, а ИИ через DB_COMMAND или скрипт-сценарием.
// Тот же чистый формат и кнопка «Заказ выполнен», что и в finalizeCartOrder.
// Идемпотентно: помечаем запись (_owner_msg/_order_notified), повторно не шлём.
async function notifyOrderFromRecord(user, tgToken, botUsername, orderRec, buyer = {}) {
  const data = orderRec?.data || {};
  if (data._owner_msg || data._order_notified) return; // уже уведомляли
  const cur = '₽'; // у записи заказа нет валюты — по умолчанию рубль
  const total = Number(data.total) || 0;
  const fee = Number(data.delivery_fee) || 0;
  const isPickup = /самовывоз|pickup|заберу/i.test(String(data.delivery_mode || ''));
  const itemsText = String(data.items || data.order || data.cart || '').trim() || '—';
  const phone = String(data.phone || data.contact || '').trim();
  const address = String(data.address || data.comment || '').trim();
  const tzOffset = (await require('../models/NotificationRule').findOne({ userId: user._id }).select('tzOffset').lean())?.tzOffset ?? 3;
  const orderTime = formatLocalDateTime(orderRec.createdAt || Date.now(), tzOffset);
  const custId = buyer.id || data._tg_chat_id || data.tg_id || '';
  const buyerName = String(data.customer || buyer.name || '').trim() || (buyer.username ? '@' + buyer.username : 'Клиент');
  const buyerLink = custId ? `<a href="tg://user?id=${custId}">${htmlEscape(buyerName)}</a>` : htmlEscape(buyerName);
  const buyerLogin = buyer.username ? ` · @${buyer.username}` : '';

  const lines = [
    `${isPickup ? '📦' : '🚚'} <b>Новый заказ на ${isPickup ? 'самовывоз' : 'доставку'}</b> от ${orderTime}${botUsername ? ` (@${botUsername})` : ''}`,
    '',
    `Получатель: ${buyerLink}${buyerLogin}`,
    `Состав заказа: ${htmlEscape(itemsText)}`,
  ];
  if (!isPickup) lines.push(`Доставка: ${fee > 0 ? fmtMoney(fee, cur) : 'бесплатно'}`);
  if (total > 0) lines.push(`К оплате: <b>${fmtMoney(total, cur)}</b>`);
  if (phone) lines.push(`Номер для связи: ${htmlEscape(phone)}`);
  if (!isPickup && address) lines.push(`Адрес доставки и комментарий: ${htmlEscape(address)}`);
  lines.push('', 'Отметь заказ выполненным, когда доставишь — кнопка ниже.');

  const kb = { inline_keyboard: [[{ text: '✅ Заказ выполнен', callback_data: `dlvdone:${orderRec._id}` }]] };
  const ownerMsgId = await notifyBotOwner(user, lines.join('\n'), kb);
  const adminMsgs = await notifyLiveAdmins(user._id, tgToken, user.telegramId, lines.join('\n'), kb);
  const patch = { 'data._order_notified': true };
  if (ownerMsgId) patch['data._owner_msg'] = ownerMsgId;
  if (adminMsgs.length) patch['data._admin_msgs'] = adminMsgs;
  await UserRecord.updateOne({ _id: orderRec._id }, { $set: patch }).catch(() => {});
}

// После хода ИИ в живом боте: не создал ли ИИ (или сценарий) новый заказ для
// этого чата, о котором владелец ещё не уведомлён? Если да — шлём уведомление.
// Нужно, потому что многие боты собирают заказ в свободном диалоге (ИИ пишет
// DB_COMMAND в схему заказов), минуя нативную корзину finalizeCartOrder.
async function notifyNewOrdersForChat(user, tgToken, botUsername, chatId, buyer) {
  try {
    const orderSchemas = await UserSchema.find({
      userId: user._id, $or: [{ name: /order|заказ/i }, { label: /заказ|order/i }],
    }).select('name').lean();
    const names = orderSchemas.map((s) => s.name);
    if (!names.length) return;
    const chatVariants = [String(chatId), Number(chatId)].filter((v) => v === 0 || v);
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const fresh = await UserRecord.find({
      userId: user._id,
      schemaName: { $in: names },
      'data._tg_chat_id': { $in: chatVariants },
      createdAt: { $gte: twoMinAgo },
      'data._owner_msg': { $exists: false },
      'data._order_notified': { $ne: true },
    }).sort({ createdAt: 1 }).limit(3).lean();
    for (const rec of fresh) {
      // Пропускаем уже завершённые/отменённые (на всякий случай).
      if (isOrderDone(rec.data?.status)) continue;
      await notifyOrderFromRecord(user, tgToken, botUsername, rec, buyer);
    }
  } catch (e) { console.warn('⚠️ notifyNewOrdersForChat:', e.message); }
}

const CATALOG_PAGE_SIZE = 12;
async function buildCatalogText(userId, schemaDoc, listFields, headerResponse, page, opts = {}) {
  const allFields = (schemaDoc.fields || []).filter(
    (f) => !f.name.startsWith('_') && f.type !== 'image' && f.type !== 'file'
  );
  const wanted = Array.isArray(listFields) && listFields.length
    ? listFields.map((n) => allFields.find((f) => f.name === n)).filter(Boolean)
    : allFields;
  const titleField = wanted[0];
  const detailFields = wanted.slice(1, 5);
  const priceField = wanted.find((f) => /цена|price|cost|стоим|сумм|amount/i.test(`${f.name} ${f.label || ''}`))
    || wanted.find((f) => f.type === 'number');

  // Фильтр категории (listFilter): показываем только записи, совпавшие по полю.
  const query = { userId, schemaName: schemaDoc.name };
  if (opts.filter && typeof opts.filter === 'object') {
    for (const [k, val] of Object.entries(opts.filter)) {
      if (val != null && val !== '' && !String(k).startsWith('_')) query[`data.${k}`] = val;
    }
  }

  const total = await UserRecord.countDocuments(query);
  if (total === 0) return { text: null, hasMore: false, empty: true };

  const recs = await UserRecord.find(query)
    .sort({ createdAt: 1 })
    .skip(page * CATALOG_PAGE_SIZE)
    .limit(CATALOG_PAGE_SIZE)
    .lean();

  const header = headerResponse ? `${headerResponse}\n\n` : '';
  if (recs.length === 0) return { text: `${header}Это весь список.`, hasMore: false, empty: false };

  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = recs.map((r) => {
    const title = htmlEscape(clip(String(r.data?.[titleField?.name] ?? '—'), 80));
    const details = detailFields
      .map((f) => {
        const v = r.data?.[f.name];
        if (v == null || v === '') return null;
        return `${htmlEscape(f.label || f.name)}: ${htmlEscape(clip(String(v), 160))}`;
      })
      .filter(Boolean)
      .join(' · ');
    return `• <b>${title}</b>${details ? `\n  ${details}` : ''}`;
  });

  // Кнопки товаров: productCard → открывают карточку (состав+добавки), addToCart →
  // кладут в корзину сразу. productCard имеет приоритет, если задан.
  let itemButtons = null;
  if (opts.productCard) {
    const cur = opts.currency || '₽';
    itemButtons = recs.map((r) => {
      const title = clip(String(r.data?.[titleField?.name] ?? 'Товар'), 26);
      const price = priceField ? String(r.data?.[priceField.name] ?? '').replace(/[^\d.]/g, '') : '';
      return [{ text: `${title}${price ? ` · ${price}${cur}` : ''}`, callback_data: `tglbcard:${schemaDoc.name}:${r._id}` }];
    });
  } else if (opts.addToCart) {
    const cur = opts.currency || '₽';
    itemButtons = recs.map((r) => {
      const title = clip(String(r.data?.[titleField?.name] ?? 'Товар'), 26);
      const price = priceField ? String(r.data?.[priceField.name] ?? '').replace(/[^\d.]/g, '') : '';
      return [{ text: `➕ ${title}${price ? ` · ${price}${cur}` : ''}`, callback_data: `tglbcart:add:${r._id}` }];
    });
  }

  const totalPages = Math.ceil(total / CATALOG_PAGE_SIZE);
  const pageNote = totalPages > 1 ? `\n\nСтраница ${page + 1} из ${totalPages}` : '';
  // В режиме карточек описания позиций не выводим текстом — каждая позиция кнопкой,
  // вся инфа открывается в её карточке. Показываем только заголовок команды.
  const bodyText = opts.productCard
    ? (headerResponse ? String(headerResponse) : 'Выберите позицию:') + pageNote
    : header + lines.join('\n\n') + pageNote;
  return {
    text: bodyText,
    hasMore: (page + 1) * CATALOG_PAGE_SIZE < total,
    empty: false,
    itemButtons,
  };
}

// Ищем запись каталога, чьё название = метке нажатой кнопки (для предохранителя:
// AI иногда вешает «добавить в корзину» отдельной командой-товаром с aiAction —
// мы это ловим и кладём товар в корзину сами, без AI). Ищем только в схемах,
// похожих на каталог (есть числовое поле «цена»).
async function findCatalogRecordByTitle(userId, title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const rx = new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const schemas = await UserSchema.find({ userId }).lean();
  for (const s of schemas) {
    const fields = (s.fields || []).filter((f) => !f.name.startsWith('_') && f.type !== 'image' && f.type !== 'file');
    const titleField = fields[0];
    const hasPrice = fields.some((f) => /цена|price|cost|стоим|сумм|amount/i.test(`${f.name} ${f.label || ''}`) || f.type === 'number');
    if (!titleField || !hasPrice) continue;
    const found = await UserRecord.findOne({ userId, schemaName: s.name, [`data.${titleField.name}`]: rx }).lean();
    if (found) return found;
  }
  return null;
}

// Streaming preview text can be cut mid-tag (e.g. AI wrote "<b>Услуги" but hasn't
// closed it yet) — Telegram's HTML parser rejects unbalanced tags outright, which
// would make editPlaceholder() fall back to sendTgMessage (a NEW message instead
// of editing). Auto-close anything still open so every progressive edit stays valid.
function closeUnclosedTags(html) {
  const stack = [];
  const tagRe = /<(\/?)(b|i|u|s|code|pre)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[1] === '/') { if (stack[stack.length - 1] === m[2]) stack.pop(); }
    else stack.push(m[2]);
  }
  return stack.length ? html + stack.reverse().map(t => `</${t}>`).join('') : html;
}

// ── Funnel-step inference for daily-report analytics ──────────────────────────
// Zero-config default for BOT_COMMANDS.funnelStep when the owner hasn't tagged
// a button explicitly via prompt — best-effort Russian-label heuristic, see
// notificationProcessor.js computeDailyStats for how this gets aggregated.
function inferFunnelStep(cmdConfig) {
  const label = (cmdConfig?.command || cmdConfig?.description || '').toLowerCase();
  if (/цен|прайс|стоимост|тариф/i.test(label)) return 'pricing';
  if (cmdConfig?.paidAction === 'premium') return 'pricing';
  if (/катало|меню|услуг|товар|ассортимент/i.test(label)) return 'catalog';
  // Любой экран-витрина (listSchema) — это просмотр каталога/меню для воронки,
  // даже если кнопка названа категорией («🍕 Пицца», «🍣 Роллы»): пользователь
  // всё равно смотрит товары. Без этого «Просмотрели каталог» всегда 0, когда
  // владелец разложил меню по категориям (частый случай).
  if (cmdConfig?.listSchema) return 'catalog';
  return null;
}

// ── Per-chat sequential queue ─────────────────────────────────────────────────
// The trailing pacing delay exists to protect the shared Mistral browser context
// when the AI/free-text path runs — it has no business throttling matched-button
// taps, which never touch the AI at all. `fn` returns `true` to signal "fast path,
// skip the pacing delay"; anything else (including the AI path) keeps it.
const chatQueues = new Map();
// Кэш токена бота по instanceId — чтобы гасить спиннер на inline-кнопке МГНОВЕННО
// (answerCallbackQuery ВНЕ очереди), не делая DB-запрос на каждый тап. Обновляется
// при каждой обработке апдейта актуальным токеном.
const botTokenCache = new Map();
// Очередь на КЛЮЧ (обычно per-chat) — сериализует обработку сообщений одного чата.
// Трейлинг-пауза 2-3с нужна ТОЛЬКО чтобы разредить обращения к браузеру Mistral,
// и применяется, ТОЛЬКО если в этом ходе реально шёл AI/браузер (fn выставит
// ctx.pace=true). Детерминированные тапы (навигация/корзина/каталог/карточка) её
// НЕ платят — иначе после каждого такого тапа следующий залипал на 2-3с.
function enqueueChat(key, fn) {
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const ctx = { pace: false };
    try { await fn(ctx); } catch (err) { console.error(`[queue:${key}]`, err.message); }
    if (ctx.pace) {
      await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 1000)));
    }
  });
  next.finally(() => { if (chatQueues.get(key) === next) chatQueues.delete(key); });
  chatQueues.set(key, next);
  return next;
}

// Rotating status lines for the "🤔 Думаю..." placeholder once a turn clearly
// missed the fast Groq path (dual-track Groq normally replies in 1-3s — these
// only kick in past STALL_MS, so a fast reply never sees them). End-customer
// facing, unlike tgletbot.js's builder-specific phrases — generic, no mention
// of bots/menus/buttons, since these show up in any business's live chat.
const END_USER_THINKING_PHRASES = [
  '🤔 Думаю...',
  '🔍 Проверяю детали...',
  '📋 Уточняю информацию...',
  '🧐 Разбираюсь...',
  '⏳ Ещё секунду...',
  '✨ Почти готово...',
  '💬 Формулирую ответ...',
];
function shuffledEndUserPhrases() {
  const arr = [...END_USER_THINKING_PHRASES];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Telegram session state (multi-step script flow) ───────────────────────────
const telegramSessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;

function getSession(chatId) {
  const key = String(chatId);
  const s = telegramSessions.get(key);
  if (s && Date.now() < s.expiresAt) return s;
  if (s) telegramSessions.delete(key);
  return null;
}
function setSession(chatId, data) {
  telegramSessions.set(String(chatId), { ...data, expiresAt: Date.now() + SESSION_TTL });
}
function clearSession(chatId) {
  telegramSessions.delete(String(chatId));
}

// ── Role gating for BOT_COMMANDS (minRole) ──────────────────────────────────
// Mirrors the role AiService.processTask already resolves for DB_COMMAND
// permission checks (UserAdmin lookup by ownerId+platform+platformUserId,
// default 'user' when no entry exists) — same identity key (chat id), so
// someone who registered via /ownerCode or /adminCode is recognized
// consistently whether the bot is having a live AI conversation with them or
// just dispatching a static BOT_COMMANDS button tap.
const ROLE_RANK = { user: 1, admin: 2, creator: 3 };
async function resolveCallerRole(ownerId, platform, platformUserId) {
  const entry = await UserAdmin.findOne({ ownerId, platform, platformUserId: String(platformUserId) }).lean();
  // «Полные права» → creator-уровень (полный доступ), иначе ограниченный админ.
  if (entry) return entry.fullRights ? 'creator' : (entry.role || 'admin');
  // Владелец бота (его аккаунт создал бота) — ВСЕГДА creator на своём боте, даже
  // если он не вводил код Создателя в собственном боте. Иначе владелец не мог бы
  // подтверждать заказы / открывать админ-разделы в своём же боте.
  if (platform === 'telegram') {
    const owner = await User.findById(ownerId).select('telegramId').lean();
    if (owner?.telegramId && String(owner.telegramId) === String(platformUserId)) return 'creator';
  }
  return 'user';
}
function roleSatisfies(callerRole, minRole) {
  if (!minRole) return true;
  return (ROLE_RANK[callerRole] || 1) >= (ROLE_RANK[minRole] || 1);
}

function detectBookingField(text) {
  const t = text.toLowerCase();
  if (/услуг|сервис|процедур|service|procedure/.test(t)) return 'service';
  if (/мастер|специалист|исполнитель|сотрудник|master/.test(t)) return 'master';
  if (/время|time/.test(t)) return 'time';
  if (/дату|дата|date|день|дня/.test(t)) return 'date';
  if (/имя|ваше имя|вас зовут|name/.test(t)) return 'clientName';
  return null;
}

function resolveRelativeDate(val) {
  if (!val) return val;
  const v = val.toLowerCase().trim();
  const d = new Date();
  if (v === 'сегодня')     return d.toLocaleDateString('ru-RU');
  if (v === 'завтра')      { d.setDate(d.getDate() + 1); return d.toLocaleDateString('ru-RU'); }
  if (v === 'послезавтра') { d.setDate(d.getDate() + 2); return d.toLocaleDateString('ru-RU'); }
  return val;
}

function extractPrice(serviceStr) {
  if (!serviceStr) return null;
  const m = String(serviceStr).match(/(\d[\d\s]*)[\s]*[₽рРrR]/i);
  if (m) return parseInt(m[1].replace(/\s/g, ''), 10);
  const m2 = String(serviceStr).match(/\((\d+)\)/);
  return m2 ? parseInt(m2[1], 10) : null;
}

function mapBookingToSchema(bookingData, schemaFields, tgFirstLast, tgUsername) {
  const src = {
    service:     bookingData.service,
    master:      bookingData.master,
    time:        bookingData.time,
    date:        resolveRelativeDate(bookingData.date),
    phone:       bookingData.phone,
    name:        bookingData.name || tgFirstLast,
    clientName:  bookingData.clientName || tgFirstLast,
    tg_username: bookingData.tg_username || (tgUsername ? `@${tgUsername}` : null),
  };
  const result = {};
  for (const field of schemaFields) {
    const fn = field.name.toLowerCase();
    const fl = (field.label || '').toLowerCase();
    if (src[fn] != null) { result[field.name] = src[fn]; continue; }
    if (/услуг|сервис|service|процедур/.test(fl) && src.service != null) { result[field.name] = src.service; continue; }
    if (/мастер|master|специалист/.test(fl) && src.master != null) { result[field.name] = src.master; continue; }
    if (/время|time/.test(fl) && src.time != null) { result[field.name] = src.time; continue; }
    if (/дата|date|день/.test(fl) && src.date != null) { result[field.name] = src.date; continue; }
    if (/телефон|phone/.test(fl) && src.phone != null) { result[field.name] = src.phone; continue; }
    if (/клиент|client/.test(fl) && (src.clientName || src.name)) { result[field.name] = src.clientName || src.name; continue; }
    if (/имя|name/.test(fl) && (src.name || src.clientName)) { result[field.name] = src.name || src.clientName; continue; }
    if (/цена|price|стоим|cost/.test(fl)) {
      const price = extractPrice(src.service);
      if (price != null) { result[field.name] = price; continue; }
    }
    if (/telegram|tg_|username/.test(fn) || /telegram|username/.test(fl)) {
      if (src.tg_username) { result[field.name] = src.tg_username; continue; }
    }
  }
  return result;
}

// ── Scripted (no-AI) booking flow: generic required-field completion ───────
// Previously this only ever asked for ONE hardcoded thing (a phone number) as
// the last step, then finalized unconditionally — any OTHER field the bot
// owner marked "required" (via a studio prompt or the Mini App's checkbox)
// was silently never enforced here. This makes the schema's own "required"
// flags (UserSchema.fields[].required) the single source of truth for what
// the scripted flow must collect, for ANY niche — not just "needs a phone
// number". Loops naturally: each missing required field gets asked for one at
// a time, by its own label, until satisfied, then finalizes.
async function findBookingSchema(userId) {
  const UserSchema = require('../models/UserSchema');
  return UserSchema.findOne({
    userId,
    $or: [
      { name: 'schedule' },
      { name: /запис|брони|book/i },
      { label: /расписани/i },
      { label: /запис|брони/i },
    ],
  });
}

function isFieldFilled(data, name) {
  const v = data[name];
  return v !== undefined && v !== null && v !== '';
}

// Returns true if it handled the flow (asked for the next field, or finalized
// the booking) — false if there's no booking-like schema to finalize into.
async function finalizeOrAskNextRequired(chatId, user, tgFrom, bookingData, sendTgMessage) {
  const schema = await findBookingSchema(user._id);
  if (!schema) return false;

  const tgFirstLast = [tgFrom.first_name, tgFrom.last_name].filter(Boolean).join(' ') || tgFrom.username || '';
  const tgUsername = tgFrom.username || '';
  const recordData = mapBookingToSchema(bookingData, schema.fields || [], tgFirstLast, tgUsername);

  const missingRequired = (schema.fields || []).find(
    (f) => f.required && f.name !== '_tg_chat_id' && !isFieldFilled(recordData, f.name)
  );

  if (missingRequired) {
    setSession(chatId, {
      ...(getSession(chatId) || {}),
      bookingData,
      awaitingField: `__req__:${missingRequired.name}`,
      awaitingBookingField: null,
    });
    await sendTgMessage(`📋 Для записи укажите, пожалуйста: *${missingRequired.label}*`, null);
    return true;
  }

  recordData._tg_chat_id = chatId;
  const UserRecord = require('../models/UserRecord');
  await UserRecord.create({
    userId: user._id,
    schemaName: schema.name,
    data: recordData,
    metadata: { createdBy: 'user', source: 'telegram' },
  });
  console.log(`✅ Бронирование сохранено → ${schema.name}, data=${JSON.stringify(recordData)}`);
  // Уведомляем владельца о новой записи/брони (детерминированно).
  const custName = [tgFrom?.first_name, tgFrom?.last_name].filter(Boolean).join(' ') || (tgFrom?.username ? '@' + tgFrom.username : 'Клиент');
  const details = Object.entries(recordData).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}: ${v}`).join(', ');
  await notifyBotOwner(user, `🔔 <b>Новая запись</b> в вашем боте!\n\n👤 ${htmlEscape(custName)}\n📝 ${htmlEscape(details)}\n\nОткрой «Мои данные» → «${schema.label || schema.name}».`);
  clearSession(chatId);
  await sendTgMessage('✅ Запись зафиксирована! Спасибо.', null);
  return true;
}

// ── TELEGRAM WEBHOOK ──────────────────────────────────────────────────────────
router.post('/webhook/telegram/:userId/:instanceId', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { userId, instanceId } = req.params;
    const update = req.body;
    // Telegram redelivers an update if it didn't get a timely 200 — which can
    // happen purely from server restarts, even though we ACK above before any
    // work. Without this, a redelivered tap/message gets processed (and
    // replied to) a second time. Scoped by instanceId since many different
    // bots' independent update_id sequences share this one route.
    if (isDuplicateUpdate(`tg:${instanceId}`, update?.update_id)) return;

    const isCallback = !!update?.callback_query;
    const cbQuery    = update?.callback_query;
    const text       = isCallback
      ? (cbQuery?.data || '')
      : (update?.message?.text || update?.message?.caption || '');
    const chatId    = isCallback ? (cbQuery?.message?.chat?.id) : update?.message?.chat?.id;
    const tgInPhotos = isCallback ? null : update?.message?.photo;
    const tgVoice    = isCallback ? null : (update?.message?.voice || update?.message?.audio);
    if ((!text && !tgInPhotos?.length && !tgVoice) || !chatId) return;

    // ── Мгновенно гасим спиннер на inline-кнопке — ДО очереди и тяжёлой обработки ──
    // Раньше answerCallbackQuery звался ВНУТРИ enqueueChat: при занятой очереди
    // (трейлинг-пауза 2-3с после чужого AI-хода на том же боте) кнопка «залипала» на
    // секунды. Отвечаем сразу, вне очереди (токен — из кэша, без DB-запроса). Callback'и
    // с тостом (корзина/подтверждения) отвечают позже своим текстом — их не трогаем.
    // tglbex: (переключение добавок в карточке) — тоже тост: показываем «+30₽/−30₽».
    const isToastCb = /^(tglbcart:add:|tglbcardadd:|tglbex:|dlvdone:|ordercancel:)/.test(text || '');
    if (isCallback && cbQuery?.id && !isToastCb) {
      let tok = botTokenCache.get(instanceId);
      if (!tok) {
        const inst = await UserIntegrations.findOne({ userId, 'telegram._id': instanceId }, { 'telegram.$': 1 }).lean().catch(() => null);
        tok = inst?.telegram?.[0]?.token;
        if (tok) botTokenCache.set(instanceId, tok);
      }
      if (tok) fetch(`https://api.telegram.org/bot${tok}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cbQuery.id }),
      }).catch(() => {});
    }

    enqueueChat(`ai:${userId}:${chatId}`, async (ctx) => {
      const user = await User.findById(userId);
      if (!user || (typeof user.isBlocked === 'function' && user.isBlocked()) || (!FREE_MODE && !user.isAccessActive())) return;

      const integDoc = await UserIntegrations.findOne({ userId: user._id });
      const bot      = integDoc?.telegram?.id(instanceId);
      const tgToken  = bot?.token;
      if (!tgToken || !bot?.connected) return;
      botTokenCache.set(instanceId, tgToken); // держим кэш токена свежим

      const botProfile   = bot.profileId
        ? await UserAiConfig.findById(bot.profileId).lean()
        : await UserAiConfig.findOne({ userId: user._id }).lean();
      const botSettings  = botProfile?.botSettings || {};
      const triggerMode    = botSettings.triggerMode    || 'respond_all';
      const triggerKeyword = (botSettings.triggerKeyword || '').toLowerCase().trim();
      const historyMode    = botSettings.historyMode    || 'personal';
      const commands       = botSettings.commands       || [];

      // Строка-метка → callback_data = сама метка (резолвится против команд).
      // Готовый объект {text, callback_data|url} пробрасывается как есть —
      // так каталог вешает служебную кнопку «Показать ещё ▶» со своим токеном.
      // Толерантно к кривой форме от AI: плоский ряд оборачиваем, пустые/битые
      // ячейки выкидываем — некорректная клавиатура НИКОГДА не должна ронять
      // отправку сообщения (иначе кнопка «ничего не делает» → жалоба клиента).
      const buildInlineMarkup = (keyboard) => {
        if (!Array.isArray(keyboard) || !keyboard.length) return null;
        const rows = keyboard
          .map((row) => (Array.isArray(row) ? row : [row])
            .map((item) => {
              if (typeof item === 'string') return item.trim() ? { text: item, callback_data: item.slice(0, 64) } : null;
              if (item && typeof item === 'object' && item.text) return item;
              return null;
            })
            .filter(Boolean))
          .filter((r) => r.length);
        return rows.length ? { inline_keyboard: rows } : null;
      };

      const sendTgMessage = async (msg, keyboard = null) => {
        const inlineMarkup = buildInlineMarkup(keyboard);
        const mkBody = (extra = {}) => {
          const b = { chat_id: chatId, text: msg, ...extra };
          if (inlineMarkup) b.reply_markup = inlineMarkup;
          return b;
        };
        // Нормализуем в безопасный HTML (что бы модель ни прислала — HTML,
        // Markdown-звёздочки или plain), всегда шлём parse_mode:'HTML'. На
        // маловероятной ошибке разбора — откат в обычный текст оригинала.
        const html = toTelegramHtml(msg);
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mkBody({ parse_mode: 'HTML', text: html })),
        }).catch(() => null);
        if (!r?.ok) {
          await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mkBody()),
          }).catch(() => {});
        }
      };

      // ── Send a photo (base64 data URL or http URL) ──────────────────────────
      const sendTgPhoto = async (srcOrDataUrl, caption = null) => {
        try {
          const form = new FormData();
          form.append('chat_id', String(chatId));
          if (caption) form.append('caption', caption);
          if (srcOrDataUrl.startsWith('http')) {
            // Send by URL
            const body = { chat_id: chatId, photo: srcOrDataUrl };
            if (caption) body.caption = caption;
            await fetch(`https://api.telegram.org/bot${tgToken}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }).catch(() => {});
          } else {
            // Send by file (base64)
            const b64 = srcOrDataUrl.replace(/^data:image\/[^;]+;base64,/, '');
            const mimeMatch = srcOrDataUrl.match(/^data:(image\/[^;]+);/);
            const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg';
            const buf = Buffer.from(b64, 'base64');
            form.append('photo', new Blob([buf], { type: mime }), `photo.${ext}`);
            await fetch(`https://api.telegram.org/bot${tgToken}/sendPhoto`, { method: 'POST', body: form }).catch(() => {});
          }
        } catch {}
      };

      // ── Send a document (base64 data URL — any file type) ──────────────────
      const sendTgDocument = async (dataUrl, filename = 'file', caption = null) => {
        try {
          const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
          const mimeMatch = dataUrl.match(/^data:([^;]+);/);
          const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
          const buf = Buffer.from(b64, 'base64');
          const form = new FormData();
          form.append('chat_id', String(chatId));
          form.append('document', new Blob([buf], { type: mime }), filename);
          if (caption) form.append('caption', caption);
          await fetch(`https://api.telegram.org/bot${tgToken}/sendDocument`, { method: 'POST', body: form }).catch(() => {});
        } catch {}
      };

      // ── Send scripted media (images/files from user records) ────────────────
      const sendScriptedMedia = async (cmd) => {
        if (!cmd.mediaSchema || !cmd.mediaField) return;
        // Схема `banners` — это ДЕТЕРМИНИРОВАННЫЙ баннер-слой экранов (helpers/banners.js),
        // а НЕ источник «медиа под кнопкой». ИИ иногда ошибочно ставит mediaSchema:"banners"
        // — тогда сюда попадали записи баннеров и слались ОТДЕЛЬНЫМИ сообщениями по указателю
        // («картинка отдельным сообщением, перепутанные»). Никогда так не делаем — баннеры
        // рисует renderStep инлайном на своём экране.
        if (String(cmd.mediaSchema).toLowerCase() === 'banners') return;
        try {
          const UserRecord = require('../models/UserRecord');
          const mediaCount = Math.min(Math.max(1, cmd.mediaCount || 3), 10);
          const isFile = cmd.mediaType === 'file';

          const allRecords = await UserRecord.find({
            userId: user._id,
            schemaName: cmd.mediaSchema,
          }).lean();

          // Filter records that actually have the media field populated
          const mediaRecords = allRecords.filter(r => {
            const v = r.data?.[cmd.mediaField];
            return v && typeof v === 'string' && v.length > 10;
          });
          if (!mediaRecords.length) return;

          // Round-robin pointer per (chatId, schema.field) to avoid repeats
          const session = getSession(chatId) || {};
          const ptrKey = `mp_${cmd.mediaSchema}_${cmd.mediaField}`;
          const ptr = session[ptrKey] || 0;

          // Pick mediaCount records starting from ptr, wrap around
          const selected = [];
          for (let i = 0; i < Math.min(mediaCount, mediaRecords.length); i++) {
            selected.push(mediaRecords[(ptr + i) % mediaRecords.length]);
          }
          // Advance pointer
          setSession(chatId, { ...session, [ptrKey]: (ptr + mediaCount) % mediaRecords.length });

          for (const rec of selected) {
            const val = rec.data[cmd.mediaField];
            if (!val) continue;

            if (isFile || val.includes(';;')) {
              // File: "filename;;base64data" or plain base64
              const sepIdx = val.indexOf(';;');
              if (sepIdx !== -1) {
                const filename = val.slice(0, sepIdx);
                const b64data = val.slice(sepIdx + 2);
                await sendTgDocument(b64data, filename);
              } else if (val.startsWith('data:')) {
                await sendTgDocument(val, 'file');
              }
            } else if (val.startsWith('data:image/') || val.startsWith('http')) {
              await sendTgPhoto(val);
            }
          }
        } catch (e) {
          console.warn('⚠️ sendScriptedMedia error:', e.message);
        }
      };

      const cbMessageId = cbQuery?.message?.message_id;
      const editTgMessage = async (msg, keyboard = null) => {
        // Источник — фото-сообщение (меню с обложкой)? ТЕКСТ у него отредактировать
        // нельзя, editMessageText упадёт и появится ЛИШНЕЕ сообщение снизу. Поэтому
        // удаляем фото и шлём текст — ОДНО сообщение (как renderStep для text-цели).
        if (isCallback && cbMessageId && !!cbQuery?.message?.photo) {
          await fetch(`https://api.telegram.org/bot${tgToken}/deleteMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: cbMessageId }),
          }).catch(() => {});
          await sendTgMessage(msg, keyboard);
          return;
        }
        const inlineMarkup = buildInlineMarkup(keyboard);
        const body = { chat_id: chatId, message_id: cbMessageId, text: msg };
        if (inlineMarkup) body.reply_markup = inlineMarkup;
        else body.reply_markup = { inline_keyboard: [] };
        const html = toTelegramHtml(msg);
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, text: html, parse_mode: 'HTML' }),
        }).catch(() => null);
        const data = await r?.json().catch(() => null);
        if (data?.ok) return;
        // "message is not modified" — контент УЖЕ точно такой (напр. повторный «+» на
        // добавке, что и так выбрана: max 1 каждой → набор не меняется). Менять
        // нечего, это НЕ ошибка. НЕ пере-шлём — иначе дубль сообщения (реальный баг).
        if (data?.description && /message is not modified/i.test(data.description)) return;
        await sendTgMessage(msg, keyboard);
      };

      // ── Финализация заказа корзины: сохраняем со всеми полями (клиент, Telegram
      // ID, адрес, телефон, статус), уведомляем владельца, чистим корзину. ──────
      const finalizeCartOrder = async ({ buyer, cart, orderSchema, cur, address = '', phone = '', mode = 'delivery', dcfg = null, deliver }) => {
        const itemsText = cart.map((x) => `${x.title} × ${x.qty}`).join(', ');
        const subtotal = cartTotal(cart);
        const fee = computeDeliveryFee(dcfg, subtotal, mode);
        const total = subtotal + fee;
        const modeLabel = mode === 'pickup' ? 'Самовывоз' : 'Доставка';
        const buyerName = [buyer?.first_name, buyer?.last_name].filter(Boolean).join(' ') || (buyer?.username ? '@' + buyer.username : 'Клиент');
        const tgId = buyer?.id ? String(buyer.id) : (chatId ? String(chatId) : '');
        let savedId = null;
        if (orderSchema) {
          const sch = await UserSchema.findOne({ userId: user._id, name: orderSchema }).lean();
          if (sch) {
            const data = { items: itemsText, total, customer: buyerName, tg_id: tgId, status: 'Новый', _tg_chat_id: chatId, delivery_mode: modeLabel, delivery_fee: fee };
            if (address) data.address = address;
            if (phone) data.phone = phone;
            try {
              const created = await UserRecord.create({ userId: user._id, schemaName: orderSchema, data, metadata: { createdBy: 'user', source: 'telegram' } });
              savedId = created?._id ? String(created._id) : null;
            } catch (e) { console.warn('⚠️ cart order save:', e.message); }
          }
        }
        setSession(chatId, { ...(getSession(chatId) || {}), cart: [], awaitingCheckout: null });
        // Кликабельный профиль покупателя: имя-ссылка (tg://user?id) + @логин.
        const buyerLink = tgId ? `<a href="tg://user?id=${tgId}">${htmlEscape(buyerName)}</a>` : htmlEscape(buyerName);
        const buyerLogin = buyer?.username ? ` · @${buyer.username}` : '';
        const orderTime = formatLocalDateTime(Date.now(), (await require('../models/NotificationRule').findOne({ userId: user._id }).select('tzOffset').lean())?.tzOffset ?? 3);
        const feeLine = fee > 0 ? `\n🚚 Доставка: ${fmtMoney(fee, cur)}` : (mode === 'delivery' ? '\n🚚 Доставка: бесплатно' : '');
        // Уведомление о заказе → ВЛАДЕЛЬЦУ в AiConstructor (@AI_ConstructorBot), а
        // НЕ в клиентский бот. Кнопка «Заказ выполнен» тапается там же (владелец),
        // обработчик dlvdone — в routes/tgletbot.js. id сообщения кладём на заказ,
        // чтобы при подтверждении погасить кнопку. Формат — чистый, без эмодзи-мусора.
        const isPickup = mode === 'pickup';
        const ownerLines = [
          `${isPickup ? '📦' : '🚚'} <b>Новый заказ на ${isPickup ? 'самовывоз' : 'доставку'}</b> от ${orderTime} (@${bot.botUsername || ''})`,
          '',
          `Получатель: ${buyerLink}${buyerLogin}`,
          `Состав заказа: ${htmlEscape(itemsText)}`,
        ];
        if (!isPickup) ownerLines.push(`Доставка: ${fee > 0 ? fmtMoney(fee, cur) : 'бесплатно'}`);
        ownerLines.push(`К оплате: <b>${fmtMoney(total, cur)}</b>`);
        if (phone) ownerLines.push(`Номер для связи: ${htmlEscape(phone)}`);
        if (!isPickup && address) ownerLines.push(`Адрес доставки и комментарий: ${htmlEscape(address)}`);
        ownerLines.push('', 'Отметь заказ выполненным, когда доставишь — кнопка ниже.');
        const ownerKb = savedId ? { inline_keyboard: [[{ text: '✅ Заказ выполнен', callback_data: `dlvdone:${savedId}` }]] } : null;
        const ownerMsgId = await notifyBotOwner(user, ownerLines.join('\n'), ownerKb);
        // Те же данные — АДМИНАМ бота в живом боте (с той же кнопкой подтверждения).
        const adminMsgs = savedId ? await notifyLiveAdmins(user._id, tgToken, user.telegramId, ownerLines.join('\n'), ownerKb) : [];
        const orderPatch = {};
        if (ownerMsgId) orderPatch['data._owner_msg'] = ownerMsgId;
        if (adminMsgs.length) orderPatch['data._admin_msgs'] = adminMsgs;
        if (savedId && Object.keys(orderPatch).length) await UserRecord.updateOne({ _id: savedId }, { $set: orderPatch }).catch(() => {});
        // Клиенту — подтверждение и ТОЛЬКО кнопка «Отменить заказ» (без меню).
        const cancelKb = savedId ? [[{ text: '❌ Отменить заказ', callback_data: `ordercancel:${savedId}` }]] : null;
        await deliver(`✅ <b>Заказ оформлен!</b>\n\n${htmlEscape(itemsText)}\n<b>Сумма: ${fmtMoney(subtotal, cur)}</b>${feeLine}${fee > 0 ? `\n<b>Итого: ${fmtMoney(total, cur)}</b>` : ''}\n📦 ${modeLabel}${address ? `\n📍 ${htmlEscape(address)}` : ''}\n\nСпасибо! Мы приняли заказ и скоро свяжемся с вами. 🙌`, cancelKb);
      };

      // ── Пагинация каталога (listSchema): «Показать ещё ▶» листает страницы ──
      // на месте (редактируем то же сообщение). Токен tglbcat:<схема>:<стр>
      // перехватываем ДО сопоставления с командами.
      const catMatch = isCallback && text.match(/^tglbcat:(.+):(\d+)$/);
      if (catMatch) {
        const catSchemaName = catMatch[1];
        const catPage = parseInt(catMatch[2], 10) || 0;
        const catCmd = commands.find((c) => c.listSchema === catSchemaName);
        if (catCmd) {
          const schemaDoc = await UserSchema.findOne({ userId: user._id, name: catSchemaName }).lean();
          if (schemaDoc) {
            const cat = await buildCatalogText(user._id, schemaDoc, catCmd.listFields, catCmd.response, catPage,
              { addToCart: catCmd.addToCart, productCard: catCmd.productCard, currency: catCmd.cartCurrency, filter: catCmd.listFilter });
            const rows = [];
            if (Array.isArray(cat.itemButtons)) cat.itemButtons.forEach((r) => rows.push(r));
            const isCartCmd = catCmd.addToCart || catCmd.productCard;
            let countedBtn = null, catPlaced = false;
            if (isCartCmd) {
              const sc = getSession(chatId) || {};
              const cnt = cartCount(sc.cart);
              const cur = catCmd.cartCurrency || '₽';
              countedBtn = { text: `🛒 Корзина${cnt ? ` (${cnt} · ${fmtMoney(cartTotal(sc.cart), cur)})` : ''}`, callback_data: 'tglbcart:view' };
              if (!cat.hasMore) { const res = placeCountedCart(catCmd.keyboard || [], countedBtn); catPlaced = res.placed; }
              if (!catPlaced) rows.push([countedBtn]);
            }
            if (cat.hasMore) rows.push([{ text: 'Показать ещё ▶', callback_data: `tglbcat:${catSchemaName}:${catPage + 1}` }]);
            // Клавиатура команды: counted-корзина встала на место своей «Корзина»
            // (catPlaced) — берём с ней; иначе снимаем дубль-«Корзина».
            const catKb = isCartCmd
              ? (catPlaced ? placeCountedCart(catCmd.keyboard || [], countedBtn).keyboard : stripCartButtons(catCmd.keyboard || []))
              : (catCmd.keyboard || []);
            if (Array.isArray(catKb)) catKb.forEach((r) => rows.push(r));
            await editTgMessage(cat.text || (catCmd.emptyResponse || 'Каталог пуст.'), rows.length ? rows : null);
          }
        }
        return;
      }

      // ── Карточка товара с добавками (детерминированно, БЕЗ AI) ─────────────
      // tglbcard:<schema>:<recordId> — открыть; tglbex:<recordId>:<idx>:<m|p> —
      // убрать/добавить добавку (макс 1 каждой, Set); tglbcardadd:<recordId> — в
      // корзину «запечённой» строкой (товар + допы, цена суммируется).
      if (isCallback && (text.startsWith('tglbcard:') || text.startsWith('tglbex:') || text.startsWith('tglbcardadd:') || text.startsWith('tglbback:'))) {
        const pc = require('../helpers/productCard');
        const cur = commands.find((c) => c.cartCurrency)?.cartCurrency || '₽';
        const sess = getSession(chatId) || {};
        const ansCb = (t) => fetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cbQuery.id, text: t || '' }),
        }).catch(() => {});
        const backRow = (recordId) => [[{ text: '⬅️ К позициям', callback_data: `tglbback:${recordId}` }]];
        // Карточка со СВОИМ баннером рисуется фото-сообщением (подпись = текст
        // карточки); без баннера — обычным текстом. captionOnly — переключение
        // добавок на той же карточке: меняем лишь подпись, без пере-заливки фото.
        const renderCardMsg = async (card, rows, { captionOnly = false } = {}) => {
          if (card.banner) {
            await renderStep({ token: tgToken, chatId, src: { messageId: cbMessageId, isPhoto: !!cbQuery?.message?.photo }, text: card.text, banner: card.banner, replyMarkup: buildInlineMarkup(rows), captionOnly });
          } else {
            await editTgMessage(card.text, rows);
          }
        };

        if (text === 'tglbex:noop') { await ansCb(); return; }

        // «К позициям» — вернуться в КАТЕГОРИЮ товара (по его category-полю).
        if (text.startsWith('tglbback:')) {
          const recordId = text.slice('tglbback:'.length);
          const item = await pc.loadItem(user._id, recordId);
          if (!item) return; // callback уже отвечён вне очереди
          // Ищем команду-категорию: тот же listSchema и, по возможности, listFilter по категории товара.
          const cands = commands.filter((c) => c.listSchema === item.schemaName && (c.productCard || c.addToCart));
          const catCmd = cands.find((c) => c.listFilter && String(c.listFilter.category || '').toLowerCase() === String(item.category || '').toLowerCase()) || cands[0];
          if (!catCmd) return;
          const schemaDoc = await UserSchema.findOne({ userId: user._id, name: item.schemaName }).lean();
          const cat = await buildCatalogText(user._id, schemaDoc, catCmd.listFields, catCmd.response, 0,
            { addToCart: catCmd.addToCart, productCard: catCmd.productCard, currency: cur, filter: catCmd.listFilter });
          const rows = [];
          if (Array.isArray(cat.itemButtons)) cat.itemButtons.forEach((r) => rows.push(r));
          const sc = getSession(chatId) || {};
          const cnt = cartCount(sc.cart);
          const countedBtn = { text: `🛒 Корзина${cnt ? ` (${cnt} · ${fmtMoney(cartTotal(sc.cart), cur)})` : ''}`, callback_data: 'tglbcart:view' };
          const res = placeCountedCart(catCmd.keyboard || [], countedBtn);
          if (!res.placed) rows.push([countedBtn]);
          (res.placed ? res.keyboard : stripCartButtons(catCmd.keyboard || [])).forEach((r) => rows.push(r));
          await editTgMessage(cat.text || 'Выберите позицию:', rows);
          return;
        }

        // Открыть карточку
        if (text.startsWith('tglbcard:')) {
          const m = text.match(/^tglbcard:(.+):([a-f0-9]{24})$/i);
          if (!m) { await ansCb(); return; }
          const [, schema, recordId] = m;
          const card = await pc.renderCard(user._id, recordId, [], cur, schema);
          if (!card) { await ansCb('Позиция не найдена'); return; }
          setSession(chatId, { ...sess, card: { recordId, extras: [] } });
          // Callback уже отвечён ВНЕ очереди — второй ansCb не нужен и только
          // блокировал бы рендер (лишний, иногда подвисающий запрос к Telegram).
          await renderCardMsg(card, [...card.keyboard, ...backRow(recordId)]);
          return;
        }

        // Тумблер модификатора: одна кнопка = вкл/выкл ✅ (op 't'). Легаси −/+ (m/p) тоже поддержаны.
        if (text.startsWith('tglbex:')) {
          const m = text.match(/^tglbex:([a-f0-9]{24}):(\d+):([mpt])$/i);
          if (!m) { await ansCb(); return; }
          const [, recordId, idxStr, op] = m;
          const idx = parseInt(idxStr, 10);
          const cur0 = sess.card && sess.card.recordId === recordId ? sess.card : { recordId, extras: [] };
          const extras = new Set((cur0.extras || []).map(Number));
          if (op === 't') { if (extras.has(idx)) extras.delete(idx); else extras.add(idx); }
          else if (op === 'p') extras.add(idx); else extras.delete(idx);
          setSession(chatId, { ...sess, card: { recordId, extras: [...extras] } });
          const card = await pc.renderCard(user._id, recordId, [...extras], cur);
          if (!card) { await ansCb(); return; }
          // Секундный тост: add — ±цена; remove — бесплатно (цена не меняется).
          const ex = card.extras && card.extras[idx];
          const on = extras.has(idx);
          let toast = '';
          if (ex) toast = ex.type === 'remove'
            ? (on ? `✅ Убрали: ${ex.name}` : `↩️ Вернули: ${ex.name}`)
            : (on ? `✅ ${ex.name} добавлен · +${ex.price}${cur}` : `➖ ${ex.name} убран · −${ex.price}${cur}`);
          await ansCb(toast);
          await renderCardMsg(card, [...card.keyboard, ...backRow(recordId)], { captionOnly: true });
          return;
        }

        // Добавить в корзину с выбранными допами
        if (text.startsWith('tglbcardadd:')) {
          const recordId = text.slice('tglbcardadd:'.length);
          const card0 = sess.card && sess.card.recordId === recordId ? sess.card : { extras: [] };
          const selIdx = new Set((card0.extras || []).map(Number));
          const item = await pc.loadItem(user._id, recordId);
          if (!item) { await ansCb('Позиция не найдена'); return; }
          const applicable = await pc.applicableExtras(user._id, item.category);
          const chosen = applicable.filter((_, i) => selIdx.has(i));
          const line = pc.composeCartLine(item, chosen);
          let cart = Array.isArray(sess.cart) ? sess.cart : [];
          cart = cartAdd(cart, line);
          setSession(chatId, { ...sess, cart, card: null });
          await ansCb(`✅ Добавлено · ${fmtMoney(cartTotal(cart), cur)}`);
          const rows = [[{ text: `🛒 Корзина (${cartCount(cart)} · ${fmtMoney(cartTotal(cart), cur)})`, callback_data: 'tglbcart:view' }]];
          rows.push([{ text: '⬅️ К позициям', callback_data: `tglbback:${recordId}` }]);
          await editTgMessage(`✅ <b>Добавлено в корзину:</b>\n${htmlEscape(line.title)} — ${fmtMoney(line.price, cur)}`, rows);
          return;
        }
        return;
      }

      // ── Нативная корзина (детерминированная логика, БЕЗ AI) ────────────────
      // tglbcart:add:<recordId> | tglbcart:view | tglbcart:clear | tglbcart:checkout
      // Простые действия (добавить/сумма/оформить) считает сервер — AI сюда не
      // подключается, экономим мощности и отвечаем мгновенно и предсказуемо.
      if (isCallback && text.startsWith('tglbcart:')) {
        const parts = text.split(':');
        const cartAction = parts[1];
        const cartArg = parts[2];
        const cur = commands.find((c) => c.cartCurrency)?.cartCurrency || '₽';
        const showCartCmd = commands.find((c) => c.showCart);
        const sess = getSession(chatId) || {};
        let cart = Array.isArray(sess.cart) ? sess.cart : [];

        if (cartAction === 'add' && cartArg) {
          const rec = await UserRecord.findOne({ _id: cartArg, userId: user._id }).lean().catch(() => null);
          if (rec) {
            const sch = await UserSchema.findOne({ userId: user._id, name: rec.schemaName }).lean();
            const item = extractItem(rec, sch?.fields);
            cart = cartAdd(cart, item);
            setSession(chatId, { ...sess, cart });
            // Тост — подтверждение без нового сообщения и без AI.
            await fetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cbQuery.id, text: `✅ ${item.title} в корзине · ${cartCount(cart)} поз · ${fmtMoney(cartTotal(cart), cur)}` }),
            }).catch(() => {});
          }
          return;
        }

        const cartViewKb = () => {
          const rows = [
            [{ text: '✅ Оформить заказ', callback_data: 'tglbcart:checkout' }],
            [{ text: '🗑 Очистить', callback_data: 'tglbcart:clear' }],
          ];
          if (Array.isArray(showCartCmd?.keyboard)) showCartCmd.keyboard.forEach((r) => rows.push(r));
          return rows;
        };

        if (cartAction === 'view') {
          if (!cart.length) { await editTgMessage('🛒 Ваша корзина пуста.', showCartCmd?.keyboard || null); return; }
          const lines = cart.map((x) => `• ${htmlEscape(x.title)} × ${x.qty} — ${fmtMoney(x.price * x.qty, cur)}`);
          await editTgMessage(`🛒 <b>Ваша корзина:</b>\n\n${lines.join('\n')}\n\n<b>Итого: ${fmtMoney(cartTotal(cart), cur)}</b>`, cartViewKb());
          return;
        }
        if (cartAction === 'clear') {
          setSession(chatId, { ...sess, cart: [] });
          await editTgMessage('🛒 Корзина очищена.', showCartCmd?.keyboard || null);
          return;
        }
        if (cartAction === 'checkout') {
          if (!cart.length) { await editTgMessage('🛒 Корзина пуста — нечего оформлять.', showCartCmd?.keyboard || null); return; }
          // Схема заказов: из showCart.checkoutSchema, иначе ищем схему-заказы.
          let orderSchema = showCartCmd?.checkoutSchema;
          if (!orderSchema) {
            const orderSchemaDoc = await UserSchema.findOne({ userId: user._id, $or: [{ name: /order|заказ/i }, { label: /заказ|order/i }] }).lean();
            orderSchema = orderSchemaDoc?.name;
          }
          const dcfg = await getDeliveryConfig(user._id);
          // Минимальная сумма заказа (если настроена).
          const mo = checkMinOrder(dcfg, cartTotal(cart));
          if (!mo.ok) {
            await editTgMessage(`🛒 Минимальная сумма заказа — <b>${fmtMoney(mo.min, cur)}</b>.\nСейчас в корзине ${fmtMoney(cartTotal(cart), cur)} — добавьте ещё что-нибудь 🙂`, cartViewKb());
            return;
          }
          // Есть настройки доставки → предлагаем «Заберу сам» / «Доставка по адресу».
          if (dcfg && dcfg.enabled) {
            setSession(chatId, { ...sess, checkoutCtx: { orderSchema, cur } });
            const terms = deliveryTerms(dcfg);
            const rows = [];
            if (dcfg.pickup) rows.push([{ text: '🚶 Заберу сам', callback_data: 'tglbcart:pickup' }]);
            rows.push([{ text: '🚚 Доставка по адресу', callback_data: 'tglbcart:delivery' }]);
            if (Array.isArray(showCartCmd?.keyboard)) showCartCmd.keyboard.forEach((r) => rows.push(r));
            await editTgMessage(`🧾 <b>Оформление заказа</b>\n\nКак вам удобнее получить заказ?${terms ? `\n\n<b>Условия доставки:</b>\n${htmlEscape(terms)}` : ''}`, rows);
            return;
          }
          // Доставки нет — как раньше: спрашиваем контакты, если схема их ждёт.
          const sch = orderSchema ? await UserSchema.findOne({ userId: user._id, name: orderSchema }).lean() : null;
          const wantsContact = sch && (sch.fields || []).some((f) => /address|адрес|phone|телефон/i.test(`${f.name} ${f.label || ''}`));
          if (wantsContact) {
            setSession(chatId, { ...sess, awaitingCheckout: { orderSchema, cur } });
            await editTgMessage('🧾 <b>Оформление заказа</b>\n\nНапишите одним сообщением <b>адрес доставки</b> и <b>телефон</b> для связи — например: «ул. Ленина 5, кв 10, +79001234567».\nЕсли самовывоз — напишите «самовывоз» и телефон.', showCartCmd?.keyboard || null);
            return;
          }
          await finalizeCartOrder({ buyer: cbQuery?.from, cart, orderSchema, cur, deliver: (t, kb) => editTgMessage(t, kb) });
          return;
        }
        // Выбор способа получения (после «Оформить заказ» при настроенной доставке).
        if (cartAction === 'pickup' || cartAction === 'delivery') {
          if (!cart.length) { await editTgMessage('🛒 Корзина пуста.', showCartCmd?.keyboard || null); return; }
          const ctx = sess.checkoutCtx || {};
          const orderSchema = ctx.orderSchema;
          if (cartAction === 'pickup') {
            setSession(chatId, { ...sess, awaitingCheckout: { orderSchema, cur, mode: 'pickup' } });
            await editTgMessage('🚶 <b>Самовывоз</b>\n\nНапишите <b>телефон</b> для связи (можно и имя) — сообщим, когда заказ будет готов.', showCartCmd?.keyboard || null);
            return;
          }
          const dcfg = await getDeliveryConfig(user._id);
          const open = isDeliveryOpenNow(dcfg);
          const hoursNote = open.open ? '' : `\n\n⏰ ${htmlEscape(open.reason || 'Сейчас нерабочее время — привезём в рабочие часы.')}`;
          setSession(chatId, { ...sess, awaitingCheckout: { orderSchema, cur, mode: 'delivery' } });
          await editTgMessage(`🚚 <b>Доставка по адресу</b>${hoursNote}\n\nНапишите одним сообщением <b>адрес</b> и <b>телефон</b> — например: «ул. Ленина 5, кв 10, +79001234567».`, showCartCmd?.keyboard || null);
          return;
        }
        return;
      }

      // ── Админ подтверждает заказ выполненным (кнопка «✅ Заказ выполнен») ───
      // Приходит АДМИНУ в живой бот (владельцу — в конструктор, там свой dlvdone).
      // Подтвердить может админ или владелец (роль ≥ admin), в т.ч. ограниченный.
      if (isCallback && text.startsWith('dlvdone:')) {
        const orderId = text.slice('dlvdone:'.length);
        const answerCb = (t, alert = false) => fetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cbQuery.id, text: t, show_alert: alert }),
        }).catch(() => {});
        const role = await resolveCallerRole(user._id, 'telegram', chatId);
        if (ROLE_RANK[role] < ROLE_RANK.admin) { await answerCb('Только администратор может подтвердить заказ.', true); return; }
        const orderRec = await UserRecord.findById(orderId).catch(() => null);
        if (!orderRec || String(orderRec.userId) !== String(user._id)) { await answerCb('Заказ не найден.', true); return; }
        if (isOrderDone(orderRec.data?.status)) { await answerCb(`Уже: ${orderRec.data?.status}.`); await grayOrderNotifications(tgToken, orderRec.data, user.telegramId); return; }
        orderRec.data = { ...(orderRec.data || {}), status: 'Выполнен', _done_at: new Date() };
        orderRec.markModified('data');
        await orderRec.save().catch(() => {});
        await answerCb('✅ Отмечено. Клиент уведомлён.');
        await grayOrderNotifications(tgToken, orderRec.data, user.telegramId);
        // Благодарность клиенту в его чат.
        const custChat = orderRec.data?._tg_chat_id || orderRec.data?.tg_id;
        if (custChat) {
          await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: custChat, parse_mode: 'HTML', text: toTelegramHtml('🎉 <b>Ваш заказ выполнен!</b>\n\nБлагодарим за заказ — было приятно! Будем рады видеть вас снова 💚') }),
          }).catch(() => {});
        }
        return;
      }

      // ── Клиент отменяет СВОЙ заказ (кнопка «❌ Отменить заказ») ─────────────
      // (Подтверждение выполнения делает владелец в конструкторе или админ в живом
      // боте — см. dlvdone. Клиент здесь может только отменить свой заказ.)
      if (isCallback && text.startsWith('ordercancel:')) {
        const orderId = text.slice('ordercancel:'.length);
        const answerCb = (t, alert = false) => fetch(`https://api.telegram.org/bot${tgToken}/answerCallbackQuery`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cbQuery.id, text: t, show_alert: alert }),
        }).catch(() => {});
        const orderRec = await UserRecord.findById(orderId).catch(() => null);
        if (!orderRec || String(orderRec.userId) !== String(user._id)) { await answerCb('Заказ не найден.', true); return; }
        // Отменить может только владелец заказа (тот же чат).
        if (String(orderRec.data?._tg_chat_id) !== String(chatId) && String(orderRec.data?.tg_id) !== String(chatId)) { await answerCb('Это не ваш заказ.', true); return; }
        if (isOrderDone(orderRec.data?.status)) { await answerCb(`Заказ уже «${orderRec.data?.status}» — отменить нельзя.`, true); return; }
        orderRec.data = { ...(orderRec.data || {}), status: 'Отменён', _cancelled_at: new Date() };
        orderRec.markModified('data');
        await orderRec.save().catch(() => {});
        await answerCb('Заказ отменён.');
        // Убираем кнопку у клиента + сообщение об отмене.
        if (cbMessageId) {
          await fetch(`https://api.telegram.org/bot${tgToken}/editMessageReplyMarkup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: cbMessageId, reply_markup: { inline_keyboard: [] } }),
          }).catch(() => {});
        }
        await sendTgMessage('❌ <b>Заказ отменён.</b> Если передумаете — оформите заново 🙂', null);
        // Владельцу в конструктор: заказ отменён + гасим его кнопку «Заказ выполнен».
        const cancelCur = commands.find((c) => c.cartCurrency)?.cartCurrency || '₽';
        await notifyBotOwner(user, `❌ <b>Заказ отменён клиентом</b> — @${bot.botUsername || ''}\n\n🛒 ${htmlEscape(String(orderRec.data?.items || ''))}${orderRec.data?.total ? `\n<b>Сумма: ${fmtMoney(Number(orderRec.data.total) || 0, cancelCur)}</b>` : ''}`);
        // Гасим кнопку «Заказ выполнен» и у владельца (конструктор), и у админов.
        await grayOrderNotifications(tgToken, orderRec.data, user.telegramId);
        return;
      }

      // ── История заказов клиента (кнопка «📜 История заказов») ───────────────
      // Показываем ТОЛЬКО уже выполненные заказы этого чата (актуальный виден в
      // «Мои заказы»). Редактируем то же сообщение.
      if (isCallback && text.startsWith('myhist:')) {
        const schemaName = text.slice('myhist:'.length);
        // Кнопка «Назад» возвращает в «Мои заказы» (команда с этим queryMySchema),
        // иначе — общий контекстный «Назад». Без неё приходилось писать /start.
        const ordersCmd = commands.find((c) => c.queryMySchema === schemaName);
        const backRow = [[{ text: '⬅️ Назад', callback_data: ordersCmd ? ordersCmd.command : 'Назад' }]];
        const mySchema = await UserSchema.findOne({ userId: user._id, name: schemaName }).lean();
        if (mySchema) {
          const mine = await UserRecord.find({ userId: user._id, schemaName, 'data._tg_chat_id': chatId }).sort({ createdAt: -1 }).limit(20).lean();
          const doneOrders = mine.filter((r) => isOrderDone(r.data?.status));
          if (!doneOrders.length) {
            await editTgMessage('📜 История пуста — выполненных заказов пока нет.', backRow);
          } else {
            const previewFields = (mySchema.fields || []).filter((f) => !f.name.startsWith('_')).slice(0, 5);
            const lines = doneOrders.map((r, i) => {
              const parts = previewFields.map((f) => { const v = r.data?.[f.name]; return v != null && v !== '' ? `${htmlEscape(f.label || f.name)}: ${htmlEscape(v)}` : null; }).filter(Boolean);
              return `${i + 1}. ${parts.join(', ')}`;
            });
            await editTgMessage(`📜 <b>История заказов</b> (${doneOrders.length})\n\n${lines.join('\n\n')}`, backRow);
          }
        } else {
          await editTgMessage('📜 История недоступна.', backRow);
        }
        return;
      }

      // ── Кирпич «Запись»: карточки услуг/мастеров + пошаговый визард ──────────
      // Всё детерминированно (кнопками), состояние визарда — в session.book.
      if (isCallback && /^(bksvc:|bkmst:|bkc:|bkm:|bkw:)/.test(text || '')) {
        const bk = require('../helpers/booking');
        const NotificationRule = require('../models/NotificationRule');
        const tz = (await NotificationRule.findOne({ userId: user._id }).select('tzOffset').lean())?.tzOffset ?? 3;
        const sess = getSession(chatId) || {};
        const showStep = async () => {
          const step = await bk.renderBookingStep(user._id, getSession(chatId)?.book || {}, tz);
          await editTgMessage(step.text, step.keyboard);
        };
        if (text.startsWith('bksvc:')) { const c = await bk.renderServiceCard(user._id, text.slice(6), tz); if (c) await editTgMessage(c.text, c.keyboard); return; }
        if (text.startsWith('bkmst:')) { const c = await bk.renderMasterCard(user._id, text.slice(6), tz); if (c) await editTgMessage(c.text, c.keyboard); return; }
        if (text.startsWith('bkc:')) { const [, svcId, mstId] = text.split(':'); setSession(chatId, { ...sess, book: { svcId, mstId: mstId || null } }); await showStep(); return; }
        if (text.startsWith('bkm:')) { setSession(chatId, { ...sess, book: { mstId: text.slice(4) } }); await showStep(); return; }
        if (text.startsWith('bkw:')) {
          const book = { ...(sess.book || {}) };
          const rest = text.slice(4);
          if (rest === 'back') {
            if (book.time) book.time = null; else if (book.mstId) book.mstId = null; else if (book.date) book.date = null; else book.svcId = null;
            setSession(chatId, { ...sess, book }); await showStep(); return;
          }
          if (rest === 'ok') {
            const from = cbQuery?.from || {};
            const cname = [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? '@' + from.username : 'Клиент');
            const rec = await bk.createBooking(user._id, book, { name: cname, username: from.username || '', chatId });
            if (!rec) { await editTgMessage('Не удалось создать запись 🙁 Попробуйте ещё раз.', [[{ text: '⬅️ Назад', callback_data: 'Назад' }]]); setSession(chatId, { ...sess, book: null }); return; }
            setSession(chatId, { ...sess, book: null, awaitingBookingPhone: String(rec._id) });
            const sum = await bk.bookingSummary(user._id, book);
            // Уведомляем владельца СРАЗУ (гарантированно, даже если клиент не оставит
            // телефон) — чисто, без эмодзи, с кликабельным клиентом.
            await notifyBotOwner(user, bk.renderOwnerBooking({ botUsername: bot.botUsername, service: sum.serviceName, master: sum.masterName, date: book.date, time: book.time, name: cname, username: from.username, tgId: chatId }));
            await editTgMessage(`✅ <b>Вы записаны!</b>\n\n${htmlEscape(sum.serviceName)} · ${htmlEscape(sum.masterName)}\n${bk.fmtDateRu(book.date)} · ${htmlEscape(book.time)}\n\nОставьте номер телефона (по желанию) — или отправьте «-», чтобы пропустить.`, null);
            return;
          }
          const ci = rest.indexOf(':'); const k = rest.slice(0, ci); const v = rest.slice(ci + 1);
          if (k === 's') book.svcId = v;
          else if (k === 'd') book.date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
          else if (k === 'm') book.mstId = v;
          else if (k === 't') book.time = `${v.slice(0, 2)}:${v.slice(2, 4)}`;
          setSession(chatId, { ...sess, book }); await showStep(); return;
        }
        return;
      }

      // Телефон после записи (session.awaitingBookingPhone) — ловим ДО команд/AI,
      // чтобы номер не ушёл в ИИ и не искался среди команд.
      if (!isCallback && text) {
        const s = getSession(chatId) || {};
        if (s.awaitingBookingPhone) {
          const bookingId = s.awaitingBookingPhone;
          setSession(chatId, { ...s, awaitingBookingPhone: null });
          const phone = text.trim();
          const hasPhone = phone && phone !== '-' && phone !== '—';
          if (hasPhone) {
            await UserRecord.updateOne({ _id: bookingId, userId: user._id }, { $set: { 'data.phone': phone } }).catch(() => {});
            // Владелец уже получил запись при бронировании — тут только короткий
            // догоняющий телефон (чтобы был под рукой в чате).
            const rec = await UserRecord.findById(bookingId).lean().catch(() => null);
            const d = rec?.data || {};
            const uname = d.username ? ` (@${htmlEscape(d.username)})` : '';
            await notifyBotOwner(user, `Телефон клиента ${htmlEscape(d.name || '')}${uname}: ${htmlEscape(phone)}\nЗапись: ${htmlEscape(d.service || '')}, ${bk.fmtDateFull(d.date)} ${htmlEscape(String(d.time || ''))}`);
          }
          const mainKb = commands.find((c) => c.command && c.command.toLowerCase() === '/start')?.keyboard || null;
          await sendTgMessage(hasPhone ? '✅ Спасибо! Запись подтверждена, мы свяжемся при необходимости 🙌' : '✅ Запись сохранена, мы свяжемся с вами 🙌', mainKb);
          return;
        }
      }

      const isSlash   = text && /^\/\w+/.test(text.trim());
      const matchText = isSlash ? text.trim().split(/\s+/)[0].toLowerCase() : (text || '').trim();

      let cmdConfig = commands.find(c => c.command && c.command.toLowerCase() === matchText.toLowerCase());

      // ── Контекстная «Назад»: возвращаем на РЕАЛЬНО предыдущий экран по хлебным
      // крошкам сессии (navStack), а не всегда в /start. Предыдущий — главное меню
      // → в него. Крошек нет → /start (никаких тупиков). Только по нажатию кнопки
      // «Назад» (callback), не по свободному тексту. ─────────────────────────────
      const BACK_RE = /^\s*(?:⬅️|◀️|🔙|↩️|←|⬅|◀)?\s*(?:назад|back)(?:\s+в\s+меню)?\s*$/i;
      let isBackTap = false;
      if (isCallback && BACK_RE.test(matchText)) {
        isBackTap = true;
        const s = getSession(chatId) || {};
        const stack = Array.isArray(s.navStack) ? s.navStack.slice() : [];
        let target = stack.pop() || '/start';
        let targetCmd = commands.find(c => c.command && c.command.toLowerCase() === target.toLowerCase());
        if (!targetCmd) { target = '/start'; targetCmd = commands.find(c => c.command && c.command.toLowerCase() === '/start'); }
        setSession(chatId, { ...s, navStack: stack, curScreen: target });
        if (targetCmd) cmdConfig = targetCmd; // дальше рендерится как обычный тап по target
      }

      // Предложение купить премиум (кнопка-ссылка на оплату на кошелёк ВЛАДЕЛЬЦА).
      // Ссылку строим при показе → метка со свежим ts. Оплата → вебхук выдаст доступ.
      const offerPremium = async () => {
        const s = await getPaidSettings(user._id);
        if (!s || !s.premium_enabled) { await sendTgMessage('Премиум-доступ пока недоступен.', null); return; }
        if (!isPaymentReady(s)) { await sendTgMessage('Оплата временно недоступна — загляните чуть позже 🙂', null); return; }
        const title = s.premium_title || 'Премиум';
        const { url } = buildPayLink(s, { chatId, code: 'premium', amount: s.premium_price, title });
        const per = s.premium_days > 0 ? ` · на ${s.premium_days} дн.` : ' · навсегда';
        const kb = url ? [[{ text: `💳 Оплатить ${s.premium_price} ${s.currency || '₽'}`, url }]] : null;
        await sendTgMessage(`💎 <b>${htmlEscape(title)}</b>${per}\n\n${htmlEscape(s.premium_desc || '')}\n\nСтоимость: <b>${s.premium_price} ${s.currency || '₽'}</b>\n\nНажмите «Оплатить» — после оплаты доступ откроется автоматически.`, kb);
      };
      // Список платных товаров с кнопками «Купить» (тоже ссылки на оплату).
      const offerProducts = async (cmd) => {
        const s = await getPaidSettings(user._id);
        const prods = await UserRecord.find({ userId: user._id, schemaName: PRODUCTS_SCHEMA }).sort({ createdAt: 1 }).limit(30).lean();
        if (!prods.length) { await sendTgMessage(cmd?.emptyResponse || 'Пока нет товаров.', cmd?.keyboard || null); return; }
        if (!isPaymentReady(s)) { await sendTgMessage('Оплата временно недоступна 🙂', cmd?.keyboard || null); return; }
        const rows = prods.map((p) => {
          const price = Number(p.data?.price) || 0;
          const { url } = buildPayLink(s, { chatId, code: String(p._id), amount: price, title: p.data?.title || 'Товар' });
          return url ? [{ text: `🛍 ${String(p.data?.title || 'Товар').slice(0, 28)} · ${price} ${s.currency || '₽'}`, url }] : null;
        }).filter(Boolean);
        if (Array.isArray(cmd?.keyboard)) cmd.keyboard.forEach((r) => rows.push(r));
        await sendTgMessage(cmd?.response || '🛍 <b>Товары</b>\n\nВыберите — после оплаты пришлём сразу в чат:', rows);
      };

      // Гейтинг доступа. minRole:'paid' — платный доступ: пускаем только клиентов
      // с активным премиумом, иначе показываем предложение купить.
      if (cmdConfig?.minRole === 'paid') {
        if (!(await hasActivePremium(user._id, chatId))) { await offerPremium(); return; }
      } else if (cmdConfig?.minRole) {
        const callerRole = await resolveCallerRole(user._id, 'telegram', chatId);
        if (!roleSatisfies(callerRole, cmdConfig.minRole)) {
          // Pretend nothing matched, rather than confirming a hidden privileged
          // command exists — the tap/text just falls through to normal handling
          // (regular AI conversation, or silently ignored in mention_only mode).
          cmdConfig = null;
        }
      }

      // ── Хлебные крошки для контекстной «Назад»: запоминаем путь экранов. /start
      // сбрасывает путь; переход вперёд по кнопке-меню кладёт текущий экран в стек;
      // возврат к уже посещённому предку схлопывает петлю. Только реальные экраны
      // (совпавшая команда), не свободный текст в AI. ────────────────────────────
      if (cmdConfig?.command && cmdConfig.command.toLowerCase() === '/start') {
        setSession(chatId, { ...(getSession(chatId) || {}), navStack: [], curScreen: '/start' });
      } else if (isCallback && cmdConfig && !isBackTap) {
        const nm = cmdConfig.command;
        const s = getSession(chatId) || {};
        const cur = s.curScreen;
        let stack = Array.isArray(s.navStack) ? s.navStack.slice() : [];
        if (!cur) {
          stack = ['/start'];
        } else if (cur.toLowerCase() !== nm.toLowerCase()) {
          const existIdx = stack.findIndex(x => String(x).toLowerCase() === nm.toLowerCase());
          if (existIdx >= 0) stack = stack.slice(0, existIdx);   // вернулись к предку — схлоп петли
          else { stack.push(cur); if (stack.length > 15) stack = stack.slice(-15); }
        }
        setSession(chatId, { ...s, navStack: stack, curScreen: nm });
      }

      // paidAction: команда-витрина оплаты (premium — предложить премиум; products — список товаров).
      if (cmdConfig?.paidAction === 'premium') { await offerPremium(); return; }
      if (cmdConfig?.paidAction === 'products') { await offerProducts(cmdConfig); return; }

      // bookingAction: команда-вход кирпича записи (услуги / мастера / визард).
      if (cmdConfig?.bookingAction) {
        const bk = require('../helpers/booking');
        const NotificationRule = require('../models/NotificationRule');
        const tz = (await NotificationRule.findOne({ userId: user._id }).select('tzOffset').lean())?.tzOffset ?? 3;
        let screen;
        if (cmdConfig.bookingAction === 'services') screen = await bk.renderServicesList(user._id);
        else if (cmdConfig.bookingAction === 'masters') screen = await bk.renderMastersList(user._id);
        else { setSession(chatId, { ...(getSession(chatId) || {}), book: {} }); screen = await bk.renderBookingStep(user._id, {}, tz); }
        await editTgMessage(screen.text, screen.keyboard);
        return;
      }

      // ── aiAction: instead of a static response, treat this tap exactly like
      // a free-text message with this instruction — falls through to the same
      // Task/processTask pipeline below (full data context, DB_COMMAND/chart
      // generation, attachments) rather than a fixed canned reply. Lets bot
      // owners wire up commands like "Аналитика" → "Построй график выручки по
      // дням за последний месяц на основе схемы orders" via a prompt, with the
      // AI actually generating it live each time the button is tapped.
      const aiActionPrompt = (cmdConfig && !cmdConfig.queryMySchema && !cmdConfig.listSchema && cmdConfig.aiAction) ? cmdConfig.aiAction : null;
      // Клавиатуру aiAction-кнопки сохраняем: после живого AI-ответа у клиента
      // должна остаться навигация (её «Назад»/меню). Своей нет — берём меню /start,
      // чтобы клиент никогда не застревал в тупике без кнопок.
      const aiActionKeyboard = aiActionPrompt
        ? ((Array.isArray(cmdConfig.keyboard) && cmdConfig.keyboard.length)
            ? cmdConfig.keyboard
            : (commands.find((c) => c.command && c.command.toLowerCase() === '/start')?.keyboard || null))
        : null;

      // ── ПРЕДОХРАНИТЕЛЬ магазина: AI часто вешает «добавить в корзину» и саму
      // «Корзину» как aiAction — тап жжёт AI, а тот галлюцинирует «добавлено», но
      // реально НЕ кладёт. Ловим это и обслуживаем нативной корзиной (сервер,
      // детерминированно, без AI), как бы бот ни был собран. ──────────────────
      if (aiActionPrompt && cmdConfig) {
        const cur = commands.find((c) => c.cartCurrency)?.cartCurrency || '₽';
        // (a) метка кнопки = товар из каталога И aiAction про корзину/заказ →
        // кладём в корзину сами (а не описательный aiAction о товаре не трогаем).
        const cartIntent = /корзин|заказ|cart|добав|оформ|order|куп/i.test(aiActionPrompt);
        const rec = cartIntent ? await findCatalogRecordByTitle(user._id, cmdConfig.command) : null;
        if (rec) {
          const sch = await UserSchema.findOne({ userId: user._id, name: rec.schemaName }).lean();
          const item = extractItem(rec, sch?.fields);
          const sess = getSession(chatId) || {};
          const cart = cartAdd(sess.cart, item);
          setSession(chatId, { ...sess, cart });
          const kb = [[{ text: `🛒 Корзина (${cartCount(cart)} · ${fmtMoney(cartTotal(cart), cur)})`, callback_data: 'tglbcart:view' }]];
          if (Array.isArray(cmdConfig.keyboard)) cmdConfig.keyboard.forEach((r) => kb.push(r));
          const msg = `✅ <b>${htmlEscape(item.title)}</b> добавлен в корзину · ${cartCount(cart)} поз · ${fmtMoney(cartTotal(cart), cur)}`;
          if (isCallback && cbMessageId) await editTgMessage(msg, kb); else await sendTgMessage(msg, kb);
          return;
        }
        // (b) метка кнопки = «Корзина»/«Cart» → показываем нативную корзину
        if (/(^|\s)(корзин|cart|моя корзина)/i.test((cmdConfig.command || '').toLowerCase())) {
          const sess = getSession(chatId) || {};
          const cart = Array.isArray(sess.cart) ? sess.cart : [];
          const back = Array.isArray(cmdConfig.keyboard) ? cmdConfig.keyboard : null;
          if (!cart.length) {
            if (isCallback && cbMessageId) await editTgMessage('🛒 Ваша корзина пуста.', back); else await sendTgMessage('🛒 Ваша корзина пуста.', back);
            return;
          }
          const lines = cart.map((x) => `• ${htmlEscape(x.title)} × ${x.qty} — ${fmtMoney(x.price * x.qty, cur)}`);
          const kb = [[{ text: '✅ Оформить заказ', callback_data: 'tglbcart:checkout' }], [{ text: '🗑 Очистить', callback_data: 'tglbcart:clear' }]];
          if (back) back.forEach((r) => kb.push(r));
          const msg = `🛒 <b>Ваша корзина:</b>\n\n${lines.join('\n')}\n\n<b>Итого: ${fmtMoney(cartTotal(cart), cur)}</b>`;
          if (isCallback && cbMessageId) await editTgMessage(msg, kb); else await sendTgMessage(msg, kb);
          return;
        }
      }

      if (aiActionPrompt) cmdConfig = null;

      if (cmdConfig) {
        // /start ВСЕГДА показывает welcomeMessage (полное приветствие) — как в
        // превью конструктора. Раньше живой бот брал короткий response команды
        // /start, и текст расходился с предпросмотром (терялся при «Завершить»).
        let responseText = (cmdConfig.command?.toLowerCase() === '/start' && botSettings.welcomeMessage)
          ? botSettings.welcomeMessage
          : (cmdConfig.response || '');
        // Главное меню ВСЕГДА одинаковое: экран-возврат в меню («Назад» с той же
        // клавиатурой, что /start) показывает то же приветствие, а не свой другой
        // текст (ИИ иногда генерит короткий вариант — это выравниваем детерминированно).
        {
          const startCmd = commands.find((c) => c.command && c.command.toLowerCase() === '/start');
          if (botSettings.welcomeMessage && cmdConfig.command?.toLowerCase() !== '/start' && startCmd && sameMenu(cmdConfig.keyboard, startCmd.keyboard)) {
            responseText = botSettings.welcomeMessage;
          }
        }
        // notifyOwner: анти-спам владельца. (1) Кнопка про заказ («где мой заказ»)
        // при ОТСУТСТВИИ активного заказа → владельца НЕ уведомляем, а честно
        // говорим клиенту. (2) Дебаунс: одну и ту же кнопку нельзя дёргать чаще
        // раза в 3 минуты — иначе владельца заспамят повторными нажатиями.
        let skipOwnerNotify = false;
        let notifyLatestOrder = null;
        if (cmdConfig.notifyOwner) {
          notifyLatestOrder = await findLatestOrderForChat(user._id, chatId);
          const isOrderTracking = /заказ|order|доставк|где\s*мо[йя]/i.test(`${cmdConfig.command || ''} ${cmdConfig.notifyOwner || ''}`);
          const hasActiveOrder = notifyLatestOrder && !isOrderDone(notifyLatestOrder.data?.status);
          if (isOrderTracking && !hasActiveOrder) {
            skipOwnerNotify = true;
            if (!responseText) responseText = 'У вас сейчас нет активных заказов 🙂 Оформите заказ — и сможете отслеживать его статус здесь.';
          } else {
            const sess = getSession(chatId) || {};
            const cdKey = `no:${String(cmdConfig.command || '').toLowerCase()}`;
            const last = (sess.notifyCooldown || {})[cdKey] || 0;
            if (Date.now() - last < 3 * 60 * 1000) skipOwnerNotify = true;
            else setSession(chatId, { ...sess, notifyCooldown: { ...(sess.notifyCooldown || {}), [cdKey]: Date.now() } });
          }
        }
        // notifyOwner-команда без текста — покажем клиенту дефолтное подтверждение.
        if (cmdConfig.notifyOwner && !responseText) responseText = 'Ваш запрос принят — мы скоро свяжемся с вами! ✅';
        let catalogMore = false; // выставит блок listSchema, если есть след. страница
        let catalogItemButtons = null; // кнопки «в корзину» по товарам (addToCart)
        let cartTopRow = null;         // кнопка «🛒 Корзина (N · сумма)» над клавиатурой
        let cartViewKb = null;         // если это команда просмотра корзины (showCart)
        let myHistoryRow = null;       // кнопка «📜 История заказов» (queryMySchema по заказам)

        // ── queryMySchema: show THIS chat's own records (e.g. "Мои записи") ──
        // without ever asking the user to re-identify themselves — Telegram
        // already gives us chat.id, and the scripted booking flow below tags
        // every record it creates with that same _tg_chat_id. Purely additive:
        // commands without this field behave exactly as before.
        if (cmdConfig.queryMySchema) {
          try {
            const UserSchema = require('../models/UserSchema');
            const UserRecord = require('../models/UserRecord');
            const mySchema = await UserSchema.findOne({ userId: user._id, name: cmdConfig.queryMySchema }).lean();
            if (mySchema) {
              // Заказы: клиенту показываем ТОЛЬКО актуальные (не выполненные), а
              // историю прячем за кнопкой «📜 История заказов». Для остальных схем —
              // прежнее поведение (последние записи).
              const isOrderSchema = /order|заказ/i.test(`${mySchema.name} ${mySchema.label || ''}`)
                || (mySchema.fields || []).some((f) => f.name === 'status');
              const allMine = await UserRecord.find({
                userId: user._id,
                schemaName: mySchema.name,
                'data._tg_chat_id': chatId,
              }).sort({ createdAt: -1 }).limit(20).lean();
              const shown = isOrderSchema ? allMine.filter((r) => !isOrderDone(r.data?.status)) : allMine.slice(0, 10);

              if (shown.length === 0) {
                responseText = cmdConfig.emptyResponse || (isOrderSchema ? 'Активных заказов сейчас нет 🙂' : 'У вас пока нет записей.');
              } else {
                const previewFields = (mySchema.fields || []).filter((f) => !f.name.startsWith('_')).slice(0, 5);
                const lines = shown.map((r, i) => {
                  const parts = previewFields
                    .map((f) => {
                      const v = r.data?.[f.name];
                      // htmlEscape: значения из БД идут в HTML-сообщение
                      return v != null && v !== '' ? `${htmlEscape(f.label || f.name)}: ${htmlEscape(v)}` : null;
                    })
                    .filter(Boolean);
                  return `${i + 1}. ${parts.join(', ')}`;
                });
                const header = cmdConfig.response || (isOrderSchema ? '🧾 Ваш актуальный заказ:' : '');
                responseText = (header ? `${header}\n\n` : '') + lines.join('\n\n');
              }
              // Кнопка истории — если это заказы и есть уже выполненные.
              if (isOrderSchema && allMine.some((r) => isOrderDone(r.data?.status))) {
                myHistoryRow = [{ text: '📜 История заказов', callback_data: `myhist:${mySchema.name}` }];
              }
            }
          } catch (e) {
            console.warn('⚠️ queryMySchema:', e.message);
          }
        }

        // ── listSchema: публичный каталог — записи схемы живьём из БД,
        // страницами. Кнопка «Показать ещё ▶» (ниже) листает остальные. ──────
        if (cmdConfig.listSchema) {
          try {
            const listSchemaDoc = await UserSchema.findOne({ userId: user._id, name: cmdConfig.listSchema }).lean();
            if (listSchemaDoc) {
              const cat = await buildCatalogText(user._id, listSchemaDoc, cmdConfig.listFields, cmdConfig.response, 0,
                { addToCart: cmdConfig.addToCart, productCard: cmdConfig.productCard, currency: cmdConfig.cartCurrency, filter: cmdConfig.listFilter });
              if (cat.empty) {
                responseText = cmdConfig.emptyResponse || 'В этом разделе пока пусто. Загляните позже 🙂';
              } else {
                responseText = cat.text;
                catalogMore = cat.hasMore;
                catalogItemButtons = cat.itemButtons;
              }
              // Счётную кнопку корзины показываем всегда (в т.ч. в пустой категории) —
              // единственную, дубли из клавиатуры команды снимет stripCartButtons.
              if (cmdConfig.addToCart || cmdConfig.productCard) {
                const sc = getSession(chatId) || {};
                const cnt = cartCount(sc.cart);
                const cur = cmdConfig.cartCurrency || '₽';
                cartTopRow = [{ text: `🛒 Корзина${cnt ? ` (${cnt} · ${fmtMoney(cartTotal(sc.cart), cur)})` : ''}`, callback_data: 'tglbcart:view' }];
              }
            }
          } catch (e) {
            console.warn('⚠️ listSchema:', e.message);
          }
        }

        // ── showCart: команда просмотра корзины (детерминированно, без AI) ────
        if (cmdConfig.showCart) {
          const sc = getSession(chatId) || {};
          const cart = Array.isArray(sc.cart) ? sc.cart : [];
          const cur = cmdConfig.cartCurrency || '₽';
          if (!cart.length) {
            responseText = cmdConfig.emptyResponse || '🛒 Ваша корзина пуста.';
          } else {
            const lines = cart.map((x) => `• ${htmlEscape(x.title)} × ${x.qty} — ${fmtMoney(x.price * x.qty, cur)}`);
            responseText = `🛒 <b>Ваша корзина:</b>\n\n${lines.join('\n')}\n\n<b>Итого: ${fmtMoney(cartTotal(cart), cur)}</b>`;
            const rows = [
              [{ text: '✅ Оформить заказ', callback_data: 'tglbcart:checkout' }],
              [{ text: '🗑 Очистить', callback_data: 'tglbcart:clear' }],
            ];
            if (Array.isArray(cmdConfig.keyboard)) cmdConfig.keyboard.forEach((r) => rows.push(r));
            cartViewKb = rows;
          }
        }

        if (isCallback && text) {
          const prevSession = getSession(chatId);
          if (prevSession?.awaitingBookingField) {
            const bd = prevSession.bookingData || {};
            bd[prevSession.awaitingBookingField] = text;
            setSession(chatId, { ...prevSession, bookingData: bd, awaitingBookingField: null, awaitingField: null });
          } else {
            const existingSession = prevSession || { bookingData: {} };
            setSession(chatId, { ...existingSession, bookingData: existingSession.bookingData || {}, awaitingField: null });
          }
        }

        if (responseText) {
          let kbd;
          if (cartViewKb) {
            kbd = cartViewKb; // команда просмотра корзины — своя клавиатура
          } else {
            kbd = Array.isArray(cmdConfig.keyboard) && cmdConfig.keyboard.length > 0
              ? [...cmdConfig.keyboard] : null;
            // Counted-кнопку «Корзина» ставим НА МЕСТО пользовательской «Корзина»
            // (сохраняя её ряд — чтобы «Корзина» и «Меню» остались в одной строке).
            // Если своей кнопки «Корзина» нет — добавим counted отдельной строкой.
            let cartPlacedInKbd = false;
            if (cartTopRow && kbd) {
              const res = placeCountedCart(kbd, cartTopRow[0]);
              kbd = res.keyboard; cartPlacedInKbd = res.placed;
              if (!Array.isArray(kbd) || !kbd.length) kbd = null;
            }
            // Над клавиатурой команды: кнопки товаров «в корзину», кнопка корзины
            // (только если не встала в саму клавиатуру), затем «Показать ещё ▶».
            const topRows = [];
            if (Array.isArray(catalogItemButtons)) catalogItemButtons.forEach((r) => topRows.push(r));
            if (cartTopRow && !cartPlacedInKbd) topRows.push(cartTopRow);
            if (catalogMore) topRows.push([{ text: 'Показать ещё ▶', callback_data: `tglbcat:${cmdConfig.listSchema}:1` }]);
            if (myHistoryRow) topRows.push(myHistoryRow);
            if (topRows.length) kbd = kbd ? [...topRows, ...kbd] : topRows;
          }
          // Баннер экрана (если владелец добавил его). Рендерим как в leadbot —
          // одно сообщение, БЕЗ спама: экран с картинкой / уход с фото-экрана идут
          // через renderStep (editMessageMedia на месте, либо удалить+прислать),
          // остальное — привычный editTgMessage/sendTgMessage (с их overflow-логикой).
          const startCmd = commands.find((c) => c.command && c.command.toLowerCase() === '/start');
          const banner = await bannerForCommand(user._id, cmdConfig, startCmd).catch(() => null);
          const srcIsPhoto = isCallback && !!cbQuery?.message?.photo;
          if (banner || srcIsPhoto) {
            await renderStep({
              token: tgToken, chatId,
              src: isCallback && cbMessageId ? { messageId: cbMessageId, isPhoto: srcIsPhoto } : null,
              text: responseText, banner, replyMarkup: buildInlineMarkup(kbd),
            });
          } else if (isCallback && cbMessageId) {
            await editTgMessage(responseText, kbd);
          } else {
            await sendTgMessage(responseText, kbd);
          }

          // notifyOwner: уведомляем ВЛАДЕЛЬЦА о запросе клиента (где заказ, подтверждение
          // и т.п.). skipOwnerNotify гасит спам (нет активного заказа / дебаунс).
          if (cmdConfig.notifyOwner && !skipOwnerNotify) {
            const nb = (isCallback ? cbQuery?.from : update.message?.from) || {};
            const nbName = [nb.first_name, nb.last_name].filter(Boolean).join(' ') || (nb.username ? '@' + nb.username : 'Клиент');
            const nbId = nb.id ? String(nb.id) : (chatId ? String(chatId) : '');
            // Кликабельный профиль: имя ссылкой (tg://user?id открывает карточку в
            // Telegram даже без юзернейма) + @логин, если он есть.
            const nameLink = nbId ? `<a href="tg://user?id=${nbId}">${htmlEscape(nbName)}</a>` : htmlEscape(nbName);
            const login = nb.username ? ` · @${nb.username}` : '';
            // Телефон/адрес/время — из последнего заказа этого клиента (уже загружен выше).
            const order = notifyLatestOrder;
            let extra = '';
            if (order) {
              const d = order.data || {};
              if (d.phone)   extra += `\n📞 ${htmlEscape(String(d.phone))}`;
              if (d.address) extra += `\n📍 ${htmlEscape(String(d.address))}`;
              if (order.createdAt) {
                const tz = (await require('../models/NotificationRule').findOne({ userId: user._id }).select('tzOffset').lean())?.tzOffset ?? 3;
                extra += `\n🕒 заказ от ${formatLocalDateTime(order.createdAt, tz)}`;
              }
            }
            await notifyBotOwner(user, `🔔 <b>${htmlEscape(cmdConfig.command || 'Запрос клиента')}</b> — бот @${bot.botUsername || ''}\n\n👤 ${nameLink}${login}\n🆔 <code>${nbId}</code>${extra}\n💬 ${htmlEscape(cmdConfig.notifyOwner)}\n\nСвяжитесь с клиентом.`);
          }

          const lowerResp = responseText.toLowerCase();
          const asksForPhone = lowerResp.includes('номер') || lowerResp.includes('телефон') || lowerResp.includes('phone');
          const asksForInput = asksForPhone ||
            lowerResp.includes('введите') || lowerResp.includes('укажите') ||
            lowerResp.includes('напишите') || lowerResp.includes('ваше имя') ||
            lowerResp.includes('your name') || lowerResp.includes('enter your');

          if (asksForInput) {
            const session = getSession(chatId) || { bookingData: {} };
            setSession(chatId, {
              ...session,
              awaitingField: asksForPhone ? 'phone' : 'text',
              awaitingBookingField: null,
              awaitingPrompt: responseText.slice(0, 200),
            });
          } else {
            const bookingField = kbd ? detectBookingField(responseText) : null;
            const session = getSession(chatId) || { bookingData: {} };
            setSession(chatId, { ...session, awaitingField: null, awaitingBookingField: bookingField });
          }

          // Record this scripted exchange in history too — otherwise the AI has
          // zero visibility into static steps (price lists, the "Записаться"
          // date/time prompt, etc.), and if the customer's next message follows
          // up on one in free text, the AI has no idea what it's replying to.
          // Confirmed live: a customer who picked a service via a button, then
          // typed a date/time as instructed, got the welcome menu echoed back —
          // the AI never even knew a service had been selected. Status
          // 'completed' immediately, no AI call — just a breadcrumb the same
          // query that builds [История диалога] below already reads.
          const histFrom = (isCallback ? cbQuery?.from : update.message?.from) || {};
          // Same personal-vs-shared key the AI-history query below filters by
          // (historyMode === 'personal' → sender's own id, else the chat's).
          const histPlatformUserId = historyMode === 'personal'
            ? String(histFrom.id || chatId)
            : String(chatId);
          const funnelStep = cmdConfig.funnelStep || inferFunnelStep(cmdConfig) || undefined;
          Task.create({
            taskId: uuidv4(),
            userId: user._id,
            ...(bot?.profileId ? { profileId: bot.profileId } : {}),
            prompt: matchText,
            rawPrompt: matchText,
            result: responseText,
            status: 'completed',
            context: { source: 'telegram-static', ...(funnelStep ? { funnelStep } : {}) },
            endUser: {
              platform: 'telegram',
              platformUserId: histPlatformUserId,
              username: histFrom.username || '',
              displayName: [histFrom.first_name, histFrom.last_name].filter(Boolean).join(' '),
            },
            completedAt: new Date(),
          }).catch(() => {});
        }

        // ── Send scripted media after text (if mediaSchema configured) ─────
        await sendScriptedMedia(cmdConfig);
        return true; // matched-command reply, no AI involved — skip the pacing delay
      }

      if (!aiActionPrompt && isSlash && matchText === '/start' && botSettings.welcomeMessage) {
        const startBanner = await getBanner(user._id, '/start').catch(() => null);
        if (startBanner) await sendBannerPhoto(tgToken, chatId, startBanner, botSettings.welcomeMessage, null);
        else await sendTgMessage(botSettings.welcomeMessage, null);
        return true; // same fast path as above
      }
      if (!aiActionPrompt && isSlash) return;
      if (!aiActionPrompt && isCallback) {
        // A tap on a stale/misconfigured button (no matching command) used to
        // get total silence — the customer just sees nothing happen and
        // assumes the bot is broken. Fall back to the main menu instead of a
        // dead end. (aiAction taps are NOT "no match" — they fall through to
        // the regular AI/Task pipeline below instead of hitting this branch.)
        const startCmd = commands.find((c) => c.command?.toLowerCase() === '/start');
        const fallbackText = startCmd?.response || botSettings.welcomeMessage || '';
        const fallbackKb = Array.isArray(startCmd?.keyboard) && startCmd.keyboard.length ? startCmd.keyboard : null;
        if (fallbackText) await sendTgMessage(`Эта функция временно недоступна. Вот главное меню:\n\n${fallbackText}`, fallbackKb);
        return true;
      }

      // Script-flow input handler
      const activeSession = getSession(chatId);

      // Ожидание адреса/телефона после «Оформить заказ» — парсим и сохраняем заказ.
      if (activeSession?.awaitingCheckout && text && !isCallback) {
        const { orderSchema, cur, mode } = activeSession.awaitingCheckout;
        const cart = Array.isArray(activeSession.cart) ? activeSession.cart : [];
        if (!cart.length) { setSession(chatId, { ...activeSession, awaitingCheckout: null }); await sendTgMessage('🛒 Корзина пуста.'); return; }
        const phone = (text.match(/(?:\+7|8|7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}/) || [])[0]?.trim() || '';
        let address;
        if (mode === 'pickup') {
          address = 'Самовывоз'; // при самовывозе адрес не нужен — просим только телефон
        } else {
          address = phone ? text.replace(phone, ' ').replace(/\s*[,;]\s*$/, '').replace(/\s{2,}/g, ' ').trim() : text.trim();
          if (/самовывоз|заберу\s*сам|pickup/i.test(text)) address = address || 'Самовывоз';
        }
        const dcfg = await getDeliveryConfig(user._id);
        await finalizeCartOrder({ buyer: update.message?.from || {}, cart, orderSchema, cur, address, phone, mode: mode || 'delivery', dcfg, deliver: (t, kb) => sendTgMessage(t, kb) });
        return;
      }

      if (activeSession?.awaitingField && text) {
        const field = activeSession.awaitingField;
        const reqMatch = /^__req__:(.+)$/.exec(field);
        const looksLikePhone = field === 'phone' && /^[\+\s\-\(\)0-9]{7,16}$/.test(text.trim());

        if (reqMatch) {
          // Generic required-field round-trip — store under the EXACT schema
          // field name we asked for, then let finalizeOrAskNextRequired decide
          // whether that was the last missing piece or there's another.
          const fieldName = reqMatch[1];
          const bookingData = { ...(activeSession.bookingData || {}), [fieldName]: text.trim() };
          const tgFrom = update.message?.from || {};
          try {
            await finalizeOrAskNextRequired(chatId, user, tgFrom, bookingData, sendTgMessage);
          } catch (err) {
            console.error('❌ Ошибка сохранения бронирования:', err.message);
            clearSession(chatId);
          }
          return;
        }

        if (looksLikePhone || field === 'text') {
          const bookingData = { ...(activeSession.bookingData || {}) };
          if (looksLikePhone) bookingData.phone = text.trim();
          else bookingData.note = text.trim(); // generic free-text answer — keep it, even if no field maps to it explicitly

          const tgFrom = update.message?.from || {};
          let handled = false;
          try {
            handled = await finalizeOrAskNextRequired(chatId, user, tgFrom, bookingData, sendTgMessage);
          } catch (err) {
            console.error('❌ Ошибка сохранения бронирования:', err.message);
          }
          if (handled) return;

          // No booking-like schema at all — fall back to the old plain ack.
          clearSession(chatId);
          const confirmMsg = looksLikePhone
            ? `✅ Номер принят: <b>${text.trim()}</b>\n\nМы свяжемся с вами для подтверждения. Спасибо!`
            : `✅ Принято: <b>${text.trim()}</b>\n\nСпасибо!`;
          await sendTgMessage(confirmMsg, null);
          return;
        }
        clearSession(chatId);
      }

      if (triggerMode === 'mention_only' && text) {
        const lowerText = text.toLowerCase();
        const mentionedByKeyword  = triggerKeyword && lowerText.startsWith(triggerKeyword);
        const mentionedByUsername = bot.botUsername && lowerText.includes(`@${bot.botUsername.toLowerCase()}`);
        const isGroupOrChannel    = update.message.chat.type !== 'private';
        if (isGroupOrChannel && !mentionedByKeyword && !mentionedByUsername) return;
      }

      // ── Доступ к ИИ по роли (внутренние боты-аналитики) ─────────────────────
      // Владелец может ограничить ДИАЛОГ с ИИ только админами/создателями
      // (botSettings.aiAccessRole = 'admin' | 'creator'), чтобы клиенты не
      // общались с ИИ по внутренним данным бизнеса. Дефолт 'all' = как раньше
      // (полностью аддитивно, клиентские боты не затронуты). Кнопки-команды с
      // своим minRole гейтятся отдельно и работают как прежде.
      const aiAccessRole = botSettings.aiAccessRole || 'all';
      if (aiAccessRole !== 'all' && (text || tgVoice?.file_id)) {
        const callerRole = await resolveCallerRole(user._id, 'telegram', chatId);
        if (!roleSatisfies(callerRole, aiAccessRole)) return; // тихо игнорируем не-админов
      }

      let inputImages = [];
      if (tgInPhotos?.length) {
        const largest = tgInPhotos[tgInPhotos.length - 1];
        try {
          const fi = await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${largest.file_id}`)
            .then(r => r.json()).catch(() => null);
          if (fi?.result?.file_path) {
            const buf = await fetch(`https://api.telegram.org/file/bot${tgToken}/${fi.result.file_path}`)
              .then(r => r.arrayBuffer()).catch(() => null);
            if (buf) inputImages.push(`data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`);
          }
        } catch {}
      }
      // ── Voice transcription ──────────────────────────────────────────
      let voiceTranscript = '';
      if (tgVoice?.file_id) {
        try {
          const fi = await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${tgVoice.file_id}`)
            .then(r => r.json()).catch(() => null);
          if (fi?.result?.file_path) {
            const audioBuf = await fetch(`https://api.telegram.org/file/bot${tgToken}/${fi.result.file_path}`)
              .then(r => r.arrayBuffer()).catch(() => null);
            if (audioBuf) {
              // ── Groq Whisper (primary) ──
              if (process.env.GROQ_API_KEY) {
                const form = new FormData();
                form.append('file', new Blob([audioBuf], { type: 'audio/ogg' }), 'voice.ogg');
                form.append('model', 'whisper-large-v3-turbo');
                form.append('language', 'ru');
                form.append('response_format', 'text');
                const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
                  body: form,
                }).catch(() => null);
                if (groqRes?.ok) voiceTranscript = (await groqRes.text().catch(() => '')).trim();
              }
              // ── Google Speech-to-Text (fallback) ──
              if (!voiceTranscript) {
                const sttKey = process.env.GOOGLE_SPEECH_API_KEY || process.env.GOOGLE_API_KEY;
                if (sttKey) {
                  const sttRes = await fetch(
                    `https://speech.googleapis.com/v1/speech:recognize?key=${sttKey}`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        config: {
                          encoding: 'OGG_OPUS',
                          sampleRateHertz: 48000,
                          languageCode: 'ru-RU',
                          alternativeLanguageCodes: ['en-US'],
                          enableAutomaticPunctuation: true,
                        },
                        audio: { content: Buffer.from(audioBuf).toString('base64') },
                      }),
                    }
                  ).then(r => r.json()).catch(() => null);
                  voiceTranscript = sttRes?.results?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
                  if (sttRes?.error) console.warn(`⚠️ Google STT: ${sttRes.error.message}`);
                }
              }
              if (voiceTranscript) console.log(`🎙 Голосовое → "${voiceTranscript}"`);
            }
          }
        } catch (err) {
          console.error('❌ Ошибка распознавания голосового:', err.message);
        }
      }

      // ── Фримиум: ИИ-ответы по премиуму ─────────────────────────────────────
      // Если владелец включил «ИИ-ответы только по премиуму», клиент получает N
      // бесплатных ИИ-ответов, дальше — предложение купить. Владельца/админов и
      // клиентов с активным премиумом не гейтим. Счёт — по прошлым ИИ-ходам чата.
      {
        const ps = await getPaidSettings(user._id);
        if (ps && ps.gate_ai && ps.premium_enabled && isPaymentReady(ps)) {
          const role = await resolveCallerRole(user._id, 'telegram', chatId);
          if (role === 'user' && !(await hasActivePremium(user._id, chatId))) {
            const used = await Task.countDocuments({ userId: user._id, 'context.source': 'telegram', 'context.platformUserId': String(chatId) });
            if (used >= (ps.free_ai_uses || 0)) { await offerPremium(); return; }
          }
        }
      }

      const effectiveText = aiActionPrompt || voiceTranscript || text
        || (tgInPhotos?.length ? 'Пользователь отправил изображение.' : 'Пользователь отправил голосовое сообщение.');

      const sendPlaceholder = async (txt) => {
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: txt }),
        }).catch(() => null);
        const data = await r?.json().catch(() => null);
        return data?.result?.message_id || null;
      };

      // fallbackToSend:true (default) sends a brand new message if the edit
      // itself fails — correct for the one-time final delivery, but dangerous
      // from a polling loop: ANY transient edit failure (Telegram rate-limits
      // rapid edits to the same message, among other reasons) would otherwise
      // spam a new message on every single tick — this actually happened in
      // production via tgletbot.js's identical pattern. Streaming-preview
      // ticks pass fallbackToSend:false; skipping one update is harmless.
      const editPlaceholder = async (msgId, txt, { fallbackToSend = true, keyboard = null } = {}) => {
        // Нормализуем ответ AI в безопасный HTML (Markdown-звёздочки → <b>, и т.п.),
        // как и все прочие исходящие тексты — иначе разметка в живых ответах бота
        // показывалась бы буквально.
        const html = toTelegramHtml(txt);
        const safeTxt = html.length > 4096 ? html.slice(0, 4095) + '…' : html;
        const markup = keyboard ? buildInlineMarkup(keyboard) : null;
        if (!msgId) { if (fallbackToSend) await sendTgMessage(txt, keyboard); return; }
        const body = { chat_id: chatId, message_id: msgId, text: safeTxt, parse_mode: 'HTML' };
        if (markup) body.reply_markup = markup;
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => null);
        if (r?.ok) return;
        const data = await r?.json().catch(() => null);
        // "message is not modified" isn't a real failure — nothing to do.
        if (data?.description?.includes('message is not modified')) return;
        if (fallbackToSend) await sendTgMessage(txt, keyboard);
      };

      const fromUser      = (isCallback ? cbQuery?.from : update.message?.from) || {};
      const tgUsername    = fromUser.username || '';
      const tgDisplayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ');
      const platformUserId = historyMode === 'personal'
        ? String(fromUser.id || chatId)
        : String(chatId);

      const isBlocked = await BlockedEndUser.findOne({
        platform: 'telegram',
        platformUserId,
        $or: [{ blockedBy: user._id }, { isGlobal: true }],
      });
      if (isBlocked) { await sendTgMessage('🚫 Доступ ограничен. Обратитесь к администратору.'); return; }

      const oneHourAgo  = new Date(Date.now() - 60 * 60 * 1000);
      const recentCount = await Task.countDocuments({
        userId: user._id,
        'endUser.platform': 'telegram',
        'endUser.platformUserId': platformUserId,
        createdAt: { $gte: oneHourAgo },
      });
      if (recentCount >= ABUSE_THRESHOLD) {
        await sendTgMessage('⚠️ Слишком много запросов. Пожалуйста, подождите и попробуйте позже.');
        return;
      }

      // ~15 последних реплик ТОЛЬКО этого пользователя (platformUserId), за сутки.
      // ВАЖНО: каждую реплику обрезаем — иначе «хлебные крошки» тапов по меню
      // (у них result = ВЕСЬ каталог/прайс) раздували бы промт в Mistral на
      // килобайты и замедляли ответ. Нам нужен ход разговора, а не дампы экранов.
      const historyTasks = await Task.find({
        userId: user._id,
        'endUser.platform': 'telegram',
        'endUser.platformUserId': platformUserId,
        status: 'completed',
        result: { $exists: true, $ne: null },
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }).sort({ createdAt: -1 }).limit(15).lean();

      let promptWithHistory = effectiveText;
      if (historyTasks.length > 0) {
        const clip = (s, n) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n) + '…' : v; };
        const history = historyTasks.reverse()
          .map(t => `Пользователь: ${clip(t.rawPrompt || t.prompt, 250)}\nАссистент: ${clip(t.result, 450)}`)
          .join('\n\n');
        promptWithHistory = `[История диалога]\n${history}\n\nПользователь: ${effectiveText}`;
      }

      const task = new Task({
        taskId: uuidv4(),
        userId: user._id,
        prompt: promptWithHistory,
        rawPrompt: effectiveText,
        context: { source: 'telegram', chatId, platform: 'telegram', platformUserId: String(chatId), ...(inputImages.length ? { inputImages } : {}) },
        status: 'processing',
        endUser: { platform: 'telegram', platformUserId, username: tgUsername, displayName: tgDisplayName },
        ...(bot?.profileId ? { profileId: bot.profileId } : {}),
      });
      await task.save();

      // 🔔 Track this contact for notification recipient lookup
      setImmediate(async () => {
        try {
          const doc = await UserIntegrations.findOne({ userId: user._id });
          if (!doc) return;
          const inst = doc.telegram.find(t => t.token === tgToken);
          if (!inst) return;
          const entry = { chatId: String(chatId), username: tgUsername || '', displayName: tgDisplayName || '', lastSeen: new Date() };
          const idx = inst.knownContacts.findIndex(c => c.chatId === String(chatId));
          if (idx >= 0) Object.assign(inst.knownContacts[idx], entry);
          else {
            inst.knownContacts.unshift(entry);
            if (inst.knownContacts.length > 200) inst.knownContacts.pop();
          }
          doc.markModified('telegram');
          await doc.save();
        } catch {}
      });

      if (user.subscriptionStatus === 'trial') {
        await User.updateOne({ _id: user._id }, { $inc: { promptsUsed: 1 } });
      }

      let thinkingMsgId;
      try {
        thinkingMsgId = await sendPlaceholder('🤔 Думаю...');

        // ── Стриминг: пока задача обрабатывается, опрашиваем partialResult и
        // прогрессивно редактируем то же сообщение — как в @SiberiAi_bot.
        // processTask() уже пишет partialResult (Groq — каждые ~400мс, Mistral/Qwen —
        // один раз на маркере [END_TEXT]); здесь просто читаем и показываем это.
        // Если за STALL_MS partialResult не меняется (Groq недоступен/пропущен —
        // ход целиком ушёл в медленный синхронный Mistral/Qwen, может занять
        // десятки секунд) — переключаем плейсхолдер на следующую фразу, чтобы
        // чат не выглядел зависшим. Быстрый dual-track Groq (1-3с) это вообще
        // не затрагивает — фразы просто не успевают появиться.
        let pollingActive = true;
        let revealedText = '';
        let lastEditAt = 0;
        let lastChangeAt = Date.now();
        const EDIT_INTERVAL = 1400;
        const STALL_MS = 4000;
        let phraseQueue = shuffledEndUserPhrases();
        let phrasePos = 0;
        const pollLoop = (async () => {
          while (pollingActive) {
            await new Promise((r) => setTimeout(r, 700));
            if (!pollingActive) break;
            const fresh = await Task.findOne({ taskId: task.taskId }).select('partialResult status').lean().catch(() => null);
            if (!fresh) continue;
            const now = Date.now();

            if (fresh.partialResult && fresh.partialResult !== revealedText) {
              // Raw, unprocessed streamed text — strip any in-progress system tag
              // (e.g. a model hallucinating Studio-style <BOT_COMMANDS>) before it
              // can ever reach the chat, same defensive pass as tgletbot.js.
              revealedText = aiService._stripStudioArtifacts(fresh.partialResult);
              lastChangeAt = now;
              if (now - lastEditAt > EDIT_INTERVAL) {
                lastEditAt = now;
                await editPlaceholder(thinkingMsgId, closeUnclosedTags(revealedText) + ' ▌', { fallbackToSend: false }).catch(() => {});
              }
            } else if (now - lastChangeAt > STALL_MS) {
              phrasePos += 1;
              if (phrasePos >= phraseQueue.length) { phraseQueue = shuffledEndUserPhrases(); phrasePos = 0; }
              lastChangeAt = now;
              lastEditAt = now;
              const stallText = revealedText
                ? `${closeUnclosedTags(revealedText)}\n\n${phraseQueue[phrasePos]}`
                : phraseQueue[phrasePos];
              await editPlaceholder(thinkingMsgId, stallText, { fallbackToSend: false }).catch(() => {});
            }

            if (fresh.status === 'completed' || fresh.status === 'error') break;
          }
        })();

        ctx.pace = true; // с этого момента реально шёл AI/браузер — очередь возьмёт паузу
        await aiService.processTask(task);
        pollingActive = false;
        await pollLoop;

        const done = await Task.findOne({ taskId: task.taskId });
        if (done.status === 'completed' && done.result) {
          // aiActionKeyboard возвращает клиенту навигацию после ответа на нажатие
          // кнопки; для обычного чат-сообщения он null (клавиатура не нужна).
          await editPlaceholder(thinkingMsgId, done.result, { keyboard: aiActionKeyboard });
          const imgs = (done.attachments || []).slice(0, 5);
          for (const dataUrl of imgs) {
            try {
              const b64  = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
              const buf  = Buffer.from(b64, 'base64');
              const form = new FormData();
              form.append('chat_id', String(chatId));
              form.append('photo', new Blob([buf], { type: 'image/png' }), 'image.png');
              await fetch(`https://api.telegram.org/bot${tgToken}/sendPhoto`, {
                method: 'POST', body: form,
              }).catch(() => {});
            } catch {}
          }
          // Если ИИ этим ходом оформил заказ (DB_COMMAND в схему заказов), минуя
          // нативную корзину — владелец и админы всё равно получат уведомление.
          await notifyNewOrdersForChat(user, tgToken, bot?.botUsername || '', chatId,
            { name: tgDisplayName, username: tgUsername, id: platformUserId });
        } else {
          await editPlaceholder(thinkingMsgId, aiFailureMessage({ source: 'telegram', userId: user._id, reason: done?.error, taskId: task.taskId }));
        }

        if (integDoc.webhookCallback?.enabled && integDoc.webhookCallback?.url) {
          fetch(integDoc.webhookCallback.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'telegram', chatId, prompt: effectiveText,
              result: done.result, attachments: done.attachments || [], taskId: task.taskId,
            }),
          }).catch(() => {});
        }
      } catch (err) {
        console.error('Telegram task error:', err.message);
        await editPlaceholder(thinkingMsgId, aiFailureMessage({ source: 'telegram', userId: user._id, reason: err.message, taskId: task.taskId }));
      }
    }); // enqueueChat tg
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});

// ── VK CALLBACK API WEBHOOK ───────────────────────────────────────────────────
router.post('/webhook/vk/:userId/:instanceId', async (req, res) => {
  try {
    const { userId, instanceId } = req.params;
    const body = req.body;
    console.log('[VK] incoming type:', body.type, 'userId:', userId, 'instanceId:', instanceId);

    const integDoc = await UserIntegrations.findOne({ userId });
    const instance = integDoc?.vk?.id(instanceId);
    if (!instance) { console.log('[VK] no vk instance'); return res.send('ok'); }

    if (body.type === 'confirmation') {
      if (instance.confirmString) {
        await UserIntegrations.findOneAndUpdate(
          { userId, 'vk._id': instanceId },
          { $set: { 'vk.$.connected': true, 'vk.$.connectedAt': new Date() } }
        );
        return res.send(instance.confirmString);
      }
      return res.send('ok');
    }

    res.send('ok');

    if (body.type !== 'message_new') { console.log('[VK] skipping type:', body.type); return; }
    const text        = body.object?.message?.text || body.object?.text || '';
    const peerId      = body.object?.message?.peer_id || body.object?.user_id;
    const vkAttachments = body.object?.message?.attachments || [];
    const hasVkPhoto  = vkAttachments.some(a => a.type === 'photo');
    if ((!text && !hasVkPhoto) || !peerId) { console.log('[VK] no text or peerId'); return; }
    if (text && /^\/\w+/.test(text.trim())) return;

    enqueueChat(`ai:${userId}:${peerId}`, async (ctx) => {
      const user = await User.findById(userId);
      if (!user || (typeof user.isBlocked === 'function' && user.isBlocked()) || (!FREE_MODE && !user.isAccessActive())) return;
      if (!instance.connected || !instance.token) return;

      const sendVk = async (message) => {
        const randomId = Math.floor(Math.random() * 1e9);
        await fetch(`https://api.vk.com/method/messages.send?v=5.199`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ access_token: instance.token, peer_id: peerId, message, random_id: randomId }),
        }).catch(() => {});
      };

      let vkInputImages = [];
      if (hasVkPhoto) {
        const photoAttach = vkAttachments.find(a => a.type === 'photo');
        const sizes   = photoAttach?.photo?.sizes || [];
        const maxSize = sizes.reduce((a, b) => ((a.width || 0) > (b.width || 0) ? a : b), sizes[0]);
        if (maxSize?.url) {
          const buf = await fetch(maxSize.url).then(r => r.arrayBuffer()).catch(() => null);
          if (buf) vkInputImages.push(`data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`);
        }
      }
      const vkEffectiveText = text || 'Пользователь отправил изображение.';
      const platformUserId  = String(peerId);
      const fromId          = body.object?.message?.from_id || body.object?.user_id;

      let vkUsername = '', vkDisplayName = '';
      if (fromId && fromId > 0) {
        const vkUserResp = await fetch(
          `https://api.vk.com/method/users.get?v=5.199&access_token=${instance.token}&user_ids=${fromId}&fields=screen_name`
        ).then(r => r.json()).catch(() => null);
        const vkUser = vkUserResp?.response?.[0];
        if (vkUser) {
          vkUsername    = vkUser.screen_name || '';
          vkDisplayName = [vkUser.first_name, vkUser.last_name].filter(Boolean).join(' ');
        }
      }

      const isBlockedVk = await BlockedEndUser.findOne({
        platform: 'vk', platformUserId, $or: [{ blockedBy: user._id }, { isGlobal: true }],
      });
      if (isBlockedVk) { await sendVk('🚫 Доступ ограничен. Обратитесь к администратору.'); return; }

      const recentCountVk = await Task.countDocuments({
        userId: user._id, 'endUser.platform': 'vk', 'endUser.platformUserId': platformUserId,
        createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      });
      if (recentCountVk >= ABUSE_THRESHOLD) {
        await sendVk('⚠️ Слишком много запросов. Пожалуйста, подождите и попробуйте позже.');
        return;
      }

      const historyTasksVk = await Task.find({
        userId: user._id, 'endUser.platform': 'vk', 'endUser.platformUserId': platformUserId,
        status: 'completed', result: { $exists: true, $ne: null },
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }).sort({ createdAt: -1 }).limit(5).lean();

      let vkPromptWithHistory = vkEffectiveText;
      if (historyTasksVk.length > 0) {
        const history = historyTasksVk.reverse()
          .map(t => `Пользователь: ${t.rawPrompt || t.prompt}\nАссистент: ${t.result}`)
          .join('\n\n');
        vkPromptWithHistory = `[История диалога]\n${history}\n\nПользователь: ${vkEffectiveText}`;
      }

      const task = new Task({
        taskId: uuidv4(),
        userId: user._id,
        prompt: vkPromptWithHistory,
        rawPrompt: vkEffectiveText,
        context: { source: 'vk', peerId, platform: 'vk', platformUserId: String(peerId), ...(vkInputImages.length ? { inputImages: vkInputImages } : {}) },
        status: 'processing',
        endUser: { platform: 'vk', platformUserId, username: vkUsername, displayName: vkDisplayName },
        ...(instance?.profileId ? { profileId: instance.profileId } : {}),
      });
      await task.save();

      if (user.subscriptionStatus === 'trial') {
        await User.updateOne({ _id: user._id }, { $inc: { promptsUsed: 1 } });
      }

      try {
        ctx.pace = true; // с этого момента реально шёл AI/браузер — очередь возьмёт паузу
        await aiService.processTask(task);
        const done = await Task.findOne({ taskId: task.taskId });
        if (done.status === 'completed' && done.result) {
          await sendVk(done.result);
          const vkImgs = (done.attachments || []).slice(0, 5);
          for (const dataUrl of vkImgs) {
            try {
              const uploadServerResp = await fetch(
                `https://api.vk.com/method/photos.getMessagesUploadServer?v=5.199&access_token=${instance.token}&peer_id=${peerId}`
              ).then(r => r.json()).catch(() => null);
              const uploadUrl = uploadServerResp?.response?.upload_url;
              if (!uploadUrl) continue;
              const b64  = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
              const buf  = Buffer.from(b64, 'base64');
              const form = new FormData();
              form.append('photo', new Blob([buf], { type: 'image/png' }), 'image.png');
              const uploadResp = await fetch(uploadUrl, { method: 'POST', body: form }).then(r => r.json()).catch(() => null);
              if (!uploadResp?.photo) continue;
              const saveResp = await fetch(
                `https://api.vk.com/method/photos.saveMessagesPhoto?v=5.199&access_token=${instance.token}&server=${uploadResp.server}&photo=${encodeURIComponent(uploadResp.photo)}&hash=${uploadResp.hash}`
              ).then(r => r.json()).catch(() => null);
              const photo = saveResp?.response?.[0];
              if (!photo) continue;
              await fetch(`https://api.vk.com/method/messages.send?v=5.199`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  access_token: instance.token, peer_id: peerId,
                  attachment: `photo${photo.owner_id}_${photo.id}`,
                  random_id: Math.floor(Math.random() * 1e9),
                }),
              }).catch(() => {});
            } catch {}
          }
        } else {
          await sendVk(aiFailureMessage({ source: 'vk', userId: user._id, reason: done?.error, taskId: task.taskId }));
        }

        if (integDoc.webhookCallback?.enabled && integDoc.webhookCallback?.url) {
          fetch(integDoc.webhookCallback.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'vk', peerId, prompt: vkEffectiveText, result: done.result, attachments: done.attachments || [], taskId: task.taskId }),
          }).catch(() => {});
        }
      } catch (err) {
        console.error('VK task error:', err.message);
        await sendVk(aiFailureMessage({ source: 'vk', userId: user._id, reason: err.message, taskId: task.taskId }));
      }
    }); // enqueueChat vk
  } catch (err) {
    console.error('VK webhook error:', err.message);
  }
});

// ── MAX BOT WEBHOOK ───────────────────────────────────────────────────────────
router.post('/webhook/max/:userId/:instanceId', async (req, res) => {
  res.status(200).json({ success: true });

  try {
    const { userId, instanceId } = req.params;
    const body = req.body;
    console.log('[MAX] incoming update_type:', body.update_type, 'userId:', userId, 'instanceId:', instanceId);

    if (body.update_type !== 'message_created') return;

    const text            = body.message?.body?.text || '';
    const chatId          = body.message?.recipient?.chat_id;
    const sender          = body.message?.sender;
    const maxInAttachments = body.message?.body?.attachments || [];
    const hasMaxPhoto     = maxInAttachments.some(a => a.type === 'image');
    if ((!text && !hasMaxPhoto) || !chatId) return;
    if (text && /^\/\w+/.test(text.trim())) return;

    enqueueChat(`ai:${userId}:${chatId}`, async (ctx) => {
      const integDoc = await UserIntegrations.findOne({ userId });
      const instance = integDoc?.max?.id(instanceId);
      if (!instance?.connected || !instance?.token) return;

      const user = await User.findById(userId);
      if (!user || (typeof user.isBlocked === 'function' && user.isBlocked()) || (!FREE_MODE && !user.isAccessActive())) return;

      const maxToken = instance.token;
      const sendMax = async (message) => {
        await fetch(`https://botapi.max.ru/messages?access_token=${maxToken}&chat_id=${chatId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        }).catch(() => {});
      };

      const platformUserId = String(sender?.user_id || chatId);
      const maxUsername    = sender?.username || '';
      const maxDisplayName = sender?.name || '';

      const isBlocked = await BlockedEndUser.findOne({
        platform: 'max', platformUserId, $or: [{ blockedBy: user._id }, { isGlobal: true }],
      });
      if (isBlocked) { await sendMax('🚫 Доступ ограничен.'); return; }

      const recentCount = await Task.countDocuments({
        userId: user._id, 'endUser.platform': 'max', 'endUser.platformUserId': platformUserId,
        createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      });
      if (recentCount >= ABUSE_THRESHOLD) {
        await sendMax('⚠️ Слишком много запросов. Пожалуйста, подождите.');
        return;
      }

      const historyTasksMax = await Task.find({
        userId: user._id, 'endUser.platform': 'max', 'endUser.platformUserId': platformUserId,
        status: 'completed', result: { $exists: true, $ne: null },
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }).sort({ createdAt: -1 }).limit(5).lean();

      const maxEffectiveText = text || 'Пользователь отправил изображение.';
      let maxPromptWithHistory = maxEffectiveText;
      if (historyTasksMax.length > 0) {
        const history = historyTasksMax.reverse()
          .map(t => `Пользователь: ${t.rawPrompt || t.prompt}\nАссистент: ${t.result}`)
          .join('\n\n');
        maxPromptWithHistory = `[История диалога]\n${history}\n\nПользователь: ${maxEffectiveText}`;
      }

      const task = new Task({
        taskId: uuidv4(),
        userId: user._id,
        prompt: maxPromptWithHistory,
        rawPrompt: maxEffectiveText,
        context: { source: 'max', chatId, platform: 'max', platformUserId: String(sender?.user_id || chatId) },
        status: 'processing',
        endUser: { platform: 'max', platformUserId, username: maxUsername, displayName: maxDisplayName },
        ...(instance?.profileId ? { profileId: instance.profileId } : {}),
      });
      await task.save();

      if (user.subscriptionStatus === 'trial') {
        await User.updateOne({ _id: user._id }, { $inc: { promptsUsed: 1 } });
      }

      try {
        ctx.pace = true; // с этого момента реально шёл AI/браузер — очередь возьмёт паузу
        await aiService.processTask(task);
        const done = await Task.findOne({ taskId: task.taskId });
        if (done.status === 'completed' && done.result) {
          await sendMax(done.result);
          const imgs = (done.attachments || []).slice(0, 5);
          for (const dataUrl of imgs) {
            try {
              const b64  = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
              const buf  = Buffer.from(b64, 'base64');
              const form = new FormData();
              form.append('image', new Blob([buf], { type: 'image/png' }), 'image.png');
              const uploadResp = await fetch(`https://botapi.max.ru/uploads?access_token=${maxToken}&type=image`, {
                method: 'POST', body: form,
              }).then(r => r.json()).catch(() => null);
              if (uploadResp?.token) {
                await fetch(`https://botapi.max.ru/messages?access_token=${maxToken}&chat_id=${chatId}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ attachments: [{ type: 'image', payload: { token: uploadResp.token } }] }),
                }).catch(() => {});
              }
            } catch {}
          }
        } else {
          await sendMax(aiFailureMessage({ source: 'max', userId: user._id, reason: done?.error, taskId: task.taskId }));
        }
      } catch (err) {
        console.error('MAX task error:', err.message);
        await sendMax(aiFailureMessage({ source: 'max', userId: user._id, reason: err.message, taskId: task.taskId }));
      }
    }); // enqueueChat max
  } catch (err) {
    console.error('MAX webhook error:', err.message);
  }
});

// ── Generic payment webhook receiver for end-user bots ─────────────────────────
// Lets a bot owner accept real payments with minimal setup: paste this URL
// (with its embedded secret) into their payment provider's notification
// settings. Best-effort across providers — protected by the unguessable
// ObjectIds in the path plus a shared secret query param, not per-provider
// cryptographic signatures (those need the PROVIDER ACCOUNT's own secret,
// which only the end user has, never Siberi).
router.post('/webhook/payment/:userId/:instanceId', async (req, res) => {
  res.status(200).send('OK');
  try {
    const { userId, instanceId } = req.params;
    const integDoc = await UserIntegrations.findOne({ userId });
    const bot = integDoc?.telegram?.id(instanceId);
    if (!bot?.paymentWebhookSecret) return;
    if (req.query.secret !== bot.paymentWebhookSecret) return;

    const user = await User.findById(userId);
    if (!user || (typeof user.isBlocked === 'function' && user.isBlocked()) || (!FREE_MODE && !user.isAccessActive())) return;

    const body = req.body || {};
    let amount = 0, currency = 'RUB', label = '', success = false, provider = 'unknown';

    if (body.notification_type) {
      // YooMoney classic HTTP-notification
      provider = 'yoomoney';
      success = body.notification_type === 'p2p-incoming' || body.notification_type === 'card-incoming';
      amount = parseFloat(body.amount || body.withdraw_amount || 0);
      label = body.label || '';
    } else if (body.event) {
      // YooKassa-style JSON webhook
      provider = 'yookassa';
      success = body.event === 'payment.succeeded' || body.object?.status === 'succeeded';
      amount = parseFloat(body.object?.amount?.value || 0);
      currency = body.object?.amount?.currency || 'RUB';
      label = body.object?.metadata?.label || body.object?.id || '';
    } else {
      // Unknown shape — store raw, only treat as a success if it says so explicitly
      provider = 'generic';
      amount = parseFloat(body.amount || 0);
      label = body.label || body.id || '';
      success = body.status === 'succeeded' || body.success === true;
    }
    if (!success) return;

    // Record the payment in a 'payments' schema (auto-created on first use)
    let schema = await UserSchema.findOne({ userId, name: 'payments' });
    if (!schema) {
      schema = await UserSchema.create({
        userId, name: 'payments', label: 'Платежи', icon: '💳',
        fields: [
          { name: 'amount', label: 'Сумма', type: 'number' },
          { name: 'currency', label: 'Валюта', type: 'text' },
          { name: 'provider', label: 'Платёжная система', type: 'text' },
          { name: 'label', label: 'Метка', type: 'text' },
          { name: 'raw', label: 'Данные', type: 'text' },
        ],
      });
    }
    const record = await UserRecord.create({
      userId, schemaName: 'payments',
      data: { amount, currency, provider, label, raw: JSON.stringify(body).slice(0, 2000) },
      metadata: { createdBy: 'ai', source: 'api' },
    });

    triggerEventRules(userId, 'create', 'payments', [record], bot.profileId).catch(() => {});

    // Платная функция бота (премиум/товар): метка <chatId>_pf_<code>_<ts> →
    // выдаём покупку клиенту и уведомляем его. Детерминированно, по метке.
    const paidInfo = parsePaidLabel(label);
    if (paidInfo && bot.token) {
      await grantPaidPurchase(userId, bot.token, paidInfo, amount).catch((e) => console.warn('grantPaid:', e.message));
      return;
    }

    // Best-effort customer notification — only if the label looks like a Telegram chat_id
    // (the bot owner's own payment-link generator can encode it that way to enable this)
    const chatIdMatch = String(label).match(/^-?\d{5,}$/);
    if (chatIdMatch && bot.token) {
      fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatIdMatch[0], text: '✅ Оплата получена! Спасибо.' }),
      }).catch(() => {});
    }
  } catch (err) {
    console.error('Payment webhook (end-user bot) error:', err.message);
  }
});

module.exports = router;
