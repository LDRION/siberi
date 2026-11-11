'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

const aiService        = require('../AiService');
const Task             = require('../models/Task');
const User             = require('../models/User');
const UserAiConfig     = require('../models/UserAiConfig');
const UserIntegrations = require('../models/UserIntegrations');
const EmbedToken       = require('../models/EmbedToken');
const NotificationRule = require('../models/NotificationRule');
const UserAdmin        = require('../models/UserAdmin');
const UserRecord       = require('../models/UserRecord');
const UserSchema       = require('../models/UserSchema');
const UserSyncConfig   = require('../models/UserSyncConfig');
const UserAffiliate    = require('../models/UserAffiliate');
const BotSnapshot      = require('../models/BotSnapshot');
const BotTemplate      = require('../models/BotTemplate');
const BotTemplatePurchase = require('../models/BotTemplatePurchase');
const { grantTemplatePurchase, PLATFORM_COMMISSION } = require('../helpers/marketplace');
const { findOrCreateOAuthUser } = require('../helpers/oauthUser');
const { connectTelegramBot }    = require('../helpers/telegramConnect');
const { validateTelegramInitData } = require('../helpers/telegramInitData');
const { isDuplicateUpdate } = require('../helpers/dedupeUpdate');
const { aiFailureMessage } = require('../helpers/aiFailureMessage');
const { getOrCreateStudioProfile } = require('./studio');
const { fireAiNotification, buildPrompt } = require('../notificationProcessor');
const { toTelegramHtml, htmlEscape } = require('../helpers/telegramFormat');
const tglbAccess = require('../services/tglbAccess');
const { cartAdd, cartTotal, cartCount, fmtMoney, extractItem, stripCartButtons, placeCountedCart } = require('../helpers/cart');
const { templateContextBlock, matchTemplate } = require('../botTemplates');
const { getBanner, setBanner, bannerForCommand, sameMenu, sendBannerPhoto, renderStep } = require('../helpers/banners');
const { ensureDeliverySchema, DELIVERY_SCHEMA, FIELDS: DELIVERY_FIELDS, DEFAULTS: DELIVERY_DEFAULTS } = require('../helpers/delivery');
const { ensurePaidSchemas, getPaidSettings, SETTINGS_SCHEMA: PAID_SCHEMA, SETTINGS_FIELDS: PAID_FIELDS } = require('../helpers/paid');
const tbank = require('../helpers/tbank');
const { isPlatformAdmin, isPlatformAdminUser, computeAdminMetrics, renderAdminMetrics, findUserByHandle, renderUserCard, grantAccess, revokeAccess, blockUser, unblockUser, newUsers, renderNewUsers, newUsersKeyboard, getPlatformAdminChatIds } = require('../helpers/metrics');
const BotFeedback = require('../models/BotFeedback');
const { detectFraudIntent } = require('../helpers/fraudWatch');
const checkAccess = require('../middleware/checkAccess');

const TGLETBOT_TOKEN = process.env.TGLETBOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TGLETBOT_TOKEN}`;
const TRIAL_DAYS  = 1; // 1 сутки; +6 дней (до недели) — за подписку на @aicupdates
const AICUPDATES_CHANNEL = process.env.AICUPDATES_CHANNEL || '@aicupdates';
const CHANNEL_BONUS_DAYS = 6;

// ── Бесплатный режим (фарм трафика) ──────────────────────────────────────────
// Тарифы Конструктора временно выключены: платной стены нет, цены нигде не
// показываем. Платный код НЕ удалён — он весь на месте и оживает флагом.
//
// Что ОСТАЁТСЯ работать (принципиально, это ростовой крючок):
//   сутки доступа → заморозка → подписка на @aicupdates → доступ открыт.
// Единственная «цена» теперь — подписка на канал.
//
// Что ВЫКЛЮЧЕНО: стена «Бесплатный период закончился → купи тариф» после того,
// как бонус за канал получен.
//
// Вернуть тарифы: TGLB_FREE_MODE=false в server/.env + pm2 restart siberi-api.
// По умолчанию — free: если переменная потеряется при переезде, юзер получит
// бесплатный доступ (не страшно), а не стену вопреки обещанию на сайте.
const FREE_MODE = process.env.TGLB_FREE_MODE !== 'false';
const ABUSE_THRESHOLD = parseInt(process.env.TGLETBOT_ABUSE_THRESHOLD) || 30;
const MINIAPP_URL = process.env.TGLETBOT_MINIAPP_URL || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Per-chat sequential queue (mirrors routes/webhooks.js) ────────────────────
const chatQueues = new Map();
function enqueueChat(key, fn) {
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    try { await fn(); } catch (err) { console.error(`[tgletbot:${key}]`, err.message); }
  });
  next.finally(() => { if (chatQueues.get(key) === next) chatQueues.delete(key); });
  chatQueues.set(key, next);
  return next;
}

// ── Ephemeral per-chat session — only for state NOT derivable from DB ─────────
// (pendingTaskId, preview-interactive flag, transient mode like awaiting_token).
// User/profile/connection state is always re-derived from Mongo on every message.
const sessions = new Map();
const SESSION_TTL = 45 * 60 * 1000;
function getSession(chatId) {
  const key = String(chatId);
  const s = sessions.get(key);
  if (s && Date.now() < s.expiresAt) return s;
  if (s) sessions.delete(key);
  return {};
}
function setSession(chatId, data) {
  sessions.set(String(chatId), { ...data, expiresAt: Date.now() + SESSION_TTL });
}
function clearSession(chatId) {
  sessions.delete(String(chatId));
}

function makeAccessCode() {
  const h = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

// ── Telegram send helpers ──────────────────────────────────────────────────────
// Keyboard rows accept plain label strings (callback_data = label, for resolving
// against a bot's own botSettings.commands — same convention as routes/webhooks.js)
// or { text, data } / { text, url } / { text, webApp } for our own control buttons.
function buildInlineMarkup(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  // Толерантно к кривой форме (плоский ряд от AI в превью, пустые ячейки) —
  // некорректная клавиатура не должна ронять отправку.
  const built = rows
    .map((row) => (Array.isArray(row) ? row : [row])
      .map((item) => {
        if (typeof item === 'string') return item.trim() ? { text: item, callback_data: item.slice(0, 64) } : null;
        if (!item || typeof item !== 'object' || !item.text) return null;
        if (item.webApp) return { text: item.text, web_app: { url: item.webApp } };
        if (item.url) return { text: item.text, url: item.url };
        return { text: item.text, callback_data: (item.data || item.text).slice(0, 64) };
      })
      .filter(Boolean))
    .filter((r) => r.length);
  return built.length ? { inline_keyboard: built } : null;
}

// Telegram hard-rejects any sendMessage/editMessageText whose text exceeds 4096
// chars (the whole call fails, nothing is delivered) — split long AI replies
// into several messages instead of silently dropping them.
const TG_MAX_LEN = 4096;
function splitForTelegram(text, maxLen = TG_MAX_LEN) {
  const str = text || '';
  if (str.length <= maxLen) return [str];
  const chunks = [];
  let remaining = str;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// STUDIO_SYSTEM_PROMPT tells the AI to use Telegram Markdown (*bold* _italic_
// `code` [text](url)) — parse_mode is required or those render as literal
// asterisks. Markdown can go unbalanced mid-stream or on AI quirks, so retry as
// plain text rather than silently failing.
async function sendTgMessageRaw(chatId, text, { keyboard } = {}) {
  const inlineMarkup = buildInlineMarkup(keyboard);
  const mkBody = (extra = {}) => {
    const b = { chat_id: chatId, text, ...extra };
    if (inlineMarkup) b.reply_markup = inlineMarkup;
    return b;
  };
  // Нормализуем в безопасный HTML (HTML/Markdown/plain → валидный HTML) и всегда
  // шлём parse_mode:'HTML'. На маловероятной ошибке разбора — откат в plain.
  const html = toTelegramHtml(text);
  const r = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mkBody({ parse_mode: 'HTML', text: html })),
  }).catch(() => null);
  let data = await r?.json().catch(() => null);
  if (!data?.ok) {
    const r2 = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mkBody()),
    }).catch(() => null);
    data = await r2?.json().catch(() => null);
  }
  return data?.result?.message_id || null;
}

async function sendTgMessage(chatId, text, { keyboard } = {}) {
  const chunks = splitForTelegram(text);
  let lastId = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    lastId = await sendTgMessageRaw(chatId, chunks[i], isLast ? { keyboard } : {});
  }
  return lastId;
}

// allowOverflow=false (default) is the ONLY safe mode for anything called
// repeatedly from a polling loop (streaming previews, stall phrases) — it just
// truncates to one message. A growing raw response that keeps exceeding 4096
// chars would otherwise get its ever-larger tail re-sent as a NEW message on
// every single poll tick, spamming the chat dozens of times in a row (this
// actually happened in production). Only the ONE-TIME final-result delivery
// after polling has stopped should ever pass allowOverflow:true.
//
// fallbackToSend=true (default) sends a brand new message if the edit itself
// fails — correct for a one-time final delivery, but actively dangerous from a
// polling loop: ANY transient edit failure (Telegram rate-limits rapid edits
// to the same message, among other reasons) would otherwise spam a new
// message on every single tick (this also actually happened in production —
// the same growing text sent 40-50 times). Streaming/stall ticks pass
// fallbackToSend:false — skipping one preview update is harmless, the next
// tick just tries again.
async function editTgMessage(chatId, messageId, text, { keyboard, allowOverflow = false, fallbackToSend = true } = {}) {
  if (!messageId) { if (fallbackToSend) await sendTgMessage(chatId, text, { keyboard }); return; }
  const chunks = allowOverflow
    ? splitForTelegram(text)
    : [text.length > TG_MAX_LEN ? text.slice(0, TG_MAX_LEN - 1) + '…' : text];
  const firstChunkKeyboard = chunks.length === 1 ? keyboard : undefined;
  const inlineMarkup = buildInlineMarkup(firstChunkKeyboard);
  const mkBody = (extra = {}) => {
    const b = { chat_id: chatId, message_id: messageId, text: chunks[0], ...extra };
    if (inlineMarkup) b.reply_markup = inlineMarkup;
    return b;
  };
  // "message is not modified" isn't a real failure — the content is already
  // exactly this (e.g. the visible text already finished streaming while the
  // model keeps working silently on config tags) — there's nothing to send.
  const isNotModified = (d) => d?.description?.includes('message is not modified');

  const html = toTelegramHtml(chunks[0]);
  const r = await fetch(`${TG_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mkBody({ parse_mode: 'HTML', text: html })),
  }).catch(() => null);
  let data = await r?.json().catch(() => null);
  let editOk = data?.ok;
  if (!editOk && isNotModified(data)) return;
  if (!editOk) {
    const r2 = await fetch(`${TG_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mkBody()),
    }).catch(() => null);
    data = await r2?.json().catch(() => null);
    editOk = data?.ok;
    if (!editOk && isNotModified(data)) return;
  }
  // On edit failure, fall back to sending — but only the already-safe chunks[0]
  // when overflow isn't allowed, never the raw (possibly huge) original text.
  if (!editOk) {
    if (fallbackToSend) await sendTgMessage(chatId, allowOverflow ? text : chunks[0], { keyboard });
    return;
  }

  // Telegram has no "append to an existing message" — any overflow beyond the
  // first chunk has to go out as additional, separate messages.
  for (let i = 1; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await sendTgMessage(chatId, chunks[i], isLast ? { keyboard } : {});
  }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId) return;
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = text; // всплывающий тост
  fetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

async function sendChatAction(chatId, action = 'typing') {
  fetch(`${TG_API}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => {});
}

// ── Control keyboards ──────────────────────────────────────────────────────────
const BUILDING_KEYBOARD = [
  [{ text: '👀 Проверить', data: 'tglb:preview' }],
  [{ text: '✏️ Редактировать бота', data: 'tglb:edit' }, { text: '🚀 Завершить создание', data: 'tglb:finish' }],
];
const LIVE_KEYBOARD = [[{ text: '👀 Проверить', data: 'tglb:preview' }]];
const EDIT_OR_FINISH_KEYBOARD = [
  [{ text: '✏️ Редактировать бота', data: 'tglb:edit' }, { text: '🚀 Завершить создание', data: 'tglb:finish' }],
];
const EDIT_ONLY_KEYBOARD = [[{ text: '✏️ Редактировать бота', data: 'tglb:edit' }]];
// Меню повторного входа (/start при уже созданном боте). Строится динамически:
// сверху даём быстрый доступ к самому боту и «Мои данные», ниже — управление.
function buildReentryKeyboard(liveInstance) {
  const rows = [];
  if (liveInstance?.botUsername) rows.push([{ text: '🚀 Открыть бота', url: `https://telegram.me/${liveInstance.botUsername}` }]);
  if (MINIAPP_URL) rows.push([{ text: '📂 Мои данные', webApp: MINIAPP_URL }]);
  rows.push([{ text: '✏️ Редактировать', data: 'tglb:keep' }]);
  rows.push([{ text: '🗑 Удалить и начать заново', data: 'tglb:restart' }]);
  return rows;
}
const CONFIRM_DELETE_KEYBOARD = [
  [{ text: '✅ Подтвердить', data: 'tglb:restart_confirm' }, { text: '❌ Отменить', data: 'tglb:restart_cancel' }],
];
const TOKEN_HELP_KEYBOARD = [[{ text: '❓ Как получить токен?', data: 'tglb:howtoken' }]];

// Rotating status lines shown from the moment a prompt is sent, so the wait never
// feels frozen — even fast (few-second) Groq turns get a couple of these in,
// and slow Mistral/Qwen fallback turns cycle through many more. Shuffled per turn
// (see shuffledPhrases()) so the order varies and nothing repeats until exhausted.
const THINKING_PHRASES = [
  '🤔 Думаю над твоим ботом...',
  '🧠 Прорабатываю логику и сценарии...',
  '🗂 Составляю схему данных...',
  '⚙️ Настраиваю меню и кнопки...',
  '🎨 Продумываю сценарии диалога...',
  '✨ Собираю всё вместе...',
  '🔍 Проверяю логику работы твоего бота...',
  '📝 Формулирую тексты ответов...',
  '🧩 Связываю кнопки между собой...',
  '🚀 Докручиваю детали...',
  '💡 Придумываю удобный сценарий для клиентов...',
  '🛠 Настраиваю поведение бота...',
  '📋 Раскладываю меню по полочкам...',
  '🧵 Сшиваю всё в единый сценарий...',
  '🎯 Проверяю, чтобы каждая кнопка работала...',
  '🌟 Добавляю последние штрихи...',
  '📐 Выравниваю структуру бота...',
  '🔧 Устраняю возможные нестыковки...',
  '🤓 Думаю, как сделать удобнее для клиентов...',
  '⏳ Ещё чуть-чуть, почти готово...',
];

function shuffledPhrases() {
  const arr = [...THINKING_PHRASES];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const WELCOME_TEXT = `👋 Привет! Я AI Constructor Bot — соберу тебе настоящего Telegram-бота прямо в этом чате.

Просто опиши, какой бот нужен, например:
«Создай бота для кофейни» или «Бот для цветочного магазина FlowerSiberi»

Я настрою меню, AI-помощника и (если нужно) базу данных. Через пару сообщений сможешь проверить бота и запустить его под своим токеном — 1 день бесплатно (+6 дней за подписку на @aicupdates), дальше от 1000₽/мес.

Команда /menu — что я умею, подробно.

Новости и обновления — @aicupdates`;

// Живое приглашение начать сборку — используется, когда бота ещё/уже нет и мы
// ждём идею от пользователя (чистый /start без бота, а также сразу после
// удаления старого бота, чтобы сценарий не выглядел «мёртвым»).
const NEW_BOT_INVITE = `✨ Погнали собирать бота! Опиши свою идею одним сообщением — соберу за пару минут.

Например:
• «Бот для доставки цветов с каталогом и заказом»
• «Бот-меню для кофейни с ценами»
• «Бот для записи в барбершоп»

Жду твою идею 👇`;

const TOKEN_INSTRUCTIONS = `🔑 Чтобы бот заработал, нужен токен от @BotFather.

1. Открой @BotFather в Telegram
2. Отправь команду /newbot
3. Придумай имя и username (должен заканчиваться на "bot")
4. BotFather пришлёт токен вида 123456:ABC-DEF... — скопируй его целиком и пришли мне`;

const MENU_TEXT = `Что умеет AI Constructor Bot

1. Бот за пару промтов
Опиши бизнес — получишь рабочего Telegram-бота с меню и AI-помощником внутри. Первая неделя бесплатно, дальше от 1000₽/мес (Standard — 1000₽, Premium — 2000₽: повышенная скорость ИИ и приоритетная очередь).

2. AI знает все твои данные
Всё, что хранится в «Мои данные» (товары, цены, клиенты — что угодно) — AI-помощник твоего бота видит и использует сразу. Меняешь данные — бот узнаёт об этом автоматически, без перенастройки.

3. Автоматические уведомления и отчёты
Можешь попросить, например: «напоминай клиентам за час до записи» или «каждое утро присылай отчёт по продажам» — бот сам будет следить и присылать сообщения в нужный момент. Команда /notify — посмотреть и проверить уже настроенные уведомления.

Ещё полезное:
/data — открыть Мои данные
/admins — администраторы твоего бота
/payments — подключить приём платежей в свой бот
/aisettings — системный промпт и ограничения AI`;

function buildMenuKeyboard() {
  const rows = [];
  if (MINIAPP_URL) rows.push([{ text: 'Мои данные', webApp: MINIAPP_URL }]);
  rows.push([{ text: 'Мои уведомления', data: 'tglb:notify_list' }, { text: 'Администраторы', data: 'tglb:admins' }]);
  rows.push([{ text: '⚙️ Настройки AI', data: 'tglb:aisettings' }]);
  return rows;
}

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || '—'));

// ── AI Settings — mirrors the website's Bot Studio settings page (systemPrompt
// + restrictions, the same two fields/limits as routes/config.js's /config
// route) so an owner can manage them directly without going through the
// builder chat, and can lock them from prompt-driven edits entirely. ─────────
async function showAiSettings(chatId, user, profile) {
  if (!profile) { await sendTgMessage(chatId, 'Сначала создай бота.'); return; }
  const fresh = await UserAiConfig.findById(profile._id).select('systemPrompt restrictions promptEditLocked').lean();
  const lockLine = fresh?.promptEditLocked
    ? '🔒 Правки промтом ЗАПРЕЩЕНЫ — менять можно только здесь.'
    : '🔓 Правки промтом разрешены — я тоже могу их менять, если попросишь в чате.';
  const msg = `*⚙️ Настройки AI*\n\n_Системный промпт:_\n${trunc(fresh?.systemPrompt, 600)}\n\n_Ограничения:_\n${trunc(fresh?.restrictions, 300)}\n\n${lockLine}`;
  const keyboard = [
    [{ text: '✏️ Изменить промпт', data: 'tglb:edit_sysprompt' }],
    [{ text: '✏️ Изменить ограничения', data: 'tglb:edit_restrictions' }],
    [{ text: fresh?.promptEditLocked ? '🔓 Разрешить правки промтом' : '🔒 Запретить правки промтом', data: 'tglb:toggle_lock' }],
  ];
  await sendTgMessage(chatId, msg, { keyboard });
}

// ── Admins — surfaces the existing ownerCode/adminCode + UserAdmin registry
// (no new infra: AiService.js already auto-registers whoever messages the
// user's live bot with one of these codes) ────────────────────────────────────
// ── Админ-консоль AiConstructor: поиск пользователя по @username + карточка ───
// (бот, статы, подписка) с действиями выдать/снять доступ, заблокировать. Только
// для платформенных админов (проверка isPlatformAdmin у вызывающего кода).
async function handleAdminUserLookup(chatId, handle) {
  const u = await findUserByHandle(handle).catch(() => null);
  if (!u) {
    await sendTgMessage(chatId, `Не нашёл пользователя «${htmlEscape(String(handle))}».\n\nПришли <b>@username</b> (как в Telegram) или числовой Telegram ID. Пользователь должен был хоть раз написать конструктору.`);
    return;
  }
  const { text, keyboard } = await renderUserCard(u);
  await sendTgMessage(chatId, text, { keyboard });
}

async function handleAdminUserCb(chatId, cbData, messageId) {
  if (cbData === 'admu:find') {
    setSession(chatId, { ...(getSession(chatId) || {}), awaitingAdminLookup: true });
    await sendTgMessage(chatId, 'Пришли <b>@username</b> пользователя (как в Telegram, например @ldrion) или его числовой Telegram ID.');
    return;
  }
  const g = cbData.match(/^admu:grant:(\d+):([a-f0-9]{24})$/i);
  const a = cbData.match(/^admu:(revoke|block|unblock|view):([a-f0-9]{24})$/i);
  const uid = g ? g[2] : (a ? a[2] : null);
  if (!uid) return;
  let u = await User.findById(uid).catch(() => null);
  if (!u) { await sendTgMessage(chatId, 'Пользователь не найден.'); return; }
  let note = '';
  if (g) { await grantAccess(u, parseInt(g[1], 10)); note = g[1] === '3650' ? '✅ Доступ выдан навсегда.' : `✅ Доступ выдан на ${g[1]} дн.`; }
  else if (a[1] === 'revoke') { await revokeAccess(u); note = '🚫 Доступ снят.'; }
  else if (a[1] === 'block') {
    if (isPlatformAdminUser(u)) { note = '⚠️ Нельзя заблокировать администратора.'; }
    else { await blockUser(u); note = '⛔ Пользователь и его бот заблокированы.'; }
  } else if (a[1] === 'unblock') { await unblockUser(u); note = '✅ Пользователь разблокирован.'; }
  u = await User.findById(uid).catch(() => u); // перечитываем актуального
  const { text, keyboard } = await renderUserCard(u);
  const body = note ? `${note}\n\n${text}` : text;
  if (messageId) await editTgMessage(chatId, messageId, body, { keyboard });
  else await sendTgMessage(chatId, body, { keyboard });
}

