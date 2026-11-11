const { chromium } = require('playwright');
const Groq = require('groq-sdk');
const Task = require('./models/Task');
const UserAiConfig = require('./models/UserAiConfig');
const User = require('./models/User');
const { MISTRAL_URL, DEBUG_DIR, takeDebugScreenshot, loadAuthState } = require('./browser');
const { executeMongoCommand } = require('./mongoExecutor');
const QwenService = require('./QwenService');
const UserRecordSnapshot = require('./models/UserRecordSnapshot');
const { writeBackToSource } = require('./routes/integrations');

require('dns').setDefaultResultOrder('ipv4first');

// Резерв Qwen ВЫКЛЮЧЕН по умолчанию (решение владельца 19.07.2026): он режется
// Cloudflare 1015 и валил 24 запроса из 44, а любой сбой Mistral защёлкивал на
// него всю систему до ручного рестарта. Код резерва цел — вернуть одной строкой
// `QWEN_FALLBACK=on` в server/.env.
const QWEN_FALLBACK_ENABLED = process.env.QWEN_FALLBACK === 'on';
// BROWSER_FALLBACKS=off — работают только режим ИИ Google и Groq по API: вкладки UltraGPT,
// Mistral и Qwen не открываются, их ярусы пропускаются. Код провайдеров остаётся на месте.
const BROWSER_FALLBACKS_OFF = process.env.BROWSER_FALLBACKS === 'off';
const fallbacksOff = () => new Error('браузерные провайдеры выключены (BROWSER_FALLBACKS=off)');

// Заглушка Cloudflare вместо чата. И Mistral, и Qwen стоят за Cloudflare, так что
// при частых запросах вкладку уводит на страницу 1015 «You are being rate limited».
// Генерации там не будет НИКОГДА — такую вкладку надо не ждать, а выбрасывать.
// Это же и есть причина «Mistral: генерация зависла» (инцидент 19.07).
const DEAD_TAB_URL_RE = /cloudflare\.com|challenges\.cloudflare|\/error-\d{3,}/i;

// Восстанавливает JSON, который LLM сгенерировал со смешанными кавычками
function fixMalformedJson(raw) {
  // Шаг 1: заменяем одиночные кавычки на двойные
  let s = raw.replace(/'/g, '"');

  // Шаг 2: убираем trailing запятые перед } или ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  // Шаг 3: восстанавливаем усечённый JSON (обрезан на полуслове)
  // Закрываем незакрытую строку если последний символ не " или }
  const trimmed = s.trimEnd();
  if (trimmed && !trimmed.endsWith('}') && !trimmed.endsWith(']') && !trimmed.endsWith('"')) {
    // Обрезаем до последней завершённой пары ключ:значение
    const lastComma = trimmed.lastIndexOf(',');
    const lastColon = trimmed.lastIndexOf(':');
    // Если последняя запятая стоит после последнего двоеточия — обрезаем после запятой
    if (lastComma > lastColon && lastComma > 0) {
      s = trimmed.slice(0, lastComma);
    } else if (lastColon > 0) {
      // Обрезаем до последнего ключа целиком
      s = trimmed.slice(0, trimmed.lastIndexOf('"', lastColon - 1));
      if (s.endsWith(',')) s = s.slice(0, -1);
    }
  }

  // Шаг 4: закрываем незакрытые скобки
  const opens = [];
  let inStr = false, escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') opens.push('}');
    else if (ch === '[') opens.push(']');
    else if (ch === '}' || ch === ']') opens.pop();
  }
  s = s + opens.reverse().join('');

  return s;
}

const getDemoChatId = () => process.env.DEMO_CHAT_ID_MISTRAL || process.env.DEMO_CHAT_ID || '';
const getDemoQwenId = () => process.env.DEMO_CHAT_ID_QWEN    || '';

