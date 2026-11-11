import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  ChevronLeft, Folder, FolderOpen, Inbox, Sparkles, Plus, Database, FileSpreadsheet,
  Upload, Download, Mic, Square, Send, Edit, Trash2, X, RefreshCw,
} from 'lucide-react';
import './TgMiniApp.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
const PAGE_SIZE = 25;

const AI_PHRASES = [
  'Думаю...', 'Применяю изменения...', 'Проверяю схему данных...',
  'Сверяюсь со структурой...', 'Почти готово...',
];

// ── Same legacy-fallback value getter as MyDataPage.jsx ───────────────────────
function getVal(rec, fieldName) {
  const v = rec.data?.[fieldName];
  if (v !== undefined && v !== null && v !== '') return v;
  return rec.data?.data?.[fieldName] ?? null;
}

// Same "name;;base64data" split as MyDataPage.jsx — split on the FIRST ";;"
function decodeFile(val) {
  if (!val || typeof val !== 'string') return null;
  const idx = val.indexOf(';;');
  if (idx === -1) return null;
  return { name: val.slice(0, idx), data: val.slice(idx + 2) };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Same rendering rules as MyDataPage.jsx's FieldValue, simplified (read-only, no zoom)
function FieldValue({ f, val }) {
  if (val == null || val === '') return <span className="tma-null">—</span>;
  const s = String(val);
  if (f.type === 'image' && (s.startsWith('data:image/') || s.startsWith('http'))) {
    return <img src={s} alt={f.label} className="tma-field-img" />;
  }
  if (f.type === 'file') {
    const decoded = decodeFile(s);
    if (decoded) {
      return <a href={decoded.data} download={decoded.name} className="tma-file-link">📎 {decoded.name}</a>;
    }
  }
  if (f.type === 'url' || (s.startsWith('http') && f.type !== 'text')) {
    return <a href={s} target="_blank" rel="noopener noreferrer" className="tma-url-link">{s}</a>;
  }
  if (f.type === 'boolean') return <>{s === 'true' || val === true ? '✅' : '❌'}</>;
  if (f.type === 'date') {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const hasTime = /T\d{2}:\d{2}/.test(s);
      const datePart = d.toLocaleDateString('ru-RU');
      const timePart = hasTime ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
      return <>{datePart}{timePart ? `, ${timePart}` : ''}</>;
    }
  }
  return <>{s}</>;
}

// ── Bottom sheet shell ─────────────────────────────────────────────────────────
function Sheet({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="tma-sheet-overlay" onClick={onClose}>
      <div className="tma-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="tma-sheet-handle" />
        <div className="tma-sheet-header">
          <h3>{title}</h3>
          <button className="tma-sheet-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="tma-sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`tma-toast tma-toast--${toast.type || 'success'}`}>{toast.message}</div>;
}

