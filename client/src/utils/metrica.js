const COUNTER_ID = 109332736;
let initialized = false;

export function initMetrica() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://mc.yandex.ru/metrika/tag.js';
  script.onload = () => {
    window.ym(COUNTER_ID, 'init', {
      webvisor: true,
      clickmap: true,
      ecommerce: 'dataLayer',
      accurateTrackBounce: true,
      trackLinks: true,
    });
  };
  document.head.appendChild(script);

  const noscript = document.createElement('noscript');
  noscript.innerHTML = `<div><img src="https://mc.yandex.ru/watch/${COUNTER_ID}" style="position:absolute;left:-9999px" alt="" /></div>`;
  document.body.appendChild(noscript);
}
