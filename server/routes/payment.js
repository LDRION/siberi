'use strict';
const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();

const authenticateOnly = require('../middleware/authenticateOnly');
const User = require('../models/User');
const tbank = require('../helpers/tbank');

const PLAN_PRICES      = { pro: 999, family: 2999, standard: 2500, premium: 10000, tgletbot: 1000, tgpremium: 2000 };
const PAYMENT_TYPE_MAP = { card: 'AC', sberpay: 'SB', yoomoney: 'PC' };

// ── Активация подписки после ПОДТВЕРЖДЁННОЙ оплаты — общая для всех провайдеров
// (ЮMoney / Т-Касса). Идемпотентна по paymentId: повторное уведомление о том же
// платеже НЕ двоит подписку и выручку. Делает: продление подписки, уведомление
// админов (тарифы конструктора), уведомление клиента в Telegram, реферальную
// комиссию 20%. Раньше эта логика жила прямо в YooMoney-вебхуке — вынесена, чтобы
// Т-Касса переиспользовала её 1-в-1. ────────────────────────────────────────────
async function grantSubscription({ userId, plan, months, amount, provider, paymentId, currency = 'RUB', label = '', paidAt = null }) {
  const durationDays = (Number(months) || 1) * 30;
  const user = await User.findById(userId).catch(() => null);
  if (!user) { console.warn('⚠️ grantSubscription: пользователь не найден', userId); return; }

  // Идемпотентность — этот платёж уже проведён?
  if (paymentId && (user.paymentHistory || []).some((p) => p.paymentId === String(paymentId))) {
    console.log(`↩️ Платёж ${paymentId} уже обработан — пропускаем`);
    return;
  }

  const planEnum = ['pro', 'family', 'standard', 'premium', 'tgletbot', 'tgpremium'].includes(plan) ? plan : 'pro';
  const wasActive = user.subscriptionStatus === 'active' && user.subscriptionEnd && user.subscriptionEnd > new Date();
  user.activateSubscription({
    provider, paymentId, plan: planEnum, durationDays,
    amount, currency, label, paidAt: paidAt || new Date().toISOString(),
  });
  await user.save();
  console.log(`✅ Подписка активирована: ${userId} (${plan} ${months}мес, ${amount}₽, ${provider})`);

  // Уведомляем платформенных админов (нас) — ТОЛЬКО о тарифах AiConstructor.
  if (['tgletbot', 'tgpremium'].includes(plan)) {
    try {
      const { notifyAdminsOfSubscription } = require('../helpers/metrics');
      await notifyAdminsOfSubscription(user, { plan, amount, months, kind: wasActive ? 'renewal' : 'new' });
    } catch (e) { console.warn('⚠️ subscription notify:', e.message); }
  }

  // Клиент узнаёт об оплате сразу в чате бота-конструктора.
  if (user.telegramId && process.env.TGLETBOT_TOKEN) {
    fetch(`https://api.telegram.org/bot${process.env.TGLETBOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegramId, text: '✅ Оплата получена! Подписка активна — можно продолжать.' }),
    }).catch(() => {});
  }

  // Реферальная комиссия 20% партнёру, приведшему пользователя.
  if (user.referredBy) {
    try {
      const UserAffiliate = require('../models/UserAffiliate');
      const referrer = await UserAffiliate.findOne({ referralCode: user.referredBy });
      if (referrer) {
        const commission = Math.round(amount * 0.20);
        if (commission > 0) {
          referrer.balance     += commission;
          referrer.totalEarned += commission;
          const refRecord = referrer.referrals.find((r) => r.userId.toString() === user._id.toString());
          if (refRecord) {
            refRecord.totalPaid += amount;
            refRecord.earned    += commission;
            if (!refRecord.firstPaymentDone) {
              refRecord.firstPaymentDone = true;
              const referrerUser = await User.findById(referrer.userId);
              if (referrerUser) {
                const PLAN_LEVEL = { standard: 1, pro: 2, premium: 3 };
                const bonusDays    = 30;
                const referralPlan = user.plan || 'standard';
                const partnerPlan  = referrerUser.plan || 'standard';
                const now          = new Date();
                const partnerHasActive = referrerUser.subscriptionStatus === 'active' && referrerUser.subscriptionEnd > now;
                if (partnerHasActive && PLAN_LEVEL[referralPlan] < PLAN_LEVEL[partnerPlan]) {
                  const existingLevel = PLAN_LEVEL[referrerUser.pendingBonus?.plan] || 0;
                  if (PLAN_LEVEL[referralPlan] > existingLevel) {
                    referrerUser.pendingBonus = { plan: referralPlan, days: bonusDays, grantedAt: now };
                  }
                } else {
                  const newPlan = (PLAN_LEVEL[referralPlan] || 1) >= (PLAN_LEVEL[partnerPlan] || 1) ? referralPlan : partnerPlan;
                  const base = partnerHasActive ? referrerUser.subscriptionEnd : now;
                  referrerUser.plan = newPlan;
                  referrerUser.subscriptionStatus = 'active';
                  referrerUser.subscriptionEnd = new Date(base.getTime() + bonusDays * 86400000);
                }
                await referrerUser.save();
              }
            }
          }
          referrer.notifications.push({ type: 'payment', joinedAt: refRecord?.joinedAt || new Date(), amount: commission, plan: user.plan });
          await referrer.save();
          console.log(`💰 Комиссия ${commission}₽ → партнёр ${user.referredBy}`);
        }
      }
    } catch (e) { console.warn('Affiliate commission error:', e.message); }
  }
}

// Отзыв доступа при возврате/реверсе платежа. Находит платёж в истории по
// paymentId, откатывает продление подписки на выданный им срок и помечает
// запись refunded. Идемпотентно: повторное уведомление о возврате того же
// платежа ничего не делает (защита от ретраев банка). Работает для любого
// провайдера (по paymentId).
async function revokeSubscription({ paymentId, reason = 'REFUNDED' }) {
  if (!paymentId) return;
  const user = await User.findOne({ 'paymentHistory.paymentId': String(paymentId) }).catch(() => null);
  if (!user) { console.warn('⚠️ revokeSubscription: платёж не найден в истории', paymentId); return; }
  const entry = (user.paymentHistory || []).find((p) => p.paymentId === String(paymentId));
  if (!entry) return;
  if (entry.refunded) { console.log(`↩️ Возврат ${paymentId} уже обработан — пропускаем`); return; }

  entry.refunded = true;
  entry.refundedAt = new Date();

  // Откатываем срок, который дал этот платёж. Если после отката подписка
  // «истекла» — переводим в expired (боты остановятся до новой оплаты).
  const days = Number(entry.durationDays) || 0;
  if (user.subscriptionEnd && days > 0) {
    const rolled = new Date(new Date(user.subscriptionEnd).getTime() - days * 86400000);
    user.subscriptionEnd = rolled;
    if (rolled.getTime() <= Date.now()) user.subscriptionStatus = 'expired';
  }
  await user.save();
  console.log(`↩️ Доступ отозван (${reason}): user=${user._id} payment=${paymentId} −${days}дн → ${user.subscriptionStatus}, до ${user.subscriptionEnd?.toISOString?.() || '—'}`);
}

// ── Откликс (hhpilot) использует ТОТ ЖЕ кошелёк ЮMoney — отдельного у продукта пока
// нет, а ЮMoney шлёт HTTP-уведомление ТОЛЬКО на один URL, настроенный в кабинете
// кошелька (этот, siberi). Платежи Откликс распознаём по label (<tenantId>_weekly|
// monthly_<ts> — таких planов у Siberi нет и не будет) и форвардим тело нотификации
// как есть на core-api Откликс: он сам перепроверит подпись тем же секретом (кошелёк
// общий → секрет тоже общий) и активирует подписку своего Tenant. OTKLIKS_CORE_API_URL
// пуст, пока Откликс не задеплоен публично, — тогда просто предупреждаем в лог и не
// роняем остальную обработку вебхука.
async function forwardToOtkliks(rawBody) {
  const url = process.env.OTKLIKS_CORE_API_URL;
  if (!url) {
    console.warn('⚠️ Платёж Откликс получен, но OTKLIKS_CORE_API_URL не задан — переслать некуда');
    return;
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/payment/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody,
      // Без таймаута зависший core-api держал бы соединение с ЮMoney до её
      // собственного обрыва, и мы бы даже не узнали, что доставка не удалась.
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`core-api ответил ${res.status}`);
    console.log('➡️ Платёж Откликс переслан в core-api');
    return true;
  } catch (e) {
    console.error('⚠️ Форвард платежа Откликс в core-api не удался:', e.message);
    alertPaymentForwardFailed(rawBody, e.message);
    return false;
  }
}

// Деньги списаны, а подписка не включилась — худший исход из возможных, и узнавать
// о нём от клиента нельзя. Fire-and-forget: алерт не должен ни ронять обработчик,
// ни задерживать ответ ЮMoney.
function alertPaymentForwardFailed(rawBody, reason) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_ALERT_CHAT_ID;
  if (!token || !chatId) return;
  let label = '—';
  try { label = new URLSearchParams(rawBody).get('label') || '—'; } catch { /* не критично */ }
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `💸 Оплата Откликс не доставлена!\n\nМетка: ${label}\nПричина: ${reason}\n\nДеньги списаны, подписка НЕ включена. ЮMoney получила не-200 и повторит уведомление, но лучше проверить руками.`,
    }),
  }).catch(() => {});
}

// POST /api/v1/payment/create
router.post('/payment/create', authenticateOnly, async (req, res) => {
  try {
    const { plan = 'standard', months = 1, paymentMethod = 'card' } = req.body;
    if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Неверный тариф' });
    const validMonths = [1, 3, 12].includes(Number(months)) ? Number(months) : 1;
    const discount    = validMonths === 3 ? 0.10 : validMonths === 12 ? 0.20 : 0;
    const amount      = Math.round(PLAN_PRICES[plan] * validMonths * (1 - discount));

    const yoomoneyWallet = process.env.YOOMONEY_WALLET;
    if (!yoomoneyWallet) return res.status(503).json({ error: 'Оплата временно недоступна. Обратитесь к поддержке.' });

    const label       = `${req.user._id}_${plan}_${validMonths}m_${Date.now()}`;
    const paymentType = PAYMENT_TYPE_MAP[paymentMethod] || 'AC';
    const paymentUrl  = `https://yoomoney.ru/quickpay/confirm?receiver=${yoomoneyWallet}&quickpay-form=shop&targets=Siberi AI+${plan}+${validMonths}mo&paymentType=${paymentType}&sum=${amount}&label=${label}`;

    res.json({ success: true, paymentUrl, plan, months: validMonths, amount, message: 'Перейдите по ссылке для оплаты' });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(500).json({ error: 'Payment creation failed' });
  }
});

