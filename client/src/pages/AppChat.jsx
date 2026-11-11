import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUp, Plus, PanelLeftClose, PanelLeft, Search, MessageSquare,
  Trash2, LogIn, Paperclip, ChevronDown, Sparkles, LayoutDashboard, Briefcase, Pencil,
} from 'lucide-react';
import MarkdownText from '../components/MarkdownText';
import ThinkingText from '../components/ThinkingText';
import { useStreamingPoll, stripSystemTags } from '../hooks/useStreamingPoll';
import './AppChat.css';

const API_URL = import.meta.env.VITE_API_URL || '/api/v1';
const LS_KEY = 'siberi_app_chats_v1';
const VISITOR_KEY = 'siberi_visitor_id';

function getVisitorId() {
  let id = localStorage.getItem(VISITOR_KEY);
  if (!id) {
    id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(VISITOR_KEY, id);
  }
  return id;
}

// ─── guest storage ───
function loadChats() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch { /* noop */ }
  return null;
}
function saveChats(chats) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(chats.slice(0, 60))); } catch { /* noop */ }
}
function localChat() {
  return { id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: 'Новый чат', messages: [], loaded: true, createdAt: Date.now() };
}
function titleFrom(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Новый чат';
}

const SUGGESTIONS = [
  { icon: '✍️', title: 'Написать текст', prompt: 'Напиши продающее описание для нового продукта — умные часы с ИИ-ассистентом.' },
  { icon: '💡', title: 'Придумать идеи', prompt: 'Придумай 10 идей коротких видео для Telegram-канала про нейросети.' },
  { icon: '🧠', title: 'Объяснить просто', prompt: 'Объясни простыми словами, как работают большие языковые модели.' },
  { icon: '💻', title: 'Помочь с кодом', prompt: 'Напиши функцию на JavaScript, которая дебаунсит вызовы, и объясни, как она работает.' },
];

