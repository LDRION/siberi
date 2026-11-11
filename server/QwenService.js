'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// QwenService — резервный AI-провайдер (chat.qwen.ai)
// Используется когда Mistral недоступен.
// ─────────────────────────────────────────────────────────────────────────────

const QWEN_URL = 'https://chat.qwen.ai';
const QWEN_TIMEOUT = 120_000; // максимум 2 минуты (text-stability fallback обеспечивает ранний выход)
const { PROMPT_LEAK_MARKERS } = require('./helpers/promptLeakMarkers');

// Несколько вариантов селекторов на случай обновления UI Qwen
const INPUT_SELECTORS = [
  '#search-input',
  'textarea[id]',
  'textarea',
  'div[contenteditable="true"][data-placeholder]',
  'div[contenteditable="true"]',
];

// Иконка стрелки-отправки (send arrow) — видна ТОЛЬКО когда не генерирует
const SEND_ICON_HREF = 'icon-line-arrow-up';

class QwenService {
  constructor(masterBrowser) {
    this.masterBrowser = masterBrowser;
    this.demoPage = null; // единая прогретая страница (аналог Mistral demoPage)
    // demoPage is ONE shared tab for the whole process — two concurrent process()
    // calls would both navigate/type/read it at once (this actually happened:
    // Mistral degraded, several users fell back to Qwen simultaneously, and the
    // resulting cross-talk made BOTH see "Designed for mobile devices..." UI junk
    // instead of a real reply). Serializing here costs nothing in the common case
    // (Qwen is the last-resort fallback, rarely concurrent) and makes the worst
    // case "queued, then correct" instead of "concurrent, then corrupted".
    this._queue = Promise.resolve();
  }

  // ── Инициализировать единую Qwen-страницу ────────────────────────────────

  async _initDemoPage() {
    // Close out whatever the old demoPage was BEFORE replacing it — otherwise
    // every re-init (the health check below is occasionally too trigger-happy
    // on a momentarily-slow-but-fine page) leaks an orphaned tab that just sits
    // there doing nothing. Confirmed live via VNC: exactly this — two Qwen tabs,
    // one abandoned, one actually working.
    if (this.demoPage && !this.demoPage.isClosed()) {
      await this.demoPage.close().catch(() => {});
    }
    const contexts = this.masterBrowser.contexts();
    const ctx = contexts.length > 0 ? contexts[0] : await this.masterBrowser.newContext();
    const page = await ctx.newPage();
    await page.goto(QWEN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    await this._dismissBanners(page);
    this.demoPage = page;
    console.log('🔵 Qwen: единая страница инициализирована');
    return page;
  }

  // ── Получить прогретую страницу Qwen (единую для всех запросов) ──────────

  async getDemoPage() {
    if (!this.demoPage) {
      return await this._initDemoPage();
    }
    // Проверяем живость страницы
    try {
      await this.demoPage.evaluate(() => document.readyState, { timeout: 3000 });
      const url = this.demoPage.url();
      if (url === 'about:blank' || url.includes('error')) {
        console.warn('⚠️ Qwen demoPage повреждена, пересоздаю...');
        return await this._initDemoPage();
      }
      return this.demoPage;
    } catch {
      console.warn('⚠️ Qwen demoPage недоступна, пересоздаю...');
      return await this._initDemoPage();
    }
  }

  // ── Закрыть мобильные баннеры и попапы Qwen ──────────────────────────────

  async _dismissBanners(page) {
    try {
      await page.evaluate(() => {
        // Ищем кнопки закрытия/dismiss для мобильных баннеров
        const closeSelectors = [
          'button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]',
          'button[aria-label*="закрыть" i]', '[class*="close-btn"]',
          '[class*="modal-close"]', '[class*="banner-close"]',
          'button:has([class*="close"])', 'button:has(svg[data-icon*="close"])',
        ];
        for (const sel of closeSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) btn.click();
        }
        // Убираем любые overlay/modal/toast с текстом о мобильном приложении
        document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="toast"], [class*="banner"], [class*="popup"]').forEach(el => {
          if (el.textContent && /mobile|app|download|ios|android/i.test(el.textContent)) {
            el.remove();
          }
        });
      });
      await page.waitForTimeout(300);
      // Дополнительно — нажать Escape чтобы закрыть любой открытый попап
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    } catch {}
  }

  // ── Детект заглушки Cloudflare ───────────────────────────────────────────
  // Cloudflare может увести вкладку с чата на свою страницу ошибки — чаще всего
  // 1015 «You are being rate limited» (нас режут по частоте), реже challenge
  // «Just a moment». Визуально это НЕ чат: генерация там не начнётся никогда.
  // Без этой проверки код ждал полный таймаут и возвращал невнятное «страница не
  // отвечает», а мёртвая вкладка оставалась висеть — за сутки так накопилось 12
  // штук и съело 2.7 ГБ RAM, что добивало и Mistral. Возвращает причину или null.
  async _detectBlockPage(page) {
    try {
      const url = page.url() || '';
      if (/cloudflare\.com|challenges\.cloudflare|\/error-\d{3,}/i.test(url)) {
        return 'Qwen: Cloudflare увёл вкладку на страницу ошибки (лимит запросов) — нужен бэкофф';
      }
      const info = await page.evaluate(() => ({
        title: document.title || '',
        body: (document.body?.innerText || '').slice(0, 600),
      })).catch(() => null);
      if (!info) return null;
      const hay = `${info.title}\n${info.body}`;
      if (/error\s*1015|you are being rate limited|rate limited/i.test(hay)) {
        return 'Qwen: лимит запросов Cloudflare (1015) — аккаунт временно режется, нужен бэкофф';
      }
      if (/just a moment|checking your browser|verify you are human|attention required/i.test(hay)) {
        return 'Qwen: Cloudflare-проверка (challenge) — вкладка не пускает к чату';
      }
      return null;
    } catch { return null; }
  }

  // ── Найти поле ввода ─────────────────────────────────────────────────────

  async _findInput(page) {
    for (const sel of INPUT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (visible) return el;
      } catch {}
    }
    return null;
  }

  async _waitForInput(page, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = await this._findInput(page);
      if (el) return el;
      await page.waitForTimeout(600);
    }
    return null;
  }

  // ── Кнопка «отправить» (arrow-up) видима → НЕ генерируем ────────────────

  // ── Кнопка «отправить» — мульти-детектор (надёжно при смене UI) ────────────────

