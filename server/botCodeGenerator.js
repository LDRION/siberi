'use strict';

// Генерирует полноценный, самодостаточный проект Telegram-бота из конфигурации
// Bot Studio — пользователь может запустить его на своём сервере/локалхосте без
// какой-либо зависимости от инфраструктуры Siberi.AI. Единственное, что нужно
// пользователю — собственный токен Telegram-бота и собственный (бесплатный)
// API-ключ Groq. Ничего из наших серверов/хостинга/учётных данных в код не попадает.

function jsLiteral(value) {
  return JSON.stringify(value ?? '');
}

function buildIndexJs(cfg) {
  const aiName         = cfg.aiName || 'Помощник';
  const systemPrompt   = cfg.systemPrompt || `Ты — ${aiName}, дружелюбный AI-ассистент. Отвечай по делу, на русском языке.`;
  const restrictions   = cfg.restrictions || '';
  const welcomeMessage = cfg.botSettings?.welcomeMessage || '';
  const triggerMode    = cfg.botSettings?.triggerMode    || 'respond_all';
  const triggerKeyword = (cfg.botSettings?.triggerKeyword || '').toLowerCase().trim();
  const historyMode    = cfg.botSettings?.historyMode    || 'personal';
  // Только текст/клавиатура — медиа из схем данных и автосохранение заявок (часть
  // платформы Siberi.AI) сюда не переносятся, см. README.
  const commands = (cfg.botSettings?.commands || []).map(c => ({
    command:     c.command     || '',
    description: c.description || '',
    response:    c.response    || '',
    keyboard:    Array.isArray(c.keyboard) ? c.keyboard : null,
  }));

  return `'use strict';
// Telegram-бот «${aiName}» — экспортирован из Siberi.AI Bot Studio.
// Полностью самостоятельный код: единственные внешние сервисы — Telegram Bot API
// и Groq (для ответов AI и расшифровки голосовых). Запускается где угодно — на
// своём сервере, на локалхосте, в контейнере. Инструкция по запуску — в README.md.

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Groq = require('groq-sdk');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_KEY  = process.env.GROQ_API_KEY;
if (!BOT_TOKEN) { console.error('❌ Не задан TELEGRAM_BOT_TOKEN в .env'); process.exit(1); }
if (!GROQ_KEY)  { console.error('❌ Не задан GROQ_API_KEY в .env — получите бесплатный ключ на console.groq.com'); process.exit(1); }

const bot  = new Telegraf(BOT_TOKEN);
const groq = new Groq({ apiKey: GROQ_KEY, timeout: 15000, maxRetries: 1 });

// ── Конфигурация бота (из Bot Studio) ──────────────────────────────────────────
const AI_NAME         = ${jsLiteral(aiName)};
const SYSTEM_PROMPT    = ${jsLiteral(systemPrompt)};
const RESTRICTIONS     = ${jsLiteral(restrictions)};
const WELCOME_MESSAGE  = ${jsLiteral(welcomeMessage)};
const TRIGGER_MODE     = ${jsLiteral(triggerMode)};    // 'respond_all' | 'mention_only'
const TRIGGER_KEYWORD  = ${jsLiteral(triggerKeyword)};
const HISTORY_MODE     = ${jsLiteral(historyMode)};    // 'personal' | 'shared'
const COMMANDS = ${JSON.stringify(commands, null, 2)};

function fullSystemPrompt() {
  let p = SYSTEM_PROMPT;
  if (RESTRICTIONS) p += \`\\n\\nНе обсуждай следующие темы — вежливо уходи от них: \${RESTRICTIONS}\`;
  return p;
}

// ── Markdown → Telegram HTML (бережно конвертирует ответ AI в форматирование) ──
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mdToHtml(raw) {
  let t = escapeHtml(raw);
  t = t.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, (_, code) => \`<pre>\${code}</pre>\`);
  t = t.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  t = t.replace(/^[ \\t]*#{1,6}[ \\t]+(.*)$/gm, '<b>$1</b>');
  t = t.replace(/^[ \\t]*[*-][ \\t]+/gm, '▪️ ');
  t = t.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
  t = t.replace(/__([^_]+)__/g, '<b>$1</b>');
  t = t.replace(/\\*([^*\\n]+)\\*/g, '<i>$1</i>');
  return t;
}

// ── Память диалогов — в процессе, сбрасывается при перезапуске бота ────────────
const sessions = new Map();
const sessionKey = (ctx) => HISTORY_MODE === 'shared' ? \`chat:\${ctx.chat.id}\` : \`user:\${ctx.from.id}\`;
function getHistory(key) {
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}

// ── Меню и команды (инлайн-кнопки), как настроено в Bot Studio ─────────────────
function buildKeyboard(rows) {
  if (!Array.isArray(rows) || !rows.length) return undefined;
  return Markup.inlineKeyboard(
    rows.map(row => row.map(label => Markup.button.callback(label, label.slice(0, 64))))
  );
}
function findCommand(text) {
  const trimmed = (text || '').trim();
  const isSlash = /^\\/\\w+/.test(trimmed);
  const matchText = isSlash ? trimmed.split(/\\s+/)[0] : trimmed;
  return COMMANDS.find(c => c.command && c.command.toLowerCase() === matchText.toLowerCase()) || null;
}
async function replyToCommand(ctx, cmd, viaCallback) {
  const text = cmd.response || (cmd.command?.toLowerCase() === '/start' ? WELCOME_MESSAGE : '') || '…';
  const kb = buildKeyboard(cmd.keyboard);
  if (viaCallback) {
    await ctx.editMessageText(text, kb).catch(() => ctx.reply(text, kb));
  } else {
    await ctx.reply(text, kb);
  }
}

bot.start(async (ctx) => {
  if (WELCOME_MESSAGE) await ctx.reply(WELCOME_MESSAGE);
  else await ctx.reply(\`Привет! Я — \${AI_NAME}. Чем могу помочь?\`);
});

bot.on('callback_query', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const cmd = findCommand(ctx.callbackQuery.data || '');
  if (cmd) await replyToCommand(ctx, cmd, true);
});

// ── Голосовые сообщения → расшифровка через Groq Whisper (тот же API-ключ) ─────
async function transcribeVoice(ctx, fileId) {
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const buf  = await fetch(link.href).then(r => r.arrayBuffer());
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'ru');
    form.append('response_format', 'text');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: \`Bearer \${GROQ_KEY}\` },
      body: form,
    });
    return (await res.text()).trim();
  } catch (err) {
    console.warn('⚠️ Расшифровка голосового не удалась:', err.message);
    return '';
  }
}
bot.on('voice', async (ctx) => {
  const text = await transcribeVoice(ctx, ctx.message.voice.file_id);
  if (text) await handleIncomingText(ctx, text);
});

// ── Свободный текст → команда или AI ────────────────────────────────────────────
async function handleIncomingText(ctx, text) {
  const cmd = findCommand(text);
  if (cmd) { await replyToCommand(ctx, cmd, false); return; }

  if (TRIGGER_MODE === 'mention_only' && ctx.chat.type !== 'private') {
    const lower = text.toLowerCase();
    const byKeyword  = TRIGGER_KEYWORD && lower.startsWith(TRIGGER_KEYWORD);
    const byUsername = ctx.botInfo?.username && lower.includes(\`@\${ctx.botInfo.username.toLowerCase()}\`);
    if (!byKeyword && !byUsername) return;
  }

  const key = sessionKey(ctx);
  const history = getHistory(key);

  await ctx.sendChatAction('typing').catch(() => {});
  try {
    const completion = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      messages:    [{ role: 'system', content: fullSystemPrompt() }, ...history.slice(-14), { role: 'user', content: text }],
      max_tokens:  1024,
      temperature: 0.6,
    });
    const reply = completion.choices[0]?.message?.content?.trim() || 'Извините, не получилось сформулировать ответ.';
    history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, history.length - 20);
    await ctx.replyWithHTML(mdToHtml(reply)).catch(() => ctx.reply(reply));
  } catch (err) {
    console.error('❌ Ошибка AI:', err.message);
    await ctx.reply('Извините, что-то пошло не так. Попробуйте ещё раз.');
  }
}
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/') && ctx.message.text.toLowerCase().startsWith('/start')) return;
  await handleIncomingText(ctx, ctx.message.text);
});

bot.launch().then(() => console.log(\`🤖 \${AI_NAME} запущен\`));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
`;
}

