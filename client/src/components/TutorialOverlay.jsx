import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot, Copy, Check, Mail } from 'lucide-react';
import { useTutorial } from '../context/TutorialContext';
import './TutorialOverlay.css';

const PAD = 16;
const TW  = 400;
const TH  = 340;   // conservative height estimate — real height is measured after render
const GAP = 14;

function Mascot() {
  const logoRef = useRef(null);
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e) => {
      if (!logoRef.current) return;
      const rect = logoRef.current.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        const s = Math.min(dist, 220) / 220;
        setEyeOffset({ x: (dx / dist) * 2.5 * s, y: (dy / dist) * 2.5 * s });
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div className="tut-mascot" ref={logoRef}>
      <Bot size={42} className="tut-mascot__bot" />
      <div className="tut-mascot__eye-l"
        style={{ transform: `translate(calc(-50% + ${eyeOffset.x}px), calc(-50% + ${eyeOffset.y}px))` }} />
      <div className="tut-mascot__eye-r"
        style={{ transform: `translate(calc(-50% + ${eyeOffset.x}px), calc(-50% + ${eyeOffset.y}px))` }} />
    </div>
  );
}

function getRect(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function getSidebarW() {
  const el = document.querySelector('aside.side');
  if (!el) return 0;
  const w = el.getBoundingClientRect().width;
  return w > 10 ? Math.round(w) : 0;
}

function tooltipPos(rect, measuredH, sidebarW) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const th = measuredH || TH;
  const sw = sidebarW ?? 260;

  const center = {
    top:  Math.max(16, vh / 2 - th / 2),
    left: Math.max(sw + 16, (sw + vw) / 2 - TW / 2),
  };

  if (!rect) return center;

  const { x, y, w, h } = rect;

  // Element is outside the visible area — show tooltip centred
  if (y + h < 40 || y > vh - 40) return center;

  const clampL = (l) => Math.max(16, Math.min(l, vw - TW - 16));
  const clampT = (t) => Math.max(16, Math.min(t, vh - th - 16));

  // 1. RIGHT of element (best for tall left panels)
  if (vw - (x + w) >= TW + GAP + 16) {
    return { top: clampT(y + PAD), left: x + w + GAP };
  }
  // 2. LEFT of element (best for elements flush against the right edge)
  if (x - TW - GAP >= sw) {
    return { top: clampT(y + PAD), left: x - TW - GAP };
  }
  // 3. BELOW element
  if (y + h + GAP + th <= vh - 8) {
    return { top: y + h + GAP, left: clampL(x) };
  }
  // 4. ABOVE element  ← clampT applied so it never goes off top
  if (y - GAP - th >= 8) {
    return { top: clampT(y - GAP - th), left: clampL(x) };
  }
  // 5. Forced: left side of element, clamped
  return { top: clampT(y + PAD), left: Math.max(sw + 16, x - TW - GAP) };
}

