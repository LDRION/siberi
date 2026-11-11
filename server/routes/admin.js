'use strict';
const express = require('express');
const router = express.Router();

const siteAdminGuard = require('../middleware/siteAdminGuard');
const adminGuard = require('../middleware/adminGuard');
const aiService = require('../AiService');
const User = require('../models/User');
const UserAiConfig = require('../models/UserAiConfig');
const UserIntegrations = require('../models/UserIntegrations');

// ==================== SITE ADMIN ROUTES ====================

// GET /api/v1/siteadmin/users — list users with search
router.get('/siteadmin/users', siteAdminGuard, async (req, res) => {
  try {
    const { q = '', page = 1, limit = 50 } = req.query;
    const query = q
      ? { $or: [
          { email: { $regex: q, $options: 'i' } },
          { displayName: { $regex: q, $options: 'i' } },
        ] }
      : {};
    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
      User.find(query)
        .select('email displayName plan subscriptionStatus subscriptionEnd createdAt lastActiveAt blocked isSiteAdmin apiKey')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      User.countDocuments(query),
    ]);
    res.json({ success: true, users, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/siteadmin/users/:id/block
router.post('/siteadmin/users/:id/block', siteAdminGuard, async (req, res) => {
  try {
    const { reason = '', durationDays = null, blockIp = false } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.isSiteAdmin) return res.status(400).json({ error: 'Нельзя заблокировать администратора' });

    user.blocked.isBlocked = true;
    user.blocked.reason = reason;
    user.blocked.blockedAt = new Date();
    user.blocked.blockedUntil = durationDays ? new Date(Date.now() + Number(durationDays) * 24 * 60 * 60 * 1000) : null;

    if (blockIp && req.body.ip && !user.blocked.blockedIps.includes(req.body.ip)) {
      user.blocked.blockedIps.push(req.body.ip);
    }

    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/siteadmin/users/:id/unblock
router.post('/siteadmin/users/:id/unblock', siteAdminGuard, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    user.blocked.isBlocked = false;
    user.blocked.reason = '';
    user.blocked.blockedAt = null;
    user.blocked.blockedUntil = null;
    user.blocked.blockedIps = [];
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/siteadmin/users/:id/payment-history
router.get('/siteadmin/users/:id/payment-history', siteAdminGuard, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('paymentHistory email');
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const history = (user.paymentHistory || []).slice().sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/siteadmin/withdrawals — list all withdrawal requests
router.get('/siteadmin/withdrawals', siteAdminGuard, async (req, res) => {
  try {
    const UserAffiliate = require('../models/UserAffiliate');
    const { status = 'pending' } = req.query;
    const aggs = await UserAffiliate.aggregate([
      { $unwind: '$payouts' },
      ...(status !== 'all' ? [{ $match: { 'payouts.status': status } }] : []),
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmpty: true } },
      { $project: {
        _id: '$payouts._id',
        affiliateId: '$_id',
        userId: '$userId',
        userEmail: '$user.email',
        amount: '$payouts.amount',
        paymentDetails: '$payouts.paymentDetails',
        status: '$payouts.status',
        requestedAt: '$payouts.requestedAt',
        processedAt: '$payouts.processedAt',
        adminNote: '$payouts.adminNote',
      }},
      { $sort: { requestedAt: -1 } },
    ]);
    res.json({ success: true, withdrawals: aggs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/siteadmin/withdrawals/:affiliateId/:payoutId/approve
router.post('/siteadmin/withdrawals/:affiliateId/:payoutId/approve', siteAdminGuard, async (req, res) => {
  try {
    const UserAffiliate = require('../models/UserAffiliate');
    const aff = await UserAffiliate.findById(req.params.affiliateId);
    if (!aff) return res.status(404).json({ error: 'Не найдено' });
    const payout = aff.payouts.id(req.params.payoutId);
    if (!payout) return res.status(404).json({ error: 'Заявка не найдена' });
    payout.status = 'approved';
    payout.processedAt = new Date();
    payout.adminNote = req.body.note || '';
    aff.totalWithdrawn = (aff.totalWithdrawn || 0) + payout.amount;
    aff.balance = Math.max(0, (aff.balance || 0) - payout.amount);
    await aff.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/siteadmin/withdrawals/:affiliateId/:payoutId/reject
router.post('/siteadmin/withdrawals/:affiliateId/:payoutId/reject', siteAdminGuard, async (req, res) => {
  try {
    const UserAffiliate = require('../models/UserAffiliate');
    const aff = await UserAffiliate.findById(req.params.affiliateId);
    if (!aff) return res.status(404).json({ error: 'Не найдено' });
    const payout = aff.payouts.id(req.params.payoutId);
    if (!payout) return res.status(404).json({ error: 'Заявка не найдена' });
    payout.status = 'rejected';
    payout.processedAt = new Date();
    payout.adminNote = req.body.note || '';
    await aff.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/siteadmin/active-apis — all profiles with API integration enabled
router.get('/siteadmin/active-apis', siteAdminGuard, async (req, res) => {
  try {
    // All AI profiles with API integration enabled
    const apiProfiles = await UserAiConfig.find({ 'integrations.api': true })
      .select('userId profileName totalRequests lastUsed createdAt updatedAt integrations')
      .sort({ lastUsed: -1 })
      .lean();

    if (!apiProfiles.length) return res.json({ success: true, integrations: [] });

    const userIds = [...new Set(apiProfiles.map(p => String(p.userId)))];

    // Fetch owners + their API keys
    const users = await User.find({ _id: { $in: userIds } })
      .select('email displayName apiKey createdAt lastActiveAt')
      .lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    // Fetch Telegram/VK/MAX bot instances to enrich context (connected = active)
    const integrations = await UserIntegrations.find({ userId: { $in: userIds } })
      .select('userId telegram vk max webhookCallback')
      .lean();
    const intMap = Object.fromEntries(integrations.map(i => [String(i.userId), i]));

    const result = apiProfiles.map(profile => {
      const user = userMap[String(profile.userId)] || {};
      const ints = intMap[String(profile.userId)] || {};
      const tgBots = (ints.telegram || []).filter(b => b.connected);
      const vkBots = (ints.vk || []).filter(b => b.connected);
      return {
        profileId:    String(profile._id),
        profileName:  profile.profileName || 'Основной профиль',
        ownerEmail:   user.email || '—',
        ownerName:    user.displayName || '',
        apiKey:       user.apiKey || '',
        totalRequests:profile.totalRequests || 0,
        lastUsed:     profile.lastUsed || null,
        createdAt:    profile.createdAt,
        updatedAt:    profile.updatedAt,
        tgBots:       tgBots.map(b => b.botUsername || b.name || b.botName || 'бот'),
        vkBots:       vkBots.map(b => b.name || 'группа'),
        hasWebhook:   !!(ints.webhookCallback?.enabled && ints.webhookCallback?.url),
      };
    });

    res.json({ success: true, integrations: result, total: result.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/siteadmin/users/:id/telegram-bots — every Telegram bot instance
// this user has connected (website Bot Studio OR TGLetBot/AIConstructorBot —
// both write to the same UserIntegrations.telegram[]/UserAiConfig models, so
// one route covers both), each paired with its profile's id/name so the admin
// UI can jump straight into editing the underlying bot config.
router.get('/siteadmin/users/:id/telegram-bots', siteAdminGuard, async (req, res) => {
  try {
    const userId = req.params.id;
    const integDoc = await UserIntegrations.findOne({ userId }).select('telegram').lean();
    const bots = integDoc?.telegram || [];
    const profileIds = [...new Set(bots.map((b) => String(b.profileId)).filter(Boolean))];
    const profiles = profileIds.length
      ? await UserAiConfig.find({ _id: { $in: profileIds } }).select('profileName aiName profileId').lean()
      : [];
    const profileMap = Object.fromEntries(profiles.map((p) => [String(p._id), p]));
    const result = bots.map((b) => ({
      instanceId: String(b._id),
      botUsername: b.botUsername || '',
      botName: b.botName || '',
      connected: !!b.connected,
      connectedAt: b.connectedAt || null,
      token: b.token || '',
      profileId: b.profileId ? String(b.profileId) : null,
      profileName: profileMap[String(b.profileId)]?.profileName || null,
      aiName: profileMap[String(b.profileId)]?.aiName || null,
    }));
    res.json({ success: true, bots: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/siteadmin/profiles/:profileId — full raw config, for the "see
// everything, edit anything" admin editor. No userId-ownership check here on
// purpose — that's the whole point of site-admin (siteAdminGuard already
// gates this to admins only).
router.get('/siteadmin/profiles/:profileId', siteAdminGuard, async (req, res) => {
  try {
    const profile = await UserAiConfig.findById(req.params.profileId).lean();
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/siteadmin/profiles/:profileId — raw-JSON save. Strips fields
// that must never change through this editor (identity/bookkeeping); every
// other key in the body is $set as-is, including nested botSettings/commands —
// this is the "do things the AI can't" hatch, not a validated form.
const PROFILE_PROTECTED_FIELDS = ['_id', '__v', 'userId', 'createdAt'];
router.put('/siteadmin/profiles/:profileId', siteAdminGuard, async (req, res) => {
  try {
    const update = { ...req.body };
    for (const f of PROFILE_PROTECTED_FIELDS) delete update[f];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Пустое обновление' });
    const profile = await UserAiConfig.findByIdAndUpdate(
      req.params.profileId,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });
    res.json({ success: true, profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== ADMIN ROUTES ====================

router.get('/admin/browser-status', adminGuard, async (req, res) => {
  try {
    const status = aiService.getStatus();
    let browserAlive = false;
    let browserInfo = null;

    try {
      const response = await fetch('http://127.0.0.1:9223/json/version', {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      browserAlive = response.ok;
      browserInfo = await response.json();
    } catch (e) {
      browserAlive = false;
    }

    res.json({
      serviceReady: status.isReady,
      browserAlive,
      browserInfo: browserAlive
        ? {
            Browser: browserInfo?.Browser,
            ProtocolVersion: browserInfo?.['Protocol-Version'],
          }
        : null,
      authStateLoaded: status.hasAuthState,
      activeContexts: status.activeContexts,
      processingTasks: status.processingTasks,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/admin/export-auth', adminGuard, async (req, res) => {
  try {
    const success = await aiService.exportAuthState();
    if (success) {
      res.json({ success: true, message: 'Auth state экспортирован.' });
    } else {
      res.status(500).json({ error: 'Не удалось экспортировать auth state' });
    }
  } catch (err) {
    console.error('Export auth error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Открывает Mistral в браузере и ждёт ручной авторизации (до 5 минут)
router.post('/admin/setup-auth', adminGuard, async (req, res) => {
  try {
    console.log('🔐 Запущена процедура ручной авторизации Mistral...');
    const success = await aiService.setupMistralAuth(300_000);
    if (success) {
      res.json({ success: true, message: 'Авторизация сохранена. Перезапуск не нужен.' });
    } else {
      res.status(500).json({ error: 'Не удалось сохранить авторизацию' });
    }
  } catch (err) {
    console.error('Setup auth error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
