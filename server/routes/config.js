'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const checkAccess = require('../middleware/checkAccess');
const authenticateOnly = require('../middleware/authenticateOnly');
const UserAiConfig = require('../models/UserAiConfig');
const UserAdmin = require('../models/UserAdmin');
const UserPermissions = require('../models/UserPermissions');
const EmbedToken = require('../models/EmbedToken');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const Task = require('../models/Task');
const aiService = require('../AiService');

function makeAccessCode() {
  const h = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${h.slice(0,4)}-${h.slice(4,8)}-${h.slice(8,12)}`;
}

// Вспомогательная функция: найти активный профиль пользователя
async function getActiveProfile(user) {
  if (user.activeProfileId) {
    const p = await UserAiConfig.findOne({ _id: user.activeProfileId, userId: user._id });
    if (p) return p;
  }
  // Fallback: первый профиль или профиль с isDefault
  return UserAiConfig.findOne({ userId: user._id });
}

router.post('/config', checkAccess, async (req, res) => {
  try {
    const { aiName, systemPrompt, restrictions, integrations, profileId } = req.body;
    if (!systemPrompt || systemPrompt.trim().length < 20) {
      return res.status(400).json({ error: 'System prompt required (min 20 chars)' });
    }

    // Лимиты интеграций по тарифу
    const limits = req.user.getPlanLimits();
    let safeIntegrations = integrations || {};
    if (limits.integrations === 0) {
      safeIntegrations = { telegram: false, websiteWidget: false };
    } else if (limits.integrations !== Infinity) {
      const activeCount = Object.values(safeIntegrations).filter(Boolean).length;
      if (activeCount > limits.integrations) {
        return res.status(403).json({
          error: `Ваш тариф допускает максимум ${limits.integrations} активных интеграции`,
          planLimits: limits,
        });
      }
    }

    // Найти нужный профиль: по profileId или активный
    let query = profileId
      ? { _id: profileId, userId: req.user._id }
      : { userId: req.user._id };

    const config = await UserAiConfig.findOneAndUpdate(
      query,
      {
        aiName: aiName?.trim() || 'Помощник',
        systemPrompt: systemPrompt.trim(),
        restrictions: (restrictions || '').trim().slice(0, 2000),
        integrations: safeIntegrations,
        $setOnInsert: {
          userId: req.user._id,
          ownerCode: makeAccessCode(),
          adminCode: makeAccessCode(),
          isDefault: true,
        },
      },
      { upsert: !profileId, returnDocument: 'after' }
    );

    if (!config) return res.status(404).json({ error: 'Профиль не найден' });

    // Если коды не были созданы при upsert
    if (!config.ownerCode || !config.adminCode) {
      config.ownerCode = config.ownerCode || makeAccessCode();
      config.adminCode = config.adminCode || makeAccessCode();
      await config.save();
    }

    // Привязать как активный профиль если не привязан
    if (!req.user.activeProfileId) {
      await User.updateOne({ _id: req.user._id }, { activeProfileId: config._id });
    }

    res.json({
      success: true,
      message: 'Settings saved',
      config: {
        _id: config._id,
        profileName: config.profileName,
        aiName: config.aiName,
        integrations: config.integrations,
        totalRequests: config.totalRequests,
        ownerCode: config.ownerCode,
        adminCode: config.adminCode,
      },
    });
  } catch (err) {
    console.error('Config save error:', err);
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

router.get('/config', checkAccess, async (req, res) => {
  try {
    const profileId = req.query.profileId;
    const config = profileId
      ? await UserAiConfig.findOne({ _id: profileId, userId: req.user._id })
      : await getActiveProfile(req.user);

    res.json({
      success: true,
      config: config
        ? {
            _id: config._id,
            profileName: config.profileName || 'Основной профиль',
            aiName: config.aiName,
            systemPrompt: config.systemPrompt,
            restrictions: config.restrictions || '',
            integrations: config.integrations,
            totalRequests: config.totalRequests,
            lastUsed: config.lastUsed,
            mistralChatId: config.mistralChatId,
            ownerCode: config.ownerCode || null,
            adminCode: config.adminCode || null,
            schemaVisibility: config.schemaVisibility || {},
          }
        : null,
    });
  } catch (err) {
    console.error('Config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch config: ' + err.message });
  }
});

// Schema visibility settings
router.get('/config/schema-visibility', checkAccess, async (req, res) => {
  try {
    const profileId = req.query.profileId;
    const config = profileId
      ? await UserAiConfig.findOne({ _id: profileId, userId: req.user._id })
      : await getActiveProfile(req.user);
    if (!config) return res.status(404).json({ error: 'Профиль не найден' });

    const UserSchema = require('../models/UserSchema');
    const schemaQuery = { userId: req.user._id, isActive: true };
    if (profileId) {
      schemaQuery.$or = [{ profileIds: { $size: 0 } }, { profileIds: profileId }];
    }
    const schemas = await UserSchema.find(schemaQuery).select('name label icon color').lean();

    res.json({
      success: true,
      schemas,
      visibility: config.schemaVisibility || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/config/schema-visibility', checkAccess, async (req, res) => {
  try {
    const { profileId, schemaName, level } = req.body;
    if (!schemaName || !['all', 'admin', 'creator'].includes(level)) {
      return res.status(400).json({ error: 'Invalid params' });
    }
    const query = profileId
      ? { _id: profileId, userId: req.user._id }
      : { userId: req.user._id };
    const config = await UserAiConfig.findOne(query);
    if (!config) return res.status(404).json({ error: 'Профиль не найден' });

    const visibility = { ...(config.schemaVisibility || {}) };
    if (level === 'all') {
      delete visibility[schemaName]; // 'all' is default, no need to store
    } else {
      visibility[schemaName] = level;
    }
    config.schemaVisibility = visibility;
    config.markModified('schemaVisibility');
    await config.save();

    res.json({ success: true, visibility });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Сброс кода Создателя (только обновляет код)
router.post('/config/reset-owner-code', checkAccess, async (req, res) => {
  try {
    const config = await UserAiConfig.findOneAndUpdate(
      { userId: req.user._id },
      { ownerCode: makeAccessCode() },
      { returnDocument: 'after' }
    );
    if (!config) return res.status(404).json({ error: 'Конфигурация не найдена' });
    res.json({ success: true, ownerCode: config.ownerCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Сброс кода Администраторов + отзыв всех admin-доступов
router.post('/config/reset-admin-code', checkAccess, async (req, res) => {
  try {
    const [config, { deletedCount }] = await Promise.all([
      UserAiConfig.findOneAndUpdate(
        { userId: req.user._id },
        { adminCode: makeAccessCode() },
        { returnDocument: 'after' }
      ),
      UserAdmin.deleteMany({ ownerId: req.user._id, role: 'admin' }),
    ]);
    if (!config) return res.status(404).json({ error: 'Конфигурация не найдена' });
    res.json({ success: true, adminCode: config.adminCode, revokedCount: deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === ПРОФИЛИ AI ===

// Список всех профилей
router.get('/profiles', checkAccess, async (req, res) => {
  try {
    const profiles = await UserAiConfig.find({ userId: req.user._id, profileName: { $ne: '__studio__' } })
      .select('_id profileName aiName isDefault integrations totalRequests lastUsed createdAt color')
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      success: true,
      profiles,
      activeProfileId: req.user.activeProfileId,
      planLimits: req.user.getPlanLimits(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создать новый профиль
router.post('/profiles', checkAccess, async (req, res) => {
  try {
    const limits = req.user.getPlanLimits();
    const count = await UserAiConfig.countDocuments({ userId: req.user._id });

    if (count >= limits.profiles) {
      return res.status(403).json({
        error: `Ваш тариф «${limits.label}» допускает максимум ${limits.profiles} профилей`,
        planLimits: limits,
      });
    }

    const { profileName = 'Новый профиль', aiName = 'Помощник', systemPrompt = 'Ты — полезный AI-помощник.' } = req.body;

    const profile = new UserAiConfig({
      userId: req.user._id,
      profileName: profileName.trim().slice(0, 60),
      aiName: aiName.trim().slice(0, 50),
      systemPrompt: systemPrompt.trim() || 'Ты — полезный AI-помощник.',
      ownerCode: makeAccessCode(),
      adminCode: makeAccessCode(),
      isDefault: count === 0,
    });
    await profile.save();

    // Создаём Mistral-чат для нового профиля в фоне
    setImmediate(async () => {
      try {
        let retries = 0;
        while (!aiService.isReady && retries < 20) { await new Promise(r => setTimeout(r, 1000)); retries++; }
        if (!aiService.isReady) return;
        const chatId = await aiService.createChatForUser(req.user._id.toString(), req.user.email);
        if (chatId) {
          profile.mistralChatId = chatId;
          await profile.save();
          console.log(`✅ Профиль "${profileName}": чат создан ${chatId}`);
        }
      } catch (e) {
        console.error('⚠️ Не удалось создать чат для профиля:', e.message);
      }
    });

    res.status(201).json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удалить профиль
router.delete('/profiles/:id', checkAccess, async (req, res) => {
  try {
    const count = await UserAiConfig.countDocuments({ userId: req.user._id });
    if (count <= 1) return res.status(400).json({ error: 'Нельзя удалить последний профиль' });

    const deleted = await UserAiConfig.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!deleted) return res.status(404).json({ error: 'Профиль не найден' });

    // Если удалён активный профиль — переключить на другой
    let newActiveId = req.user.activeProfileId;
    if (req.user.activeProfileId?.toString() === req.params.id) {
      const next = await UserAiConfig.findOne({ userId: req.user._id });
      newActiveId = next ? next._id : null;
      await User.updateOne({ _id: req.user._id }, { activeProfileId: newActiveId });
    }

    res.json({ success: true, activeProfileId: newActiveId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Переключить активный профиль
router.put('/profiles/:id/activate', checkAccess, async (req, res) => {
  try {
    const profile = await UserAiConfig.findOne({ _id: req.params.id, userId: req.user._id });
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });

    await User.updateOne({ _id: req.user._id }, { activeProfileId: profile._id });

    res.json({ success: true, activeProfileId: profile._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновить имя профиля
router.patch('/profiles/:id', checkAccess, async (req, res) => {
  try {
    const { profileName, color } = req.body;
    const update = {};
    if (profileName !== undefined) update.profileName = (profileName || '').trim().slice(0, 60) || 'Профиль';
    if (color !== undefined) update.color = color ? color.slice(0, 20) : null;
    const profile = await UserAiConfig.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      update,
      { returnDocument: 'after' }
    );
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ И ПОДПИСКЕ ===
router.get('/user/info', authenticateOnly, async (req, res) => {
  try {
    const user = req.user;
    const now = new Date();
    let trialEndsAt = null;

    if (user.subscriptionStatus === 'trial' && user.trialStart) {
      trialEndsAt = new Date(user.trialStart.getTime() + (user.trialDurationDays || 7) * 24 * 60 * 60 * 1000);
    }

    res.json({
      success: true,
      email: user.email,
      emailVerified: user.emailVerified || false,
      plan: user.plan || 'standard',
      subscriptionStatus: user.subscriptionStatus,
      subscriptionEnd: user.subscriptionEnd,
      isAccessActive: user.isAccessActive(),
      trialEndsAt,
      planLimits: user.getPlanLimits(),
      canExportBotCode: user.canExportBotCode(),
      isSiteAdmin: user.isSiteAdmin || false,
      autoRenew: user.autoRenew === true, // только явное согласие (оферта п. 8.1)
      hintsEnabled: user.hintsEnabled !== false, // default true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User preferences ──────────────────────────────────────────────────────────
router.patch('/user/preferences', authenticateOnly, async (req, res) => {
  try {
    const { autoRenew, hintsEnabled } = req.body;
    const update = {};
    if (typeof autoRenew === 'boolean') update.autoRenew = autoRenew;
    if (typeof hintsEnabled === 'boolean') update.hintsEnabled = hintsEnabled;
    if (!Object.keys(update).length) return res.json({ success: true });
    Object.assign(req.user, update);
    await req.user.save();
    res.json({ success: true, autoRenew: req.user.autoRenew === true, hintsEnabled: req.user.hintsEnabled !== false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rotate API key — invalidates the old one immediately. Telegram/VK/MAX bots
// and the widget are keyed by userId/BotFather token, never by apiKey, so they're
// entirely unaffected. The website session re-syncs automatically (client updates
// localStorage from this response). Only code the user has already copied
// elsewhere (Data API scripts, custom REST integrations) needs a manual update —
// the client warns about that before calling this. ──────────────────────────────
router.post('/user/regenerate-apikey', authenticateOnly, async (req, res) => {
  try {
    req.user.apiKey = uuidv4();
    await req.user.save();
    res.json({ success: true, apiKey: req.user.apiKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Payment history ───────────────────────────────────────────────────────────
router.get('/user/payment-history', authenticateOnly, async (req, res) => {
  try {
    const history = (req.user.paymentHistory || [])
      .slice()
      .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Activity stats ────────────────────────────────────────────────────────────
router.get('/stats/activity', checkAccess, async (req, res) => {
  try {
    const userId = req.user._id;
    const now = new Date();
    const days = 14;
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const tasks = await Task.find(
      { userId, createdAt: { $gte: since }, status: { $in: ['completed', 'error'] } },
      { createdAt: 1, processingTime: 1, status: 1 }
    ).lean();

    // Group by day (YYYY-MM-DD in local time)
    const byDay = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - (days - 1 - i) * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      byDay[key] = { date: key, count: 0, errors: 0, avgMs: 0, totalMs: 0 };
    }

    for (const t of tasks) {
      const key = new Date(t.createdAt).toISOString().slice(0, 10);
      if (!byDay[key]) continue;
      byDay[key].count++;
      if (t.status === 'error') byDay[key].errors++;
      if (t.processingTime) { byDay[key].totalMs += t.processingTime; }
    }

    const series = Object.values(byDay).map((d) => ({
      date: d.date,
      count: d.count,
      errors: d.errors,
      avgMs: d.count > 0 ? Math.round(d.totalMs / d.count) : 0,
    }));

    const totalWeek = series.slice(-7).reduce((s, d) => s + d.count, 0);
    const totalAll = tasks.length;
    const errorCount = tasks.filter((t) => t.status === 'error').length;
    const successTasks = tasks.filter((t) => t.processingTime);
    const avgProcessingMs = successTasks.length
      ? Math.round(successTasks.reduce((s, t) => s + t.processingTime, 0) / successTasks.length)
      : 0;

    res.json({ success: true, series, totalWeek, totalAll, errorCount, avgProcessingMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === EMBED TOKEN (short-lived token for widget URLs, avoids exposing real API key) ===
router.get('/embed/token', checkAccess, async (req, res) => {
  try {
    const et = await EmbedToken.findOne({ userId: req.user._id, expiresAt: { $gt: new Date() } });
    if (!et) return res.json({ success: true, token: null });
    res.json({ success: true, token: et.token, expiresAt: et.expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/embed/token', checkAccess, async (req, res) => {
  try {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await EmbedToken.findOneAndUpdate(
      { userId: req.user._id },
      { token, expiresAt },
      { upsert: true, returnDocument: 'after' }
    );
    // Auto-detect: user deployed the website widget — mark slot as active
    if (!req.user.widgetIntegrationActive) {
      req.user.widgetIntegrationActive = true;
      req.user.save().catch(() => {});
    }
    res.json({ success: true, token, expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// === ОСНОВНОЙ API ===
router.post('/analyze', checkAccess, async (req, res) => {
  try {
    const { prompt, context, profileId, platformUserId, platform, image } = req.body;
    if (!prompt || prompt.trim().length < 1) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const task = new Task({
      taskId: uuidv4(),
      userId: req.user._id,
      prompt: prompt.trim(),
      context: {
        ...(context || {}),
        ...(image ? { inputImages: [image] } : {}),
      },
      status: 'processing',
      ...(profileId ? { profileId } : {}),
      endUser: {
        platform: (platform || 'web').slice(0, 50),
        platformUserId: (platformUserId || '').toString().trim().slice(0, 200),
        ip: req.headers['x-forwarded-for'] || req.ip || '',
      },
    });
    await task.save();

    // Считаем промпты для триальных пользователей
    if (req.user.subscriptionStatus === 'trial') {
      req.user.promptsUsed = (req.user.promptsUsed || 0) + 1;
      req.user.save().catch(() => {});
    }

    console.log(`📋 Задача создана: ${task.taskId} для пользователя ${req.user.email}`);

    // 🔥 Асинхронная обработка БЕЗ next
    setImmediate(async () => {
      try {
        await aiService.processTask(task);
      } catch (err) {
        console.error('❌ Ошибка обработки задачи:', err.message);
      }
    });

    res.status(202).json({
      success: true,
      taskId: task.taskId,
      message: 'Task processing started',
      estimatedTime: '30-90 seconds',
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Pre-warm: открываем вкладку браузера заранее, пока пользователь ещё только читает чат
router.post('/ping', authenticateOnly, async (req, res) => {
  res.json({ ok: true }); // отвечаем сразу, прогрев идёт в фоне
  setImmediate(async () => {
    try {
      if (!aiService.isReady) return;
      const userId = req.user._id.toString();
      const userEmail = req.user.email;

      // Берём активный профиль пользователя
      const profile = await UserAiConfig.findOne(
        req.user.activeProfileId
          ? { _id: req.user.activeProfileId, userId: req.user._id }
          : { userId: req.user._id }
      ).catch(() => null);

      const chatId = profile?.mistralChatId;

      // Если у профиля нет чата — создаём в фоне
      if (profile && !chatId) {
        console.log(`🆕 Ping: у профиля нет чата, создаю...`);
        const newChatId = await aiService.createChatForUser(userId, userEmail);
        if (newChatId) {
          profile.mistralChatId = newChatId;
          await profile.save();
          console.log(`✅ Ping: чат создан ${newChatId}`);
        }
        return; // context уже открыт после createChatForUser
      }

      // Если контекст уже открыт — просто сбрасываем таймер
      await aiService.ensureUserContextReady(userId, userEmail, chatId);
      console.log(`🔥 Ping: контекст готов для ${userEmail}`);
    } catch (e) {
      // игнорируем — прогрев не критичен
    }
  });
});

router.get('/result/:taskId', checkAccess, async (req, res) => {
  try {
    const task = await Task.findOne({ taskId: req.params.taskId });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (task.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      status: task.status,
      result: task.result,
      partialResult: task.partialResult || null,
      attachments: task.attachments || [],
      error: task.error,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      processingTime: task.processingTime,
      studioChanges: task.context?.studioChanges || null,
      studioPreviewMessages: task.context?.studioPreviewMessages || null,
      bulkDocToken: task.context?.bulkDocToken || null,
      bulkDocCount: task.context?.bulkDocCount || null,
    });
  } catch (err) {
    console.error('Result fetch error:', err);
    res.status(500).json({ error: 'Error fetching result' });
  }
});

// ==================== УПРАВЛЕНИЕ ДОСТУПОМ ====================

router.get('/access/admins', checkAccess, async (req, res) => {
  try {
    const admins = await UserAdmin.find({ ownerId: req.user._id }).lean();
    res.json({ success: true, admins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/access/admins', checkAccess, async (req, res) => {
  try {
    const { platform, platformUserId, displayName, role } = req.body;
    if (!platform || !platformUserId?.trim()) {
      return res.status(400).json({ error: 'Платформа и ID обязательны' });
    }
    const admin = await UserAdmin.create({
      ownerId: req.user._id,
      role: role === 'creator' ? 'creator' : 'admin',
      platform,
      platformUserId: platformUserId.trim(),
      displayName: displayName?.trim() || '',
    });
    res.json({ success: true, admin });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Такой администратор уже добавлен' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/access/admins/:id', checkAccess, async (req, res) => {
  try {
    await UserAdmin.deleteOne({ _id: req.params.id, ownerId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/access/permissions', checkAccess, async (req, res) => {
  try {
    // $setOnInsert: создаёт документ с дефолтами только при первом обращении
    const perms = await UserPermissions.findOneAndUpdate(
      { ownerId: req.user._id },
      {
        $setOnInsert: {
          allowCreate: true, allowUpdate: false, allowDelete: false, allowSchemaCreate: false,
          adminAllowCreate: true, adminAllowUpdate: true, adminAllowDelete: true, adminAllowSchemaCreate: true,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true, permissions: perms });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

router.put('/access/permissions', checkAccess, async (req, res) => {
  try {
    const {
      allowCreate, allowUpdate, allowDelete, allowSchemaCreate,
      adminAllowCreate, adminAllowUpdate, adminAllowDelete, adminAllowSchemaCreate,
    } = req.body;
    const perms = await UserPermissions.findOneAndUpdate(
      { ownerId: req.user._id },
      {
        allowCreate: !!allowCreate, allowUpdate: !!allowUpdate,
        allowDelete: !!allowDelete, allowSchemaCreate: !!allowSchemaCreate,
        adminAllowCreate: !!adminAllowCreate, adminAllowUpdate: !!adminAllowUpdate,
        adminAllowDelete: !!adminAllowDelete, adminAllowSchemaCreate: !!adminAllowSchemaCreate,
        updatedAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true, permissions: perms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 История чата
router.get('/chat/history', checkAccess, async (req, res) => {
  try {
    const messages = await ChatMessage.find({ userId: req.user._id })
      .sort({ createdAt: 1 })
      .limit(150)
      .lean();
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/chat/history', checkAccess, async (req, res) => {
  try {
    await ChatMessage.deleteMany({ userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 Отправка сообщения в чат
// ── DOCX text extraction ─────────────────────────────────────────────────────
// POST /api/v1/chat/docx-extract  { docxBase64, filename }
router.post('/chat/docx-extract', checkAccess, async (req, res) => {
  try {
    const { docxBase64, filename } = req.body;
    if (!docxBase64) return res.status(400).json({ error: 'docxBase64 required' });
    const mammoth = require('mammoth');
    const buf = Buffer.from(docxBase64, 'base64');
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = result.value?.trim() || '';
    if (!text) return res.status(422).json({ error: 'Документ не содержит читаемого текста' });
    res.json({ success: true, text, filename: filename || 'document.docx', chars: text.length });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось прочитать DOCX: ' + err.message });
  }
});

// ── Generate PDF from text ────────────────────────────────────────────────────
// POST /api/v1/chat/generate-pdf  { text, filename? }
router.post('/chat/generate-pdf', checkAccess, async (req, res) => {
  try {
    const { text, filename = 'document.pdf' } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const PDFDocument = require('pdfkit');
    const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const fs = require('fs');

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    // Register font
    if (fs.existsSync(FONT)) {
      doc.registerFont('Regular', FONT);
      if (fs.existsSync(FONT_BOLD)) doc.registerFont('Bold', FONT_BOLD);
      doc.font('Regular');
    }

    const hasBold = fs.existsSync(FONT_BOLD);
    const stripBold = s => s.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*\*/g, '');

    const lines = text.split('\n');
    let emptyRun = 0;
    for (const line of lines) {
      const t = line.trimEnd();

      // Skip orphan bullet lines (just a bullet symbol, no text)
      if (/^[•·\-\*]\s*$/.test(t)) continue;

      if (t === '') {
        emptyRun++;
        if (emptyRun === 1) doc.moveDown(0.35);
        continue;
      }
      emptyRun = 0;

      // Markdown heading: # / ## / ###
      const hm = t.match(/^(#{1,3})\s+(.+)/);
      if (hm) {
        const fontSize = hm[1].length === 1 ? 16 : hm[1].length === 2 ? 14 : 12;
        doc.font(hasBold ? 'Bold' : 'Regular').fontSize(fontSize).text(stripBold(hm[2]));
        doc.font('Regular').fontSize(11).moveDown(0.2);
        continue;
      }

      // **Standalone bold line** (treat as sub-heading)
      if (/^\*\*[^*]+\*\*[:\s]*$/.test(t)) {
        doc.font(hasBold ? 'Bold' : 'Regular').fontSize(12).text(t.replace(/\*\*/g, '').trim());
        doc.font('Regular').fontSize(11);
        continue;
      }

      // Bullet: • · - * followed by text
      const bm = t.match(/^([•·]|\-|\*)\s+(.+)/);
      if (bm) {
        doc.fontSize(11).text(`• ${stripBold(bm[2])}`, { indent: 14 });
        continue;
      }

      // Regular paragraph — strip leftover markdown
      doc.fontSize(11).text(stripBold(t).replace(/\*([^*\n]+)\*/g, '$1'));
    }

    await new Promise(resolve => { doc.on('end', resolve); doc.end(); });
    const buf = Buffer.concat(chunks);

    const safeName = filename.replace(/[^a-zA-Z0-9а-яёА-ЯЁ._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка генерации PDF: ' + err.message });
  }
});

// ── Generate DOCX from text ───────────────────────────────────────────────────
// POST /api/v1/chat/generate-docx  { text, filename? }
router.post('/chat/generate-docx', checkAccess, async (req, res) => {
  try {
    const { text, filename = 'document.docx' } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

    const stripBoldDocx = s => s.replace(/\*\*/g, '');
    const makeBoldRuns = s => {
      const parts = s.split(/\*\*([^*]+)\*\*/g);
      return parts.map((p, i) => new TextRun({ text: p, bold: i % 2 === 1 }));
    };

    const children = text.split('\n')
      .filter(line => !/^[•·\-\*]\s*$/.test(line.trim())) // drop orphan bullets
      .map(line => {
        const t = line.trimEnd();
        if (/^### /.test(t)) return new Paragraph({ text: stripBoldDocx(t.slice(4)), heading: HeadingLevel.HEADING_3 });
        if (/^## /.test(t))  return new Paragraph({ text: stripBoldDocx(t.slice(3)), heading: HeadingLevel.HEADING_2 });
        if (/^# /.test(t))   return new Paragraph({ text: stripBoldDocx(t.slice(2)), heading: HeadingLevel.HEADING_1 });
        if (t === '')         return new Paragraph({ text: '' });
        // Bullet lines: • · - *
        const bm = t.match(/^([•·]|\-|\*)\s+(.+)/);
        if (bm) return new Paragraph({ bullet: { level: 0 }, children: makeBoldRuns(bm[2]) });
        // Regular with inline bold
        return new Paragraph({ children: makeBoldRuns(t) });
      });

    const doc = new Document({ sections: [{ children }] });
    const buf = await Packer.toBuffer(doc);

    const safeName = filename.replace(/[^a-zA-Z0-9а-яёА-ЯЁ._-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка генерации DOCX: ' + err.message });
  }
});

// ── Save PDF text to user's data ─────────────────────────────────────────────
// POST /api/v1/chat/pdf-save  { text, filename, pages }
router.post('/chat/pdf-save', checkAccess, async (req, res) => {
  try {
    const { text, filename, pages } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const UserSchema = require('../models/UserSchema');
    const UserRecord = require('../models/UserRecord');
    const SCHEMA = 'pdf_документы';

    let schema = await UserSchema.findOne({ userId: req.user._id, name: SCHEMA });
    if (!schema) {
      schema = await UserSchema.create({
        userId: req.user._id,
        name:   SCHEMA,
        label:  'PDF документы',
        fields: [
          { name: 'название',  label: 'Название',  type: 'text',   required: false },
          { name: 'текст',     label: 'Текст',     type: 'text',   required: false },
          { name: 'страниц',   label: 'Страниц',   type: 'number', required: false },
          { name: 'дата',      label: 'Дата',      type: 'date',   required: false },
        ],
        isActive: true,
      });
    }

    const record = await UserRecord.create({
      userId: req.user._id,
      schemaName: SCHEMA,
      data: {
        название: filename || 'document.pdf',
        текст:    text,
        страниц:  pages || null,
        дата:     new Date().toISOString().slice(0, 10),
      },
      metadata: { createdBy: 'user', source: 'pdf' },
    });

    res.json({ success: true, recordId: record._id, schemaName: SCHEMA });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PDF text extraction ───────────────────────────────────────────────────────
// POST /api/v1/chat/pdf-extract  { pdfBase64: "...", filename: "..." }
router.post('/chat/pdf-extract', checkAccess, async (req, res) => {
  try {
    const { pdfBase64, filename } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 required' });

    const pdfParse = require('pdf-parse');
    const buf = Buffer.from(pdfBase64, 'base64');
    const data = await pdfParse(buf);

    const text = data.text?.trim() || '';
    if (!text) return res.status(422).json({ error: 'PDF не содержит читаемого текста (возможно, это сканированное изображение)' });

    res.json({
      success: true,
      text,
      pages: data.numpages,
      filename: filename || 'document.pdf',
      chars: text.length,
    });
  } catch (err) {
    console.error('PDF extract error:', err.message);
    res.status(500).json({ error: 'Не удалось прочитать PDF: ' + err.message });
  }
});

router.post('/chat/send', checkAccess, async (req, res) => {
  try {
    const { prompt, image, activeProfileIds, pdfText, pdfFilename, docText, docFilename } = req.body;
    if (!prompt?.trim() && !pdfText && !docText) return res.status(400).json({ error: 'Введите сообщение' });

    const hasImage  = typeof image   === 'string' && image.startsWith('data:image/');
    const hasPdf    = typeof pdfText === 'string' && pdfText.length > 0;
    const hasDoc    = typeof docText === 'string' && docText.length > 0;
    const fileText  = pdfText || docText;
    const fileName  = pdfFilename || docFilename || 'document';

    const userMessage = prompt?.trim() || '';

    // ── Detect stored file mentions and inject their content into the prompt ──────
    let storedFileContext = '';
    const fileRefRe = /\b([\wа-яёА-ЯЁ][\wа-яёА-ЯЁ0-9 _-]*\.(pdf|docx|doc|xlsx|csv|txt))\b/gi;
    const mentionedFiles = [...new Set(
      [...(userMessage.matchAll(fileRefRe))].map(m => m[1].trim().toLowerCase())
    )];

    if (mentionedFiles.length > 0) {
      const UserRecord = require('../models/UserRecord');
      const fileRecords = await UserRecord.find({ userId: req.user._id, schemaName: 'pdf_документы' }).lean();
      const matched = fileRecords.filter(r => {
        const stored = (r.data?.название || '').toLowerCase();
        const storedBase = stored.replace(/\.[^.]+$/, '');
        return mentionedFiles.some(mf => {
          const mfBase = mf.replace(/\.[^.]+$/, '');
          return storedBase === mfBase || stored.includes(mfBase) || mfBase.includes(storedBase);
        });
      });
      if (matched.length > 0) {
        const sep = '─'.repeat(60);
        const filesBlock = matched.map(r =>
          `[ФАЙЛ ИЗ БАЗЫ: ${r.data.название} | ID: ${r._id} | схема: pdf_документы]\n${sep}\n${(r.data.текст || '').slice(0, 22000)}\n${sep}`
        ).join('\n\n');
        storedFileContext =
          filesBlock + '\n\n' +
          'ИНСТРУКЦИЯ ПО ФАЙЛАМ:\n' +
          '• Анализ/вопросы — используй содержимое выше напрямую.\n' +
          '• Редактирование — сохрани ПОЛНЫЙ обновлённый текст командой:\n' +
          '  <DB_COMMAND>{"action":"update","schema":"pdf_документы","filter":{"_id":"<ID из заголовка>"},"update":{"текст":"<полный новый текст>"}}</DB_COMMAND>\n' +
          '• Сохранить загруженный файл в конкретную схему — используй create в нужной схеме.\n' +
          '• После обновления — сообщи пользователю что файл сохранён.\n\n';
      }
    }

    // Build full prompt: stored file context first, then attached file, then user message
    let fullPrompt;
    if (hasPdf || hasDoc) {
      fullPrompt = `${storedFileContext}[Файл: ${fileName}]\n${'='.repeat(40)}\n${fileText.slice(0, 30000)}\n${'='.repeat(40)}\n\n${userMessage}`;
    } else {
      fullPrompt = storedFileContext + userMessage;
    }

    await ChatMessage.create({
      userId: req.user._id,
      role: 'user',
      content: userMessage || `[PDF: ${pdfFilename}]`,
      image: hasImage ? image : undefined,
    });

    if (req.user.subscriptionStatus === 'trial') {
      req.user.promptsUsed = (req.user.promptsUsed || 0) + 1;
      req.user.save().catch(() => {});
    }

    const taskCtx = { source: 'web-chat', saveHistory: true };
    if (Array.isArray(activeProfileIds)) taskCtx.activeProfileIds = activeProfileIds;

    const task = new Task({
      taskId: uuidv4(),
      userId: req.user._id,
      prompt: fullPrompt,
      context: taskCtx,
      status: 'processing',
    });
    await task.save();

    // Храним изображение только в RAM до момента обработки задачи
    if (hasImage) {
      aiService.pendingImages.set(task.taskId, image);
    }

    setImmediate(async () => {
      try {
        await aiService.processTask(task);
      } catch (err) {
        console.error('❌ Chat task error:', err.message);
      }
    });

    res.status(202).json({ success: true, taskId: task.taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Скачать ZIP из пакетной генерации (BULK_DOC) ─────────────────────────────
router.get('/chat/bulk-download/:token', checkAccess, (req, res) => {
  const job = aiService.bulkDocJobs.get(req.params.token);
  if (!job) return res.status(404).json({ error: 'Файл не найден или срок хранения истёк (1 час)' });
  if (Date.now() > job.expires) {
    aiService.bulkDocJobs.delete(req.params.token);
    return res.status(410).json({ error: 'Срок хранения файла истёк' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  res.setHeader('Content-Length', job.buf.length);
  res.end(job.buf);
});

// ── Тестовый переключатель Qwen fallback (только для разработки) ──────────────
router.post('/dev/toggle-qwen', checkAccess, (req, res) => {
  aiService.setForceQwen(!aiService.forceQwen);
  res.json({
    success: true,
    forceQwen: aiService.forceQwen,
    message: aiService.forceQwen
      ? '⚡ Qwen fallback ВКЛЮЧЁН — Mistral игнорируется'
      : '✅ Mistral включён — штатный режим',
  });
});

router.get('/dev/toggle-qwen', checkAccess, (req, res) => {
  res.json({ forceQwen: aiService.forceQwen });
});

// ── Тестовый переключатель Groq tier-1 (только для разработки) ────────────────
router.post('/dev/toggle-groq', checkAccess, (req, res) => {
  aiService.setForceGroqOff(!aiService.forceGroqOff);
  res.json({
    success: true,
    forceGroqOff: aiService.forceGroqOff,
    message: aiService.forceGroqOff
      ? '⛔ Groq ВЫКЛЮЧЕН — сразу Mistral/Qwen'
      : '✅ Groq включён — приоритет №1',
  });
});

router.get('/dev/toggle-groq', checkAccess, (req, res) => {
  res.json({ forceGroqOff: aiService.forceGroqOff });
});

// === ШАБЛОНЫ ===
router.get('/templates/:type', checkAccess, async (req, res) => {
  const { type } = req.params;
  const templates = {
    'telegram-bot': `
// Telegram Bot Template
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const API_KEY = '${req.user.apiKey}';
const API_BASE = 'http://localhost:3000/api/v1';
const TG_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';

const bot = new TelegramBot(TG_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  try {
    const { data } = await axios.post(\`\${API_BASE}/analyze\`,
      { prompt: msg.text },
      { headers: { Authorization: \`Bearer \${API_KEY}\` }, timeout: 60000 }
    );

    const pollResult = async () => {
      const res = await axios.get(\`\${API_BASE}/result/\${data.taskId}\`, {
        headers: { Authorization: \`Bearer \${API_KEY}\` }
      });
      const resultData = res.data;

      if (resultData.status === 'completed') {
        bot.sendMessage(msg.chat.id, resultData.result);
      } else if (resultData.status === 'error') {
        bot.sendMessage(msg.chat.id, \`Error: \${resultData.error}\`);
      } else {
        setTimeout(pollResult, 2000);
      }
    };
    pollResult();
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Connection error: ' + e.message);
  }
});
console.log('🤖 Telegram bot started');
`.trim(),
    'website-widget': `
<!-- Website Widget -->
<div id="ai-widget">
  <div class="messages" id="messages"></div>
  <input id="user-input" placeholder="Спросите...">
  <button onclick="send()">➤</button>
</div>
<script>
const API_KEY = '${req.user.apiKey}';
const API_BASE = 'https://${req.headers.host}/api/v1';

async function send() {
  const input = document.getElementById('user-input');
  const prompt = input.value.trim();
  if (!prompt) return;

  document.getElementById('messages').innerHTML += \`<div><b>You:</b> \${prompt}</div>\`;
  input.value = '';

  const r1 = await fetch(\`\${API_BASE}/analyze\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${API_KEY}\` },
    body: JSON.stringify({ prompt })
  });
  const { taskId } = await r1.json();

  const check = async () => {
    const r2 = await fetch(\`\${API_BASE}/result/\${taskId}\`);
    const data = await r2.json();
    if (data.status === 'completed') {
      document.getElementById('messages').innerHTML += \`<div><b>AI:</b> \${data.result}</div>\`;
    } else if (data.status === 'error') {
      document.getElementById('messages').innerHTML += \`<div style="color:red">Error: \${data.error}</div>\`;
    } else {
      setTimeout(check, 2000);
    }
  };
  check();
}
</script>
<style>
#ai-widget{position:fixed;bottom:20px;right:20px;width:320px;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:15px;z-index:1000}
.messages{max-height:300px;overflow-y:auto;margin-bottom:10px;font-size:14px}
input{width:75%;padding:8px;border:1px solid #ddd;border-radius:4px}
button{width:20%;padding:8px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer}
button:hover{background:#0056b3}
</style>
`.trim(),
  };

  if (!templates[type]) return res.status(404).json({ error: 'Template not found' });

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${type}.js"`);
  res.send(templates[type]);
});

module.exports = router;
