import { useState, lazy, Suspense } from 'react'
import { ArrowRight } from 'lucide-react'
import welcomeArt from '../assets/welcome-art.webp'
import Modal from '../components/Modal.jsx'
import LegalSkeleton from '../components/LegalSkeleton.jsx'
import { haptic, openTelegramLink } from '../telegram.js'
import './WelcomeScreen.css'

// Юр-тексты грузим лениво — первый экран должен открываться мгновенно.
const OfertaContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.OfertaContent })))
const PrivacyContent = lazy(() => import('../legal.jsx').then((m) => ({ default: m.PrivacyContent })))

export default function WelcomeScreen({ onEnter }) {
  const [legal, setLegal] = useState(null) // 'oferta' | 'privacy' | null
  const [agreed, setAgreed] = useState(false)

  const enter = () => {
    if (!agreed) { haptic('light'); return }
    haptic('medium')
    onEnter?.()
  }
  const openLegal = (which) => (e) => {
    e.preventDefault()
    haptic('light')
    setLegal(which)
  }

  return (
    <div className="welcome">
      <div className="welcome__art" aria-hidden="true">
        <img src={welcomeArt} alt="" />
        <div className="welcome__fade" />
      </div>

      <div className="welcome__content">
        <span className="welcome__eyebrow">Добро пожаловать</span>
        <h1 className="welcome__title">AI Constructor Bot</h1>
        <p className="welcome__subtitle">Просто опиши бота словами — встроенный AI соберёт его за пару минут. Меню, база данных и живой AI-помощник внутри.</p>

        <label className="welcome__agree">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => { haptic('light'); setAgreed(e.target.checked) }}
          />
          <span>
            Я прочитал(а) и принимаю{' '}
            <a href="#" onClick={openLegal('oferta')}>Оферту</a> и{' '}
            <a href="#" onClick={openLegal('privacy')}>Политику&nbsp;конфиденциальности</a>
          </span>
        </label>

        <button className="welcome__cta" onClick={enter} disabled={!agreed}>
          <span>Продолжить</span>
          <ArrowRight size={20} strokeWidth={2.4} />
        </button>

        <p className="welcome__news">
          Следите за новостями и обновлениями в{' '}
          <a
            href="https://telegram.me/aicupdates"
            onClick={(e) => { e.preventDefault(); haptic('light'); openTelegramLink('https://telegram.me/aicupdates') }}
          >
            @aicupdates
          </a>
        </p>
      </div>

      <Modal open={legal === 'oferta'} onClose={() => setLegal(null)} title="Публичная оферта">
        <Suspense fallback={<LegalSkeleton />}><OfertaContent /></Suspense>
      </Modal>
      <Modal open={legal === 'privacy'} onClose={() => setLegal(null)} title="Политика конфиденциальности">
        <Suspense fallback={<LegalSkeleton />}><PrivacyContent /></Suspense>
      </Modal>
    </div>
  )
}
