import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Globe,
  Inbox,
  MessageSquare,
  RotateCcw,
  Shield,
  Timer,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTutorial } from '../context/TutorialContext';
import './ControlPanel.css';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace(/\/api\/v1$/, '');

const TUTORIAL_STEPS = [
  {
    selector: null,
    text: 'Добро пожаловать в Siberi AI! 👋\n\nЧтобы запустить AI-ассистента с нуля, нужно всего 3 шага. Давайте пройдём их вместе — займёт не больше 5 минут.',
  },
  {
    selector: 'a[href="/settings"]',
    text: 'Прежде всего — загляните в «Настройки AI».\n\nПосле регистрации для вас автоматически создан первый профиль — «Основной профиль». Всё, что вы будете настраивать: данные, поведение бота, правила ответов — привязано именно к нему.\n\nЗайдите и дайте профилю понятное имя, например «Барбершоп» или «Кофейня». Позже вы сможете создать несколько профилей — для разных направлений или аудиторий.',
  },
  {
    selector: 'a[href="/chat"]',
    text: 'Шаг 1 — Заполните базу знаний.\n\nНажмите «Чат с нейросетью» и напишите AI:\n\n«Создай и заполни примерами все нужные схемы данных для [опишите ваш бизнес]»\n\nAI соберёт структуру за 30 секунд. Потом проверьте «Мои данные» — там уже будет готовая база.',
  },
  {
    selector: 'a[href="/chat"]',
    text: '✨ Магия Siberi AI — вы можете управлять всем при помощи промтов.\n\nAI в чате не просто отвечает — он действует прямо из диалога:\n\n• «Добавь запись в меню: стейк, 890 руб» — появится в «Мои данные»\n• «Измени промт — работаем до 22:00» — настройки обновятся мгновенно\n• «Покажи все заявки за сегодня» — AI выгрузит выборку прямо в чат\n\nЭто работает и для ваших клиентов — через разговор с ботом. А в «Настройках AI» вы сами решаете, что пользователь может узнать или изменить, что доступно администратору, а что — только вам как создателю.',
  },
  {
    selector: 'a[href="/studio"]',
    text: 'Шаг 2 — Настройте Telegram-бота (если нужен).\n\nНажмите «Bot Studio» и напишите в нижнее поле:\n\n«Настрой меню бота для [описание бизнеса], учти все нюансы ниши»\n\nAI настроит приветствие, команды и логику — бот будет готов к публикации.',
  },
  {
    selector: 'a[href="/integrations"]',
    text: 'Шаг 3 — Подключите к нужному каналу.\n\nНажмите «Интеграции»:\n\n• «Без кода» — Telegram-бот, VK, виджет на сайт. Никакого сервера и хостинга — мы берём это на себя, бот работает 24/7 без вашего участия\n• «Для разработчиков» — REST API, SDK и Webhook для кастомных сценариев\n\nВыберите платформу → укажите профиль AI → следуйте инструкции. Готово!',
  },
  {
    selector: '.stats',
    text: 'Ваша статистика в реальном времени:\n\n• Всего запросов — сколько раз пользователи обратились к AI\n• За 7 дней — динамика активности\n• Интеграций подключено — сколько каналов работает',
  },
  {
    selector: '.side__acc',
    text: 'Кнопка 👤 — быстрый доступ к основным опциям:\n\n• Автопродление подписки\n• Подсказки — включить или выключить этот туториал\n• Стать партнёром — реферальная программа с выплатами',
  },
  {
    selector: '.fc-trigger',
    text: 'Кнопка внизу справа — мини-чат.\n\nДля удобства вы можете открыть его и писать промты, не покидая текущей страницы. Контекст и история аналогичны основному «Чату с нейросетью».\n\n• AI — ваш ассистент\n• Поддержка — онлайн-консультант Siberi AI',
  },
  {
    selector: 'a[href="/partner"]',
    text: '«Стать партнёром» — реферальная программа.\n\nПолучайте 20% от платежей каждого приглашённого вами пользователя — пассивный доход за рекомендации.',
  },
  {
    selector: '.side__api',
    text: 'Ваш API-ключ — для прямых запросов к Siberi AI из кода или сторонних сервисов.\n\nНажмите «Копировать», чтобы поместить ключ в буфер обмена для вставки.',
  },
  {
    selector: '.cp-tabs-left',
    text: 'Три раздела:\n\n• «История» — полный лог диалогов с датой и платформой\n• «Пользователи» — все, кто обращался к боту\n• «Заблокированные» — управление ограниченным доступом',
  },
  {
    selector: '.cp-profile-select',
    text: 'Фильтр по профилю — если у вас несколько AI-профилей, смотрите активность каждого отдельно или сразу всех.',
  },
  {
    selector: '.cp-panel',
    text: 'История запросов — нажмите на строку, чтобы раскрыть полный диалог: запрос пользователя, ответ AI, платформа и время.\n\n🔄 Кнопка «Откатить» вернёт данные сайта к состоянию до этого запроса — если бот что-то изменил не так.',
  },
  {
    selector: null,
    text: 'Мы всегда рады обратной связи!\n\nЕсли что-то не так, есть идея или хочется поделиться впечатлениями — напишите нам:\n\nВаш фидбек напрямую влияет на развитие Siberi AI. Спасибо, что вы с нами!',
    email: 'hello@siberi.online',
  },
];

