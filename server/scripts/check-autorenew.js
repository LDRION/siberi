// READ-ONLY: сколько пользователей имеют включённое автопродление и откуда оно взялось.
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

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');
  const tg = { telegramId: { $ne: null } };
  const [total, onTrue, onFalse, missing, tgOnTrue] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ autoRenew: true }),
    User.countDocuments({ autoRenew: false }),
    User.countDocuments({ autoRenew: { $exists: false } }),
    User.countDocuments({ ...tg, autoRenew: true }),
  ]);
  console.log('Всего пользователей:', total);
  console.log('  autoRenew = true :', onTrue, `(из них telegram-юзеры конструктора: ${tgOnTrue})`);
  console.log('  autoRenew = false:', onFalse);
  console.log('  поля нет вообще  :', missing, '(читается как ВЫКЛ — это ок)');
  console.log('\nВАЖНО: тумблера в мини-аппе не существовало, значит telegram-юзеры');
  console.log('физически не могли дать явное согласие — все true у них от старого default.');
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
