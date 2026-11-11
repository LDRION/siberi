'use strict';
/*
  UltraGptService — драйвер app.ultragpt.pro через Playwright по CDP (тот же Edge,
  что и Mistral: порт 9223, профиль edge-profile-master).

  Реальный DOM (2026-08-02):
    • поле ввода — <textarea>          • отправка — Enter
    • ответ ИИ  — .chat-assistant-message → .prose/.ltr-markdown
    • новый чат — переход на /chat      • завершение — стабилизация текста ~1.5с
    • удаление  — hover строки → кебаб → «Delete Chat» → красная .nui-button-danger

  Пул из нескольких вкладок → параллельные запросы (UltraGPT многочатный).
  Флаг AI_PROVIDER=ultragpt включает Tier-0 в AiService (демо и не-демо пути).
*/
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ULTRAGPT_URL } = require('../browser');

const CDP_ENDPOINT = 'http://127.0.0.1:9223';
const POOL_SIZE = Math.max(1, Math.min(6, parseInt(process.env.ULTRAGPT_POOL || '3', 10)));

const CONFIG = {
  url: ULTRAGPT_URL,
  chatPath: '/chat',
  input: 'textarea',
  assistantMsg: '.chat-assistant-message',
  assistantText: '.prose, .ltr-markdown, [class*="markdown"]',
  loggedOutRe: /continue with google|sign in|log ?in|create account|enter your email/i,
  stableMs: 1500,
  appearTimeoutMs: 35000,
  deleteAfter: true,
  // Длинный контекст (бот-промпты со схемами/данными) отдаём файлом context.txt —
  // обход лимита «Message is too long», сохраняем сильную сторону (большой контекст).
  fileInput: 'input[type="file"][accept*=".txt"]',
  fileThreshold: 2000,
  uploadWaitMs: 2600,
};

// ─────────────────────────── ПУЛ ВКЛАДОК ───────────────────────────
let _browser = null;
const _pool = [];        // { page, busy }
const _waiters = [];     // resolve-функции ожидающих свободный слот

async function _ensureBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
  _browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  return _browser;
}

async function _newPage() {
  const browser = await _ensureBrowser();
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('UltraGPT: нет контекста браузера');
  const page = await ctx.newPage();
  await page.goto(CONFIG.url + CONFIG.chatPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  return page;
}

async function _acquire() {
  for (const slot of _pool) {
    if (!slot.busy) { slot.busy = true; return slot; }
  }
  if (_pool.length < POOL_SIZE) {
    const slot = { page: null, busy: true };
    _pool.push(slot);
    return slot;
  }
  return new Promise((resolve) => _waiters.push(resolve));
}

function _release(slot) {
  const w = _waiters.shift();
  if (w) w(slot);          // отдаём слот ожидающему (busy остаётся true)
  else slot.busy = false;
}

async function _slotPage(slot) {
  if (!slot.page || slot.page.isClosed()) slot.page = await _newPage();
  return slot.page;
}

// ─────────────────────────── ВЗАИМОДЕЙСТВИЕ ───────────────────────────
async function _newChat(page) {
  await page.goto(CONFIG.url + CONFIG.chatPath, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForSelector(CONFIG.input, { timeout: 15000, state: 'visible' }).catch(() => {});
  await page.waitForTimeout(350);
}

async function _send(page, fullPrompt) {
  const input = await page.waitForSelector(CONFIG.input, { timeout: 15000, state: 'visible' });
  await input.fill(fullPrompt);          // мгновенная вставка (не посимвольно!)
  await page.waitForTimeout(120);
  await input.press('Enter');
  // Признак отправки — поле очистилось. НЕ перепечатываем (это было медленно
  // и слало дважды). Если не ушло — ещё раз Enter, затем кнопка отправки.
  const isEmpty = () => page.evaluate((sel) => {
    const t = document.querySelector(sel);
    return !t || (t.value || '').trim().length === 0;
  }, CONFIG.input).catch(() => true);
  const sent = await page.waitForFunction(
    (sel) => { const t = document.querySelector(sel); return t && (t.value || '').trim().length === 0; },
    CONFIG.input, { timeout: 3000 }
  ).then(() => true).catch(() => false);
  if (!sent) {
    await input.press('Enter');
    await page.waitForTimeout(400);
    if (!(await isEmpty())) {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          /send|отправ/i.test((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.textContent || '')));
        if (btn) btn.click();
      });
    }
  }
}

