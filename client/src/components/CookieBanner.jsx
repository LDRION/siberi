import { useState, useEffect } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { initMetrica } from '../utils/metrica';
import './CookieBanner.css';

export default function CookieBanner() {
  const [visible, setVisible] = useState(() => !localStorage.getItem('cookieConsent'));

  useEffect(() => {
    if (localStorage.getItem('cookieConsent')) initMetrica();
  }, []);

  // Standalone Telegram Mini App view — no website chrome, no analytics cookies to consent to
  if (window.location.pathname.startsWith('/tg-data')) return null;

  if (!visible) return null;

  const accept = () => {
    localStorage.setItem('cookieConsent', '1');
    initMetrica();
    setVisible(false);
  };

  return (
    <div className="cookie-banner" role="banner" aria-label="Уведомление о cookie">
      <div className="cookie-banner__icon">
        <ShieldCheck size={20} strokeWidth={1.8} />
      </div>
      <span className="cookie-banner__text">
        Мы используем cookie для корректной работы сайта.
      </span>
      <button className="cookie-banner__btn" onClick={accept}>
        Понятно
      </button>
      <button className="cookie-banner__close" onClick={accept} aria-label="Закрыть">
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
