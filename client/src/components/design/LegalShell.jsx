import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StarsBg from './StarsBg';
import '../../pages/Legal.css';

/* Оболочка юридических страниц (оферта / политика) — редизайн Total Black.
   Контент (секции) передаётся как children. Тема + фон-звёзды общие. */
export default function LegalShell({ title, meta, children, crossLink }) {
  const [light, setLight] = useState(() => { try { return localStorage.getItem('siberi-theme') === 'light'; } catch { return false; } });
  const [showTop, setShowTop] = useState(false);

  useEffect(() => {
    document.body.classList.add('sb-legal');
    window.scrollTo(0, 0);
    const onScroll = () => setShowTop(window.scrollY > 500);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { document.body.classList.remove('sb-legal', 'light'); window.removeEventListener('scroll', onScroll); };
  }, []);
  useEffect(() => {
    document.body.classList.toggle('light', light);
    try { localStorage.setItem('siberi-theme', light ? 'light' : 'dark'); } catch { /* noop */ }
    window.dispatchEvent(new Event('themechange'));
  }, [light]);

  return (
    <>
      <StarsBg />
      <header className="top">
        <Link className="brand" to="/" aria-label="Siberi AI">
          <span className="brand__mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01M9.5 16.5h5" /></svg></span>
          <span className="brand__name">SIBERI<span className="brand__dot">.AI</span></span>
        </Link>
        <div className="top__r">
          <button className="theme" type="button" aria-label="Сменить тему" onClick={() => setLight((v) => !v)}>
            <svg className="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            <svg className="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v2.5M12 20v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1.5 12h2.5M20 12h2.5M4.2 19.8l1.8-1.8M18 6l1.8-1.8" /></svg>
          </button>
          <Link className="back" to="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 18l-6-6 6-6" /></svg> <span>На главную</span></Link>
        </div>
      </header>

      <main className="doc">
        <div className="doc__kicker">Документ</div>
        <h1 className="doc__title">{title}</h1>
        {meta && <div className="doc__meta">{meta}</div>}
        <div className="doc__body">{children}</div>
        <div className="foot">
          <Link to="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 18l-6-6 6-6" /></svg><span>На главную</span></Link>
          {crossLink && <Link to={crossLink.to}><span>{crossLink.label}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></Link>}
        </div>
      </main>

      <button className={`toTop${showTop ? ' show' : ''}`} type="button" aria-label="Наверх" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
      </button>
    </>
  );
}
