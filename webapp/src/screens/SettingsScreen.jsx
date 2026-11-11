import { useState, lazy, Suspense } from 'react'
import {
  Receipt,
  LifeBuoy,
  MessageSquare,
  Megaphone,
  ChevronRight,
  ChevronDown,
  FileText,
  Scale,
  LogOut,
  Palette,
  Check,
  Clock,
  RotateCcw,
  Wallet,
  XCircle,
} from 'lucide-react'
import { SectionTitle } from '../components/ui.jsx'
import ScreenHero from '../components/ScreenHero.jsx'
import Modal from '../components/Modal.jsx'
import LegalSkeleton from '../components/LegalSkeleton.jsx'
import { REF_MIN_PAYOUT } from '../plans.js'
import { useApp } from '../store.js'

// Юр-тексты (~100 КБ) вынесены в отдельный чанк: грузятся только при открытии документа,
// чтобы не тормозить первый запуск мини-аппа.
const OfertaContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.OfertaContent })))
const PrivacyContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.PrivacyContent })))
const PdnPolicyContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.PdnPolicyContent })))
const PorucheniyeContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.PorucheniyeContent })))
const RecurrentContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.RecurrentContent })))
import { ACCENTS, getSavedAccent, saveAccent } from '../theme.js'
import { haptic, closeApp, openTelegramLink } from '../telegram.js'
import './SettingsScreen.css'

// Упоминания разделов в ответах → на какую вкладку ведёт клик.
// Длинные фразы раньше коротких, чтобы совпадение бралось целиком.
const NAV_TERMS = [
  { term: '«Партнёрская программа»', tab: 'account' },
  { term: '«Аккаунт»', tab: 'account' },
  { term: '«База»', tab: 'database' },
  { term: '«Бот»', tab: 'bot' },
  { term: '«Настройки»', tab: 'settings' },
]

// Вопросы-ответы для «Помощь и FAQ» (аккордеон).
const FAQ = [
  {
    q: 'Как создать своего телеграм-бота?',
    a: 'Телеграм-бот создаётся текстовым сообщением в основном чат-боте @AI_ConstructorBot. Напишите вашу идею — за пару минут мы соберём вам готового Telegram-бота.',
  },
  {
    q: 'Как управлять ботом?',
    a: `Всё на вкладке «Бот», а текущее состояние показывает статус — «онлайн» или «оффлайн».

«Запустить» — включает бота, «Остановить» — выключает, «Перезагрузить» — перезапускает его (полезно, если бот подвис).

Мы хостим ботов 24/7 — не нужно думать о серверах или доплачивать за хостинг, всё уже включено.

«Удалить бота» полностью удаляет бота и его данные. Действие необратимо, применяйте его внимательно.`,
  },
  {
    q: 'Как работать с базой данных?',
    a: `Откройте вкладку «База» — там список всех ваших баз. Нажмите на нужную, чтобы увидеть записи.

Каждая запись это отдельная карточка: её можно отредактировать (карандаш) или удалить (корзина). Поиск вверху быстро находит нужную запись.

У названия базы карандаш меняет её схему, а «+» рядом добавляет новую запись.

Внизу экрана — «Редактировать текстом»: опишите изменение словами или голосом, и AI внесёт правки.

Чтобы создать или подключить базу, нажмите «+» в правом нижнем углу на списке баз. «Новая схема» — создать вручную, задав поля, их тип (текст, число, дата и др.) и отметку «обязательное». Также доступны импорт из Google Таблиц (с выбором направления синхронизации), подключение внешней базы (MongoDB или PostgreSQL) и загрузка файла CSV, JSON, SQL.

Кнопка «Экспортировать базу» в любой момент выгрузит ваши данные.`,
  },
  {
    q: 'Какие есть тарифы и чем они отличаются?',
    a: `Тарифов два, оба оформляются во вкладке «Аккаунт»:

Standard — 1 000 ₽/мес: хостинг бота 24/7, все функции конструктора, база данных, интеграции и уведомления.

Premium — 2 000 ₽/мес: всё то же самое, плюс повышенная скорость отработки ИИ и приоритетная очередь при высокой нагрузке.

При оплате сразу на 6 месяцев скидка 16%, на 12 месяцев — 33%.`,
  },
  {
    q: 'Как оплатить бота?',
    a: `Оформите подписку во вкладке «Аккаунт» — она и включает вашего бота.

Мы принимаем: банковские карты, SberPay, СБП, ЮMoney. Платёж проходит через защищённый шлюз — данные карт мы не храним и не видим.

После оплаты подписка активируется автоматически в течение минуты, бот пришлёт подтверждение в чат.`,
  },
  {
    q: 'Как вывести реферальные деньги?',
    a: `Откройте вкладку «Аккаунт» → «Партнёрская программа» и нажмите «Вывести деньги». Минимальная сумма вывода — ${REF_MIN_PAYOUT.toLocaleString('ru-RU')} ₽. Выплата приходит на карту или СБП в течение 1–3 рабочих дней.`,
  },
]

