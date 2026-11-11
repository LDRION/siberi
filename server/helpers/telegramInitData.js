'use strict';
const crypto = require('crypto');

// Validates Telegram Mini App `initData` per Telegram's documented algorithm:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Kept free of Express/Mongo so it can be exercised directly from a script.
function validateTelegramInitData(initData, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!botToken || !initData || typeof initData !== 'string') return { valid: false };

  let parsed;
  try {
    parsed = new URLSearchParams(initData);
  } catch {
    return { valid: false };
  }

  const hash = parsed.get('hash');
  if (!hash) return { valid: false };
  parsed.delete('hash');

  const dataCheckString = Array.from(parsed.keys())
    .sort()
    .map((key) => `${key}=${parsed.get(key)}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuf = Buffer.from(hash, 'hex');
  const computedBuf = Buffer.from(computedHash, 'hex');
  if (hashBuf.length !== computedBuf.length || !crypto.timingSafeEqual(hashBuf, computedBuf)) {
    return { valid: false };
  }

  const authDate = parseInt(parsed.get('auth_date'), 10);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return { valid: false };
  }

  let user;
  try {
    user = JSON.parse(parsed.get('user') || '');
  } catch {
    return { valid: false };
  }
  if (!user || (user.id == null)) return { valid: false };

  return { valid: true, user };
}

module.exports = { validateTelegramInitData };
