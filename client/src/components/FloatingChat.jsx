import { Bot, Headphones, Loader2, MessageSquare, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import MarkdownText from './MarkdownText';
import ThinkingText from './ThinkingText';
import { useStreamingPoll, stripSystemTags } from '../hooks/useStreamingPoll';
import './FloatingChat.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
const POLL_TIMEOUT_MS = 150_000;
const SUPPORT_HISTORY_KEY = 'support_chat_history';
const SUPPORT_GREETING = 'Здравствуйте! Я помогу вам освоиться на сайте и отвечу на любые ваши вопросы.';

export default function FloatingChatWidget({ apiKey }) {
  const location = useLocation();
  const hidden = location.pathname === '/chat' || location.pathname === '/';
  if (hidden) return null;
  return <FloatingChat apiKey={apiKey} />;
}

function loadSupportHistory() {
  try { return JSON.parse(localStorage.getItem(SUPPORT_HISTORY_KEY)) || null; } catch { return null; }
}
function saveSupportHistory(msgs) {
  localStorage.setItem(SUPPORT_HISTORY_KEY, JSON.stringify(msgs.slice(-40)));
}

function FloatingChat({ apiKey }) {
  const [open, setOpen]   = useState(false);
  const [tab, setTab]     = useState('ai'); // 'ai' | 'support'
  const [unread, setUnread] = useState(false);

  // AI tab
  const [messages, setMessages]   = useState(null);
  const aiTaskRef      = useRef(null);
  const aiPollStart    = useRef(null);

  const { loading: aiLoading, setLoading: setAiLoading, streamingText: aiStreamText, isStreaming: aiStreaming, startPolling: startAiPoll, stopPolling: stopAiPollHook } = useStreamingPoll({
    apiKey,
    onComplete: (data) => {
      aiTaskRef.current = null; aiPollStart.current = null;
      const text = stripSystemTags(data.result || '') || aiStreamText || '(пустой ответ)';
      setMessages(p => [...(p || []), { role: 'ai', content: text, createdAt: new Date() }]);
      if (!open) setUnread(true);
    },
    onError: (msg) => {
      aiTaskRef.current = null; aiPollStart.current = null;
      setMessages(p => [...(p || []), { role: 'ai', content: `❌ ${msg || 'Ошибка нейросети'}`, createdAt: new Date() }]);
    },
  });

  const { loading: suppLoading, setLoading: setSuppLoading, streamingText: suppStreamText, isStreaming: suppStreaming, startPolling: startSuppPoll, stopPolling: stopSuppPollHook } = useStreamingPoll({
    apiKey,
    resultPath: '/demo/result/',
    onComplete: (data) => {
      suppTaskRef.current = null; suppPollStart.current = null;
      const text = stripSystemTags(data.result || '') || suppStreamText || '(пустой ответ)';
      setSupportMsgs(p => {
        const next = [...(p || []), { role: 'ai', content: text, createdAt: new Date() }];
        saveSupportHistory(next); return next;
      });
      if (!open) setUnread(true);
    },
    onError: (msg) => {
      suppTaskRef.current = null; suppPollStart.current = null;
      setSupportMsgs(p => {
        const next = [...(p || []), { role: 'ai', content: `❌ ${msg || 'Ошибка'}`, createdAt: new Date() }];
        saveSupportHistory(next); return next;
      });
    },
  });

  // Legacy refs kept for visibility-recovery logic compatibility
  const aiPollRef      = useRef(null);

  // Support tab
  const [supportMsgs, setSupportMsgs]     = useState(null);
  const suppTaskRef    = useRef(null);
  const suppPollRef    = useRef(null);
  const suppPollStart  = useRef(null);

  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);
  const textareaRef    = useRef(null);

  // Scroll to bottom on new messages / loading
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, aiLoading, supportMsgs, suppLoading]);

  // On open / tab switch
  useEffect(() => {
    if (!open) return;
    setUnread(false);
    if (tab === 'ai' && messages === null) fetchAiHistory();
    if (tab === 'support' && supportMsgs === null) initSupport();
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 150);
  }, [open, tab]);

  useEffect(() => () => { clearTimeout(aiPollRef.current); clearTimeout(suppPollRef.current); }, []);

  useEffect(() => {
    const handler = () => { setOpen(true); setTab('support'); };
    window.addEventListener('open-consultant', handler);
    return () => window.removeEventListener('open-consultant', handler);
  }, []);

  // Visibility recovery for AI tab
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (aiTaskRef.current) { startAiPoll(aiTaskRef.current); }
      if (suppTaskRef.current) { startSuppPoll(suppTaskRef.current); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // ── AI tab ──────────────────────────────────────────────────────────────────
  const fetchAiHistory = async () => {
    try {
      const res  = await fetch(`${API_URL}/chat/history`, { headers: { Authorization: `Bearer ${apiKey}` } });
      const data = await res.json();
      setMessages(data.success ? data.messages : []);
    } catch { setMessages([]); }
  };

  const stopAi = (errorMsg = null) => {
    stopAiPollHook();
    aiTaskRef.current = null; aiPollStart.current = null;
    clearTimeout(aiPollRef.current);
    if (errorMsg) setMessages(p => [...(p || []), { role: 'ai', content: errorMsg, createdAt: new Date() }]);
  };

  const handleAiSend = async () => {
    const text = input.trim();
    if (!text || aiLoading) return;
    setMessages(p => [...(p || []), { role: 'user', content: text, createdAt: new Date() }]);
    setInput(''); if (textareaRef.current) textareaRef.current.style.height = 'auto';
    try {
      const res  = await fetch(`${API_URL}/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      if (data.success) { aiTaskRef.current = data.taskId; aiPollStart.current = Date.now(); startAiPoll(data.taskId); }
      else throw new Error();
    } catch { stopAi('❌ Ошибка отправки'); }
  };

  // ── Support tab ─────────────────────────────────────────────────────────────
  const initSupport = () => {
    const saved = loadSupportHistory();
    if (saved && saved.length > 0) { setSupportMsgs(saved); return; }
    const init = [{ role: 'ai', content: SUPPORT_GREETING }];
    setSupportMsgs(init);
    saveSupportHistory(init);
  };

  const stopSupport = (errorMsg = null) => {
    suppTaskRef.current = null; suppPollStart.current = null;
    stopSuppPollHook();
    if (errorMsg) setSupportMsgs(p => {
      const next = [...(p || []), { role: 'ai', content: errorMsg }];
      saveSupportHistory(next); return next;
    });
  };

  const handleSupportSend = async () => {
    const text = input.trim();
    if (!text || suppLoading) return;
    const userMsg = { role: 'user', content: text };
    setSupportMsgs(p => { const next = [...(p || []), userMsg]; saveSupportHistory(next); return next; });
    setInput(''); if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const historyForApi = (supportMsgs || []).slice(-6).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    try {
      const res  = await fetch(`${API_URL}/support/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ message: text, history: historyForApi }),
      });
      const data = await res.json();
      if (data.success) { suppTaskRef.current = data.taskId; suppPollStart.current = Date.now(); startSuppPoll(data.taskId); }
      else throw new Error();
    } catch { stopSupport('❌ Ошибка отправки'); }
  };

  const handleSend = (e) => {
    e?.preventDefault();
    if (tab === 'ai') handleAiSend();
    else handleSupportSend();
  };

  const loading  = tab === 'ai' ? aiLoading : suppLoading;
  const msgs     = tab === 'ai' ? messages  : supportMsgs;
  const isEmpty  = msgs?.length === 0;

  return (
    <>
      <button
        className={`fc-trigger${open ? ' fc-trigger--open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-label={open ? 'Закрыть чат' : 'Открыть чат'}
      >
        <span className="fc-trigger__icon">
          <Bot size={22} className={`fc-icon-bot${open ? ' fc-icon--hidden' : ''}`} />
          <X   size={20} className={`fc-icon-x${open  ? '' : ' fc-icon--hidden'}`} />
        </span>
        {unread && !open && <span className="fc-badge" />}
      </button>

      <div className={`fc-panel${open ? ' fc-panel--open' : ''}`} aria-hidden={!open}>
        {/* Шапка */}
        <div className="fc-header">
          <Bot size={16} />
          <span>{tab === 'ai' ? 'Чат с нейросетью' : 'Онлайн-консультант'}</span>
          <button className="fc-close" onClick={() => setOpen(false)} aria-label="Закрыть"><X size={15} /></button>
        </div>

        {/* Вкладки */}
        <div className="fc-tabs">
          <button className={`fc-tab${tab === 'ai' ? ' fc-tab--active' : ''}`} onClick={() => setTab('ai')}>
            <MessageSquare size={13} /> Чат с нейросетью
          </button>
          <button className={`fc-tab${tab === 'support' ? ' fc-tab--active' : ''}`} onClick={() => setTab('support')}>
            <Headphones size={13} /> Онлайн-консультант
          </button>
        </div>

        {/* Сообщения */}
        <div className="fc-messages">
          {msgs === null && <div className="fc-center"><Loader2 size={22} className="spin" /></div>}
          {msgs !== null && isEmpty && tab === 'ai' && (
            <div className="fc-center fc-empty"><Bot size={30} /><p>Напишите что-нибудь</p></div>
          )}
          {msgs?.map((msg, i) => (
            <div key={i} className={`fc-msg fc-msg--${msg.role === 'user' ? 'user' : 'ai'}`}>
              {msg.role !== 'user'
                ? <div className="fc-bubble fc-bubble--md"><MarkdownText text={msg.content} isAi /></div>
                : <div className="fc-bubble">{msg.content}</div>
              }
            </div>
          ))}
          {aiLoading && !aiStreaming && tab === 'ai' && (
            <div className="fc-msg fc-msg--ai">
              <div className="fc-bubble fc-thinking"><ThinkingText /></div>
            </div>
          )}
          {aiStreaming && tab === 'ai' && (
            <div className="fc-msg fc-msg--ai">
              <div className="fc-bubble fc-bubble--md streaming-bubble">
                <MarkdownText text={aiStreamText} isAi />
                <span className="streaming-cursor" aria-hidden="true" />
              </div>
            </div>
          )}
          {suppLoading && !suppStreaming && tab === 'support' && (
            <div className="fc-msg fc-msg--ai">
              <div className="fc-bubble fc-thinking"><ThinkingText /></div>
            </div>
          )}
          {suppStreaming && tab === 'support' && (
            <div className="fc-msg fc-msg--ai">
              <div className="fc-bubble fc-bubble--md streaming-bubble">
                <MarkdownText text={suppStreamText} isAi />
                <span className="streaming-cursor" aria-hidden="true" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Ввод */}
        <form className="fc-input-row" onSubmit={handleSend}>
          <textarea
            ref={(el) => { inputRef.current = el; textareaRef.current = el; }}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px';
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={tab === 'ai' ? 'Напишите сообщение...' : 'Задайте вопрос о сайте...'}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
          </button>
        </form>
      </div>
    </>
  );
}
