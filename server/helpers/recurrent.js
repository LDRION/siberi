// ── Подписка AiConstructor: уведомления о конце + автопродление ──────────────
//
// Уведомления (всем, у кого платная подписка, независимо от автопродления):
//  • за 7 дней  • за сутки  • в момент окончания
// Текст зависит от того, включено ли автопродление: одним — когда и сколько
// спишем с карты + кнопка отключения, другим — предложение его подключить.
//
// Автопродление (только для тех, кто включил его сам):
//  1) Пользователь САМ включил автопродление (Оферта п. 8.1) → его платёж уходит
//     с Recurrent:'Y' + CustomerKey (routes/tgletbot.js createPaymentUrl).
//  2) Т-Касса привязывает карту и присылает RebillId в нотификации родительского
//     платежа → сохраняем в user.tbankRebillId (routes/payment.js webhook).
//  3) Когда подписка закончилась — списываем через Charge по RebillId.
//
// ВАЖНО: подписку продлевает НЕ этот модуль, а нотификация CONFIRMED в вебхуке —
// тем же идемпотентным путём (grantSubscription по paymentId), что и ручная
// оплата. Здесь только инициируем списание и ведём диагностику.
const tbank = require('./tbank');

const AI_PLANS = ['tgletbot', 'tgpremium'];
const MAX_FAILS = 3;                 // после 3 неудач подряд перестаём дёргать карту
const COOLDOWN_MS = 30 * 60 * 1000;  // пауза между попытками: ждём нотификацию, не списываем дважды
const BATCH = 200;

const WEEK_LEAD_MS = 7 * 24 * 3600e3;
// 25 часов, а не 24: Оферта п. 8.3 требует предупредить «не позднее чем за 24
// часа» до списания, а тик планировщика дискретен (раз в 10 минут). Порог ровно
// в 24 ч сработал бы уже ПОСЛЕ этой границы (23 ч 5x мин) и нарушал бы оферту —
// час запаса гарантирует, что предупреждение уходит заранее.
const DAY_LEAD_MS = 25 * 3600e3;
// «Подписка закончилась» шлём только если она истекла недавно. Иначе после
// долгого простоя сервера (или при первом запуске этого кода) сообщение улетело
// бы всем, у кого подписка кончилась хоть когда-нибудь.
const ENDED_WINDOW_MS = 48 * 3600e3;

let _ticking = false; // защита от наложения тиков (setInterval не ждёт прошлый)

const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

// На сколько месяцев продлевать — ровно на тот же срок, что человек оплачивал
// в прошлый раз (в истории хранится durationDays).
function renewMonths(user) {
  const last = (user.paymentHistory || [])
    .filter((p) => AI_PLANS.includes(p.plan) && Number(p.amount) > 0 && !p.refunded)
    .sort((a, b) => new Date(b.paidAt || b.activatedAt || 0) - new Date(a.paidAt || a.activatedAt || 0))[0];
  const days = Number(last?.durationDays) || 30;
  const m = Math.round(days / 30);
  return [1, 6, 12].includes(m) ? m : 1;
}

// Спишем ли мы реально с карты, когда подписка кончится. Только при ЭТОМ условии
// можно обещать автосписание: автопродление можно включить тумблером в ЛК и без
// привязанной карты (она привязывается при первой оплате) — обещать списание
// такому пользователю значит соврать, бот просто встанет.
const canCharge = (u) => Boolean(
  u.autoRenew && u.tbankRebillId && (u.autoRenewFailCount || 0) < MAX_FAILS && tbank.isConfigured(),
);

async function tgSend(user, text, keyboard) {
  if (!user.telegramId) return;
  try {
    const { sendTgMessage } = require('../routes/tgletbot'); // lazy — избегаем циклов
    await sendTgMessage(user.telegramId, text, keyboard ? { keyboard } : {});
  } catch (e) {
    console.warn('recurrent: не смогли отправить сообщение', String(user._id), e.message);
  }
}

// ── Уведомления о конце подписки ─────────────────────────────────────────────