async function showAdmins(chatId, user, profile) {
  if (!profile) { await sendTgMessage(chatId, 'Сначала создай бота.'); return; }
  const fresh = await UserAiConfig.findById(profile._id).lean();
  const admins = await UserAdmin.find({ ownerId: user._id, platform: 'telegram' }).lean();
  let msg = `Код владельца: \`${fresh?.ownerCode || '—'}\`\nКод администратора: \`${fresh?.adminCode || '—'}\`\n\nЧтобы добавить администратора — пусть он напишет твоему боту нужный код в чат (один раз).\n\n`;
  msg += admins.length
    ? 'Сейчас зарегистрированы:\n' + admins.map((a) => `• ${a.displayName || a.platformUserId} — ${a.role === 'creator' ? 'владелец' : 'админ'}`).join('\n')
    : 'Пока никто не зарегистрирован.';
  await sendTgMessage(chatId, msg);
}

// ── Notification preview — always sends the test to the tester's own chat via
// their OWN live bot (never to a rule's real configured recipients), so testing
// can never spam a real customer or admin. ────────────────────────────────────
async function showNotifyList(chatId, user) {
  const rules = await NotificationRule.find({ userId: user._id }).limit(10).lean();
  if (!rules.length) {
    await sendTgMessage(chatId, 'У тебя пока нет настроенных уведомлений.\n\nПросто опиши его в чате — например «напоминай клиентам за час до визита» или «каждый день в 9 утра присылай мне отчёт по продажам» — и я настрою.');
    return;
  }
  const keyboard = rules.map((r) => [{ text: `🔔 ${r.name}`, data: `tglb:notifytest:${r._id}` }]);
  await sendTgMessage(chatId, 'Твои уведомления — нажми, чтобы посмотреть, как будет выглядеть (тест придёт тебе же):', { keyboard });
}

// ── Payment webhook setup — surfaces routes/webhooks.js's generic payment
// receiver: paste one URL into YooMoney/YooKassa's notification settings and
// successful payments auto-save into a 'payments' schema + can trigger /notify
// rules. Secret is minted once per bot instance and reused on repeat calls. ───
async function showPaymentSetup(chatId, user, liveInstance) {
  if (!liveInstance) {
    await sendTgMessage(chatId, 'Сначала запусти бота («Завершить создание») — после этого пришлю адрес для приёма платежей.');
    return;
  }
  let secret = liveInstance.paymentWebhookSecret;
  if (!secret) {
    secret = crypto.randomBytes(16).toString('hex');
    await UserIntegrations.findOneAndUpdate(
      { userId: user._id, 'telegram._id': liveInstance._id },
      { $set: { 'telegram.$.paymentWebhookSecret': secret } }
    );
  }
  const serverUrl = process.env.SERVER_URL || '';
  const url = `${serverUrl}/api/v1/webhook/payment/${user._id}/${liveInstance._id}?secret=${secret}`;
  await sendTgMessage(
    chatId,
    `💳 Приём платежей\n\nВставь этот адрес в настройки уведомлений своей платёжной системы (ЮMoney или ЮKassa — раздел «HTTP-уведомления» / «Webhook»):\n\n\`${url}\`\n\nКаждый успешный платёж автоматически:\n— сохранится в схему «Платежи» (загляни в /data)\n— запустит уведомление, если настроишь правило через /notify\n\nНикому не показывай этот адрес — в нём секретный ключ.`
  );
}

async function testNotifyRule(chatId, user, liveInstance, ruleId) {
  if (!liveInstance) {
    await sendTgMessage(chatId, 'Сначала запусти бота («Завершить создание»), чтобы протестировать уведомления.');
    return;
  }
  const rule = await NotificationRule.findOne({ _id: ruleId, userId: user._id });
  if (!rule) { await sendTgMessage(chatId, 'Не нашёл это уведомление.'); return; }

  await sendTgMessage(chatId, '⏳ Готовлю тестовое уведомление...');
  let sampleRecord = null;
  if (rule.schemaName) {
    sampleRecord = await UserRecord.findOne({ userId: user._id, schemaName: rule.schemaName }).sort({ createdAt: -1 }).lean();
  }
  const prompt = sampleRecord
    ? buildPrompt(rule, [], sampleRecord)
    : `[ТЕСТ УВЕДОМЛЕНИЯ]\n\n[ЗАДАЧА]\n${rule.messagePrompt || 'Сформируй краткое тестовое уведомление.'}`;

  fireAiNotification(rule, String(user.telegramId), prompt).catch(() => {});
  await sendTgMessage(chatId, 'Отправляю тест от твоего бота — проверь чат с ним через несколько секунд. Если не пришло — напиши /start своему боту хотя бы раз, чтобы он мог тебе писать.');
}

// ── Referral attribution — /start ref_CODE deep links from the mini app's
// partner program. Only brand-new users get attributed (same rule as the
// website's ?ref= signup flow in routes/auth.js); the payment webhook in
// routes/payment.js then credits the partner 20% off every payment. ──────────
async function attachReferral(user, rawCode) {
  try {
    const code = String(rawCode || '').toUpperCase().trim();
    if (!code || user.referredBy) return;
    const referrer = await UserAffiliate.findOne({ referralCode: code });
    if (!referrer || String(referrer.userId) === String(user._id)) return;
    user.referredBy = code;
    await user.save();
    referrer.referrals.push({ userId: user._id });
    referrer.notifications.push({ type: 'registration', joinedAt: user.createdAt || new Date() });
    await referrer.save();
  } catch (err) {
    console.warn('TGLetBot referral attach error:', err.message);
  }
}

// ── Полное удаление бота: профили, вебхуки, «Мои данные» и синк-конфиги.
// Общая точка для кнопки «Удалить и начать заново» в чате и кнопки удаления в
// мини-аппе. Прямые Mongoose-удаления — writeBackToSource() не срабатывает:
// внешние Google-таблицы/базы не трогаются, отключается только наша синхронизация.
// keepBanners: при ПЕРЕСБОРКЕ («Начать заново») сохраняем загруженные картинки-
// баннеры — жалко терять, и они переиспользуются на совпадающих экранах нового
// бота. При ПОЛНОМ УДАЛЕНИИ бота (mini-app «Удалить бота») — стираем и их, чтобы
// от бота не осталось ничего: все картинки на всех экранах обнуляются.
async function wipeUserBot(user, { keepBanners = true } = {}) {
  const integDoc = await UserIntegrations.findOne({ userId: user._id });
  const oldProfiles = await UserAiConfig.find({ userId: user._id, profileName: { $ne: '__studio__' } });
  if (integDoc && oldProfiles.length) {
    for (const p of oldProfiles) {
      const insts = (integDoc.telegram || []).filter((i) => String(i.profileId) === String(p._id));
      for (const inst of insts) await fetch(`https://api.telegram.org/bot${inst.token}/deleteWebhook`).catch(() => {});
    }
    integDoc.telegram = (integDoc.telegram || []).filter(
      (i) => !oldProfiles.some((p) => String(i.profileId) === String(p._id))
    );
    await integDoc.save();
  }
  await UserAiConfig.deleteMany({ userId: user._id, profileName: { $ne: '__studio__' } });
  // Баннеры-картинки (схема banners) — загруженные пользователем визуалы,
  // привязанные к экранам по имени (/start и т.п.). При пересборке НЕ стираем
  // (keepBanners=true): жалко терять и они переиспользуются на совпадающих
  // экранах нового бота. При полном удалении бота (keepBanners=false) — стираем
  // всё, включая баннеры: картинки на всех экранах обнуляются.
  const schemaFilter = keepBanners ? { userId: user._id, name: { $ne: 'banners' } } : { userId: user._id };
  const recordFilter = keepBanners ? { userId: user._id, schemaName: { $ne: 'banners' } } : { userId: user._id };
  await UserSchema.deleteMany(schemaFilter);
  await UserRecord.deleteMany(recordFilter);
  await UserSyncConfig.deleteMany({ userId: user._id });
  // Удаляем правила уведомлений удалённых ботов — иначе от каждой пересборки
  // копятся сиротские daily_report и владельцу капает по несколько отчётов.
  await require('../models/NotificationRule').deleteMany({ userId: user._id }).catch(() => {});
}

// ── Profile creation — mirrors routes/config.js's POST /profiles (sync save) ──
// NOTE: deliberately NOT pre-warming a Mistral chat in the background here
// (unlike routes/config.js/oauth.js's website signup, which has natural delay
// before the user's first real message). TGLetBot's whole funnel is "describe
// your bot in the very next message" — the user routinely types their first
// real prompt within seconds of /start. A background createChatForUser() was
// racing against that real prompt on the SAME per-user Playwright page (both
// typing/sending/navigating concurrently, no mutual exclusion between the two
// flows) — confirmed live: the background INIT chat's own cleanup deleted a
// chat right as the real generation was starting, and the real task's own
// completion went undetected because the page got driven out from under it.
// processTask() already creates the context+chat inline on the first real
// message with no concurrent actor involved, so this optimization isn't worth
// the corruption risk for this particular funnel.
async function createDraftProfile(user) {
  const profile = new UserAiConfig({
    userId: user._id,
    profileName: 'Мой бот',
    aiName: 'Бот',
    systemPrompt: 'Ты — полезный AI-ассистент Telegram-бота.',
    ownerCode: makeAccessCode(),
    adminCode: makeAccessCode(),
    isDefault: true,
  });
  await profile.save();
  return profile;
}

// Экран /start конструктора: есть живой бот → меню «что сделать»; есть черновик →
// продолжаем настройку; ничего нет → приглашение собрать бота. Используется и для
// самой команды /start, и как безопасная реакция на ЛЮБУЮ неизвестную слэш-команду
// (/clear, /gogogo…): такие НИКОГДА не уходят в ИИ (иначе он может «понять» их как
// «очисти бота» и снести конфигурацию — реальный баг с /clear).
async function showStartScreen(chatId, user, profile, liveInstance) {
  clearSession(chatId);
  if (liveInstance) {
    setSession(chatId, { mode: 'reentry_choice' });
    await sendTgMessage(chatId, `У тебя уже есть бот @${liveInstance.botUsername}. Что сделать?\n\nНовости и обновления — @aicupdates`, { keyboard: [...buildReentryKeyboard(liveInstance), [FEEDBACK_BTN]] });
  } else if (profile) {
    await sendTgMessage(chatId, 'Продолжим настройку! Опиши, что добавить, или жми «Завершить создание», если всё готово.', { keyboard: [...BUILDING_KEYBOARD, [FEEDBACK_BTN]] });
  } else {
    await sendTgMessage(chatId, NEW_BOT_INVITE, { keyboard: [[FEEDBACK_BTN]] });
  }
}

