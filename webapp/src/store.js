import { createContext, useContext } from 'react'

// Глобальное состояние приложения: фаза сессии, аккаунт, бот, тосты.
// Наполняется в App.jsx, читается экранами через useApp().
export const AppCtx = createContext(null)
export const useApp = () => useContext(AppCtx)
