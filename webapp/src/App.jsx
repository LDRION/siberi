import { useCallback, useEffect, useRef, useState } from 'react'
import { preloadImages } from './preload.js'
import { syncAccentFromCloud } from './theme.js'
import { tg, user as tgUser } from './telegram.js'
import { api, setToken } from './api.js'
import { AppCtx } from './store.js'
import TabBar from './components/TabBar.jsx'
import TabSwitcher from './components/TabSwitcher.jsx'
import WelcomeScreen from './screens/WelcomeScreen.jsx'
import AccountScreen from './screens/AccountScreen.jsx'
import BotScreen from './screens/BotScreen.jsx'
import DatabaseScreen from './screens/DatabaseScreen.jsx'
import FeaturesScreen from './screens/FeaturesScreen.jsx'
import SettingsScreen from './screens/SettingsScreen.jsx'
import './App.css'

const SCREENS = {
  account: AccountScreen,
  bot: BotScreen,
  database: DatabaseScreen,
  features: FeaturesScreen,
  settings: SettingsScreen,
}

export default function App() {
  // Приложение всегда открывается с приветственной страницы.
  const [entered, setEntered] = useState(false)
  const [tab, setTab] = useState('account')

  // Сессия: initData → короткоживущий токен. Пока юзер на welcome-экране,
  // сессия и данные успевают подгрузиться в фоне.
  const [phase, setPhase] = useState('boot') // 'boot' | 'no-telegram' | 'error' | 'ready'
  const [account, setAccount] = useState(null)
  const [bot, setBot] = useState(null)
  const [botLoading, setBotLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)

  const showToast = useCallback((message, type = 'success') => {
    clearTimeout(toastTimer.current)
    setToast({ message, type })
    toastTimer.current = setTimeout(() => setToast(null), 2800)
  }, [])

  const refreshAccount = useCallback(async () => {
    try {
      const { data } = await api.get('/tgletbot/miniapp/account')
      if (data.success) setAccount(data)
    } catch {
      /* не критично — экран покажет спиннер, данные подтянутся при след. обновлении */
    }
  }, [])

  const refreshBot = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setBotLoading(true)
    try {
      const { data } = await api.get('/tgletbot/miniapp/bot')
      if (data.success) setBot(data.bot)
    } catch {
      /* оставляем прошлое состояние */
    } finally {
      setBotLoading(false)
    }
  }, [])

  // Прогреваем картинки экранов заранее, чтобы первый переход не дёргался.
  useEffect(() => { preloadImages() }, [])
  // Подтягиваем акцент из облака Telegram (если менялся на другом устройстве).
  useEffect(() => { syncAccentFromCloud() }, [])

  // Обмен Telegram initData на токен сессии.
  useEffect(() => {
    const initData = tg?.initData
    if (!initData) { setPhase('no-telegram'); return }
    api.post('/tgletbot/miniapp/session', { initData })
      .then(({ data }) => {
        if (!data.success) throw new Error('bad session')
        setToken(data.token)
        setPhase('ready')
      })
      .catch(() => setPhase('error'))
  }, [])

  // Как только сессия готова — тянем аккаунт и состояние бота.
  useEffect(() => {
    if (phase !== 'ready') return
    refreshAccount()
    refreshBot()
  }, [phase, refreshAccount, refreshBot])

  const ctx = { phase, tgUser, account, refreshAccount, bot, botLoading, refreshBot, showToast }

  if (!entered) {
    return (
      <div className="app">
        <div className="app__aurora" aria-hidden="true" />
        <WelcomeScreen onEnter={() => setEntered(true)} />
      </div>
    )
  }

  if (phase === 'no-telegram' || phase === 'error') {
    return (
      <div className="app">
        <div className="app__aurora" aria-hidden="true" />
        <div className="app-status">
          <h2>{phase === 'no-telegram' ? 'Откройте через Telegram' : 'Не получилось войти'}</h2>
          <p>
            {phase === 'no-telegram'
              ? 'Приложение работает только внутри Telegram — откройте его из бота @AI_ConstructorBot.'
              : 'Сессия Telegram недействительна. Закройте приложение и откройте его заново.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        {/* Фоновое неон-свечение (aurora) */}
        <div className="app__aurora" aria-hidden="true" />

        {toast && <div className={`toast toast--${toast.type}`}>{toast.message}</div>}

        <div className="app__viewport">
          <TabSwitcher tab={tab}>
            {(id) => {
              const Screen = SCREENS[id]
              return <Screen onNavigate={setTab} />
            }}
          </TabSwitcher>
        </div>

        <TabBar active={tab} onChange={setTab} />
      </div>
    </AppCtx.Provider>
  )
}
