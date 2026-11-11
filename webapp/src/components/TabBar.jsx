import { User, Bot, Database, Sparkles, Settings } from 'lucide-react'
import { haptic } from '../telegram.js'
import './TabBar.css'

export const TABS = [
  { id: 'account', label: 'Аккаунт', icon: User },
  { id: 'bot', label: 'Бот', icon: Bot },
  { id: 'database', label: 'База', icon: Database },
  { id: 'features', label: 'Функции', icon: Sparkles },
  { id: 'settings', label: 'Настройки', icon: Settings },
]

export default function TabBar({ active, onChange }) {
  return (
    <nav className="tabbar">
      {TABS.map(({ id, label, icon: Icon }) => {
        const isActive = active === id
        return (
          <button
            key={id}
            className={`tabbar__item ${isActive ? 'is-active' : ''}`}
            onClick={() => {
              if (!isActive) haptic('light')
              onChange(id)
            }}
          >
            <span className="tabbar__icon">
              <Icon size={22} strokeWidth={2.2} />
            </span>
            <span className="tabbar__label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
