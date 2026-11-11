import axios from 'axios';
import { Bot, Check, Copy, ImageIcon, Loader2, Mic, MicOff, Send, User, X } from 'lucide-react';
import ThinkingText from '../components/ThinkingText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import './ChatEmbed.css';

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

export default function ChatEmbed() {
  const [searchParams] = useSearchParams();
  // Support both ?key= (legacy) and ?token= (embed token, preferred — doesn't expose real API key)
  const apiKey = searchParams.get('token') || searchParams.get('key');
  const embedUserId = searchParams.get('userId') || '';

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiName, setAiName] = useState('AI-ассистент');
  const [pendingImage, setPendingImage] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });

  const messagesEndRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const voiceBaseRef = useRef('');
  const robotRef = useRef(null);

  const speechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    if (!apiKey) return;
    axios.get(`${API_URL}/config`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then((res) => {
      if (res.data.success && res.data.config?.aiName) setAiName(res.data.config.aiName);
    }).catch(() => {});
  }, [apiKey]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!robotRef.current) return;
      const rect = robotRef.current.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        const scale = Math.min(dist, 180) / 180;
        setEyeOffset({ x: (dx / dist) * 3 * scale, y: (dy / dist) * 3 * scale });
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    return () => {
      clearTimeout(pollTimeoutRef.current);
      recognitionRef.current?.stop();
    };
  }, []);

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

  const pollResult = async (id) => {
    try {
      const res = await axios.get(`${API_URL}/result/${id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = res.data;
      if (data.status === 'completed') {
        setMessages((prev) => [
          ...prev,
          { role: 'ai', content: data.result, attachments: data.attachments || [], createdAt: new Date() },
        ]);
        setLoading(false);
      } else if (data.status === 'error') {
        // Never show the raw internal error (data.error) to the end user — it's
        // technical detail meant for admin debugging, not a real reply. Server
        // already alerted the developer when it set this task to 'error'.
        setMessages((prev) => [
          ...prev,
          {
            role: 'ai',
            content: 'Прошу прощения, я сломалась. Но моему разработчику уже отправлен сигнал. Вы можете связаться с нашим менеджером @SiberiManager.',
            createdAt: new Date(),
          },
        ]);
        setLoading(false);
      } else {
        pollTimeoutRef.current = setTimeout(() => pollResult(id), 1500);
      }
    } catch (err) {
      console.error('Poll error:', err);
      pollTimeoutRef.current = setTimeout(() => pollResult(id), 2000);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if ((!text && !pendingImage) || loading || !apiKey) return;

    const sentImage = pendingImage;
    const sentText = text || '(изображение)';

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: sentText, image: sentImage, createdAt: new Date() },
    ]);
    setInput('');
    setPendingImage(null);
    setLoading(true);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    try {
      const body = { prompt: sentText, platform: 'web' };
      if (embedUserId) body.platformUserId = embedUserId;
      if (sentImage) body.image = sentImage;

      const res = await axios.post(`${API_URL}/analyze`, body, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.data.success && res.data.taskId) {
        pollResult(res.data.taskId);
      } else {
        throw new Error(res.data.error || 'No taskId');
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'ai', content: '❌ Ошибка отправки сообщения', createdAt: new Date() },
      ]);
      setLoading(false);
    }
  };

  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleImageFile(file);
  };

  if (!apiKey) {
    return (
      <div className="ce-no-key">
        <div className="ce-no-key__icon"><Bot size={48} /></div>
        <p>Токен не указан</p>
        <span>Добавьте параметр <code>?token=ВАШ_ТОКЕН</code> к URL страницы</span>
      </div>
    );
  }

  return (
    <div
      className={`ce-wrap${dragOver ? ' ce-drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="ce-drop-overlay">
          <ImageIcon size={40} />
          <p>Отпустите изображение</p>
        </div>
      )}

      <div className="ce-header">
        <div className="ce-header-left">
          <div className="ce-robot" ref={robotRef}>
            <Bot size={48} />
            <div
              className="ce-eye-l"
              style={{ transform: `translate(calc(-50% + ${eyeOffset.x}px), calc(-50% + ${eyeOffset.y}px))` }}
            />
            <div
              className="ce-eye-r"
              style={{ transform: `translate(calc(-50% + ${eyeOffset.x}px), calc(-50% + ${eyeOffset.y}px))` }}
            />
          </div>
          <div className="ce-header-info">
            <h1 className="ce-ai-name">{aiName}</h1>
            <span className="ce-online"><span className="ce-online-dot" />Онлайн</span>
          </div>
        </div>
        <a className="ce-powered" href="https://siberi.online" target="_blank" rel="noopener noreferrer">
          Powered by Siberi AI
        </a>
      </div>

      <div className="ce-messages">
        {messages.length === 0 && !loading && (
          <div className="ce-empty">
            <p>Привет! Чем могу помочь?</p>
            <span>Вставьте изображение через Ctrl+V или перетащите файл</span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ce-msg ${msg.role}`}>
            <div className="ce-msg-avatar">
              {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
            </div>
            <div className="ce-msg-bubble">
              {msg.image && <img className="ce-msg-image" src={msg.image} alt="вложение" />}
              <MarkdownText text={msg.content} isAi={msg.role === 'ai'} />
              {msg.attachments?.length > 0 && (
                <div className="ce-attachments">
                  {msg.attachments.map((src, j) => (
                    <a key={j} href={src} target="_blank" rel="noopener noreferrer">
                      <img className="ce-attachment-img" src={src} alt={`chart-${j + 1}`} />
                    </a>
                  ))}
                </div>
              )}
              <span className="ce-msg-time">
                {new Date(msg.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))}

        {loading && (
          <div className="ce-msg ai">
            <div className="ce-msg-avatar"><Bot size={16} /></div>
            <div className="ce-msg-bubble ce-thinking">
              <ThinkingText />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form className="ce-input-area" onSubmit={handleSend}>
        {pendingImage && (
          <div className="ce-img-preview">
            <img src={pendingImage} alt="вложение" className="ce-img-thumb" />
            <button type="button" className="ce-img-remove" onClick={() => setPendingImage(null)} title="Убрать">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="ce-input-row">
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
              recording ? '🎙 Говорите...' : pendingImage ? 'Добавьте подпись...' : 'Напишите сообщение...'
            }
            disabled={loading}
            autoFocus
          />
          {speechSupported && (
            <button
              type="button"
              className={`ce-voice-btn${recording ? ' ce-voice-btn--active' : ''}`}
              onClick={toggleVoice}
              disabled={loading}
              title={recording ? 'Остановить запись' : 'Голосовой ввод'}
            >
              {recording ? <MicOff size={18} /> : <Mic size={18} />}
              {recording && <span className="ce-voice-ring" />}
            </button>
          )}
          <button
            type="submit"
            className="ce-send-btn"
            disabled={loading || (!input.trim() && !pendingImage)}
          >
            {loading ? <Loader2 className="ce-spin" size={18} /> : <Send size={18} />}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button className="md-copy-btn" onClick={copy} type="button">
          {copied ? <><Check size={12} /> Скопировано</> : <><Copy size={12} /> Копировать</>}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function applyInline(text, key = 0) {
  const parts = [];
  const re = /(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)|(`([^`]+?)`)|\[([^\]]+?)\]\(([^)]+?)\)|(https?:\/\/[^\s<>"')\]]+)|(www\.[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(?:\/[^\s<>"')\]]*)?)|((?<![a-zA-Z0-9@./])[a-zA-Z0-9][a-zA-Z0-9-]{2,}\.(?:ru|kz|ua|by|am|az|ge|kg|md|tj|tm|uz|com|net|org|io|ai|gov|edu|info)(?:\/[^\s<>"')\]]*)?(?![a-zA-Z0-9-.]))/g;
  let last = 0;
  let m;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])      parts.push(<strong key={`${key}-${idx++}`}>{m[2]}</strong>);
    else if (m[3]) parts.push(<em key={`${key}-${idx++}`}>{m[4]}</em>);
    else if (m[5]) parts.push(<code key={`${key}-${idx++}`} className="md-inline-code">{m[6]}</code>);
    else if (m[7]) parts.push(
      <a key={`${key}-${idx++}`} href={m[8]} target="_blank" rel="noopener noreferrer" className="md-source-link">
        <span className="md-source-icon">🔗</span>{m[7]}
      </a>
    );
    else if (m[9]) parts.push(
      <a key={`${key}-${idx++}`} href={m[9]} target="_blank" rel="noopener noreferrer" className="md-source-link">
        <span className="md-source-icon">🔗</span>{m[9].replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
      </a>
    );
    else if (m[10]) parts.push(
      <a key={`${key}-${idx++}`} href={`https://${m[10]}`} target="_blank" rel="noopener noreferrer" className="md-source-link">
        <span className="md-source-icon">🔗</span>{m[10].replace(/\/$/, '')}
      </a>
    );
    else if (m[11]) parts.push(
      <a key={`${key}-${idx++}`} href={`https://${m[11]}`} target="_blank" rel="noopener noreferrer" className="md-source-link">
        <span className="md-source-icon">🔗</span>{m[11].replace(/\/$/, '')}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function normalizeHtmlToMd(raw) {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `• ${c.trim()}\n`)
    .replace(/<\/?ul[^>]*>/gi, '\n').replace(/<\/?ol[^>]*>/gi, '\n')
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, c) => `${'#'.repeat(+lvl)} ${c.trim()}\n`)
    .replace(/<[^>]+>/g, '');
}