function buildPackageJson(cfg) {
  const name = (cfg.aiName || 'my-telegram-bot')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'telegram-bot';
  return JSON.stringify({
    name,
    version: '1.0.0',
    private: true,
    description: 'Telegram-бот, экспортированный из Siberi.AI Bot Studio',
    scripts: { start: 'node index.js' },
    engines: { node: '>=18.0.0' },
    dependencies: {
      telegraf: '^4.16.3',
      'groq-sdk': '^1.2.1',
      dotenv: '^16.4.5',
    },
  }, null, 2) + '\n';
}

function buildEnvExample() {
  return `# Токен вашего Telegram-бота — получите у @BotFather в Telegram
TELEGRAM_BOT_TOKEN=

# Бесплатный API-ключ Groq — получите на https://console.groq.com/keys
GROQ_API_KEY=
`;
}

function buildReadme(cfg) {
  const aiName = cfg.aiName || 'Помощник';
  return `# ${aiName} — Telegram-бот

Экспортирован из **Siberi.AI Bot Studio**. Полностью самостоятельный код —
работает на любом сервере или локалхосте, без зависимости от платформы Siberi.AI.

## Что включено

- Меню и команды с инлайн-кнопками — ровно как настроено в Bot Studio
- AI-ответы на свободные вопросы по вашему системному промту
- Расшифровка голосовых сообщений (через Groq Whisper)
- Память диалога (личная или общая на чат — как выбрано в настройках)

## Что НЕ включено

Эти возможности завязаны на данные внутри вашего аккаунта Siberi.AI и не
переносятся в самостоятельный код:
- Автоматическое сохранение заявок/записей в базу данных
- Показ фото и файлов из ваших схем данных (Мои данные)

Если они нужны — добавьте свою логику в \`index.js\` (см. функцию \`handleIncomingText\`)
или подключите свою базу данных.

## Запуск

1. Установите [Node.js](https://nodejs.org/) версии 18 или новее
2. Распакуйте архив и откройте папку в терминале
3. Установите зависимости:
   \`\`\`
   npm install
   \`\`\`
4. Скопируйте \`.env.example\` в файл \`.env\` и заполните:
   - \`TELEGRAM_BOT_TOKEN\` — получите у [@BotFather](https://telegram.me/BotFather) в Telegram
   - \`GROQ_API_KEY\` — бесплатный ключ на [console.groq.com/keys](https://console.groq.com/keys)
5. Запустите бота:
   \`\`\`
   npm start
   \`\`\`

Готово — бот работает. Можно запускать на своём VPS, домашнем сервере или через
любой Node.js-хостинг (процесс должен работать постоянно, например через PM2 или
системный сервис).
`;
}

function generateBotProject(cfg) {
  return {
    'index.js':       buildIndexJs(cfg),
    'package.json':   buildPackageJson(cfg),
    '.env.example':   buildEnvExample(),
    'README.md':      buildReadme(cfg),
  };
}

module.exports = { generateBotProject };