// Отметки о том, что уже отправлено. Привязаны к конкретному subscriptionEnd:
// как только подписку продлили, дата меняется и цикл начинается заново.
function notifyState(user, end) {
  const st = user.subEndNotify;
  if (!st || !st.for || new Date(st.for).getTime() !== end.getTime()) {
    user.subEndNotify = { for: end, week: false, day: false, ended: false };
  }
  return user.subEndNotify;
}

const STAGE_HEAD = {
  week: (left) => `⏳ <b>Подписка заканчивается через ${left} дн.</b>`,
  day:  () => '⚠️ <b>Подписка заканчивается завтра</b>',
  ended: () => '🔴 <b>Подписка закончилась</b>',
};

// Собираем сообщение: шапка по этапу + факты + блок про автопродление.
function buildNotice(user, stage, end, months) {
  const tg = require('../routes/tgletbot');
  const planKey = tg.tglbPlanKey(user.plan);
  const amount = tg.tglbPlanTotal(planKey, months);
  const name = tg.TGLB_PLANS[planKey]?.name || 'Standard';
  const left = Math.max(1, Math.ceil((end - Date.now()) / 86400e3));
  const willCharge = canCharge(user);
  const miniapp = process.env.TGLETBOT_MINIAPP_URL || '';

  const lines = [STAGE_HEAD[stage](left), '', `Тариф: <b>${name}</b>`];
  lines.push(stage === 'ended'
    ? `Действовала до: <b>${fmtDate(end)}</b>`
    : `Действует до: <b>${fmtDate(end)}</b>`);

  if (stage === 'ended') lines.push('', '⛔️ Ваш бот приостановлен — он не отвечает пользователям, пока подписка не продлена.');

  const keyboard = [];
  if (willCharge) {
    // Оферта п. 8.3 + Политика рекуррентных платежей п. 3.4: заранее называем
    // сумму, дату и тариф и даём отключить в один тап.
    lines.push('', `✅ У вас включено автопродление — <b>${money(amount)}</b> спишутся с привязанной карты <b>${fmtDate(end)}</b>`
      + `${months > 1 ? ` (период ${months} мес)` : ''}, бот продолжит работать без пауз.`,
      'При необходимости вы можете отключить его в настройках.');
    keyboard.push([{ text: '❌ Отключить автопродление', data: 'autoren:off' }]);
  } else if (user.autoRenew) {
    // Тумблер включён, но списывать не с чего — честно говорим об этом.
    lines.push('', 'ℹ️ Автопродление включено, но карта ещё не привязана — она привяжется при первой оплате.',
      'Пока продлите вручную, иначе бот остановится.');
  } else {
    lines.push('', stage === 'ended' ? 'Продлите подписку — бот заработает сразу после оплаты.' : 'Продлите подписку, чтобы бот продолжал работать без пауз.',
      '', '💡 Боитесь пропустить платёж? Подключите автопродление в настройках! Отключить его можно в любой момент.');
  }

  if (miniapp) keyboard.push([{ text: willCharge ? '📱 Открыть приложение' : '💳 Продлить подписку', webApp: miniapp }]);
  return { text: lines.join('\n'), keyboard: keyboard.length ? keyboard : null };
}

async function sendNotice(user, stage, end, months) {
  const { text, keyboard } = buildNotice(user, stage, end, months);
  await tgSend(user, text, keyboard);
  const st = notifyState(user, end);
  st[stage] = true;
  user.markModified('subEndNotify');
  await user.save().catch(() => {});
  console.log(`🔔 Уведомление о подписке [${stage}]: ${user._id} (до ${fmtDate(end)}, auto=${canCharge(user) ? 'ON' : 'off'})`);
}

// Какой этап пора отправить (и не отправляли ли уже). null — ничего не нужно.
function dueStage(user, end, now) {
  const st = notifyState(user, end);
  const left = end - now;

  if (left <= 0) {
    // Тем, у кого сейчас пройдёт автосписание, «бот остановлен» слать нельзя:
    // движок ниже спишет деньги, а об успехе сообщит чек из вебхука.
    if (canCharge(user)) return null;
    return (!st.ended && left > -ENDED_WINDOW_MS) ? 'ended' : null;
  }
  if (left <= DAY_LEAD_MS) return st.day ? null : 'day';
  if (left <= WEEK_LEAD_MS) return st.week ? null : 'week';
  return null;
}

