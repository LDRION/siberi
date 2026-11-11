// Проверка списка новых пользователей для /admin. Только чтение.
// Запуск: node /var/www/siberi/server/scripts/test-newusers.js
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

const { newUsers, renderNewUsers, newUsersKeyboard } = require('../helpers/metrics');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');
  for (const days of [7, 30]) {
    const list = await newUsers(days, 15);
    console.log(`\n===== ${days} дней =====`);
    console.log(renderNewUsers(list, days).replace(/<[^>]+>/g, ''));
    if (days === 7) console.log('\nкнопок в клавиатуре:', newUsersKeyboard(list).length);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
