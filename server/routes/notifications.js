'use strict';
const express          = require('express');
const router           = express.Router();
const checkAccess      = require('../middleware/checkAccess');
const NotificationRule = require('../models/NotificationRule');
const UserSchema       = require('../models/UserSchema');
const UserAiConfig     = require('../models/UserAiConfig');
const UserIntegrations = require('../models/UserIntegrations');

// GET /api/v1/notifications/resolve-contact?input=@ldrion&profileId=xxx
router.get('/notifications/resolve-contact', checkAccess, async (req, res) => {
  try {
    const { input, profileId } = req.query;
    if (!input || !profileId) return res.status(400).json({ success: false });

    const s = String(input).trim();
    if (/^-?\d+$/.test(s)) return res.json({ success: true, chatId: s });

    const usernameClean = s.replace(/^@/, '').toLowerCase();
    const integDoc = await UserIntegrations.findOne({ userId: req.user._id }).lean();
    const bot = (integDoc?.telegram || []).find(t =>
      t.connected && t.token && t.profileId?.toString() === profileId
    );
    if (!bot) return res.json({ success: false, reason: 'no_bot' });

    const found = (bot.knownContacts || []).find(c => c.username?.toLowerCase() === usernameClean);
    if (found?.chatId) return res.json({ success: true, chatId: found.chatId, displayName: found.displayName });

    // Try Telegram API
    const r = await fetch(
      `https://api.telegram.org/bot${bot.token}/getChat?chat_id=${encodeURIComponent('@' + usernameClean)}`
    ).catch(() => null);
    if (r?.ok) {
      const data = await r.json();
      if (data.ok && data.result?.id) {
        return res.json({ success: true, chatId: String(data.result.id), displayName: data.result.first_name });
      }
    }
    res.json({ success: false, reason: 'not_found' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/notifications/rules
router.get('/notifications/rules', checkAccess, async (req, res) => {
  try {
    const rules = await NotificationRule.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).lean();
    res.json({ success: true, rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/notifications/rules
router.post('/notifications/rules', checkAccess, async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      name, enabled, profileId,
      recipientType, recipientChatId, recipients, recipientChatIdField,
      triggerType, schemaName,
      dateField, minutesBefore,
      reportHour, messagePrompt,
    } = req.body;

    if (!profileId) return res.status(400).json({ error: 'profileId required' });

    const rule = new NotificationRule({
      userId, profileId, name, enabled,
      recipientType, recipientChatId,
      recipients: Array.isArray(recipients) ? recipients.filter(Boolean) : [],
      recipientChatIdField,
      triggerType, schemaName,
      dateField: dateField || 'date',
      minutesBefore: minutesBefore || 120,
      reportHour: reportHour ?? 9,
      messagePrompt,
    });
    await rule.save();
    res.json({ success: true, rule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/notifications/rules/:id
router.put('/notifications/rules/:id', checkAccess, async (req, res) => {
  try {
    const rule = await NotificationRule.findOne({ _id: req.params.id, userId: req.user._id });
    if (!rule) return res.status(404).json({ error: 'Not found' });

    const fields = [
      'name', 'enabled', 'profileId',
      'recipientType', 'recipientChatId', 'recipientChatIdField',
      'triggerType', 'schemaName',
      'dateField', 'minutesBefore', 'reportHour', 'messagePrompt',
    ];
    fields.forEach(f => { if (req.body[f] !== undefined) rule[f] = req.body[f]; });
    if (Array.isArray(req.body.recipients)) {
      rule.recipients = req.body.recipients.filter(Boolean);
    }
    await rule.save();
    res.json({ success: true, rule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/notifications/rules/:id
router.delete('/notifications/rules/:id', checkAccess, async (req, res) => {
  try {
    await NotificationRule.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/notifications/context — schemas + profiles + contacts for the UI
router.get('/notifications/context', checkAccess, async (req, res) => {
  try {
    const userId = req.user._id;
    const [schemas, profiles, integDoc] = await Promise.all([
      UserSchema.find({ userId }).select('name label').lean(),
      UserAiConfig.find({ userId, profileName: { $ne: '__studio__' } })
        .select('_id profileName aiName color').lean(),
      UserIntegrations.findOne({ userId }).lean(),
    ]);

    const tgBots = (integDoc?.telegram || []).filter(t => t.connected && t.token);
    const tgProfileIds = new Set(tgBots.map(t => t.profileId?.toString()));

    // Build contacts map: profileId → [{chatId, username, displayName}]
    const contactsByProfile = {};
    for (const bot of tgBots) {
      const pid = bot.profileId?.toString();
      if (!pid) continue;
      contactsByProfile[pid] = (bot.knownContacts || [])
        .slice(0, 50)
        .map(c => ({ chatId: c.chatId, username: c.username, displayName: c.displayName }));
    }

    res.json({
      success: true,
      schemas: schemas.map(s => ({ name: s.name, label: s.label || s.name })),
      profiles: profiles.map(p => ({
        _id: p._id,
        label: p.aiName || p.profileName,
        hasTelegram: tgProfileIds.has(p._id.toString()),
        contacts: contactsByProfile[p._id.toString()] || [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