// Groq SDK's own `timeout` option only covers time-to-first-byte — it's cleared the
// moment fetch() resolves with response headers, so a stream that starts fine and then
// goes silent mid-way is NOT caught by it. This wraps any async-iterable stream and
// throws if any single chunk takes longer than `stallMs` to arrive, so a mid-stream
// hang fails over to Mistral/Qwen just as fast as an outright connection failure.
async function* withStallTimeout(stream, stallMs) {
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Groq stream stalled — no data for ${stallMs}ms`)), stallMs)),
    ]);
    if (result.done) return;
    yield result.value;
  }
}

class AiService {
  constructor() {
    this.masterBrowser = null;
    this.profileContext = null;
    this.userContexts = new Map();
    this.isReady = false;
    this.processingTasks = new Set();
    this._notifProcessing = 0; // сколько НИЗКОПРИОРИТЕТНЫХ задач-уведомлений/отчётов сейчас в работе
    this.initPromise = null;
    this.authState = null;
    this.demoContext = null;
    this.demoPage = null;
    this.demoWarmChatId = null;
    this.sparePage = null;        // pre-loaded, idle Mistral tab ready for instant handoff
    this._sparePagePreparing = false;

    // ── Пул прогретых вкладок Mistral (масштабирование параллельной обработки) ──
    // Каждая вкладка обслуживает РОВНО ОДИН запрос: от вставки промта до чтения
    // ответа. Ответ читается из ТОЙ ЖЕ страницы (по messagesBefore) → запросы
    // физически не могут перепутаться. Прогреваем POOL_WARM заранее; под нагрузкой
    // дорастаем до POOL_MAX; если все заняты — запрос ждёт в очереди. Чаты Mistral
    // stateless (историю подаём из нашей БД), поэтому любая вкладка обслужит любой
    // запрос. Логика: «хватает одной — идём одной; занята — прыгаем на вторую… до N».
    // Потолок = 3: проверено стресс-тестом — один Mistral-аккаунт устойчиво тянет
    // ровно 3 параллельные генерации; на 4–5 начинает троттлить/виснуть. Роутинг
    // при этом никогда не путается. Меняется через MISTRAL_POOL_SIZE.
    this.mistralPoolMax  = Math.max(1, parseInt(process.env.MISTRAL_POOL_SIZE, 10) || 3);
    this.mistralPoolWarm = Math.min(this.mistralPoolMax, Math.max(1, parseInt(process.env.MISTRAL_POOL_WARM, 10) || 3));
    this.poolFree    = [];         // свободные прогретые страницы
    this.poolAll     = new Set();  // все страницы пула (free + busy + cleaning)
    this.poolWaiters = [];         // ожидающие свободную вкладку (resolve-функции)
    this.poolPending = 0;          // сколько вкладок сейчас прогревается (защита от гонок)
    this._poolFilling = false;
    // Буфер обмена ОС — ОДИН на весь браузер. Отправка промта = «copy → Ctrl+V»,
    // и при параллельной работе вкладок эти секции нельзя перекрывать (иначе одна
    // вставит чужой промт). Сериализуем ТОЛЬКО эту короткую секцию (~300мс) —
    // долгое ожидание ответа остаётся полностью параллельным.
    this._clipboardLock = Promise.resolve();

    this.contextCreationPromises = new Map();
    this.pendingImages = new Map(); // taskId → base64 image (never persisted to DB)
    this.bulkDocJobs   = new Map(); // token  → { buf, filename, count, expires }
    this.qwen = null;
    this.forceQwen = process.env.FORCE_QWEN === 'true';
    this._workerStarted = false; // гарантируем однократный запуск воркера
    this.mistralDownSince = null;       // timestamp первого падения Mistral
    this._mistralHealthInterval = null; // интервал авто-восстановления

    // ── Groq — приоритет №1 (быстрый реальный API, до Mistral/Qwen) ──────────
    // timeout короткий и maxRetries: 0 — нужно понять, что Groq не отвечает, и сразу
    // переключиться на Mistral/Qwen, а не ждать дефолтную 1 минуту × 2 повтора SDK.
    this.groq = process.env.GROQ_API_KEY
      ? new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 6000, maxRetries: 0 })
      : null;
    this.forceGroqOff = process.env.FORCE_GROQ_OFF === 'true'; // принудительно выключить Groq (тест)
    this.groqDownSince = null;
    this._groqHealthInterval = null;
  }

  // Переключить принудительный режим Qwen (для тестирования)
  setForceQwen(value) {
    this.forceQwen = !!value;
    console.log(`🔧 Режим ${this.forceQwen ? '⚡ QWEN FALLBACK (тест)' : '✅ Mistral (норм)'} активирован`);
  }

  // Принудительно выключить Groq (для тестирования цепочки Mistral→Qwen)
  setForceGroqOff(value) {
    this.forceGroqOff = !!value;
    console.log(`🔧 Groq ${this.forceGroqOff ? '⛔ ВЫКЛЮЧЕН (тест)' : '✅ включён (норм)'}`);
  }

  // ── Автопереключение на Qwen при падении Mistral ──────────────────────────

  async _onMistralDown() {
    // Qwen отключён → НЕ защёлкиваемся на резерв. Раньше одна зависшая генерация
    // переводила ВСЕХ пользователей на Qwen, и система там залипала (health-check
    // не возвращал Mistral ни разу из 25). Теперь падает только этот запрос, а
    // следующий снова идёт в Mistral со свежей вкладкой пула — это честнее и
    // заметно надёжнее, чем сидеть на режущемся Cloudflare резерве.
    if (!QWEN_FALLBACK_ENABLED) {
      console.warn('⚠️ Mistral дал сбой на этом запросе. Qwen отключён — остаёмся на Mistral, следующий запрос пойдёт со свежей вкладкой.');
      return;
    }
    if (this.mistralDownSince) return; // уже переключены
    this.mistralDownSince = Date.now();
    this.forceQwen = true;
    console.warn('🔴 Mistral недоступен — переключаюсь на Qwen. Запускаю health-check каждые 10 мин.');

    // Lazy-init Qwen страницы (первый раз)
    if (this.qwen && !this.qwen.demoPage) {
      this.qwen.getDemoPage().catch((e) => console.warn('⚠️ Qwen init при failover:', e.message));
    }

    this._startMistralHealthCheck();
    this._startTabJanitor();
  }

  // ── Уборщик осиротевших вкладок ───────────────────────────────────────────
  // Инцидент 19.07: за 9 дней аптайма браузера накопилось 12 вкладок с
  // Cloudflare Error 1015 — Qwen пересоздаёт свою demoPage при поломке, но
  // close() на протухшей после реконнекта ссылке молча падает в .catch(), и
  // вкладка остаётся сиротой. 19 вкладок = 2.7 ГБ RAM → свободно 178 МБ →
  // ложилось всё, включая Mistral.
  //
  // Закрываем ТОЛЬКО заведомо мёртвые страницы (заглушки Cloudflare) — они
  // никогда не бывают рабочими. Живые вкладки чата не трогаем: неверно закрытая
  // вкладка оборвала бы чужую генерацию.
  _startTabJanitor() {
    if (this._tabJanitorInterval) return;
    const sweep = async () => {
      try {
        const ctxs = this.masterBrowser?.contexts?.() || [];
        if (!ctxs.length) return;
        let killed = 0;
        let totalPages = 0;
        for (const ctx of ctxs) {                       // ВСЕ контексты, не только [0]
          const pages = ctx.pages();
          totalPages += pages.length;
          for (const p of pages) {
            try {
              if (p.isClosed()) continue;
              if (!DEAD_TAB_URL_RE.test(p.url() || '')) continue;
              // Вкладка могла быть в пуле — иначе пул считал бы её живой и
              // выдавал бы дохлую страницу следующему запросу.
              this.poolAll.delete(p);
              const i = this.poolFree.indexOf(p);
              if (i !== -1) this.poolFree.splice(i, 1);
              if (this.demoPage === p) this.demoPage = null;
              if (this.sparePage === p) this.sparePage = null;
              await p.close().catch(() => {});
              killed++;
            } catch {}
          }
        }
        if (killed) {
          console.warn(`🧹 Уборщик вкладок: закрыто мёртвых (Cloudflare-заглушки): ${killed}`);
          if (process.env.GOOGLEAI_TIER0 !== 'true') this._ensureMistralPool?.().catch(() => {});   // добить пул свежими
        }
        await this._closeIdleFallbackTabs(ctxs).catch((e) => console.warn('⚠️ Уборка запасных вкладок:', e.message));
        if (totalPages > 12) console.warn(`⚠️ Вкладок в браузере: ${totalPages} — подозрение на утечку`);
      } catch {}
    };
    this._tabJanitorInterval = setInterval(sweep, 5 * 60 * 1000);
    if (this._tabJanitorInterval.unref) this._tabJanitorInterval.unref();
    sweep().catch(() => {});                            // сразу, не ждать первые 5 мин
  }

  // Google AI — основной провайдер, Mistral только запасной. Его вкладки, простаивающие
  // дольше 10 минут, закрываем, а осиротевшие (страницы входа и т.п., которых нет ни в
  // пуле, ни у пользователей) — сразу. Живой случай 11.10.2026: три вкладки Mistral,
  // открытые фолбэком 6 октября, пять дней держали 2,1 ГБ памяти, одна крутила процессор
  // на 98%, страница входа зависла — сервер ушёл в подкачку, и тормозил сам Google AI,
  // а новое подключение Playwright к браузеру висело на зависшей вкладке. Понадобится
  // Mistral — пул откроет вкладку заново (_acquireMistralPage проверяет живость).
  // Вкладки пользователей (userContexts) и занятые вкладки пула не трогаем.
  async _closeIdleFallbackTabs(ctxs) {
    if (process.env.GOOGLEAI_TIER0 !== 'true') return;
    const IDLE_MS = 10 * 60 * 1000;
    let closed = 0;
    for (let i = this.poolFree.length - 1; i >= 0; i -= 1) {
      const p = this.poolFree[i];
      if (Date.now() - (p.__freedAt || 0) < IDLE_MS) continue;
      this.poolFree.splice(i, 1);
      this.poolAll.delete(p);
      await p.close().catch(() => {});
      closed++;
    }
    const keep = new Set([...this.poolAll, this.demoPage, this.sparePage].filter(Boolean));
    for (const u of this.userContexts.values()) if (u?.page) keep.add(u.page);
    for (const ctx of ctxs) {
      for (const p of ctx.pages()) {
        if (p.isClosed() || keep.has(p) || !/mistral\.ai/i.test(p.url() || '')) continue;
        await p.close().catch(() => {});
        closed++;
      }
    }
    if (closed) console.log(`🧹 Google AI основной — закрыто простаивающих вкладок Mistral: ${closed}`);
  }

  // ── Периодическая проверка возврата Mistral ───────────────────────────────

  _startMistralHealthCheck() {
    if (this._mistralHealthInterval) return;
    this._mistralHealthInterval = setInterval(async () => {
      if (!this.forceQwen) return;
      console.log('🔍 Health-check: проверяю Mistral...');
      try {
        // Инцидент 19.07: проверка проваливалась 25 раз из 25 и НИ РАЗУ не вернула
        // Mistral — система залипала на Qwen (а он режется Cloudflare, 24 провала
        // против 20 успехов) до ручного рестарта. Причины было две:
        // (1) бюджеты 15с/8с малы для холодной загрузки тяжёлого SPA под нагрузкой
        //     — сам пул греет вкладку ~9-10с, так что 8с на весь чат-интерфейс
        //     гарантировали провал;
        // (2) при `demoPage === null` (после реконнекта CDP) проверка молча
        //     выходила и не пробовала снова.
        // Ошибку больше не глотаем — без неё причина была не видна в логах.
        let page = this.demoPage;
        if (!page || page.isClosed?.()) {
          const ctx = this.masterBrowser?.contexts?.()[0];
          if (!ctx) throw new Error('нет контекста браузера');
          page = await ctx.newPage();
          this.demoPage = page;
        }
        await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._waitForChatInterface(page, 25000);
        // Mistral снова доступен
        this.forceQwen = false;
        this.mistralDownSince = null;
        clearInterval(this._mistralHealthInterval);
        this._mistralHealthInterval = null;
        console.log('🟢 Mistral вернулся! Основной провайдер восстановлен.');
      } catch (e) {
        const mins = Math.round((Date.now() - this.mistralDownSince) / 60000);
        console.log(`⏳ Mistral недоступен уже ${mins} мин (${e.message.slice(0, 120)}), продолжаю с Qwen.`);
      }
    }, 10 * 60 * 1000);
  }

  // Определить, что ошибка вызвана недоступностью Mistral, а не багом в коде
  _isMistralDown(err) {
  const m = (err.message || '').toLowerCase();
  return (
    m.includes('net::err') ||
    m.includes('navigation timeout') ||
    m.includes('timeout') && (m.includes('goto') || m.includes('navigation')) ||
    m.includes('target closed') ||
    m.includes('context was destroyed') ||
    m.includes('не удалось создать чат') ||
    m.includes('failed to create chat') ||
    m.includes('ответ пустой') ||
    m.includes('текст пуст') ||
    m.includes('empty response') ||
    m.includes('промт не доставлен') ||
    m.includes('не добавил новое сообщение') ||
    m.includes('браузер отключился') ||
    m.includes('достигнут лимит сообщений') ||
    m.includes('rate limit') ||
    m.includes('генерация зависла') ||
    err.name === 'TimeoutError' ||
    // 🔥 НОВОЕ: ошибки селекторов / UI изменений
    m.includes('strict mode violation') ||      // Playwright: multiple elements
    m.includes('locator not found') ||          // Playwright: элемент не найден
    m.includes('elementhandle.waitfor') ||      // Playwright: waitForSelector failed
    m.includes('timeout 30000ms waiting for') || // Playwright: общий таймаут селектора
    m.includes('error: element not found') ||   // Общий паттерн
    (m.includes('selector') && m.includes('not found'))
  );
}

  // ── Автопереключение на Mistral/Qwen при падении Groq (приоритет №1) ─────

  async _onGroqDown() {
    if (this.groqDownSince) return; // уже переключены
    this.groqDownSince = Date.now();
    console.warn('🔴 Groq недоступен — переключаюсь на Mistral/Qwen. Запускаю health-check каждые 5 мин.');
    this._startGroqHealthCheck();
  }

  _startGroqHealthCheck() {
    if (this._groqHealthInterval) return;
    this._groqHealthInterval = setInterval(async () => {
      if (!this.groqDownSince || !this.groq) return;
      console.log('🔍 Health-check: проверяю Groq...');
      try {
        await this.groq.chat.completions.create({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
          reasoning_effort: 'low',
        });
        this.groqDownSince = null;
        clearInterval(this._groqHealthInterval);
        this._groqHealthInterval = null;
        console.log('🟢 Groq вернулся! Снова приоритет №1.');
      } catch {
        const mins = Math.round((Date.now() - this.groqDownSince) / 60000);
        console.log(`⏳ Groq недоступен уже ${mins} мин, продолжаю с Mistral/Qwen.`);
      }
    }, 5 * 60 * 1000);
  }

  // Определить, что ошибка Groq означает «провайдер недоступен» (лимиты/перегрузка/сеть),
  // а не баг в промте — отличается от Mistral/Qwen: это реальный API с HTTP-статусами.
  _isGroqDown(err) {
    const status = err?.status || err?.response?.status;
    const m = (err.message || '').toLowerCase();
    return (
      status === 429 || status === 500 || status === 502 || status === 503 || status === 529 ||
      m.includes('rate limit') || m.includes('quota') || m.includes('overloaded') ||
      m.includes('timeout') || m.includes('timed out') || m.includes('stalled') ||
      m.includes('econnreset') || m.includes('enotfound') || m.includes('network') ||
      m.includes('connection error')
    );
  }

  // Стриминговый запрос к Groq для демо-потока (быстрее и без браузерной автоматизации)
  // Стриминговый запрос к Groq — общий для demo-потока и основного агентного потока.
  // maxTokens выше для основного потока: ответы там могут включать DB_COMMAND/BULK_DOC JSON.
  //
  // llama-3.3-70b-versatile сняли с Groq (модель отдавала 404 "does not exist" на
  // КАЖДЫЙ вызов — Groq-тир фолбэка был мёртв полностью, недели подряд, судя по
  // логам). openai/gpt-oss-120b — reasoning-модель: часть max_tokens уходит в
  // скрытое рассуждение (поле reasoning), а не в видимый content — без
  // reasoning_effort:'low' 5-10 токенов на health-check съедались рассуждением
  // целиком, content оставался пустым. Тот же риск и здесь при маленьком maxTokens.
  async _streamGroq(task, systemPrompt, maxTokens, onPartialText) {
    const stream = await this.groq.chat.completions.create({
      model:       'openai/gpt-oss-120b',
      messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: task.prompt }],
      max_tokens:  maxTokens,
      reasoning_effort: 'low',
      temperature: 0.6,
      stream:      true,
    });

    let fullText = '';
    let lastUpdate = 0;
    for await (const chunk of withStallTimeout(stream, 10000)) {
      fullText += chunk.choices[0]?.delta?.content || '';
      const now = Date.now();
      if (onPartialText && now - lastUpdate > 400) {
        lastUpdate = now;
        await onPartialText(fullText);
      }
    }
    return fullText.trim();
  }

  resetInactivityTimer(userId) {
    userId = userId.toString();
    const ctx = this.userContexts.get(userId);
    if (ctx && ctx.inactivityTimer) {
      clearTimeout(ctx.inactivityTimer);
    }

    if (ctx) {
      ctx.inactivityTimer = setTimeout(
        async () => {
          console.log(`⏳ Контекст ${userId} простаивает 10 мин, очищаю...`);
          await this.destroyUserContext(userId);
        },
        10 * 60 * 1000
      ); // 10 минут — достаточно для активного пользователя
    }
  }

  async ensureUserContextReady(userId, userEmail, chatId) {
    userId = userId.toString();
    if (!this.isReady) return;
    // Только сбрасываем таймер если контекст уже существует.
    // НЕ создаём контекст при пинге — только при реальном запросе.
    // Это нужно чтобы не плодить вкладки браузера без реальных запросов.
    if (this.userContexts.has(userId)) {
      this.resetInactivityTimer(userId);
    }
  }

  // ==================== ИНИЦИАЛИЗАЦИЯ ====================

  async init() {
    if (this.initPromise) return this.initPromise;

    // Воркер стартует сразу — tick() ждёт isReady=true внутри, не блокируя запуск
    this.startWorker();

    this.initPromise = (async () => {
      console.log('🚀 Mistral AI Gateway: Старт...');

      try {
        // После pm2 restart Edge держит CDP ~36с пока не завершит cleanup старого процесса.
        // WS коннектится сразу, но CDP протокол доступен только после cleanup.
        // Таймаут 45с надёжно покрывает этот период.
        this.masterBrowser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 45000 });
        console.log('✅ Подключено к браузеру через CDP');

        // Уборщик — ВСЕГДА, с момента подключения. Раньше он стартовал только из
        // _onMistralDown(), а после отключения Qwen тот выходит ранним return —
        // и уборщик переставал запускаться вовсе: мёртвые вкладки копились
        // (6 заглушек за пару часов), забивая браузер. Утечка не связана с тем,
        // упал Mistral или нет, поэтому и чистка не должна от этого зависеть.
        this._startTabJanitor();

        this.masterBrowser.on('disconnected', () => {
          console.error('❌ Браузер отключился!');
          this.isReady = false;
          this.profileContext = null;
          this.userContexts.clear();
          this.demoContext = null;
          this.demoPage = null;
          this.sparePage = null;
          // Сбрасываем пул: страницы мертвы вместе с браузером. Ожидающих будим
          // с null → их запрос уйдёт на Qwen (см. проверку в processTask).
          this.poolFree = [];
          this.poolAll = new Set();
          this.poolPending = 0;
          const waiters = this.poolWaiters; this.poolWaiters = [];
          waiters.forEach((w) => { try { w(null); } catch {} });
          setTimeout(() => this._reconnect(), 5000);
        });

        this.masterBrowser.on('targetcrashed', (target) => {
          console.error('❌ Страница упала:', target.url?.() || 'unknown');
        });

        this.profileContext = this.masterBrowser.contexts()[0];
        console.log('✅ Профильный контекст браузера готов');

        // Закрываем все вкладки из предыдущей сессии (накапливаются при рестартах Edge)
        const _stalePages = this.profileContext.pages();
        if (_stalePages.length > 0) {
          console.log(`🧹 Закрываю ${_stalePages.length} вкладок из предыдущей сессии...`);
          // close() служебной вкладки Edge (edge://nurturing — реклама мобильного
          // приложения) может не вернуться никогда, и тогда воркер так и не стартует:
          // задачи копятся в pending. Ждём не дольше 5с, лишняя вкладка не мешает.
          await Promise.race([
            Promise.allSettled(_stalePages.map(p => p.close())),
            new Promise(r => setTimeout(r, 5000)),
          ]);
        }

        // Прогрев Mistral (демо-контекст + запасная вкладка + пул) — ТОЛЬКО если
        // Mistral реально используется. При AI_PROVIDER=ultragpt генерация идёт
        // через app.ultragpt.pro, а Mistral — лишь ленивый аварийный фолбэк
        // (вкладка откроется на лету, только если UltraGPT упадёт). Так при старте
        // не плодятся лишние вкладки chat.mistral.ai.
        if (process.env.AI_PROVIDER !== 'ultragpt') {
          try {
            await this._initDemoContext();
          } catch (demoErr) {
            console.warn('⚠️ Демо-контекст не загрузился при старте, будет создан при первом запросе:', demoErr.message);
          }
          this._prepareSparePage();
          this._ensureMistralPool();
        } else {
          console.log(BROWSER_FALLBACKS_OFF
            ? '🟢 BROWSER_FALLBACKS=off — только режим ИИ Google и Groq, вкладки UltraGPT и Mistral не открываются'
            : '🟣 AI_PROVIDER=ultragpt — прогрев вкладок Mistral пропущен');
        }

        this.qwen = new QwenService(this.masterBrowser);
        console.log('✅ Qwen резерв готов (инициализируется при необходимости)');

        this.isReady = true;
        console.log('✅ Готов к работе');
        return true;
      } catch (err) {
        console.error('❌ Ошибка инициализации:', err.message);
        this.isReady = false;
        setTimeout(() => this._reconnect(), 5000);
        return false;
      }
    })();

    return this.initPromise;
  }

  async _reconnect() {
    if (this.isReady) return;
    console.log('🔄 Автоматическое переподключение к браузеру...');
    try {
      this.masterBrowser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 15000 });
      this.profileContext = this.masterBrowser.contexts()[0];
      // Закрываем все вкладки из предыдущей сессии
      const _staleR = this.profileContext.pages();
      if (_staleR.length > 0) {
        console.log(`🧹 Реконнект: закрываю ${_staleR.length} старых вкладок...`);
        await Promise.allSettled(_staleR.map(p => p.close()));
      }
      this.masterBrowser.on('disconnected', () => {
        console.error('❌ Браузер отключился!');
        this.isReady = false;
        this.profileContext = null;
        this.userContexts.clear();
        this.demoContext = null;
        this.demoPage = null;
        this.sparePage = null;
        this.poolFree = [];
        this.poolAll = new Set();
        this.poolPending = 0;
        const waiters = this.poolWaiters; this.poolWaiters = [];
        waiters.forEach((w) => { try { w(null); } catch {} });
        setTimeout(() => this._reconnect(), 5000);
      });
      if (process.env.AI_PROVIDER !== 'ultragpt') {
        try { await this._initDemoContext(); } catch (e) { console.warn('⚠️ Демо не загрузился при реконнекте:', e.message); }
      }
      // Если init упал ДО создания Qwen (напр. connectOverCDP timeout), this.qwen
      // остаётся null, и без этого резерв Qwen никогда бы не появился → фолбэк на
      // Qwen падал с «reading 'process' of null». Создаём его здесь при нужде.
      if (this.qwen) this.qwen.browser = this.masterBrowser;
      else { this.qwen = new QwenService(this.masterBrowser); console.log('✅ Qwen резерв создан при реконнекте'); }
      this.isReady = true;
      if (process.env.AI_PROVIDER !== 'ultragpt') {
        this._prepareSparePage();
        this._ensureMistralPool(); // заново прогреваем пул после реконнекта
      }
      console.log('✅ Переподключено к браузеру');
      // Если воркер не был запущен (init провалился ранее) — запускаем сейчас
      this.startWorker();
    } catch (err) {
      console.error('❌ Переподключение не удалось:', err.message, '— повтор через 10с');
      setTimeout(() => this._reconnect(), 10000);
    }
  }

  // Резерв Qwen «по требованию»: если по какой-то причине (провал init до его
  // создания) this.qwen == null, но браузер уже есть — создаём. Гарантирует, что
  // фолбэк Mistral→Qwen никогда не падает с «reading 'process' of null».
  _getQwen() {
    // Qwen ОТКЛЮЧЁН (решение владельца 19.07.2026). Код резерва оставлен целиком,
    // включается обратно одной переменной: QWEN_FALLBACK=on в server/.env.
    // Причина по данным суток: Qwen режется Cloudflare (Error 1015) и валит 24
    // запроса из 44, а любое падение Mistral раньше ЗАЩЁЛКИВАЛО систему на Qwen
    // до ручного рестарта (health-check возвращал Mistral 0 раз из 25) — то есть
    // резерв делал хуже, чем его отсутствие. Mistral надёжнее в одиночку.
    if (!QWEN_FALLBACK_ENABLED) {
      throw new Error('Qwen отключён (QWEN_FALLBACK=off) — работаем только на Mistral');
    }
    if (!this.qwen && this.masterBrowser) {
      this.qwen = new QwenService(this.masterBrowser);
      console.log('✅ Qwen резерв создан по требованию (был null)');
    }
    if (!this.qwen) throw new Error('Резерв Qwen недоступен — браузер не готов'); // чистая ошибка вместо null.process
    return this.qwen;
  }

  async _initDemoContext() {
    if (BROWSER_FALLBACKS_OFF) return;
    if (!this.profileContext) throw new Error('profileContext не готов — браузер ещё не подключён');
    console.log('🎭 Инициализация демо-контекста...');
    this.demoContext = this.profileContext;
    this.demoPage = await this.demoContext.newPage();
    await this.demoPage.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('✅ Демо-контекст готов');
  }

  // Создаёт прогретый чат: homepage → "Готов?" → ответ "OK" → чат открыт и ждёт запроса.
  // Возвращает chatId или null при ошибке.
  async _prepareWarmChat(page) {
    if (this.demoWarmChatPreparing) return null;
    this.demoWarmChatPreparing = true;
    try {
      // Удаляем старый прогретый чат перед созданием нового
      if (this.demoWarmChatId) {
        await this._deleteMistralChat(page, this.demoWarmChatId).catch(() => {});
        this.demoWarmChatId = null;
      }
      console.log('🔥 Прогреваю чат Mistral...');
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(400);

      // Отправляем короткий warm-up промт чтобы создать чат
      await this.sendPromptWithSystem(page, 'Готов?', 'Ответь одним словом: OK', 'warmup');

      // Ждём пока Mistral создаст чат (URL сменится)
      const urlDeadline = Date.now() + 15000;
      while (Date.now() < urlDeadline) {
        await page.waitForTimeout(300);
        if (page.url().includes('/chat/')) break;
      }

      // Ждём стабилизации ответа "OK"
      let prevCount = 0, stable = 0;
      const respDeadline = Date.now() + 15000;
      while (Date.now() < respDeadline) {
        await page.waitForTimeout(400);
        const count = await page.evaluate(() => {
          const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
          let max = 0;
          for (const s of selectors) { const n = document.querySelectorAll(s).length; if (n > max) max = n; }
          return max;
        }).catch(() => 0);
        if (count >= 2 && count === prevCount) { stable++; if (stable >= 2) break; }
        else { stable = 0; prevCount = count; }
      }

      const match = page.url().match(/\/(?:chat|c)\/([a-f0-9-]{36})/i);
      const chatId = match?.[1] || null;
      if (chatId) {
        this.demoWarmChatId = chatId;
        console.log(`🔥 Демо-чат прогрет: ${chatId}`);
      }
      return chatId;
    } catch (e) {
      console.warn('⚠️ _prepareWarmChat:', e.message);
      return null;
    } finally {
      this.demoWarmChatPreparing = false;
    }
  }

  // ==================== УПРАВЛЕНИЕ КОНТЕКСТАМИ ====================

  // Loads+waits a fresh Mistral tab to idle-ready, WITHOUT assigning it to any
  // userId — kept in this.sparePage for instant handoff. Closing the gap that
  // made every brand-new per-user context pay the full page-load+SPA-hydration
  // cost synchronously (confirmed live via VNC: an already-warm tab sat idle
  // on screen while a real request was about to spin up a totally separate,
  // cold one — because pm2 restarts wipe the in-memory userContexts Map while
  // the underlying browser/tabs persist, and the per-user pool starts empty
  // every time). Cheap to keep one spare around; refilled after every handoff.
  async _prepareSparePage() {
    if (BROWSER_FALLBACKS_OFF) return;
    if (this.sparePage || this._sparePagePreparing) return;
    if (!this.profileContext || this.forceQwen) return;
    this._sparePagePreparing = true;
    try {
      const page = await this.profileContext.newPage();
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await this._waitForChatInterface(page, 25000);
      } catch {
        await page.waitForTimeout(5000);
        await this._waitForChatInterface(page, 10000);
      }
      await this._closeModals(page, 'spare');
      this.sparePage = page;
      console.log('🌤️ Запасная прогретая вкладка Mistral готова');
    } catch (e) {
      console.warn('⚠️ Не удалось подготовить запасную вкладку:', e.message);
    } finally {
      this._sparePagePreparing = false;
    }
  }

  // ════════════ ПУЛ ПРОГРЕТЫХ ВКЛАДОК MISTRAL ════════════
  // Прогревает ОДНУ вкладку Mistral до готовности к вводу (без привязки к userId).
  async _warmMistralPage() {
    if (!this.profileContext || this.forceQwen) return null;
    let page;
    try {
      page = await this.profileContext.newPage();
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await this._waitForChatInterface(page, 25000);
      } catch {
        await page.waitForTimeout(5000);
        await this._waitForChatInterface(page, 10000);
      }
      await this._closeModals(page, 'pool');
      return page;
    } catch (e) {
      console.warn('⚠️ _warmMistralPage:', e.message);
      if (page) await page.close().catch(() => {});
      return null;
    }
  }

  // Жива ли страница (не упала/не закрыта) — быстрая проверка перед выдачей.
  async _isPageUsable(page) {
    try {
      await page.evaluate(() => document.readyState, { timeout: 4000 });
      // Заглушка Cloudflare ОТВЕЧАЕТ на evaluate — по одному readyState она
      // выглядит «живой» и раньше возвращалась в пул, отравляя следующий запрос
      // (тот ждал генерацию на странице ошибки и падал с «зависла»). Считаем
      // такую вкладку негодной — вызывающий её закроет и восполнит пул.
      if (DEAD_TAB_URL_RE.test(page.url() || '')) {
        console.warn('☠️ Вкладка на заглушке Cloudflare — выбрасываю из пула');
        return false;
      }
      return true;
    } catch { return false; }
  }

  // Если есть свободные страницы и ожидающие — раздаём.
  _handoffToWaiters() {
    while (this.poolWaiters.length && this.poolFree.length) {
      const resolve = this.poolWaiters.shift();
      resolve(this.poolFree.shift());
    }
  }

  // Догоняет пул до POOL_WARM прогретых вкладок. Fire-and-forget, без гонок.
  async _ensureMistralPool() {
    if (BROWSER_FALLBACKS_OFF) return;
    if (this._poolFilling || this.forceQwen || !this.profileContext) return;
    this._poolFilling = true;
    try {
      while (this.poolAll.size + this.poolPending < this.mistralPoolWarm) {
        this.poolPending++;
        let page = null;
        try { page = await this._warmMistralPage(); }
        finally { this.poolPending--; }
        if (!page) break;
        this.poolAll.add(page);
        page.__freedAt = Date.now();
        this.poolFree.push(page);
        this._handoffToWaiters();
        console.log(`🔥 Пул Mistral: +вкладка (${this.poolAll.size}/${this.mistralPoolWarm} тёплых, макс ${this.mistralPoolMax})`);
      }
    } finally {
      this._poolFilling = false;
    }
  }

  // Берёт вкладку из пула НА ОДИН запрос. Свободная живая → сразу; иначе, если
  // пул меньше макс — прогреваем ещё одну; иначе ждём освобождения (очередь).
  // На время реконнекта браузера может вернуть null (обрабатывается вызывающим).
  async _acquireMistralPage() {
    if (BROWSER_FALLBACKS_OFF) throw fallbacksOff();
    // 1) свободная живая вкладка
    while (this.poolFree.length) {
      const page = this.poolFree.shift();
      if (await this._isPageUsable(page)) return page;
      this.poolAll.delete(page);
      await page.close().catch(() => {});
    }
    // 2) под нагрузкой дорастаем до максимума
    if (this.poolAll.size + this.poolPending < this.mistralPoolMax) {
      this.poolPending++;
      let page = null;
      try { page = await this._warmMistralPage(); }
      finally { this.poolPending--; }
      if (page) { this.poolAll.add(page); return page; }
    }
    // 3) все заняты — ждём, пока кто-то освободит вкладку
    if (this.poolAll.size === 0 && this.poolPending === 0) return null; // пул пуст (реконнект)
    console.log(`⏳ Пул Mistral занят (${this.poolAll.size}/${this.mistralPoolMax}) — жду свободную вкладку`);
    return await new Promise((resolve) => this.poolWaiters.push(resolve));
  }

  // Возвращает вкладку в пул. НЕ блокирует вызывающего: чистит (переход на /chat +
  // удаление использованного чата) АСИНХРОННО и делает доступной только ПОСЛЕ
  // чистки — иначе следующий запрос попал бы на страницу, где ещё идёт удаление
  // прошлого чата (перепутались бы). Мёртвую вкладку выкидываем и восполняем пул.
  _releaseMistralPage(page) {
    if (!page || !this.poolAll.has(page)) return;
    (async () => {
      let usable = await this._isPageUsable(page);
      if (usable) {
        try {
          const usedChatId = page.url().match(/\/(?:chat|c)\/([a-f0-9-]{36})/i)?.[1];
          await page.goto(`${MISTRAL_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          if (usedChatId) await this._deleteMistralChat(page, usedChatId).catch(() => {});
        } catch { usable = await this._isPageUsable(page); }
      }
      if (!usable) {
        this.poolAll.delete(page);
        await page.close().catch(() => {});
        this._ensureMistralPool();
        return;
      }
      const waiter = this.poolWaiters.shift();
      if (waiter) waiter(page);
      else { page.__freedAt = Date.now(); this.poolFree.push(page); }
    })().catch((e) => console.warn('⚠️ _releaseMistralPage:', e.message));
  }

  async createUserContext(userId, email) {
    userId = userId.toString(); // 🔥
    if (!this.masterBrowser) throw new Error('Браузер не инициализирован.');
    if (this.userContexts.has(userId)) return this.userContexts.get(userId).page;

    console.log(`🔐 Создаю контекст для ${email} (userId: ${userId})`);

    // Используем профильный контекст — в нём живёт Google-сессия Mistral
    const context = this.profileContext;
    let page;

    if (this.sparePage) {
      // Instant handoff — already loaded & idle, no fresh page-load/hydration wait.
      page = this.sparePage;
      this.sparePage = null;
      console.log('⚡ Использую прогретую запасную вкладку (без ожидания загрузки)');
      await this._closeModals(page, userId);
    } else {
      page = await context.newPage();
      // Always start at homepage — fresh chat per request is faster than accumulated context
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await this._waitForChatInterface(page, 25000);
      } catch {
        await page.waitForTimeout(5000);
        await this._waitForChatInterface(page, 10000);
      }
      await this._closeModals(page, userId);
    }
    this._prepareSparePage(); // fire-and-forget — refill the pool for the next request

    this.userContexts.set(userId, {
      context,
      page,
      email,
      createdAt: Date.now(),
      inactivityTimer: null,
    });
    this.resetInactivityTimer(userId);

    console.log(`✅ Контекст создан для ${email}`);
    // Прогрев НЕ делаем при создании контекста — только после первого реального запроса.
    // Иначе у каждого активного пользователя появляется свой чат в общем Mistral-аккаунте.
    return page;
  }

  // Аналог _prepareWarmChat для обычных пользователей (переиспользует страницу пользователя)
  async _prepareUserWarmChat(userId) {
    userId = userId.toString();
    const ctx = this.userContexts.get(userId);
    if (!ctx || ctx.warmChatPreparing) return null;
    ctx.warmChatPreparing = true;
    // Удаляем старый прогретый чат перед созданием нового
    if (ctx.warmChatId) {
      await this._deleteMistralChat(ctx.page, ctx.warmChatId).catch(() => {});
      ctx.warmChatId = null;
    }
    try {
      const page = ctx.page;
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(400);
      await this.sendPromptWithSystem(page, 'Готов?', 'Ответь одним словом: OK', 'warmup');
      const urlDeadline = Date.now() + 12000;
      while (Date.now() < urlDeadline) {
        await page.waitForTimeout(300);
        if (page.url().includes('/chat/')) break;
      }
      // Ждём стабилизации ответа
      let prevCount = 0, stable = 0;
      const respDeadline = Date.now() + 12000;
      while (Date.now() < respDeadline) {
        await page.waitForTimeout(400);
        const count = await page.evaluate(() => {
          const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
          let max = 0;
          for (const s of selectors) { const n = document.querySelectorAll(s).length; if (n > max) max = n; }
          return max;
        }).catch(() => 0);
        if (count >= 2 && count === prevCount) { stable++; if (stable >= 2) break; }
        else { stable = 0; prevCount = count; }
      }
      const match = page.url().match(/\/(?:chat|c)\/([a-f0-9-]{36})/i);
      const chatId = match?.[1] || null;
      const u = this.userContexts.get(userId);
      if (u) u.warmChatId = chatId;
      if (chatId) console.log(`🔥 Прогретый чат пользователя ${userId}: ${chatId}`);
      return chatId;
    } catch (e) {
      console.warn(`⚠️ _prepareUserWarmChat(${userId}):`, e.message);
      return null;
    } finally {
      const u = this.userContexts.get(userId);
      if (u) u.warmChatPreparing = false;
    }
  }

  // 🔥 ИЗМЕНЕНО: getDemoPage теперь использует единый контекст
  async getDemoPage() {
    if (BROWSER_FALLBACKS_OFF) throw fallbacksOff();
    // Если демо-контекст еще не создан (например, при первом запросе до полной инициализации)
    if (!this.demoPage || !this.demoContext) {
      console.warn('⚠️ Демо-контекст не инициализирован, создаю...');
      await this._initDemoContext();
    }

    // Проверяем, жива ли страница
    try {
      await this.demoPage.evaluate(() => document.readyState);
      const url = this.demoPage.url();

      // Если страница сломана или закрыта — перезагружаем
      if (url.includes('Application error') || url === 'about:blank') {
        console.warn('⚠️ Демо-страница сломана, перезагружаю...');
        await this.demoPage.reload({ waitUntil: 'domcontentloaded' });
        await this.demoPage.waitForTimeout(1000);
      }
    } catch {
      console.warn('⚠️ Демо-страница недоступна, пересоздаю контекст...');
      await this._initDemoContext();
    }

    return this.demoPage;
  }

  async _waitForChatInterface(page, timeout = 25000) {
    // Mistral использует div[contenteditable], не textarea — проверяем оба варианта
    try {
      await page
        .locator(
          'div[contenteditable="true"], textarea[placeholder*="Type" i], textarea[placeholder*="message" i], textarea[placeholder*="ask" i], textarea[aria-label*="send" i], [data-testid="chat-input"], textarea'
        )
        .first()
        .waitFor({ state: 'visible', timeout: Math.min(400, timeout) });
      return true;
    } catch {}

    try {
      await page.waitForFunction(() => document.body.innerText.length > 100, {
        timeout: Math.min(timeout, 25000),
      });
      return true;
    } catch {}

    throw new Error(`Интерфейс не загрузился за ${timeout}мс`);
  }

  async _renameChatInSidebar(page, chatId, newName) {
    try {
      console.log(`✏️ Переименовываю чат ${chatId} → "${newName}"`);
      await page.waitForTimeout(1000);

      // Кнопка ⋮ — div[role="button"][aria-label="More options"] ВНУТРИ <a href="/chat/{chatId}">
      // Находим <a> и ищем кнопку внутри неё
      const chatLink = page.locator(`a[href*="${chatId}"]`).first();
      if ((await chatLink.count()) === 0) {
        console.warn('⚠️ Чат не найден в сайдбаре, пропускаю rename');
        return false;
      }

      await chatLink.scrollIntoViewIfNeeded();
      await chatLink.hover();
      await page.waitForTimeout(500);

      // Кнопка ⋮ внутри ссылки: div[role="button"][aria-label="More options"]
      const moreBtn = chatLink.locator('[aria-label="More options"]').first();
      if (!(await moreBtn.isVisible({ timeout: 2000 }))) {
        console.warn('⚠️ Кнопка ⋮ не видна после hover');
        return false;
      }
      await moreBtn.click();
      await page.waitForTimeout(400);

      // Edit — div[role="menuitem"] с текстом "Edit"
      const editItem = page.locator('[role="menuitem"]:has-text("Edit")').first();
      if (!(await editItem.isVisible({ timeout: 2000 }))) {
        console.warn('⚠️ Пункт Edit не найден в меню');
        await page.keyboard.press('Escape');
        return false;
      }
      await editItem.click();
      await page.waitForTimeout(400);

      // После клика Edit фокус падает в поле названия — выделяем всё и вводим новое
      await page.keyboard.press('Control+A');
      await page.waitForTimeout(100);
      await page.keyboard.type(newName);
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');

      console.log(`✅ Чат переименован: "${newName}"`);
      return true;
    } catch (err) {
      console.warn(`⚠️ _renameChatInSidebar: ${err.message}`);
      return false;
    }
  }

  async _closeModals(page, userId) {
    const modalSelectors = [
      'button:has-text("Cancel")',
      'button:has-text("Close")',
      'button:has-text("Skip")',
      'button:has-text("Got it")',
      'button:has-text("Продолжить")',
      '[role="dialog"] button:first-of-type',
      '.modal-close, .close-button, [aria-label*="close" i]',
    ];

    for (let i = 0; i < 2; i++) {
      let closed = false;
      for (const selector of modalSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 1500 })) {
            await btn.click();
            console.log('✅ Модальное окно закрыто');
            closed = true;
            await page.waitForTimeout(300);
            break;
          }
        } catch {}
      }
      if (!closed) break;
    }
  }

  async destroyUserContext(userId) {
    userId = userId.toString();
    const ctx = this.userContexts.get(userId);
    if (ctx) {
      if (ctx.inactivityTimer) clearTimeout(ctx.inactivityTimer);
      try {
        await ctx.page.close();
        console.log(`🧹 Страница очищена: ${userId}`);
      } catch (err) {
        console.error(`❌ Ошибка очистки ${userId}:`, err.message);
      }
      this.userContexts.delete(userId);
    }
  }

  async getPageForUser(userId, email) {
    if (BROWSER_FALLBACKS_OFF) throw fallbacksOff();
    userId = userId.toString(); // 🔥
    console.log(
      `🔍 getPageForUser: userId="${userId}", contextExists=${this.userContexts.has(userId)}`
    ); // 🔥 добавить
    if (email === 'demo@siberi.ai') return await this.getDemoPage();

    const existing = this.userContexts.get(userId);
    if (existing?.page) {
      try {
        // Если идёт прогрев — страница занята, возвращаем сразу без evaluate (он timeout-нет)
        if (existing.warmChatPreparing) {
          this.resetInactivityTimer(userId);
          return existing.page;
        }
        await existing.page.evaluate(() => document.readyState, { timeout: 5000 });
        this.resetInactivityTimer(userId);
        return existing.page;
      } catch (err) {
        console.warn(`⚠️ Страница не отвечает (${err.message}), проверяю контекст...`);

        // 🔥 Пробуем reload вместо полного пересоздания
        try {
          await existing.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          await this._waitForChatInterface(existing.page, 10000);
          this.resetInactivityTimer(userId);
          console.log(`✅ Страница восстановлена через reload для ${userId}`);
          return existing.page;
        } catch (reloadErr) {
          console.warn(`⚠️ Reload не помог, пересоздаю контекст: ${reloadErr.message}`);
          await this.destroyUserContext(userId);
        }
      }
    }

    if (this.contextCreationPromises.has(userId)) {
      return await this.contextCreationPromises.get(userId);
    }

    if (!this.masterBrowser?.isConnected?.()) {
      console.warn('⚠️ Браузер отключился, переподключаюсь...');
      try {
        this.masterBrowser = await chromium.connectOverCDP('http://127.0.0.1:9223', {
          timeout: 15000,
        });
        this.profileContext = this.masterBrowser.contexts()[0];
        this.authState = loadAuthState();
      } catch (err) {
        throw new Error('Browser disconnected. Restart server.');
      }
    }

    const creationPromise = this.createUserContext(userId, email);
    this.contextCreationPromises.set(userId, creationPromise);
    try {
      return await creationPromise;
    } finally {
      this.contextCreationPromises.delete(userId);
    }
  }

  // ==================== СОЗДАНИЕ ЧАТА ====================

  async createChatForUser(userId, email, maxRetries = 3) {
    if (this.forceQwen) {
      console.log('🔧 forceQwen=true: пропускаю создание Mistral-чата при регистрации');
      return null;
    }

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🆕 Попытка ${attempt}/${maxRetries}: создание чата для ${email}`);

        const page = await this.getPageForUser(userId, email);
        await this._closeModals(page, userId);

        // 🔥 Всегда идём на чистую страницу Mistral чтобы создать НОВЫЙ чат
        // Без этого INIT отправляется в уже открытый чат и возвращается тот же chatId
        const currentUrl = page.url();
        if (currentUrl.includes('/chat/') || currentUrl.includes('/c/')) {
          console.log('🏠 Перехожу на главную Mistral для создания нового чата...');
          await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1500);
        }

        // Detect Mistral error page and reload
        const isErrorPage = await page.evaluate(() =>
          (document.body?.innerText || '').includes('went wrong') ||
          (document.body?.innerText || '').includes('Application error') ||
          (document.title || '').toLowerCase().includes('error')
        ).catch(() => false);
        if (isErrorPage) {
          console.warn('⚠️ Mistral error page — перезагружаю...');
          await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);
        }

        const initConfig = await UserAiConfig.findOne({ userId }).catch(() => null);
        const aiNameInit = initConfig?.aiName || 'Siberi AI';
        const message = `[SYSTEM INIT] Ты — ${aiNameInit}, AI-ассистент платформы Siberi AI. Никогда не упоминай Mistral, GPT, Claude или другие модели — ты ${aiNameInit}. Никогда не используй имя, фамилию или email пользователя при ответах — они конфиденциальны. ЯЗЫК: отвечай ИСКЛЮЧИТЕЛЬНО на русском языке. РОД: Ты — девушка, всегда отвечай в женском роде («Поняла», «Сделала», «Готова», «Уточнила» и т.д.).`;

        const textarea = await page.$('textarea').catch(() => null);

        // Копируем сообщение в буфер обмена (как в sendPromptWithSystem)
        await page.evaluate((text) => {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }, message);

        if (textarea) {
          await textarea.focus();
          await page.waitForTimeout(200);
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyV');
          await page.keyboard.up('Control');
        } else {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(200);
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyV');
          await page.keyboard.up('Control');
        }
        await page.waitForTimeout(600);
        await page.keyboard.press('Enter');

        console.log('✅ Сообщение отправлено, жду навигации в новый чат...');

        try {
          await page.waitForURL(/\/(?:chat|c)\/[a-f0-9-]{36}/i, { timeout: 20000 });
        } catch {
          console.warn('⚠️ waitForURL не сработал за 20с, читаю текущий URL');
        }

        const url = page.url();
        console.log('🔗 Текущий URL:', url);

        const match = url.match(/\/(?:chat|c)\/([a-f0-9-]{36})/i);
        const chatId = match?.[1];

        if (!chatId) {
          await takeDebugScreenshot(page, userId, 'no_chat_id');
          throw new Error('Не удалось извлечь Chat ID из URL: ' + url);
        }

        console.log(`✅ Чат создан: ${chatId}`);

        // Ждём пока AI полностью ответит на INIT-сообщение
        await (async () => {
          // Stop/Abort button presence — same reliable signal as checkGenerating()
          // below. The old Voice Mode/.lucide-mic check this replaced always
          // returned true (Mistral renamed its icon library), which silently
          // burned the full 60s wait on every single context creation.
          const chk = () => page.evaluate(() => {
            const stopBtn = document.querySelector(
              'button[aria-label="Stop"], button[aria-label="Abort"], ' +
              'button[aria-label*="stop" i], button[aria-label*="abort" i], ' +
              'button[data-testid*="stop"], [role="button"][aria-label*="Stop"]'
            );
            return !!(stopBtn && stopBtn.offsetParent !== null);
          }).catch(() => false);
          // ждём начала генерации (до 8с)
          const t1 = Date.now() + 8000;
          while (Date.now() < t1) { await page.waitForTimeout(300); if (await chk()) break; }
          // ждём окончания генерации (до 60с)
          const t2 = Date.now() + 60000;
          while (Date.now() < t2) { await page.waitForTimeout(500); if (!(await chk())) break; }
          await page.waitForTimeout(1000);
          console.log('✅ AI ответил на INIT, продолжаем...');
        })();

        // Удаляем INIT-чат сразу — он больше не нужен (каждый запрос создаёт свой временный чат)
        await this._deleteMistralChat(page, chatId).catch(() => {});
        try {
          await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 8000 });
        } catch {}

        return chatId;
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ Попытка ${attempt} не удалась: ${err.message}`);

        if (attempt === maxRetries) {
          try {
            const page = this.userContexts.get(userId)?.page;
            if (page) await takeDebugScreenshot(page, userId, 'create_failed');
          } catch {}
        }

        const delay = 1000 * Math.pow(1.5, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        await this.destroyUserContext(userId);
      }
    }

    throw new Error(`Не удалось создать чат: ${lastError?.message}`);
  }

  // ==================== РАБОТА С ЧАТОМ ====================

  async goToUserChat(page, chatId) {
    if (!chatId) return false;

    const targetUrl = `${MISTRAL_URL}/chat/${chatId}`;
    const currentUrl = page.url();

    // Уже на нужной странице — проверяем что чат реально существует
    if (currentUrl.includes(chatId)) {
      const dead = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase();
        return t.includes('this chat does not exist') || t.includes('chat does not exist');
      }).catch(() => false);
      if (dead) {
        console.warn(`⚠️ Чат ${chatId} удалён (This chat does not exist)`);
        return false;
      }
      console.log(`✅ Уже в нужном чате: ${chatId}`);
      return true;
    }

    console.log(`🔗 Переход в чат: ${targetUrl} (сейчас: ${currentUrl})`);
    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      await page.waitForTimeout(800);
      // Проверяем что чат существует после перехода
      const dead = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase();
        return t.includes('this chat does not exist') || t.includes('chat does not exist');
      }).catch(() => false);
      if (dead) {
        console.warn(`⚠️ Чат ${chatId} удалён (This chat does not exist)`);
        return false;
      }
      return true;
    } catch (err) {
      console.error('❌ Ошибка перехода в чат:', err.message);
      await takeDebugScreenshot(page, 'unknown', 'goto_chat_failed');
      return false;
    }
  }

  // 🔥 sendPrompt() — ДЛЯ ДЕМО: Сразу используем keyboard без поиска textarea
  async sendPrompt(page, prompt, userId = 'unknown') {
    console.log('📤 Отправка промпта (DEMO)...');
    const sendStartTime = Date.now();

    const messagesBefore = await page.evaluate(() => {
      return document.querySelectorAll('[class*="message"], [class*="assistant"]').length;
    });
    console.log(`📊 Сообщений до отправки: ${messagesBefore}`);

    try {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
      await page.keyboard.type(prompt, { delay: 1 });
      await page.waitForTimeout(100);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      console.log('✓ Промпт отправлен через keyboard (DEMO mode)');
      return { success: true, messagesBefore, sendStartTime };
    } catch (err) {
      console.error('❌ Ошибка отправки промпта:', err.message);
      return { success: false, messagesBefore, sendStartTime };
    }
  }

  // 🔥 НОВЫЙ: Метод для копирования текста в буфер обмена через Playwright
  async _copyToClipboard(page, text) {
    try {
      await page.evaluate((text) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }, text);
      console.log('✅ Промт скопирован в буфер обмена');
      return true;
    } catch (err) {
      console.error('❌ Ошибка копирования в буфер:', err.message);
      return false;
    }
  }

  // 🔥 НОВЫЙ: Фоллбэк на старый метод ввода, если буфер не сработал
  async _fallbackSendPrompt(page, fullPrompt, userId, sendStartTime) {
    console.warn('⚠️ Использую фоллбэк: ввод через keyboard.type');
    let textarea = null;
    try {
      textarea = await page.waitForSelector('textarea', { timeout: 2000, state: 'visible' });
    } catch (err) {
      console.warn('⚠️ Textarea не найдена, использую keyboard.type');
    }

    if (textarea) {
      await textarea.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);

      const lines = fullPrompt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        await page.keyboard.type(lines[i], { delay: 5 });
        if (i < lines.length - 1) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Enter');
          await page.keyboard.up('Shift');
          await page.waitForTimeout(50);
        }
      }
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);

      const lines = fullPrompt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        await page.keyboard.type(lines[i], { delay: 5 });
        if (i < lines.length - 1) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Enter');
          await page.keyboard.up('Shift');
          await page.waitForTimeout(50);
        }
      }
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
    }

    const elapsed = Date.now() - sendStartTime;
    console.log(`✅ Промт отправлен через фоллбэк за ${elapsed} мс`);
    return { success: true, sendStartTime };
  }

  // 🔥 Вставка изображения в чат через буфер обмена браузера
  async _injectImageToChat(page, dataUrl) {
    const mimeMatch = dataUrl.match(/^data:(image\/[a-z+]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    const ext = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
    const fileName = `image.${ext}`;
    const buffer = Buffer.from(base64, 'base64');

    // Debug: log all file inputs and buttons found on the page
    try {
      const domInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({
          tag: 'input', id: el.id, name: el.name, accept: el.accept,
        }));
        const btns = Array.from(document.querySelectorAll('button')).filter((b) =>
          /attach|image|upload|file|clip|photo/i.test((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + b.textContent)
        ).map((b) => ({ label: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: b.textContent?.slice(0, 30) }));
        return { inputs, btns };
      });
      console.log('🔍 DOM scan:', JSON.stringify(domInfo));
    } catch {}

    // Strategy 1 — direct setInputFiles on hidden file input (works in CDP mode, no permissions needed)
    try {
      const fileInput = page.locator('input[type="file"]').first();
      const count = await fileInput.count();
      if (count > 0) {
        await fileInput.setInputFiles({ name: fileName, mimeType, buffer });
        await page.waitForTimeout(1200);
        console.log('🖼️ Изображение загружено через file input');
        return;
      }
    } catch (err) {
      console.warn('⚠️ File input не найден:', err.message);
    }

    // Strategy 2 — click attachment button, intercept FileChooser dialog
    const attachSelectors = [
      'button[aria-label*="attach" i]',
      'button[aria-label*="image" i]',
      'button[aria-label*="upload" i]',
      'button[aria-label*="file" i]',
      'button[title*="attach" i]',
      'button[title*="image" i]',
      '[data-testid*="file"]',
      '[data-testid*="attach"]',
      'label[for*="file"]',
    ];
    for (const sel of attachSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 600 })) {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 4000 }),
            btn.click(),
          ]);
          await fileChooser.setFiles({ name: fileName, mimeType, buffer });
          await page.waitForTimeout(1200);
          console.log(`🖼️ Изображение загружено через FileChooser (${sel})`);
          return;
        }
      } catch {}
    }

    // Strategy 3 — synthetic DataTransfer paste event (fallback)
    try {
      await page.evaluate(async ({ b64, mime, fname }) => {
        const byteArr = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const blob = new Blob([byteArr], { type: mime });
        const file = new File([blob], fname, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.querySelector('textarea') || document.activeElement || document.body;
        target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      }, { b64: base64, mime: mimeType, fname: fileName });
      await page.waitForTimeout(1000);
      console.log('🖼️ Изображение вставлено через synthetic paste event');
    } catch (err) {
      console.warn('⚠️ Все стратегии вставки изображения не сработали:', err.message);
    }
  }

  // Сериализатор доступа к общему буферу обмена ОС (см. _clipboardLock в конструкторе).
  // Держит критическую секцию «copy → Ctrl+V» атомарной между параллельными вкладками.
  async _withClipboard(fn) {
    const prev = this._clipboardLock;
    let release;
    this._clipboardLock = new Promise((r) => { release = r; });
    try { await prev; } catch {}
    try { return await fn(); }
    finally { release(); }
  }

  // 🔥 ОСНОВНОЙ: Отправка промпта через буфер обмена
  async sendPromptWithSystem(page, userPrompt, systemPrompt, userId = 'unknown', imageBase64 = null) {
    console.log('📤 Отправка единого промпта с контекстом...');
    const sendStartTime = Date.now();
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    await this._waitForChatInterface(page, 30000);

    // Считаем сообщения ДО отправки, чтобы waitForResponse мог ждать появления нового
    const messagesBefore = await page.evaluate(() => {
      const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
      let all = [];
      for (const s of selectors) {
        const els = document.querySelectorAll(s);
        if (els.length) all = Array.from(els);
      }
      return all.length;
    }).catch(() => 0);
    console.log(`📊 Сообщений до отправки: ${messagesBefore}`);

    if (imageBase64) {
      await this._injectImageToChat(page, imageBase64);
    }

    // Закрываем модальные окна перед отправкой (они могут перехватывать Enter)
    await this._closeModals(page, userId).catch(() => {});

    try {
      // Критическая секция буфера обмена: copy → фокус → Ctrl+V делаем под мьютексом,
      // чтобы параллельная вкладка не затёрла буфер между нашим copy и paste. Enter
      // — уже после (текст в поле, буфер больше не нужен), вне мьютекса.
      await this._withClipboard(async () => {
        // Копируем в буфер обмена через скрытую textarea (надёжный метод)
        await page.evaluate((text) => {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }, fullPrompt);
        const inputEl = await page.$('div[contenteditable="true"], textarea').catch(() => null);
        if (inputEl) {
          await inputEl.focus();
        } else {
          await page.keyboard.press('Tab'); // input не найден — фокус через Tab
        }
        await page.waitForTimeout(50);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyV');
        await page.keyboard.up('Control');
        await page.waitForTimeout(150); // даём рендереру дочитать буфер ДО снятия мьютекса
      });
      console.log('✅ Промт скопирован и вставлен (Ctrl+V под мьютексом буфера)');
      await page.keyboard.press('Enter');
      console.log('✅ Промт отправлен');
    } catch (err) {
      console.error('❌ Ошибка вставки/отправки:', err.message);
      const result = await this._fallbackSendPrompt(page, fullPrompt, userId, sendStartTime);
      return { ...result, messagesBefore };
    }

    const elapsed = Date.now() - sendStartTime;
    console.log(`✅ Промт отправлен за ${elapsed} мс`);
    return { success: true, sendStartTime, messagesBefore };
  }

  // ── Marker signalling end of user-visible text, before system commands ──────
  static get TEXT_DONE_MARKER() { return '[END_TEXT]'; }

  // Shared with QwenService.js (extracted to helpers/promptLeakMarkers.js to
  // avoid a circular require — AiService already requires QwenService). Used
  // here by formatResponse — the universal final cleanup applied regardless of
  // which provider answered — and locally inside waitForResponse.
  static get PROMPT_LEAK_MARKERS() {
    return require('./helpers/promptLeakMarkers').PROMPT_LEAK_MARKERS;
  }

  // 🔥 ПОЛНАЯ ЗАМЕНА МЕТОДА: Ждем именно по иконке кнопок (Самое надежное!)
  // onPartialText: optional async callback(text) called when [END_TEXT] marker is detected
  async waitForResponse(page, timeoutMs = 90000, userId = 'unknown', messagesBefore = 0, onPartialText = null) {
    console.log('⏳ Ожидание ответа (через визуальный индикатор готовности)...');
    const MARKER = AiService.TEXT_DONE_MARKER;
    let partialFired = false;

    // sendPromptWithSystem() pastes systemPrompt+userPrompt as ONE message — there's
    // no separate "system" role in Mistral's web UI, so OUR OWN sent bubble contains
    // the full prompt verbatim. If the scraper ever grabs that bubble instead of the
    // real new AI reply (race condition, layout quirk, etc.), PROMPT_LEAK_MARKERS
    // (shared with formatResponse) are strings that prove it — none could plausibly
    // appear in a genuine AI answer. Checked with .includes(), not .startsWith(),
    // by every extraction point below (streaming reads, the final read, and the
    // last-resort hard gate) so a fix here closes the leak everywhere at once.
    const PROMPT_LEAK_MARKERS = AiService.PROMPT_LEAK_MARKERS;

    // Free-tier Mistral account hits "Messages limit reached... resets in N
    // minutes" — confirmed live (the shared account genuinely ran out this
    // session). Waiting out the full 90-180s timeout before falling back to
    // Qwen is pure waste once this dialog is up; check for it on every poll
    // tick across all wait loops below so failover is near-instant instead.
    const checkRateLimited = () => page.evaluate(() => {
      const t = document.body.innerText || '';
      return /messages limit reached|message limit|reached your message limit/i.test(t);
    }).catch(() => false);

    const maybeFirePartial = async (text) => {
      if (partialFired || !onPartialText) return;
      const idx = text.indexOf(MARKER);
      if (idx === -1) return;
      partialFired = true;
      const textPart = text.slice(0, idx).trim();
      if (PROMPT_LEAK_MARKERS.some((m) => textPart.includes(m))) {
        console.warn('⚠️ [END_TEXT] перед маркером — утечка промта, partialResult не показываю');
        return;
      }
      // Если перед [END_TEXT] меньше 30 символов — AI поставил маркер слишком рано
      // (артефакт веб-поиска или tool-call JSON). Игнорируем — используем финальный текст.
      if (textPart.length > 30) {
        console.log(`🎯 [END_TEXT] marker found — partialResult (${textPart.length} chars)`);
        try { await onPartialText(textPart); } catch {}
      } else {
        console.log(`⚠️ [END_TEXT] слишком рано (${textPart.length} chars) — игнорирую partialResult`);
      }
    };
    const startTime = Date.now();

    // True streaming: emit growing DOM text immediately as AI types (every 150ms max)
    let _lastEmitLen = 0;
    let _lastEmitAt = 0;
    const SEARCH_JUNK_RE = /^(searching|searched|web search|thinking|thought|worked)\s/i;
    // Системные промты начинаются с этих строк — никогда не отправляем их пользователю
    const SYSTEM_PROMPT_RE = /^(ты\s*—\s*помощник|ты\s*—\s*[а-яё]+.*ассистент|критически важно|правила форматирования|ответь одним словом)/i;
    // Текст интерфейса Mistral который может попасть в парсер вместо реального ответа
    const MISTRAL_UI_RE = /^(designed for mobile|get the (mistral |le chat )?app|try (our|le chat)|download.*app|better experience and more features|le chat.*app|for ios|for android|switch to|open in app)/i;
    const emitProgressive = async (text) => {
      if (partialFired || !onPartialText) return;
      const now = Date.now();
      if (now - _lastEmitAt < 150) return;
      const markerIdx = text.indexOf(MARKER);
      const clean = (markerIdx !== -1 ? text.slice(0, markerIdx) : text)
        .replace(/\s+\d{1,2}:\d{2}(?:am|pm)?\s*$/i, '')  // strip trailing UI timestamp
        .trim();
      // Skip Mistral search/thinking UI artifacts, system prompt leaks, and Mistral UI text
      if (SEARCH_JUNK_RE.test(clean)) return;
      if (SYSTEM_PROMPT_RE.test(clean)) return;
      if (PROMPT_LEAK_MARKERS.some((m) => clean.includes(m))) return;
      if (MISTRAL_UI_RE.test(clean)) return;
      if (clean.length < 15) return;
      if (clean.length > _lastEmitLen) {
        _lastEmitAt = now;
        _lastEmitLen = clean.length;
        await onPartialText(clean).catch(() => {});
      }
    };

    const getMessageCount = () => page.evaluate(() => {
      const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
      let all = [];
      for (const s of selectors) {
        const els = document.querySelectorAll(s);
        if (els.length) all = Array.from(els);
      }
      return all.length;
    }).catch(() => 0);

    // Фаза 0: ждём появления нового элемента (AI-ответ появляется в том же DOM-элементе что
    // и предыдущая беседа — count растёт на 1 когда Mistral рендерит ответ, не user-bubble).
    if (messagesBefore > 0) {
      console.log(`⏳ Фаза 0: жду ответа Mistral (было ${messagesBefore})...`);
      let newMessageAppeared = false;
      const phase0End = Date.now() + 90000;
      while (Date.now() < phase0End) {
        await page.waitForTimeout(200);
        if (await checkRateLimited()) throw new Error('Mistral: достигнут лимит сообщений (rate limit)');
        const count = await getMessageCount();
        if (count > messagesBefore) {
          // Verify it's not just a search indicator — wait briefly for actual content
          await page.waitForTimeout(100);
          const txt = await page.evaluate(() => {
            const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
            let all = [];
            for (const s of selectors) { const els = document.querySelectorAll(s); if (els.length) all = Array.from(els); }
            return all[all.length - 1]?.textContent?.trim() || '';
          }).catch(() => '');
          const isSearchJunk = /^(searching|searched|web search)\s/i.test(txt);
          if (isSearchJunk) {
            console.log('⏳ Mistral ищет в сети, ожидаю реального ответа...');
            continue; // keep waiting
          }
          console.log(`✅ Новый элемент появился (стало ${count})`);
          newMessageAppeared = true;
          break;
        }
      }
      if (!newMessageAppeared) {
        throw new Error('Промт не доставлен: Mistral не добавил новый элемент за 90 сек');
      }
    }

    // Возвращает true пока Mistral генерирует ответ.
    // Проверяем несколько UI-индикаторов на случай изменений в Mistral UI.
    const checkGenerating = () => page.evaluate(() => {
      // 1. Stop/Abort button visible (most reliable in newer Mistral)
      const stopBtn = document.querySelector(
        'button[aria-label="Stop"], button[aria-label="Abort"], ' +
        'button[aria-label*="stop" i], button[aria-label*="abort" i], ' +
        'button[data-testid*="stop"], [role="button"][aria-label*="Stop"]'
      );
      if (stopBtn && stopBtn.offsetParent !== null) return true;

      // 2. Voice Mode button (legacy) — REMOVED 2026-06-28. Mistral renamed its
      // icon library so `.lucide-mic` never matches any more; this check had
      // degraded into "if a Voice Mode button exists, ALWAYS return true",
      // permanently overriding check #1's correct "done" verdict with a false
      // "still generating" one. Confirmed live: a finished response (no stop
      // button, no spinner) sat for 20+ minutes because of this one line.
      // aria-busy alone (without the icon check) isn't independently verified
      // reliable either, so dropping the whole block rather than half-fixing it.

      // 3. Send button disabled (Mistral disables it during generation)
      const sendBtn = document.querySelector(
        'button[aria-label="Send message"], button[aria-label*="Send" i][type="submit"], ' +
        'button[data-testid="send-button"]'
      );
      if (sendBtn && sendBtn.disabled) return true;

      // 4. Loading/spinner indicator in message area
      const spinner = document.querySelector(
        '.message-in-progress, [class*="generating"], [class*="streaming"], ' +
        '[data-generating="true"], [aria-busy="true"]:not([role="dialog"])'
      );
      if (spinner) return true;

      return false;
    }).catch(() => false);

    // Фаза 1: определяем режим ожидания.
    // Если messagesBefore > 0: Phase 0 уже нашёл новый элемент — проверяем кнопку.
    // Если messagesBefore == 0: ждём пока AI начнёт генерировать (до 10с).
    let generationStarted = false;
    if (messagesBefore > 0) {
      // После Phase 0: сразу проверяем кнопку — AI скорее всего уже генерирует
      generationStarted = await checkGenerating();
      if (generationStarted) console.log('✅ Генерация подтверждена кнопкой после Phase 0');
    } else {
      // Для свежих чатов (messagesBefore=0): ждём первого DOM-элемента ИЛИ кнопки генерации.
      // Тайм-аут 3с вместо 10с — если кнопки нет, stability loop справится сам.
      const phase1End = Date.now() + 3000;
      while (Date.now() < phase1End) {
        await page.waitForTimeout(200);
        if (await checkRateLimited()) throw new Error('Mistral: достигнут лимит сообщений (rate limit)');
        const count = await getMessageCount();
        if (count > 0) {
          generationStarted = await checkGenerating();
          console.log(`✅ Первый элемент появился (count=${count}), кнопка=${generationStarted}`);
          break;
        }
        if (await checkGenerating()) {
          generationStarted = true;
          console.log('✅ AI начал генерировать (кнопка)');
          break;
        }
      }
    }

    // Читает текст последнего AI-сообщения.
    // afterIndex: пропускаем первые N элементов (старые сообщения + пузырь пользователя).
    // Thinking-блоки стрипятся до возврата — иначе stability loop стабилизируется на chain-of-thought.
    const getLastMessageText = (afterIndex = 0) => page.evaluate((startIdx, leakMarkers) => {
      const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
      let all = [];
      for (const s of selectors) {
        const els = document.querySelectorAll(s);
        if (els.length) all = Array.from(els);
      }
      const relevant = startIdx > 0 ? all.slice(startIdx) : all;
      if (relevant.length === 0) return '';
      // Back up past any bubble that's actually our own sent prompt (system prompt +
      // data context bled through) rather than the real new AI reply — never trust
      // textStartsWith on one specific prompt's wording, check ALL known prompts.
      let idx = relevant.length - 1;
      let last = relevant[idx];
      while (last && leakMarkers.some((m) => last.textContent.includes(m)) && idx > 0) {
        idx -= 1;
        last = relevant[idx];
      }
      if (!last) return '';
      // Клонируем и удаляем thinking/reasoning-блоки перед чтением текста.
      // Это критично: без этого stability loop стабилизируется на мышлении, а не на реальном ответе.
      const clone = last.cloneNode(true);
      clone.querySelectorAll(
        'details, summary, [class*="think"], [class*="reason"], [class*="thought"], ' +
        'button, span[class*="copy"], [aria-label*="Copy"], [class*="code-header"], ' +
        // Веб-поиск Mistral: только контейнеры источников, не инлайн-элементы
        '[class*="web-search"], [class*="tool-call"], [class*="tool_call"], [class*="source-card"], [class*="plugin"]'
      ).forEach(el => el.remove());
      const text = clone.textContent.trim();
      // Last-resort: even after backing up, never hand back text containing a leak
      // marker — an empty string just means "no preview yet", which is always safe.
      if (leakMarkers.some((m) => text.includes(m))) return '';
      return text;
    }, afterIndex, PROMPT_LEAK_MARKERS).catch(() => '');

    // Separate from getLastMessageText on purpose: that one strips thinking/
    // reasoning blocks before measuring length, which is correct for deciding
    // what the user should see — but WRONG as a stuck-detection signal. Mistral
    // can spend several minutes in an extended thinking phase before the first
    // visible character of the real answer appears; during that whole window
    // the stripped text is empty/flat even though the model is actively working
    // (confirmed live: a stuck-detector based on the stripped text fired at
    // ~280s and yanked the page away from a generation that was still genuinely
    // in progress, per direct VNC observation). This probe measures the FULL
    // raw length (thinking included) so "is anything happening at all" is
    // judged independently from "what does the clean answer look like so far".
    const getLastMessageRawLen = (afterIndex = 0) => page.evaluate((startIdx) => {
      const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
      let all = [];
      for (const s of selectors) {
        const els = document.querySelectorAll(s);
        if (els.length) all = Array.from(els);
      }
      const relevant = startIdx > 0 ? all.slice(startIdx) : all;
      if (relevant.length === 0) return 0;
      const last = relevant[relevant.length - 1];
      return last ? (last.textContent || '').length : 0;
    }, afterIndex).catch(() => 0);

    // msgOffset: для чатов с историей пропускаем user-bubble (index=messagesBefore).
    // Стриминг читает только НОВЫЕ элементы — AI-ответ начиная с messagesBefore+1.
    // Всегда пропускаем пузырь пользователя (index=messagesBefore) при стриминге.
    // Без этого при холодном старте (messagesBefore=0) первым элементом читается user-bubble
    // с системным промтом — он утекает на экран пользователя через emitProgressive.
    const msgOffset = messagesBefore + 1;

    // Сбрасываем счётчик прогрессивного стриминга — Phase 0 мог прочитать старый текст
    _lastEmitLen = 0;
    _lastEmitAt = 0;

    // Завершение определяется ИСКЛЮЧИТЕЛЬНО кнопкой (реальный паттерн), не
    // часами. timeoutMs здесь — не "сколько ждать готового ответа", а порог
    // зависания: если кнопка час кнопка всё ещё говорит "генерирую", но текст
    // не вырос ни на символ за timeoutMs — страница реально зависла (мёртвая
    // вкладка/сеть), а не модель просто долго думает. Пока текст растёт —
    // ждём дальше без верхней границы; так длинные студийные ответы (которые
    // легитимно пишутся по 3-5 минут) никогда не обрезаются по часам, а
    // настоящее зависание всё равно ловится и уходит в retry/Qwen, а не
    // тихо отдаётся как готовый, но недописанный ответ.
    const STUCK_NOT_DONE = 'Mistral: генерация зависла — текст не меняется, хотя кнопка показывает "идёт генерация"';
    const HARD_CEILING_MS = 20 * 60 * 1000; // абсолютный предохранитель от вечного зависания страницы
    // Отдельный предел на «вкладка МОЛЧИТ»: если Mistral не выдал НИ ОДНОГО символа
    // за это время (промт не принят / рендерер завис / кнопка так и не «загенерила»),
    // не ждём 20 мин HARD_CEILING — падаем в фолбэк (Qwen) быстро. Легитимная фаза
    // «поиск/раздумье» с пустым текстом длится секунды-десятки секунд, не минуты.
    const NO_OUTPUT_CEILING_MS = 3 * 60 * 1000;
    // Cloudflare увёл вкладку с чата → генерации не будет. Отдельная причина, а не
    // «зависла»: так в алерте видно настоящий диагноз (нас режут по частоте), и
    // вкладка пойдёт в утиль, а не вернётся в пул.
    const CF_BLOCKED = 'Mistral: Cloudflare увёл вкладку на заглушку (лимит запросов 1015) — вкладка выброшена';
    let lastCfCheckAt = Date.now();

    if (generationStarted) {
      // Фаза 2: AI генерирует — поллим DOM каждые 150мс и стримим текст сразу
      let confirmedDone = false;
      let lastLen = 0;
      let lastProgressAt = Date.now();
      const loopStart = Date.now();
      while (Date.now() - loopStart < HARD_CEILING_MS) {
        await page.waitForTimeout(150);
        if (await checkRateLimited()) throw new Error('Mistral: достигнут лимит сообщений (rate limit)');
        const rawLen = await getLastMessageRawLen(msgOffset);
        if (rawLen > lastLen) { lastLen = rawLen; lastProgressAt = Date.now(); }
        if (!partialFired) {
          const cur = await getLastMessageText(msgOffset);
          await maybeFirePartial(cur);   // финальный маркер [END_TEXT]
          await emitProgressive(cur);    // прогрессивный стриминг каждые 150мс
        }
        if (!(await checkGenerating())) {
          console.log('✅ Кнопка стала активной (генерация завершена)!');
          confirmedDone = true;
          break;
        }
        if (Date.now() - lastProgressAt > timeoutMs) throw new Error(STUCK_NOT_DONE);
      }
      if (!confirmedDone) throw new Error(STUCK_NOT_DONE);
    } else {
      // Кнопка не зафиксирована при старте (AI мог быть в фазе веб-поиска).
      // Стратегия: на каждой итерации проверяем кнопку снова — если AI перешёл
      // из "поиск" в "генерация", ловим это и переключаемся в button-mode (без задержек).
      console.log('⚡ Кнопка не зафиксирована — стриминг через стабилизацию (с переключением на button-mode)...');
      await page.waitForTimeout(200);
      let prevText = '';
      let stableCount = 0;
      let switchedToButtonMode = false;
      let confirmedDoneInButtonMode = false;
      let lastStuckCheckLen = 0;
      let lastStuckProgressAt = Date.now();
      const preButtonLoopStart = Date.now();
      while (Date.now() - preButtonLoopStart < HARD_CEILING_MS) {
        await page.waitForTimeout(200);
        if (await checkRateLimited()) throw new Error('Mistral: достигнут лимит сообщений (rate limit)');
        const cur = await getLastMessageText(msgOffset);
        await maybeFirePartial(cur);
        await emitProgressive(cur);

        // Перепроверяем кнопку: при веб-поиске AI сначала "ищет" (кнопка idle),
        // потом переходит в "генерацию" (кнопка aria-busy=true).
        if (await checkGenerating()) {
          console.log('⚡ Кнопка стала активной в fallback режиме — переключаюсь на button-mode');
          switchedToButtonMode = true;
          let lastLen = 0;
          let lastProgressAt = Date.now();
          const buttonLoopStart = Date.now();
          while (Date.now() - buttonLoopStart < HARD_CEILING_MS) {
            await page.waitForTimeout(150);
            if (await checkRateLimited()) throw new Error('Mistral: достигнут лимит сообщений (rate limit)');
            const rawLenInner = await getLastMessageRawLen(msgOffset);
            if (rawLenInner > lastLen) { lastLen = rawLenInner; lastProgressAt = Date.now(); }
            if (!partialFired) {
              const t = await getLastMessageText(msgOffset);
              await maybeFirePartial(t);
              await emitProgressive(t);
            }
            if (!(await checkGenerating())) {
              console.log('✅ Кнопка стала активной (генерация завершена) [из fallback]');
              confirmedDoneInButtonMode = true;
              break;
            }
            if (Date.now() - lastProgressAt > timeoutMs) throw new Error(STUCK_NOT_DONE);
          }
          break;
        }

        const rawLenOuter = await getLastMessageRawLen(msgOffset);
        if (rawLenOuter > lastStuckCheckLen) { lastStuckCheckLen = rawLenOuter; lastStuckProgressAt = Date.now(); }

        if (cur.length > 30 && cur === prevText) {
          stableCount++;
          if (stableCount >= 3) {
            console.log('✅ Текст стабилизирован (генерация завершена)');
            break;
          }
        } else {
          stableCount = 0;
        }
        prevText = cur;

        // На этой фазе AI мог ещё не начать (поиск/раздумье) — текст может быть
        // пустым подолгу легитимно, поэтому стак-проверка мягче основной фазы.
        if (Date.now() - lastStuckProgressAt > timeoutMs && rawLenOuter > 0) throw new Error(STUCK_NOT_DONE);
        // Вкладка МОЛЧИТ (ни символа) дольше NO_OUTPUT_CEILING — не ждём 20 мин
        // HARD_CEILING, а падаем в фолбэк: ловит зависшую/не принявшую промт вкладку
        // (реальный баг: задача висела ~20 мин на молчащем Mistral вместо Qwen).
        if (rawLenOuter === 0 && Date.now() - preButtonLoopStart > NO_OUTPUT_CEILING_MS) throw new Error(STUCK_NOT_DONE);
        // Вкладку могло увести на заглушку Cloudflare (1015 rate limit) — тогда
        // ждать бессмысленно: чата на странице больше нет. Проверяем раз в ~10с
        // и падаем сразу с внятной причиной вместо 3-минутного «зависания».
        if (Date.now() - lastCfCheckAt > 10_000) {
          lastCfCheckAt = Date.now();
          if (DEAD_TAB_URL_RE.test(page.url() || '')) throw new Error(CF_BLOCKED);
        }
      }
      if (switchedToButtonMode && !confirmedDoneInButtonMode) throw new Error(STUCK_NOT_DONE);
      if (!switchedToButtonMode && stableCount < 3) throw new Error(STUCK_NOT_DONE);
    }

    // Извлекаем текст + структурированный контент последнего сообщения
    console.log('📥 Парсинг финального ответа...');
    const extractFinalMessage = (leakMarkers) => {
      // Пробуем взять элементы только от ассистента (исключаем user-bubble с промтом)
      let allMessages = [];
      const selectors = ['[class*="message"]', '[class*="assistant"]', '.markdown', '.prose'];
      for (const s of selectors) {
        const els = document.querySelectorAll(s);
        if (els.length) allMessages = Array.from(els);
      }

      // Если элементов больше чем было до отправки + 1 (user-bubble), берём последний
      // (он будет AI-bubble). Если нет — защита: пропускаем элементы, чей текст начинается
      // с маркеров системного промта.
      let idx2 = allMessages.length - 1;
      let lastMsg = allMessages[idx2];
      while (lastMsg && leakMarkers.some((m) => lastMsg.textContent.includes(m)) && idx2 > 0) {
        console && console.warn('⚠️ Обнаружен prompt-leak в last message, берём предыдущий');
        idx2 -= 1;
        lastMsg = allMessages[idx2];
      }
      if (!lastMsg) return { text: '', canvasCount: 0, imgSrcs: [] };

      const clone = lastMsg.cloneNode(true);
      clone
        .querySelectorAll(
          'button, span[class*="copy"], [aria-label*="Copy"], footer, div[class*="code-header"], span[class*="timestamp"], time,' +
          'details, summary, [class*="think"], [class*="reason"], [class*="thought"], ' +
          '[class*="web-search"], [class*="tool-call"], [class*="tool_call"], [class*="source-card"], [class*="plugin"]'
        )
        .forEach((el) => el.remove());

      // Конвертируем Mistral rich-table (таблица спрятана в data-атрибуте, не <table>!)
      clone.querySelectorAll('[data-rich-table-inner-html]').forEach((wrapper) => {
        const html = wrapper.getAttribute('data-rich-table-inner-html');
        if (!html) { wrapper.remove(); return; }
        try {
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          const tbl = tmp.querySelector('table');
          if (!tbl) { wrapper.remove(); return; }
          const rows = Array.from(tbl.querySelectorAll('tr'));
          if (!rows.length) { wrapper.remove(); return; }
          const md = rows.map((row, ri) => {
            const cells = Array.from(row.querySelectorAll('th, td'))
              .map((c) => c.textContent.trim().replace(/\|/g, '\\|'));
            const line = '| ' + cells.join(' | ') + ' |';
            return ri === 0 ? line + '\n|' + cells.map(() => ' --- |').join('') : line;
          }).join('\n');
          wrapper.replaceWith(document.createTextNode('\n\n' + md + '\n\n'));
        } catch (e) { wrapper.remove(); }
      });

      // Конвертируем обычные HTML-таблицы → markdown
      clone.querySelectorAll('table').forEach((table) => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!rows.length) { table.remove(); return; }
        const mdRows = rows.map((row, rowIdx) => {
          const cells = Array.from(row.querySelectorAll('th, td'))
            .map((c) => c.textContent.trim().replace(/\|/g, '\\|'));
          const line = '| ' + cells.join(' | ') + ' |';
          if (rowIdx === 0) return line + '\n|' + cells.map(() => ' --- |').join('');
          return line;
        }).join('\n');
        table.replaceWith(document.createTextNode('\n\n' + mdRows + '\n\n'));
      });

      clone.querySelectorAll('br').forEach((el) => el.replaceWith(document.createTextNode('\n')));

      // Convert inline formatting to Markdown before textContent extraction
      clone.querySelectorAll('strong, b').forEach((el) => {
        el.prepend(document.createTextNode('**'));
        el.append(document.createTextNode('**'));
      });
      clone.querySelectorAll('em, i').forEach((el) => {
        el.prepend(document.createTextNode('*'));
        el.append(document.createTextNode('*'));
      });

      // Convert block structure to Markdown
      clone.querySelectorAll('h1').forEach((el) => { el.prepend(document.createTextNode('\n# ')); el.append(document.createTextNode('\n')); });
      clone.querySelectorAll('h2').forEach((el) => { el.prepend(document.createTextNode('\n## ')); el.append(document.createTextNode('\n')); });
      clone.querySelectorAll('h3').forEach((el) => { el.prepend(document.createTextNode('\n### ')); el.append(document.createTextNode('\n')); });
      clone.querySelectorAll('h4, h5, h6').forEach((el) => { el.prepend(document.createTextNode('\n#### ')); el.append(document.createTextNode('\n')); });
      clone.querySelectorAll('li').forEach((el) => { el.prepend(document.createTextNode('\n• ')); el.append(document.createTextNode('\n')); });
      clone.querySelectorAll('blockquote').forEach((el) => { el.prepend(document.createTextNode('\n> ')); el.append(document.createTextNode('\n')); });
      clone.querySelectorAll('p, div').forEach((el) => {
        el.prepend(document.createTextNode('\n'));
        el.append(document.createTextNode('\n'));
      });

      // Считаем canvas (графики) и собираем img src в оригинале (не clone)
      const canvasCount = lastMsg.querySelectorAll('canvas').length;
      const imgSrcs = Array.from(lastMsg.querySelectorAll('img[src]'))
        .map((img) => img.src)
        .filter((src) => src && src.startsWith('http') && !/avatar|icon|logo/i.test(src));

      return { text: clone.textContent || '', canvasCount, imgSrcs };
    };
    let extracted = await page.evaluate(extractFinalMessage, PROMPT_LEAK_MARKERS);

    if (!extracted.text || extracted.text.trim().length < 5) {
      throw new Error('Ответ получен, но текст пуст или слишком короткий');
    }

    // Графики/изображения генерируются Mistral отдельным tool-call'ом, который
    // может ещё работать несколько секунд ПОСЛЕ того как кнопка Stop уже
    // погасла (она отражает только текстовый стрим, не статус инструмента).
    // Если в ответе упомянут график/диаграмма, но картинки ещё нет — даём
    // дополнительное окно и пересчитываем снимок DOM один раз.
    if (extracted.imgSrcs.length === 0 && extracted.canvasCount === 0 &&
        /граф|диаграмм|визуализ|chart/i.test(extracted.text)) {
      console.log('⏳ Упомянут график без картинки — доп. ожидание tool-call (до 8с)...');
      await page.waitForTimeout(8000);
      const retried = await page.evaluate(extractFinalMessage, PROMPT_LEAK_MARKERS).catch(() => null);
      if (retried && (retried.imgSrcs.length > 0 || retried.canvasCount > 0)) {
        console.log(`✅ Доп. ожидание помогло: img=${retried.imgSrcs.length} canvas=${retried.canvasCount}`);
        extracted = retried;
      } else {
        console.log('⚠️ Картинка графика так и не появилась после доп. ожидания');
      }
    }

    // Убираем timestamp-артефакты вида "1:04am", "13:04" в конце текста (UI Mistral/Qwen)
    extracted.text = extracted.text
      .replace(/\s+\d{1,2}:\d{2}(?:am|pm)?\s*$/i, '')
      .trim();

    // Конвертируем img-URL в base64 через браузер (у него есть auth-куки Mistral)
    const attachments = [];
    for (const src of extracted.imgSrcs.slice(0, 5)) {
      try {
        const b64 = await page.evaluate(async (url) => {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return null;
          const blob = await res.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }, src);
        if (b64 && b64.startsWith('data:')) {
          attachments.push(b64);
          console.log(`✅ Изображение загружено как base64: ${src.slice(0, 60)}...`);
        }
      } catch (err) {
        console.warn('⚠️ Не удалось загрузить изображение:', err.message);
      }
    }
    if (extracted.canvasCount > 0) {
      console.log(`📊 Обнаружено ${extracted.canvasCount} canvas-элементов, скриншочу...`);
      try {
        for (const sel of [
          '[class*="message"]:last-of-type canvas',
          '[class*="assistant"]:last-of-type canvas',
          '.markdown canvas', '.prose canvas',
        ]) {
          const canvases = await page.$$(sel);
          for (const canvas of canvases.slice(0, 5)) {
            const shot = await canvas.screenshot({ type: 'png' });
            attachments.push('data:image/png;base64,' + shot.toString('base64'));
          }
          if (attachments.length > 0) break;
        }
        console.log(`✅ Захвачено вложений: ${attachments.length}`);
      } catch (err) {
        console.warn('⚠️ Canvas screenshot failed:', err.message);
      }
    }

    // Strip [END_TEXT] marker from final response (it's a streaming signal, not content)
    extracted.text = extracted.text.replace(/\[END_TEXT\]/g, '').trim();

    // Отбрасываем известные UI-фразы интерфейса Mistral, которые иногда попадают в парсер
    const MISTRAL_UI_PHRASES = [
      /designed for mobile devices/i,
      /offering better experience and more features/i,
      /get the (mistral|le chat) app/i,
      /try (our|le chat) (app|mobile)/i,
      /download.*app.*ios.*android/i,
      /open in (the )?app/i,
    ];
    if (MISTRAL_UI_PHRASES.some(re => re.test(extracted.text))) {
      console.warn('⚠️ Обнаружен UI-текст Mistral в финальном ответе — отброшен:', extracted.text.slice(0, 80));
      extracted.text = '';
    }

    // Last-resort hard gate: every DOM-level backup-and-retry above already tries
    // to avoid grabbing our own sent prompt, but this is the final checkpoint
    // before the text becomes task.result/botSettings content. Cleared to ''
    // rather than thrown — same treatment as the MISTRAL_UI_PHRASES check right
    // above — so the caller's EXISTING "empty response → retry once, then Qwen"
    // logic (processTask) picks it up automatically instead of a one-off error
    // with no retry.
    if (PROMPT_LEAK_MARKERS.some((m) => extracted.text.includes(m))) {
      console.error('❌ Финальный ответ всё ещё содержит сигнатуру нашего промта — отброшен целиком');
      extracted.text = '';
    }

    // Возвращаем текст + вложения (графики, изображения)
    return { text: extracted.text, attachments };
  }

  // Debug-only: appends which provider generated this response, e.g. "(MISTRAL)".
  // Toggle via DEBUG_TAG_MODEL=true in .env + pm2 restart — purely for live
  // testing/triage (e.g. "is this formatting bug specific to one provider?"),
  // never on by default.
  _debugModelTag(provider) {
    if (process.env.DEBUG_TAG_MODEL !== 'true' || !provider) return '';
    return `\n\n(${provider.toUpperCase()})`;
  }

  // 🔥 УЛУЧШЕННАЯ ФУНКЦИЯ ФИНАТИЧЕСКОГО ФОРМАТИРОВАНИЯ ТЕКСТА ДЛЯ UI
  formatResponse(text) {
    if (!text) return '';

    // Universal last-resort gate, regardless of provider (Groq/Mistral/Qwen) or
    // which extraction path the text came through: never let our own prompt
    // text (DB_COMMAND rules, [ЗАПРОС] section, etc.) reach the user as if it
    // were a real answer. Empty string is always safe — callers already treat
    // an empty response as "nothing to show" rather than crashing on it.
    if (AiService.PROMPT_LEAK_MARKERS.some((m) => text.includes(m))) {
      console.error('❌ formatResponse: текст содержит сигнатуру нашего промта — отброшен целиком');
      return '';
    }

    let safeText = text;

    // Удаляем технические артефакты
    safeText = safeText
      .replace(/Команда для базы данных:\s*/gi, '')
      .replace(/\s+xml\s*$/i, '')
      .replace(/\s+__DB_PLACEHOLDER__\s*/i, '')
      .replace(/(\d{1,2}:\d{2}\s*[ap]m)/gi, ''); // ← Убираем время в формате 12:30am/pm

    // Убираем утечку имени владельца аккаунта платформы (имя из профиля Mistral/Qwen)
    // Паттерн: обращение вида "Sib Ero", "Sib", имя+фамилия латиницей из 2-10 букв каждое
    safeText = safeText
      .replace(/\b(Sib\s+Ero|Sib\s+[A-Z][a-z]+|[A-Z][a-z]{1,9}\s+Ero)\b/g, 'вы')
      .replace(/,\s*(Sib\s+Ero|Sib\s+[A-Z][a-z]+|[A-Z][a-z]{1,9}\s+Ero)[!.,]?/g, '')
      .replace(/(Sib\s+Ero|Sib\s+[A-Z][a-z]+|[A-Z][a-z]{1,9}\s+Ero)[!.,]?\s*/g, '');

    // Убираем артефакты веб-поиска: строки из одного JSON-символа или голый JSON-объект
    safeText = safeText
      .replace(/^\s*[{}]\s*$/gm, '')               // строки с одним { или }
      .replace(/^\s*\{[^}]{0,120}\}\s*$/gm, '')    // строки вида {"key":"val"} без текста вокруг
      .replace(/^\s*\[[^\]]{0,120}\]\s*$/gm, '');  // строки вида ["a","b"] без текста вокруг

    if (safeText.length < 5) return '';

    safeText = safeText.replace(/\n{3,}/g, '\n\n').trim();

    return safeText.trim();
  }

  // ==================== УТИЛИТЫ ДЛЯ РАБОТЫ С ДАННЫМИ ====================

  // Strip AI "thinking" / chain-of-thought text that leaked into the response.
  // Mistral reasoning mode outputs English thinking, then the Russian answer — we strip the thinking.
  _stripThinking(text) {
    if (!text) return text;

    // Strip Mistral UI artifacts: "Thought for 2s" / "Worked for 2s" headers
    text = text.replace(/^(?:Thought|Worked)\s+for\s+[\d.]+\s*s\s*/i, '').trimStart();
    // Strip "Final answer:" / "Answer:" labels that leak after thinking
    text = text.replace(/^(?:Final\s+answer|Answer)\s*:\s*/i, '').trimStart();

    const trimmed = text.trimStart();
    // Quick exit: starts with Cyrillic, HTML tag, or common response starters
    if (/^[Ѐ-ӿ<✅❌⚠️•]/.test(trimmed)) return text;

    // Strategy 1 (legacy): emoji markers as definitive answer boundary
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (/^[❌✅⚠️]/.test(line) || /^<b>[❌✅⚠️]/.test(line)) {
        const candidate = lines.slice(i).join('\n').trim();
        if (candidate.length > 30) return candidate;
      }
    }

    // Strategy 2: paragraph-based Cyrillic detection.
    // Mistral thinking is English paragraphs; the actual answer is Russian paragraph(s) at the end.
    // Walk backwards through paragraphs collecting the "Russian tail", stop at first English paragraph.
    const paragraphs = text.split(/\n{2,}/);
    if (paragraphs.length < 2) return text;

    // ≥40% of letter-chars are Cyrillic → paragraph is considered Russian
    const isMostlyCyrillic = (p) => {
      const letters = p.match(/[a-zA-ZЀ-ӿ]/g) || [];
      if (letters.length < 5) return false;
      const cyr = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length;
      return cyr / letters.length >= 0.40;
    };

    let russianStart = -1;
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const p = paragraphs[i].trim();
      if (!p) continue;
      if (isMostlyCyrillic(p)) {
        russianStart = i;
      } else {
        break; // hit an English paragraph — stop collecting
      }
    }

    if (russianStart > 0) {
      const candidate = paragraphs.slice(russianStart).join('\n\n').trim();
      if (candidate.length > 10) return candidate;
    }

    // No clean boundary found — return original unchanged
    return text;
  }

  parseAIResponse(response) {
    const DB_COMMAND_REGEX    = /<DB_COMMAND>([\s\S]*?)<\/DB_COMMAND>/gi;
    const NOTIF_COMMAND_REGEX = /<NOTIF_COMMAND>([\s\S]*?)<\/NOTIF_COMMAND>/gi;
    const BULK_DOC_REGEX      = /<BULK_DOC>([\s\S]*?)<\/BULK_DOC>/gi;
    const CHART_DATA_REGEX    = /<CHART_DATA>([\s\S]*?)<\/CHART_DATA>/gi;
    const commands = [];
    const notifCommands = [];
    const bulkDocCommands = [];
    const chartCommands = [];
    let match;

    while ((match = BULK_DOC_REGEX.exec(response)) !== null) {
      try { bulkDocCommands.push(JSON.parse(match[1].trim())); }
      catch { console.warn('⚠️ Не удалось распарсить BULK_DOC'); }
    }

    // 📊 Извлекаем CHART_DATA — структурированные данные для детерминированного
    // рендеринга графика (QuickChart), а не картинку "на глаз" от самой модели
    // (та регулярно врёт цифры и превращает текст в нечитаемую кашу).
    while ((match = CHART_DATA_REGEX.exec(response)) !== null) {
      try { chartCommands.push(JSON.parse(match[1].trim())); }
      catch { console.warn('⚠️ Не удалось распарсить CHART_DATA'); }
    }

    // 🔥 Извлекаем ВСЕ DB-команды из ответа
    while ((match = DB_COMMAND_REGEX.exec(response)) !== null) {
      const raw = match[1].trim();
      try {
        commands.push(JSON.parse(raw));
      } catch {
        try {
          const fixed = fixMalformedJson(raw);
          commands.push(JSON.parse(fixed));
          console.log('✅ DB_COMMAND восстановлен после fix');
        } catch (err2) {
          console.warn('⚠️ Не удалось распарсить DB_COMMAND:', err2.message, '\nRaw:', raw.slice(0, 200));
        }
      }
    }

    // 🔔 Извлекаем NOTIF_COMMAND
    while ((match = NOTIF_COMMAND_REGEX.exec(response)) !== null) {
      const raw = match[1].trim();
      try {
        notifCommands.push(JSON.parse(raw));
      } catch {
        try {
          const fixed = fixMalformedJson(raw);
          notifCommands.push(JSON.parse(fixed));
          console.log('✅ NOTIF_COMMAND восстановлен после fix');
        } catch (err2) {
          console.warn('⚠️ Не удалось распарсить NOTIF_COMMAND:', err2.message, '\nRaw:', raw.slice(0, 200));
        }
      }
    }

    // 🔥 Вырезаем все теги из текста пользователя
    DB_COMMAND_REGEX.lastIndex = 0;
    NOTIF_COMMAND_REGEX.lastIndex = 0;
    BULK_DOC_REGEX.lastIndex = 0;
    CHART_DATA_REGEX.lastIndex = 0;
    let userResponse = response
      .replace(DB_COMMAND_REGEX, '')
      .replace(NOTIF_COMMAND_REGEX, '')
      .replace(BULK_DOC_REGEX, '')
      .replace(CHART_DATA_REGEX, '')
      // Also strip any incomplete/unclosed NOTIF_COMMAND tag (truncated response)
      .replace(/<NOTIF_COMMAND>[\s\S]*/gi, '')
      .replace(/<DB_COMMAND>[\s\S]*/gi, '')
      .replace(/<CHART_DATA>[\s\S]*/gi, '')
      .trim();

    // Strip English chain-of-thought reasoning if the AI leaked it before the final answer
    userResponse = this._stripThinking(userResponse);

    // Deduplicate identical create commands (Mistral sometimes emits the same DB_COMMAND twice)
    const seenCreates = new Set();
    const dedupedCommands = commands.filter(cmd => {
      if (cmd.action !== 'create') return true;
      const key = `${cmd.schema}::${JSON.stringify(cmd.data)}`;
      if (seenCreates.has(key)) {
        console.warn('⚠️ Дубликат DB_COMMAND create отброшен:', cmd.schema);
        return false;
      }
      seenCreates.add(key);
      return true;
    });

    if (!userResponse && (dedupedCommands.length > 0 || notifCommands.length > 0)) {
      userResponse = 'Готово! Изменения применены.';
    }

    return {
      userResponse,
      dbCommands:     dedupedCommands.length > 0   ? dedupedCommands   : null,
      notifCommands:  notifCommands.length > 0      ? notifCommands     : null,
      bulkDocCommands: bulkDocCommands.length > 0   ? bulkDocCommands   : null,
      chartCommands:  chartCommands.length > 0      ? chartCommands     : null,
    };
  }

  // Детерминированный рендер графика через QuickChart (а не "нарисованная"
  // моделью картинка — та регулярно искажает цифры и текст). labels/values
  // приходят из CHART_DATA-тега, который AI заполняет РЕАЛЬНЫМИ данными,
  // уже присутствующими у него в контексте.
  async _renderChartImage(chartCmd) {
    try {
      const { title, labels, values, type, label } = chartCmd || {};
      if (!Array.isArray(labels) || !Array.isArray(values) || labels.length === 0) return null;
      const chartType = ['bar', 'line', 'pie', 'doughnut'].includes(type) ? type : 'bar';
      const palette = ['#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6'];
      const isSliced = chartType === 'pie' || chartType === 'doughnut';
      const config = {
        type: chartType,
        data: {
          labels: labels.slice(0, 20).map((l) => String(l)),
          datasets: [{
            label: label || 'Значение',
            data: values.slice(0, 20).map((v) => Number(v) || 0),
            backgroundColor: isSliced
              ? labels.map((_, i) => palette[i % palette.length])
              : palette[0],
          }],
        },
        options: {
          plugins: {
            title: { display: !!title, text: title || '' },
            legend: { display: isSliced },
          },
        },
      };
      const r = await fetch('https://quickchart.io/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart: config, width: 600, height: 400, backgroundColor: 'white', format: 'png' }),
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch (err) {
      console.warn('⚠️ Рендер графика (QuickChart) не удался:', err.message);
      return null;
    }
  }

  async executeBulkDoc(userId, command) {
    const { schema, template, format = 'pdf', filter = {} } = command;
    if (!schema || !template) throw new Error('BULK_DOC: schema and template are required');

    const UserRecord = require('./models/UserRecord');
    const query = { userId, schemaName: schema };
    if (filter && Object.keys(filter).length > 0) {
      for (const [k, v] of Object.entries(filter)) {
        query[`data.${k}`] = v;
      }
    }
    const records = await UserRecord.find(query).lean();
    if (records.length === 0) throw new Error(`BULK_DOC: в схеме "${schema}" нет записей по фильтру`);

    const renderTemplate = (tmpl, data) =>
      tmpl.replace(/\{\{(\w+)\}\}/g, (_, key) => (data[key] !== undefined ? String(data[key]) : ''));

    const JSZip = require('jszip');
    const zip = new JSZip();

    const fs = require('fs');
    const FONT     = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const hasBold  = fs.existsSync(FONT_BOLD);
    const stripBold = s => s.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*\*/g, '');

    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      const text = renderTemplate(template, { ...rec.data, _id: rec._id.toString() });
      const baseName = `doc_${String(idx + 1).padStart(3, '0')}`;

      if (format === 'docx') {
        const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
        const children = text.split('\n')
          .filter(l => !/^[•·\-\*]\s*$/.test(l.trim()))
          .map(line => {
            const t = line.trimEnd();
            if (/^### /.test(t)) return new Paragraph({ text: t.slice(4).replace(/\*\*/g, ''), heading: HeadingLevel.HEADING_3 });
            if (/^## /.test(t))  return new Paragraph({ text: t.slice(3).replace(/\*\*/g, ''), heading: HeadingLevel.HEADING_2 });
            if (/^# /.test(t))   return new Paragraph({ text: t.slice(2).replace(/\*\*/g, ''), heading: HeadingLevel.HEADING_1 });
            if (t === '')         return new Paragraph({ text: '' });
            const bm = t.match(/^([•·]|\-|\*)\s+(.+)/);
            if (bm) {
              const parts = bm[2].split(/\*\*([^*]+)\*\*/g);
              return new Paragraph({ bullet: { level: 0 }, children: parts.map((p, i) => new TextRun({ text: p, bold: i % 2 === 1 })) });
            }
            const parts = t.split(/\*\*([^*]+)\*\*/g);
            return new Paragraph({ children: parts.map((p, i) => new TextRun({ text: p, bold: i % 2 === 1 })) });
          });
        const docx = new Document({ sections: [{ children }] });
        const buf = await Packer.toBuffer(docx);
        zip.file(`${baseName}.docx`, buf);
      } else {
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        if (fs.existsSync(FONT)) {
          doc.registerFont('Regular', FONT);
          if (hasBold) doc.registerFont('Bold', FONT_BOLD);
          doc.font('Regular');
        }
        let emptyRun = 0;
        for (const line of text.split('\n')) {
          const t = line.trimEnd();
          if (/^[•·\-\*]\s*$/.test(t)) continue;
          if (t === '') { emptyRun++; if (emptyRun === 1) doc.moveDown(0.35); continue; }
          emptyRun = 0;
          const hm = t.match(/^(#{1,3})\s+(.+)/);
          if (hm) {
            const sz = hm[1].length === 1 ? 16 : hm[1].length === 2 ? 14 : 12;
            doc.font(hasBold ? 'Bold' : 'Regular').fontSize(sz).text(stripBold(hm[2]));
            doc.font('Regular').fontSize(11).moveDown(0.2);
            continue;
          }
          if (/^\*\*[^*]+\*\*[:\s]*$/.test(t)) {
            doc.font(hasBold ? 'Bold' : 'Regular').fontSize(12).text(t.replace(/\*\*/g, '').trim());
            doc.font('Regular').fontSize(11); continue;
          }
          const bm = t.match(/^([•·]|\-|\*)\s+(.+)/);
          if (bm) { doc.fontSize(11).text(`• ${stripBold(bm[2])}`, { indent: 14 }); continue; }
          doc.fontSize(11).text(stripBold(t).replace(/\*([^*\n]+)\*/g, '$1'));
        }
        await new Promise(resolve => { doc.on('end', resolve); doc.end(); });
        zip.file(`${baseName}.pdf`, Buffer.concat(chunks));
      }
    }

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const token = require('crypto').randomBytes(16).toString('hex');
    const ext = format === 'docx' ? 'docx' : 'pdf';
    this.bulkDocJobs.set(token, {
      buf: zipBuf,
      filename: `siberi_bulk_${schema}.zip`,
      count: records.length,
      ext,
      expires: Date.now() + 3600000, // 1h TTL
    });
    // auto-cleanup
    setTimeout(() => this.bulkDocJobs.delete(token), 3600000);
    return { token, count: records.length };
  }

  async executeNotifCommand(userId, profileId, command) {
    const NotificationRule = require('./models/NotificationRule');
    const action = command.action || 'create';

    if (action === 'delete') {
      if (!command.name) throw new Error('NOTIF_COMMAND delete: name required');
      const result = await NotificationRule.deleteOne({ userId, name: command.name });
      console.log(`🔔 NOTIF_COMMAND delete: "${command.name}" (deleted: ${result.deletedCount})`);
      return result;
    }

    if (action === 'update') {
      if (!command.name) throw new Error('NOTIF_COMMAND update: name required');
      const rule = await NotificationRule.findOne({ userId, name: command.name });
      if (!rule) throw new Error(`NOTIF_COMMAND update: rule "${command.name}" not found`);
      const fields = ['enabled','recipientType','recipientChatId','recipientChatIdField',
                      'triggerType','schemaName','dateField','minutesBefore','reportHour','reportMinute','tzOffset','messagePrompt'];
      fields.forEach(f => { if (command[f] !== undefined) rule[f] = command[f]; });
      await rule.save();
      console.log(`🔔 NOTIF_COMMAND update: "${rule.name}"`);
      return rule;
    }

    // default: create
    const ruleData = {
      userId,
      profileId: command.profileId || profileId,
      name:               command.name              || 'Авто-уведомление',
      enabled:            command.enabled            !== false,
      recipientType:      command.recipientType      || 'user_field',
      recipientChatId:    command.recipientChatId    || '',
      recipientChatIdField: command.recipientChatIdField || '_tg_chat_id',
      triggerType:        command.triggerType        || 'time_before',
      schemaName:         command.schemaName         || '',
      dateField:          command.dateField          || 'date',
      minutesBefore:      command.minutesBefore      ?? 120,
      reportHour:         command.reportHour         ?? 9,
      reportMinute:       command.reportMinute       ?? 0,
      tzOffset:           command.tzOffset           ?? 3,
      messagePrompt:      command.messagePrompt      || '',
    };

    // Upsert by name to avoid duplicates from repeated requests
    const existing = await NotificationRule.findOne({ userId, name: ruleData.name });
    if (existing) {
      Object.assign(existing, ruleData);
      await existing.save();
      console.log(`🔔 NOTIF_COMMAND upsert (updated): "${ruleData.name}"`);
      return existing;
    }

    const rule = new NotificationRule(ruleData);
    await rule.save();
    console.log(`🔔 NOTIF_COMMAND create: "${ruleData.name}"`);
    return rule;
  }

  // Transliterate any string into a valid schema name (Latin + digits + underscore)
  _toSchemaName(raw) {
    const TRANSLIT = {
      'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
      'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
      'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
      'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    };
    return String(raw).toLowerCase()
      .split('').map((c) => TRANSLIT[c] ?? (c.match(/[a-z0-9]/) ? c : '_'))
      .join('').replace(/_+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50) || 'schema';
  }

  // autoTagChatId: when set (live Telegram end-user turns, never studio builds),
  // stamps newly created records with the same _tg_chat_id the scripted booking
  // flow in webhooks.js already uses — so a booking created live by the AI
  // (e.g. via an aiAction button) shows up in "Мои записи" (queryMySchema)
  // exactly like one created through the scripted phone-collection flow.
  async executeDBCommand(userId, command, taskId = null, profileId = null, autoTagChatId = null) {
    try {
      if (!command.action) {
        throw new Error('DB_COMMAND: missing action');
      }

      // 🔥 1. Отдельная обработка создания схемы
      if (command.action === 'create_schema') {
        const UserSchema = require('./models/UserSchema');
        let schemaData = command.schemaData || (typeof command.schema === 'object' ? command.schema : null);

        // AI sometimes puts the name in command.schema (string) and fields in schemaData without a name
        if (schemaData && !schemaData.name && command.schema && typeof command.schema === 'string') {
          schemaData = { ...schemaData, name: command.schema };
        }
        // Also try top-level name field
        if (schemaData && !schemaData.name && command.name) {
          schemaData = { ...schemaData, name: command.name };
        }
        // AI sometimes only sends label without name — auto-generate name from label
        if (schemaData && !schemaData.name && schemaData.label) {
          schemaData = { ...schemaData, name: schemaData.label };
        }

        if (!schemaData || !schemaData.fields?.length) {
          throw new Error('DB_COMMAND create_schema: missing fields');
        }
        // If still no name, use a fallback
        if (!schemaData.name) {
          schemaData = { ...schemaData, name: 'schema_' + Date.now() };
        }

        // Transliterate Cyrillic schema name → valid Latin identifier, preserve original as label
        const originalName = schemaData.name;
        schemaData = {
          ...schemaData,
          name: this._toSchemaName(originalName),
          label: schemaData.label || originalName,
        };

        console.log(`🔧 Создаю новую схему: ${schemaData.name}`);

        // 🔥 🔥 🔥 ИСПРАВЛЕНИЕ: Корректируем поле type для всех полей схемы
        const correctedFields = schemaData.fields.map((field) => {
          const allowedTypes = ['text', 'number', 'date', 'boolean', 'url', 'image', 'enum'];
          if (!allowedTypes.includes(field.type)) {
            console.warn(`⚠️ Исправлено невалидное type: "${field.type}" → "text"`);
            return { ...field, type: 'text' }; // По умолчанию заменяем на 'text'
          }
          return field;
        });

        const existing = await UserSchema.findOne({ userId, name: schemaData.name });
        if (existing) {
          existing.label = schemaData.label || existing.label;
          if (schemaData.description) existing.description = schemaData.description;
          existing.fields = correctedFields;
          if (schemaData.icon) existing.icon = schemaData.icon;
          if (schemaData.color) existing.color = schemaData.color;
          // Assign to profile if called from a profile context and not already assigned
          if (profileId) {
            const pid = String(profileId);
            if (!existing.profileIds.map(String).includes(pid)) {
              existing.profileIds.push(profileId);
            }
          }
          await existing.save();
          console.log(`✅ Схема "${schemaData.name}" обновлена (profileId: ${profileId || 'общие'})`);
          return { success: true, schemaId: existing._id, updated: true };
        }

        const newSchema = new UserSchema({
          userId,
          name: schemaData.name,
          label: schemaData.label || schemaData.name,
          description: schemaData.description || '',
          fields: correctedFields,
          icon: schemaData.icon || '📋',
          color: schemaData.color || '#3b82f6',
          profileIds: profileId ? [profileId] : [],
        });

        await newSchema.save();
        console.log(`✅ Схема "${schemaData.name}" создана (profileId: ${profileId || 'общие'})`);

        setImmediate(async () => {
          try {
            const { triggerEventRules } = require('./notificationProcessor');
            await triggerEventRules(userId, 'create_schema', schemaData.name, [{ data: { name: schemaData.name, label: schemaData.label } }], profileId);
          } catch {}
        });

        return { success: true, schemaId: newSchema._id };
      }

      // 🔥 2. Для операций с записями обязательно поле schema
      if (!command.schema) {
        throw new Error('DB_COMMAND: missing schema for record operation');
      }

      // Transliterate schema name so Cyrillic names match stored schema names
      const resolvedSchema = this._toSchemaName(command.schema);

      const { MongoClient, ObjectId } = require('mongodb');
      let client;

      try {
        client = new MongoClient('mongodb://localhost:27017');
        await client.connect();
        const db = client.db('siberiai_api');
        const collection = db.collection('userrecords');
        const userIdObj = new ObjectId(String(userId));

        console.log(`🔧 Выполняю MongoDB команду: ${command.action} для схемы "${resolvedSchema}"`);

        // Resolve relative date words to actual dates in any data object
        const _resolveRelDate = (val) => {
          if (typeof val !== 'string') return val;
          const v = val.trim().toLowerCase();
          const d = new Date();
          if (v === 'сегодня') return d.toLocaleDateString('ru-RU');
          if (v === 'завтра') { d.setDate(d.getDate() + 1); return d.toLocaleDateString('ru-RU'); }
          if (v === 'послезавтра') { d.setDate(d.getDate() + 2); return d.toLocaleDateString('ru-RU'); }
          if (v === 'вчера') { d.setDate(d.getDate() - 1); return d.toLocaleDateString('ru-RU'); }
          if (v === 'позавчера') { d.setDate(d.getDate() - 2); return d.toLocaleDateString('ru-RU'); }
          return val;
        };
        const resolveDatesInData = (obj) => {
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
          const out = {};
          for (const [k, v] of Object.entries(obj)) out[k] = _resolveRelDate(v);
          return out;
        };

        switch (command.action) {
          case 'delete': {
            if (!command.filter || Object.keys(command.filter).length === 0) {
              throw new Error('DB_COMMAND delete: filter is required');
            }
            // Build query: _id if provided, otherwise match by data fields
            const deleteQuery = { userId: userIdObj, schemaName: resolvedSchema };
            if (command.filter._id) {
              deleteQuery._id = new ObjectId(String(command.filter._id));
            } else {
              for (const [k, v] of Object.entries(command.filter)) {
                deleteQuery[`data.${k}`] = v;
              }
            }

            // Snapshot all matching records before deletion
            const recordsToDelete = await collection.find(deleteQuery).toArray();
            if (recordsToDelete.length === 0) {
              return { deletedCount: 0, error: 'Записи по фильтру не найдены' };
            }
            if (taskId) {
              for (const rec of recordsToDelete) {
                await UserRecordSnapshot.create({
                  taskId,
                  ownerId: userIdObj,
                  recordId: rec._id,
                  schemaName: resolvedSchema,
                  operation: 'delete',
                  fullDocBefore: rec,
                }).catch(() => {});
              }
            }

            const deleteResult = await collection.deleteMany(deleteQuery);
            console.log(`✅ Удалено записей: ${deleteResult.deletedCount}`);

            if (deleteResult.deletedCount > 0) {
              setImmediate(async () => {
                try {
                  const { triggerEventRules } = require('./notificationProcessor');
                  await triggerEventRules(userId, 'delete', resolvedSchema, recordsToDelete, profileId);
                } catch {}
                // Write-back для каждой удалённой записи
                for (const rec of recordsToDelete) {
                  try {
                    await writeBackToSource(userId, resolvedSchema, rec.data, 'delete', rec.metadata);
                  } catch {}
                }
              });
            }

            return deleteResult;
          }

          case 'update': {
            if (!command.filter || Object.keys(command.filter).length === 0 || !command.update) {
              throw new Error('DB_COMMAND update: missing filter or update data');
            }
            // Flatten if AI wrapped the fields inside a "data" key: {"update":{"data":{...}}}
            const rawFieldsRaw =
              command.update.data && typeof command.update.data === 'object' && !Array.isArray(command.update.data)
                ? command.update.data
                : command.update;
            const rawFields = resolveDatesInData(rawFieldsRaw);
            const updateFields = {};
            for (const key of Object.keys(rawFields)) {
              // AI sometimes uses "data.fieldName" dot-notation already — strip leading "data." to avoid double-prefixing
              const cleanKey = key.startsWith('data.') ? key.slice(5) : key;
              updateFields[`data.${cleanKey}`] = rawFields[key];
            }

            // Build update query: _id if provided, otherwise match by data fields
            const updateQuery = { userId: userIdObj, schemaName: resolvedSchema };
            if (command.filter._id) {
              updateQuery._id = new ObjectId(String(command.filter._id));
            } else {
              for (const [k, v] of Object.entries(command.filter)) {
                updateQuery[`data.${k}`] = v;
              }
            }

            // Снапшот перед обновлением
            if (taskId) {
              const docBefore = await collection.findOne(updateQuery);
              if (docBefore) {
                await UserRecordSnapshot.create({
                  taskId,
                  ownerId: userIdObj,
                  recordId: docBefore._id,
                  schemaName: resolvedSchema,
                  operation: 'update',
                  fullDocBefore: docBefore,
                }).catch(() => {});
              }
            }

            const updateResult = await collection.updateMany(updateQuery, { $set: updateFields });
            console.log(`✅ Обновлено записей: ${updateResult.modifiedCount}`);

            if (updateResult.modifiedCount > 0) {
              setImmediate(async () => {
                try {
                  const { triggerEventRules } = require('./notificationProcessor');
                  const changedRecord = { data: { ...command.filter, ...rawFields, _filter: command.filter } };
                  await triggerEventRules(userId, 'update', resolvedSchema, [changedRecord], profileId);
                } catch {}
                // Write-back: если схема с двусторонней синхронизацией
                try {
                  const updatedDoc = await collection.findOne(updateQuery);
                  if (updatedDoc) {
                    await writeBackToSource(userId, resolvedSchema, updatedDoc.data, 'update', updatedDoc.metadata);
                  }
                } catch {}
              });
            }

            return updateResult;
          }

          case 'create': {
            if (!command.data) {
              throw new Error('DB_COMMAND create: missing data');
            }
            // Required-field safety net: the prompt instructs the AI not to
            // create a record until every "required":true field has a real
            // value, but enforce it here too rather than trust that alone —
            // better to reject and log than silently save an incomplete
            // booking that LOOKS confirmed to the customer (the AI's own text
            // is already written by this point, so this can't fix THIS
            // turn's reply, but it stops the bad write from ever landing).
            const UserSchemaModel = require('./models/UserSchema');
            const schemaDoc = await UserSchemaModel.findOne({ userId, name: resolvedSchema }).lean();
            if (schemaDoc) {
              const missingRequired = (schemaDoc.fields || []).filter((f) => {
                if (!f.required || f.name === '_tg_chat_id') return false;
                const v = command.data[f.name];
                return v === undefined || v === null || v === '';
              });
              if (missingRequired.length > 0) {
                const names = missingRequired.map((f) => f.label || f.name).join(', ');
                console.warn(`⚠️ DB_COMMAND create отклонён — не хватает обязательных полей: ${names}`);
                return { error: `Не хватает обязательных полей: ${names}` };
              }
            }
            // ── Дедуп КАТАЛОЖНЫХ записей ────────────────────────────────────
            // Студия/владелец при правке иногда ПЕРЕСОЗДаёт уже существующие
            // позиции (реальный баг «спамит дубли в БД»). Если это НЕ персональная
            // запись клиента (autoTagChatId пуст) и НЕ схема заказов/броней/корзины
            // (там дубли легитимны), и в схеме есть поле-название, а запись с таким
            // же значением уже есть — пропускаем создание. Детерминированно.
            if (autoTagChatId == null && !/order|заказ|book|запис|брон|cart|корзин/i.test(resolvedSchema)) {
              const idField = (schemaDoc?.fields || []).find((f) =>
                /^(name|title|название|наименование|имя|товар|блюдо|позиция|product)$/i.test(f.name) ||
                /назван|наимен|товар|блюд|title|name/i.test(f.label || ''));
              const idVal = idField ? command.data[idField.name] : null;
              if (idField && typeof idVal === 'string' && idVal.trim()) {
                const esc = idVal.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const dup = await collection.findOne({
                  userId: userIdObj, schemaName: resolvedSchema,
                  [`data.${idField.name}`]: { $regex: `^\\s*${esc}\\s*$`, $options: 'i' },
                });
                if (dup) {
                  console.log(`⏭ Дубль пропущен: ${resolvedSchema}.${idField.name}="${idVal.trim()}"`);
                  return { skipped: true, reason: 'duplicate' };
                }
              }
            }
            // System-controlled identity tag — the AI sometimes "fills it in"
            // itself with a placeholder (e.g. "не указано") because it sees the
            // field name in the schema, which would silently defeat "Мои записи"
            // lookups. Our own value always wins when we have one.
            if (autoTagChatId != null) {
              command.data._tg_chat_id = autoTagChatId;
            }
            const insertResult = await collection.insertOne({
              userId: userIdObj,
              schemaName: resolvedSchema,
              data: resolveDatesInData(command.data),
              metadata: { createdBy: 'ai', source: 'ai', lastModifiedBy: 'ai' },
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            console.log(`✅ Создана запись с ID: ${insertResult.insertedId}`);

            setImmediate(async () => {
              try {
                const { triggerEventRules } = require('./notificationProcessor');
                const createdRecord = { data: resolveDatesInData(command.data) };
                await triggerEventRules(userId, 'create', resolvedSchema, [createdRecord], profileId);
              } catch {}
              // Write-back
              try {
                await writeBackToSource(userId, resolvedSchema, resolveDatesInData(command.data), 'create', null);
              } catch {}
            });

            // Снапшот после создания
            if (taskId) {
              await UserRecordSnapshot.create({
                taskId,
                ownerId: userIdObj,
                recordId: insertResult.insertedId,
                schemaName: resolvedSchema,
                operation: 'create',
                fullDocBefore: null,
                createdRecordId: insertResult.insertedId,
              }).catch(() => {});
            }

            return insertResult;
          }

          case 'dedupe': {
            // Удаляет ДУБЛИКАТЫ по полю (по умолчанию name/title): оставляет самую
            // старую запись каждого значения, остальные удаляет. Для «удали дубли
            // по name» — детерминированно, а не полагаясь на угадывание фильтра ИИ.
            const field = String(command.field || command.by || 'name').replace(/^data\./, '');
            const all = await collection.find({ userId: userIdObj, schemaName: resolvedSchema }).sort({ createdAt: 1 }).toArray();
            const seen = new Set();
            const toDelete = [];
            for (const rec of all) {
              const raw = rec.data?.[field];
              const key = (raw == null ? '' : String(raw)).trim().toLowerCase();
              if (!key) continue; // пустые значения не считаем дублями
              if (seen.has(key)) toDelete.push(rec._id); else seen.add(key);
            }
            if (!toDelete.length) return { deletedCount: 0, dedupeField: field };
            if (taskId) {
              for (const rec of all) {
                if (toDelete.some((id) => id.equals(rec._id))) {
                  await UserRecordSnapshot.create({ taskId, ownerId: userIdObj, recordId: rec._id, schemaName: resolvedSchema, operation: 'delete', fullDocBefore: rec }).catch(() => {});
                }
              }
            }
            const dedupeRes = await collection.deleteMany({ _id: { $in: toDelete } });
            console.log(`✅ Дедуп ${resolvedSchema} по "${field}": удалено ${dedupeRes.deletedCount}`);
            return { deletedCount: dedupeRes.deletedCount, dedupeField: field };
          }

          default:
            throw new Error(`DB_COMMAND: unknown action "${command.action}"`);
        }
      } finally {
        if (client) await client.close();
      }
    } catch (err) {
      console.error('❌ Ошибка выполнения MongoDB команды:', err.message);
      throw err;
    }
  }

  async buildDataContext(userId, maxRecordsPerSchema = 500, profileId = null, activeProfileIds = null, callerRole = 'creator', schemaVisibility = {}) {
    console.log(`🔍 buildDataContext: userId=${userId}, profileId=${profileId}, activeProfileIds=${JSON.stringify(activeProfileIds)}`);

    try {
      const UserSchema = require('./models/UserSchema');
      const UserRecord = require('./models/UserRecord');

      let schemaQuery = { userId, isActive: true };

      if (Array.isArray(activeProfileIds)) {
        // User explicitly chose which profiles to include in chat context
        // Always include common schemas + schemas assigned to selected profiles
        if (activeProfileIds.length > 0) {
          schemaQuery.$or = [
            { profileIds: { $size: 0 } },
            { profileIds: { $in: activeProfileIds } },
          ];
        } else {
          // All profiles deselected — only common schemas
          schemaQuery.$or = [{ profileIds: { $size: 0 } }];
        }
      } else if (profileId) {
        // Single profile filter (legacy / integrations path)
        schemaQuery.$or = [
          { profileIds: { $size: 0 } },
          { profileIds: profileId },
        ];
      }
      // else: no filter — include all schemas

      // Filter schemas based on visibility settings and caller role
      const schemas = (await UserSchema.find(schemaQuery).lean()).filter(schema => {
        if (callerRole === 'creator') return true; // creator sees everything
        const vis = schemaVisibility?.[schema.name] || 'all';
        if (vis === 'all') return true;
        if (vis === 'admin') return callerRole === 'admin';
        if (vis === 'creator') return false; // only creator, but caller is not creator
        return true;
      });
      console.log(`📊 Найдено схем: ${schemas.length}`);

      if (schemas.length === 0) {
        console.log('⚠️ У пользователя нет активных схем');
        return '';
      }

      // 🔥 Загружаем записи всех схем ПАРАЛЛЕЛЬНО вместо последовательно.
      // maxRecordsPerSchema<=0 → без лимита (грузим ВСЕ записи схемы): для живого
      // бота/веб-чата ИИ должен видеть всю базу целиком (сильная сторона Mistral —
      // огромный контекст), а не первые N записей.
      const allRecords = await Promise.all(
        schemas.map((schema) => {
          let q = UserRecord.find({ userId, schemaName: schema.name }).sort({ createdAt: -1 });
          if (maxRecordsPerSchema > 0) q = q.limit(maxRecordsPerSchema);
          return q.lean();
        })
      );

      const contextParts = [];
      contextParts.push('{');

      // Определения схем: поля, которые AI должен использовать при создании записей
      contextParts.push('  "schemas": {');
      for (let si = 0; si < schemas.length; si++) {
        const schema = schemas[si];
        const comma = si < schemas.length - 1 ? ',' : '';
        const fieldDefs = schema.fields
          .map((f) => `{"name":"${f.name}","label":"${f.label}","type":"${f.type}"${f.required ? ',"required":true' : ''}}`)
          .join(', ');
        contextParts.push(`    "${schema.name}": {"label":"${schema.label}","fields":[${fieldDefs}]}${comma}`);
      }
      contextParts.push('  },');

      contextParts.push('  "userData": {');

      for (let si = 0; si < schemas.length; si++) {
        const schema = schemas[si];
        const records = allRecords[si];

        console.log(`📋 Схема "${schema.name}": найдено записей ${records.length}`);

        contextParts.push(`    "${schema.name}": [`);

        for (const record of records) {
          contextParts.push(`      {`);
          contextParts.push(`        "_id": "${record._id}",`);
          contextParts.push(`        "data": {`);

          const schemaFieldNames = new Set(schema.fields.map((f) => f.name));
          const recordFields = schema.fields
            .map((f) => {
              const val = record.data[f.name];
              if (val !== undefined && val !== null && val !== '') {
                // Replace base64 blobs with a compact placeholder to keep context small
                if (typeof val === 'string' && val.startsWith('data:image/')) {
                  return `          "${f.name}": "[изображение]"`;
                }
                if (typeof val === 'string' && val.startsWith('data:')) {
                  // file stored as base64 — extract filename from JSON prefix if present
                  let fileName = 'файл';
                  try { fileName = JSON.parse(val.split(';;')[0])?.name || 'файл'; } catch {}
                  return `          "${f.name}": "[файл: ${fileName}]"`;
                }
                // file metadata JSON (name;;base64)
                if (f.type === 'file' && typeof val === 'string' && val.includes(';;')) {
                  let fileName = 'файл';
                  try { fileName = val.split(';;')[0]; } catch {}
                  return `          "${f.name}": "[файл: ${fileName}]"`;
                }
                return `          "${f.name}": ${typeof val === 'string' ? JSON.stringify(val) : val}`;
              }
              return null;
            })
            .filter(Boolean);
          // Also include extra fields not defined in schema (e.g. tg_username, name from Telegram)
          for (const [k, v] of Object.entries(record.data || {})) {
            if (!schemaFieldNames.has(k) && v !== undefined && v !== null && v !== '') {
              let displayVal = v;
              if (typeof v === 'string' && v.startsWith('data:image/')) displayVal = '[изображение]';
              else if (typeof v === 'string' && v.startsWith('data:')) displayVal = '[файл]';
              else if (typeof v === 'string' && v.includes(';;')) displayVal = `[файл: ${v.split(';;')[0]}]`;
              recordFields.push(`          "${k}": ${typeof displayVal === 'string' ? JSON.stringify(displayVal) : displayVal}`);
            }
          }

          contextParts.push(recordFields.join(',\n'));
          contextParts.push(`        }`);
          contextParts.push(`      },`);
        }

        if (records.length > 0) {
          contextParts[contextParts.length - 1] = contextParts[contextParts.length - 1].replace(
            /,$/,
            ''
          );
        }

        contextParts.push(`    ],`);
      }

      if (schemas.length > 0) {
        contextParts[contextParts.length - 1] = contextParts[contextParts.length - 1].replace(
          /,$/,
          ''
        );
      }

      contextParts.push('  }');
      contextParts.push('}');

      let context = contextParts.join('\n');
      if (context.length > 80000) {
        context = context.substring(0, 80000) + '\n  ... (данные обрезаны из-за большого объёма)\n  }\n}';
      }
      console.log(`✅ Контекст сформирован (${context.length} символов)`);
      return context;
    } catch (err) {
      console.error('❌ Ошибка buildDataContext:', err.message);
      return '';
    }
  }

  async buildScheduleContext(userId) {
    try {
      const UserScheduleConfig = require('./models/UserScheduleConfig');
      const UserRecord = require('./models/UserRecord');
      const configs = await UserScheduleConfig.find({ userId }).lean();
      if (!configs.length) return '';

      const now = new Date();
      const RU_DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
      const todayDow = (now.getDay() + 6) % 7; // 0=Mon..6=Sun
      const todayStr = now.toISOString().slice(0, 10);
      const nowMin = now.getHours() * 60 + now.getMinutes();

      const parts = [];
      parts.push(`--- РАСПИСАНИЕ И РАБОЧИЕ ЧАСЫ (на ${todayStr}, ${RU_DAYS_FULL[todayDow]}) ---`);
      parts.push(`Текущее время: ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`);
      parts.push('');

      for (const cfg of configs) {
        const workers = cfg.workers || [];
        if (!workers.length) continue;

        // Load recent records for this schema and filter today's in JS
        const allRecs = await UserRecord.find({ userId, schemaName: cfg.schemaName }).limit(300).lean();
        const todayRecs = allRecs.filter((r) => {
          const vals = Object.values(r.data || {});
          return vals.some((v) => typeof v === 'string' && v.startsWith(todayStr));
        });

        const workerField = cfg.workerField || null;

        parts.push(`Схема: ${cfg.schemaName}${workerField ? ` (поле мастера: ${workerField})` : ''}`);

        for (const w of workers) {
          const workingToday = (w.days || [0,1,2,3,4]).includes(todayDow);
          const startH = w.startH ?? 9;
          const endH = w.endH ?? 18;

          if (!workingToday) {
            parts.push(`  Мастер "${w.name}": ВЫХОДНОЙ`);
            continue;
          }

          // Find booked slots for this worker today
          const norm = (s) => String(s || '').trim().toLowerCase();
          const workerRecs = todayRecs.filter((r) => {
            if (!workerField) return true;
            return norm(r.data?.[workerField]) === norm(w.name);
          });

          const bookedMins = new Set();
          for (const r of workerRecs) {
            // Search all string values for a time pattern HH:MM
            for (const v of Object.values(r.data || {})) {
              const match = typeof v === 'string' ? v.match(/^(\d{1,2}):(\d{2})$/) : null;
              if (match) { bookedMins.add(parseInt(match[1]) * 60 + parseInt(match[2])); break; }
            }
          }

          // Calculate free slots (30-min intervals in working hours, after now)
          const freeSlots = [];
          for (let m = startH * 60; m < endH * 60; m += 30) {
            if (m <= nowMin) continue; // past
            if (!bookedMins.has(m)) {
              freeSlots.push(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
            }
          }

          const bookings = workerRecs.length;
          const wHours = `${String(startH).padStart(2,'0')}:00–${String(endH).padStart(2,'0')}:00`;
          parts.push(`  Мастер "${w.name}": работает ${wHours}, записей сегодня: ${bookings}, свободные слоты: ${freeSlots.length ? freeSlots.join(', ') : 'нет'}`);
        }
        parts.push('');
      }

      return parts.join('\n');
    } catch (err) {
      console.error('⚠️ buildScheduleContext:', err.message);
      return '';
    }
  }

  // ==================== ОБРАБОТКА ЗАДАЧИ ====================

  async processTask(task) {
    console.log(`⚡ Обработка: ${task.taskId}`);
    const startTime = Date.now();
    // pendingImages = in-memory store for ChatPage uploads; inputImages in context = Telegram/VK/MAX photos
    // Внешний API может прислать несколько картинок (скриншот + увеличенный фрагмент) —
    // Google AI получает их все, остальные провайдеры — первую, как раньше.
    const pendingImg = this.pendingImages.get(task.taskId);
    const imageList = (Array.isArray(pendingImg) ? pendingImg : (pendingImg ? [pendingImg] : []))
      .concat(!pendingImg && task.context?.inputImages?.length ? task.context.inputImages : [])
      .filter(Boolean).slice(0, 4);
    const imageBase64 = imageList[0] || null;
    this.pendingImages.delete(task.taskId);

    // ── Collect context images from records matching the prompt ──────────────
    // Triggered when user asks for photos/examples and records have image fields.
    // Up to (3 - inputImages) images are injected into the AI chat.
    const contextImages = [];
    const maxContextImages = Math.max(0, 3 - (imageBase64 ? 1 : 0));
    if (maxContextImages > 0) {
      try {
        const rawPrompt = (task.rawPrompt || task.prompt || '').toLowerCase();
        const IMAGE_KEYWORDS = [
          'фото', 'изображен', 'картинк', 'покажи', 'показ', 'примеры', 'работ',
          'портфол', 'галере', 'photo', 'image', 'picture', 'show', 'example', 'portfolio',
        ];
        const wantsImages = IMAGE_KEYWORDS.some(kw => rawPrompt.includes(kw));
        if (wantsImages) {
          const UserSchema = require('./models/UserSchema');
          const UserRecord = require('./models/UserRecord');
          const schemas = await UserSchema.find({ userId: task.userId, isActive: true }).lean();
          const imageSchemas = schemas.filter(s => s.fields.some(f => f.type === 'image'));
          for (const schema of imageSchemas) {
            if (contextImages.length >= maxContextImages) break;
            const imgFields = schema.fields.filter(f => f.type === 'image').map(f => f.name);
            const txtFields = schema.fields.filter(f => f.type !== 'image' && f.type !== 'file').map(f => f.name);
            const records = await UserRecord.find({ userId: task.userId, schemaName: schema.name }).limit(100).lean();
            for (const rec of records) {
              if (contextImages.length >= maxContextImages) break;
              // Check if prompt mentions a text field value OR only one image schema exists
              const matchesByText = txtFields.some(fn => {
                const v = rec.data?.[fn];
                return v && String(v).length > 2 && rawPrompt.includes(String(v).toLowerCase());
              });
              if (matchesByText || imageSchemas.length === 1) {
                for (const fn of imgFields) {
                  const v = rec.data?.[fn];
                  if (v && (v.startsWith('data:image/') || v.startsWith('http'))) {
                    contextImages.push(v);
                    if (contextImages.length >= maxContextImages) break;
                  }
                }
              }
            }
          }
          if (contextImages.length > 0) {
            console.log(`🖼 Контекстные изображения: ${contextImages.length}`);
          }
        }
      } catch (e) {
        console.warn('⚠️ contextImages сбор:', e.message);
      }
    }

    try {
      task.status = 'processing';
      await task.save();

      const user = await User.findById(task.userId);
      if (!user) throw new Error('User not found');

      // Выбор профиля: task.profileId → activeProfileId пользователя → первый профиль
      let config = null;
      if (task.profileId) {
        config = await UserAiConfig.findOne({ _id: task.profileId, userId: task.userId });
      }
      if (!config && user.activeProfileId) {
        config = await UserAiConfig.findOne({ _id: user.activeProfileId, userId: task.userId });
      }
      if (!config) {
        config = await UserAiConfig.findOne({ userId: task.userId });
      }
      // Сохраняем выбранный профиль в задаче (для фильтрации в панели управления)
      if (config && !task.profileId) {
        task.profileId = config._id;
        await task.save().catch(() => {});
      }
      // Если email фейковый (OAuth без email) — используем телефон как идентификатор
      const userEmail = user.email.includes('@oauth.local')
        ? (user.phone || user.email)
        : user.email;

      if (userEmail === 'demo@siberi.ai') {
        console.log('🎭 Демо-пользователь');

        const mistralId = getDemoChatId();
        const qwenId    = getDemoQwenId();
        const isFirst       = task.context?.isFirst ?? true;
        const historyLines  = task.context?.historyLines || '';
        const source        = task.context?.source || 'landing_demo_v2';

        // Системный промт онлайн-консультанта (для зарегистрированных пользователей)
        const supportSystemPrompt = `Ты — Помощник, онлайн-консультант платформы Siberi AI (siberi.online).
Никогда не упоминай Mistral AI, GPT, Claude или другие модели — ты Помощник Siberi AI.
🇷🇺 ЯЗЫК: Отвечай ИСКЛЮЧИТЕЛЬНО на русском языке, независимо от языка вопроса.
⚧ РОД: Ты — девушка, всегда отвечай в женском роде («Поняла», «Сделала», «Готова», «Уточнила» и т.д.).
Никогда не обращайся к пользователю по имени, фамилии или email из аккаунта — они конфиденциальны.
Ты говоришь с зарегистрированным пользователем. Отвечай профессионально, конкретно, дружелюбно.
Это продолжение диалога — НЕ здоровайся, сразу отвечай на вопрос.

## Навигация платформы
- **Панель управления** (/dashboard) — главная после входа: обзор аккаунта, статус подписки, быстрые действия, кнопка «Улучшить план»
- **Управление ИИ** (/panel) — история запросов, список пользователей бота, блокировка, откат изменений в данных
- **Чат с нейросетью** (/chat) — прямой чат с AI. Можно давать промты для создания схем данных («Создай схему для записи клиентов барбершопа» — AI создаст структуру и наполнит примерами)
- **Мои данные** (/data) — база знаний AI: схемы (структуры таблиц), записи (прайслисты, клиенты, расписания), импорт из Google Sheets / Excel / CSV / PostgreSQL / MongoDB, Data API (REST-доступ к данным). Схемы перетаскиваются между профилями.
- **Настройки AI** (/settings) — AI-профили (до 3 на Pro, Premium: без ограничений по числу интеграций; 1 на Standard), имя ассистента, системный промт, ограничения, права для администраторов и пользователей
- **Интеграции** (/integrations) — каналы: Telegram Bot, VK Bot, MAX Bot, виджет-консультант для сайта, AI-лендинг (готовый сайт с встроенным AI-чатом), REST API
- **Bot Studio** (/studio) — визуальный конфигуратор Telegram-бота: AI сам пишет системный промт, команды, приветствие, создаёт схемы данных — вы просто описываете что нужно. Доступно на Pro и Premium.
- **Подписка** (/billing) — тарифы:
  - Standard — 2 500 ₽/мес: 1 AI-профиль, 1 интеграция
  - Pro — 5 000 ₽/мес: 2 AI-профиля, до 2 интеграций, Bot Studio
  - Premium — 10 000 ₽/мес: 3 AI-профиля, безлимитные интеграции, все функции
  - Скидка 10% за 3 мес, 20% за год. Пробный период — 7 дней бесплатно (полный Premium-доступ, без карты).
- **Партнёрская программа** (/partner) — реферальная система: приглашай пользователей и получай бонусный доступ

## Ключевые возможности
- В /chat можно одним промтом создать всю схему данных — AI создаст структуру и сразу наполнит примерами
- Несколько AI-профилей = разные персонажи: консультант, продавец, поддержка — переключаются в /settings
- Голосовой ввод: кнопка микрофона в поле ввода (работает в браузере)
- Data API: читай данные напрямую через HTTP GET по API-ключу из любого приложения
- В /panel назначай администраторов — они видят все диалоги с ботом
- Bot Studio (/studio): опиши бота — AI сам настроит команды, сценарии, запишет системный промт (Pro+)
- Виджет-консультант: вставляется на сайт одной строкой кода, отвечает 24/7
- AI-лендинг: готовый сайт с AI-чатом — запуск за 5 минут без программиста

## О платформе
Siberi AI — платформа для создания персональных AI-помощников для бизнеса. Создан командой из Сибири.
Сайт: siberi.online | Поддержка: hello@siberi.online

${historyLines ? `## История диалога\n${historyLines}` : ''}

## Правила
- Используй markdown: **жирный**, ## заголовки, списки, абзацы
- Объясняй конкретно: где кнопка, как настроить, что делать
- Если не знаешь точного ответа — честно скажи и предложи написать на hello@siberi.online`;

        // Системный промт — демо-режим лендинга
        const demoSystemPrompt = `Ты — Помощник, AI-ассистент платформы Siberi AI (siberi.online).
Никогда не называй себя Mistral, GPT, Claude — только Помощник Siberi AI.
🇷🇺 ЯЗЫК: Отвечай ИСКЛЮЧИТЕЛЬНО на русском языке, независимо от языка вопроса. Никогда не переходи на английский или любой другой язык.
⚧ РОД: Ты — девушка, всегда отвечай в женском роде («Поняла», «Сделала», «Готова», «Уточнила» и т.д.).
КРИТИЧЕСКИ ВАЖНО: Никогда не используй имя, фамилию, никнейм или любые личные данные из аккаунта — обращайся к собеседнику нейтрально: «вы», без имён.
⚡ ГЛАВНОЕ ПРАВИЛО: Отвечай АБСОЛЮТНО на любой вопрос без исключений — погода, кулинария, история, математика, новости, что угодно. Ты демонстрируешь возможности AI — любой ответ уместен. НЕ отказывай в ответе и НЕ перенаправляй на тему Siberi, если вопрос не про платформу.
${isFirst ? 'Это первое сообщение — поприветствуй тепло, 1-2 предложения, затем сразу полный ответ.' : 'Продолжение диалога — НЕ здоровайся, сразу по делу.'}

О ПЛАТФОРМЕ:
Siberi AI — персональный AI-сотрудник для бизнеса. За 5 минут запускаешь умного ассистента без программиста и без кредитной карты.

Возможности: Telegram, VK, MAX, виджет на сайт, AI-лендинг, REST API; база знаний (прайслисты, расписания, FAQ); импорт Google Sheets / Excel / CSV / PostgreSQL / MongoDB; роли и доступы; голосовой ввод; Bot Studio.

Тарифы: Пробный — 7 дней бесплатно (полный Premium-доступ, без карты); Standard — 2500 ₽/мес; Pro — 5000 ₽/мес (Bot Studio); Premium — 10000 ₽/мес (безлимит). Скидка 10% за 3 мес, 20% за год.

Контакты: siberi.online | hello@siberi.online | 152-ФЗ.
${historyLines ? `\nИстория диалога:\n${historyLines}` : ''}

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА (нарушение недопустимо):
1. Заголовки разделов — ## Заголовок (обязательно если ответ длиннее 2 предложений)
2. Перечисления — ТОЛЬКО через "- пункт", никогда не через запятую
3. Ключевые слова и термины — **жирным**
4. После текстовой части (перед Фишкой) напиши на отдельной строке ровно: [END_TEXT] — технический маркер системы, пользователь его не видит.
5. После [END_TEXT] — отдельный абзац: > **Фишка:** [одна неочевидная возможность платформы]
6. Никогда не пиши сплошным текстом — всегда разбивай на разделы со списками

ВОПРОС ПОЛЬЗОВАТЕЛЯ:`;

        // Выбираем промт в зависимости от источника (бот-фолбэк передаёт свой промт явно)
        const activeSystemPrompt = task.context?.customSystemPrompt
          || (source === 'widget_support' ? supportSystemPrompt : demoSystemPrompt);

        // ── Tier 0: UltraGPT — ТОЛЬКО для /app и внешнего API (app_chat/external_api).
        // Лендинг-демо (landing_demo_v2) и виджет-консультант (widget_support) — там
        // простые короткие вопросы, скорость важнее → оставляем на быстром Groq (Tier 1).
        // ── Tier −1 (демо/внешний API): Gemini через «Режим ИИ» Google ──
        // Без квот, отвечает за 11-20с, длинный контекст уходит PDF-вложением
        // внутри драйвера. Ошибка — тихо вниз, на UltraGPT.
        if (process.env.GOOGLEAI_TIER0 === 'true' && (source === 'app_chat' || source === 'external_api')) {
          try {
            const googleai = require('./services/googleai');
            const onGaiPartial = async (t) => {
              task.partialResult = String(t).replace(/\[END_TEXT\]/g, '').trim();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            };
            const gaiRaw = await googleai.generate(task.prompt, activeSystemPrompt, onGaiPartial, { images: imageList });
            const { userResponse } = this.parseAIResponse(String(gaiRaw).replace(/\[END_TEXT\]/g, ''));
            const finalGai = (userResponse && userResponse.length >= 2) ? userResponse : String(gaiRaw).trim();
            if (!finalGai || finalGai.length < 2) throw new Error('пустой ответ Google AI');
            task.status = 'completed'; task.error = undefined;
            task.result = finalGai; task.completedAt = new Date();
            task.processingTime = Date.now() - startTime;
            await task.save();
            console.log(`✅ Демо Google AI: ${finalGai.length} символов за ${Date.now() - startTime}мс`);
            return finalGai;
          } catch (err) {
            console.warn(`⚠️ Google AI упал (${err.message}) — фолбэк на UltraGPT/Groq`);
          }
        }

        if (process.env.AI_PROVIDER === 'ultragpt' && !BROWSER_FALLBACKS_OFF && (source === 'app_chat' || source === 'external_api')) {
          try {
            const ultragpt = require('./services/ultragpt');
            const onUgPartial = async (t) => {
              task.partialResult = String(t).replace(/\[END_TEXT\]/g, '').trim();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            };
            const ugRaw = await ultragpt.generate(task.prompt, activeSystemPrompt, onUgPartial);
            const { userResponse } = this.parseAIResponse(String(ugRaw).replace(/\[END_TEXT\]/g, ''));
            const finalUg = (userResponse && userResponse.length >= 2) ? userResponse : String(ugRaw).trim();
            if (!finalUg || finalUg.length < 2) throw new Error('пустой ответ UltraGPT');
            task.status = 'completed'; task.error = undefined;
            task.result = finalUg; task.completedAt = new Date();
            task.processingTime = Date.now() - startTime;
            await task.save();
            console.log(`✅ Демо UltraGPT: ${finalUg.length} символов за ${Date.now() - startTime}мс`);
            return finalUg;
          } catch (err) {
            console.warn(`⚠️ UltraGPT упал (${err.message}) — фолбэк на Groq/Mistral`);
          }
        }

        // ── Tier 1: Groq — быстрый реальный API, пробуем первым ────────────────
        if (this.groq && !this.forceGroqOff && !this.groqDownSince) {
          try {
            const onGroqPartialText = async (textPart) => {
              task.partialResult = textPart.replace(/\[END_TEXT\]/g, '').trim();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            };
            const groqRaw = await this._streamGroq(task, activeSystemPrompt, 1500, onGroqPartialText);
            // Mistral/Qwen strip this marker before storing the result (AiService.js:1579,
            // QwenService.js:318) — Groq's raw completion needs the same treatment, it's a
            // streaming signal for the model, not content the user should ever see.
            const { userResponse } = this.parseAIResponse(groqRaw.replace(/\[END_TEXT\]/g, ''));
            if (!userResponse || userResponse.length < 5) throw new Error('Пустой ответ Groq');

            task.status = 'completed';
            task.error = undefined;
            task.result = userResponse;
            task.completedAt = new Date();
            task.processingTime = Date.now() - startTime;
            await task.save();
            console.log(`✅ Демо Groq: ${userResponse.length} символов за ${Date.now() - startTime}мс`);
            return userResponse;
          } catch (err) {
            console.warn(`⚠️ Демо Groq упал (${err.message}), пробуем Mistral...`);
            if (this._isGroqDown(err)) await this._onGroqDown();
          }
        }

        // ── Tier 2 / 3: существующая цепочка Mistral → Qwen (без изменений) ───
        if (BROWSER_FALLBACKS_OFF) {
          task.status = 'error';
          task.error = 'Google AI и Groq недоступны (браузерные провайдеры выключены)';
          task.completedAt = new Date();
          await task.save();
          return null;
        }
        let usedQwen = false;

        if (!this.forceQwen) {
          const page = await this.getPageForUser(task.userId, userEmail);

          // Страница всегда должна быть на /chat — если ещё на старом чате, ждём быстрой навигации
          try {
            const url = page.url();
            if (url.includes('/chat/') && url.match(/\/chat\/[a-f0-9-]{36}/i)) {
              await page.goto(`${MISTRAL_URL}/chat`, { waitUntil: 'commit', timeout: 5000 });
              // Небольшая пауза чтобы textarea появился после commit
              await page.waitForTimeout(300);
            }
          } catch (e) {
            console.warn('⚠️ Навигация к /chat:', e.message);
          }

          let _demoChatIdForCleanup = null;
          try {
            const sendResult = await this.sendPromptWithSystem(
              page, task.prompt, activeSystemPrompt, task.userId
            );

            // Progressive streaming callback — saves partialResult to DB as AI types
            const onDemoPartialText = async (textPart) => {
              task.partialResult = textPart;
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            };
            const { text: response, attachments: demoAttachments } = await this.waitForResponse(
              page, 90000, task.userId, sendResult.messagesBefore, onDemoPartialText
            );
            if (!response || response.length < 10) throw new Error('Пустой ответ Mistral');

            task.status = 'completed';
            task.error = undefined;
            task.result = response;
            task.attachments = demoAttachments || [];
            task.completedAt = new Date();
            task.processingTime = Date.now() - startTime;
            await task.save();
            console.log(`✅ Демо Mistral: ${response.length} символов за ${Date.now() - startTime}мс`);

            // Возвращаемся на /chat в фоне — удаляем чат только после полной загрузки страницы
            _demoChatIdForCleanup = page.url().match(/\/(?:chat|c)\/([a-f0-9-]{36})/i)?.[1];
            page.goto(`${MISTRAL_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 10000 })
              .then(() => {
                if (_demoChatIdForCleanup) this._deleteMistralChat(page, _demoChatIdForCleanup).catch(() => {});
              })
              .catch(() => {
                if (_demoChatIdForCleanup) setTimeout(() => this._deleteMistralChat(page, _demoChatIdForCleanup).catch(() => {}), 4000);
              });

            return response;
          } catch (err) {
            // Delete the chat even if request failed
            if (!_demoChatIdForCleanup) {
              try { _demoChatIdForCleanup = page.url().match(/\/(?:chat|c)\/([a-f0-9-]{36})/i)?.[1]; } catch {}
            }
            if (_demoChatIdForCleanup) {
              setTimeout(() => this._deleteMistralChat(page, _demoChatIdForCleanup).catch(() => {}), 3000);
            }
            console.warn(`⚠️ Демо Mistral упал (${err.message}), пробуем Qwen...`);
            if (this._isMistralDown(err)) await this._onMistralDown();
            usedQwen = true;
          }
        } else {
          usedQwen = true;
        }

        // Qwen fallback для демо
        if (usedQwen && this.qwen && qwenId) {
          try {
            // Rotation: force new Qwen chat every 20 requests
            if (!this._demoQwenReqCount) this._demoQwenReqCount = 0;
            this._demoQwenReqCount++;
            let activeQwenId = qwenId;
            if (this._demoQwenReqCount >= 20) {
              console.log(`🔄 Ротация Qwen демо-чата (${this._demoQwenReqCount} запросов)`);
              this._demoQwenReqCount = 0;
              activeQwenId = null;
            }

            const onQwenPartialText = async (textPart) => {
              task.partialResult = textPart;
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            };

            const { text: qwenRaw, chatId: newQwenChatId } = await this._getQwen().process(
              task, activeSystemPrompt, task.userId, activeQwenId, userEmail, onQwenPartialText
            );

            if (activeQwenId === null && newQwenChatId) {
              await this._updateEnvVar('DEMO_CHAT_ID_QWEN', newQwenChatId);
            }

            const { userResponse } = this.parseAIResponse(qwenRaw);
            if (!userResponse || userResponse.length < 5) throw new Error('Пустой ответ Qwen');

            task.status = 'completed';
            task.error = undefined;
            task.result = userResponse;
            task.completedAt = new Date();
            task.processingTime = Date.now() - startTime;
            await task.save();
            console.log(`✅ Демо Qwen fallback: ${userResponse.length} символов`);
            return userResponse;
          } catch (err) {
            console.error('❌ Демо Qwen тоже упал:', err.message);
          }
        }

        task.status = 'error';
        task.error = 'Оба AI-провайдера недоступны';
        task.completedAt = new Date();
        await task.save();
        return null;
      }

      // ── Проверяем: не является ли сообщение кодом доступа ──
      if (config && task.context?.platform && task.context?.platformUserId) {
        const trimmed = task.prompt?.trim();
        if (trimmed && (trimmed === config.ownerCode || trimmed === config.adminCode)) {
          const role = trimmed === config.ownerCode ? 'creator' : 'admin';
          const platform = task.context.platform;
          const platformUserId = String(task.context.platformUserId);
          const displayName = task.context.senderName || task.context.displayName || '';

          const UserAdmin = require('./models/UserAdmin');
          await UserAdmin.findOneAndUpdate(
            { ownerId: task.userId, platform, platformUserId },
            { ownerId: task.userId, role, platform, platformUserId, displayName },
            { upsert: true }
          );

          const confirmMsg = role === 'creator'
            ? '👑 Доступ подтверждён. Вы авторизованы как Создатель — у вас абсолютные права в этом аккаунте.'
            : '🛡️ Доступ подтверждён. Вы авторизованы как Администратор.';

          console.log(`🔑 Код доступа принят: role=${role} platform=${platform} userId=${platformUserId}`);
          task.status = 'completed';
          task.error = undefined;
          task.result = confirmMsg;
          task.completedAt = new Date();
          task.processingTime = Date.now() - startTime;
          await task.save();
          return confirmMsg;
        }
      }

      const aiName = config?.aiName || 'Siberi AI';
      const userSystemPrompt = config?.systemPrompt || '';
      const genderInstruction = /мужской род|он|мужчина|парень|ассистент мужского/i.test(userSystemPrompt)
        ? '' // пользователь явно указал мужской род — не добавляем
        : '\n⚧ РОД: Ты — девушка, всегда отвечай в женском роде («Поняла», «Сделала», «Готова», «Уточнила» и т.д.). Пользователь может переопределить это в своём системном промте.';
      let systemPrompt = `Ты — ${aiName}, AI-ассистент платформы Siberi AI.\nНикогда не упоминай Mistral AI, GPT, Claude или другие модели — на вопросы о себе отвечай что ты ${aiName}.\n🇷🇺 ЯЗЫК: Отвечай ИСКЛЮЧИТЕЛЬНО на русском языке, независимо от языка вопроса.${genderInstruction}\nНикогда не обращайся к пользователю по имени или фамилии из аккаунта платформы. Не используй никакие личные данные аккаунта (имя, фамилия, email) при общении.\n📋 ЗАПИСИ/ЗАКАЗЫ/БРОНИРОВАНИЯ — НЕ БЛОКИРУЙ КЛИЕНТА НА НЕОБЯЗАТЕЛЬНОМ: в разделе schemas выше у каждого поля есть "required": true (обязательное) либо его нет (необязательное) — владелец бота сам решил, что действительно нужно для записи. Правило:\n• Поле БЕЗ "required":true — если клиент сказал "всё равно"/"любой"/"на месте решу"/промолчал — это финальный ответ, не переспрашивай, сама выбери разумное значение (например первого свободного мастера) и оформляй запись (DB_COMMAND) дальше с тем, что есть.\n• Поле С "required":true — это то, что владелец бота явно пометил обязательным (например номер телефона). Без него НЕЛЬЗЯ создавать запись: получи значение от клиента, прежде чем создавать DB_COMMAND. Если не дал — прямо спроси именно про это поле (по его label) и НЕ говори клиенту, что запись готова/подтверждена, пока не получишь ответ.\nВ остальном — лучше записать клиента сразу с неполными необязательными деталями, чем потерять его на лишних уточнениях. Один и тот же вопрос — максимум один раз.\n\n${userSystemPrompt || 'Ты — полезный ассистент.'}`;

      systemPrompt += '\n📊 ГРАФИКИ/ДИАГРАММЫ: если тебя просят построить график, диаграмму или визуализацию — НЕ рисуй картинку сам своим инструментом генерации изображений (он искажает цифры и превращает текст/подписи в нечитаемую кашу) и НЕ пиши программный код (Python/matplotlib и т.п.) — вместо этого добавь в конец ответа тег с точными данными, мы сами отрендерим из них настоящий читаемый график:\n<CHART_DATA>{"type":"bar","title":"Заголовок","label":"Название ряда","labels":["Метка 1","Метка 2"],"values":[10,20]}</CHART_DATA>\n• type: "bar" | "line" | "pie" | "doughnut" (по умолчанию "bar")\n• labels/values — РЕАЛЬНЫЕ числа из доступных тебе данных, не придуманные\n• Этот тег пользователь не видит — текст ответа (включая обычное текстовое summary/таблицу с теми же цифрами) пиши как всегда, отдельно от тега.';

      if (config?.restrictions?.trim()) {
        systemPrompt += `\n\n--- ЗАПРЕЩЁННЫЕ ТЕМЫ (не обсуждай, вежливо перенаправляй) ---\n${config.restrictions}`;
      }

      // Platform-specific formatting instructions
      // endUser.platform reflects where the message is actually delivered (e.g.
      // notification-rule tasks have context.source:'notification' but always
      // end up sent to Telegram via endUser.platform — fall back to context.source
      // only for sources like web-chat/studio that don't set endUser at all).
      const platformSource = task.endUser?.platform || task.context?.source;

      // Telegram-specific formatting: HTML parse mode is enabled
      if (platformSource === 'telegram') {
        systemPrompt += `\n\n--- ФОРМАТ ОТВЕТА (Telegram) ---
Используй HTML-форматирование. СТРОГО соблюдай правила:

1. <b>жирный</b> — для названий, заголовков разделов
2. <i>курсив</i> — для подзаголовков категорий
3. <pre>...</pre> — ТОЛЬКО для программного кода. НЕ используй для прайсов, списков, каталогов.
4. НЕ используй Markdown-таблицы (| col | col |) — в Telegram они не работают.
5. НИКОГДА не используй звёздочки *так* или **так** для выделения — сообщение отправляется в HTML-режиме, звёздочки не превращаются в жирный текст, а остаются видны как обычные символы. Жирный — ТОЛЬКО через <b>...</b>. Не смешивай два формата в одном ответе.
6. Если в ответе несколько разделов (каждый со своим <b>Заголовком:</b> и пунктами под ним) — ОБЯЗАТЕЛЬНО разделяй их пустой строкой. Никогда не пиши заголовок и текст сразу после него в одной строке (НЕЛЬЗЯ: "<b>Заголовок:</b>текст..." или "...предыдущий пункт<b>Следующий заголовок:</b>") — после каждого заголовка перенос строки, перед каждым новым разделом — пустая строка.

Для прайсов, каталогов и перечней используй формат:
<b>✂️ Заголовок раздела</b>

• <b>Название позиции</b> — описание, цена, детали
• <b>Другая позиция</b> — описание

Для разбивки по категориям:
<i>Категория:</i>
• <b>Позиция 1</b> — описание
• <b>Позиция 2</b> — описание

Пример прайса услуг (только для СТИЛЯ оформления, это не реальные данные):
<b>✂️ Услуги барбершопа:</b>

• <b>Стрижка мужская</b> — 1500₽, 45 мин
• <b>Стрижка бороды</b> — 800₽, 25 мин
• <b>Детская стрижка</b> — 800₽, 30 мин

⚠️ Это пример СТИЛЯ оформления, не настоящие услуги. Когда отвечаешь на вопрос о реальных услугах/ценах/каталоге — используй ТОЛЬКО данные из раздела userData выше. Никогда не копируй названия или цифры из этого примера в ответ пользователю.`;
      }

      // VK: plain text only, no HTML tags supported
      if (platformSource === 'vk') {
        systemPrompt += `\n\n--- ФОРМАТ ОТВЕТА (ВКонтакте) ---
ВКонтакте не поддерживает HTML и Markdown. Используй только обычный текст. СТРОГО соблюдай правила:

1. Для заголовков — ЗАГЛАВНЫЕ БУКВЫ или эмодзи в начале строки
2. Для списков — символ • или эмодзи
3. НЕ используй Markdown-таблицы (| col | col |) — они не работают в ВК
4. НЕ используй HTML-теги (<b>, <i>, <pre> и т.д.)
5. Разделяй разделы пустой строкой

Пример прайса:
✂️ УСЛУГИ БАРБЕРШОПА

• Стрижка мужская — 1500₽ (45 мин)
• Стрижка бороды — 800₽ (25 мин)
• Детская стрижка — 800₽ (30 мин)

Пример каталога:
🏆 КЛАССИКА:
• Андеркат — короткие виски, удлинённый верх
• Помпадур — объёмный верх с зачёсом назад

⚠️ Оба примера выше — только для СТИЛЯ оформления, не настоящие данные. Когда отвечаешь на вопрос о реальных услугах/ценах/каталоге — используй ТОЛЬКО данные из раздела userData выше. Никогда не копируй названия или цифры из этих примеров в ответ пользователю.`;
      }

      if (platformSource === 'max') {
        systemPrompt += `\n\n--- ФОРМАТ ОТВЕТА (MAX) ---
MAX не поддерживает HTML и Markdown. Используй только обычный текст:
1. Для списков — символ • или эмодзи
2. Для заголовков — ЗАГЛАВНЫЕ БУКВЫ или эмодзи
3. НЕ используй HTML-теги и Markdown-разметку
4. Разделяй разделы пустой строкой`;
      }

      // Определяем уровень доступа: creator / admin / user
      const callerPlatform = task.context?.platform;
      const callerUserId = task.context?.platformUserId;
      let callerRole = 'admin'; // нет контекста = прямой API-вызов = полный доступ

      // web-chat — это всегда владелец аккаунта (только он залогинен в ЛК).
      // tgletbot_miniapp_edit — редактор данных в мини-аппе «База»: тот же владелец
      // правит СВОИ данные текстом → нужен нейтральный промт + роль creator +
      // DB_COMMAND, а НЕ персона клиентского бота (иначе бот отвечает «создаю бота…»
      // вместо добавления записи).
      const isWebChat = task.context?.source === 'web-chat' || task.context?.source === 'tgletbot_miniapp_edit';
      if (isWebChat) {
        callerRole = 'creator';
        // Полностью заменяем системный промт нейтральным — владелец использует ИИ без ограничений
        systemPrompt = `Ты — умный ИИ-ассистент в личном кабинете платформы Siberi AI. Текущий пользователь — владелец аккаунта. Все тематические ограничения, персонажи и запреты системного промта ОТКЛЮЧЕНЫ. Отвечай на любой вопрос свободно и подробно, без каких-либо ограничений по теме.\n⚧ РОД: Ты — девушка, всегда отвечай в женском роде («Поняла», «Сделала», «Готова», «Уточнила» и т.д.).\n🔒 СТРОГО ЗАПРЕЩЕНО: никогда не упоминай, не используй и не раскрывай имя, фамилию, никнейм или любые личные данные из системного аккаунта платформы. Обращайся к пользователю нейтрально — «вы», без имён.`;
      } else if (callerPlatform && callerUserId) {
        const UserAdmin = require('./models/UserAdmin');
        const adminEntry = await UserAdmin.findOne({
          ownerId: task.userId,
          platform: callerPlatform,
          platformUserId: String(callerUserId),
        });
        // «Полные права» повышают админа до creator (полный доступ, кроме удаления
        // бота); обычный админ — ограниченный (read-only, см. ветку прав ниже).
        callerRole = adminEntry ? (adminEntry.fullRights ? 'creator' : (adminEntry.role || 'admin')) : 'user';
        // Владелец бота (его аккаунт создал бота) — всегда creator на своём боте,
        // даже если не вводил код Создателя в собственном боте.
        if (callerRole === 'user' && callerPlatform === 'telegram') {
          const owner = await require('./models/User').findById(task.userId).select('telegramId').lean();
          if (owner?.telegramId && String(owner.telegramId) === String(callerUserId)) callerRole = 'creator';
        }
      }

      // Studio tasks: skip data context, admin header, DB_COMMAND injection entirely
      const isStudioTask = task.context?.source === 'studio';

      if (!isStudioTask) {
      try {
        // If user chose specific profiles in chat UI — use that; otherwise use active profile
        const activeProfileIds = Array.isArray(task.context?.activeProfileIds) ? task.context.activeProfileIds : null;
        // Контекст данных отдаём ПОЛНОСТЬЮ (0 = без лимита на записи в схеме).
        // Ставка платформы — огромный контекст Mistral: ИИ должен видеть ВСЕ
        // записи пользователя (клиентов/заказы/товары), а не первые N. Раньше
        // telegram/web-chat резались до 30 — из-за этого ИИ «не видел» большую
        // часть базы и отвечал неполно. maxRec=500 для прочих источников (там
        // огромный контекст Mistral не задействуется) — оставляем как было.
        const maxRec = (platformSource === 'telegram' || isWebChat) ? 0 : 500;
        const dataContext = await this.buildDataContext(task.userId, maxRec, config?._id || null, activeProfileIds, callerRole, config?.schemaVisibility || {});
        if (dataContext) {
          systemPrompt += `\n\n${dataContext}`;
          systemPrompt += `\n\n⚠️ ПРАВИЛО ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ: При создании записей обязательными считаются ТОЛЬКО поля с "required":true в схеме. Поля без этого флага — необязательны: создавай запись с теми данными, которые есть, не требуй остальные.

⚠️ ПРАВИЛО ИСТОЧНИКА ДАННЫХ: Когда пользователь спрашивает о своих данных (клиентах, записях, товарах, сотрудниках, заказах и т.д.) или просит изменить их — используй ИСКЛЮЧИТЕЛЬНО данные из раздела "userData" выше. Не опирайся на данные из истории переписки — она могла содержать другой контекст. Если нужной записи нет в "userData" — прямо скажи об этом. На общие вопросы (не связанные с данными пользователя) отвечай как обычно, используя свои знания.

🚨 КРИТИЧНО — ИСТОРИЯ ДИАЛОГА МОЖЕТ ВРАТЬ: Прошлые реплики "Ассистент:" в истории переписки — это просто текст, который был отправлен раньше, а НЕ подтверждение, что действие реально выполнено (из-за технического сбоя запись могла не сохраниться, хотя ассистент тогда написал "готово"/"забронировано"/"создано"). Если в истории написано, что что-то создано/забронировано/изменено, но в разделе "userData" выше этой записи СЕЙЧАС нет — считай, что она НЕ создана, прошлая реплика была ошибочной, и выполни действие заново (создай её сейчас). Никогда не отказывай в повторном действии и не утверждай "уже существует/конфликт", если подтверждающей записи нет в живых данных выше — единственный источник правды это "userData", а не прошлые слова ассистента.`;
          console.log('✅ Контекст добавлен в системный промт');
        } else {
          console.warn('⚠️ Контекст пустой, не добавлен');
        }

        // Inject schedule/working hours context if configured
        try {
          const scheduleCtx = await this.buildScheduleContext(task.userId);
          if (scheduleCtx) {
            systemPrompt += `\n\n${scheduleCtx}`;
            console.log('✅ Контекст расписания добавлен');
          }
        } catch (_) {}

        console.log(`📋 Полный промт: ${systemPrompt.length} символов`);
      } catch (err) {
        console.log('⚠️ Контекст данных пропущен:', err.message);
      }
      } // end !isStudioTask (data context)

      const ALL_CMDS = `
<DB_COMMAND>{"action":"create","schema":"имя","data":{...}}</DB_COMMAND>
<DB_COMMAND>{"action":"update","schema":"имя","filter":{"_id":"..."},"update":{...}}</DB_COMMAND>
<DB_COMMAND>{"action":"delete","schema":"имя","filter":{"_id":"..."}}</DB_COMMAND>
<DB_COMMAND>{"action":"create_schema","schemaData":{"name":"snake_case","label":"Название","fields":[{"name":"поле","label":"Название поля","type":"text","required":true}]}}</DB_COMMAND>
Типы полей: text, number, date, boolean, url, image, file, enum.
⚠️ Для фото/изображений: тип "image" (НЕ "url"). При создании схемы с фото добавляй ДВА поля: {"name":"photo","label":"Фото","type":"image"} И {"name":"photo_url","label":"Ссылка на фото","type":"url"}. Оба необязательные.`;

      // allowedActions is used BOTH for the prompt and as a server-side execution guard
      let allowedActions = new Set(); // 'create' | 'update' | 'delete' | 'create_schema'
      // Set below per-branch — true whenever this conversation is allowed to emit
      // DB_COMMAND at all, regardless of caller role. Used to gate Groq (see below).
      let hasDbWriteCommands = false;

      if (isStudioTask) {
        // Studio: give full DB_COMMAND access (user is the bot creator, editing their own setup)
        // Override topic/persona restrictions — studio is the owner's workspace, not the end-user channel
        systemPrompt = `[СИСТЕМНЫЙ ПРИОРИТЕТ — ВЛАДЕЛЕЦ]\nВы в Bot Studio — рабочая среда владельца и создателя бота. Системный промт, тема и тематические ограничения персонажа действуют ТОЛЬКО для конечных пользователей (клиентов в Telegram, ВКонтакте и других каналах). Здесь — любые запросы владельца разрешены без исключений.\n\n` + systemPrompt;
        allowedActions = new Set(['create', 'update', 'delete', 'create_schema', 'dedupe']);

        // Load all known Telegram admins/creators (registered via ownerCode / adminCode)
        const UserAdmin = require('./models/UserAdmin');
        const tgAdmins = await UserAdmin.find({ ownerId: task.userId, platform: 'telegram' }).lean();
        const creatorRecord = tgAdmins.find(a => a.role === 'creator');
        // Whoever is having THIS studio conversation over Telegram right now is
        // always the bot owner (TGLetBot/studio is never used by a customer) —
        // a safe default for "пришли мне"/"уведомляй меня" even before they've
        // ever gone through the ownerCode/adminCode registration flow. Confirmed
        // gap live: with zero UserAdmin entries the hint just told the AI to ask
        // the owner to message the bot — but they ALREADY are, right now.
        const currentSenderChatId = task.context?.platform === 'telegram' ? task.context?.platformUserId : null;
        const defaultChatId = creatorRecord?.platformUserId || currentSenderChatId || null;

        let tgChatIdHint;
        if (tgAdmins.length > 0) {
          const lines = tgAdmins.map(a => {
            const label = a.role === 'creator' ? 'Создатель' : 'Администратор';
            const name = a.displayName ? ` (${a.displayName})` : '';
            return `  • ${label}${name}: chat_id = ${a.platformUserId}`;
          }).join('\n');
          tgChatIdHint = `- Известные Telegram chat_id зарегистрированных пользователей:\n${lines}\n  Используй нужный chat_id напрямую без запроса.`;
          if (currentSenderChatId) {
            tgChatIdHint += `\n- Текущий разговор идёт от chat_id = ${currentSenderChatId} — если просят "пришли МНЕ"/"уведомляй МЕНЯ" без уточнения адресата, используй именно этот chat_id.`;
          }
        } else if (currentSenderChatId) {
          tgChatIdHint = `- recipientChatId — это ЧИСЛОВОЙ Telegram chat_id. Этот разговор идёт от chat_id = ${currentSenderChatId} — если пользователь просит "пришли МНЕ"/"уведомляй МЕНЯ" без уточнения адресата, используй именно этот chat_id напрямую, без вопросов.`;
        } else {
          tgChatIdHint = `- recipientChatId — это ЧИСЛОВОЙ Telegram chat_id. Если неизвестен — попроси пользователя написать боту в Telegram (это зарегистрирует его chat_id).`;
        }

        const notifTriggerTypes = `triggerType — доступные значения:
  • "record_created"  — мгновенно при создании записи
  • "record_updated"  — мгновенно при изменении записи
  • "record_deleted"  — мгновенно при удалении записи
  • "any_change"      — мгновенно при любом изменении (создание/обновление/удаление)
  • "schema_created"  — мгновенно при создании новой схемы данных
  • "new_record"      — опрос раз в 60с (устарело, лучше "record_created")
  • "time_before"     — за minutesBefore минут до события в поле dateField (нужно указать dateField)
  • "daily_report"    — ежедневно в reportHour часов (0-23)
schemaName: "" = все схемы; "имя_схемы" = только эта схема.`;

        // ⚠️ Без этого списка update/delete по имени бьют вслепую: модель не
        // видит ни одного реального правила и либо угадывает name (чаще всего
        // неверно — ошибка "rule not found" просто проглатывается), либо создаёт
        // ДУБЛИКАТ через action:"create" вместо правки существующего. Особенно
        // важно теперь, когда у каждого бота по умолчанию уже есть авто-созданное
        // правило "Ежедневный отчёт" — "отключи отчёт" должно бить точно в него.
        const NotificationRule = require('./models/NotificationRule');
        const existingRules = await NotificationRule.find({ userId: task.userId, profileId: config?._id }).select('name triggerType enabled reportHour recipientChatId recipients').lean();
        const existingRulesBlock = existingRules.length > 0
          ? `\n\nУЖЕ СУЩЕСТВУЮЩИЕ ПРАВИЛА (для action:"update"/"delete" используй ТОЧНОЕ совпадение name из списка ниже — никогда не угадывай имя и не создавай новое правило вместо правки существующего):\n` +
            existingRules.map(r => `  • name:"${r.name}" — ${r.triggerType}${r.triggerType === 'daily_report' ? `, в ${r.reportHour ?? 9}:00` : ''}, ${r.enabled ? 'включено' : 'ВЫКЛЮЧЕНО'}, получатель: ${r.recipientChatId || (r.recipients || []).join(',') || '—'}`).join('\n')
          : '';

        systemPrompt += `\n\n--- РАБОТА С ДАННЫМИ (СХЕМЫ И ЗАПИСИ) ---\n\nТы можешь создавать схемы данных и управлять записями прямо из Bot Studio. Используй стандартный формат:\n<DB_COMMAND>{"action":"create_schema","schemaData":{"name":"snake_case","label":"Название","fields":[{"name":"поле","label":"Название поля","type":"text","required":true}]}}</DB_COMMAND>\n<DB_COMMAND>{"action":"create","schema":"имя_схемы","data":{...}}</DB_COMMAND>\n<DB_COMMAND>{"action":"update","schema":"имя_схемы","filter":{"_id":"..."},"update":{...}}</DB_COMMAND>\n<DB_COMMAND>{"action":"delete","schema":"имя_схемы","filter":{"_id":"..."}}</DB_COMMAND>\n\nКоманды выполняются автоматически и не видны пользователю.\n\n⛔ ЗАПРЕТ: Никогда не показывай JSON, код или технические детали схем в тексте ответа. Никаких блоков \`\`\`json\`\`\` или \`\`\`code\`\`\`. Только понятный человеческий текст: что создаётся, зачем, что будет хранить. DB_COMMAND скрыты и выполняются сами.\n\n💡 ПРАВИЛО ПРИМЕРОВ: примеры записей нужны ТОЛЬКО в СПРАВОЧНЫХ/каталожных схемах — общих для всех клиентов (товары, меню, услуги, портфолио): сразу после create_schema дай СТРОГО 2 команды create с правдоподобными данными по теме.\n\n⛔ ПЕРСОНАЛЬНЫЕ схемы — те, что клиент заполняет сам через сценарий (адреса, заказы, корзина, записи/брони, заявки) — создавай ПУСТЫМИ, без единого примера. Иначе каждый клиент увидит чужой фейковый мусор в своём списке «Мои записи». И НИКОГДА не создавай запись-заглушку с текстом вроде «Ожидается ввод», «не указано» и т.п. — запись появляется только когда клиент реально что-то ввёл.\n\n⛔ ИДЕНТИФИКАТОР КЛИЕНТА: не создавай в схемах поле для id пользователя/чата (user_id, chat_id, tg_id, telegram_id, «ID пользователя» и подобные). Платформа САМА невидимо привязывает каждую запись клиента к его чату (скрытое системное поле _tg_chat_id), а queryMySchema сам показывает клиенту только его записи. Своё такое поле ты не заполнишь правильно (получается мусор вроде значения «_tg_chat_id») и оно протекает в «Мои записи». Просто не создавай его.\n\n--- АВТОМАТИЧЕСКИЕ УВЕДОМЛЕНИЯ ---\n\nТы можешь создавать, обновлять и удалять правила уведомлений.\n\nПравила:\n- Создавай не более 1-2 правил на запрос. Если нужно следить за всеми схемами — schemaName: "" (пустая строка = все схемы).\n- ВАЖНО: recipientChatId — ТОЛЬКО числовой Telegram chat_id, НЕ @username.\n${tgChatIdHint}\n- recipientType "specific_id" — фиксированный chat_id. "user_field" — chat_id берётся из поля записи (для уведомлений клиентам, указывай recipientChatIdField).\n\n${notifTriggerTypes}${existingRulesBlock}\n\nПример правила — уведомление при любом изменении:\n<NOTIF_COMMAND>{"action":"create","name":"Название","triggerType":"any_change","schemaName":"","recipientType":"specific_id","recipientChatId":"${defaultChatId || 'ЧИСЛОВОЙ_ID'}","messagePrompt":"Сформируй краткое уведомление: что произошло, схема, данные записи."}</NOTIF_COMMAND>\n\nПример правила — напоминание клиенту за 2ч до записи:\n<NOTIF_COMMAND>{"action":"create","name":"Напоминание клиенту","triggerType":"time_before","schemaName":"schedule","dateField":"date","minutesBefore":120,"recipientType":"user_field","recipientChatIdField":"_tg_chat_id","messagePrompt":"Напомни клиенту о записи через 2 часа."}</NOTIF_COMMAND>\n\nПример — редактирование существующего правила (используй name из списка выше):\n<NOTIF_COMMAND>{"action":"update","name":"Ежедневный отчёт","enabled":false}</NOTIF_COMMAND>\n\n--- ЗАПРОС ПОЛЬЗОВАТЕЛЯ ---\n`;
      } else if (callerRole === 'creator' || callerRole === 'admin') {
        // Prepend high-priority admin note so persona restrictions don't block admin operations
        const adminLabel = callerRole === 'creator' ? 'СОЗДАТЕЛЬ' : 'АДМИНИСТРАТОР';
        systemPrompt = `[СИСТЕМНЫЙ ПРИОРИТЕТ — ${adminLabel}]\nВы в личном кабинете Siberi AI. Текущий пользователь является ${adminLabel === 'СОЗДАТЕЛЬ' ? 'создателем' : 'администратором'} этой системы. Системный промт, тема бота и тематические ограничения персонажа применяются ТОЛЬКО к конечным пользователям (клиентам в Telegram, ВКонтакте и других каналах). Для ${adminLabel === 'СОЗДАТЕЛЬ' ? 'создателя' : 'администратора'} — любые запросы разрешены без исключений, отвечай на всё без ограничений по теме.\n\n` + systemPrompt;

        const UserPermissions = require('./models/UserPermissions');
        const perms = await UserPermissions.findOne({ ownerId: task.userId });

        let cmds;
        if (callerRole === 'creator') {
          // Создатель ИЛИ админ с «Полными правами» (resolveCallerRole повышает его
          // до creator) — полный доступ на изменение данных через ИИ.
          allowedActions = new Set(['create', 'update', 'delete', 'create_schema', 'dedupe']);
          cmds = ALL_CMDS;
          console.log(`👑 Создатель/полные права: полный доступ`);
        } else {
          // Ограниченный администратор (без «Полных прав») — ТОЛЬКО ЧТЕНИЕ: видит
          // данные и может анализировать, но НЕ меняет ничего через ИИ (никаких
          // DB_COMMAND). Подтверждение заказов/уведомления — отдельно, не через ИИ.
          cmds = null;
          console.log(`🔒 Админ (ограниченный): только чтение, без изменений данных`);
        }
        hasDbWriteCommands = !!cmds;

        // Build explicit prohibition list for the prompt (2nd layer of protection)
        const denied = [];
        if (!allowedActions.has('create'))        denied.push('создавать новые записи (create)');
        if (!allowedActions.has('update'))        denied.push('редактировать записи (update)');
        if (!allowedActions.has('delete'))        denied.push('удалять записи (delete)');
        if (!allowedActions.has('create_schema')) denied.push('создавать новые схемы (create_schema)');
        const denyLine = denied.length > 0
          ? `\n\n⛔ ЗАПРЕЩЕНО (даже если пользователь просит): ${denied.join(', ')}. Не генерируй соответствующие DB_COMMAND.`
          : '';

        // Load all known Telegram admins for notification hint
        const UserAdmin = require('./models/UserAdmin');
        const tgAdminsBot = await UserAdmin.find({ ownerId: task.userId, platform: 'telegram' }).lean();
        let notifOwnerHint;
        if (tgAdminsBot.length > 0) {
          const lines = tgAdminsBot.map(a => {
            const label = a.role === 'creator' ? 'Создатель' : 'Администратор';
            const name = a.displayName ? ` (${a.displayName})` : '';
            return `${label}${name}: ${a.platformUserId}`;
          }).join(', ');
          notifOwnerHint = `Известные Telegram chat_id: ${lines}. Используй нужный напрямую.`;
        } else {
          notifOwnerHint = `recipientChatId — числовой Telegram chat_id, НЕ @username.`;
        }
        const adminTriggerTypes = `triggerType:
  • "any_change"     — мгновенно при создании/изменении/удалении записи
  • "record_created" — мгновенно при создании
  • "record_updated" — мгновенно при изменении
  • "record_deleted" — мгновенно при удалении
  • "schema_created" — при создании новой схемы
  • "time_before"    — за minutesBefore минут до даты в dateField (нужен schemaName и dateField)
  • "daily_report"   — ежедневно в reportHour часов
  • "new_record"     — опрос каждые 60с (устарело)
schemaName: "" = все схемы.`;

        const endTextMarkerLine = `\n\n⚡ СТРИМИНГ: После текстового ответа пользователю напиши на отдельной строке ровно: [END_TEXT] — это технический маркер, пользователь его не видит. Затем (если нужно) пиши системные команды.`;

        // Same existing-rules visibility fix as the Studio branch above — see
        // that comment for why this matters (update/delete-by-name was blind).
        const NotificationRuleAdmin = require('./models/NotificationRule');
        const existingRulesAdmin = await NotificationRuleAdmin.find({ userId: task.userId, profileId: config?._id }).select('name triggerType enabled reportHour recipientChatId recipients').lean();
        const existingRulesBlockAdmin = existingRulesAdmin.length > 0
          ? `\n\nУЖЕ СУЩЕСТВУЮЩИЕ ПРАВИЛА (для action:"update"/"delete" используй ТОЧНОЕ совпадение name из списка ниже — никогда не угадывай имя и не создавай новое правило вместо правки существующего):\n` +
            existingRulesAdmin.map(r => `  • name:"${r.name}" — ${r.triggerType}${r.triggerType === 'daily_report' ? `, в ${r.reportHour ?? 9}:00` : ''}, ${r.enabled ? 'включено' : 'ВЫКЛЮЧЕНО'}, получатель: ${r.recipientChatId || (r.recipients || []).join(',') || '—'}`).join('\n')
          : '';

        if (cmds) {
          systemPrompt += `\n\n--- ФОРМАТ РАБОТЫ С ДАННЫМИ ---\n\nКогда нужно изменить данные пользователя, включи в ответ JSON-команды в следующем формате:\n${cmds}\n\nКоманды выполняются автоматически и не видны пользователю — он видит только твой текстовый ответ.\n\n⛔ КРИТИЧЕСКИ ВАЖНО: Никогда не показывай JSON, код или технические детали схем в тексте ответа — ни обычным текстом, ни в блоках \`\`\`json\`\`\`/\`\`\`code\`\`\`. Так данные НЕ создаются — реальное создание происходит ТОЛЬКО через теги DB_COMMAND выше. Человеческим текстом объясняй РЕЗУЛЬТАТ (что создано и зачем), а не сам JSON.\n\nПри создании новой схемы сразу добавь примеры записей: по умолчанию 1, но если пользователь явно указал количество ('пять примеров', '10 записей') — добавь именно столько отдельных команд create.\n\n📋 Если пользователь просит НЕСКОЛЬКО схем за один раз — обработай ВСЕ через цепочку DB_COMMAND одну за другой: create_schema для первой схемы → нужное число create для её записей → create_schema для следующей схемы → её записи → и так далее для каждой. Не сокращай и не описывай словами — каждая схема и каждая запись оформляется отдельным тегом DB_COMMAND.${denyLine}\n\n--- ПАКЕТНАЯ ГЕНЕРАЦИЯ ДОКУМЕНТОВ (BULK_DOC) ---\n\nКогда пользователь просит создать несколько документов сразу (счета для всех клиентов, акты за месяц, отчёты по каждой записи и т.п.) — используй команду:\n<BULK_DOC>{"schema":"имя_схемы","template":"Шаблон документа\\nЗначение поля: {{имя_поля}}\\nДругое: {{другое_поле}}","format":"pdf"}</BULK_DOC>\n\nПравила:\n- schema — имя схемы откуда брать записи\n- template — текст документа с подстановкой {{имя_поля}} из данных записи; используй {{_id}} для ID записи\n- format — "pdf" или "docx"\n- Сервер сам создаст по одному файлу на каждую запись и упакует всё в ZIP\n- После выполнения скажи пользователю сколько документов создано и что ZIP готов к скачиванию\n\nПример — счета для всех клиентов:\n<BULK_DOC>{"schema":"clients","template":"СЧЁТ\\n\\nКлиент: {{name}}\\nТелефон: {{phone}}\\nСумма: {{amount}} руб.\\nДата: {{date}}","format":"pdf"}</BULK_DOC>\n\n--- АВТОМАТИЧЕСКИЕ УВЕДОМЛЕНИЯ ---\n\nТы можешь создавать/обновлять/удалять правила уведомлений. Не более 1-2 правил за раз. schemaName:"" = все схемы. ${notifOwnerHint} ВАЖНО: recipientChatId — только числовой ID, НЕ @username.\n\n${adminTriggerTypes}${existingRulesBlockAdmin}\n\nПример — уведомление о любом изменении:\n<NOTIF_COMMAND>{"action":"create","name":"Изменения в данных","triggerType":"any_change","schemaName":"","recipientType":"specific_id","recipientChatId":"ЧИСЛОВОЙ_ID","messagePrompt":"Кратко опиши что изменилось: действие, схема, данные."}</NOTIF_COMMAND>\n\nПример — напоминание клиенту:\n<NOTIF_COMMAND>{"action":"create","name":"Напоминание клиенту","triggerType":"time_before","schemaName":"schedule","dateField":"date","minutesBefore":120,"recipientType":"user_field","recipientChatIdField":"_tg_chat_id","messagePrompt":"Напомни клиенту о визите."}</NOTIF_COMMAND>\n\nПример — редактирование существующего правила (используй name из списка выше):\n<NOTIF_COMMAND>{"action":"update","name":"Ежедневный отчёт","enabled":false}</NOTIF_COMMAND>${endTextMarkerLine}\n\n--- ЗАПРОС ПОЛЬЗОВАТЕЛЯ ---\n`;
        } else {
          systemPrompt += `\n\n⛔ У этого пользователя нет прав на изменение данных. Не генерируй никаких DB_COMMAND.${endTextMarkerLine}\n\n--- ЗАПРОС ПОЛЬЗОВАТЕЛЯ ---\n`;
        }
      } else {
        // Обычный пользователь
        const UserPermissions = require('./models/UserPermissions');
        const perms = await UserPermissions.findOne({ ownerId: task.userId });
        const allowCreate       = perms?.allowCreate       ?? true;
        const allowUpdate       = perms?.allowUpdate       ?? false;
        const allowDelete       = perms?.allowDelete       ?? false;
        const allowSchemaCreate = perms?.allowSchemaCreate ?? false;

        if (allowCreate)       allowedActions.add('create');
        if (allowUpdate)       allowedActions.add('update');
        if (allowDelete)       allowedActions.add('delete');
        if (allowSchemaCreate) allowedActions.add('create_schema');

        const cmds = [];
        if (allowCreate)       cmds.push(`<DB_COMMAND>{"action":"create","schema":"имя","data":{...}}</DB_COMMAND>`);
        if (allowUpdate)       cmds.push(`<DB_COMMAND>{"action":"update","schema":"имя","filter":{"_id":"..."},"update":{...}}</DB_COMMAND>`);
        if (allowDelete)       cmds.push(`<DB_COMMAND>{"action":"delete","schema":"имя","filter":{"_id":"..."}}</DB_COMMAND>`);
        if (allowSchemaCreate) cmds.push(`<DB_COMMAND>{"action":"create_schema","schemaData":{"name":"snake_case","label":"Название","fields":[{"name":"поле","label":"Название поля","type":"text","required":true}]}}</DB_COMMAND>`);
        hasDbWriteCommands = cmds.length > 0;

        const denied = [];
        if (!allowCreate)       denied.push('создавать записи (create)');
        if (!allowUpdate)       denied.push('редактировать (update)');
        if (!allowDelete)       denied.push('удалять (delete)');
        if (!allowSchemaCreate) denied.push('создавать схемы (create_schema)');
        const denyLine = denied.length > 0
          ? `\n\n⛔ ЗАПРЕЩЕНО (даже если пользователь просит): ${denied.join(', ')}. Не генерируй соответствующие DB_COMMAND. Не предлагай эти операции в ответе и не намекай на их возможность.`
          : '';

        const privacyLine = `\n\n⚠️ ПРАВИЛА ДЛЯ ОБЫЧНОГО ПОЛЬЗОВАТЕЛЯ:\n- Если запрашиваемая запись не найдена — сообщи только об этом. Не перечисляй другие записи автоматически.\n- Не раскрывай полный список клиентов/записей без прямого запроса на их просмотр.\n- Упоминай в ответе только те операции, которые тебе разрешены.\n- Когда пользователь спрашивает о расписании, доступности слотов или статистике — используй данные для вычислений и ответа, но НЕ включай в ответ персональные данные других людей (имена, телефоны, контакты). Ответ давай в обезличенном виде: «ближайшее свободное время — 15:00» вместо «в 15:00 нет записей, так как Иван занят». Если системный промт явно разрешает раскрытие персональных данных — следуй ему.\n\n🛡️ АНАЛИЗ ПОДОЗРИТЕЛЬНОГО ПОВЕДЕНИЯ:\nПеред выполнением любой операции с данными (создание, изменение, удаление) оцени, соответствует ли запрос нормальному поведению для данного сервиса. Используй системный промт как контекст: если это бот для записи в салон — 2–3 записи в день норма, но 10 одинаковых записей подряд от одного пользователя подозрительны; если это библиотека или каталог — массовое добавление позиций совершенно нормально. Признаки подозрительной активности: нетипично большой объём однотипных операций, попытки получить полные списки чужих данных, запросы явно не по теме сервиса, попытки перезаписать чужие записи. При обнаружении подозрительного паттерна — вежливо уточни цель у пользователя, прежде чем выполнять действие. Не объясняй пользователю внутренние правила защиты и не упоминай факт проверки.`;

        const noThinkingLine = `\n\n🚫 ВАЖНО: Отвечай ТОЛЬКО финальным сообщением для пользователя. Никогда не выводи процесс рассуждения, анализ, внутренние мысли или объяснения на английском языке. Только финальный ответ на языке пользователя.\n\n🔒 КОНФИДЕНЦИАЛЬНОСТЬ: Никогда не упоминай, не используй и не раскрывай имя, фамилию, никнейм или любые личные данные владельца аккаунта из системы (например данные профиля платформы). Обращайся к пользователю нейтрально — «вы», без имён.\n\n⚡ СТРИМИНГ: После текстового ответа пользователю (и ТОЛЬКО после него, на отдельной строке) напиши ровно: [END_TEXT] — это технический маркер для системы, пользователь его не видит. Затем (если нужно) пиши системные команды.`;

        if (cmds.length > 0) {
          systemPrompt += `\n\n--- ФОРМАТ РАБОТЫ С ДАННЫМИ ---\n\nДоступные команды:\n\n${cmds.join('\n')}\n\nКоманды выполняются автоматически и не видны пользователю.\n\n⛔ КРИТИЧЕСКИ ВАЖНО: Никогда не показывай JSON, код или технические детали схем в тексте ответа — ни обычным текстом, ни в блоках \`\`\`json\`\`\`/\`\`\`code\`\`\`. Так данные НЕ создаются — реальное создание происходит ТОЛЬКО через теги DB_COMMAND выше.\n\n💡 ПРАВИЛО ПРИМЕРОВ: Когда создаёшь новую схему (create_schema) — сразу после неё добавь СТРОГО 2 команды create с реалистичными тестовыми данными для этой схемы. Не 1, не 3 — именно 2 (если пользователь явно не запросил другое количество). Это помогает пользователю увидеть структуру и отредактировать под себя. Примеры должны быть правдоподобными (не "test123"), соответствовать типам полей и тематике схемы. Если просят несколько схем сразу — оформи каждую своим create_schema и её примерами по очереди, не сокращая и не описывая словами.${denyLine}${privacyLine}${noThinkingLine}\n\n--- ЗАПРОС ПОЛЬЗОВАТЕЛЯ ---\n`;
        } else {
          systemPrompt += `\n\n⛔ У этого пользователя нет прав на изменение данных. Не генерируй никаких DB_COMMAND.${privacyLine}${noThinkingLine}\n\n--- ЗАПРОС ПОЛЬЗОВАТЕЛЯ ---\n`;
        }
        console.log(`👤 Обычный пользователь: create=${allowCreate} update=${allowUpdate} delete=${allowDelete} schemaCreate=${allowSchemaCreate}`);
      } // end !isStudioTask (admin/user permissions block)

      // Groq реже соблюдает формат тегов DB_COMMAND на сложных запросах (создание схем,
      // бронирование/запись с несколькими полями и т.п.) — иногда уверенно подтверждает
      // действие пользователю, ничего не записав в базу. Для ботов, заведённых через
      // TGLetBot (user.telegramId), на это не идём на компромисс между скоростью и
      // надёжностью: Groq всё равно отвечает пользователю первым (быстро), а параллельно
      // Mistral (резерв — Qwen) молча проходит ту же переписку и сам выполняет
      // DB_COMMAND/NOTIF_COMMAND — пользователь этого второго прохода вообще не видит.
      // Остальные потоки (studio/webchat/widget/мини-апп) — как раньше, просто пропускают
      // Groq целиком. TODO: если хорошо себя покажет — расширить dualTrack на все боты.
      const dualTrackDataExec = hasDbWriteCommands && !!user.telegramId && task.context?.source === 'telegram';
      const skipGroqForDataChats = isStudioTask || isWebChat || task.context?.source === 'widget_support' || task.context?.source === 'tgletbot_miniapp_edit' || (hasDbWriteCommands && !dualTrackDataExec);

      // ── Tier −1: Gemini через «Режим ИИ» Google (флаг GOOGLEAI_TIER0=true) ──
      // Самый приоритетный: без квот и лимитов, отвечает за 11-20с. Длинный
      // контекст уходит вложением-PDF внутри драйвера, так что ограничений по
      // размеру промта нет. Любая ошибка — молча вниз, на UltraGPT.
      if (process.env.GOOGLEAI_TIER0 === 'true') {
        try {
          const googleai = require('./services/googleai');
          const onGaiPartial = async (textPart) => {
            const preview = this._extractTextPreview(textPart);
            if (preview) {
              task.partialResult = preview;
              task.textCompletedAt = new Date();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            }
          };
          const rawResponse = await googleai.generate(task.prompt, systemPrompt, onGaiPartial, { images: imageList });
          if (!rawResponse || rawResponse.length < 2) throw new Error('Пустой ответ Google AI');
          task.rawAiResponse = rawResponse;
          const finalUserResponse = await this._finalizeAgentResponse(rawResponse, [], {
            task, config, startTime, isStudioTask, isWebChat, contextImages, allowedActions, callerRole, provider: 'googleai',
          });
          console.log(`✅ Google AI: задача завершена за ${Date.now() - startTime}мс`);
          return finalUserResponse;
        } catch (gaiErr) {
          console.warn(`⚠️ Google AI упал (${gaiErr.message}), фолбэк на UltraGPT/Groq/Mistral...`);
        }
      }

      // ── Tier 0: UltraGPT (за флагом AI_PROVIDER=ultragpt) — ОСНОВНОЙ провайдер ──
      // Тот же собранный systemPrompt + task.prompt (весь контекст бота/базы/истории
      // уже внутри). DB_COMMAND/форматирование/история обрабатываются в
      // _finalizeAgentResponse (провайдер-агностично). При любой ошибке — фолбэк на
      // Groq/Mistral ниже. Покрывает кабинетный /chat, Telegram/VK-боты, ConstructorBot,
      // Studio — всё, что идёт через processTask.
      if (process.env.AI_PROVIDER === 'ultragpt' && !BROWSER_FALLBACKS_OFF) {
        try {
          const ultragpt = require('./services/ultragpt');
          const onUgPartial = async (textPart) => {
            const preview = this._extractTextPreview(textPart);
            if (preview) {
              task.partialResult = preview;
              task.textCompletedAt = new Date();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            }
          };
          const rawResponse = await ultragpt.generate(task.prompt, systemPrompt, onUgPartial);
          if (!rawResponse || rawResponse.length < 2) throw new Error('Пустой ответ UltraGPT');
          task.rawAiResponse = rawResponse;
          const finalUserResponse = await this._finalizeAgentResponse(rawResponse, [], {
            task, config, startTime, isStudioTask, isWebChat, contextImages, allowedActions, callerRole, provider: 'ultragpt',
          });
          console.log(`✅ UltraGPT: задача завершена за ${Date.now() - startTime}мс`);
          return finalUserResponse;
        } catch (ugErr) {
          console.warn(`⚠️ UltraGPT упал (${ugErr.message}), фолбэк на Groq/Mistral...`);
        }
      }

      // ── Tier 1: Groq — быстрый реальный API, пробуем первым (везде, как и в demo) ──
      if (this.groq && !this.forceGroqOff && !this.groqDownSince && !skipGroqForDataChats) {
        try {
          const onGroqPartial = async (textPart) => {
            const preview = this._extractTextPreview(textPart);
            if (preview) {
              task.partialResult = preview;
              task.textCompletedAt = new Date();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            }
          };
          const rawResponse = await this._streamGroq(task, systemPrompt, 4096, onGroqPartial);
          if (!rawResponse || rawResponse.length < 5) throw new Error('Пустой ответ Groq');
          task.rawAiResponse = rawResponse;

          if (dualTrackDataExec) {
            // Текст пользователю — от Groq, мгновенно. DB_COMMAND/NOTIF_COMMAND из
            // ОТВЕТА GROQ полностью игнорируются (он ненадёжен в этой части) — их
            // выполнение целиком передаётся фоновому проходу через Mistral/Qwen.
            const { userResponse: groqUserText } = this.parseAIResponse(rawResponse);
            const finalText = this.formatResponse(groqUserText) || 'Готово!';

            task.status = 'completed';
            task.error = undefined;
            task.result = finalText ? finalText + this._debugModelTag('groq') : finalText;
            task.attachments = contextImages.slice(0, 5);
            task.completedAt = new Date();
            task.totalProcessingTime = Date.now() - startTime;
            if (!task.processingTime) task.processingTime = task.totalProcessingTime;
            await task.save();

            setImmediate(() => {
              this._runShadowDataExec(task, systemPrompt, finalText, { allowedActions, callerRole, userEmail })
                .catch((e) => console.error('❌ Shadow-exec упал:', e.message));
            });

            console.log(`✅ Groq (dual-track): текст за ${Date.now() - startTime}мс, Mistral исполняет данные в фоне`);
            return finalText;
          }

          const finalUserResponse = await this._finalizeAgentResponse(rawResponse, [], {
            task, config, startTime, isStudioTask, isWebChat, contextImages, allowedActions, callerRole, provider: 'groq',
          });
          console.log(`✅ Groq: задача завершена за ${Date.now() - startTime}мс`);
          return finalUserResponse;
        } catch (groqErr) {
          console.warn(`⚠️ Groq упал (${groqErr.message}), пробуем Mistral...`);
          if (this._isGroqDown(groqErr)) await this._onGroqDown();
        }
      }

      // ── Выбор провайдера: Mistral (основной) или Qwen (резерв) ──────────────

      if (!this.forceQwen) {
        // pooledPage — вкладка из пула Mistral, взятая на ЭТОТ запрос; вернём её в
        // пул в finally. web-chat идёт по демо-странице и пул не использует.
        let pooledPage = null;
        try {
          // web-chat использует уже прогретую демо-страницу — не создаём новые вкладки.
          // Остальное (конструктор + живые боты) берёт вкладку из ПУЛА: до 5 запросов
          // параллельно, ответ читается из своей вкладки → не перепутается.
          const isWebChat = task.context?.source === 'web-chat';
          const page = isWebChat
            ? await this.getDemoPage()
            : (pooledPage = await this._acquireMistralPage());
          if (!page) throw new Error('Браузер отключился: пул Mistral пуст (реконнект)');

          // Запускаем загрузку истории параллельно с навигацией
          const historyPromise = !isStudioTask
            ? this.buildShortHistory(task.userId, 3)
            : Promise.resolve('');

          // Страница всегда должна быть на /chat (новый чат, готов к вводу)
          try {
            const url = page.url();
            if (url.includes('/chat/') && url.match(/\/chat\/[a-f0-9-]{36}/i)) {
              await page.goto(`${MISTRAL_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 10000 });
            }
          } catch (e) {
            console.warn('⚠️ Навигация к /chat:', e.message);
          }

          const shortHistory = await historyPromise;
          if (shortHistory) {
            systemPrompt += shortHistory;
            console.log('📜 История (последние 3 пары) добавлена в промт');
          }

          // Inject context images (extra images from user records) before prompt
          // Пропускаем для web-chat — автоинжект картинок из базы замедляет до 60+ сек
          if (contextImages.length > 0 && !isWebChat) {
            for (const ctxImg of contextImages) {
              try { await this._injectImageToChat(page, ctxImg); } catch {}
            }
          }

          let sendResult = await this.sendPromptWithSystem(
            page,
            task.prompt,
            systemPrompt,
            task.userId,
            imageBase64
          );

          // Callback: called when [END_TEXT] marker appears — saves partialResult immediately
          const onPartialText = async (textPart) => {
            task.partialResult = textPart;
            task.textCompletedAt = new Date();
            task.processingTime = Date.now() - startTime;
            await task.save().catch(() => {});
          };

          // NOTE: this is no longer "how long to wait before giving up" — completion
          // is detected purely by the generation button/icon (a real pattern), with
          // no upper bound on legitimate generation time. This value is now the
          // STUCK threshold passed into waitForResponse: how long the visible text
          // is allowed to sit completely unchanged while the button still claims
          // "generating" before we conclude the page itself is frozen (not the model
          // thinking) and bail out to retry/Qwen. Studio turns get a more patient
          // threshold since a paragraph-to-paragraph pause while writing several
          // schemas + examples can legitimately run longer than a plain chat reply.
          const mistralWaitMs = isStudioTask ? 280000 : 90000;
          const mistralRetryWaitMs = isStudioTask ? 200000 : 60000;

          let rawResponse, attachments;
          try {
            ({ text: rawResponse, attachments } = await this.waitForResponse(
              page,
              mistralWaitMs,
              task.userId,
              sendResult.messagesBefore,
              onPartialText
            ));
          } catch (waitErr) {
            // If response timed out, retry from fresh homepage once
            if (this._isMistralDown(waitErr)) {
              console.warn(`⚠️ Mistral не ответил — повторная попытка с чистой страницы...`);
              try {
                await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
                await page.waitForTimeout(800);
              } catch {}
              sendResult = await this.sendPromptWithSystem(page, task.prompt, systemPrompt, task.userId, imageBase64);
              ({ text: rawResponse, attachments } = await this.waitForResponse(page, mistralWaitMs, task.userId, sendResult.messagesBefore, onPartialText));
            } else {
              throw waitErr;
            }
          }

          if (!rawResponse || rawResponse.length < 10) {
            // Быстрый retry перед уходом на Qwen — иногда Mistral возвращает только DB_COMMAND без текста
            console.warn('⚠️ Mistral: пустой ответ — пробую ещё раз...');
            try {
              await page.goto(`${MISTRAL_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 8000 });
              await page.waitForTimeout(500);
              const retrySend = await this.sendPromptWithSystem(page, task.prompt, systemPrompt, task.userId, imageBase64);
              ({ text: rawResponse, attachments } = await this.waitForResponse(page, mistralRetryWaitMs, task.userId, retrySend.messagesBefore, onPartialText));
            } catch {}
            if (!rawResponse || rawResponse.length < 10) {
              throw new Error('Ответ пустой');
            }
          }

          task.rawAiResponse = rawResponse;

          // ── Partial result fallback: only if [END_TEXT] marker was NOT detected ──
          // onPartialText already set partialResult correctly when marker fired.
          // We only overwrite if it wasn't set yet (AI skipped the marker).
          if (!task.partialResult) {
            const textPreview = this._extractTextPreview(rawResponse);
            if (textPreview) {
              task.partialResult = textPreview;
              task.textCompletedAt = new Date();
              task.processingTime = Date.now() - startTime;
              await task.save().catch(() => {});
            }
          }

          const finalUserResponse = await this._finalizeAgentResponse(rawResponse, attachments, {
            task, config, startTime, isStudioTask, isWebChat, contextImages, allowedActions, callerRole, provider: 'mistral',
          });

          console.log(`✅ Mistral: задача завершена за ${Date.now() - startTime}мс`);

          // Возврат вкладки на /chat и удаление использованного чата делает
          // _releaseMistralPage (в finally) — АСИНХРОННО, но вкладка становится
          // доступной только после чистки, поэтому следующий запрос не попадёт на
          // страницу с недоудалённым чатом.
          return finalUserResponse;

        } catch (mistralErr) {
          if (!this._isMistralDown(mistralErr)) {
            // Программная ошибка — не пробуем Qwen
            throw mistralErr;
          }
          // Qwen отключён → фолбэка нет. Пробрасываем НАСТОЯЩУЮ причину Mistral
          // («генерация зависла» / Cloudflare 1015), а не маскирующее «Qwen
          // отключён» из _getQwen — иначе в алерте виден ложный диагноз, будто
          // проблема в резерве, а не в самом Mistral.
          if (!QWEN_FALLBACK_ENABLED) {
            if (pooledPage) { this._releaseMistralPage(pooledPage); pooledPage = null; }
            throw mistralErr;
          }
          console.warn(`⚠️ Mistral недоступен (${mistralErr.message})`);
          await this._onMistralDown();
          console.warn('🔄 Переключаюсь на Qwen...');
        } finally {
          // Возвращаем вкладку в пул на всех путях (успех/ошибка/переход на Qwen).
          if (pooledPage) this._releaseMistralPage(pooledPage);
        }
      } else {
        console.log('🔧 forceQwen=true: пропускаю Mistral');
      }

      // ── Qwen fallback ────────────────────────────────────────────────────────

      return await this._runQwen(task, systemPrompt, config, startTime, userEmail, allowedActions, callerRole, contextImages);

    } catch (err) {
      console.error('❌ Ошибка processTask:', err.message);
      task.status = 'error';
      task.error = err.message;
      task.completedAt = new Date();
      await task.save();
      // Central hook — covers every channel (Telegram/VK/MAX/web-chat/tgletbot)
      // since they all funnel through processTask. Callers still show their own
      // AI_FAILURE_MESSAGE text via helpers/aiFailureMessage.js; this just makes
      // sure the "alert the developer" half of that promise actually fires even
      // for failure paths a given caller didn't explicitly wire up.
      try {
        const { alertDeveloperOfAiFailure } = require('./helpers/aiFailureMessage');
        alertDeveloperOfAiFailure({ source: task.context?.source || 'unknown', userId: task.userId, reason: err.message, taskId: task.taskId }).catch(() => {});
      } catch {}
      return null;
    }
  }

  // ── Studio: извлечь JSON-блок изменений, применить к профилю, вернуть текст ──

  // Extract a named XML-style tag from text. Returns content or null if absent.
  // Works even if the closing tag is missing (truncated response).
  // Extract the user-visible text portion of a raw AI response.
  // Priority: [END_TEXT] marker → first system XML tag → full text (fallback)
  _extractTextPreview(raw) {
    if (!raw) return '';
    const MARKER = AiService.TEXT_DONE_MARKER;
    // 1. Use [END_TEXT] marker if present (most accurate)
    const markerIdx = raw.indexOf(MARKER);
    if (markerIdx !== -1) {
      const text = this._stripThinking(raw.slice(0, markerIdx).trim());
      return this.formatResponse(text) || '';
    }
    // 2. Fall back to first system XML tag
    const SYSTEM_TAGS = ['<DB_COMMAND>', '<BOT_SETTINGS>', '<BOT_COMMANDS>', '<BOT_PREVIEW>', '<WELCOME_MESSAGE>', '<NOTIF_COMMAND>', '<ADD_COMMANDS>', '<REMOVE_COMMANDS>', '<PATCH_COMMANDS>'];
    let cutAt = raw.length;
    for (const tag of SYSTEM_TAGS) {
      const idx = raw.indexOf(tag);
      if (idx !== -1 && idx < cutAt) cutAt = idx;
    }
    const text = this._stripThinking(raw.slice(0, cutAt).trim());
    return this.formatResponse(text) || '';
  }

  _extractTag(text, tag) {
    // Tolerate the model dropping underscores in the tag name (observed in the
    // wild: <BOTSETTINGS> instead of <BOT_SETTINGS>) — match either spelling.
    const loose = tag.split('_').join('_?');
    const openRe = new RegExp(`<${loose}>`, 'i');
    const closeRe = new RegExp(`<\\/${loose}>`, 'i');
    const openMatch = openRe.exec(text);
    if (!openMatch) return null;
    const contentStart = openMatch.index + openMatch[0].length;
    const closeMatch = closeRe.exec(text.slice(contentStart));
    return (closeMatch ? text.slice(contentStart, contentStart + closeMatch.index) : text.slice(contentStart)).trim();
  }

  // Defense in depth: if the model invents/garbles a tag name we don't even
  // recognize as a loose variant, still strip anything shaped like an
  // ALLCAPS XML-ish tag block (config/JSON payload) rather than ever let it
  // reach the end user — this is what stands between a model formatting slip
  // and a raw system prompt leaking into someone's Telegram chat.
  _stripStudioArtifacts(text) {
    if (!text) return text;
    return text.replace(/<([A-Za-z][A-Za-z_]{3,29})>[\s\S]*?(?:<\/\1>|$)/gi, '').trim();
  }

  // Try JSON.parse; on failure attempt to recover a truncated array by
  // dropping the last incomplete element.
  // Экранирует НЕэкранированные двойные кавычки ВНУТРИ строковых значений — самая
  // частая ошибка Mistral, рушащая весь BOT_COMMANDS (напр. салон "Nail Art"
  // внутри "response":"…" → невалидный JSON → кнопки не применялись, «бот без
  // кнопок»). Структурную кавычку (перед :,}] или в конце) НЕ трогаем — только
  // ту, за которой идёт не-структурный символ (значит она внутри текста).
  _repairInnerQuotes(str) {
    const s = String(str);
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
      if (ch === '\\') { out += ch + (s[i + 1] || ''); i++; continue; } // уже экранированная пара
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const next = s[j];
        if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
          out += ch; inStr = false;          // структурная закрывающая кавычка
        } else {
          out += '\\"';                        // внутренняя кавычка → экранируем
        }
        continue;
      }
      out += ch;
    }
    return out;
  }

  _tryParseJson(str) {
    try { return JSON.parse(str); } catch {}
    // Ремонт внутренних неэкранированных кавычек ("салон "Nail Art"" и т.п.).
    try { return JSON.parse(this._repairInnerQuotes(str)); } catch {}
    // Ремонт общих косяков (одиночные кавычки, trailing-запятые, усечение).
    try { return JSON.parse(fixMalformedJson(str)); } catch {}
    try { return JSON.parse(fixMalformedJson(this._repairInnerQuotes(str))); } catch {}
    // Drop last (possibly incomplete) object in an array and retry.
    const lastGood = str.lastIndexOf('},{');
    if (lastGood !== -1) {
      const head = str.slice(0, lastGood + 1) + ']';
      try { return JSON.parse(head); } catch {}
      try { return JSON.parse(this._repairInnerQuotes(head)); } catch {}
    }
    return null;
  }

  // ── Shared "raw AI text → saved task + scheduled side-effects" pipeline ───────
  // Used by Mistral, Groq and Qwen alike — whichever provider answered, the
  // DB_COMMAND/NOTIF_COMMAND/BULK_DOC parsing and execution must be identical.
  async _finalizeAgentResponse(rawResponse, attachments, ctx) {
    const { task, config, startTime, isStudioTask, isWebChat, contextImages, allowedActions, callerRole, provider } = ctx;

    let finalUserResponse;
    let dbCommands = [];
    let notifCommands = [];
    let chartCommands = [];

    if (isStudioTask) {
      const parsed = this.parseAIResponse(rawResponse);
      dbCommands = parsed.dbCommands || [];
      notifCommands = parsed.notifCommands || [];
      chartCommands = parsed.chartCommands || [];
      finalUserResponse = await this._applyStudioChanges(parsed.userResponse, task);
    } else {
      const parsed = this.parseAIResponse(rawResponse);
      dbCommands = parsed.dbCommands || [];
      notifCommands = parsed.notifCommands || [];
      chartCommands = parsed.chartCommands || [];

      // ── BULK_DOC: generate ZIP before saving task so token is available on first poll ──
      if (parsed.bulkDocCommands?.length > 0) {
        for (const bulkCmd of parsed.bulkDocCommands) {
          try {
            const { token, count } = await this.executeBulkDoc(task.userId, bulkCmd);
            task.context = { ...task.context, bulkDocToken: token, bulkDocCount: count };
            task.markModified('context');
            console.log(`📦 BULK_DOC: ${count} файлов сгенерировано, token=${token}`);
          } catch (bulkErr) {
            console.error('⚠️ BULK_DOC error:', bulkErr.message);
          }
        }
      }

      finalUserResponse =
        this.formatResponse(parsed.userResponse) ||
        ((dbCommands.length > 0 || notifCommands.length > 0) ? 'Готово! Изменения применены.' : '');
    }

    // 📊 CHART_DATA → реальный график через QuickChart (точные цифры, читаемый
    // текст) — работает одинаково для Mistral и Qwen, т.к. это просто JSON,
    // а не картинка, которую модель должна была бы "нарисовать" сама.
    let chartAttachments = [];
    if (chartCommands.length > 0) {
      for (const cmd of chartCommands.slice(0, 3)) {
        const img = await this._renderChartImage(cmd);
        if (img) chartAttachments.push(img);
      }
    }

    // 🔥 Сразу возвращаем ответ пользователю — DB/NOTIF-команды выполняются в фоне
    task.status = 'completed';
    task.error = undefined;
    task.result = finalUserResponse ? finalUserResponse + this._debugModelTag(provider) : finalUserResponse;
    // Merge: реальные графики первыми, затем AI-attachments + context images (from records) — capped at 5 total
    // web-chat: не показываем контекстные картинки автоматически — только если AI сам решил показать
    task.attachments = [...chartAttachments, ...(attachments || []), ...(isWebChat ? [] : contextImages)].slice(0, 5);
    task.completedAt = new Date();
    task.totalProcessingTime = Date.now() - startTime;
    if (!task.processingTime) task.processingTime = task.totalProcessingTime; // fallback
    // Mark notif changes so BotStudio shows "Applied" highlight
    if (isStudioTask && notifCommands.length > 0 && !task.context?.studioChanges) {
      task.context = { ...task.context, studioChanges: { notifRules: notifCommands.length } };
      task.markModified('context');
    }
    await task.save();

    // Всё остальное — в фоне, пользователь уже получил ответ
    setImmediate(async () => {
      if (dbCommands && dbCommands.length > 0) {
        for (const dbCommand of dbCommands) {
          // ⛔ SERVER-SIDE PERMISSION GUARD — reject any command not in allowedActions.
          // This is the true security barrier; the prompt-level prohibition is advisory only.
          if (!allowedActions.has(dbCommand.action)) {
            console.warn(`🚫 Команда отклонена (нет прав): ${dbCommand.action} | role=${callerRole}`);
            continue;
          }
          try {
            console.log('🔧 Выполняю команду БД:', dbCommand.action);
            const schemaProfileId = task.context?.source === 'studio'
              ? (task.context?.targetProfileId || null)
              : (task.profileId || null);
            const tgChatTag = (task.context?.source !== 'studio' && task.endUser?.platform === 'telegram' && task.endUser?.platformUserId)
              ? Number(task.endUser.platformUserId) : null;
            const dbResult = await this.executeDBCommand(task.userId, dbCommand, task.taskId, schemaProfileId, tgChatTag);
            if (dbResult?.error) console.error('⚠️ Ошибка БД-команды:', dbResult.error);
          } catch (dbErr) {
            console.error('⚠️ Ошибка выполнения БД-команды:', dbErr.message);
          }
        }
      }

      if (notifCommands && notifCommands.length > 0 && (callerRole === 'creator' || callerRole === 'admin' || isStudioTask)) {
        const notifProfileId = task.context?.targetProfileId || task.profileId || null;
        for (const nc of notifCommands) {
          try {
            await this.executeNotifCommand(task.userId, notifProfileId, nc);
          } catch (ncErr) {
            console.error('⚠️ Ошибка NOTIF_COMMAND:', ncErr.message);
          }
        }
      }

      if (task.context?.saveHistory && finalUserResponse?.trim().length > 0) {
        const ChatMessage = require('./models/ChatMessage');
        await ChatMessage.create({
          userId: task.userId,
          role: 'ai',
          content: finalUserResponse,
          attachments: attachments || [],
          taskId: task.taskId,
        }).catch((e) => console.warn('⚠️ Не удалось сохранить историю:', e.message));
      }

      if (config) {
        config.totalRequests = (config.totalRequests || 0) + 1;
        config.lastUsed = new Date();
        await config.save().catch(() => {});
      }
    });

    return finalUserResponse;
  }

  // ── Shadow data-exec pass (dual-track Groq) ──────────────────────────────────
  // Runs strictly AFTER the user already has Groq's reply — never touches
  // task.result/status. Its only job: figure out, reliably, whether this turn
  // implied a data change and execute it via DB_COMMAND/NOTIF_COMMAND. Mistral
  // first, Qwen if Mistral is down. Errors are logged and swallowed — there is
  // no user-facing response left to fall back to at this point.
  async _runShadowDataExec(task, systemPrompt, groqUserText, { allowedActions, callerRole, userEmail }) {
    const profileId = task.context?.source === 'studio'
      ? (task.context?.targetProfileId || null)
      : (task.profileId || null);

    const shadowPrompt = `${systemPrompt}\n\n🔒 РЕЖИМ СКРЫТОГО ИСПОЛНЕНИЯ ДАННЫХ\nПользователю только что отправлен этот ответ (он уже его видит, повторять не нужно):\n"""\n${groqUserText}\n"""\nТвоя единственная задача сейчас — понять по переписке выше, требуется ли действие с данными (создать/изменить/удалить запись или схему, настроить уведомление), и если да — выполнить его тегами DB_COMMAND/NOTIF_COMMAND в точности как обычно. Не пиши обращение к пользователю — этот текст никто не увидит, важны только теги. Если действие не требуется — просто напиши "нет".`;

    let rawResponse = null;
    let usedProvider = 'mistral';
    try {
      const page = await this.getPageForUser(task.userId, userEmail);
      const sendResult = await this.sendPromptWithSystem(page, task.prompt, shadowPrompt, task.userId, null);
      ({ text: rawResponse } = await this.waitForResponse(page, 60000, task.userId, sendResult.messagesBefore, null));
      const usedChatId = page.url().match(/\/(?:chat|c)\/([a-f0-9-]{36})/i)?.[1];
      try { await page.goto(`${MISTRAL_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 8000 }); } catch {}
      if (usedChatId) setTimeout(() => this._deleteMistralChat(page, usedChatId).catch(() => {}), 2000);
    } catch (mistralErr) {
      console.warn(`⚠️ Shadow-exec: Mistral недоступен (${mistralErr.message}), пробую Qwen...`);
      usedProvider = 'qwen';
      try {
        const { text: qwenRaw } = await this._getQwen().process(task, shadowPrompt, task.userId.toString(), null, userEmail ?? null, null);
        rawResponse = qwenRaw;
      } catch (qwenErr) {
        console.error('❌ Shadow-exec: Qwen тоже упал —', qwenErr.message);
        return;
      }
    }

    if (!rawResponse) return;

    // parseAIResponse returns null (not []) when a tag is absent — guard explicitly,
    // default destructuring only covers undefined.
    const parsed = this.parseAIResponse(rawResponse);
    const dbCommands = parsed.dbCommands || [];
    const notifCommands = parsed.notifCommands || [];

    for (const dbCommand of dbCommands) {
      if (!allowedActions.has(dbCommand.action)) {
        console.warn(`🚫 Shadow-exec (${usedProvider}): команда отклонена (нет прав) — ${dbCommand.action}`);
        continue;
      }
      try {
        const tgChatTag = (task.endUser?.platform === 'telegram' && task.endUser?.platformUserId)
          ? Number(task.endUser.platformUserId) : null;
        const dbResult = await this.executeDBCommand(task.userId, dbCommand, task.taskId, profileId, tgChatTag);
        if (dbResult?.error) console.error(`⚠️ Shadow-exec (${usedProvider}) БД-ошибка:`, dbResult.error);
        else console.log(`✅ Shadow-exec (${usedProvider}): выполнена команда ${dbCommand.action}`);
      } catch (e) {
        console.error(`⚠️ Shadow-exec (${usedProvider}) БД-исключение:`, e.message);
      }
    }

    if (notifCommands.length > 0 && (callerRole === 'creator' || callerRole === 'admin')) {
      for (const nc of notifCommands) {
        try { await this.executeNotifCommand(task.userId, profileId, nc); }
        catch (e) { console.error(`⚠️ Shadow-exec (${usedProvider}) NOTIF-ошибка:`, e.message); }
      }
    }
  }

  // The studio prompt explicitly tells the AI every keyboard button needs its
  // own BOT_COMMANDS entry with a real response — confirmed live that both
  // Mistral and Qwen still sometimes break this in two different ways: (a) a
  // button with NO command behind it at all ("Записаться" shipped on 8 pages
  // with zero matching command, ending in "эта функция временно недоступна"
  // for real customers), and (b) a command that DOES exist but with an empty
  // "response" (a "Назад" entry generated as {command:"Назад",response:"",
  // keyboard:null} — webhooks.js's `if (responseText)` gate means an empty
  // response sends literally nothing, the button just does nothing when
  // tapped). Prompting alone isn't reliable enough for a promise this
  // visible, so enforce it deterministically for both cases. "Назад" mirrors
  // /start (same fallback webhooks.js already uses elsewhere); booking-shaped
  // labels (Записаться/Заброн.../Оформить...) get hooked into the existing
  // scripted phone-collection flow so they create a real record, not just an
  // acknowledgement.
  _fixOrphanedButtons(commands) {
    if (!Array.isArray(commands)) return commands;
    const norm = (s) => (s || '').toString().trim().toLowerCase();
    const startCmd = commands.find((c) => norm(c.command) === '/start');
    // No more "уточняется, напишите нам" dead ends, and no more hand-maintained
    // regex of which labels "look like" a booking — every bot already has full
    // live-AI access to its own data via aiAction (it gets the same data context
    // a normal conversation turn would), so ANY orphaned button can be handed
    // straight to the AI to actually resolve, contextually, right now, instead
    // of admitting defeat with a canned phrase. "Назад" is the one true
    // exception — going back to the main menu is unambiguous and instant,
    // doesn't need a live AI round-trip.
    const buildFallback = (label) => {
      if (norm(label) === 'назад' || norm(label) === 'back') {
        return { command: label, response: startCmd?.response || '', keyboard: startCmd?.keyboard || null };
      }
      return {
        command: label,
        aiAction: `Пользователь нажал кнопку «${label}», для которой ещё не задан собственный сценарий. Определи по названию кнопки и характеру бота, что он, скорее всего, хочет, и прямо сейчас помоги по существу (запиши его, посчитай, покажи нужное, оформи — в зависимости от смысла кнопки), а не проси подождать. Если для этого не хватает какой-то конкретной детали — спроси именно её.`,
      };
    };

    // Pass 1: repair existing commands that would silently send nothing.
    const fixedBroken = [];
    const patched = commands.map((c0) => {
      // Чистим ошибочный mediaSchema:"banners" — баннеры экранов рисует
      // детерминированный слой (helpers/banners.js), а НЕ «медиа под кнопкой».
      // Иначе баннеры сыпались отдельными сообщениями и перепутанными.
      let c = c0;
      if (c0 && String(c0.mediaSchema || '').toLowerCase() === 'banners') {
        c = { ...c0 }; delete c.mediaSchema; delete c.mediaField; delete c.mediaMode; delete c.mediaCount; delete c.mediaType;
      }
      if (norm(c.command) === '/start') return c; // has the welcomeMessage fallback
      if (c.response || c.aiAction) return c; // aiAction commands intentionally have no static response
      if (c.queryMySchema || c.listSchema || c.showCart || c.notifyOwner || c.paidAction || c.bookingAction) return c; // resolve their response dynamically (records/cart/notify/paid/booking)
      fixedBroken.push(c.command);
      const fallback = buildFallback(c.command);
      return fallback.aiAction
        ? { ...c, response: undefined, aiAction: fallback.aiAction }
        : { ...c, response: fallback.response, keyboard: c.keyboard?.length ? c.keyboard : fallback.keyboard };
    });
    if (fixedBroken.length > 0) {
      console.warn(`⚠️ Studio: AI создала команды с пустым ответом (${fixedBroken.join(', ')}) — починил`);
    }

    // Pass 2: find buttons referenced in any keyboard with no command at all.
    const known = new Set(patched.map((c) => norm(c.command)));
    const referenced = [];
    const seen = new Set();
    for (const c of patched) {
      if (!Array.isArray(c.keyboard)) continue;
      for (const row of c.keyboard) {
        if (!Array.isArray(row)) continue;
        for (const item of row) {
          const label = typeof item === 'string' ? item : item?.text;
          const key = norm(label);
          if (label && !seen.has(key)) { seen.add(key); referenced.push(label); }
        }
      }
    }
    const missing = referenced.filter((label) => !known.has(norm(label)));
    if (missing.length > 0) {
      console.warn(`⚠️ Studio: AI оставила кнопки без обработчика (${missing.join(', ')}) — добавляю заглушки`);
      for (const label of missing) patched.push(buildFallback(label));
    }

    return patched;
  }

  // Defends against a confirmed-live failure mode: <BOT_COMMANDS> is a full-
  // array replace, and despite being told to copy untouched commands verbatim,
  // the model sometimes emits only the commands it's currently focused on —
  // silently deleting every other button in the bot (a real session: an owner
  // lost the entire main menu twice while iterating on one submenu). If the
  // new list is missing a large fraction of the bot's existing commands by
  // label, treat it as an accidental omission rather than an intentional
  // removal and merge the missing ones back in.
  async _guardAgainstCommandLoss(targetId, newCommands) {
    if (!targetId || !Array.isArray(newCommands)) return newCommands;
    try {
      const existing = await UserAiConfig.findById(targetId).select('botSettings.commands').lean();
      const oldCommands = existing?.botSettings?.commands || [];
      if (oldCommands.length < 3) return newCommands; // too small a bot for this to matter
      const norm = (s) => (s || '').toString().trim().toLowerCase();
      const newLabels = new Set(newCommands.map((c) => norm(c.command)));
      const missing = oldCommands.filter((c) => !newLabels.has(norm(c.command)));
      const missingRatio = missing.length / oldCommands.length;
      if (missing.length > 0 && missingRatio > 0.3) {
        console.warn(`⚠️ Studio: BOT_COMMANDS потерял ${missing.length}/${oldCommands.length} команд — восстанавливаю недостающие (вероятная случайная потеря, не запрошенное удаление)`);
        return [...newCommands, ...missing];
      }
      return newCommands;
    } catch (e) {
      console.warn('⚠️ _guardAgainstCommandLoss:', e.message);
      return newCommands;
    }
  }

  // Применяет точечные правки ТЕКСТА экранов из тегов
  // <SCREEN_TEXT screen="Меню">новый текст</SCREEN_TEXT> — детерминированно правит
  // response нужной команды (или welcomeMessage для главного меню), НЕ трогая
  // остальные команды. Надёжнее, чем заставлять модель переизливать весь
  // BOT_COMMANDS ради правки одного текста (частый провал: «Готово», а текст тот же).
  // Текст может содержать любую разметку (<b>, ссылки, *markdown*) — рендерится
  // через toTelegramHtml при отправке. Возвращает список изменённых экранов.
  async _applyScreenTextEdits(rawResponse, targetId) {
    if (!rawResponse || !targetId) return [];
    const edits = [];
    const re = /<SCREEN_?TEXT\s+screen\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/SCREEN_?TEXT>/gi;
    let m;
    while ((m = re.exec(rawResponse)) !== null) edits.push({ screen: m[1].trim(), text: m[2].trim() });
    if (!edits.length) return [];
    const prof = await UserAiConfig.findById(targetId);
    if (!prof) return [];
    if (!prof.botSettings) prof.botSettings = {};
    const commands = prof.botSettings.commands || [];
    const norm = (s) => (s || '').toString().trim().toLowerCase();
    const stripLead = (s) => norm(s).replace(/^[^\p{L}\p{N}]+/u, '').trim(); // убрать ведущие эмодзи/значки
    const isStart = (s) => ['/start', 'start', 'главное меню', 'главное', 'приветствие', 'welcome', 'стартовое меню', 'главный экран', 'старт'].includes(norm(s));
    const applied = [];
    for (const e of edits) {
      if (!e.text) continue;
      if (isStart(e.screen)) {
        prof.botSettings.welcomeMessage = e.text;
        const startCmd = commands.find((c) => norm(c.command) === '/start');
        if (startCmd) startCmd.response = e.text; // /start-команда тоже отражает главное меню
        applied.push('Главное меню');
      } else {
        let cmd = commands.find((c) => norm(c.command) === norm(e.screen));
        if (!cmd) cmd = commands.find((c) => stripLead(c.command) === stripLead(e.screen)); // без учёта ведущих эмодзи
        if (cmd) { cmd.response = e.text; applied.push(cmd.command); }
        else console.warn(`⚠️ SCREEN_TEXT: экран "${e.screen}" не найден среди команд`);
      }
    }
    if (applied.length) {
      prof.markModified('botSettings');
      await prof.save().catch((err) => console.warn('⚠️ SCREEN_TEXT save:', err.message));
      console.log(`✅ SCREEN_TEXT применён: ${applied.join(', ')}`);
    }
    return applied;
  }

  // ── ХИРУРГИЧЕСКАЯ ПРАВКА КОМАНД (добавь/убери/поправь кнопку) ────────────────
  // <ADD_COMMANDS>[{...}, ...]</ADD_COMMANDS>    — upsert по имени команды;
  // <REMOVE_COMMANDS>["Имя1","Имя2"]</REMOVE_COMMANDS> — удалить команды + вычистить
  //                                                 их кнопки из ВСЕХ клавиатур.
  //
  // Зачем: раньше добавить ОДНУ кнопку можно было только переизлив ВЕСЬ BOT_COMMANDS
  // (полная замена). Модель не могла надёжно повторить весь список дословно →
  // теряла команды ИЛИ вовсе пропускала структурную правку, делая лишь лёгкую
  // (SCREEN_TEXT), и врала «Готово». Теперь «добавь кнопку / подменю» = прислать
  // ТОЛЬКО затронутые команды: сервер вливает их в существующий список, остальное
  // сохраняет 1-в-1. Предохранители те же, что для полного BOT_COMMANDS
  // (_fixOrphanedButtons достроит забытые команды-заглушки, stackCommands
  // вертикализует раскладку) — поэтому даже частичная/кривая правка доводится до
  // рабочего состояния. Это «железобетон» для самых частых запросов пользователей.
  async _applyCommandPatch(rawResponse, targetId) {
    if (!rawResponse || !targetId) return { added: [], removed: [] };
    const addRaw = this._extractTag(rawResponse, 'ADD_COMMANDS')
      || this._extractTag(rawResponse, 'PATCH_COMMANDS')
      || this._extractTag(rawResponse, 'UPSERT_COMMANDS');
    const removeRaw = this._extractTag(rawResponse, 'REMOVE_COMMANDS')
      || this._extractTag(rawResponse, 'DELETE_COMMANDS');
    if (!addRaw && !removeRaw) return { added: [], removed: [] };

    let patch = addRaw ? this._tryParseJson(addRaw) : null;
    if (patch && !Array.isArray(patch)) patch = [patch];
    patch = Array.isArray(patch) ? patch.filter((c) => c && typeof c === 'object' && c.command) : [];

    let removeNames = removeRaw ? this._tryParseJson(removeRaw) : null;
    if (typeof removeNames === 'string') removeNames = [removeNames];
    removeNames = Array.isArray(removeNames)
      ? removeNames.map((x) => (typeof x === 'string' ? x : x?.command)).filter(Boolean)
      : [];

    const norm = (s) => (s || '').toString().trim().toLowerCase();

    // ПРОТИВОРЕЧИЕ «добавить И удалить одну и ту же команду»: модель иногда шлёт
    // REMOVE для того, что тут же ДОБАВЛЯЕТ (паттерн «убрать старое → создать
    // новое», хотя ADD и так upsert-заменяет). Тогда REMOVE успевал вычистить
    // кнопку из родительского меню, а ADD её обратно не вешал → команда есть, а
    // КНОПКА пропала (реальный баг: «Бургеры» исчезли). Приоритет — ДОБАВЛЕНИЕ:
    // не удаляем то, что явно пересоздаём.
    if (patch.length && removeNames.length) {
      const addSet = new Set(patch.map((p) => norm(p.command)));
      const conflict = removeNames.filter((n) => addSet.has(norm(n)));
      if (conflict.length) console.warn(`⚠️ ADD+REMOVE конфликт (добавление приоритетно), НЕ удаляю: ${conflict.join(', ')}`);
      removeNames = removeNames.filter((n) => !addSet.has(norm(n)));
    }

    if (!patch.length && !removeNames.length) return { added: [], removed: [] };

    const prof = await UserAiConfig.findById(targetId);
    if (!prof) return { added: [], removed: [] };
    if (!prof.botSettings) prof.botSettings = {};
    let commands = Array.isArray(prof.botSettings.commands) ? prof.botSettings.commands.slice() : [];
    const btnLabel = (b) => (typeof b === 'string' ? b : b?.text) || '';

    // 1) Удаления: убрать сами команды + вычистить их кнопки из всех клавиатур,
    //    чтобы «убери кнопку X» работало одним тегом и не оставляло зомби-кнопку
    //    (иначе _fixOrphanedButtons воскресил бы её заглушкой).
    const removed = [];
    if (removeNames.length) {
      const rmSet = new Set(removeNames.map(norm));
      commands = commands.filter((c) => {
        if (rmSet.has(norm(c.command))) { removed.push(c.command); return false; }
        return true;
      });
      for (const c of commands) {
        if (!Array.isArray(c.keyboard)) continue;
        c.keyboard = c.keyboard
          .map((row) => (Array.isArray(row) ? row : [row]).filter((b) => !rmSet.has(norm(btnLabel(b)))))
          .filter((row) => row.length);
      }
    }

    // 2) Upsert: совпало имя → мержим поля (неуказанные сохраняем); нет → добавляем.
    //    Значение null в патче = УДАЛИТЬ это поле (напр. {"listSchema":null} убирает
    //    каталог с экрана, оставив текст) — чтобы «убери что угодно» работало точечно.
    // Существующий субдок приводим к plain (toObject) для чистого спреда. При
    // УДАЛЕНИИ поля (null) сбрасываем _id — иначе mongoose диффит субдок по _id и
    // НЕ делает $unset снятого поля (оно «залипает» в БД, реальный баг). Новый _id
    // = чистая пере-вставка субдока без удалённого поля.
    const asPlain = (c) => (c && typeof c.toObject === 'function') ? c.toObject() : c;
    const added = [];
    for (const p of patch) {
      const idx = commands.findIndex((c) => norm(c.command) === norm(p.command));
      if (idx >= 0) {
        const merged = { ...asPlain(commands[idx]), ...p };
        let deleted = false;
        for (const k of Object.keys(p)) if (p[k] === null) { delete merged[k]; deleted = true; }
        if (deleted) delete merged._id;
        commands[idx] = merged;
      } else {
        const created = { ...p };
        for (const k of Object.keys(created)) if (created[k] === null) delete created[k];
        commands.push(created);
      }
      added.push(p.command);
    }

    // Те же предохранители, что и для полного BOT_COMMANDS.
    const { stackCommands } = require('./helpers/keyboardLayout');
    prof.botSettings.commands = stackCommands(this._fixOrphanedButtons(commands));
    prof.markModified('botSettings.commands');
    await prof.save().catch((err) => console.warn('⚠️ ADD/REMOVE_COMMANDS save:', err.message));
    if (added.length)   console.log(`✅ ADD_COMMANDS (upsert): ${added.join(', ')}`);
    if (removed.length) console.log(`✅ REMOVE_COMMANDS: ${removed.join(', ')}`);
    return { added, removed };
  }

  async _applyStudioChanges(rawResponse, task) {
    // Clean text for the user = everything before the first XML tag. Loose
    // match tolerates the model dropping underscores (e.g. <BOTSETTINGS>).
    const firstTag = rawResponse.search(/<(WELCOME_?MESSAGE|BOT_?SETTINGS|BOT_?COMMANDS|BOT_?PREVIEW|BUILD_?NOTES|SCREEN_?TEXT|ADD_?COMMANDS|PATCH_?COMMANDS|UPSERT_?COMMANDS|REMOVE_?COMMANDS|DELETE_?COMMANDS)/i);
    let cleanText = (firstTag !== -1 ? rawResponse.slice(0, firstTag) : rawResponse).trim();
    cleanText = this._stripStudioArtifacts(cleanText);
    // SCREEN_TEXT содержит атрибут (screen="…") — _stripStudioArtifacts его не ловит,
    // снимаем отдельно, чтобы блок не утёк в текст пользователю.
    cleanText = cleanText.replace(/<SCREEN_?TEXT[\s\S]*?<\/SCREEN_?TEXT>/gi, '').trim();
    // ADD/REMOVE/PATCH_COMMANDS — точечная правка команд; тоже вырезаем из текста.
    cleanText = cleanText.replace(/<(ADD|PATCH|UPSERT|REMOVE|DELETE)_?COMMANDS>[\s\S]*?<\/(ADD|PATCH|UPSERT|REMOVE|DELETE)_?COMMANDS>/gi, '').trim();
    // formatResponse collapses the runs of blank lines that nested <div>/<p>
    // wrapping in Mistral's DOM produces (each nesting level adds its own
    // leading/trailing \n) — the studio path never ran through it before,
    // unlike the regular chat path, which is why builder replies showed huge
    // empty gaps that a normal bot reply never did.
    cleanText = this.formatResponse(cleanText);

    // Extract each section independently — a truncated section doesn't break others
    const welcomeRaw  = this._extractTag(rawResponse, 'WELCOME_MESSAGE');
    const settingsRaw = this._extractTag(rawResponse, 'BOT_SETTINGS');
    const commandsRaw = this._extractTag(rawResponse, 'BOT_COMMANDS');
    const previewRaw  = this._extractTag(rawResponse, 'BOT_PREVIEW');
    const buildNotesRaw = this._extractTag(rawResponse, 'BUILD_NOTES');

    const changes = {};
    if (welcomeRaw  != null) changes.welcomeMessage = welcomeRaw;

    if (settingsRaw) {
      let s = this._tryParseJson(settingsRaw);
      if (!s) {
        // JSON.parse failed (likely unescaped double quotes inside string values).
        // Fallback: extract simple enum/short fields via regex; for systemPrompt use
        // a greedy match that stops at the last "} to avoid quote ambiguity.
        const strVal = (key) => {
          const m = settingsRaw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*?)"`));
          return m ? m[1] : null;
        };
        const tm = strVal('triggerMode');
        const hm = strVal('historyMode');
        const ar = strVal('aiAccessRole');
        const an = strVal('aiName');
        const tk = strVal('triggerKeyword');
        // systemPrompt: grab everything between first " after key and the last " before closing }
        let sp = null;
        const spMatch = settingsRaw.match(/"systemPrompt"\s*:\s*"([\s\S]*?)"\s*}/);
        if (spMatch) sp = spMatch[1];
        s = {};
        if (tm) s.triggerMode = tm;
        if (hm) s.historyMode = hm;
        if (ar) s.aiAccessRole = ar;
        if (an) s.aiName = an;
        if (tk != null) s.triggerKeyword = tk;
        if (sp) s.systemPrompt = sp;
        if (Object.keys(s).length === 0) s = null;
        if (s) console.log('⚠️ Studio: BOT_SETTINGS JSON невалиден, поля извлечены через regex:', Object.keys(s).join(', '));
      }
      if (s) {
        if (s.triggerMode    != null) changes.triggerMode    = s.triggerMode;
        if (s.triggerKeyword != null) changes.triggerKeyword = s.triggerKeyword;
        if (s.historyMode    != null) changes.historyMode    = s.historyMode;
        if (s.aiAccessRole   != null) changes.aiAccessRole   = s.aiAccessRole;
        if (s.aiName         != null) changes.aiName         = s.aiName;
        if (s.systemPrompt   != null) changes.systemPrompt   = s.systemPrompt;
        if (s.restrictions   != null) changes.restrictions   = s.restrictions;
        // Фримиум ИИ (продаём премиум-доступ к ИИ-ответам). Не поле botSettings —
        // мостим в схему монетизации paid_settings ниже.
        if (s.aiPremiumGate  != null) changes.aiPremiumGate  = s.aiPremiumGate;
        if (s.aiFreeUses     != null) changes.aiFreeUses     = s.aiFreeUses;
      }
    }

    if (commandsRaw) {
      const cmds = this._tryParseJson(commandsRaw);
      if (cmds) {
        const { stackCommands } = require('./helpers/keyboardLayout');
        // Вертикализуем раскладку (1 кнопка = 1 ряд): на мобилке ряды из 2+ кнопок
        // обрезаются и роняют конверсию. Делаем детерминированно, не надеясь на ИИ.
        changes.commands = stackCommands(await this._guardAgainstCommandLoss(task.context?.targetProfileId, this._fixOrphanedButtons(cmds)));
      }
    }

    const previewMessages = previewRaw ? this._tryParseJson(previewRaw) : null;

    if (Object.keys(changes).length > 0) {
      const targetId = task.context?.targetProfileId;

      // Owner can lock systemPrompt/restrictions to the dedicated "Настройки
      // AI" menu only (see seedDefaults.js / tgletbot.js) — every OTHER
      // change (commands, schemas, welcome message...) still applies normally.
      let locked = false;
      if (targetId && (changes.systemPrompt != null || changes.restrictions != null)) {
        const lockCheck = await UserAiConfig.findById(targetId).select('promptEditLocked').lean();
        locked = !!lockCheck?.promptEditLocked;
        if (locked) {
          delete changes.systemPrompt;
          delete changes.restrictions;
        }
      }

      const update = {};
      if (changes.welcomeMessage  != null) update['botSettings.welcomeMessage'] = changes.welcomeMessage;
      if (changes.triggerMode     != null) update['botSettings.triggerMode']    = changes.triggerMode;
      if (changes.triggerKeyword  != null) update['botSettings.triggerKeyword'] = changes.triggerKeyword;
      if (changes.historyMode     != null) update['botSettings.historyMode']    = changes.historyMode;
      if (changes.aiAccessRole    != null) update['botSettings.aiAccessRole']   = changes.aiAccessRole;
      if (changes.commands        != null) update['botSettings.commands']       = changes.commands;
      if (changes.systemPrompt    != null) update.systemPrompt                  = changes.systemPrompt;
      if (changes.restrictions    != null) update.restrictions                  = changes.restrictions;
      if (changes.aiName          != null) update.aiName                        = changes.aiName;

      if (targetId && Object.keys(update).length > 0) {
        try {
          await UserAiConfig.findByIdAndUpdate(targetId, { $set: update });
          console.log(`✅ Studio: изменения применены (${Object.keys(update).join(', ')})`);
        } catch (e) {
          console.warn('⚠️ Studio: ошибка применения изменений:', e.message);
        }
      }
      // Мост фримиума ИИ → схема монетизации paid_settings (ИИ управляет ею через
      // BOT_SETTINGS, но хранится она как данные, а не в botSettings).
      if (changes.aiPremiumGate != null || changes.aiFreeUses != null) {
        try {
          const { ensurePaidSchemas, SETTINGS_SCHEMA } = require('./helpers/paid');
          await ensurePaidSchemas(task.userId);
          const set = {};
          if (changes.aiPremiumGate != null) {
            set['data.gate_ai'] = !!changes.aiPremiumGate;
            if (changes.aiPremiumGate) { set['data.enabled'] = true; set['data.premium_enabled'] = true; }
          }
          if (changes.aiFreeUses != null) set['data.free_ai_uses'] = Math.max(0, parseInt(changes.aiFreeUses) || 0);
          await require('./models/UserRecord').updateOne({ userId: task.userId, schemaName: SETTINGS_SCHEMA }, { $set: set });
          console.log(`✅ Studio: фримиум ИИ обновлён (gate=${changes.aiPremiumGate}, free=${changes.aiFreeUses})`);
        } catch (e) { console.warn('⚠️ paid gate bridge:', e.message); }
      }
      if (locked) {
        cleanText += '\n\n🔒 Системный промпт и ограничения защищены от изменений через чат — измени их в «⚙️ Настройки AI».';
      }

      task.context = {
        ...task.context,
        studioChanges: changes,
        studioPreviewMessages: previewMessages || [],
      };
      task.markModified('context');
    }

    // ── Наблюдательный лог студийной сборки (только запись, поведение не меняет).
    // Позволяет проверять РЕАЛЬНУЮ генерацию: что ушло в Mistral (task.prompt,
    // включая инъецированный макет) и что он вернул (rawResponse), и что в итоге
    // собралось. Включается DEBUG_STUDIO_CAPTURE=true в .env.
    if (process.env.DEBUG_STUDIO_CAPTURE === 'true') {
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, 'debug');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'studio-last.json'), JSON.stringify({
          ts: new Date().toISOString(),
          taskId: task.taskId,
          userId: String(task.userId),
          prompt: task.prompt,
          rawResponse,
          appliedCommands: changes.commands || null,
          welcome: changes.welcomeMessage || null,
          aiName: changes.aiName || null,
        }, null, 2));
      } catch (e) { console.warn('studio capture:', e.message); }
    }

    // BUILD_NOTES persists independently of changes above — it's the model's
    // own running memory of this build, may be the only thing present on a
    // turn that's just a decision/clarification with no structural change.
    if (buildNotesRaw != null) {
      const targetId = task.context?.targetProfileId;
      if (targetId) {
        await UserAiConfig.findByIdAndUpdate(targetId, { $set: { studioBuildNotes: buildNotesRaw.trim() } }).catch((e) => {
          console.warn('⚠️ Studio: ошибка сохранения BUILD_NOTES:', e.message);
        });
      }
    }

    // ADD/REMOVE_COMMANDS — хирургическая правка команд (добавь/убери/поправь кнопку)
    // БЕЗ переизлития всего BOT_COMMANDS. Применяем ВСЕГДА, отдельно от BOT_COMMANDS.
    let cmdPatch = { added: [], removed: [] };
    try {
      cmdPatch = await this._applyCommandPatch(rawResponse, task.context?.targetProfileId);
    } catch (e) { console.warn('⚠️ ADD/REMOVE_COMMANDS apply:', e.message); }

    // SCREEN_TEXT — точечные правки текста экранов (детерминированно, отдельно от
    // BOT_COMMANDS). Применяем даже если других изменений не было (чистая правка текста).
    try {
      const screensApplied = await this._applyScreenTextEdits(rawResponse, task.context?.targetProfileId);
      if (screensApplied.length && (!cleanText || cleanText === '✅ Готово.')) {
        cleanText = `✅ Готово — обновил текст экрана: ${screensApplied.join(', ')}.`;
      }
    } catch (e) { console.warn('⚠️ SCREEN_TEXT apply:', e.message); }

    // Если применили только правку команд (без прозы) — не отдаём пользователю
    // пустой/дежурный ответ, а подтверждаем ЧТО именно сделали.
    if ((cmdPatch.added.length || cmdPatch.removed.length) && (!cleanText || cleanText === '✅ Готово.')) {
      const parts = [];
      if (cmdPatch.added.length)   parts.push(`добавил/обновил: ${cmdPatch.added.join(', ')}`);
      if (cmdPatch.removed.length) parts.push(`убрал: ${cmdPatch.removed.join(', ')}`);
      cleanText = `✅ Готово — ${parts.join('; ')}.`;
    }

    // Never fall back to the raw response here — if cleanText ends up empty
    // (e.g. the model opened straight into tags with no chat preface, or used
    // a tag format we couldn't recognize at all) a generic acknowledgement is
    // always safer than risking raw config/JSON reaching the user.
    return cleanText || '✅ Готово.';
  }

  // ── Обработка задачи через Qwen ───────────────────────────────────────────

  async _runQwen(task, systemPrompt, config, startTime, userEmail, allowedActions = new Set(['create', 'update', 'delete', 'create_schema', 'dedupe']), callerRole = 'creator', contextImages = []) {
    console.log('🌟 Qwen: начинаю обработку...');

    // Для Studio используем отдельный чат, если задан в конфиге
const existingQwenChatId = task.context?.source === 'studio' && config?.qwenStudioThreadId
  ? config.qwenStudioThreadId
  : config?.qwenThreadId ?? null;

// Callback: called by Qwen when [END_TEXT] marker is detected
const qwenOnPartialText = async (textPart) => {
  task.partialResult = textPart;
  task.textCompletedAt = new Date();
  task.processingTime = Date.now() - startTime;
  await task.save().catch(() => {});
};

const { text: qwenRaw, chatId: newQwenChatId } = await this._getQwen().process(
  task,
  systemPrompt,
  task.userId.toString(),
  existingQwenChatId,
  userEmail ?? null,
  qwenOnPartialText
);

    // Сохраняем ID чата Qwen для последующих fallback-запросов
if (newQwenChatId) {
  if (config) {
    // 🔥 Для Studio используем отдельное поле, чтобы не ломать обычные чаты
    const isStudio = task.context?.source === 'studio';
    const field = isStudio ? 'qwenStudioThreadId' : 'qwenThreadId';

    if (config[field] !== newQwenChatId) {
      config[field] = newQwenChatId;
      config.totalRequests = (config.totalRequests || 0) + 1;
      config.lastUsed = new Date();
      await config.save();
      console.log(`✅ Qwen: сохранён ${isStudio ? 'Studio-' : ''}chatId: ${newQwenChatId}`);
    }
  } else {
    // Конфиг ещё не создан (регистрация через Qwen)
    const isStudio = task.context?.source === 'studio';
    await UserAiConfig.findOneAndUpdate(
      { userId: task.userId },
      {
        $setOnInsert: {
          userId: task.userId,
          aiName: 'Помощник',
          systemPrompt: 'Ты — полезный AI-помощник Siberi AI',
          hasPersonalThread: true,
        },
        $set: {
          [isStudio ? 'qwenStudioThreadId' : 'qwenThreadId']: newQwenChatId,
          lastUsed: new Date(),
        },
      },
      { upsert: true }
    );
  }
}

    task.rawAiResponse = qwenRaw;

    // ── Partial result for Qwen: set text preview before commands ────────────
    const qwenTextPreview = this._extractTextPreview(qwenRaw);
    if (qwenTextPreview) {
      task.partialResult = qwenTextPreview;
      task.textCompletedAt = new Date();
      task.processingTime = Date.now() - startTime;
      await task.save().catch(() => {});
    }

    let finalUserResponse;

    if (task.context?.source === 'studio') {
      const { userResponse: studioUserResponse, dbCommands: studioDbCmds, notifCommands: studioNotifCmds } = this.parseAIResponse(qwenRaw);
      if (studioDbCmds && studioDbCmds.length > 0) {
        const studioTargetProfileId = task.context?.targetProfileId || null;
        for (const cmd of studioDbCmds) {
          try { await this.executeDBCommand(task.userId, cmd, task.taskId, studioTargetProfileId); }
          catch (e) { console.warn('⚠️ Qwen studio DB-команда ошибка:', e.message); }
        }
      }
      if (studioNotifCmds && studioNotifCmds.length > 0) {
        const notifProfileId = task.context?.targetProfileId || task.profileId || null;
        for (const nc of studioNotifCmds) {
          try { await this.executeNotifCommand(task.userId, notifProfileId, nc); }
          catch (e) { console.warn('⚠️ Qwen studio NOTIF-команда ошибка:', e.message); }
        }
      }
      finalUserResponse = await this._applyStudioChanges(studioUserResponse, task);
    } else {
      const { userResponse, dbCommands, notifCommands } = this.parseAIResponse(qwenRaw);

      if (dbCommands && dbCommands.length > 0) {
        for (const cmd of dbCommands) {
          // ⛔ SERVER-SIDE PERMISSION GUARD (Qwen path)
          if (!allowedActions.has(cmd.action)) {
            console.warn(`🚫 Qwen команда отклонена (нет прав): ${cmd.action} | role=${callerRole}`);
            continue;
          }
          try {
            const qwenSchemaProfileId = task.context?.source === 'studio'
              ? (task.context?.targetProfileId || null)
              : (task.profileId || null);
            const tgChatTag = (task.context?.source !== 'studio' && task.endUser?.platform === 'telegram' && task.endUser?.platformUserId)
              ? Number(task.endUser.platformUserId) : null;
            await this.executeDBCommand(task.userId, cmd, task.taskId, qwenSchemaProfileId, tgChatTag);
          } catch (e) {
            console.warn('⚠️ Qwen DB-команда ошибка:', e.message);
          }
        }
      }

      if (notifCommands && notifCommands.length > 0 && (callerRole === 'creator' || callerRole === 'admin')) {
        const notifProfileId = task.profileId || null;
        for (const nc of notifCommands) {
          try { await this.executeNotifCommand(task.userId, notifProfileId, nc); }
          catch (e) { console.warn('⚠️ Qwen NOTIF-команда ошибка:', e.message); }
        }
      }

      finalUserResponse =
        this.formatResponse(userResponse) ||
        ((dbCommands?.length > 0 || notifCommands?.length > 0) ? 'Готово! Изменения применены.' : '');
    }

    task.status = 'completed';
    task.error = undefined;
    task.result = finalUserResponse ? finalUserResponse + this._debugModelTag('qwen') : finalUserResponse;
    // Attach context images (from records) so Telegram sends them to the user
    task.attachments = [...contextImages].slice(0, 5);
    task.completedAt = new Date();
    task.totalProcessingTime = Date.now() - startTime;
    if (!task.processingTime) task.processingTime = task.totalProcessingTime;
    await task.save();

    if (task.context?.saveHistory && finalUserResponse?.trim().length > 0) {
      const ChatMessage = require('./models/ChatMessage');
      await ChatMessage.create({
        userId: task.userId,
        role: 'ai',
        content: finalUserResponse,
        attachments: [],
        taskId: task.taskId,
      }).catch((e) => console.warn('⚠️ Qwen: не удалось сохранить историю:', e.message));
    }

    console.log(`✅ Qwen: задача завершена за ${Date.now() - startTime}мс`);
    return finalUserResponse;
  }

  async _updateEnvVar(key, value) {
    const fs = require('fs');
    const envPath = require('path').join(__dirname, '.env');
    try {
      let content = fs.readFileSync(envPath, 'utf8');
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      fs.writeFileSync(envPath, content, 'utf8');
      process.env[key] = value;
      console.log(`✅ Ротация: ${key}=${value}`);
    } catch (err) {
      console.warn(`⚠️ _updateEnvVar: ${err.message}`);
    }
  }

  // Удаляет чат Mistral из UI (вызывается после каждого ответа — держим аккаунт чистым)
  // Удаление ненадёжно с первого раза (тайминги/гонка с рендером сайдбара),
  // из-за чего чаты копились. Пробуем несколько раз, пока чат реально не исчезнет.
  async _deleteMistralChat(page, chatId) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ok = await this._deleteMistralChatOnce(page, chatId);
      if (ok) return;
      // чат уже пропал из сайдбара? считаем успехом
      const gone = (await page.locator(`a[href*="${chatId}"]`).count().catch(() => 1)) === 0;
      if (gone) return;
      await page.waitForTimeout(1000).catch(() => {});
    }
    console.warn(`⚠️ _deleteMistralChat: чат ${chatId} не удалился за 3 попытки`);
  }

  async _deleteMistralChatOnce(page, chatId) {
    try {
      // Ждём пока сайдбар отрендерится (React гидратация после goto)
      await page.waitForSelector(`a[href*="${chatId}"]`, { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(500);

      const chatLink = page.locator(`a[href*="${chatId}"]`).first();
      if ((await chatLink.count()) === 0) return true; // уже нет — успех

      await chatLink.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      // Двигаем мышь к строке чата — CSS :hover → кнопка становится visible
      const box = await chatLink.boundingBox();
      if (!box) return false;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(700);

      // Radix UI слушает pointerdown, а не click — используем Playwright click({force:true})
      // XPath: находим ближайшего предка ссылки, который содержит кнопку "More options"
      const moreBtn = page.locator(
        `xpath=//a[contains(@href,"${chatId}")]/ancestor::*[.//*[@aria-label="More options"]][1]//*[@aria-label="More options"]`
      ).first();
      try {
        await moreBtn.click({ force: true, timeout: 2000 });
      } catch {
        return false;
      }
      await page.waitForTimeout(600);

      // Delete в контекстном меню — Playwright с force
      const deleteItem = page.locator('[role="menuitem"]').filter({ hasText: 'Delete' }).first();
      try {
        await deleteItem.click({ force: true, timeout: 2000 });
      } catch {
        await page.keyboard.press('Escape');
        return false;
      }
      await page.waitForTimeout(600);

      // Подтверждение удаления — кнопка с bg-state-destructive
      const confirmBtn = page.locator('button').filter({ hasText: 'Delete' }).filter({
        has: page.locator('[class*="bg-state-destructive"]')
      }).first();
      try {
        await confirmBtn.click({ force: true, timeout: 2000 });
      } catch {
        // Пробуем без фильтра класса — просто первая деструктивная кнопка
        await page.locator('button[class*="bg-state-destructive"]').first()
          .click({ force: true, timeout: 1500 }).catch(() => {});
      }
      await page.waitForTimeout(500);
      // Успех только если чат реально исчез из сайдбара.
      const stillThere = (await page.locator(`a[href*="${chatId}"]`).count().catch(() => 0)) > 0;
      if (stillThere) return false;
      console.log(`🗑️ Чат Mistral удалён: ${chatId}`);
      return true;
    } catch (err) {
      console.warn(`⚠️ _deleteMistralChatOnce: ${err.message}`);
      return false;
    }
  }

  async buildShortHistory(userId, limit = 3) {
    try {
      const ChatMessage = require('./models/ChatMessage');
      const msgs = await ChatMessage.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit * 2)
        .lean();
      if (!msgs || msgs.length === 0) return '';
      msgs.reverse();
      const lines = msgs.map(m =>
        m.role === 'user' ? `Пользователь: ${m.content}` : `Ассистент: ${m.content}`
      );
      return `\n\n[ИСТОРИЯ ПОСЛЕДНИХ ДИАЛОГОВ]\n${lines.join('\n')}\n[КОНЕЦ ИСТОРИИ]`;
    } catch {
      return '';
    }
  }

  // ==================== WORKER ====================

  async startWorker() {
    if (this._workerStarted) return; // однократный запуск
    this._workerStarted = true;
    console.log('🔄 Воркер запущен');

    // Сколько задач каждого пользователя в работе. Обычному пользователю — по одной
    // (его контекст/вкладка общие на все запросы), а системному demo@siberi.ai —
    // параллельно: от его имени идут ВСЕ внешние запросы (/api/v1/ai/*, Откликс, /app,
    // лендинг), и по одной они стояли в общей очереди — живой замер 11.10.2026:
    // ожидание до 38с у каждой десятой задачи. Эти пути без общего состояния: Google AI
    // открывает вкладку на запрос, Groq — HTTP. Предел — DEMO_PARALLEL (по умолчанию 3).
    const processingUserIds = new Map();
    const DEMO_PARALLEL = Math.max(1, Number(process.env.DEMO_PARALLEL || 3));
    const User = require('./models/User');
    const demoUser = await User.findOne({ email: 'demo@siberi.ai' }).select('_id').lean().catch(() => null);
    const demoUserId = demoUser ? demoUser._id.toString() : null;
    const userLimit = (id) => (id === demoUserId ? DEMO_PARALLEL : 1);
    const busyIds = () => [...processingUserIds].filter(([id, n]) => n >= userLimit(id)).map(([id]) => id);
    // Обрабатываем до N задач ПАРАЛЛЕЛЬНО (по числу вкладок в пуле Mistral). Каждая
    // задача берёт свою вкладку из пула → до 5 запросов одновременно. Раньше воркер
    // был строго последовательным (следующая задача — только в finally предыдущей),
    // из-за чего пул вкладок не давал бы никакого параллелизма.
    // С Google AI основным предел не привязан к пулу Mistral (3 вкладки): Google открывает
    // вкладку на запрос, и задачи разных пользователей не должны ждать друг друга.
    const MAX_CONCURRENT = process.env.GOOGLEAI_TIER0 === 'true'
      ? Math.max(1, Number(process.env.WORKER_CONCURRENCY || 5))
      : Math.max(1, this.mistralPoolMax || 5);
    // Уведомления/отчёты (context.source:'notification') — НИЗКИЙ приоритет: не
    // больше NOTIF_MAX одновременно. Живой AI (конструктор + боты клиентов) всегда
    // имеет свободные вкладки пула и НЕ ждёт за отчётами (был флуд отчётов в 23:50).
    const NOTIF_MAX = 1;

    // Единый «насос»: заполняет свободные слоты атомарными claim'ами. Два уровня
    // защиты от экспоненциального роста тиков (был такой баг): pumpTimer — не более
    // одного отложенного вызова; _pumping — не более одного прохода одновременно.
    let pumpTimer = null;
    const schedulePump = (delay) => {
      if (pumpTimer) return;
      pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, delay);
    };
    // Новая задача — проход прямо сейчас, а не через ≤300 мс опроса. Идёт проход —
    // помечаем, и он повторится сразу по окончании (иначе задача ждала бы следующего тика).
    let repump = false;
    const kick = () => {
      if (this._pumping) { repump = true; return; }
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
      schedulePump(0);
    };
    require('./helpers/taskEvents').taskEvents.on('saved', (doc) => {
      if (doc && doc.status === 'pending') kick();
    });

    const pump = async () => {
      if (this._pumping) { repump = true; return; }
      this._pumping = true;
      try {
        if (!this.isReady) { schedulePump(200); return; }
        // Забираем задачи, пока есть свободные слоты и доступные (не занятые тем же
        // пользователем) задачи. claim атомарный — двойной обработки не будет.
        while (this.processingTasks.size < MAX_CONCURRENT) {
          const busyUserIds = busyIds();
          const base = { status: 'pending', taskId: { $nin: Array.from(this.processingTasks) }, userId: { $nin: busyUserIds } };
          // ПРИОРИТЕТ: сначала берём ЖИВУЮ задачу (конструктор/боты клиентов), НЕ
          // notification — она важнее и не должна ждать за отчётами.
          let task = await Task.findOneAndUpdate(
            { ...base, 'context.source': { $ne: 'notification' } },
            { $set: { status: 'processing' } },
            { returnDocument: 'after', sort: { createdAt: 1 } }
          ).catch(() => null);
          let claimedNotif = false;
          // Живых нет и есть свободный notif-слот → берём уведомление/отчёт (≤ NOTIF_MAX).
          if (!task && this._notifProcessing < NOTIF_MAX) {
            task = await Task.findOneAndUpdate(
              { ...base, 'context.source': 'notification' },
              { $set: { status: 'processing' } },
              { returnDocument: 'after', sort: { createdAt: 1 } }
            ).catch(() => null);
            if (task) claimedNotif = true;
          }
          if (!task) break; // нет доступных задач (или notif-слот занят)

          this.processingTasks.add(task.taskId);
          const uid = task.userId.toString();
          processingUserIds.set(uid, (processingUserIds.get(uid) || 0) + 1);
          if (claimedNotif) this._notifProcessing++;

          // Каждая задача — своя параллельная цепочка; по завершении освобождает слот.
          (async () => {
            try {
              await this.processTask(task);
            } catch (err) {
              console.error('❌ Ошибка воркера:', err.message);
              task.status = 'pending';
              await task.save().catch(() => {});
            } finally {
              this.processingTasks.delete(task.taskId);
              const left = (processingUserIds.get(uid) || 1) - 1;
              if (left > 0) processingUserIds.set(uid, left); else processingUserIds.delete(uid);
              if (claimedNotif) this._notifProcessing--;
              schedulePump(50); // слот освободился — сразу пробуем взять следующую
            }
          })();
        }
        schedulePump(300); // страховочный опрос: задачи других процессов (siberi-bot)
      } finally {
        this._pumping = false;
        if (repump) { repump = false; kick(); }
      }
    };

    // Google AI — основной провайдер: держим тёплые вкладки заранее (services/googleai).
    if (process.env.GOOGLEAI_TIER0 === 'true') {
      try { require('./services/googleai').warmUp(); } catch (e) { console.warn('⚠️ GoogleAI warmUp:', e.message); }
    }

    pump();
  }

  // ==================== ПУБЛИЧНЫЕ МЕТОДЫ ====================

  async createChatOnRegistration(userId, email) {
    try {
      console.log(`🔥 Создаю чат при регистрации для ${email}...`);

      if (!this.isReady) {
        await this.init();
        if (!this.isReady) throw new Error('Сервис не готов');
      }

      const UserSchema = require('./models/UserSchema');
      const defaultSchema = await UserSchema.findOne({ userId, name: 'schedule' });

      if (!defaultSchema) {
        const newSchema = new UserSchema({
          userId,
          name: 'schedule',
          label: 'Расписание',
          description: 'Записи клиентов на услуги',
          icon: '📅',
          color: '#10b981',
          fields: [
            {
              name: 'date',
              label: 'Дата',
              type: 'date',
              required: true,
              description: 'Дата записи',
            },
            {
              name: 'time',
              label: 'Время',
              type: 'text',
              required: true,
              description: 'Время начала',
            },
            {
              name: 'client',
              label: 'Клиент',
              type: 'text',
              required: true,
              description: 'Имя клиента',
            },
            {
              name: 'service',
              label: 'Услуга',
              type: 'text',
              required: true,
              description: 'Название услуги',
            },
            {
              name: 'price',
              label: 'Цена',
              type: 'number',
              required: false,
              description: 'Стоимость в рублях',
            },
            {
              name: 'phone',
              label: 'Телефон',
              type: 'text',
              required: false,
              description: 'Контактный телефон',
            },
            {
              name: 'notes',
              label: 'Заметки',
              type: 'text',
              required: false,
              description: 'Дополнительная информация',
            },
          ],
        });
        await newSchema.save();
        console.log(`✅ Создана дефолтная схема "schedule" для ${email}`);
      }

      const chatId = await this.createChatForUser(userId, email);
      if (chatId) {
        console.log(`✅ Чат создан: ${chatId}`);
        return chatId;
      }
      throw new Error('createChatForUser вернул null');
    } catch (err) {
      console.error('❌ Ошибка создания чата:', err.message);
      return null;
    }
  }

  async exportAuthState() {
    const { exportAuthState } = require('./browser');
    return await exportAuthState(this.masterBrowser);
  }

  // При старте: открывает Mistral через профильный контекст и сохраняет куки если уже залогинен
  async _detectMistralAuthFromProfile() {
    console.log('🔍 Проверяю авторизацию Mistral через профиль браузера...');
    const contexts = this.masterBrowser.contexts();
    if (!contexts.length) {
      console.log('⚠️ Нет активных контекстов браузера');
      return null;
    }

    const ctx = contexts[0]; // профильный контекст — имеет куки из edge-profile-master
    let page;
    try {
      page = await ctx.newPage();
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForTimeout(2500);

      // Проверяем: есть ли признаки авторизованного UI (сайдбар с историей)
      const authenticated = await page.evaluate(() => {
        if (!window.location.hostname.includes('chat.mistral.ai')) return false;
        const p = window.location.pathname;
        if (p.includes('sign-in') || p.includes('login') || p.includes('/auth')) return false;
        const sidebar = document.querySelector(
          'nav, aside, [class*="sidebar"], [class*="thread-list"], [class*="history"], [class*="chat-list"]'
        );
        if (!sidebar) return false;
        const signInLink = document.querySelector(
          'a[href*="sign-in"], a[href*="login"], button[class*="sign-in"]'
        );
        return !signInLink;
      }).catch(() => false);

      if (authenticated) {
        console.log('✅ Mistral: авторизован через профиль, сохраняю куки...');
        const { STORAGE_STATE_PATH } = require('./browser');
        const state = await ctx.storageState({ path: STORAGE_STATE_PATH });
        console.log(`✅ Сохранено кук: ${state.cookies?.length || 0}`);
        return state;
      } else {
        console.log('ℹ️ Mistral: не авторизован. Войди в Edge и перезапусти сервер, или вызови /api/v1/admin/setup-auth');
        return null;
      }
    } catch (err) {
      console.warn('⚠️ _detectMistralAuthFromProfile:', err.message);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // Открывает Mistral в браузере, ждёт пока залогинишься, сохраняет куки
  async setupMistralAuth(timeoutMs = 300_000) {
    console.log('🔐 setupMistralAuth: открываю Mistral для авторизации...');
    if (!this.masterBrowser) throw new Error('Браузер не подключён');

    const context = await this.masterBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU',
    });
    const page = await context.newPage();

    try {
      await page.goto(MISTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log('🌐 Mistral открыт в новой вкладке Edge — войди в аккаунт');

      const deadline = Date.now() + timeoutMs;
      let loggedIn = false;

      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);

        const authenticated = await page.evaluate(() => {
          // Если редиректнуло на auth-домен — ещё не залогинен
          if (!window.location.hostname.includes('chat.mistral.ai')) return false;
          // Путь логина
          const p = window.location.pathname;
          if (p.includes('sign-in') || p.includes('login') || p.includes('/auth')) return false;

          // Признак авторизованного UI — nav или aside с историей чатов
          const sidebar = document.querySelector(
            'nav, aside, [class*="sidebar"], [class*="thread-list"], [class*="history"], [class*="chat-list"]'
          );
          if (!sidebar) return false;

          // Нет кнопок «войти»
          const signInLink = document.querySelector(
            'a[href*="sign-in"], a[href*="login"], button[class*="sign-in"], a[class*="sign-in"]'
          );
          return !signInLink;
        }).catch(() => false);

        if (authenticated) {
          loggedIn = true;
          console.log('✅ Авторизация в Mistral обнаружена!');
          break;
        }
      }

      if (!loggedIn) throw new Error('Таймаут ожидания входа (5 минут)');

      const { STORAGE_STATE_PATH } = require('./browser');
      const state = await context.storageState({ path: STORAGE_STATE_PATH });
      this.authState = state;
      console.log(`✅ Auth state сохранён: ${state.cookies?.length || 0} кук`);
      return true;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  async confirmManualAuth() {
    console.log('🔐 Проверка авторизации...');
    for (const [userId, ctx] of this.userContexts) {
      try {
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await this._waitForChatInterface(ctx.page, 15000);
        console.log(`✅ Контекст ${userId} обновлён`);
      } catch (err) {
        console.warn(`⚠️ Контекст ${userId}: ${err.message}`);
      }
    }
  }

  getStatus() {
    return {
      isReady: this.isReady,
      activeContexts: this.userContexts.size,
      processingTasks: this.processingTasks.size,
      hasAuthState: !!this.authState,
      contexts: Array.from(this.userContexts.keys()),
    };
  }

  async shutdown() {
    console.log('🛑 Завершение работы...');
    this.isReady = false;
    // Не вызываем masterBrowser.close() — это вызывает 25-секундный cleanup в Edge
    // и блокирует CDP для нового процесса. WS закроется автоматически вместе с процессом.
    this.masterBrowser = null;
    this.profileContext = null;
    this.demoPage = null;
    this.demoContext = null;
    this.userContexts.clear();
    console.log('✅ Сервис остановлен');
  }
}

module.exports = new AiService();