// ── A single field input for the add/edit record form ────────────────────────
function FieldInput({ f, value, onChange }) {
  const [busy, setBusy] = useState(false);

  if (f.type === 'boolean') {
    return (
      <label className="tma-checkbox-row">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{value ? 'Да' : 'Нет'}</span>
      </label>
    );
  }
  if (f.type === 'enum') {
    return (
      <select className="tma-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (f.type === 'date') {
    return <input className="tma-input" type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (f.type === 'number') {
    return <input className="tma-input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (f.type === 'image' || f.type === 'file') {
    return (
      <div>
        {value && f.type === 'image' && (String(value).startsWith('data:image') || String(value).startsWith('http')) && (
          <img src={value} alt="" className="tma-field-img" style={{ marginBottom: 8 }} />
        )}
        {value && f.type === 'file' && decodeFile(value) && (
          <div className="tma-record-line" style={{ marginBottom: 8 }}>📎 {decodeFile(value).name}</div>
        )}
        <input
          className="tma-input"
          type="file"
          accept={f.type === 'image' ? 'image/*' : undefined}
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              const dataUrl = await readFileAsDataUrl(file);
              onChange(f.type === 'file' ? `${file.name};;${dataUrl}` : dataUrl);
            } finally {
              setBusy(false);
            }
          }}
        />
        {busy && <span className="tma-hint">Загрузка...</span>}
      </div>
    );
  }
  return <input className="tma-input" type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function TgMiniApp() {
  // 'boot' | 'no-telegram' | 'error' | 'ready'
  const [phase, setPhase] = useState('boot');
  const [errorMsg, setErrorMsg] = useState('');
  const [token, setToken] = useState(null);

  const [view, setView] = useState('folders'); // 'folders' | 'records' | 'detail'
  const [schemas, setSchemas] = useState([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [selectedSchema, setSelectedSchema] = useState(null);
  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [pagination, setPagination] = useState(null);
  const [selectedRecord, setSelectedRecord] = useState(null);

  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // AI edit sheet
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatusText, setAiStatusText] = useState('');
  const [recording, setRecording] = useState(false);
  const [livePartial, setLivePartial] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const partialTimerRef = useRef(null);
  const isPressedRef = useRef(false);
  const isHoldingRef = useRef(false);
  const holdTimeoutRef = useRef(null);
  const pressStartRef = useRef(0);

  // Record/schema form sheets
  const [recordForm, setRecordForm] = useState(null); // { mode:'add'|'edit', data: {...} }
  const [schemaForm, setSchemaForm] = useState(null); // { mode:'add'|'edit', label, icon, fields:[...] }
  const [savingForm, setSavingForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // { type:'record'|'schema', target }

  // Sync sheets
  const [syncConfigs, setSyncConfigs] = useState([]);
  const [externalDbConfigs, setExternalDbConfigs] = useState([]);
  const [sheetsForm, setSheetsForm] = useState({ sourceUrl: '', direction: 'import' });
  const [sheetsFetchResult, setSheetsFetchResult] = useState(null);
  const [sheetsSelectedTab, setSheetsSelectedTab] = useState('');
  const [sheetsSchemaName, setSheetsSchemaName] = useState('');
  const [sheetsFetchLoading, setSheetsFetchLoading] = useState(false);
  const [sheetsFetchError, setSheetsFetchError] = useState('');
  const [externalDbForm, setExternalDbForm] = useState({ connectionString: '', dbType: 'mongodb' });
  const [extDbTestResult, setExtDbTestResult] = useState(null);
  const [extDbSelectedColl, setExtDbSelectedColl] = useState('');
  const [extDbSchemaName, setExtDbSchemaName] = useState('');
  const [extDbSyncEnabled, setExtDbSyncEnabled] = useState(true);
  const [extDbDirection, setExtDbDirection] = useState('import');
  const [extDbTestLoading, setExtDbTestLoading] = useState(false);
  const [extDbTestError, setExtDbTestError] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);

  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const authHeader = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const showToast = useCallback((message, type = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const handleAuthError = useCallback((err) => {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      setPhase('error');
      setErrorMsg('Сессия истекла. Закройте и снова откройте приложение.');
      return true;
    }
    return false;
  }, []);

  // ── Boot: exchange Telegram initData for a scoped session token ──────────────
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready?.();
    tg?.expand?.();
    const initData = tg?.initData;
    if (!initData) {
      setPhase('no-telegram');
      return;
    }
    axios.post(`${API_URL}/tgletbot/miniapp/session`, { initData })
      .then((res) => {
        if (res.data.success) {
          setToken(res.data.token);
          setPhase('ready');
        } else {
          setPhase('error');
          setErrorMsg('Сессия Telegram недействительна, перезапустите приложение.');
        }
      })
      .catch((err) => {
        setPhase('error');
        setErrorMsg(err.response?.status === 403
          ? 'Подписка неактивна.'
          : 'Сессия Telegram недействительна, перезапустите приложение.');
      });
  }, []);

  // ── Folders ────────────────────────────────────────────────────────────────
  const loadSchemas = useCallback(() => {
    setSchemasLoading(true);
    return axios.get(`${API_URL}/data/schemas`, { headers: authHeader() })
      .then((res) => setSchemas(res.data.schemas || []))
      .catch((err) => { if (!handleAuthError(err)) showToast('Не удалось загрузить данные.', 'error'); })
      .finally(() => setSchemasLoading(false));
  }, [authHeader, handleAuthError, showToast]);

  useEffect(() => {
    if (phase !== 'ready' || !token) return;
    loadSchemas();
  }, [phase, token, loadSchemas]);

  const loadRecords = useCallback((schema, page, append) => {
    setRecordsLoading(true);
    return axios.get(`${API_URL}/data/records/${schema.name}`, {
      headers: authHeader(),
      params: { limit: PAGE_SIZE, page },
    })
      .then((res) => {
        setRecords((prev) => (append ? [...prev, ...(res.data.records || [])] : (res.data.records || [])));
        setPagination(res.data.pagination || null);
      })
      .catch((err) => { if (!handleAuthError(err)) showToast('Не удалось загрузить записи.', 'error'); })
      .finally(() => setRecordsLoading(false));
  }, [authHeader, handleAuthError, showToast]);

  const openSchema = (schema) => {
    setSelectedSchema(schema);
    setRecords([]);
    setPagination(null);
    setView('records');
    loadRecords(schema, 1, false);
  };

  const openRecord = (rec) => {
    setSelectedRecord(rec);
    setView('detail');
  };

  const goBack = () => {
    if (sheet) { setSheet(null); return; }
    if (view === 'detail') { setSelectedRecord(null); setView('records'); }
    else if (view === 'records') { setSelectedSchema(null); setView('folders'); }
  };

  // ── Native Telegram back button ───────────────────────────────────────────────
  useEffect(() => {
    const btn = window.Telegram?.WebApp?.BackButton;
    if (!btn) return;
    if (view === 'folders' && !sheet) { btn.hide(); return; }
    btn.show();
    btn.onClick(goBack);
    return () => btn.offClick(goBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sheet]);

  const closeApp = () => window.Telegram?.WebApp?.close?.();

  // ── AI prompt edit ─────────────────────────────────────────────────────────────
  const refreshAfterEdit = () => {
    if (view === 'folders') loadSchemas();
    else if (view === 'records' && selectedSchema) loadRecords(selectedSchema, 1, false);
  };

  const submitAiPrompt = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    setAiBusy(true);
    let phraseIdx = 0;
    setAiStatusText(AI_PHRASES[0]);
    try {
      const res = await axios.post(`${API_URL}/analyze`, {
        prompt, context: { source: 'tgletbot_miniapp_edit' }, platform: 'tgletbot_miniapp',
      }, { headers: authHeader() });
      const taskId = res.data.taskId;
      const deadline = Date.now() + 100000;
      let lastPartial = '';
      let lastChangeAt = Date.now();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 900));
        const r2 = await axios.get(`${API_URL}/result/${taskId}`, { headers: authHeader() });
        const now = Date.now();
        if (r2.data.partialResult && r2.data.partialResult !== lastPartial) {
          lastPartial = r2.data.partialResult;
          lastChangeAt = now;
          setAiStatusText(lastPartial.slice(0, 80));
        } else if (now - lastChangeAt > 2200) {
          phraseIdx = (phraseIdx + 1) % AI_PHRASES.length;
          lastChangeAt = now;
          setAiStatusText(AI_PHRASES[phraseIdx]);
        }
        if (r2.data.status === 'completed') {
          setAiPrompt('');
          setSheet(null);
          showToast(r2.data.result ? r2.data.result.slice(0, 120) : 'Изменения сохранены ✅');
          refreshAfterEdit();
          return;
        }
        if (r2.data.status === 'error') {
          showToast('Прошу прощения, я сломалась. Сигнал разработчику уже отправлен. Можно написать @SiberiManager.', 'error');
          return;
        }
      }
      showToast('AI долго отвечает — попробуй ещё раз чуть позже.', 'error');
    } catch (err) {
      if (!handleAuthError(err)) showToast('Прошу прощения, я сломалась. Сигнал разработчику уже отправлен. Можно написать @SiberiManager.', 'error');
    } finally {
      setAiBusy(false);
      setAiStatusText('');
    }
  };

  // ── Voice input — hands-free with auto-stop on silence, or press-and-hold ────
  // Tap once: keeps recording with no need to hold; auto-finalizes after ~2s of
  // silence, with a live (re-transcribed every ~2.5s) preview while it runs.
  // Press AND HOLD: silence auto-stop is suppressed — only releasing stops it.
  // Tapping the mic again after a segment already finished appends a new line
  // instead of overwriting whatever was already typed/dictated.
  const HOLD_THRESHOLD_MS = 350;
  const SILENCE_MS = 2000;
  const SILENCE_LEVEL = 6; // empirical: average |sample-128| deviation below this = silence

  const transcribeAccumulated = async () => {
    if (!audioChunksRef.current.length) return '';
    const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const dataUrl = await readFileAsDataUrl(blob);
    try {
      const res = await axios.post(`${API_URL}/tgletbot/miniapp/transcribe`, { audio: dataUrl }, { headers: authHeader() });
      return res.data.text || '';
    } catch {
      return '';
    }
  };

  const finalizeRecording = useCallback(async () => {
    if (!mediaRecorderRef.current && !recording) return;
    clearInterval(silenceTimerRef.current);
    clearInterval(partialTimerRef.current);
    silenceTimerRef.current = null;
    partialTimerRef.current = null;

    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    isHoldingRef.current = false;
    setRecording(false);

    await new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    });

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }

    setAiBusy(true);
    setAiStatusText('Распознаю голос...');
    const text = await transcribeAccumulated();
    audioChunksRef.current = [];
    setLivePartial('');
    setAiBusy(false);
    setAiStatusText('');

    if (text) {
      setAiPrompt((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
    } else {
      showToast('Не разобрала голос, попробуй ещё раз.', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, authHeader, showToast]);

  const beginRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];
      setLivePartial('');

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorderRef.current = recorder;
      recorder.start(1000); // flush a chunk every second so accumulated audio stays fresh

      // Silence detection (best-effort — recording still works without it, just
      // without auto-stop; the user can always finish via press-and-hold instead)
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        const data = new Uint8Array(analyser.frequencyBinCount);
        let silenceStart = null;
        silenceTimerRef.current = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
          const avg = sum / data.length;
          if (avg < SILENCE_LEVEL) {
            if (silenceStart == null) silenceStart = Date.now();
            else if (!isHoldingRef.current && Date.now() - silenceStart > SILENCE_MS) {
              finalizeRecording();
            }
          } else {
            silenceStart = null;
          }
        }, 200);
      } catch { /* no AudioContext available — silence auto-stop just won't fire */ }

      // Live preview — re-transcribe everything captured so far every ~2.5s
      partialTimerRef.current = setInterval(async () => {
        const text = await transcribeAccumulated();
        if (text) setLivePartial(text);
      }, 2500);

      setRecording(true);
    } catch {
      showToast('Нет доступа к микрофону.', 'error');
    }
  };

  const onMicPressStart = (e) => {
    e.preventDefault();
    if (recording) {
      // already recording hands-free from an earlier tap — this press means "stop now"
      finalizeRecording();
      return;
    }
    isPressedRef.current = true;
    pressStartRef.current = Date.now();
    isHoldingRef.current = false;
    beginRecording();
    holdTimeoutRef.current = setTimeout(() => {
      if (isPressedRef.current) isHoldingRef.current = true;
    }, HOLD_THRESHOLD_MS);
  };

  const onMicPressEnd = (e) => {
    if (!isPressedRef.current) return;
    isPressedRef.current = false;
    e.preventDefault?.();
    clearTimeout(holdTimeoutRef.current);
    const wasHold = Date.now() - pressStartRef.current >= HOLD_THRESHOLD_MS;
    if (wasHold) finalizeRecording(); // release after a hold — stop immediately
    // a quick tap leaves recording running hands-free; silence auto-stop finishes it
  };

  // ── Record CRUD ────────────────────────────────────────────────────────────────
  const openAddRecord = () => {
    const blank = {};
    (selectedSchema?.fields || []).forEach((f) => { blank[f.name] = f.type === 'boolean' ? false : ''; });
    setRecordForm({ mode: 'add', data: blank });
    setSheet('record-form');
  };

  const openEditRecord = (rec) => {
    const data = {};
    (selectedSchema?.fields || []).forEach((f) => { data[f.name] = getVal(rec, f.name) ?? (f.type === 'boolean' ? false : ''); });
    setRecordForm({ mode: 'edit', data, recordId: rec._id });
    setSheet('record-form');
  };

  const saveRecordForm = async () => {
    if (!recordForm || !selectedSchema) return;
    setSavingForm(true);
    try {
      if (recordForm.mode === 'add') {
        await axios.post(`${API_URL}/data/records/${selectedSchema.name}`, { data: recordForm.data }, { headers: authHeader() });
        showToast('Запись добавлена ✅');
      } else {
        await axios.put(`${API_URL}/data/records/${selectedSchema.name}/${recordForm.recordId}`, { data: recordForm.data }, { headers: authHeader() });
        showToast('Изменения сохранены ✅');
      }
      setSheet(null);
      setRecordForm(null);
      loadRecords(selectedSchema, 1, false);
      if (view === 'detail') setView('records');
    } catch (err) {
      if (!handleAuthError(err)) showToast('Не удалось сохранить запись.', 'error');
    } finally {
      setSavingForm(false);
    }
  };

  // ── Schema CRUD ──────────────────────────────────────────────────────────────
  const openAddSchema = () => {
    setSchemaForm({ mode: 'add', label: '', fields: [{ name: 'name', label: 'Название', type: 'text', required: true }] });
    setSheet('schema-form');
  };

  const openEditSchema = (schema) => {
    setSchemaForm({ mode: 'edit', name: schema.name, label: schema.label || schema.name, fields: schema.fields.map((f) => ({ ...f })) });
    setSheet('schema-form');
  };

  const addSchemaField = () => {
    setSchemaForm((sf) => ({ ...sf, fields: [...sf.fields, { name: '', label: '', type: 'text', required: false }] }));
  };
  const updateSchemaField = (idx, patch) => {
    setSchemaForm((sf) => ({ ...sf, fields: sf.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) }));
  };
  const removeSchemaField = (idx) => {
    setSchemaForm((sf) => ({ ...sf, fields: sf.fields.filter((_, i) => i !== idx) }));
  };

  const saveSchemaForm = async () => {
    if (!schemaForm) return;
    const cleanFields = schemaForm.fields.filter((f) => f.name.trim());
    if (!cleanFields.length) { showToast('Добавь хотя бы одно поле.', 'error'); return; }
    setSavingForm(true);
    try {
      if (schemaForm.mode === 'add') {
        const name = (schemaForm.label || 'schema').toLowerCase().replace(/[^a-zа-я0-9_]+/gi, '_').slice(0, 40) || 'schema';
        await axios.post(`${API_URL}/data/schemas`, {
          name, label: schemaForm.label || name, fields: cleanFields,
        }, { headers: authHeader() });
        showToast('Схема создана ✅');
      } else {
        await axios.put(`${API_URL}/data/schemas/${schemaForm.name}`, {
          label: schemaForm.label, fields: cleanFields,
        }, { headers: authHeader() });
        showToast('Схема обновлена ✅');
      }
      setSheet(null);
      setSchemaForm(null);
      loadSchemas();
    } catch (err) {
      if (!handleAuthError(err)) showToast('Не удалось сохранить схему.', 'error');
    } finally {
      setSavingForm(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────────
  const performDelete = async () => {
    if (!confirmDelete) return;
    setSavingForm(true);
    try {
      if (confirmDelete.type === 'record') {
        await axios.delete(`${API_URL}/data/records/${selectedSchema.name}/${confirmDelete.target._id}`, { headers: authHeader() });
        showToast('Запись удалена');
        loadRecords(selectedSchema, 1, false);
        setView('records');
      } else {
        await axios.delete(`${API_URL}/data/schemas/${confirmDelete.target.name}`, { headers: authHeader() });
        showToast('Схема удалена');
        loadSchemas();
        setView('folders');
      }
      setConfirmDelete(null);
      setSheet(null);
    } catch (err) {
      if (!handleAuthError(err)) showToast('Не удалось удалить.', 'error');
    } finally {
      setSavingForm(false);
    }
  };

  // ── Sync (Google Sheets / external DB) ──────────────────────────────────────
  const loadSyncConfigs = async () => {
    try {
      const [sheetsRes, dbRes] = await Promise.all([
        axios.get(`${API_URL}/integrations/sync/list`, { headers: authHeader() }).catch(() => ({ data: { configs: [] } })),
        axios.get(`${API_URL}/integrations/external-db/sync/list`, { headers: authHeader() }).catch(() => ({ data: { configs: [] } })),
      ]);
      // /integrations/sync/list returns ALL sync configs (sheets + external DB mixed) —
      // filter to just Sheets here; the external-db endpoint already filters server-side.
      setSyncConfigs((sheetsRes.data.configs || []).filter((c) => c.sourceType !== 'external_db'));
      setExternalDbConfigs(dbRes.data.configs || []);
    } catch { /* non-fatal */ }
  };

  const openSyncSheet = (which) => {
    setSheetsForm({ sourceUrl: '', direction: 'import' });
    setSheetsFetchResult(null);
    setSheetsSelectedTab('');
    setSheetsSchemaName('');
    setSheetsFetchError('');
    setExternalDbForm({ connectionString: '', dbType: 'mongodb' });
    setExtDbTestResult(null);
    setExtDbSelectedColl('');
    setExtDbSchemaName('');
    setExtDbSyncEnabled(true);
    setExtDbDirection('import');
    setExtDbTestError('');
    loadSyncConfigs();
    setSheet(which);
  };

  // Mirrors the website's flow exactly: paste a link, "Просмотр" auto-detects
  // tabs/columns — no need to know a schema name up front, one gets suggested.
  const fetchSheetsPreview = async (tab) => {
    if (!sheetsForm.sourceUrl.trim()) return;
    setSheetsFetchLoading(true);
    setSheetsFetchError('');
    try {
      const res = await axios.post(`${API_URL}/integrations/sheets/fetch`, {
        url: sheetsForm.sourceUrl.trim(), sheetName: tab || null,
      }, { headers: authHeader() });
      setSheetsFetchResult(res.data);
      const chosenTab = tab || res.data.tabs?.[0] || '';
      setSheetsSelectedTab(chosenTab);
      if (!sheetsSchemaName) {
        const base = (chosenTab || 'sheet').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '') || 'sheet';
        setSheetsSchemaName(`${base}_${Date.now().toString(36).slice(-4)}`);
      }
    } catch (err) {
      if (!handleAuthError(err)) setSheetsFetchError(err.response?.data?.error || 'Не удалось открыть таблицу — проверь ссылку и доступ.');
    } finally {
      setSheetsFetchLoading(false);
    }
  };

  const saveSheetsSync = async () => {
    if (!sheetsForm.sourceUrl.trim() || !sheetsSchemaName.trim()) { showToast('Укажи ссылку на таблицу.', 'error'); return; }
    setSyncBusy(true);
    try {
      await axios.post(`${API_URL}/integrations/sync/save`, {
        schemaName: sheetsSchemaName.trim(),
        sourceUrl: sheetsForm.sourceUrl.trim(),
        sheetName: sheetsSelectedTab || null,
        direction: sheetsForm.direction,
      }, { headers: authHeader() });
      showToast('Google Sheets подключён ✅');
      setSheet(null);
      loadSyncConfigs();
      loadSchemas();
    } catch (err) {
      if (!handleAuthError(err)) showToast(err.response?.data?.error || 'Не удалось подключить таблицу.', 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  // Mirrors the website's ExternalDbModal flow: type + connection string first,
  // "Подключиться" tests it and returns the REAL collection/table list — no
  // blindly typing a collection name that might not even exist.
  const testExternalDb = async () => {
    if (!externalDbForm.connectionString.trim()) return;
    setExtDbTestLoading(true);
    setExtDbTestError('');
    try {
      const res = await axios.post(`${API_URL}/integrations/external-db/test`, {
        connectionString: externalDbForm.connectionString.trim(),
        type: externalDbForm.dbType,
      }, { headers: authHeader() });
      setExtDbTestResult(res.data);
      const items = res.data.collections || res.data.tables || [];
      const first = items[0] || '';
      setExtDbSelectedColl(first);
      if (!extDbSchemaName && first) {
        setExtDbSchemaName(first.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
      }
    } catch (err) {
      if (!handleAuthError(err)) setExtDbTestError(err.response?.data?.error || 'Не удалось подключиться — проверь строку подключения.');
    } finally {
      setExtDbTestLoading(false);
    }
  };

  const saveExternalDbSync = async () => {
    if (!extDbSelectedColl || !extDbSchemaName.trim()) {
      showToast('Выбери коллекцию/таблицу и укажи имя схемы.', 'error');
      return;
    }
    setSyncBusy(true);
    try {
      const payload = {
        connectionString: externalDbForm.connectionString.trim(),
        type: externalDbForm.dbType,
        dbType: externalDbForm.dbType,
        collection: extDbSelectedColl,
        schemaName: extDbSchemaName.trim(),
        direction: extDbSyncEnabled ? extDbDirection : 'import',
      };
      if (extDbSyncEnabled) {
        await axios.post(`${API_URL}/integrations/external-db/sync/save`, payload, { headers: authHeader() });
      } else {
        await axios.post(`${API_URL}/integrations/external-db/import`, payload, { headers: authHeader() });
      }
      showToast(extDbSyncEnabled ? 'Синхронизация включена ✅' : 'Импортировано ✅');
      setSheet(null);
      loadSyncConfigs();
      loadSchemas();
    } catch (err) {
      if (!handleAuthError(err)) showToast(err.response?.data?.error || 'Не удалось подключиться к базе.', 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  const triggerSync = async (kind, id) => {
    setSyncBusy(true);
    try {
      const path = kind === 'sheets' ? `/integrations/sync/trigger/${id}` : `/integrations/external-db/sync/trigger/${id}`;
      await axios.post(`${API_URL}${path}`, {}, { headers: authHeader() });
      showToast('Синхронизация запущена ✅');
      loadSchemas();
    } catch (err) {
      if (!handleAuthError(err)) showToast('Не удалось синхронизировать.', 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  const deleteSync = async (kind, id) => {
    setSyncBusy(true);
    try {
      const path = kind === 'sheets' ? `/integrations/sync/${id}` : `/integrations/external-db/sync/${id}`;
      await axios.delete(`${API_URL}${path}`, { headers: authHeader() });
      showToast('Синхронизация отключена');
      loadSyncConfigs();
    } catch {
      showToast('Не удалось отключить синхронизацию.', 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  // ── Import / export ──────────────────────────────────────────────────────────
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await axios.post(`${API_URL}/data/import`, form, {
        headers: { ...authHeader(), 'Content-Type': 'multipart/form-data' },
      });
      const s = res.data.summary || {};
      showToast(`Импортировано: ${s.importedSchemas || 0} схем, ${s.importedRecords || 0} записей ✅`);
      loadSchemas();
      setSheet(null);
    } catch (err) {
      if (!handleAuthError(err)) showToast('Не удалось импортировать файл.', 'error');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExport = async (format) => {
    try {
      // CSV is inherently single-table — export the currently open schema if there
      // is one, otherwise the server defaults to the first schema it finds.
      const params = { format };
      if (format === 'csv' && selectedSchema?.name) params.schema = selectedSchema.name;
      const res = await axios.get(`${API_URL}/data/export`, {
        headers: authHeader(), params, responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `siberi-data.${format === 'xlsx' ? 'xlsx' : format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Экспорт готов ✅');
    } catch {
      showToast('Не удалось экспортировать (попробуй открыть «Мои данные» на сайте).', 'error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  if (phase === 'boot') {
    return <div className="tma-wrap tma-center"><div className="tma-spinner" /></div>;
  }

  if (phase === 'no-telegram') {
    return (
      <div className="tma-wrap tma-center">
        <div className="tma-empty">
          <Folder size={40} className="tma-empty-icon" />
          <h2>Откройте через Telegram</h2>
          <p>Это мини-приложение работает только внутри Telegram — откройте его из бота @AI_ConstructorBot.</p>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="tma-wrap tma-center">
        <div className="tma-empty">
          <Folder size={40} className="tma-empty-icon" />
          <h2>Не получилось</h2>
          <p>{errorMsg}</p>
          <button className="tma-btn" onClick={closeApp}>Закрыть</button>
        </div>
      </div>
    );
  }

  // Plain "first 3 fields in schema order" hid the date on a bookings-style
  // schema (client_name, client_phone, master_id were first; date was 5th) —
  // confirmed live: a saved booking was unrecognizable in the list because the
  // one field that actually identifies WHICH booking it is never showed up.
  // Date fields are almost always the identifying detail for record-style
  // data, so they're guaranteed a preview slot; "_"-prefixed fields are
  // system-internal (e.g. _tg_chat_id) and never meaningful to show here.
  const visibleSchemaFields = (selectedSchema?.fields || []).filter((f) => f.type !== 'image' && f.type !== 'file' && !f.name.startsWith('_'));
  const previewFields = [
    ...visibleSchemaFields.filter((f) => f.type === 'date'),
    ...visibleSchemaFields.filter((f) => f.type !== 'date'),
  ].slice(0, 3);

  return (
    <div className="tma-wrap">
      <Toast toast={toast} />

      <header className="tma-header">
        {view !== 'folders' && (
          <button className="tma-back" onClick={goBack}><ChevronLeft size={20} /></button>
        )}
        <h1 className="tma-title">
          {view === 'folders' && 'Мои данные'}
          {view === 'records' && (selectedSchema?.label || selectedSchema?.name)}
          {view === 'detail' && 'Запись'}
        </h1>
        {view === 'records' && (
          <button className="tma-icon-btn" onClick={() => openEditSchema(selectedSchema)} title="Изменить схему">
            <Edit size={17} />
          </button>
        )}
        {view === 'detail' && selectedRecord && (
          <div className="tma-header-actions">
            <button className="tma-icon-btn" onClick={() => openEditRecord(selectedRecord)} title="Редактировать"><Edit size={17} /></button>
            <button className="tma-icon-btn tma-icon-btn--danger" onClick={() => { setConfirmDelete({ type: 'record', target: selectedRecord }); setSheet('confirm-delete'); }} title="Удалить"><Trash2 size={17} /></button>
          </div>
        )}
      </header>

      <main className="tma-main">
        {view === 'folders' && (
          schemasLoading ? (
            <div className="tma-center"><div className="tma-spinner" /></div>
          ) : schemas.length === 0 ? (
            <div className="tma-empty">
              <Inbox size={40} className="tma-empty-icon" />
              <h2>Пока нет данных</h2>
              <p>Создайте схемы данных в чате с ботом — просто опишите, что нужно хранить, или нажмите «+» ниже.</p>
            </div>
          ) : (
            <div className="tma-folders">
              {schemas.map((s) => (
                <button key={s._id || s.name} className="tma-folder" onClick={() => openSchema(s)}>
                  <span className="tma-folder-icon" style={{ background: `${s.color || '#3b82f6'}1f`, color: s.color || '#3b82f6' }}>
                    <FolderOpen size={20} />
                  </span>
                  <span className="tma-folder-label">{s.label || s.name}</span>
                  <ChevronLeft size={16} className="tma-folder-arrow" />
                </button>
              ))}
            </div>
          )
        )}

        {view === 'records' && (
          recordsLoading && records.length === 0 ? (
            <div className="tma-center"><div className="tma-spinner" /></div>
          ) : records.length === 0 ? (
            <div className="tma-empty">
              <Inbox size={40} className="tma-empty-icon" />
              <h2>Пусто</h2>
              <p>В этой папке пока нет записей. Добавьте первую через «+» ниже.</p>
            </div>
          ) : (
            <>
              <div className="tma-records">
                {records.map((rec) => (
                  <button key={rec._id} className="tma-record" onClick={() => openRecord(rec)}>
                    {previewFields.map((f) => (
                      <div key={f.name} className="tma-record-line">
                        <span className="tma-record-label">{f.label}:</span>{' '}
                        <span className="tma-record-value"><FieldValue f={f} val={getVal(rec, f.name)} /></span>
                      </div>
                    ))}
                  </button>
                ))}
              </div>
              {pagination && pagination.page < pagination.pages && (
                <button
                  className="tma-btn tma-loadmore"
                  disabled={recordsLoading}
                  onClick={() => loadRecords(selectedSchema, pagination.page + 1, true)}
                >
                  {recordsLoading ? 'Загрузка...' : 'Показать ещё'}
                </button>
              )}
            </>
          )
        )}

        {view === 'detail' && selectedRecord && (
          <div className="tma-detail">
            {(selectedSchema?.fields || []).map((f) => (
              <div key={f.name} className="tma-detail-field">
                <span className="tma-detail-label">{f.label}</span>
                <div className="tma-detail-value"><FieldValue f={f} val={getVal(selectedRecord, f.name)} /></div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* ── Bottom action bar ──────────────────────────────────────────────────── */}
      {!sheet && (
        <div className="tma-actionbar">
          <button className="tma-fab tma-fab--ai" onClick={() => setSheet('ai-edit')}>
            <Sparkles size={18} /> Изменить промтом
          </button>
          <button className="tma-fab tma-fab--menu" onClick={() => setSheet('menu')}>
            <Plus size={20} />
          </button>
        </div>
      )}

      {/* ── Main action menu sheet ─────────────────────────────────────────────── */}
      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title="Действия">
        <div className="tma-menu-grid">
          {view === 'folders' && (
            <button className="tma-menu-item" onClick={openAddSchema}>
              <Plus size={20} /> Новая схема
            </button>
          )}
          {view === 'records' && (
            <button className="tma-menu-item" onClick={openAddRecord}>
              <Plus size={20} /> Новая запись
            </button>
          )}
          <button className="tma-menu-item" onClick={() => openSyncSheet('sync-sheets')}>
            <FileSpreadsheet size={20} /> Google Sheets
          </button>
          <button className="tma-menu-item" onClick={() => openSyncSheet('sync-externaldb')}>
            <Database size={20} /> Внешняя БД
          </button>
          <button className="tma-menu-item" onClick={() => setSheet('import-export')}>
            <Upload size={20} /> Импорт / экспорт
          </button>
        </div>
      </Sheet>

      {/* ── AI edit sheet ──────────────────────────────────────────────────────── */}
      <Sheet open={sheet === 'ai-edit'} onClose={() => !aiBusy && setSheet(null)} title="Изменить промтом">
        <p className="tma-hint">Опиши, что изменить в данных — например «добавь поле скидка в схему услуги» или «удали все старые заказы».</p>
        {aiBusy ? (
          <div className="tma-ai-status"><div className="tma-spinner" /><span>{aiStatusText}</span></div>
        ) : (
          <>
            <textarea
              className="tma-textarea"
              rows={4}
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Что изменить?"
            />
            {recording && (
              <div className="tma-live-partial">🎙 {livePartial || 'Слушаю...'}</div>
            )}
            <div className="tma-ai-actions">
              <button
                className={`tma-mic-btn ${recording ? 'tma-mic-btn--rec' : ''}`}
                onPointerDown={onMicPressStart}
                onPointerUp={onMicPressEnd}
                onPointerLeave={onMicPressEnd}
                onPointerCancel={onMicPressEnd}
                title="Тапни — запись без удержания, сама остановится через 2с тишины. Удерживай — пока не отпустишь."
              >
                {recording ? <Square size={18} /> : <Mic size={18} />}
              </button>
              <button className="tma-btn tma-btn--grow" disabled={!aiPrompt.trim()} onClick={submitAiPrompt}>
                <Send size={16} /> Отправить
              </button>
            </div>
            <p className="tma-hint tma-hint--mic">Тапни на 🎤 — запись остановится сама через 2 сек тишины. Зажми и держи — пока не отпустишь палец. Тапни ещё раз — добавит новую строку, не удаляя прошлую.</p>
          </>
        )}
      </Sheet>

      {/* ── Record add/edit sheet ──────────────────────────────────────────────── */}
      <Sheet open={sheet === 'record-form'} onClose={() => setSheet(null)} title={recordForm?.mode === 'add' ? 'Новая запись' : 'Редактировать запись'}>
        {recordForm && (
          <>
            {(selectedSchema?.fields || []).map((f) => (
              <div key={f.name} className="tma-form-row">
                <label className="tma-form-label">{f.label}{f.required ? ' *' : ''}</label>
                <FieldInput f={f} value={recordForm.data[f.name]} onChange={(v) => setRecordForm((rf) => ({ ...rf, data: { ...rf.data, [f.name]: v } }))} />
              </div>
            ))}
            <button className="tma-btn tma-btn--full" disabled={savingForm} onClick={saveRecordForm}>
              {savingForm ? 'Сохраняю...' : 'Сохранить'}
            </button>
          </>
        )}
      </Sheet>

      {/* ── Schema add/edit sheet ──────────────────────────────────────────────── */}
      <Sheet open={sheet === 'schema-form'} onClose={() => setSheet(null)} title={schemaForm?.mode === 'add' ? 'Новая схема' : 'Изменить схему'}>
        {schemaForm && (
          <>
            <div className="tma-form-row">
              <label className="tma-form-label">Название</label>
              <input className="tma-input" value={schemaForm.label} onChange={(e) => setSchemaForm((sf) => ({ ...sf, label: e.target.value }))} />
            </div>
            <div className="tma-form-label" style={{ marginTop: 12 }}>Поля</div>
            {schemaForm.fields.map((f, idx) => (
              <div key={idx} className="tma-field-block">
                <div className="tma-field-row">
                  <input className="tma-input tma-input--sm" placeholder="имя_поля" value={f.name} onChange={(e) => updateSchemaField(idx, { name: e.target.value })} />
                  <input className="tma-input tma-input--sm" placeholder="Подпись" value={f.label} onChange={(e) => updateSchemaField(idx, { label: e.target.value })} />
                  <select className="tma-input tma-input--sm" value={f.type} onChange={(e) => updateSchemaField(idx, { type: e.target.value })}>
                    {['text', 'number', 'date', 'boolean', 'url', 'enum', 'image', 'file'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button className="tma-icon-btn tma-icon-btn--danger" onClick={() => removeSchemaField(idx)}><X size={16} /></button>
                </div>
                <label className="tma-field-required">
                  <input type="checkbox" checked={!!f.required} onChange={(e) => updateSchemaField(idx, { required: e.target.checked })} />
                  Обязательное поле — бот не закроет запись без него
                </label>
              </div>
            ))}
            <button className="tma-btn tma-btn--ghost" onClick={addSchemaField}><Plus size={14} /> Добавить поле</button>
            <button className="tma-btn tma-btn--full" disabled={savingForm} onClick={saveSchemaForm} style={{ marginTop: 14 }}>
              {savingForm ? 'Сохраняю...' : 'Сохранить схему'}
            </button>
            {schemaForm.mode === 'edit' && (
              <button
                className="tma-btn tma-btn--full tma-btn--danger"
                onClick={() => { setConfirmDelete({ type: 'schema', target: { name: schemaForm.name } }); setSheet('confirm-delete'); }}
              >
                <Trash2 size={15} /> Удалить схему целиком
              </button>
            )}
          </>
        )}
      </Sheet>

      {/* ── Confirm delete sheet ───────────────────────────────────────────────── */}
      <Sheet open={sheet === 'confirm-delete'} onClose={() => setSheet(null)} title="Удалить?">
        <p className="tma-hint">
          {confirmDelete?.type === 'record' ? 'Запись будет удалена без возможности восстановить.' : 'Схема и ВСЕ её записи будут удалены без возможности восстановить.'}
        </p>
        <div className="tma-ai-actions">
          <button className="tma-btn tma-btn--grow" onClick={() => setSheet(confirmDelete?.type === 'schema' ? 'schema-form' : null)}>Отменить</button>
          <button className="tma-btn tma-btn--grow tma-btn--danger" disabled={savingForm} onClick={performDelete}>
            {savingForm ? 'Удаляю...' : 'Удалить'}
          </button>
        </div>
      </Sheet>

      {/* ── Google Sheets sync sheet ───────────────────────────────────────────── */}
      <Sheet open={sheet === 'sync-sheets'} onClose={() => setSheet(null)} title="Google Sheets">
        <p className="tma-hint">Вставь ссылку на таблицу — остальное определится само.</p>
        <div className="tma-form-row">
          <div className="tma-url-row">
            <input
              className="tma-input"
              type="url"
              value={sheetsForm.sourceUrl}
              onChange={(e) => setSheetsForm((f) => ({ ...f, sourceUrl: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') fetchSheetsPreview(); }}
              placeholder="https://docs.google.com/spreadsheets/d/..."
            />
            <button className="tma-btn" disabled={sheetsFetchLoading || !sheetsForm.sourceUrl.trim()} onClick={() => fetchSheetsPreview()}>
              {sheetsFetchLoading ? '...' : 'Просмотр'}
            </button>
          </div>
        </div>

        {sheetsFetchError && <p className="tma-error-text">{sheetsFetchError}</p>}

        {sheetsFetchResult && (
          <>
            {sheetsFetchResult.tabs?.length > 1 && (
              <div className="tma-tabs-row">
                {sheetsFetchResult.tabs.map((t) => (
                  <button
                    key={t}
                    className={`tma-tab-chip ${sheetsSelectedTab === t ? 'tma-tab-chip--active' : ''}`}
                    onClick={() => fetchSheetsPreview(t)}
                    disabled={sheetsFetchLoading}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            <p className="tma-hint">
              {sheetsFetchResult.empty
                ? 'Лист пустой или без заголовков.'
                : `${sheetsFetchResult.total} строк · колонки: ${(sheetsFetchResult.headers || []).join(', ')}`}
            </p>

            <div className="tma-form-row">
              <label className="tma-form-label">Название схемы</label>
              <input className="tma-input" value={sheetsSchemaName} onChange={(e) => setSheetsSchemaName(e.target.value)} />
            </div>

            <div className="tma-form-label">Направление синхронизации</div>
            <div className="tma-direction-toggle">
              <button
                className={`tma-direction-opt ${sheetsForm.direction === 'import' ? 'tma-direction-opt--active' : ''}`}
                onClick={() => setSheetsForm((f) => ({ ...f, direction: 'import' }))}
              >
                <span className="tma-direction-icon">⬇️</span>
                <span className="tma-direction-label">Только получать</span>
              </button>
              <button
                className={`tma-direction-opt ${sheetsForm.direction === 'bidirectional' ? 'tma-direction-opt--active' : ''}`}
                onClick={() => setSheetsForm((f) => ({ ...f, direction: 'bidirectional' }))}
              >
                <span className="tma-direction-icon">↔️</span>
                <span className="tma-direction-label">Получать и возвращать</span>
              </button>
            </div>
            <p className="tma-hint">
              {sheetsForm.direction === 'import'
                ? 'Изменения в таблице подтянутся к нам сами. А вот то, что изменишь здесь — через бота, AI или вручную — в таблицу обратно НЕ попадёт.'
                : 'Работает в обе стороны: изменения в таблице подтянутся к нам, а то, что изменишь здесь — через бота, AI или вручную — попадёт обратно в таблицу.'}
            </p>

            <button className="tma-btn tma-btn--full" disabled={syncBusy || !sheetsSchemaName.trim()} onClick={saveSheetsSync}>
              {syncBusy ? 'Подключаю...' : 'Подключить'}
            </button>
          </>
        )}

        {syncConfigs.length > 0 && (
          <>
            <div className="tma-form-label" style={{ marginTop: 16 }}>Подключённые таблицы</div>
            {syncConfigs.map((c) => (
              <div key={c._id} className="tma-sync-row">
                <span>{c.schemaName} ({c.direction === 'bidirectional' ? '↔' : '→'})</span>
                <div className="tma-sync-row-actions">
                  <button className="tma-icon-btn" onClick={() => triggerSync('sheets', c._id)}><RefreshCw size={15} /></button>
                  <button className="tma-icon-btn tma-icon-btn--danger" onClick={() => deleteSync('sheets', c._id)}><X size={15} /></button>
                </div>
              </div>
            ))}
          </>
        )}
      </Sheet>

      {/* ── External DB sync sheet ─────────────────────────────────────────────── */}
      <Sheet open={sheet === 'sync-externaldb'} onClose={() => setSheet(null)} title="Внешняя база данных">
        <p className="tma-hint">Укажи тип базы и строку подключения — дальше покажем твои коллекции/таблицы для выбора.</p>

        <div className="tma-direction-toggle">
          <button
            className={`tma-direction-opt ${externalDbForm.dbType === 'mongodb' ? 'tma-direction-opt--active' : ''}`}
            onClick={() => { setExternalDbForm((f) => ({ ...f, dbType: 'mongodb' })); setExtDbTestResult(null); }}
          >
            <span className="tma-direction-label">MongoDB</span>
          </button>
          <button
            className={`tma-direction-opt ${externalDbForm.dbType === 'postgresql' ? 'tma-direction-opt--active' : ''}`}
            onClick={() => { setExternalDbForm((f) => ({ ...f, dbType: 'postgresql' })); setExtDbTestResult(null); }}
          >
            <span className="tma-direction-label">PostgreSQL</span>
          </button>
        </div>

        <div className="tma-form-row">
          <label className="tma-form-label">Строка подключения</label>
          <input
            className="tma-input"
            value={externalDbForm.connectionString}
            onChange={(e) => { setExternalDbForm((f) => ({ ...f, connectionString: e.target.value })); setExtDbTestResult(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') testExternalDb(); }}
            placeholder={externalDbForm.dbType === 'mongodb' ? 'mongodb+srv://user:pass@cluster.mongodb.net/db' : 'postgresql://user:pass@host:5432/db'}
          />
        </div>
        <p className="tma-hint">🔒 Хранится в зашифрованном виде, никому не передаётся.</p>

        {extDbTestError && <p className="tma-error-text">{extDbTestError}</p>}

        {!extDbTestResult && (
          <button className="tma-btn tma-btn--full" disabled={extDbTestLoading || !externalDbForm.connectionString.trim()} onClick={testExternalDb}>
            {extDbTestLoading ? 'Подключаюсь...' : 'Подключиться'}
          </button>
        )}

        {extDbTestResult && (
          <>
            <div className="tma-form-row">
              <label className="tma-form-label">Коллекция / таблица</label>
              <select
                className="tma-input"
                value={extDbSelectedColl}
                onChange={(e) => {
                  const v = e.target.value;
                  setExtDbSelectedColl(v);
                  if (!extDbSchemaName) setExtDbSchemaName(v.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
                }}
              >
                {(extDbTestResult.collections || extDbTestResult.tables || []).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="tma-form-row">
              <label className="tma-form-label">Имя схемы в Siberi</label>
              <input className="tma-input" value={extDbSchemaName} onChange={(e) => setExtDbSchemaName(e.target.value)} placeholder="латиница, цифры, _" />
            </div>

            <div className="tma-toggle-row" onClick={() => setExtDbSyncEnabled((v) => !v)}>
              <span className="tma-form-label" style={{ margin: 0 }}>Автосинхронизация</span>
              <span className={`tma-toggle ${extDbSyncEnabled ? 'tma-toggle--on' : ''}`}><span className="tma-toggle-thumb" /></span>
            </div>
            <p className="tma-hint">
              {extDbSyncEnabled ? 'Данные будут обновляться автоматически каждую ночь.' : 'Разовый импорт — для обновления нужно повторить вручную.'}
            </p>

            {extDbSyncEnabled && (
              <>
                <div className="tma-form-label">Направление синхронизации</div>
                <div className="tma-direction-toggle">
                  <button
                    className={`tma-direction-opt ${extDbDirection === 'import' ? 'tma-direction-opt--active' : ''}`}
                    onClick={() => setExtDbDirection('import')}
                  >
                    <span className="tma-direction-icon">⬇️</span>
                    <span className="tma-direction-label">Только получать</span>
                  </button>
                  <button
                    className={`tma-direction-opt ${extDbDirection === 'bidirectional' ? 'tma-direction-opt--active' : ''}`}
                    onClick={() => setExtDbDirection('bidirectional')}
                  >
                    <span className="tma-direction-icon">↔️</span>
                    <span className="tma-direction-label">Получать и возвращать</span>
                  </button>
                </div>
              </>
            )}

            <div className="tma-export-row" style={{ marginTop: 12 }}>
              <button className="tma-btn" onClick={() => setExtDbTestResult(null)}>← Назад</button>
              <button className="tma-btn tma-btn--full" disabled={syncBusy || !extDbSelectedColl || !extDbSchemaName.trim()} onClick={saveExternalDbSync}>
                {syncBusy ? 'Сохраняю...' : (extDbSyncEnabled ? 'Включить синхронизацию' : 'Импортировать')}
              </button>
            </div>
          </>
        )}

        {externalDbConfigs.length > 0 && (
          <>
            <div className="tma-form-label" style={{ marginTop: 16 }}>Подключённые базы</div>
            {externalDbConfigs.map((c) => (
              <div key={c._id} className="tma-sync-row">
                <span>{c.schemaName} ({c.direction === 'bidirectional' ? '↔' : '→'})</span>
                <div className="tma-sync-row-actions">
                  <button className="tma-icon-btn" onClick={() => triggerSync('externaldb', c._id)}><RefreshCw size={15} /></button>
                  <button className="tma-icon-btn tma-icon-btn--danger" onClick={() => deleteSync('externaldb', c._id)}><X size={15} /></button>
                </div>
              </div>
            ))}
          </>
        )}
      </Sheet>

      {/* ── Import / export sheet ──────────────────────────────────────────────── */}
      <Sheet open={sheet === 'import-export'} onClose={() => setSheet(null)} title="Импорт / экспорт">
        <div className="tma-form-label">Импорт</div>
        <p className="tma-hint">Файлы CSV, JSON или SQL.</p>
        <input ref={fileInputRef} type="file" accept=".json,.csv,.sql" style={{ display: 'none' }} onChange={handleImportFile} />
        <button className="tma-btn tma-btn--full" disabled={importing} onClick={() => fileInputRef.current?.click()}>
          <Upload size={15} /> {importing ? 'Загружаю...' : 'Выбрать файл'}
        </button>

        <div className="tma-form-label" style={{ marginTop: 18 }}>Экспорт данных</div>
        <p className="tma-hint">JSON и Excel — всё сразу. CSV — только {selectedSchema ? `«${selectedSchema.label || selectedSchema.name}»` : 'первая схема'} (CSV — таблица, поддерживает только одну схему за раз).</p>
        <div className="tma-export-row">
          <button className="tma-btn" onClick={() => handleExport('json')}><Download size={14} /> JSON</button>
          <button className="tma-btn" onClick={() => handleExport('csv')}><Download size={14} /> CSV</button>
          <button className="tma-btn" onClick={() => handleExport('xlsx')}><Download size={14} /> Excel</button>
        </div>
      </Sheet>
    </div>
  );
}
