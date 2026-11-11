import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';
import './App.css';
import ErrorBoundary from './components/ErrorBoundary';
import { TutorialProvider } from './context/TutorialContext';
import Layout from './components/Layout';
import AISettings from './pages/AISettings';
import Billing from './pages/Billing';
import ChatPage from './pages/ChatPage';
import Analytics from './pages/Analytics';
import ErrorPage from './pages/ErrorPage';
import Integrations from './pages/Integrations';
import Landing from './pages/Landing';
import Login from './pages/Login';
import PrivacyPage from './pages/PrivacyPage';
import OfertaPage from './pages/OfertaPage';
import PayResult from './pages/PayResult';
import MyDataPage from './pages/MyDataPage';
import PartnerPage from './pages/PartnerPage';
import Solutions from './pages/Solutions';
import ControlPanel from './pages/ControlPanel';
import BotStudio from './pages/BotStudio';
import ChatEmbed from './pages/ChatEmbed';
import TgMiniApp from './pages/TgMiniApp';
import NichePage from './pages/NichePage';
import AppChat from './pages/AppChat';
import SiteBackground from './components/SiteBackground';

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

function LoginRedirect() {
  const pending = localStorage.getItem('pendingNicheSetup');
  if (pending) return <Navigate to={`/data?nicheSetup=${pending}`} />;
  return <Navigate to="/panel" />;
}

