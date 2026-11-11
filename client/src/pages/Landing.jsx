import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import MarkdownText from '../components/MarkdownText';
import ThinkingText from '../components/ThinkingText';
import { useStreamingPoll } from '../hooks/useStreamingPoll';
import './Landing.css';

/* ==========================================================================
   Лендинг Siberi AI — редизайн Total Black.
   Перенос из дизайн-эталона (newdesignsiberi/index.html + script.js + stars.js).
   Данные — статический маркетинговый контент, рендерятся в JSX (SEO/пре-рендер).
   Поведения — React-эффекты; модалки — React-стейт.
   ========================================================================== */

const NICHES = [
  { id: 'cafe', emoji: '🍽️', cat: 'Кафе и доставка', name: 'Принимает заказы сам',
    desc: 'Меню, бронь столика, статус доставки — без звонков.',
    about: 'AI берёт на себя приём заказов и броней: подскажет по меню и акциям, забронирует столик, оформит доставку и сообщит её статус — круглосуточно, без оператора на линии.' },
  { id: 'beauty', emoji: '✂️', cat: 'Бьюти-услуги', name: 'Онлайн-запись без звонков',
    desc: 'Барбершоп, маникюр, салон — запись, цены, напоминания.',
    about: 'AI ведёт онлайн-запись к нужному мастеру, рассказывает об услугах и ценах, показывает свободные окна и напоминает о визите — для барбершопов, маникюра и салонов красоты.' },
  { id: 'realty', emoji: '🏠', cat: 'Недвижимость и авто', name: 'Доводит до сделки',
    desc: 'Подбор, ипотека и кредит, запись на показ.',
    about: 'AI подбирает объекты и авто под бюджет, отвечает по ипотеке, кредиту и трейд-ину, записывает на показ или тест-драйв и передаёт менеджеру уже тёплого, квалифицированного лида.' },
  { id: 'shop', emoji: '🛍️', cat: 'Интернет-магазин', name: 'Знает каталог наизусть',
    desc: 'Подбор товара, наличие, статус заказа.',
    about: 'AI знает весь каталог: помогает выбрать товар, проверяет наличие и характеристики, отслеживает статус заказа и предлагает допродажи, поднимая средний чек.' },
  { id: 'school', emoji: '🎓', cat: 'Онлайн-школы', name: 'Отвечает студентам за вас',
    desc: 'Вопросы по курсам, доступам и оплате.',
    about: 'AI-куратор отвечает на вопросы о программе, доступах и дедлайнах, помогает с оплатой и тарифами и возвращает студентов к обучению — снимая до 80% обращений с поддержки.' },
  { id: 'med', emoji: '🩺', cat: 'Медицина и клиники', name: 'Запись на приём без очередей',
    desc: 'Запись к врачу, услуги, подготовка к приёму.',
    about: 'AI-регистратура записывает к нужному специалисту, рассказывает об услугах и подготовке к приёму, напоминает о визите и собирает обратную связь — телефон больше не занят.' },
  { id: 'b2b', emoji: '🏢', cat: 'B2B и услуги', name: 'AI-сотрудник компании',
    desc: 'База знаний, заявки, ответы по продукту.',
    about: 'AI отвечает по продуктам, услугам и регламентам, помогает сотрудникам и клиентам находить ответ в базе знаний компании и обрабатывает входящие заявки — с доступом по ролям.' },
  { id: 'travel', emoji: '✈️', cat: 'Туризм', name: 'Турагент, что не спит',
    desc: 'Подбор туров, визы, заявки 24/7.',
    about: 'AI подбирает туры под бюджет и даты, отвечает по визам, страховке и перелётам, фиксирует заявки и передаёт горячие лиды менеджеру — в любое время суток.' },
];

const FEATURES = [
  { svg: <><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" /></>,
    name: 'Интеграция куда угодно', desc: 'Telegram / VK / API — за пару минут' },
  { svg: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>,
    name: 'AI на основе ваших данных', desc: 'Каталог, прайс, регламенты' },
  { svg: <><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    name: 'Управление доступом', desc: 'Гибкие права и роли' },
  { svg: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></>,
    name: 'Импорт из любого формата', desc: 'Excel, CSV, Sheets, 1C' },
  { svg: <><path d="M9.94 14.06A2 2 0 0 0 8.5 12.6L2.37 11a.5.5 0 0 1 0-.96L8.5 8.44A2 2 0 0 0 9.94 7L11.52.86a.5.5 0 0 1 .96 0L14.06 7a2 2 0 0 0 1.44 1.44L21.63 10a.5.5 0 0 1 0 .96l-6.13 1.6A2 2 0 0 0 14.06 14l-1.58 6.13a.5.5 0 0 1-.96 0z" /><path d="M20 17v4" /><path d="M22 19h-4" /></>,
    name: 'Схемы данных через промт', desc: 'Опишите структуру словами' },
  { svg: <><path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" /></>,
    name: 'Голосовой ввод', desc: 'Siberi распознаёт голосовые сообщения' },
];

// Роудмап запуска. Формулировки от первого лица «мы сделаем» — это услуга под
// ключ, а не конструктор, который клиент собирает сам. Пункты внутри шага —
// ровный список, а не облако тегов: так видно объём работы, а не пестрота.
const STEPS = [
  {
    n: '01',
    tag: 'Настройка',
    name: 'Соберём AI-сотрудника под вас',
    desc: 'Смотрим, кого он должен заменить, и собираем агента под эти обязанности.',
    rows: [
      'Роль, характер и тон общения',
      'Сценарии продаж, записи и поддержки',
      'Регламенты: что обещать можно, а что нет',
      'Сложное передаёт живому сотруднику',
    ],
    meta: 'Обычно 1–2 дня',
  },
  {
    n: '02',
    tag: 'Данные',
    name: 'Заправим его вашими данными',
    desc: 'Агент отвечает по вашему каталогу и правилам, а не придумывает на ходу.',
    rows: [
      'Excel, CSV, Google Sheets',
      '1С, CRM и amoCRM',
      'Сайт, прайс и документы',
      'Цены и остатки обновляются сами',
    ],
    meta: 'Разово или на постоянной синхронизации',
  },
  {
    n: '03',
    tag: 'Запуск',
    name: 'Поставим его на все каналы',
    desc: 'Один агент отвечает везде одинаково — и там, где у вас своя логика.',
    rows: [
      'Telegram, VK, WhatsApp',
      'Виджет на сайт и мобильное приложение',
      'REST API и вебхуки',
      'Встраивание в вашу серверную логику',
    ],
    meta: 'Работает 24/7 с первого дня',
  },
];

