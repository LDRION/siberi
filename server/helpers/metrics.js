// ── Метрики платформы AiConstructor (для /admin и уведомлений о подписках) ──
// ВСЁ scoped ТОЛЬКО на AiConstructor (не смешиваем с веб-Siberi):
// • пользователи — telegram-аккаунты (telegramId != null, т.е. пришли через бота-конструктор);
// • платежи/выручка — РЕАЛЬНЫЕ оплаты тарифов конструктора (paymentHistory,
//   plan ∈ tgletbot/tgpremium, amount>0) — ручные гранты (пустой paymentHistory)
//   и веб-подписки (standard/pro/premium) НЕ считаются платящими;
// • боты — подключённые telegram-инстансы.
const { htmlEscape } = require('./telegramFormat');

const AI_PLANS = ['tgletbot', 'tgpremium']; // тарифы AiConstructor
const PLAN_NAME = { tgletbot: 'Standard', tgpremium: 'Premium', standard: 'Standard', pro: 'Pro', premium: 'Premium' };
const planName = (p) => PLAN_NAME[p] || p || '—';

// Платформенные админы (МЫ) — по @username и/или числовому id.
function platformAdminUsernames() {
  return (process.env.PLATFORM_ADMIN_USERNAMES || '')
    .split(',').map((s) => s.trim().replace(/^@+/, '').toLowerCase()).filter(Boolean);
}
function platformAdminIds() {
  return (process.env.PLATFORM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function isPlatformAdmin(fromUser) {
  if (!fromUser) return false;
  const idAllow = [...platformAdminIds()];
  if (process.env.ADMIN_ALERT_CHAT_ID) idAllow.push(String(process.env.ADMIN_ALERT_CHAT_ID));
  if (fromUser.id && idAllow.includes(String(fromUser.id))) return true;
  const uname = String(fromUser.username || '').replace(/^@+/, '').toLowerCase();
  return !!uname && platformAdminUsernames().includes(uname);
}

// Числовые chat_id админов для рассылки: env + ADMIN_ALERT_CHAT_ID + резолв
// @username → telegramId по тем, кто уже писал конструктору.
async function getPlatformAdminChatIds() {
  const User = require('../models/User');
  const ids = new Set(platformAdminIds());
  if (process.env.ADMIN_ALERT_CHAT_ID) ids.add(String(process.env.ADMIN_ALERT_CHAT_ID));
  const unames = platformAdminUsernames();
  if (unames.length) {
    const admins = await User.find({ telegramUsername: { $in: unames }, telegramId: { $ne: null } })
      .select('telegramId').lean().catch(() => []);
    admins.forEach((a) => a.telegramId && ids.add(String(a.telegramId)));
  }
  return [...ids];
}

// Уведомить админов о покупке/продлении подписки AiConstructor.
async function notifyAdminsOfSubscription(user, { plan, amount = 0, months, kind = 'new' } = {}) {
  const token = process.env.TGLETBOT_TOKEN;
  if (!token) return;
  const chatIds = await getPlatformAdminChatIds();
  if (!chatIds.length) return;
  const who = user?.telegramUsername ? '@' + user.telegramUsername
    : (user?.displayName || user?.email || ('id ' + (user?.telegramId || user?._id || '?')));
  const emoji = kind === 'renewal' ? '🔁' : '🟢';
  const text = `${emoji} <b>${kind === 'renewal' ? 'Продление подписки' : 'Новая подписка'}</b>\n\n`
    + `Пользователь: ${htmlEscape(who)}\n`
    + `Тариф: ${htmlEscape(planName(plan))}\n`
    + `Сумма: <b>${Number(amount) || 0}₽</b>${months ? ` · ${months} мес` : ''}`;
  await Promise.allSettled(chatIds.map((chatId) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    }).catch(() => {})
  ));
}

// Список подключённых ботов: {username, at}, свежие сверху, максимум `limit`.
// Жив ли бот на самом деле: спрашиваем Telegram (getMe).
//  true  — работает;
//  false — токен отозван / бота удалили (Telegram явно ответил ошибкой);
//  null  — не смогли проверить (сеть/таймаут) — НЕ считаем мёртвым.
async function botAlive(token) {
  if (!token) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.status === 401 || r.status === 404) return false; // Unauthorized / бота нет
    const j = await r.json().catch(() => null);
    if (j && j.ok === true) return true;
    if (j && j.ok === false) return false;
    return null;
  } catch {
    return null; // сеть/таймаут — статус неизвестен
  }
}

