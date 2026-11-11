import defaultRobot from '../assets/robot-hero.webp'
import './ScreenHero.css'

// Робот с уже вшитой неон-линией (один прозрачный PNG) — стоит сверху,
// держится за линию и смотрит вниз на контент раздела.
// robotSrc позволяет подменить картинку (например, статусным роботом во вкладке «Бот»).
export default function ScreenHero({ eyebrow, title, subtitle, right, robotSrc, robotVariant }) {
  return (
    <div className={`hero ${robotVariant ? `hero--${robotVariant}` : ''}`}>
      <div className="hero__bg" aria-hidden="true" />
      <img className="hero__robot" src={robotSrc || defaultRobot} alt="" />

      <div className="hero__caption">
        {eyebrow && <span className="hero__eyebrow">{eyebrow}</span>}
        {title && <h1 className="hero__title">{title}</h1>}
        {subtitle && <p className="hero__subtitle">{subtitle}</p>}
        {right && <div className="hero__right">{right}</div>}
      </div>
    </div>
  )
}