async _isSendReady(page) {
  try {
    const isReady = await page.evaluate((sendIconHref) => {
      // Qwen's send button keeps the SAME class ("send-button") whether idle or
      // generating — confirmed live via VNC + DOM inspection. The only thing
      // that actually changes is which icon is rendered inside it: a plain
      // send arrow (#icon-line-arrow-up) when ready, swapped for a stop/square
      // icon while generating. disabled/CSS-class-based heuristics (the old
      // approach) don't track this at all, which is exactly why "generation
      // finished" kept going undetected — Qwen really had finished, our check
      // just never noticed because it was watching the wrong signal.
      const sendBtn = document.querySelector('button.send-button, button[class*="send-button"]');
      if (sendBtn) {
        const use = sendBtn.querySelector('use');
        const href = use ? (use.getAttribute('href') || use.getAttribute('xlink:href') || '') : '';
        if (href) return href.includes(sendIconHref);
        // Button found but icon href unreadable right now (mid swap/re-render).
        // Do NOT fall through to the generic textarea-class heuristics below —
        // those aren't actually tied to generation state and once falsely
        // reported "ready" here, mistaking a mid-generation pause for done.
        // Safe default: assume still generating (costs one more 600ms poll;
        // the alternative truncates a real answer).
        return false;
      }

      // Fallbacks below only matter if Qwen's markup changes again and the
      // primary check above can't even find the button.
      // 1. Кнопка с aria-label
      const ariaBtn = document.querySelector(
        'button[aria-label*="send" i], button[aria-label*="отправить" i], button[data-testid="send"]'
      );
      if (ariaBtn && !ariaBtn.disabled && ariaBtn.offsetParent !== null) {
        if (!ariaBtn.querySelector('svg[class*="spin"], [class*="loading"], [class*="loader"]')) {
          return true;
        }
      }
      // 2. Иконка стрелки (generic)
      const arrowIcons = document.querySelectorAll('svg[class*="arrow"], svg[class*="send"], use[href*="arrow"], use[href*="send"]');
      for (const icon of arrowIcons) {
        const btn = icon.closest('button:not([disabled])');
        if (btn && btn.offsetParent !== null && !btn.querySelector('[class*="loading"], [class*="spin"]')) {
          return true;
        }
      }
      // 3. Textarea не в generating
      const textarea = document.querySelector('textarea, div[contenteditable="true"]');
      if (textarea) {
        const parent = textarea.closest('[class*="chat"], [class*="input"], [class*="composer"]');
        if (parent && !parent.classList.toString().match(/generating|loading|thinking/i)) {
          return true;
        }
      }
      return false;
    }, SEND_ICON_HREF);
    return isReady;
  } catch {
    return false;
  }
}

