'use strict';
/**
 * Notification Processor
 * Runs every 60 seconds, checks NotificationRules, fires AI tasks, sends Telegram messages.
 */

const { v4: uuidv4 } = require('uuid');
const NotificationRule  = require('./models/NotificationRule');
const UserRecord        = require('./models/UserRecord');
const UserIntegrations  = require('./models/UserIntegrations');
const Task              = require('./models/Task');
const UserAiConfig      = require('./models/UserAiConfig');
const User              = require('./models/User');
const UserSchema        = require('./models/UserSchema');
const { toTelegramHtml } = require('./helpers/telegramFormat');

const INTERVAL_MS = 60 * 1000; // check every 60s
let processorTimer = null;
let _ticking = false; // защита от НАЛОЖЕНИЯ тиков (setInterval не ждёт прошлый тик)

// ── Серийная очередь уведомлений/отчётов ────────────────────────────────────
// Раньше tick() дёргал fireAiNotification НАПРЯМУЮ и ЖДАЛ ответ AI (pollTask до
// 90с) внутри цикла → при отчётах для всех ботов в 23:50 тик висел, а
// setInterval порождал НАЛОЖЕННЫЕ тики → отчёты уходили ПАЧКОЙ и забивали AI
// (Qwen «страница не отвечает»). Теперь tick только КЛАДЁТ задание в очередь и
// сразу возвращается; дренаж идёт ОДИН ЗА ОДНИМ в фоне, без спешки. Приоритет
// живого AI над отчётами обеспечивает воркер (NOTIF_MAX, см. AiService).
const notifQueue = [];
let _draining = false;
let _notifGapMs = 1500; // пауза между заданиями — не частим (в тестах уменьшаем)
let _sender = null;     // тест-сеам: подмена реальной отправки fireAiNotification

function enqueueNotification(rule, chatId, prompt) {
  notifQueue.push({ rule, chatId, prompt });
  drainNotifications();
}

