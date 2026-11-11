import { useEffect, useState } from 'react'

// Один слой, последовательный fade: старый экран гаснет → контент
// подменяется НЕВИДИМЫМ (наложения текста невозможно) → новый проявляется.
export default function TabSwitcher({ tab, children }) {
  const [shown, setShown] = useState(tab)
  const [visible, setVisible] = useState(true)
  const [animating, setAnimating] = useState(false)

  useEffect(() => {
    if (tab !== shown) {
      setAnimating(true)
      setVisible(false) // запускаем затухание текущего экрана
    }
  }, [tab, shown])

  const handleTransitionEnd = (e) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'opacity') return
    if (!visible && tab !== shown) {
      // экран погас — меняем контент, пока он невидим, и проявляем
      setShown(tab)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true))
      )
    } else if (visible && tab === shown) {
      setAnimating(false) // проявление завершено — возвращаем блюр
    }
  }

  return (
    <div
      className={`screen-fade ${visible ? 'is-visible' : ''} ${animating ? 'is-anim' : ''}`}
      onTransitionEnd={handleTransitionEnd}
    >
      {children(shown)}
    </div>
  )
}
