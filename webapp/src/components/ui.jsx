// Маленькие переиспользуемые примитивы. Чистая презентация.
import './ui.css'

export function Card({ children, className = '', glow = false, ...rest }) {
  return (
    <div className={`ui-card ${glow ? 'ui-card--glow' : ''} ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function SectionTitle({ children }) {
  return <h2 className="ui-section-title">{children}</h2>
}

const STATUS_LABEL = {
  online: 'Онлайн',
  offline: 'Оффлайн',
  absent: 'Не создан',
  active: 'Активна',
}

export function StatusPill({ status, label }) {
  return (
    <span className={`ui-pill ui-pill--${status}`}>
      <span className="ui-pill__dot" />
      {label ?? STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function StatTile({ value, label, accent = false }) {
  return (
    <div className={`ui-stat ${accent ? 'ui-stat--accent' : ''}`}>
      <span className="ui-stat__value">{value}</span>
      <span className="ui-stat__label">{label}</span>
    </div>
  )
}

export function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`ui-toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange?.(!checked)}
    >
      <span className="ui-toggle__knob" />
    </button>
  )
}

export function ProgressBar({ value, max, tone = 'accent' }) {
  const pct = Math.min(100, Math.round((value / max) * 100))
  return (
    <div className="ui-progress">
      <div className={`ui-progress__fill ui-progress__fill--${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
