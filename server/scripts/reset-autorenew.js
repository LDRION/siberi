// Разовый сброс автопродления в ВЫКЛ для всех, кто не давал явного согласия.
//
// Запуск:  node /var/www/siberi/server/scripts/reset-autorenew.js
//
// Зачем: поле autoRenew исторически имело default: true, а тумблера в мини-аппе
// не существовало — значит ни один пользователь конструктора не мог осознанно
// подключить автопродление. Оферта п. 8.1 и Политика рекуррентных платежей п. 2.1
// прямо запрещают включение по умолчанию: подключение возможно ТОЛЬКО явным
// действием пользователя. Поэтому приводим данные в соответствие с документами.
//
// Безопасность: рекуррентные списания сейчас не реализованы вообще, поэтому
// сброс ни на кого не влияет функционально — он только приводит флаг к правде.
// Перед изменением делается бэкап затронутых id.
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
const BACKUP = path.join(__dirname, '..', 'autorenew-backup.json');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');

  const before = await User.find({ autoRenew: true }).select('_id telegramId email').lean();
  fs.writeFileSync(BACKUP, JSON.stringify(before, null, 2), 'utf8');
  console.log(`Бэкап: ${before.length} пользовател(я) с autoRenew=true -> ${BACKUP}`);

  const res = await User.updateMany({ autoRenew: true }, { $set: { autoRenew: false } });
  console.log(`Сброшено в ВЫКЛ: ${res.modifiedCount}`);

  const left = await User.countDocuments({ autoRenew: true });
  console.log(`\nПОСЛЕ: autoRenew=true осталось: ${left} (должно быть 0)`);
  console.log('Теперь автопродление включится только когда пользователь сам нажмёт тумблер и примет политику.');

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