export default function AppChat() {
  const navigate = useNavigate();
  const apiKey = useMemo(() => localStorage.getItem('apiKey'), []);
  const authed = !!apiKey;
  const visitorId = useMemo(getVisitorId, []);

  const [chats, setChats] = useState(() => (authed ? [] : (loadChats() || [localChat()])));
  const [activeId, setActiveId] = useState(() => (authed ? null : (loadChats()?.[0]?.id || null)));
  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [limitInfo, setLimitInfo] = useState(null);
  const [booting, setBooting] = useState(authed);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [attachment, setAttachment] = useState(null); // прикреплённый текстовый документ

  const streamRef = useRef(null);
  const taRef = useRef(null);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const active = chats.find(c => c.id === activeId) || null;

  // Persist guest chats only
  useEffect(() => { if (!authed) saveChats(chats); }, [chats, authed]);

  const authHeaders = () => (authed ? { Authorization: `Bearer ${apiKey}` } : {});

  // ─── boot: load server conversations for authed users ───
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/conversations`, { headers: authHeaders() });
        const data = await res.json();
        if (cancelled) return;
        let list = (data.conversations || []).map(c => ({ id: c._id, title: c.title, messages: [], loaded: false }));
        if (!list.length) {
          const created = await createServerConversation();
          if (created) list = [created];
        }
        setChats(list);
        setActiveId(list[0]?.id || null);
      } catch { /* stay empty */ }
      finally { if (!cancelled) setBooting(false); }
    })();
    return () => { cancelled = true; };
  }, [authed]);

  // ─── lazy-load messages when selecting an unloaded server chat ───
  useEffect(() => {
    if (!authed || !active || active.loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/conversations/${active.id}/messages`, { headers: authHeaders() });
        const data = await res.json();
        if (cancelled) return;
        const messages = (data.messages || []).map(m => ({ role: m.role, content: m.content }));
        setChats(prev => prev.map(c => c.id === active.id ? { ...c, messages, loaded: true } : c));
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [authed, activeId]);

  // ─── Автопрокрутка: держимся низа, но отпускаем, как только листают вверх ───
  // Раньше лента дёргалась к концу на каждое новое сообщение безусловно. Читать
  // длинный ответ было нельзя: любое обновление возвращало вниз. Теперь «липнем»
  // к низу, только пока пользователь сам там стоит; ушёл вверх — не мешаем, а
  // кнопка «вниз» возвращает обратно.
  const stickBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onStreamScroll = () => {
    const box = streamRef.current;
    if (!box) return;
    // 80px «мёртвой зоны»: во время печати высота растёт, и точное равенство
    // низу почти никогда не выполняется.
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    stickBottom.current = near;
    setAtBottom(near);
  };

  const scrollToBottom = (smooth) => {
    const box = streamRef.current;
    if (!box) return;
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickBottom.current = true;
    setAtBottom(true);
  };

  // Новое сообщение — прыгаем вниз плавно (если не читаем историю выше).
  useEffect(() => {
    if (stickBottom.current) scrollToBottom(true);
  }, [active?.messages, booting]);

  // Смена чата — всегда в конец, мгновенно.
  useEffect(() => { stickBottom.current = true; scrollToBottom(false); }, [activeId]);

  const pushMessage = (chatId, msg) => {
    setChats(prev => prev.map(c => {
      if (c.id !== chatId) return c;
      const messages = [...c.messages, msg];
      let title = c.title;
      if (title === 'Новый чат' && msg.role === 'user') title = titleFrom(msg.content);
      return { ...c, title, messages };
    }));
  };

  const { loading, streamingText, isStreaming, startPolling } = useStreamingPoll({
    apiKey,
    resultPath: '/demo/result/',
    onComplete: (data) => {
      const text = stripSystemTags(data.result || '') || streamingText || '(пустой ответ)';
      const cid = activeIdRef.current;
      pushMessage(cid, { role: 'ai', content: text });
      if (authed && cid) {
        fetch(`${API_URL}/conversations/${cid}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ content: text }),
        }).catch(() => {});
      }
    },
    onError: (msg) => {
      pushMessage(activeIdRef.current, { role: 'ai', content: `⚠️ ${msg || 'Не удалось получить ответ'}` });
    },
  });

  // Печать ответа — догоняем низ мгновенно: на «smooth» кадры печати накладывают
  // анимации друг на друга и лента перестаёт слушаться колеса. Эффект стоит ниже
  // useStreamingPoll намеренно — streamingText объявлен там.
  useEffect(() => {
    if (stickBottom.current) scrollToBottom(false);
  }, [streamingText]);

  async function createServerConversation() {
    try {
      const res = await fetch(`${API_URL}/conversations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: '{}',
      });
      const data = await res.json();
      if (data.conversation) return { id: data.conversation._id, title: data.conversation.title, messages: [], loaded: true };
    } catch { /* noop */ }
    return null;
  }

  // Прикрепление текстового документа: читаем в браузере, подмешиваем в промпт.
  const readAttachment = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAttachment({ name: file.name, content: String(reader.result || '').slice(0, 200000) });
    reader.onerror = () => setAttachment(null);
    reader.readAsText(file);
  };

  const send = async (raw) => {
    const typed = (raw ?? input).trim();
    if ((!typed && !attachment) || loading) return;

    // Ensure there is an active chat
    let chat = active;
    if (!chat) {
      if (authed) { chat = await createServerConversation(); if (!chat) return; setChats(prev => [chat, ...prev]); setActiveId(chat.id); activeIdRef.current = chat.id; }
      else { chat = localChat(); setChats(prev => [chat, ...prev]); setActiveId(chat.id); activeIdRef.current = chat.id; }
    }

    // Прикреплённый файл: в чате показываем компактно, в модель уходит полный текст.
    const att = attachment;
    const displayText = att ? `📎 ${att.name}${typed ? '\n' + typed : ''}` : typed;
    const sendText = att
      ? `Содержимое прикреплённого файла «${att.name}»:\n"""\n${att.content}\n"""\n\n${typed || 'Проанализируй прикреплённый файл.'}`
      : typed;

    setInput('');
    setAttachment(null);
    if (taRef.current) taRef.current.style.height = 'auto';
    setLimitInfo(null);
    pushMessage(chat.id, { role: 'user', content: displayText });

    try {
      if (authed) {
        const res = await fetch(`${API_URL}/conversations/${chat.id}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ message: sendText }),
        });
        const data = await res.json();
        if (data.limitReached) { setLimitInfo({ resetIn: data.resetIn, limit: data.limit }); return; }
        if (data.success && data.taskId) startPolling(data.taskId);
        else throw new Error();
      } else {
        const history = (chat.messages || []).slice(-8).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
        const res = await fetch(`${API_URL}/demo/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitorId, message: sendText, history, source: 'app_chat' }),
        });
        const data = await res.json();
        if (data.limitReached) { setLimitInfo({ resetIn: data.resetIn, limit: data.limit }); return; }
        if (data.success && data.taskId) startPolling(data.taskId);
        else throw new Error();
      }
    } catch {
      pushMessage(chat.id, { role: 'ai', content: '⚠️ Ошибка отправки. Попробуйте ещё раз.' });
    }
  };

  const createChat = async () => {
    // Reuse the current empty chat instead of piling up blanks
    if (active && active.messages.length === 0) { setInput(''); setLimitInfo(null); return; }
    if (authed) {
      const c = await createServerConversation();
      if (!c) return;
      setChats(prev => [c, ...prev]); setActiveId(c.id);
    } else {
      const c = localChat();
      setChats(prev => [c, ...prev]); setActiveId(c.id);
    }
    setLimitInfo(null); setInput('');
  };

  const deleteChat = (id, e) => {
    e?.stopPropagation();
    if (authed) {
      fetch(`${API_URL}/conversations/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    }
    setChats(prev => {
      const next = prev.filter(c => c.id !== id);
      if (!next.length) { const c = localChat(); if (authed) createServerConversation().then(sc => sc && setChats([sc])); return [c]; }
      if (activeId === id) setActiveId(next[0].id);
      return next;
    });
  };

  const startRename = (c, e) => { e?.stopPropagation(); setEditingId(c.id); setEditValue(c.title); };
  const cancelRename = () => { setEditingId(null); setEditValue(''); };
  const commitRename = () => {
    const id = editingId;
    const title = editValue.trim().slice(0, 80);
    setEditingId(null);
    if (!id || !title) return;
    setChats(prev => prev.map(c => (c.id === id ? { ...c, title } : c)));
    if (authed) {
      fetch(`${API_URL}/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ title }),
      }).catch(() => {});
    }
  };

  const filtered = query.trim()
    ? chats.filter(c => c.title.toLowerCase().includes(query.trim().toLowerCase()))
    : chats;

  const isEmpty = !active || active.messages.length === 0;

  const onKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const autosize = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
  };

  return (
    <div className={`fa-app ac${sidebarOpen ? '' : ' ac--collapsed'}`}>
      {/* фон — глобальный SiteBackground (teleconstructor), рендерится в App */}

      {/* ─── Sidebar ─── */}
      <aside className="ac-side">
        <div className="ac-side__head">
          <div className="ac-brand">
            <img className="ac-brand__mark" src="/siberi-logo.webp" alt="Siberi" />
            <span className="ac-brand__name">Siberi</span>
          </div>
          <button className="ac-icon-btn" title="Свернуть панель" onClick={() => setSidebarOpen(false)}>
            <PanelLeftClose size={18} />
          </button>
        </div>

        <button className="ac-newchat" onClick={createChat}>
          <Plus size={17} /> <span>Новый чат</span>
        </button>

        <div className="ac-search">
          <Search size={15} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по чатам" />
        </div>

        <div className="ac-chatlist" data-lenis-prevent>
          <div className="ac-chatlist__label">Чаты</div>
          {booting && <div className="ac-chatlist__empty">Загрузка…</div>}
          {!booting && filtered.map(c => (
            <div
              key={c.id}
              className={`ac-chatitem${c.id === activeId ? ' is-active' : ''}${editingId === c.id ? ' is-editing' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => { if (editingId !== c.id) { setActiveId(c.id); setLimitInfo(null); } }}
              onKeyDown={(e) => { if (editingId !== c.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setActiveId(c.id); } }}
              onDoubleClick={(e) => startRename(c, e)}
            >
              <MessageSquare size={15} className="ac-chatitem__ic" />
              {editingId === c.id ? (
                <input
                  className="ac-chatitem__edit"
                  value={editValue}
                  autoFocus
                  maxLength={80}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setEditValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') cancelRename();
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <span className="ac-chatitem__title">{c.title}</span>
              )}
              {editingId !== c.id && (
                <div className="ac-chatitem__actions">
                  <button className="ac-chatitem__act" title="Переименовать" onClick={(e) => startRename(c, e)}>
                    <Pencil size={13} />
                  </button>
                  <button className="ac-chatitem__act is-danger" title="Удалить" onClick={(e) => deleteChat(c.id, e)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
          {!booting && !filtered.length && <div className="ac-chatlist__empty">Ничего не найдено</div>}
        </div>

        <div className="ac-side__foot">
          <button className="ac-login ac-login--ghost" onClick={() => navigate('/about')}>
            <Briefcase size={16} /> <span>Для бизнеса</span>
          </button>
          {authed ? (
            <button className="ac-login ac-login--ghost" onClick={() => navigate('/panel')}>
              <LayoutDashboard size={16} /> <span>Кабинет</span>
            </button>
          ) : (
            <>
              <button className="ac-login" onClick={() => navigate('/login')}>
                <LogIn size={16} /> <span>Войти</span>
              </button>
              <div className="ac-side__hint">Гостевой режим · 3 сообщения в день</div>
            </>
          )}
        </div>
      </aside>

      {/* ─── Main ─── */}
      <main className="ac-main">
        <header className="ac-top">
          {!sidebarOpen && (
            <button className="ac-icon-btn" title="Показать панель" onClick={() => setSidebarOpen(true)}>
              <PanelLeft size={18} />
            </button>
          )}
          <button className="ac-model">
            <Sparkles size={15} /> <span>Siberi AI</span> <ChevronDown size={14} />
          </button>
          <div className="ac-top__spacer" />
          {!authed && <button className="ac-top__cta" onClick={() => navigate('/login')}>Войти</button>}
        </header>

        {isEmpty ? (
          <div className="ac-hero">
            <img className="ac-hero__mark" src="/siberi-logo.webp" alt="Siberi" />
            <h1 className="ac-hero__title">Чем помочь?</h1>
            <p className="ac-hero__sub">Siberi — нейросеть, которая пишет, объясняет, считает и помогает с делами.</p>

            <div className="ac-composer ac-composer--hero">
              <Composer input={input} taRef={taRef} loading={loading} onChange={autosize} onKeyDown={onKeyDown} onSend={() => send()} attachment={attachment} onAttach={readAttachment} onRemoveAttach={() => setAttachment(null)} />
            </div>

            <div className="ac-suggest">
              {SUGGESTIONS.map(s => (
                <button key={s.title} className="ac-suggest__item" onClick={() => send(s.prompt)}>
                  <span className="ac-suggest__ic">{s.icon}</span>
                  <span className="ac-suggest__t">{s.title}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="ac-stream" data-lenis-prevent ref={streamRef} onScroll={onStreamScroll}>
              <div className="ac-stream__inner">
                {active.messages.map((m, i) => (<Message key={i} role={m.role} content={m.content} />))}
                {loading && !isStreaming && (
                  <div className="ac-row ac-row--ai">
                    <div className="ac-ava">S</div>
                    <div className="ac-msg ac-msg--ai"><ThinkingText /></div>
                  </div>
                )}
                {isStreaming && (
                  <div className="ac-row ac-row--ai">
                    <div className="ac-ava">S</div>
                    <div className="ac-msg ac-msg--ai">
                      <MarkdownText text={streamingText} isAi />
                      <span className="ac-cursor" aria-hidden="true" />
                    </div>
                  </div>
                )}
                {limitInfo && (
                  <div className="ac-limit">
                    Дневной лимит для гостей исчерпан ({limitInfo.limit || 10} в сутки). Зарегистрируйтесь — общайтесь без ограничений, бесплатно.
                    <button onClick={() => navigate('/login')}>Зарегистрироваться</button>
                  </div>
                )}
              </div>
            </div>

            {!atBottom && (
              <button className="ac-scrolldown" onClick={() => scrollToBottom(true)} title="К последнему сообщению" aria-label="К последнему сообщению">
                <ChevronDown size={18} />
              </button>
            )}

            <div className="ac-composer ac-composer--docked">
              <Composer input={input} taRef={taRef} loading={loading} onChange={autosize} onKeyDown={onKeyDown} onSend={() => send()} attachment={attachment} onAttach={readAttachment} onRemoveAttach={() => setAttachment(null)} />
              <div className="ac-composer__note">Siberi может ошибаться. Проверяйте важное.</div>
            </div>
          </>
        )}
      </main>

    </div>
  );
}

function Composer({ input, taRef, loading, onChange, onKeyDown, onSend, attachment, onAttach, onRemoveAttach }) {
  const fileRef = useRef(null);
  return (
    <div className="ac-inputbox">
      <input ref={fileRef} type="file" hidden
        accept=".txt,.md,.markdown,.csv,.json,.log,.text,.yml,.yaml,.xml,.rtf,.tsv,.ini,.conf"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(f); e.target.value = ''; }} />
      <button className="ac-inputbox__attach" title="Прикрепить текстовый документ" type="button" onClick={() => fileRef.current?.click()}><Paperclip size={18} /></button>
      {attachment && (
        <span className="ac-attach-chip" title={attachment.name}>
          <Paperclip size={13} />
          <span className="ac-attach-chip__name">{attachment.name}</span>
          <button type="button" className="ac-attach-chip__x" title="Убрать" onClick={onRemoveAttach}>×</button>
        </span>
      )}
      <textarea ref={taRef} value={input} rows={1} onChange={onChange} onKeyDown={onKeyDown} placeholder="Спросите что угодно…" />
      <button className="ac-inputbox__send" onClick={onSend} disabled={loading || (!input.trim() && !attachment)} title="Отправить" type="button">
        <ArrowUp size={18} />
      </button>
    </div>
  );
}

// memo: во время печати ответа AppChat перерисовывается десятки раз в секунду, и без
// мемоизации КАЖДОЕ прошлое сообщение заново прогонялось через тяжёлый парсер markdown.
// Чем больше ответов в диалоге, тем сильнее лаг. Готовые сообщения не меняются —
// пропускаем их перерисовку, парсим только новое.
const Message = memo(function Message({ role, content }) {
  if (role === 'user') {
    return (
      <div className="ac-row ac-row--user">
        <div className="ac-msg ac-msg--user">{content}</div>
      </div>
    );
  }
  return (
    <div className="ac-row ac-row--ai">
      <div className="ac-ava">S</div>
      <div className="ac-msg ac-msg--ai"><MarkdownText text={content} isAi /></div>
    </div>
  );
});
