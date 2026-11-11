import { useEffect } from 'react';

// Страница результата оплаты — куда Т-Касса возвращает клиента после платежа
// (SuccessURL → /pay/success, FailURL → /pay/fail). Самодостаточная (инлайн-стили),
// чтобы мгновенно открываться во встроенном браузере Telegram на мобиле.
const BOT_URL = 'https://telegram.me/AI_ConstructorBot';

export default function PayResult({ type = 'success' }) {
  const ok = type === 'success';

  useEffect(() => {
    document.title = ok ? 'Оплата прошла — AI Constructor Bot' : 'Оплата не прошла — AI Constructor Bot';
  }, [ok]);

  const accent = ok ? '#46d39a' : '#e06464';
  const accentSoft = ok ? 'rgba(70,211,154,0.14)' : 'rgba(224,100,100,0.14)';

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={{ ...styles.badge, background: accentSoft, color: accent }}>
          {ok ? (
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          ) : (
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          )}
        </div>

        <h1 style={styles.title}>{ok ? 'Оплата прошла успешно' : 'Оплата не прошла'}</h1>

        <p style={styles.text}>
          {ok
            ? 'Спасибо! Подписка активирована. Вернитесь в бот — всё готово к работе. Если доступ не открылся сразу, он появится в течение минуты.'
            : 'Платёж отклонён или отменён. Деньги не списаны. Вы можете вернуться в бот и попробовать оплатить ещё раз.'}
        </p>

        <a href={BOT_URL} style={{ ...styles.btn, background: accent }}>
          Вернуться в бот
        </a>

        <p style={styles.hint}>AI Constructor Bot · @AI_ConstructorBot</p>
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: '#08090a',
    fontFamily: "'Sora', 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  card: {
    width: '100%',
    maxWidth: '400px',
    background: '#161719',
    border: '1px solid rgba(255,255,255,.08)',
    borderRadius: '20px',
    padding: '36px 28px',
    textAlign: 'center',
    boxShadow: '0 30px 80px rgba(0,0,0,0.7)',
  },
  badge: {
    width: '76px',
    height: '76px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
  },
  title: {
    margin: '0 0 12px',
    fontSize: '22px',
    fontWeight: 700,
    color: '#f3f3f6',
    lineHeight: 1.25,
  },
  text: {
    margin: '0 0 26px',
    fontSize: '15px',
    lineHeight: 1.55,
    color: '#a9a9b4',
  },
  btn: {
    display: 'block',
    width: '100%',
    padding: '14px 20px',
    borderRadius: '12px',
    color: '#08090a',
    fontSize: '16px',
    fontWeight: 600,
    textDecoration: 'none',
    boxSizing: 'border-box',
  },
  hint: {
    margin: '18px 0 0',
    fontSize: '12px',
    color: '#74747e',
  },
};