// Тарифы убраны: сервис бесплатный, монетизация — по заявке через форму.
// Демо-диалоги для модалки направления (в женском роде — Siberi).
const DOC = {
  cafe: { chat: [['Здравствуйте! Чем могу помочь?', 0], ['Столик на двоих в 19:00', 1], ['Готово! Забронировала, ждём вас', 0]], chips: ['Предзаказать блюда', 'Как добраться'] },
  beauty: { chat: [['Здравствуйте! Чем могу помочь?', 0], ['Маникюр в субботу', 1], ['Есть окно в 14:00 к мастеру Анне', 0]], chips: ['Записаться', 'Другое время'] },
  realty: { chat: [['Здравствуйте! Чем помочь?', 0], ['Двушка до 8 млн у метро', 1], ['Нашла 6 вариантов, ипотека от 42 000 ₽', 0]], chips: ['Смотреть подбор', 'Запись на показ'] },
  shop: { chat: [['Здравствуйте! Чем помочь?', 0], ['Кроссовки есть в 42?', 1], ['Да, в наличии — доставим завтра', 0]], chips: ['В корзину', 'Похожие'] },
  school: { chat: [['Здравствуйте! Чем помочь?', 0], ['Когда дедлайн модуля 3?', 1], ['До 14 июня — напомню за день', 0]], chips: ['Открыть курс', 'Продлить доступ'] },
  med: { chat: [['Здравствуйте! Чем помочь?', 0], ['Нужен терапевт на завтра', 1], ['Есть приём в 10:30, врач Иванова', 0]], chips: ['Записаться', 'Подготовка'] },
  b2b: { chat: [['Здравствуйте! Чем помочь?', 0], ['Опт от 100 штук?', 1], ['Скидка 12% — подготовлю КП', 0]], chips: ['Получить КП', 'Менеджер'] },
  travel: { chat: [['Здравствуйте! Чем помочь?', 0], ['Турция на двоих, июль, до 200к', 1], ['Подобрала 8 туров «всё включено»', 0]], chips: ['Смотреть туры', 'Вопрос по визе'] },
};
const SAT = {
  cafe: [['Есть столик на двоих в 19:00?', 'Да, на 19:00 свободно'], ['Сколько ждать доставку?', 'Около 40 минут до вас'], ['В пицце есть орехи?', 'Нет, орехов в составе нет'], ['Можно оплатить картой?', 'Да, картой или через СБП']],
  beauty: [['Есть запись на маникюр в субботу?', 'Свободно в 14:00 и 17:00'], ['Сколько стоит стрижка?', 'Стрижка — от 1 500 ₽'], ['Можно перенести визит?', 'Да, конечно — перенесу запись'], ['Вы работаете в воскресенье?', 'Да, с 10:00 до 20:00']],
  realty: [['Есть двушки до 8 млн у метро?', 'Да, есть 6 вариантов'], ['Какой будет платёж по ипотеке?', 'От 42 000 ₽ в месяц'], ['Можно посмотреть квартиру?', 'Да, организую показ'], ['Берёте авто в трейд-ин?', 'Да, зачтём в сделку']],
  shop: [['Эти кроссовки есть в 42?', 'Да, в наличии 2 пары'], ['Когда доставите заказ?', 'Завтра до 18:00'], ['Чем модели отличаются?', 'Материалом верха и весом'], ['Можно вернуть товар?', 'Да, в течение 14 дней']],
  school: [['Что входит в курс?', '12 модулей и практика'], ['Не открывается урок 3', 'Доступ восстановила'], ['До какого числа доступ?', 'До 14 июня включительно'], ['Есть рассрочка?', 'Да, на 6 месяцев без %']],
  med: [['Есть приём к терапевту завтра?', 'Да, в 10:30 и 15:00'], ['Как подготовиться к анализу?', 'Сдавать утром, натощак'], ['Можно перенести приём?', 'Да, перенесу на удобное время'], ['Сколько стоит УЗИ?', 'УЗИ — от 1 800 ₽']],
  b2b: [['Есть скидка на опт?', 'Да, от 100 шт — 12%'], ['Какие сроки поставки?', '3–5 рабочих дней'], ['Можно получить КП?', 'Да, пришлю КП на почту'], ['Работаете с НДС?', 'Да, работаем с НДС']],
  travel: [['Туры в Турцию в июле есть?', 'Да, от 180 000 ₽ на двоих'], ['Нужна ли виза в Турцию?', 'Нет, только загранпаспорт'], ['Что входит в тур?', 'Перелёт, отель и трансфер'], ['Можно с детьми?', 'Да, подберём семейный отель']],
};

const num = (n) => String(n + 1).padStart(2, '0');
const coverSrc = (id, light) => `/covers/${id}${light ? '-light' : ''}.png?v=navy`;

/* ---- реальный демо-чат Siberi (та же логика, что на живом сайте) ---- */
const API_URL = import.meta.env.VITE_API_URL || '/api/v1';
const DEMO_THINKING_PHRASES = ['Думаю', 'Обрабатываю запрос', 'Формулирую ответ', 'Подготавливаю результат', 'Ещё немного'];

