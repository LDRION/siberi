'use strict';
const UserIntegrations = require('../models/UserIntegrations');
const User = require('../models/User');

async function getIntegrations(userId) {
  let doc = await UserIntegrations.findOne({ userId });
  if (!doc) {
    doc = new UserIntegrations({ userId });
    await doc.save();
  }
  return doc;
}

// Counts active hosted-bot/integration slots against the user's plan limit.
async function countUserIntegrations(userId) {
  const [doc, user] = await Promise.all([
    getIntegrations(userId),
    User.findById(userId).select('apiIntegrationActive widgetIntegrationActive').lean(),
  ]);
  const bots = (doc.telegram?.length || 0) + (doc.vk?.length || 0) + (doc.max?.length || 0);
  const widgetSlot = user?.widgetIntegrationActive ? 1 : 0;
  const apiSlot    = user?.apiIntegrationActive    ? 1 : 0;
  return bots + widgetSlot + apiSlot;
}

// ── Validate a BotFather token, register the webhook, and store the instance ──
// Shared by the website's /integrations/telegram/connect route and TGLetBot's
// own finalize step. Returns a plain result object instead of writing to `res`
// so both callers can map it to their own response shape.
async function connectTelegramBot(user, token, profileId, name) {
  if (!token || !token.includes(':')) {
    return { success: false, status: 400, error: 'Неверный токен бота' };
  }

  const limits = user.getPlanLimits();
  if (limits.integrations === 0) {
    return { success: false, status: 403, error: 'Хостинговые интеграции доступны начиная с тарифа Pro', planLimits: limits };
  }

  const totalActiveTg = await countUserIntegrations(user._id);
  if (limits.integrations !== Infinity && totalActiveTg >= limits.integrations) {
    return { success: false, status: 403, error: `Достигнут лимит интеграций (${limits.integrations})` };
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).catch(() => null);
  if (!tgRes || !tgRes.ok) {
    return { success: false, status: 400, error: 'Токен не принят Telegram. Проверьте токен от @BotFather.' };
  }
  const botUsername = tgRes.result.username;

  const serverUrl = process.env.SERVER_URL || process.env.FRONTEND_URL?.replace(':5173', ':3000') || '';
  if (!serverUrl) return { success: false, status: 500, error: 'SERVER_URL не задан в .env' };

  // Reserve the instance to get _id
  const updated = await UserIntegrations.findOneAndUpdate(
    { userId: user._id },
    { $push: { telegram: { name: name || '', token, botUsername, connected: false, ...(profileId ? { profileId } : {}) } } },
    { upsert: true, returnDocument: 'after' }
  );
  const instance = updated.telegram[updated.telegram.length - 1];

  const webhookUrl = `${serverUrl}/api/v1/webhook/telegram/${user._id}/${instance._id}`;
  const whRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
  }).then((r) => r.json()).catch(() => null);

  if (!whRes || !whRes.ok) {
    // Roll back
    await UserIntegrations.findOneAndUpdate({ userId: user._id }, { $pull: { telegram: { _id: instance._id } } });
    return { success: false, status: 500, error: 'Не удалось установить webhook: ' + (whRes?.description || 'Ошибка Telegram API') };
  }

  await UserIntegrations.findOneAndUpdate(
    { userId: user._id, 'telegram._id': instance._id },
    { $set: { 'telegram.$.connected': true, 'telegram.$.connectedAt': new Date() } }
  );

  // Default reviews schema/command + immediate-review + daily-report rules for
  // every bot that goes live — fire-and-forget, never blocks the connect flow.
  // Skips silently (inside seedBotDefaults) if we have no known Telegram
  // channel to the creator (typical for website-only customers).
  if (profileId) {
    const { seedBotDefaults } = require('./seedDefaults');
    const { resolveDefaultCreatorChatId } = require('../notificationProcessor');
    resolveDefaultCreatorChatId(user, profileId)
      .then((chatId) => seedBotDefaults(user._id, profileId, chatId))
      .catch((err) => console.warn('⚠️ seedBotDefaults:', err.message));
  }

  return { success: true, instanceId: instance._id, botUsername, webhookUrl };
}

module.exports = { connectTelegramBot, countUserIntegrations, getIntegrations };
