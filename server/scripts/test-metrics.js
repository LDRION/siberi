// Диагностика: печатает метрики /admin в консоль (read-only, ничего не меняет).
// Запуск: node /var/www/siberi/server/scripts/test-metrics.js
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

const { computeAdminMetrics, renderAdminMetrics } = require('../helpers/metrics');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');
  const m = await computeAdminMetrics();
  console.log('=== как увидишь в /admin ===\n');
  console.log(renderAdminMetrics(m).replace(/<[^>]+>/g, ''));
  console.log('\n=== сырые числа ===');
  console.log({
    total: m.total,
    trialActive: m.trialActive,
    trialOver: m.trialOver,
    trialOverActive: m.trialOverActive,
    payingNow: m.payingNow,
    everPaid: m.everPaid,
    botsConnectedFlag: m.botsCount,
    botsWorking: m.botsWorking,
    botsDead: m.botsDead,
    botsUnknown: m.botsUnknown,
  });
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
