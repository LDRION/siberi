'use strict';
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const Task = require('../models/Task');
const User = require('../models/User');
const aiService = require('../AiService');
const { waitForTask, isFinal } = require('../helpers/taskEvents');

const router = express.Router();

// ── Защита ключом ──────────────────────────────────────────────────────────
// Ключ в server/.env: EXTERNAL_API_KEY. Принимаем в заголовке
//   Authorization: Bearer <key>   или   X-API-Key: <key>
// Fail-closed: если ключ не задан в .env — доступ закрыт полностью.
function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}
function requireExternalKey(req, res, next) {
  const expected = process.env.EXTERNAL_API_KEY;
  if (!expected) return res.status(503).json({ error: 'External API is not configured' });
  const hdr = req.headers['authorization'] || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const provided = bearer || req.headers['x-api-key'] || '';
  if (!provided || !timingEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
}

// Отдельный лимит для внешнего API (браузерный пайплайн последователен и не быстр).
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded (30/min)' },
});

// ── Общий системный промпт (тот же «ИИ в целом», что и в /app) ──────────────
function buildSystemPrompt(userSystem, historyLines) {
  const base = (userSystem && String(userSystem).trim())
    || `Ты — Siberi, умный и дружелюбный AI-ассистент. Отвечай по существу, структурно, в markdown, на языке пользователя.`;
  return `${base}
Никогда не называй себя Mistral, GPT, Claude или другой моделью — ты Siberi.
${historyLines ? `\n## История диалога (контекст)\n${historyLines}\n` : ''}
ВОПРОС ПОЛЬЗОВАТЕЛЯ:`;
}

async function getDemoUser() {
  let u = await User.findOne({ email: 'demo@siberi.ai' });
  if (!u) {
    u = new User({
      email: 'demo@siberi.ai', passwordHash: 'demo', apiKey: 'demo-key-allow-all',
      trialStart: new Date(), subscriptionStatus: 'active',
      subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    await u.save();
  }
  return u;
}

function cleanResult(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\/?(DB_COMMAND|BOT_SETTINGS|BOT_COMMANDS|BOT_PREVIEW|WELCOME_MESSAGE|NOTIF_COMMAND)[\s\S]*?>/gi, '')
    .replace(/\[END_TEXT\]/g, '')
    .trim();
}

// ── Скриншот от внешнего клиента ────────────────────────────────────────────
// Хостинг Siberi выполняется на сервере, а промт с картинкой пишет пользователь
// на СВОЁМ компьютере — картинка обязана доехать до сервера ВНУТРИ самого запроса
// (это HTTP JSON-API, никакого общего диска/буфера обмена между машинами нет и
// быть не может). Принимаем её как base64: либо готовый data:image/...;base64,...
// (стандарт для body.image и для OpenAI-совместимого image_url.url), либо голый
// base64 без префикса — тогда считаем его PNG. Дальше картинка идёт тем же путём,
// что и вложение из /chat (aiService.pendingImages, см. routes/config.js), и
// доезжает до модели через googleai.generate({ imageBase64 }).
function normalizeImageInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^data:image\/[a-z+]+;base64,/i.test(s)) return s;
  // Голый base64 (проверяем по алфавиту, чтобы не завернуть в data-URL мусор
  // вроде случайно присланного обычного текста).
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100) {
    return `data:image/png;base64,${s.replace(/\s+/g, '')}`;
  }
  return null;
}

function buildHistoryLines(history) {
  if (!Array.isArray(history)) return '';
  return history.slice(-10).map((m) => {
    const who = (m.role === 'assistant' || m.role === 'ai') ? 'Ассистент' : 'Пользователь';
    return `${who}: ${messageText(m.content).replace(/\s+/g, ' ').slice(0, 1500)}`;
  }).join('\n');
}

// OpenAI vision-формат содержимого сообщения — МАССИВ частей вместо строки:
// [{type:"text", text:"..."}, {type:"image_url", image_url:{url:"data:image/...;base64,..."}}]
// (ровно так стандартные OpenAI SDK шлют скриншот). Раньше content просто
// заворачивался в String(...) — для массива это даёт "[object Object]" вместо
// текста, а картинка внутри терялась молча, без единой ошибки в ответе.
function messageText(content) {
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n');
  }
  return String(content ?? '');
}

// Все картинки сообщения (до 4): скриншот + увеличенный фрагмент и т.п.
function messageImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'image_url' && (p.image_url?.url || typeof p.image_url === 'string'))
    .map((p) => normalizeImageInput(p.image_url?.url || p.image_url)).filter(Boolean).slice(0, 4);
}

// body.image / body.imageBase64 (одна) или body.images (массив, до 4).
function bodyImages(body) {
  const list = Array.isArray(body.images) ? body.images : [body.image ?? body.imageBase64];
  return list.map(normalizeImageInput).filter(Boolean).slice(0, 4);
}

// Создать задачу и синхронно дождаться результата (общий хелпер).
async function runAndWait({ prompt, system, historyLines, timeoutMs, image }) {
  const demoUser = await getDemoUser();
  const task = new Task({
    taskId: uuidv4(),
    userId: demoUser._id,
    prompt,
    context: {
      source: 'external_api',
      isFirst: !historyLines,
      historyLines,
      customSystemPrompt: buildSystemPrompt(system, historyLines),
    },
    status: 'pending',
  });
  // В БД картинку не пишем (та же логика, что и у /chat в routes/config.js) —
  // только в память. Кладём ДО сохранения: сохранение сразу будит воркер.
  if (image && image.length) aiService.pendingImages.set(task.taskId, image);
  await task.save();
  // Ждём не опросом раз в 700 мс, а события сохранения задачи (helpers/taskEvents).
  const t = await waitForTask(Task, task.taskId, { timeoutMs });
  if (t && t.status === 'completed') return { ok: true, taskId: task.taskId, result: cleanResult(t.result) };
  if (t && t.status === 'error') return { ok: false, taskId: task.taskId, error: t.error || 'generation failed' };
  return { ok: false, taskId: task.taskId, timeout: true };
}

// ── POST /ai/generate ───────────────────────────────────────────────────────
// body: { prompt/message, system?, history?, wait? (default true), timeoutMs?,
//         image?/imageBase64? }
// image/imageBase64 — скриншот/картинка к промту: data:image/...;base64,... или
// голый base64 (см. normalizeImageInput). Модель реально видит вложение только
// когда основной провайдер — Google AI Mode (GOOGLEAI_TIER0=true); на остальных
// тирах картинка молча не используется (нет там ещё этого пути), чем при
// необходимости стоит заняться отдельно.
// wait=true  → синхронно ждём и возвращаем { success, result, taskId }
// wait=false → сразу { success, taskId }, забираем через GET /ai/result/:taskId
router.post('/ai/generate', requireExternalKey, aiLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = String(body.prompt ?? body.message ?? '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt (or message) is required' });

    const wait = body.wait !== false;
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 120000, 5000), 300000);
    const historyLines = buildHistoryLines(body.history);
    const image = bodyImages(body);

    const demoUser = await getDemoUser();
    const task = new Task({
      taskId: uuidv4(),
      userId: demoUser._id,
      prompt,
      context: {
        source: 'external_api',
        isFirst: !historyLines,
        historyLines,
        customSystemPrompt: buildSystemPrompt(body.system, historyLines),
      },
      status: 'pending',
    });
    if (image.length) aiService.pendingImages.set(task.taskId, image);
    await task.save();

    if (!wait) return res.status(202).json({ success: true, taskId: task.taskId });

    // Синхронное ожидание: ответ уходит в момент сохранения результата (событие задачи).
    const t = await waitForTask(Task, task.taskId, { timeoutMs });
    if (t && t.status === 'completed') {
      return res.json({ success: true, taskId: task.taskId, result: cleanResult(t.result) });
    }
    if (t && t.status === 'error') {
      return res.status(502).json({ success: false, taskId: task.taskId, error: t.error || 'generation failed' });
    }
    return res.status(504).json({ success: false, taskId: task.taskId, error: 'timeout waiting for result', note: 'poll GET /ai/result/:taskId' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /ai/result/:taskId ──────────────────────────────────────────────────
// ?waitMs=N (до 25000) — долгий опрос: ответ приходит, как только у задачи что-то
// изменилось (новый кусок partialResult или готовность), а не на следующем опросе
// клиента. Без waitMs — как раньше, сразу текущее состояние.
router.get('/ai/result/:taskId', requireExternalKey, async (req, res) => {
  try {
    let t = await Task.findOne({ taskId: req.params.taskId }).lean();
    if (!t) return res.status(404).json({ error: 'Task not found' });
    const waitMs = Math.min(Math.max(Number(req.query.waitMs) || 0, 0), 25000);
    if (waitMs && !isFinal(t)) {
      const seenPartial = t.partialResult || '';
      t = (await waitForTask(Task, t.taskId, {
        timeoutMs: waitMs,
        until: (d) => isFinal(d) || (d.partialResult || '') !== seenPartial,
      })) || t;
    }
    res.json({
      success: true,
      status: t.status,
      result: t.status === 'completed' ? cleanResult(t.result) : null,
      partialResult: t.partialResult ? cleanResult(t.partialResult) : null,
      error: t.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OpenAI-совместимо: POST /ai/chat/completions ────────────────────────────
// Позволяет подключать Siberi AI стандартными OpenAI-SDK:
//   base_url = https://siberi.online/api/v1/ai , api_key = <EXTERNAL_API_KEY> ,
//   model = "siberi-ai". Тело: { model, messages:[{role,content}], ... }
router.post('/ai/chat/completions', requireExternalKey, aiLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => messageText(m.content)).join('\n\n');
    const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    let lastUser = -1;
    for (let i = convo.length - 1; i >= 0; i--) { if (convo[i].role === 'user') { lastUser = i; break; } }
    if (lastUser === -1) {
      return res.status(400).json({ error: { message: 'no user message', type: 'invalid_request_error' } });
    }
    const prompt = messageText(convo[lastUser].content).trim();
    // Скриншот — стандартный OpenAI vision-формат: content — массив с частью
    // {type:"image_url", image_url:{url:"data:image/...;base64,..."}}.
    const image = messageImages(convo[lastUser].content);
    const historyLines = buildHistoryLines(convo.slice(0, lastUser));
    const timeoutMs = Math.min(Math.max(Number(body.timeout_ms) || 120000, 5000), 300000);

    const out = await runAndWait({ prompt, system, historyLines, timeoutMs, image });
    if (!out.ok) {
      return res.status(out.timeout ? 504 : 502).json({
        error: { message: out.timeout ? 'timeout waiting for result' : (out.error || 'generation failed'), type: 'server_error' },
      });
    }
    return res.json({
      id: 'chatcmpl-' + out.taskId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'siberi-ai',
      choices: [{ index: 0, message: { role: 'assistant', content: out.result }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
});

// OpenAI-совместимо: список моделей.
router.get('/ai/models', requireExternalKey, (req, res) => {
  res.json({ object: 'list', data: [{ id: 'siberi-ai', object: 'model', created: 1700000000, owned_by: 'siberi' }] });
});

// Health/ping для внешних интеграций (тоже под ключом).
router.get('/ai/ping', requireExternalKey, (req, res) => res.json({ success: true, ok: true, service: 'Siberi AI API', ts: Date.now() }));

module.exports = router;
