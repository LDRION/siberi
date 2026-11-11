'use strict';
// Auto-provisioning for every bot that goes live: a reviews schema/command so
// end-users can leave feedback, an immediate notification when one arrives, and
// a daily marketing report — all idempotent (safe to call on every connect/
// reconnect) and all editable afterward via a normal prompt to the Bot Studio
// AI (see AiService.js's existing-rules visibility fix for why that works
// reliably even for the auto-created rules).
const UserSchema       = require('../models/UserSchema');
const UserAiConfig     = require('../models/UserAiConfig');
const NotificationRule = require('../models/NotificationRule');

async function ensureReviewsSchema(userId, profileId) {
  return UserSchema.findOneAndUpdate(
    { userId, name: 'reviews' },
    {
      $setOnInsert: {
        userId,
        name: 'reviews',
        label: 'Отзывы',
        description: 'Отзывы клиентов о боте/услугах — что понравилось, что нет',
        icon: '📝',
        profileIds: profileId ? [profileId] : [],
        fields: [
          { name: 'comment',     label: 'Текст отзыва', type: 'text',   required: true },
          { name: 'rating',      label: 'Оценка',       type: 'number' },
          { name: '_tg_chat_id', label: 'Chat ID',      type: 'text' },
        ],
      },
    },
    { upsert: true, new: true }
  );
}

async function ensureReviewCommand(profileId) {
  const config = await UserAiConfig.findById(profileId);
  if (!config) return;
  const commands = config.botSettings?.commands || [];
  // Specific match only — a loose /отзыв/i.test(command) false-positives on
  // generic orphaned-button placeholders (_fixOrphanedButtons in AiService.js
  // patches ANY unmapped button with a generic aiAction mentioning its own
  // label, e.g. a pre-existing "Отзывы" button with no schema wiring at all —
  // confirmed live, that placeholder is NOT the dedicated reviews-schema flow
  // this function adds, and matching on label alone skipped adding the real one).
  const already = commands.some(c => c.command === '📝 Отзыв' || /reviews/i.test(c.aiAction || ''));
  if (already) return;

  commands.push({
    command: '📝 Отзыв',
    description: 'Оставить отзыв о боте/услугах',
    aiAction: 'Узнай у клиента, что понравилось и что не понравилось — короткий свободный текст. Когда получишь ответ, сохрани его в схему reviews (DB_COMMAND create, поле comment) и поблагодари клиента за отзыв.',
  });
  config.botSettings.commands = commands;
  config.markModified('botSettings.commands');
  await config.save();
}

async function ensureReviewNotificationRule(userId, profileId, recipientChatId) {
  return NotificationRule.findOneAndUpdate(
    { userId, profileId, name: 'Новый отзыв' },
    {
      $setOnInsert: {
        userId, profileId,
        name: 'Новый отзыв',
        triggerType: 'record_created',
        schemaName: 'reviews',
        recipientType: 'specific_id',
        recipientChatId,
        messagePrompt: 'Кратко перескажи отзыв клиента: что понравилось, что не понравилось.',
      },
    },
    { upsert: true, new: true }
  );
}

async function ensureDailyReportRule(userId, profileId, recipientChatId) {
  const existing = await NotificationRule.findOne({ profileId, triggerType: 'daily_report' });
  if (existing) return existing;
  return NotificationRule.create({
    userId, profileId,
    name: 'Ежедневный отчёт',
    triggerType: 'daily_report',
    reportHour: 23,
    reportMinute: 0, // 23:00 локального: отчёт за прошедший день, но с ЗАПАСОМ времени —
    // при 100+ ботах отчёты дренажатся по очереди, чтобы не приходили в 2 ночи (было 23:50)
    recipientType: 'specific_id',
    recipientChatId,
  });
}

// Single entry point — call after a bot's Telegram connection succeeds.
// Fire-and-forget by the caller; never throws (each step is independently
// guarded so a partial failure doesn't block the others).
async function seedBotDefaults(userId, profileId, recipientChatId) {
  if (!recipientChatId) return; // no known Telegram channel to the creator — skip silently
  const results = await Promise.allSettled([
    ensureReviewsSchema(userId, profileId),
    ensureReviewCommand(profileId),
    ensureReviewNotificationRule(userId, profileId, recipientChatId),
    ensureDailyReportRule(userId, profileId, recipientChatId),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`⚠️ seedBotDefaults step ${i} failed:`, r.reason?.message);
  });
}

module.exports = {
  seedBotDefaults,
  ensureReviewsSchema,
  ensureReviewCommand,
  ensureReviewNotificationRule,
  ensureDailyReportRule,
};
