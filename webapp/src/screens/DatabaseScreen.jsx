import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Database,
  ChevronRight,
  ArrowLeft,
  Pencil,
  Plus,
  Trash2,
  Mic,
  Send,
  Search,
  Square,
  FilePlus2,
  Sheet,
  Upload,
  Download,
  Check,
  Eye,
  Lock,
  Crown,
  RefreshCw,
  X,
} from 'lucide-react'
import { Card } from '../components/ui.jsx'
import ScreenHero from '../components/ScreenHero.jsx'
import Modal from '../components/Modal.jsx'
import { api, errMsg } from '../api.js'
import { useApp } from '../store.js'
import { haptic } from '../telegram.js'
import './DatabaseScreen.css'

const PAGE_SIZE = 25

const AI_PHRASES = [
  'Думаю...', 'Применяю изменения...', 'Проверяю схему данных...',
  'Сверяюсь со структурой...', 'Почти готово...',
]

// Типы полей схемы — значения ровно как на сервере (routes/data.js).
const FIELD_TYPES = [
  { value: 'text', label: 'Текст' },
  { value: 'number', label: 'Число' },
  { value: 'date', label: 'Дата' },
  { value: 'boolean', label: 'Да / Нет' },
  { value: 'url', label: 'Ссылка' },
  { value: 'enum', label: 'Выбор' },
  { value: 'image', label: 'Картинка' },
  { value: 'file', label: 'Файл' },
]

// Пункты меню «+» → на какой под-экран ведут.
const IMPORT_ACTIONS = [
  { view: 'schema', label: 'Новая схема', sub: 'Создать базу вручную', icon: FilePlus2 },
  { view: 'sheets', label: 'Гугл Таблицы', sub: 'Импорт из Google Таблиц', icon: Sheet },
  { view: 'external', label: 'Внешняя база данных', sub: 'MongoDB, PostgreSQL', icon: Database },
  { view: 'device', label: 'Импортировать с устройства', sub: 'CSV, JSON, SQL', icon: Upload },
]

const IMPORT_TITLES = {
  menu: 'Данные',
  schema: 'Новая схема',
  sheets: 'Гугл Таблицы',
  external: 'Внешняя база данных',
  device: 'Импорт с устройства',
  export: 'Экспорт базы',
}

const newField = () => ({ id: Date.now() + Math.random(), name: '', label: '', type: 'text', required: false })

// ── Значение поля с legacy-fallback (тот же паттерн, что на сайте) ────────────
function getVal(rec, fieldName) {
  const v = rec.data?.[fieldName]
  if (v !== undefined && v !== null && v !== '') return v
  return rec.data?.data?.[fieldName] ?? null
}

// «name;;base64data» — split по ПЕРВОМУ ";;"
function decodeFile(val) {
  if (!val || typeof val !== 'string') return null
  const idx = val.indexOf(';;')
  if (idx === -1) return null
  return { name: val.slice(0, idx), data: val.slice(idx + 2) }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Отображение значения по типу поля (read-only, для карточек записей)
function FieldValue({ f, val }) {
  if (val == null || val === '') return <>—</>
  const s = String(val)
  if (f.type === 'image' && (s.startsWith('data:image/') || s.startsWith('http'))) {
    return <img src={s} alt={f.label} className="db-field-img" />
  }
  if (f.type === 'file') {
    const decoded = decodeFile(s)
    if (decoded) {
      return <a href={decoded.data} download={decoded.name} className="db-field-link">📎 {decoded.name}</a>
    }
  }
  if (f.type === 'url' || (s.startsWith('http') && f.type !== 'text')) {
    return <a href={s} target="_blank" rel="noopener noreferrer" className="db-field-link">{s}</a>
  }
  if (f.type === 'boolean') return <>{s === 'true' || val === true ? '✅' : '❌'}</>
  if (f.type === 'date') {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      const hasTime = /T\d{2}:\d{2}/.test(s)
      const datePart = d.toLocaleDateString('ru-RU')
      const timePart = hasTime ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''
      return <>{datePart}{timePart ? `, ${timePart}` : ''}</>
    }
  }
  return <>{s}</>
}

// Инпут поля формы записи — по типу из схемы
function FieldInput({ f, value, onChange }) {
  const [busy, setBusy] = useState(false)

  if (f.type === 'boolean') {
    return (
      <button
        type="button"
        className={`db-req ${value ? 'is-on' : ''}`}
        onClick={() => { haptic('light'); onChange(!value) }}
        aria-pressed={!!value}
      >
        <span className="db-req__box">{value && <Check size={12} strokeWidth={3.4} />}</span>
        {value ? 'Да' : 'Нет'}
      </button>
    )
  }
  if (f.type === 'enum') {
    return (
      <select className="db-select" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (f.type === 'date') {
    return <input className="db-input" type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />
  }
  if (f.type === 'number') {
    return <input className="db-input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
  }
  if (f.type === 'image' || f.type === 'file') {
    return (
      <div>
        {value && f.type === 'image' && (String(value).startsWith('data:image') || String(value).startsWith('http')) && (
          <img src={value} alt="" className="db-field-img" style={{ marginBottom: 8 }} />
        )}
        {value && f.type === 'file' && decodeFile(value) && (
          <p className="db-hint" style={{ margin: '0 0 8px' }}>📎 {decodeFile(value).name}</p>
        )}
        <input
          className="db-input"
          type="file"
          accept={f.type === 'image' ? 'image/*' : undefined}
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setBusy(true)
            try {
              const dataUrl = await readFileAsDataUrl(file)
              onChange(f.type === 'file' ? `${file.name};;${dataUrl}` : dataUrl)
            } finally {
              setBusy(false)
            }
          }}
        />
        {busy && <p className="db-hint db-hint--muted">Загрузка...</p>}
      </div>
    )
  }
  return <input className="db-input" type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} />
}