export default function TutorialOverlay() {
  const { currentStep, idx, total, next, skip, isActive, originPath } = useTutorial();
  const [rect, setRect]           = useState(null);
  const [tooltipH, setTooltipH]   = useState(TH);
  const [copied, setCopied]        = useState(false);
  const tooltipRef                 = useRef(null);
  const location                   = useLocation();
  const navigate                   = useNavigate();

  useEffect(() => { setCopied(false); }, [idx]);

  // Navigate back to origin page when advancing while off-route
  const handleNext = useCallback(() => {
    next();
    if (originPath && location.pathname !== originPath) {
      navigate(originPath);
    }
  }, [next, originPath, location.pathname, navigate]);

  const handleCopyEmail = useCallback(() => {
    if (!currentStep?.email) return;
    navigator.clipboard.writeText(currentStep.email).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [currentStep?.email]);

  // Measure actual tooltip height after each render
  useEffect(() => {
    if (tooltipRef.current) {
      setTooltipH(tooltipRef.current.offsetHeight);
    }
  });

  const updateRect = useCallback(() => {
    setRect(getRect(currentStep?.selector));
  }, [currentStep?.selector]);

  // Scroll element into view when step changes, then update rect
  useEffect(() => {
    if (!isActive || !currentStep?.selector) return;
    const el = document.querySelector(currentStep.selector);
    if (!el) return;

    const r = el.getBoundingClientRect();
    const inView = r.top >= 60 && r.bottom <= window.innerHeight - 60;
    if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Extra updateRect after scroll animation settles
      const t = setTimeout(updateRect, 520);
      return () => clearTimeout(t);
    }
  }, [currentStep?.selector, isActive, updateRect]);

  // Re-calculate position on resize / scroll
  useEffect(() => {
    if (!isActive) { setRect(null); return; }
    const t = setTimeout(updateRect, 60);
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [isActive, updateRect]);

  // Pulse on the actual DOM element(s)
  useEffect(() => {
    if (!isActive || !currentStep?.selector) return;
    const t = setTimeout(() => {
      const el = document.querySelector(currentStep.selector);
      if (el) el.classList.add('tut-target-pulse');
      // Extra selector — highlight simultaneously (e.g. sidebar mirror of a content button)
      if (currentStep.selectorExtra) {
        const el2 = document.querySelector(currentStep.selectorExtra);
        if (el2) el2.classList.add('tut-target-pulse');
      }
    }, 80);
    return () => {
      clearTimeout(t);
      document.querySelectorAll('.tut-target-pulse')
        .forEach(el => el.classList.remove('tut-target-pulse'));
    };
  }, [currentStep?.selector, currentStep?.selectorExtra, isActive]);

  // Lock body scroll while overlay is visible
  useEffect(() => {
    document.body.style.overflow = isActive ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isActive]);

  if (!isActive) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const SIDEBAR_W = getSidebarW();

  // Build dim panels leaving a spotlight hole
  const panels = [];
  if (rect) {
    const inSidebar = SIDEBAR_W > 0 && rect.x < SIDEBAR_W;

    if (inSidebar) {
      // Sidebar element: dim entire content area — no partial spotlight strip in content
      panels.push({ top: 0, left: SIDEBAR_W, right: 0, bottom: 0 });
    } else {
      const t = Math.max(0,          rect.y - PAD);
      const l = Math.max(SIDEBAR_W,  rect.x - PAD);
      const r = rect.x + rect.w + PAD;
      const b = rect.y + rect.h + PAD;

      if (t > 0)          panels.push({ top: 0, left: SIDEBAR_W, right: 0, height: t });
      if (b < vh)         panels.push({ top: b, left: SIDEBAR_W, right: 0, bottom: 0 });
      if (l > SIDEBAR_W)  panels.push({ top: t, left: SIDEBAR_W, width: l - SIDEBAR_W, height: Math.max(0, b - t) });
      if (r < vw)         panels.push({ top: t, left: r, right: 0, height: Math.max(0, b - t) });
    }
  } else {
    panels.push({ top: 0, left: SIDEBAR_W, right: 0, bottom: 0 });
  }

  const pos    = tooltipPos(rect, tooltipH, SIDEBAR_W);
  const isLast = idx + 1 >= total;

  return (
    <div className="tut-root">
      {panels.map((style, i) => (
        <div key={i} className="tut-panel" style={style} />
      ))}

      {rect && rect.x >= SIDEBAR_W && (
        <div
          className="tut-spotlight-ring"
          style={{
            top:    rect.y - PAD,
            left:   rect.x - PAD,
            width:  rect.w + PAD * 2,
            height: rect.h + PAD * 2,
          }}
        />
      )}

      <div className="tut-tooltip" style={pos} ref={tooltipRef}>
        <Mascot />
        <div className="tut-body" key={idx}>
          <div className="tut-counter">{idx + 1} / {total}</div>
          <p className="tut-text">{currentStep.text}</p>
          {currentStep.email && (
            <div className="tut-email-widget">
              <a
                href={`mailto:${currentStep.email}`}
                className="tut-email-link"
                onClick={(e) => e.stopPropagation()}
              >
                <Mail size={13} />
                {currentStep.email}
              </a>
              <button
                className={`tut-email-copy${copied ? ' copied' : ''}`}
                onClick={handleCopyEmail}
                title="Скопировать адрес"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          )}
          <div className="tut-actions">
            <button className="tut-skip" onClick={skip}>Пропустить</button>
            <button className="tut-next" onClick={handleNext}>
              {isLast ? '✓ Готово' : 'Далее →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