async _isGenerating(page) {
  // Если кнопка НЕ готова → значит, генерация идёт
  return !(await this._isSendReady(page));
}

  // ── Отправить сообщение (через буфер обмена для надёжности с длинным текстом) ──

  async send(page, text) {
    const input = await this._waitForInput(page, 15_000);
    if (!input) throw new Error('Qwen: поле ввода не найдено — возможно не авторизован');

    await input.click();
    await page.waitForTimeout(100);

    // Пробуем textarea.fill() — Playwright правильно обрабатывает React-контролируемые поля
    let sent = false;
    try {
      await input.fill(text);
      sent = true;
      console.log('✅ Qwen: текст введён через fill()');
    } catch {}

    if (!sent) {
      // Пробуем insertText через contenteditable
      const injected = await page.evaluate((t) => {
        const el = document.querySelector('div[contenteditable="true"][data-placeholder], div[contenteditable="true"]');
        if (!el) return false;
        el.focus();
        document.execCommand('selectAll', false, null);
        return document.execCommand('insertText', false, t);
      }, text);

      if (!injected) {
        // Clipboard paste — ВАЖНО: после копирования возвращаем фокус в поле ввода
        await page.evaluate((t) => {
          const area = document.createElement('textarea');
          area.value = t;
          area.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
          document.body.appendChild(area);
          area.focus();
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
        }, text);
        await input.click(); // возвращаем фокус в реальное поле
        await page.waitForTimeout(150);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyV');
        await page.keyboard.up('Control');
        await page.waitForTimeout(500);
      }
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    console.log('📤 Qwen: сообщение отправлено');
  }

  // ── Ждать ответа и извлечь текст ─────────────────────────────────────────

  async waitForResponse(page, onPartialText = null, responseTimeoutMs = 120_000) {
    console.log('⏳ Qwen: ожидаю ответ...');
    const MARKER = '[END_TEXT]';
    let partialFired = false;

    // Qwen's homepage/chat shell shows a static "Designed for mobile devices..."
    // promo banner that's present BEFORE any message is even sent (especially
    // right after the reload-and-retry path) — and a banner that never changes
    // trivially satisfies "text stable for N ticks". Used both by the early
    // "instant answer" fast-path below AND the final cleanup, so a known-bad
    // match never gets accepted as a real reply at either point.
    const QWEN_UI_RE = /^(designed for mobile|get the (mistral |le chat |qwen )?app|better experience and more features|download.*app|for ios|for android|switch to|open in app)/i;
    const looksLikeJunk = (text) => {
      const t = (text || '').trim();
      return QWEN_UI_RE.test(t) || PROMPT_LEAK_MARKERS.some((m) => t.includes(m));
    };

    const maybeFirePartial = async (text) => {
      if (partialFired || !onPartialText) return;
      const idx = text.indexOf(MARKER);
      if (idx === -1) return;
      partialFired = true;
      const textPart = text.slice(0, idx).trim();
      if (PROMPT_LEAK_MARKERS.some((m) => textPart.includes(m))) {
        console.warn('⚠️ Qwen [END_TEXT] перед маркером — утечка промта, partialResult не показываю');
        return;
      }
      if (textPart.length > 30) {
        console.log(`🎯 Qwen [END_TEXT] marker — partialResult (${textPart.length} chars)`);
        try { await onPartialText(textPart); } catch {}
      } else {
        console.log(`⚠️ Qwen [END_TEXT] слишком рано (${textPart.length} chars) — игнорирую partialResult`);
      }
    };

    // Ждём URL вида /c/{uuid} (новый чат создан)
    let chatId = null;
    try {
      await page.waitForURL(/\/c\/[a-f0-9-]{8,}/i, { timeout: 12_000 });
    } catch {
      console.log('⚠️ Qwen: URL не изменился, возможно уже в чате');
    }

    const urlMatch = page.url().match(/\/c\/([a-f0-9-]{8,})/i);
    chatId = urlMatch?.[1] ?? null;
    console.log(`🔗 Qwen chatId: ${chatId || 'нет'}`);

    // Единый цикл ожидания: сначала ждём начала генерации, потом стабилизации текста
    // Дополнительно — text-stability как надёжный fallback если иконка не детектируется.
    // Завершение определяется ИСКЛЮЧИТЕЛЬНО реальными паттернами (иконка/стабильный
    // текст), не часами. responseTimeoutMs здесь — порог зависания: если текст не
    // растёт ни на символ за это время, страница реально зависла, а не Qwen просто
    // долго пишет длинный студийный ответ. Пока текст растёт — ждём дальше без
    // верхней границы (кроме абсолютного предохранителя HARD_CEILING_MS).
    const HARD_CEILING_MS = 20 * 60 * 1000;
    const loopStart = Date.now();
    let started = false;
    let prevText = '';
    let stableCount = 0;
    let confirmedDone = false;
    let lastLen = 0;
    let lastProgressAt = Date.now();
    let lastBlockCheckAt = Date.now();

    // Короткая пауза — даём Qwen время начать обработку
    await page.waitForTimeout(1500);

    while (Date.now() - loopStart < HARD_CEILING_MS) {
      await page.waitForTimeout(600);

      const isGen = await this._isGenerating(page);

      if (!started) {
        if (isGen) {
          started = true;
          console.log('✅ Qwen начал генерировать');
          stableCount = 0;
          prevText = '';
          lastLen = 0;
          lastProgressAt = Date.now();
        } else {
          // Проверяем не появился ли текст уже (быстрый ответ)
          const cur = await this._extractLastMessage(page).catch(() => '');
          if (cur.length > lastLen) { lastLen = cur.length; lastProgressAt = Date.now(); }
          await maybeFirePartial(cur);
          if (looksLikeJunk(cur)) {
            // Static page chrome (promo banner) or our own leaked prompt —
            // never count this as a stable answer, no matter how long it sits
            // unchanged. Keep waiting for the real generation to actually start.
            stableCount = 0;
            prevText = '';
          } else if (cur.length > 30) {
            stableCount++;
            if (cur === prevText && stableCount >= 3) {
              // Confirm before trusting it: a "ready" reading on _isSendReady can be
              // a momentary false negative (icon mid-swap) rather than a real instant
              // answer — and wrongly trusting it here means shipping a truncated
              // answer as final. Wait a bit longer and re-check both the text and
              // the generating-icon once more before committing to "done".
              await page.waitForTimeout(2000);
              const confirmGen = await this._isGenerating(page);
              const confirmText = await this._extractLastMessage(page).catch(() => '');
              if (!confirmGen && confirmText === cur) {
                console.log('✅ Qwen: мгновенный ответ (текст стабилен, подтверждено)');
                confirmedDone = true;
                break;
              }
              console.log('⚠️ Qwen: текст продолжил меняться после "стабильного" — генерация ещё идёт');
              started = confirmGen;
              stableCount = 0;
              prevText = confirmText;
              lastLen = confirmText.length;
              lastProgressAt = Date.now();
              continue;
            }
            prevText = cur;
          }
        }
        // Ещё ничего не появилось и кнопка не показывает генерацию — если это
        // длится дольше окна, страница не отозвалась вовсе (не путать с "AI
        // долго думает": там started уже true и работает stuck-check ниже).
        // Ничего не появилось — возможная причина не «долго думает», а увод
        // вкладки на заглушку Cloudflare (чаще всего 1015 rate limit). Там
        // генерации не будет НИКОГДА, ждать полный таймаут бессмысленно.
        // Проверяем раз в ~10с (evaluate недёшев) и падаем с внятной причиной.
        if (Date.now() - lastBlockCheckAt > 10_000) {
          lastBlockCheckAt = Date.now();
          const blocked = await this._detectBlockPage(page);
          if (blocked) throw new Error(blocked);
        }
        if (Date.now() - lastProgressAt > responseTimeoutMs) {
          throw new Error('Qwen: страница не отвечает — генерация не началась за отведённое время');
        }
      } else {
        // Генерация шла — проверяем завершение по иконке
        if (!isGen) {
          console.log('✅ Qwen завершил ответ (иконка отправки появилась)');
          confirmedDone = true;
          break;
        }
        // Текстовая стабилизация как дополнительный выход (на случай сломанной иконки)
        const cur = await this._extractLastMessage(page).catch(() => '');
        if (cur.length > lastLen) { lastLen = cur.length; lastProgressAt = Date.now(); }
        await maybeFirePartial(cur); // check [END_TEXT] marker on every tick
        if (cur.length > 50) {
          if (cur === prevText) {
            stableCount++;
            if (stableCount >= 5) {
              console.log('✅ Qwen: текст стабилизирован (fallback)');
              confirmedDone = true;
              break;
            }
          } else {
            stableCount = 0;
            prevText = cur;
          }
        } else {
          stableCount = 0;
          prevText = cur;
        }
        if (Date.now() - lastProgressAt > responseTimeoutMs) {
          throw new Error('Qwen: генерация зависла — текст не меняется, хотя иконка показывает "идёт генерация"');
        }
      }
    }

    if (!confirmedDone) {
      throw new Error('Qwen: генерация зависла — нет ни подтверждения завершения, ни роста текста за отведённое время');
    }

    const text = await this._extractLastMessage(page);
    console.log(`📝 Qwen: извлечено ${text.length} символов`);
    // Убираем артефакты Qwen Reasoning Mode и стриминг-маркер
    let cleanText = text
      .replace(/^Thinking completed\s*/i, '')
      .replace(/^Thinking\.\.\.\s*/i, '')
      .replace(/^<think>[\s\S]*?<\/think>\s*/i, '')
      .replace(/\[END_TEXT\]/g, '')
      .trim();

    // Фильтруем UI-артефакты (мобильная реклама и т.п.) — QWEN_UI_RE shared with
    // the early "instant answer" check above.
    if (QWEN_UI_RE.test(cleanText.trim())) {
      console.warn(`⚠️ Qwen: UI-артефакт отброшен: "${cleanText.slice(0, 80)}"`);
      throw new Error('Qwen: ответ содержит UI-артефакт мобильного приложения');
    }

    // Same risk as Mistral: messageText pastes systemPrompt+task.prompt as ONE
    // message — if the scraper above ever grabs our own sent bubble instead of
    // the real new reply, this is how we'd know. process()'s catch already
    // retries once on "артефакт" — extend that same retry to this case too.
    if (PROMPT_LEAK_MARKERS.some((m) => cleanText.includes(m))) {
      console.warn(`⚠️ Qwen: ответ содержит сигнатуру нашего промта — отброшен: "${cleanText.slice(0, 80)}"`);
      throw new Error('Qwen: ответ содержит утечку собственного промта (prompt leak)');
    }

    if (cleanText.length > 0) {
      console.log(`🔍 Qwen preview: "${cleanText.slice(0, 100).replace(/\n/g, '\\n')}"`);
    } else {
      const debugHtml = await page.evaluate(() => {
        const last = document.querySelector('[class*="message"]:last-of-type, [role="article"]:last-of-type, .content:last-of-type');
        return last ? last.outerHTML.slice(0, 500) : 'No message element found';
      }).catch(() => 'evaluate failed');
      console.warn(`⚠️ Qwen: текст пуст, DOM-превью: ${debugHtml.slice(0, 300)}`);
    }
    return { text: cleanText || text, chatId };
  }

  // ── Извлечь текст последнего сообщения AI (универсальный детектор) ───────────

async _extractLastMessage(page) {
  const raw = await page.evaluate(() => {
    // ── 1. Собираем ВСЕ возможные контейнеры сообщений ─────────────────────
    const allSelectors = [
  // 🔥 ТВОИ СЕЛЕКТОРЫ (приоритет!) — из скрина
  'div.response-message-content',
  '.phase-answer',
  '[id^="chat-response-message-"]',
  '[class*="response-message"]',
  '[class*="phase-answer"]',
  'div.t2t.phase-answer',

  // Qwen-specific fallbacks
  '[class*="qwen-message"]', '[class*="qwen-chat"]', '[class*="qwen-assistant"]',
  '[data-testid*="message"]', '[data-testid*="assistant"]', '[data-testid*="response"]',

  // Generic AI/chat
  '[role="article"]', '[role="region"][aria-label*="message" i]',
  '[class*="assistant-message"]', '[class*="ai-message"]', '[class*="bot-message"]',
  '[class*="response"]', '[class*="reply"]', '[class*="answer"]',

  // Markdown/content
  '.md', '.prose', '.markdown', '.markdown-body', '.content', '.message-content',

  // Fallback: any div with substantial text that's not user input
  'div[aria-label*="message" i]', 'div[class*="bubble"]:not([class*="user"])',
];

    // ── 1a. Быстрый путь: chat-response-message-* (точный Qwen-селектор) ──────
    // Берём ПОСЛЕДНИЙ из них по порядку в DOM — он самый свежий
    const responseEls = Array.from(document.querySelectorAll('[id^="chat-response-message-"]'));
    if (responseEls.length > 0) {
      const lastResponse = responseEls[responseEls.length - 1];
      const t = lastResponse.textContent?.trim();
      if (t && t.length > 5) {
        // Небольшая чистка: убираем кнопки и UI
        const clone = lastResponse.cloneNode(true);
        clone.querySelectorAll('button, [class*="copy" i], [class*="action" i], [class*="toolbar" i], [class*="feedback" i]').forEach(el => el.remove());
        clone.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
        // div/h1-h6 too, not just p/li — Qwen's UI wraps paragraph-equivalent
        // blocks in <div>, and missing this collapsed every block boundary into
        // one run-on line (confirmed live: headers glued directly to the next
        // sentence with zero separator, e.g. "</b>Вы больше не будете...").
        clone.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6').forEach(el => { el.prepend(document.createTextNode('\n')); el.append(document.createTextNode('\n')); });
        return clone.textContent.trim();
      }
    }

    let candidates = [];
    for (const sel of allSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent?.trim();
        // Фильтруем: только элементы с текстом > 20 символов, не user-сообщения и не сайдбар
        if (text && text.length > 20 &&
            !el.closest('[class*="user"], [class*="human"], [data-role="user"]') &&
            !el.closest('nav, aside, [class*="sidebar"], [class*="history"], [class*="chat-list"]')) {
          candidates.push({ el, text, score: text.length });
        }
      }
    }

    // ── 2. Берём последний по позиции в DOM (самый свежий) ──────────────────
    if (candidates.length > 0) {
      // Сортируем по DOM-позиции: compareDocumentPosition даёт 4 если b идёт ПОСЛЕ a
      candidates.sort((a, b) => a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1);
      const best = candidates[candidates.length - 1]; // последний в DOM = самый новый

      // ── 3. Клонируем и чистим ─────────────────────────────────────────────
      const clone = best.el.cloneNode(true);
      clone.querySelectorAll(
        'button, [class*="copy" i], [class*="action" i], [class*="footer" i], time, [class*="feedback" i], [class*="toolbar" i], [class*="header" i]'
      ).forEach(el => el.remove());

      // Удаляем цитаты/источники
      clone.querySelectorAll('[class*="citation" i], [class*="source" i], [class*="reference" i]').forEach(el => el.remove());

      // ── 4. Таблицы → markdown ─────────────────────────────────────────────
      clone.querySelectorAll('table').forEach(table => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!rows.length) { table.remove(); return; }
        const md = rows.map((row, ri) => {
          const cells = Array.from(row.querySelectorAll('th, td'))
            .map(c => c.textContent.trim().replace(/\|/g, '\\|'));
          if (!cells.length) return '';
          const line = '| ' + cells.join(' | ') + ' |';
          return ri === 0 ? line + '\n|' + cells.map(() => ' --- |').join('') : line;
        }).filter(Boolean).join('\n');
        const ph = document.createElement('div');
        ph.setAttribute('data-md-table', 'true');
        ph.textContent = '\n\n' + md + '\n\n';
        table.replaceWith(ph);
      });

      // ── 5. Форматируем переносы ───────────────────────────────────────────
      clone.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
      clone.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6').forEach(el => {
        el.prepend(document.createTextNode('\n'));
        el.append(document.createTextNode('\n'));
      });
      clone.querySelectorAll('div:not([data-md-table])').forEach(el => {
        el.prepend(document.createTextNode('\n'));
        el.append(document.createTextNode('\n'));
      });

      return clone.textContent.trim();
    }

    // ── 6. Fallback: ищем любой элемент с текстом, который не user ─────────
    const allDivs = Array.from(document.querySelectorAll('div'));
    const nonUser = allDivs.filter(div => {
      const cls = (div.className || '').toLowerCase();
      const txt = div.textContent?.trim();
      return txt?.length > 50 &&
             !cls.includes('user') && !cls.includes('human') && !cls.includes('input') &&
             !div.querySelector('textarea, input[type="text"]');
    });
    if (nonUser.length > 0) {
      return nonUser[nonUser.length - 1].textContent.trim();
    }

    return '';
  }).catch(err => {
    console.warn('⚠️ _extractLastMessage evaluate error:', err.message);
    return '';
  });

  if (!raw) return '';

  // ── Node.js: пост-обработка (склеиваем таблицы, убираем артефакты) ─────
  const lines = raw.split('\n');
  const fixed = [];
  for (const line of lines) {
    const t = line.trim();
    const prev = fixed.length > 0 ? fixed[fixed.length - 1].trim() : '';
    if (prev && /^\|/.test(prev) && t !== '' && !/^\|/.test(t) && t.includes('|')) {
      fixed[fixed.length - 1] = fixed[fixed.length - 1].trimEnd() + ' ' + t;
    } else {
      fixed.push(line);
    }
  }
  return fixed.join('\n').trim();
}

  // ── Попытка переименовать чат в сайдбаре ─────────────────────────────────

  async _renameChat(page, chatId, label) {
    try {
      await page.waitForTimeout(2000);

      // ── Шаг 1: найти элемент чата в сайдбаре ───────────────────────────────
      const chatContainer = await page.evaluateHandle((chatId) => {
        // По href с chatId
        const byHref = document.querySelector(`a[href*="/c/${chatId}"]`);
        if (byHref) return byHref.closest('li, [class*="item"], [class*="session"]') || byHref;

        // По href без /c/ (резерв)
        const byHref2 = document.querySelector(`[href*="${chatId}"]`);
        if (byHref2) return byHref2.closest('li, [class*="item"], [class*="session"]') || byHref2;

        // Активный/выделенный элемент сайдбара
        const active = document.querySelector(
          '[class*="active"][class*="item"], [class*="selected"][class*="item"], [aria-selected="true"]'
        );
        if (active) return active;

        // Первый элемент сайдбара (только что созданный чат — сверху)
        const first = document.querySelector(
          'nav li:first-child, aside li:first-child, [class*="sidebar"] li:first-child, [class*="chat-list"] > *:first-child'
        );
        return first || null;
      }, chatId);

      const chatContainerEl = await chatContainer.asElement();
      if (!chatContainerEl) {
        console.log(`⚠️ Qwen: элемент чата "${chatId}" в сайдбаре не найден, пропускаю переименование`);
        return;
      }

      await chatContainerEl.hover();
      await page.waitForTimeout(600);

      // ── Шаг 2: найти кнопку ··· (icon-line-more-01) ─────────────────────────
      const moreBtn = await page.evaluateHandle((chatId) => {
        const containers = [
          document.querySelector(`a[href*="/c/${chatId}"]`)?.closest('li, [class*="item"], [class*="session"]'),
          document.querySelector('[class*="active"][class*="item"], [class*="selected"][class*="item"]'),
          document.querySelector('nav li:first-child, aside li:first-child, [class*="chat-list"] > *:first-child'),
          document.body,
        ];
        for (const container of containers) {
          if (!container) continue;
          for (const use of container.querySelectorAll('use')) {
            const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
            if (href.includes('icon-line-more-01')) {
              const btn = use.closest('button');
              if (btn) return btn;
            }
          }
        }
        return null;
      }, chatId);

      const moreBtnEl = await moreBtn.asElement();
      if (!moreBtnEl) {
        console.log('⚠️ Qwen: кнопка "···" (icon-line-more-01) не найдена');
        return;
      }
      await moreBtnEl.click();
      await page.waitForTimeout(500);

      // ── Шаг 3: пункт «Переименовать» ────────────────────────────────────────
      const renameItem = await page.$(
        '[class*="rename" i], li:has-text("Rename"), li:has-text("Переименовать"), [role="menuitem"]:has-text("Rename")'
      );
      if (!renameItem) {
        console.log('⚠️ Qwen: пункт "Переименовать" не найден в меню');
        await page.keyboard.press('Escape');
        return;
      }
      await renameItem.click();
      await page.waitForTimeout(400);

      // ── Шаг 4: ввод нового имени ─────────────────────────────────────────────
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type(label, { delay: 30 });

      // ── Шаг 5: подтвердить (.qwen-modal-btn-actions.brandprimary) ───────────
      const confirmBtn = await page.$(
        'button.qwen-modal-btn-actions.brandprimary, button:has-text("Confirm"), button:has-text("Подтвердить")'
      );
      if (confirmBtn) {
        await confirmBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      console.log(`✅ Qwen: чат переименован → "${label}"`);
    } catch (err) {
      console.log('⚠️ Qwen: переименование не удалось:', err.message);
    }
  }

  // ── Основной метод: обработать запрос через Qwen ─────────────────────────

  // Public entry point — just enqueues onto the single shared demoPage's queue.
  // Errors don't wedge the queue for the next caller (the .catch(() => {}) only
  // protects the queue chain itself; the real error still rejects `run` for
  // whoever called process() this time).
  process(...args) {
    const run = this._queue.then(() => this._processQueued(...args));
    this._queue = run.catch(() => {});
    return run;
  }

  async _processQueued(task, systemPrompt, userId, existingQwenChatId, userEmail, onPartialText = null) {
    console.log('🌟 Qwen: начинаю обработку задачи', task.taskId);

    // Единая прогретая страница — не создаём новых вкладок (как Mistral demoPage)
    const page = await this.getDemoPage();

    // Собираем последние 3 пары сообщений из истории
    const ChatMessage = require('./models/ChatMessage');
    const history = await ChatMessage.find({ userId })
      .sort({ createdAt: -1 })
      .limit(6)
      .lean()
      .catch(() => []);
    history.reverse();

    // Always use fresh Qwen chat — inject history in prompt for context
    let isNewChat = true;
    const currentUrl = page.url();
    if (!currentUrl.startsWith(QWEN_URL) || currentUrl.includes('/c/')) {
      await page.goto(QWEN_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(2000);
    }

    // Строим текст сообщения
    let messageText;
    if (isNewChat) {
      // Первое сообщение: системный промт + история + текущий запрос
      let historySection = '';
      if (history.length > 0) {
        const lines = history.map((m) =>
          `${m.role === 'user' ? 'Пользователь' : 'AI'}: ${m.content}`
        );
        historySection = '\n\n--- ПРЕДЫДУЩИЙ ДИАЛОГ (для контекста) ---\n' +
          lines.join('\n') +
          '\n--- КОНЕЦ ИСТОРИИ ---\n';
      }
      messageText =
        systemPrompt +
        historySection +
        '\n\n--- ТЕКУЩИЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ ---\n' +
        task.prompt;
    } else {
      // Продолжение существующего чата — только сам запрос
      messageText = task.prompt;
    }

    // Закрываем баннеры перед отправкой (на случай если появились после навигации)
    await this._dismissBanners(page);

    // Same reasoning as Mistral: this is now a STUCK threshold (how long text
    // can sit completely unchanged before we conclude the page froze), not an
    // upper bound on legitimate generation — completion is detected purely by
    // the icon/text-stability patterns in waitForResponse, with no clock-based
    // cutoff. Studio turns get more patience since a long bot-build answer can
    // legitimately pause longer between paragraphs than a plain chat reply.
    const qwenResponseTimeoutMs = task.context?.source === 'studio' ? 280_000 : 120_000;

    await this.send(page, messageText);
    let text, newChatId;
    try {
      ({ text, chatId: newChatId } = await this.waitForResponse(page, onPartialText, qwenResponseTimeoutMs));
    } catch (respErr) {
      // Если поймали UI-артефакт, утечку собственного промта ИЛИ зависшую
      // страницу — сбрасываем страницу и пробуем ещё раз (same one-shot retry
      // for all three failure modes; a reload is a reasonable recovery for a
      // frozen DOM, same as for a stale/junk render).
      if (respErr.message.includes('артефакт') || respErr.message.includes('artifact') || respErr.message.includes('prompt leak') || respErr.message.includes('зависл') || respErr.message.includes('не отвечает')) {
        console.warn(`⚠️ Qwen: ошибка на первой попытке (${respErr.message}) — reload и retry`);
        await page.goto(QWEN_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await this._dismissBanners(page);
        await this.send(page, messageText);
        ({ text, chatId: newChatId } = await this.waitForResponse(page, onPartialText, qwenResponseTimeoutMs));
      } else {
        throw respErr;
      }
    }

    if (!text || text.trim().length < 5) {
      throw new Error('Qwen: ответ пустой или слишком короткий');
    }

    const resultChatId = newChatId || existingQwenChatId;

    // Сначала возвращаемся на homepage (страница готова), потом удаляем чат в фоне
    try {
      await page.goto(QWEN_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch {}
    if (resultChatId) setImmediate(() => this._deleteQwenChat(page, resultChatId).catch(() => {}));

    console.log(`✅ Qwen: ${text.length} символов, chatId=${resultChatId}`);
    return { text, chatId: resultChatId };
  }

  // ── Удалить чат Qwen из UI ──────────────────────────────────────────────

  async _deleteQwenChat(page, chatId) {
    try {
      // Ждём пока сайдбар отрендерится
      await page.waitForSelector(`a[href*="${chatId}"], [href*="${chatId}"]`, { timeout: 6000 }).catch(() => {});

      const chatLink = page.locator(`a[href*="${chatId}"], [href*="${chatId}"]`).first();
      if ((await chatLink.count()) === 0) {
        console.warn(`⚠️ _deleteQwenChat: чат ${chatId} не найден в сайдбаре`);
        return;
      }

      await chatLink.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      // Двигаем мышь к строке — CSS :hover активирует кнопку
      const box = await chatLink.boundingBox();
      if (!box) return;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(600);

      // Кнопка "три точки" — XPath: ближайший предок со кнопкой, затем сама кнопка
      // Пробуем aria-label=More options первым, потом fallback на любую кнопку в строке
      let moreBtnClicked = false;
      const moreBtnXpath = page.locator(
        `xpath=//*[contains(@href,"${chatId}") or contains(@href,"${chatId}")]/ancestor::*[.//button][1]//button[last()]`
      ).first();
      try {
        await moreBtnXpath.click({ force: true, timeout: 2000 });
        moreBtnClicked = true;
      } catch {
        // Fallback: кнопка с aria-label или data-action в родительском контейнере
        const fallbackBtn = page.locator(`a[href*="${chatId}"]`)
          .locator('xpath=ancestor::li[1]//button | ancestor::div[contains(@class,"item")][1]//button')
          .last();
        try {
          await fallbackBtn.click({ force: true, timeout: 1500 });
          moreBtnClicked = true;
        } catch {}
      }
      if (!moreBtnClicked) return;
      await page.waitForTimeout(500);

      // Пункт Delete в меню — Playwright с force
      const deleteItem = page.locator(
        'li.chat-menu-item-error, [class*="chat-menu-item-error"], ' +
        '[role="menuitem"]:has-text("Delete"), li:has-text("Delete")'
      ).first();
      try {
        await deleteItem.click({ force: true, timeout: 2000 });
      } catch {
        await page.keyboard.press('Escape');
        return;
      }
      await page.waitForTimeout(500);

      // Кнопка подтверждения — force click
      const confirmBtn = page.locator(
        'button.dangerprimary, button[class*="dangerprimary"], ' +
        'button[class*="danger"][class*="primary"], button[class*="destructive"]'
      ).first();
      try {
        await confirmBtn.click({ force: true, timeout: 2000 });
      } catch {
        await page.locator('button:has-text("Delete"):not([aria-label])').first()
          .click({ force: true, timeout: 1500 }).catch(() => {});
      }
      console.log(`🗑️ Чат Qwen удалён: ${chatId}`);
    } catch (err) {
      console.warn(`⚠️ _deleteQwenChat: ${err.message}`);
    }
  }

  // ── Освободить ресурсы (закрыть единую страницу) ─────────────────────────

  destroy() {
    if (this.demoPage) {
      this.demoPage.close().catch(() => {});
      this.demoPage = null;
    }
  }
}

module.exports = QwenService;
