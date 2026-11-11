import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initTelegram } from './telegram.js'
import { applyAccent, getSavedAccent } from './theme.js'
import './index.css'

// Инициализируем Telegram WebApp до рендера (expand, тема, ready).
initTelegram()
// Применяем сохранённый акцент до первого кадра — чтобы не мигало синим.
applyAccent(getSavedAccent())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