const PLATFORM_LABELS = {
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  web: 'Web',
  api: 'API',
  other: 'Другое',
  demo: 'Демо',
  studio: 'Bot Studio',
};

const PLATFORM_COLORS = {
  telegram: '#2aabee',
  vk: '#4a76a8',
  web: '#667eea',
  api: '#764ba2',
  other: '#94a3b8',
  demo: '#10b981',
};

function ProfileSelect({ profiles, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = profiles.find(p => p._id === value) || null;

  useEffect(() => {
    const onOut = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, []);

  const pick = (id) => { onChange(id); setOpen(false); };

  return (
    <div className="cp-profile-select" ref={ref}>
      <button
        type="button"
        className="cp-profile-select__trigger"
        style={selected?.color ? { '--sel-color': selected.color } : {}}
        onClick={() => setOpen(o => !o)}
      >
        {selected?.color && <span className="cp-profile-dot" style={{ background: selected.color }} />}
        <span>{selected ? (selected.profileName || selected.aiName || 'Профиль') : 'Все профили'}</span>
        <ChevronDown size={14} className={`cp-profile-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div className="cp-profile-select__menu">
          <button className={`cp-profile-option${!value ? ' active' : ''}`} onClick={() => pick('')}>
            Все профили
          </button>
          {profiles.map(p => (
            <button
              key={p._id}
              className={`cp-profile-option${value === p._id ? ' active' : ''}`}
              style={p.color ? { '--opt-color': p.color } : {}}
              onClick={() => pick(p._id)}
            >
              {p.color && <span className="cp-profile-dot" style={{ background: p.color }} />}
              {p.profileName || p.aiName || 'Профиль'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LEAD_STATUS = {
  new:       { label: 'Новая',    color: '#10b981' },
  contacted: { label: 'В работе', color: '#3b82f6' },
  won:       { label: 'Успех',    color: '#22c55e' },
  lost:      { label: 'Отказ',    color: '#94a3b8' },
};
const LEAD_STATUS_ORDER = ['new', 'contacted', 'won', 'lost'];

function PlatformBadge({ platform }) {
  const label = PLATFORM_LABELS[platform] || platform;
  const color = PLATFORM_COLORS[platform] || '#94a3b8';
  return (
    <span className="cp-platform-badge" style={{ background: `${color}18`, color }}>
      {platform === 'telegram' || platform === 'vk' ? (
        <MessageSquare size={11} />
      ) : (
        <Globe size={11} />
      )}
      {label}
    </span>
  );
}

// ── График активности (перенесён с «Обзора» при слиянии) ────────────────────
// Разметка и сглаживание — как в эталоне (sparkChart, Catmull-Rom→Безье).
// Цвета БЕЗ хардкода: в Обзоре линия была фиолетовым градиентом #667eea→#764ba2,
// а кабинет строго монохромный — заливка тянется из var(--text), линия/точки
// красятся классами .spk__line/.spk__dot из Layout.css.
const SPK_W = 600, SPK_H = 150, SPK_PAD_X = 6, SPK_PAD_T = 16, SPK_PAD_B = 8;

function sparkPaths(vals) {
  const n = vals.length;
  if (n < 2) return null;
  const max = Math.max(...vals), min = Math.min(...vals);
  const x = (i) => SPK_PAD_X + (i * (SPK_W - 2 * SPK_PAD_X)) / (n - 1);
  const y = (v) => SPK_PAD_T + (1 - (v - min) / (max - min || 1)) * (SPK_H - SPK_PAD_T - SPK_PAD_B);
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const f = (z) => z.toFixed(1);
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return { line: d, area: `${d} L ${f(x(n - 1))} ${SPK_H} L ${f(x(0))} ${SPK_H} Z`, pts };
}

function formatMs(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}мс`;
  return `${(ms / 1000).toFixed(1)}с`;
}

function shortDay(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ru-RU', { weekday: 'short' });
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function truncate(str, n = 80) {
  if (!str) return '—';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ControlPanel({ apiKey }) {
  const { enabled, startTutorial, isActive, skipped, completedPaths } = useTutorial();
  const [tab, setTab]           = useState('history');
  const [stats, setStats]       = useState(null);
  const [activity, setActivity] = useState(null);
  const [sparkHover, setSparkHover] = useState(null);

  // История
  const [history, setHistory]   = useState([]);
  const [histPage, setHistPage] = useState(1);
  const [histTotal, setHistTotal] = useState(0);
  const [histPages, setHistPages] = useState(1);
  const [histFilter, setHistFilter] = useState(''); // profileId filter
  const [expandedId, setExpandedId] = useState(null);
  const [histLoading, setHistLoading] = useState(false);

  // Профили
  const [profiles, setProfiles] = useState([]);

  // Пользователи
  const [users, setUsers]       = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // Заблокированные
  const [blocked, setBlocked]   = useState([]);

  // Заявки (видны только администратору сайта)
  const [isSiteAdmin, setIsSiteAdmin] = useState(false);
  const [leads, setLeads]       = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadNewCount, setLeadNewCount] = useState(0);

  // Модалка отката
  const [rollbackTask, setRollbackTask] = useState(null);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackResult, setRollbackResult] = useState(null);

  // Модалка блокировки
  const [blockTarget, setBlockTarget] = useState(null); // { platform, platformUserId }
  const [blockReason, setBlockReason] = useState('');
  const [blockLoading, setBlockLoading] = useState(false);

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // ── Загрузка данных ─────────────────────────────────────────────────────────

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/panel/stats`, { headers });
      if (r.ok) setStats(await r.json());
    } catch {}
  }, [apiKey]);

  // Активность + среднее время ответа — переехали сюда с «Обзора» при его
  // слиянии с Мониторингом (в эталоне отдельного Обзора нет). Оба показателя
  // приходят одним ответом /stats/activity.
  const loadActivity = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/stats/activity`, { headers });
      if (!r.ok) return;
      const d = await r.json();
      if (d.success) setActivity(d);
    } catch {}
  }, [apiKey]);

  const loadProfiles = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/profiles`, { headers });
      if (r.ok) setProfiles((await r.json()).profiles || []);
    } catch {}
  }, [apiKey]);

  const loadHistory = useCallback(async (page = 1, profileId = '') => {
    setHistLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 20 });
      if (profileId) params.set('profileId', profileId);
      const r = await fetch(`${API_BASE}/api/v1/panel/history?${params}`, { headers });
      if (r.ok) {
        const data = await r.json();
        setHistory(data.tasks || []);
        setHistTotal(data.total || 0);
        setHistPages(data.pages || 1);
      }
    } catch {}
    setHistLoading(false);
  }, [apiKey]);

  const loadUsers = useCallback(async (profileId = '') => {
    setUsersLoading(true);
    try {
      const params = new URLSearchParams();
      if (profileId) params.set('profileId', profileId);
      const r = await fetch(`${API_BASE}/api/v1/panel/users?${params}`, { headers });
      if (r.ok) setUsers((await r.json()).users || []);
    } catch {}
    setUsersLoading(false);
  }, [apiKey]);

  const loadBlocked = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/v1/panel/blocked`, { headers });
      if (r.ok) setBlocked((await r.json()).blocked || []);
    } catch {}
  }, [apiKey]);

  // Заявки видит только админ сайта. Пробуем загрузить: успех = мы админ,
  // показываем вкладку; 403 — вкладки просто не будет.
  const loadLeads = useCallback(async () => {
    setLeadsLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/v1/panel/leads?limit=100`, { headers });
      if (r.ok) {
        const d = await r.json();
        setIsSiteAdmin(true);
        setLeads(d.leads || []);
        setLeadNewCount(d.newCount || 0);
      } else {
        setIsSiteAdmin(false);
      }
    } catch {}
    setLeadsLoading(false);
  }, [apiKey]);

  async function setLeadStatus(id, status) {
    // оптимистично, с откатом при ошибке
    const prev = leads;
    setLeads((ls) => ls.map((l) => (l._id === id ? { ...l, status } : l)));
    try {
      const r = await fetch(`${API_BASE}/api/v1/panel/leads/${id}/status`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error();
      setLeadNewCount((leads.filter((l) => (l._id === id ? status : l.status) === 'new')).length);
    } catch {
      setLeads(prev);
    }
  }

  useEffect(() => {
    loadActivity();
    loadStats();
    loadProfiles();
    loadLeads();
  }, [loadStats, loadProfiles, loadActivity, loadLeads]);

  useEffect(() => {
    if (tab === 'leads') loadLeads();
  }, [tab, loadLeads]);

  useEffect(() => {
    if (tab === 'history') loadHistory(histPage, histFilter);
  }, [tab, histPage, histFilter, loadHistory]);

  useEffect(() => {
    if (tab === 'users') loadUsers(histFilter);
  }, [tab, histFilter, loadUsers]);

  useEffect(() => {
    if (enabled && !isActive && !skipped && !completedPaths.has('/panel')) {
      const t = setTimeout(() => { if (window.location.pathname === '/panel') startTutorial(TUTORIAL_STEPS, '/panel'); }, 800);
      return () => clearTimeout(t);
    }
  }, [enabled, isActive, skipped, completedPaths]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'blocked') { loadBlocked(); loadUsers(''); }
  }, [tab, loadBlocked, loadUsers]);

  // ── Действия ────────────────────────────────────────────────────────────────

  async function doRollback() {
    if (!rollbackTask) return;
    setRollbackLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/v1/panel/rollback/${rollbackTask.taskId}`, {
        method: 'POST',
        headers,
      });
      const data = await r.json();
      setRollbackResult(data);
      if (data.success) {
        loadHistory(histPage, histFilter);
        loadStats();
      }
    } catch (e) {
      setRollbackResult({ success: false, error: e.message });
    }
    setRollbackLoading(false);
  }

  async function doBlock() {
    if (!blockTarget) return;
    setBlockLoading(true);
    try {
      await fetch(`${API_BASE}/api/v1/panel/block`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...blockTarget, reason: blockReason }),
      });
      setBlockTarget(null);
      setBlockReason('');
      loadUsers(histFilter);
      loadBlocked();
      loadStats();
    } catch {}
    setBlockLoading(false);
  }

  async function doUnblock(id) {
    try {
      await fetch(`${API_BASE}/api/v1/panel/block/${id}`, { method: 'DELETE', headers });
      loadBlocked();
      loadUsers(tab === 'users' ? histFilter : '');
      loadStats();
    } catch {}
  }

  // ── Рендер ──────────────────────────────────────────────────────────────────

  return (
    <div className="cp-root">
      {/* Заголовок раздела даёт оболочка (Layout → .head «Мониторинг»):
          своя шапка «Назад · Управление ИИ» дублировала его, а «Назад» вела
          на Обзор, который сливается сюда же. В эталоне шапка одна. */}

      {/* Статистика — разметка эталона (.stats/.stat), стили уже в Layout.css.
          Дельт («+128 за неделю») нет намеренно: в эталоне это демо-числа,
          бэкенд их не отдаёт — рисовать фальшивую динамику нельзя. */}
      {stats && (
        <section className="stats stats--4">
          <div className="stat stat--accent">
            <div className="stat__ic"><MessageSquare size={20} /></div>
            <div className="stat__v">{stats.totalTasks.toLocaleString('ru-RU')}</div>
            <div className="stat__l">Всего запросов</div>
          </div>
          <div className="stat">
            <div className="stat__ic"><Users size={20} /></div>
            <div className="stat__v">{stats.uniqueUsers.toLocaleString('ru-RU')}</div>
            <div className="stat__l">Уникальных пользователей</div>
          </div>
          <div className="stat">
            <div className="stat__ic"><Timer size={20} /></div>
            <div className="stat__v">{formatMs(activity?.avgProcessingMs)}</div>
            <div className="stat__l">Среднее время ответа</div>
          </div>
          <div className="stat">
            <div className="stat__ic"><Ban size={20} /></div>
            <div className="stat__v">{stats.blockedCount}</div>
            <div className="stat__l">Заблокировано</div>
            <div className="stat__d stat__d--mute">за всё время</div>
          </div>
        </section>
      )}

      {/* Активность — карточка эталона (.card + .card__head + spark) */}
      {(() => {
        const series = activity?.series?.slice(-7) || [];
        const vals = series.map((d) => d.count ?? 0);
        const spk = vals.some((v) => v > 0) ? sparkPaths(vals) : null;
        return (
          <div className="card">
            <div className="card__head">
              <h3><Zap size={17} /> Активность</h3>
              <span className="muted-s">последние 7 дней</span>
            </div>
            {!spk ? (
              <div className="cp-spark-empty">Запросов за последние 7 дней не было</div>
            ) : (
              <>
                <div className="spkwrap" onMouseLeave={() => setSparkHover(null)}>
                  <svg
                    className="spk"
                    viewBox={`0 0 ${SPK_W} ${SPK_H}`}
                    preserveAspectRatio="none"
                    onMouseMove={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      const sx = ((e.clientX - r.left) / r.width) * SPK_W;
                      const i = spk.pts.reduce((b, p, idx) => (Math.abs(p[0] - sx) < Math.abs(spk.pts[b][0] - sx) ? idx : b), 0);
                      setSparkHover(i);
                    }}
                  >
                    <defs>
                      <linearGradient id="cpSpkFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="var(--text)" stopOpacity="0.20" />
                        <stop offset="1" stopColor="var(--text)" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path className="spk__area" d={spk.area} fill="url(#cpSpkFill)" />
                    <path className="spk__line" d={spk.line} />
                    {spk.pts.map((p, i) => (
                      <circle key={i} className={`spk__dot${sparkHover === i ? ' spk__dot--on' : ''}`} cx={p[0]} cy={p[1]} r="3.2" />
                    ))}
                  </svg>
                  {sparkHover !== null && series[sparkHover] && (
                    <div
                      className="cp-spark-tip"
                      style={{
                        // за точкой, а не по центру графика: SVG растянут через
                        // preserveAspectRatio=none, поэтому X точки → % ширины,
                        // Y → пиксели (высота spkwrap = высоте SVG в единицах)
                        left: `${(spk.pts[sparkHover][0] / SPK_W) * 100}%`,
                        top: `${spk.pts[sparkHover][1]}px`,
                      }}
                    >
                      {formatDate(series[sparkHover].date).split(',')[0]} · {vals[sparkHover]}
                    </div>
                  )}
                </div>
                <div className="spark__x">
                  {series.map((d, i) => <span key={i}>{shortDay(d.date)}</span>)}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Вкладки */}
      <div className="cp-tabs">
        <div className="cp-tabs-left">
          <button className={`cp-tab ${tab === 'history'  ? 'active' : ''}`} onClick={() => setTab('history')}>
            <Clock size={15} />
            История запросов
          </button>
          <button className={`cp-tab ${tab === 'users'    ? 'active' : ''}`} onClick={() => setTab('users')}>
            <Users size={15} />
            Пользователи
          </button>
          <button className={`cp-tab ${tab === 'blocked'  ? 'active' : ''}`} onClick={() => setTab('blocked')}>
            <Ban size={15} />
            <span className="cp-tab-full">Заблокированные</span>
            <span className="cp-tab-short">Блоки</span>
            {stats?.blockedCount > 0 && (
              <span className="cp-tab-badge">{stats.blockedCount}</span>
            )}
          </button>
          {isSiteAdmin && (
            <button className={`cp-tab ${tab === 'leads' ? 'active' : ''}`} onClick={() => setTab('leads')}>
              <Inbox size={15} />
              Заявки
              {leadNewCount > 0 && (
                <span className="cp-tab-badge cp-tab-badge--lead">{leadNewCount}</span>
              )}
            </button>
          )}
        </div>
        <ProfileSelect
          profiles={profiles}
          value={histFilter}
          onChange={(v) => { setHistFilter(v); setHistPage(1); }}
        />
      </div>

      {/* ── Вкладка: История ── */}
      {tab === 'history' && (
        <div className="cp-panel">
          <div className="cp-toolbar">
            <span className="cp-total-label">
              {histTotal.toLocaleString('ru-RU')} запрос{histTotal % 10 === 1 && histTotal % 100 !== 11 ? '' : histTotal % 10 >= 2 && histTotal % 10 <= 4 && (histTotal % 100 < 10 || histTotal % 100 >= 20) ? 'а' : 'ов'}
            </span>
          </div>

          {histLoading ? (
            <div className="cp-loading">Загрузка...</div>
          ) : history.length === 0 ? (
            <div className="cp-empty">
              <Clock size={36} />
              <p>Запросов пока нет</p>
              <p className="cp-empty-sub">Здесь появятся сообщения клиентов вашего бота</p>
            </div>
          ) : (
            <div className="cp-table">
              {history.map((task) => {
                const eu = task.endUser || {};
                const userLabel = eu.username ? `@${eu.username}` : eu.displayName || eu.platformUserId || '—';
                const isExpanded = expandedId === task._id;
                const toggle = () => setExpandedId(isExpanded ? null : task._id);
                return (
                <div key={task._id} className={`cp-row ${isExpanded ? 'expanded' : ''}`}>
                  <div className="cp-row-main" onClick={toggle}>
                    <div className="cp-row-left">
                      <span className="cp-row-date">{formatDate(task.createdAt)}</span>
                      <PlatformBadge platform={eu.platform || 'api'} />
                      {eu.platformUserId && (
                        <span className="cp-row-uid" title={`ID: ${eu.platformUserId}`}>{userLabel}</span>
                      )}
                    </div>
                    <div className="cp-row-prompt">{truncate(task.prompt, 90)}</div>
                    <div className="cp-row-actions" onClick={(e) => e.stopPropagation()}>
                      {task.hasDataChanges && (
                        <button
                          className="cp-btn-rollback"
                          title="Откатить изменения данных с этого момента"
                          onClick={() => { setRollbackTask(task); setRollbackResult(null); }}
                        >
                          <RotateCcw size={14} />
                          Откатить
                        </button>
                      )}
                      <button
                        className="cp-row-expand"
                        title={isExpanded ? 'Свернуть' : 'Развернуть'}
                        onClick={toggle}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="cp-row-detail">
                      <div className="cp-detail-block">
                        <div className="cp-detail-label">Запрос пользователя</div>
                        <div className="cp-detail-text">{task.prompt}</div>
                      </div>
                      {task.result && (
                        <div className="cp-detail-block">
                          <div className="cp-detail-label">Ответ AI</div>
                          <div className="cp-detail-text">{task.result}</div>
                        </div>
                      )}
                      {task.attachments?.length > 0 && (
                        <div className="cp-detail-block">
                          <div className="cp-detail-label">Изображения ({task.attachments.length})</div>
                          <div className="cp-detail-images">
                            {task.attachments.map((src, i) => (
                              <a key={i} href={src} target="_blank" rel="noreferrer">
                                <img src={src} alt={`attachment-${i}`} className="cp-detail-img" />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                      {task.error && (
                        <div className="cp-detail-block cp-detail-block--err">
                          <div className="cp-detail-label">Ошибка</div>
                          <div className="cp-detail-text">{task.error}</div>
                        </div>
                      )}
                      <div className="cp-detail-meta">
                        {eu.username && <span>@{eu.username}</span>}
                        {eu.displayName && <span>{eu.displayName}</span>}
                        {eu.platformUserId && <span>ID: {eu.platformUserId}</span>}
                        {eu.ip && <span>IP: {eu.ip}</span>}
                        <span>Статус: {task.status}</span>
                        {task.processingTime && <span>Время: {task.processingTime} мс</span>}
                      </div>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}

          {/* Пагинация */}
          {histPages > 1 && (
            <div className="cp-pagination">
              <button
                className="cp-page-btn"
                disabled={histPage <= 1}
                onClick={() => setHistPage((p) => p - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="cp-page-info">
                {histPage} / {histPages}
              </span>
              <button
                className="cp-page-btn"
                disabled={histPage >= histPages}
                onClick={() => setHistPage((p) => p + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Вкладка: Пользователи ── */}
      {tab === 'users' && (
        <div className="cp-panel">
          {usersLoading ? (
            <div className="cp-loading">Загрузка...</div>
          ) : users.length === 0 ? (
            <div className="cp-empty">
              <Users size={36} />
              <p>Пользователей пока нет</p>
              <p className="cp-empty-sub">Здесь появятся клиенты, написавшие вашему боту</p>
            </div>
          ) : (
            <div className="cp-table">
              <div className="cp-table-head cp-users-head">
                <span>Платформа</span>
                <span>Пользователь</span>
                <span>Запросов</span>
                <span>Активность</span>
                <span>Статус</span>
                <span></span>
              </div>
              {users.map((u) => (
                <div key={`${u.platform}:${u.platformUserId}`} className="cp-user-row">
                  <PlatformBadge platform={u.platform} />
                  <div className="cp-user-identity">
                    {u.username && <span className="cp-user-login">@{u.username}</span>}
                    {u.displayName && <span className="cp-user-name">{u.displayName}</span>}
                    <span className="cp-user-id">{u.platformUserId}</span>
                  </div>
                  <span className="cp-count">{u.count}</span>
                  <span className="cp-date">{formatDate(u.lastActive)}</span>
                  <span>
                    {u.platform !== 'studio' && (u.blockedDoc ? (
                      <span className="cp-status-blocked">Заблок.</span>
                    ) : (
                      <span className="cp-status-ok">Активен</span>
                    ))}
                  </span>
                  <div className="cp-user-actions">
                    {u.platform !== 'studio' && (u.blockedDoc ? (
                      <button
                        className="cp-btn-unblock"
                        onClick={() => doUnblock(u.blockedDoc._id)}
                      >
                        Разблокировать
                      </button>
                    ) : (
                      <button
                        className="cp-btn-block"
                        onClick={() => { setBlockTarget({ platform: u.platform, platformUserId: u.platformUserId }); setBlockReason(''); }}
                      >
                        <Ban size={13} />
                        Заблокировать
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Вкладка: Заблокированные ── */}
      {tab === 'blocked' && (
        <div className="cp-panel">
          {blocked.length === 0 ? (
            <div className="cp-empty">
              <Shield size={36} />
              <p>Заблокированных нет</p>
              <p className="cp-empty-sub">Заблокированные пользователи появятся здесь</p>
            </div>
          ) : (
            <div className="cp-table">
              <div className="cp-table-head cp-blocked-head">
                <span>Платформа</span>
                <span>Пользователь</span>
                <span>Причина</span>
                <span>Дата</span>
                <span></span>
              </div>
              {blocked.map((b) => {
                // Попробуем найти username из списка users
                const matchedUser = users.find(u => u.platform === b.platform && u.platformUserId === b.platformUserId);
                return (
                <div key={b._id} className="cp-blocked-row">
                  <PlatformBadge platform={b.platform} />
                  <div className="cp-user-identity">
                    {matchedUser?.username && <span className="cp-user-login">@{matchedUser.username}</span>}
                    {matchedUser?.displayName && <span className="cp-user-name">{matchedUser.displayName}</span>}
                    <span className="cp-user-id">{b.platformUserId}</span>
                  </div>
                  <span className="cp-reason">{b.reason || '—'}</span>
                  <span className="cp-date">{formatDate(b.blockedAt)}</span>
                  <button
                    className="cp-btn-unblock"
                    onClick={() => doUnblock(b._id)}
                  >
                    Разблокировать
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Вкладка: Заявки (только админ сайта) ── */}
      {tab === 'leads' && isSiteAdmin && (
        <div className="cp-panel">
          {leadsLoading ? (
            <div className="cp-loading">Загрузка...</div>
          ) : leads.length === 0 ? (
            <div className="cp-empty">
              <Inbox size={36} />
              <p>Заявок пока нет</p>
              <p className="cp-empty-sub">Здесь появятся заявки, отправленные через форму на сайте</p>
            </div>
          ) : (
            <div className="cp-leads">
              {leads.map((lead) => {
                const st = LEAD_STATUS[lead.status] || LEAD_STATUS.new;
                return (
                  <div key={lead._id} className={`cp-lead${lead.status === 'new' ? ' cp-lead--new' : ''}`}>
                    <div className="cp-lead-top">
                      <div className="cp-lead-who">
                        <span className="cp-lead-name">{lead.name || 'Без имени'}</span>
                        {lead.niche && <span className="cp-lead-niche">{lead.niche}</span>}
                      </div>
                      <div className="cp-lead-meta">
                        <span
                          className="cp-lead-status"
                          style={{ background: `${st.color}1a`, color: st.color }}
                        >
                          {st.label}
                        </span>
                        <span className="cp-lead-date">{formatDate(lead.createdAt)}</span>
                      </div>
                    </div>
                    {lead.contact && (
                      <div className="cp-lead-contact">{lead.contact}</div>
                    )}
                    {lead.message && (
                      <div className="cp-lead-msg">{lead.message}</div>
                    )}
                    <div className="cp-lead-actions">
                      {LEAD_STATUS_ORDER.map((s) => (
                        <button
                          key={s}
                          className={`cp-lead-set${lead.status === s ? ' active' : ''}`}
                          style={lead.status === s ? { '--st-color': LEAD_STATUS[s].color } : {}}
                          onClick={() => lead.status !== s && setLeadStatus(lead._id, s)}
                        >
                          {LEAD_STATUS[s].label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Модалка: Подтверждение отката ── */}
      {rollbackTask && (
        <div className="cp-modal-overlay" onClick={() => !rollbackLoading && setRollbackTask(null)}>
          <div className="cp-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="cp-modal-close"
              onClick={() => !rollbackLoading && setRollbackTask(null)}
            >
              <X size={18} />
            </button>

            {!rollbackResult ? (
              <>
                <div className="cp-modal-icon cp-modal-icon--warn">
                  <AlertTriangle size={28} />
                </div>
                <h2 className="cp-modal-title">Откат данных</h2>
                <p className="cp-modal-text">
                  Вы действительно хотите откатить данные, хранящиеся на сайте, до этого момента?
                </p>
                <div className="cp-modal-task-info">
                  <div className="cp-modal-task-row">
                    <span>Дата:</span>
                    <strong>{formatDate(rollbackTask.createdAt)}</strong>
                  </div>
                  <div className="cp-modal-task-row">
                    <span>Запрос:</span>
                    <strong>{truncate(rollbackTask.prompt, 60)}</strong>
                  </div>
                </div>
                <p className="cp-modal-warn">
                  <AlertTriangle size={14} />
                  Все изменения в данных, сделанные с этого запроса и позже, будут безвозвратно удалены.
                </p>
                <div className="cp-modal-actions">
                  <button
                    className="cp-btn-secondary"
                    onClick={() => setRollbackTask(null)}
                    disabled={rollbackLoading}
                  >
                    Отмена
                  </button>
                  <button
                    className="cp-btn-danger"
                    onClick={doRollback}
                    disabled={rollbackLoading}
                  >
                    {rollbackLoading ? 'Откатываем...' : 'Да, откатить'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={`cp-modal-icon ${rollbackResult.success ? 'cp-modal-icon--ok' : 'cp-modal-icon--err'}`}>
                  {rollbackResult.success ? <RotateCcw size={28} /> : <AlertTriangle size={28} />}
                </div>
                <h2 className="cp-modal-title">
                  {rollbackResult.success ? 'Откат выполнен' : 'Ошибка отката'}
                </h2>
                <p className="cp-modal-text">
                  {rollbackResult.message || rollbackResult.error}
                </p>
                <div className="cp-modal-actions">
                  <button
                    className="cp-btn-primary"
                    onClick={() => setRollbackTask(null)}
                  >
                    Закрыть
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Модалка: Подтверждение блокировки ── */}
      {blockTarget && (
        <div className="cp-modal-overlay" onClick={() => !blockLoading && setBlockTarget(null)}>
          <div className="cp-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="cp-modal-close"
              onClick={() => !blockLoading && setBlockTarget(null)}
            >
              <X size={18} />
            </button>
            <div className="cp-modal-icon cp-modal-icon--warn">
              <Ban size={28} />
            </div>
            <h2 className="cp-modal-title">Заблокировать пользователя</h2>
            <div className="cp-modal-task-info">
              <div className="cp-modal-task-row">
                <span>Платформа:</span>
                <strong>{PLATFORM_LABELS[blockTarget.platform] || blockTarget.platform}</strong>
              </div>
              <div className="cp-modal-task-row">
                <span>ID:</span>
                <strong>{blockTarget.platformUserId}</strong>
              </div>
            </div>
            <label className="cp-block-reason-label">
              Причина блокировки (необязательно)
              <textarea
                className="cp-block-reason-input"
                placeholder="Например: спам, накрутка данных..."
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                rows={2}
                maxLength={200}
              />
            </label>
            <p className="cp-modal-warn">
              <AlertTriangle size={14} />
              Пользователь больше не сможет обращаться к вашему боту.
            </p>
            <div className="cp-modal-actions">
              <button
                className="cp-btn-secondary"
                onClick={() => setBlockTarget(null)}
                disabled={blockLoading}
              >
                Отмена
              </button>
              <button
                className="cp-btn-danger"
                onClick={doBlock}
                disabled={blockLoading}
              >
                {blockLoading ? 'Блокируем...' : 'Заблокировать'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
