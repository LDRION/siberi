import axios from 'axios';
import { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import StarsBg from '../components/design/StarsBg';
import './Login.css';

/* ==========================================================================
   Вход / Регистрация / Сброс пароля — редизайн Total Black.
   Разметка из дизайн-эталона (login.html + reset-password.html), вся логика
   авторизации сохранена: OAuth VK/Яндекс, email+пароль, забыли/сброс, verify.
   ========================================================================== */

const API_URL = import.meta.env.VITE_API_URL || '/api/v1';
const ym = (goal) => { try { window.ym?.(109332736, 'reachGoal', goal); } catch { /* noop */ } };

const RobotMark = ({ xl = false }) => (
  <div className={`robot${xl ? ' robot--xl' : ''}`} aria-hidden="true">
    <span className="robot__glow"></span>
    <svg className="robot__bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /></svg>
    <span className="bot-eyes"><span className="bot-eye bot-eye--l"></span><span className="bot-eye bot-eye--r"></span></span>
    {xl && <span className="robot__ring"></span>}
  </div>
);

const EyeBtn = ({ shown, onClick }) => (
  <button className={`eye${shown ? ' eye--on' : ''}`} type="button" aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'} onClick={onClick}>
    <svg className="i-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
    <svg className="i-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.3 4.1M6.5 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 2.4-.3" /></svg>
  </button>
);

// ВАЖНО: Chrome определён на уровне модуля (не внутри Login). Если объявлять его
// внутри компонента, на каждый ввод символа создаётся новая функция-компонент →
// React ремонтит всё поддерево: звёзды перезапускаются, а инпут теряет фокус.
function Chrome({ setLight, children }) {
  return (
    <>
      <StarsBg />
      <header className="top">
        <Link className="brand" to="/" aria-label="Siberi AI">
          <span className="brand__mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01M9.5 16.5h5" /></svg></span>
          <span className="brand__name">SIBERI<span className="brand__dot">.AI</span></span>
        </Link>
        <button className="theme" type="button" aria-label="Сменить тему" onClick={() => setLight((v) => !v)}>
          <svg className="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
          <svg className="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v2.5M12 20v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1.5 12h2.5M20 12h2.5M4.2 19.8l1.8-1.8M18 6l1.8-1.8" /></svg>
        </button>
      </header>
      {children}
      <Link className="back" to="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 18l-6-6 6-6" /></svg> На главную</Link>
    </>
  );
}

export default function Login({ onLogin }) {
  const [searchParams] = useSearchParams();
  const refCode = searchParams.get('ref') || '';
  const resetToken = searchParams.get('reset') || '';
  const verifyToken = searchParams.get('verify') || '';
  const oauthToken = searchParams.get('token') || '';
  const oauthError = searchParams.get('error') || '';

  const [mode, setMode] = useState(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [showPwd2, setShowPwd2] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(oauthError ? decodeURIComponent(oauthError) : '');
  const [info, setInfo] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [light, setLight] = useState(() => { try { return localStorage.getItem('siberi-theme') === 'light'; } catch { return false; } });

  /* тема + метка страницы для дизайн-токенов */
  useLayoutEffect(() => {
    document.body.classList.add('sb-login');
    document.documentElement.classList.remove('sb-boot-app', 'sb-boot-light'); // boot-подложка снята — тему держит body.sb-login
    return () => document.body.classList.remove('sb-login', 'light');
  }, []);
  useEffect(() => {
    document.body.classList.toggle('light', light);
    try { localStorage.setItem('siberi-theme', light ? 'light' : 'dark'); } catch { /* noop */ }
    window.dispatchEvent(new Event('themechange'));
  }, [light]);

  /* OAuth callback — сервер вернул сюда с ?token= */
  useEffect(() => { if (oauthToken) onLogin(oauthToken); }, [oauthToken]); // eslint-disable-line react-hooks/exhaustive-deps

  /* авто-подтверждение email по токену из письма */
  useEffect(() => {
    if (!verifyToken) return;
    setVerifying(true);
    axios.get(`${API_URL}/auth/verify-email?token=${verifyToken}`)
      .then((res) => { if (res.data.success) onLogin(res.data.apiKey); })
      .catch(() => { setError('Ссылка подтверждения недействительна или устарела.'); setVerifying(false); });
  }, [verifyToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (m) => { setMode(m); setError(''); setInfo(''); setPassword(''); setPassword2(''); setShowPwd(false); setShowPwd2(false); };

  const handleRegister = async (e) => {
    e.preventDefault(); setError('');
    if (password !== password2) { setError('Пароли не совпадают'); return; }
    setLoading(true);
    try {
      await axios.post(`${API_URL}/auth/register`, { email, password, ref: refCode || undefined, acceptTerms: true });
      ym('registration'); setMode('registered');
    } catch (err) { setError(err.response?.data?.error || 'Произошла ошибка'); }
    finally { setLoading(false); }
  };
  const handleLogin = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/auth/login`, { email, password });
      if (res.data.success) { ym('login'); onLogin(res.data.apiKey); }
    } catch (err) { setError(err.response?.data?.error || 'Произошла ошибка'); setLoading(false); }
  };
  const handleForgot = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    try { await axios.post(`${API_URL}/auth/forgot-password`, { email }); setMode('forgot-sent'); }
    catch { setError('Произошла ошибка, попробуйте позже'); }
    finally { setLoading(false); }
  };
  const handleReset = async (e) => {
    e.preventDefault(); setError('');
    if (password !== password2) { setError('Пароли не совпадают'); return; }
    setLoading(true);
    try { await axios.post(`${API_URL}/auth/reset-password`, { token: resetToken, password }); setMode('reset-done'); }
    catch (err) { setError(err.response?.data?.error || 'Ссылка устарела'); }
    finally { setLoading(false); }
  };
  const handleResend = async () => {
    if (!email) { setError('Введите email для повторной отправки'); return; }
    setLoading(true);
    try { await axios.post(`${API_URL}/auth/resend-verification`, { email }); setInfo('Письмо отправлено повторно. Проверьте папку «Спам».'); }
    catch { setInfo('Не удалось отправить. Попробуйте позже.'); }
    finally { setLoading(false); }
  };

  if (verifying) {
    return (
      <Chrome setLight={setLight}>
        <main className="card">
          <RobotMark />
          <h1 className="card__title">Подтверждаем email…</h1>
          <p className="card__sub">Секунду — проверяем ссылку из письма.</p>
          {error && <div className="auth-error">{error}</div>}
        </main>
      </Chrome>
    );
  }

  // Успешные экраны (регистрация / письмо сброса / пароль обновлён)
  if (mode === 'registered' || mode === 'forgot-sent' || mode === 'reset-done') {
    const map = {
      registered: { t: 'Проверьте почту', d: <>Мы отправили письмо на <b>{email}</b> со ссылкой для подтверждения аккаунта.</>, resend: true },
      'forgot-sent': { t: 'Письмо отправлено', d: <>Если аккаунт с <b>{email}</b> существует — на почту придёт ссылка для сброса пароля.</> },
      'reset-done': { t: 'Пароль обновлён', d: 'Теперь войдите с новым паролем.' },
    }[mode];
    return (
      <Chrome setLight={setLight}>
        <main className="card">
          <RobotMark />
          <h1 className="card__title">{map.t}</h1>
          <p className="card__sub">{map.d}</p>
          {map.resend && (
            <>
              <button className="submit" type="button" disabled={loading} onClick={handleResend}>Отправить письмо повторно</button>
              {info && <p className="auth-info">{info}</p>}
            </>
          )}
          <button className="submit submit--ghost" type="button" onClick={() => go('login')}>Вернуться ко входу</button>
        </main>
      </Chrome>
    );
  }

  // Сброс пароля (переход по ссылке из письма)
  if (mode === 'reset') {
    return (
      <Chrome setLight={setLight}>
        <main className="card">
          <RobotMark />
          <h1 className="card__title">Новый пароль</h1>
          <p className="card__sub">Придумайте новый пароль для входа в кабинет.</p>
          <form className="form" onSubmit={handleReset} noValidate>
            <label className="field"><span className="field__l">Новый пароль</span>
              <span className="field__pw">
                <input className="inp" type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" minLength={6} required />
                <EyeBtn shown={showPwd} onClick={() => setShowPwd((v) => !v)} />
              </span>
            </label>
            <label className="field"><span className="field__l">Повторите пароль</span>
              <span className="field__pw">
                <input className="inp" type={showPwd2 ? 'text' : 'password'} value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="••••••••" autoComplete="new-password" required />
                <EyeBtn shown={showPwd2} onClick={() => setShowPwd2((v) => !v)} />
              </span>
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="submit" type="submit" disabled={loading}>{loading ? 'Сохраняем…' : 'Сохранить пароль'}</button>
          </form>
        </main>
      </Chrome>
    );
  }

  // «Забыли пароль»
  if (mode === 'forgot') {
    return (
      <Chrome setLight={setLight}>
        <main className="card">
          <RobotMark />
          <h1 className="card__title">Сброс пароля</h1>
          <p className="card__sub">Укажите почту — пришлём ссылку для смены пароля.</p>
          <form className="form" onSubmit={handleForgot} noValidate>
            <label className="field"><span className="field__l">Email</span>
              <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" autoComplete="email" required />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="submit" type="submit" disabled={loading}>{loading ? 'Отправляем…' : 'Отправить ссылку'}</button>
          </form>
          <button className="submit submit--ghost" type="button" onClick={() => go('login')}>Вернуться ко входу</button>
        </main>
      </Chrome>
    );
  }

  // Основной экран: Вход / Регистрация
  const reg = mode === 'register';
  const showRedirect = loading && (mode === 'login' || mode === 'register');
  return (
    <Chrome setLight={setLight}>
      <main className="card">
        <RobotMark />
        <h1 className="card__title">{reg ? 'Создание аккаунта' : 'Вход в кабинет'}</h1>
        <p className="card__sub">{reg ? 'Зарегистрируйтесь через сервис или по почте' : 'Войдите через сервис или по почте'}<br /><span className="card__sub-sec">{reg ? 'Бесплатный доступ к чату — 10 запросов в день' : 'Ваши данные защищены, согласно 152-ФЗ'}</span></p>

        <div className="tabs" role="tablist">
          <button className={`tab${!reg ? ' tab--on' : ''}`} type="button" role="tab" onClick={() => go('login')}>Вход</button>
          <button className={`tab${reg ? ' tab--on' : ''}`} type="button" role="tab" onClick={() => go('register')}>Регистрация</button>
        </div>

        <div className="oauth">
          <a className="oauth-btn oauth-btn--ya" href={`${API_URL}/auth/yandex`}><span className="oauth-ic oauth-ic--ya" aria-hidden="true">Я</span> Яндекс</a>
          <a className="oauth-btn oauth-btn--vk" href={`${API_URL}/auth/vk`}><span className="oauth-ic oauth-ic--vk" aria-hidden="true"><svg viewBox="0 0 48 48" fill="currentColor"><path d="M25.2 34.5c-11.4 0-18.4-7.9-18.7-21h5.84c.19 9.55 4.5 13.6 7.79 14.43V13.5h5.46v8.36c3.27-.35 6.7-4.08 7.86-8.36h5.41c-.89 4.28-4.62 8.01-7.28 9.55 2.66 1.25 6.88 4.51 8.49 9.45h-5.97c-1.26-3.93-4.4-6.97-8.51-7.46v7.46z" /></svg></span> VK</a>
        </div>

        <div className="divider">или по почте</div>

        <form className="form" onSubmit={reg ? handleRegister : handleLogin} noValidate>
          <label className="field"><span className="field__l">Email</span>
            <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" autoComplete="email" required />
          </label>
          <label className="field"><span className="field__l">Пароль</span>
            <span className="field__pw">
              <input className="inp" type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={reg ? 'new-password' : 'current-password'} minLength={6} required />
              <EyeBtn shown={showPwd} onClick={() => setShowPwd((v) => !v)} />
            </span>
          </label>
          {reg && (
            <label className="field field--reg"><span className="field__l">Повторите пароль</span>
              <span className="field__pw">
                <input className="inp" type={showPwd2 ? 'text' : 'password'} value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="••••••••" autoComplete="new-password" required />
                <EyeBtn shown={showPwd2} onClick={() => setShowPwd2((v) => !v)} />
              </span>
            </label>
          )}
          {!reg && <button type="button" className="forgot" onClick={() => go('forgot')}>Забыли пароль?</button>}
          {error && <div className="auth-error">{error}</div>}
          <button className="submit" type="submit" disabled={loading}>{loading ? 'Секунду…' : (reg ? 'Создать аккаунт' : 'Войти')}</button>
        </form>

        <p className="legal">Продолжая, вы соглашаетесь с:<br /><span className="legal__nowrap"><Link to="/oferta">офертой</Link> и <Link to="/privacy">политикой конфиденциальности</Link></span></p>
        <p className="legal" style={{ marginTop: 10 }}>Новости и обновления — в Telegram-канале <a href="https://t.me/SiberiNews" target="_blank" rel="noopener">@SiberiNews</a></p>
      </main>

      {showRedirect && (
        <div className="redirect show" aria-hidden="false">
          <div className="redirect__in">
            <RobotMark xl />
            <div className="redirect__t">{reg ? 'Создаём аккаунт…' : 'Входим в кабинет…'}</div>
            <div className="redirect__d">Секунду — подготавливаем ваш кабинет Siberi.</div>
          </div>
        </div>
      )}
    </Chrome>
  );
}