// Оформление платежа по статусу: иконка, подпись, тон.
const PAY_META = {
  paid: { label: 'Оплачено', icon: Check },
  pending: { label: 'В обработке', icon: Clock },
  refund: { label: 'Возврат', icon: RotateCcw },
  payout: { label: 'Выведено', icon: Wallet },
  rejected: { label: 'Отклонено', icon: XCircle },
}
const fmtPayDate = (d) =>
  new Date(d)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\sг\.$/, '')
const fmtAmount = (amount, status) =>
  (status === 'refund' || status === 'payout' ? '+' : '') +
  amount.toLocaleString('ru-RU') +
  ' ₽'

function Row({ icon: Icon, label, sub, right, tone, onClick }) {
  return (
    <button className={`set-row ${tone ? `set-row--${tone}` : ''}`} onClick={onClick} type="button">
      <span className="set-row__icon">
        <Icon size={18} />
      </span>
      <span className="set-row__text">
        <span className="set-row__label">{label}</span>
        {sub && <span className="set-row__sub">{sub}</span>}
      </span>
      <span className="set-row__right">{right}</span>
    </button>
  )
}

// Список документов для модалки «Документы». id совпадает со значением legal.
const DOCS = [
  { id: 'oferta', label: 'Публичная оферта' },
  { id: 'privacy', label: 'Политика конфиденциальности' },
  { id: 'pdn', label: 'Обработка персональных данных' },
  { id: 'poruchenie', label: 'Поручение на обработку' },
  { id: 'recurrent', label: 'Рекуррентные платежи' },
]

