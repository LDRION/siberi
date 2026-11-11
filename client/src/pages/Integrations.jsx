import axios from 'axios';
import {
  Bot,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  Monitor,
  Plus,
  Server,
  Settings,
  Shield,
  Terminal,
  Unplug,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TelegramIcon, VKIcon, MAXIcon } from '../components/BrandIcons';
import { useTutorial } from '../context/TutorialContext';
import './Integrations.css';

const TUTORIAL_STEPS = [
  {
    selector: '.head',
    text: 'Раздел интеграций — подключайте AI к любым каналам.\n\nДве вкладки: «Без кода» — готовые коннекторы, и «Для разработчиков» — API, SDK, Webhook.',
  },
  {
    selector: '.seg__b',
    text: 'Вкладка «Без кода»:\nTelegram-бот, VK, виджет на сайт, полноэкранный AI-чат.\n🚀 Никакого сервера и хостинга — мы берём это на себя. Бот работает 24/7 на нашей инфраструктуре без вашего участия.\n\nВкладка «Для разработчиков»:\nREST API с авторизацией по ключу, JavaScript SDK, Webhook-уведомления на ваш сервер.',
  },
  {
    selector: '.icard',
    text: 'Каждая карточка — отдельный канал.\n\nНажмите «Подключить» → выберите AI-профиль → следуйте пошаговой инструкции.\n\nОдин профиль AI можно подключить к нескольким каналам одновременно — Telegram, VK и сайт работают параллельно.',
  },
  {
    selector: 'a[href="/settings"]',
    text: 'Если хотите, чтобы разные каналы отвечали по-разному — создайте отдельные AI-профили в «Настройках AI» и подключите каждый к своему каналу.',
  },
];

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

// ── Modal wrapper ─────────────────────────────────────────────────────────────
function Modal({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="integ-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="integ-modal">
        <div className="integ-modal__head">
          <div>
            <div className="ck__title">{title}</div>
            {subtitle && <div className="ck__sub">{subtitle}</div>}
          </div>
          <button className="ck__x" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="integ-modal__body">{children}</div>
      </div>
    </div>
  );
}

// ── Code block with copy ──────────────────────────────────────────────────────
function CodeBlock({ code, filename, lang = 'js', onDownload }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="cb">
      <div className="cb__head">
        <Terminal size={14} /><span>{filename}</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {onDownload && <button className="cb__btn" onClick={onDownload}><Download size={14} /></button>}
          <button className="cb__btn" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </div>
      </div>
      <pre className="cb__pre"><code>{code}</code></pre>
    </div>
  );
}

// ── Integration card ──────────────────────────────────────────────────────────
function IntegCard({ icon, title, desc, badge, badgeType, status, profileTag, onOpen, disabled }) {
  return (
    <div className={`icard ${disabled ? 'icard--soon' : ''}`}>
      <div className="icard__top">
        <span className="icard__ic">{icon}</span>
        {badge && <span className={`chip ${badgeType === 'green' ? 'chip--ok' : 'chip--soft'}`}>{badge}</span>}
      </div>
      <div className="icard__n">{title}</div>
      <p className="icard__d">{desc}</p>
      {status ? (
        <div className="icard__st">
          <span className="chip chip--ok"><span className="idot" />{status}</span>
          {profileTag && <span className="chip chip--soft">{profileTag}</span>}
        </div>
      ) : null}
      <button
        className={`btn ${disabled ? 'btn--disabled' : 'btn--primary'}`}
        onClick={!disabled ? onOpen : undefined}
        disabled={disabled}
      >
        {disabled ? 'Скоро' : 'Открыть'}<ChevronRight size={15} />
      </button>
    </div>
  );
}

// ── Profile selector (shown as first step of any bot modal) ───────────────────
function ProfileSelector({ profiles, selectedId, onSelect, onNavigate }) {
  return (
    <div className="ig__prof-step">
      <p className="ig__lbl">Выберите AI-профиль для этой интеграции</p>
      <div className="igprof-list">
        {profiles.map(p => (
          <button
            key={p._id}
            type="button"
            className={`igprof ${selectedId === p._id ? 'igprof--on' : ''}`}
            onClick={() => onSelect(p._id)}
          >
            <span className="igprof__n">{p.profileName || p.aiName || 'Профиль'}</span>
            {selectedId === p._id && <Check size={14} />}
          </button>
        ))}
      </div>
      <button type="button" className="igprof igprof--add" onClick={onNavigate}>
        <Plus size={14} /> Создать профиль AI
      </button>
    </div>
  );
}

