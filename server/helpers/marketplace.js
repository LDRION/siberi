'use strict';
// Маркетплейс макетов: начисление покупки и выплата автору.
// Комиссия платформы — 30% (автору 70%). Выплата автору идёт на его
// партнёрский баланс (UserAffiliate) — вывод существующим механизмом.
const BotTemplate = require('../models/BotTemplate');
const BotTemplatePurchase = require('../models/BotTemplatePurchase');
const UserAffiliate = require('../models/UserAffiliate');

const PLATFORM_COMMISSION = 0.30;

function genAffiliateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Идемпотентно фиксирует покупку макета и начисляет автору 70%.
// paymentId (operation_id провайдера) защищает от повторной обработки вебхука.
async function grantTemplatePurchase(buyerId, template, amount = 0, paymentId = null) {
  if (paymentId) {
    const existing = await BotTemplatePurchase.findOne({ paymentId }).lean();
    if (existing) return existing; // уже обработано
  }
  const authorPayout = Math.round((amount || 0) * (1 - PLATFORM_COMMISSION));
  const purchase = await BotTemplatePurchase.create({
    templateId: template._id,
    code: template.code,
    buyerId,
    authorId: template.authorId,
    amount: amount || 0,
    authorPayout,
    paymentId: paymentId || undefined,
  });
  await BotTemplate.updateOne({ _id: template._id }, { $inc: { sales: 1 } });

  if (authorPayout > 0 && template.authorId && String(template.authorId) !== String(buyerId)) {
    let aff = await UserAffiliate.findOne({ userId: template.authorId });
    if (!aff) {
      let code; let attempts = 0;
      do { code = genAffiliateCode(); attempts++; } while (attempts < 10 && await UserAffiliate.findOne({ referralCode: code }));
      aff = new UserAffiliate({ userId: template.authorId, referralCode: code });
    }
    aff.balance += authorPayout;
    aff.totalEarned += authorPayout;
    aff.notifications.push({ type: 'payment', joinedAt: new Date(), amount: authorPayout, plan: 'template' });
    await aff.save();
  }
  return purchase;
}

module.exports = { grantTemplatePurchase, PLATFORM_COMMISSION };