// Списание. Возвращает true при успешном Charge (подписку выдаст вебхук).
async function chargeOne(user, months) {
  const tg = require('../routes/tgletbot');
  const planKey = tg.tglbPlanKey(user.plan);
  const plan = tg.TGLB_PLANS[planKey];
  const amount = tg.tglbPlanTotal(planKey, months);
  const serverUrl = process.env.SERVER_URL || '';

  // Ставим метку ДО списания: если процесс упадёт посередине, повторной попытки
  // на следующем тике не будет — деньги дважды не спишем.
  user.autoRenewLastTryAt = new Date();
  await user.save().catch(() => {});

  const r = await tbank.chargeRecurrent({
    amountRub: amount,
    orderId: tbank.encodeSubOrderId(String(user._id), plan.slug, months),
    description: `AI Constructor Bot — ${plan.name}, ${months} мес (автопродление)`,
    rebillId: user.tbankRebillId,
    customerKey: user.tbankCustomerKey || String(user._id),
    notificationURL: serverUrl ? `${serverUrl}/api/v1/payment/tbank/webhook` : undefined,
  });

  if (r.ok) {
    user.autoRenewFailCount = 0;
    user.autoRenewLastError = null;
    await user.save().catch(() => {});
    console.log(`🔁 Автосписание OK: ${user._id} ${plan.name} ${months}мес ${money(amount)} (payment ${r.paymentId})`);
    return true;
  }

  user.autoRenewFailCount = (user.autoRenewFailCount || 0) + 1;
  user.autoRenewLastError = String(r.error || 'unknown').slice(0, 200);
  await user.save().catch(() => {});
  console.warn(`⚠️ Автосписание не прошло (${user.autoRenewFailCount}/${MAX_FAILS}): ${user._id} — ${r.error}`);

  const last = user.autoRenewFailCount >= MAX_FAILS;
  await tgSend(user,
    '⚠️ <b>Не удалось продлить подписку</b>\n\n'
    + `Не получилось списать ${money(amount)} с привязанной карты.\n`
    + (last
      ? 'Больше пытаться не будем — продлите вручную в разделе «Аккаунт», чтобы бот продолжил работать.'
      : `Попробуем ещё раз позже (попытка ${user.autoRenewFailCount} из ${MAX_FAILS}). Можно продлить вручную в разделе «Аккаунт».`));
  return false;
}

// Один проход планировщика.
async function runSubscriptionTick() {
  if (_ticking) return;
  _ticking = true;
  try {
    const User = require('../models/User');
    const now = new Date();

    // Берём ВСЕХ с платной подпиской AiConstructor: уведомления нужны и тем, у
    // кого автопродление выключено (им как раз и предлагаем его подключить).
    const users = await User.find({
      plan: { $in: AI_PLANS },
      subscriptionEnd: { $ne: null },
      telegramId: { $ne: null },
    }).limit(BATCH);

    for (const u of users) {
      try {
        if (typeof u.isBlocked === 'function' && u.isBlocked()) continue;
        const end = new Date(u.subscriptionEnd);
        if (isNaN(end)) continue;
        const months = renewMonths(u);

        const stage = dueStage(u, end, now);
        if (stage) await sendNotice(u, stage, end, months);

        // Списываем только с тех, кто сам включил автопродление и привязал карту.
        if (end <= now && canCharge(u)) {
          // Пауза между попытками: ждём нотификацию от прошлой (иначе спишем дважды).
          if (u.autoRenewLastTryAt && now - new Date(u.autoRenewLastTryAt) < COOLDOWN_MS) continue;
          await chargeOne(u, months);
        }
      } catch (e) {
        console.error('subscription: ошибка по пользователю', String(u._id), e.message);
      }
    }
  } catch (e) {
    console.error('subscription tick error:', e.message);
  } finally {
    _ticking = false;
  }
}

module.exports = {
  runSubscriptionTick, renewMonths, canCharge, buildNotice, dueStage,
  MAX_FAILS, WEEK_LEAD_MS, DAY_LEAD_MS, ENDED_WINDOW_MS,
};