async function drainNotifications() {
  if (_draining) return;   // строго ОДНО задание за раз (серийно)
  _draining = true;
  try {
    while (notifQueue.length) {
      const { rule, chatId, prompt } = notifQueue.shift();
      const send = _sender || fireAiNotification;
      try { await send(rule, chatId, prompt); }
      catch (err) { console.error(`❌ [Notif] drain "${rule?.name}":`, err.message); }
      if (notifQueue.length) await new Promise((r) => setTimeout(r, _notifGapMs));
    }
  } finally { _draining = false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEventDatetime(record, dateField, timeField) {
  const raw = record.data?.[dateField];
  if (!raw) return null;

  let d;
  if (raw instanceof Date) {
    d = new Date(raw);
  } else if (typeof raw === 'string') {
    // try ISO first
    d = new Date(raw);
    if (isNaN(d.getTime())) {
      // try DD.MM.YYYY
      const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (m) d = new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
    }
  } else {
    return null;
  }
  if (!d || isNaN(d.getTime())) return null;

  // Add time component if available
  const timeRaw = timeField && record.data?.[timeField];
  if (timeRaw && typeof timeRaw === 'string') {
    const tm = timeRaw.match(/(\d{1,2}):(\d{2})/);
    if (tm) {
      d.setHours(parseInt(tm[1], 10), parseInt(tm[2], 10), 0, 0);
    }
  }
  return d;
}

function buildPrompt(rule, records, singleRecord = null) {
  const schemaInfo = `Схема данных: "${rule.schemaName}"`;
  let dataBlock;

  if (singleRecord) {
    dataBlock = `Запись:\n${JSON.stringify(singleRecord.data, null, 2)}`;
  } else {
    dataBlock = `Записей: ${records.length}\n` +
      records.slice(0, 20).map((r, i) => `${i + 1}. ${JSON.stringify(r.data)}`).join('\n');
  }

  return `[КОНТЕКСТ УВЕДОМЛЕНИЯ]\n${schemaInfo}\n${dataBlock}\n\n[ЗАДАЧА]\n${rule.messagePrompt || 'Сформируй краткое уведомление на основе данных выше.'}`;
}

// ── Daily-report deterministic stats (funnel, users, revenue, reviews) ────────
// Computed server-side so the LLM never has to do arithmetic — it only narrates
// numbers we hand it (mirrors the CHART_DATA precedent: don't trust the model
// with sums it can get wrong). Each sub-query is independently guarded — one
// missing schema/empty collection must never break the whole report.
async function computeDailyStats(rule, startOfDay) {
  const stats = {};

  // Top-of-funnel: distinct people who messaged the bot today (free-text + static taps)
  try {
    const activeIds = await Task.distinct('endUser.platformUserId', {
      profileId: rule.profileId,
      'endUser.platform': 'telegram',
      createdAt: { $gte: startOfDay },
    });
    stats.activeToday = activeIds.length;
  } catch { stats.activeToday = null; }

  // Funnel steps (catalog/pricing) — distinct people who hit a tagged button today
  for (const step of ['catalog', 'pricing']) {
    try {
      const ids = await Task.distinct('endUser.platformUserId', {
        profileId: rule.profileId,
        'endUser.platform': 'telegram',
        'context.funnelStep': step,
        createdAt: { $gte: startOfDay },
      });
      stats[`step_${step}`] = ids.length;
    } catch { stats[`step_${step}`] = null; }
  }

  // Purchases: rule.schemaName if set, else 'payments' (the one schema with a
  // stable, known shape) — never guess a random schema. _tg_chat_id is stored
  // inconsistently as either a string or a number depending on when/how a
  // record was created (confirmed live on real data) — $toString normalizes
  // before grouping so the same chat isn't double-counted as two buyers.
  try {
    const purchaseSchema = rule.schemaName || 'payments';
    const buyerIds = await UserRecord.aggregate([
      { $match: { userId: rule.userId, schemaName: purchaseSchema, createdAt: { $gte: startOfDay }, 'data._tg_chat_id': { $ne: null } } },
      { $group: { _id: { $toString: '$data._tg_chat_id' } } },
    ]);
    if (buyerIds.length > 0) {
      stats.purchasesToday = buyerIds.length;
      stats.purchaseSchema = purchaseSchema;
    }
  } catch {}

  // User dynamics: total ever seen, new today vs returning — one aggregate, no
  // second query for "total" (classify from the same firstSeen-per-user result).
  try {
    const byUser = await Task.aggregate([
      { $match: { profileId: rule.profileId, 'endUser.platform': 'telegram' } },
      { $group: { _id: '$endUser.platformUserId', firstSeen: { $min: '$createdAt' } } },
    ]);
    stats.totalUsersEver = byUser.length;
    stats.newToday = byUser.filter(u => u.firstSeen >= startOfDay).length;
  } catch { stats.totalUsersEver = null; stats.newToday = null; }

  // Repeat purchases — only meaningful if a purchase schema actually resolved above
  if (stats.purchaseSchema) {
    try {
      const byBuyer = await UserRecord.aggregate([
        { $match: { userId: rule.userId, schemaName: stats.purchaseSchema, 'data._tg_chat_id': { $ne: null } } },
        { $group: { _id: { $toString: '$data._tg_chat_id' }, count: { $sum: 1 } } },
      ]);
      stats.repeatBuyers = byBuyer.filter(b => b.count >= 2).length;
      stats.totalBuyers = byBuyer.length;
    } catch {}
  }

  // Revenue — 'payments' schema only in v1 (stable, known `amount` field; an
  // arbitrary AI-defined schema has no convention for which field is "the price",
  // and guessing wrong would reintroduce the exact hallucinated-math bug this fixes)
  try {
    const paymentsToday = await UserRecord.find({
      userId: rule.userId, schemaName: 'payments', createdAt: { $gte: startOfDay },
    }).select('data.amount').lean();
    if (paymentsToday.length > 0) {
      stats.revenueToday = paymentsToday.reduce((sum, r) => sum + (Number(r.data?.amount) || 0), 0);
      stats.paymentsCount = paymentsToday.length;
    }
  } catch {}

  // Reviews — only mention the line if the schema actually exists for this bot
  try {
    const reviewsSchema = await UserSchema.findOne({ userId: rule.userId, name: 'reviews' }).select('_id').lean();
    if (reviewsSchema) {
      stats.reviewsToday = await UserRecord.countDocuments({
        userId: rule.userId, schemaName: 'reviews', createdAt: { $gte: startOfDay },
      });
    }
  } catch {}

  return stats;
}

// Renders the [ТОЧНЫЕ ДАННЫЕ] block + task instructions for daily_report rules
// specifically — buildPrompt() (below) stays the generic one used by every
// other trigger type.
function buildDailyReportPrompt(rule, records, stats) {
  const lines = [];
  if (stats.activeToday != null) {
    lines.push(`Зашли в бот сегодня: ${stats.activeToday} чел.`);
    if (stats.step_catalog != null) {
      lines.push(`  Просмотрели каталог: ${stats.step_catalog} (отвал ${Math.max(0, stats.activeToday - stats.step_catalog)} на этом шаге)`);
    }
    if (stats.step_pricing != null) {
      lines.push(`  Просмотрели цены: ${stats.step_pricing} (отвал ${Math.max(0, stats.activeToday - stats.step_pricing)} на этом шаге)`);
    }
    if (stats.purchasesToday != null) lines.push(`  Купили: ${stats.purchasesToday}`);
  }
  if (stats.totalUsersEver != null) {
    lines.push(`Пользователей всего за всё время: ${stats.totalUsersEver}`);
    lines.push(`Новых сегодня: ${stats.newToday ?? 0}`);
  }
  if (stats.totalBuyers > 0) {
    lines.push(`Повторных покупателей (2+ покупки): ${stats.repeatBuyers} из ${stats.totalBuyers} покупателей`);
  }
  if (stats.revenueToday != null) {
    lines.push(`Выручка (схема "payments") сегодня: ${stats.revenueToday}₽ (${stats.paymentsCount} платежей)`);
  }
  if (stats.reviewsToday != null) {
    lines.push(`Новых отзывов сегодня: ${stats.reviewsToday}`);
  }

  const statsBlock = lines.length > 0
    ? `[ТОЧНЫЕ ДАННЫЕ — ИСПОЛЬЗУЙ КАК ЕСТЬ, НЕ ПЕРЕСЧИТЫВАЙ И НЕ СКЛАДЫВАЙ САМ]\n${lines.join('\n')}\n[/ТОЧНЫЕ ДАННЫЕ]\n\n`
    : '';

  const schemaInfo = rule.schemaName ? `Схема данных: "${rule.schemaName}"` : '';
  const dataBlock = `Записей за сегодня в этой схеме: ${records.length}\n` +
    records.slice(0, 20).map((r, i) => `${i + 1}. ${JSON.stringify(r.data)}`).join('\n');

  const task = rule.messagePrompt ||
    'Дай маркетинговый отчёт по разделам: воронка, динамика пользователей, отзывы, выручка. Используй ТОЛЬКО числа из блока [ТОЧНЫЕ ДАННЫЕ] выше — не выдумывай и не пересчитывай их сам. Отметь, на каком шаге воронки больше всего отвала, и дай 1-2 практичные рекомендации. Построй CHART_DATA по воронке (зашли/просмотрели/купили).\n\nФОРМАТ: каждый раздел начинай с <b>Заголовка:</b> на ОТДЕЛЬНОЙ строке, перед каждым новым разделом — пустая строка. Не пиши заголовок и первый пункт списка слитно в одну строку.';

  return `${statsBlock}[КОНТЕКСТ УВЕДОМЛЕНИЯ]\n${schemaInfo}\n${dataBlock}\n\n[ЗАДАЧА]\n${task}`;
}

// ── Creator resolution for auto-provisioned default rules ─────────────────────
// user.telegramId is reliable & user-level (every TGLetBot-originated account
// has it set, no extra registration needed). UserAdmin{role:'creator'} is a
// second-choice fallback for website customers who registered themselves as
// creator inside their own bot — NOTE UserAdmin has no profileId, so this is a
// known, accepted ambiguity across a user's multiple bots; only consulted when
// telegramId is absent.
async function resolveDefaultCreatorChatId(user, profileId) {
  if (user?.telegramId) return String(user.telegramId);
  try {
    const UserAdmin = require('./models/UserAdmin');
    const admin = await UserAdmin.findOne({ ownerId: user._id, role: 'creator', platform: 'telegram' }).lean();
    if (admin?.platformUserId && /^-?\d+$/.test(admin.platformUserId)) return admin.platformUserId;
  } catch {}
  return null;
}

const ACTION_LABELS = {
  create:        'Создание записи',
  update:        'Изменение записи',
  delete:        'Удаление записи',
  create_schema: 'Создание новой схемы данных',
};

function buildPromptForEvent(rule, action, schemaName, records) {
  const actionLabel = ACTION_LABELS[action] || action;
  const schemaInfo  = schemaName ? `Схема: "${schemaName}"` : '';
  let dataBlock = '';
  if (Array.isArray(records) && records.length > 0) {
    dataBlock = records.length === 1
      ? `Данные:\n${JSON.stringify(records[0].data ?? records[0], null, 2)}`
      : `Записей: ${records.length}\n` + records.slice(0, 10).map((r, i) => `${i + 1}. ${JSON.stringify(r.data ?? r)}`).join('\n');
  }
  return `[КОНТЕКСТ УВЕДОМЛЕНИЯ]\nСобытие: ${actionLabel}\n${schemaInfo}\n${dataBlock}\n\n[ЗАДАЧА]\n${rule.messagePrompt || 'Сформируй краткое уведомление о произошедшем изменении.'}`;
}

// Event-driven: вызывается напрямую из executeDBCommand при каждом изменении данных
async function triggerEventRules(userId, action, schemaName, records, callerProfileId) {
  try {
    const eventTypes = {
      create:        ['record_created', 'any_change'],
      update:        ['record_updated', 'any_change'],
      delete:        ['record_deleted', 'any_change'],
      create_schema: ['schema_created', 'any_change'],
    };
    const types = eventTypes[action];
    if (!types) return;

    const orSchema = schemaName
      ? [{ schemaName: '' }, { schemaName: null }, { schemaName: schemaName }]
      : [{ schemaName: '' }, { schemaName: null }];

    const rules = await NotificationRule.find({
      userId,
      enabled: true,
      triggerType: { $in: types },
      $or: orSchema,
    }).lean();

    if (!rules.length) return;

    const user = await User.findById(userId).select('subscriptionStatus subscriptionEnd trialStart');
    if (!user?.isAccessActive?.()) return;

    const recArr = Array.isArray(records) ? records : (records ? [records] : []);

    for (const rule of rules) {
      try {
        const ruleProfileId = rule.profileId || callerProfileId;
        const rawList = rule.recipients?.length
          ? rule.recipients
          : (rule.recipientChatId ? [rule.recipientChatId] : []);
        if (!rawList.length) continue;

        const prompt = buildPromptForEvent(rule, action, schemaName, recArr);
        for (const raw of rawList) {
          const chatId = await resolveChatId(String(userId), ruleProfileId, raw);
          if (chatId) {
            await fireAiNotification(rule, chatId, prompt);
            console.log(`✅ [Notif] ${action}/${schemaName || 'schema'} → chat ${chatId} (правило "${rule.name}")`);
          }
        }
      } catch (ruleErr) {
        console.error(`❌ [Notif] triggerEventRules правило "${rule.name}":`, ruleErr.message);
      }
    }
  } catch (err) {
    console.error('❌ [Notif] triggerEventRules:', err.message);
  }
}

async function pollTask(taskId, userId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    // attachments included — a notification built from a "построй график"-style
    // messagePrompt (analytics/daily reports) can come back with a chart image
    // (Mistral renders it as a canvas, the AI pipeline screenshots it into
    // task.attachments same as any normal chat reply). Used to be silently
    // dropped here since only result/status/error were ever selected.
    const t = await Task.findOne({ taskId, userId }).select('status result error attachments').lean();
    if (!t) return null;
    if (t.status === 'completed' && t.result) return { text: t.result, attachments: t.attachments || [] };
    if (t.status === 'error') return null;
  }
  return null;
}

async function sendTelegramMsg(token, chatId, text) {
  if (!token || !chatId || !text) return false;
  // Нормализуем ответ ИИ в безопасный HTML (Markdown-звёздочки **жирный** → <b>,
  // `код` → <code> и т.п.) — иначе отчёт «Воронка продаж» показывал буквальные
  // «**Рекомендации:**». Как во всех прочих исходящих (см. helpers/telegramFormat).
  const html = toTelegramHtml(String(text)).slice(0, 4096);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
  }).catch(() => null);

  if (r?.ok) return true;
  // На ошибке разбора HTML — откат в обычный текст оригинала.
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4096) }),
  }).catch(() => {});
  return false;
}