function App() {
  // Синхронная инициализация из localStorage/URL-токена — чтобы на первом кадре
  // кабинет знал про авторизацию и не мигал редиректом на /login, а приложение
  // рисовалось сразу, без блокирующего экрана «Загрузка».
  const initialKey = (() => {
    try {
      return localStorage.getItem('apiKey') || new URLSearchParams(window.location.search).get('token') || null;
    } catch { return null; }
  })();
  const [isAuthenticated, setIsAuthenticated] = useState(!!initialKey);
  const [apiKey, setApiKey] = useState(initialKey);
  const [maintenance, setMaintenance] = useState(false);
  const [isSiteAdmin, setIsSiteAdmin] = useState(false);

  useEffect(() => {
    const storedKey = localStorage.getItem('apiKey');
    if (storedKey) {
      setApiKey(storedKey);
      setIsAuthenticated(true);
    }

    // Also check URL token (OAuth redirect arrives before localStorage is set)
    const urlToken = new URLSearchParams(window.location.search).get('token');
    const keyToCheck = storedKey || urlToken;
    if (urlToken) {
      localStorage.setItem('apiKey', urlToken);
      setApiKey(urlToken);
      setIsAuthenticated(true);
    }

    const maintenanceFetch = fetch(`${API_BASE}/maintenance`, {
      headers: keyToCheck ? { Authorization: `Bearer ${keyToCheck}` } : {},
    })
      .then(r => r.json())
      .then(data => { if (data.active && !data.bypass) setMaintenance(true); })
      .catch(() => {});

    const adminFetch = keyToCheck
      ? fetch(`${API_BASE}/user/info`, { headers: { Authorization: `Bearer ${keyToCheck}` } })
          .then(r => r.json())
          .then(data => { if (data.isSiteAdmin) setIsSiteAdmin(true); })
          .catch(() => {})
      : Promise.resolve();

    // Фоном: maintenance/admin. Не блокируем первый рендер — если включён
    // режим техработ, экран сменится на него сразу после ответа.
    void Promise.all([maintenanceFetch, adminFetch]);
  }, []);

  const checkMaintenance = async (key) => {
    try {
      const r = await fetch(`${API_BASE}/maintenance`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      const data = await r.json();
      if (!data.active || data.bypass) setMaintenance(false);
    } catch {}
  };

  // Пингуем сервер при любой активности — держим браузерный контекст тёплым
  const pingServer = (key) => {
    if (!key) return;
    fetch(`${API_BASE}/ping`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } }).catch(() => {});
  };

  const handleLogin = (key) => {
    localStorage.setItem('apiKey', key);
    setApiKey(key);
    setIsAuthenticated(true);
    checkMaintenance(key);
    pingServer(key);
    fetch(`${API_BASE}/user/info`, { headers: { Authorization: `Bearer ${key}` } })
      .then(r => r.json())
      .then(data => { if (data.isSiteAdmin) setIsSiteAdmin(true); })
      .catch(() => {});
  };

  const handleLogout = () => {
    localStorage.removeItem('apiKey');
    setApiKey(null);
    setIsAuthenticated(false);
    setIsSiteAdmin(false);
  };

  // After a key rotation, swap the live session over to the new key — no re-login needed
  const handleApiKeyRotated = (newKey) => {
    localStorage.setItem('apiKey', newKey);
    setApiKey(newKey);
  };


  // /tg-data (TGLetBot Mini App) authenticates via Telegram initData, not the
  // website apiKey — it can never present a whitelisted key to bypass, so it
  // must be exempt from the gate outright (its own server-side endpoints are
  // exempt too, see index.js's maintenance gate).
  const onLoginPage = window.location.pathname === '/login' || window.location.pathname === '/reset-password' || window.location.pathname === '/tg-data';
  if (maintenance && !onLoginPage) {
    return (
      <Router>
        <ErrorPage type="maintenance" />
      </Router>
    );
  }

  return (
    <TutorialProvider>
    <Router>
      <ErrorBoundary>
      <SiteBackground />
      <SmoothScroll />
      <PageTitle />
      <MetricaTracker />
      {isAuthenticated && apiKey && <ActivityTracker apiKey={apiKey} pingServer={pingServer} />}
      <SystemChangeToast />
      {/* Cookie/согласие — в новом дизайне живёт на лендинге (Landing.jsx).
          TODO финализация: единый consent в новом дизайне + инициализация Метрики по согласию. */}
      <Routes>
        {/* Главная — ChatGPT-подобное приложение (перепозиционирование: «ИИ в целом») */}
        <Route path="/" element={isAuthenticated ? <Navigate to="/app" replace /> : <Landing />} />
        <Route path="/app" element={<AppChat />} />

        {/* Маркетинговый лендинг переехал на /about — сохранён целиком (SEO, ниши) */}
        <Route path="/about" element={<Landing />} />
        <Route path="/welcome" element={<Navigate to="/about" replace />} />

        {/* Страница входа/регистрации */}
        <Route
          path="/login"
          element={
            !isAuthenticated ? <Login onLogin={handleLogin} /> : <LoginRedirect />
          }
        />

        {/* Email verification — auto-login after confirm */}
        <Route path="/verify-email" element={isAuthenticated ? <Navigate to="/panel" /> : <Login onLogin={handleLogin} />} />

        {/* Password reset */}
        <Route path="/reset-password" element={<Login onLogin={handleLogin} />} />

        {/* «Обзор» слит с «Мониторингом» — как в эталоне, где отдельного
            viewDashboard нет (#dashboard там тоже уходит на manage). Метрики и
            график активности переехали в /panel; интеграции, тариф и API-ключ
            и так живут в своих разделах (/integrations, /billing, сайдбар).
            Маршрут оставлен редиректом — на него ведут старые ссылки. */}
        <Route path="/dashboard" element={<Navigate to="/panel" replace />} />

        {/* Аналитика (новый раздел редизайна) */}
        <Route
          path="/analytics"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <Analytics apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Мои данные */}
        <Route
          path="/data"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <MyDataPage apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route path="/schemas" element={<Navigate to="/data" />} />
        <Route path="/records" element={<Navigate to="/data" />} />

        {/* Настройки AI */}
        <Route
          path="/settings"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <AISettings apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Кому нужно — публичная страница для SEO */}
        <Route
          path="/solutions"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <Solutions apiKey={apiKey} />
              </Layout>
            ) : (
              <Solutions apiKey={null} />
            )
          }
        />

        {/* Интеграции */}
        <Route
          path="/integrations"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <Integrations apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Личная нейросеть */}
        <Route
          path="/chat"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <ChatPage apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Подписка */}
        <Route
          path="/billing"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <Billing apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Партнёрская программа */}
        <Route
          path="/partner"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <PartnerPage apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Панель управления ботом */}
        <Route
          path="/panel"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <ControlPanel apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Bot Studio */}
        <Route
          path="/studio"
          element={
            isAuthenticated ? (
              <Layout apiKey={apiKey} onLogout={handleLogout} isSiteAdmin={isSiteAdmin} onApiKeyRotated={handleApiKeyRotated}>
                <BotStudio apiKey={apiKey} />
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Публичная страница AI-чата (встраиваемая) */}
        <Route path="/chat-page" element={<ChatEmbed />} />

        {/* TGLetBot Mini App — "Мои данные" в Telegram */}
        <Route path="/tg-data" element={<TgMiniApp />} />

        {/* Посадочные страницы по нишам — публичные, для SEO */}
        <Route path="/for/:niche" element={<NichePage />} />

        {/* Политика конфиденциальности */}
        <Route path="/privacy" element={<PrivacyPage />} />

        {/* Публичная оферта */}
        <Route path="/oferta" element={<OfertaPage />} />

        {/* Результат оплаты — куда Т-Касса возвращает клиента после платежа */}
        <Route path="/pay/success" element={<PayResult type="success" />} />
        <Route path="/pay/fail" element={<PayResult type="fail" />} />

        {/* Страница технических работ */}
        <Route path="/maintenance" element={<ErrorPage type="maintenance" />} />

        {/* 404 — все неизвестные маршруты */}
        <Route path="*" element={<ErrorPage type="notFound" />} />
      </Routes>
      </ErrorBoundary>
    </Router>
    </TutorialProvider>
  );
}