// Подключённые боты + РЕАЛЬНЫЙ статус каждого. Флаг connected в базе не значит,
// что бот отвечает людям. Три состояния, которые важно различать:
//  • working — токен жив И у владельца активен доступ → бот реально работает;
//  • paused  — токен жив и вебхук стоит, но у владельца кончился доступ (триал/подписка):
//              апдейты долетают, а обработчик их молча игнорирует
//              (routes/webhooks.js: `if (!user.isAccessActive()) return`) —
//              снаружи бот выглядит мёртвым. Это и есть горячие кандидаты на оплату;
//  • dead    — токен отозван / бота удалили (Telegram отвечает ошибкой).
async function launchedBots(limit = 30) {
  const UserIntegrations = require('../models/UserIntegrations');
  const User = require('../models/User');
  const docs = await UserIntegrations.find({ telegram: { $elemMatch: { connected: true } } })
    .select('userId telegram.botUsername telegram.connected telegram.connectedAt telegram.token')
    .lean().catch(() => []);

  const bots = [];
  for (const d of docs) {
    for (const t of (d.telegram || [])) {
      if (t.connected) bots.push({ owner: d.userId, username: t.botUsername || '', at: t.connectedAt || null, token: t.token });
    }
  }
  bots.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)); // свежие сверху

  // @login создателя каждого бота — то, что реально нужно видеть в /admin
  // (по нему сразу понятно, чей это бот, и можно проверить на скам).
  const ownerIds = [...new Set(bots.map((b) => String(b.owner || '')).filter(Boolean))];
  const owners = await User.find({ _id: { $in: ownerIds } }).select('telegramUsername telegramId').lean().catch(() => []);
  // @username, а при его отсутствии — «id <tgId>», чтобы создатель был виден всегда.
  const handle = new Map(owners.map((u) => [String(u._id), u.telegramUsername ? `@${u.telegramUsername}` : (u.telegramId ? `id ${u.telegramId}` : '')]));

  // Проверяем живость параллельно; токен наружу не отдаём.
  const checked = await Promise.all(bots.map(async (b) => {
    const alive = await botAlive(b.token);
    return { username: b.username, at: b.at, owner: handle.get(String(b.owner || '')) || '', alive };
  }));

  // Статусы «на паузе» (доступ истёк — в FREE_MODE неактуально) и «не проверить»
  // убраны: бот либо работает, либо нет. Удалённые (alive===false) прячем — их
  // владелец снёс, показывать нечего. Непроверенные (alive===null, транзиентный
  // сбой getMe) оставляем, чтобы не прятать живой бот из-за сетевой заминки.
  const live = checked.filter((b) => b.alive !== false);
  return { total: live.length, list: live.slice(0, limit) };
}

