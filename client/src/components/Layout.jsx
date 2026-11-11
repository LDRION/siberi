import {
  BarChart3, Check, ChevronLeft, Code2, Copy, CreditCard, Database, Handshake,
  HelpCircle, KeyRound, LayoutDashboard, Lightbulb, Lock, LogOut,
  Menu, MessageSquare, RefreshCw, Settings, Shield, User, Users, Users2, Wand2, X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import FloatingChatWidget from './FloatingChat';
import TutorialOverlay from './TutorialOverlay';
import AdminPanel from './AdminPanel';
import { useTutorial } from '../context/TutorialContext';
import './Layout.css';

/* ==========================================================================
   Каркас кабинета — редизайн Total Black (оболочка из panel.html).
   Вся логика сохранена: навигация, профиль, API-ключ (копия/ротация),
   автопродление, подсказки, админ-панель, консультант, тема.
   Экраны рендерятся в .view как children (React Router).
   ========================================================================== */

const API_BASE_LAYOUT = import.meta.env.VITE_API_URL || '/api/v1';

// Меню кабинета — по алфавиту, как в эталоне. Дом (чат) открывается по бренду.
// «Обзор» слит в «Мониторинг», «Интеграции» — под-вкладка «Настроек AI».
const NAV = [
  { path: '/analytics', icon: BarChart3, label: 'Аналитика' },
  { path: '/data', icon: Database, label: 'База знаний' },
  { path: '/studio', icon: Wand2, label: 'Конструктор бота', studio: true },
  { path: '/panel', icon: Shield, label: 'Мониторинг' },
  { path: '/settings', icon: Settings, label: 'Настройки AI' },
];
// информационные пункты — внизу
const NAV_SEC = [
  { path: '/solutions', icon: Users, label: 'Возможности Siberi AI' },
  { path: '/billing', icon: CreditCard, label: 'Подписка' },
  { path: '/partner', icon: Handshake, label: 'Стать партнёром' },
];

// Заголовок/подзаголовок шапки по маршруту.
const HEAD = {
  '/dashboard': { icon: LayoutDashboard, title: 'Обзор', sub: 'Метрики, интеграции и статус вашего AI' },
  '/analytics': { icon: BarChart3, title: 'Аналитика', sub: 'Динамика, каналы, воронка и качество ответов' },
  '/data': { icon: Database, title: 'База знаний', sub: 'Схемы и записи, на которых отвечает ваш AI' },
  '/studio': { icon: Wand2, title: 'Конструктор бота', sub: 'Личность, команды и правила — правкой словами' },
  '/panel': { icon: Shield, title: 'Мониторинг', sub: 'Диалоги, пользователи и статистика' },
  '/settings': { icon: Settings, title: 'Настройки AI', sub: 'Профиль, поведение и интеграции' },
  '/integrations': { icon: Code2, title: 'Интеграции', sub: 'Telegram, VK, виджет и API' },
  '/solutions': { icon: Users, title: 'Кому пригодится Siberi AI?', sub: 'Выберите свою роль — покажем, как AI изменит вашу работу или жизнь' },
  '/billing': { icon: CreditCard, title: 'Подписка', sub: 'Тариф, оплата и автопродление' },
  '/partner': { icon: Handshake, title: 'Стать партнёром', sub: 'Приводите клиентов и зарабатывайте' },
  '/chat': { icon: MessageSquare, title: 'Чат с нейросетью', sub: 'Спросите что угодно — AI ответит по вашим данным' },
  '/account': { icon: User, title: 'Аккаунт', sub: 'Личные настройки и безопасность' },
};

function AnimatedMain({ locationKey, children }) {
  const [phase, setPhase] = useState('enter');
  const [displayed, setDisplayed] = useState(children);
  const prevKey = useRef(locationKey);
  useEffect(() => {
    if (prevKey.current === locationKey) { setDisplayed(children); return; }
    prevKey.current = locationKey;
    setPhase('exit');
    const t = setTimeout(() => { setDisplayed(children); setPhase('enter'); }, 160);
    return () => clearTimeout(t);
  }, [locationKey, children]);
  return <div className={`view view-${phase}`} id="viewHost">{displayed}</div>;
}

export default function Layout({ children, apiKey, onLogout, isSiteAdmin, onApiKeyRotated }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { enabled, setEnabled, isActive } = useTutorial();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [studioModalOpen, setStudioModalOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [userPlan, setUserPlan] = useState(null);
  const [subStatus, setSubStatus] = useState(null);
  const [userEmail, setUserEmail] = useState('');
  const [autoRenew, setAutoRenew] = useState(true);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [rotateKeyModalOpen, setRotateKeyModalOpen] = useState(false);
  const [rotatingKey, setRotatingKey] = useState(false);
  const [rotateKeyError, setRotateKeyError] = useState('');
  const [light, setLight] = useState(() => { try { return localStorage.getItem('siberi-theme') === 'light'; } catch { return false; } });

  // useLayoutEffect, а НЕ useEffect: весь CSS кабинета заскоуплен под
  // `body.sb-panel`, а useEffect отрабатывает уже ПОСЛЕ первой отрисовки —
  // один кадр рисовался вообще без стилей. Заметнее всего это было на роботе
  // в логотипе: инлайновый <svg> без width/height без CSS растягивается до
  // дефолтных 300×150 («огромная голова робота» на полсекунды).
  useLayoutEffect(() => {
    document.body.classList.add('sb-panel');
    // Снимаем boot-классы анти-FOUC (index.html вешает их на <html> до рендера):
    // их инлайн-CSS красит фон по сохранённой теме и весит 0,2,2 — перебивает
    // body.sb-panel(.light). Пока React не смонтирован, они гасят вспышку; как
    // только оболочка взяла тему на себя, они мешают (фон залипал светлым при
    // переключении на тёмную) — дальше темой рулят токены body.sb-panel.
    document.documentElement.classList.remove('sb-boot-app', 'sb-boot-light');
    return () => document.body.classList.remove('sb-panel', 'light');
  }, []);
  useLayoutEffect(() => {
    document.body.classList.toggle('light', light);
    try { localStorage.setItem('siberi-theme', light ? 'light' : 'dark'); } catch { /* noop */ }
    window.dispatchEvent(new Event('themechange'));
  }, [light]);

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${API_BASE_LAYOUT}/user/info`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((r) => r.json())
      .then((d) => {
        setUserPlan(d.plan); setSubStatus(d.subscriptionStatus);
        setAutoRenew(d.autoRenew !== false); setEnabled(d.hintsEnabled !== false);
        if (d.email) setUserEmail(d.email);
      })
      .catch(() => {});
  }, [apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePreference = (key, value) => {
    fetch(`${API_BASE_LAYOUT}/user/preferences`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {});
  };
  const toggleAutoRenew = () => { const n = !autoRenew; setAutoRenew(n); savePreference('autoRenew', n); };
  const toggleHints = () => { const n = !enabled; setEnabled(n); savePreference('hintsEnabled', n); };
  const copyApiKey = () => { navigator.clipboard.writeText(apiKey || '').catch(() => {}); setApiKeyCopied(true); setTimeout(() => setApiKeyCopied(false), 2000); };
  const confirmRotateApiKey = async () => {
    setRotatingKey(true); setRotateKeyError('');
    try {
      const r = await fetch(`${API_BASE_LAYOUT}/user/regenerate-apikey`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } });
      const data = await r.json();
      if (!data.success) throw new Error(data.error || 'Не удалось обновить ключ');
      onApiKeyRotated?.(data.apiKey); setRotateKeyModalOpen(false);
    } catch (err) { setRotateKeyError(err.message || 'Не удалось обновить ключ. Попробуйте ещё раз.'); }
    finally { setRotatingKey(false); }
  };

  const hasStudioAccess = subStatus === 'trial' || userPlan === 'pro' || userPlan === 'premium';
  const closeSide = () => setSidebarOpen(false);
  const navTo = (path, studio) => (e) => {
    if (studio && !hasStudioAccess) { e.preventDefault(); setSidebarOpen(false); setStudioModalOpen(true); return; }
    setSidebarOpen(false);
  };

  const head = HEAD[location.pathname] || { icon: MessageSquare, title: 'Кабинет', sub: '' };
  const HeadIcon = head.icon;

  const NavLink = ({ item, sec }) => {
    const active = location.pathname === item.path;
    const Icon = item.icon;
    return (
      <Link to={item.path} className={`nav__item${sec ? ' nav__item--sec' : ''}${active ? ' nav__item--active' : ''}`} onClick={navTo(item.path, item.studio)}>
        <span className="nav__ic"><Icon size={sec ? 18 : 19} /></span>
        <span className="nav__t">{item.label}</span>
        {item.studio && !hasStudioAccess && <Lock size={13} className="nav__lock" />}
      </Link>
    );
  };

  return (
    <div className={`app${collapsed ? ' side-collapsed' : ''}${sidebarOpen ? ' side-open' : ''}${isActive ? ' tut-active' : ''}`} id="app">
      <div className="grain" aria-hidden="true"></div>

      {/* ================= САЙДБАР ================= */}
      <aside className="side" id="side">
        <div className="side__brand" role="button" tabIndex={0} onClick={() => { closeSide(); navigate('/chat'); }} aria-label="Открыть чат с нейросетью">
          <span className="side__mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01M9.5 16.5h5" /></svg></span>
          <span className="side__name">SIBERI<span className="side__dot">.AI</span></span>
          <button className="side__collapse" type="button" aria-label="Свернуть меню" title="Свернуть меню" onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v); }}>
            <ChevronLeft size={20} />
          </button>
        </div>

        <nav className="nav" id="nav">{NAV.map((i) => <NavLink key={i.path} item={i} />)}</nav>

        <div className="side__foot">
          <nav className="nav nav--sec" id="navSecondary">
            {NAV_SEC.map((i) => <NavLink key={i.path} item={i} sec />)}
          </nav>

          <button className={`hints-toggle${enabled ? ' hints-toggle--on' : ''}`} type="button" aria-pressed={enabled} onClick={toggleHints}>
            <span className="hints-toggle__l"><Lightbulb size={17} /> <span>Подсказки</span></span>
            <span className="hints-toggle__sw"><span className="hints-toggle__knob"></span></span>
          </button>

          <div className="side__api" id="apiBox">
            <span className="side__api-l">API KEY</span>
            <div className="side__api-row">
              <code id="apiKey">{apiKey ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}` : '—'}</code>
              <button className="side__api-copy" aria-label="Скопировать ключ" title={apiKeyCopied ? 'Скопировано!' : 'Скопировать'} onClick={copyApiKey}>
                {apiKeyCopied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
          </div>

          <button className="side__acc" type="button" onClick={() => setProfileOpen((v) => !v)}>
            <span className="side__acc-ic" aria-hidden="true"><User size={19} /></span>
            <span className="side__acc-meta">
              <span className="side__acc-name">Мой аккаунт</span>
              <span className="side__acc-mail">{userEmail || (userPlan ? `Тариф: ${userPlan}` : 'Личные настройки')}</span>
            </span>
            <span className="side__acc-chev" aria-hidden="true"><Settings size={16} /></span>
          </button>
        </div>
      </aside>

      {/* ================= ОСНОВНОЙ ЭКРАН ================= */}
      <main className="main">
        <header className="head">
          <button className="head__burger" aria-label="Меню" onClick={() => setSidebarOpen((v) => !v)}>
            {sidebarOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
          <div className="head__l">
            <span className="head__ic"><HeadIcon size={22} /></span>
            <div>
              <h1 className="head__title">{head.title}</h1>
              {head.sub && <p className="head__sub">{head.sub}</p>}
            </div>
          </div>
          <div className="head__r">
            <button className="theme-toggle" type="button" aria-label="Сменить тему" onClick={() => setLight((v) => !v)}>
              <svg className="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
              <svg className="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v2.5M12 20v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1.5 12h2.5M20 12h2.5M4.2 19.8l1.8-1.8M18 6l1.8-1.8" /></svg>
            </button>
          </div>
        </header>

        <AnimatedMain locationKey={location.pathname}>{children}</AnimatedMain>
      </main>

      {sidebarOpen && <div className="scrim" onClick={closeSide} />}

      {/* Плавающий консультант + туториал (существующая логика) */}
      <FloatingChatWidget apiKey={apiKey} />
      <TutorialOverlay />

      {/* Админ */}
      {isSiteAdmin && (
        <button className="adm-trigger" onClick={() => setAdminOpen(true)} title="Панель администратора"><Shield size={22} /></button>
      )}
      {adminOpen && <AdminPanel apiKey={apiKey} onClose={() => setAdminOpen(false)} />}

      {/* Профиль-панель */}
      {profileOpen && <div className="prof-panel-overlay" onClick={() => setProfileOpen(false)} />}
      <div className={`prof-panel${profileOpen ? ' prof-panel--open' : ''}`}>
        <div className={`prof-panel__item prof-panel__toggle${autoRenew ? ' prof-panel__toggle--on' : ''}`} onClick={toggleAutoRenew}>
          <RefreshCw size={15} /><span className="prof-panel__label">Автопродление</span>
        </div>
        <div className="prof-panel__sep" />
        <div className={`prof-panel__item prof-panel__toggle${enabled ? ' prof-panel__toggle--on' : ''}`} onClick={toggleHints}>
          <HelpCircle size={15} /><span className="prof-panel__label">Подсказки</span>
        </div>
        <div className="prof-panel__sep" />
        <button className="prof-panel__item prof-panel__action" onClick={() => { setProfileOpen(false); navigate('/partner'); }}>
          <Users2 size={15} /><span className="prof-panel__label">Стать партнёром</span>
        </button>
        <button className="prof-panel__item prof-panel__action prof-panel__action--danger" onClick={() => { setRotateKeyError(''); setRotateKeyModalOpen(true); }}>
          <KeyRound size={15} /><span className="prof-panel__label">Заменить API KEY</span>
        </button>
        <button className="prof-panel__item prof-panel__action" onClick={onLogout}>
          <LogOut size={15} /><span className="prof-panel__label">Выйти</span>
        </button>
        <button className="prof-panel__close" onClick={() => setProfileOpen(false)} title="Закрыть"><X size={16} /></button>
      </div>

      {/* Ротация API-ключа */}
      {rotateKeyModalOpen && (
        <div className="rotate-key-overlay" onClick={() => !rotatingKey && setRotateKeyModalOpen(false)}>
          <div className="rotate-key-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rotate-key-modal__icon"><KeyRound size={28} /></div>
            <h3 className="rotate-key-modal__title">Заменить API KEY?</h3>
            <p className="rotate-key-modal__text">Старый ключ сразу перестанет работать. Сайт, Telegram/VK/MAX-боты и виджет продолжат работать как обычно — они не зависят от этого ключа.</p>
            <p className="rotate-key-modal__text rotate-key-modal__text--warn">Но если вы вставляли этот ключ в код своих проектов вручную (например, через Data API) — поменяйте его там сами.</p>
            {rotateKeyError && <p className="rotate-key-modal__error">{rotateKeyError}</p>}
            <div className="rotate-key-modal__actions">
              <button className="rotate-key-modal__btn rotate-key-modal__btn--cancel" onClick={() => setRotateKeyModalOpen(false)} disabled={rotatingKey}>Отменить</button>
              <button className="rotate-key-modal__btn rotate-key-modal__btn--confirm" onClick={confirmRotateApiKey} disabled={rotatingKey}>{rotatingKey ? 'Заменяю...' : 'Подтвердить'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Bot Studio upsell */}
      {studioModalOpen && (
        <div className="studio-upsell-overlay" onClick={() => setStudioModalOpen(false)}>
          <div className="studio-upsell-modal" onClick={(e) => e.stopPropagation()}>
            <button className="studio-upsell-close" onClick={() => setStudioModalOpen(false)}><X size={18} /></button>
            <div className="studio-upsell-icon"><Wand2 size={36} /></div>
            <h2 className="studio-upsell-title">Конструктор бота</h2>
            <p className="studio-upsell-desc">Опишите своего бота — AI сам напишет системный промт, команды, клавиатуры и создаст схемы данных. Без программирования.</p>
            <div className="studio-upsell-plans"><span className="studio-upsell-plan">Pro</span><span className="studio-upsell-plan studio-upsell-plan--gold">Premium</span></div>
            <p className="studio-upsell-note">Доступно на тарифах Pro и Premium</p>
            <button className="studio-upsell-btn" onClick={() => { setStudioModalOpen(false); navigate('/billing'); }}>Улучшить тариф</button>
          </div>
        </div>
      )}
    </div>
  );
}
