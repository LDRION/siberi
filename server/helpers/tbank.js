'use strict';
// ── T-Bank (Т-Касса / Тинькофф) интернет-эквайринг ──────────────────────────
// Приём платежей ЗА ПОДПИСКУ на конструктор (AI Constructor Bot) на наш терминал
// ИП. Поток «Банковская платёжная форма», одностадийная оплата:
//   1. initPayment → POST /v2/Init → получаем PaymentURL, ведём клиента туда;
//   2. клиент платит на форме Т-Кассы (карта/СБП/SberPay), чеки формирует сам
//      терминал (онлайн-касса подключена на стороне Т-Кассы — Receipt НЕ шлём);
//   3. Т-Касса шлёт server-to-server уведомление на NotificationURL со статусом
//      CONFIRMED → мы проверяем подпись (Token) и активируем подписку.
// Подпись (Token) — SHA-256 от значений КОРНЕВЫХ скалярных полей запроса + пароль
// терминала, отсортированных по имени ключа. Вложенные объекты (DATA/Receipt) в
// подпись НЕ входят. Алгоритм подтверждён эмпирически на тест-терминале (Init +
// GetState приняты). ⚠️ Секреты — только в .env (TBANK_TERMINAL_KEY/PASSWORD),
// в репозиторий не коммитим.
const crypto = require('crypto');

const API_URL = process.env.TBANK_API_URL || 'https://securepay.tinkoff.ru/v2';

function terminal() {
  return {
    key: (process.env.TBANK_TERMINAL_KEY || '').trim(),
    password: (process.env.TBANK_TERMINAL_PASSWORD || '').trim(),
  };
}

// Настроен ли приём через Т-Касса (есть ключ+пароль терминала). Пока false —
// платежи идут прежним способом (ЮMoney), ничего не ломается.
function isConfigured() {
  const t = terminal();
  return !!(t.key && t.password);
}

// Тест-режим: терминал ДЕМО (ключ содержит DEMO) либо явный флаг TBANK_TEST_MODE.
// На ДЕМО-терминале деньги не двигаются, а его пароль не является строгим
// секретом — поэтому в тест-режиме приём через Т-Касса РАЗРЕШЁН ТОЛЬКО платформенным
// админам (см. createPaymentUrl / tbank-вебхук): обычные клиенты остаются на ЮMoney,
// а форсированное уведомление не выдаст подписку случайному пользователю. Как
// только впишут БОЕВОЙ ключ (без DEMO) — режим сам выключится, включится для всех.
function isTestMode() {
  const t = terminal();
  return /DEMO/i.test(t.key) || process.env.TBANK_TEST_MODE === 'true';
}

// Token = SHA-256(конкатенация значений корневых скалярных полей + Password,
// отсортированных по имени ключа). Булевы → 'true'/'false'. Объекты/массивы
// (DATA, Receipt, Token) исключаются.
function signToken(params, password) {
  const src = { ...params, Password: password };
  const concat = Object.keys(src)
    .filter((k) => {
      if (k === 'Token') return false;
      const v = src[k];
      return v !== undefined && v !== null && typeof v !== 'object';
    })
    .sort()
    .map((k) => {
      const v = src[k];
      return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    })
    .join('');
  return crypto.createHash('sha256').update(concat).digest('hex');
}

