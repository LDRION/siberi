import { useState, useEffect } from 'react'
import {
  Play,
  Square,
  RotateCw,
  ExternalLink,
  Users,
  Activity,
  Sparkles,
  Plus,
  Trash2,
  ChevronRight,
  Layers,
  Save,
  RotateCcw,
  Store,
  Tag,
  Upload,
  Check,
  X,
} from 'lucide-react'
import { Card } from '../components/ui.jsx'
import ScreenHero from '../components/ScreenHero.jsx'
import Modal from '../components/Modal.jsx'
import { api, errMsg } from '../api.js'
import { useApp } from '../store.js'
import { haptic, openTelegramLink } from '../telegram.js'
import botOnline from '../assets/bot_online.webp'
import botOffline from '../assets/bot_offline.webp'
import botNotcreated from '../assets/bot_notcreated.webp'
import './BotScreen.css'

// Статус бота выражает сам робот-герой: он держит соответствующую плашку.
const STATUS_ART = {
  online: botOnline,
  offline: botOffline,
  absent: botNotcreated,
}

// КД на кнопки питания (старт/стоп/перезагрузка) — реальные действия
// с вебхуком Telegram, нельзя спамить. Общий для всех трёх: после любого
// действия процесс должен «устаканиться», прежде чем дёргать снова.
const POWER_COOLDOWN_MS = 6000

