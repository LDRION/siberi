'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

/**
 * Сравнение секретов, не зависящее от того, сколько символов совпало.
 * Пустой ожидаемый секрет считаем несовпадением — иначе при незаданной
 * переменной окружения эндпоинт открылся бы всем.
 */
function timingSafeEqualStr(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

const checkAccess = require('../middleware/checkAccess');
const aiService = require('../AiService');
const Task = require('../models/Task');
const DemoVisitor = require('../models/DemoVisitor');
const User = require('../models/User');
const UserAiConfig = require('../models/UserAiConfig');

// === ДЕМО-ЭНДПОИНТЫ (ОБЩИЙ ЧАТ) ===
router.post('/demo/analyze', async (req, res) => {
  try {
    const { prompt, context } = req.body;

    // 🔥 ПЕРВЫМ ДЕЛОМ: Удаляем старую запись UserAiConfig для демо
    let demoUser = await User.findOne({ email: 'demo@siberi.ai' });
    if (demoUser) {
      await UserAiConfig.deleteOne({ userId: demoUser._id });
    }

    // 🔥 Создаём/обновляем пользователя
    if (!demoUser) {
      demoUser = new User({
        email: 'demo@siberi.ai',
        passwordHash: 'demo',
        apiKey: 'demo-key-allow-all',
        trialStart: new Date(),
        subscriptionStatus: 'active',
        subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      await demoUser.save();
    }

    const task = new Task({
      taskId: uuidv4(),
      userId: demoUser._id,
      prompt: prompt || 'Тестовый вопрос',
      context: context || { source: 'landing_demo' },
      status: 'pending',
    });

    await task.save();
    res.status(202).json({ success: true, taskId: task.taskId });
  } catch (err) {
    console.error('Demo error:', err);
    res.status(500).json({ error: 'Demo failed: ' + err.message });
  }
});

router.get('/demo/result/:taskId', async (req, res) => {
  try {
    const task = await Task.findOne({ taskId: req.params.taskId });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    res.json({
      status: task.status,
      result: task.result,
      partialResult: task.partialResult || null,
      error: task.error,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching result' });
  }
});

// === ДЕМО-ЧАТ v2: лимиты, контекст, Mistral+Qwen fallback ===
router.post('/demo/chat', async (req, res) => {
  try {
    const { visitorId, message, history = [] } = req.body;
    if (!visitorId || !message?.trim()) {
      return res.status(400).json({ error: 'visitorId and message required' });
    }

    const LIMIT = parseInt(process.env.GUEST_DAILY_CHAT, 10) || 10;  // незарегистрированный: 10 промтов/сутки
    const RESET_MS = 24 * 60 * 60 * 1000;
    const now = new Date();

    let visitor = await DemoVisitor.findOne({ visitorId });
    if (!visitor) {
      visitor = new DemoVisitor({ visitorId, messageCount: 0 });
    }

    // Сброс счётчика если 24ч прошли
    if (visitor.resetAt && now > visitor.resetAt) {
      visitor.messageCount = 0;
      visitor.firstMessageAt = null;
      visitor.resetAt = null;
    }

    if (visitor.messageCount >= LIMIT) {
      const resetIn = visitor.resetAt
        ? Math.ceil((visitor.resetAt - now) / 1000 / 60 / 60)
        : 0;
      return res.json({ limitReached: true, resetIn });
    }

    if (!visitor.firstMessageAt) {
      visitor.firstMessageAt = now;
      visitor.resetAt = new Date(now.getTime() + RESET_MS);
    }
    visitor.lastMessageAt = now;
    visitor.messageCount += 1;
    await visitor.save();

    const isFirst = visitor.messageCount === 1;

    // История диалога — только полные пары user+assistant с непустыми ответами
    const cleanHistory = [];
    const rawHistory = history.slice(-8);
    for (let i = 0; i < rawHistory.length - 1; i++) {
      const msg = rawHistory[i];
      const next = rawHistory[i + 1];
      if (msg.role === 'user' && next?.role === 'assistant' && next.content?.trim().length > 10) {
        cleanHistory.push(msg, next);
        i++; // пропускаем next, он уже добавлен
      }
    }
    const historyLines = cleanHistory.slice(-6).map(m => {
      const role = m.role === 'user' ? 'Пользователь' : 'Ассистент';
      const content = String(m.content).split('\n')[0].slice(0, 300);
      return `${role}: ${content}`;
    }).join('\n');

    // Используем демо-пользователя
    let demoUser = await User.findOne({ email: 'demo@siberi.ai' });
    if (!demoUser) {
      demoUser = new User({
        email: 'demo@siberi.ai',
        passwordHash: 'demo',
        apiKey: 'demo-key-allow-all',
        trialStart: new Date(),
        subscriptionStatus: 'active',
        subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      await demoUser.save();
    }

    const task = new Task({
      taskId: uuidv4(),
      userId: demoUser._id,
      prompt: message.trim(),
      context: {
        // /app помечает себя source:'app_chat' → UltraGPT. Лендинг-демо (без source)
        // остаётся 'landing_demo_v2' → быстрый Groq. Whitelist, чтобы извне не подменяли.
        source: req.body.source === 'app_chat' ? 'app_chat' : 'landing_demo_v2',
        visitorId,
        isFirst,
        historyLines,
      },
      status: 'pending',
    });
    await task.save();

    res.status(202).json({
      success: true,
      taskId: task.taskId,
      remaining: LIMIT - visitor.messageCount,
    });
  } catch (err) {
    console.error('Demo chat v2 error:', err);
    res.status(500).json({ error: 'Demo failed: ' + err.message });
  }
});

// ── Внутренний фолбэк для Telegram-бота (Siberi) ──────────────────────────────
// Бот (@SiberiAi_bot) работает отдельным процессом и использует Groq напрямую.
// Когда Groq у бота недоступен, бот стучится сюда — тот же воркер обработает
// запрос через уже тёплую цепочку Groq → Mistral → Qwen (этого инстанса).
// Защищён общим секретом, не предназначен для публичного доступа.
router.post('/internal/ai-fallback', async (req, res) => {
  try {
    // Сравнение постоянное по времени — как в middleware/adminGuard.js и
    // routes/externalApi.js. Обычное !== выходит на первом несовпавшем символе,
    // и время ответа зависит от того, сколько символов угадано.
    const secret = req.headers['x-internal-secret'];
    if (!timingSafeEqualStr(secret, process.env.INTERNAL_API_SECRET)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { message, systemPrompt } = req.body;
    if (!message?.trim())      return res.status(400).json({ error: 'message required' });
    if (!systemPrompt?.trim()) return res.status(400).json({ error: 'systemPrompt required' });

    let demoUser = await User.findOne({ email: 'demo@siberi.ai' });
    if (!demoUser) {
      demoUser = new User({
        email: 'demo@siberi.ai',
        passwordHash: 'demo',
        apiKey: 'demo-key-allow-all',
        trialStart: new Date(),
        subscriptionStatus: 'active',
        subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      await demoUser.save();
    }

    const task = new Task({
      taskId: uuidv4(),
      userId: demoUser._id,
      prompt: message.trim(),
      context: { source: 'telegram_bot_fallback', customSystemPrompt: systemPrompt },
      status: 'pending',
    });
    await task.save();

    // Воркер подхватит задачу асинхронно — ждём результат прямо здесь (синхронный ответ боту)
    const deadline = Date.now() + 55000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      const fresh = await Task.findOne({ taskId: task.taskId });
      if (!fresh) break;
      if (fresh.status === 'completed') return res.json({ success: true, result: fresh.result });
      if (fresh.status === 'error')     return res.status(502).json({ error: fresh.error || 'AI error' });
    }
    return res.status(504).json({ error: 'Timeout waiting for AI response' });
  } catch (err) {
    console.error('Internal AI fallback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Онлайн-консультант (widget support chat, authenticated) ──────────────────
router.post('/support/chat', checkAccess, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });

    const historyLines = history.slice(-6).map(m => {
      const role = m.role === 'user' ? 'Пользователь' : 'Ассистент';
      return `${role}: ${String(m.content).split('\n')[0].slice(0, 300)}`;
    }).join('\n');

    let demoUser = await User.findOne({ email: 'demo@siberi.ai' });
    if (!demoUser) {
      demoUser = new User({
        email: 'demo@siberi.ai', passwordHash: 'demo', apiKey: 'demo-key-allow-all',
        trialStart: new Date(), subscriptionStatus: 'active',
        subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      await demoUser.save();
    }

    const task = new Task({
      taskId: uuidv4(),
      userId: demoUser._id,
      prompt: message.trim(),
      context: { source: 'widget_support', historyLines },
      status: 'pending',
    });
    await task.save();
    // воркер подхватывает задачу из БД автоматически
    res.status(202).json({ success: true, taskId: task.taskId });
  } catch (err) {
    console.error('Support chat error:', err);
    res.status(500).json({ error: 'Support chat failed' });
  }
});

module.exports = router;
