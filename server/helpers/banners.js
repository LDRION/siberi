// ── Баннеры экранов бота ───────────────────────────────────────────────────
// Пользователь в предпросмотре (в чате конструктор-бота) встаёт на нужный экран
// и просто присылает картинку — она цепляется баннером к этому шагу меню.
//
// ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ — схема данных «Баннеры» (name='banners'). Есть запись
// для экрана → баннер показывается; удалил запись в mini-app («База») → баннер
// отвязался. Никакой отдельной синхронизации: и превью, и живой бот при рендере
// экрана просто спрашивают эту схему.
//
// Важно: file_id Telegram привязан к токену бота, поэтому file_id от
// @AI_ConstructorBot НЕ годится для живого бота пользователя (другой токен).
// Храним картинку как data-URL (base64) — его умеют слать оба бота, и mini-app
// показывает её как обычное поле-картинку.
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');
const { toTelegramHtml } = require('./telegramFormat');

const BANNER_SCHEMA = 'banners';
const BANNER_LABEL = 'Баннеры';
const F_SCREEN = 'screen';
const F_IMAGE = 'image';

// Ответ Telegram считается «успехом», если ok ИЛИ «message is not modified»
// (контент уже точно такой — напр. повторный «+» на добавке: менять нечего).
// Это НЕ ошибка: без такой трактовки код пере-слал бы сообщение → дубль (баг).
const okOrNotModified = (d) => !!d?.ok || /message is not modified/i.test(d?.description || '');

// Ключ экрана — команда/подпись кнопки как есть (например '/start' или '📋 Меню').
// Матчим регистронезависимо, поэтому просто триммим.
function stepKey(label) {
  return String(label || '').trim().slice(0, 100);
}

function screenRegex(key) {
  return new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
}

async function ensureBannerSchema(userId) {
  let sd = await UserSchema.findOne({ userId, name: BANNER_SCHEMA });
  if (!sd) {
    sd = await UserSchema.create({
      userId, name: BANNER_SCHEMA, label: BANNER_LABEL, icon: '🖼', color: '#8b5cf6',
      description: 'Картинки-баннеры для экранов бота: какая картинка показывается на каком шаге меню. Удалите запись — баннер отвяжется от экрана.',
      fields: [
        { name: F_SCREEN, label: 'Экран', type: 'text', required: true, description: 'К какому экрану/кнопке привязан баннер (например /start или «📋 Меню»).' },
        { name: F_IMAGE, label: 'Картинка', type: 'image', required: true, description: 'Баннер, который показывается на этом экране.' },
      ],
      isActive: true,
    }).catch(() => null);
  }
  return sd;
}

// Ставит/меняет баннер для экрана. dataUrl = 'data:image/...;base64,...'.
async function setBanner(userId, screen, dataUrl) {
  await ensureBannerSchema(userId);
  const key = stepKey(screen);
  if (!key || !dataUrl) return null;
  let rec = await UserRecord.findOne({ userId, schemaName: BANNER_SCHEMA, [`data.${F_SCREEN}`]: screenRegex(key) });
  if (rec) {
    rec.data = { ...(rec.data || {}), [F_SCREEN]: key, [F_IMAGE]: dataUrl };
    rec.markModified('data');
    await rec.save();
  } else {
    rec = await UserRecord.create({
      userId, schemaName: BANNER_SCHEMA,
      data: { [F_SCREEN]: key, [F_IMAGE]: dataUrl },
      metadata: { createdBy: 'user', source: 'telegram' },
    });
  }
  return rec;
}

// Возвращает data-URL (или http-URL) баннера для экрана, либо null.
async function getBanner(userId, screen) {
  const key = stepKey(screen);
  if (!key) return null;
  const rec = await UserRecord.findOne({ userId, schemaName: BANNER_SCHEMA, [`data.${F_SCREEN}`]: screenRegex(key) }).lean();
  const img = rec?.data?.[F_IMAGE];
  return (typeof img === 'string' && (img.startsWith('data:image/') || img.startsWith('http'))) ? img : null;
}

// Баннер для экрана команды: сначала СВОЙ; если своего нет — баннер /start как
// ОБЛОЖКА бота на «менюшных» экранах. Зачем: чтобы переходы между экранами шли
// фото→фото (editMessageMedia редактирует на месте, без «дёрганья»/новых
// сообщений — как в leadbot), картинка должна быть НА КАЖДОМ таком экране.
// Не накрываем обложкой экраны с длинным текстом/каталогом/динамикой (там текст
// не влезет в подпись фото 1024): listSchema/queryMySchema/showCart/aiAction/
// paidAction и ответы длиннее ~900 символов остаются текстовыми.
// Две клавиатуры — одно меню, если совпадают тексты кнопок (форма). Используется,
// чтобы экраны-возвраты в главное меню («Назад» с той же клавиатурой, что /start)
// показывали то же приветствие и ту же обложку, что /start.
function sameMenu(a, b) {
  const norm = (kb) => JSON.stringify((Array.isArray(kb) ? kb : []).map((row) => (Array.isArray(row) ? row : [row]).map((x) => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean)));
  const na = norm(a);
  return na !== '[]' && na === norm(b);
}

async function bannerForCommand(userId, cmd, startCmd) { // startCmd — для обратной совместимости, не используется
  const own = await getBanner(userId, cmd?.command);
  if (own) return own;
  if (!cmd || String(cmd.command || '').toLowerCase() === '/start') return null;
  if (cmd.listSchema || cmd.queryMySchema || cmd.showCart || cmd.aiAction || cmd.paidAction) return null;
  if (String(cmd.response || '').length > 900) return null;
  return getBanner(userId, '/start');
}

