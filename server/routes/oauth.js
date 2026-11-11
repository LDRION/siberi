const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { findOrCreateOAuthUser } = require('../helpers/oauthUser');

// In-memory PKCE store: state → { codeVerifier, expiresAt }
const pkceStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pkceStore) if (v.expiresAt < now) pkceStore.delete(k);
}, 60_000);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SERVER_URL   = process.env.SERVER_URL   || 'http://localhost:3000';
const STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'dev-oauth-state-secret';

const ALLOWED_REDIRECT_PREFIXES = ['siberi://', 'exp://', FRONTEND_URL];

// ── State helpers (CSRF protection) ─────────────────────────────────────────
// redirectUrl is base64url-encoded inside state so colons don't break splitting
function makeState(provider, redirectUrl = '') {
  const ts  = Date.now().toString();
  const rd  = Buffer.from(redirectUrl).toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(`${provider}:${ts}:${rd}`).digest('hex').slice(0, 16);
  return Buffer.from(`${provider}:${ts}:${rd}:${sig}`).toString('base64url');
}

// Returns { redirectUrl } on success, null on failure
function verifyState(state, provider) {
  try {
    const decoded = Buffer.from(state, 'base64url').toString();
    const parts   = decoded.split(':');
    if (parts.length < 4) return null;
    const [p, ts, rd, sig] = parts;
    if (p !== provider)                      return null;
    if (Date.now() - parseInt(ts) > 600_000) return null;
    const expected = crypto.createHmac('sha256', STATE_SECRET).update(`${p}:${ts}:${rd}`).digest('hex').slice(0, 16);
    if (sig !== expected)                    return null;
    const redirectUrl = Buffer.from(rd, 'base64url').toString();
    return { redirectUrl };
  } catch { return null; }
}

function isSafeRedirect(url) {
  return !url || ALLOWED_REDIRECT_PREFIXES.some((p) => url.startsWith(p));
}

function redirectTarget(stateResult, token) {
  const base = (isSafeRedirect(stateResult?.redirectUrl) && stateResult?.redirectUrl)
    ? stateResult.redirectUrl
    : `${FRONTEND_URL}/login`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${token}`;
}

function fail(res, msg, redirectUrl = '') {
  const base = (isSafeRedirect(redirectUrl) && redirectUrl) ? redirectUrl : `${FRONTEND_URL}/login`;
  const sep  = base.includes('?') ? '&' : '?';
  return res.redirect(`${base}${sep}error=${encodeURIComponent(msg)}`);
}

// Запускает создание чата при OAuth-регистрации (не блокирует ответ)
function triggerChatCreation(aiService, userId, email) {
  setImmediate(async () => {
    try {
      let retries = 0;
      while (!aiService.isReady && retries < 30) {
        await new Promise((r) => setTimeout(r, 1000));
        retries++;
      }
      if (!aiService.isReady) return;
      const UserAiConfig = require('../models/UserAiConfig');
      const existing = await UserAiConfig.findOne({ userId });
      if (existing?.mistralChatId) return; // чат уже есть
      const chatId = await aiService.createChatOnRegistration(userId.toString(), email);
      if (chatId) {
        await UserAiConfig.findOneAndUpdate(
          { userId },
          { $setOnInsert: { userId, aiName: 'Помощник', systemPrompt: 'Ты — полезный AI-помощник Siberi AI', mistralChatId: chatId, hasPersonalThread: true } },
          { upsert: true, returnDocument: 'after' }
        );
      }
    } catch (e) {
      console.error('⚠️ OAuth: не удалось создать чат:', e.message);
    }
  });
}

// ════════════════════════════════════════
// GOOGLE — отключено (требования законодательства РФ)
// Существующие аккаунты сохранены; пользователи могут войти
// через «Забыли пароль?» чтобы установить email-пароль.
// ════════════════════════════════════════
router.get('/google', (req, res) => {
  const redirectUrl = req.query.redirect_url || '';
  return fail(res, 'Вход через Google недоступен. Используйте email и пароль (или «Забыли пароль?»).', redirectUrl || `${FRONTEND_URL}/login`);
});

router.get('/google/callback', (req, res) => {
  return fail(res, 'Вход через Google недоступен.', `${FRONTEND_URL}/login`);
});

// ════════════════════════════════════════
// YANDEX
// ════════════════════════════════════════
router.get('/yandex', (req, res) => {
  const redirectUrl = req.query.redirect_url || '';
  if (!process.env.YANDEX_CLIENT_ID) return fail(res, 'Yandex OAuth не настроен', redirectUrl);
  const redirectUri = `${SERVER_URL}/api/v1/auth/yandex/callback`;
  const params = new URLSearchParams({
    client_id:     process.env.YANDEX_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    state:         makeState('yandex', redirectUrl),
  });
  res.redirect(`https://oauth.yandex.ru/authorize?${params}`);
});

