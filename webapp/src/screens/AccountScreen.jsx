import { useState, useEffect, lazy, Suspense } from 'react'
import {
  Crown,
  RefreshCw,
  Gift,
  Copy,
  Share2,
  Users,
  UserCheck,
  Percent,
  Wallet,
  ChevronRight,
  Check,
  Info,
  Clock,
} from 'lucide-react'
import { Card, ProgressBar, Toggle } from '../components/ui.jsx'
import ScreenHero from '../components/ScreenHero.jsx'
import Modal from '../components/Modal.jsx'
import LegalSkeleton from '../components/LegalSkeleton.jsx'
import { plans, periods, planTotal, REF_PERCENT, REF_MIN_PAYOUT } from '../plans.js'
import { api, errMsg } from '../api.js'
import { useApp } from '../store.js'
import { haptic, shareLink, tg, openTelegramLink } from '../telegram.js'
import './AccountScreen.css'

// Политику рекуррентных платежей показываем из общего чанка юр-текстов (грузится по клику).
const RecurrentContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.RecurrentContent })))

function subProgress({ startedAt, expiresAt }) {
  const start = new Date(startedAt).getTime()
  const end = new Date(expiresAt).getTime()
  const now = Date.now()
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000))
  const used = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100))
  return { daysLeft, used }
}

const fmtDate = (d) =>
  new Date(d)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\sг\.$/, '')
const fmtPrice = (n) => n.toLocaleString('ru-RU') + ' ₽'

// Тон подписки по остатку дней: ok (синий) → soon (янтарь) → urgent (розовый)
const subTier = (daysLeft) => (daysLeft < 7 ? 'urgent' : daysLeft <= 15 ? 'soon' : 'ok')

