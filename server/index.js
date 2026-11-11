require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// ── Secure password hashing via Node.js built-in scrypt ──────────────────────
// Backward-compatible: old base64 passwords still work, rehashed on next login.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`scrypt$${salt}$${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  if (stored && stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    const salt = parts[1];
    const hash = parts[2];
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, key) => {
        if (err) reject(err);
        else {
          try { resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), key)); }
          catch { resolve(false); }
        }
      });
    });
  }
  // Legacy base64 migration — resolves synchronously
  return Promise.resolve(Buffer.from(password).toString('base64') === stored);
}

const { launchBrowser } = require('./browser');
const aiService = require('./AiService');
const Task = require('./models/Task');
const User = require('./models/User');
const ChatMessage = require('./models/ChatMessage');
const UserAiConfig = require('./models/UserAiConfig');
const UserAdmin = require('./models/UserAdmin');
const UserPermissions = require('./models/UserPermissions');
const checkAccess = require('./middleware/checkAccess');

// Lightweight auth: verifies API key only, no subscription check (used for payment/billing)
async function authenticateOnly(req, res, next) {
  try {
    const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!key || key.length < 16) return res.status(401).json({ error: 'API key missing' });
    const user = await User.findOne({ apiKey: key });
    if (!user) return res.status(403).json({ error: 'Invalid API key' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
const integrationsRouter = require('./routes/integrations');
const onecRouter         = require('./routes/onec');
const oauthRouter        = require('./routes/oauth');
const affiliateRouter    = require('./routes/affiliate');
const panelRouter        = require('./routes/panel');
const adminRouter        = require('./routes/admin');
const authRouter         = require('./routes/auth');
const demoRouter         = require('./routes/demo');
const configRouter       = require('./routes/config');
const dataRouter         = require('./routes/data');
const studioRouter       = require('./routes/studio');
const paymentRouter      = require('./routes/payment');
const webhooksRouter         = require('./routes/webhooks');
const tgletbotRouter         = require('./routes/tgletbot');
const notificationsRouter    = require('./routes/notifications');
const externalApiRouter      = require('./routes/externalApi');
const conversationsRouter    = require('./routes/conversations');
const notificationProcessor  = require('./notificationProcessor');
const UserIntegrations = require('./models/UserIntegrations');
const BlockedEndUser = require('./models/BlockedEndUser');
const EmbedToken = require('./models/EmbedToken');
const DemoVisitor = require('./models/DemoVisitor');

// ── Nightly sync at 04:00 ─────────────────────────────────────────────────────
;(function startNightlySync() {
  let lastRunDate = '';
  setInterval(() => {
    const now = new Date();
    if (now.getHours() !== 4 || now.getMinutes() !== 0) return;
    const dateKey = now.toDateString();
    if (dateKey === lastRunDate) return;
    lastRunDate = dateKey;
    console.log('🌙 Ночная синхронизация Google Sheets...');
    integrationsRouter.runAllSyncs().catch((err) => console.error('Ночная синхронизация:', err.message));
  }, 60000);
})();

// ── Cleanup stuck tasks every 5 minutes ───────────────────────────────────────
;(function startStuckTasksCleanup() {
  const cleanup = async () => {
    try {
      const cutoff = new Date(Date.now() - 12 * 60 * 1000); // 12 minutes
      const { modifiedCount } = await Task.updateMany(
        { status: { $in: ['pending', 'processing'] }, createdAt: { $lt: cutoff } },
        { $set: { status: 'error', error: 'Timeout: задача не была обработана за 12 минут', completedAt: new Date() } }
      );
      if (modifiedCount > 0) console.log(`🧹 Очищено зависших задач: ${modifiedCount}`);
    } catch (err) {
      console.error('Ошибка очистки зависших задач:', err.message);
    }
  };
  // Run once on startup, then every 5 minutes
  setTimeout(cleanup, 10000);
  setInterval(cleanup, 5 * 60 * 1000);
})();

// ── Подписки AiConstructor: уведомления + автопродление ──────────────────────
// Тик раз в 10 минут: шлём уведомления о конце подписки (за 7 дней, за сутки, в
// момент окончания) и списываем по окончании у тех, кто включил автопродление.
// Внутри есть защита от наложения тиков, отметки об отправленных уведомлениях и
// cooldown между попытками списания (двойного списания не будет), поэтому частый
// тик безопасен, а уведомления уходят близко к обещанному сроку.
;(function startSubscriptionScheduler() {
  const { runSubscriptionTick } = require('./helpers/recurrent');
  const tick = () => runSubscriptionTick().catch((e) => console.error('Подписки:', e.message));
  setTimeout(tick, 30 * 1000);        // первый прогон — через 30 сек после старта
  setInterval(tick, 10 * 60 * 1000);  // дальше — каждые 10 минут
})();

// Fraud-sweep живых ботов: раз в 30 мин сканируем конфиги подключённых ботов на
// скам-паттерны и шлём админам сигнал (мониторинг, не блокировка). Закрывает
// дыру, из-за которой живой скам-бот всплывал лишь если технически падал.
;(function startFraudSweep() {
  const { sweepLiveBotsForFraud } = require('./routes/tgletbot');
  const tick = () => sweepLiveBotsForFraud().catch((e) => console.error('Fraud-sweep:', e.message));
  setTimeout(tick, 90 * 1000);        // первый прогон — через 90 сек (дать боту прогреться)
  setInterval(tick, 30 * 60 * 1000);  // дальше — каждые 30 минут
})();

const app = express();
app.set('trust proxy', 1); // behind nginx

// ── Security headers ──────────────────────────────────────────────────────────
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false, // disabled — SPA loads inline scripts/styles
    crossOriginEmbedderPolicy: false,
  }));
} catch { console.warn('helmet not installed — run npm install in /server'); }

