'use strict';

const { isDuplicateUpdate } = require('./dedupeUpdate');

// The one message shown to a user anywhere the AI pipeline (Groq → Mistral →
// Qwen, all retries exhausted) ends up with nothing safe to show — better to
// show this once than ever risk a half-cleaned artifact reaching someone.
const AI_FAILURE_MESSAGE =
  'Прошу прощения, я сломалась. Но моему разработчику уже отправлен сигнал. ' +
  'Вы можете связаться с нашим менеджером @SiberiManager.';

// Fire-and-forget ping to the platform's own admin so "уже отправлен сигнал" is
// an actual fact, not just a friendlier error string. Never throws/blocks —
// failing to send the alert must never also break the (already degraded)
// user-facing reply.
//
// Both the per-channel caller (webhooks.js/tgletbot.js — knows exactly when
// the fallback text is about to be shown) AND processTask's own catch (the
// only place that sees web-chat/other channels with no per-channel caller of
// their own) call this for the same underlying failure — taskId-deduped via
// the same Map dedupeUpdate.js uses for Telegram update_ids, so a single
// incident still only ever produces one real Telegram message.
// Async, но НИКОГДА не ожидается вызывающим (fire-and-forget) — поэтому весь
// обогащающий код обёрнут в try/catch: упавший лукап не должен ни ронять
// процесс unhandled-rejection'ом, ни мешать уже деградировавшему ответу.
// Обогащение делаем здесь, а не в 8 местах вызова: userId/taskId достаточно,
// чтобы поднять и @login владельца, и конечного клиента, и сам текст запроса.
async function alertDeveloperOfAiFailure({ source, userId, reason, taskId } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_ALERT_CHAT_ID;
  if (!token || !chatId) return;
  if (taskId && isDuplicateUpdate('ai-failure-alert', taskId)) return;

  let ownerLine = userId ? `Владелец: userId ${userId}` : null;
  let botLine = null;
  let clientLine = null;
  let requestLine = null;
  try {
    if (userId) {
      const User = require('../models/User');
      const u = await User.findById(userId).select('telegramUsername displayName telegramId').lean();
      if (u) {
        const handle = u.telegramUsername ? `@${u.telegramUsername}` : (u.displayName || '—');
        ownerLine = `Владелец: ${handle}${u.telegramId ? ` · tg ${u.telegramId}` : ''}`;
      }
      // Ссылка на самого бота — чтобы из алерта можно было сразу открыть его и
      // воспроизвести проблему, не разыскивая владельца по базе.
      const UserIntegrations = require('../models/UserIntegrations');
      const integ = await UserIntegrations.findOne({ userId }).select('telegram').lean();
      const bots = (integ?.telegram || []).filter((b) => b?.botUsername);
      if (bots.length) {
        const live = bots.find((b) => b.connected) || bots[0];
        botLine = `Бот: @${live.botUsername} — https://t.me/${live.botUsername}${live.connected ? '' : ' (отключён)'}`;
      }
    }
    if (taskId) {
      const Task = require('../models/Task');
      const t = await Task.findOne({ taskId }).select('rawPrompt prompt endUser').lean();
      // endUser — КЛИЕНТ чужого бота (в живых ботах именно он словил поломку,
      // а userId выше — владелец бота). Для конструктора они совпадают.
      const eu = t?.endUser;
      if (eu && (eu.username || eu.platformUserId)) {
        const h = eu.username ? `@${String(eu.username).replace(/^@+/, '')}` : (eu.displayName || '—');
        clientLine = `Клиент: ${h}${eu.platformUserId ? ` · id ${eu.platformUserId}` : ''}`;
      }
      const req = String(t?.rawPrompt || t?.prompt || '').trim();
      if (req) requestLine = `Запрос: «${req.length > 300 ? `${req.slice(0, 300)}…` : req}»`;
    }
  } catch { /* обогащение — бонус, алерт уходит и без него */ }

  const lines = [
    '🚨 AI не смог обработать запрос — пользователь увидел fallback-сообщение.',
    source ? `Источник: ${source}` : null,
    ownerLine,
    botLine,
    clientLine,
    requestLine,
    reason ? `Причина: ${reason}` : null,
  ].filter(Boolean);
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
  }).catch(() => {});
}

// Use this everywhere a total AI failure needs a user-facing message — fires
// the alert as a side effect and returns the one canonical string.
function aiFailureMessage(context) {
  // Не ждём: вызывающему нужна строка немедленно, алерт уходит своим ходом.
  alertDeveloperOfAiFailure(context).catch(() => {});
  return AI_FAILURE_MESSAGE;
}

module.exports = { AI_FAILURE_MESSAGE, alertDeveloperOfAiFailure, aiFailureMessage };