function MarkdownText({ text, isAi }) {
  if (!text) return null;
  text = normalizeHtmlToMd(text);

  const segments = [];
  const codeRe = /```(\w*)\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', content: text.slice(last, m.index) });
    segments.push({ type: 'code', lang: m[1], content: m[2].trimEnd() });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last) });

  return (
    <div className={`md${isAi ? ' md-ai' : ''}`}>
      {segments.map((seg, si) => {
        if (seg.type === 'code') return <CodeBlock key={si} lang={seg.lang} code={seg.content} />;

        let lines = seg.content.split('\n');
        {
          const merged = [];
          for (const ln of lines) {
            const t = ln.trim();
            const prevT = merged.length > 0 ? merged[merged.length - 1].trim() : '';
            if (prevT && /^\|/.test(prevT) && t && !/^\|/.test(t) && t.includes('|')) {
              merged[merged.length - 1] = merged[merged.length - 1].trimEnd() + ' ' + t;
            } else {
              merged.push(ln);
            }
          }
          lines = merged;
        }
        const nodes = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];

          const hm = line.match(/^(#{1,4})\s+(.+)/);
          if (hm) {
            const lvl = Math.min(hm[1].length + 1, 5);
            const Tag = `h${lvl}`;
            nodes.push(<Tag key={`${si}-${i}`} className={`md-h md-h${hm[1].length}`}>{applyInline(hm[2], `${si}-${i}`)}</Tag>);
            i++; continue;
          }

          if (/^---+$/.test(line.trim())) {
            nodes.push(<hr key={`${si}-${i}`} className="md-hr" />);
            i++; continue;
          }

          if (/^\|.+\|/.test(line)) {
            const tableLines = [];
            while (i < lines.length && /^\|.+\|/.test(lines[i])) {
              tableLines.push(lines[i]);
              i++;
            }
            const isSep = (l) => /^\|[\s\-:|]+\|/.test(l);
            const parseRow = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
            const headerLine = tableLines[0];
            const bodyLines = tableLines.filter((l, idx) => idx !== 0 && !isSep(l));
            nodes.push(
              <div key={`${si}-tbl-${i}`} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>{parseRow(headerLine).map((h, hi) => <th key={hi}>{applyInline(h, `th-${si}-${hi}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {bodyLines.map((row, ri) => (
                      <tr key={ri}>
                        {parseRow(row).map((cell, ci) => <td key={ci}>{applyInline(cell, `td-${si}-${ri}-${ci}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
            continue;
          }

          if (/^[-*•·–—]\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^[-*•·–—]\s/.test(lines[i])) {
              items.push(<li key={i}>{applyInline(lines[i].replace(/^[-*•·–—]\s+/, ''), i)}</li>);
              i++;
            }
            nodes.push(<ul key={`${si}-ul-${i}`} className="md-ul">{items}</ul>);
            continue;
          }

          if (/^[•·–—]$/.test(line.trim()) && i + 1 < lines.length) {
            const next = lines[i + 1];
            if (next.trim() !== '') {
              lines[i + 1] = line.trim() + ' ' + next;
              i++;
              continue;
            }
          }

          if (/^\d+\.\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
              const content = lines[i].replace(/^\d+\.\s+/, '');
              const hasExplicitBold = /\*\*/.test(content);
              items.push(
                <li key={i}>
                  {hasExplicitBold
                    ? applyInline(content, i)
                    : <strong>{applyInline(content, i)}</strong>}
                </li>
              );
              i++;
            }
            nodes.push(<ol key={`${si}-ol-${i}`} className="md-ol">{items}</ol>);
            continue;
          }

          if (line.trim() === '') { i++; continue; }

          const rawParaLines = [];
          while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !/^(#{1,4}\s|[-*•·–—]\s|\d+\.\s|---+$|\|.+\|)/.test(lines[i])
          ) {
            rawParaLines.push(lines[i]);
            i++;
          }
          if (rawParaLines.length) {
            const paraLines = [];
            for (const l of rawParaLines) {
              const prev = paraLines[paraLines.length - 1];
              if (prev !== undefined) {
                const opens = (prev.match(/\(/g) || []).length;
                const closes = (prev.match(/\)/g) || []).length;
                if (opens > closes) {
                  paraLines[paraLines.length - 1] = prev + ' ' + l.trimStart();
                  continue;
                }
              }
              paraLines.push(l);
            }
            let nextNonEmpty = '';
            for (let j = i; j < lines.length; j++) {
              if (lines[j].trim()) { nextNonEmpty = lines[j].trim(); break; }
            }
            const isCaption = /^\|.+\|/.test(nextNonEmpty);
            nodes.push(
              <p key={`${si}-p-${i}`} className={`md-p${isCaption ? ' md-table-caption' : ''}`}>
                {paraLines.map((l, j) => (
                  <span key={j}>{applyInline(l, `${si}-${i}-${j}`)}{j < paraLines.length - 1 ? <br /> : null}</span>
                ))}
              </p>
            );
          }
        }
        return <>{nodes}</>;
      })}
    </div>
  );
}