// ── SEO: per-route title / description / canonical / OG ─────────────────────
const DEFAULT_TITLE = 'ИИ для бизнеса — нейросеть-ассистент в Telegram и на сайте | Siberi AI';
const DEFAULT_DESC =
  'Нейросеть для бизнеса: AI-ассистент отвечает клиентам в Telegram, VK и на сайте 24/7 — консультирует, записывает, продаёт. Запуск за 5 минут без программиста.';

const APP_TITLE = 'Siberi — ИИ для бизнеса';
const APP_DESC =
  'Siberi — умный AI-ассистент: пишет и редактирует тексты, объясняет сложное простыми словами, считает, помогает с кодом и идеями. Бесплатно, на русском, без установки.';

const PAGE_SEO = {
  '/': { title: APP_TITLE, desc: APP_DESC },
  '/about': { title: 'Siberi — ИИ для бизнеса', desc: DEFAULT_DESC },
  '/login': {
    title: 'Вход — Siberi',
    desc: 'Создайте своего ИИ-ассистента для бизнеса за 5 минут.',
  },
  '/partner': {
    title: 'Партнёрам — Siberi',
    desc: 'Приглашайте клиентов на платформу Siberi AI и получайте бонусы: бесплатные месяцы подписки за каждого реферала.',
  },
  '/privacy': {
    title: 'Конфиденциальность — Siberi',
    desc: 'Политика обработки персональных данных платформы Siberi AI. Соответствие 152-ФЗ.',
  },
  '/oferta': {
    title: 'Оферта — Siberi',
    desc: 'Договор публичной оферты на использование AI-платформы Siberi AI: тарифы, пробный период 7 дней, порядок оплаты.',
  },
  '/solutions': {
    title: 'Сценарии — Siberi',
    desc: 'Сценарии использования нейросети Siberi AI: для предпринимателей, разработчиков, мастеров и офисных команд. Найдите свой вариант ИИ-ассистента.',
  },
  // Приватные разделы — краулерам здесь делать нечего
  '/dashboard':    { title: 'Панель управления — Siberi AI', noindex: true },
  '/panel':        { title: 'Управление ИИ — Siberi AI', noindex: true },
  '/chat':         { title: 'Чат AI — Siberi AI', noindex: true },
  '/app':          { title: 'Siberi', noindex: true },
  '/data':         { title: 'Данные — Siberi AI', noindex: true },
  '/settings':     { title: 'Настройки AI — Siberi AI', noindex: true },
  '/integrations': { title: 'Интеграции — Siberi AI', noindex: true },
  '/billing':      { title: 'Подписка — Siberi AI', noindex: true },
  '/studio':       { title: 'Bot Studio — Siberi AI', noindex: true },
};