// ── Push slash-command menu to the live customer bot (mirrors the now-fixed
// pattern in routes/studio.js) ─────────────────────────────────────────────────
async function pushSetMyCommands(user, profileId) {
  try {
    const integDoc = await UserIntegrations.findOne({ userId: user._id });
    const inst = (integDoc?.telegram || []).find((i) => i.connected && String(i.profileId) === String(profileId));
    if (!inst?.token) return;
    const fresh = await UserAiConfig.findById(profileId).lean();
    const slashCommands = (fresh?.botSettings?.commands || [])
      .filter((c) => c.command?.startsWith('/') && c.command.length > 1)
      .map((c) => ({ command: c.command.replace(/^\//, '').toLowerCase(), description: c.description || c.command }));
    await fetch(`https://api.telegram.org/bot${inst.token}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: slashCommands }),
    }).catch(() => {});
  } catch {}
}

// ── YooMoney quickpay links — inlined (routes/payment.js's /payment/create is
// behind apiKey auth, not callable from a server-to-server webhook handler).
// Два тарифа AiConstructor. Слаги ('tgletbot' / 'tgpremium') попадают в label
// платёжки, разбираются вебхуком routes/payment.js и обязаны совпадать с enum
// плана в models/User.js. Скидки за срок должны совпадать с webapp/src/plans.js. ──
const TGLB_PLANS = {
  standard: { slug: 'tgletbot',  price: 1000, name: 'Standard' },
  premium:  { slug: 'tgpremium', price: 2000, name: 'Premium'  },
};
const TGLB_PERIOD_DISCOUNTS = { 1: 0, 6: 0.16, 12: 0.33 };

function tglbPlanTotal(planKey, months) {
  const plan = TGLB_PLANS[planKey] || TGLB_PLANS.standard;
  const discount = TGLB_PERIOD_DISCOUNTS[months] ?? 0;
  return Math.round((plan.price * months * (1 - discount)) / 10) * 10;
}

function buildPaymentUrl(userId, planKey = 'standard', months = 1, paymentType = null) {
  const wallet = process.env.YOOMONEY_WALLET;
  if (!wallet) return null;
  const plan = TGLB_PLANS[planKey] || TGLB_PLANS.standard;
  const sum = tglbPlanTotal(planKey, months);
  const label = `${userId}_${plan.slug}_${months}m_${Date.now()}`;
  const typeParam = paymentType ? `&paymentType=${paymentType}` : '';
  return `https://yoomoney.ru/quickpay/confirm?receiver=${wallet}&quickpay-form=shop&targets=Siberi AI+${plan.slug}+${months}mo${typeParam}&sum=${sum}&label=${label}`;
}

// Ссылка на оплату подписки. Т-Касса (эквайринг ИП) — ОСНОВНОЙ способ, когда
// настроен терминал (env TBANK_TERMINAL_KEY/PASSWORD); ЮMoney — ЗАПАСНОЙ. Если
// Init в Т-Кассе внезапно упал — тоже откатываемся на ЮMoney, чтобы оплата
// НИКОГДА не была полностью недоступна. Async: Т-Касса требует серверный вызов
// Init для получения платёжной ссылки (в отличие от статичной ссылки ЮMoney).
async function createPaymentUrl(user, planKey = 'standard', months = 1, paymentType = null) {
  const userId = user?._id || user; // допускаем и объект user, и голый id
  const plan = TGLB_PLANS[planKey] || TGLB_PLANS.standard;
  const m = [1, 6, 12].includes(Number(months)) ? Number(months) : 1;
  // Тест-режим (ДЕМО-терминал): Т-Касса только для платформенных админов, чтобы
  // обычные клиенты не платили на ДЕМО (деньги не двигаются) — они идут на ЮMoney.
  const tbankAllowed = tbank.isConfigured()
    && (!tbank.isTestMode() || (user && typeof user === 'object' && isPlatformAdminUser(user)));
  if (tbankAllowed) {
    const sum = tglbPlanTotal(planKey, m);
    const serverUrl = process.env.SERVER_URL || '';
    // Куда Т-Касса вернёт клиента после оплаты — наши страницы результата
    // (кнопка «Вернуться в бот» уже на них), а не сразу диплинк бота.
    const siteUrl = (process.env.PUBLIC_SITE_URL || 'https://siberi.online').replace(/\/$/, '');
    // Если пользователь сам включил автопродление — помечаем платёж рекуррентным:
    // Т-Касса привяжет карту и вернёт RebillId в нотификации (см. webhook).
    // Без явного согласия Recurrent НЕ шлём (Оферта п. 8.1).
    const wantsRecurrent = !!(user && typeof user === 'object' && user.autoRenew === true);
    const r = await tbank.initPayment({
      amountRub: sum,
      orderId: tbank.encodeSubOrderId(String(userId), plan.slug, m),
      description: `AI Constructor Bot — ${plan.name}, ${m} мес`,
      data: { userId: String(userId), plan: plan.slug, months: String(m) },
      notificationURL: serverUrl ? `${serverUrl}/api/v1/payment/tbank/webhook` : undefined,
      successURL: process.env.TBANK_SUCCESS_URL || `${siteUrl}/pay/success`,
      failURL:    process.env.TBANK_FAIL_URL    || `${siteUrl}/pay/fail`,
      recurrent: wantsRecurrent,
      customerKey: String(userId),
    });
    if (r.ok) return r.paymentUrl;
    console.warn(`⚠️ T-Bank Init failed (${r.error}${r.details ? ': ' + r.details : ''}) — откат на ЮMoney`);
  }
  return buildPaymentUrl(userId, planKey, m, paymentType);
}

async function sendPaymentOverlay(chatId, user) {
  // FREE_MODE: тарифов нет. Любой путь, ведущий сюда (старая кнопка в истории
  // чата, callback tglb:showpay), получает правду вместо ценника.
  if (FREE_MODE) {
    await sendTgMessage(chatId, '🎁 AiConstructor сейчас *бесплатный* — платить не нужно, просто пользуйся.');
    return;
  }
  const stdUrl  = await createPaymentUrl(user, 'standard', 1);
  const premUrl = await createPaymentUrl(user, 'premium', 1);
  if (!stdUrl || !premUrl) { await sendTgMessage(chatId, 'Оплата временно недоступна, попробуй позже.'); return; }
  const keyboard = [
    [{ text: '💳 Standard — 1000₽/мес', url: stdUrl }],
    [{ text: '🚀 Premium — 2000₽/мес', url: premUrl }],
  ];
  if (MINIAPP_URL) keyboard.push([{ text: '📱 Открыть приложение', webApp: MINIAPP_URL }]);
  await sendTgMessage(
    chatId,
    '⏳ Бесплатный период закончился.\n\nВыбери тариф — бот останется на хостинге и будет работать 24/7:\n\n💳 *Standard* — 1000₽/мес. Хостинг 24/7 и все функции конструктора.\n🚀 *Premium* — 2000₽/мес. То же самое, плюс повышенная скорость отработки ИИ и приоритетная очередь при нагрузке.\n\nВ приложении можно оформить сразу на 6 или 12 месяцев со скидкой до 33%.',
    { keyboard }
  );
}

// Подписан ли пользователь на инфо-канал @aicupdates. ⚠️ Требует, чтобы
// @AI_ConstructorBot был АДМИНОМ канала — иначе getChatMember вернёт ошибку и
// мы честно считаем «не подписан».
async function isSubscribedToChannel(telegramUserId) {
  try {
    const r = await fetch(`${TG_API}/getChatMember?chat_id=${encodeURIComponent(AICUPDATES_CHANNEL)}&user_id=${telegramUserId}`).then((x) => x.json());
    if (!r?.ok) { console.warn('getChatMember @aicupdates:', r?.description); return false; }
    return ['member', 'administrator', 'creator'].includes(r.result?.status);
  } catch (e) { console.warn('getChatMember err:', e.message); return false; }
}

// Выдаёт бонус +6 дней (до недели) за подписку — ОДИН раз на аккаунт. Добавляет
// дни ко ВРЕМЕНИ, которое осталось (trialEnd = trialStart + trialDurationDays).
async function grantChannelBonus(user) {
  if (user.channelBonusClaimed) return { ok: false, reason: 'claimed' };
  if (!(await isSubscribedToChannel(user.telegramId))) return { ok: false, reason: 'not_subscribed' };
  user.channelBonusClaimed = true;
  user.subscriptionStatus = 'trial';
  if (!user.trialStart) user.trialStart = new Date();
  user.trialDurationDays = (user.trialDurationDays || TRIAL_DAYS) + CHANNEL_BONUS_DAYS;
  await user.save();
  return { ok: true };
}

// Гейт при истёкшем доступе. Пока бонус не получен — предлагаем подписку на канал
// (+6 дней) ИЛИ оплату; если бонус уже получен — только оплата.
// FREE_MODE: платной ветки нет — подписка на @aicupdates открывает доступ, и это
// единственное условие. Про дни не пишем: доступ после подписки бессрочный, и
// обещать «+6 дней» было бы враньём в меньшую сторону.
async function sendTrialGate(chatId, user) {
  const chanUrl = `https://telegram.me/${AICUPDATES_CHANNEL.replace('@', '')}`;
  if (FREE_MODE) {
    await sendTgMessage(
      chatId,
      '⏳ Пробный день закончился.\n\nAiConstructor сейчас *бесплатный* — для первых 1500 пользователей.\n\nЧтобы открыть полный доступ, подпишись на наш канал @aicupdates (новости и обновления) и нажми «Я подписался»:',
      { keyboard: [
        [{ text: '📢 Подписаться на @aicupdates', url: chanUrl }],
        [{ text: '✅ Я подписался — открыть доступ', data: 'tglb:checksub' }],
      ] }
    );
    return;
  }
  if (user.channelBonusClaimed) { await sendPaymentOverlay(chatId, user); return; }
  await sendTgMessage(
    chatId,
    `⏳ Пробный день закончился.\n\nПродли бесплатно ещё на неделю — просто подпишись на наш канал @aicupdates (новости и обновления AiConstructor) и нажми «Я подписался»:\n\n📢 +${CHANNEL_BONUS_DAYS} дней за подписку.\n\nИли оформи подписку, чтобы бот работал 24/7 без ограничений.`,
    { keyboard: [
      [{ text: '📢 Подписаться на @aicupdates', url: chanUrl }],
      [{ text: `✅ Я подписался — открыть +${CHANNEL_BONUS_DAYS} дней`, data: 'tglb:checksub' }],
      [{ text: '💳 Оформить подписку', data: 'tglb:showpay' }],
    ] }
  );
}

// ── Воронка фидбека ──────────────────────────────────────────────────────────
// Кнопка «Оставить отзыв» на /start → просим написать сообщение (ставим флаг
// awaitingFeedback в сессии). Текст пользователя перехватывается ДО гейта (чтобы
// отзыв мог оставить даже замороженный юзер) и падает алертом всем админам.
const FEEDBACK_BTN = { text: '💬 Оставить отзыв', data: 'tglb:feedback' };

async function promptFeedback(chatId) {
  setSession(chatId, { ...getSession(chatId), awaitingFeedback: true });
  await sendTgMessage(chatId, '💬 Напиши одним сообщением, что думаешь: что нравится, что бесит, чего не хватает, какая идея. Всё уйдёт напрямую команде — мы правим продукт по таким отзывам.\n\nОтменить — отправь /start.');
}

function fbAuthor(fb) {
  if (fb.telegramUsername) return '@' + fb.telegramUsername;
  return fb.displayName || (fb.telegramId ? `id ${fb.telegramId}` : 'Пользователь');
}

// Сохраняет отзыв, подтверждает пользователю и шлёт алерт всем платформенным
// админам (кроме самого автора, если он админ и тестирует).
async function submitFeedback(chatId, user, fromUser, text) {
  const fb = await BotFeedback.create({
    userId:           user?._id,
    telegramId:       String(fromUser?.id || user?.telegramId || chatId),
    telegramUsername: String(user?.telegramUsername || fromUser?.username || '').replace(/^@+/, ''),
    displayName:      user?.displayName || fromUser?.first_name || '',
    text,
  }).catch((e) => { console.warn('feedback save:', e.message); return null; });

  await sendTgMessage(chatId, '🙏 Спасибо! Твой отзыв ушёл команде — мы реально их читаем и правим продукт по ним.');
  if (!fb) return;

  try {
    const adminIds = await getPlatformAdminChatIds();
    const who = fbAuthor(fb);
    for (const aid of adminIds) {
      if (String(aid) === String(chatId)) continue;
      await sendTgMessage(aid, `💬 <b>Новый отзыв</b>\n\n${text}\n\n👤 ${who}`, {
        keyboard: [[{ text: '📋 Открыть фидбек', data: 'admfb' }]],
      }).catch(() => {});
    }
  } catch (e) { console.warn('feedback notify admins:', e.message); }
}

// ── Листалка фидбека в /admin (по одному отзыву, ◀️/▶️) ──────────────────────
function feedbackKeyboard(idx, total, fb) {
  const nav = [];
  if (idx > 0)         nav.push({ text: '◀️ Новее',  data: `admfb:${idx - 1}` });
  if (idx < total - 1) nav.push({ text: 'Старее ▶️', data: `admfb:${idx + 1}` });
  const rows = [];
  if (nav.length) rows.push(nav);
  if (fb?.userId) rows.push([{ text: '👤 Профиль автора', data: `admu:view:${fb.userId}` }]);
  rows.push([{ text: '🔄 Обновить', data: 'admfb' }]);
  return rows;
}

function renderFeedbackCard(fb, idx, total) {
  const when = new Date(fb.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `💬 <b>Отзыв ${idx + 1} из ${total}</b>\n\n${fb.text}\n\n👤 ${fbAuthor(fb)}\n🕐 ${when}`;
}

// idx 0 = самый свежий. messageId задан → редактируем то же сообщение
// (перелистывание на месте); не задан → шлём новое (вход из меню /admin).
async function showFeedback(chatId, idx, messageId) {
  const total = await BotFeedback.countDocuments();
  if (!total) {
    const txt = '💬 Пока отзывов нет — воронка ждёт первых сообщений.';
    if (messageId) await editTgMessage(chatId, messageId, txt); else await sendTgMessage(chatId, txt);
    return;
  }
  idx = Math.max(0, Math.min(idx, total - 1));
  const fb = await BotFeedback.findOne().sort({ createdAt: -1 }).skip(idx).lean();
  if (!fb) return;
  if (fb.status === 'new') await BotFeedback.updateOne({ _id: fb._id }, { $set: { status: 'read' } }).catch(() => {});
  const body = renderFeedbackCard(fb, idx, total);
  const kb = feedbackKeyboard(idx, total, fb);
  if (messageId) await editTgMessage(chatId, messageId, body, { keyboard: kb });
  else await sendTgMessage(chatId, body, { keyboard: kb });
}

// Детерминированное создание схем макета (структура + примеры) для пользователя.
// Личные схемы (orders/bookings) — пустые; справочные (menu/products/services) —
// с 2 примерами, если ещё пусто. Не перезаписывает уже существующие схемы.
async function ensureTemplateSchemas(userId, tpl) {
  for (const sd of (tpl?.schemas || [])) {
    if (!sd?.name) continue;
    let schema = await UserSchema.findOne({ userId, name: sd.name });
    if (!schema) {
      schema = await UserSchema.create({
        userId, name: sd.name, label: sd.label || sd.name, icon: sd.icon || '📋',
        fields: sd.fields || [], isActive: true,
      }).catch((e) => { console.warn('ensureTemplateSchemas create:', e.message); return null; });
    }
    if (schema && Array.isArray(sd.samples) && sd.samples.length) {
      const count = await UserRecord.countDocuments({ userId, schemaName: sd.name });
      if (count === 0) {
        for (const data of sd.samples) {
          await UserRecord.create({ userId, schemaName: sd.name, data, metadata: { createdBy: 'template', source: 'template' } }).catch(() => {});
        }
      }
    }
  }
}

// Предохранитель: команды ссылаются на listSchema/queryMySchema/checkoutSchema/
// mediaSchema, но AI не всегда создаёт саму схему через DB_COMMAND. Создаём
// недостающие с разумными полями по имени — чтобы разделы бота не были пустыми.
async function ensureReferencedSchemas(userId, commands) {
  const refs = new Set();
  for (const c of (commands || [])) for (const k of ['listSchema', 'queryMySchema', 'checkoutSchema', 'mediaSchema']) if (c[k]) refs.add(String(c[k]));
  const isOrder = (n) => /order|заказ/i.test(n);
  const isBooking = (n) => /book|бронь|брони|запис/i.test(n);

  // Есть корзина/заказы → детерминированно заводим схему «Доставка» с дефолтами
  // (часы, стоимость, самовывоз и т.п.). Владелец потом донастроит в mini-app.
  // Чисто аддитивно — на генерацию бота не влияет.
  const hasCartOrOrder = (commands || []).some((c) => c.checkoutSchema || c.showCart || c.addToCart)
    || [...refs].some((n) => isOrder(n));
  if (hasCartOrOrder) {
    const tz = (await NotificationRule.findOne({ userId }).select('tzOffset').lean())?.tzOffset;
    await ensureDeliverySchema(userId, { tzOffset: typeof tz === 'number' ? tz : undefined }).catch((e) => console.warn('ensureDelivery:', e.message));
  }

  // Есть платные функции (премиум-гейт или витрина оплаты) → заводим схемы монетизации.
  const hasPaid = (commands || []).some((c) => c.paidAction || c.minRole === 'paid');
  if (hasPaid) await ensurePaidSchemas(userId).catch((e) => console.warn('ensurePaid:', e.message));

  // Есть карточки товаров (productCard) → заводим схему добавок product_extras,
  // чтобы владелец/ИИ могли добавить сыр/соус/… и они появились в карточках.
  const hasProductCard = (commands || []).some((c) => c.productCard);
  if (hasProductCard) {
    const { ensureExtrasSchema } = require('../helpers/productCard');
    await ensureExtrasSchema(userId).catch((e) => console.warn('ensureExtras:', e.message));
  }
  // Кирпич записи → заводим схемы услуги/мастера/связки/записи (с недельным графиком).
  const hasBooking = (commands || []).some((c) => c.bookingAction);
  if (hasBooking) {
    const { ensureBookingSchemas } = require('../helpers/booking');
    await ensureBookingSchemas(userId).catch((e) => console.warn('ensureBooking:', e.message));
  }
  for (const name of refs) {
    const existing = await UserSchema.findOne({ userId, name });
    if (existing) {
      // Схема заказа/брони уже есть (создал Mistral или прошлая сборка) — дописываем
      // недостающие служебные поля (Клиент, Telegram ID, Статус), чтобы данные
      // клиента сохранялись и отображались в базе у ЛЮБОГО бота, не только шаблонного.
      if (isOrder(name) || isBooking(name)) {
        const have = new Set((existing.fields || []).map((f) => f.name));
        const want = [{ name: 'customer', label: 'Клиент', type: 'text' }, { name: 'tg_id', label: 'Telegram ID', type: 'text' }];
        if (isOrder(name)) want.push(
          { name: 'phone', label: 'Телефон', type: 'text' },
          { name: 'address', label: 'Адрес доставки', type: 'text' },
          { name: 'status', label: 'Статус', type: 'text' },
          { name: 'delivery_mode', label: 'Способ получения', type: 'text' },
          { name: 'delivery_fee', label: 'Стоимость доставки', type: 'number' },
        );
        const missing = want.filter((f) => !have.has(f.name));
        if (missing.length) { existing.fields.push(...missing); existing.markModified('fields'); await existing.save().catch((e) => console.warn('ensureRef patch:', e.message)); }
      }
      continue;
    }
    let fields;
    if (/order|заказ/i.test(name)) fields = [{ name: 'items', label: 'Состав заказа', type: 'text' }, { name: 'total', label: 'Сумма', type: 'number' }, { name: 'customer', label: 'Клиент', type: 'text' }, { name: 'tg_id', label: 'Telegram ID', type: 'text' }, { name: 'phone', label: 'Телефон', type: 'text' }, { name: 'address', label: 'Адрес доставки', type: 'text' }, { name: 'status', label: 'Статус', type: 'text' }, { name: 'delivery_mode', label: 'Способ получения', type: 'text' }, { name: 'delivery_fee', label: 'Стоимость доставки', type: 'number' }];
    else if (/staff|персонал|сотрудник/i.test(name)) fields = [{ name: 'name', label: 'Имя', type: 'text', required: true }, { name: 'role', label: 'Должность', type: 'text' }, { name: 'phone', label: 'Телефон', type: 'text' }];
    else if (/schedule|расписан|смен/i.test(name)) fields = [{ name: 'title', label: 'Название', type: 'text', required: true }, { name: 'date', label: 'Дата', type: 'date' }, { name: 'note', label: 'Заметка', type: 'text' }];
    else if (/book|бронь|брони|запис/i.test(name)) fields = [{ name: 'date', label: 'Дата и время', type: 'date', required: true }, { name: 'phone', label: 'Телефон', type: 'text', required: true }, { name: 'customer', label: 'Клиент', type: 'text' }, { name: 'tg_id', label: 'Telegram ID', type: 'text' }, { name: 'name', label: 'Имя', type: 'text' }];
    else fields = [{ name: 'name', label: 'Название', type: 'text', required: true }, { name: 'description', label: 'Описание', type: 'text' }, { name: 'price', label: 'Цена', type: 'number' }];
    await UserSchema.create({ userId, name, label: name, icon: '📋', fields, isActive: true }).catch((e) => console.warn('ensureRef create:', e.message));
  }
}

// ── Run one AI builder turn (mirrors routes/webhooks.js's Task + partialResult
// streaming pattern, with context.source:'studio' so AiService._applyStudioChanges
// writes straight onto the target profile) ────────────────────────────────────
// Чистит «человеческий» текст ответа студии от служебного мусора, который модель
// иногда вываливает пользователю на сложных запросах: код-блоки, markdown-разделы
// (### Технические детали / Что нужно сделать в коде / Вопросы для уточнения),
// псевдо-превью, JSON. Пользователь должен видеть только вводные 2-4 предложения
// «что сделано» — не план и не техчасть. Детерминированно, т.к. промт-правило
// модель соблюдает не всегда.
function cleanStudioReply(text) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' '); // огороженные код-блоки
  // Обрезаем всё, начиная с первого markdown-заголовка (## / ###) или тех.раздела.
  const markers = [
    /(^|\n)\s*#{2,6}\s+/,
    /(^|\n)\s*(технические детали|что нужно сделать|что нужно поправить|вопросы для уточнения|пример работы|как это работает)\b/i,
  ];
  let cut = t.length;
  for (const re of markers) { const m = re.exec(t); if (m && m.index < cut) cut = m.index; }
  t = t.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > 900) t = t.slice(0, 900).replace(/\s+\S*$/, '') + '…';
  return t || '✅ Готово — изменения применены.';
}

// Сигнал админам о подозрении на мошеннического бота. МОНИТОРИНГ, НЕ БЛОКИРОВКА:
// пользователь ничего не замечает и продолжает работать — решение принимает
// человек. Кнопки ведут в уже существующие admu-обработчики (карточка/блок),
// так что из алерта можно действовать в один тап.
async function alertAdminsOfFraudAttempt(user, message, detected) {
  try {
    // Не спамим: один сигнал на пользователя раз в 30 минут, даже если он
    // переформулирует запрос десять раз подряд.
    const bucket = Math.floor(Date.now() / (30 * 60 * 1000));
    if (isDuplicateUpdate('fraud-watch', `${user._id}:${bucket}`)) return;

    const handle = user.telegramUsername ? `@${user.telegramUsername}` : (user.displayName || 'без ника');
    const req = String(message || '').slice(0, 600);
    const text = [
      '⚠️ <b>Подозрение на мошеннического бота</b>',
      '',
      `Пользователь: ${handle}${user.telegramId ? ` · tg ${user.telegramId}` : ''}`,
      `Признаки: ${detected.markers.join('; ')}`,
      '',
      '<b>Запрос:</b>',
      `«${req}»`,
      '',
      'Пользователь НЕ заблокирован и работает как обычно — это только сигнал.',
    ].join('\n');
    const keyboard = [
      [{ text: '👤 Карточка пользователя', data: `admu:view:${user._id}` }],
      [{ text: '🚫 Заблокировать', data: `admu:block:${user._id}` }],
    ];
    for (const aid of await getPlatformAdminChatIds()) {
      await sendTgMessage(aid, text, { keyboard }).catch(() => {});
    }
  } catch (e) { console.warn('fraud-watch alert:', e.message); }
}

// ── Fraud-sweep живых ботов ───────────────────────────────────────────────────
// fraudWatch на запросе ловит скам НА СБОРКЕ. Но уже собранный живой бот никто
// не перепроверяет — скам-начинка живёт в его системном промпте (дыра, из-за
// которой @StarPetsMM2Gifts_bot всплыл лишь когда падал технически). Этот проход
// сканирует конфиги ВСЕХ подключённых ботов и шлёт админам сигнал. Как и весь
// fraudWatch — МОНИТОРИНГ, НЕ блокировка: решает человек.
const _fraudSweptConfigs = new Set(); // userId:hash — чтобы не слать один и тот же конфиг повторно
function _cfgHash(s) { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; } return h; }

async function sweepLiveBotsForFraud() {
  try {
    const { scanBotConfig } = require('../helpers/fraudWatch');
    const UserIntegrations = require('../models/UserIntegrations');
    const docs = await UserIntegrations.find({ telegram: { $elemMatch: { connected: true } } }).select('userId telegram.botUsername telegram.connected').lean().catch(() => []);
    for (const d of docs) {
      const liveBot = (d.telegram || []).find((t) => t.connected);
      if (!liveBot) continue;
      const cfg = await UserAiConfig.findOne({ userId: d.userId, profileName: { $ne: '__studio__' } }).lean().catch(() => null);
      if (!cfg) continue;
      const detected = scanBotConfig(cfg);
      if (!detected) continue;
      // Дедуп по содержимому конфига: правил бот → новый хеш → сигнал снова.
      const key = `${d.userId}:${_cfgHash((cfg.systemPrompt || '') + (cfg.botSettings?.welcomeMessage || ''))}`;
      if (_fraudSweptConfigs.has(key)) continue;
      _fraudSweptConfigs.add(key);

      const user = await User.findById(d.userId).catch(() => null);
      if (!user || isPlatformAdmin({ id: user.telegramId, username: user.telegramUsername })) continue;
      const handle = user.telegramUsername ? `@${user.telegramUsername}` : (user.displayName || 'без ника');
      const text = [
        '⚠️ <b>Живой бот похож на мошеннический</b>',
        '',
        `Бот: @${liveBot.botUsername} — https://t.me/${liveBot.botUsername}`,
        `Создатель: ${handle}${user.telegramId ? ` · tg ${user.telegramId}` : ''}`,
        `Признаки: ${detected.markers.join('; ')}`,
        '',
        `<b>Роль бота:</b>\n«${String(cfg.systemPrompt || '').slice(0, 500)}»`,
        '',
        'Бот работает как обычно — это только сигнал, реши сам.',
      ].join('\n');
      const keyboard = [
        [{ text: '👤 Карточка создателя', data: `admu:view:${user._id}` }],
        [{ text: '🚫 Заблокировать', data: `admu:block:${user._id}` }],
      ];
      for (const aid of await getPlatformAdminChatIds()) await sendTgMessage(aid, text, { keyboard }).catch(() => {});
      console.warn(`🚩 fraud-sweep: @${liveBot.botUsername} (${handle}) — ${detected.markers.join('; ')}`);
    }
  } catch (e) { console.warn('fraud-sweep:', e.message); }
}

async function runBuildingTurn(chatId, user, profile, message, { isLive = false } = {}) {
  // Детект детерминированный и НЕ зависит от модели: сигнал уйдёт, даже если
  // промпт студии не сработал и ИИ послушно собрала мошенника.
  const fraud = detectFraudIntent(message);
  if (fraud) {
    console.warn(`🚩 fraud-watch: @${user.telegramUsername || user._id} — ${fraud.markers.join('; ')}`);
    alertAdminsOfFraudAttempt(user, message, fraud).catch(() => {});
  }

  setSession(chatId, { ...getSession(chatId), pendingTaskId: 'pending' });

  const studioProfile = await getOrCreateStudioProfile(user);
  const currentConfig = {
    aiName: profile.aiName,
    systemPrompt: profile.systemPrompt,
    botSettings: profile.botSettings,
  };
  // Chat history doesn't survive (Mistral/Qwen chats get deleted after each
  // turn) — this is the model's own persisted memory of decisions/gaps for
  // this specific bot, read fresh every turn so it can keep building on it.
  const buildNotesSection = profile.studioBuildNotes
    ? `\n\n[ЗАМЕТКИ РАЗРАБОТЧИКА]\n${profile.studioBuildNotes}`
    : '';

  // Эталонный макет — только при сборке С НУЛЯ (у бота ещё нет команд): даём
  // Mistral проверенный рабочий скелет нужного типа как основу. При правках уже
  // готового бота макет не подставляем, чтобы не перетирать его структуру.
  const isFreshBuild = !(profile.botSettings?.commands?.length);
  const matchedTpl = isFreshBuild ? matchTemplate(message) : null;
  const templateSection = matchedTpl ? templateContextBlock(message) : '';
  // ДЕТЕРМИНИРОВАННО создаём схемы макета + примеры ДО генерации — чтобы каталог
  // и корзина работали, даже если Mistral не эмитит DB_COMMAND (реальный кейс).
  if (matchedTpl) await ensureTemplateSchemas(user._id, matchedTpl).catch((e) => console.warn('ensureTemplateSchemas:', e.message));

  // Текущие записи схем (с _id) — чтобы при РЕДАКТИРОВАНИИ студия видела, что уже
  // есть в базе: не пересоздавала дубли, а правила/удаляла прицельно по _id.
  // При сборке с нуля данных ещё нет — секция будет пустой.
  let dataSection = '';
  if (!isFreshBuild) {
    try {
      const dctx = await aiService.buildDataContext(user._id, 300, profile._id, null, 'creator', {});
      if (dctx) dataSection = `\n\n[ТЕКУЩИЕ ДАННЫЕ БОТА — существующие записи с их _id]\n${dctx}`;
    } catch (e) { console.warn('studio dataContext:', e.message); }
  }

  const task = new Task({
    taskId: uuidv4(),
    userId: user._id,
    prompt: `[ТЕКУЩИЙ КОНФИГ]\n${JSON.stringify(currentConfig, null, 2)}${buildNotesSection}${templateSection}${dataSection}\n\n[ЗАПРОС]\n${message}`,
    rawPrompt: message,
    context: { source: 'studio', targetProfileId: profile._id, platform: 'telegram', platformUserId: String(chatId) },
    profileId: studioProfile._id,
    status: 'processing',
    endUser: { platform: 'telegram', platformUserId: String(chatId) },
  });
  await task.save();
  setSession(chatId, { ...getSession(chatId), pendingTaskId: task.taskId });

  let phraseQueue = shuffledPhrases();
  let phrasePos = 0;
  const thinkingMsgId = await sendTgMessage(chatId, phraseQueue[phrasePos]);
  sendChatAction(chatId, 'typing');

  // Partial text only updates once or twice (Groq streams it; Mistral reveals it
  // once at its internal [END_TEXT] marker) — after that the model keeps working
  // silently on the config tags (menu, data schema...). Groq turns can finish in
  // a few seconds while Mistral/Qwen fallback can take much longer, so rotate
  // status phrases on a short ~1.3s cadence (just above Telegram's edit-rate
  // comfort zone) — fast turns still get visible movement, slow ones cycle through
  // many phrases instead of sitting frozen on the first one.
  const STALL_MS = 1300;
  let pollingActive = true;
  let revealedText = '';
  let lastShownPartial = '';
  let lastChangeAt = Date.now();
  let lastEditAt = 0;
  const pollLoop = (async () => {
    while (pollingActive) {
      await sleep(500);
      if (!pollingActive) break;
      const fresh = await Task.findOne({ taskId: task.taskId }).select('partialResult status').lean().catch(() => null);
      if (!fresh) continue;
      const now = Date.now();

      if (fresh.partialResult && fresh.partialResult !== lastShownPartial) {
        lastShownPartial = fresh.partialResult;
        // task.partialResult is raw, unprocessed streamed text — may already
        // contain an in-progress <BOT_COMMANDS>/<BOT_SETTINGS>/... tag the model
        // started emitting. Strip it defensively before it ever reaches the chat.
        revealedText = cleanStudioReply(aiService._stripStudioArtifacts(fresh.partialResult));
        lastChangeAt = now;
        if (now - lastEditAt > STALL_MS) {
          lastEditAt = now;
          await editTgMessage(chatId, thinkingMsgId, revealedText + ' ▌', { fallbackToSend: false }).catch(() => {});
        }
      } else if (now - lastChangeAt > STALL_MS) {
        phrasePos += 1;
        if (phrasePos >= phraseQueue.length) { phraseQueue = shuffledPhrases(); phrasePos = 0; }
        lastChangeAt = now;
        lastEditAt = now;
        const stallText = revealedText ? `${revealedText}\n\n${phraseQueue[phrasePos]}` : phraseQueue[phrasePos];
        await editTgMessage(chatId, thinkingMsgId, stallText, { fallbackToSend: false }).catch(() => {});
      }

      if (fresh.status === 'completed' || fresh.status === 'error') break;
    }
  })();

  try {
    await aiService.processTask(task);
  } catch (err) {
    console.error('TGLetBot task error:', err.message);
  }
  pollingActive = false;
  await pollLoop;

  const done = await Task.findOne({ taskId: task.taskId });
  setSession(chatId, { ...getSession(chatId), pendingTaskId: null });

  if (done?.status === 'completed' && done.result) {
    // Предохранитель: команды могли сослаться на схему, которую AI не создал
    // (staff/schedule и т.п.) — создаём недостающие, чтобы разделы не были пустышками.
    try {
      const freshProfile = await UserAiConfig.findById(profile._id).select('botSettings.commands').lean();
      await ensureReferencedSchemas(user._id, freshProfile?.botSettings?.commands || []);
    } catch (e) { console.warn('ensureReferencedSchemas:', e.message); }

    // Чистим ответ от служебного мусора (техразделы/код/вопросы) — пользователь
    // видит только короткое «что сделано». Overflow больше не нужен (текст короткий).
    await editTgMessage(chatId, thinkingMsgId, cleanStudioReply(done.result), { allowOverflow: true });
    setSession(chatId, { ...getSession(chatId), previewActive: false });

    if (isLive) {
      await pushSetMyCommands(user, profile._id);
      await sendTgMessage(chatId, 'Изменения применены ✅ Бот уже работает по-новому.', { keyboard: LIVE_KEYBOARD });
    } else {
      await sendTgMessage(chatId, 'Что дальше?', { keyboard: BUILDING_KEYBOARD });
    }
  } else {
    await editTgMessage(chatId, thinkingMsgId, aiFailureMessage({ source: 'tgletbot', userId: user._id, reason: done?.error, taskId: task.taskId }));
  }
}

// ── Preview rendering — simulates /start (welcome + real top-level menu) and
// stops there; the user taps through it themselves from this point on. Taps
// resolve against the just-persisted botSettings.commands (same case-insensitive
// match routes/webhooks.js uses for real bots), so navigation goes as deep as
// the user wants to click, instead of dumping the AI's whole scripted demo. ───
async function renderPreview(chatId, profile, { withFollowup = true, isLive = false } = {}) {
  const fresh = await UserAiConfig.findById(profile._id).lean();
  const welcome = fresh?.botSettings?.welcomeMessage || 'Привет! 👋';
  const startCmd = (fresh?.botSettings?.commands || []).find((c) => c.command === '/start');
  const kb = Array.isArray(startCmd?.keyboard) && startCmd.keyboard.length ? startCmd.keyboard : null;

  const header = isLive
    ? '👀 Вот как сейчас выглядит твой бот — нажимай на кнопки сам:'
    : '👀 Вот как будет выглядеть твой бот — нажимай на кнопки сам:';
  await sendTgMessage(chatId, header);
  // Баннер стартового экрана (если пользователь его добавил) — шлём картинкой,
  // текст приветствия уходит подписью.
  const banner = await getBanner(profile.userId, '/start').catch(() => null);
  if (banner) {
    await sendBannerPhoto(TGLETBOT_TOKEN, chatId, banner, welcome, buildInlineMarkup(kb));
  } else {
    await sendTgMessage(chatId, welcome, kb ? { keyboard: kb } : {});
  }
  if (withFollowup) {
    await sendTgMessage(chatId, 'Изменения применены. Что делаем дальше?\n\n💡 Хочешь баннер на экран? Зайди на нужный экран меню и пришли картинку — прицеплю.', { keyboard: isLive ? EDIT_ONLY_KEYBOARD : EDIT_OR_FINISH_KEYBOARD });
  }

  setSession(chatId, { ...getSession(chatId), previewActive: true, previewStep: '/start', previewNavStack: [], previewCurScreen: '/start' });
}

// Edits the tapped message in place (same convention routes/webhooks.js uses for
// real bots) so navigating the preview updates one message instead of flooding
// the chat with a new bubble per tap.
// Превью 1-в-1 с реальным ботом: у экрана ТОЛЬКО его собственная клавиатура —
// без «⬅️ Меню бота» и без панели конструктора. Управление предпросмотром
// («Редактировать бота» / «Завершить создание») живёт ОТДЕЛЬНЫМ нижним
// сообщением «Когда наиграешься — что дальше?», а не подмешивается в каждый
// экран (раньше эти кнопки лезли в меню бота, а «Меню бота» слал новое сообщение
// вместо возврата в главное меню). Навигация назад — родными кнопками бота.
function previewNavKb(cmdKeyboard) {
  return Array.isArray(cmdKeyboard) ? cmdKeyboard : [];
}

// Лёгкий рендер записей схемы для превью (без пагинации) — чтобы данные из БД
// были видны прямо при тестировании в конструкторе, а не только в живом боте.
async function previewSchemaText(userId, schemaName, headerResponse, { onlyChatId = null, addToCart = false, productCard = false, currency = '₽', filter = null } = {}) {
  const sd = await UserSchema.findOne({ userId, name: schemaName }).lean();
  if (!sd) return { text: null, itemButtons: null };
  const q = { userId, schemaName: sd.name };
  if (onlyChatId != null) q['data._tg_chat_id'] = onlyChatId;
  if (filter && typeof filter === 'object') {
    for (const [k, val] of Object.entries(filter)) {
      if (val != null && val !== '' && !String(k).startsWith('_')) q[`data.${k}`] = val;
    }
  }
  const recs = await UserRecord.find(q).sort({ createdAt: 1 }).limit(20).lean();
  if (!recs.length) return { text: null, itemButtons: null };
  const fields = (sd.fields || []).filter((f) => !f.name.startsWith('_') && f.type !== 'image' && f.type !== 'file');
  const tf = fields[0];
  const df = fields.slice(1, 5);
  const priceField = fields.find((f) => /цена|price|cost|стоим|сумм|amount/i.test(`${f.name} ${f.label || ''}`)) || fields.find((f) => f.type === 'number');
  const lines = recs.map((r) => {
    const title = htmlEscape(String(r.data?.[tf?.name] ?? '—'));
    const det = df.map((f) => { const v = r.data?.[f.name]; return v != null && v !== '' ? `${htmlEscape(f.label || f.name)}: ${htmlEscape(v)}` : null; }).filter(Boolean).join(' · ');
    return `• <b>${title}</b>${det ? `\n  ${det}` : ''}`;
  });
  // Кнопки товаров — 1-в-1 как в живом боте. productCard → открывают карточку.
  let itemButtons = null;
  if (productCard) {
    itemButtons = recs.map((r) => {
      const title = String(r.data?.[tf?.name] ?? 'Товар').slice(0, 26);
      const price = priceField ? String(r.data?.[priceField.name] ?? '').replace(/[^\d.]/g, '') : '';
      return [{ text: `${title}${price ? ` · ${price}${currency}` : ''}`, data: `tglbcard:${sd.name}:${r._id}` }];
    });
  } else if (addToCart) {
    itemButtons = recs.map((r) => {
      const title = String(r.data?.[tf?.name] ?? 'Товар').slice(0, 26);
      const price = priceField ? String(r.data?.[priceField.name] ?? '').replace(/[^\d.]/g, '') : '';
      return [{ text: `➕ ${title}${price ? ` · ${price}${currency}` : ''}`, data: `tglbcart:add:${r._id}` }];
    });
  }
  // В режиме карточек описания текстом не выводим — вся инфа в карточке позиции.
  const bodyText = productCard
    ? (headerResponse ? String(headerResponse) : 'Выберите позицию:')
    : (headerResponse ? `${headerResponse}\n\n` : '') + lines.join('\n\n');
  return { text: bodyText, itemButtons };
}

// Поиск товара каталога по названию (для предохранителя магазина в превью).
async function findCatalogRecordByTitlePreview(userId, title) {
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

async function resolvePreviewTap(chatId, messageId, profile, label, { isLive = false, srcIsPhoto = false } = {}) {
  const fresh = await UserAiConfig.findById(profile._id).lean();
  const commands = fresh?.botSettings?.commands || [];
  let cmd = commands.find((c) => c.command && c.command.toLowerCase() === String(label).toLowerCase());
  // Контекстная «Назад» в превью (как в живом боте): по хлебным крошкам
  // previewNavStack возвращаемся на реально предыдущий экран, а не всегда в /start.
  const PREV_BACK_RE = /^\s*(?:⬅️|◀️|🔙|↩️|←|⬅|◀)?\s*(?:назад|back)(?:\s+в\s+меню)?\s*$/i;
  let isBack = false;
  if (PREV_BACK_RE.test(String(label))) {
    isBack = true;
    const s = getSession(chatId) || {};
    const stack = Array.isArray(s.previewNavStack) ? s.previewNavStack.slice() : [];
    let target = stack.pop() || '/start';
    let tCmd = commands.find((c) => c.command && c.command.toLowerCase() === target.toLowerCase());
    if (!tCmd) { target = '/start'; tCmd = commands.find((c) => c.command && c.command.toLowerCase() === '/start'); }
    setSession(chatId, { ...s, previewNavStack: stack });
    if (tCmd) cmd = tCmd;
  }
  if (!cmd) {
    // Dead end otherwise — always leave a way forward («Меню бота»).
    await editTgMessage(
      chatId, messageId,
      'У этой кнопки пока нет своего ответа — допиши, например: «добавь обработку для кнопки ' + label + '», и я её настрою.',
      { keyboard: previewNavKb(null, isLive) }
    );
    return;
  }
  // Хлебные крошки навигации + previewStep (текущий экран для баннера).
  // previewCurScreen — только меню-экраны (не card:-ключи), чтобы стек был чистым.
  {
    const nm = cmd.command;
    const s = getSession(chatId) || {};
    if (nm.toLowerCase() === '/start') {
      setSession(chatId, { ...s, previewActive: true, previewStep: '/start', previewNavStack: [], previewCurScreen: '/start' });
    } else {
      let stack = Array.isArray(s.previewNavStack) ? s.previewNavStack.slice() : [];
      const cur = s.previewCurScreen;
      if (!isBack && cur && cur.toLowerCase() !== nm.toLowerCase()) {
        const i = stack.findIndex((x) => String(x).toLowerCase() === nm.toLowerCase());
        if (i >= 0) stack = stack.slice(0, i);
        else { stack.push(cur); if (stack.length > 15) stack = stack.slice(-15); }
      }
      setSession(chatId, { ...s, previewActive: true, previewStep: nm, previewNavStack: stack, previewCurScreen: nm });
    }
  }
  // Баннер экрана (если добавлен): свой либо баннер /start для экранов с тем же
  // главным меню (напр. «Назад») — чтобы картинка меню была видна и при возврате.
  const startCmd = commands.find((c) => c.command === '/start');
  const banner = await bannerForCommand(profile.userId, cmd, startCmd).catch(() => null);
  // Как в leadbot: одно сообщение без спама (editMessageMedia на месте / удалить+прислать).
  const src = messageId ? { messageId, isPhoto: srcIsPhoto } : null;
  const showStep = async (body, rows) => {
    if (banner || srcIsPhoto) {
      await renderStep({ token: TGLETBOT_TOKEN, chatId, src, text: body, banner, replyMarkup: buildInlineMarkup(rows) });
    } else {
      await editTgMessage(chatId, messageId, body, { keyboard: rows });
    }
  };
  // Кирпич записи (bookingAction) — рендерим тем же движком, что и живой бот.
  // Конвертируем callback_data → data (формат превью-клавиатур).
  if (cmd.bookingAction) {
    const bk = require('../helpers/booking');
    const toData = (kb) => (kb || []).map((row) => row.map((b) => ({ text: b.text, data: b.callback_data || b.data })));
    let screen;
    if (cmd.bookingAction === 'services') screen = await bk.renderServicesList(profile.userId);
    else if (cmd.bookingAction === 'masters') screen = await bk.renderMastersList(profile.userId);
    else { setSession(chatId, { ...getSession(chatId), previewBook: {} }); screen = await bk.renderBookingStep(profile.userId, {}, 3); }
    await editTgMessage(chatId, messageId, screen.text, { keyboard: toData(screen.keyboard) });
    return;
  }
  // Каталог/личные записи — показываем РЕАЛЬНЫЕ данные из БД прямо в превью,
  // включая кнопки корзины (addToCart) — 1-в-1 как в живом боте.
  if (cmd.listSchema || cmd.queryMySchema) {
    const schemaName = cmd.listSchema || cmd.queryMySchema;
    const cur = cmd.cartCurrency || '₽';
    const { text: body, itemButtons } = await previewSchemaText(profile.userId, schemaName, cmd.response, {
      onlyChatId: cmd.queryMySchema ? chatId : null,
      addToCart: !!cmd.listSchema && !!cmd.addToCart,
      productCard: !!cmd.listSchema && !!cmd.productCard,
      currency: cur,
      filter: cmd.listSchema ? cmd.listFilter : null,
    });
    const rows = [];
    if (Array.isArray(itemButtons)) itemButtons.forEach((r) => rows.push(r));
    const isCartCmd = cmd.listSchema && (cmd.addToCart || cmd.productCard);
    let navKb = cmd.keyboard;
    if (isCartCmd) {
      const sc = getSession(chatId) || {};
      const cnt = cartCount(sc.previewCart);
      const countedBtn = { text: `🛒 Корзина${cnt ? ` (${cnt} · ${fmtMoney(cartTotal(sc.previewCart), cur)})` : ''}`, data: 'tglbcart:view' };
      const res = placeCountedCart(cmd.keyboard || [], countedBtn);
      if (res.placed) navKb = res.keyboard;      // counted-корзина встала в строку своей «Корзина»
      else { rows.push([countedBtn]); navKb = stripCartButtons(cmd.keyboard); } // иначе — отдельной строкой
    }
    previewNavKb(navKb, isLive).forEach((r) => rows.push(r)); // рамка тестирования поверх
    await showStep(
      body || cmd.emptyResponse || (cmd.response ? `${cmd.response}\n\n(данных пока нет — добавь их в «Мои данные»)` : 'Данных пока нет — добавь их в «Мои данные».'),
      rows
    );
    return;
  }
  // aiAction — живой AI, в превью не симулируем, но оставляем навигацию.
  if (cmd.aiAction) {
    // Предохранитель магазина (как в живом боте): товар-aiAction «в корзину» →
    // кладём в превью-корзину сами, без заглушки, чтобы превью совпадал с живым.
    if (/корзин|заказ|cart|добав|оформ|куп/i.test(cmd.aiAction)) {
      const rec = await findCatalogRecordByTitlePreview(profile.userId, cmd.command);
      if (rec) {
        const sd = await UserSchema.findOne({ userId: profile.userId, name: rec.schemaName }).lean();
        const item = extractItem(rec, sd?.fields);
        const sess = getSession(chatId) || {};
        const cart = cartAdd(sess.previewCart, item);
        setSession(chatId, { ...sess, previewCart: cart });
        const cur = (fresh?.botSettings?.commands || []).find((c) => c.cartCurrency)?.cartCurrency || '₽';
        const kb = [[{ text: `🛒 Корзина (${cartCount(cart)} · ${fmtMoney(cartTotal(cart), cur)})`, data: 'tglbcart:view' }]];
        previewNavKb(cmd.keyboard, isLive).forEach((r) => kb.push(r));
        await editTgMessage(chatId, messageId, `✅ <b>${htmlEscape(item.title)}</b> добавлен в корзину · ${cartCount(cart)} поз · ${fmtMoney(cartTotal(cart), cur)}`, { keyboard: kb });
        return;
      }
    }
    await showStep(
      '💬 Здесь бот ответит живым AI прямо по смыслу нажатия — в превью это не симулируется, но после запуска сработает само.',
      previewNavKb(cmd.keyboard, isLive)
    );
    return;
  }
  const welcome = fresh?.botSettings?.welcomeMessage || '';
  // Главное меню всегда одинаковое: /start и экраны-возвраты в меню (та же
  // клавиатура, что /start, напр. «Назад») показывают одно и то же приветствие.
  const isMainMenu = cmd.command.toLowerCase() === '/start' || (welcome && startCmd && sameMenu(cmd.keyboard, startCmd.keyboard));
  const responseText = isMainMenu ? (welcome || cmd.response || '') : (cmd.response || '');
  if (responseText) {
    const kb = Array.isArray(cmd.keyboard) && cmd.keyboard.length ? cmd.keyboard : null;
    // Даже у обычного ответа гарантируем навигацию: если у команды нет своей
    // клавиатуры — добавляем «Меню бота», чтобы из превью можно было идти дальше.
    await showStep(responseText, kb || previewNavKb(null, isLive));
  } else {
    // Пустой ответ у команды — раньше тут была тишина и мёртвый UI. Оставляем ход.
    await editTgMessage(
      chatId, messageId,
      'У этой кнопки пока нет текста ответа — допиши, что она должна показывать.',
      { keyboard: previewNavKb(cmd.keyboard, isLive) }
    );
  }
}

// Превью-корзина: те же действия, что в живом боте (webhooks.js), но в
// превью-сессии и БЕЗ сохранения реального заказа — чтобы превью совпадал с
// живым ботом 1-в-1 при тестировании.
async function handlePreviewCart(chatId, cbQuery, profile, cbData, { isLive = false } = {}) {
  const messageId = cbQuery.message?.message_id;
  const parts = cbData.split(':');
  const action = parts[1];
  const arg = parts[2];
  const fresh = await UserAiConfig.findById(profile._id).lean();
  const commands = fresh?.botSettings?.commands || [];
  const cur = commands.find((c) => c.cartCurrency)?.cartCurrency || '₽';
  const showCartCmd = commands.find((c) => c.showCart);
  const sess = getSession(chatId) || {};
  let cart = Array.isArray(sess.previewCart) ? sess.previewCart : [];

  if (action === 'add' && arg) {
    const rec = await UserRecord.findOne({ _id: arg, userId: profile.userId }).lean().catch(() => null);
    if (rec) {
      const sd = await UserSchema.findOne({ userId: profile.userId, name: rec.schemaName }).lean();
      const item = extractItem(rec, sd?.fields);
      cart = cartAdd(cart, item);
      setSession(chatId, { ...sess, previewCart: cart });
      await answerCallback(cbQuery.id, `✅ ${item.title} в корзине · ${cartCount(cart)} поз · ${fmtMoney(cartTotal(cart), cur)}`);
    }
    return;
  }
  const withNav = (extraRows) => {
    const rows = extraRows.slice();
    previewNavKb(showCartCmd?.keyboard, isLive).forEach((r) => rows.push(r));
    return rows;
  };
  if (action === 'view') {
    if (!cart.length) { await editTgMessage(chatId, messageId, '🛒 Ваша корзина пуста.', { keyboard: previewNavKb(showCartCmd?.keyboard, isLive) }); return; }
    const lines = cart.map((x) => `• ${htmlEscape(x.title)} × ${x.qty} — ${fmtMoney(x.price * x.qty, cur)}`);
    await editTgMessage(chatId, messageId, `🛒 <b>Ваша корзина:</b>\n\n${lines.join('\n')}\n\n<b>Итого: ${fmtMoney(cartTotal(cart), cur)}</b>`,
      { keyboard: withNav([[{ text: '✅ Оформить заказ', data: 'tglbcart:checkout' }], [{ text: '🗑 Очистить', data: 'tglbcart:clear' }]]) });
    return;
  }
  if (action === 'clear') { setSession(chatId, { ...sess, previewCart: [] }); await editTgMessage(chatId, messageId, '🛒 Корзина очищена.', { keyboard: previewNavKb(showCartCmd?.keyboard, isLive) }); return; }
  if (action === 'checkout') {
    if (!cart.length) { await editTgMessage(chatId, messageId, '🛒 Корзина пуста — нечего оформлять.', { keyboard: previewNavKb(showCartCmd?.keyboard, isLive) }); return; }
    const itemsText = cart.map((x) => `${x.title} × ${x.qty}`).join(', ');
    const total = cartTotal(cart);
    setSession(chatId, { ...sess, previewCart: [] });
    await editTgMessage(chatId, messageId, `✅ <b>Заказ оформлен!</b>\n\n${htmlEscape(itemsText)}\n<b>Итого: ${fmtMoney(total, cur)}</b>\n\n(в превью заказ не сохраняется — в живом боте сохранится)`, { keyboard: previewNavKb(null, isLive) });
    return;
  }
}

// Превью кирпича записи — 1-в-1 с живым ботом (тот же движок booking.js), но
// состояние в previewBook и без сохранения реальной записи. Клавиатуры → data.
async function handlePreviewBooking(chatId, cbQuery, profile, cbData) {
  const bk = require('../helpers/booking');
  const messageId = cbQuery.message?.message_id;
  const userId = profile.userId;
  const toData = (kb) => (kb || []).map((row) => row.map((b) => ({ text: b.text, data: b.callback_data || b.data })));
  const sess = getSession(chatId) || {};
  const edit = (screen) => editTgMessage(chatId, messageId, screen.text, { keyboard: toData(screen.keyboard) });
  const showStep = async () => edit(await bk.renderBookingStep(userId, getSession(chatId)?.previewBook || {}, 3));

  if (cbData.startsWith('bksvc:')) { const c = await bk.renderServiceCard(userId, cbData.slice(6), 3); if (c) await edit(c); return; }
  if (cbData.startsWith('bkmst:')) { const c = await bk.renderMasterCard(userId, cbData.slice(6), 3); if (c) await edit(c); return; }
  if (cbData.startsWith('bkc:')) { const [, svcId, mstId] = cbData.split(':'); setSession(chatId, { ...sess, previewBook: { svcId, mstId: mstId || null } }); await showStep(); return; }
  if (cbData.startsWith('bkm:')) { setSession(chatId, { ...sess, previewBook: { mstId: cbData.slice(4) } }); await showStep(); return; }
  if (cbData.startsWith('bkw:')) {
    const book = { ...(sess.previewBook || {}) };
    const rest = cbData.slice(4);
    if (rest === 'back') { if (book.time) book.time = null; else if (book.mstId) book.mstId = null; else if (book.date) book.date = null; else book.svcId = null; setSession(chatId, { ...sess, previewBook: book }); await showStep(); return; }
    if (rest === 'ok') {
      const sum = await bk.bookingSummary(userId, book);
      setSession(chatId, { ...sess, previewBook: null });
      await editTgMessage(chatId, messageId, `✅ <b>Запись оформлена!</b>\n\n💇 ${htmlEscape(sum.serviceName)}\n👩‍💼 ${htmlEscape(sum.masterName)}\n📅 ${bk.fmtDateRu(book.date)} · 🕐 ${htmlEscape(book.time)}\n\n(в превью запись не сохраняется — в живом боте сохранится и спросит телефон)`, { keyboard: [[{ text: '⬅️ В меню', data: 'Назад' }]] });
      return;
    }
    const ci = rest.indexOf(':'); const k = rest.slice(0, ci); const v = rest.slice(ci + 1);
    if (k === 's') book.svcId = v; else if (k === 'd') book.date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`; else if (k === 'm') book.mstId = v; else if (k === 't') book.time = `${v.slice(0, 2)}:${v.slice(2, 4)}`;
    setSession(chatId, { ...sess, previewBook: book }); await showStep(); return;
  }
}

// Превью-карточки товаров с добавками — 1-в-1 с живым ботом (webhooks.js), но в
// previewCart и в формате кнопок превью (data:). Логика/рендер — общий helper.
async function handlePreviewCard(chatId, cbQuery, profile, cbData) {
  const pc = require('../helpers/productCard');
  const messageId = cbQuery.message?.message_id;
  const userId = profile.userId;
  const fresh = await UserAiConfig.findById(profile._id).lean();
  const commands = fresh?.botSettings?.commands || [];
  const cur = commands.find((c) => c.cartCurrency)?.cartCurrency || '₽';
  const sess = getSession(chatId) || {};
  const toData = (rows) => rows.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data })));
  const backRow = (recordId) => [[{ text: '⬅️ К позициям', data: `tglbback:${recordId}` }]];
  // Карточка со СВОИМ баннером — фото-сообщение (подпись = текст карточки), иначе
  // текст. captionOnly — переключение добавок: меняем лишь подпись, без пере-фото.
  const renderCardMsg = (card, rows, { captionOnly = false } = {}) =>
    renderStep({
      token: TGLETBOT_TOKEN, chatId,
      src: messageId ? { messageId, isPhoto: !!cbQuery?.message?.photo } : null,
      text: card.text, banner: card.banner || null,
      replyMarkup: buildInlineMarkup(rows), captionOnly,
    });

  if (cbData === 'tglbex:noop') { await answerCallback(cbQuery.id); return; }

  if (cbData.startsWith('tglbcard:')) {
    const m = cbData.match(/^tglbcard:(.+):([a-f0-9]{24})$/i);
    if (!m) return;
    const card = await pc.renderCard(userId, m[2], [], cur, m[1]);
    if (!card) return;
    // previewStep = карточка: присланное фото прицепится к ЭТОЙ карточке, а не к родителю.
    setSession(chatId, { ...sess, previewCardSel: { recordId: m[2], extras: [] }, previewStep: pc.cardBannerKey(m[2]), previewActive: true });
    await renderCardMsg(card, [...toData(card.keyboard), ...backRow(m[2])]);
    return;
  }
  if (cbData.startsWith('tglbback:')) {
    const recordId = cbData.slice('tglbback:'.length);
    const item = await pc.loadItem(userId, recordId);
    if (!item) return;
    const cands = commands.filter((c) => c.listSchema === item.schemaName && (c.productCard || c.addToCart));
    const catCmd = cands.find((c) => c.listFilter && String(c.listFilter.category || '').toLowerCase() === String(item.category || '').toLowerCase()) || cands[0];
    if (!catCmd) return;
    const { text: body, itemButtons } = await previewSchemaText(userId, item.schemaName, catCmd.response, { productCard: true, currency: cur, filter: catCmd.listFilter });
    const rows = [];
    if (Array.isArray(itemButtons)) itemButtons.forEach((r) => rows.push(r));
    const cnt = cartCount(sess.previewCart);
    const countedBtn = { text: `🛒 Корзина${cnt ? ` (${cnt} · ${fmtMoney(cartTotal(sess.previewCart), cur)})` : ''}`, data: 'tglbcart:view' };
    const resB = placeCountedCart(catCmd.keyboard || [], countedBtn);
    if (!resB.placed) rows.push([countedBtn]);
    (resB.placed ? resB.keyboard : stripCartButtons(catCmd.keyboard || [])).forEach((r) => rows.push(r));
    // Вернулись в категорию — previewStep снова на команду категории (не на карточку).
    setSession(chatId, { ...getSession(chatId), previewStep: catCmd.command, previewActive: true });
    // renderStep корректно уводит фото→текст (карточка была с баннером): удалит фото и пришлёт текст.
    await renderStep({ token: TGLETBOT_TOKEN, chatId, src: messageId ? { messageId, isPhoto: !!cbQuery?.message?.photo } : null, text: body || 'Выберите позицию:', banner: null, replyMarkup: buildInlineMarkup(rows) });
    return;
  }
  if (cbData.startsWith('tglbex:')) {
    const m = cbData.match(/^tglbex:([a-f0-9]{24}):(\d+):([mpt])$/i);
    if (!m) { await answerCallback(cbQuery.id); return; }
    const recordId = m[1], idx = parseInt(m[2], 10), op = m[3];
    const cur0 = sess.previewCardSel && sess.previewCardSel.recordId === recordId ? sess.previewCardSel : { recordId, extras: [] };
    const extras = new Set((cur0.extras || []).map(Number));
    if (op === 't') { if (extras.has(idx)) extras.delete(idx); else extras.add(idx); }
    else if (op === 'p') extras.add(idx); else extras.delete(idx);
    setSession(chatId, { ...sess, previewCardSel: { recordId, extras: [...extras] }, previewStep: pc.cardBannerKey(recordId), previewActive: true });
    const card = await pc.renderCard(userId, recordId, [...extras], cur);
    if (!card) { await answerCallback(cbQuery.id); return; }
    // Секундный тост: add — ±цена; remove — бесплатно.
    const ex = card.extras && card.extras[idx];
    const on = extras.has(idx);
    let toast = '';
    if (ex) toast = ex.type === 'remove'
      ? (on ? `✅ Убрали: ${ex.name}` : `↩️ Вернули: ${ex.name}`)
      : (on ? `✅ ${ex.name} добавлен · +${ex.price}${cur}` : `➖ ${ex.name} убран · −${ex.price}${cur}`);
    await answerCallback(cbQuery.id, toast);
    await renderCardMsg(card, [...toData(card.keyboard), ...backRow(recordId)], { captionOnly: true });
    return;
  }
  if (cbData.startsWith('tglbcardadd:')) {
    const recordId = cbData.slice('tglbcardadd:'.length);
    const card0 = sess.previewCardSel && sess.previewCardSel.recordId === recordId ? sess.previewCardSel : { extras: [] };
    const selIdx = new Set((card0.extras || []).map(Number));
    const item = await pc.loadItem(userId, recordId);
    if (!item) return;
    const chosen = (await pc.applicableExtras(userId, item.category)).filter((_, i) => selIdx.has(i));
    const line = pc.composeCartLine(item, chosen);
    let cart = Array.isArray(sess.previewCart) ? sess.previewCart : [];
    cart = cartAdd(cart, line);
    setSession(chatId, { ...sess, previewCart: cart, previewCardSel: null });
    const rows = [
      [{ text: `🛒 Корзина (${cartCount(cart)} · ${fmtMoney(cartTotal(cart), cur)})`, data: 'tglbcart:view' }],
      [{ text: '⬅️ К позициям', data: `tglbback:${recordId}` }],
    ];
    // Карточка была фото-сообщением — renderStep корректно сменит фото→текст.
    await renderStep({ token: TGLETBOT_TOKEN, chatId, src: messageId ? { messageId, isPhoto: !!cbQuery?.message?.photo } : null, text: `✅ <b>Добавлено в корзину:</b>\n${htmlEscape(line.title)} — ${fmtMoney(line.price, cur)}`, banner: null, replyMarkup: buildInlineMarkup(rows) });
    return;
  }
}

// ── Voice messages — same Groq Whisper (primary) + Google STT (fallback) chain
// routes/webhooks.js already uses for live customer bots, so a user can describe
// or tweak their bot by voice instead of typing. ──────────────────────────────
async function transcribeAudioBuffer(audioBuf, { mime = 'audio/ogg', filename = 'voice.ogg', encoding = 'OGG_OPUS', sampleRateHertz = 48000 } = {}) {
  try {
    if (process.env.GROQ_API_KEY) {
      const form = new FormData();
      form.append('file', new Blob([audioBuf], { type: mime }), filename);
      form.append('model', 'whisper-large-v3-turbo');
      form.append('language', 'ru');
      form.append('response_format', 'text');
      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: form,
      }).catch(() => null);
      if (groqRes?.ok) {
        const transcript = (await groqRes.text().catch(() => '')).trim();
        if (transcript) return transcript;
      }
    }

    const sttKey = process.env.GOOGLE_SPEECH_API_KEY || process.env.GOOGLE_API_KEY;
    if (sttKey) {
      const sttRes = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${sttKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding,
            sampleRateHertz,
            languageCode: 'ru-RU',
            alternativeLanguageCodes: ['en-US'],
            enableAutomaticPunctuation: true,
          },
          audio: { content: Buffer.from(audioBuf).toString('base64') },
        }),
      }).then((r) => r.json()).catch(() => null);
      return sttRes?.results?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
    }
  } catch (err) {
    console.error('TGLetBot voice transcription error:', err.message);
  }
  return '';
}

async function transcribeVoice(fileId) {
  const fi = await fetch(`${TG_API}/getFile?file_id=${fileId}`).then((r) => r.json()).catch(() => null);
  if (!fi?.result?.file_path) return '';
  const audioBuf = await fetch(`https://api.telegram.org/file/bot${TGLETBOT_TOKEN}/${fi.result.file_path}`)
    .then((r) => r.arrayBuffer()).catch(() => null);
  if (!audioBuf) return '';
  return transcribeAudioBuffer(audioBuf, { mime: 'audio/ogg', filename: 'voice.ogg', encoding: 'OGG_OPUS', sampleRateHertz: 48000 });
}

// Скачивает фото из конструктор-бота и отдаёт data-URL (base64). file_id
// привязан к токену бота, поэтому храним сами байты, а не file_id — иначе живой
// бот пользователя (другой токен) не смог бы отправить эту картинку.
async function downloadPhotoAsDataUrl(fileId) {
  const fi = await fetch(`${TG_API}/getFile?file_id=${fileId}`).then((r) => r.json()).catch(() => null);
  const fp = fi?.result?.file_path;
  if (!fp) return null;
  const buf = await fetch(`https://api.telegram.org/file/bot${TGLETBOT_TOKEN}/${fp}`)
    .then((r) => r.arrayBuffer()).catch(() => null);
  if (!buf) return null;
  const mime = /\.png$/i.test(fp) ? 'image/png' : /\.webp$/i.test(fp) ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

// ── Mini App session exchange ──────────────────────────────────────────────────
// Validates Telegram's signed initData, then mints a short-lived EmbedToken (never
// the user's real apiKey) so the Mini App can call the EXISTING /data/schemas and
// /data/records/:schemaName endpoints — same auth path the website widget uses.
router.post('/tgletbot/miniapp/session', async (req, res) => {
  try {
    const { initData } = req.body || {};
    const result = validateTelegramInitData(initData, TGLETBOT_TOKEN, { maxAgeSeconds: 86400 });
    if (!result.valid) return res.status(401).json({ success: false, error: 'Invalid Telegram session' });

    const telegramId = String(result.user.id);
    let user = await User.findOne({ telegramId });
    if (!user) {
      const { user: created } = await findOrCreateOAuthUser({
        provider: 'telegram', providerId: telegramId,
        displayName: result.user.first_name || '', trialDurationDays: TRIAL_DAYS,
      });
      user = created;
    }

    // Токен выдаётся и при неактивной подписке: мини-апп должен открываться,
    // чтобы пользователь мог оплатить тариф из вкладки «Аккаунт». Данные
    // (/data/*) при этом всё равно закрыты checkAccess'ом.
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await EmbedToken.findOneAndUpdate(
      { userId: user._id },
      { token, expiresAt },
      { upsert: true }
    );

    res.json({
      success: true, token, expiresAt,
      user: { firstName: result.user.first_name || '', username: result.user.username || '' },
    });
  } catch (err) {
    console.error('TGLetBot miniapp session error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App voice input — same Groq Whisper chain, but for a raw browser
// recording (MediaRecorder) instead of a Telegram-hosted voice file. Gated by
// checkAccess so the Mini App's EmbedToken works here too. ─────────────────────
router.post('/tgletbot/miniapp/transcribe', checkAccess, async (req, res) => {
  try {
    const { audio } = req.body || {};
    if (!audio || typeof audio !== 'string' || !audio.startsWith('data:audio/')) {
      return res.status(400).json({ success: false, error: 'audio (data URL) required' });
    }
    const b64 = audio.slice(audio.indexOf(',') + 1);
    const buf = Buffer.from(b64, 'base64');
    const text = await transcribeAudioBuffer(buf, { mime: 'audio/webm', filename: 'voice.webm', encoding: 'WEBM_OPUS', sampleRateHertz: 48000 });
    res.json({ success: true, text });
  } catch (err) {
    console.error('TGLetBot miniapp transcribe error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App auth — Bearer EmbedToken БЕЗ проверки подписки (в отличие от
// checkAccess): аккаунт/оплата/партнёрка должны работать и у истёкших
// пользователей, иначе им нечем оплатить. ─────────────────────────────────────
async function miniappAuth(req, res, next) {
  try {
    const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!key) return res.status(401).json({ success: false, error: 'Token missing' });
    const embed = await EmbedToken.findOne({ token: key, expiresAt: { $gt: new Date() } });
    const user = embed && await User.findById(embed.userId);
    if (!user) return res.status(401).json({ success: false, error: 'Invalid token' });
    req.user = user;
    next();
  } catch (err) {
    console.error('TGLetBot miniapp auth error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
}

const TGLB_PLAN_NAMES = { tgletbot: 'Standard', tgpremium: 'Premium', standard: 'Standard', pro: 'Premium', premium: 'Premium' };
const tglbPlanKey = (plan) => (['tgpremium', 'premium', 'pro'].includes(plan) ? 'premium' : 'standard');

function tglbMonthsLabel(durationDays) {
  const months = Math.max(1, Math.round((durationDays || 30) / 30));
  if (months >= 5 && months <= 7) return '6 месяцев';
  if (months >= 11) return '12 месяцев';
  if (months === 1) return '1 месяц';
  return `${months} мес`;
}

// ── Mini App: аккаунт — подписка, партнёрка (авто-регистрация кода), платежи ──
router.get('/tgletbot/miniapp/account', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const now = new Date();

    let subscription;
    if (FREE_MODE) {
      // FREE_MODE: тарифов нет — у всех «бесплатный доступ», без сроков и статусов
      // trial/expired (иначе мини-апп рисовал бы «период истёк» вопреки правде).
      subscription = { status: 'free', plan: 'free', planName: 'Бесплатный доступ' };
    } else if (user.subscriptionStatus === 'active' && user.subscriptionEnd > now) {
      const lastPay = (user.paymentHistory || [])[(user.paymentHistory || []).length - 1];
      subscription = {
        status: 'active',
        plan: tglbPlanKey(user.plan),
        planName: TGLB_PLAN_NAMES[user.plan] || 'Standard',
        startedAt: lastPay?.activatedAt || user.trialStart || user.createdAt,
        expiresAt: user.subscriptionEnd,
      };
    } else if (user.subscriptionStatus === 'trial' && user.trialStart) {
      const trialEnd = new Date(user.trialStart.getTime() + (user.trialDurationDays || 7) * 86400000);
      subscription = trialEnd > now
        ? { status: 'trial', plan: 'trial', planName: 'Пробный период', startedAt: user.trialStart, expiresAt: trialEnd }
        : { status: 'expired' };
    } else {
      subscription = { status: 'expired' };
    }

    // Партнёрка: код создаётся лениво при первом открытии аккаунта
    let aff = await UserAffiliate.findOne({ userId: user._id });
    if (!aff) {
      const genCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      };
      let code, attempts = 0;
      do { code = genCode(); attempts++; } while (attempts < 10 && await UserAffiliate.findOne({ referralCode: code }));
      aff = new UserAffiliate({ userId: user._id, referralCode: code });
      await aff.save();
    }
    const botUsername = process.env.TGLETBOT_USERNAME || 'AI_ConstructorBot';
    const referral = {
      code: aff.referralCode,
      link: `https://telegram.me/${botUsername}?start=ref_${aff.referralCode}`,
      invited: (aff.referrals || []).length,
      active: (aff.referrals || []).filter((r) => r.totalPaid > 0).length,
      percent: 20,
      earned: aff.totalEarned || 0,
      available: aff.balance || 0,
      minPayout: 1000,
      payoutPending: (aff.payouts || []).some((p) => p.status === 'pending'),
    };

    const PAYOUT_STATUS = { pending: 'pending', approved: 'payout', rejected: 'rejected' };
    const payments = [
      ...(user.paymentHistory || []).map((p, i) => ({
        id: `pay_${i}`,
        date: p.paidAt || p.activatedAt,
        title: `${TGLB_PLAN_NAMES[p.plan] || p.plan || 'Подписка'} · ${tglbMonthsLabel(p.durationDays)}`,
        amount: p.amount || 0,
        status: 'paid',
      })),
      ...(aff.payouts || []).map((p, i) => ({
        id: `payout_${i}`,
        date: p.requestedAt,
        title: 'Вывод с рефералов',
        amount: p.amount || 0,
        status: PAYOUT_STATUS[p.status] || 'pending',
      })),
    ].filter((p) => p.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);

    // Бонус за подписку на @aicupdates: +6 дней (до недели), разово на аккаунт.
    const channelBonus = {
      claimed: !!user.channelBonusClaimed,
      channel: AICUPDATES_CHANNEL,
      channelUrl: `https://telegram.me/${AICUPDATES_CHANNEL.replace('@', '')}`,
      bonusDays: CHANNEL_BONUS_DAYS,
      baseDays: TRIAL_DAYS,
      // «под замком» до подписки — показываем на полоске (7 дней = 1 + 6)
      lockedDays: (user.subscriptionStatus === 'trial' && !user.channelBonusClaimed) ? CHANNEL_BONUS_DAYS : 0,
      canClaim: user.subscriptionStatus === 'trial' && !user.channelBonusClaimed,
    };

    res.json({ success: true, subscription, referral, payments, botUsername, channelBonus, autoRenew: user.autoRenew === true });
  } catch (err) {
    console.error('TGLetBot miniapp account error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: забрать бонус +6 дней за подписку на @aicupdates (разово) ──────
router.post('/tgletbot/miniapp/claim-channel-bonus', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    if (user.channelBonusClaimed) return res.json({ success: false, reason: 'claimed' });
    const r = await grantChannelBonus(user);
    if (r.ok) return res.json({ success: true, bonusDays: CHANNEL_BONUS_DAYS });
    return res.json({ success: false, reason: r.reason });
  } catch (err) {
    console.error('claim-channel-bonus:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: «Особые функции» — доставка + приём платежей ──────────────────
// GET возвращает текущий конфиг доставки (+ описания полей для формы) и адрес
// вебхука оплаты. Источник правды — схема данных «Доставка» (та же, что видна в
// «Базе»); правим ту же запись. Служебное поле _admin_msgs наружу не отдаём.
router.get('/tgletbot/miniapp/features', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const tz = (await NotificationRule.findOne({ userId: user._id }).select('tzOffset').lean())?.tzOffset;
    await ensureDeliverySchema(user._id, { tzOffset: typeof tz === 'number' ? tz : undefined });
    const rec = await UserRecord.findOne({ userId: user._id, schemaName: DELIVERY_SCHEMA }).lean();
    const delivery = { ...DELIVERY_DEFAULTS, ...(rec?.data || {}) };
    delete delivery._admin_msgs;

    const profile = await UserAiConfig.findOne({ userId: user._id, profileName: { $ne: '__studio__' } });
    const integDoc = await UserIntegrations.findOne({ userId: user._id });
    const liveInstance = profile && (integDoc?.telegram || []).find((i) => i.connected && String(i.profileId) === String(profile._id));
    let paymentUrl = '';
    if (liveInstance) {
      let secret = liveInstance.paymentWebhookSecret;
      if (!secret) {
        secret = crypto.randomBytes(16).toString('hex');
        await UserIntegrations.findOneAndUpdate(
          { userId: user._id, 'telegram._id': liveInstance._id },
          { $set: { 'telegram.$.paymentWebhookSecret': secret } }
        );
      }
      paymentUrl = `${process.env.SERVER_URL || ''}/api/v1/webhook/payment/${user._id}/${liveInstance._id}?secret=${secret}`;
    }

    // Монетизация: настройки приёма оплаты ОТ клиентов бота (кошелёк, премиум).
    await ensurePaidSchemas(user._id);
    const paidRec = await UserRecord.findOne({ userId: user._id, schemaName: PAID_SCHEMA }).lean();
    const paid = { ...(await getPaidSettings(user._id)), ...(paidRec?.data || {}) };

    res.json({
      success: true,
      hasBot: !!profile, // без бота вкладка «Функции» показывает приятную заглушку
      delivery, fields: DELIVERY_FIELDS,
      payment: { botLive: !!liveInstance, url: paymentUrl },
      paid, paidFields: PAID_FIELDS,
    });
  } catch (e) {
    console.error('miniapp features:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Сохранение настроек монетизации (кошелёк, премиум) — та же запись paid_settings.
router.post('/tgletbot/miniapp/paid', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    await ensurePaidSchemas(user._id);
    const rec = await UserRecord.findOne({ userId: user._id, schemaName: PAID_SCHEMA });
    if (!rec) return res.status(500).json({ success: false, error: 'no record' });
    const next = { ...(rec.data || {}) };
    for (const fdef of PAID_FIELDS) {
      if (!(fdef.name in body)) continue;
      let v = body[fdef.name];
      if (fdef.type === 'number') v = Number(v) || 0;
      else if (fdef.type === 'boolean') v = v === true || v === 'true' || v === 1;
      else v = String(v ?? '').slice(0, 2000);
      next[fdef.name] = v;
    }
    rec.data = next;
    rec.markModified('data');
    await rec.save();
    res.json({ success: true, paid: next });
  } catch (e) {
    console.error('miniapp paid save:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.post('/tgletbot/miniapp/delivery', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    await ensureDeliverySchema(user._id);
    const rec = await UserRecord.findOne({ userId: user._id, schemaName: DELIVERY_SCHEMA });
    if (!rec) return res.status(500).json({ success: false, error: 'no record' });
    const next = { ...(rec.data || {}) };
    for (const fdef of DELIVERY_FIELDS) {
      if (!(fdef.name in body)) continue;
      let v = body[fdef.name];
      if (fdef.type === 'number') v = Number(v) || 0;
      else if (fdef.type === 'boolean') v = v === true || v === 'true' || v === 1;
      else v = String(v ?? '').slice(0, 2000);
      next[fdef.name] = v;
    }
    rec.data = next; // _admin_msgs и прочее служебное сохраняем как есть
    rec.markModified('data');
    await rec.save();
    const clean = { ...next }; delete clean._admin_msgs;
    res.json({ success: true, delivery: clean });
  } catch (e) {
    console.error('miniapp delivery save:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: администраторы бота ────────────────────────────────────────────
// «Полные права» — админ равен создателю (полный доступ к данным/ИИ), НО не может
// удалить бота. Без флага — ограниченный: получает уведомления о заказах, видит
// воронку и базу, подтверждает доставки, НО не меняет бота (ни через ИИ).
// Кандидаты (для подсказок) — те, кто писал живому боту владельца (knownContacts).
// Добавление по @username резолвит telegram-id из ДВУХ источников: (1) контакты
// живого бота, (2) пользователи конструктора (@AI_ConstructorBot). Человек виден/
// добавляем, только если хоть раз писал боту (/start) — иначе id неизвестен.
function normUname(u) { return String(u || '').replace(/^@+/, '').trim().toLowerCase(); }

// Достаёт контакты живого бота владельца (тех, кто ему писал) — {chatId, username, displayName}.
async function ownerKnownContacts(user) {
  const profile = await UserAiConfig.findOne({ userId: user._id, profileName: { $ne: '__studio__' } }).select('_id').lean();
  if (!profile) return [];
  const integDoc = await UserIntegrations.findOne({ userId: user._id }).select('telegram').lean();
  const inst = (integDoc?.telegram || []).find((i) => String(i.profileId) === String(profile._id));
  return Array.isArray(inst?.knownContacts) ? inst.knownContacts : [];
}

// Резолвит @username → { platformUserId, username, displayName } из контактов бота,
// затем из пользователей конструктора. null, если человек нигде не «засветился».
async function resolveTgUserByUsername(user, uname) {
  const key = normUname(uname);
  if (!key) return null;
  const contacts = await ownerKnownContacts(user);
  const hit = contacts.find((c) => normUname(c.username) === key);
  if (hit && hit.chatId) return { platformUserId: String(hit.chatId), username: normUname(hit.username), displayName: hit.displayName || '' };
  const cu = await User.findOne({ telegramUsername: key, telegramId: { $ne: null } }).select('telegramId telegramUsername displayName').lean();
  if (cu && cu.telegramId) return { platformUserId: String(cu.telegramId), username: normUname(cu.telegramUsername), displayName: cu.displayName || '' };
  return null;
}

// Список админов + кандидаты (контакты живого бота, кого ещё нет в админах).
router.get('/tgletbot/miniapp/admins', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const admins = (await UserAdmin.find({ ownerId: user._id, platform: 'telegram' }).sort({ createdAt: 1 }).lean())
      .map((a) => ({
        id: String(a._id),
        platformUserId: a.platformUserId,
        username: a.username || '',
        displayName: a.displayName || '',
        fullRights: !!a.fullRights,
      }));
    const taken = new Set(admins.map((a) => String(a.platformUserId)));
    const ownerTgId = String(user.telegramId || '');
    const contacts = await ownerKnownContacts(user);
    const seen = new Set();
    const candidates = [];
    for (const c of contacts) {
      const id = String(c.chatId || '');
      if (!id || id === ownerTgId || taken.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ platformUserId: id, username: normUname(c.username), displayName: c.displayName || '' });
    }
    // Свежие сверху (по последней активности), обрезаем для лёгкости.
    candidates.sort((a, b) => (a.username && !b.username ? -1 : b.username && !a.username ? 1 : 0));
    res.json({ success: true, admins, candidates: candidates.slice(0, 100) });
  } catch (e) {
    console.error('miniapp admins list:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Добавить админа по @username (или напрямую по platformUserId из подсказки).
router.post('/tgletbot/miniapp/admins', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};
    let platformUserId = body.platformUserId ? String(body.platformUserId) : '';
    let username = normUname(body.username);
    let displayName = String(body.displayName || '').slice(0, 100);
    const fullRights = body.fullRights === true || body.fullRights === 'true';

    if (!platformUserId) {
      const found = await resolveTgUserByUsername(user, username);
      if (!found) {
        return res.status(404).json({
          success: false,
          error: 'Пользователь не найден. Он должен хотя бы раз написать боту (/start), чтобы его можно было добавить.',
        });
      }
      platformUserId = found.platformUserId;
      username = found.username || username;
      displayName = displayName || found.displayName;
    }
    if (String(user.telegramId || '') === platformUserId) {
      return res.status(400).json({ success: false, error: 'Вы владелец — у вас уже полные права.' });
    }
    const doc = await UserAdmin.findOneAndUpdate(
      { ownerId: user._id, platform: 'telegram', platformUserId },
      { $set: { role: 'admin', username, displayName, fullRights }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ success: true, admin: { id: String(doc._id), platformUserId: doc.platformUserId, username: doc.username || '', displayName: doc.displayName || '', fullRights: !!doc.fullRights } });
  } catch (e) {
    console.error('miniapp admins add:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Переключить «Полные права».
router.patch('/tgletbot/miniapp/admins/:id', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const fullRights = req.body?.fullRights === true || req.body?.fullRights === 'true';
    const doc = await UserAdmin.findOneAndUpdate(
      { _id: req.params.id, ownerId: user._id },
      { $set: { fullRights } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, admin: { id: String(doc._id), fullRights: !!doc.fullRights } });
  } catch (e) {
    console.error('miniapp admins patch:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Удалить админа.
router.delete('/tgletbot/miniapp/admins/:id', miniappAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = await UserAdmin.deleteOne({ _id: req.params.id, ownerId: user._id });
    res.json({ success: r.deletedCount > 0 });
  } catch (e) {
    console.error('miniapp admins delete:', e.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: ссылка на оплату тарифа ──────────────────────────────────────────
// ── Mini App: включить/выключить автопродление ──────────────────────────────
// Только по явному действию пользователя (Оферта п. 8.1, Политика рекуррентных
// платежей п. 2.1). Отключение вступает в силу немедленно (п. 8.4) и не влияет
// на уже оплаченный период.
router.post('/tgletbot/miniapp/autorenew', miniappAuth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled должен быть boolean' });
    req.user.autoRenew = enabled;
    await req.user.save();
    res.json({ success: true, autoRenew: req.user.autoRenew === true });
  } catch (err) {
    console.error('TGLetBot miniapp autorenew error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.post('/tgletbot/miniapp/pay', miniappAuth, async (req, res) => {
  try {
    // FREE_MODE: пока мы обещаем «бесплатно», принимать деньги нельзя — ни через
    // старый экран в кеше мини-аппа, ни прямым запросом.
    if (FREE_MODE) {
      return res.status(409).json({ success: false, error: 'AiConstructor сейчас бесплатный — оплата не нужна.' });
    }
    const user = req.user;
    const { plan = 'standard', months = 1, autoRenew } = req.body || {};
    // Тумблер автопродления на экране оплаты — тоже явное действие пользователя.
    if (typeof autoRenew === 'boolean' && user.autoRenew !== autoRenew) {
      user.autoRenew = autoRenew;
      await user.save().catch(() => {});
    }
    if (!TGLB_PLANS[plan]) return res.status(400).json({ success: false, error: 'Неверный тариф' });
    const m = [1, 6, 12].includes(Number(months)) ? Number(months) : 1;

    // Даунгрейд при активной подписке activateSubscription молча отбрасывает —
    // деньги ушли бы в пустоту. Блокируем на входе.
    const now = new Date();
    const activePremium = user.subscriptionStatus === 'active' && user.subscriptionEnd > now
      && tglbPlanKey(user.plan) === 'premium';
    if (plan === 'standard' && activePremium) {
      return res.status(400).json({ success: false, error: 'Сейчас у вас Premium — перейти на Standard можно после окончания текущего периода.' });
    }

    const url = await createPaymentUrl(user, plan, m);
    if (!url) return res.status(503).json({ success: false, error: 'Оплата временно недоступна' });
    res.json({ success: true, url, amount: tglbPlanTotal(plan, m) });
  } catch (err) {
    console.error('TGLetBot miniapp pay error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: вывод реферального баланса (та же логика, что /affiliate/withdraw) ──
router.post('/tgletbot/miniapp/referral/withdraw', miniappAuth, async (req, res) => {
  try {
    const { amount, paymentDetails } = req.body || {};
    const num = Number(amount);
    if (!num || num < 1000) return res.status(400).json({ success: false, error: 'Минимальная сумма вывода — 1 000 ₽' });
    if (!paymentDetails?.trim()) return res.status(400).json({ success: false, error: 'Укажите реквизиты для выплаты' });

    const affiliate = await UserAffiliate.findOne({ userId: req.user._id });
    if (!affiliate) return res.status(404).json({ success: false, error: 'Вы не участник партнёрской программы' });
    if (affiliate.balance < num) return res.status(400).json({ success: false, error: 'Недостаточно средств на балансе' });
    if (affiliate.payouts.some((p) => p.status === 'pending')) {
      return res.status(400).json({ success: false, error: 'У вас уже есть необработанный запрос на вывод' });
    }

    affiliate.payouts.push({ amount: num, paymentDetails: paymentDetails.trim() });
    await affiliate.save();
    res.json({ success: true });
  } catch (err) {
    console.error('TGLetBot miniapp withdraw error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: состояние бота + статистика ──────────────────────────────────────
async function findUserBot(userId) {
  const profile = await UserAiConfig.findOne({ userId, profileName: { $ne: '__studio__' } }).lean();
  if (!profile) return { profile: null, instance: null };
  const integDoc = await UserIntegrations.findOne({ userId });
  const instance = (integDoc?.telegram || []).find((i) => String(i.profileId) === String(profile._id)) || null;
  return { profile, instance, integDoc };
}

router.get('/tgletbot/miniapp/bot', miniappAuth, async (req, res) => {
  try {
    const { profile, instance } = await findUserBot(req.user._id);
    // Профиль без подключённого токена — бот ещё «не создан» с точки зрения
    // пользователя (создание достраивается в чате), поэтому absent.
    if (!profile || !instance) return res.json({ success: true, bot: { status: 'absent' } });

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    // Считаем ТОЛЬКО работу ЖИВОГО бота (context.source:'telegram' — ответы
    // клиентам). НЕ мешаем сюда студийные промты владельца (source:'studio' —
    // «создай/поправь бота»), иначе «Обработано AI» раздувается собственными
    // правками, а не реальной работой бота (было: считались ВСЕ completed-задачи).
    const liveScope = { userId: req.user._id, 'context.source': 'telegram' };
    const [requestsToday, aiProcessed] = await Promise.all([
      Task.countDocuments({ ...liveScope, createdAt: { $gte: startOfDay } }),
      Task.countDocuments({ ...liveScope, status: 'completed' }),
    ]);

    // Показываем НАСТОЯЩЕЕ имя Telegram-бота (из BotFather/getMe), а не выдуманный
    // aiName. Кэшируем в botName, чтобы не дёргать getMe при каждом открытии.
    let botName = instance.botName;
    if (!botName && instance.token) {
      const me = await fetch(`https://api.telegram.org/bot${instance.token}/getMe`).then((r) => r.json()).catch(() => null);
      botName = me?.result?.first_name || '';
      if (botName) {
        await UserIntegrations.findOneAndUpdate(
          { userId: req.user._id, 'telegram._id': instance._id },
          { $set: { 'telegram.$.botName': botName } }
        ).catch(() => {});
      }
    }

    res.json({
      success: true,
      bot: {
        status: instance.connected ? 'online' : 'offline',
        name: botName || instance.botUsername || profile.aiName || 'Мой бот',
        username: instance.botUsername || '',
        stats: {
          totalUsers: (instance.knownContacts || []).length,
          requestsToday,
          aiProcessed,
        },
      },
    });
  } catch (err) {
    console.error('TGLetBot miniapp bot error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: питание бота (start / stop / restart) — реальный вебхук Telegram.
// checkAccess: управлять хостингом можно только с активной подпиской. ──────────
router.post('/tgletbot/miniapp/bot/power', checkAccess, async (req, res) => {
  try {
    const { action } = req.body || {};
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Неверное действие' });
    }
    const { instance } = await findUserBot(req.user._id);
    if (!instance?.token) return res.status(400).json({ success: false, error: 'Бот ещё не подключён — заверши создание в чате.' });

    const serverUrl = process.env.SERVER_URL || '';
    const webhookUrl = `${serverUrl}/api/v1/webhook/telegram/${req.user._id}/${instance._id}`;
    let connected;
    if (action === 'stop') {
      await fetch(`https://api.telegram.org/bot${instance.token}/deleteWebhook`).catch(() => {});
      connected = false;
    } else {
      const whRes = await fetch(`https://api.telegram.org/bot${instance.token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, drop_pending_updates: action === 'restart' }),
      }).then((r) => r.json()).catch(() => null);
      if (!whRes?.ok) {
        return res.status(502).json({ success: false, error: 'Telegram не принял вебхук: ' + (whRes?.description || 'ошибка API') });
      }
      connected = true;
    }
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id, 'telegram._id': instance._id },
      { $set: { 'telegram.$.connected': connected } }
    );
    res.json({ success: true, status: connected ? 'online' : 'offline' });
  } catch (err) {
    console.error('TGLetBot miniapp power error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: удалить бота целиком (профиль + данные + синки) ──────────────────
router.post('/tgletbot/miniapp/bot/delete', miniappAuth, async (req, res) => {
  try {
    // Перед удалением сохраняем макет — чтобы можно было вернуться.
    await snapshotCurrentLayout(req.user, 'auto', 'Перед удалением');
    // Полное удаление бота — обнуляем всё, включая загруженные баннеры-картинки
    // на всех экранах меню (в отличие от «Начать заново», где их сохраняем).
    await wipeUserBot(req.user, { keepBanners: false });
    res.json({ success: true });
  } catch (err) {
    console.error('TGLetBot miniapp delete error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Mini App: снапшоты макета бота (сохранить / список / вернуть / удалить) ────
// Снимок = структура и поведение бота (botSettings + промпт), НЕ данные.
async function snapshotCurrentLayout(user, source = 'manual', name = '') {
  const { profile } = await findUserBot(user._id);
  if (!profile || !(profile.botSettings?.commands?.length)) return null;
  const snap = await BotSnapshot.create({
    userId: user._id,
    profileId: profile._id,
    name: name || profile.aiName || 'Макет',
    source,
    aiName: profile.aiName || '',
    systemPrompt: profile.systemPrompt || '',
    botSettings: profile.botSettings || {},
  });
  // Не копим бесконечно авто-снимки: держим последние 20 на пользователя.
  const all = await BotSnapshot.find({ userId: user._id }).sort({ createdAt: -1 }).select('_id').lean();
  if (all.length > 20) {
    await BotSnapshot.deleteMany({ _id: { $in: all.slice(20).map((s) => s._id) } });
  }
  return snap;
}

router.post('/tgletbot/miniapp/snapshots/save', miniappAuth, async (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim().slice(0, 60);
    const snap = await snapshotCurrentLayout(req.user, 'manual', name);
    if (!snap) return res.status(400).json({ success: false, error: 'Пока нечего сохранять — сначала создай бота.' });
    res.json({ success: true, id: snap._id });
  } catch (err) {
    console.error('TGLetBot snapshot save error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.get('/tgletbot/miniapp/snapshots', miniappAuth, async (req, res) => {
  try {
    const snaps = await BotSnapshot.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({
      success: true,
      snapshots: snaps.map((s) => ({
        id: s._id,
        name: s.name,
        source: s.source,
        commands: (s.botSettings?.commands || []).length,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error('TGLetBot snapshots list error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.post('/tgletbot/miniapp/snapshots/:id/restore', miniappAuth, async (req, res) => {
  try {
    const snap = await BotSnapshot.findOne({ _id: req.params.id, userId: req.user._id }).lean().catch(() => null);
    if (!snap) return res.status(404).json({ success: false, error: 'Макет не найден' });
    const { profile, instance } = await findUserBot(req.user._id);
    if (!profile) return res.status(400).json({ success: false, error: 'Сначала создай бота.' });
    // Перед откатом сохраняем текущий макет — чтобы «отменить откат».
    await snapshotCurrentLayout(req.user, 'auto', 'Перед возвратом');
    await UserAiConfig.findByIdAndUpdate(profile._id, {
      $set: { aiName: snap.aiName, systemPrompt: snap.systemPrompt, botSettings: snap.botSettings },
    });
    // Если бот подключён — обновим меню слэш-команд в самом Telegram.
    if (instance?.connected) await pushSetMyCommands(req.user, profile._id);
    res.json({ success: true });
  } catch (err) {
    console.error('TGLetBot snapshot restore error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.delete('/tgletbot/miniapp/snapshots/:id', miniappAuth, async (req, res) => {
  try {
    await BotSnapshot.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    console.error('TGLetBot snapshot delete error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Маркетплейс макетов ботов ─────────────────────────────────────────────────
const TEMPLATE_CATEGORY_PREFIX = { ecommerce: 'SHOP', restaurant: 'FOOD', booking: 'BOOK', other: 'BOT' };
async function genTemplateCode(category) {
  const prefix = TEMPLATE_CATEGORY_PREFIX[category] || 'BOT';
  for (let i = 0; i < 12; i++) {
    const code = `${prefix}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    if (!(await BotTemplate.findOne({ code }))) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

// Собирает макет из текущего бота пользователя (структура + определения схем, без данных).
async function buildTemplatePayload(userId) {
  const { profile } = await findUserBot(userId);
  if (!profile || !(profile.botSettings?.commands?.length)) return null;
  const schemas = await UserSchema.find({ userId, isActive: true }).lean();
  return {
    aiName: profile.aiName || '',
    systemPrompt: profile.systemPrompt || '',
    botSettings: profile.botSettings || {},
    schemas: schemas.map((s) => ({ name: s.name, label: s.label, icon: s.icon, color: s.color, fields: s.fields || [] })),
  };
}

// Применяет макет к боту покупателя: снапшот текущего → запись структуры →
// создание пустых схем макета (данные не переносятся).
async function applyTemplateToUser(user, tpl) {
  await snapshotCurrentLayout(user, 'auto', 'Перед сменой макета');
  let { profile } = await findUserBot(user._id);
  if (!profile) profile = await createDraftProfile(user);
  await UserAiConfig.findByIdAndUpdate(profile._id, {
    $set: { aiName: tpl.aiName || 'Бот', systemPrompt: tpl.systemPrompt || 'Ты — полезный ассистент.', botSettings: tpl.botSettings || {} },
  });
  for (const sd of (tpl.schemas || [])) {
    if (!sd?.name) continue;
    const exists = await UserSchema.findOne({ userId: user._id, name: sd.name });
    if (!exists) {
      await UserSchema.create({
        userId: user._id, name: sd.name, label: sd.label || sd.name,
        icon: sd.icon || '📋', color: sd.color, fields: sd.fields || [], isActive: true,
      }).catch((e) => console.warn('applyTemplate schema:', e.message));
    }
  }
  const { instance } = await findUserBot(user._id);
  if (instance?.connected) await pushSetMyCommands(user, profile._id);
}

// Публикация текущего бота как макета на продажу (уходит на модерацию).
router.post('/tgletbot/miniapp/templates/publish', miniappAuth, async (req, res) => {
  try {
    const title = (req.body?.title || '').toString().trim().slice(0, 80);
    const description = (req.body?.description || '').toString().trim().slice(0, 500);
    const category = ['ecommerce', 'restaurant', 'booking', 'other'].includes(req.body?.category) ? req.body.category : 'other';
    const price = Math.max(0, Math.min(100000, Math.round(Number(req.body?.price) || 0)));
    if (!title) return res.status(400).json({ success: false, error: 'Укажите название макета.' });

    const payload = await buildTemplatePayload(req.user._id);
    if (!payload) return res.status(400).json({ success: false, error: 'Сначала создай бота — публиковать пока нечего.' });

    const code = await genTemplateCode(category);
    const tpl = await BotTemplate.create({
      code, authorId: req.user._id, title, description, category, price, status: 'pending', ...payload,
    });
    res.json({ success: true, id: tpl._id, code: tpl.code, status: tpl.status });
  } catch (err) {
    console.error('Template publish error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Мои макеты (опубликованные) + мои покупки.
router.get('/tgletbot/miniapp/templates/mine', miniappAuth, async (req, res) => {
  try {
    const published = await BotTemplate.find({ authorId: req.user._id }).sort({ createdAt: -1 }).lean();
    const purchases = await BotTemplatePurchase.find({ buyerId: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      commission: PLATFORM_COMMISSION,
      isModerator: isTemplateModerator(req.user),
      published: published.map((t) => ({ id: t._id, code: t.code, title: t.title, price: t.price, status: t.status, sales: t.sales, moderationNote: t.moderationNote })),
      purchases: purchases.map((p) => ({ code: p.code, amount: p.amount, createdAt: p.createdAt })),
    });
  } catch (err) {
    console.error('Templates mine error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Инфо о макете по коду (для просмотра перед покупкой). Только одобренные.
router.get('/tgletbot/miniapp/templates/lookup/:code', miniappAuth, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const tpl = await BotTemplate.findOne({ code }).lean();
    if (!tpl || (tpl.status !== 'approved' && String(tpl.authorId) !== String(req.user._id))) {
      return res.status(404).json({ success: false, error: 'Макет с таким кодом не найден.' });
    }
    const owned = tpl.price === 0 || String(tpl.authorId) === String(req.user._id)
      || !!(await BotTemplatePurchase.findOne({ buyerId: req.user._id, templateId: tpl._id }));
    res.json({
      success: true,
      template: {
        code: tpl.code, title: tpl.title, description: tpl.description, category: tpl.category,
        price: tpl.price, sales: tpl.sales, commands: (tpl.botSettings?.commands || []).length, owned,
      },
    });
  } catch (err) {
    console.error('Template lookup error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Покупка макета: бесплатный/уже купленный/свой → сразу владение; иначе ссылка на оплату.
router.post('/tgletbot/miniapp/templates/:code/buy', miniappAuth, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const tpl = await BotTemplate.findOne({ code });
    if (!tpl || tpl.status !== 'approved') return res.status(404).json({ success: false, error: 'Макет не найден.' });

    const isOwn = String(tpl.authorId) === String(req.user._id);
    const alreadyBought = await BotTemplatePurchase.findOne({ buyerId: req.user._id, templateId: tpl._id });
    if (isOwn || alreadyBought || tpl.price === 0) {
      if (!isOwn && !alreadyBought && tpl.price === 0) {
        await grantTemplatePurchase(req.user._id, tpl, 0, null);
      }
      return res.json({ success: true, owned: true });
    }
    const wallet = process.env.YOOMONEY_WALLET;
    if (!wallet) return res.status(503).json({ success: false, error: 'Оплата временно недоступна.' });
    const label = `${req.user._id}_tpl_${tpl._id}_${Date.now()}`;
    const url = `https://yoomoney.ru/quickpay/confirm?receiver=${wallet}&quickpay-form=shop&targets=Siberi AI+template+${tpl.code}&sum=${tpl.price}&label=${label}`;
    res.json({ success: true, owned: false, url, amount: tpl.price });
  } catch (err) {
    console.error('Template buy error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Применить макет к своему боту (только если владеешь: куплен/бесплатный/свой).
router.post('/tgletbot/miniapp/templates/:code/apply', miniappAuth, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const tpl = await BotTemplate.findOne({ code }).lean();
    if (!tpl || (tpl.status !== 'approved' && String(tpl.authorId) !== String(req.user._id))) {
      return res.status(404).json({ success: false, error: 'Макет не найден.' });
    }
    const owned = tpl.price === 0 || String(tpl.authorId) === String(req.user._id)
      || !!(await BotTemplatePurchase.findOne({ buyerId: req.user._id, templateId: tpl._id }));
    if (!owned) return res.status(403).json({ success: false, error: 'Сначала купите этот макет.' });

    await applyTemplateToUser(req.user, tpl);
    res.json({ success: true });
  } catch (err) {
    console.error('Template apply error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ── Маркетплейс: модерация (админ) + публикация в канал ────────────────────────
const TPL_ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const TPL_MODERATOR_IDS = (process.env.TEMPLATE_MODERATOR_IDS || process.env.ADMIN_ALERT_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
function isTemplateModerator(user) {
  return !!(user?.isSiteAdmin
    || TPL_ADMIN_EMAILS.includes((user?.email || '').toLowerCase())
    || (user?.telegramId && TPL_MODERATOR_IDS.includes(String(user.telegramId))));
}

async function postTemplateToChannel(tpl) {
  const channel = process.env.TEMPLATE_CHANNEL_ID;
  if (!channel || !TGLETBOT_TOKEN) return;
  const priceStr = tpl.price > 0 ? `${tpl.price} ₽` : 'Бесплатно';
  const botUsername = process.env.TGLETBOT_USERNAME || 'AI_ConstructorBot';
  const text = `🧩 <b>${tpl.title}</b>\n\n${tpl.description || ''}\n\n💰 ${priceStr} · 📦 ${(tpl.botSettings?.commands || []).length} команд\n🔑 Код: <code>${tpl.code}</code>\n\nУстановить: @${botUsername} → приложение → «Бот» → «Магазин макетов» → введи код.`;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channel, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

router.get('/tgletbot/miniapp/templates/admin/pending', miniappAuth, async (req, res) => {
  if (!isTemplateModerator(req.user)) return res.status(403).json({ success: false, error: 'Нет доступа' });
  const pending = await BotTemplate.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
  res.json({ success: true, templates: pending.map((t) => ({ id: t._id, code: t.code, title: t.title, description: t.description, price: t.price, category: t.category, commands: (t.botSettings?.commands || []).length })) });
});

router.post('/tgletbot/miniapp/templates/admin/:id/approve', miniappAuth, async (req, res) => {
  if (!isTemplateModerator(req.user)) return res.status(403).json({ success: false, error: 'Нет доступа' });
  const tpl = await BotTemplate.findById(req.params.id);
  if (!tpl) return res.status(404).json({ success: false, error: 'Не найдено' });
  tpl.status = 'approved';
  tpl.moderationNote = '';
  await tpl.save();
  await postTemplateToChannel(tpl);
  res.json({ success: true });
});

router.post('/tgletbot/miniapp/templates/admin/:id/reject', miniappAuth, async (req, res) => {
  if (!isTemplateModerator(req.user)) return res.status(403).json({ success: false, error: 'Нет доступа' });
  const tpl = await BotTemplate.findById(req.params.id);
  if (!tpl) return res.status(404).json({ success: false, error: 'Не найдено' });
  tpl.status = 'rejected';
  tpl.moderationNote = (req.body?.note || '').toString().slice(0, 300);
  await tpl.save();
  res.json({ success: true });
});

// ── Webhook ─────────────────────────────────────────────────────────────────────
router.post('/webhook/tgletbot', async (req, res) => {
  res.status(200).send('OK');
  if (!TGLETBOT_TOKEN) return;

  try {
    const update = req.body;
    // Telegram redelivers an update if it didn't get a timely 200 — which can
    // happen purely from server restarts, even though we ACK above before any
    // work. Without this, a redelivered tap/message gets processed (and
    // replied to) a second time.
    if (isDuplicateUpdate('tgletbot', update?.update_id)) return;
    const isCallback = !!update?.callback_query;
    const cbQuery = update?.callback_query;
    const cbData = cbQuery?.data || '';
    let text = isCallback ? '' : (update?.message?.text || '').trim();
    const tgVoice = isCallback ? null : (update?.message?.voice || update?.message?.audio);
    // Фото (баннер экрана): берём самый крупный размер из массива message.photo.
    const tgPhotos = isCallback ? null : update?.message?.photo;
    const tgPhoto = Array.isArray(tgPhotos) && tgPhotos.length ? tgPhotos[tgPhotos.length - 1] : null;
    const fromUser = (isCallback ? cbQuery?.from : update?.message?.from) || {};
    const chatId = isCallback ? cbQuery?.message?.chat?.id : update?.message?.chat?.id;
    if (!chatId || !fromUser?.id) return;
    if (!isCallback && !text && !tgVoice?.file_id && !tgPhoto?.file_id) return;

    enqueueChat(String(chatId), async () => {
      // Добавление в превью-корзину (тост с суммой) и переключение добавок в
      // карточке (тост «+30₽/−30₽») отвечают СВОИМ текстом внутри — не гасим их
      // пустым ответом здесь.
      if (isCallback && !/^(tglbcart:add:|tglbex:)/.test(cbData || '')) answerCallback(cbQuery.id);

      if (!isCallback && !text && tgVoice?.file_id) {
        sendChatAction(chatId, 'typing');
        text = await transcribeVoice(tgVoice.file_id);
        if (!text) {
          await sendTgMessage(chatId, 'Не удалось распознать голосовое 🙁 Попробуй ещё раз или напиши текстом.');
          return;
        }
      }

      const telegramId = String(fromUser.id);

      // ── Доступ: конструктор открыт владельцу и тем, кого он позвал ──────────
      // Проверяем ДО создания аккаунта: случайному человеку не заводим запись,
      // не тратим на него ИИ и вообще ничего не делаем, кроме одной строчки.
      if (tglbAccess.isOwner(telegramId)) {
        const cmd = text.match(/^\/(invite|revoke|invited)(?:@\S+)?(?:\s+(.*))?$/i);
        if (cmd) {
          const [, name, arg] = cmd;
          let reply;
          if (name.toLowerCase() === 'invited') reply = await tglbAccess.list();
          else if (name.toLowerCase() === 'invite') reply = await tglbAccess.invite(arg, telegramId);
          else reply = await tglbAccess.revoke(arg);
          tglbAccess.resetCache();          // чтобы доступ включился сразу, а не через минуту
          await sendTgMessage(chatId, reply);
          return;
        }
      } else if (!(await tglbAccess.hasAccess(fromUser))) {
        if (!isCallback) {
          await sendTgMessage(chatId,
            'Конструктор сейчас работает по приглашениям 🔒\n\n'
            + 'Если тебе нужен доступ — напиши владельцу, он откроет.');
        }
        return;
      }

      let user = await User.findOne({ telegramId });

      // ── Brand new contact ──────────────────────────────────────────────────
      if (!user) {
        if (isCallback) return; // stray callback tap with no account behind it — ignore
        const { user: created } = await findOrCreateOAuthUser({
          provider: 'telegram', providerId: telegramId,
          displayName: fromUser.first_name || '', trialDurationDays: TRIAL_DAYS,
        });
        user = created;

        // Реф-ссылка мини-аппа: /start ref_CODE — привязываем партнёра сразу,
        // до первого платежа (вебхук оплаты потом сам начислит комиссию).
        const startPayload = text.match(/^\/start\s+(\S+)/i)?.[1] || '';
        if (startPayload.toLowerCase().startsWith('ref_')) {
          await attachReferral(user, startPayload.slice(4));
        }

        const profile = await createDraftProfile(user);
        await sendTgMessage(chatId, WELCOME_TEXT);

        const isStartCmd = /^\/start(\s|$)/i.test(text);
        // Слэш-команда (в т.ч. несуществующая) первым сообщением — не сборка, а команда:
        // не запускаем ИИ, просто приглашаем описать бота словами.
        if (text && !isStartCmd && !text.trim().startsWith('/')) {
          await runBuildingTurn(chatId, user, profile, text);
        } else {
          await sendTgMessage(chatId, 'Расскажи в одном сообщении, какой бот нужен 👇');
        }
        return;
      }

      // ── Блокировка аккаунта платформенным админом (через /admin) ────────────
      // Заблокированный не может пользоваться конструктором; его живой бот тоже
      // молчит (гейт в webhooks.js). Админов не блокируем.
      if (user.isBlocked && user.isBlocked() && !isPlatformAdmin(fromUser)) {
        if (!isCallback) await sendTgMessage(chatId, '⛔ Ваш аккаунт заблокирован администратором.\n\nЕсли это ошибка — напишите в поддержку.');
        return;
      }

      // ── Запоминаем @username конструктор-пользователя ───────────────────────
      // Нужен, чтобы владелец мог добавить этого человека в админы по @username в
      // mini-app (кандидаты берём из тех, кто хоть раз писал конструктору).
      {
        const uname = String(fromUser.username || '').replace(/^@+/, '').toLowerCase();
        if (uname && uname !== String(user.telegramUsername || '').toLowerCase()) {
          user.telegramUsername = uname;
          await user.save().catch(() => {});
        }
      }

      // ── Метрика активности (для active_users) ───────────────────────────────
      User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});

      // ── Отключение автопродления прямо из уведомления о списании ──────────
      // Политика рекуррентных платежей п. 3.4 требует кнопку отключения прямо
      // в уведомлении; п. 8.4 оферты — отключение вступает в силу немедленно
      // и НЕ трогает уже оплаченный период.
      if (isCallback && cbData === 'autoren:off') {
        if (user) {
          user.autoRenew = false;
          await user.save().catch(() => {});
        }
        await answerCallback(cbQuery.id, 'Автопродление отключено');
        await sendTgMessage(chatId,
          '❌ <b>Автопродление отключено</b>\n\n'
          + 'Списаний больше не будет. Доступ сохраняется до конца уже оплаченного периода.\n'
          + 'Включить обратно можно в мини-аппе → «Аккаунт».');
        return;
      }

      // ── Админ-консоль AiConstructor: карточка пользователя (бот/статы/подписка)
      // + выдать/снять доступ, заблокировать/разблокировать. Работает независимо
      // от собственной подписки админа. Только для платформенных админов. ────────
      if (isPlatformAdmin(fromUser)) {
        if (isCallback && (cbData || '').startsWith('admu:')) {
          await handleAdminUserCb(chatId, cbData, cbQuery.message?.message_id);
          return;
        }
        // Новые пользователи + на каком шаге застряли — чтобы догонять фидбеком.
        if (isCallback && cbData === 'admnew') {
          await answerCallback(cbQuery.id);
          sendChatAction(chatId, 'typing');
          try {
            const list = await newUsers(7, 15);
            await sendTgMessage(chatId, renderNewUsers(list, 7), { keyboard: newUsersKeyboard(list) });
          } catch (e) {
            await sendTgMessage(chatId, 'Не удалось получить список: ' + e.message);
          }
          return;
        }
        // Листалка отзывов: 'admfb' — из меню (новое сообщение, с #0);
        // 'admfb:<idx>' — навигация ◀️/▶️ (редактируем на месте).
        if (isCallback && (cbData === 'admfb' || cbData.startsWith('admfb:'))) {
          await answerCallback(cbQuery.id);
          const idx = cbData === 'admfb' ? 0 : (parseInt(cbData.split(':')[1], 10) || 0);
          const msgId = cbData === 'admfb' ? null : cbQuery.message?.message_id;
          try {
            await showFeedback(chatId, idx, msgId);
          } catch (e) {
            await sendTgMessage(chatId, 'Не удалось открыть фидбек: ' + e.message);
          }
          return;
        }
        const asess = getSession(chatId) || {};
        if (asess.awaitingAdminLookup && !isCallback && text && !text.trim().startsWith('/')) {
          setSession(chatId, { ...asess, awaitingAdminLookup: false });
          await handleAdminUserLookup(chatId, text.trim());
          return;
        }
      }

      // ── Приём текста отзыва ──────────────────────────────────────────────────
      // ДО гейта: отзыв должен уметь оставить кто угодно, включая замороженного
      // юзера. Команды (текст с «/») не перехватываем — /start отменяет режим.
      const fsess = getSession(chatId) || {};
      if (fsess.awaitingFeedback && !isCallback && text && !text.trim().startsWith('/')) {
        setSession(chatId, { ...fsess, awaitingFeedback: false });
        await submitFeedback(chatId, user, fromUser, text.trim());
        return;
      }

      // ── Trial/subscription gate ─────────────────────────────────────────────
      // Пробный день кончился → предлагаем подписку на @aicupdates (+6 дней) или
      // оплату. Кнопки самого гейта (проверка подписки / показать оплату) —
      // пропускаем, иначе пользователь не смог бы их нажать.
      const gateBypass = isCallback && (cbData === 'tglb:checksub' || cbData === 'tglb:showpay' || cbData === 'tglb:feedback' || cbData.startsWith('dlvdone:'));
      // FREE_MODE: подписался на канал — пользуйся дальше бесплатно, платной стены
      // больше нет. Заморозка первых суток и гейт подписки на @aicupdates живут
      // как жили: пока бонус не получен, сюда мы не проваливаемся.
      const freePass = FREE_MODE && user.channelBonusClaimed;
      if (!user.isAccessActive() && !gateBypass && !freePass) {
        await sendTrialGate(chatId, user);
        return;
      }

      // ── Abuse guard for this public funnel bot ──────────────────────────────
      // Считаем ТОЛЬКО реальные ИИ-сборки (context.source==='studio'). Раньше
      // сюда попадали и хлебные крошки 'telegram-static', которые ЖИВОЙ бот пишет
      // на КАЖДЫЙ тап кнопки при тестировании — из-за них владелец, просто листая
      // меню своего бота, за час набивал 30+ «запросов» и рейт-лимитил сам себя,
      // хотя ни одного лишнего обращения к Mistral не делал.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentCount = await Task.countDocuments({
        userId: user._id, 'context.source': 'studio',
        createdAt: { $gte: oneHourAgo },
      });
      if (recentCount >= ABUSE_THRESHOLD) {
        await sendTgMessage(chatId, '⚠️ Слишком много запросов. Подожди немного и попробуй снова.');
        return;
      }

      const profile = await UserAiConfig.findOne({ userId: user._id, profileName: { $ne: '__studio__' } });
      const integDoc = await UserIntegrations.findOne({ userId: user._id });
      const liveInstance = profile && (integDoc?.telegram || []).find(
        (i) => i.connected && String(i.profileId) === String(profile._id)
      );
      const session = getSession(chatId);

      // ── Фото-баннер: пользователь встал на нужный экран в предпросмотре и
      // прислал картинку — цепляем её баннером к текущему шагу. Источник правды —
      // схема «Баннеры» (удалить баннер = удалить запись в mini-app «База»). ──
      if (!isCallback && tgPhoto?.file_id) {
        if (!profile) {
          await sendTgMessage(chatId, 'Сначала опиши, какой бот нужен — потом сможешь добавлять баннеры к экранам 🙂');
          return;
        }
        const step = session?.previewStep;
        if (!session?.previewActive || !step) {
          await sendTgMessage(chatId, '🖼 Чтобы поставить баннер: жми «👀 Проверить», зайди на нужный экран (например /start или любую кнопку меню) и пришли картинку прямо там — я прицеплю её к этому экрану.', { keyboard: LIVE_KEYBOARD });
          return;
        }
        sendChatAction(chatId, 'upload_photo');
        const dataUrl = await downloadPhotoAsDataUrl(tgPhoto.file_id);
        if (!dataUrl) { await sendTgMessage(chatId, 'Не смог загрузить картинку 🙁 Попробуй ещё раз.'); return; }
        await setBanner(user._id, step, dataUrl);
        // Баннер КАРТОЧКИ товара (step = card:<recordId>) — перерисуем именно её,
        // с только что прицепленной картинкой (а не родительский экран).
        if (step.startsWith('card:')) {
          const pc = require('../helpers/productCard');
          const recordId = step.slice('card:'.length);
          const freshCfg = await UserAiConfig.findById(profile._id).lean();
          const cur = (freshCfg?.botSettings?.commands || []).find((c) => c.cartCurrency)?.cartCurrency || '₽';
          const sess2 = getSession(chatId) || {};
          const sel = sess2.previewCardSel && sess2.previewCardSel.recordId === recordId ? (sess2.previewCardSel.extras || []) : [];
          const card = await pc.renderCard(user._id, recordId, sel, cur);
          await sendTgMessage(chatId, '✅ Баннер прицеплён к карточке товара. Вот как она теперь выглядит 👇\n\nЧтобы заменить — пришли другую картинку, стоя на этой карточке. Чтобы убрать — удали запись в mini-app → «База» → «Баннеры».');
          if (card) {
            const toData = (rows) => rows.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data })));
            const rows = [...toData(card.keyboard), [{ text: '⬅️ К позициям', data: `tglbback:${recordId}` }]];
            await renderStep({ token: TGLETBOT_TOKEN, chatId, src: null, text: card.text, banner: card.banner || dataUrl, replyMarkup: buildInlineMarkup(rows) });
          }
          return;
        }
        const label = step === '/start' ? 'стартовый экран' : `экран «${step}»`;
        await sendTgMessage(chatId, `✅ Баннер прицеплён на ${label}. Открой его в предпросмотре — картинка уже там.\n\nЧтобы заменить — пришли другую картинку, стоя на этом экране. Чтобы убрать — удали запись в mini-app → «База» → «Баннеры».`);
        if (step === '/start') await renderPreview(chatId, profile, { withFollowup: false, isLive: !!liveInstance });
        else await resolvePreviewTap(chatId, null, profile, step, { isLive: !!liveInstance });
        return;
      }

      // ── Callback taps ────────────────────────────────────────────────────────
      if (isCallback) {
        // Владелец отмечает заказ выполненным (кнопка «✅ Заказ выполнен» из
        // уведомления о заказе — оно приходит СЮДА, в конструктор, а не в клиентский
        // бот). Помечаем заказ, гасим кнопку, благодарим клиента в живом боте.
        if (cbData.startsWith('dlvdone:')) {
          const orderId = cbData.slice('dlvdone:'.length);
          const orderRec = await UserRecord.findById(orderId).catch(() => null);
          if (!orderRec || String(orderRec.userId) !== String(user._id)) { await answerCallback(cbQuery.id, 'Заказ не найден.'); return; }
          if (/выполнен|отмен|выдан|доставлен|завершён|завершен/i.test(orderRec.data?.status || '')) { await answerCallback(cbQuery.id, `Уже: ${orderRec.data?.status}.`); return; }
          orderRec.data = { ...(orderRec.data || {}), status: 'Выполнен', _done_at: new Date() };
          orderRec.markModified('data');
          await orderRec.save().catch(() => {});
          answerCallback(cbQuery.id, '✅ Отмечено. Клиент уведомлён.');
          const mid = cbQuery.message?.message_id;
          if (mid) {
            await fetch(`${TG_API}/editMessageReplyMarkup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }) }).catch(() => {});
          }
          // Гасим ту же кнопку у админов (им уведомление ушло в живой бот).
          if (liveInstance?.token) {
            for (const m of (orderRec.data?._admin_msgs || [])) {
              if (!m?.chat || !m?.message_id) continue;
              await fetch(`https://api.telegram.org/bot${liveInstance.token}/editMessageReplyMarkup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: m.chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }) }).catch(() => {});
            }
          }
          await sendTgMessage(chatId, '✅ Заказ отмечен выполненным — клиент получил благодарность.');
          const custChat = orderRec.data?._tg_chat_id || orderRec.data?.tg_id;
          if (custChat && liveInstance?.token) {
            await fetch(`https://api.telegram.org/bot${liveInstance.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: custChat, parse_mode: 'HTML', text: toTelegramHtml('🎉 <b>Ваш заказ выполнен!</b>\n\nБлагодарим за заказ — было приятно! Будем рады видеть вас снова 💚') }) }).catch(() => {});
          }
          return;
        }
        // Проверка подписки на канал → выдача бонуса +6 дней (разово на аккаунт).
        if (cbData === 'tglb:checksub') {
          if (user.channelBonusClaimed) {
            await sendTgMessage(
              chatId,
              FREE_MODE
                ? 'У тебя уже открыт полный доступ 🙌 Всё бесплатно — просто продолжай, напиши /start.'
                : 'Бонус за подписку уже был получен на этом аккаунте 🙌 Чтобы продолжить дальше — оформи подписку.',
              FREE_MODE ? {} : { keyboard: [[{ text: '💳 Оформить подписку', data: 'tglb:showpay' }]] },
            );
            return;
          }
          const res = await grantChannelBonus(user);
          if (res.ok) {
            await sendTgMessage(chatId, FREE_MODE
              ? '🎉 Готово! Полный доступ открыт — пользуйся бесплатно. Спасибо, что подписался на @aicupdates!\n\nПродолжаем — напиши /start.'
              : `🎉 Готово! Открыли ещё +${CHANNEL_BONUS_DAYS} дней. Спасибо, что подписался на @aicupdates!\n\nПродолжаем — напиши /start.`);
          } else if (res.reason === 'not_subscribed') {
            const chanUrl = `https://telegram.me/${AICUPDATES_CHANNEL.replace('@', '')}`;
            await sendTgMessage(chatId, 'Пока не вижу тебя среди подписчиков @aicupdates 🤔 Подпишись и нажми кнопку ещё раз.', { keyboard: [[{ text: '📢 Подписаться на @aicupdates', url: chanUrl }], [{ text: '✅ Я подписался', data: 'tglb:checksub' }]] });
          } else {
            await sendPaymentOverlay(chatId, user);
          }
          return;
        }
        if (cbData === 'tglb:showpay') {
          await sendPaymentOverlay(chatId, user);
          return;
        }
        if (cbData === 'tglb:feedback') {
          await answerCallback(cbQuery.id);
          await promptFeedback(chatId);
          return;
        }
        if (cbData === 'tglb:keep') {
          clearSession(chatId);
          if (profile) await renderPreview(chatId, profile, { withFollowup: false });
          await sendTgMessage(chatId, '✏️ Напиши, что добавить или изменить — я обновлю бота.');
          return;
        }
        if (cbData === 'tglb:restart') {
          await sendTgMessage(
            chatId,
            '⚠️ Удалить бота и начать заново?\n\nВсё текущее меню, настройки и подключённый токен будут стёрты. Восстановить будет невозможно.',
            { keyboard: CONFIRM_DELETE_KEYBOARD }
          );
          return;
        }
        if (cbData === 'tglb:restart_cancel') {
          await sendTgMessage(chatId, 'Отменено — бот не тронут.', { keyboard: buildReentryKeyboard(liveInstance) });
          return;
        }
        if (cbData === 'tglb:restart_confirm') {
          // "Начать заново" means OUR data too, not just the bot's settings —
          // wipeUserBot() drops profiles, webhooks, schemas/records and sync
          // configs (external Sheets/DBs themselves are never touched).
          // Перед удалением сохраняем макет — вернуться можно из мини-аппа.
          await snapshotCurrentLayout(user, 'auto', 'Перед удалением');
          // Удаление бота = чистый лист: стираем и загруженные баннеры-картинки,
          // чтобы они НЕ подтягивались к новому боту (keepBanners:false).
          await wipeUserBot(user, { keepBanners: false });
          clearSession(chatId);
          await sendTgMessage(chatId, '🗑 Готово — старый бот, его данные и загруженные картинки-баннеры удалены (внешние таблицы и базы, если были подключены, не тронуты — отключена только синхронизация).');
          // Профиль не пере-создаём заранее: следующее же сообщение с идеей
          // лениво создаст черновик и уйдёт в сборку (см. `if (!profile)` ниже).
          // Живое приглашение — чтобы сценарий не выглядел «мёртвым».
          await sendTgMessage(chatId, NEW_BOT_INVITE);
          return;
        }
        if (cbData === 'tglb:preview') {
          if (profile) await renderPreview(chatId, profile, { isLive: !!liveInstance });
          return;
        }
        if (cbData === 'tglb:edit') {
          if (profile) await renderPreview(chatId, profile, { withFollowup: false });
          await sendTgMessage(chatId, '✏️ Напиши, что добавить или изменить — я обновлю бота.');
          return;
        }
        if (cbData === 'tglb:finish') {
          setSession(chatId, { ...session, mode: 'awaiting_token', previewActive: false });
          await sendTgMessage(chatId, TOKEN_INSTRUCTIONS, { keyboard: TOKEN_HELP_KEYBOARD });
          return;
        }
        if (cbData === 'tglb:howtoken') {
          await sendTgMessage(chatId, TOKEN_INSTRUCTIONS);
          return;
        }
        if (cbData === 'tglb:admins') {
          await showAdmins(chatId, user, profile);
          return;
        }
        if (cbData === 'tglb:notify_list') {
          await showNotifyList(chatId, user);
          return;
        }
        if (cbData === 'tglb:aisettings') {
          await showAiSettings(chatId, user, profile);
          return;
        }
        if (cbData === 'tglb:edit_sysprompt') {
          if (!profile) { await sendTgMessage(chatId, 'Сначала создай бота.'); return; }
          setSession(chatId, { ...session, mode: 'editing_sysprompt' });
          await sendTgMessage(chatId, 'Пришли новый текст системного промпта (минимум 20 символов) — заменю целиком.\n\n/cancel — отменить');
          return;
        }
        if (cbData === 'tglb:edit_restrictions') {
          if (!profile) { await sendTgMessage(chatId, 'Сначала создай бота.'); return; }
          setSession(chatId, { ...session, mode: 'editing_restrictions' });
          await sendTgMessage(chatId, 'Пришли новый текст ограничений (о чём AI не должен говорить) — заменю целиком. Пусто/«-» — очистить.\n\n/cancel — отменить');
          return;
        }
        if (cbData === 'tglb:toggle_lock') {
          if (!profile) { await sendTgMessage(chatId, 'Сначала создай бота.'); return; }
          const fresh = await UserAiConfig.findById(profile._id).select('promptEditLocked');
          fresh.promptEditLocked = !fresh.promptEditLocked;
          await fresh.save();
          await showAiSettings(chatId, user, profile);
          return;
        }
        if (cbData.startsWith('tglb:notifytest:')) {
          await testNotifyRule(chatId, user, liveInstance, cbData.slice('tglb:notifytest:'.length));
          return;
        }
        // Превью-корзина (нативные кнопки ➕/Корзина) — те же действия, что в живом боте.
        if (cbData.startsWith('tglbcart:')) {
          if (profile) await handlePreviewCart(chatId, cbQuery, profile, cbData, { isLive: !!liveInstance });
          return;
        }
        // Карточки товаров с добавками (превью) — те же tglbcard/tglbex/tglbcardadd/tglbback.
        if (cbData.startsWith('tglbcard:') || cbData.startsWith('tglbex:') || cbData.startsWith('tglbcardadd:') || cbData.startsWith('tglbback:')) {
          if (profile) await handlePreviewCard(chatId, cbQuery, profile, cbData);
          return;
        }
        // Кирпич записи (превью) — карточки услуг/мастеров + визард.
        if (/^(bksvc:|bkmst:|bkc:|bkm:|bkw:)/.test(cbData || '')) {
          if (profile) await handlePreviewBooking(chatId, cbQuery, profile, cbData);
          return;
        }
        // Not one of ours — must be a preview-button tap (plain command label)
        if (session.previewActive && profile) {
          await resolvePreviewTap(chatId, cbQuery.message?.message_id, profile, cbData, { isLive: !!liveInstance, srcIsPhoto: !!cbQuery.message?.photo });
        }
        return;
      }

      // ── Free-text messages ───────────────────────────────────────────────────
      if (!text) {
        await sendTgMessage(chatId, 'Опиши текстом, какой бот нужен 🙂');
        return;
      }

      // "/start ref_XXX" от уже существующего пользователя — обычный /start
      // (реф-привязка только для новых аккаунтов, как и на сайте).
      const isStartCmd = /^\/start(\s|$)/i.test(text);
      if (isStartCmd) {
        // /start always means "fresh start" — showStartScreen сбрасывает session,
        // так что следующее сообщение роутится с чистого DB-состояния.
        await showStartScreen(chatId, user, profile, liveInstance);
        return;
      }

      // Платформенная админ-панель метрик — только для админов платформы (PLATFORM_ADMIN_USERNAMES).
      // Для чужих ведёт себя как неизвестная команда (/start), не выдавая себя.
      if (text.toLowerCase() === '/admin') {
        if (!isPlatformAdmin(fromUser)) { await showStartScreen(chatId, user, profile, liveInstance); return; }
        sendChatAction(chatId, 'typing');
        try {
          const m = await computeAdminMetrics();
          const newFb = await BotFeedback.countDocuments({ status: 'new' }).catch(() => 0);
          await sendTgMessage(chatId, renderAdminMetrics(m), {
            keyboard: [
              [{ text: '🆕 Новые пользователи', data: 'admnew' }],
              [{ text: newFb ? `💬 Фидбек (${newFb} новых)` : '💬 Фидбек', data: 'admfb' }],
              [{ text: '👤 Посмотреть пользователя', data: 'admu:find' }],
            ],
          });
        } catch (e) {
          await sendTgMessage(chatId, 'Не удалось посчитать метрики: ' + e.message);
        }
        return;
      }

      if (text.toLowerCase() === '/data') {
        if (MINIAPP_URL) {
          await sendTgMessage(chatId, 'Здесь твои схемы и записи — как папки с файлами.', {
            keyboard: [[{ text: '📂 Открыть Мои данные', webApp: MINIAPP_URL }]],
          });
        } else {
          await sendTgMessage(chatId, 'Мини-приложение «Мои данные» сейчас недоступно.');
        }
        return;
      }

      if (text.toLowerCase() === '/feedback' || text.toLowerCase() === '/otzyv') {
        await promptFeedback(chatId);
        return;
      }

      if (text.toLowerCase() === '/menu') {
        await sendTgMessage(chatId, MENU_TEXT, { keyboard: buildMenuKeyboard() });
        return;
      }

      if (text.toLowerCase() === '/admins') {
        await showAdmins(chatId, user, profile);
        return;
      }

      if (text.toLowerCase() === '/notify') {
        await showNotifyList(chatId, user);
        return;
      }

      if (text.toLowerCase() === '/payments') {
        await showPaymentSetup(chatId, user, liveInstance);
        return;
      }

      if (text.toLowerCase() === '/aisettings') {
        await showAiSettings(chatId, user, profile);
        return;
      }

      if (text.toLowerCase() === '/cancel' && (session.mode === 'editing_sysprompt' || session.mode === 'editing_restrictions')) {
        setSession(chatId, { ...session, mode: null });
        await showAiSettings(chatId, user, profile);
        return;
      }

      if (!profile) {
        // Shouldn't normally happen (profile is created on first contact), but guard anyway.
        // Неизвестный слэш и здесь не уходит в ИИ (иначе /clear = «снеси бота»).
        if (text && text.trim().startsWith('/')) { await showStartScreen(chatId, user, profile, liveInstance); return; }
        const newProfile = await createDraftProfile(user);
        await runBuildingTurn(chatId, user, newProfile, text);
        return;
      }

      if (session.mode === 'editing_sysprompt') {
        if (text.trim().length < 20) {
          await sendTgMessage(chatId, 'Слишком коротко — минимум 20 символов. Пришли текст ещё раз, или /cancel.');
          return;
        }
        await UserAiConfig.findByIdAndUpdate(profile._id, { $set: { systemPrompt: text.trim().slice(0, 50000) } });
        setSession(chatId, { ...session, mode: null });
        await sendTgMessage(chatId, '✅ Системный промпт обновлён.');
        await showAiSettings(chatId, user, profile);
        return;
      }

      if (session.mode === 'editing_restrictions') {
        const cleared = text.trim() === '-' || text.trim() === '';
        await UserAiConfig.findByIdAndUpdate(profile._id, { $set: { restrictions: cleared ? '' : text.trim().slice(0, 10000) } });
        setSession(chatId, { ...session, mode: null });
        await sendTgMessage(chatId, cleared ? '✅ Ограничения очищены.' : '✅ Ограничения обновлены.');
        await showAiSettings(chatId, user, profile);
        return;
      }

      if (session.mode === 'reentry_choice') {
        await sendTgMessage(chatId, 'Выбери один из вариантов выше 👆', { keyboard: buildReentryKeyboard(liveInstance) });
        return;
      }

      if (session.mode === 'awaiting_token') {
        if (!text.includes(':')) {
          await sendTgMessage(chatId, 'Это не похоже на токен от @BotFather. Пришли строку вида 123456:ABC-...', { keyboard: TOKEN_HELP_KEYBOARD });
          return;
        }
        const result = await connectTelegramBot(user, text, profile._id);
        if (result.success) {
          clearSession(chatId);
          // Та же панель управления, что и на /start (Открыть бота / Мои данные /
          // Редактировать / Удалить и начать заново) — чтобы сразу после ввода
          // токена были под рукой «Редактировать» и «Удалить и начать заново».
          const launchKeyboard = buildReentryKeyboard({ botUsername: result.botUsername });
          await sendTgMessage(
            chatId,
            `🚀 Бот @${result.botUsername} запущен и работает 24/7!\n\nНапиши ему /start, чтобы проверить.\n\nКаждый день в 00:00 я присылаю тебе сюда отчёт по боту (заходы, отзывы, продажи) — отключить или изменить время можно, просто написав мне об этом.`,
            { keyboard: launchKeyboard }
          );
        } else {
          await sendTgMessage(chatId, `❌ ${result.error}\n\nПопробуй прислать токен ещё раз.`, { keyboard: TOKEN_HELP_KEYBOARD });
        }
        return;
      }

      // ЛЮБАЯ неизвестная слэш-команда (/clear, /gogogo, /reset…) — это команда, а
      // НЕ описание бота, и НИКОГДА не должна уходить в ИИ (иначе он мог «понять»
      // /clear как «очисти бота» и снести конфигурацию — реальный баг). Известные
      // команды и режимы редактирования обработаны выше; здесь ловим остальные «/»
      // и ведём себя как /start.
      if (text && text.trim().startsWith('/')) {
        await showStartScreen(chatId, user, profile, liveInstance);
        return;
      }

      if (session.pendingTaskId) {
        await sendTgMessage(chatId, '⏳ Секунду, ещё работаю над предыдущим запросом...');
        return;
      }

      await runBuildingTurn(chatId, user, profile, text, { isLive: !!liveInstance });
    });
  } catch (err) {
    console.error('TGLetBot webhook error:', err.message);
  }
});

module.exports = router;
// Отдаём наружу для движка автопродления (helpers/recurrent.js): прайс и отправка
// сообщений должны браться из ЕДИНОГО источника — цены обязаны совпадать (CLAUDE.md).
module.exports.TGLB_PLANS = TGLB_PLANS;
module.exports.tglbPlanTotal = tglbPlanTotal;
module.exports.tglbPlanKey = tglbPlanKey;
module.exports.sendTgMessage = sendTgMessage;
module.exports.sweepLiveBotsForFraud = sweepLiveBotsForFraud;