// Посчитать все метрики (только AiConstructor). Под-запросы независимы.
async function computeAdminMetrics() {
  const User = require('../models/User');
  const now = Date.now();
  const D = new Date(now - 24 * 3600e3);
  const W = new Date(now - 7 * 24 * 3600e3);
  const M = new Date(now - 30 * 24 * 3600e3);
  const tgUser = { telegramId: { $ne: null } };
  // Реальный платящий за тариф конструктора (не ручной грант, не веб-подписка).
  const realPaid = { paymentHistory: { $elemMatch: { plan: { $in: AI_PLANS }, amount: { $gt: 0 } } } };
  const num = (p) => p.catch(() => 0);

  // ВАЖНО: subscriptionStatus:'trial' — это ДЕФОЛТ, он не переключается на 'expired'
  // сам по себе. Реальный конец триала считается на лету: trialStart + trialDurationDays
  // (см. User.isAccessActive). Поэтому считаем триал по ДАТЕ, а не по статусу —
  // иначе в «на триале» падают все, кто просто никогда не платил.
  const nowD = new Date();
  const trialEndExpr = { $add: ['$trialStart', { $multiply: [{ $ifNull: ['$trialDurationDays', 7] }, 86400000] }] };
  const trialBase = { ...tgUser, subscriptionStatus: 'trial', trialStart: { $ne: null } };
  const trialActiveQ = { ...trialBase, $expr: { $gt: [trialEndExpr, nowD] } };  // идёт прямо сейчас
  const trialOverQ = { ...trialBase, $expr: { $lte: [trialEndExpr, nowD] } };   // закончился, не оплатил

  const [total, newD, newW, newM, actD, actW, actM,
    trialActive, trialOver, trialOverActive, payingNow, everPaid] = await Promise.all([
    num(User.countDocuments(tgUser)),
    num(User.countDocuments({ ...tgUser, createdAt: { $gte: D } })),
    num(User.countDocuments({ ...tgUser, createdAt: { $gte: W } })),
    num(User.countDocuments({ ...tgUser, createdAt: { $gte: M } })),
    num(User.countDocuments({ ...tgUser, lastActiveAt: { $gte: D } })),
    num(User.countDocuments({ ...tgUser, lastActiveAt: { $gte: W } })),
    num(User.countDocuments({ ...tgUser, lastActiveAt: { $gte: M } })),
    num(User.countDocuments(trialActiveQ)),
    num(User.countDocuments(trialOverQ)),
    // Триал кончился, но человек продолжает пользоваться — самый горячий сегмент.
    num(User.countDocuments({ ...trialOverQ, lastActiveAt: { $gte: W } })),
    num(User.countDocuments({ ...tgUser, subscriptionStatus: 'active', subscriptionEnd: { $gt: nowD }, ...realPaid })),
    num(User.countDocuments({ ...tgUser, ...realPaid })),
  ]);
  const conversion = total > 0 ? (everPaid / total) * 100 : 0;
  // Конверсия из «прошедших триал» в платных — честнее, чем от всех регистраций.
  const convAfterTrial = (trialOver + everPaid) > 0 ? (everPaid / (trialOver + everPaid)) * 100 : 0;

  // Реальная выручка по тарифам конструктора (из paymentHistory, по paidAt).
  const revAgg = async (since) => {
    const m2 = { 'paymentHistory.plan': { $in: AI_PLANS }, 'paymentHistory.amount': { $gt: 0 } };
    if (since) m2['paymentHistory.paidAt'] = { $gte: since };
    const r = await User.aggregate([
      { $match: { ...tgUser, ...realPaid } },
      { $unwind: '$paymentHistory' },
      { $match: m2 },
      { $group: { _id: null, sum: { $sum: '$paymentHistory.amount' }, n: { $sum: 1 } } },
    ]).catch(() => []);
    return { sum: r[0]?.sum || 0, n: r[0]?.n || 0 };
  };
  const [revD, revW, revM, revAll] = await Promise.all([revAgg(D), revAgg(W), revAgg(M), revAgg(null)]);

  const bots = await launchedBots(30);

  return {
    total, newD, newW, newM, actD, actW, actM,
    botsCount: bots.total, botsList: bots.list,
    trialActive, trialOver, trialOverActive, payingNow, everPaid, conversion, convAfterTrial,
    revD, revW, revM, revAll,
    gateway: await gatewayHealth(),
  };
}

