// Тонкая обёртка над Telegram.WebApp.
// В браузере (вне Telegram) tg === undefined — всё деградирует мягко.

export const tg = window.Telegram?.WebApp

export function initTelegram() {
  if (!tg) return
  tg.ready()
  tg.expand()
  // Тёмная тема приложения под наш фон #020617.
  try {
    tg.setHeaderColor('#020617')
    tg.setBackgroundColor('#020617')
  } catch (_) {
    // старые версии клиента могут не поддерживать — не критично
  }
}

export const haptic = (type = 'light') => {
  tg?.HapticFeedback?.impactOccurred?.(type)
}

// Открывает t.me-ссылку: внутри Telegram — нативно, в браузере — новой вкладкой.
export function openTelegramLink(url) {
  if (tg?.openTelegramLink) tg.openTelegramLink(url)
  else window.open(url, '_blank', 'noopener')
}

// Закрывает Web App — возврат в чат с ботом. Вне Telegram — no-op (false).
export function closeApp() {
  if (!tg?.close) return false
  tg.close()
  return true
}

// Открывает системное окно «Поделиться» Telegram с готовой ссылкой.
// Возвращает false, если мы вне Telegram (тогда вызывающий делает fallback).
export function shareLink(url, text = '') {
  if (!tg?.openTelegramLink) return false
  const share = `https://telegram.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`
  tg.openTelegramLink(share)
  return true
}

export const user = tg?.initDataUnsafe?.user ?? null