app.set('trust proxy', 1); // behind nginx

// ── CORS ──────────────────────────────────────────────────────────────────────
// Endpoints called by the embedded widget/SDK may originate from ANY customer
// domain — those get a wildcard. Dashboard and auth routes are restricted to
// the platform's own origins.
const PLATFORM_ORIGINS = [
  'https://siberi.online',
  'https://www.siberi.online',
  'http://localhost:5173',
  'http://localhost:3000',
];
const corsPlatform = cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no Origin header) and server-to-server calls
    if (!origin || PLATFORM_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
});
const corsPublic = cors({ origin: '*' });

// Widget/SDK public endpoints — allow any origin (auth handled by API key)
// app.use already matches all sub-paths; cors() handles OPTIONS preflight automatically
app.use('/api/v1/analyze', corsPublic);
app.use('/api/v1/result', corsPublic);
app.use('/api/v1/data', corsPublic);
app.use('/api/v1/ai', corsPublic); // внешний защищённый AI API — кросс-домен, защита ключом

// All other routes — platform origins only
app.use(corsPlatform);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
try {
  const rateLimit = require('express-rate-limit');

  // Auth endpoints: 10 requests per 15 min per IP
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Слишком много попыток. Подождите 15 минут.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/v1/auth/', authLimiter);

  // General API: 120 requests per minute per IP. Skip platform webhook
  // deliveries (Telegram/VK/MAX/payment) — they arrive from a small, SHARED
  // pool of server IPs covering every bot we host, not one customer's traffic,
  // so an IP-keyed limit here would throttle unrelated bots' legitimate
  // deliveries during busy periods. A throttled delivery gets no response in
  // time, which is exactly what shows up as "Connection timed out" + a ~1min
  // retry on the platform's side — indistinguishable from real network flakiness.
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.originalUrl.startsWith('/api/v1/webhook/'),
  });
  app.use('/api/v1/', apiLimiter);
} catch { console.warn('express-rate-limit not installed — run npm install in /server'); }