// Небольшой сегмент-переключатель.
function Segmented({ options, value, onChange }) {
  return (
    <div className="db-seg" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`db-seg__cell ${value === o.value ? 'is-active' : ''}`}
          onClick={() => { haptic('light'); onChange(o.value) }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Визуальный редактор недельного графика мастера (поля mon..sun) ──────────
// Значение поля дня — "10:00-20:00" (работает) или "" (выходной). Кирпич записи
// (server/helpers/booking.js) генерит свободные окна из этих часов.
const SCHED_DAYS = [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']]
const SCHED_KEYS = SCHED_DAYS.map((d) => d[0])
function parseRange(v) {
  const m = String(v || '').match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/)
  if (!m) return { on: false, start: '10:00', end: '20:00' }
  return { on: true, start: `${m[1].padStart(2, '0')}:${m[2]}`, end: `${m[3].padStart(2, '0')}:${m[4]}` }
}
function WeeklyScheduleEditor({ data, onChange }) {
  const setDay = (key, next) => onChange(key, next)
  const copyToAll = () => {
    haptic('medium')
    // берём первый рабочий день как шаблон
    const tmpl = SCHED_KEYS.map((k) => parseRange(data[k])).find((r) => r.on)
    if (!tmpl) return
    SCHED_KEYS.forEach((k) => { const r = parseRange(data[k]); if (r.on) setDay(k, `${tmpl.start}-${tmpl.end}`) })
  }
  const anyOn = SCHED_KEYS.some((k) => parseRange(data[k]).on)
  return (
    <div className="sched">
      {SCHED_DAYS.map(([key, label]) => {
        const r = parseRange(data[key])
        return (
          <div className={`sched-row ${r.on ? 'is-on' : ''}`} key={key}>
            <span className="sched-day">{label}</span>
            <button
              type="button"
              className={`sched-toggle ${r.on ? 'is-on' : ''}`}
              onClick={() => { haptic('light'); setDay(key, r.on ? '' : `${r.start}-${r.end}`) }}
            >
              {r.on ? 'Работает' : 'Выходной'}
            </button>
            {r.on ? (
              <div className="sched-times">
                <input className="sched-time" type="time" value={r.start} onChange={(e) => setDay(key, `${e.target.value || '10:00'}-${r.end}`)} />
                <span className="sched-dash">–</span>
                <input className="sched-time" type="time" value={r.end} onChange={(e) => setDay(key, `${r.start}-${e.target.value || '20:00'}`)} />
              </div>
            ) : (
              <div className="sched-times sched-times--off">—</div>
            )}
          </div>
        )
      })}
      {anyOn && (
        <button type="button" className="sched-copy" onClick={copyToAll}>Применить часы первого рабочего дня ко всем</button>
      )}
    </div>
  )
}

export default function DatabaseScreen({ onNavigate }) {
  const { phase, showToast } = useApp()

  // ── Схемы и записи ───────────────────────────────────────────
  const [schemas, setSchemas] = useState(null) // null — загрузка
  const [accessDenied, setAccessDenied] = useState(false)
  const [openSchema, setOpenSchema] = useState(null) // объект схемы или null (список)
  const [records, setRecords] = useState([])
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [pagination, setPagination] = useState(null)
  const [query, setQuery] = useState('')

  // ── Формы ────────────────────────────────────────────────────
  const [recordForm, setRecordForm] = useState(null) // { mode:'add'|'edit', data, recordId }
  const [delRecord, setDelRecord] = useState(null) // запись к удалению
  const [schemaForm, setSchemaForm] = useState(null) // { mode:'add'|'edit', name, label, fields }
  const [schemaEditOpen, setSchemaEditOpen] = useState(false)
  const [delSchemaOpen, setDelSchemaOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  // ── AI-правка текстом/голосом ────────────────────────────────
  const [textOpen, setTextOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStatusText, setAiStatusText] = useState('')
  const [recording, setRecording] = useState(false)
  const [livePartial, setLivePartial] = useState('')
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const streamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const silenceTimerRef = useRef(null)
  const partialTimerRef = useRef(null)
  const isPressedRef = useRef(false)
  const isHoldingRef = useRef(false)
  const holdTimeoutRef = useRef(null)
  const pressStartRef = useRef(0)

  // ── Импорт / экспорт / синки ─────────────────────────────────
  const [importView, setImportView] = useState(null) // null | menu | schema | sheets | external | device | export
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef(null)
  const [exportSchema, setExportSchema] = useState('')
  const [exportFmt, setExportFmt] = useState('csv')
  // Гугл Таблицы
  const [sheetUrl, setSheetUrl] = useState('')
  const [sheetsResult, setSheetsResult] = useState(null)
  const [sheetsTab, setSheetsTab] = useState('')
  const [sheetsSchemaName, setSheetsSchemaName] = useState('')
  const [sheetSync, setSheetSync] = useState('import') // import | bidirectional
  const [sheetsLoading, setSheetsLoading] = useState(false)
  const [sheetsError, setSheetsError] = useState('')
  // Внешняя БД
  const [extType, setExtType] = useState('mongodb')
  const [extConn, setExtConn] = useState('')
  const [extResult, setExtResult] = useState(null)
  const [extColl, setExtColl] = useState('')
  const [extSchemaName, setExtSchemaName] = useState('')
  const [extSyncMode, setExtSyncMode] = useState('sync') // sync | once
  const [extDirection, setExtDirection] = useState('import')
  const [extLoading, setExtLoading] = useState(false)
  const [extError, setExtError] = useState('')
  // Подключённые синхронизации
  const [syncConfigs, setSyncConfigs] = useState([])
  const [externalDbConfigs, setExternalDbConfigs] = useState([])
  const [syncBusy, setSyncBusy] = useState(false)

  // ── Загрузка схем ────────────────────────────────────────────
  const loadSchemas = useCallback(async () => {
    try {
      const { data } = await api.get('/data/schemas')
      setSchemas(data.schemas || [])
      setAccessDenied(false)
    } catch (err) {
      if (err.response?.status === 403) { setAccessDenied(true); setSchemas([]) }
      else showToast('Не удалось загрузить данные.', 'error')
    }
  }, [showToast])

  useEffect(() => {
    if (phase !== 'ready') return
    loadSchemas()
  }, [phase, loadSchemas])

  const loadRecords = useCallback(async (schema, page, append) => {
    setRecordsLoading(true)
    try {
      const { data } = await api.get(`/data/records/${schema.name}`, { params: { limit: PAGE_SIZE, page } })
      setRecords((prev) => (append ? [...prev, ...(data.records || [])] : (data.records || [])))
      setPagination(data.pagination || null)
    } catch {
      showToast('Не удалось загрузить записи.', 'error')
    } finally {
      setRecordsLoading(false)
    }
  }, [showToast])

  const openDb = (schema) => {
    haptic('light')
    setQuery('')
    setOpenSchema(schema)
    setRecords([])
    setPagination(null)
    loadRecords(schema, 1, false)
  }
  const back = () => { haptic('light'); setQuery(''); setOpenSchema(null); loadSchemas() }
  const backToMenu = () => { haptic('light'); setImportView('menu') }
  const closeImport = () => setImportView(null)

  const visibleFields = (openSchema?.fields || []).filter((f) => !f.name.startsWith('_'))

  // ── AI-правка ────────────────────────────────────────────────
  const refreshAfterEdit = () => {
    loadSchemas()
    if (openSchema) loadRecords(openSchema, 1, false)
  }

  const sendText = async () => {
    const prompt = aiPrompt.trim()
    if (!prompt || aiBusy) return
    haptic('medium')
    setAiBusy(true)
    let phraseIdx = 0
    setAiStatusText(AI_PHRASES[0])
    try {
      const res = await api.post('/analyze', {
        prompt, context: { source: 'tgletbot_miniapp_edit' }, platform: 'tgletbot_miniapp',
      })
      const taskId = res.data.taskId
      const deadline = Date.now() + 100000
      let lastPartial = ''
      let lastChangeAt = Date.now()
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 900))
        const r2 = await api.get(`/result/${taskId}`)
        const now = Date.now()
        if (r2.data.partialResult && r2.data.partialResult !== lastPartial) {
          lastPartial = r2.data.partialResult
          lastChangeAt = now
          setAiStatusText(lastPartial.slice(0, 80))
        } else if (now - lastChangeAt > 2200) {
          phraseIdx = (phraseIdx + 1) % AI_PHRASES.length
          lastChangeAt = now
          setAiStatusText(AI_PHRASES[phraseIdx])
        }
        if (r2.data.status === 'completed') {
          setAiPrompt('')
          setTextOpen(false)
          showToast(r2.data.result ? r2.data.result.slice(0, 120) : 'Изменения сохранены ✅')
          refreshAfterEdit()
          return
        }
        if (r2.data.status === 'error') {
          showToast('Прошу прощения, я сломалась. Сигнал разработчику уже отправлен.', 'error')
          return
        }
      }
      showToast('AI долго отвечает — попробуй ещё раз чуть позже.', 'error')
    } catch (err) {
      showToast(errMsg(err, 'Прошу прощения, я сломалась. Попробуй ещё раз.'), 'error')
    } finally {
      setAiBusy(false)
      setAiStatusText('')
    }
  }

  // ── Голосовой ввод: тап — свободная запись с авто-стопом по тишине,
  // зажатие — пока не отпустишь (порт из старого мини-аппа). ───────────
  const HOLD_THRESHOLD_MS = 350
  const SILENCE_MS = 2000
  const SILENCE_LEVEL = 6

  const transcribeAccumulated = async () => {
    if (!audioChunksRef.current.length) return ''
    const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
    const dataUrl = await readFileAsDataUrl(blob)
    try {
      const res = await api.post('/tgletbot/miniapp/transcribe', { audio: dataUrl })
      return res.data.text || ''
    } catch {
      return ''
    }
  }

  const finalizeRecording = useCallback(async () => {
    if (!mediaRecorderRef.current && !recording) return
    clearInterval(silenceTimerRef.current)
    clearInterval(partialTimerRef.current)
    silenceTimerRef.current = null
    partialTimerRef.current = null

    const recorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    isHoldingRef.current = false
    setRecording(false)

    await new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve()
      recorder.addEventListener('stop', resolve, { once: true })
      recorder.stop()
    })

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null }

    setAiBusy(true)
    setAiStatusText('Распознаю голос...')
    const text = await transcribeAccumulated()
    audioChunksRef.current = []
    setLivePartial('')
    setAiBusy(false)
    setAiStatusText('')

    if (text) {
      setAiPrompt((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text))
    } else {
      showToast('Не разобрала голос, попробуй ещё раз.', 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, showToast])

  const beginRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      audioChunksRef.current = []
      setLivePartial('')

      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mediaRecorderRef.current = recorder
      recorder.start(1000)

      // Детект тишины — best-effort: без AudioContext просто не будет авто-стопа
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const audioCtx = new AudioCtx()
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        audioCtxRef.current = audioCtx
        const data = new Uint8Array(analyser.frequencyBinCount)
        let silenceStart = null
        silenceTimerRef.current = setInterval(() => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128)
          const avg = sum / data.length
          if (avg < SILENCE_LEVEL) {
            if (silenceStart == null) silenceStart = Date.now()
            else if (!isHoldingRef.current && Date.now() - silenceStart > SILENCE_MS) {
              finalizeRecording()
            }
          } else {
            silenceStart = null
          }
        }, 200)
      } catch { /* нет AudioContext — просто без авто-стопа */ }

      // Живой превью — ре-транскрипция накопленного каждые ~2.5с
      partialTimerRef.current = setInterval(async () => {
        const text = await transcribeAccumulated()
        if (text) setLivePartial(text)
      }, 2500)

      setRecording(true)
    } catch {
      showToast('Нет доступа к микрофону.', 'error')
    }
  }

  const onMicPressStart = (e) => {
    e.preventDefault()
    if (recording) { finalizeRecording(); return }
    isPressedRef.current = true
    pressStartRef.current = Date.now()
    isHoldingRef.current = false
    beginRecording()
    holdTimeoutRef.current = setTimeout(() => {
      if (isPressedRef.current) isHoldingRef.current = true
    }, HOLD_THRESHOLD_MS)
  }

  const onMicPressEnd = (e) => {
    if (!isPressedRef.current) return
    isPressedRef.current = false
    e.preventDefault?.()
    clearTimeout(holdTimeoutRef.current)
    const wasHold = Date.now() - pressStartRef.current >= HOLD_THRESHOLD_MS
    if (wasHold) finalizeRecording()
  }

  // ── CRUD записей ─────────────────────────────────────────────
  const openAddRecord = () => {
    haptic('light')
    const blank = {}
    visibleFields.forEach((f) => { blank[f.name] = f.type === 'boolean' ? false : '' })
    setRecordForm({ mode: 'add', data: blank })
  }
  const openEditRecord = (rec) => {
    haptic('light')
    const data = {}
    visibleFields.forEach((f) => { data[f.name] = getVal(rec, f.name) ?? (f.type === 'boolean' ? false : '') })
    setRecordForm({ mode: 'edit', data, recordId: rec._id })
  }
  const saveRecordForm = async () => {
    if (!recordForm || !openSchema || saving) return
    haptic('medium')
    setSaving(true)
    try {
      if (recordForm.mode === 'add') {
        await api.post(`/data/records/${openSchema.name}`, { data: recordForm.data })
        showToast('Запись добавлена ✅')
      } else {
        await api.put(`/data/records/${openSchema.name}/${recordForm.recordId}`, { data: recordForm.data })
        showToast('Изменения сохранены ✅')
      }
      setRecordForm(null)
      loadRecords(openSchema, 1, false)
    } catch (err) {
      showToast(errMsg(err, 'Не удалось сохранить запись.'), 'error')
    } finally {
      setSaving(false)
    }
  }
  const deleteRecord = async () => {
    if (!delRecord || saving) return
    haptic('medium')
    setSaving(true)
    try {
      await api.delete(`/data/records/${openSchema.name}/${delRecord._id}`)
      showToast('Запись удалена')
      setDelRecord(null)
      loadRecords(openSchema, 1, false)
    } catch (err) {
      showToast(errMsg(err, 'Не удалось удалить.'), 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── CRUD схем ────────────────────────────────────────────────
  const startNewSchema = () => {
    haptic('light')
    setSchemaForm({ mode: 'add', label: '', fields: [{ ...newField(), name: 'name', label: 'Название', required: true }] })
    setImportView('schema')
  }
  const openSchemaEdit = () => {
    haptic('light')
    setSchemaForm({
      mode: 'edit',
      name: openSchema.name,
      label: openSchema.label || openSchema.name,
      fields: (openSchema.fields || []).map((f) => ({ ...f, id: Date.now() + Math.random() })),
    })
    setSchemaEditOpen(true)
  }
  const addField = () => { haptic('light'); setSchemaForm((sf) => ({ ...sf, fields: [...sf.fields, newField()] })) }
  const removeField = (id) => setSchemaForm((sf) => ({ ...sf, fields: sf.fields.length > 1 ? sf.fields.filter((x) => x.id !== id) : sf.fields }))
  const setField = (id, patch) => setSchemaForm((sf) => ({ ...sf, fields: sf.fields.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
  const toggleReq = (id) => { haptic('light'); setSchemaForm((sf) => ({ ...sf, fields: sf.fields.map((x) => (x.id === id ? { ...x, required: !x.required } : x)) })) }

  const saveSchemaForm = async () => {
    if (!schemaForm || saving) return
    const cleanFields = schemaForm.fields
      .filter((f) => f.name.trim())
      .map(({ id: _id, ...f }) => ({ ...f, label: f.label?.trim() || f.name.trim() }))
    if (!cleanFields.length) { showToast('Добавь хотя бы одно поле.', 'error'); return }
    haptic('medium')
    setSaving(true)
    try {
      if (schemaForm.mode === 'add') {
        const name = (schemaForm.label || 'schema').toLowerCase().replace(/[^a-zа-я0-9_]+/gi, '_').slice(0, 40) || 'schema'
        await api.post('/data/schemas', { name, label: schemaForm.label || name, fields: cleanFields })
        showToast('Схема создана ✅')
        closeImport()
      } else {
        await api.put(`/data/schemas/${schemaForm.name}`, { label: schemaForm.label, fields: cleanFields })
        showToast('Схема обновлена ✅')
        setSchemaEditOpen(false)
        setOpenSchema((s) => ({ ...s, label: schemaForm.label, fields: cleanFields }))
      }
      setSchemaForm(null)
      loadSchemas()
    } catch (err) {
      showToast(errMsg(err, 'Не удалось сохранить схему.'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const deleteSchema = async () => {
    if (saving) return
    haptic('medium')
    setSaving(true)
    try {
      await api.delete(`/data/schemas/${openSchema.name}`)
      showToast('Схема удалена')
      setDelSchemaOpen(false)
      setSchemaEditOpen(false)
      setOpenSchema(null)
      loadSchemas()
    } catch (err) {
      showToast(errMsg(err, 'Не удалось удалить.'), 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Синхронизации (Sheets / внешняя БД) ──────────────────────
  const loadSyncConfigs = async () => {
    try {
      const [sheetsRes, dbRes] = await Promise.all([
        api.get('/integrations/sync/list').catch(() => ({ data: { configs: [] } })),
        api.get('/integrations/external-db/sync/list').catch(() => ({ data: { configs: [] } })),
      ])
      // /sync/list отдаёт ВСЕ конфиги (sheets + external_db) — фильтруем таблицы
      setSyncConfigs((sheetsRes.data.configs || []).filter((c) => c.sourceType !== 'external_db'))
      setExternalDbConfigs(dbRes.data.configs || [])
    } catch { /* не критично */ }
  }

  const openImportView = (view) => {
    haptic('light')
    if (view === 'sheets') {
      setSheetUrl(''); setSheetsResult(null); setSheetsTab(''); setSheetsSchemaName(''); setSheetsError(''); setSheetSync('import')
      loadSyncConfigs()
    }
    if (view === 'external') {
      setExtConn(''); setExtResult(null); setExtColl(''); setExtSchemaName(''); setExtError(''); setExtSyncMode('sync'); setExtDirection('import')
      loadSyncConfigs()
    }
    if (view === 'export') {
      setExportSchema(schemas?.[0]?.name || '')
    }
    setImportView(view)
  }

  const fetchSheetsPreview = async (tab) => {
    if (!sheetUrl.trim() || sheetsLoading) return
    haptic('light')
    setSheetsLoading(true)
    setSheetsError('')
    try {
      const res = await api.post('/integrations/sheets/fetch', { url: sheetUrl.trim(), sheetName: tab || null })
      setSheetsResult(res.data)
      const chosenTab = tab || res.data.tabs?.[0] || ''
      setSheetsTab(chosenTab)
      if (!sheetsSchemaName) {
        const base = (chosenTab || 'sheet').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '') || 'sheet'
        setSheetsSchemaName(`${base}_${Date.now().toString(36).slice(-4)}`)
      }
    } catch (err) {
      setSheetsError(errMsg(err, 'Не удалось открыть таблицу — проверь ссылку и доступ.'))
    } finally {
      setSheetsLoading(false)
    }
  }

  const saveSheetsSync = async () => {
    if (!sheetUrl.trim() || !sheetsSchemaName.trim() || syncBusy) return
    haptic('medium')
    setSyncBusy(true)
    try {
      await api.post('/integrations/sync/save', {
        schemaName: sheetsSchemaName.trim(),
        sourceUrl: sheetUrl.trim(),
        sheetName: sheetsTab || null,
        direction: sheetSync,
      })
      showToast('Google Sheets подключён ✅')
      closeImport()
      loadSchemas()
    } catch (err) {
      showToast(errMsg(err, 'Не удалось подключить таблицу.'), 'error')
    } finally {
      setSyncBusy(false)
    }
  }

  const testExternalDb = async () => {
    if (!extConn.trim() || extLoading) return
    haptic('light')
    setExtLoading(true)
    setExtError('')
    try {
      const res = await api.post('/integrations/external-db/test', {
        connectionString: extConn.trim(), type: extType,
      })
      setExtResult(res.data)
      const items = res.data.collections || res.data.tables || []
      const first = items[0] || ''
      setExtColl(first)
      if (!extSchemaName && first) setExtSchemaName(first.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
    } catch (err) {
      setExtError(errMsg(err, 'Не удалось подключиться — проверь строку подключения.'))
    } finally {
      setExtLoading(false)
    }
  }

  const saveExternalDbSync = async () => {
    if (!extColl || !extSchemaName.trim() || syncBusy) {
      if (!extColl || !extSchemaName.trim()) showToast('Выбери коллекцию и укажи имя схемы.', 'error')
      return
    }
    haptic('medium')
    setSyncBusy(true)
    try {
      const payload = {
        connectionString: extConn.trim(),
        type: extType,
        dbType: extType,
        collection: extColl,
        schemaName: extSchemaName.trim(),
        direction: extSyncMode === 'sync' ? extDirection : 'import',
      }
      if (extSyncMode === 'sync') {
        await api.post('/integrations/external-db/sync/save', payload)
      } else {
        await api.post('/integrations/external-db/import', payload)
      }
      showToast(extSyncMode === 'sync' ? 'Синхронизация включена ✅' : 'Импортировано ✅')
      closeImport()
      loadSchemas()
    } catch (err) {
      showToast(errMsg(err, 'Не удалось подключиться к базе.'), 'error')
    } finally {
      setSyncBusy(false)
    }
  }

  const triggerSync = async (kind, id) => {
    haptic('light')
    setSyncBusy(true)
    try {
      const path = kind === 'sheets' ? `/integrations/sync/trigger/${id}` : `/integrations/external-db/sync/trigger/${id}`
      await api.post(path, {})
      showToast('Синхронизация запущена ✅')
      loadSchemas()
    } catch {
      showToast('Не удалось синхронизировать.', 'error')
    } finally {
      setSyncBusy(false)
    }
  }

  const deleteSync = async (kind, id) => {
    haptic('light')
    setSyncBusy(true)
    try {
      const path = kind === 'sheets' ? `/integrations/sync/${id}` : `/integrations/external-db/sync/${id}`
      await api.delete(path)
      showToast('Синхронизация отключена')
      loadSyncConfigs()
    } catch {
      showToast('Не удалось отключить синхронизацию.', 'error')
    } finally {
      setSyncBusy(false)
    }
  }

  const renderSyncRows = (configs, kind) => configs.length > 0 && (
    <>
      <label className="db-label" style={{ marginTop: 4 }}>Подключено сейчас</label>
      {configs.map((c) => (
        <div key={c._id} className="db-sync-row">
          <span className="db-sync-row__name">{c.schemaName} {c.direction === 'bidirectional' ? '↔' : '→'}</span>
          <span className="db-sync-row__actions">
            <button className="db-headtools__btn" disabled={syncBusy} onClick={() => triggerSync(kind, c._id)} type="button" aria-label="Синхронизировать">
              <RefreshCw size={15} />
            </button>
            <button className="db-headtools__btn" disabled={syncBusy} onClick={() => deleteSync(kind, c._id)} type="button" aria-label="Отключить">
              <X size={15} />
            </button>
          </span>
        </div>
      ))}
    </>
  )

  // ── Импорт файла / экспорт ───────────────────────────────────
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await api.post('/data/import', form, { headers: { 'Content-Type': 'multipart/form-data' } })
      const s = res.data.summary || {}
      showToast(`Импортировано: ${s.importedSchemas || 0} схем, ${s.importedRecords || 0} записей ✅`)
      closeImport()
      loadSchemas()
    } catch (err) {
      showToast(errMsg(err, 'Не удалось импортировать файл.'), 'error')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleExport = async () => {
    haptic('medium')
    try {
      const params = { format: exportFmt }
      if (exportFmt === 'csv' && exportSchema) params.schema = exportSchema
      const res = await api.get('/data/export', { params, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `aiconstructor-data.${exportFmt}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast('Экспорт готов ✅')
      closeImport()
    } catch {
      showToast('Не удалось экспортировать.', 'error')
    }
  }

  // ── Рендер ───────────────────────────────────────────────────
  const q = query.trim().toLowerCase()
  const shownRecords = q
    ? records.filter((r) => visibleFields.some((f) => String(getVal(r, f.name) ?? '').toLowerCase().includes(q)))
    : records

  // Общий редактор полей схемы — для создания и правки
  const renderSchemaEditor = (saveLabel) => schemaForm && (
    <>
      <div className="db-form">
        <label className="db-label">Название схемы</label>
        <input
          className="db-input"
          placeholder="Например: Услуги"
          value={schemaForm.label}
          onChange={(e) => setSchemaForm((sf) => ({ ...sf, label: e.target.value }))}
        />
      </div>

      <div className="db-form">
        <label className="db-label">Поля</label>
        <div className="db-fields">
          {schemaForm.fields.map((f) => (
            <div key={f.id} className="db-fielditem">
              <input
                className="db-input db-fielditem__name"
                placeholder="имя_поля (латиницей)"
                value={f.name}
                onChange={(e) => setField(f.id, { name: e.target.value })}
              />
              <input
                className="db-input db-fielditem__name"
                placeholder="Подпись (для карточек)"
                value={f.label || ''}
                onChange={(e) => setField(f.id, { label: e.target.value })}
              />
              <div className="db-fielditem__row">
                <select
                  className="db-select"
                  value={f.type}
                  onChange={(e) => setField(f.id, { type: e.target.value })}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`db-req ${f.required ? 'is-on' : ''}`}
                  onClick={() => toggleReq(f.id)}
                  aria-pressed={f.required}
                >
                  <span className="db-req__box">{f.required && <Check size={12} strokeWidth={3.4} />}</span>
                  Обязательное
                </button>
                <button
                  type="button"
                  className="db-fielditem__del"
                  onClick={() => removeField(f.id)}
                  aria-label="Удалить поле"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <button className="db-addfield" onClick={addField} type="button">
          <Plus size={16} /> Добавить поле
        </button>
      </div>

      <p className="db-hint db-hint--muted">
        «Обязательное» — бот не закроет запись, пока это поле не заполнено.
      </p>

      <button className="btn btn--primary" disabled={saving} onClick={saveSchemaForm} type="button">
        {saving ? 'Сохраняю…' : saveLabel}
      </button>
    </>
  )

  return (
    <>
      {!openSchema ? (
        // ── Список баз данных ───────────────────────────
        <div className="db-page">
          <ScreenHero eyebrow="База данных" subtitle="Управление данными бота" />
          <div className="screen-body">
            {schemas === null ? (
              <div className="spinner" />
            ) : accessDenied ? (
              <Card className="bot-empty">
                <Lock size={26} className="bot-empty__icon" />
                <p className="bot-empty__text">
                  Подписка неактивна — данные откроются после оформления тарифа.
                </p>
                <button className="btn btn--primary" onClick={() => { haptic('light'); onNavigate?.('account') }}>
                  <Crown size={18} />
                  Оформить подписку
                </button>
              </Card>
            ) : schemas.length === 0 ? (
              <p className="db-empty">
                Пока нет данных. Опиши боту в чате, что нужно хранить, — или создай схему через «+» ниже.
              </p>
            ) : (
              <div className="db-list">
                {schemas.map((s) => (
                  <button key={s._id || s.name} className="db-card" onClick={() => openDb(s)} type="button">
                    <span
                      className="db-card__icon"
                      style={{ background: `${s.color || '#3b82f6'}1f`, color: s.color || '#3b82f6' }}
                    >
                      {s.icon ? <span className="db-card__emoji">{s.icon}</span> : <Database size={20} />}
                    </span>
                    <span className="db-card__main">
                      <span className="db-card__name">{s.label || s.name}</span>
                      <span className="db-card__count">{s.recordCount ?? 0} записей</span>
                    </span>
                    <ChevronRight size={18} className="db-card__chevron" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Единый бар: «Редактировать текстом» | «+» */}
          {!accessDenied && (
            <div className="db-actions">
              <div className="db-actionbar">
                <button
                  className="db-actionbar__edit"
                  onClick={() => { haptic('light'); setTextOpen(true) }}
                  type="button"
                >
                  <Pencil size={18} />
                  Редактировать текстом
                </button>
                <span className="db-actionbar__div" />
                <button
                  className="db-actionbar__add"
                  onClick={() => { haptic('light'); loadSyncConfigs(); setImportView('menu') }}
                  type="button"
                  aria-label="Добавить данные"
                >
                  <Plus size={22} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        // ── Открытая база ───────────────────────────────
        <div className="db-detail">
          <div className="db-detail__bar">
            <button className="db-back" onClick={back} type="button" aria-label="Назад">
              <ArrowLeft size={20} />
            </button>
            <span className="db-detail__icon">
              {openSchema.icon ? <span className="db-card__emoji">{openSchema.icon}</span> : <Database size={18} />}
            </span>
            <span className="db-detail__titles">
              <span className="db-detail__name">{openSchema.label || openSchema.name}</span>
              <span className="db-detail__count">{pagination?.total ?? records.length} записей</span>
            </span>
            <div className="db-search">
              <Search size={15} className="db-search__icon" />
              <input
                className="db-search__input"
                placeholder="Поиск…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="db-headtools">
              <button className="db-headtools__btn" onClick={openSchemaEdit} type="button" aria-label="Редактировать схему">
                <Pencil size={17} />
              </button>
              <button className="db-headtools__btn db-headtools__btn--danger" onClick={() => { haptic('medium'); setDelSchemaOpen(true) }} type="button" aria-label="Удалить схему">
                <Trash2 size={16} />
              </button>
              <span className="db-headtools__div" />
              <button className="db-headtools__btn db-headtools__btn--add" onClick={openAddRecord} type="button" aria-label="Добавить запись">
                <Plus size={19} />
              </button>
            </div>
          </div>

          <div className="db-detail__body">
            {recordsLoading && records.length === 0 ? (
              <div className="spinner" />
            ) : shownRecords.length === 0 ? (
              <p className="db-empty">
                {q ? `По запросу «${query.trim()}» ничего не найдено.` : 'В этой базе пока нет записей. Добавь первую через «+» вверху.'}
              </p>
            ) : (
              <>
                {shownRecords.map((rec) => (
                  <Card key={rec._id} className="db-record">
                    <div className="db-record__fields">
                      {visibleFields.map((f) => (
                        <div key={f.name} className="db-field">
                          <span className="db-field__label">{f.label || f.name}</span>
                          <span className="db-field__value"><FieldValue f={f} val={getVal(rec, f.name)} /></span>
                        </div>
                      ))}
                    </div>
                    <div className="db-record__actions">
                      <div className="db-rectools">
                        <button
                          className="db-rectools__btn"
                          onClick={() => openEditRecord(rec)}
                          type="button"
                          aria-label="Редактировать запись"
                        >
                          <Pencil size={15} />
                        </button>
                        <span className="db-rectools__div" />
                        <button
                          className="db-rectools__btn db-rectools__btn--del"
                          onClick={() => { haptic('light'); setDelRecord(rec) }}
                          type="button"
                          aria-label="Удалить запись"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </Card>
                ))}
                {!q && pagination && pagination.page < pagination.pages && (
                  <button
                    className="btn btn--ghost"
                    disabled={recordsLoading}
                    onClick={() => loadRecords(openSchema, pagination.page + 1, true)}
                    type="button"
                  >
                    {recordsLoading ? 'Загрузка…' : 'Показать ещё'}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Внутри базы — только редактирование текстом */}
          <div className="db-actions">
            <div className="db-actionbar">
              <button
                className="db-actionbar__edit"
                onClick={() => { haptic('light'); setTextOpen(true) }}
                type="button"
              >
                <Pencil size={18} />
                Редактировать текстом
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Попап: редактирование текстом / голосом */}
      <Modal open={textOpen} onClose={() => !aiBusy && setTextOpen(false)} title="Редактировать текстом">
        <div className="stack">
          {aiBusy ? (
            <div className="db-ai-status">
              <div className="spinner spinner--sm" />
              <span>{aiStatusText}</span>
            </div>
          ) : (
            <>
              <p className="db-hint">
                Опиши, что хочешь изменить — например «добавь поле скидка в схему услуги» или
                «удали все старые заказы».
              </p>
              <div className="db-compose">
                <textarea
                  className="db-compose__input"
                  placeholder="Введите запрос…"
                  rows={3}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                />
                {recording && (
                  <p className="db-hint">🎙 {livePartial || 'Слушаю...'}</p>
                )}
                <div className="db-compose__row">
                  <button
                    className="db-mic"
                    onPointerDown={onMicPressStart}
                    onPointerUp={onMicPressEnd}
                    onPointerLeave={onMicPressEnd}
                    onPointerCancel={onMicPressEnd}
                    type="button"
                    aria-label="Записать голосом"
                  >
                    {recording ? <Square size={20} /> : <Mic size={20} />}
                  </button>
                  <button className="db-send" onClick={sendText} disabled={!aiPrompt.trim()} type="button">
                    <Send size={17} />
                    Отправить
                  </button>
                </div>
              </div>
              <p className="db-hint db-hint--muted">
                Нажми на <Mic size={13} className="db-mic__inline" /> — запись остановится сама через
                2 сек тишины. Зажми и держи — пока не отпустишь палец. Нажми ещё раз — добавит новую
                строку, не удаляя прошлую.
              </p>
            </>
          )}
        </div>
      </Modal>

      {/* Попап: редактирование схемы открытой базы */}
      <Modal open={schemaEditOpen} onClose={() => setSchemaEditOpen(false)} title="Редактировать схему">
        <div className="stack">
          {renderSchemaEditor('Сохранить изменения')}
          <button
            className="btn btn--danger"
            onClick={() => { haptic('light'); setDelSchemaOpen(true) }}
            type="button"
          >
            <Trash2 size={16} />
            Удалить схему целиком
          </button>
        </div>
      </Modal>

      {/* Попап: подтверждение удаления схемы */}
      <Modal open={delSchemaOpen} onClose={() => setDelSchemaOpen(false)} title="Удалить схему?">
        <div className="stack">
          <p className="db-hint">Схема и ВСЕ её записи будут удалены без возможности восстановления.</p>
          <div className="grid-2">
            <button className="btn btn--ghost" onClick={() => setDelSchemaOpen(false)} type="button">
              Отмена
            </button>
            <button className="btn btn--danger-solid" disabled={saving} onClick={deleteSchema} type="button">
              {saving ? 'Удаляю…' : 'Удалить'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Попап: добавление / редактирование записи */}
      <Modal
        open={recordForm !== null}
        onClose={() => setRecordForm(null)}
        title={recordForm?.mode === 'add' ? 'Новая запись' : 'Редактировать запись'}
      >
        {recordForm && (
          <div className="stack">
            {(() => {
              const isMasters = openSchema?.name === 'masters' && visibleFields.some((f) => SCHED_KEYS.includes(f.name))
              let gridDone = false
              return visibleFields.map((f) => {
                // Поля дней (mon..sun) у мастера — рисуем ОДНОЙ визуальной сеткой.
                if (isMasters && SCHED_KEYS.includes(f.name)) {
                  if (gridDone) return null
                  gridDone = true
                  return (
                    <div key="__sched" className="db-form">
                      <label className="db-label">🗓 График работы</label>
                      <WeeklyScheduleEditor
                        data={recordForm.data}
                        onChange={(k, v) => setRecordForm((rf) => ({ ...rf, data: { ...rf.data, [k]: v } }))}
                      />
                    </div>
                  )
                }
                return (
                  <div key={f.name} className="db-form">
                    <label className="db-label">{f.label || f.name}{f.required ? ' *' : ''}</label>
                    <FieldInput
                      f={f}
                      value={recordForm.data[f.name]}
                      onChange={(v) => setRecordForm((rf) => ({ ...rf, data: { ...rf.data, [f.name]: v } }))}
                    />
                  </div>
                )
              })
            })()}
            <button className="btn btn--primary" disabled={saving} onClick={saveRecordForm} type="button">
              {recordForm.mode === 'add' && <Plus size={18} />}
              {saving ? 'Сохраняю…' : recordForm.mode === 'add' ? 'Добавить запись' : 'Сохранить'}
            </button>
          </div>
        )}
      </Modal>

      {/* Попап: подтверждение удаления записи */}
      <Modal open={delRecord !== null} onClose={() => setDelRecord(null)} title="Удалить запись?">
        <div className="stack">
          <p className="db-hint">Запись будет удалена без возможности восстановления.</p>
          <div className="grid-2">
            <button className="btn btn--ghost" onClick={() => setDelRecord(null)} type="button">
              Отмена
            </button>
            <button className="btn btn--danger-solid" disabled={saving} onClick={deleteRecord} type="button">
              {saving ? 'Удаляю…' : 'Удалить'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Попап: данные (импорт / создание / экспорт) */}
      <Modal open={importView !== null} onClose={closeImport} title={IMPORT_TITLES[importView] || ''}>
        {/* Меню */}
        {importView === 'menu' && (
          <div className="stack">
            <div className="db-tiles">
              {IMPORT_ACTIONS.map((a) => {
                const Icon = a.icon
                return (
                  <button
                    key={a.view}
                    className="db-tile"
                    onClick={() => { a.view === 'schema' ? startNewSchema() : openImportView(a.view) }}
                    type="button"
                  >
                    <span className="db-tile__icon"><Icon size={22} /></span>
                    <span className="db-tile__label">{a.label}</span>
                    <span className="db-tile__sub">{a.sub}</span>
                  </button>
                )
              })}
            </div>

            <button
              className="btn btn--ghost db-export-btn"
              onClick={() => openImportView('export')}
              type="button"
            >
              <Download size={18} />
              Экспортировать базу
            </button>
          </div>
        )}

        {/* Новая схема */}
        {importView === 'schema' && (
          <div className="stack">
            <button className="db-sub__back" onClick={backToMenu} type="button">
              <ArrowLeft size={16} /> Назад
            </button>
            {renderSchemaEditor('Сохранить схему')}
          </div>
        )}

        {/* Гугл Таблицы */}
        {importView === 'sheets' && (
          <div className="stack">
            <button className="db-sub__back" onClick={backToMenu} type="button">
              <ArrowLeft size={16} /> Назад
            </button>

            <div className="db-form">
              <label className="db-label">Ссылка на таблицу</label>
              <input
                className="db-input"
                placeholder="https://docs.google.com/spreadsheets/…"
                value={sheetUrl}
                onChange={(e) => { setSheetUrl(e.target.value); setSheetsResult(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') fetchSheetsPreview() }}
              />
            </div>
            <p className="db-hint">Таблица обязательно должна быть открыта для доступа по ссылке.</p>

            {sheetsError && <p className="db-hint" style={{ color: 'var(--danger)' }}>{sheetsError}</p>}

            {sheetUrl.trim() && !sheetsResult && (
              <button className="btn btn--ghost" disabled={sheetsLoading} onClick={() => fetchSheetsPreview()} type="button">
                <Eye size={18} /> {sheetsLoading ? 'Открываю…' : 'Просмотр'}
              </button>
            )}

            {sheetsResult && (
              <>
                <div className="db-preview">
                  {(sheetsResult.tabs?.length ? sheetsResult.tabs : [sheetsTab || 'Лист 1']).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`db-preview__sheet ${sheetsTab === t ? 'is-active' : ''}`}
                      disabled={sheetsLoading}
                      onClick={() => fetchSheetsPreview(t)}
                    >
                      <span className="db-preview__name"><Sheet size={15} /> {t}</span>
                      {sheetsTab === t && (
                        <>
                          <span className="db-preview__meta">
                            {sheetsResult.empty ? 'Пустой лист или без заголовков' : `${sheetsResult.total} строк · ${(sheetsResult.headers || []).length} колонок`}
                          </span>
                          {!sheetsResult.empty && (
                            <span className="db-preview__cols">{(sheetsResult.headers || []).join(', ')}</span>
                          )}
                        </>
                      )}
                    </button>
                  ))}
                </div>

                <div className="db-form">
                  <label className="db-label">Название схемы</label>
                  <input
                    className="db-input"
                    placeholder="products"
                    value={sheetsSchemaName}
                    onChange={(e) => setSheetsSchemaName(e.target.value)}
                  />
                </div>

                <div className="db-form">
                  <label className="db-label">Синхронизация</label>
                  <Segmented
                    value={sheetSync}
                    onChange={setSheetSync}
                    options={[
                      { value: 'import', label: 'Только получать' },
                      { value: 'bidirectional', label: 'Получать и возвращать' },
                    ]}
                  />
                </div>
                <p className="db-hint db-hint--muted">
                  {sheetSync === 'import'
                    ? 'Изменения в таблице подтянутся сами, а то, что изменишь через бота, AI или вручную — в таблицу не попадёт.'
                    : 'Работает в обе стороны: изменения в таблице подтянутся к нам, а то, что изменишь здесь — через бота, AI или вручную — добавится в таблицу автоматически.'}
                </p>

                <button className="btn btn--primary" disabled={syncBusy || !sheetsSchemaName.trim()} onClick={saveSheetsSync} type="button">
                  {syncBusy ? 'Подключаю…' : 'Подключить таблицу'}
                </button>
              </>
            )}

            {renderSyncRows(syncConfigs, 'sheets')}
          </div>
        )}

        {/* Внешняя БД */}
        {importView === 'external' && (
          <div className="stack">
            <button className="db-sub__back" onClick={backToMenu} type="button">
              <ArrowLeft size={16} /> Назад
            </button>

            <div className="db-form">
              <label className="db-label">Тип базы</label>
              <Segmented
                value={extType}
                onChange={(v) => { setExtType(v); setExtResult(null) }}
                options={[
                  { value: 'mongodb', label: 'MongoDB' },
                  { value: 'postgresql', label: 'PostgreSQL' },
                ]}
              />
            </div>

            <div className="db-form">
              <label className="db-label">Строка подключения</label>
              <input
                className="db-input"
                placeholder={extType === 'mongodb' ? 'mongodb+srv://user:pass@host/db' : 'postgres://user:pass@host:5432/db'}
                value={extConn}
                onChange={(e) => { setExtConn(e.target.value); setExtResult(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') testExternalDb() }}
              />
            </div>

            <div className="db-note">
              <Lock size={16} />
              <span>Данные хранятся в зашифрованном виде и никому не передаются.</span>
            </div>

            {extError && <p className="db-hint" style={{ color: 'var(--danger)' }}>{extError}</p>}

            {!extResult && (
              <button className="btn btn--primary" disabled={extLoading || !extConn.trim()} onClick={testExternalDb} type="button">
                {extLoading ? 'Подключаюсь…' : 'Подключиться'}
              </button>
            )}

            {extResult && (
              <>
                <div className="db-form">
                  <label className="db-label">Коллекция / таблица</label>
                  <select
                    className="db-select"
                    value={extColl}
                    onChange={(e) => {
                      const v = e.target.value
                      setExtColl(v)
                      if (!extSchemaName) setExtSchemaName(v.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                    }}
                  >
                    {(extResult.collections || extResult.tables || []).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                <div className="db-form">
                  <label className="db-label">Имя схемы</label>
                  <input
                    className="db-input"
                    placeholder="латиница, цифры, _"
                    value={extSchemaName}
                    onChange={(e) => setExtSchemaName(e.target.value)}
                  />
                </div>

                <div className="db-form">
                  <label className="db-label">Режим</label>
                  <Segmented
                    value={extSyncMode}
                    onChange={setExtSyncMode}
                    options={[
                      { value: 'sync', label: 'Автосинхронизация' },
                      { value: 'once', label: 'Разовый импорт' },
                    ]}
                  />
                </div>
                <p className="db-hint db-hint--muted">
                  {extSyncMode === 'sync'
                    ? 'Данные будут обновляться автоматически каждую ночь.'
                    : 'Разовый импорт — для обновления нужно повторить вручную.'}
                </p>

                {extSyncMode === 'sync' && (
                  <div className="db-form">
                    <label className="db-label">Направление</label>
                    <Segmented
                      value={extDirection}
                      onChange={setExtDirection}
                      options={[
                        { value: 'import', label: 'Только получать' },
                        { value: 'bidirectional', label: 'Получать и возвращать' },
                      ]}
                    />
                  </div>
                )}

                <button
                  className="btn btn--primary"
                  disabled={syncBusy || !extColl || !extSchemaName.trim()}
                  onClick={saveExternalDbSync}
                  type="button"
                >
                  {syncBusy ? 'Сохраняю…' : (extSyncMode === 'sync' ? 'Включить синхронизацию' : 'Импортировать')}
                </button>
              </>
            )}

            {renderSyncRows(externalDbConfigs, 'externaldb')}
          </div>
        )}

        {/* Импорт с устройства */}
        {importView === 'device' && (
          <div className="stack">
            <button className="db-sub__back" onClick={backToMenu} type="button">
              <ArrowLeft size={16} /> Назад
            </button>
            <div className="db-drop">
              <span className="db-drop__icon"><Upload size={26} /></span>
              <p className="db-drop__text">Поддерживаются форматы CSV, JSON и SQL.</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv,.sql"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
              <button
                className="btn btn--primary db-drop__btn"
                disabled={importing}
                onClick={() => { haptic('light'); fileInputRef.current?.click() }}
                type="button"
              >
                {importing ? 'Загружаю…' : 'Выбрать файл'}
              </button>
            </div>
          </div>
        )}

        {/* Экспорт */}
        {importView === 'export' && (
          <div className="stack">
            <button className="db-sub__back" onClick={backToMenu} type="button">
              <ArrowLeft size={16} /> Назад
            </button>

            <div className="db-form">
              <label className="db-label">Формат</label>
              <Segmented
                value={exportFmt}
                onChange={setExportFmt}
                options={[
                  { value: 'csv', label: 'CSV' },
                  { value: 'json', label: 'JSON' },
                  { value: 'xlsx', label: 'Excel' },
                ]}
              />
            </div>

            {exportFmt === 'csv' ? (
              <div className="db-form">
                <label className="db-label">База данных (CSV — одна схема за раз)</label>
                <select className="db-select" value={exportSchema} onChange={(e) => setExportSchema(e.target.value)}>
                  {(schemas || []).map((s) => (
                    <option key={s.name} value={s.name}>{s.label || s.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="db-hint db-hint--muted">JSON и Excel выгружают все базы сразу.</p>
            )}

            <button className="btn btn--primary" onClick={handleExport} type="button">
              <Download size={18} />
              Экспортировать
            </button>
          </div>
        )}
      </Modal>
    </>
  )
}
