#!/usr/bin/env node
'use strict';

// Здоровье AI-шлюза одной командой:  node scripts/gateway-health.js
//
// Из /admin в боте это убрано намеренно (техника, а не бизнес-метрика).
// Смотреть отсюда — и владельцу, и при разборе инцидентов.
//
// Что важно знать про пороги:
// • вкладок в норме 5 (3 пула + запасная + демо). Рост выше = утечка: браузер
//   забивается и генерация деградирует (инцидент 19.07: 19 вкладок / 2.7 ГБ).
// • «мёртвые» = заглушки Cloudflare 1015 (нас режут по частоте запросов).
//   Их закрывает уборщик раз в 5 мин; если они копятся — уборщик не работает.
// • память: Edge в норме ест ~2.4 ГБ из 3.8 — запас тонкий, следим за
//   available (это НЕ «free»: free без учёта кеша всегда выглядит страшно).

const CDP = 'http://127.0.0.1:9223';

async function cdpPages() {
  const r = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await r.json();
  return (list || []).filter((p) => p.type === 'page');
}

function sh(cmd) {
  try { return require('child_process').execSync(cmd, { timeout: 5000 }).toString().trim(); }
  catch { return ''; }
}

(async () => {
  const DEAD = /cloudflare\.com|challenges\.cloudflare|\/error-\d{3,}/i;
  console.log('\n  ═══ AI-ШЛЮЗ ═══\n');

  let pages = null;
  try { pages = await cdpPages(); }
  catch (e) { console.log(`  ❌ CDP недоступен (${e.message.slice(0, 60)})`); }

  if (pages) {
    const dead = pages.filter((p) => DEAD.test(p.url || ''));
    const mistral = pages.filter((p) => /mistral/i.test(p.url || ''));
    const qwen = pages.filter((p) => /qwen/i.test(p.url || ''));
    const mark = pages.length > 12 ? '🔴 утечка' : pages.length > 7 ? '⚠️ многовато' : '✅';
    console.log(`  Вкладок: ${pages.length} (норма 5)  ${mark}`);
    console.log(`    mistral: ${mistral.length} · qwen: ${qwen.length} · мёртвых: ${dead.length}${dead.length ? ' ☠️' : ''}`);
    if (dead.length) {
      console.log(`    ↳ это заглушки Cloudflare 1015. Уборщик закрывает их раз в 5 мин;`);
      console.log(`      если не уменьшаются — проверь, что он запущен (лог «🧹 Уборщик вкладок»).`);
    }
  }

  const edgeMb = parseInt(sh("ps -eo rss,comm | grep -i msedge | awk '{s+=$1} END {print int(s/1024)}'"), 10);
  const availMb = parseInt(sh("free -m | awk '/^Mem:/{print $7}'"), 10);
  const swapMb = parseInt(sh("free -m | awk '/^Swap:/{print $3}'"), 10);
  const memMark = availMb < 300 ? '🔴' : availMb < 700 ? '⚠️' : '✅';
  console.log(`\n  Память: Edge ${edgeMb || '—'} МБ · доступно ${availMb || '—'} МБ ${memMark}` +
              (swapMb ? ` · swap занято ${swapMb} МБ` : ''));

  // Считаем ТОЛЬКО после последнего старта процесса — иначе старые записи в
  // логе показывали бы «были переключения» на свежезапущенном здоровом шлюзе.
  const provider = sh("pm2 logs siberi-api --lines 400 --nostream 2>/dev/null | awk '/Mistral AI Gateway: Старт/{f=1;c=0} f&&/Переключаюсь на Qwen/{c++} END{print c+0}'");
  console.log(`  Провайдер: ${Number(provider) > 0 ? `⚠️ переключений на Qwen с момента старта: ${provider}` : '✅ Mistral'}`);
  console.log(`  Qwen-резерв: ${process.env.QWEN_FALLBACK === 'on' ? 'включён' : 'ОТКЛЮЧЁН (QWEN_FALLBACK=on чтобы вернуть)'}`);

  console.log('\n  Если вкладки копятся:  systemctl restart edge-browser.service && pm2 restart siberi-api\n');
})();
