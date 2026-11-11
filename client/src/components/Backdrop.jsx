import { useEffect, useRef } from 'react';
import './Backdrop.css';

/*
  Backdrop — премиум-фон в стиле tbot.host:
  глубокий тёплый градиент-меш + виньетка + плёночное зерно (CSS) и
  «созвездия» — точки, соединённые тонкими линиями тёплого кирпичного цвета
  (canvas, медленный дрейф, без реакции на курсор).
  Центр спокойный — контент читается. Производительность: ~50 точек, кап FPS,
  пауза во вкладке, лёгкий режим на мобилках, статичный кадр при reduce-motion.
  Canvas — верхнеуровневый position:fixed (надёжный композитинг).
*/
export default function Backdrop() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const isMobile = window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 720;
    const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    const MIN_FRAME = isMobile ? 40 : 26;
    const THRESH = isMobile ? 120 : 152;
    const THRESH2 = THRESH * THRESH;

    let W = 0, H = 0, pts = [];
    const build = () => {
      const cw = window.innerWidth, ch = window.innerHeight;
      W = cw; H = ch;
      canvas.width = Math.round(cw * DPR); canvas.height = Math.round(ch * DPR);
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const N = Math.min(isMobile ? 32 : 74, Math.round(cw * ch / 21000));
      pts = Array.from({ length: N }, () => ({
        x: Math.random() * cw, y: Math.random() * ch,
        vx: (Math.random() - 0.5) * 0.16, vy: (Math.random() - 0.5) * 0.16,
      }));
    };
    build();
    window.addEventListener('resize', build, { passive: true });

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < THRESH2) {
            const al = (1 - Math.sqrt(d2) / THRESH) * 0.4;
            ctx.strokeStyle = `rgba(222,142,104,${al})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(244,190,150,0.85)';
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, 6.2832); ctx.fill();
      }
    };

    if (reduce) { draw(); return () => window.removeEventListener('resize', build); }

    let raf = 0, last = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      if (now - last < MIN_FRAME) return;
      last = now;
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -12) p.x = W + 12; else if (p.x > W + 12) p.x = -12;
        if (p.y < -12) p.y = H + 12; else if (p.y > H + 12) p.y = -12;
      }
      draw();
    };
    raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', build); };
  }, []);

  return (
    <>
      <div className="bd" aria-hidden="true">
        <div className="bd-aurora" />
        <div className="bd-vignette" />
        <div className="bd-grain" />
      </div>
      <canvas ref={ref} className="bd-web" aria-hidden="true" />
    </>
  );
}
