// Диагностика: почему бот «числится запущенным», но не работает.
// Показывает getMe + getWebhookInfo по каждому подключённому боту. READ-ONLY.
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

const UserIntegrations = require('../models/UserIntegrations');

const api = async (token, method) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: ctrl.signal });
    clearTimeout(t);
    return await r.json();
  } catch (e) { return { ok: false, _net: e.message }; }
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/siberiai_api');
  const docs = await UserIntegrations.find({ telegram: { $elemMatch: { connected: true } } })
    .select('telegram.botUsername telegram.connected telegram.connectedAt telegram.token').lean();

  const bots = [];
  for (const d of docs) for (const t of (d.telegram || [])) if (t.connected) bots.push(t);
  bots.sort((a, b) => new Date(b.connectedAt || 0) - new Date(a.connectedAt || 0));

  for (const b of bots) {
    const me = await api(b.token, 'getMe');
    const wh = await api(b.token, 'getWebhookInfo');
    const w = wh.result || {};
    console.log(`\n@${b.botUsername || '—'}  (подключён ${b.connectedAt ? new Date(b.connectedAt).toLocaleDateString('ru-RU') : '—'})`);
    console.log(`   getMe: ${me.ok ? 'OK — @' + (me.result?.username || '') : 'FAIL — ' + (me.description || me._net)}`);
    console.log(`   webhook url: ${w.url || '(ПУСТО — бот никем не обслуживается)'}`);
    console.log(`   наш сервер: ${w.url && w.url.includes('/webhook/telegram/') ? 'ДА' : 'НЕТ'}`);
    if (w.pending_update_count) console.log(`   в очереди необработанных: ${w.pending_update_count}`);
    if (w.last_error_message) {
      console.log(`   ПОСЛЕДНЯЯ ОШИБКА: ${w.last_error_message}`
        + (w.last_error_date ? ` (${new Date(w.last_error_date * 1000).toLocaleString('ru-RU')})` : ''));
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
