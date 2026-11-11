import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamingPoll, stripSystemTags } from '../hooks/useStreamingPoll';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useTutorial } from '../context/TutorialContext';
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  Lock,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  Send,
  SlidersHorizontal,
  Trash2,
  User,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import './BotStudio.css';
import MarkdownText from '../components/MarkdownText';

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

const TRIGGER_LABELS = { respond_all: 'На каждое сообщение', mention_only: 'Только при упоминании' };
const HISTORY_LABELS  = { personal: 'Личная у каждого', shared: 'Общая на весь чат' };

const TUTORIAL_STEPS = [
  {
    selector: '.studio-chat-panel',
    text: 'Главный инструмент Bot Studio — этот чат внизу. Пишите сюда на русском, и AI сам всё сделает:\n\n• «Обнови раздел Услуги — добавь стрижку за 500 руб.» — изменит данные\n• «Сделай меню с кнопками Запись / Услуги / Контакты» — создаст меню Telegram-бота\n• «Напоминай о записи за час» — настроит уведомление\n• «Сделай бота строже и добавь приветствие» — отредактирует настройки AI',
  },
  {
    selector: '.studio-preview',
    text: 'Справа — симулятор Telegram-бота. Здесь вы сразу видите, как бот ответит вашему клиенту — прямо в интерфейсе, похожем на настоящий Telegram.\n\nТестируйте до публикации: если что-то не так — уточните запрос в чате внизу.',
  },
  {
    selector: '.studio-config',
    text: 'Левая панель — полная конфигурация бота:\n\n• Приветствие — сообщение при /start\n• Триггер — слово для активации в группах\n• Промт — главная инструкция AI\n• Запреты — темы, которые бот игнорирует\n\nМожно редактировать вручную или через чат справа.\n\n↕ Панель прокручивается — посмотрите полосу прокрутки справа, там ещё есть разделы.',
  },
  {
    selector: '.studio-profile-picker',
    text: 'Выбор профиля — у каждого профиля своя конфигурация бота. Один профиль = один бот с уникальным поведением.\n\nПереключайтесь здесь, чтобы редактировать разные боты.',
  },
  {
    selector: '.studio-save-btn',
    selectorExtra: '.studio-restart-btn',
    text: '«Сохранить» — применяет все изменения в конфигурации.\n\n«Начать заново» — сбрасывает бота к заводским настройкам, если хотите начать с чистого листа.',
  },
];