// Собрать текст /admin (HTML для Telegram).
function renderAdminMetrics(m) {
  const money = (n) => `${Math.round(n).toLocaleString('ru-RU')}₽`;
  const lines = [
    '📊 <b>Метрики AiConstructor</b>',
    '',
    '<b>Пользователи</b>',
    `• Всего: <b>${m.total}</b>`,
    `• Новые: ${m.newD} за день · ${m.newW} за неделю · ${m.newM} за месяц`,
    `• Активные: ${m.actD} за день · ${m.actW} за неделю · ${m.actM} за месяц`,
    '',
    '<b>Воронка</b>',
    `• Бесплатный период идёт: <b>${m.trialActive}</b>`,
    `• Бесплатный закончился: ${m.trialOver}${m.trialOverActive ? ` · из них ещё пользуются: <b>${m.trialOverActive}</b>` : ''}`,
    `• Платящих сейчас: <b>${m.payingNow}</b> · платили когда-либо: ${m.everPaid}`,
    '',
    '<b>Конверсия</b>',
    `• Из всех регистраций: <b>${m.conversion.toFixed(1)}%</b>`,
    `• Из прошедших триал: <b>${m.convAfterTrial.toFixed(1)}%</b>`,
    '',
    '<b>Выручка</b>',
    `• День: ${money(m.revD.sum)} (${m.revD.n}) · Неделя: ${money(m.revW.sum)} (${m.revW.n})`,
    `• Месяц: ${money(m.revM.sum)} (${m.revM.n}) · Всего: <b>${money(m.revAll.sum)}</b> (${m.revAll.n})`,
    '',
    `<b>Боты: ${m.botsCount} работают</b>`,
  ];
  if (m.botsList && m.botsList.length) {
    // Формат: Бот — @создатель — дата запуска (по просьбе владельца).
    for (const b of m.botsList) {
      const when = b.at ? new Date(b.at).toLocaleDateString('ru-RU') : '';
      const creator = b.owner ? htmlEscape(b.owner) : '—'; // уже с «@» или «id»
      lines.push(`• @${htmlEscape(b.username || '—')} — ${creator}${when ? ` — ${when}` : ''}`);
    }
    if (m.botsCount > m.botsList.length) lines.push(`…и ещё ${m.botsCount - m.botsList.length}`);
  } else {
    lines.push('<i>пока ни одного</i>');
  }

  return lines.join('\n');
}

// Состояние браузерного шлюза. В /admin НЕ выводится намеренно: это техническая
// телеметрия, а не бизнес-метрика — владельцу в боте она только мешает. Смотреть
// из терминала: `node scripts/gateway-health.js` (см. там же пороги).
// Всё best-effort: при недоступном CDP просто вернём, что смогли.
async function gatewayHealth() {
  const out = { tabs: null, deadTabs: 0, edgeMb: null, freeMb: null };
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined;
    const list = await fetch('http://127.0.0.1:9223/json/list', { signal: ctl }).then((r) => r.json());
    const pages = (list || []).filter((p) => p.type === 'page');
    out.tabs = pages.length;
    out.deadTabs = pages.filter((p) => /cloudflare\.com|challenges\.cloudflare|\/error-\d{3,}/i.test(p.url || '')).length;
  } catch { /* CDP недоступен — не наша забота здесь */ }
  try {
    const { execSync } = require('child_process');
    const rss = execSync("ps -eo rss,comm | grep -i msedge | awk '{s+=$1} END {print int(s/1024)}'", { timeout: 4000 }).toString().trim();
    out.edgeMb = parseInt(rss, 10) || null;
    const free = execSync("free -m | awk '/^Mem:/{print $7}'", { timeout: 4000 }).toString().trim();
    out.freeMb = parseInt(free, 10) || null; // available, а не free — реальный запас
  } catch {}
  return out;
}

// ── Новые пользователи: кто на каком шаге воронки застрял ───────────────────
// Нужно, чтобы догонять обратной связью тех, кто зашёл в бота и НЕ попробовал
// собрать своего.
//
// Чем меряем «пробовал»: Task — задача генерации. Она создаётся только когда
// человек реально попросил ИИ что-то собрать (routes/tgletbot.js).
// ВАЖНО, почему не иначе: профиль UserAiConfig автосоздаётся при первом входе
// («Мой бот»), а поля totalRequests/lastUsed в коде НИГДЕ не инкрементятся —
// по ним судить нельзя, они всегда нулевые.
const STAGE = {
  idle:     { icon: '⚪️', label: 'только зашёл' },
  tried:    { icon: '🟡', label: 'собирал бота' },
  launched: { icon: '🟢', label: 'запустил' },
};