const NICHE_SEO = {
  barbershop: {
    title: 'ИИ для барбершопа — запись клиентов в Telegram 24/7 | Siberi AI',
    desc: 'Нейросеть для барбершопа: принимает запись в Telegram, знает прайс и расписание мастеров, напоминает о визите. Запуск за 5 минут.',
  },
  cafe: {
    title: 'ИИ для кафе и ресторана — бронирование столиков в Telegram | Siberi AI',
    desc: 'AI-ассистент для ресторана: бронирует столики, отвечает про меню и акции 24/7. Без программиста.',
  },
  medical: {
    title: 'ИИ для клиники — запись пациентов без оператора | Siberi AI',
    desc: 'Нейросеть для медицинского центра: консультирует по услугам и ценам, записывает на приём круглосуточно, напоминает о визите.',
  },
  realty: {
    title: 'ИИ для недвижимости — квалификация лидов 24/7 | Siberi AI',
    desc: 'AI-ассистент для агентства недвижимости: отвечает по базе объектов, квалифицирует покупателей, назначает показы.',
  },
  education: {
    title: 'ИИ для онлайн-школы — поддержка студентов 24/7 | Siberi AI',
    desc: 'Нейросеть для онлайн-школы: отвечает на вопросы по программе, принимает заявки и оплату. Без команды поддержки.',
  },
  shop: {
    title: 'ИИ для интернет-магазина — AI-консультант по каталогу | Siberi AI',
    desc: 'Нейросеть для магазина: знает весь каталог и остатки, отвечает покупателям быстрее менеджера, принимает заказы.',
  },
  beauty: {
    title: 'ИИ для салона красоты — онлайн-запись в Telegram | Siberi AI',
    desc: 'AI-ассистент для мастера красоты: принимает запись, показывает прайс и портфолио, напоминает клиентам. Запуск за вечер.',
  },
  delivery: {
    title: 'ИИ для доставки еды — приём заказов в Telegram | Siberi AI',
    desc: 'Нейросеть для доставки: принимает заказы в Telegram, знает меню и зоны доставки, фиксирует всё в таблице. Без сайта и приложения.',
  },
  travel: {
    title: 'ИИ для турагентства — подбор туров в Telegram 24/7 | Siberi AI',
    desc: 'AI-ассистент для туризма: подбирает туры по бюджету, консультирует по визам и отелям, принимает заявки ночью и в выходные.',
  },
  office: {
    title: 'ИИ для бизнеса и B2B — квалификация лидов и FAQ | Siberi AI',
    desc: 'Нейросеть для B2B-компании: квалифицирует входящие лиды, отвечает сотрудникам и клиентам, интегрируется через REST API.',
  },
  blogger: {
    title: 'ИИ для блогера — продажи курсов в Telegram 24/7 | Siberi AI',
    desc: 'AI-ассистент для блогера: отвечает подписчикам, продаёт курсы и марафоны, принимает оплату — пока вы снимаете контент.',
  },
  auto: {
    title: 'ИИ для автосалона — консультации и тест-драйвы 24/7 | Siberi AI',
    desc: 'Нейросеть для автосалона: консультирует по моделям и комплектациям, записывает на тест-драйв, передаёт горячих лидов менеджеру.',
  },
};

function setMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

// Плавный инерционный вертикальный скролл всего сайта (Lenis, как teleconstructor).
// Десктоп + без reduced-motion. Вложенные скролл-контейнеры (чат, списки) помечены
// data-lenis-prevent — там остаётся нативный скролл.
function SmoothScroll() {
  useEffect(() => {
    const rm = matchMedia('(prefers-reduced-motion:reduce)').matches;
    const desktop = matchMedia('(min-width:900px) and (hover:hover) and (pointer:fine)').matches;
    if (rm || !desktop || !window.Lenis) return;
    const lenis = new window.Lenis({ duration: 1.1, smoothWheel: true, touchMultiplier: 1.6 });
    let raf = requestAnimationFrame(function loop(t) { lenis.raf(t); raf = requestAnimationFrame(loop); });
    return () => { cancelAnimationFrame(raf); lenis.destroy(); };
  }, []);
  return null;
}

function PageTitle() {
  const location = useLocation();
  useEffect(() => {
    const nicheMatch = location.pathname.match(/^\/for\/(\w+)$/);
    const seo = nicheMatch
      ? (NICHE_SEO[nicheMatch[1]] ?? { title: 'ИИ-ассистент для вашей ниши | Siberi AI', desc: DEFAULT_DESC })
      : (PAGE_SEO[location.pathname] ?? { title: DEFAULT_TITLE, desc: DEFAULT_DESC });

    const url = `https://siberi.online${location.pathname === '/' ? '/' : location.pathname}`;
    document.title = seo.title;
    setMeta('name', 'description', seo.desc || DEFAULT_DESC);
    setMeta('name', 'robots', seo.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large, max-snippet:-1');
    setMeta('property', 'og:title', seo.title);
    setMeta('property', 'og:description', seo.desc || DEFAULT_DESC);
    setMeta('property', 'og:url', url);
    setMeta('name', 'twitter:title', seo.title);
    setMeta('name', 'twitter:description', seo.desc || DEFAULT_DESC);

    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', url);
  }, [location.pathname]);
  return null;
}

// Трекер переходов для Яндекс.Метрики (SPA: без этого видит только первый URL)
function MetricaTracker() {
  const location = useLocation();
  const isFirst = useRef(true);
  useEffect(() => {
    // Первый рендер — init уже отправил hit с url из index.html
    if (isFirst.current) { isFirst.current = false; return; }
    try {
      window.ym?.(109332736, 'hit', window.location.href, {
        title: document.title,
        referer: document.referrer,
      });
    } catch {}
  }, [location.pathname]);
  return null;
}

// ── Glassmorphism green toast for system changes ─────────────────────────────
function SystemChangeToast() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handler = (e) => {
      const msg = e.detail?.message || 'Изменения применены';
      const id = Date.now();
      setToasts(prev => [...prev, { id, msg }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
    };
    window.addEventListener('siberi:system-change', handler);
    return () => window.removeEventListener('siberi:system-change', handler);
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="sys-toast-container">
      {toasts.map(t => (
        <div key={t.id} className="sys-toast">{t.msg}</div>
      ))}
    </div>
  );
}

// Следит за активностью пользователя: пингует при смене роута и каждые 5 мин
function ActivityTracker({ apiKey, pingServer }) {
  const location = useLocation();
  const intervalRef = useRef(null);

  useEffect(() => {
    // Пинг при каждом переходе между страницами
    pingServer(apiKey);
  }, [location.pathname]);

  useEffect(() => {
    // Периодический пинг каждые 5 минут пока сайт открыт
    intervalRef.current = setInterval(() => pingServer(apiKey), 5 * 60 * 1000);
    return () => clearInterval(intervalRef.current);
  }, [apiKey]);

  return null;
}

export default App;