function getOrCreateVisitorId() {
  try {
    let id = localStorage.getItem('demo_visitor_id');
    if (!id) { id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); localStorage.setItem('demo_visitor_id', id); }
    return id;
  } catch { return 'v_anon'; }
}
function loadDemoMessages() {
  try {
    const msgs = JSON.parse(localStorage.getItem('demo_messages') || '[]');
    const clean = [];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user' && msgs[i + 1]?.role === 'assistant' && msgs[i + 1].content?.trim().length > 10) { clean.push(msgs[i], msgs[i + 1]); i++; }
    }
    if (clean.length !== msgs.length) localStorage.setItem('demo_messages', JSON.stringify(clean));
    return clean;
  } catch { return []; }
}
function saveDemoMessages(msgs) { try { localStorage.setItem('demo_messages', JSON.stringify(msgs.slice(-10))); } catch { /* noop */ } }

const RobotSvg = () => (
  <svg className="robot__bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
  </svg>
);
const XSvg = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>);
const ChatHead = () => (<div className="chat__head"><span className="a"><svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4" /><circle cx="9" cy="13" r="1.3" stroke="none" /><circle cx="15" cy="13" r="1.3" stroke="none" /></svg></span><b>Siberi AI</b><i></i><span>онлайн</span></div>);

export default function Landing() {
  const navigate = useNavigate();
  const [light] = useState(false); // только тёмная тема — переключатель убран
  const [current, setCurrent] = useState(0);
  const [ctaOpen, setCtaOpen] = useState(false);
  const [docIndex, setDocIndex] = useState(-1);
  const [satShow, setSatShow] = useState(false);
  const [legalKey, setLegalKey] = useState(null);
  const [tg, setTg] = useState(null);
  const [cookieShow, setCookieShow] = useState(false);
  // Стартуем ПУСТЫМ (детерминированно = как в пре-рендере), историю из localStorage
  // подхватываем ПОСЛЕ монтирования — иначе гидратация видит другой текст → React #418.
  const [demoMessages, setDemoMessages] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [demoLimitReached, setDemoLimitReached] = useState(false);
  const isLoggedIn = (() => { try { return !!localStorage.getItem('apiKey'); } catch { return false; } })();
  const visitorId = getOrCreateVisitorId();

  // Роудмап запуска: заполняется по мере прокрутки — станции зажигаются одна за
  // другой, а «готовность» доходит до 100%. Считаем в rAF, чтобы не дёргать
  // ре-рендер на каждом событии скролла.
  const rmRef = useRef(null);
  const [rmProgress, setRmProgress] = useState(0);
  useEffect(() => {
    const el = rmRef.current;
    if (!el) return undefined;
    let raf = 0;
    const calc = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // 0 — блок только выехал снизу; 1 — прошёл примерно до верхней трети экрана
      const span = Math.max(1, r.height * 0.55 + vh * 0.35);
      const p = (vh * 0.82 - r.top) / span;
      setRmProgress(Math.max(0, Math.min(1, p)));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(calc); };
    calc();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  const rmPct = Math.round(rmProgress * 100);
  // Станция «зажглась», когда линия дошла до её узла (узлы стоят на 0 / 50 / 100%).
  const rmReached = (i) => rmProgress >= i / (STEPS.length - 1) - 0.02;

  // Лид-форма «Сделаем за вас»
  const [lead, setLead] = useState({ name: '', contact: '', niche: '', message: '' });
  const [leadSubmitting, setLeadSubmitting] = useState(false);
  const [leadDone, setLeadDone] = useState(false);
  const [leadError, setLeadError] = useState('');

  const { loading: demoLoading, setLoading: setDemoLoading, streamingText: demoStreamText, isStreaming: demoStreaming, startPolling: startDemoPoll } = useStreamingPoll({
    apiKey: null,
    resultPath: '/demo/result/',
    onComplete: (data) => {
      const text = data.result || '';
      if (text) setDemoMessages((prev) => { const u = [...prev, { role: 'assistant', content: text }]; saveDemoMessages(u); return u; });
    },
    onError: () => setDemoMessages((prev) => [...prev, { role: 'assistant', content: 'Не получилось получить ответ. Попробуйте ещё раз 🙂' }]),
  });

  const deckRef = useRef(null);
  const cardRefs = useRef([]);
  const posRef = useRef(0);
  const currentRef = useRef(0);
  const eyesRef = useRef(null);
  const robotRef = useRef(null);
  const bubbleRef = useRef(null);
  const bubbleTextRef = useRef(null);
  const chatRef = useRef(null);
  const starsRef = useRef(null);
  const N = NICHES.length;

  const anyModal = ctaOpen || docIndex >= 0 || !!legalKey || !!tg;

  /* ---- тема ---- */
  useEffect(() => {
    document.body.classList.toggle('light', light);
    try { localStorage.setItem('siberi-theme', light ? 'light' : 'dark'); } catch { /* noop */ }
    window.dispatchEvent(new Event('themechange'));
  }, [light]);

  /* лендинг красит body в total black — метим его, чтобы не зацепить другие страницы */
  useLayoutEffect(() => {
    document.body.classList.add('sb-landing');
    return () => { document.body.classList.remove('sb-landing', 'no-scroll', 'light'); };
  }, []);

  /* ---- блок прокрутки под модалкой ---- */
  useEffect(() => {
    document.body.classList.toggle('no-scroll', anyModal);
    document.documentElement.classList.toggle('no-scroll', anyModal);
  }, [anyModal]);

  /* спутники модалки направления «разлетаются» после открытия */
  useEffect(() => {
    if (docIndex < 0) { setSatShow(false); return; }
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setSatShow(true)));
    return () => cancelAnimationFrame(r);
  }, [docIndex]);

  /* ---- Esc закрывает всё ---- */
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setCtaOpen(false); setDocIndex(-1); setLegalKey(null); setTg(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---- coverflow: раскладка карточек ---- */
  const layout = useCallback((p) => {
    cardRefs.current.forEach((card, i) => {
      if (!card) return;
      const off = i - p; const a = Math.abs(off);
      if (a > 2.5) {
        card.style.opacity = '0'; card.style.pointerEvents = 'none';
        card.style.transform = `translate(-50%,-50%) translateX(${off * 70}%) scale(.5)`;
        return;
      }
      const x = off * 60; const scale = Math.max(1 - a * 0.16, 0.6); const opacity = Math.max(1 - a * 0.55, 0.12);
      card.style.transform = `translate(-50%,-50%) translateX(${x}%) scale(${scale})`;
      card.style.opacity = String(opacity);
      card.style.zIndex = String(20 - Math.round(a));
      card.style.pointerEvents = 'auto';
    });
  }, []);

  const go = useCallback((i) => {
    const c = Math.max(0, Math.min(N - 1, i));
    currentRef.current = c; posRef.current = c;
    setCurrent(c); layout(c);
  }, [N, layout]);

  useEffect(() => { layout(0); }, [layout]);
  useEffect(() => {
    const onResize = () => layout(posRef.current);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [layout]);

  useEffect(() => {
    const onKey = (e) => {
      if (anyModal) return;
      if (e.key === 'ArrowRight') go(currentRef.current + 1);
      else if (e.key === 'ArrowLeft') go(currentRef.current - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, anyModal]);

  /* ---- coverflow: drag/свайп/тап ---- */
  useEffect(() => {
    const deck = deckRef.current; if (!deck) return;
    let dragging = false, startX = 0, startPos = 0, moved = false;
    const widthRef = () => Math.min(window.innerWidth * 0.6, 380);
    const DRAG_START = 10, SWITCH = 0.18;
    const down = (e) => { dragging = true; moved = false; startX = e.clientX; startPos = posRef.current; deck.setPointerCapture(e.pointerId); };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!moved) { if (Math.abs(dx) < DRAG_START) return; moved = true; deck.classList.add('dragging'); }
      let p = startPos - dx / widthRef();
      p = Math.max(-0.4, Math.min(N - 0.6, p)); posRef.current = p; layout(p);
    };
    const end = (e) => {
      if (!dragging) return; dragging = false; deck.classList.remove('dragging');
      if (!moved) {
        const under = e && e.clientX != null ? document.elementFromPoint(e.clientX, e.clientY) : null;
        const openBtn = under && under.closest('.track__open');
        const card = under && under.closest('.track');
        const i = card ? cardRefs.current.indexOf(card) : -1;
        if (i < 0) { go(currentRef.current); return; }
        if (openBtn && i === currentRef.current) { setDocIndex(i); return; }
        go(i); return;
      }
      const d = posRef.current - startPos;
      const target = Math.abs(d) < SWITCH ? Math.round(startPos) : Math.round(posRef.current);
      go(target);
    };
    deck.addEventListener('pointerdown', down);
    deck.addEventListener('pointermove', move);
    deck.addEventListener('pointerup', end);
    deck.addEventListener('pointercancel', end);
    const noDrag = (e) => e.preventDefault();
    deck.addEventListener('dragstart', noDrag);
    return () => {
      deck.removeEventListener('pointerdown', down);
      deck.removeEventListener('pointermove', move);
      deck.removeEventListener('pointerup', end);
      deck.removeEventListener('pointercancel', end);
      deck.removeEventListener('dragstart', noDrag);
    };
  }, [N, go, layout]);

  /* ---- робот: глаза следят за курсором + реплики ---- */
  useEffect(() => {
    // react-snap (пре-рендер) — НЕ запускаем реплики/анимации: иначе текст реплики
    // попадёт в статичный HTML, а при гидратации span пустой → React #418.
    if (typeof navigator !== 'undefined' && /ReactSnap/i.test(navigator.userAgent)) return;
    const eyes = eyesRef.current, robot = robotRef.current;
    const bubble = bubbleRef.current, bText = bubbleTextRef.current;
    if (!eyes || !robot) return;
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0, lock = false;
    const MAXX = 5, MAXY = 3.5;
    const tick = () => {
      cx += (tx - cx) * 0.18; cy += (ty - cy) * 0.18;
      eyes.style.transform = `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px)`;
      raf = (Math.abs(tx - cx) > 0.1 || Math.abs(ty - cy) > 0.1) ? requestAnimationFrame(tick) : 0;
    };
    const look = (ex, ey) => { tx = ex * MAXX; ty = ey * MAXY; if (!raf) raf = requestAnimationFrame(tick); };
    const onMove = (e) => {
      if (lock) return;
      const r = robot.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
      const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      look(Math.max(-1, Math.min(1, dx * 2.4)), Math.max(-1, Math.min(1, dy * 2.4)));
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const MSGS = ['Чем помочь бизнесу?', 'Отвечаю клиентам 24/7', 'Спросите меня о ценах', 'Запишу клиента без звонка', 'Знаю весь ваш каталог', 'Готов к работе ✨'];
    const POS = [{ c: 'pos-tr', ex: 1, ey: -0.7 }, { c: 'pos-r', ex: 1, ey: 0.2 }, { c: 'pos-tl', ex: -1, ey: -0.7 }, { c: 'pos-l', ex: -1, ey: 0.2 }, { c: 'pos-t', ex: 0, ey: -1 }];
    let i = 0, prev = 'pos-tr'; const timers = [];
    const cycle = () => {
      if (!bubble || !bText) return;
      const pos = POS[Math.floor(Math.random() * POS.length)];
      bubble.classList.remove(prev); bubble.classList.add(pos.c); prev = pos.c;
      bText.textContent = MSGS[i++ % MSGS.length];
      bubble.classList.add('show'); lock = true; look(pos.ex, pos.ey);
      timers.push(setTimeout(() => { bubble.classList.remove('show'); lock = false; look(0, 0); }, 3000));
      timers.push(setTimeout(cycle, 4600));
    };
    timers.push(setTimeout(cycle, 1200));
    return () => { window.removeEventListener('pointermove', onMove); if (raf) cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
  }, []);

  /* ---- фон-созвездия (stars canvas) ---- */
  useEffect(() => {
    const canvas = starsRef.current; if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const readStar = () => getComputedStyle(document.body).getPropertyValue('--star').trim() || '255,255,255';
    const isLight = () => document.body.classList.contains('light');
    const LINK = 130, PULL = 150;
    let dpr, dots = [], starRGB = readStar(), raf = 0;
    let mx = -999, my = -999, cx = -999, cy = -999, hasMouse = false;
    const reread = () => requestAnimationFrame(() => { starRGB = readStar(); });
    window.addEventListener('themechange', reread);
    const onMove = (e) => { mx = e.clientX; my = e.clientY; if (!hasMouse) { hasMouse = true; cx = mx; cy = my; } };
    window.addEventListener('mousemove', onMove, { passive: true });
    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
      canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(90, Math.round(innerWidth / 18));
      dots = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22, r: Math.random() * 1.4 + 0.5 }));
    };
    const paint = (alive) => {
      const link = isLight() ? starRGB : '212,132,92';
      for (let i = 0; i < dots.length; i++) {
        const p = dots[i];
        if (alive) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > innerWidth) p.vx *= -1; if (p.y < 0 || p.y > innerHeight) p.vy *= -1; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fillStyle = `rgba(${starRGB},.55)`; ctx.fill();
        for (let j = i + 1; j < dots.length; j++) {
          const q = dots[j], d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d > LINK) continue;
          ctx.globalAlpha = (1 - d / LINK) * 0.22; ctx.strokeStyle = `rgb(${link})`; ctx.lineWidth = 0.6;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
        if (alive && hasMouse) {
          const d = Math.hypot(p.x - cx, p.y - cy);
          if (d < PULL) { ctx.globalAlpha = (1 - d / PULL) * 0.5; ctx.strokeStyle = `rgb(${link})`; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(cx, cy); ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
      }
    };
    const frame = () => { raf = requestAnimationFrame(frame); cx += (mx - cx) * 0.12; cy += (my - cy) * 0.12; ctx.clearRect(0, 0, innerWidth, innerHeight); paint(true); };
    window.addEventListener('resize', resize, { passive: true });
    resize();
    if (reduce) { ctx.clearRect(0, 0, innerWidth, innerHeight); paint(false); } else frame();
    return () => { window.removeEventListener('themechange', reread); window.removeEventListener('mousemove', onMove); window.removeEventListener('resize', resize); if (raf) cancelAnimationFrame(raf); };
  }, []);

  /* ---- cookie-баннер ---- */
  useEffect(() => {
    let saved = null; try { saved = localStorage.getItem('siberi-cookie-consent'); } catch { /* noop */ }
    if (saved) return;
    const t = setTimeout(() => setCookieShow(true), 900);
    return () => clearTimeout(t);
  }, []);
  const cookieChoose = (val) => { try { localStorage.setItem('siberi-cookie-consent', val); } catch { /* noop */ } setCookieShow(false); };

  /* Демо на /about всегда ПУСТОЕ при заходе на страницу: не подгружаем прошлый
     диалог и чистим старую историю из localStorage. */
  useEffect(() => { try { localStorage.removeItem('demo_messages'); } catch { /* noop */ } }, []);

  /* ---- демо-чат: подгон высоты ---- */
  const growChat = useCallback(() => {
    const chat = chatRef.current; if (!chat) return;
    // Высоту больше не режем — блок растёт под контент и листается страницей (вложенный
    // скролл колесо не ловил). Во время печати мягко доводим низ блока до вида, но ТОЛЬКО
    // если человек и так внизу страницы: листает вверх читать — не мешаем.
    const nearPageBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
    if ((demoLoading || demoStreaming) && nearPageBottom) {
      const b = chat.getBoundingClientRect().bottom;
      if (b > window.innerHeight - 90) window.scrollBy({ top: b - (window.innerHeight - 90), behavior: 'smooth' });
    }
  }, [demoLoading, demoStreaming]);
  useEffect(() => { growChat(); }, [demoMessages, demoStreamText, demoLoading, growChat]);

  // Реальная логика: залогиненный → в его чат с предзаполнением; иначе демо через /demo/chat.
  const handleTestAI = async (e) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || demoLoading) return;
    if (isLoggedIn) { navigate('/chat', { state: { prefill: text } }); return; }
    if (demoLimitReached) { navigate('/login'); return; }

    const contextHistory = demoMessages.slice(-4);
    const next = [...demoMessages, { role: 'user', content: text }];
    setDemoMessages(next); saveDemoMessages(next);
    setPrompt('');
    setDemoLoading(true);
    try {
      // source:'app_chat' → тот же быстрый провайдер (UltraGPT) и та же отрисовка, что
      // в /app: демо на лендинге печатает так же мгновенно и красиво, а не по 10 секунд.
      const { data } = await axios.post(`${API_URL}/demo/chat`, { visitorId, message: text, history: contextHistory, source: 'app_chat' }, { timeout: 30000 });
      if (data.limitReached) {
        setDemoLimitReached(true); setDemoLoading(false);
        setDemoMessages((p) => { const u = [...p, { role: 'assistant', content: 'Вы уже попробовали демо — и, кажется, почувствовали вкус 😉 Зарегистрируйтесь и получите персонального AI-ассистента, который знает именно ваш бизнес.' }]; saveDemoMessages(u); return u; });
        return;
      }
      if (data.remaining === 0) setDemoLimitReached(true);
      startDemoPoll(data.taskId);
    } catch {
      setDemoLoading(false);
      setDemoMessages((p) => [...p, { role: 'assistant', content: 'Упс, мы сейчас немного перегружены 🙈 Попробуйте через минуту.' }]);
    }
  };
  const onInputKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTestAI(e); } };

  /* ---- переход в Telegram (перехват t.me) ---- */
  const openTg = (e, href) => {
    e.preventDefault();
    const domain = href.replace(/\/+$/, '').split('/').pop();
    setTg({ domain, appOnly: /^siberimanager$/i.test(domain) });
  };

  const handleLeadSubmit = async (e) => {
    e.preventDefault();
    if (!lead.contact.trim()) { setLeadError('Оставьте контакт, чтобы мы связались.'); return; }
    setLeadSubmitting(true); setLeadError('');
    try {
      await axios.post(`${API_URL}/lead`, { ...lead, source: 'landing' }, { timeout: 12000 });
      setLeadDone(true);
    } catch (err) {
      setLeadError(err?.response?.data?.error || 'Не удалось отправить. Попробуйте ещё раз.');
    } finally { setLeadSubmitting(false); }
  };

  const goStart = () => { setCtaOpen(false); navigate('/login'); };

  const doc = docIndex >= 0 ? NICHES[docIndex] : null;
  const docData = doc ? (DOC[doc.id] || { chat: [], chips: [] }) : null;

  return (
    <>

      {/* ВЕРХНЯЯ ПАНЕЛЬ */}
      <header className="topbar">
        <a className="brand brand--back" href="/app" aria-label="В чат Siberi" onClick={(e) => { e.preventDefault(); navigate('/app'); }}>
          <span className="brand__chev" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
          </span>
          <img className="brand__logo" src="/siberi-logo.webp" alt="" width="34" height="34" />
          <span className="brand__name">Siberi</span>
        </a>
        <div className="topbar__ctl">
          <button className="cta-btn" type="button" onClick={() => setCtaOpen(true)}>Оставить заявку</button>
        </div>
      </header>

      {/* ЭКРАН-ВИТРИНА */}
      <main className="stage" id="top">
        <section className="hero">
          <div className="hero__head">
            <h1 className="hero__title">Настроим AI, который работает <span className="hero__brandword">за вас</span></h1>
            <p className="hero__sub">Отвечает клиентам, записывает и продаёт 24/7. Вы ставите задачу — внедрение под ключ берём на себя.</p>
          </div>

          {/* Демо-чат */}
          <div className="demo" id="demo">
            <div className="demo__head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 17a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2z" /></svg>
              <span>Протестируйте AI прямо сейчас</span>
            </div>
            <div className={`demo__chat${demoMessages.length || demoLoading ? ' on' : ''}`} ref={chatRef} aria-live="polite">
              {demoMessages.map((m, i) => (
                <div key={i} className={`demo__msg demo__msg--${m.role === 'user' ? 'user' : 'ai'}`}>
                  {m.role === 'user' ? m.content : <MarkdownText text={m.content} isAi={true} />}
                </div>
              ))}
              {demoStreaming && (
                <div className="demo__msg demo__msg--ai"><MarkdownText text={demoStreamText} isAi={true} /><span className="streaming-cursor" aria-hidden="true" /></div>
              )}
              {demoLoading && !demoStreaming && (
                <div className="demo__msg demo__msg--ai"><ThinkingText phrases={DEMO_THINKING_PHRASES} /></div>
              )}
            </div>
            <form className="demo__form" onSubmit={handleTestAI}>
              <textarea rows="1" placeholder="Задайте любой вопрос…" autoComplete="off" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onInputKey} disabled={demoLoading} />
              <button className="demo__send" type="submit" aria-label="Отправить" disabled={!prompt.trim() || demoLoading}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>
              </button>
            </form>
            <span className="demo__hint">Enter — отправить · в прототипе ответ демонстрационный</span>
          </div>

          <aside className="caps" aria-label="Для кого Siberi">
            <div className="caps__row"><span className="caps__label">Для клиента в любой час</span><span className="caps__more"><span>чтобы ответ приходил и ночью, и в выходной&nbsp;— Siberi на связи 24/7, без пропущенных обращений.</span></span></div>
            <div className="caps__row"><span className="caps__label">Для запуска без кода</span><span className="caps__more"><span>чтобы собрать ассистента за один вечер&nbsp;— опишите задачу словами, без разработчиков и интеграторов.</span></span></div>
            <div className="caps__row"><span className="caps__label">Для живого диалога</span><span className="caps__more"><span>чтобы ассистент отвечал голосом вашего бренда&nbsp;— по вашим данным, а сложное передавал живому сотруднику.</span></span></div>
          </aside>

          <button className="scroll-down" aria-label="Листать вниз" title="Листать вниз" onClick={() => document.getElementById('portfolio')?.scrollIntoView({ behavior: 'smooth' })}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </section>
      </main>

      {/* ПОРТФОЛИО (coverflow) */}
      <section className="portfolio" id="portfolio">
        <div className="block__head">
          <span className="block__kicker">Портфолио</span>
          <h2 className="block__title">Уже работает в этих направлениях</h2>
          <p className="block__lead">Готовый AI-сценарий под каждое направление.</p>
        </div>
        <section className="player" aria-label="Сценарии для бизнеса">
          <button className="nav-btn nav-btn--prev" aria-label="Предыдущий" disabled={current === 0} onClick={() => go(current - 1)}><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg></button>
          <div className="deck" ref={deckRef}>
            {NICHES.map((p, i) => (
              <article key={p.id} className={`track${i === current ? ' active' : ''}`} ref={(el) => { cardRefs.current[i] = el; }}>
                <div className="track__card">
                  <div className="track__art">
                    <span className="track__emoji">{p.emoji}</span>
                    <img className="track__img" src={coverSrc(p.id, light)} alt="" loading="lazy"
                      onLoad={(e) => e.currentTarget.classList.add('ok')}
                      onError={(e) => { e.currentTarget.closest('.track__art')?.classList.add('noimg'); e.currentTarget.remove(); }} />
                  </div>
                  <span className="track__cat">{p.cat}</span>
                  <h2 className="track__name">{p.name}</h2>
                  <p className="track__desc">{p.desc}</p>
                  <button className="track__open" type="button" onClick={() => setDocIndex(i)}>Подробнее <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
                </div>
              </article>
            ))}
          </div>
          <button className="nav-btn nav-btn--next" aria-label="Следующий" disabled={current === N - 1} onClick={() => go(current + 1)}><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg></button>
        </section>
        <div className="dots">
          {NICHES.map((p, i) => (<button key={p.id} aria-label={`Направление ${i + 1}`} className={i === current ? 'on' : ''} onClick={() => go(i)} />))}
        </div>
        <footer className="hero__foot">
          <span className="counter">{num(current)} / {num(N - 1)}</span>
          <button className="cta-btn cta-btn--lg" type="button" onClick={() => setCtaOpen(true)}>Обсудить мой бизнес</button>
        </footer>
      </section>

      {/* ВОЗМОЖНОСТИ + ЗАПУСК + CTA */}
      <section className="combo" id="more">
        <div className="combo__inner">
          <div className="combo__block">
            <div className="block__head"><span className="block__kicker">Возможности</span><h2 className="block__title">Всё что нужно — уже внутри</h2></div>
            <div className="grid grid--features">
              {FEATURES.map((f, i) => (
                <div className={`feat${i === 0 || i === 5 ? ' feat--wide' : ''}`} key={i}>
                  <span className="feat__ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{f.svg}</svg></span>
                  <div className="feat__body">
                    <div className="feat__name">{f.name}</div>
                    <div className="feat__desc">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ЗАПУСК — роудмап: линия заполняется по мере прокрутки, станции зажигаются */}
      <section className="launch" id="launch">
        <div className="launch__inner">
          <div className="block__head">
            <span className="block__kicker">Запуск</span>
            <h2 className="block__title">Три шага до вашего AI</h2>
            <p className="block__lead">Всю работу берём на себя — от разбора задачи до запуска в ваших каналах.</p>
          </div>

          <div className={`rm${rmPct >= 100 ? ' rm--done' : ''}`} ref={rmRef} style={{ '--rm': rmProgress }}>
            <div className="rm__meter">
              <span className="rm__meter-cap">Готовность вашего AI</span>
              <div className="rm__meter-bar"><i /></div>
              <span className="rm__meter-val">{rmPct}<i>%</i></span>
            </div>

            <div className="rm__flow">
              <div className="rm__rail" aria-hidden="true">
                <i className="rm__rail-fill" />
                <i className="rm__rail-pulse" />
              </div>
              <ol className="rm__track">
              {STEPS.map((s, i) => (
                <li className={`rm__stop${rmReached(i) ? ' is-on' : ''}${rmProgress >= Math.min(.99, (i + 1) / STEPS.length) ? ' is-done' : ''}`} key={s.n}>
                  <div className="rm__node">
                    <span className="rm__num">{s.n}</span>
                    <svg className="rm__tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
                  </div>
                  <div className="rm__card">
                    <span className="rm__tag">{s.tag}</span>
                    <h3 className="rm__name">{s.name}</h3>
                    <p className="rm__desc">{s.desc}</p>
                    <ul className="rm__list">
                      {s.rows.map((c) => (
                        <li key={c}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                    <span className="rm__meta">{s.meta}</span>
                  </div>
                </li>
              ))}
              </ol>
            </div>

            <div className="rm__finish">
              <span className="rm__finish-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 22V4M4 4h13l-2 4 2 4H4" /></svg></span>
              <span className="rm__finish-text">AI в работе — отвечает клиентам 24/7</span>
            </div>
          </div>

          <div className="combo__cta">
            <h2 className="finale__title">Внедрим AI в ваш бизнес — под ключ</h2>
            <button className="cta-btn cta-btn--lg" type="button" onClick={() => setCtaOpen(true)}>Оставить заявку</button>
          </div>
        </div>

        <footer className="foot">
          <div className="foot__top">
            <span className="foot__brand">SIBERI.AI</span>
            <span className="foot__trust"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>Ваши данные защищены · 152-ФЗ</span>
          </div>
          <div className="foot__bottom">
            <span className="foot__copy">© 2026 · Нейросеть для бизнеса</span>
            <nav className="foot__links">
              <button className="foot__link" type="button" onClick={() => setLegalKey('oferta')}>Публичная оферта</button>
              <button className="foot__link" type="button" onClick={() => setLegalKey('privacy')}>Политика конфиденциальности</button>
              <a className="foot__mail" href="mailto:hello@siberi.online">hello@siberi.online</a>
            </nav>
          </div>
        </footer>
      </section>

      {/* Модалка направления */}
      <div className={`doc${docIndex >= 0 ? ' open' : ''}`} aria-hidden={docIndex < 0}>
        <div className="doc__backdrop" onClick={() => setDocIndex(-1)}></div>
        <div className={`doc__sats${satShow ? ' show' : ''}`} aria-hidden="true">
          {doc && (SAT[doc.id] || []).map(([q, a], k) => (
            <div className="sat" style={{ '--i': k + 1 }} key={k}>
              <ChatHead />
              <div className="sat__msg sat__msg--me">{q}</div>
              <div className="sat__msg sat__msg--ai">{a}</div>
            </div>
          ))}
        </div>
        <div className="doc__card" role="dialog" aria-modal="true" aria-label="Сценарий для бизнеса">
          <button className="doc__x" aria-label="Закрыть" onClick={() => setDocIndex(-1)}><XSvg /></button>
          <div className="doc__hero">
            {docData && (<>
              <ChatHead />
              {docData.chat.map(([t, me], k) => (<div className={`doc__msg doc__msg--${me ? 'me' : 'ai'}`} key={k}>{t}</div>))}
              {docData.chips?.length > 0 && (<div className="doc__chips">{docData.chips.map((x, k) => <span className="doc__chip" key={k}>{x}</span>)}</div>)}
            </>)}
          </div>
          <div className="doc__body">
            <span className="doc__cat">{doc?.cat}</span>
            <h3 className="doc__title">{doc?.name}</h3>
            <p className="doc__about">{doc?.about || doc?.desc}</p>
            <button className="cta-btn cta-btn--block" type="button" onClick={() => { setDocIndex(-1); setCtaOpen(true); }}>Интеграция</button>
          </div>
        </div>
      </div>

      {/* Модалка CTA — заявка на роботозамещение */}
      <div className={`modal modal--lead${ctaOpen ? ' open' : ''}`} aria-hidden={!ctaOpen}>
        <div className="modal__backdrop" onClick={() => setCtaOpen(false)}></div>
        <div className="modal__card" role="dialog" aria-modal="true" aria-label="Заявка на внедрение AI">
          <button className="modal__x" aria-label="Закрыть" onClick={() => setCtaOpen(false)}><XSvg /></button>
          <img className="lead-logo" src="/siberi-logo.webp" alt="" width="96" height="96" />
          {leadDone ? (
            <>
              <h3 className="modal__title">Заявка принята ✓</h3>
              <p className="modal__text">Свяжемся в ближайшее время, посчитаем, каких сотрудников закроет AI-агент и во сколько это обойдётся.</p>
              <button className="modal__btn" type="button" onClick={() => setCtaOpen(false)}>Готово</button>
            </>
          ) : (
            <>
              <span className="lead-kicker">Роботозамещение</span>
              <h3 className="modal__title">AI-агент вместо штата сотрудников</h3>
              <p className="modal__text">
                Один агент закрывает менеджера, администратора и оператора: отвечает, консультирует, записывает
                и продаёт 24/7 — без зарплаты, отпусков и текучки.
              </p>
              <p className="modal__text modal__text--sub">
                Оставьте заявку — свяжемся, разберём вашу бизнес-модель, найдём где AI даст максимум
                и предложим оптимальное решение. Всё обсудим и рассчитаем — без обязательств.
              </p>
              <ul className="lead-facts">
                <li><b>24/7</b><span>без выходных</span></li>
                <li><b>0 ₽</b><span>зарплаты и налогов</span></li>
                <li><b>2 сек</b><span>ответ клиенту</span></li>
              </ul>
              <form className="lead-form" onSubmit={handleLeadSubmit}>
                <input className="lead-input" type="text" placeholder="Ваше имя" value={lead.name} onChange={(e) => setLead((v) => ({ ...v, name: e.target.value }))} autoComplete="name" />
                <input className="lead-input" type="text" placeholder="Телефон, Telegram или e-mail" value={lead.contact} onChange={(e) => setLead((v) => ({ ...v, contact: e.target.value }))} autoComplete="tel" />
                <input className="lead-input" type="text" placeholder="Сфера бизнеса" value={lead.niche} onChange={(e) => setLead((v) => ({ ...v, niche: e.target.value }))} />
                <textarea className="lead-input lead-textarea" rows="2" placeholder="Кого хотите заменить или что автоматизировать" value={lead.message} onChange={(e) => setLead((v) => ({ ...v, message: e.target.value }))} />
                {leadError && <div className="lead-error">{leadError}</div>}
                <button className="modal__btn" type="submit" disabled={leadSubmitting}>{leadSubmitting ? 'Отправляем…' : 'Хочу AI-сотрудника'}</button>
              </form>
            </>
          )}
        </div>
      </div>

      {/* Попап перехода в Telegram */}
      <div className={`modal${tg ? ' open' : ''}`} aria-hidden={!tg}>
        <div className="modal__backdrop" onClick={() => setTg(null)}></div>
        <div className="modal__card" role="dialog" aria-modal="true" aria-label="Открыть Telegram">
          <button className="modal__x" aria-label="Закрыть" onClick={() => setTg(null)}><XSvg /></button>
          <div className="modal__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg></div>
          <h3 className="modal__title">Открыть Telegram?</h3>
          <p className="modal__text">Перейдём в Telegram — <b style={{ color: 'var(--text)' }}>@{tg?.domain}</b>.</p>
          <button className="modal__btn" onClick={() => { const d = tg.domain; setTg(null); window.location.href = 'tg://resolve?domain=' + d; }}>Открыть приложение</button>
          {!tg?.appOnly && <button className="modal__alt" onClick={() => { const d = tg.domain; setTg(null); window.open('https://t.me/s/' + d, '_blank', 'noopener'); }}>Открыть в браузере</button>}
        </div>
      </div>

      {/* Попап документа (оферта / политика) */}
      <div className={`legal${legalKey ? ' open' : ''}`} aria-hidden={!legalKey}>
        <div className="legal__backdrop" onClick={() => setLegalKey(null)}></div>
        <div className="legal__card" role="dialog" aria-modal="true" aria-label="Документ">
          <header className="legal__head">
            <h2 className="legal__title">{legalKey === 'oferta' ? 'Публичная оферта' : 'Политика конфиденциальности'}</h2>
            <div className="legal__actions">
              <a className="legal__open" href={legalKey === 'oferta' ? '/oferta' : '/privacy'} target="_blank" rel="noopener">Открыть на отдельной странице<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></svg></a>
              <button className="legal__x" aria-label="Закрыть" onClick={() => setLegalKey(null)}><XSvg /></button>
            </div>
          </header>
          <div className="legal__body">
            <p>Полный текст документа открывается на отдельной странице — нажмите «Открыть на отдельной странице» выше.</p>
          </div>
        </div>
      </div>

      {/* Cookie / согласие 152-ФЗ */}
      <div className={`cookie${cookieShow ? ' show' : ''}`} aria-hidden={!cookieShow}>
        <div className="cookie__ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z" /><path d="M8.5 9.5h.01M15 13h.01M10 15.5h.01" /></svg></div>
        <p className="cookie__text">Мы используем cookie и обрабатываем данные для работы сайта и аналитики. Продолжая, вы соглашаетесь с <button className="cookie__link" type="button" onClick={() => setLegalKey('privacy')}>политикой конфиденциальности</button> (152-ФЗ).</p>
        <div className="cookie__btns">
          <button className="cookie__btn cookie__btn--ghost" type="button" onClick={() => cookieChoose('necessary')}>Только необходимые</button>
          <button className="cookie__btn cookie__btn--primary" type="button" onClick={() => cookieChoose('all')}>Принять</button>
        </div>
      </div>
    </>
  );
}
