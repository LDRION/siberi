import { useId } from 'react';

export function TelegramIcon({ size = 24, className, style }) {
  const id = useId();
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} className={className} style={style} xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid">
      <defs>
        <linearGradient id={`${id}tg`} x1="50%" x2="50%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#2AABEE" />
          <stop offset="100%" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}tg)`} d="M128 0C94.06 0 61.48 13.494 37.5 37.49A128.038 128.038 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51 0-33.934-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0Z" />
      <path fill="#FFF" d="M57.94 126.648c37.32-16.256 62.2-26.974 74.64-32.152 35.56-14.786 42.94-17.354 47.76-17.441 1.06-.017 3.42.245 4.96 1.49 1.28 1.05 1.64 2.47 1.82 3.467.16.996.38 3.266.2 5.038-1.92 20.24-10.26 69.356-14.5 92.026-1.78 9.592-5.32 12.808-8.74 13.122-7.44.684-13.08-4.912-20.28-9.63-11.26-7.386-17.62-11.982-28.56-19.188-12.64-8.328-4.44-12.906 2.76-20.386 1.88-1.958 34.64-31.748 35.26-34.45.08-.338.16-1.598-.6-2.262-.74-.666-1.84-.438-2.64-.258-1.14.256-19.12 12.152-54 35.686-5.1 3.508-9.72 5.218-13.88 5.128-4.56-.098-13.36-2.584-19.9-4.708-8-2.606-14.38-3.984-13.82-8.41.28-2.304 3.46-4.662 9.52-7.072Z" />
    </svg>
  );
}

export function VKIcon({ size = 24, className, style }) {
  const id = useId();
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 256 256" width={size} height={size} className={className} style={style}>
      <g clipPath={`url(#${id}vkc)`}>
        <mask id={`${id}vkm`} width="256" height="256" x="0" y="0" maskUnits="userSpaceOnUse" style={{ maskType: 'luminance' }}>
          <path fill="#fff" d="M256 0H0v256h256V0z" />
        </mask>
        <g mask={`url(#${id}vkm)`}>
          <path fill="#07F" d="M0 122.88C0 64.95 0 35.99 18 18 36 0 64.95 0 122.88 0h10.24C191.05 0 220.01 0 238 18c18 18 18 46.95 18 104.88v10.24c0 57.93 0 86.89-18 104.88-18 18-46.95 18-104.88 18h-10.24c-57.93 0-86.89 0-104.88-18C0 220 0 191.06 0 133.13v-10.24z" />
          <path fill="#fff" d="M136.21 184.43c-58.34 0-91.62-40-93.01-106.56h29.23c.96 48.85 22.5 69.54 39.57 73.81V77.87h27.52V120c16.85-1.81 34.56-21.01 40.53-42.13h27.52c-4.58 26.02-23.78 45.22-37.44 53.12 13.66 6.4 35.52 23.14 43.84 53.44h-30.29c-6.5-20.27-22.72-35.95-44.16-38.08v38.08h-3.3z" />
        </g>
      </g>
      <defs>
        <clipPath id={`${id}vkc`}>
          <path fill="#fff" d="M0 0h256v256H0z" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function GoogleIcon({ size = 24, className, style }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={style} xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

export function YandexIcon({ size = 24, className, style }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={style} xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="12" fill="#FC3F1D"/>
      <path fill="#fff" d="M13.47 18.5h-1.9V8.56H10.3c-1.37 0-2.09.67-2.09 1.77 0 1.25.56 1.84 1.69 2.61l.95.64-2.72 4.92H6.16l2.46-4.44c-1.42-.99-2.23-1.97-2.23-3.64 0-2.05 1.42-3.42 3.93-3.42h3.15V18.5z"/>
    </svg>
  );
}

export function MAXIcon({ size = 24, className, style }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
      <defs>
        <clipPath id={`${id}maxclip`}>
          <rect width="100" height="100" rx="24" ry="24" />
        </clipPath>
      </defs>
      <image href="/max.jpg" width="100" height="100" clipPath={`url(#${id}maxclip)`} />
    </svg>
  );
}

export function YooMoneyIcon({ size = 24, className, style }) {
  return (
    <img
      src="/yoomoney-logo.png"
      alt="ЮMoney"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', ...style }}
    />
  );
}

export function SberPayIcon({ size = 24, className, style }) {
  return (
    <img
      src="/sberpay-logo.png"
      alt="SberPay"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', ...style }}
    />
  );
}

export function SBPIcon({ size = 24, className, style }) {
  return (
    <img
      src="/sbp-logo.png"
      alt="СБП — Система быстрых платежей"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', mixBlendMode: 'multiply', ...style }}
    />
  );
}

export function OneCIcon({ size = 24, className, style }) {
  return (
    <img
      src="/1c-logo.png"
      alt="1С:Предприятие"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', ...style }}
    />
  );
}

export function WebsiteIcon({ size = 24, color = '#7c3aed', className, style }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={style} xmlns="http://www.w3.org/2000/svg" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  );
}
