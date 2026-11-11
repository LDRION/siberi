import { useCallback, useEffect, useState } from 'react'
import { Truck, CreditCard, Copy, Check, Loader2, Info, Crown, Wallet, Zap, Bot, RotateCcw, Users, UserPlus, Trash2, ShieldCheck } from 'lucide-react'
import { SectionTitle, Toggle } from '../components/ui.jsx'
import ScreenHero from '../components/ScreenHero.jsx'
import { api, errMsg } from '../api.js'
import { useApp } from '../store.js'
import { haptic, closeApp } from '../telegram.js'
import './FeaturesScreen.css'

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

// Строка дней "Пн,Вт,..." ↔ множество.
const parseDays = (s) => new Set(String(s || '').split(/[,;\s]+/).map((d) => d.trim().slice(0, 2)).filter(Boolean))
const joinDays = (set) => DAYS.filter((d) => set.has(d)).join(',')

function Field({ label, hint, children }) {
  return (
    <label className="feat-field">
      <span className="feat-field__label">{label}</span>
      {children}
      {hint && <span className="feat-field__hint">{hint}</span>}
    </label>
  )
}

export default function FeaturesScreen() {
  const { showToast } = useApp()
  const [section, setSection] = useState('delivery') // 'delivery' | 'payments'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [hasBot, setHasBot] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingPaid, setSavingPaid] = useState(false)
  const [copied, setCopied] = useState(false)
  const [d, setD] = useState(null)          // конфиг доставки
  const [p, setP] = useState(null)          // конфиг монетизации
  const [payment, setPayment] = useState({ botLive: false, url: '' })

  // ── Админы ────────────────────────────────────────────────────────────────
  const [admins, setAdmins] = useState(null)     // null — ещё не грузили
  const [candidates, setCandidates] = useState([])
  const [adminsLoading, setAdminsLoading] = useState(false)
  const [uname, setUname] = useState('')
  const [adding, setAdding] = useState(false)

  const loadAdmins = useCallback(() => {
    setAdminsLoading(true)
    api.get('/tgletbot/miniapp/admins')
      .then(({ data }) => {
        if (data.success) { setAdmins(data.admins || []); setCandidates(data.candidates || []) }
      })
      .catch(() => {})
      .finally(() => setAdminsLoading(false))
  }, [])

  const addAdmin = async () => {
    const name = uname.replace(/^@+/, '').trim()
    if (!name) return
    // Если ввели того, кто уже в подсказках — добавим сразу по его id (надёжнее).
    const cand = candidates.find((c) => (c.username || '').toLowerCase() === name.toLowerCase())
    setAdding(true)
    haptic('medium')
    try {
      const { data } = await api.post('/tgletbot/miniapp/admins', cand
        ? { platformUserId: cand.platformUserId, username: cand.username, displayName: cand.displayName }
        : { username: name })
      if (data.success) {
        setUname('')
        showToast('Админ добавлен ✅')
        loadAdmins()
      } else {
        showToast(data.error || 'Не удалось добавить', 'error')
      }
    } catch (e) {
      showToast(errMsg(e), 'error')
    } finally {
      setAdding(false)
    }
  }

  const toggleRights = async (a) => {
    haptic('light')
    const next = !a.fullRights
    setAdmins((prev) => prev.map((x) => (x.id === a.id ? { ...x, fullRights: next } : x)))
    try {
      const { data } = await api.patch(`/tgletbot/miniapp/admins/${a.id}`, { fullRights: next })
      if (!data.success) throw new Error()
    } catch {
      setAdmins((prev) => prev.map((x) => (x.id === a.id ? { ...x, fullRights: !next } : x)))
      showToast('Не удалось изменить', 'error')
    }
  }

  const removeAdmin = async (a) => {
    haptic('medium')
    setAdmins((prev) => prev.filter((x) => x.id !== a.id))
    try {
      await api.delete(`/tgletbot/miniapp/admins/${a.id}`)
      loadAdmins() // вернём его в подсказки
    } catch {
      showToast('Не удалось удалить', 'error')
      loadAdmins()
    }
  }

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    api.get('/tgletbot/miniapp/features')
      .then(({ data }) => {
        if (!data.success) { setError(true); return }
        setHasBot(data.hasBot !== false) // без бота — покажем заглушку, а не форму
        setD(data.delivery)
        setP(data.paid || null)
        setPayment(data.payment || { botLive: false, url: '' })
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])
  // Грузим админов только когда открыли их вкладку (и один раз).
  useEffect(() => { if (section === 'admins' && admins === null && hasBot) loadAdmins() }, [section, admins, hasBot, loadAdmins])

  const set = (k, v) => setD((prev) => ({ ...prev, [k]: v }))
  const daysSet = parseDays(d?.days)
  const toggleDay = (day) => {
    haptic('light')
    const next = new Set(daysSet)
    next.has(day) ? next.delete(day) : next.add(day)
    set('days', joinDays(next))
  }

  const save = async () => {
    setSaving(true)
    haptic('medium')
    try {
      const { data } = await api.post('/tgletbot/miniapp/delivery', d)
      if (data.success) { setD(data.delivery); showToast('Сохранено ✅') }
      else showToast('Не удалось сохранить', 'error')
    } catch (e) {
      showToast(errMsg(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const setPaid = (k, v) => setP((prev) => ({ ...prev, [k]: v }))
  const savePaid = async () => {
    setSavingPaid(true)
    haptic('medium')
    try {
      const { data } = await api.post('/tgletbot/miniapp/paid', p)
      if (data.success) { setP(data.paid); showToast('Сохранено ✅') }
      else showToast('Не удалось сохранить', 'error')
    } catch (e) {
      showToast(errMsg(e), 'error')
    } finally {
      setSavingPaid(false)
    }
  }

  const copyUrl = async () => {
    haptic('light')
    try { await navigator.clipboard.writeText(payment.url) } catch { /* clipboard может быть недоступен */ }
    setCopied(true)
    showToast('Адрес скопирован')
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <>
      <ScreenHero eyebrow="Особые функции" />
      <div className="screen-body feat-body">
        {loading ? (
          <div className="feat-loading"><Loader2 size={26} className="spin" /></div>
        ) : error ? (
          <div className="feat-empty">
            <span className="feat-empty__icon"><Info size={30} /></span>
            <p className="feat-empty__title">Не удалось загрузить</p>
            <p className="feat-empty__text">Проверьте связь и попробуйте ещё раз.</p>
            <button className="feat-empty__btn" type="button" onClick={() => { haptic('light'); load() }}>
              <RotateCcw size={17} /> Повторить
            </button>
          </div>
        ) : !hasBot ? (
          <div className="feat-empty feat-empty--ok">
            <span className="feat-empty__icon"><Bot size={30} /></span>
            <p className="feat-empty__title">Сначала создайте бота 🙂</p>
            <p className="feat-empty__text">Здесь настраиваются доставка и приём оплаты вашего бота. Закройте приложение и создайте бота прямо в чате — просто напишите конструктору, какой бот вам нужен. Как бот появится, эти функции откроются тут.</p>
            <button className="feat-empty__btn" type="button" onClick={() => { haptic('medium'); closeApp() }}>
              Закрыть и создать бота
            </button>
          </div>
        ) : !d ? (
          <div className="feat-loading"><Loader2 size={26} className="spin" /></div>
        ) : (
          <>
            {/* ── Верхние под-вкладки ──────────────────────────────── */}
            <div className="feat-tabs">
              <button type="button" className={`feat-tab ${section === 'delivery' ? 'is-active' : ''}`} onClick={() => { haptic('light'); setSection('delivery') }}>
                <Truck size={17} /> Доставка
              </button>
              <button type="button" className={`feat-tab ${section === 'payments' ? 'is-active' : ''}`} onClick={() => { haptic('light'); setSection('payments') }}>
                <CreditCard size={17} /> Платежи
              </button>
              <button type="button" className={`feat-tab ${section === 'admins' ? 'is-active' : ''}`} onClick={() => { haptic('light'); setSection('admins') }}>
                <Users size={17} /> Админы
              </button>
            </div>

            {section === 'delivery' && (
            <>
            {/* ── Доставка ─────────────────────────────────────────── */}
            <div className="feat-card">
              <div className="feat-row feat-row--toggle">
                <span className="feat-row__lead"><Truck size={18} /> Доставка включена</span>
                <Toggle checked={!!d.enabled} onChange={(v) => set('enabled', v)} />
              </div>

              {d.enabled && (
                <>
                  <Field label="Дни доставки">
                    <div className="feat-days">
                      {DAYS.map((day) => (
                        <button
                          key={day}
                          type="button"
                          className={`feat-day ${daysSet.has(day) ? 'is-on' : ''}`}
                          onClick={() => toggleDay(day)}
                        >{day}</button>
                      ))}
                    </div>
                  </Field>

                  <div className="feat-grid2">
                    <Field label="Доставка с">
                      <input className="feat-input" value={d.hours_from || ''} onChange={(e) => set('hours_from', e.target.value)} placeholder="10:00" inputMode="numeric" />
                    </Field>
                    <Field label="Доставка до">
                      <input className="feat-input" value={d.hours_to || ''} onChange={(e) => set('hours_to', e.target.value)} placeholder="22:00" inputMode="numeric" />
                    </Field>
                  </div>

                  <div className="feat-row feat-row--toggle">
                    <span className="feat-row__lead">Разрешить самовывоз</span>
                    <Toggle checked={!!d.pickup} onChange={(v) => set('pickup', v)} />
                  </div>

                  <div className="feat-grid2">
                    <Field label="Стоимость, ₽">
                      <input className="feat-input" type="number" value={d.cost ?? 0} onChange={(e) => set('cost', e.target.value)} />
                    </Field>
                    <Field label="Бесплатно от, ₽" hint="0 — выключено">
                      <input className="feat-input" type="number" value={d.free_from ?? 0} onChange={(e) => set('free_from', e.target.value)} />
                    </Field>
                  </div>

                  <Field label="Минимальная сумма заказа, ₽" hint="0 — без ограничения">
                    <input className="feat-input" type="number" value={d.min_order ?? 0} onChange={(e) => set('min_order', e.target.value)} />
                  </Field>

                  <Field label="Условия / зоны доставки" hint="Показывается клиенту при оформлении">
                    <textarea className="feat-input feat-textarea" rows={2} value={d.zone_text || ''} onChange={(e) => set('zone_text', e.target.value)} placeholder="Например: доставляем по центру и Кировскому району" />
                  </Field>

                  <Field label="Ссылка на карту зон (Яндекс)">
                    <input className="feat-input" value={d.zone_map_url || ''} onChange={(e) => set('zone_map_url', e.target.value)} placeholder="https://yandex.ru/maps/..." />
                  </Field>

                  <Field label="Yandex Geocoder API-ключ" hint="Необязательно. Нужен только для авто-проверки адреса по зоне.">
                    <input className="feat-input" value={d.yandex_api_key || ''} onChange={(e) => set('yandex_api_key', e.target.value)} placeholder="—" />
                  </Field>

                  <Field label="Часовой пояс (сдвиг от UTC)" hint="3 = МСК, 4 = Самара">
                    <input className="feat-input" type="number" value={d.tz_offset ?? 3} onChange={(e) => set('tz_offset', e.target.value)} />
                  </Field>
                </>
              )}
            </div>

            <button className="feat-save" type="button" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={18} className="spin" /> : <Check size={18} />}
              Сохранить
            </button>
            </>
            )}

            {section === 'payments' && p && (
            <>
              {/* 1. Приём оплаты от клиентов + кошелёк */}
              <SectionTitle>Приём оплаты от клиентов</SectionTitle>
              <div className="feat-card">
                <div className="feat-row feat-row--toggle">
                  <span className="feat-row__lead"><Wallet size={18} /> Принимать оплату в боте</span>
                  <Toggle checked={!!p.enabled} onChange={(v) => setPaid('enabled', v)} />
                </div>
                {p.enabled && (
                  <Field label="Номер кошелька ЮMoney" hint="Куда клиенты платят. Пример: 4100 1234 5678 90">
                    <input className="feat-input" value={p.yoomoney_wallet || ''} onChange={(e) => setPaid('yoomoney_wallet', e.target.value)} placeholder="4100…" inputMode="numeric" />
                  </Field>
                )}
              </div>

              {/* 2. Адрес вебхука (чтобы мы узнавали об оплатах) */}
              {p.enabled && (
                <div className="feat-card">
                  {payment.botLive ? (
                    <>
                      <p className="feat-note">
                        <Info size={14} /> Вставьте этот адрес в раздел «HTTP-уведомления» / «Webhook» в настройках ЮMoney — так бот узнаёт об оплатах и сам выдаёт клиенту купленное.
                      </p>
                      <div className="feat-url" onClick={copyUrl}>
                        <span className="feat-url__text">{payment.url}</span>
                        <span className="feat-url__copy">{copied ? <Check size={16} /> : <Copy size={16} />}</span>
                      </div>
                      <p className="feat-warn"><Info size={14} /> Не показывайте адрес посторонним — в нём секретный ключ.</p>
                    </>
                  ) : (
                    <p className="feat-note">
                      <CreditCard size={16} /> Запустите бота (вкладка «Бот» → «Завершить создание»), и здесь появится адрес для приёма платежей.
                    </p>
                  )}
                </div>
              )}

              {/* 3. Премиум-доступ */}
              {p.enabled && (
                <>
                  <SectionTitle>Премиум-доступ</SectionTitle>
                  <div className="feat-card">
                    <div className="feat-row feat-row--toggle">
                      <span className="feat-row__lead"><Crown size={18} /> Продавать премиум</span>
                      <Toggle checked={!!p.premium_enabled} onChange={(v) => setPaid('premium_enabled', v)} />
                    </div>
                    {p.premium_enabled && (
                      <>
                        <div className="feat-grid2">
                          <Field label="Название">
                            <input className="feat-input" value={p.premium_title || ''} onChange={(e) => setPaid('premium_title', e.target.value)} placeholder="Премиум" />
                          </Field>
                          <Field label="Цена, ₽">
                            <input className="feat-input" type="number" value={p.premium_price ?? 0} onChange={(e) => setPaid('premium_price', e.target.value)} />
                          </Field>
                        </div>
                        <Field label="Срок, дней" hint="0 — доступ навсегда, иначе подписка на N дней">
                          <input className="feat-input" type="number" value={p.premium_days ?? 0} onChange={(e) => setPaid('premium_days', e.target.value)} />
                        </Field>
                        <Field label="Что даёт премиум">
                          <textarea className="feat-input feat-textarea" rows={2} value={p.premium_desc || ''} onChange={(e) => setPaid('premium_desc', e.target.value)} placeholder="Доступ к закрытым разделам, безлимитные ИИ-ответы и т.п." />
                        </Field>
                        <Field label="Сообщение после оплаты">
                          <input className="feat-input" value={p.success_text || ''} onChange={(e) => setPaid('success_text', e.target.value)} placeholder="Оплата получена — доступ открыт!" />
                        </Field>
                      </>
                    )}
                  </div>

                  {/* 4. ИИ-ответы по подписке (фримиум) */}
                  <div className="feat-card">
                    <div className="feat-row feat-row--toggle">
                      <span className="feat-row__lead"><Zap size={18} /> ИИ-ответы только по премиуму</span>
                      <Toggle checked={!!p.gate_ai} onChange={(v) => setPaid('gate_ai', v)} />
                    </div>
                    {p.gate_ai && (
                      <Field label="Сколько ИИ-ответов бесплатно" hint="Потом — только с премиумом. 0 — премиум сразу, без бесплатных.">
                        <input className="feat-input" type="number" value={p.free_ai_uses ?? 0} onChange={(e) => setPaid('free_ai_uses', e.target.value)} />
                      </Field>
                    )}
                  </div>

                  <p className="feat-note" style={{ padding: '4px 4px 0' }}>
                    <Info size={14} /> Что именно закрыть за премиум — проще сказать конструктору словами: «сделай раздел X только для премиума», «ИИ-ответы по подписке, 3 бесплатно». Платные товары/файлы — в «База» → «Платные товары».
                  </p>
                </>
              )}

              <button className="feat-save" type="button" onClick={savePaid} disabled={savingPaid}>
                {savingPaid ? <Loader2 size={18} className="spin" /> : <Check size={18} />}
                Сохранить
              </button>
            </>
            )}

            {section === 'admins' && (
            <>
              {/* Панель добавления по @username */}
              <SectionTitle>Добавить администратора</SectionTitle>
              <div className="feat-card">
                <div className="adm-add">
                  <div className="adm-add__input">
                    <span className="adm-add__at">@</span>
                    <input
                      className="feat-input adm-add__field"
                      value={uname}
                      onChange={(e) => setUname(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addAdmin() }}
                      placeholder="username"
                      list="adm-candidates"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <datalist id="adm-candidates">
                      {candidates.filter((c) => c.username).map((c) => (
                        <option key={c.platformUserId} value={c.username}>{c.displayName || `@${c.username}`}</option>
                      ))}
                    </datalist>
                  </div>
                  <button className="adm-add__btn" type="button" onClick={addAdmin} disabled={adding || !uname.trim()}>
                    {adding ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />}
                    Добавить
                  </button>
                </div>
                <p className="feat-field__hint" style={{ marginTop: 8 }}>
                  Человек появится в списке, только если хотя бы раз писал вашему боту или конструктору (нажимал /start). Начните вводить — подскажем из тех, кто уже писал.
                </p>
              </div>

              {/* Список администраторов */}
              <SectionTitle>Администраторы</SectionTitle>
              {adminsLoading && admins === null ? (
                <div className="feat-loading"><Loader2 size={22} className="spin" /></div>
              ) : (admins && admins.length > 0) ? (
                <div className="feat-card feat-card--flush">
                  {admins.map((a) => (
                    <div className="adm-item" key={a.id}>
                      <div className="adm-item__main">
                        <span className="adm-item__name">{a.displayName || (a.username ? `@${a.username}` : `id ${a.platformUserId}`)}</span>
                        {a.username && a.displayName && <span className="adm-item__uname">@{a.username}</span>}
                        <span className={`adm-item__badge ${a.fullRights ? 'is-full' : ''}`}>
                          {a.fullRights ? <><ShieldCheck size={12} /> Полные права</> : 'Ограниченный'}
                        </span>
                      </div>
                      <div className="adm-item__actions">
                        <div className="adm-item__toggle" title="Полные права">
                          <Toggle checked={a.fullRights} onChange={() => toggleRights(a)} />
                        </div>
                        <button className="adm-item__del" type="button" onClick={() => removeAdmin(a)} title="Удалить">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="feat-card">
                  <p className="feat-note"><Users size={16} /> Пока нет админов. Добавьте первого по @username сверху.</p>
                </div>
              )}

              <p className="feat-note" style={{ padding: '4px 4px 0' }}>
                <Info size={14} /> <b>Полные права</b> — админ может всё, что и вы (менять бота через ИИ, данные), КРОМЕ удаления бота. Без них — админ получает уведомления о заказах, видит воронку продаж и базу, подтверждает доставки, но ничего не меняет.
              </p>
            </>
            )}
          </>
        )}
      </div>
    </>
  )
}