router.get('/yandex/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const sv = verifyState(state, 'yandex');
  if (error || !code) return fail(res, 'Авторизация Яндекс отменена', sv?.redirectUrl);
  if (!sv)            return fail(res, 'Неверный state, попробуйте снова');

  try {
    const redirectUri = `${SERVER_URL}/api/v1/auth/yandex/callback`;
    const tokenRes = await fetch('https://oauth.yandex.ru/token', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:  `Basic ${Buffer.from(`${process.env.YANDEX_CLIENT_ID}:${process.env.YANDEX_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return fail(res, 'Яндекс: не удалось получить токен', sv.redirectUrl);

    const profileRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${tokens.access_token}` },
    });
    const profile = await profileRes.json();

    const email       = profile.default_email || profile.emails?.[0] || null;
    const displayName = profile.real_name || profile.login || null;
    const phone       = profile.default_phone?.number || null;

    const { user, isNew } = await findOrCreateOAuthUser({
      provider: 'yandex', providerId: String(profile.id), email, displayName, phone,
    });
    if (isNew) triggerChatCreation(router._aiService, user._id, user.email);
    res.redirect(redirectTarget(sv, user.apiKey));
  } catch (err) {
    console.error('Yandex OAuth error:', err.message);
    fail(res, 'Ошибка авторизации через Яндекс', false);
  }
});

// ════════════════════════════════════════
// VK ID (id.vk.com — OAuth 2.1 + PKCE)
// ════════════════════════════════════════
router.get('/vk', (req, res) => {
  const redirectUrl   = req.query.redirect_url || '';
  if (!process.env.VK_CLIENT_ID) return fail(res, 'VK OAuth не настроен', redirectUrl);
  const redirectUri   = `${SERVER_URL}/api/v1/auth/vk/callback`;
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const deviceId      = crypto.randomBytes(16).toString('hex');
  const state         = makeState('vk', redirectUrl);

  pkceStore.set(state, { codeVerifier, deviceId, expiresAt: Date.now() + 300_000 });

  const params = new URLSearchParams({
    client_id:             process.env.VK_CLIENT_ID,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 'email',
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(`https://id.vk.com/authorize?${params}`);
});

router.get('/vk/callback', async (req, res) => {
  const { code, state, error, device_id: callbackDeviceId } = req.query;
  const sv = verifyState(state, 'vk');
  if (error || !code) return fail(res, 'Авторизация VK отменена', sv?.redirectUrl);
  if (!sv)            return fail(res, 'Неверный state, попробуйте снова');

  const pkce = pkceStore.get(state);
  if (!pkce) return fail(res, 'Сессия авторизации истекла, попробуйте снова');
  pkceStore.delete(state);

  try {
    const redirectUri = `${SERVER_URL}/api/v1/auth/vk/callback`;

    // VK ID: POST /oauth2/auth с параметрами в query string, code в теле
    // device_id берём из callback (VK присылает его), иначе fallback на наш
    const tokenParams = new URLSearchParams({
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
      client_id:     process.env.VK_CLIENT_ID,
      code_verifier: pkce.codeVerifier,
      state,
      device_id:     callbackDeviceId || pkce.deviceId,
      scope:         'email',
    });
    const tokenRes = await fetch(`https://id.vk.com/oauth2/auth?${tokenParams}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ code }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('VK token error:', tokens);
      return fail(res, 'VK: не удалось получить токен');
    }

    // Данные пользователя через VK ID user_info
    const userInfoParams = new URLSearchParams({ client_id: process.env.VK_CLIENT_ID });
    const userInfoRes = await fetch(`https://id.vk.com/oauth2/user_info?${userInfoParams}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ access_token: tokens.access_token }),
    });
    const userInfo = await userInfoRes.json();
    const u = userInfo.user || {};

    const vkId        = String(u.id || tokens.user_id);
    const email       = u.email || tokens.email || null;
    const phone       = u.phone || null;
    const displayName = [u.first_name, u.last_name].filter(Boolean).join(' ') || null;

    const { user, isNew } = await findOrCreateOAuthUser({
      provider: 'vk', providerId: vkId, email, displayName, phone,
    });
    if (isNew) triggerChatCreation(router._aiService, user._id, user.email);
    res.redirect(redirectTarget(sv, user.apiKey));
  } catch (err) {
    console.error('VK OAuth error:', err.message);
    fail(res, 'Ошибка авторизации через VK', false);
  }
});

// Factory: вызывается из index.js с aiService
router.setAiService = function (aiService) {
  router._aiService = aiService;
};

module.exports = router;
