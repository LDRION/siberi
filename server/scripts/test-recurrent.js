// Диагностика движка автопродления. Показывает кандидатов и прогоняет один тик.
// БЕЗОПАСНО: списание произойдёт только если у пользователя реально включено
// автопродление, привязана карта (RebillId) И подписка уже закончилась.
// Запуск: node /var/www/siberi/server/scripts/test-recurrent.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s[0] === '#') continue;
  const i = s.indexOf('=');
  if (i < 0) continue;
  let v = s.slice(i + 1).trim();
  if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) v = v.slice(1, -1);
  const k = s.slice(0, i).trim();
  if (process.env[k] === undefined) process.env[k] = v;
}

const User = require('../models/User');
const tbank = require('../helpers/tbank');
const { runSubscriptionTick, renewMonths, MAX_FAILS } = require("../helpers/recurrent");

const AI_PLANS = ['tgletbot', 'tgpremium'];

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');
  console.log('Т-Касса настроена:', tbank.isConfigured(), '| тест-режим (DEMO):', tbank.isTestMode());

  const [withAuto, withCard, ready] = await Promise.all([
    User.countDocuments({ autoRenew: true }),
    User.countDocuments({ tbankRebillId: { $ne: null } }),
    User.countDocuments({
      autoRenew: true, tbankRebillId: { $ne: null }, plan: { $in: AI_PLANS },
      subscriptionEnd: { $ne: null }, autoRenewFailCount: { $lt: MAX_FAILS },
    }),
  ]);
  console.log('\nВключено автопродление:', withAuto);
  console.log('Привязана карта (RebillId):', withCard);
  console.log('Кандидатов для движка:', ready);

  const cands = await User.find({
    autoRenew: true, tbankRebillId: { $ne: null }, plan: { $in: AI_PLANS },
  }).select('telegramId plan subscriptionEnd autoRenewFailCount paymentHistory').lean();
  for (const u of cands) {
    const end = u.subscriptionEnd ? new Date(u.subscriptionEnd) : null;
    const left = end ? Math.round((end - Date.now()) / 3600e3) : null;
    console.log(`  tg=${u.telegramId} plan=${u.plan} до=${end ? end.toISOString() : '—'}`
      + ` (осталось ${left} ч) продлим на ${renewMonths(u)} мес, неудач: ${u.autoRenewFailCount || 0}`);
  }

  console.log('\nПрогоняю один тик…');
  await runSubscriptionTick();
  console.log('Тик отработал без ошибок ✅');

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