export default function Integrations({ apiKey }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { enabled, startTutorial, isActive, skipped, completedPaths } = useTutorial();

  useEffect(() => {
    if (enabled && !isActive && !skipped && !completedPaths.has('/integrations')) {
      const t = setTimeout(() => { if (window.location.pathname === '/integrations') startTutorial(TUTORIAL_STEPS, '/integrations'); }, 500);
      return () => clearTimeout(t);
    }
  }, [enabled, isActive, skipped, completedPaths]); // eslint-disable-line react-hooks/exhaustive-deps

  const [activeTab, setActiveTab] = useState('no-code');
  const [modal, setModal] = useState(null); // null | string key
  const [copied, setCopied] = useState(null);

  // Integration status
  const [status, setStatus] = useState(null);

  // Telegram state
  const [tgToken, setTgToken] = useState('');
  const [tgName, setTgName] = useState('');
  const [tgLoading, setTgLoading] = useState(false);
  const [tgError, setTgError] = useState('');
  const [tgStep, setTgStep] = useState('profile'); // 'list' | 'profile' | 'setup'

  // VK state
  const [vkToken, setVkToken] = useState('');
  const [vkName, setVkName] = useState('');
  const [vkGroupId, setVkGroupId] = useState('');
  const [vkSecret, setVkSecret] = useState('');
  const [vkLoading, setVkLoading] = useState(false);
  const [vkError, setVkError] = useState('');
  const [vkStep, setVkStep] = useState('profile'); // 'list' | 'profile' | 'form' | 'confirm'
  const [vkConfirmStr, setVkConfirmStr] = useState('');
  const [vkWebhookUrl, setVkWebhookUrl] = useState('');
  const [vkInstanceId, setVkInstanceId] = useState('');

  // MAX state
  const [maxToken, setMaxToken] = useState('');
  const [maxName, setMaxName] = useState('');
  const [maxLoading, setMaxLoading] = useState(false);
  const [maxError, setMaxError] = useState('');
  const [maxStep, setMaxStep] = useState('profile'); // 'list' | 'profile' | 'setup'

  // Webhook callback state
  const [whUrl, setWhUrl] = useState('');
  const [whEnabled, setWhEnabled] = useState(false);
  const [whSaving, setWhSaving] = useState(false);

  // AI-профили (для выбора при подключении интеграций)
  const [profiles, setProfiles] = useState([]);
  const [tgProfileId, setTgProfileId] = useState('');
  const [vkProfileId, setVkProfileId] = useState('');
  const [maxProfileId, setMaxProfileId] = useState('');

  // Embed token (short-lived, used in widget URLs instead of real API key)
  const [embedToken, setEmbedToken] = useState(null);
  const [embedTokenLoading, setEmbedTokenLoading] = useState(false);

  // Onboarding checklist
  const [onboardingPlatforms, setOnboardingPlatforms] = useState([]);

  const h = { Authorization: `Bearer ${apiKey}` };

  const PLATFORM_MODAL_MAP = {
    telegram: 'telegram',
    vk: 'vk',
    max: 'max',
    website: 'widget',
    fullpage: 'fullpage',
    api: 'sdk',
  };

  const PLATFORM_LABELS = {
    telegram: <><TelegramIcon size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Telegram Bot</>,
    vk:       <><VKIcon size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> VK Bot</>,
    max:      <><MAXIcon size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> MAX Bot</>,
    website:  '🌐 Виджет',
    fullpage: '🖥️ AI-страница',
    api:      '⚡ API / SDK',
  };

  const isIntegrationDone = (key) => {
    if (!status) return false;
    if (key === 'telegram') return (status.telegram || []).some(b => b.connected);
    if (key === 'vk') return (status.vk || []).some(b => b.connected);
    if (key === 'max') return (status.max || []).some(b => b.connected);
    return false;
  };

  useEffect(() => {
    if (!apiKey) return;
    axios.get(`${API_URL}/profiles`, { headers: h })
      .then(res => { if (res.data.success) setProfiles(res.data.profiles || []); })
      .catch(() => {});
    // Load existing embed token (or auto-generate on first use)
    axios.get(`${API_URL}/embed/token`, { headers: h })
      .then(res => {
        if (res.data.token) {
          setEmbedToken(res.data.token);
        } else {
          // Auto-generate on first load so widget URLs are ready immediately
          return axios.post(`${API_URL}/embed/token`, {}, { headers: h })
            .then(r => { if (r.data.token) setEmbedToken(r.data.token); });
        }
      })
      .catch(() => {});
  }, [apiKey]);

  useEffect(() => {
    if (!apiKey) return;
    fetchStatus();
    const params = new URLSearchParams(location.search);
    if (params.get('onboarding') === 'true') {
      const integ = location.state?.integrations || {};
      const platforms = Object.entries(integ).filter(([, v]) => v).map(([k]) => k);
      if (platforms.length > 0) {
        setOnboardingPlatforms(platforms);
        const firstModal = PLATFORM_MODAL_MAP[platforms[0]];
        if (firstModal) setTimeout(() => openModal(firstModal), 400);
      }
      navigate('/integrations', { replace: true, state: location.state });
    }
  }, [apiKey]);

  const fetchStatus = async () => {
    try {
      const { data } = await axios.get(`${API_URL}/integrations/status`, { headers: h });
      setStatus(data);
      if (data.webhookCallback) {
        setWhUrl(data.webhookCallback.url || '');
        setWhEnabled(data.webhookCallback.enabled || false);
      }
    } catch {}
  };

  const openModal = (key) => {
    setModal(key);
    setTgError(''); setVkError(''); setMaxError('');
    const defaultProfileId = profiles[0]?._id || '';
    if (key === 'telegram') {
      const hasBots = (status?.telegram || []).length > 0;
      setTgStep(hasBots ? 'list' : 'profile');
      setTgToken(''); setTgName('');
      setTgProfileId(defaultProfileId);
    }
    if (key === 'vk') {
      const hasBots = (status?.vk || []).length > 0;
      setVkStep(hasBots ? 'list' : 'profile');
      setVkToken(''); setVkGroupId(''); setVkSecret(''); setVkName('');
      setVkProfileId(defaultProfileId);
    }
    if (key === 'max') {
      const hasBots = (status?.max || []).length > 0;
      setMaxStep(hasBots ? 'list' : 'profile');
      setMaxToken(''); setMaxName('');
      setMaxProfileId(defaultProfileId);
    }
  };
  const closeModal = () => setModal(null);

  const copy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // ── Telegram ──────────────────────────────────────────────────────────────
  const connectTelegram = async () => {
    if (!tgToken.trim()) return;
    setTgLoading(true); setTgError('');
    try {
      await axios.post(`${API_URL}/integrations/telegram/connect`,
        { token: tgToken.trim(), name: tgName.trim(), ...(tgProfileId ? { profileId: tgProfileId } : {}) },
        { headers: h });
      setTgToken(''); setTgName('');
      await fetchStatus();
      setTgStep('done');
    } catch (err) {
      setTgError(err.response?.data?.error || 'Ошибка подключения');
    } finally { setTgLoading(false); }
  };

  const disconnectTelegram = async (instanceId) => {
    setTgLoading(true);
    try {
      await axios.delete(`${API_URL}/integrations/telegram/${instanceId}/disconnect`, { headers: h });
      await fetchStatus();
    } catch {}
    setTgLoading(false);
  };

  // ── VK ────────────────────────────────────────────────────────────────────
  const setupVk = async () => {
    if (!vkToken.trim() || !vkGroupId.trim()) return;
    setVkLoading(true); setVkError('');
    try {
      const { data } = await axios.post(`${API_URL}/integrations/vk/setup`,
        { token: vkToken.trim(), groupId: vkGroupId.trim(), secret: vkSecret.trim(), name: vkName.trim(), ...(vkProfileId ? { profileId: vkProfileId } : {}) },
        { headers: h });
      setVkWebhookUrl(data.webhookUrl);
      setVkInstanceId(data.instanceId);
      setVkStep('confirm');
    } catch (err) {
      setVkError(err.response?.data?.error || 'Ошибка настройки');
    } finally { setVkLoading(false); }
  };

  const activateVk = async () => {
    if (!vkConfirmStr.trim()) { setVkError('Введите строку подтверждения из VK'); return; }
    setVkLoading(true); setVkError('');
    try {
      await axios.post(`${API_URL}/integrations/vk/${vkInstanceId}/activate`, { confirmString: vkConfirmStr.trim() }, { headers: h });
      await fetchStatus();
      setVkStep('list');
    } catch (err) {
      setVkError(err.response?.data?.error || 'Ошибка активации');
    }
    setVkLoading(false);
  };

  const disconnectVk = async (instanceId) => {
    setVkLoading(true);
    try {
      await axios.delete(`${API_URL}/integrations/vk/${instanceId}/disconnect`, { headers: h });
      await fetchStatus();
    } catch {}
    setVkLoading(false);
  };

  // ── MAX ───────────────────────────────────────────────────────────────────
  const connectMax = async () => {
    if (!maxToken.trim()) return;
    setMaxLoading(true); setMaxError('');
    try {
      await axios.post(`${API_URL}/integrations/max/connect`,
        { token: maxToken.trim(), name: maxName.trim(), ...(maxProfileId ? { profileId: maxProfileId } : {}) },
        { headers: h });
      await fetchStatus();
      setMaxToken(''); setMaxName('');
      setMaxStep('list');
    } catch (err) {
      setMaxError(err.response?.data?.error || 'Ошибка подключения');
    } finally { setMaxLoading(false); }
  };

  const disconnectMax = async (instanceId) => {
    setMaxLoading(true);
    try {
      await axios.delete(`${API_URL}/integrations/max/${instanceId}/disconnect`, { headers: h });
      await fetchStatus();
    } catch {}
    setMaxLoading(false);
  };

  // ── Webhook callback ──────────────────────────────────────────────────────
  const saveWebhook = async () => {
    setWhSaving(true);
    try { await axios.put(`${API_URL}/integrations/webhook-callback`, { url: whUrl, enabled: whEnabled }, { headers: h }); }
    catch {}
    setWhSaving(false);
  };

  const refreshEmbedToken = async () => {
    setEmbedTokenLoading(true);
    try {
      const res = await axios.post(`${API_URL}/embed/token`, {}, { headers: h });
      if (res.data.token) setEmbedToken(res.data.token);
    } catch {}
    setEmbedTokenLoading(false);
  };

  // ── Code generators ───────────────────────────────────────────────────────
  const base = API_URL.replace('/api/v1', '');

  const codes = {
    tgBot: () => `const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const API_KEY = '${apiKey}';
const API_BASE = '${base}';
const TG_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN'; // от @BotFather

const bot = new TelegramBot(TG_TOKEN, { polling: true });
console.log('🤖 Siberi AI Telegram Bot запущен!');

// Ждём результат задачи (AI обрабатывает асинхронно)
async function waitResult(taskId) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const { data } = await axios.get(\`\${API_BASE}/api/v1/result/\${taskId}\`,
      { headers: { Authorization: \`Bearer \${API_KEY}\` } });
    if (data.status === 'completed' || data.status === 'error') return data;
  }
  return { status: 'error', error: 'Timeout — AI не ответил за 2 минуты' };
}

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  try {
    // 1. Отправляем запрос → получаем taskId
    const { data } = await axios.post(\`\${API_BASE}/api/v1/analyze\`,
      { prompt: msg.text }, { headers: { Authorization: \`Bearer \${API_KEY}\` } });
    if (!data.taskId) { bot.sendMessage(chatId, '❌ ' + (data.error || 'Ошибка')); return; }

    // 2. Ждём и отправляем результат
    const result = await waitResult(data.taskId);
    if (result.status === 'completed') {
      await bot.sendMessage(chatId, result.result);
      for (const img of result.attachments || []) {
        const buf = Buffer.from(img.replace(/^data:image\\/\\w+;base64,/, ''), 'base64');
        await bot.sendPhoto(chatId, buf).catch(() => {});
      }
    } else {
      bot.sendMessage(chatId, '❌ ' + (result.error || 'Ошибка'));
    }
  } catch (e) { bot.sendMessage(chatId, '❌ ' + e.message); }
});`,

    vkBot: () => `const { VK } = require('vk-io');
const axios = require('axios');
const { Readable } = require('stream');

const API_KEY = '${apiKey}';
const API_BASE = '${base}';
const VK_TOKEN = 'YOUR_VK_COMMUNITY_TOKEN';

const vk = new VK({ token: VK_TOKEN });

async function waitResult(taskId) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const { data } = await axios.get(\`\${API_BASE}/api/v1/result/\${taskId}\`,
      { headers: { Authorization: \`Bearer \${API_KEY}\` } });
    if (data.status === 'completed' || data.status === 'error') return data;
  }
  return { status: 'error', error: 'Timeout' };
}

vk.updates.on('message_new', async (ctx) => {
  const text = ctx.text;
  if (!text) return;
  try {
    const { data } = await axios.post(\`\${API_BASE}/api/v1/analyze\`,
      { prompt: text }, { headers: { Authorization: \`Bearer \${API_KEY}\` } });
    if (!data.taskId) { ctx.reply('❌ ' + (data.error || 'Ошибка')); return; }

    const result = await waitResult(data.taskId);
    if (result.status === 'completed') {
      await ctx.reply(result.result);
      // Отправляем картинки от AI (если есть)
      for (const imgData of result.attachments || []) {
        try {
          const buf = Buffer.from(imgData.replace(/^data:image\\/\\w+;base64,/, ''), 'base64');
          const [photo] = await vk.upload.messagePhoto({
            source: { value: Readable.from(buf), filename: 'image.png', contentType: 'image/png' },
            peer_id: ctx.peerId,
          });
          await ctx.send({ attachment: [photo] });
        } catch {}
      }
    } else {
      ctx.reply('❌ ' + (result.error || 'Ошибка'));
    }
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

vk.updates.start().catch(console.error);
console.log('🤖 VK Bot запущен!');`,

    maxBot: () => `const axios = require('axios');

const API_KEY = '${apiKey}';
const API_BASE = '${base}';
const MAX_TOKEN = 'YOUR_MAX_BOT_TOKEN'; // https://bots.max.ru
const MAX_API = 'https://botapi.max.ru';

let marker = 0;

async function waitResult(taskId) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const { data } = await axios.get(\`\${API_BASE}/api/v1/result/\${taskId}\`,
      { headers: { Authorization: \`Bearer \${API_KEY}\` } });
    if (data.status === 'completed' || data.status === 'error') return data;
  }
  return { status: 'error', error: 'Timeout' };
}

const pollMax = async () => {
  try {
    const { data } = await axios.get(\`\${MAX_API}/updates\`, {
      params: { access_token: MAX_TOKEN, timeout: 30, ...(marker ? { marker } : {}) }
    });
    for (const upd of data.updates || []) {
      marker = upd.update_id + 1;
      if (upd.update_type === 'message_created') {
        const chatId = upd.message?.recipient?.chat_id;
        const text = upd.message?.body?.text;
        if (text && chatId) handleMsg(chatId, text).catch(console.error);
      }
    }
  } catch {}
  setTimeout(pollMax, 1000);
};

const send = (chatId, body) =>
  fetch(\`\${MAX_API}/messages?access_token=\${MAX_TOKEN}&chat_id=\${chatId}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});

const handleMsg = async (chatId, text) => {
  try {
    const { data } = await axios.post(\`\${API_BASE}/api/v1/analyze\`,
      { prompt: text }, { headers: { Authorization: \`Bearer \${API_KEY}\` } });
    if (!data.taskId) { await send(chatId, { text: '❌ ' + (data.error || 'Ошибка') }); return; }

    const result = await waitResult(data.taskId);
    if (result.status === 'completed') {
      await send(chatId, { text: result.result });
      // Отправляем картинки от AI (если есть)
      for (const imgData of result.attachments || []) {
        try {
          const buf = Buffer.from(imgData.replace(/^data:image\\/\\w+;base64,/, ''), 'base64');
          const form = new FormData();
          form.append('image', new Blob([buf], { type: 'image/png' }), 'image.png');
          const up = await fetch(\`\${MAX_API}/uploads?access_token=\${MAX_TOKEN}&type=image\`, {
            method: 'POST', body: form,
          }).then(r => r.json()).catch(() => null);
          if (up?.token) await send(chatId, { attachments: [{ type: 'image', payload: { token: up.token } }] });
        } catch {}
      }
    } else {
      await send(chatId, { text: '❌ ' + (result.error || 'Ошибка') });
    }
  } catch (e) { await send(chatId, { text: '❌ ' + e.message }); }
};

pollMax();
console.log('🤖 MAX Bot запущен!');`,

    widget: () => `<!-- Siberi AI Виджет — вставьте перед </body> -->
<script>
(function(){
  var K='${apiKey}',B='${base}',N='AI-Помощник';
  var s=document.createElement('style');
  s.textContent='#sib-btn{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);border:none;cursor:pointer;box-shadow:0 4px 20px rgba(102,126,234,.45);z-index:9999;font-size:26px;transition:transform .2s}#sib-btn:hover{transform:scale(1.1)}#sib-win{position:fixed;bottom:96px;right:24px;width:360px;height:510px;background:#fff;border-radius:18px;box-shadow:0 8px 40px rgba(0,0,0,.18);z-index:9999;display:none;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif}#sib-win.open{display:flex}#sib-head{background:linear-gradient(135deg,#667eea,#764ba2);padding:16px 18px;display:flex;align-items:center;gap:10px}#sib-head span{color:#fff;font-weight:700;font-size:15px;flex:1}#sib-head button{background:none;border:none;color:rgba(255,255,255,.75);cursor:pointer;font-size:22px;padding:0}#sib-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}.sib-m{max-width:82%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}.sib-u{align-self:flex-end;background:#667eea;color:#fff}.sib-a{align-self:flex-start;background:#f1f5f9;color:#1e293b}.sib-img{max-width:100%;border-radius:10px;margin-top:6px;display:block}#sib-inp{display:flex;padding:12px 14px;border-top:1px solid #e2e8f0;gap:8px}#sib-txt{flex:1;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px;outline:none;font-size:14px}#sib-txt:focus{border-color:#667eea}#sib-go{padding:10px 16px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:10px;cursor:pointer;font-size:20px}#sib-go:disabled{opacity:.5;cursor:default}';
  document.head.appendChild(s);
  var btn=document.createElement('button');btn.id='sib-btn';btn.innerHTML='&#x1F4AC;';document.body.appendChild(btn);
  var win=document.createElement('div');win.id='sib-win';
  win.innerHTML='<div id="sib-head"><span>&#x1F916; '+N+'</span><button onclick="document.getElementById(\'sib-win\').classList.remove(\'open\')">&#x2715;</button></div><div id="sib-msgs"></div><div id="sib-inp"><input id="sib-txt" placeholder="Напишите сообщение..."/><button id="sib-go">&#x279C;</button></div>';
  document.body.appendChild(win);
  btn.onclick=function(){win.classList.toggle('open');if(win.classList.contains('open'))document.getElementById('sib-txt').focus();};
  var msgs=document.getElementById('sib-msgs'),txt=document.getElementById('sib-txt'),go=document.getElementById('sib-go');
  function add(t,c){var d=document.createElement('div');d.className='sib-m '+c;d.textContent=t;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d;}
  function addImg(src){var i=document.createElement('img');i.src=src;i.className='sib-img';msgs.appendChild(i);msgs.scrollTop=msgs.scrollHeight;}
  function poll(taskId,w){
    fetch(B+'/api/v1/result/'+taskId,{headers:{'Authorization':'Bearer '+K}})
    .then(function(r){return r.json();}).then(function(res){
      if(res.status==='completed'){w.textContent=res.result||'✓';(res.attachments||[]).forEach(addImg);go.disabled=false;txt.disabled=false;}
      else if(res.status==='error'){w.textContent='❌ '+(res.error||'Ошибка');go.disabled=false;txt.disabled=false;}
      else{setTimeout(function(){poll(taskId,w);},2000);}
    }).catch(function(){setTimeout(function(){poll(taskId,w);},3000);});}
  function send(){var t=txt.value.trim();if(!t||go.disabled)return;txt.value='';add(t,'sib-u');var w=add('⏳ Думаю...','sib-a');go.disabled=true;txt.disabled=true;
    fetch(B+'/api/v1/analyze',{method:'POST',headers:{'Authorization':'Bearer '+K,'Content-Type':'application/json'},body:JSON.stringify({prompt:t})})
    .then(function(r){return r.json();}).then(function(d){
      if(d.taskId){setTimeout(function(){poll(d.taskId,w);},2000);}
      else{w.textContent='❌ '+(d.error||'Ошибка');go.disabled=false;txt.disabled=false;}
    }).catch(function(){w.textContent='❌ Ошибка соединения';go.disabled=false;txt.disabled=false;});}
  go.onclick=send;txt.onkeydown=function(e){if(e.key==='Enter')send();};
})();
</script>`,

    widgetScript: () => `<script src="${window.location.origin}/siberi-widget.js?token=${embedToken || apiKey}"></script>`,
    widgetWebView: () => `${window.location.origin}/chat-page?token=${embedToken || apiKey}`,

    fullpageUrl: () => `${window.location.origin}/chat-page?token=${embedToken || apiKey}`,

    fullpageIframe: () => `<iframe
  src="${window.location.origin}/chat-page?token=${embedToken || apiKey}"
  width="100%"
  height="700"
  style="border:none;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.12);"
  allow="microphone"
></iframe>`,

    deployLinux: () => `#!/bin/bash
# Siberi AI — Авто-установщик Telegram Bot (Linux/Mac)
set -e
echo "🚀 Установка Siberi AI Bot..."

if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

mkdir -p ~/siberi-bot && cd ~/siberi-bot

cat > bot.js << 'BOTEOF'
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const API_KEY = '${apiKey}';
const API_BASE = '${base}';
const TG_TOKEN = process.env.TG_TOKEN;
const bot = new TelegramBot(TG_TOKEN, { polling: true });
console.log('🤖 Siberi AI Bot запущен!');

async function waitResult(taskId) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const { data } = await axios.get(API_BASE+'/api/v1/result/'+taskId,
      { headers: { Authorization: 'Bearer '+API_KEY } });
    if (data.status === 'completed' || data.status === 'error') return data;
  }
  return { status: 'error', error: 'Timeout' };
}

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  try {
    const { data } = await axios.post(API_BASE+'/api/v1/analyze',
      { prompt: msg.text }, { headers: { Authorization: 'Bearer '+API_KEY } });
    if (!data.taskId) { bot.sendMessage(chatId, '❌ '+(data.error||'Ошибка')); return; }
    const result = await waitResult(data.taskId);
    if (result.status === 'completed') {
      await bot.sendMessage(chatId, result.result);
      for (const img of result.attachments || []) {
        const buf = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        await bot.sendPhoto(chatId, buf).catch(() => {});
      }
    } else { bot.sendMessage(chatId, '❌ '+(result.error||'Ошибка')); }
  } catch(e) { bot.sendMessage(chatId, '❌ '+e.message); }
});
BOTEOF

npm init -y > /dev/null && npm install node-telegram-bot-api axios
read -p "Введите токен Telegram бота: " TG_TOKEN
echo "TG_TOKEN=$TG_TOKEN" > .env
command -v pm2 &> /dev/null && pm2 start bot.js --name siberi-bot && pm2 save || TG_TOKEN=$TG_TOKEN node bot.js`,

    deployWindows: () => `# Siberi AI — Установщик для Windows (PowerShell)
Write-Host "🚀 Установка Siberi AI Bot..." -ForegroundColor Cyan
try { node --version | Out-Null } catch {
  Write-Host "📦 Установите Node.js: https://nodejs.org" -ForegroundColor Yellow
  Start-Process "https://nodejs.org"; Read-Host "После установки — Enter"
}
$dir = "$env:USERPROFILE\\siberi-bot"
New-Item -ItemType Directory -Force -Path $dir | Out-Null; Set-Location $dir
@'
const TelegramBot = require("node-telegram-bot-api"), axios = require("axios");
const API_KEY="${apiKey}", API_BASE="${base}", TG_TOKEN=process.env.TG_TOKEN;
const bot=new TelegramBot(TG_TOKEN,{polling:true});
console.log("🤖 Siberi AI Bot запущен!");
async function waitResult(taskId){
  for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,2000));
    const{data}=await axios.get(API_BASE+"/api/v1/result/"+taskId,{headers:{Authorization:"Bearer "+API_KEY}});
    if(data.status==="completed"||data.status==="error")return data;
  }
  return{status:"error",error:"Timeout"};
}
bot.on("message",async(msg)=>{
  if(!msg.text)return; const chatId=msg.chat.id;
  try{
    const{data}=await axios.post(API_BASE+"/api/v1/analyze",{prompt:msg.text},{headers:{Authorization:"Bearer "+API_KEY}});
    if(!data.taskId){bot.sendMessage(chatId,"❌ "+(data.error||"Ошибка"));return;}
    const result=await waitResult(data.taskId);
    if(result.status==="completed"){
      await bot.sendMessage(chatId,result.result);
      for(const img of result.attachments||[]){
        const buf=Buffer.from(img.replace(/^data:image\/\w+;base64,/,""),"base64");
        await bot.sendPhoto(chatId,buf).catch(()=>{});
      }
    }else{bot.sendMessage(chatId,"❌ "+(result.error||"Ошибка"));}
  }catch(e){bot.sendMessage(chatId,"❌ "+e.message);}
});
'@ | Set-Content bot.js
npm init -y | Out-Null; npm install node-telegram-bot-api axios
$token=Read-Host "Токен Telegram бота"; "TG_TOKEN=$token"|Set-Content .env
$env:TG_TOKEN=$token; node bot.js`,

    sdkCdn: () => `<script src="${window.location.origin}/siberi-sdk.js"></script>
<script>
  const api = SiberiAI({ apiKey: '${apiKey}' });
</script>`,

    sdkNode: () => `const SiberiAI = require('./siberi-sdk');
const api = SiberiAI({ apiKey: '${apiKey}' });`,
  };

  const dl = (code, filename) => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([code], { type: 'text/plain' })),
      download: filename,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  // ── Statuses ──────────────────────────────────────────────────────────────
  const tgBots = (status?.telegram || []).filter(b => b.connected);
  const vkGroups = (status?.vk || []).filter(b => b.connected);
  const maxBots = (status?.max || []).filter(b => b.connected);

  const tgStatus = tgBots.length > 1 ? `${tgBots.length} бота`
    : tgBots.length === 1 ? `@${tgBots[0].botUsername}` : null;
  const vkStatus = vkGroups.length > 1 ? `${vkGroups.length} группы`
    : vkGroups.length === 1 ? `Группа ${vkGroups[0].groupId}` : null;
  const maxStatus = maxBots.length > 1 ? `${maxBots.length} бота`
    : maxBots.length === 1 ? (maxBots[0].botUsername ? `@${maxBots[0].botUsername}` : maxBots[0].botName || 'Подключён') : null;

  const resolveProfileTag = (bots) => {
    if (bots.length !== 1 || !bots[0].profileId) return null;
    const p = profiles.find(x => x._id === bots[0].profileId || String(x._id) === String(bots[0].profileId));
    return p ? (p.profileName || p.aiName) : null;
  };
  const tgProfileTag  = resolveProfileTag(tgBots);
  const vkProfileTag  = resolveProfileTag(vkGroups);
  const maxProfileTag = resolveProfileTag(maxBots);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="integrations-page">
      {/* ── Onboarding checklist ─────────────────────────────────── */}
      {onboardingPlatforms.length > 0 && (
        <div className="card integ-ob">
          <div className="card__head">
            <h3><Zap size={16} /> Настройте выбранные интеграции</h3>
            <button className="ck__x" onClick={() => setOnboardingPlatforms([])}>
              <X size={16} />
            </button>
          </div>
          <div className="integ-ob__steps">
            {onboardingPlatforms.map((key) => {
              const done = isIntegrationDone(key);
              return (
                <button
                  key={key}
                  className={`btn btn--ghost btn--sm ${done ? 'integ-ob__step--done' : ''}`}
                  onClick={() => openModal(PLATFORM_MODAL_MAP[key])}
                >
                  {done
                    ? <Check size={14} />
                    : <span className="integ-ob__arrow">→</span>
                  }
                  {PLATFORM_LABELS[key]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tab nav ──────────────────────────────────────────────── */}
      <div className="seg">
        <button className={`seg__b ${activeTab === 'no-code' ? 'seg__b--active' : ''}`} onClick={() => setActiveTab('no-code')}>
          <Zap size={15} /> Без кода
        </button>
        <button className={`seg__b ${activeTab === 'developer' ? 'seg__b--active' : ''}`} onClick={() => setActiveTab('developer')}>
          <Code2 size={15} /> Для разработчиков
        </button>
      </div>

      {/* ════════════════════════════════════════════════════════════
          БЕЗ КОДА
      ════════════════════════════════════════════════════════════ */}
      {activeTab === 'no-code' && (
        <div className="integ-tab-content">

          <div className="igroup">
            <div className="igroup__t">Мессенджеры</div>
            <div className="igrid">

              <IntegCard
                icon={<TelegramIcon size={44} />}
                title="Telegram Bot"
                desc="Бот отвечает сам — просто вставьте токен. Никакого сервера."
                badge={tgBots.length > 0 ? (tgBots.length > 1 ? `${tgBots.length} бота` : 'Подключён') : 'Hosted'}
                badgeType={tgBots.length > 0 ? 'green' : 'blue'}
                status={tgStatus}
                profileTag={tgProfileTag}
                onOpen={() => openModal('telegram')}
              />

              <IntegCard
                icon={<VKIcon size={44} />}
                title="VK Bot (Callback API)"
                desc="Бот для вашего сообщества ВКонтакте — через Callback API."
                badge={vkGroups.length > 0 ? (vkGroups.length > 1 ? `${vkGroups.length} группы` : 'Подключён') : 'Hosted'}
                badgeType={vkGroups.length > 0 ? 'green' : 'blue'}
                status={vkStatus}
                profileTag={vkProfileTag}
                onOpen={() => openModal('vk')}
              />

              <IntegCard
                icon={<MAXIcon size={44} />}
                title="MAX Bot"
                desc="Мессенджер MAX от VK — автоматические ответы в вашем боте."
                badge="Скоро"
                badgeType="gray"
                disabled
              />

            </div>
          </div>

          <div className="igroup">
            <div className="igroup__t">Уведомления</div>
            <div className="igrid">

              <IntegCard
                icon={<div className="ci ci--wh"><Link2 size={20} /></div>}
                title="Webhook-уведомления"
                desc="Получайте ответы AI на ваш сервер сразу после обработки."
                badge={whEnabled && whUrl ? 'Включён' : undefined}
                badgeType="green"
                onOpen={() => openModal('webhook')}
              />

            </div>
          </div>

          <div className="igroup">
            <div className="igroup__t">На ваш сайт</div>
            <div className="igrid">

              <IntegCard
                icon={<div className="ci ci--web"><Globe size={20} /></div>}
                title="Онлайн-консультант"
                desc="Плавающая кнопка чата в углу сайта. Один тег — и готово."
                badge="1 строка"
                badgeType="purple"
                onOpen={() => openModal('widgetEmbed')}
              />

              <IntegCard
                icon={<div className="ci ci--page"><Monitor size={20} /></div>}
                title="Страница AI-чата"
                desc="Готовая страница с полноэкранным чатом — поделитесь ссылкой или встройте через iframe."
                badge="Ссылка"
                badgeType="purple"
                onOpen={() => openModal('fullpage')}
              />

            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          ДЛЯ РАЗРАБОТЧИКОВ
      ════════════════════════════════════════════════════════════ */}
      {activeTab === 'developer' && (
        <div className="integ-tab-content">

          <div className="dev-api-note">
            <Zap size={16} />
            <div>
              <strong>Асинхронный API:</strong> <code>POST /api/v1/analyze</code> → <code>{'{ taskId }'}</code> → <code>GET /api/v1/result/:taskId</code>
              <span className="dev-api-note__auth"> Auth: <code>Authorization: Bearer {apiKey || 'YOUR_API_KEY'}</code></span>
            </div>
          </div>

          <div className="igroup">
            <div className="igroup__t">Мессенджеры</div>
            <div className="igrid">
              <IntegCard
                icon={<TelegramIcon size={44} />}
                title="Telegram Bot"
                desc="Node.js шаблон с polling — запустите за 2 минуты."
                badge="Node.js"
                badgeType="green"
                onOpen={() => openModal('tgCode')}
              />
              <IntegCard
                icon={<VKIcon size={44} />}
                title="VK Bot (Long Poll)"
                desc="Бот для сообщества ВКонтакте — через vk-io."
                badge="Node.js"
                badgeType="green"
                onOpen={() => openModal('vkCode')}
              />
              <IntegCard
                icon={<MAXIcon size={44} />}
                title="MAX Bot"
                desc="Мессенджер MAX от VK — Long Polling API."
                badge="Скоро"
                badgeType="gray"
                disabled
              />
            </div>
          </div>

          <div className="igroup">
            <div className="igroup__t">На сайт</div>
            <div className="igrid">
              <IntegCard
                icon={<div className="ci ci--web"><Globe size={20} /></div>}
                title="Онлайн-консультант (виджет)"
                desc="Плавающая кнопка 💬 — вставьте один тег перед </body>."
                badge="HTML"
                badgeType="purple"
                onOpen={() => openModal('widget')}
              />
              <IntegCard
                icon={<div className="ci ci--page"><Monitor size={20} /></div>}
                title="Страница AI-чата"
                desc="Готовая страница с полноэкранным чатом — поделитесь ссылкой или встройте через iframe."
                badge="Ссылка"
                badgeType="purple"
                onOpen={() => openModal('fullpage')}
              />
            </div>
          </div>

          <div className="igroup">
            <div className="igroup__t">Автоматизация деплоя</div>
            <div className="igrid">
              <IntegCard
                icon={<div className="ci ci--srv"><Server size={20} /></div>}
                title="Авто-установщик Linux / Mac"
                desc="bash-скрипт: установит Node.js, настроит PM2, запустит бота."
                badge="bash"
                badgeType="gray"
                onOpen={() => openModal('deployLinux')}
              />
              <IntegCard
                icon={<div className="ci ci--srv"><Server size={20} /></div>}
                title="Авто-установщик Windows"
                desc="PowerShell-скрипт: то же самое, только для Windows."
                badge="PowerShell"
                badgeType="gray"
                onOpen={() => openModal('deployWindows')}
              />
            </div>
          </div>

          <div className="igroup">
            <div className="igroup__t">SDK</div>
            <div className="igrid">
              <IntegCard
                icon={<div className="ci ci--sdk"><Code2 size={20} /></div>}
                title="JavaScript SDK"
                desc="Используйте API из любого JS-проекта — браузер или Node.js."
                badge="JS"
                badgeType="blue"
                onOpen={() => openModal('sdk')}
              />
            </div>
          </div>

        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          MODALS
      ════════════════════════════════════════════════════════════ */}

      {/* Telegram hosted */}
      {modal === 'telegram' && (
        <Modal title="Telegram Bot" subtitle="Подключите бота без написания кода" onClose={closeModal}>
          {tgStep === 'list' && (
            <>
              <div className="integ-instances-list">
                {(status?.telegram || []).map(bot => {
                  const botProfile = bot.profileId ? profiles.find(p => String(p._id) === String(bot.profileId)) : null;
                  return (
                  <div key={bot.id} className="row">
                    <div className="row__top">
                      <Bot size={15} />
                      <span>{bot.botUsername ? `@${bot.botUsername}` : bot.name || 'Бот'}</span>
                      {bot.connected && <span className="idot" />}
                      {botProfile && <span className="chip chip--soft">{botProfile.profileName || botProfile.aiName}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => { closeModal(); navigate(`/studio?profileId=${bot.profileId}`); }}
                        title="Настроить бота в Bot Studio"
                      >
                        <Settings size={12} /> Настроить
                      </button>
                      <button className="btn btn--danger btn--sm" onClick={() => disconnectTelegram(bot.id)} disabled={tgLoading}>
                        {tgLoading ? <Loader2 size={12} className="spin" /> : <Unplug size={12} />} Отключить
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
              <button className="btn btn--ghost btn--sm" style={{ marginTop: 14 }} onClick={() => { setTgProfileId(profiles[0]?._id || ''); setTgStep('profile'); }}>
                <Plus size={14} /> Добавить бота
              </button>
            </>
          )}
          {tgStep === 'profile' && (
            <>
              <ProfileSelector
                profiles={profiles}
                selectedId={tgProfileId}
                onSelect={setTgProfileId}
                onNavigate={() => { closeModal(); navigate('/settings?highlight=new-profile'); }}
              />
              <div className="modal-btn-row" style={{ marginTop: 16 }}>
                {(status?.telegram || []).length > 0 && (
                  <button className="ck__back" onClick={() => setTgStep('list')}>← Назад</button>
                )}
                <button className="btn btn--primary" onClick={() => setTgStep('setup')} disabled={!tgProfileId}>
                  Далее →
                </button>
              </div>
            </>
          )}
          {tgStep === 'setup' && (
            <>
              <ol className="ig__steps">
                <li>Откройте <strong>@BotFather</strong> в Telegram</li>
                <li>Команда <code>/newbot</code>, придумайте имя и @username</li>
                <li>Скопируйте токен и вставьте ниже</li>
              </ol>
              <div className="field">
                <label>Название (для вашего удобства)</label>
                <input className="inp" placeholder="Например: Бот для клиентов" value={tgName} onChange={e => setTgName(e.target.value)} />
              </div>
              <div className="ig__row">
                <input
                  className="inp"
                  placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connectTelegram()}
                />
                <button className="btn btn--primary" onClick={connectTelegram} disabled={tgLoading || !tgToken.trim()}>
                  {tgLoading ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Подключить
                </button>
              </div>
              {tgError && <div className="modal-error">{tgError}</div>}
              <button className="ck__back" onClick={() => setTgStep('profile')}>← Назад</button>
              <div className="ig__note"><Shield size={13} /> Токен хранится зашифровано на нашем сервере</div>
            </>
          )}
          {tgStep === 'done' && (
            <>
              <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
                <div className="ig__done-t">Бот подключён!</div>
                <div className="ig__done-d">
                  Теперь настройте поведение бота — команды, меню, приветствие и ответы.
                </div>
                <button
                  className="btn btn--primary"
                  style={{ width: '100%', justifyContent: 'center', gap: 8, marginBottom: 10 }}
                  onClick={() => { closeModal(); navigate(`/studio?profileId=${tgProfileId}`); }}
                >
                  <Settings size={16} /> Настроить бота в Bot Studio
                </button>
                <button className="ck__back" onClick={() => { setTgStep('list'); }}>
                  Пропустить →
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* VK hosted */}
      {modal === 'vk' && (
        <Modal title="VK Bot (Callback API)" subtitle="Автоматические ответы в вашем сообществе ВКонтакте" onClose={closeModal}>
          {vkStep === 'list' && (
            <>
              <div className="integ-instances-list">
                {(status?.vk || []).map(grp => (
                  <div key={grp.id} className="row">
                    <div className="row__top">
                      <VKIcon size={15} />
                      <span>{grp.name || `Группа ${grp.groupId}`}</span>
                      {grp.connected && <span className="idot" />}
                    </div>
                    <button className="btn btn--danger btn--sm" onClick={() => disconnectVk(grp.id)} disabled={vkLoading}>
                      {vkLoading ? <Loader2 size={12} className="spin" /> : <Unplug size={12} />} Отключить
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn--ghost btn--sm" style={{ marginTop: 14 }} onClick={() => { setVkProfileId(profiles[0]?._id || ''); setVkStep('profile'); }}>
                <Plus size={14} /> Добавить группу
              </button>
            </>
          )}
          {vkStep === 'profile' && (
            <>
              <ProfileSelector
                profiles={profiles}
                selectedId={vkProfileId}
                onSelect={setVkProfileId}
                onNavigate={() => { closeModal(); navigate('/settings?highlight=new-profile'); }}
              />
              <div className="modal-btn-row" style={{ marginTop: 16 }}>
                {(status?.vk || []).length > 0 && (
                  <button className="ck__back" onClick={() => setVkStep('list')}>← Назад</button>
                )}
                <button className="btn btn--primary" onClick={() => setVkStep('form')} disabled={!vkProfileId}>
                  Далее →
                </button>
              </div>
            </>
          )}
          {vkStep === 'form' && (
            <>
              <ol className="ig__steps">
                <li>Откройте сообщество → <strong>Управление</strong> → в левом меню <strong>«Дополнительно»</strong> → справа появится <strong>«Работа с API»</strong></li>
                <li>Вкладка <strong>«Ключи доступа»</strong> → «Создать ключ» → поставьте галочку <strong>«Сообщения сообщества»</strong> → скопируйте ключ (начинается с vk1.a...)</li>
                <li>ID или адрес сообщества: из URL vk.com/club<strong>238714065</strong> → <strong>238714065</strong>, или vk.com/<strong>mudakoff</strong> → <strong>mudakoff</strong></li>
                <li>Секретный ключ — придумайте любую строку (например: <strong>mySecret123</strong>). Запомните её — она понадобится на следующем шаге</li>
              </ol>
              <div className="field">
                <label>Название (для вашего удобства)</label>
                <input className="inp" placeholder="Например: Основная группа" value={vkName} onChange={e => setVkName(e.target.value)} />
              </div>
              <div className="field">
                <label>Токен сообщества</label>
                <input className="inp" placeholder="vk1.a.xxx..." value={vkToken} onChange={(e) => setVkToken(e.target.value)} />
              </div>
              <div className="field">
                <label>ID или адрес сообщества</label>
                <input className="inp" placeholder="123456789 или mudakoff или club123456" value={vkGroupId} onChange={(e) => setVkGroupId(e.target.value.trim())} />
              </div>
              <div className="field">
                <label>Секретный ключ <span className="modal-optional">(рекомендуется)</span></label>
                <input className="inp" placeholder="Любая строка, например: mySecret123" value={vkSecret} onChange={(e) => setVkSecret(e.target.value)} />
              </div>
              {vkError && <div className="modal-error">{vkError}</div>}
              <div className="modal-btn-row">
                <button className="ck__back" onClick={() => setVkStep('profile')}>← Назад</button>
                <button className="btn btn--primary" onClick={setupVk} disabled={vkLoading || !vkToken.trim() || !vkGroupId.trim()}>
                  {vkLoading ? <Loader2 size={15} className="spin" /> : null} Далее →
                </button>
              </div>
            </>
          )}
          {vkStep === 'confirm' && (
            <>
              <ol className="ig__steps" style={{ counterReset: 'ig 4' }}>
                <li>В <strong>«Работа с API»</strong> → вкладка <strong>«Callback API»</strong> → нажмите <strong>«Добавить сервер»</strong> → вставьте URL ниже, придумайте название → нажмите «Добавить»</li>
                <li>VK покажет <strong>строку подтверждения</strong> (например: a7f56afa) — скопируйте её в поле ниже, затем нажмите <strong>«Подключить»</strong></li>
                <li>В поле <strong>«Секретный ключ»</strong> в VK введите ту же строку что вы указали на шаге 4 → нажмите <strong>«Сохранить»</strong></li>
                <li>Нажмите <strong>«Подтвердить»</strong> в VK — сервер должен подтвердиться ✓</li>
                <li>Вкладка <strong>«Типы событий»</strong> → включите <strong>«Входящее сообщение»</strong> и остальные нужные → нажмите <strong>«Сохранить»</strong></li>
              </ol>
              <div className="modal-confirm-box" style={{ marginTop: 12 }}>
                <p>Ваш webhook URL:</p>
                <div className="modal-copy-row">
                  <code className="modal-url">{vkWebhookUrl}</code>
                  <button className="row__btn" onClick={() => copy(vkWebhookUrl, 'vkurl')}>
                    {copied === 'vkurl' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
              <div className="field" style={{ marginTop: 14 }}>
                <label>Строка подтверждения из VK <span className="modal-optional">(шаг 6)</span></label>
                <input
                  className="inp"
                  placeholder="Например: a7f56afa"
                  value={vkConfirmStr}
                  onChange={(e) => setVkConfirmStr(e.target.value)}
                />
              </div>
              {vkError && <div className="modal-error">{vkError}</div>}
              <div className="modal-btn-row">
                <button className="ck__back" onClick={() => setVkStep('form')}>← Назад</button>
                <button className="btn btn--primary" onClick={activateVk} disabled={vkLoading || !vkConfirmStr.trim()}>
                  {vkLoading ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Подключить
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* MAX hosted */}
      {modal === 'max' && (
        <Modal title="MAX Bot" subtitle="Автоматические ответы в вашем боте MAX от VK" onClose={closeModal}>
          {maxStep === 'list' && (
            <>
              <div className="integ-instances-list">
                {(status?.max || []).map(bot => (
                  <div key={bot.id} className="row">
                    <div className="row__top">
                      <MAXIcon size={15} />
                      <span>{bot.botUsername ? `@${bot.botUsername}` : bot.botName || bot.name || 'Бот'}</span>
                      {bot.connected && <span className="idot" />}
                    </div>
                    <button className="btn btn--danger btn--sm" onClick={() => disconnectMax(bot.id)} disabled={maxLoading}>
                      {maxLoading ? <Loader2 size={12} className="spin" /> : <Unplug size={12} />} Отключить
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn--ghost btn--sm" style={{ marginTop: 14 }} onClick={() => { setMaxProfileId(profiles[0]?._id || ''); setMaxStep('profile'); }}>
                <Plus size={14} /> Добавить бота
              </button>
            </>
          )}
          {maxStep === 'profile' && (
            <>
              <ProfileSelector
                profiles={profiles}
                selectedId={maxProfileId}
                onSelect={setMaxProfileId}
                onNavigate={() => { closeModal(); navigate('/settings?highlight=new-profile'); }}
              />
              <div className="modal-btn-row" style={{ marginTop: 16 }}>
                {(status?.max || []).length > 0 && (
                  <button className="ck__back" onClick={() => setMaxStep('list')}>← Назад</button>
                )}
                <button className="btn btn--primary" onClick={() => setMaxStep('setup')} disabled={!maxProfileId}>
                  Далее →
                </button>
              </div>
            </>
          )}
          {maxStep === 'setup' && (
            <>
              <ol className="ig__steps">
                <li>Откройте <strong>bots.max.ru</strong> → создайте бота → скопируйте токен</li>
                <li>Вставьте токен ниже и нажмите «Подключить» — webhook зарегистрируется автоматически</li>
              </ol>
              <div className="field">
                <label>Название (для вашего удобства)</label>
                <input className="inp" placeholder="Например: Основной бот" value={maxName} onChange={e => setMaxName(e.target.value)} />
              </div>
              <div className="field" style={{ marginTop: 8 }}>
                <label>Токен бота</label>
                <input
                  className="inp"
                  placeholder="Токен из bots.max.ru"
                  value={maxToken}
                  onChange={(e) => setMaxToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connectMax()}
                />
              </div>
              {maxError && <div className="modal-error">{maxError}</div>}
              <div className="modal-btn-row">
                <button className="ck__back" onClick={() => setMaxStep('profile')}>← Назад</button>
                <button className="btn btn--primary" onClick={connectMax} disabled={maxLoading || !maxToken.trim()}>
                  {maxLoading ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Подключить
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* MAX code (developer tab) */}
      {modal === 'maxCode' && (
        <Modal title="MAX Bot" subtitle="Long Polling — запустите на своём сервере" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Зарегистрируйте бота на <strong>bots.max.ru</strong></li>
            <li>Скопируйте токен, замените <code>YOUR_MAX_BOT_TOKEN</code> в коде</li>
            <li><code>npm install axios</code> → <code>node max-bot.js</code></li>
          </ol>
          <CodeBlock code={codes.maxBot()} filename="max-bot.js" onDownload={() => dl(codes.maxBot(), 'max-bot.js')} />
        </Modal>
      )}

      {/* Webhook callback */}
      {modal === 'webhook' && (
        <Modal title="Webhook-уведомления" subtitle="Получайте результаты AI на ваш сервер" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Укажите URL вашего сервера, который будет принимать POST-запросы</li>
            <li>После каждого ответа AI мы пришлём туда JSON с результатом</li>
          </ol>
          <div className="webhook-toggle" style={{ marginBottom: 12 }}>
            <label className="toggle-switch">
              <input type="checkbox" checked={whEnabled} onChange={(e) => setWhEnabled(e.target.checked)} />
              <span className="toggle-slider" />
            </label>
            <span>Включить webhook</span>
          </div>
          <div className="ig__row">
            <input className="inp" type="url" placeholder="https://your-server.com/webhook"
              value={whUrl} onChange={(e) => setWhUrl(e.target.value)} disabled={!whEnabled} />
            <button className="btn btn--primary" onClick={saveWebhook} disabled={whSaving}>
              {whSaving ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Сохранить
            </button>
          </div>
          <div className="ig__note" style={{ marginTop: 14 }}>
            Формат POST-запроса: <code>{`{"source":"vk","prompt":"...","result":"...","attachments":["data:image/png;base64,..."],"taskId":"..."}`}</code>
          </div>
        </Modal>
      )}

      {/* Widget — no-code embed (Без кода tab) */}
      {modal === 'widgetEmbed' && (
        <Modal title="Онлайн-консультант" subtitle="Плавающая кнопка 💬 в углу сайта, приложения или любой страницы" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Для сайтов — один тег перед <code>&lt;/body&gt;</code></li>
            <li>Для iOS / Android — откройте страницу чата в WebView</li>
            <li>Готово — никаких зависимостей, серверов и настроек</li>
          </ol>

          <div className="widget-embed-section">
            <div className="widget-embed-label">
              <Globe size={14} />
              Для сайтов — вставьте перед <code>&lt;/body&gt;</code>
            </div>
            <div className="widget-embed-row">
              <div className="widget-embed-code">{codes.widgetScript()}</div>
              <button className="row__btn" onClick={() => copy(codes.widgetScript(), 'wScript')} title="Скопировать">
                {copied === 'wScript' ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
          </div>

          <div className="widget-embed-section">
            <div className="widget-embed-label">
              <Monitor size={14} />
              Для iOS / Android — WebView или In-App Browser
            </div>
            <div className="widget-embed-row">
              <div className="widget-embed-code" style={{ fontSize: 12 }}>{codes.widgetWebView()}</div>
              <button className="row__btn" onClick={() => copy(codes.widgetWebView(), 'wWebView')} title="Скопировать">
                {copied === 'wWebView' ? <Check size={15} /> : <Copy size={15} />}
              </button>
              <a href={codes.widgetWebView()} target="_blank" rel="noopener noreferrer" className="row__btn" title="Открыть">
                <ExternalLink size={15} />
              </a>
            </div>
          </div>

          <div className="ig__hint">
            <Shield size={14} />
            <span>Ссылки используют одноразовый <b>embed-токен</b> (30 дней) — ваш основной API-ключ не попадает в URL.</span>
            <button
              onClick={refreshEmbedToken}
              disabled={embedTokenLoading}
              className="btn btn--ghost btn--sm ig__hint-act"
            >
              {embedTokenLoading ? 'Обновление...' : 'Обновить токен'}
            </button>
          </div>
          <div className="ig__hint ig__hint--block">
            <b>Управление доступом:</b> чтобы AI знал роль конкретного пользователя (администратор / обычный) — добавьте <code>&amp;userId=ID</code> к ссылке или тегу. ID берёте из вашей собственной системы. Пример: <code>?token=...&amp;userId=user_123</code>
          </div>
        </Modal>
      )}

      {/* Widget — full code (Для разработчиков tab) */}
      {modal === 'widget' && (
        <Modal title="Онлайн-консультант" subtitle="Плавающая кнопка 💬 — полный JS-код для кастомизации" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Скопируйте код ниже</li>
            <li>Вставьте перед <code>&lt;/body&gt;</code> на любой странице сайта</li>
            <li>Измените стили и текст под ваш проект</li>
          </ol>
          <CodeBlock code={codes.widget()} filename="widget.html" />
        </Modal>
      )}

      {/* Fullpage */}
      {modal === 'fullpage' && (
        <Modal title="Страница AI-чата" subtitle="Готовая страница с полноэкранным чатом — поделитесь ссылкой или встройте через iframe" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Скопируйте ссылку и поделитесь с пользователями</li>
            <li>Или встройте чат на сайт через iframe — одна строка кода</li>
            <li>Страница уже готова: голос, картинки, Markdown — всё включено</li>
          </ol>

          <div className="igroup__t">
            Ссылка на страницу
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
            <div className="widget-embed-code">
              {codes.fullpageUrl()}
            </div>
            <button
              className="row__btn"
              onClick={() => copy(codes.fullpageUrl(), 'fpUrl')}
              title="Скопировать"
            >
              {copied === 'fpUrl' ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <a
              href={codes.fullpageUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="row__btn"
              title="Открыть"
            >
              <ExternalLink size={15} />
            </a>
          </div>

          <CodeBlock code={codes.fullpageIframe()} filename="embed.html" />

          <div className="ig__hint">
            <Shield size={14} />
            <span>Ссылки используют <b>embed-токен</b> (30 дней) вместо основного API-ключа.</span>
            <button
              onClick={refreshEmbedToken}
              disabled={embedTokenLoading}
              className="btn btn--ghost btn--sm ig__hint-act"
            >
              {embedTokenLoading ? 'Обновление...' : 'Обновить токен'}
            </button>
          </div>
          <div className="ig__hint ig__hint--block">
            <b>Управление доступом:</b> добавьте <code>&amp;userId=ID</code> к ссылке — AI определит роль пользователя (администратор / обычный). ID берёте из вашей системы. Пример: <code>?token=...&amp;userId=user_123</code>
          </div>
        </Modal>
      )}

      {/* TG code (dev tab) */}
      {modal === 'tgCode' && (
        <Modal title="Telegram Bot (код)" subtitle="Запустите бота на своём сервере" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Создайте бота через <strong>@BotFather</strong> → команда <code>/newbot</code></li>
            <li>Замените <code>YOUR_TELEGRAM_BOT_TOKEN</code> в коде</li>
            <li><code>npm install node-telegram-bot-api axios</code> → <code>node bot.js</code></li>
          </ol>
          <CodeBlock code={codes.tgBot()} filename="bot.js" onDownload={() => dl(codes.tgBot(), 'bot.js')} />
        </Modal>
      )}

      {/* VK code (dev tab) */}
      {modal === 'vkCode' && (
        <Modal title="VK Bot (Long Poll)" subtitle="Long Polling через библиотеку vk-io — запустите на своём сервере" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Сообщество → <strong>Управление → Дополнительно → Работа с API</strong></li>
            <li>Вкладка <strong>«Ключи доступа»</strong> → «Создать ключ» → включите <strong>«Сообщения сообщества»</strong> → скопируйте ключ</li>
            <li>Замените <code>YOUR_VK_COMMUNITY_TOKEN</code> и <code>YOUR_SIBERI_API_KEY</code> в коде ниже</li>
            <li><code>npm install vk-io axios</code> → <code>node vk-bot.js</code></li>
          </ol>
          <CodeBlock code={codes.vkBot()} filename="vk-bot.js" onDownload={() => dl(codes.vkBot(), 'vk-bot.js')} />
        </Modal>
      )}

      {/* Deploy Linux */}
      {modal === 'deployLinux' && (
        <Modal title="Авто-установщик Linux / Mac" subtitle="bash-скрипт: Node.js + PM2 + бот" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Скачайте скрипт и запустите: <code>bash siberi-install.sh</code></li>
            <li>Введите токен Telegram бота при запросе</li>
            <li>Бот запустится через PM2 с автозапуском при перезагрузке</li>
          </ol>
          <CodeBlock code={codes.deployLinux()} filename="siberi-install.sh" onDownload={() => dl(codes.deployLinux(), 'siberi-install.sh')} />
        </Modal>
      )}

      {/* Deploy Windows */}
      {modal === 'deployWindows' && (
        <Modal title="Авто-установщик Windows" subtitle="PowerShell-скрипт" onClose={closeModal}>
          <ol className="ig__steps">
            <li>Скачайте файл .ps1</li>
            <li>Правая кнопка → «Выполнить с помощью PowerShell»</li>
            <li>Введите токен Telegram бота при запросе</li>
          </ol>
          <CodeBlock code={codes.deployWindows()} filename="siberi-install.ps1" onDownload={() => dl(codes.deployWindows(), 'siberi-install.ps1')} />
        </Modal>
      )}

      {/* SDK */}
      {modal === 'sdk' && (
        <Modal title="JavaScript SDK" subtitle="Используйте API из любого JS-проекта" onClose={closeModal}>
          <div className="field">
            <label><span className="chip chip--soft">Браузер</span> Подключить через &lt;script&gt;</label>
            <div className="sdk-snippet">
              <pre>{codes.sdkCdn()}</pre>
              <button className="row__btn sdk-copy-btn" onClick={() => copy(codes.sdkCdn(), 'cdn')}>
                {copied === 'cdn' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <div className="field">
            <label><span className="chip chip--ok">Node.js</span> Скачать и подключить локально</label>
            <div className="sdk-snippet">
              <pre>{codes.sdkNode()}</pre>
              <button className="row__btn sdk-copy-btn" onClick={() => copy(codes.sdkNode(), 'node')}>
                {copied === 'node' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <a className="sdk-download-link" href="/siberi-sdk.js" download="siberi-sdk.js">
              <ExternalLink size={13} /> Скачать siberi-sdk.js
            </a>
          </div>
          <div className="sdk-examples">
            <div className="sdk-examples__title"><Zap size={14} /> Примеры</div>
            <div className="sdk-examples__grid">
              <div className="sdk-example"><div className="sdk-example__label">Список записей</div>
                <pre>{`const { records } = await api.records.list('products');`}</pre></div>
              <div className="sdk-example"><div className="sdk-example__label">Создать запись</div>
                <pre>{`await api.records.create('orders', { client: 'Иван', amount: 5000 });`}</pre></div>
              <div className="sdk-example"><div className="sdk-example__label">Спросить AI</div>
                <pre>{`const answer = await api.chat.send('Сколько заказов за сегодня?');`}</pre></div>
              <div className="sdk-example"><div className="sdk-example__label">Поиск</div>
                <pre>{`await api.records.list('clients', { search: 'Иван', limit: 20 });`}</pre></div>
            </div>
          </div>
          <div className="sdk-note"><Shield size={13} /> Держите API-ключ на сервере — не вставляйте в публичный клиентский код.</div>
        </Modal>
      )}

    </div>
  );
}