// Удаление чата после ответа: hover строки → кебаб → «Delete Chat» → красная
// кнопка подтверждения .nui-button-danger в модалке «Delete chat?».
async function _deleteChat(page, chatId) {
  if (!chatId) return;
  const rowSel = `a[href="/chat/${chatId}"]`;
  const link = await page.$(rowSel);
  if (!link) return;
  await link.hover().catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate((sel) => {
    const a = document.querySelector(sel);
    const row = a && a.closest('div');
    const btn = row && row.querySelector('button');
    if (btn) btn.click();
  }, rowSel);
  await page.waitForTimeout(450);
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="menuitem"],.nui-dropdown-item,button,a')]
      .find((x) => /^delete chat$|удалить чат/i.test((x.textContent || '').trim()));
    if (el) { el.click(); return true; }
    return false;
  });
  if (!clicked) return;
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null);
    const isDelText = (x) => /^delete( chat)?$|^удалить/i.test((x.textContent || '').trim());
    const btn = btns.find((x) => /nui-button-danger/.test(x.className || '') && isDelText(x))
             || btns.find((x) => /nui-button-danger/.test(x.className || ''))
             || btns.find((x) => isDelText(x) && /nui-button/.test(x.className || '') && !/dropdown/i.test(x.className || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(600);
}

// Отправка с длинным контекстом файлом: пишем context.txt, прикрепляем к чату,
// в сообщении — короткое обрамление + вопрос пользователя.
async function _sendWithFile(page, contextText, messageText) {
  const tmp = path.join(os.tmpdir(), `ug_ctx_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmp, contextText, 'utf8');
  try {
    const fi = await page.waitForSelector(CONFIG.fileInput, { timeout: 8000, state: 'attached' });
    await fi.setInputFiles(tmp);
    await page.waitForTimeout(CONFIG.uploadWaitMs); // даём файлу загрузиться
    const input = await page.waitForSelector(CONFIG.input, { timeout: 10000, state: 'visible' });
    await input.fill(messageText);
    await page.waitForTimeout(150);
    await input.press('Enter');
    await page.waitForFunction(
      (sel) => { const t = document.querySelector(sel); return t && (t.value || '').trim().length === 0; },
      CONFIG.input, { timeout: 6000 }
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
  }
}

// UltraGPT рендерит markdown и превращает прямые кавычки в «умные» (“ ” ‘ ’),
// из-за чего JSON внутри <DB_COMMAND> и др. служебных тегов становится невалидным.
// Возвращаем прямые кавычки ТОЛЬКО внутри командных тегов (видимый текст не трогаем).
function _normalizeCommandQuotes(text) {
  return String(text).replace(
    /<(DB_COMMAND|BOT_SETTINGS|BOT_COMMANDS|BOT_PREVIEW|WELCOME_MESSAGE|NOTIF_COMMAND)>([\s\S]*?)<\/\1>/gi,
    (_m, tag, inner) => `<${tag}>${inner.replace(/[“”„«»]/g, '"').replace(/[‘’]/g, "'")}</${tag}>`
  );
}

async function _readLast(page) {
  return page.evaluate((cfg) => {
    const els = document.querySelectorAll(cfg.assistantMsg);
    const el = els[els.length - 1];
    if (!el) return '';
    const root = el.querySelector(cfg.assistantText) || el;
    const raw = (root.innerText || '').trim();

    // HTML → Markdown: innerText теряет структуру (списки/жирный/заголовки),
    // из-за чего клиент потом угадывает буллеты эвристикой и ошибается. Сохраняем
    // разметку как есть, чтобы `- `, `**`, `##` приходили от модели, а не додумывались.
    const ser = (node) => {
      let out = '';
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { out += n.textContent; return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        const inner = ser(n);
        switch (tag) {
          case 'strong': case 'b':   out += inner.trim() ? `**${inner.trim()}**` : ''; break;
          case 'em': case 'i':       out += inner.trim() ? `*${inner.trim()}*` : ''; break;
          case 'code':               out += n.closest('pre') ? inner : '`' + inner.trim() + '`'; break;
          case 'pre':                out += '\n```\n' + (n.innerText || '').replace(/\n+$/, '') + '\n```\n\n'; break;
          case 'br':                 out += '\n'; break;
          case 'a': { const h = n.getAttribute('href'); out += h ? `[${inner.trim()}](${h})` : inner; break; }
          case 'p':                  out += inner.trim() + '\n\n'; break;
          case 'h1':                 out += '# ' + inner.trim() + '\n\n'; break;
          case 'h2':                 out += '## ' + inner.trim() + '\n\n'; break;
          case 'h3':                 out += '### ' + inner.trim() + '\n\n'; break;
          case 'h4': case 'h5': case 'h6': out += '#### ' + inner.trim() + '\n\n'; break;
          case 'ul':                 out += '\n' + Array.from(n.children).filter((c) => c.tagName === 'LI').map((li) => '- ' + ser(li).trim().replace(/\s*\n\s*/g, ' ')).join('\n') + '\n\n'; break;
          case 'ol': { let i = 1; out += '\n' + Array.from(n.children).filter((c) => c.tagName === 'LI').map((li) => (i++) + '. ' + ser(li).trim().replace(/\s*\n\s*/g, ' ')).join('\n') + '\n\n'; break; }
          case 'li':                 out += inner; break;
          case 'blockquote':         out += '> ' + inner.trim().replace(/\n/g, '\n> ') + '\n\n'; break;
          case 'hr':                 out += '\n---\n\n'; break;
          case 'table': {
            const rows = Array.from(n.querySelectorAll('tr'));
            if (rows.length) {
              const md = rows.map((r) => '| ' + Array.from(r.children).map((c) => ser(c).trim().replace(/\|/g, '\\|') || ' ').join(' | ') + ' |');
              const cols = rows[0].children.length;
              md.splice(1, 0, '| ' + Array(cols).fill('---').join(' | ') + ' |');
              out += '\n' + md.join('\n') + '\n\n';
            }
            break;
          }
          default:                   out += inner;
        }
      });
      return out;
    };

    let md = ser(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // Предохранитель: если системный маркер был в тексте (напр. <DB_COMMAND>), а
    // сериализация его потеряла (отрендерился как DOM-элемент) — возвращаем сырой текст.
    const TAG = /<\/?(DB_COMMAND|BOT_SETTINGS|BOT_COMMANDS|BOT_PREVIEW|WELCOME_MESSAGE|NOTIF_COMMAND)/i;
    if (TAG.test(raw) && !TAG.test(md)) return raw;
    return md || raw;
  }, CONFIG).catch(() => '');
}