export default function BotScreen() {
  const { bot, botLoading, refreshBot, account, showToast } = useApp()

  // Обновляем статус бота при каждом заходе на вкладку — статус тянется один раз
  // при старте приложения, поэтому после запуска/остановки бота в чате мини-апп
  // мог показывать устаревший статус, пока его не перезапустят. Тихо, без спиннера.
  useEffect(() => { refreshBot({ silent: true }) }, [refreshBot])

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [coolUntil, setCoolUntil] = useState(0) // timestamp окончания КД
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)

  // Макеты (снапшоты) бота
  const [snapsOpen, setSnapsOpen] = useState(false)
  const [snaps, setSnaps] = useState(null) // null — не загружено
  const [snapBusy, setSnapBusy] = useState(false)

  const loadSnaps = async () => {
    try {
      const { data } = await api.get('/tgletbot/miniapp/snapshots')
      if (data.success) setSnaps(data.snapshots || [])
    } catch { setSnaps([]) }
  }
  const openSnaps = () => { haptic('light'); setSnaps(null); setSnapsOpen(true); loadSnaps() }
  const saveSnap = async () => {
    if (snapBusy) return
    haptic('medium'); setSnapBusy(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/snapshots/save', {})
      if (data.success) { showToast('Макет сохранён ✅'); loadSnaps() }
    } catch (err) { showToast(errMsg(err), 'error') } finally { setSnapBusy(false) }
  }
  const restoreSnap = async (id) => {
    if (snapBusy) return
    haptic('medium'); setSnapBusy(true)
    try {
      const { data } = await api.post(`/tgletbot/miniapp/snapshots/${id}/restore`)
      if (data.success) { showToast('Макет применён ✅ Текущий сохранён на всякий случай.'); loadSnaps(); refreshBot({ silent: true }) }
    } catch (err) { showToast(errMsg(err), 'error') } finally { setSnapBusy(false) }
  }
  const deleteSnap = async (id) => {
    haptic('light'); setSnapBusy(true)
    try {
      const { data } = await api.delete(`/tgletbot/miniapp/snapshots/${id}`)
      if (data.success) loadSnaps()
    } catch (err) { showToast(errMsg(err), 'error') } finally { setSnapBusy(false) }
  }
  const fmtSnapDate = (d) => new Date(d).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  // ── Магазин макетов (маркетплейс) ─────────────────────────────
  const [marketOpen, setMarketOpen] = useState(false)
  const [mine, setMine] = useState(null)
  const [mktBusy, setMktBusy] = useState(false)
  const [code, setCode] = useState('')
  const [found, setFound] = useState(null) // результат lookup
  const [pubForm, setPubForm] = useState({ title: '', description: '', price: '', category: 'other' })
  const [pending, setPending] = useState(null) // модерация

  const loadMine = async () => {
    try { const { data } = await api.get('/tgletbot/miniapp/templates/mine'); if (data.success) setMine(data) } catch { setMine({ published: [], purchases: [] }) }
  }
  const openMarket = () => { haptic('light'); setMine(null); setFound(null); setCode(''); setPending(null); setMarketOpen(true); loadMine() }
  const lookup = async () => {
    const c = code.trim().toUpperCase()
    if (!c || mktBusy) return
    haptic('light'); setMktBusy(true); setFound(null)
    try {
      const { data } = await api.get(`/tgletbot/miniapp/templates/lookup/${encodeURIComponent(c)}`)
      if (data.success) setFound(data.template)
    } catch (err) { showToast(errMsg(err, 'Макет с таким кодом не найден.'), 'error') } finally { setMktBusy(false) }
  }
  const buy = async () => {
    if (mktBusy || !found) return
    haptic('medium'); setMktBusy(true)
    try {
      const { data } = await api.post(`/tgletbot/miniapp/templates/${found.code}/buy`)
      if (data.owned) { showToast('Макет доступен ✅'); setFound({ ...found, owned: true }) }
      else if (data.url) { showToast('Открываю оплату…'); if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(data.url); else window.open(data.url, '_blank') }
    } catch (err) { showToast(errMsg(err), 'error') } finally { setMktBusy(false) }
  }
  const applyTpl = async () => {
    if (mktBusy || !found) return
    haptic('medium'); setMktBusy(true)
    try {
      const { data } = await api.post(`/tgletbot/miniapp/templates/${found.code}/apply`)
      if (data.success) { showToast('Макет применён ✅ Старый сохранён в «Макеты».'); setMarketOpen(false); refreshBot({ silent: true }) }
    } catch (err) { showToast(errMsg(err), 'error') } finally { setMktBusy(false) }
  }
  const publish = async () => {
    if (mktBusy || !pubForm.title.trim()) return
    haptic('medium'); setMktBusy(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/templates/publish', {
        title: pubForm.title, description: pubForm.description, price: Number(pubForm.price) || 0, category: pubForm.category,
      })
      if (data.success) { showToast('Отправлено на модерацию ✅'); setPubForm({ title: '', description: '', price: '', category: 'other' }); loadMine() }
    } catch (err) { showToast(errMsg(err), 'error') } finally { setMktBusy(false) }
  }
  const loadPending = async () => {
    try { const { data } = await api.get('/tgletbot/miniapp/templates/admin/pending'); if (data.success) setPending(data.templates) } catch { setPending([]) }
  }
  const moderate = async (id, action, note) => {
    haptic('medium'); setMktBusy(true)
    try {
      await api.post(`/tgletbot/miniapp/templates/admin/${id}/${action}`, note ? { note } : {})
      showToast(action === 'approve' ? 'Одобрено и опубликовано ✅' : 'Отклонено'); loadPending()
    } catch (err) { showToast(errMsg(err), 'error') } finally { setMktBusy(false) }
  }
  const STATUS_RU = { pending: 'на модерации', approved: 'опубликован', rejected: 'отклонён', delisted: 'снят' }

  const status = bot?.status || 'absent'
  const isAbsent = status === 'absent'
  const isOnline = status === 'online'
  const stats = bot?.stats || { totalUsers: 0, requestsToday: 0, aiProcessed: 0 }
  const funnelBot = account?.botUsername || 'AI_ConstructorBot'

  const remaining = Math.max(0, Math.ceil((coolUntil - now) / 1000))
  const cooling = remaining > 0

  // Тикаем секундами, пока идёт КД; останавливаемся по истечении.
  useEffect(() => {
    if (Date.now() >= coolUntil) return
    const id = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= coolUntil) clearInterval(id)
    }, 250)
    return () => clearInterval(id)
  }, [coolUntil])

  // Действие питания: гасим спам во время КД, иначе шлём на сервер и запускаем КД.
  const power = (action) => async () => {
    if (Date.now() < coolUntil || busy) {
      haptic('rigid') // короткий «нельзя» — клик проигнорирован
      return
    }
    haptic('medium')
    setBusy(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/bot/power', { action })
      if (data.success) {
        setCoolUntil(Date.now() + POWER_COOLDOWN_MS)
        showToast(
          action === 'stop' ? 'Бот остановлен' : action === 'restart' ? 'Бот перезагружен ✅' : 'Бот запущен ✅'
        )
        refreshBot({ silent: true })
      }
    } catch (err) {
      showToast(errMsg(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const openBot = () => {
    haptic('light')
    if (bot?.username) openTelegramLink(`https://telegram.me/${bot.username}`)
  }

  // Создание бота происходит в чате с конструктором — ведём туда.
  const createBot = () => {
    haptic('medium')
    openTelegramLink(`https://telegram.me/${funnelBot}`)
  }

  const doDelete = async () => {
    if (deleting) return
    haptic('medium')
    setDeleting(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/bot/delete')
      if (data.success) {
        setConfirmDelete(false)
        showToast('Бот и его данные удалены')
        refreshBot({ silent: true })
      }
    } catch (err) {
      showToast(errMsg(err), 'error')
    } finally {
      setDeleting(false)
    }
  }

  if (botLoading && !bot) {
    return (
      <>
        <ScreenHero title="Бот" subtitle="Загружаю…" robotSrc={STATUS_ART.absent} robotVariant="status" />
        <div className="screen-body"><div className="spinner" /></div>
      </>
    )
  }

  return (
    <>
      <ScreenHero
        title={isAbsent ? 'Бот' : (bot?.name || 'Мой бот')}
        subtitle={isAbsent ? 'Ещё не создан' : `@${bot?.username || ''}`}
        robotSrc={STATUS_ART[status]}
        robotVariant="status"
      />

      <div className="screen-body">
        {isAbsent ? (
          <Card className="bot-empty">
            <Sparkles size={26} className="bot-empty__icon" />
            <p className="bot-empty__text">
              Опиши задачу промтом в чате с @{funnelBot} — и мы соберём и захостим бота за пару минут.
            </p>
            <button className="btn btn--primary" onClick={createBot}>
              <Plus size={18} />
              Создать бота
            </button>
          </Card>
        ) : (
          <>
            <Card className="bot-panel">
              <div className="stat-row">
                <div className="stat-row__item">
                  <span className="stat-row__icon"><Users size={16} /></span>
                  <span className="stat-row__value">
                    {(stats.totalUsers || 0).toLocaleString('ru-RU')}
                  </span>
                  <span className="stat-row__label">Пользователей</span>
                </div>
                <div className="stat-row__item">
                  <span className="stat-row__icon"><Activity size={16} /></span>
                  <span className="stat-row__value">{stats.requestsToday || 0}</span>
                  <span className="stat-row__label">Запросов сегодня</span>
                </div>
                <div className="stat-row__item">
                  <span className="stat-row__icon"><Sparkles size={16} /></span>
                  <span className="stat-row__value">
                    {stats.aiProcessed >= 1000 ? `${(stats.aiProcessed / 1000).toFixed(1)}k` : (stats.aiProcessed || 0)}
                  </span>
                  <span className="stat-row__label">Обработано AI</span>
                </div>
              </div>

              <div className="bot-panel__divider" />

              <div className="ctrl-row">
                {isOnline ? (
                  <button
                    className="ctrl-row__btn ctrl-row__btn--danger"
                    onClick={power('stop')}
                    disabled={cooling || busy}
                  >
                    <Square size={19} />
                    <span>{cooling ? `${remaining} с` : 'Остановить'}</span>
                    {cooling && (
                      <span className="ctrl-row__cd" style={{ animationDuration: `${POWER_COOLDOWN_MS}ms` }} />
                    )}
                  </button>
                ) : (
                  <button
                    className="ctrl-row__btn ctrl-row__btn--success"
                    onClick={power('start')}
                    disabled={cooling || busy}
                  >
                    <Play size={19} />
                    <span>{cooling ? `${remaining} с` : 'Запустить'}</span>
                    {cooling && (
                      <span className="ctrl-row__cd" style={{ animationDuration: `${POWER_COOLDOWN_MS}ms` }} />
                    )}
                  </button>
                )}
                <button className="ctrl-row__btn" onClick={power('restart')} disabled={cooling || busy}>
                  <RotateCw size={19} />
                  <span>{cooling ? `${remaining} с` : 'Перезагрузить'}</span>
                  {cooling && (
                    <span className="ctrl-row__cd" style={{ animationDuration: `${POWER_COOLDOWN_MS}ms` }} />
                  )}
                </button>
                <button className="ctrl-row__btn ctrl-row__btn--accent" onClick={openBot}>
                  <ExternalLink size={19} />
                  <span>Открыть</span>
                </button>
              </div>
            </Card>

            <Card className="bot-actions">
              <button className="bot-action" onClick={openSnaps}>
                <span className="bot-action__icon">
                  <Layers size={18} />
                </span>
                <span className="bot-action__text">
                  <span className="bot-action__label">Макеты бота</span>
                  <span className="bot-action__sub">Сохранить текущий или вернуться к прошлому</span>
                </span>
                <ChevronRight size={18} className="bot-action__chevron" />
              </button>
              <button className="bot-action" onClick={openMarket}>
                <span className="bot-action__icon">
                  <Store size={18} />
                </span>
                <span className="bot-action__text">
                  <span className="bot-action__label">Магазин макетов</span>
                  <span className="bot-action__sub">Установить готовый макет по коду или продать свой</span>
                </span>
                <ChevronRight size={18} className="bot-action__chevron" />
              </button>
              <button className="bot-action bot-action--danger" onClick={() => { haptic('light'); setConfirmDelete(true) }}>
                <span className="bot-action__icon">
                  <Trash2 size={18} />
                </span>
                <span className="bot-action__text">
                  <span className="bot-action__label">Удалить бота</span>
                  <span className="bot-action__sub">Безвозвратно удалить бота и данные</span>
                </span>
                <ChevronRight size={18} className="bot-action__chevron" />
              </button>
            </Card>
          </>
        )}
      </div>

      <Modal open={marketOpen} onClose={() => setMarketOpen(false)} title="Магазин макетов">
        <div className="stack">
          {/* Установить по коду */}
          <span className="plan-section">Установить макет по коду</span>
          <div className="promo__field">
            <input className="promo__input" placeholder="Например SHOP-A7F3" value={code}
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') lookup() }} />
            <button className="promo__apply" disabled={!code.trim() || mktBusy} onClick={lookup}>Найти</button>
          </div>
          {found && (
            <div className="tpl-card">
              <span className="tpl-card__title">{found.title}</span>
              {found.description && <span className="tpl-card__desc">{found.description}</span>}
              <span className="tpl-card__meta">
                <Tag size={13} /> {found.price > 0 ? `${found.price.toLocaleString('ru-RU')} ₽` : 'Бесплатно'} · {found.commands} команд · куплен {found.sales} раз
              </span>
              {found.owned ? (
                <button className="btn btn--primary" disabled={mktBusy} onClick={applyTpl}>
                  <Check size={17} /> Применить к моему боту
                </button>
              ) : (
                <button className="btn btn--primary" disabled={mktBusy} onClick={buy}>
                  <Tag size={17} /> Купить за {found.price.toLocaleString('ru-RU')} ₽
                </button>
              )}
              <p className="db-hint db-hint--muted">При применении текущий макет сохранится в «Макеты» — вернуться можно в любой момент.</p>
            </div>
          )}

          {/* Опубликовать свой */}
          <span className="plan-section">Продать свой макет</span>
          <p className="db-hint">Опубликуй текущего бота как макет. После модерации он попадёт в канал, а с каждой продажи ты получаешь {mine ? Math.round((1 - (mine.commission || 0.3)) * 100) : 70}%.</p>
          <div className="db-form">
            <input className="db-input" placeholder="Название макета" value={pubForm.title} onChange={(e) => setPubForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="db-form">
            <textarea className="db-compose__input" rows={2} placeholder="Краткое описание" value={pubForm.description} onChange={(e) => setPubForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="grid-2">
            <input className="db-input" type="number" placeholder="Цена, ₽ (0 — бесплатно)" value={pubForm.price} onChange={(e) => setPubForm((f) => ({ ...f, price: e.target.value }))} />
            <select className="db-select" value={pubForm.category} onChange={(e) => setPubForm((f) => ({ ...f, category: e.target.value }))}>
              <option value="ecommerce">Магазин</option>
              <option value="restaurant">Еда/доставка</option>
              <option value="booking">Запись/услуги</option>
              <option value="other">Другое</option>
            </select>
          </div>
          <button className="btn btn--primary" disabled={mktBusy || !pubForm.title.trim()} onClick={publish}>
            <Upload size={17} /> Отправить на модерацию
          </button>

          {/* Мои макеты и покупки */}
          {mine && (mine.published.length > 0 || mine.purchases.length > 0) && (
            <>
              <span className="plan-section">Мои макеты</span>
              {mine.published.map((t) => (
                <div key={t.id} className="snap-item">
                  <span className="snap-item__main">
                    <span className="snap-item__name">{t.title}</span>
                    <span className="snap-item__meta">{t.code} · {STATUS_RU[t.status] || t.status} · продаж: {t.sales}</span>
                  </span>
                </div>
              ))}
              {mine.purchases.map((p, i) => (
                <div key={`p${i}`} className="snap-item">
                  <span className="snap-item__main">
                    <span className="snap-item__name">Куплен: {p.code}</span>
                    <span className="snap-item__meta">{p.amount > 0 ? `${p.amount.toLocaleString('ru-RU')} ₽` : 'бесплатно'}</span>
                  </span>
                </div>
              ))}
            </>
          )}

          {/* Модерация (только модератору) */}
          {mine?.isModerator && (
            <>
              <span className="plan-section">Модерация</span>
              {pending === null ? (
                <button className="btn btn--ghost" onClick={loadPending}>Загрузить очередь</button>
              ) : pending.length === 0 ? (
                <p className="db-hint db-hint--muted">Очередь пуста.</p>
              ) : pending.map((t) => (
                <div key={t.id} className="tpl-card">
                  <span className="tpl-card__title">{t.title}</span>
                  {t.description && <span className="tpl-card__desc">{t.description}</span>}
                  <span className="tpl-card__meta"><Tag size={13} /> {t.price > 0 ? `${t.price} ₽` : 'Бесплатно'} · {t.commands} команд · {t.code}</span>
                  <div className="grid-2">
                    <button className="btn btn--primary" disabled={mktBusy} onClick={() => moderate(t.id, 'approve')}><Check size={16} /> Одобрить</button>
                    <button className="btn btn--danger-solid" disabled={mktBusy} onClick={() => moderate(t.id, 'reject', 'Не соответствует правилам')}><X size={16} /> Отклонить</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </Modal>

      <Modal open={snapsOpen} onClose={() => setSnapsOpen(false)} title="Макеты бота">
        <div className="stack">
          <p className="db-hint">
            Макет — это структура и поведение бота (меню, команды, тексты). Данные («Мои данные») он не трогает.
            Сохрани текущий макет, чтобы в любой момент к нему вернуться.
          </p>
          <button className="btn btn--primary" disabled={snapBusy} onClick={saveSnap}>
            <Save size={18} />
            {snapBusy ? 'Секунду…' : 'Сохранить текущий макет'}
          </button>

          {snaps === null ? (
            <div className="spinner spinner--sm" style={{ margin: '18px auto' }} />
          ) : snaps.length === 0 ? (
            <p className="db-hint db-hint--muted">Сохранённых макетов пока нет.</p>
          ) : (
            <div className="snap-list">
              {snaps.map((s) => (
                <div key={s.id} className="snap-item">
                  <span className="snap-item__main">
                    <span className="snap-item__name">
                      {s.name}
                      {s.source === 'auto' && <span className="snap-item__auto">авто</span>}
                    </span>
                    <span className="snap-item__meta">{s.commands} команд · {fmtSnapDate(s.createdAt)}</span>
                  </span>
                  <span className="snap-item__actions">
                    <button className="db-headtools__btn" disabled={snapBusy} onClick={() => restoreSnap(s.id)} title="Применить макет" aria-label="Применить">
                      <RotateCcw size={16} />
                    </button>
                    <button className="db-headtools__btn db-rectools__btn--del" disabled={snapBusy} onClick={() => deleteSnap(s.id)} title="Удалить" aria-label="Удалить">
                      <Trash2 size={15} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="db-hint db-hint--muted">
            При применении макета текущий автоматически сохраняется — так что откат всегда можно отменить.
          </p>
        </div>
      </Modal>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Удалить бота?">
        <p className="confirm__text">
          Бот, его настройки и все данные («Мои данные», синхронизации) будут удалены без
          возможности восстановления. Внешние Google-таблицы и базы не пострадают.
        </p>
        <div className="confirm__actions">
          <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
            Отмена
          </button>
          <button className="btn btn--danger-solid" disabled={deleting} onClick={doDelete}>
            {deleting ? 'Удаляю…' : 'Удалить бота'}
          </button>
        </div>
      </Modal>
    </>
  )
}
