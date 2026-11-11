// Акцентные темы. Меняют только «неон» — фон остаётся Total Black.
// rgb — RGB-триплет яркого цвета, от него считаются все подложки-оттенки
// через rgb(var(--accent-rgb) / a) в CSS.
export const ACCENTS = [
  { id: 'blue',    name: 'Синий',      accent: '#2563eb', bright: '#3b82f6', rgb: '59 130 246' },
  { id: 'emerald', name: 'Зелёный',    accent: '#059669', bright: '#10b981', rgb: '16 185 129' },
  { id: 'violet',  name: 'Фиолетовый', accent: '#7c3aed', bright: '#8b5cf6', rgb: '139 92 246' },
  { id: 'rose',    name: 'Розовый',    accent: '#db2777', bright: '#ec4899', rgb: '236 72 153' },
  { id: 'amber',   name: 'Оранжевый',  accent: '#ea580c', bright: '#f97316', rgb: '249 115 22' },
  { id: 'cyan',    name: 'Голубой',    accent: '#0891b2', bright: '#06b6d4', rgb: '6 182 212' },
]

const KEY = 'accentTheme'

// Применяет тему к корню документа (мгновенно, без перерисовки React).
export function applyAccent(id) {
  const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0]
  const r = document.documentElement.style
  r.setProperty('--accent', a.accent)
  r.setProperty('--accent-bright', a.bright)
  r.setProperty('--accent-rgb', a.rgb)
  return a.id
}

// Сохранённый выбор: localStorage (мгновенно) + Telegram CloudStorage (синк).
export function getSavedAccent() {
  try {
    return localStorage.getItem(KEY) || 'blue'
  } catch {
    return 'blue'
  }
}

export function saveAccent(id) {
  try { localStorage.setItem(KEY, id) } catch (_) {}
  try { window.Telegram?.WebApp?.CloudStorage?.setItem?.(KEY, id) } catch (_) {}
  return applyAccent(id)
}

// Подтягивает выбор из облака Telegram (между устройствами), если он там есть.
export function syncAccentFromCloud(onApplied) {
  try {
    window.Telegram?.WebApp?.CloudStorage?.getItem?.(KEY, (err, val) => {
      if (!err && val) {
        try { localStorage.setItem(KEY, val) } catch (_) {}
        applyAccent(val)
        onApplied?.(val)
      }
    })
  } catch (_) {}
}
