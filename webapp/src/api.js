// Тонкий клиент API. Приложение отдаётся с siberi.online, поэтому запросы
// идут на тот же домен (nginx проксирует /api на Node). Авторизация —
// короткоживущий EmbedToken из POST /tgletbot/miniapp/session.
import axios from 'axios'

export const API_URL = import.meta.env.VITE_API_URL || '/api/v1'

export const api = axios.create({ baseURL: API_URL })

export function setToken(token) {
  api.defaults.headers.common.Authorization = `Bearer ${token}`
}

// Человекочитаемое сообщение из ответа сервера (или запасной текст).
export function errMsg(err, fallback = 'Что-то пошло не так, попробуй ещё раз.') {
  const serverText = err?.response?.data?.error
  // Служебные англоязычные ошибки middleware не показываем пользователю
  if (serverText && /^[а-яё]/i.test(serverText)) return serverText
  if (err?.response?.status === 403) return 'Нужна активная подписка — оформи её во вкладке «Аккаунт».'
  return fallback
}
