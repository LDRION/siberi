'use strict';
// Единая нормализация текста в валидный Telegram-HTML.
//
// Предыстория: системный промпт велит модели форматировать ответы в HTML
// (<b>, <i>, ...). Но модель нестабильна — иногда присылает Markdown-звёздочки
// (*жирный*). Если такой текст уйдёт в Markdown-режиме и Telegram его отвергнет
// (легаси-Markdown хрупкий: любой непарный спецсимвол рушит разбор), сообщение
// откатывается в plain и звёздочки показываются буквально. Чтобы этого не было
// НИКОГДА, весь исходящий текст приводим к HTML и всегда шлём parse_mode:'HTML':
//   • есть HTML-теги (наш собранный каталог или HTML от модели) — отдаём как есть;
//   • нет тегов (обычный текст или Markdown) — экранируем спецсимволы и
//     конвертируем Markdown-маркеры (*ж*, **ж**, `код`, _к_) в HTML-теги.

// Теги форматирования, поддерживаемые Telegram в HTML-режиме.
const HTML_TAG_RE = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|blockquote|br)(?:\s[^>]*)?>/i;

// Экранирование спецсимволов HTML. Идемпотентно: уже готовые сущности
// (&amp;, &lt;, ...) повторно не экранируются — можно безопасно прогонять
// текст, значения в котором уже были экранированы (карточки каталога).
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Делает бренд «Siberi AI» кликабельной ссылкой на сайт (видимый текст остаётся
// «Siberi AI»). Защищаем уже существующие <a>…</a>, чтобы не вложить ссылку в
// ссылку. Матчим «Siberi AI / Siberi AI / SiberiAI», но НЕ «siberi.online»
// (после точки идёт «online», а не «AI»).
const BRAND_URL = 'https://siberi.online';
const BRAND_RE = /\bSiberi[.\s]?AI\b/gi;
function linkifyBrand(html) {
  if (!html || !/siberi/i.test(html)) return html; // дешёвый нестейтфул-предчек
  // Плейсхолдеры с null-символами — в обычном тексте их нет, поэтому обратная
  // подстановка не заденет реальные числа (в отличие от « N »).
  const NUL = String.fromCharCode(0);
  const stash = [];
  let t = String(html).replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => {
    stash.push(m);
    return NUL + (stash.length - 1) + NUL;
  });
  t = t.replace(BRAND_RE, '<a href="' + BRAND_URL + '">Siberi AI</a>');
  t = t.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), (_, i) => stash[+i] != null ? stash[+i] : '');
  return t;
}

// Приводит произвольный текст к безопасному Telegram-HTML.
function toTelegramHtml(text) {
  if (!text) return text || '';
  // Экранируем спецсимволы ТОЛЬКО если это ещё не HTML (иначе поломали бы теги
  // и дважды экранировали наш собранный каталог). А вот Markdown-маркеры
  // конвертируем ВСЕГДА: модель часто смешивает <b>заголовок</b> и *пример*
  // в одном сообщении — если пропустить такой текст как «уже HTML», звёздочки
  // останутся буквальными (реальная жалоба).
  // Для не-HTML — полное экранирование (&<>); для уже-HTML экранируем ТОЛЬКО голые
  // амперсанды (не трогая теги), иначе «злой» URL со знаком & (напр. YouTube
  // ?v=..&t=4564s) внутри <a href> ломает разбор HTML у Telegram.
  const escAmp = (s) => s.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  let t = HTML_TAG_RE.test(text) ? escAmp(text) : htmlEscape(text);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');   // **жирный**
  t = t.replace(/__([^_\n]+)__/g, '<u>$1</u>');        // __подчёркнутый__
  t = t.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');        // ~~зачёркнутый~~
  t = t.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');        // *жирный*
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');    // `код`
  // [текст](https://…) → ссылка. Только http/https, чтобы не ловить мусор.
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  // _курсив_ — только на границах слова, чтобы не задеть snake_case и ссылки.
  t = t.replace(/(?<![\w*])_([^_\n]+)_(?![\w*])/g, '<i>$1</i>');
  // Бренд «Siberi AI» → ссылка на сайт (последним шагом, поверх готового HTML).
  t = linkifyBrand(t);
  return t;
}

// Оставлено для обратной совместимости (выбор режима по содержимому).
function pickParseMode(text) {
  if (!text) return null;
  if (HTML_TAG_RE.test(text)) return 'HTML';
  return null;
}

module.exports = { toTelegramHtml, htmlEscape, pickParseMode, HTML_TAG_RE, linkifyBrand };