export default function SettingsScreen({ onNavigate }) {
  const { account } = useApp()
  const payments = account?.payments || []
  const [legal, setLegal] = useState(null) // 'oferta' | 'privacy' | 'pdn' | 'poruchenie' | 'recurrent' | null
  const [docsOpen, setDocsOpen] = useState(false)
  const [accent, setAccent] = useState(getSavedAccent())
  const [themeOpen, setThemeOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [faqOpen, setFaqOpen] = useState(false)
  const [openFaq, setOpenFaq] = useState(0) // индекс раскрытого вопроса (−1 — все закрыты)
  const openFaqModal = () => {
    haptic('light')
    setOpenFaq(-1) // все вопросы свёрнуты — ничего не раскрыто заранее
    setFaqOpen(true)
  }
  const toggleFaq = (i) => {
    haptic('light')
    setOpenFaq((cur) => (cur === i ? -1 : i))
  }
  // Переход на вкладку из ссылки в FAQ — закрываем попап и переключаем раздел.
  const goTab = (tab) => {
    haptic('light')
    setFaqOpen(false)
    onNavigate?.(tab)
  }
  // Делает кликабельными @username (→ Telegram) и названия разделов (→ вкладка).
  const renderAnswer = (text) => {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const navAlt = NAV_TERMS.map((n) => esc(n.term)).join('|')
    const re = new RegExp(`@([A-Za-z][\\w]{4,31})|${navAlt}`, 'g')
    const parts = []
    let last = 0
    let m
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(text.slice(last, m.index))
      if (m[1]) {
        const uname = m[1]
        parts.push(
          <a
            key={m.index}
            className="faq__link"
            href={`https://telegram.me/${uname}`}
            onClick={(e) => {
              e.preventDefault()
              haptic('light')
              openTelegramLink(`https://telegram.me/${uname}`)
            }}
          >
            @{uname}
          </a>
        )
      } else {
        const nav = NAV_TERMS.find((n) => n.term === m[0])
        parts.push(
          <button key={m.index} type="button" className="faq__link" onClick={() => goTab(nav.tab)}>
            {m[0]}
          </button>
        )
      }
      last = m.index + m[0].length
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts
  }
  const chevron = <ChevronRight size={18} className="set-chevron" />

  return (
    <>
      <ScreenHero eyebrow="Настройки" />

      <div className="screen-body settings-body">
        <SectionTitle>Аккаунт</SectionTitle>
        <div className="set-group">
          <Row
            icon={Receipt}
            label="История платежей"
            right={chevron}
            onClick={() => { haptic('light'); setPayOpen(true) }}
          />
        </div>

        <SectionTitle>Поддержка</SectionTitle>
        <div className="set-group">
          <Row icon={LifeBuoy} label="Помощь и FAQ" right={chevron} onClick={openFaqModal} />
          <Row
            icon={Megaphone}
            label="Новости и обновления"
            sub="@aicupdates"
            right={chevron}
            onClick={() => { haptic('light'); openTelegramLink('https://telegram.me/aicupdates') }}
          />
          <Row
            icon={MessageSquare}
            label="Написать в поддержку"
            sub="@SiberiManager"
            right={chevron}
            onClick={() => { haptic('light'); openTelegramLink('https://telegram.me/SiberiManager') }}
          />
          <Row
            icon={Scale}
            label="Документы"
            right={chevron}
            onClick={() => { haptic('light'); setDocsOpen(true) }}
          />
        </div>

        <div className="set-bottombar">
          <button
            className="set-bottombar__btn"
            onClick={() => { haptic('light'); setThemeOpen(true) }}
            type="button"
          >
            <Palette size={18} />
            Сменить тему
          </button>
          <span className="set-bottombar__div" />
          <button
            className="set-bottombar__btn set-bottombar__btn--danger"
            onClick={() => { haptic('medium'); closeApp() }}
            type="button"
          >
            <LogOut size={18} />
            Выйти
          </button>
        </div>

      </div>

      <Modal open={docsOpen} onClose={() => setDocsOpen(false)} title="Документы">
        <div className="set-group">
          {DOCS.map((doc) => (
            <Row
              key={doc.id}
              icon={FileText}
              label={doc.label}
              right={chevron}
              onClick={() => { haptic('light'); setDocsOpen(false); setLegal(doc.id) }}
            />
          ))}
        </div>
      </Modal>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="История платежей">
        {payments.length === 0 ? (
          <p className="pay-empty">Здесь появятся ваши платежи</p>
        ) : (
          <ul className="pay-list">
            {payments.map((p) => {
              const meta = PAY_META[p.status] || PAY_META.paid
              const Icon = meta.icon
              return (
                <li key={p.id} className={`pay-item pay-item--${p.status}`}>
                  <span className="pay-item__icon">
                    <Icon size={16} strokeWidth={2.4} />
                  </span>
                  <span className="pay-item__main">
                    <span className="pay-item__title">{p.title}</span>
                    <span className="pay-item__date">{fmtPayDate(p.date)}</span>
                  </span>
                  <span className="pay-item__right">
                    <span className="pay-item__amount">{fmtAmount(p.amount, p.status)}</span>
                    <span className="pay-item__status">{meta.label}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Modal>

      <Modal open={themeOpen} onClose={() => setThemeOpen(false)} title="Акцентный цвет">
        <div className="theme-grid">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`theme-opt ${accent === a.id ? 'is-active' : ''}`}
              onClick={() => { haptic('light'); setAccent(saveAccent(a.id)) }}
            >
              <span className="set-swatch" style={{ '--sw': a.bright }}>
                {accent === a.id && <Check size={16} strokeWidth={3.2} />}
              </span>
              <span className="theme-opt__name">{a.name}</span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={faqOpen} onClose={() => setFaqOpen(false)} title="Помощь и FAQ">
        <ul className="faq">
          {FAQ.map((item, i) => {
            const isOpen = openFaq === i
            return (
              <li key={i} className={`faq__item ${isOpen ? 'is-open' : ''}`}>
                <button
                  className="faq__q"
                  onClick={() => toggleFaq(i)}
                  type="button"
                  aria-expanded={isOpen}
                >
                  <span className="faq__q-text">{item.q}</span>
                  <ChevronDown size={18} className="faq__chevron" />
                </button>
                <div className="faq__a-wrap">
                  <div className="faq__a-inner">
                    <p className="faq__a">{renderAnswer(item.a)}</p>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </Modal>

      <Modal open={legal === 'oferta'} onClose={() => setLegal(null)} title="Публичная оферта">
        <Suspense fallback={<LegalSkeleton />}><OfertaContent /></Suspense>
      </Modal>
      <Modal open={legal === 'privacy'} onClose={() => setLegal(null)} title="Политика конфиденциальности">
        <Suspense fallback={<LegalSkeleton />}><PrivacyContent /></Suspense>
      </Modal>
      <Modal open={legal === 'pdn'} onClose={() => setLegal(null)} title="Политика обработки персональных данных">
        <Suspense fallback={<LegalSkeleton />}><PdnPolicyContent /></Suspense>
      </Modal>
      <Modal open={legal === 'poruchenie'} onClose={() => setLegal(null)} title="Поручение на обработку персональных данных">
        <Suspense fallback={<LegalSkeleton />}><PorucheniyeContent /></Suspense>
      </Modal>
      <Modal open={legal === 'recurrent'} onClose={() => setLegal(null)} title="Политика рекуррентных платежей">
        <Suspense fallback={<LegalSkeleton />}><RecurrentContent /></Suspense>
      </Modal>
    </>
  )
}
