import { useCallback, useEffect, useRef, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
// Above AiService's own 20-min stuck-detection ceiling — see doPoll's pending branch.
const CLIENT_HARD_CEILING_MS = 22 * 60 * 1000;

const SYSTEM_TAG_NAMES = 'DB_COMMAND|BOT_SETTINGS|BOT_COMMANDS|BOT_PREVIEW|WELCOME_MESSAGE|NOTIF_COMMAND';
const SYSTEM_TAG_RE = new RegExp(`<(${SYSTEM_TAG_NAMES})[\\s>][\\s\\S]*?<\\/\\1>|<(${SYSTEM_TAG_NAMES})[\\s\\S]*?\\/>`, 'gi');
// Match full tag name + optional content, OR a known prefix of a tag name (e.g. "<DB_COM" mid-stream)
const SYSTEM_TAG_PARTIAL_RE = new RegExp(
  `<(?:${SYSTEM_TAG_NAMES})(?:[\\s>][\\s\\S]*)?$|<(?:DB|BOT|WELCO|NOTIF)[A-Z_]*(?:[\\s>][\\s\\S]*)?$`,
  'gi'
);
export function stripSystemTags(text) {
  if (!text) return '';
  return text
    .replace(SYSTEM_TAG_RE, '')
    .replace(SYSTEM_TAG_PARTIAL_RE, '')
    .replace(/\[END_TEXT\]/g, '')
    .replace(/\s*\d{1,2}:\d{2}\s*[ap]m\s*$/gim, '')
    // Mistral recurring spelling error
    .replace(/Лойальность/g, 'Лояльность')
    .trim();
}

export function hasSystemCommands(text) {
  if (!text) return false;
  return /<(DB_COMMAND|BOT_SETTINGS|BOT_COMMANDS|BOT_PREVIEW|WELCOME_MESSAGE|NOTIF_COMMAND)[\s>]/i.test(text);
}

export function useStreamingPoll({ apiKey, onComplete, onError, onDbChange, resultPath = '/result/' }) {
  const [loading, setLoading]         = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming]  = useState(false);

  const tw          = useRef({ text: '', idx: 0, timer: null, started: false });
  const poll        = useRef(null);
  const pending     = useRef(null);
  const mounted     = useRef(true);
  const pollStart   = useRef(null);
  const dbFired     = useRef(false); // whether onDbChange was already called this session

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (poll.current)     clearTimeout(poll.current);
      if (tw.current.timer) clearInterval(tw.current.timer);
    };
  }, []);

  // ── Typewriter ─────────────────────────────────────────────────────────────
  // resumeFrom: skip re-animating already-displayed text — only type the new part
  const startTypewriter = useCallback((fullText, onDone, resumeFrom = 0) => {
    if (!mounted.current) return;
    if (tw.current.timer) clearInterval(tw.current.timer);

    const text = stripSystemTags(fullText);
    if (!text) { onDone?.(); return; }

    const len   = text.length;
    // Slower refresh rate for long texts to avoid blocking the browser's rendering thread
    const delay = Math.max(35, Math.min(60, Math.round(4500 / Math.max(len, 1))));
    const batch = Math.max(2, Math.floor(len / 55));
    const startIdx = Math.min(resumeFrom, text.length);

    tw.current = { text, idx: startIdx, timer: null, started: true, speedUp: false };
    setIsStreaming(true);
    // Show already-typed portion instantly — no re-animation from the top
    setStreamingText(text.slice(0, startIdx));

    if (startIdx >= text.length) { onDone?.(); return; }

    tw.current.timer = setInterval(() => {
      if (!mounted.current) { clearInterval(tw.current.timer); return; }
      const ref = tw.current;
      if (ref.idx >= ref.text.length) {
        clearInterval(ref.timer);
        ref.timer = null;
        if (mounted.current) setStreamingText(ref.text);
        onDone?.();
        return;
      }
      const remaining    = ref.text.length - ref.idx;
      const dynamicBatch = ref.speedUp
        ? Math.max(batch, Math.ceil(remaining / 12))
        : (remaining > 150 ? Math.max(batch, Math.ceil(remaining / 50)) : batch);
      const next = Math.min(ref.idx + dynamicBatch, ref.text.length);
      setStreamingText(ref.text.slice(0, next));
      tw.current.idx = next;
    }, delay);
  }, []);

  const stopTypewriter = useCallback(() => {
    if (tw.current.timer) clearInterval(tw.current.timer);
    tw.current = { text: '', idx: 0, timer: null, started: false };
    if (mounted.current) { setIsStreaming(false); setStreamingText(''); }
  }, []);

  const fireCompletion = useCallback(() => {
    if (!mounted.current) return;
    const p = pending.current;
    pending.current = null;
    stopTypewriter();
    setLoading(false);
    if (p) p.cb(p.data);
  }, [stopTypewriter]);

  // ── Polling ────────────────────────────────────────────────────────────────
  const doPoll = useCallback(async (taskId) => {
    if (!mounted.current) return;
    try {
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const res  = await fetch(`${API_URL}${resultPath}${taskId}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.partialResult) {
        // Notify parent when DB operations start (fire once per session)
        if (!dbFired.current && hasSystemCommands(data.partialResult)) {
          dbFired.current = true;
          onDbChange?.();
        }

        const cleanPartial = stripSystemTags(data.partialResult);
        if (!tw.current.started) {
          if (cleanPartial) startTypewriter(cleanPartial, null);
        } else if (cleanPartial.length > tw.current.text.length) {
          if (tw.current.timer) {
            // Timer running — extend target text, animation continues naturally
            tw.current.text = cleanPartial;
          } else {
            // Timer finished previous chunk — resume from where we stopped (no re-typing)
            startTypewriter(cleanPartial, null, tw.current.idx);
          }
        }
        // cleanPartial same length = DB_COMMAND phase — cursor blinks, no action needed
      }

      if (data.status === 'completed') {
        // Check final result for DB ops too (in case partialResult wasn't available)
        if (!dbFired.current && hasSystemCommands(data.result)) {
          dbFired.current = true;
          onDbChange?.();
        }

        // Attach whether DB ops happened so onComplete can show the "done" notification
        const completionData = { ...data, _dbChanged: dbFired.current };
        const cb = (d) => { if (mounted.current && onComplete) onComplete(d); };

        if (mounted.current) setLoading(false);

        if (tw.current.started) {
          const finalText = stripSystemTags(data.result || data.partialResult || '');
          if (finalText && finalText !== tw.current.text) {
            tw.current.text = finalText;
          }
          tw.current.speedUp = true;
          pending.current = { data: completionData, cb };
          const checkDeadline = Date.now() + 8000;
          const checkDone = setInterval(() => {
            if (!mounted.current || !tw.current.timer || Date.now() > checkDeadline) {
              clearInterval(checkDone);
              if (pending.current) {
                if (tw.current.text) setStreamingText(tw.current.text);
                fireCompletion();
              }
            }
          }, 100);
        } else {
          const text = stripSystemTags(data.result || data.partialResult || '');
          if (text) {
            pending.current = { data: completionData, cb };
            startTypewriter(text, fireCompletion);
            tw.current.speedUp = true;
          } else {
            cb(completionData);
          }
        }
      } else if (data.status === 'error') {
        stopTypewriter();
        if (mounted.current) setLoading(false);
        if (onError) onError(data.error || 'Ошибка');
      } else {
        const elapsed = Date.now() - (pollStart.current || 0);
        // Hard ceiling so a server-side hang (worker crash mid-task, a task that
        // never gets marked completed/error) doesn't spin the loader forever with
        // no way out for the user. Set above AiService's own HARD_CEILING_MS
        // (20 min, bumped today so legitimately long Bot Studio builds aren't cut
        // short) — this is a last-resort net, not the normal exit path.
        if (elapsed > CLIENT_HARD_CEILING_MS) {
          if (poll.current) clearTimeout(poll.current);
          stopTypewriter();
          if (mounted.current) setLoading(false);
          if (onError) onError('Превышено время ожидания ответа. Попробуйте ещё раз.');
          return;
        }
        if (tw.current.started) {
          // Adaptive rate while streaming: fast early, slower for long-running ops
          const streamDelay = elapsed < 8000 ? 300 : elapsed < 20000 ? 600 : 1000;
          poll.current = setTimeout(() => doPoll(taskId), streamDelay);
        } else {
          const delay = elapsed < 2000 ? 200 : elapsed < 6000 ? 400 : elapsed < 12000 ? 700 : 1200;
          poll.current = setTimeout(() => doPoll(taskId), delay);
        }
      }
    } catch {
      const elapsed = Date.now() - (pollStart.current || 0);
      if (elapsed > CLIENT_HARD_CEILING_MS) {
        stopTypewriter();
        if (mounted.current) setLoading(false);
        if (onError) onError('Превышено время ожидания ответа. Попробуйте ещё раз.');
        return;
      }
      poll.current = setTimeout(() => doPoll(taskId), 2000);
    }
  }, [apiKey, onComplete, onError, onDbChange, startTypewriter, stopTypewriter, fireCompletion]);

  const startPolling = useCallback((taskId) => {
    if (poll.current) clearTimeout(poll.current);
    // Clear any still-running typewriter interval from a previous task before
    // discarding tw.current — otherwise that old interval's closure keeps a
    // stale reference and silently no-ops its own clearInterval (it reads
    // ref.timer off the *new* tw.current, which is null), leaving it ticking
    // forever and fighting the next task's own typewriter over the same
    // mutable idx/text. Only matters for back-to-back submits, but cheap to
    // always do.
    if (tw.current.timer) clearInterval(tw.current.timer);
    tw.current    = { text: '', idx: 0, timer: null, started: false };
    pending.current = null;
    pollStart.current = Date.now();
    dbFired.current = false;
    if (mounted.current) { setLoading(true); setIsStreaming(false); setStreamingText(''); }
    doPoll(taskId);
  }, [doPoll]);

  const stopPolling = useCallback(() => {
    if (poll.current) clearTimeout(poll.current);
    pending.current = null;
    stopTypewriter();
    if (mounted.current) setLoading(false);
  }, [stopTypewriter]);

  return { loading, setLoading, streamingText, isStreaming, startPolling, stopPolling };
}