// ── Maintenance mode ─────────────────────────────────────────────────────────
const MAINTENANCE_FILE      = path.join(__dirname, '.maintenance');
const MAINTENANCE_WHITELIST = (process.env.MAINTENANCE_WHITELIST || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function isMaintenanceActive() {
  if (process.env.MAINTENANCE_MODE === 'true') return true;
  try { return fs.existsSync(MAINTENANCE_FILE); } catch { return false; }
}

// Status endpoint — always accessible, no auth required
app.get('/api/v1/maintenance', async (req, res) => {
  const active = isMaintenanceActive();
  let bypass = false;
  if (active) {
    const apiKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (apiKey) {
      try {
        const user = await User.findOne({ apiKey }).lean();
        if (user && MAINTENANCE_WHITELIST.includes(user.email.toLowerCase())) bypass = true;
      } catch {}
    }
  }
  res.json({ active, bypass });
});

// Maintenance gate — blocks all routes except this endpoint and OAuth redirects
app.use(async (req, res, next) => {
  if (!isMaintenanceActive()) return next();
  if (req.path === '/api/v1/maintenance') return next();
  if (req.path.startsWith('/api/v1/auth/')) return next();
  // Allow polling endpoints (no auth header, needed for support/demo result checks)
  if (req.path.startsWith('/api/v1/demo/result/')) return next();
  if (req.path === '/api/v1/payment/webhook') return next();
  if (req.path === '/api/v1/payment/tbank/webhook') return next();
  // Webhooks from external platforms must always go through — they can't auth
  if (req.path.startsWith('/api/v1/webhook/')) return next();
  if (req.path.startsWith('/api/v1/1c/push/')) return next();
  // TGLetBot Mini App ("Мои данные") authenticates via Telegram initData →
  // EmbedToken, not the website's apiKey/login — it has no way to present a
  // whitelisted apiKey, so the bypass check below would always fail for it.
  // Site maintenance is about pausing the dashboard/builder, not the bot
  // ecosystem — exempt the mini app's own session exchange and the read-only
  // data endpoints it depends on.
  if (req.path.startsWith('/api/v1/tgletbot/')) return next();
  if (req.path.startsWith('/api/v1/data/')) return next();

  const apiKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (apiKey) {
    try {
      const user = await User.findOne({ apiKey }).lean();
      if (user && MAINTENANCE_WHITELIST.includes(user.email.toLowerCase())) return next();
    } catch {}
  }
  return res.status(503).json({ maintenance: true, message: 'Технические работы. Скоро вернёмся!' });
});

app.use('/api/v1/integrations', integrationsRouter);
app.use('/api/v1/1c', onecRouter);
app.use('/api/v1/affiliate',   checkAccess, affiliateRouter);
app.use('/api/v1/panel',       checkAccess, panelRouter);
app.use('/api/v1/auth',        oauthRouter);
oauthRouter.setAiService(aiService);

// ── Extracted route modules (new modular structure) ───────────────────────────
app.use('/api/v1', adminRouter);
app.use('/api/v1', authRouter);
app.use('/api/v1', demoRouter);
app.use('/api/v1', require('./routes/lead'));   // публичная лид-форма лендинга
app.use('/api/v1', configRouter);
app.use('/api/v1', dataRouter);
app.use('/api/v1', studioRouter);
app.use('/api/v1', paymentRouter);
// ── Рубильник «лавочка закрыта» (обратимо, env-флаг) ──────────────────────────
// BOTS_DISABLED=true → @AI_ConstructorBot и ВСЕ клиентские боты (telegram/vk/max)
// молчат: апдейт получаем и ACK'аем 200 (чтобы Telegram не ретраил), но не
// обрабатываем. Платёжные вебхуки не трогаем. Файлы/данные целы — вернуть работу
// = убрать флаг и `pm2 restart siberi-api --update-env`.
app.use('/api/v1/webhook', (req, res, next) => {
  const p = req.path;
  const isBotPath = p.startsWith('/telegram/') || p.startsWith('/vk/') || p.startsWith('/max/') || p.startsWith('/tgletbot');
  if (!isBotPath) return next();

  // Полная тишина — прежний рубильник, оставлен как аварийный.
  if (process.env.BOTS_DISABLED === 'true') return res.status(200).send('OK');

  // Лавочка открыта не для всех: конструктор пускает по приглашениям (гейт
  // внутри routes/tgletbot.js, там же команды /invite), а клиентские боты
  // работают только у владельца и у приглашённых. Чужие боты, оставшиеся с
  // прежних времён, продолжают молчать — ACK'аем 200, чтобы Telegram не ретраил.
  if (process.env.BOTS_ALLOWLIST_ONLY === 'true') {
    if (p.startsWith('/tgletbot')) return next();   // у конструктора свой пофамильный гейт
    const userId = p.split('/')[2] || '';           // /telegram/:userId/:instanceId
    return require('./services/tglbAccess').allowedUserIds()
      .then((ids) => (ids.has(userId) ? next() : res.status(200).send('OK')))
      .catch(() => res.status(200).send('OK'));
  }
  next();
});
app.use('/api/v1', webhooksRouter);
app.use('/api/v1', tgletbotRouter);
app.use('/api/v1', notificationsRouter);
app.use('/api/v1', conversationsRouter);
app.use('/api/v1', externalApiRouter);

notificationProcessor.start();

// ==================== ОБРАБОТКА ОШИБОК ====================
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  aiService.shutdown().finally(() => process.exit(1));
});