async function callApi(method, body) {
  const r = await fetch(`${API_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Создаёт платёж. amountRub — сумма В РУБЛЯХ (переводим в копейки). Возвращает
// { ok, paymentUrl, paymentId, orderId } или { ok:false, error, details }.
async function initPayment({ amountRub, orderId, description, data, successURL, failURL, notificationURL, recurrent, customerKey }) {
  const t = terminal();
  if (!t.key || !t.password) return { ok: false, error: 'not_configured' };
  const body = {
    TerminalKey: t.key,
    Amount: Math.round(Number(amountRub) * 100),
    OrderId: String(orderId),
    Description: String(description || '').slice(0, 250),
  };
  if (notificationURL) body.NotificationURL = notificationURL;
  if (successURL) body.SuccessURL = successURL;
  if (failURL)    body.FailURL    = failURL;
  // CustomerKey привязывает карту к покупателю — обязателен для рекуррентов.
  if (customerKey) body.CustomerKey = String(customerKey);
  // Recurrent:'Y' помечает РОДИТЕЛЬСКИЙ платёж: после успешной оплаты Т-Касса
  // пришлёт в нотификации RebillId, по которому потом списываем без клиента.
  if (recurrent) body.Recurrent = 'Y';
  if (data && typeof data === 'object') body.DATA = data; // не входит в подпись
  body.Token = signToken(body, t.password);
  let j;
  try {
    j = await callApi('Init', body);
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
  if (j && j.Success && j.PaymentURL) {
    return { ok: true, paymentUrl: j.PaymentURL, paymentId: String(j.PaymentId), orderId: String(orderId) };
  }
  return { ok: false, error: j?.Message || j?.ErrorCode || 'init_failed', details: j?.Details, raw: j };
}

// АВТОСПИСАНИЕ по сохранённой карте (рекуррент). Два шага по схеме Т-Кассы:
//   1) Init — создаём новый платёж (Recurrent тут НЕ шлём: это уже дочернее
//      списание; CustomerKey — тот же, что и у родительского);
//   2) Charge — списываем с привязанной карты по RebillId, без участия клиента.
// Возвращает { ok, paymentId, status, raw } либо { ok:false, error, ... }.
// ВАЖНО: подписку выдаёт НЕ этот метод, а нотификация CONFIRMED в вебхуке —
// так автосписание идёт ровно тем же идемпотентным путём, что и ручная оплата.
async function chargeRecurrent({ amountRub, orderId, description, rebillId, customerKey, notificationURL }) {
  const t = terminal();
  if (!t.key || !t.password) return { ok: false, error: 'not_configured' };
  if (!rebillId) return { ok: false, error: 'no_rebill_id' };

  const init = await initPayment({ amountRub, orderId, description, customerKey, notificationURL });
  if (!init.ok) return { ok: false, error: `init: ${init.error}`, details: init.details, raw: init.raw };

  const body = { TerminalKey: t.key, PaymentId: String(init.paymentId), RebillId: String(rebillId) };
  body.Token = signToken(body, t.password);
  let j;
  try {
    j = await callApi('Charge', body);
  } catch (e) {
    return { ok: false, error: `network: ${e.message}`, paymentId: init.paymentId };
  }
  if (j && j.Success && ['CONFIRMED', 'AUTHORIZED'].includes(j.Status)) {
    return { ok: true, paymentId: String(j.PaymentId || init.paymentId), status: j.Status, raw: j };
  }
  return {
    ok: false,
    error: j?.Message || j?.ErrorCode || 'charge_failed',
    details: j?.Details, status: j?.Status, paymentId: init.paymentId, raw: j,
  };
}

// Проверяет подпись входящего уведомления от Т-Кассы. Возвращает boolean.
function verifyNotification(body, password = terminal().password) {
  if (!body || body.Token == null || !password) return false;
  const expected = signToken(body, password);
  const got = String(body.Token).toLowerCase();
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

// Возврат/отмена платежа через API (/v2/Cancel). Для CONFIRMED — это ВОЗВРАТ
// (полный, если amountKop не задан; частичный — если задан), для AUTHORIZED —
// реверс холда. Делается С НАШЕГО сервера ключом терминала, кабинет не нужен —
// обходит ограничения прав/браузера в ЛК. Возвращает { ok, status, raw }.
async function cancelPayment({ paymentId, amountKop } = {}) {
  const t = terminal();
  if (!t.key || !t.password) return { ok: false, error: 'not_configured' };
  const body = { TerminalKey: t.key, PaymentId: String(paymentId) };
  if (amountKop != null) body.Amount = Math.round(amountKop);
  body.Token = signToken(body, t.password);
  let j;
  try {
    j = await callApi('Cancel', body);
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
  if (j && j.Success) return { ok: true, status: j.Status, originalAmount: j.OriginalAmount, newAmount: j.NewAmount, raw: j };
  return { ok: false, error: j?.Message || j?.ErrorCode || 'cancel_failed', details: j?.Details, raw: j };
}

// Уточнить статус платежа (резерв/сверка). Возвращает ответ GetState.
async function getState(paymentId) {
  const t = terminal();
  if (!t.key || !t.password) return { Success: false, error: 'not_configured' };
  const body = { TerminalKey: t.key, PaymentId: String(paymentId) };
  body.Token = signToken(body, t.password);
  try {
    return await callApi('GetState', body);
  } catch (e) {
    return { Success: false, error: e.message };
  }
}

// ── OrderId для подписок конструктора (≤50 символов — лимит Т-Кассы) ──────────
// Формат: <userId>_<planChar><months>_<b36ts>  (напр. 6512..293a_p12_lт9k2).
// userId — 24-символьный ObjectId (без «_»), planChar+months — без «_»,
// суффикс времени в base36 — без «_». Поэтому split('_') даёт ровно 3 части.
const SLUG_TO_CHAR = { tgletbot: 's', tgpremium: 'p' };
const CHAR_TO_SLUG = { s: 'tgletbot', p: 'tgpremium' };

function encodeSubOrderId(userId, slug, months) {
  const c = SLUG_TO_CHAR[slug] || 's';
  return `${userId}_${c}${months}_${Date.now().toString(36)}`;
}

function decodeSubOrderId(orderId) {
  const parts = String(orderId || '').split('_');
  if (parts.length < 3) return null;
  const userId = parts[0];
  const pm = parts[1] || '';
  const slug = CHAR_TO_SLUG[pm[0]];
  const months = parseInt(pm.slice(1), 10);
  if (!/^[a-f0-9]{24}$/i.test(userId) || !slug || !months) return null;
  return { userId, slug, months };
}

module.exports = {
  API_URL, terminal, isConfigured, isTestMode, signToken,
  initPayment, chargeRecurrent, verifyNotification, getState, cancelPayment,
  encodeSubOrderId, decodeSubOrderId,
  SLUG_TO_CHAR, CHAR_TO_SLUG,
};
