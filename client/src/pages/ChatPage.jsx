import axios from 'axios';
import { Bot, Check, Download, FileText, ImageIcon, Lightbulb, Loader2, Mic, MicOff, Paperclip, Send, Trash2, User, X } from 'lucide-react';
import ThinkingText from '../components/ThinkingText';
import MarkdownText from '../components/MarkdownText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTutorial } from '../context/TutorialContext';
import { useStreamingPoll, stripSystemTags } from '../hooks/useStreamingPoll';
import './ChatPage.css';

const HINT_CATEGORIES = [
  {
    icon: '📁', label: 'Файлы',
    hints: [
      'Загрузи прайс.pdf и подними все цены на 500 рублей',
      'Расскажи о файле договор.pdf — что в нём',
      'Сохрани содержимое загруженного файла в схему «документы»',
    ],
  },
  {
    icon: '🗄️', label: 'Данные',
    hints: [
      'Создай схему для учёта клиентов: имя, телефон, дата визита, сумма',
      'Добавь запись: Иван Иванов, тел. 8-900-123-45-67, визит завтра в 15:00',
      'Покажи всех клиентов, которые были в этом месяце',
      'Найди записи где сумма больше 5000 рублей',
    ],
  },
  {
    icon: '📊', label: 'Аналитика',
    hints: [
      'Проанализируй мои данные: что изменилось за эту неделю?',
      'Какой товар или услуга самые популярные?',
      'Сравни продажи этого месяца с прошлым',
      'Найди клиентов, которые давно не приходили',
    ],
  },
  {
    icon: '📄', label: 'Документы',
    hints: [
      'Создай счёт для клиента Иванова на 5 000 рублей — скачаю PDF',
      'Напиши договор оказания услуг для клиента: [опиши условия]',
      'Сгенерируй отчёт по всем продажам за текущий месяц',
      'Создай счета для всех клиентов из схемы «клиенты» и упакуй в ZIP',
    ],
  },
  {
    icon: '🤖', label: 'Автоматизация',
    hints: [
      'Настрой уведомление в Telegram когда появляется новый клиент',
      'Отправляй мне итоги дня каждый вечер в 21:00',
      'Создай Telegram-бот для ответов на вопросы о моём меню',
    ],
  },
];

const TUTORIAL_STEPS = [
  // Шаг про «.chat-title» убран: строку с именем AI сняли при переносе чата на
  // эталон (заголовок теперь один — от оболочки). Переключение профилей и так
  // объясняется в туториале Настроек AI.
  {
    selector: '.clear-btn',
    text: 'Кнопка 🗑 — очистить всю историю диалога. Используйте, чтобы начать разговор с чистого листа.',
  },
  {
    selector: '.chat-context-dock',
    text: 'Контекст данных — выберите, какие базы знаний AI использует прямо сейчас.\n\n• «Все» — AI видит все ваши данные\n• Конкретный профиль — AI отвечает только по его данным\n\nПолезно, если у вас несколько направлений бизнеса.',
  },
  {
    selector: null,
    text: 'История диалога — AI запоминает весь разговор и отвечает с учётом контекста.\n\nПоддерживаются форматирование, таблицы, блоки кода, изображения и файлы.',
  },
  {
    selector: '.attach-btn',
    text: '📎 Кнопка прикрепления файлов.\n\nВставьте картинку, скриншот таблицы, графика или документа — нейросеть увидит изображение, проанализирует и будет точно знать, о чём идёт речь.\n\nМожно также перетащить файл прямо в окно чата.',
  },
  {
    selector: '.voice-btn',
    text: '🎤 Голосовой ввод.\n\nНажмите микрофон и говорите — AI переведёт речь в текст и сразу ответит.\n\nУдобно на ходу, за рулём или когда мысль проще произнести, чем набрать.',
  },
  {
    selector: '.chat-input-area',
    text: '✨ Через этот чат можно управлять всем:\n\n• «Добавь в меню: борщ, 350 руб» — запись появится в Мои данные\n• «Удали заявку клиента Иванова» — данные обновятся\n• «Измени промт — работаем до 23:00» — настройки AI изменятся\n• «Покажи все записи за сегодня» — AI выгрузит выборку прямо в чат\n\nВы управляете бизнесом через разговор.',
  },
];

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
const MAX_IMAGE_PX = 1920;

function resizeImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ChatPage({ apiKey }) {
  const location = useLocation();
  const { enabled, startTutorial, isActive, skipped, completedPaths } = useTutorial();

  useEffect(() => {
    if (enabled && !isActive && !skipped && !completedPaths.has('/chat')) {
      const t = setTimeout(() => { if (window.location.pathname === '/chat') startTutorial(TUTORIAL_STEPS, '/chat'); }, 500);
      return () => clearTimeout(t);
    }
  }, [enabled, isActive, skipped, completedPaths]); // eslint-disable-line react-hooks/exhaustive-deps

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [aiName, setAiName] = useState('Моя нейросеть');
  const [pendingImage, setPendingImage] = useState(null);
  const [pendingPdf, setPendingPdf]     = useState(null); // { text, filename, pages, chars }
  const [pdfLoading, setPdfLoading]     = useState(false);
  const [pdfSaved, setPdfSaved]         = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [activeProfileIds, setActiveProfileIds] = useState(null); // null = все профили
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const pendingFileRef = useRef(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const hintsRef = useRef(null);

  const [dbNotif, setDbNotif] = useState(null); // null | 'generating' | 'done' | 'closing'
  const dbNotifTimerRef = useRef(null);

  const closeDbNotif = () => {
    clearTimeout(dbNotifTimerRef.current);
    setDbNotif('closing');
    dbNotifTimerRef.current = setTimeout(() => setDbNotif(null), 420);
  };

  const { loading, setLoading, streamingText, isStreaming, startPolling, stopPolling } = useStreamingPoll({
    apiKey,
    onDbChange: () => {
      setDbNotif('generating');
    },
    onComplete: (data) => {
      const text = stripSystemTags(data.result || '') || streamingText || '';
      setMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content: text,
          attachments: data.attachments || [],
          fromFile: pendingFileRef.current,
          bulkDocToken: data.bulkDocToken || null,
          bulkDocCount: data.bulkDocCount || null,
          createdAt: new Date(),
        },
      ]);
      // DB changes notification
      if (data._dbChanged || data.studioChanges) {
        setDbNotif('done');
        clearTimeout(dbNotifTimerRef.current);
        // Auto-close: bar drains 6s, slide-out starts at 5.4s (fade before bar ends)
        dbNotifTimerRef.current = setTimeout(() => {
          setDbNotif('closing');
          setTimeout(() => setDbNotif(null), 500);
        }, 5400);
      } else {
        setDbNotif(null);
      }
      // Fire green toast if system changes were made
      if (data.studioChanges || (data.result === 'Готово! Изменения применены.')) {
        window.dispatchEvent(new CustomEvent('siberi:system-change', { detail: { message: 'Изменения применены ✓' } }));
      }
    },
    onError: (msg) => {
      setDbNotif(null);
      setMessages((prev) => [...prev, { role: 'ai', content: `❌ ${msg}`, createdAt: new Date() }]);
    },
  });
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const voiceBaseRef = useRef('');
  const fileInputRef = useRef(null);

  const speechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  // Prefill from landing demo redirect
  useEffect(() => {
    const prefill = location.state?.prefill;
    if (prefill) {
      setInput(prefill);
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [location.state]);

  useEffect(() => {
    fetchConfig();
    fetchHistory();
    fetchProfiles();
    return () => {
      stopPolling(); // cancel streaming + typewriter on unmount
      recognitionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const fetchConfig = async () => {
    try {
      const res = await axios.get(`${API_URL}/config`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.data.success && res.data.config?.aiName) {
        setAiName(res.data.config.aiName);
      }
    } catch (err) {
      console.warn('Не удалось загрузить имя AI:', err);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${API_URL}/chat/history`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.data.success) setMessages(res.data.messages.map(m => ({
        ...m,
        attachments: m.attachments || [],
        content: m.role === 'ai' ? stripSystemTags(m.content || '') || m.content : m.content,
      })));
    } catch (err) {
      console.error('History fetch error:', err);
    }
  };

  const fetchProfiles = async () => {
    try {
      const res = await axios.get(`${API_URL}/profiles`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const ps = res.data.profiles || [];
      setProfiles(ps);
      // По умолчанию все профили активны (null = все)
      setActiveProfileIds(null);
    } catch {}
  };

  const toggleProfile = (id) => {
    setActiveProfileIds(prev => {
      // null = все профили выбраны
      const allIds = profiles.map(p => p._id);
      const current = prev === null ? allIds : prev;
      if (current.includes(id)) {
        const next = current.filter(x => x !== id);
        return next.length === allIds.length ? null : (next.length === 0 ? [] : next);
      } else {
        const next = [...current, id];
        return next.length === allIds.length ? null : next;
      }
    });
  };

  const resizeTextarea = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 160) + 'px';
    }
  }, []);

  const toggleVoice = useCallback(() => {
    if (recording) {
      recognitionRef.current?.stop();
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recog = new SR();
    recog.lang = 'ru-RU';
    recog.interimResults = true;
    recog.continuous = false;
    recognitionRef.current = recog;
    finalTranscriptRef.current = '';
    voiceBaseRef.current = (inputRef.current?.value || '').trimEnd();

    recog.onstart = () => setRecording(true);

    recog.onresult = (e) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      finalTranscriptRef.current = final;
      const spoken = (final + interim).trim();
      const base = voiceBaseRef.current;
      setInput(base ? base + '\n' + spoken : spoken);
      setTimeout(resizeTextarea, 0);
    };

    recog.onend = () => {
      setRecording(false);
      if (finalTranscriptRef.current) inputRef.current?.focus();
    };

    recog.onerror = (e) => {
      if (e.error !== 'aborted') console.warn('Speech error:', e.error);
      setRecording(false);
    };

    recog.start();
  }, [recording, resizeTextarea]);

  const handleImageFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const raw = await readFileAsDataUrl(file);
      const resized = await resizeImage(raw);
      setPendingImage(resized);
      inputRef.current?.focus();
    } catch (err) {
      console.error('Image read error:', err);
    }
  }, []);

  const handleDocxFile = useCallback(async (file) => {
    if (!file) return;
    const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || file.name.endsWith('.docx');
    if (!isDocx) return;
    setPdfLoading(true);
    setPendingPdf(null);
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = (e) => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch(`${API_URL}/chat/docx-extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ docxBase64: base64, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка чтения DOCX');
      setPendingPdf({ text: data.text, filename: data.filename, pages: null, chars: data.chars, type: 'docx' });
      inputRef.current?.focus();
    } catch (err) {
      setMessages(prev => [...prev, { role: 'ai', content: `❌ ${err.message}`, createdAt: new Date() }]);
    }
    setPdfLoading(false);
  }, [apiKey]);

  const handlePdfFile = useCallback(async (file) => {
    if (!file || file.type !== 'application/pdf') return;
    setPdfLoading(true);
    setPendingPdf(null);
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = (e) => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch(`${API_URL}/chat/pdf-extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ pdfBase64: base64, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка чтения PDF');
      setPendingPdf({ text: data.text, filename: data.filename, pages: data.pages, chars: data.chars });
      inputRef.current?.focus();
    } catch (err) {
      setMessages(prev => [...prev, { role: 'ai', content: `❌ ${err.message}`, createdAt: new Date() }]);
    }
    setPdfLoading(false);
  }, [apiKey]);

  const handleSavePdfToData = useCallback(async () => {
    if (!pendingPdf) return;
    try {
      await axios.post(`${API_URL}/chat/pdf-save`, {
        text: pendingPdf.text, filename: pendingPdf.filename, pages: pendingPdf.pages,
      }, { headers: { Authorization: `Bearer ${apiKey}` } });
      setPdfSaved(true);
      setTimeout(() => setPdfSaved(false), 3000);
    } catch (err) {
      console.error('Save PDF to data error:', err.message);
    }
  }, [pendingPdf, apiKey]);

  // Capture paste anywhere on the page
  useEffect(() => {
    const onPaste = (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find((it) => it.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        handleImageFile(imageItem.getAsFile());
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleImageFile]);

  useEffect(() => {
    if (!hintsOpen) return;
    const onClick = (e) => { if (hintsRef.current && !hintsRef.current.contains(e.target)) setHintsOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [hintsOpen]);

  const handleSend = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if ((!text && !pendingImage && !pendingPdf) || loading) return;

    const sentImage = pendingImage;
    const sentPdf   = pendingPdf;
    // fromFile = true when user uploaded a file OR mentioned a stored file by name
    const hasMentionedFile = /\b[\wа-яёА-ЯЁ][\wа-яёА-ЯЁ0-9 _-]*\.(pdf|docx|doc|xlsx|csv|txt)\b/i.test(text);
    pendingFileRef.current = !!sentPdf || hasMentionedFile;
    const sentText  = text || (sentPdf ? `[PDF: ${sentPdf.filename}]` : '(изображение)');

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text || (sentPdf ? `📄 ${sentPdf.filename}` : '(изображение)'), image: sentImage, pdf: sentPdf ? { filename: sentPdf.filename, pages: sentPdf.pages } : null, createdAt: new Date() },
    ]);
    setInput('');
    setPendingImage(null);
    setPendingPdf(null);
    setLoading(true);

    try {
      const body = { prompt: sentText };
      if (sentImage) body.image = sentImage;
      if (sentPdf) {
        if (sentPdf.type === 'docx') { body.docText = sentPdf.text; body.docFilename = sentPdf.filename; }
        else                         { body.pdfText = sentPdf.text; body.pdfFilename = sentPdf.filename; }
      }
      if (activeProfileIds !== null) body.activeProfileIds = activeProfileIds;

      const res = await axios.post(`${API_URL}/chat/send`, body, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.data.success) {
        startPolling(res.data.taskId);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'ai', content: '❌ Ошибка отправки сообщения', createdAt: new Date() },
      ]);
      setLoading(false);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm('Очистить историю чата?')) return;
    try {
      await axios.delete(`${API_URL}/chat/history`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setMessages([]);
    } catch (err) {
      alert('Ошибка очистки: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) handlePdfFile(file);
    else if (file.name.endsWith('.docx') || file.type.includes('wordprocessingml')) handleDocxFile(file);
    else handleImageFile(file);
  };

  // Download helper — calls generate endpoint and triggers browser download
  const downloadGenerated = async (type, text, baseFilename) => {
    try {
      const ext  = type === 'pdf' ? 'pdf' : 'docx';
      const name = baseFilename
        ? baseFilename.replace(/\.[^.]+$/, '') + `_edited.${ext}`
        : `siberi_document.${ext}`;
      const res = await fetch(`${API_URL}/chat/generate-${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ text, filename: name }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { alert('Ошибка загрузки: ' + err.message); }
  };

  return (
    <div
      className={`chat-page${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dbNotif && (
        <div className={`db-notif db-notif--${dbNotif === 'closing' ? 'done closing' : dbNotif}`}>
          <div className="db-notif__body">
            <div className="db-notif__header">
              <div className="db-notif__icon-wrap">
                {dbNotif === 'generating'
                  ? <span className="db-notif__spinner" />
                  : <span className="db-notif__check-icon">✓</span>}
              </div>
              <button className="db-notif__close" onClick={closeDbNotif} type="button">✕</button>
            </div>
            <div className="db-notif__label">
              {dbNotif === 'generating' ? 'Выполняется' : 'Завершено'}
            </div>
            <div className="db-notif__text">
              {dbNotif === 'generating' ? 'Вносим изменения в данные…' : 'Изменения сохранены!'}
            </div>
            <div className="db-notif__sub">
              {dbNotif === 'generating' ? 'Пожалуйста, подождите' : 'База данных обновлена'}
            </div>
          </div>
          <div className="db-notif__bar">
            <div className="db-notif__bar-fill" key={dbNotif} />
          </div>
        </div>
      )}
      {dragOver && (
        <div className="drop-overlay">
          <ImageIcon size={48} />
          <p>Отпустите изображение</p>
        </div>
      )}

      <div className="chat-header">
        <div className="hints-wrap" ref={hintsRef}>
          <button
            className={`hints-toggle-btn${hintsOpen ? ' active' : ''}`}
            onClick={() => setHintsOpen(v => !v)}
            title="Примеры запросов"
          >
            <Lightbulb size={16} />
            <span>Что умею?</span>
          </button>
          {hintsOpen && (
            <div className="hints-panel">
              <div className="hints-panel-header">Примеры запросов — нажми чтобы вставить</div>
              <div className="hints-categories">
                {HINT_CATEGORIES.map(cat => (
                  <div key={cat.label} className="hints-cat">
                    <div className="hints-cat-label">{cat.icon} {cat.label}</div>
                    {cat.hints.map(hint => (
                      <button
                        key={hint}
                        className="hint-item"
                        onClick={() => {
                          setInput(hint);
                          setHintsOpen(false);
                          setTimeout(() => inputRef.current?.focus(), 50);
                        }}
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <button className="clear-btn" onClick={clearHistory} title="Очистить историю">
          <Trash2 size={18} />
        </button>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !loading && (
          <div className="empty-chat">
            <Bot size={48} />
            <p>Начните диалог с вашим AI-помощником</p>
            <span>Прикрепите изображение, PDF или Word — или просто перетащите файл</span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="msg-avatar">
              {msg.role === 'user' ? <User size={18} /> : <Bot size={18} />}
            </div>
            <div className="msg-bubble">
              {msg.image && (
                <img className="msg-image" src={msg.image} alt="вложение" />
              )}
              {msg.pdf && (
                <div className="msg-pdf-chip">
                  <FileText size={13} style={{ color: '#e53e3e' }} />
                  {msg.pdf.filename}{msg.pdf.pages ? ` · ${msg.pdf.pages} стр.` : ''}
                </div>
              )}
              <MarkdownText text={msg.content} isAi={msg.role === 'ai'} />
              {msg.attachments?.length > 0 && (
                <div className="msg-attachments">
                  {msg.attachments.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                      <img className="msg-attachment-img" src={src} alt={`chart-${i + 1}`} />
                    </a>
                  ))}
                </div>
              )}
              {/* Bulk ZIP download when AI generated multiple documents */}
              {msg.role === 'ai' && msg.bulkDocToken && (
                <div className="msg-download-row">
                  <a
                    className="msg-download-btn msg-download-btn--zip"
                    href={`${API_URL}/chat/bulk-download/${msg.bulkDocToken}`}
                    download
                    title="Скачать ZIP архив"
                  >
                    <Download size={11} /> Скачать ZIP ({msg.bulkDocCount} файлов)
                  </a>
                </div>
              )}
              {/* Download buttons only when AI responded to an uploaded file */}
              {msg.role === 'ai' && msg.fromFile && msg.content && (
                <div className="msg-download-row">
                  <button className="msg-download-btn" onClick={() => downloadGenerated('pdf', msg.content, null)} title="Скачать как PDF">
                    <Download size={11} /> PDF
                  </button>
                  <button className="msg-download-btn" onClick={() => downloadGenerated('docx', msg.content, null)} title="Скачать как Word">
                    <Download size={11} /> Word
                  </button>
                </div>
              )}
              <span className="msg-time">
                {new Date(msg.createdAt).toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </div>
        ))}

        {loading && !isStreaming && (
          <div className="message ai">
            <div className="msg-avatar"><Bot size={18} /></div>
            <div className="msg-bubble thinking"><ThinkingText /></div>
          </div>
        )}
        {isStreaming && (
          <div className="message ai">
            <div className="msg-avatar"><Bot size={18} /></div>
            <div className="msg-bubble streaming-bubble">
              <MarkdownText text={streamingText} isAi />
              <span className="streaming-cursor" aria-hidden="true" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {profiles.length > 0 && (
        <div className="chat-context-dock">
          <div className="chat-context-left">
            <span className="chat-context-label">Контекст данных</span>
            <div className="chat-context-divider" />
            <button
              type="button"
              className={`chat-context-chip all${activeProfileIds === null ? ' active' : ''}`}
              onClick={() => setActiveProfileIds(null)}
            >
              Все
            </button>
            {profiles.map(p => {
              const allIds = profiles.map(x => x._id);
              const current = activeProfileIds === null ? allIds : activeProfileIds;
              const isActive = current.includes(p._id);
              return (
                <button
                  key={p._id}
                  type="button"
                  className={`chat-context-chip${isActive ? ' active' : ''}`}
                  style={p.color ? { '--chip-color': p.color } : {}}
                  onClick={() => toggleProfile(p._id)}
                  title={isActive ? 'Исключить данные профиля' : 'Включить данные профиля'}
                >
                  {p.color && <span className="chat-context-chip__dot" style={{ background: p.color }} />}
                  {p.profileName || p.aiName || 'Профиль'}
                </button>
              );
            })}
          </div>
          <div className="chat-context-hints">
            <span><kbd>Enter</kbd> отправить</span>
            <span><kbd>Shift+Enter</kbd> новая строка</span>
            <span><kbd>Ctrl+V</kbd> вставить фото</span>
          </div>
        </div>
      )}

      <form className="chat-input-area" onSubmit={handleSend}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.type === 'application/pdf' || f.name.endsWith('.pdf')) handlePdfFile(f);
            else if (f.name.endsWith('.docx') || f.type.includes('wordprocessingml')) handleDocxFile(f);
            else handleImageFile(f);
            e.target.value = '';
          }}
        />
        {pendingImage && (
          <div className="img-preview-bar">
            <img src={pendingImage} alt="вложение" className="img-preview-thumb" />
            <button type="button" className="img-preview-remove" onClick={() => setPendingImage(null)} title="Убрать изображение">
              <X size={14} />
            </button>
          </div>
        )}
        {pdfLoading && (
          <div className="pdf-preview-bar">
            <Loader2 size={14} className="spin" />
            <span>Читаю PDF…</span>
          </div>
        )}
        {pendingPdf && !pdfLoading && (
          <div className="pdf-preview-bar">
            <FileText size={15} style={{ color: '#e53e3e', flexShrink: 0 }} />
            <div className="pdf-preview-info">
              <span className="pdf-preview-name">{pendingPdf.filename}</span>
              <span className="pdf-preview-meta">{pendingPdf.pages ? `${pendingPdf.pages} стр. · ` : ''}{(pendingPdf.chars / 1000).toFixed(1)}K символов</span>
            </div>
            <button type="button" className="pdf-save-btn" onClick={handleSavePdfToData} title="Сохранить текст в Мои данные">
              {pdfSaved ? <><Check size={12} /> Сохранено</> : 'В данные'}
            </button>
            <button type="button" className="img-preview-remove" onClick={() => setPendingPdf(null)} title="Убрать файл">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-input-row">
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || pdfLoading}
            title="Прикрепить изображение, PDF или Word"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            placeholder={
              recording   ? 'Говорите...'
              : pendingPdf  ? `Задайте вопрос по «${pendingPdf.filename}»…`
              : pendingImage ? 'Добавьте подпись или отправьте так...'
              : 'Напишите сообщение...'
            }
            disabled={loading}
            autoFocus
          />
          {speechSupported && (
            <button
              type="button"
              className={`voice-btn${recording ? ' voice-btn--active' : ''}`}
              onClick={toggleVoice}
              disabled={loading}
              title={recording ? 'Остановить запись' : 'Голосовой ввод'}
            >
              {recording ? <MicOff size={20} /> : <Mic size={20} />}
              {recording && <span className="voice-btn__ring" />}
            </button>
          )}
          <button type="submit" disabled={loading || pdfLoading || (!input.trim() && !pendingImage && !pendingPdf)}>
            {loading ? <Loader2 className="spin" size={20} /> : <Send size={20} />}
          </button>
        </div>
      </form>
    </div>
  );
}

