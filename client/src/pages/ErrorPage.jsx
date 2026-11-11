import { useEffect, useLayoutEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StarsBg from '../components/design/StarsBg';
import './ErrorPage.css';

/* Страницы ошибок (404 / 500 / техработы) — редизайн Total Black.
   Разметка из дизайн-эталона (pages/*.html). Логика типов/действий сохранена. */
const CONFIGS = {
  notFound: { code: '404', eye: 'x', title: 'Такой страницы нет', desc: 'Возможно, ссылка устарела или введена с ошибкой. Вернитесь на главную — нейросеть на месте и готова помочь.', action: { label: 'На главную', to: '/' } },
  error: { code: '500', eye: '', title: 'Что-то пошло не так', desc: 'Произошла непредвиденная ошибка. Мы уже работаем над тем, чтобы это исправить.', action: { label: 'Перезагрузить', reload: true } },
  maintenance: { code: '', eye: '', title: 'Технические работы', desc: 'Сайт временно недоступен — мы улучшаем платформу и скоро вернёмся. Спасибо за терпение!', action: { label: 'Обновить страницу', reload: true } },
};

export default function ErrorPage({ type = 'notFound', message }) {
  const navigate = useNavigate();
  const cfg = CONFIGS[type] || CONFIGS.notFound;
  const [light, setLight] = useState(() => { try { return localStorage.getItem('siberi-theme') === 'light'; } catch { return false; } });

  useLayoutEffect(() => {
    document.body.classList.add('sb-error');
    document.documentElement.classList.remove('sb-boot-app', 'sb-boot-light'); // boot-подложка снята — тему держит body.sb-error
    return () => document.body.classList.remove('sb-error', 'light');
  }, []);
  useEffect(() => {
    document.body.classList.toggle('light', light);
    try { localStorage.setItem('siberi-theme', light ? 'light' : 'dark'); } catch { /* noop */ }
    window.dispatchEvent(new Event('themechange'));
  }, [light]);

  const handleAction = () => { if (cfg.action.reload) window.location.reload(); else navigate(cfg.action.to); };

  return (
    <>
      <StarsBg />
      <button className="theme-toggle" type="button" aria-label="Сменить тему" onClick={() => setLight((v) => !v)}>
        <svg className="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
        <svg className="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v2.5M12 20v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1.5 12h2.5M20 12h2.5M4.2 19.8l1.8-1.8M18 6l1.8-1.8" /></svg>
      </button>

      <main className="wrap">
        <div className={`robot${cfg.eye === 'x' ? ' robot--x' : ''}`} aria-hidden="true">
          <span className="robot__glow"></span>
          <svg className="robot__bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /></svg>
          <span className="bot-eyes"><span className="bot-eye bot-eye--l"></span><span className="bot-eye bot-eye--r"></span></span>
          <span className="robot__spark"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5z" /></svg></span>
        </div>
        {cfg.code && <div className="code">{cfg.code}</div>}
        <h1 className="title">{cfg.title}</h1>
        <p className="lead">{cfg.desc}</p>
        {message && <pre className="err-detail">{message}</pre>}
        <div className="actions">
          <button className="btn btn--primary" onClick={handleAction}>{cfg.action.label}</button>
          {type !== 'maintenance' && (
            <button className="btn btn--ghost" onClick={() => navigate(-1)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 18l-6-6 6-6" /></svg> Назад
            </button>
          )}
        </div>
      </main>

      <footer className="foot"><b>SIBERI.AI</b> · персональная нейросеть для бизнеса</footer>
    </>
  );
}