// POST /api/v1/payment/webhook — YooMoney HTTP-notification
router.post('/payment/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const body = req.body;
    const webhookSecret = process.env.YOOMONEY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('❌ YOOMONEY_WEBHOOK_SECRET not set');
      return res.status(500).send('Payment service misconfigured');
    }
    // Проверка подписи — устойчиво к ОБЕИМ схемам провайдера. Кошелёк ЮMoney
    // (quickpay-form=shop) шлёт `sha1_hash` = SHA-1 от строго заданной строки;
    // часть интеграций/ЮKassa — HMAC-SHA256 `sign` по всем параметрам. Принимаем
    // платёж, если ВЕРНА ЛЮБАЯ подпись (обе требуют секрет — подделать нельзя,
    // безопасность та же). Раньше проверялся только `sign` — если ЮMoney слал
    // sha1_hash, реальные оплаты молча отваливались на 401.
    let verified = false;
    let usedScheme = null;

    if (body.sha1_hash) {
      const s = [
        body.notification_type, body.operation_id, body.amount, body.currency,
        body.datetime, body.sender, body.codepro, webhookSecret, body.label,
      ].join('&');
      if (crypto.createHash('sha1').update(s).digest('hex') === body.sha1_hash) { verified = true; usedScheme = 'sha1_hash'; }
    }
    if (!verified && body.sign) {
      const { sign: _omit, ...paramsForSign } = body;
      const signString = Object.keys(paramsForSign).sort()
        .map(k => `${k}=${encodeURIComponent(paramsForSign[k] ?? '')}`)
        .join('&');
      if (crypto.createHmac('sha256', webhookSecret).update(signString).digest('hex') === body.sign) { verified = true; usedScheme = 'sign'; }
    }
    if (!verified) {
      console.warn('⚠️ YooMoney webhook: подпись не прошла', { hasSha1: !!body.sha1_hash, hasSign: !!body.sign, notif: body.notification_type });
      return res.status(401).send('Invalid signature');
    }
    console.log(`✅ YooMoney webhook: подпись ок (${usedScheme})`);

    if (body.notification_type !== 'p2p-incoming' && body.notification_type !== 'card-incoming') {
      return res.status(200).send('OK');
    }

    const label = body.label || '';
    const [userId, plan, monthsRaw] = label.split('_');
    if (!userId || !plan) { console.warn('⚠️ YooMoney webhook: missing label', label); return res.status(200).send('OK'); }

    // ── Платёж Откликс (hhpilot) — см. forwardToOtkliks выше. Выходим ДО обращения к
    // Siberi User (userId здесь — Tenant _id из другой базы, не наш пользователь). ──
    if (plan === 'weekly' || plan === 'monthly') {
      const delivered = await forwardToOtkliks(new URLSearchParams(body).toString());
      // Не-200 в ответ ЮMoney — она повторит уведомление. Осознанно: молча ответить
      // «ОК» на недоставленный платёж значит потерять его навсегда. Исключение —
      // незаданный OTKLIKS_CORE_API_URL: повтор не поможет, слать всё равно некуда.
      if (!delivered && process.env.OTKLIKS_CORE_API_URL) return res.status(502).send('Forward failed');
      return res.status(200).send('OK');
    }

    const months      = parseInt(monthsRaw) || 1;
    const durationDays = months * 30;

    // ── Покупка макета в маркетплейсе: label = <buyerId>_tpl_<templateId>_<ts> ──
    if (plan === 'tpl') {
      try {
        const BotTemplate = require('../models/BotTemplate');
        const { grantTemplatePurchase } = require('../helpers/marketplace');
        const templateId = monthsRaw; // третий сегмент — id макета
        const tpl = await BotTemplate.findById(templateId).catch(() => null);
        const buyer = await User.findById(userId).catch(() => null);
        if (tpl && buyer) {
          await grantTemplatePurchase(buyer._id, tpl, parseFloat(body.amount || 0), body.operation_id);
          console.log(`🧩 Макет ${tpl.code} куплен пользователем ${userId} (${body.amount}₽), автору 70%`);
          if (buyer.telegramId && process.env.TGLETBOT_TOKEN) {
            fetch(`https://api.telegram.org/bot${process.env.TGLETBOT_TOKEN}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: buyer.telegramId, text: `✅ Макет «${tpl.title}» куплен! Открой приложение → Бот → Магазин макетов, чтобы применить его.` }),
            }).catch(() => {});
          }
        } else {
          console.warn('⚠️ template purchase: template/buyer not found', label);
        }
      } catch (e) { console.error('template purchase webhook error:', e.message); }
      return res.status(200).send('OK');
    }

    await grantSubscription({
      userId, plan, months,
      amount: parseFloat(body.amount || 0),
      provider: 'yoomoney', paymentId: body.operation_id,
      currency: body.currency || 'RUB', label,
      paidAt: body.datetime || new Date().toISOString(),
    });
    res.status(200).send('OK');
  } catch (err) {
    console.error('Payment webhook error:', err);
    res.status(500).send('Error');
  }
});

// POST /api/v1/payment/tbank/webhook — уведомление от Т-Кассы (JSON).
// Т-Касса шлёт server-to-server при смене статуса платежа и РЕТРАИТ, пока не
// получит ответ 'OK'. Проверяем подпись (Token) паролем терминала, затем на
// статусе CONFIRMED (одностадийная оплата — деньги списаны) активируем подписку.
router.post('/payment/tbank/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    if (!tbank.verifyNotification(body)) {
      console.warn('⚠️ T-Bank webhook: подпись не прошла', { status: body.Status, order: body.OrderId });
      return res.status(403).send('Invalid token');
    }
    // Отвечаем сразу — иначе Т-Касса будет слать повтор (обработка идемпотентна).
    res.status(200).send('OK');

    console.log(`💳 T-Bank notify: Status=${body.Status} OrderId=${body.OrderId} PaymentId=${body.PaymentId} Amount=${body.Amount}`);

    // Возврат/реверс: отзываем доступ, выданный этим платежом (иначе «дырявая
    // касса» — вернули деньги, а подписка осталась). Идемпотентно по paymentId.
    if (['REFUNDED', 'REVERSED'].includes(body.Status)) {
      await revokeSubscription({ paymentId: String(body.PaymentId || ''), reason: body.Status });
      return;
    }
    if (body.Status !== 'CONFIRMED') return; // ждём только успешное списание
    const dec = tbank.decodeSubOrderId(body.OrderId);
    if (!dec) { console.warn('⚠️ T-Bank webhook: OrderId не распознан', body.OrderId); return; }

    // Тест-режим (ДЕМО-терминал): на ДЕМО деньги не двигаются, а его пароль не
    // строгий секрет — поэтому подписку выдаём ТОЛЬКО платформенным админам, чтобы
    // форс-уведомление не подарило доступ случайному пользователю. На боевом
    // терминале (без DEMO) этот гейт снят — выдаём всем как обычно.
    if (tbank.isTestMode()) {
      const { isPlatformAdminUser } = require('../helpers/metrics');
      const u = await User.findById(dec.userId).select('telegramId telegramUsername').lean().catch(() => null);
      if (!u || !isPlatformAdminUser(u)) {
        console.warn('⚠️ T-Bank webhook: тест-режим — не-админ, подписку НЕ выдаём', dec.userId);
        return;
      }
    }

    // Рекуррент: в нотификации РОДИТЕЛЬСКОГО платежа (Init был с Recurrent:'Y')
    // приходит RebillId — это привязка карты. Сохраняем, чтобы потом списывать
    // автопродление без участия клиента. Обновляем атомарно, до grantSubscription.
    if (body.RebillId) {
      await User.updateOne(
        { _id: dec.userId },
        { $set: {
          tbankRebillId: String(body.RebillId),
          tbankCustomerKey: String(dec.userId),
          autoRenewFailCount: 0,
          autoRenewLastError: null,
        } },
      ).catch((e) => console.warn('⚠️ T-Bank webhook: RebillId не сохранён:', e.message));
      console.log(`🔁 RebillId сохранён (автопродление возможно): ${dec.userId}`);
    }

    const amountRub = Math.round((Number(body.Amount) || 0) / 100); // копейки → рубли
    await grantSubscription({
      userId: dec.userId, plan: dec.slug, months: dec.months, amount: amountRub,
      provider: 'tbank', paymentId: String(body.PaymentId || ''),
      currency: 'RUB', label: String(body.OrderId || ''), paidAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('T-Bank webhook error:', err.message);
    // Ответ уже отправлен (200 OK) — Т-Касса не будет ретраить; ошибка залогирована.
  }
});

module.exports = router;
