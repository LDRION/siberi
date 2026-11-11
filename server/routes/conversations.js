'use strict';
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Чат /app доступен и без платного тарифа (с дневным лимитом), поэтому здесь —
// authOnly (аутентификация без блокировки по подписке). Лимит применяем в /send.
const checkAccess = require('../middleware/authOnly');
const Task = require('../models/Task');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const ConversationMessage = require('../models/ConversationMessage');

// ─── Общий системный промпт «ИИ в целом» для /app ───
// AiService уважает context.customSystemPrompt (демо-ветка). Историю диалога
// вкладываем прямо сюда — при кастомном промпте автоинжекта historyLines нет.
function buildSystemPrompt(historyLines) {
  return `Ты — Siberi, умный и дружелюбный AI-ассистент. Помогай с чем угодно: пиши и редактируй тексты, объясняй сложное простыми словами, считай, помогай с кодом, генерируй идеи, переводи, рассуждай.
🇷🇺 ЯЗЫК: отвечай на языке пользователя (по умолчанию — русский).
Никогда не называй себя Mistral, GPT, Claude или другой моделью — ты Siberi.
Форматируй ответы в markdown: ## заголовки, списки через «- », **жирный** для важного, \`\`\` для кода. Пиши структурно и по делу, без воды и без лишних дисклеймеров.
В продолжающемся диалоге не здоровайся повторно — сразу отвечай.
${historyLines ? `\n## История диалога (для контекста)\n${historyLines}\n` : ''}
ВОПРОС ПОЛЬЗОВАТЕЛЯ:`;
}

async function getDemoUser() {
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
  return demoUser;
}

async function ownedConversation(id, userId) {
  if (!id || !id.match(/^[a-f0-9]{24}$/i)) return null;
  const conv = await Conversation.findOne({ _id: id, userId });
  return conv || null;
}

// ─── Список диалогов ───
router.get('/conversations', checkAccess, async (req, res) => {
  try {
    const items = await Conversation.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(200)
      .select('title createdAt updatedAt')
      .lean();
    res.json({ success: true, conversations: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Создать диалог ───
router.post('/conversations', checkAccess, async (req, res) => {
  try {
    const title = (req.body?.title || 'Новый чат').toString().slice(0, 80);
    const conv = await Conversation.create({ userId: req.user._id, title });
    res.status(201).json({ success: true, conversation: { _id: conv._id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Переименовать ───
router.patch('/conversations/:id', checkAccess, async (req, res) => {
  try {
    const conv = await ownedConversation(req.params.id, req.user._id);
    if (!conv) return res.status(404).json({ error: 'Диалог не найден' });
    const title = (req.body?.title || '').toString().trim().slice(0, 80);
    if (title) { conv.title = title; conv.updatedAt = new Date(); await conv.save(); }
    res.json({ success: true, title: conv.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Удалить диалог + его сообщения ───
router.delete('/conversations/:id', checkAccess, async (req, res) => {
  try {
    const conv = await ownedConversation(req.params.id, req.user._id);
    if (!conv) return res.status(404).json({ error: 'Диалог не найден' });
    await ConversationMessage.deleteMany({ conversationId: conv._id });
    await conv.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Сообщения диалога ───
router.get('/conversations/:id/messages', checkAccess, async (req, res) => {
  try {
    const conv = await ownedConversation(req.params.id, req.user._id);
    if (!conv) return res.status(404).json({ error: 'Диалог не найден' });
    const messages = await ConversationMessage.find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Отправка сообщения: сохраняем реплику пользователя, запускаем генерацию ───
// через общий демо-путь AiService (без 3/сутки лимита, без ChatMessage).
router.post('/conversations/:id/send', checkAccess, async (req, res) => {
  try {
    const conv = await ownedConversation(req.params.id, req.user._id);
    if (!conv) return res.status(404).json({ error: 'Диалог не найден' });

    const message = (req.body?.message || '').toString().trim();
    if (!message) return res.status(400).json({ error: 'Введите сообщение' });

    // Зарегистрированным — без ограничений. Сервис бесплатный: лимит (10/сутки) есть
    // только у НЕзарегистрированных гостей и живёт в demo-пути (routes/demo.js).
    // Монетизация — по индивидуальному согласованию через форму, тарифов в продукте нет.

    // Память диалога — последние сообщения в текстовом виде.
    const prior = await ConversationMessage.find({ conversationId: conv._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    // Историю держим в бюджете по символам, а не «10 реплик по 1500».
    // Причина — скорость: провайдер (services/googleai.js) отдаёт короткий промт
    // через URL и начинает печатать за ~5с, а всё, что длиннее urlLimit, уходит
    // вложением-PDF и стоит вдвое дороже по времени. Прежние 10×1500 = до 15000
    // символов гарантированно выбивали КАЖДЫЙ второй и последующий вопрос на
    // медленную дорогу. Набираем от свежих к старым, пока помещаемся.
    const HISTORY_BUDGET = 1000;
    const PER_MESSAGE = 600;
    const picked = [];
    let used = 0;
    for (const m of prior) {                       // prior уже отсортирован от новых к старым
      const who = m.role === 'user' ? 'Пользователь' : 'Ассистент';
      const line = `${who}: ${String(m.content).replace(/\s+/g, ' ').slice(0, PER_MESSAGE)}`;
      if (used + line.length > HISTORY_BUDGET) break;
      picked.push(line);
      used += line.length + 1;
    }
    const historyLines = picked.reverse().join('\n');

    const isFirst = prior.length === 0;

    // Сохраняем реплику пользователя
    await ConversationMessage.create({ conversationId: conv._id, userId: req.user._id, role: 'user', content: message });

    // Автозаголовок из первого сообщения
    if (isFirst && (!conv.title || conv.title === 'Новый чат')) {
      conv.title = message.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Новый чат';
    }
    conv.updatedAt = new Date();
    await conv.save();

    // Задача для общего демо-пути (ИИ в целом)
    const demoUser = await getDemoUser();
    const task = new Task({
      taskId: uuidv4(),
      userId: demoUser._id,
      prompt: message,
      context: {
        source: 'app_chat',
        isFirst,
        historyLines,
        customSystemPrompt: buildSystemPrompt(historyLines),
      },
      status: 'pending',
    });
    await task.save();

    res.status(202).json({ success: true, taskId: task.taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Сохранить ответ ассистента (клиент шлёт финальный текст после стрима) ───
router.post('/conversations/:id/reply', checkAccess, async (req, res) => {
  try {
    const conv = await ownedConversation(req.params.id, req.user._id);
    if (!conv) return res.status(404).json({ error: 'Диалог не найден' });
    const content = (req.body?.content || '').toString();
    if (!content.trim()) return res.status(400).json({ error: 'Пустой ответ' });
    await ConversationMessage.create({ conversationId: conv._id, userId: req.user._id, role: 'ai', content });
    conv.updatedAt = new Date();
    await conv.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