// Отправляет баннер как фото с подписью и (опц.) inline-клавиатурой.
// replyMarkup — уже готовый объект {inline_keyboard:[...]} или null.
// Подпись Telegram ограничена 1024 символами — режем аккуратно; на ошибке
// парсинга HTML откатываемся к фото с обычной подписью, чтобы картинка дошла.
async function sendBannerPhoto(token, chatId, dataUrl, caption, replyMarkup) {
  const rawCap = caption ? String(caption) : '';
  const capHtml = rawCap ? toTelegramHtml(rawCap.length > 900 ? rawCap.slice(0, 900) + '…' : rawCap).slice(0, 1024) : null;

  const post = async ({ parseHtml = true } = {}) => {
    try {
      const cap = parseHtml ? capHtml : (rawCap ? rawCap.slice(0, 1024) : null);
      if (dataUrl.startsWith('http')) {
        const body = { chat_id: chatId, photo: dataUrl };
        if (cap) { body.caption = cap; if (parseHtml) body.parse_mode = 'HTML'; }
        if (replyMarkup) body.reply_markup = replyMarkup;
        const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return !!r?.ok;
      }
      const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const mime = (dataUrl.match(/^data:(image\/[^;]+);/) || [])[1] || 'image/jpeg';
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (cap) { form.append('caption', cap); if (parseHtml) form.append('parse_mode', 'HTML'); }
      if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
      form.append('photo', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `banner.${ext}`);
      const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
      return !!r?.ok;
    } catch { return false; }
  };

  if (await post({ parseHtml: true })) return true;
  return post({ parseHtml: false }); // откат без HTML-разметки
}

function bannerCaption(text) {
  const raw = text ? String(text) : '';
  return raw ? toTelegramHtml(raw.length > 900 ? raw.slice(0, 900) + '…' : raw).slice(0, 1024) : '';
}

async function tgDelete(token, chatId, messageId) {
  if (!messageId) return;
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  }).catch(() => {});
}

// Меняет КАРТИНКУ+подпись+клавиатуру у уже-фото-сообщения НА МЕСТЕ (editMessageMedia).
async function editMediaPhoto(token, chatId, messageId, dataUrl, caption, replyMarkup) {
  try {
    const media = { type: 'photo' };
    const cap = bannerCaption(caption);
    if (cap) { media.caption = cap; media.parse_mode = 'HTML'; }
    if (dataUrl.startsWith('http')) {
      media.media = dataUrl;
      const r = await fetch(`https://api.telegram.org/bot${token}/editMessageMedia`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, media, reply_markup: replyMarkup || undefined }),
      }).then((x) => x.json()).catch(() => null);
      return okOrNotModified(r);
    }
    media.media = 'attach://photo';
    const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    const mime = (dataUrl.match(/^data:(image\/[^;]+);/) || [])[1] || 'image/jpeg';
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('message_id', String(messageId));
    form.append('media', JSON.stringify(media));
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `banner.${ext}`);
    const r = await fetch(`https://api.telegram.org/bot${token}/editMessageMedia`, { method: 'POST', body: form }).then((x) => x.json()).catch(() => null);
    return okOrNotModified(r);
  } catch { return false; }
}

// Меняет ТОЛЬКО подпись+клавиатуру у уже-фото-сообщения (editMessageCaption),
// НЕ пере-загружая картинку. Для случаев, где фото то же, а меняется лишь текст
// подписи/кнопки (напр. переключение добавок «−/+» в карточке товара) — так
// переключение мгновенное, без повторной заливки base64 на каждый тап.
async function editMediaCaption(token, chatId, messageId, caption, replyMarkup) {
  try {
    const cap = bannerCaption(caption);
    const body = { chat_id: chatId, message_id: messageId };
    if (cap) { body.caption = cap; body.parse_mode = 'HTML'; }
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json()).catch(() => null);
    return okOrNotModified(r);
  } catch { return false; }
}

// Рендер экрана как в leadbot: одно сообщение, БЕЗ спама.
// Совпал тип — правим на месте (photo↔photo через editMessageMedia, text↔text
// через editMessageText); тип поменялся (text↔photo) — удаляем старое и шлём новое.
// src = { messageId, isPhoto } — сообщение, по кнопке которого пришли (или null — новое).
// captionOnly — картинка та же, меняется лишь подпись/клавиатура (editMessageCaption).
async function renderStep({ token, chatId, src, text, banner, replyMarkup, captionOnly = false }) {
  const rm = replyMarkup || undefined;
  if (banner) {
    if (src?.messageId && src.isPhoto) {
      if (captionOnly && await editMediaCaption(token, chatId, src.messageId, text, rm)) return;
      if (await editMediaPhoto(token, chatId, src.messageId, banner, text, rm)) return;
    }
    await tgDelete(token, chatId, src?.messageId);
    return sendBannerPhoto(token, chatId, banner, text, rm);
  }
  const html = toTelegramHtml(String(text || ''));
  if (src?.messageId && !src.isPhoto) {
    const r = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: src.messageId, text: html, parse_mode: 'HTML', reply_markup: rm, disable_web_page_preview: true }),
    }).then((x) => x.json()).catch(() => null);
    if (okOrNotModified(r)) return;
  }
  if (src?.messageId && src.isPhoto) await tgDelete(token, chatId, src.messageId);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', reply_markup: rm, disable_web_page_preview: true }),
  }).catch(() => {});
}

module.exports = { BANNER_SCHEMA, ensureBannerSchema, setBanner, getBanner, bannerForCommand, sameMenu, sendBannerPhoto, renderStep, stepKey };