export default function BotStudio({ apiKey }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const profileId = searchParams.get('profileId') || '';
  const { enabled, startTutorial, isActive, skipped, completedPaths } = useTutorial();

  // Profile picker
  const [profiles, setProfiles]               = useState([]);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const [config, setConfig] = useState(null);   // current profile config
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  // Studio AI chat state
  const [messages, setMessages] = useState([
    { role: 'ai', text: 'Привет! Я помогу настроить твоего бота. Опиши что хочешь изменить — например:\n«Сделай так чтобы бот отвечал только когда его называют по имени» или «Добавь команду /помощь с приветственным текстом».' },
  ]);
  const [input, setInput]     = useState('');
  const studioCompleteRef = useRef(null);
  const { loading: sending, setLoading: setSending, streamingText: studioStreamText, isStreaming: studioStreaming, startPolling: startStudioPoll, stopPolling: stopStudioPoll } = useStreamingPoll({
    apiKey,
    onComplete: (data) => {
      if (studioCompleteRef.current) studioCompleteRef.current(data);
      inputRef.current?.focus();
    },
    onError: (msg) => {
      setMessages(m => [...m, { role: 'ai', text: `Ошибка: ${msg}` }]);
      inputRef.current?.focus();
    },
  });
  const [pendingImage, setPendingImage] = useState(null);
  const [recording, setRecording]       = useState(false);
  const fileInputRef      = useRef(null);
  const recognitionRef    = useRef(null);
  const finalTranscriptRef = useRef('');
  const voiceBaseRef      = useRef('');

  // Telegram simulator state
  const [simMessages, setSimMessages] = useState([]);
  const [simInput, setSimInput]       = useState('');
  const [simMenuOpen, setSimMenuOpen] = useState(false);
  const [simKeyboard, setSimKeyboard] = useState(null); // [[row]] ReplyKeyboardMarkup
  // Экран, на котором СЕЙЧАС стоит предпросмотр (последняя команда, чей ответ
  // показан). Шлётся в /studio/chat как currentScreen → ИИ понимает, какой экран
  // правит, когда пользователь пишет «поменяй текст на …» без указания экрана.
  const [simScreen, setSimScreen]     = useState('/start');
  const simScreenRef = useRef('/start');
  const setSimScreenBoth = (name) => { const v = name || '/start'; simScreenRef.current = v; setSimScreen(v); };
  const simEndRef = useRef(null);

  // Left panel view mode
  const [leftMode, setLeftMode] = useState('ui'); // 'ui' | 'code'
  const leftModeRef = useRef('ui');
  const configRef   = useRef(null);

  // Code export (Pro/Premium only) — full standalone bot project
  const [canExportCode, setCanExportCode] = useState(false);
  const [exportFiles, setExportFiles]     = useState(null);  // { 'index.js': '...', ... }
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError]     = useState('');
  const [activeFile, setActiveFile]       = useState('index.js');
  const [downloading, setDownloading]     = useState(false);

  // Reset / confirm dialog
  const [resetConfirm, setResetConfirm] = useState(false);

  const chatEndRef      = useRef(null);
  const inputRef        = useRef(null);
  const pollTimeoutRef  = useRef(null);
  const autoSaveTimer   = useRef(null);
  const initialLoad     = useRef(true); // skip auto-save on first load

  const speechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => { leftModeRef.current = leftMode; }, [leftMode]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => () => clearTimeout(pollTimeoutRef.current), []);

  const configLoaded = !loading && !!config;
  useEffect(() => {
    if (enabled && !isActive && !skipped && !completedPaths.has('/studio') && configLoaded) {
      const t = setTimeout(() => {
        if (window.location.pathname === '/studio') {
          startTutorial(TUTORIAL_STEPS, '/studio');
        }
      }, 500);
      return () => clearTimeout(t);
    }
  }, [enabled, isActive, skipped, completedPaths, configLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImageFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const raw = e.target.result;
      const img = new Image();
      img.onload = () => {
        const MAX_PX = 1920;
        const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        setPendingImage(canvas.toDataURL('image/jpeg', 0.85));
        inputRef.current?.focus();
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  }, []);

  // Paste image from clipboard
  useEffect(() => {
    const onPaste = (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find((it) => it.type.startsWith('image/'));
      if (imageItem) { e.preventDefault(); handleImageFile(imageItem.getAsFile()); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleImageFile]);

  const toggleVoice = useCallback(() => {
    if (recording) {
      recognitionRef.current?.stop();
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recog = new SpeechRecognition();
    recognitionRef.current = recog;
    recog.lang = 'ru-RU';
    recog.interimResults = true;
    recog.continuous = false;
    finalTranscriptRef.current = '';
    voiceBaseRef.current = (inputRef.current?.value || '').trimEnd();
    recog.onstart = () => setRecording(true);
    recog.onresult = (e) => {
      let final = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      finalTranscriptRef.current = final;
      const spoken = (final + interim).trim();
      const base = voiceBaseRef.current;
      setInput(base ? base + '\n' + spoken : spoken);
    };
    recog.onend = () => {
      setRecording(false);
      if (finalTranscriptRef.current) inputRef.current?.focus();
    };
    recog.onerror = (e) => { if (e.error !== 'aborted') console.warn('Speech:', e.error); setRecording(false); };
    recog.start();
  }, [recording]);

  // Auto-save whenever config changes (debounced 1.5 s, skip initial mount)
  useEffect(() => {
    if (!config) return;
    if (initialLoad.current) { initialLoad.current = false; return; }
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => saveConfig(config), 1500);
    return () => clearTimeout(autoSaveTimer.current);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load profiles list and config on mount / profileId change
  useEffect(() => {
    fetch(`${API_BASE}/studio/profiles`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(r => r.json()).then(d => { if (d.success) setProfiles(d.profiles); }).catch(() => {});
  }, [apiKey]);

  // Тариф — нужен только флаг canExportBotCode (Pro/Premium) для вкладки «Код»
  useEffect(() => {
    fetch(`${API_BASE}/user/info`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(r => r.json()).then(d => { if (d.success) setCanExportCode(!!d.canExportBotCode); }).catch(() => {});
  }, [apiKey]);

  // Re-fetch config when tab becomes visible again (so edits from AISettings don't get overwritten)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (autoSaveTimer.current) return; // user is actively editing — don't overwrite
      fetch(`${API_BASE}/studio/config${profileId ? `?profileId=${profileId}` : ''}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }).then(r => r.json()).then(d => {
        if (!d.success || !d.profile) return;
        const p = d.profile;
        initialLoad.current = true; // prevent auto-save on this config update
        setConfig(prev => ({
          ...prev,
          aiName:        p.aiName        ?? prev.aiName,
          systemPrompt:  p.systemPrompt  ?? prev.systemPrompt,
          triggerMode:   p.botSettings?.triggerMode   ?? prev.triggerMode,
          triggerKeyword: p.botSettings?.triggerKeyword ?? prev.triggerKeyword,
          historyMode:   p.botSettings?.historyMode   ?? prev.historyMode,
          welcomeMessage: p.botSettings?.welcomeMessage ?? prev.welcomeMessage,
          commands:      p.botSettings?.commands      ?? prev.commands,
        }));
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [apiKey, profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API_BASE}/studio/config${profileId ? `?profileId=${profileId}` : ''}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const d = await r.json();
        if (d.success) {
          const cfg = {
            _id: d.profile._id,
            profileName: d.profile.profileName,
            aiName: d.profile.aiName,
            systemPrompt: d.profile.systemPrompt,
            restrictions: d.profile.restrictions || '',
            triggerMode:     d.profile.botSettings?.triggerMode     || 'respond_all',
            triggerKeyword:  d.profile.botSettings?.triggerKeyword  || '',
            historyMode:     d.profile.botSettings?.historyMode     || 'personal',
            welcomeMessage:  d.profile.botSettings?.welcomeMessage  || '',
            commands:        d.profile.botSettings?.commands        || [],
          };
          setConfig(cfg);
          initSimulator(cfg);
        }
      } catch {}
      setLoading(false);
    })();
  }, [profileId]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { simEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [simMessages]);

  // Shared sim send logic: match text against commands, return response + keyboard
  const simMatch = (text, commands) => {
    if (!text) return null;
    const isSlash = /^\/\w+/.test(text.trim());
    const matchText = isSlash ? text.trim().split(/\s+/)[0].toLowerCase() : text.trim();
    return (commands || []).find(c => c.command?.toLowerCase() === matchText.toLowerCase()) || null;
  };

  const initSimulator = (cfg, overrideMessages) => {
    setSimMenuOpen(false);
    setSimScreenBoth('/start');
    if (overrideMessages?.length) {
      setSimMessages(overrideMessages);
      // Pick keyboard from last bot message that has one
      const lastBotKbd = [...overrideMessages].reverse().find(m => m.from === 'bot' && m.keyboard?.length);
      setSimKeyboard(lastBotKbd?.keyboard || null);
      return;
    }
    const startCmd = cfg.commands?.find(c => c.command?.toLowerCase() === '/start');
    const welcome = cfg.welcomeMessage || startCmd?.response;
    const t = nowTime();
    setSimMessages(welcome
      ? [{ from: 'user', text: '/start', time: t }, { from: 'bot', text: welcome, time: t }]
      : [{ from: 'bot', text: `Привет! Я — ${cfg.aiName || 'ваш помощник'}. Чем могу помочь?`, time: t }]
    );
    setSimKeyboard(startCmd?.keyboard?.length ? startCmd.keyboard : null);
  };

  // Code view — полный экспортируемый код бота (Pro/Premium только)
  const switchToCode = async () => {
    setLeftMode('code');
    if (!canExportCode || exportFiles || exportLoading) return;
    setExportLoading(true);
    setExportError('');
    try {
      const r = await fetch(`${API_BASE}/studio/export-preview${profileId ? `?profileId=${profileId}` : ''}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const d = await r.json();
      if (d.success) { setExportFiles(d.files); setActiveFile('index.js'); }
      else setExportError(d.error || 'Не удалось загрузить код');
    } catch {
      setExportError('Не удалось загрузить код');
    }
    setExportLoading(false);
  };

  const switchToUi = () => setLeftMode('ui');

  const downloadCodeZip = async () => {
    setDownloading(true);
    try {
      const r = await fetch(`${API_BASE}/studio/export${profileId ? `?profileId=${profileId}` : ''}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) throw new Error('download failed');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(config?.aiName || 'telegram-bot').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Не удалось скачать архив');
    }
    setDownloading(false);
  };

  // Apply changes from AI and save to server
  const applyChanges = async (changes) => {
    const next = { ...config };
    if (changes.triggerMode    != null) next.triggerMode    = changes.triggerMode;
    if (changes.triggerKeyword != null) next.triggerKeyword = changes.triggerKeyword;
    if (changes.historyMode    != null) next.historyMode    = changes.historyMode;
    if (changes.systemPrompt   != null) next.systemPrompt   = changes.systemPrompt;
    if (changes.restrictions   != null) next.restrictions   = changes.restrictions;
    if (changes.commands       != null) next.commands       = changes.commands;
    if (changes.aiName         != null) next.aiName         = changes.aiName;
    setConfig(next);
    await saveConfig(next);
  };

  const saveConfig = async (cfg = config) => {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/studio/apply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: cfg._id,
          changes: {
            systemPrompt:   cfg.systemPrompt,
            aiName:         cfg.aiName,
            triggerMode:    cfg.triggerMode,
            triggerKeyword: cfg.triggerKeyword,
            historyMode:    cfg.historyMode,
            welcomeMessage: cfg.welcomeMessage,
            commands:       cfg.commands,
            restrictions:   cfg.restrictions,
          },
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  };

  // Apply changes to local config state only (server already persisted them via AiService)
  // Registered as the onComplete handler via studioCompleteRef
  useEffect(() => {
    studioCompleteRef.current = (data) => {
      const explanation = stripSystemTags(data.result || studioStreamText || '').trim();
      const changes = data.studioChanges;
      const preview = data.studioPreviewMessages;
      if (changes) {
        const base = configRef.current || {};
        const next = { ...base };
        if (changes.triggerMode    != null) next.triggerMode    = changes.triggerMode;
        if (changes.triggerKeyword != null) next.triggerKeyword = changes.triggerKeyword;
        if (changes.historyMode    != null) next.historyMode    = changes.historyMode;
        if (changes.welcomeMessage != null) next.welcomeMessage = changes.welcomeMessage;
        if (changes.systemPrompt   != null) next.systemPrompt   = changes.systemPrompt;
        if (changes.aiName         != null) next.aiName         = changes.aiName;
        if (changes.commands       != null) next.commands       = changes.commands;
        setConfig(next);
        initSimulator(next, preview?.length ? preview : null);
        // Конфиг поменялся — сгенерированный код устарел, перегружаем при следующем заходе
        // (а если уже открыта вкладка «Код» — сразу же)
        setExportFiles(null);
        if (leftModeRef.current === 'code' && canExportCode) {
          fetch(`${API_BASE}/studio/export-preview${profileId ? `?profileId=${profileId}` : ''}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          }).then(r => r.json()).then(d => { if (d.success) setExportFiles(d.files); }).catch(() => {});
        }
        setMessages(m => [...m, { role: 'ai', text: explanation || 'Изменения применены.', isChange: true }]);
        window.dispatchEvent(new CustomEvent('siberi:system-change', { detail: { message: 'Настройки бота обновлены ✓' } }));
      } else {
        setMessages(m => [...m, { role: 'ai', text: explanation || 'Нет ответа.' }]);
      }
    };
  });

  const handleSend = async (e) => {
    e?.preventDefault();
    const text = input.trim();
    if ((!text && !pendingImage) || sending) return;
    const sentImage = pendingImage;
    const sentText = text || '(изображение)';
    setInput('');
    setPendingImage(null);
    setMessages(m => [...m, { role: 'user', text: sentText, image: sentImage }]);
    setSending(true);

    try {
      const currentConfigSummary = {
        aiName:         config.aiName,
        systemPrompt:   config.systemPrompt,
        triggerMode:    config.triggerMode,
        triggerKeyword: config.triggerKeyword,
        historyMode:    config.historyMode,
        welcomeMessage: config.welcomeMessage,
        commands:       config.commands,
      };

      const body = { profileId: config._id, message: sentText, currentConfig: currentConfigSummary, currentScreen: simScreenRef.current };
      if (sentImage) body.image = sentImage;
      const r = await fetch(`${API_BASE}/studio/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();

      if (d.taskId) {
        startStudioPoll(d.taskId);
      } else {
        setMessages(m => [...m, { role: 'ai', text: 'Ошибка: нет ответа от сервера.' }]);
        setSending(false);
        inputRef.current?.focus();
      }
    } catch {
      setMessages(m => [...m, { role: 'ai', text: 'Ошибка соединения. Попробуйте ещё раз.' }]);
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const nowTime = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  // Simulator: send a message (slash command, button press, or free text)
  const handleSimSend = (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    const cfg = configRef.current || config;
    const cmd = simMatch(trimmed, cfg.commands);
    const t = nowTime();
    if (cmd) {
      const responseText = cmd.response ||
        (cmd.command?.toLowerCase() === '/start' && cfg.welcomeMessage ? cfg.welcomeMessage : '[нет ответа]');
      const kbd = Array.isArray(cmd.keyboard) && cmd.keyboard.length > 0 ? cmd.keyboard : null;
      setSimMessages(prev => [...prev, { from: 'user', text: trimmed, time: t }, { from: 'bot', text: responseText, time: t }]);
      setSimKeyboard(kbd);
      setSimScreenBoth(cmd.command); // встали на этот экран — его и будем править
      return;
    }
    // /start fallback
    if (trimmed.toLowerCase() === '/start' && cfg.welcomeMessage) {
      setSimMessages(prev => [...prev, { from: 'user', text: trimmed, time: t }, { from: 'bot', text: cfg.welcomeMessage, time: t }]);
      setSimKeyboard(null);
      setSimScreenBoth('/start');
      return;
    }
    // Unknown slash — ignore
    if (/^\/\w+/.test(trimmed)) {
      setSimMessages(prev => [...prev, { from: 'user', text: trimmed, time: t }, { from: 'bot', text: `Команда '${trimmed}' не настроена.`, time: t }]);
      return;
    }
    // Free text — simulated AI response
    setSimMessages(prev => [...prev, { from: 'user', text: trimmed, time: t }, { from: 'bot', text: `${cfg.aiName || 'Бот'} отвечает согласно системному промту...`, time: t }]);
  };

  // Commands builder helpers
  const addCommand = () => {
    setConfig(c => ({ ...c, commands: [...(c.commands || []), { command: '/команда', description: '', response: '' }] }));
  };
  const updateCommand = (i, field, val) => {
    setConfig(c => {
      const cmds = [...c.commands];
      cmds[i] = { ...cmds[i], [field]: val };
      return { ...c, commands: cmds };
    });
  };
  const removeCommand = (i) => {
    setConfig(c => ({ ...c, commands: c.commands.filter((_, idx) => idx !== i) }));
  };

  if (loading) {
    return (
      <div className="studio-loading">
        <Wand2 size={32} className="studio-loading-icon" />
        <p>Загружаем Bot Studio...</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="studio-loading">
        <p>Профиль не найден. <Link to="/settings">Перейти к настройкам</Link></p>
      </div>
    );
  }

  const handleReset = async () => {
    const blank = {
      ...config,
      aiName: 'Помощник',
      systemPrompt: '',
      triggerMode: 'respond_all',
      triggerKeyword: '',
      historyMode: 'personal',
      welcomeMessage: '',
      commands: [],
    };
    setConfig(blank);
    initSimulator(blank);
    setResetConfirm(false);
    await saveConfig(blank);
  };

  return (
    <div className="studio-root">
      {/* TutorialOverlay рендерит оболочка (Layout) — свой убран,
          иначе после обёртки раздела в Layout их было бы два */}
      {/* Reset confirm overlay */}
      {resetConfirm && (
        <div className="studio-reset-overlay">
          <div className="studio-reset-dialog">
            <div className="studio-reset-title">Начать заново?</div>
            <div className="studio-reset-body">Все настройки бота будут сброшены к нулю. Это действие нельзя отменить.</div>
            <div className="studio-reset-actions">
              <button className="studio-reset-confirm" onClick={handleReset}>Да, сбросить</button>
              <button className="studio-reset-cancel" onClick={() => setResetConfirm(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar: слева сегмент Интерфейс/Код (как в эталоне .seg),
          справа — функционал прода (профиль / сохранить / сброс). */}
      <div className="studio-topbar">
        <div className="studio-topbar-left">
          <div className="studio-view-toggle">
            <button
              className={`studio-view-toggle-btn${leftMode === 'ui' ? ' active' : ''}`}
              onClick={switchToUi}
            >
              <SlidersHorizontal size={14} /> Интерфейс
            </button>
            <button
              className={`studio-view-toggle-btn${leftMode === 'code' ? ' active' : ''}`}
              onClick={switchToCode}
            >
              <Code2 size={14} /> Код {!canExportCode && <Lock size={11} />}
            </button>
          </div>
        </div>

        <div className="studio-topbar-right">
          {/* Profile picker */}
          <div className="studio-profile-picker" onClick={() => setProfilePickerOpen(v => !v)}>
            <div className="studio-profile-picker-inner">
              <span className="studio-profile-picker-name">{config.aiName || config.profileName}</span>
              <ChevronDown size={14} className={`studio-profile-picker-chevron${profilePickerOpen ? ' open' : ''}`} />
            </div>
            {profilePickerOpen && profiles.length > 0 && (
              <div className="studio-profile-dropdown">
                {profiles.map(p => (
                  <button
                    key={p._id}
                    className={`studio-profile-option${p._id === config._id ? ' active' : ''}`}
                    onClick={e => {
                      e.stopPropagation();
                      setProfilePickerOpen(false);
                      navigate(`/studio?profileId=${p._id}`);
                    }}
                  >
                    <span className="studio-profile-option-dot" style={{ background: p.color || '#667eea' }} />
                    <span className="studio-profile-option-name">{p.aiName || p.profileName}</span>
                    {p._id === config._id && <span className="studio-profile-option-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className={`studio-save-btn${saved ? ' saved' : ''}`}
            onClick={() => saveConfig()}
            disabled={saving}
          >
            {saved ? '✓ Авто' : saving ? '...' : 'Сохранить'}
          </button>

          <button className="studio-restart-btn" onClick={() => setResetConfirm(true)}>
            ↺ Начать заново
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="studio-content">
        {/* Left: Config panel */}
        <div className="studio-config">
          {leftMode === 'code' ? (
            !canExportCode ? (
              /* ── Upsell: Pro/Premium только ── */
              <div className="studio-code-locked">
                <Lock size={32} />
                <h3>Полный код бота — на Pro и Premium</h3>
                <p>
                  Скачайте готовый, полноценный проект Telegram-бота — точно с тем же
                  меню, промтом и поведением, что настроено здесь. Запускайте у себя на
                  сервере или локалхосте, без зависимости от Siberi AI.
                </p>
                <Link to="/billing" className="studio-code-upgrade-btn">Улучшить тариф</Link>
              </div>
            ) : (
              /* ── Code export view ── */
              <div className="studio-code-view">
                {exportLoading ? (
                  <div className="studio-code-hint">Собираю код бота…</div>
                ) : exportError ? (
                  <div className="studio-code-error">⚠ {exportError}</div>
                ) : exportFiles ? (
                  <>
                    <div className="studio-code-hint">
                      Полноценный проект бота — точная копия текущей настройки. Скачайте и
                      запустите на своём сервере (понадобится свой токен Telegram-бота и
                      бесплатный ключ Groq — всё описано в README.md).
                    </div>
                    <div className="studio-code-tabs">
                      {Object.keys(exportFiles).map(name => (
                        <button
                          key={name}
                          className={`studio-code-tab${activeFile === name ? ' active' : ''}`}
                          onClick={() => setActiveFile(name)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <pre className="studio-code-editor studio-code-readonly">{exportFiles[activeFile]}</pre>
                    <div className="studio-code-actions">
                      <button
                        className="studio-code-apply-btn"
                        onClick={downloadCodeZip}
                        disabled={downloading}
                      >
                        <Download size={14} /> {downloading ? 'Скачиваю…' : 'Скачать .zip'}
                      </button>
                      <button
                        className="studio-code-reset-btn"
                        onClick={() => navigator.clipboard?.writeText(exportFiles[activeFile])}
                      >
                        <Copy size={14} /> Копировать файл
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            )
          ) : (
          <div className="studio-config-inner">
            <Section title="Приветственное сообщение" icon={<MessageSquare size={16} />}>
              <textarea
                className="studio-welcome-msg"
                value={config.welcomeMessage}
                onChange={e => setConfig(c => ({ ...c, welcomeMessage: e.target.value }))}
                rows={3}
                placeholder="Привет! 👋 Я — ваш помощник. Чем могу помочь?"
              />
              <p className="studio-hint">Отправляется пользователю при команде /start</p>
            </Section>

            <Section title="Режим ответов" icon={<Zap size={16} />}>
              <div className="studio-toggle-group">
                {['respond_all', 'mention_only'].map(mode => (
                  <button
                    key={mode}
                    className={`studio-toggle-btn${config.triggerMode === mode ? ' active' : ''}`}
                    onClick={() => setConfig(c => ({ ...c, triggerMode: mode }))}
                  >
                    {TRIGGER_LABELS[mode]}
                  </button>
                ))}
              </div>
              {config.triggerMode === 'mention_only' && (
                <div className="studio-field">
                  <label>Ключевое слово-триггер</label>
                  <input
                    value={config.triggerKeyword}
                    onChange={e => setConfig(c => ({ ...c, triggerKeyword: e.target.value }))}
                    placeholder="Например: Алиса, /ai, бот,"
                  />
                  <p className="studio-hint">Бот ответит только если сообщение начинается с этого слова</p>
                </div>
              )}
            </Section>

            <Section title="История диалога" icon={<MessageSquare size={16} />}>
              <div className="studio-toggle-group">
                {['personal', 'shared'].map(mode => (
                  <button
                    key={mode}
                    className={`studio-toggle-btn${config.historyMode === mode ? ' active' : ''}`}
                    onClick={() => setConfig(c => ({ ...c, historyMode: mode }))}
                  >
                    {HISTORY_LABELS[mode]}
                  </button>
                ))}
              </div>
              <p className="studio-hint">
                {config.historyMode === 'personal'
                  ? 'У каждого пользователя свой отдельный чат с ботом'
                  : 'Все участники чата видят общую историю диалога'}
              </p>
            </Section>

            <Section title="Меню и команды" icon={<Bot size={16} />}>
              <div className="studio-commands">
                {(config.commands || []).map((cmd, i) => (
                  <div key={i} className="studio-cmd-card">
                    <div className="studio-cmd-row">
                      <input
                        className="studio-cmd-name"
                        value={cmd.command}
                        onChange={e => updateCommand(i, 'command', e.target.value)}
                        placeholder="/команда или кнопка"
                        title={cmd.command}
                      />
                      <input
                        className="studio-cmd-desc"
                        value={cmd.description}
                        onChange={e => updateCommand(i, 'description', e.target.value)}
                        placeholder="Описание (видно пользователю)"
                      />
                      <button className="studio-cmd-del" onClick={() => removeCommand(i)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <textarea
                      className="studio-cmd-response"
                      value={cmd.response}
                      onChange={e => {
                        updateCommand(i, 'response', e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                      onFocus={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                      placeholder="Текст ответа бота на эту команду..."
                      rows={2}
                    />
                    {Array.isArray(cmd.keyboard) && cmd.keyboard.length > 0 && (
                      <div>
                        <div className="studio-cmd-keyboard-label">⌨️ Клавиатура:</div>
                        <div className="studio-cmd-keyboard">
                          {cmd.keyboard.map(row => row.join(' · ')).join(' / ')}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <button className="studio-add-cmd" onClick={addCommand}>
                  <Plus size={15} /> Добавить команду
                </button>
              </div>
            </Section>

            <Section title="Системный промт" icon={<User size={16} />} collapsible defaultOpen={false}>
              <textarea
                className="studio-sys-prompt"
                value={config.systemPrompt}
                onChange={e => setConfig(c => ({ ...c, systemPrompt: e.target.value }))}
                rows={8}
                placeholder="Инструкции поведения бота..."
              />
              <p className="studio-hint">Подсказка: можно попросить AI изменить промт через чат ниже</p>
            </Section>

            <Section title="Запрещённые темы" icon={<User size={16} />} collapsible defaultOpen={false}>
              <textarea
                className="studio-sys-prompt"
                value={config.restrictions || ''}
                onChange={e => setConfig(c => ({ ...c, restrictions: e.target.value }))}
                rows={4}
                placeholder="Например: не обсуждать конкурентов, не давать юридических советов..."
              />
              <p className="studio-hint">AI будет вежливо уходить от этих тем</p>
            </Section>
          </div>
          )} {/* end leftMode === 'code' ? : */}
        </div>

        {/* Right: Telegram simulator */}
        <div className="studio-preview">
          <div className="studio-preview-header">
            <div className="studio-tg-avatar">{config.aiName?.[0]?.toUpperCase() || 'B'}</div>
            <div>
              <div className="studio-tg-name">{config.aiName || 'Бот'}</div>
              <div className="studio-tg-status">bot · онлайн</div>
            </div>
            <span
              className="studio-sim-screen-badge"
              title="Экран, который правится, если написать «поменяй текст на …» без указания вкладки. Нажимайте кнопки бота, чтобы перейти на нужный экран."
            >✏️ {simScreen === '/start' ? 'Главное меню' : simScreen}</span>
            <button className="studio-sim-reset" onClick={() => initSimulator(config)} title="Сброс симулятора">↺</button>
          </div>

          <div className="studio-tg-chat">
            {simMessages.map((msg, i) => (
              <div key={i} className={`studio-tg-msg studio-tg-msg--${msg.from}`}>
                {msg.from === 'bot' && (
                  <div className="studio-tg-bot-avatar">{config.aiName?.[0]?.toUpperCase() || 'B'}</div>
                )}
                <div className="studio-tg-bubble">
                  {msg.from === 'bot'
                    ? <MarkdownText text={msg.text} />
                    : msg.text}
                  <span className="studio-tg-time">
                    {msg.time || ''}
                    {msg.from === 'user' && <span className="studio-tg-check">✓✓</span>}
                  </span>
                </div>
              </div>
            ))}
            <div ref={simEndRef} />
          </div>

          {/* Command menu popup — all commands */}
          {simMenuOpen && (config.commands || []).length > 0 && (
            <div className="studio-tg-menu-popup">
              <div className="studio-tg-menu-title">Команды бота</div>
              {(config.commands || []).map((cmd, i) => (
                <button key={i} className="studio-tg-menu-row"
                  onClick={() => { handleSimSend(cmd.command); setSimMenuOpen(false); }}>
                  <span className="studio-tg-menu-cmd">{cmd.command}</span>
                  <span className="studio-tg-menu-desc">{cmd.description || cmd.response?.slice(0, 40) || ''}</span>
                </button>
              ))}
            </div>
          )}

          {/* Reply keyboard (Telegram-style buttons above input) */}
          {simKeyboard && simKeyboard.length > 0 && (
            <div className="studio-tg-keyboard">
              {simKeyboard.map((row, ri) => (
                <div key={ri} className="studio-tg-keyboard-row">
                  {(Array.isArray(row) ? row : [row]).map((btn, bi) => (
                    <button key={bi} className="studio-tg-keyboard-btn"
                      onClick={() => handleSimSend(btn)}>
                      {btn}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Input bar — read-only visual (interaction via keyboard buttons) */}
          <div className="studio-sim-input-row">
            {(config.commands || []).length > 0 && (
              <button
                className={`studio-sim-menu-btn${simMenuOpen ? ' active' : ''}`}
                onClick={() => setSimMenuOpen(v => !v)}
                title="Все команды"
              >/</button>
            )}
            <div className="studio-sim-input studio-sim-input--readonly">
              <span className="studio-sim-input-placeholder">Напишите сообщение...</span>
            </div>
            <button className="studio-sim-send studio-sim-send--disabled" disabled title="Используйте команды или кнопки бота">
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Bottom: AI chat */}
      <div className="studio-chat-panel">
        <div className="studio-chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`studio-chat-msg studio-chat-msg--${msg.role}${msg.isChange ? ' studio-chat-msg--change' : ''}`}>
              {msg.isChange && <span className="studio-change-tag">✓ Применено</span>}
              {msg.image && <img src={msg.image} alt="вложение" className="studio-msg-image" />}
              <span className="studio-chat-text">
                {msg.role === 'ai'
                  ? <MarkdownText text={msg.text} />
                  : msg.text}
              </span>
            </div>
          ))}
          {sending && !studioStreaming && (
            <div className="studio-chat-msg studio-chat-msg--ai">
              <span className="studio-typing">
                <span /><span /><span />
              </span>
            </div>
          )}
          {studioStreaming && (
            <div className="studio-chat-msg studio-chat-msg--ai streaming-bubble">
              <MarkdownText text={studioStreamText} />
              <span className="streaming-cursor" aria-hidden="true" />
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <form className="studio-chat-input-row" onSubmit={handleSend}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = ''; }}
          />
          {pendingImage && (
            <div className="studio-img-preview-bar">
              <img src={pendingImage} alt="вложение" className="studio-img-preview-thumb" />
              <button
                type="button"
                className="studio-img-preview-remove"
                onClick={() => setPendingImage(null)}
                title="Убрать изображение"
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="studio-chat-input-inner">
            <button
              type="button"
              className="studio-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              title="Прикрепить изображение"
            >
              <Paperclip size={16} />
            </button>
            <textarea
              ref={inputRef}
              className="studio-chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={recording ? '🎙 Говорите...' : pendingImage ? 'Добавьте подпись или отправьте так...' : 'Опиши что хочешь изменить в боте...'}
              rows={1}
              disabled={sending}
            />
            {speechSupported && (
              <button
                type="button"
                className={`studio-voice-btn${recording ? ' studio-voice-btn--active' : ''}`}
                onClick={toggleVoice}
                disabled={sending}
                title={recording ? 'Остановить запись' : 'Голосовой ввод'}
              >
                {recording ? <MicOff size={16} /> : <Mic size={16} />}
                {recording && <span className="studio-voice-ring" />}
              </button>
            )}
            <button type="submit" className="studio-chat-send" disabled={sending || (!input.trim() && !pendingImage)}>
              <Send size={18} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({ title, icon, children, collapsible = false, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="studio-section">
      <div
        className={`studio-section-header${collapsible ? ' clickable' : ''}`}
        onClick={collapsible ? () => setOpen(!open) : undefined}
      >
        <span className="studio-section-icon">{icon}</span>
        <span className="studio-section-title">{title}</span>
        {collapsible && (open ? <ChevronUp size={15} /> : <ChevronDown size={15} />)}
      </div>
      {(!collapsible || open) && <div className="studio-section-body">{children}</div>}
    </div>
  );
}