process.on('SIGINT', async () => {
  console.log('🛑 Получен SIGINT, завершаю работу...');
  await aiService.shutdown();
  await mongoose.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Получен SIGTERM, завершаю работу...');
  await aiService.shutdown();
  await mongoose.disconnect();
  process.exit(0);
});

// ==================== ЭНДПОИНТЫ ====================

// Тот же гвард, что и у роутов админки — общий модуль, а не вторая копия рядом:
// здесь лежала своя, со сравнением через !==, и правка в одном месте её не
// касалась. Внутри — сравнение, постоянное по времени.
const adminGuard = require('./middleware/adminGuard');

app.all('/api/v1/confirm-auth', adminGuard, async (req, res) => {
  try {
    await aiService.confirmManualAuth();
    res.json({ success: true, message: 'Авторизация проверена' });
  } catch (err) {
    console.error('Ошибка подтверждения:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/v1/status', async (req, res) => {
  res.json({
    service: 'ai-api-gateway',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    aiService: aiService.getStatus(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ai-api-gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});


// ==================== ЗАПУСК ====================
async function startServer() {
  try {
    console.log('🚀 Инициализация AI Platform v2.0...');

    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api';
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB Connected');

    // Удаляем старый уникальный индекс userId_1 из useraiconfigs (мешает мульти-профилям)
    try {
      const col = mongoose.connection.collection('useraiconfigs');
      const indexes = await col.indexes();
      const hasOldIndex = indexes.some(i => i.name === 'userId_1' && i.unique);
      if (hasOldIndex) {
        await col.dropIndex('userId_1');
        console.log('🔧 Удалён устаревший уникальный индекс userId_1 из useraiconfigs');
      }
    } catch (idxErr) {
      console.warn('⚠️ Не удалось проверить/удалить индекс userId_1:', idxErr.message);
    }

    console.log('🌐 Запуск браузера...');
    await launchBrowser();

    const PORT = process.env.PORT || 3000;
    // Только петля: наружу сервис попадает исключительно через nginx (он и
    // проксирует на 127.0.0.1:3000 — см. /etc/nginx/sites-available/siberi).
    // На 0.0.0.0 порт был открыт всем интерфейсам, и единственным, что не давало
    // ходить в API в обход nginx и TLS, оставался файрвол.
    const HOST = process.env.HOST || '127.0.0.1';
    app.listen(PORT, HOST, () => {
      console.log(`🌐 API Gateway: http://localhost:${PORT}`);
      console.log('🔄 Инициализация AI-модуля...');
      aiService.init().catch((err) => {
        console.error('❌ Ошибка инициализации AiService:', err.message);
      });
    });
  } catch (err) {
    console.error('❌ CRITICAL START ERROR:', err);
    console.error('💡 Проверьте: 1) MongoDB запущен, 2) Edge установлен, 3) порт 9223 свободен');
    process.exit(1);
  }
}

startServer();