function fmtAgo(d) {
  if (!d) return '—';
  const h = Math.round((Date.now() - new Date(d)) / 3600e3);
  if (h < 1) return 'только что';
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

const userLabel = (u) => (u.telegramUsername ? '@' + u.telegramUsername : (u.firstName || `id${u.telegramId}`));

async function newUsers(days = 7, limit = 15) {
  const User = require('../models/User');
  const Task = require('../models/Task');
  const UserIntegrations = require('../models/UserIntegrations');
  const since = new Date(Date.now() - days * 86400e3);

  const users = await User.find({ telegramId: { $ne: null }, createdAt: { $gte: since } })
    .sort({ createdAt: -1 }).limit(limit)
    .select('telegramId telegramUsername firstName createdAt lastActiveAt')
    .lean().catch(() => []);
  if (!users.length) return [];

  const ids = users.map((u) => u._id);
  const [tasks, ints] = await Promise.all([
    Task.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]).catch(() => []),
    UserIntegrations.find({ userId: { $in: ids }, telegram: { $elemMatch: { connected: true } } })
      .select('userId telegram.botUsername telegram.connected').lean().catch(() => []),
  ]);
  const taskBy = new Map(tasks.map((t) => [String(t._id), t.n]));
  const botBy = new Map();
  for (const i of ints) {
    const b = (i.telegram || []).find((t) => t.connected);
    if (b) botBy.set(String(i.userId), b.botUsername || '');
  }

  return users.map((u) => {
    const id = String(u._id);
    const tries = taskBy.get(id) || 0;
    const bot = botBy.get(id) || null;
    return { ...u, tries, bot, stage: bot ? 'launched' : (tries > 0 ? 'tried' : 'idle') };
  });
}