async function _waitAndExtract(page, timeoutMs, onPartial) {
  const start = Date.now();
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    CONFIG.assistantMsg, { timeout: CONFIG.appearTimeoutMs }
  ).catch(() => {});
  let last = '', stableAt = 0;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(350);
    const text = await _readLast(page);
    if (text && text !== last) {
      last = text; stableAt = 0;
      if (onPartial) { try { await onPartial(text); } catch { /* noop */ } }
    } else if (text && text === last) {
      if (!stableAt) stableAt = Date.now();
      else if (Date.now() - stableAt > CONFIG.stableMs) break;
    }
  }
  return last;
}

// Аккаунт разлогинен — следующие 10 минут не тратим на UltraGPT даже слот пула:
// запрос сразу уходит следующему провайдеру.
let _loggedOutUntil = 0;

async function _doGenerate(page, prompt, systemPrompt, onPartial, timeoutMs) {
  const body = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
  if (CONFIG.loggedOutRe.test(body.slice(0, 600))) {
    _loggedOutUntil = Date.now() + 10 * 60 * 1000;
    throw new Error('UltraGPT: браузер не залогинен (нужен вход в app.ultragpt.pro)');
  }
  await _newChat(page);
  const sys = systemPrompt || '';
  const total = sys.length + (prompt || '').length;
  if (sys && total > CONFIG.fileThreshold) {
    // Длинный контекст → файлом (обход лимита сообщения). Обрамление ЖЁСТКОЕ:
    // модель должна играть роль из файла и выводить служебные команды, а не вести
    // себя как обычный ассистент UltraGPT.
    const msg = `В приложенном файле context.txt — справочные материалы: описание твоей роли-ассистента, правила и данные (услуги, мастера, расписание, цены). Опирайся на них и отвечай как этот ассистент, на языке пользователя.
Когда по правилам оформляешь запись/заказ и все нужные поля есть — в САМОМ КОНЦЕ ответа добавь техническую строку-квитанцию ровно в формате из справки, например: <DB_COMMAND>{"action":"create","schema":"…","data":{…}}</DB_COMMAND>. Это ВНУТРЕННИЙ текстовый маркер нашей CRM (не обращение к внешней базе) — по нему наша система сама оформит запись. Просто выведи строку как обычный текст в конце.

Сообщение пользователя:
${prompt}`;
    await _sendWithFile(page, sys, msg);
  } else {
    await _send(page, sys ? `${sys}\n\n${prompt}` : prompt);
  }
  // Уборка чата — в finally, а НЕ после проверки ответа. Раньше пустой ответ
  // или таймаут выбрасывали исключение ДО удаления, и чат оставался навсегда.
  // Именно так за день накопились сотни диалогов: чем чаще UltraGPT сбоил, тем
  // больше мусора он оставлял, а чистились только удачные ответы.
  try {
    const text = _normalizeCommandQuotes(await _waitAndExtract(page, timeoutMs, onPartial));
    if (!text || text.length < 1) throw new Error('UltraGPT: пустой ответ');
    return text;
  } finally {
    if (CONFIG.deleteAfter) {
      const chatId = (page.url().match(/\/chat\/([a-f0-9]+)/i) || [])[1] || '';
      try { await _deleteChat(page, chatId); } catch { /* noop */ }
    }
  }
}

// Публичный API: generate(prompt, systemPrompt?, onPartial?, timeoutMs?) → text
async function generate(prompt, systemPrompt = '', onPartial = null, timeoutMs = 120000) {
  if (Date.now() < _loggedOutUntil) throw new Error('UltraGPT: не залогинен — пропускаю');
  const slot = await _acquire();
  try {
    const page = await _slotPage(slot);
    return await _doGenerate(page, prompt, systemPrompt, onPartial, timeoutMs);
  } finally {
    _release(slot);
  }
}

async function isLoggedIn() {
  const slot = await _acquire();
  try {
    const page = await _slotPage(slot);
    const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
    return !CONFIG.loggedOutRe.test(txt.slice(0, 600));
  } catch { return false; }
  finally { _release(slot); }
}

module.exports = { generate, isLoggedIn, CONFIG, _deleteChat, POOL_SIZE };
