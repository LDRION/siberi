// Показывает, как выглядят уведомления о конце подписки, и проверяет, что каждый
// этап срабатывает ровно один раз. Ничего не отправляет и не пишет в БД.
// Запуск: node /var/www/siberi/server/scripts/preview-sub-notices.js
const fs = require('fs');
const path = require('path');

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

const { buildNotice, dueStage, canCharge } = require('../helpers/recurrent');

const plain = (t) => t.replace(/<b>|<\/b>/g, '*').replace(/<[^>]+>/g, '');
const END = new Date('2026-07-20T12:00:00+03:00');

const CASES = [
  ['Автопродление ВКЛЮЧЕНО (карта привязана)', { plan: 'tgletbot', autoRenew: true, tbankRebillId: 'rb_1', autoRenewFailCount: 0 }],
  ['Автопродление ВЫКЛЮЧЕНО',                  { plan: 'tgletbot', autoRenew: false, tbankRebillId: null }],
  ['Тумблер включён, но карты нет',            { plan: 'tgpremium', autoRenew: true, tbankRebillId: null }],
];

for (const [label, user] of CASES) {
  console.log('\n\n' + '█'.repeat(64) + `\n█ ${label}  (спишем: ${canCharge(user) ? 'ДА' : 'нет'})\n` + '█'.repeat(64));
  for (const stage of ['week', 'day', 'ended']) {
    // «Закончилась» тем, с кого спишем, не уходит: вместо этого идёт автосписание,
    // а об успехе сообщает чек об оплате из вебхука.
    if (stage === 'ended' && canCharge(user)) {
      console.log('\n──── ended ────\n  (не отправляется — вместо него идёт автосписание + чек об оплате)');
      continue;
    }
    const { text, keyboard } = buildNotice(user, stage, END, 1);
    console.log(`\n──── ${stage} ────`);
    console.log(plain(text));
    console.log('[кнопки] ' + (keyboard ? keyboard.flat().map((b) => b.text).join(' | ') : '—'));
  }
}

// ── Таймлайн: каждый этап обязан сработать ровно один раз ────────────────────
console.log('\n\n' + '='.repeat(64) + '\n= Таймлайн подписки (тик каждые 10 мин)\n' + '='.repeat(64));
const u = { plan: 'tgletbot', autoRenew: false, subEndNotify: null, markModified() {} };
const H = 3600e3;
const points = [
  ['за 10 дней', -240 * H], ['за 8 дней', -192 * H], ['за 7 дней', -168 * H],
  ['за 6 дней', -144 * H], ['за 3 дня', -72 * H], ['за 26 ч', -26 * H],
  ['за 25 ч (порог)', -25 * H], ['за 23 ч', -23 * H], ['за 2 ч', -2 * H],
  ['ровно в конце', 0], ['через 3 ч', 3 * H], ['через 30 ч', 30 * H], ['через 3 дня', 72 * H],
];
for (const [label, off] of points) {
  const now = new Date(END.getTime() + off);
  const st = dueStage(u, END, now);
  if (st) { const s = u.subEndNotify; s[st] = true; }
  console.log(`  ${label.padEnd(18)} → ${st ? '📨 ' + st : '—'}`);
}
console.log('\n  После продления (дата сдвинулась на месяц):');
const END2 = new Date(END.getTime() + 30 * 86400e3);
console.log(`  ${'за 7 дней'.padEnd(18)} → ${dueStage(u, END2, new Date(END2.getTime() - 168 * H)) ? '📨 week (цикл начался заново ✅)' : '— ОШИБКА: отметки не сбросились'}`);