function renderNewUsers(list, days = 7) {
  if (!list.length) return `🆕 <b>Новых пользователей за ${days} дн. нет</b>`;
  const idle = list.filter((u) => u.stage === 'idle').length;
  const lines = [`🆕 <b>Новые пользователи</b> · за ${days} дн.: <b>${list.length}</b>`, ''];
  for (const u of list) {
    const s = STAGE[u.stage];
    const reg = new Date(u.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    lines.push(`${s.icon} <b>${htmlEscape(userLabel(u))}</b> — ${reg} · ${s.label}${u.bot ? ` @${htmlEscape(u.bot)}` : ''}`);
    lines.push(`   промтов к ИИ: ${u.tries} · был: ${fmtAgo(u.lastActiveAt)}`);
  }
  if (idle) lines.push('', `⚪️ <b>${idle}</b> зашли и ни разу не попросили ИИ собрать бота — вот кому писать.`);
  lines.push('', '👆 Нажми на пользователя, чтобы открыть карточку.');
  return lines.join('\n');
}

// Кнопки: тап по пользователю открывает его карточку (admu:view уже есть).
function newUsersKeyboard(list) {
  return list.slice(0, 12).map((u) => [{
    text: `${STAGE[u.stage].icon} ${userLabel(u)}`,
    data: `admu:view:${u._id}`,
  }]);
}

// ── Админ-консоль: карточка пользователя + действия ─────────────────────────

// Является ли САМ пользователь (запись User) платформенным админом — чтобы не
// дать заблокировать своего же.
function isPlatformAdminUser(user) {
  return isPlatformAdmin({ id: user?.telegramId, username: user?.telegramUsername });
}

// Поиск пользователя по @username (как в Telegram) или числовому Telegram ID.
async function findUserByHandle(handle) {
  const User = require('../models/User');
  const h = String(handle || '').trim().replace(/^@+/, '');
  if (!h) return null;
  if (/^\d+$/.test(h)) {
    const byId = await User.findOne({ telegramId: h }).catch(() => null);
    if (byId) return byId;
  }
  const rx = new RegExp('^' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return User.findOne({ telegramUsername: rx }).catch(() => null);
}

// Подключённые боты пользователя.
async function userBots(userId) {
  const UserIntegrations = require('../models/UserIntegrations');
  const doc = await UserIntegrations.findOne({ userId }).select('telegram').lean().catch(() => null);
  return (doc?.telegram || []).map((t) => ({ username: t.botUsername || '', connected: !!t.connected }));
}

function subscriptionLine(user) {
  const now = new Date();
  const dfmt = (d) => new Date(d).toLocaleDateString('ru-RU');
  if (user.subscriptionStatus === 'active' && user.subscriptionEnd) {
    const days = Math.ceil((new Date(user.subscriptionEnd) - now) / 86400e3);
    return `🟢 активна (${planName(user.plan)}) — до ${dfmt(user.subscriptionEnd)}${days > 0 ? ` · ещё ${days} дн.` : ' · истекла'}`;
  }
  if (user.subscriptionStatus === 'trial' && user.trialStart) {
    const tEnd = new Date(new Date(user.trialStart).getTime() + (user.trialDurationDays || 7) * 86400e3);
    const days = Math.ceil((tEnd - now) / 86400e3);
    return `⏳ триал — до ${dfmt(tEnd)}${days > 0 ? ` · ещё ${days} дн.` : ' · истёк'}`;
  }
  return `🔴 ${user.subscriptionStatus || 'нет'}`;
}

// Карточка пользователя (текст + inline-клавиатура действий, формат tgletbot: data).
async function renderUserCard(user) {
  const bots = await userBots(user._id);
  const uid = String(user._id);
  const active = typeof user.isAccessActive === 'function' ? user.isAccessActive() : false;
  const blocked = typeof user.isBlocked === 'function' ? user.isBlocked() : !!user.blocked?.isBlocked;
  const uname = user.telegramUsername ? '@' + user.telegramUsername : '—';
  const lines = [
    '👤 <b>Пользователь</b>',
    `Имя: ${htmlEscape(user.displayName || '—')}`,
    `Ник: ${htmlEscape(uname)}`,
    `Telegram ID: <code>${htmlEscape(String(user.telegramId || '—'))}</code>`,
    `Регистрация: ${user.createdAt ? new Date(user.createdAt).toLocaleDateString('ru-RU') : '—'}`,
    `Активность: ${user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString('ru-RU') : '—'}`,
    '',
    `Доступ: ${active ? '🟢 активен' : '🔴 нет'}`,
    `Подписка: ${subscriptionLine(user)}`,
    `Блокировка: ${blocked ? '⛔ ЗАБЛОКИРОВАН' + (user.blocked?.reason ? ` (${htmlEscape(user.blocked.reason)})` : '') : '— нет'}`,
    '',
    `<b>Боты (${bots.length}):</b>`,
  ];
  if (bots.length) for (const b of bots) lines.push(`• @${htmlEscape(b.username || '—')} — ${b.connected ? '🟢 работает' : '⚪️ выключен'}`);
  else lines.push('<i>нет</i>');

  const keyboard = [
    [{ text: '💳 Доступ +30 дн.', data: `admu:grant:30:${uid}` }, { text: '♾ Навсегда', data: `admu:grant:3650:${uid}` }],
    [{ text: '🚫 Снять доступ', data: `admu:revoke:${uid}` }],
    blocked
      ? [{ text: '✅ Разблокировать', data: `admu:unblock:${uid}` }]
      : [{ text: '⛔ Заблокировать', data: `admu:block:${uid}` }],
    [{ text: '🔄 Обновить', data: `admu:view:${uid}` }],
  ];
  return { text: lines.join('\n'), keyboard };
}

// Выдать доступ на N дней (ручной грант: активная подписка БЕЗ записи в
// paymentHistory — чтобы не искажать метрики выручки). Продлевает от текущей даты
// окончания, если она в будущем.
async function grantAccess(user, days) {
  const now = Date.now();
  const base = (user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date()) ? new Date(user.subscriptionEnd).getTime() : now;
  user.subscriptionStatus = 'active';
  user.subscriptionEnd = new Date(base + (Number(days) || 30) * 86400e3);
  if (!['tgletbot', 'tgpremium'].includes(user.plan)) user.plan = 'tgletbot';
  await user.save().catch(() => {});
  return user;
}

async function revokeAccess(user) {
  user.subscriptionStatus = 'expired';
  user.subscriptionEnd = new Date(Date.now() - 1000);
  await user.save().catch(() => {});
  return user;
}

async function blockUser(user, reason = '') {
  user.blocked = { ...(user.blocked?.toObject ? user.blocked.toObject() : user.blocked || {}), isBlocked: true, reason, blockedAt: new Date(), blockedUntil: null };
  user.markModified('blocked');
  await user.save().catch(() => {});
  return user;
}

async function unblockUser(user) {
  user.blocked = { ...(user.blocked?.toObject ? user.blocked.toObject() : user.blocked || {}), isBlocked: false, blockedUntil: null };
  user.markModified('blocked');
  await user.save().catch(() => {});
  return user;
}

module.exports = {
  isPlatformAdmin, isPlatformAdminUser, getPlatformAdminChatIds,
  notifyAdminsOfSubscription, computeAdminMetrics, renderAdminMetrics, planName,
  findUserByHandle, userBots, renderUserCard, grantAccess, revokeAccess, blockUser, unblockUser,
  newUsers, renderNewUsers, newUsersKeyboard,
};
