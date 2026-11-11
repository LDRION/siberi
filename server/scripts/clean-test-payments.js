// Разовая очистка ТЕСТОВЫХ платежей конструктора (наши прогоны Т-Кассы 13.07.2026).
//
// Запуск:  node /var/www/siberi/server/scripts/clean-test-payments.js
//
// Безопасность:
//  • удаляет только планы конструктора (tgletbot/tgpremium) с amount > 0
//    и paidAt СТРОГО раньше CUTOFF — любой реальный платёж после 14.07.2026 не тронется;
//  • перед удалением делает бэкап в JSON (путь печатается в консоль);
//  • подписки не трогает (доступ пользователей не меняется).
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// .env без зависимости от dotenv
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
const AI_PLANS = ['tgletbot', 'tgpremium'];
const CUTOFF = new Date('2026-07-14T00:00:00.000Z');
const BACKUP = path.join(__dirname, '..', 'test-payments-backup-2026-07-13.json');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');

  const match = {
    paymentHistory: { $elemMatch: { plan: { $in: AI_PLANS }, amount: { $gt: 0 }, paidAt: { $lt: CUTOFF } } },
  };

  // 1) Бэкап
  const before = await User.find(match).select('telegramId username paymentHistory').lean();
  fs.writeFileSync(BACKUP, JSON.stringify(before, null, 2), 'utf8');
  const cnt = before.reduce(
    (a, u) => a + (u.paymentHistory || []).filter(
      (p) => AI_PLANS.includes(p.plan) && p.amount > 0 && new Date(p.paidAt) < CUTOFF).length, 0);
  console.log(`Бэкап: ${before.length} пользовател(я), ${cnt} тестовых платеж(ей) -> ${BACKUP}`);

  // 2) Удаление
  const res = await User.updateMany(match, {
    $pull: { paymentHistory: { plan: { $in: AI_PLANS }, amount: { $gt: 0 }, paidAt: { $lt: CUTOFF } } },
  });
  console.log(`Обновлено пользователей: ${res.modifiedCount}`);

  // 3) Проверка — что теперь покажет /admin
  const agg = await User.aggregate([
    { $match: { 'paymentHistory.plan': { $in: AI_PLANS }, 'paymentHistory.amount': { $gt: 0 } } },
    { $unwind: '$paymentHistory' },
    { $match: { 'paymentHistory.plan': { $in: AI_PLANS }, 'paymentHistory.amount': { $gt: 0 } } },
    { $group: { _id: null, sum: { $sum: '$paymentHistory.amount' }, n: { $sum: 1 } } },
  ]);
  const everPaid = await User.countDocuments({
    paymentHistory: { $elemMatch: { plan: { $in: AI_PLANS }, amount: { $gt: 0 } } },
  });
  console.log('\nПОСЛЕ ОЧИСТКИ (это увидишь в /admin):');
  console.log(`  Выручка всего: ${agg[0]?.sum || 0}₽ (${agg[0]?.n || 0} платежей)`);
  console.log(`  Платили когда-либо: ${everPaid}`);

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
