import { useEffect, useRef } from 'react';
import './SiteBackground.css';

/* Единый фон всего сайта — перенос 1:1 из teleconstructor.ru:
   база #060911 + дрейфующая aurora (a1/a2/a3) + canvas-созвездие (частицы,
   линии между близкими, связь к курсору) + vignette + grain.
   Рендерится один раз в App, лежит фиксированно ПОЗАДИ контента (z-index:-1). */
export default function SiteBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const rm = matchMedia('(prefers-reduced-motion:reduce)').matches;
    const DESKTOP = matchMedia('(min-width:900px) and (hover:hover) and (pointer:fine)').matches;
    const cv = canvasRef.current;
    if (!cv || rm || !DESKTOP) return; // на мобильных/reduced-motion — только aurora

    const ctx = cv.getContext('2d');
    let W, H, P = [], N, mx = -999, my = -999, vis = true, raf = 0;
    function init() {
      W = cv.width = innerWidth; H = cv.height = innerHeight;
      N = Math.min(90, Math.round(innerWidth / 16)); P = [];
      for (let i = 0; i < N; i++) P.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, r: Math.random() * 1.6 + 0.4 });
    }
    const onMove = (e) => { mx = e.clientX; my = e.clientY; };
    const onVis = () => { vis = !document.hidden; };
    addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    function frame() {
      raf = requestAnimationFrame(frame);
      if (!vis) return;
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const p = P[i]; p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fillStyle = 'rgba(150,180,255,.55)'; ctx.fill();
        for (let j = i + 1; j < N; j++) {
          const q = P[j], dx = p.x - q.x, dy = p.y - q.y, d = dx * dx + dy * dy;
          if (d < 11000) { ctx.globalAlpha = 1 - d / 11000; ctx.strokeStyle = 'rgba(91,140,255,.35)'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.globalAlpha = 1; }
        }
        const ax = p.x - mx, ay = p.y - my, ad = ax * ax + ay * ay;
        if (ad < 20000) { ctx.globalAlpha = 1 - ad / 20000; ctx.strokeStyle = 'rgba(34,211,238,.5)'; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(mx, my); ctx.stroke(); ctx.globalAlpha = 1; }
      }
    }
    init(); addEventListener('resize', init); frame();
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('mousemove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('resize', init);
    };
  }, []);

  return (
    <div className="site-bg" aria-hidden="true">
      <div className="site-bg__base" />
      <div className="fx">
        <div className="aurora a1" />
        <div className="aurora a2" />
        <div className="aurora a3" />
        <canvas id="stars" ref={canvasRef} />
      </div>
      <div className="vignette" />
      <div className="grain" />
    </div>
  );
}