// Выбор срока: карточки с встроенным бейджем-скидкой и ценой за месяц
function PeriodPicker({ planId, value, onChange }) {
  return (
    <div className="tperiod">
      {periods.map((p) => {
        const isActive = p.id === value
        const monthly = Math.round(planTotal(planId, p.id) / p.months)
        return (
          <button
            key={p.id}
            className={`tperiod__cell ${isActive ? 'is-active' : ''}`}
            onClick={() => onChange(p.id)}
            type="button"
          >
            {p.discount > 0 && (
              <span className="tperiod__badge">−{Math.round(p.discount * 100)}%</span>
            )}
            <span className="tperiod__label">{p.label}</span>
            <span className="tperiod__price">
              {fmtPrice(monthly)}<span className="tperiod__per">/мес</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

// Итог: цена со скидкой + перечёркнутая цена без скидки (если есть выгода)
function TotalRow({ planId, periodId }) {
  const planObj = plans.find((p) => p.id === planId)
  const periodObj = periods.find((p) => p.id === periodId)
  const total = planTotal(planId, periodId)
  const full = planObj && periodObj ? planObj.price * periodObj.months : 0
  const hasDiscount = periodObj?.discount > 0
  return (
    <div className="plan-total">
      <span className="plan-total__label">Итого</span>
      <span className="plan-total__sums">
        <span className="plan-total__value">{fmtPrice(total)}</span>
        {hasDiscount && <span className="plan-total__old">{fmtPrice(full)}</span>}
      </span>
    </div>
  )
}

export default function AccountScreen() {
  const { account, refreshAccount, tgUser, showToast } = useApp()
  const name = tgUser?.first_name || 'Мой аккаунт'
  const username = tgUser?.username || ''

  const [partnerOpen, setPartnerOpen] = useState(false)
  const [bonusBusy, setBonusBusy] = useState(false)
  const [termsOpen, setTermsOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [wdAmount, setWdAmount] = useState('')
  const [wdDetails, setWdDetails] = useState('')
  const [wdBusy, setWdBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // Автопродление. Включается ТОЛЬКО явным действием + принятием политики
  // (Оферта п. 8.1, Политика рекуррентных платежей п. 2.1). Выключается мгновенно (п. 8.4).
  const [autoRenew, setAutoRenew] = useState(false)
  const [arConsentOpen, setArConsentOpen] = useState(false)
  const [arPolicyOpen, setArPolicyOpen] = useState(false)
  const [arBusy, setArBusy] = useState(false)
  const [plansOpen, setPlansOpen] = useState(false)
  const [plan, setPlan] = useState('premium')
  const [period, setPeriod] = useState('m1')
  const [infoPlan, setInfoPlan] = useState(null) // id тарифа для попапа подробностей
  const [renewOpen, setRenewOpen] = useState(false)
  const [renewPeriod, setRenewPeriod] = useState('m1')
  const [payBusy, setPayBusy] = useState(false)

  const hero = (
    <ScreenHero
      eyebrow="Мой аккаунт"
      title={name}
      subtitle={username ? <span className="account-handle">@{username}</span> : null}
    />
  )

  if (!account) {
    return (
      <>
        {hero}
        <div className="screen-body"><div className="spinner" /></div>
      </>
    )
  }

  const sub = account.subscription
  const ref = account.referral
  // FREE_MODE (сервер отдаёт status:'free'): тарифов нет, доступ бесплатный.
  // Ни цен, ни сроков, ни автопродления — но гейт подписки на канал живёт.
  const isFree = sub.status === 'free'
  const hasSub = sub.status === 'active' || sub.status === 'trial' || isFree
  const isTrial = sub.status === 'trial'
  // У бесплатного доступа нет срока — прогресс/дни не считаем (иначе NaN).
  const { daysLeft, used } = hasSub && !isFree ? subProgress(sub) : { daysLeft: 0, used: 0 }
  const tier = subTier(daysLeft)
  const currentPlanId = sub.plan === 'premium' ? 'premium' : 'standard'
  const currentPlan = plans.find((p) => p.id === currentPlanId)
  const planLabel = isTrial ? 'Пробный период' : (sub.planName || currentPlan?.name)
  const infoPlanData = plans.find((p) => p.id === infoPlan)
  // Активный Premium «вниз» не продаём — сервер такой платёж отбрасывает
  const premiumActive = sub.status === 'active' && sub.plan === 'premium'

  // Бонус +6 дней за подписку на @aicupdates (разово на аккаунт)
  const bonus = account.channelBonus || { canClaim: false, claimed: true }
  const openChannel = () => {
    haptic('light')
    if (bonus.channelUrl) openTelegramLink(bonus.channelUrl)
  }
  const claimBonus = async () => {
    if (bonusBusy) return
    haptic('medium')
    setBonusBusy(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/claim-channel-bonus')
      if (data.success) { showToast(isFree ? 'Готово! Полный доступ открыт 🎉' : `Готово! +${data.bonusDays} дней 🎉`); refreshAccount() }
      else if (data.reason === 'not_subscribed') showToast('Пока не вижу подписку на @aicupdates. Подпишись и попробуй снова.', 'error')
      else if (data.reason === 'claimed') showToast('Бонус уже был получен на этом аккаунте.', 'error')
      else showToast('Не получилось. Попробуй ещё раз.', 'error')
    } catch (e) {
      showToast(errMsg(e), 'error')
    } finally {
      setBonusBusy(false)
    }
  }

  // Создание платёжной ссылки: сумму и label считает сервер, мы только открываем
  const startPay = async (planId, periodId) => {
    if (payBusy) return
    haptic('medium')
    setPayBusy(true)
    try {
      const months = periods.find((p) => p.id === periodId)?.months || 1
      const { data } = await api.post('/tgletbot/miniapp/pay', { plan: planId, months, autoRenew })
      if (data.success && data.url) {
        setPlansOpen(false)
        setRenewOpen(false)
        showToast('Открываю страницу оплаты…')
        if (tg?.openLink) tg.openLink(data.url)
        else window.open(data.url, '_blank', 'noopener')
      }
    } catch (err) {
      showToast(errMsg(err), 'error')
    } finally {
      setPayBusy(false)
    }
  }

  // Синхронизируем тумблер с сервером (источник правды — аккаунт).
  useEffect(() => { setAutoRenew(account?.autoRenew === true) }, [account?.autoRenew])

  const saveAutoRenew = async (value) => {
    if (arBusy) return
    setArBusy(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/autorenew', { enabled: value })
      if (data.success) {
        setAutoRenew(data.autoRenew)
        setArConsentOpen(false)
        showToast(data.autoRenew ? 'Автопродление включено' : 'Автопродление выключено')
        refreshAccount()
      }
    } catch (err) {
      showToast(errMsg(err), 'error')
    } finally {
      setArBusy(false)
    }
  }
  // Включение — сначала показываем согласие с политикой. Выключение — сразу, без вопросов.
  const askAutoRenew = (value) => {
    haptic('light')
    if (value) setArConsentOpen(true)
    else saveAutoRenew(false)
  }

  const openPlans = () => {
    haptic('light')
    setPlan(premiumActive ? 'premium' : (isTrial || !hasSub ? 'premium' : currentPlanId))
    setPeriod('m1')
    setPlansOpen(true)
  }
  const openRenew = () => {
    haptic('light')
    setRenewPeriod('m1')
    setRenewOpen(true)
  }
  const openPartner = () => {
    haptic('light')
    setPartnerOpen(true)
  }
  const openWithdraw = () => {
    haptic('light')
    if (ref.payoutPending) {
      showToast('Запрос на вывод уже в обработке — дождись выплаты.', 'error')
      return
    }
    if ((ref.available || 0) < REF_MIN_PAYOUT) {
      showToast(`Минимальная сумма вывода — ${REF_MIN_PAYOUT.toLocaleString('ru-RU')} ₽`, 'error')
      return
    }
    setWdAmount(String(ref.available))
    setWdDetails('')
    setWithdrawOpen(true)
  }
  const submitWithdraw = async () => {
    if (wdBusy) return
    haptic('medium')
    setWdBusy(true)
    try {
      const { data } = await api.post('/tgletbot/miniapp/referral/withdraw', {
        amount: Number(wdAmount),
        paymentDetails: wdDetails,
      })
      if (data.success) {
        setWithdrawOpen(false)
        showToast('Запрос на вывод отправлен ✅')
        refreshAccount()
      }
    } catch (err) {
      showToast(errMsg(err), 'error')
    } finally {
      setWdBusy(false)
    }
  }
  const copyLink = () => {
    haptic('light')
    navigator.clipboard
      ?.writeText(ref.link)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {})
  }
  // В Telegram — системный шаринг ссылки; вне Telegram — копируем в буфер.
  const shareInvite = () => {
    haptic('medium')
    if (!shareLink(ref.link, 'Собери своего ИИ-бота по моей ссылке 🤖')) {
      copyLink()
    }
  }

  return (
    <>
      {hero}

      <div className="screen-body">
        {/* Единая карточка аккаунта с разделениями */}
        <Card glow className="acc-card">
          {/* Шапка: подписка — единый блок */}
          <div className={`acc-sub ${hasSub ? `acc-sub--${tier}` : 'acc-sub--none'}`}>
            <span className="acc-sub__eyebrow">Ваша подписка</span>

            {isFree ? (
              /* Бесплатный режим: статус без сроков + гейт подписки на канал */
              <>
                <div className="acc-sub__panel">
                  <div className="acc-sub__panel-top">
                    <span className="acc-sub__seg acc-sub__seg--plan">
                      <Crown size={16} className="acc-sub__crown" />
                      Бесплатный доступ
                    </span>
                    <span className="acc-sub__seg acc-sub__seg--state">
                      <span className="acc-sub__state-dot" />
                      активен
                    </span>
                  </div>
                </div>

                {bonus.canClaim ? (
                  <div className="acc-bonus">
                    <p className="acc-bonus__head">📢 <b>Откройте полный доступ</b></p>
                    <p className="acc-bonus__text">Подпишитесь на канал {bonus.channel} — и доступ откроется полностью. Бесплатно.</p>
                    <div className="acc-bonus__btns">
                      <button className="acc-bonus__btn acc-bonus__btn--ghost" onClick={openChannel}>Подписаться</button>
                      <button className="acc-bonus__btn" onClick={claimBonus} disabled={bonusBusy}>
                        {bonusBusy ? 'Проверяю…' : 'Я подписался'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="acc-sub__until">
                    AiConstructor бесплатный для первых 1500 пользователей.<br />
                    Платить не нужно — просто пользуйтесь.
                  </p>
                )}
              </>
            ) : hasSub ? (
              <>
                <div className="acc-sub__panel">
                  <div className="acc-sub__panel-top">
                    <span className="acc-sub__seg acc-sub__seg--plan">
                      <Crown size={16} className="acc-sub__crown" />
                      {planLabel}
                    </span>
                    <span className="acc-sub__seg acc-sub__seg--state">
                      <span className="acc-sub__state-dot" />
                      активна
                    </span>
                  </div>
                  <div className="acc-sub__panel-until">
                    Действует до <b>{fmtDate(sub.expiresAt)}</b>
                  </div>
                </div>

                <div className="acc-sub__bar">
                  <ProgressBar value={used} max={100} tone={tier} />
                  <span className="acc-sub__days">
                    {daysLeft} дн.{isTrial && bonus.canClaim ? <span className="acc-sub__locked"> +{bonus.bonusDays} 🔒</span> : null}
                  </span>
                </div>

                {isTrial && bonus.canClaim && (
                  <div className="acc-bonus">
                    <p className="acc-bonus__head">📢 <b>+{bonus.bonusDays} дней бесплатно</b></p>
                    <p className="acc-bonus__text">Подпишитесь на канал {bonus.channel} — и пробный период продлится до недели.</p>
                    <div className="acc-bonus__btns">
                      <button className="acc-bonus__btn acc-bonus__btn--ghost" onClick={openChannel}>Подписаться</button>
                      <button className="acc-bonus__btn" onClick={claimBonus} disabled={bonusBusy}>
                        {bonusBusy ? 'Проверяю…' : 'Я подписался'}
                      </button>
                    </div>
                  </div>
                )}

                {isTrial && (
                  <>
                    <p className="acc-sub__until">
                      Дальше — от {fmtPrice(1000)}/мес.<br />
                      Оформи тариф, чтобы бот не остановился.
                    </p>
                    <button className="btn btn--primary acc-sub__cta" onClick={openPlans}>
                      <Crown size={18} />
                      Оформить подписку
                    </button>
                  </>
                )}

                {!isTrial && tier === 'urgent' && (
                  <p className="acc-sub__warn">
                    Подписка скоро закончится — не забудьте продлить
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="acc-sub__panel acc-sub__panel--none">
                  <span className="acc-sub__seg acc-sub__seg--plan">
                    <Crown size={16} className="acc-sub__crown acc-sub__crown--off" />
                    Нет подписки
                  </span>
                </div>

                <p className="acc-sub__until">
                  Оформите подписку, чтобы запускать и хостить ботов
                </p>

                <button className="btn btn--primary acc-sub__cta" onClick={openPlans}>
                  <Crown size={18} />
                  Оформить подписку
                </button>
              </>
            )}
          </div>

          {/* Автопродление — по умолчанию выключено, включается только явно (Оферта п. 8.1).
              В бесплатном режиме продлевать нечего — тумблер скрыт. */}
          {!isFree && (
            <>
              <div className="acc-div" />
              <div className="acc-row">
                <span className="acc-row__label">
                  <span className="acc-row__icon"><RefreshCw size={17} /></span>
                  Автопродление
                </span>
                <Toggle checked={autoRenew} onChange={askAutoRenew} />
              </div>
            </>
          )}
          {/* Пояснения под тумблером нет: состояние читается по самому тумблеру,
              а раскрытие условий и ссылка на Политику рекуррентных платежей —
              в модалке подключения (единственный момент, где даётся согласие). */}

          {sub.status === 'active' && (
            <>
              <div className="acc-div" />

              {/* Продлить подписку (текущий тариф) */}
              <button className="acc-row acc-row--btn" onClick={openRenew} type="button">
                <span className="acc-row__label">
                  <span className="acc-row__icon"><RefreshCw size={17} /></span>
                  Продлить подписку
                </span>
                <ChevronRight size={18} className="acc-row__chevron" />
              </button>

              <div className="acc-div" />

              {/* Сменить тарифный план */}
              <button className="acc-row acc-row--btn" onClick={openPlans} type="button">
                <span className="acc-row__label">
                  <span className="acc-row__icon"><Crown size={17} /></span>
                  Тарифный план
                </span>
                <span className="acc-row__right">
                  <span className="acc-row__value">{currentPlan?.name}</span>
                  <ChevronRight size={18} className="acc-row__chevron" />
                </span>
              </button>
            </>
          )}

          <div className="acc-div" />

          {/* Партнёрская программа */}
          <button className="acc-row acc-row--btn" onClick={openPartner} type="button">
            <span className="acc-row__label">
              <span className="acc-row__icon"><Gift size={17} /></span>
              Партнёрская программа
            </span>
            <span className="acc-row__right">
              <span className="acc-row__value">{ref.percent || REF_PERCENT}%</span>
              <ChevronRight size={18} className="acc-row__chevron" />
            </span>
          </button>
        </Card>
      </div>

      {/* Попап: выбор/смена тарифа */}
      <Modal open={plansOpen} onClose={() => setPlansOpen(false)} title="Тарифный план">
        <div className="stack">
          {/* Карточка выбора плана */}
          <div className="tariff-card">
            {plans.map((p) => {
              const isSelected = p.id === plan
              const locked = p.id === 'standard' && premiumActive
              return (
                <div
                  key={p.id}
                  className={`tplan ${isSelected ? 'tplan--selected' : ''}`}
                  style={locked ? { opacity: 0.45 } : undefined}
                  onClick={() => {
                    if (locked) {
                      haptic('rigid')
                      showToast('Сейчас у вас Premium — Standard станет доступен после окончания периода.', 'error')
                      return
                    }
                    haptic('light')
                    setPlan(p.id)
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="tplan__radio">
                    {isSelected && <Check size={13} strokeWidth={3.2} />}
                  </span>
                  <span className="tplan__main">
                    <span className="tplan__name">
                      {p.name}
                      {p.popular && <span className="plan__badge plan__badge--popular">Популярный</span>}
                    </span>
                    <span className="tplan__price">
                      {fmtPrice(p.price)}<span className="plan__price-per">/мес</span>
                    </span>
                  </span>
                  <button
                    className="tplan__info"
                    onClick={(e) => { e.stopPropagation(); haptic('light'); setInfoPlan(p.id) }}
                    aria-label="Подробнее о тарифе"
                    type="button"
                  >
                    <Info size={17} />
                  </button>
                </div>
              )
            })}
          </div>

          <span className="plan-section">Срок подписки</span>
          <PeriodPicker planId={plan} value={period} onChange={(id) => { haptic('light'); setPeriod(id) }} />

          <TotalRow planId={plan} periodId={period} />

          <div className="acc-arpay">
            <span className="acc-arpay__main">
              <span className="acc-arpay__title">Автопродление</span>
              <span className="acc-arpay__sub">Чтобы бот не остановился по окончании срока</span>
            </span>
            <Toggle checked={autoRenew} onChange={askAutoRenew} />
          </div>

          <button className="btn btn--primary" disabled={payBusy} onClick={() => startPay(plan, period)}>
            <Crown size={18} />
            {payBusy ? 'Секунду…' : `Оплатить ${fmtPrice(planTotal(plan, period))}`}
          </button>
          <p className="acc-paynote">
            После оплаты подписка активируется автоматически в течение минуты — бот пришлёт подтверждение в чат.
          </p>
        </div>
      </Modal>

      {/* Попап: продление текущей подписки */}
      <Modal open={renewOpen} onClose={() => setRenewOpen(false)} title="Продление подписки">
        <div className="stack">
          <div className="renew-plan">
            <span className="renew-plan__left">
              <Crown size={16} className="acc-sub__crown" />
              <span className="renew-plan__name">{currentPlan?.name}</span>
            </span>
            <span className="renew-plan__price">
              {fmtPrice(currentPlan?.price || 0)}<span className="plan__price-per">/мес</span>
            </span>
          </div>

          <span className="plan-section">Срок продления</span>
          <PeriodPicker planId={currentPlanId} value={renewPeriod} onChange={(id) => { haptic('light'); setRenewPeriod(id) }} />

          <TotalRow planId={currentPlanId} periodId={renewPeriod} />

          <div className="acc-arpay">
            <span className="acc-arpay__main">
              <span className="acc-arpay__title">Автопродление</span>
              <span className="acc-arpay__sub">Чтобы дальше продлевалось само</span>
            </span>
            <Toggle checked={autoRenew} onChange={askAutoRenew} />
          </div>

          <button className="btn btn--primary" disabled={payBusy} onClick={() => startPay(currentPlanId, renewPeriod)}>
            <RefreshCw size={18} />
            {payBusy ? 'Секунду…' : `Продлить за ${fmtPrice(planTotal(currentPlanId, renewPeriod))}`}
          </button>
          <p className="acc-paynote">
            Оплаченный срок добавится к текущей подписке — ни один день не сгорит.
          </p>
          {/* Согласие на автопродление + сама политика — см. модалки ниже */}
        </div>
      </Modal>

      {/* Попап: подробности тарифа */}
      <Modal open={!!infoPlan} onClose={() => setInfoPlan(null)} title={infoPlanData ? `Тариф ${infoPlanData.name}` : ''}>
        {infoPlanData && (
          <div className="stack">
            <div className="plan-info__price">
              <span className="plan-info__price-val">{fmtPrice(infoPlanData.price)}</span>
              <span className="plan-info__price-per">в месяц</span>
            </div>
            <ul className="plan-info__list">
              {infoPlanData.features.map((f) => (
                <li key={f} className="plan-info__item">
                  <Check size={16} className="plan-info__check" />
                  {f}
                </li>
              ))}
            </ul>
            <button
              className="btn btn--primary"
              onClick={() => {
                haptic('light')
                if (!(infoPlan === 'standard' && premiumActive)) setPlan(infoPlan)
                setInfoPlan(null)
              }}
            >
              Выбрать {infoPlanData.name}
            </button>
          </div>
        )}
      </Modal>

      {/* Попап: партнёрская программа */}
      <Modal open={partnerOpen} onClose={() => setPartnerOpen(false)} title="Партнёрская программа">
        <div className="stack">
          <p className="ref-head">
            <Gift size={16} className="ref-head__gift" />
            Приглашай друзей и получай <b>{ref.percent || REF_PERCENT}%</b> с каждой их оплаты
          </p>

          <div className="ref-link">
            <code className="ref-link__code">telegram.me/…/start=ref_{ref.code}</code>
            <button
              className={`ref-link__btn ${copied ? 'is-copied' : ''}`}
              onClick={copyLink}
              aria-label="Скопировать"
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
            </button>
          </div>

          <button className="btn btn--primary" onClick={shareInvite}>
            <Share2 size={18} />
            Пригласить друга
          </button>

          {/* Статистика — единая карточка: [иконка + заголовок] в строку, цифра ниже */}
          <div className="ref-grid">
            <div className="ref-grid__cell">
              <span className="ref-grid__head">
                <span className="ref-grid__icon"><Users size={14} /></span>
                <span className="ref-grid__label">Приглашено</span>
              </span>
              <span className="ref-grid__value">{ref.invited}</span>
            </div>
            <div className="ref-grid__cell">
              <span className="ref-grid__head">
                <span className="ref-grid__icon"><UserCheck size={14} /></span>
                <span className="ref-grid__label">Активных рефералов</span>
              </span>
              <span className="ref-grid__value">{ref.active}</span>
            </div>
            <div className="ref-grid__cell">
              <span className="ref-grid__head">
                <span className="ref-grid__icon"><Percent size={14} /></span>
                <span className="ref-grid__label">Ваш процент</span>
              </span>
              <span className="ref-grid__value">{ref.percent || REF_PERCENT}%</span>
            </div>
            <div className="ref-grid__cell">
              <span className="ref-grid__head">
                <span className="ref-grid__icon"><Wallet size={14} /></span>
                <span className="ref-grid__label">Всего заработано</span>
              </span>
              <span className="ref-grid__value">{(ref.earned || 0).toLocaleString('ru-RU')}&nbsp;₽</span>
            </div>
          </div>

          {/* Доступно к выводу */}
          <div className="ref-payout">
            <span className="ref-payout__label">Доступно к выводу</span>
            <span className="ref-payout__value">{(ref.available || 0).toLocaleString('ru-RU')}&nbsp;₽</span>
          </div>

          <button className="btn btn--primary" onClick={openWithdraw}>
            {ref.payoutPending ? <Clock size={18} /> : <Wallet size={18} />}
            {ref.payoutPending ? 'Вывод в обработке' : 'Вывести деньги'}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => { haptic('light'); setTermsOpen(true) }}
          >
            Подробные условия
          </button>
        </div>
      </Modal>

      {/* Попап: вывод средств */}
      <Modal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} title="Вывод средств">
        <div className="stack">
          <div className="db-form">
            <label className="db-label">Сумма, ₽</label>
            <input
              className="db-input"
              type="number"
              min={REF_MIN_PAYOUT}
              value={wdAmount}
              onChange={(e) => setWdAmount(e.target.value)}
            />
          </div>
          <div className="db-form">
            <label className="db-label">Реквизиты (номер карты или телефон СБП + банк)</label>
            <input
              className="db-input"
              placeholder="2200 0000 0000 0000, Сбер"
              value={wdDetails}
              onChange={(e) => setWdDetails(e.target.value)}
            />
          </div>
          <p className="acc-paynote">
            Выплата проверяется и отправляется вручную — обычно в течение 1–3 рабочих дней.
          </p>
          <button
            className="btn btn--primary"
            disabled={wdBusy || !wdDetails.trim() || Number(wdAmount) < REF_MIN_PAYOUT}
            onClick={submitWithdraw}
          >
            <Wallet size={18} />
            {wdBusy ? 'Отправляю…' : 'Отправить запрос'}
          </button>
        </div>
      </Modal>

      {/* Попап: условия партнёрской программы */}
      <Modal open={termsOpen} onClose={() => setTermsOpen(false)} title="Условия программы">
        <div className="stack">
          <ul className="ref-terms">
            <li className="ref-terms__item">
              <span className="ref-terms__icon"><Percent size={18} /></span>
              <p className="ref-terms__text">
                <b>{REF_PERCENT}%</b> с каждой оплаты приглашённого — не только с первой,
                а со всех его платежей, пока он пользуется сервисом.
              </p>
            </li>
            <li className="ref-terms__item">
              <span className="ref-terms__icon"><Wallet size={18} /></span>
              <p className="ref-terms__text">
                Минимальная сумма вывода — <b>{REF_MIN_PAYOUT.toLocaleString('ru-RU')}&nbsp;₽</b>.
                Одновременно может обрабатываться один запрос на вывод.
              </p>
            </li>
            <li className="ref-terms__item">
              <span className="ref-terms__icon"><Clock size={18} /></span>
              <p className="ref-terms__text">
                Выплаты проверяются и отправляются вручную в течение <b>1–3 рабочих дней</b> на карту или СБП.
              </p>
            </li>
          </ul>

          <button className="btn btn--primary" onClick={() => { haptic('light'); setTermsOpen(false) }}>
            <Check size={18} />
            Понятно
          </button>
        </div>
      </Modal>

      {/* Согласие на автопродление. Показывается ТОЛЬКО при включении тумблера —
          подключить можно лишь явным действием с принятием политики (Оферта п. 8.1). */}
      <Modal open={arConsentOpen} onClose={() => setArConsentOpen(false)} title="Подключить автопродление">
        <div className="stack">
          <ul className="acc-arlist">
            <li>Подписка будет продлеваться автоматически, бот не остановится.</li>
            <li>Предупредим о списании заранее — за сутки (или за 3 дня, если период больше месяца).</li>
            <li>Отключить можно в любой момент здесь же — доступ до конца оплаченного периода сохранится.</li>
          </ul>
          <p className="acc-arconsent">
            Продолжая, вы принимаете{' '}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); haptic('light'); setArPolicyOpen(true) }}
            >
              Политику рекуррентных платежей
            </a>
            .
          </p>
          <button className="btn btn--primary" disabled={arBusy} onClick={() => saveAutoRenew(true)}>
            <Check size={18} />
            {arBusy ? 'Секунду…' : 'Принимаю и подключаю'}
          </button>
          <button className="btn" onClick={() => { haptic('light'); setArConsentOpen(false) }}>
            Отмена
          </button>
        </div>
      </Modal>

      <Modal open={arPolicyOpen} onClose={() => setArPolicyOpen(false)} title="Политика рекуррентных платежей">
        <Suspense fallback={<LegalSkeleton />}><RecurrentContent /></Suspense>
      </Modal>
    </>
  )
}