async function sendTelegramPhoto(token, chatId, dataUrl, caption) {
  if (!token || !chatId || !dataUrl) return false;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', toTelegramHtml(String(caption)).slice(0, 1024));
      form.append('parse_mode', 'HTML');
    }
    if (dataUrl.startsWith('http')) {
      form.append('photo', dataUrl);
    } else {
      const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const mimeMatch = dataUrl.match(/^data:(image\/[^;]+);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png';
      form.append('photo', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `chart.${ext}`);
    }
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form }).catch(() => null);
    return !!r?.ok;
  } catch {
    return false;
  }
}

async function getBotInstance(userId, profileId) {
  const integDoc = await UserIntegrations.findOne({ userId }).lean();
  if (!integDoc?.telegram?.length) return null;
  return integDoc.telegram.find(t =>
    t.connected && t.token &&
    t.profileId?.toString() === profileId?.toString()
  ) || null;
}

async function getBotToken(userId, profileId) {
  const inst = await getBotInstance(userId, profileId);
  return inst?.token || null;
}

async function resolveChatId(userId, profileId, rawChatId) {
  if (!rawChatId) return null;
  const s = String(rawChatId).trim();
  // Already numeric
  if (/^-?\d+$/.test(s)) return s;

  const usernameClean = s.replace(/^@/, '').toLowerCase();
  const inst = await getBotInstance(userId, profileId);
  if (!inst) return null;

  // 1. Check knownContacts cache
  const found = (inst.knownContacts || []).find(c => c.username?.toLowerCase() === usernameClean);
  if (found?.chatId) return found.chatId;

  // 2. Fallback: ask Telegram API to resolve @username → numeric id
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${inst.token}/getChat?chat_id=${encodeURIComponent('@' + usernameClean)}`
    ).catch(() => null);
    if (r?.ok) {
      const data = await r.json();
      if (data.ok && data.result?.id) {
        const chatId = String(data.result.id);
        console.log(`[Notif] Resolved @${usernameClean} → ${chatId} via Telegram API`);
        // Cache for future lookups
        setImmediate(async () => {
          try {
            const UserIntegrations = require('./models/UserIntegrations');
            const doc = await UserIntegrations.findOne({ userId });
            const botInst = doc?.telegram?.find(t => t.token === inst.token);
            if (!botInst) return;
            const entry = { chatId, username: usernameClean, displayName: data.result.first_name || usernameClean, lastSeen: new Date() };
            const idx = botInst.knownContacts.findIndex(c => c.chatId === chatId);
            if (idx >= 0) Object.assign(botInst.knownContacts[idx], entry);
            else { botInst.knownContacts.unshift(entry); if (botInst.knownContacts.length > 200) botInst.knownContacts.pop(); }
            doc.markModified('telegram');
            await doc.save();
          } catch {}
        });
        return chatId;
      }
    }
  } catch {}

  // 3. Fallback: look up UserAdmin records (owner/admins who registered with the bot)
  try {
    const UserAdmin = require('./models/UserAdmin');
    const admin = await UserAdmin.findOne({
      ownerId: userId,
      platform: 'telegram',
      $or: [
        { platformUserId: '@' + usernameClean },
        { platformUserId: usernameClean },
      ],
    }).lean();
    if (admin?.platformUserId && /^-?\d+$/.test(admin.platformUserId)) {
      console.log(`[Notif] Resolved @${usernameClean} → ${admin.platformUserId} via UserAdmin`);
      return admin.platformUserId;
    }
    // Also check Task history — user may have messaged the bot
    const Task = require('./models/Task');
    const task = await Task.findOne({
      userId,
      'endUser.platform': 'telegram',
      'endUser.username': { $regex: new RegExp('^' + usernameClean + '$', 'i') },
    }).select('endUser').lean();
    if (task?.endUser?.platformUserId && /^-?\d+$/.test(task.endUser.platformUserId)) {
      console.log(`[Notif] Resolved @${usernameClean} → ${task.endUser.platformUserId} via Task history`);
      return task.endUser.platformUserId;
    }
  } catch {}

  console.warn(`[Notif] Не удалось разрешить @${usernameClean} — пользователь не найден ни в одном источнике`);
  return null;
}

async function fireAiNotification(rule, chatId, prompt) {
  // Find the AI profile config
  const profile = await UserAiConfig.findById(rule.profileId).lean();
  if (!profile) return;

  const task = new Task({
    taskId: uuidv4(),
    userId: rule.userId,
    prompt,
    rawPrompt: rule.messagePrompt || 'Уведомление',
    context: { source: 'notification', ruleId: rule._id.toString() },
    profileId: rule.profileId,
    status: 'pending',
    endUser: {
      platform: 'telegram',
      platformUserId: String(chatId),
      displayName: 'Notification',
    },
  });
  await task.save();

  const result = await pollTask(task.taskId, rule.userId);
  if (!result) return;

  const token = await getBotToken(rule.userId, rule.profileId);
  if (!token) return;

  const attachments = (result.attachments || []).slice(0, 5);
  if (attachments.length > 0) {
    // First image carries the text as a caption (e.g. a chart + its summary for
    // a daily_report/analytics rule); any extra images follow without caption.
    await sendTelegramPhoto(token, chatId, attachments[0], result.text);
    for (const att of attachments.slice(1)) {
      await sendTelegramPhoto(token, chatId, att, null);
    }
  } else {
    await sendTelegramMsg(token, chatId, result.text);
  }
  console.log(`✅ [Notif] Правило "${rule.name}": сообщение отправлено → chat ${chatId}${attachments.length ? ` (+${attachments.length} изображений)` : ''}`);
}

// ── Rule processors ───────────────────────────────────────────────────────────

async function processNewRecord(rule) {
  const since = rule.lastRunAt || new Date(0);
  const query = { userId: rule.userId, createdAt: { $gt: since } };
  if (rule.schemaName) query.schemaName = rule.schemaName;
  const records = await UserRecord.find(query).sort({ createdAt: 1 }).limit(20).lean();

  if (!records.length) return;
  console.log(`[Notif] Правило "${rule.name}": найдено ${records.length} новых записей`);

  if (rule.recipientType !== 'specific_id') return;

  const rawList = rule.recipients?.length ? rule.recipients : (rule.recipientChatId ? [rule.recipientChatId] : []);
  const chatIds = [];
  for (const raw of rawList) {
    const chatId = await resolveChatId(rule.userId, rule.profileId, raw);
    if (chatId) chatIds.push(chatId);
    else console.warn(`[Notif] Правило "${rule.name}": не удалось разрешить получателя "${raw}"`);
  }

  if (!chatIds.length) return;

  for (const rec of records) {
    const prompt = buildPrompt(rule, [], rec);
    for (const chatId of chatIds) {
      enqueueNotification(rule, chatId, prompt); // в очередь, не блокируем тик
    }
  }

  await NotificationRule.updateOne({ _id: rule._id }, { lastRunAt: new Date() });
}

async function processTimeBefore(rule) {
  if (!rule.schemaName || !rule.dateField) return;

  const now = Date.now();
  const windowMs = rule.minutesBefore * 60 * 1000;
  // Find records whose event time falls within [now - 5min, now + minutesBefore]
  // (we check slightly before to not miss due to processing delay)
  const sentIds = (rule.sentRecordIds || []).map(id => id.toString());

  const candidates = await UserRecord.find({
    userId: rule.userId,
    schemaName: rule.schemaName,
    _id: { $nin: rule.sentRecordIds || [] },
  }).limit(200).lean();

  const toNotify = [];
  for (const rec of candidates) {
    const eventDt = parseEventDatetime(rec, rule.dateField, 'time');
    if (!eventDt) continue;
    const msUntilEvent = eventDt.getTime() - now;
    // Send if: event is upcoming AND we're within the notification window (with ±5min tolerance)
    if (msUntilEvent > -5 * 60 * 1000 && msUntilEvent <= windowMs + 5 * 60 * 1000) {
      toNotify.push(rec);
    }
  }
  if (!toNotify.length) return;

  const newSentIds = [];
  for (const rec of toNotify) {
    const prompt = buildPrompt(rule, [], rec);

    if (rule.recipientType === 'user_field') {
      const chatId = rec.data?.[rule.recipientChatIdField || '_tg_chat_id'];
      if (!chatId) continue;
      enqueueNotification(rule, chatId, prompt);
    } else {
      const rawList = rule.recipients?.length ? rule.recipients : (rule.recipientChatId ? [rule.recipientChatId] : []);
      let sent = false;
      for (const raw of rawList) {
        const chatId = await resolveChatId(rule.userId, rule.profileId, raw);
        if (chatId) { enqueueNotification(rule, chatId, prompt); sent = true; }
      }
      if (!sent) continue;
    }

    newSentIds.push(rec._id);
  }

  if (newSentIds.length) {
    const combined = [...(rule.sentRecordIds || []), ...newSentIds].slice(-500);
    await NotificationRule.updateOne({ _id: rule._id }, { sentRecordIds: combined });
  }
}

async function processDailyReport(rule) {
  // reportHour — локальный час владельца; переводим в UTC-час срабатывания.
  const tz = rule.tzOffset ?? 3;
  const targetUtcHour = ((((rule.reportHour ?? 9) - tz) % 24) + 24) % 24;
  const targetMinute = rule.reportMinute ?? 0; // минуты tz-инвариантны (сдвиг — целые часы)
  const now = new Date();
  if (now.getUTCHours() !== targetUtcHour) return;
  // Ждём нужную минуту в этом часу (тик раз в 60с). Для 23:50 — сработает в :50+,
  // once-per-day-guard ниже не даст повториться. Отчёт охватит день с 00:00.
  if (now.getUTCMinutes() < targetMinute) return;

  // Once per day — считаем по локальной дате владельца (сдвигаем на tz).
  const localNow = new Date(now.getTime() + tz * 3600000);
  if (rule.lastRunAt) {
    const lastLocal = new Date(new Date(rule.lastRunAt).getTime() + tz * 3600000);
    if (
      lastLocal.getUTCFullYear() === localNow.getUTCFullYear() &&
      lastLocal.getUTCMonth() === localNow.getUTCMonth() &&
      lastLocal.getUTCDate() === localNow.getUTCDate()
    ) return;
  }

  // Начало локального дня владельца, выраженное в UTC.
  const startOfDay = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 0, 0, 0) - tz * 3600000);
  const dailyQuery = { userId: rule.userId, createdAt: { $gte: startOfDay } };
  if (rule.schemaName) dailyQuery.schemaName = rule.schemaName;
  const records = await UserRecord.find(dailyQuery).limit(50).lean();

  const rawList = rule.recipients?.length ? rule.recipients : (rule.recipientChatId ? [rule.recipientChatId] : []);
  if (!rawList.length) return;

  // lastRunAt СРАЗУ (до постановки в очередь) — чтобы наложенные/следующие тики
  // не поставили тот же отчёт ПОВТОРНО (был баг: дублирующиеся отчёты).
  await NotificationRule.updateOne({ _id: rule._id }, { lastRunAt: new Date() });
  const stats = await computeDailyStats(rule, startOfDay);
  const prompt = buildDailyReportPrompt(rule, records, stats);
  for (const raw of rawList) {
    const chatId = await resolveChatId(rule.userId, rule.profileId, raw);
    if (chatId) enqueueNotification(rule, chatId, prompt); // серийная очередь, без спешки
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick() {
  // Лавочка закрыта (BOTS_DISABLED) — не генерим и не шлём владельцам ботов
  // никакие уведомления/отчёты (daily_report «воронка», new_record, time_before).
  // Обратимо: убрать флаг + перезапустить siberi-api. См. [[aiconstructor-shutdown]].
  if (process.env.BOTS_DISABLED === 'true') return;
  if (_ticking) return; // не накладываем тики (setInterval не ждёт прошлый)
  _ticking = true;
  try {
    const rules = await NotificationRule.find({ enabled: true }).lean();
    if (!rules.length) return;

    for (const rule of rules) {
      // Quick check: user access still active (must NOT use .lean() — isAccessActive is a Mongoose method)
      try {
        const user = await User.findById(rule.userId).select('subscriptionStatus subscriptionEnd trialStart');
        if (!user?.isAccessActive?.()) continue;
      } catch { continue; }

      try {
        if (rule.triggerType === 'new_record')    await processNewRecord(rule);
        if (rule.triggerType === 'time_before')   await processTimeBefore(rule);
        if (rule.triggerType === 'daily_report')  await processDailyReport(rule);
      } catch (err) {
        console.error(`❌ [Notif] Ошибка правила "${rule.name}":`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ [Notif] Ошибка тика:', err.message);
  } finally {
    _ticking = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  console.log('🔔 Notification Processor: старт (интервал 60с)');
  processorTimer = setInterval(tick, INTERVAL_MS);
  // Run once after 10s on startup to catch anything missed
  setTimeout(tick, 10000);
}

function stop() {
  if (processorTimer) { clearInterval(processorTimer); processorTimer = null; }
}

module.exports = {
  start, stop, triggerEventRules, fireAiNotification, buildPrompt, buildPromptForEvent, resolveChatId,
  computeDailyStats, buildDailyReportPrompt, resolveDefaultCreatorChatId,
  enqueueNotification, tick, processDailyReport,
  // тест-хуки (только для проверок):
  __setSender: (fn) => { _sender = fn; },
  __setGap: (ms) => { _notifGapMs = ms; },
  __queueLen: () => notifQueue.length,
};
