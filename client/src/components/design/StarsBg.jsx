import { useEffect, useRef } from 'react';

/* Общий фон-созвездия для страниц редизайна (лендинг/вход/юр/ошибки).
   Точки дрейфуют, соседи соединяются линиями, курсор притягивает связи.
   Тема-зависимо: цвет точек из --star (читается с body), линии — коралл в тёмной.
   Требует, чтобы на body были дизайн-токены (класс sb-<page>). */
export default function StarsBg({ className = 'bg' }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const readStar = () => getComputedStyle(document.body).getPropertyValue('--star').trim() || '255,255,255';
    const isLight = () => document.body.classList.contains('light');
    const LINK = 130, PULL = 150;
    let dpr, dots = [], starRGB = readStar(), raf = 0;
    let mx = -999, my = -999, cx = -999, cy = -999, hasMouse = false;
    const reread = () => requestAnimationFrame(() => { starRGB = readStar(); });
    window.addEventListener('themechange', reread);
    const onMove = (e) => { mx = e.clientX; my = e.clientY; if (!hasMouse) { hasMouse = true; cx = mx; cy = my; } };
    window.addEventListener('mousemove', onMove, { passive: true });
    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
      canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(90, Math.round(innerWidth / 18));
      dots = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22, r: Math.random() * 1.4 + 0.5 }));
    };
    const paint = (alive) => {
      const link = isLight() ? starRGB : '212,132,92';
      for (let i = 0; i < dots.length; i++) {
        const p = dots[i];
        if (alive) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > innerWidth) p.vx *= -1; if (p.y < 0 || p.y > innerHeight) p.vy *= -1; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fillStyle = `rgba(${starRGB},.55)`; ctx.fill();
        for (let j = i + 1; j < dots.length; j++) {
          const q = dots[j], d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d > LINK) continue;
          ctx.globalAlpha = (1 - d / LINK) * 0.22; ctx.strokeStyle = `rgb(${link})`; ctx.lineWidth = 0.6;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
        if (alive && hasMouse) {
          const d = Math.hypot(p.x - cx, p.y - cy);
          if (d < PULL) { ctx.globalAlpha = (1 - d / PULL) * 0.5; ctx.strokeStyle = `rgb(${link})`; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(cx, cy); ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
      }
    };
    const frame = () => { raf = requestAnimationFrame(frame); cx += (mx - cx) * 0.12; cy += (my - cy) * 0.12; ctx.clearRect(0, 0, innerWidth, innerHeight); paint(true); };
    window.addEventListener('resize', resize, { passive: true });
    resize();
    if (reduce) { ctx.clearRect(0, 0, innerWidth, innerHeight); paint(false); } else frame();
    return () => { window.removeEventListener('themechange', reread); window.removeEventListener('mousemove', onMove); window.removeEventListener('resize', resize); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return <canvas id="stars" className={className} ref={ref}></canvas>;
}
