'use strict';
const axios = require('axios');

// In-memory OTP store: normalizedPhone → { code, expires, resendAfter, attempts }
const otpStore = new Map();

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '8') return '7' + digits.slice(1);
  if (digits.length === 11 && digits[0] === '7') return digits;
  if (digits.length === 10) return '7' + digits;
  return digits;
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function requestOtp(phone) {
  const normalized = normalizePhone(phone);
  if (normalized.length !== 11) {
    return { ok: false, error: 'Неверный формат номера телефона' };
  }

  const now = Date.now();
  const existing = otpStore.get(normalized);
  if (existing && existing.resendAfter > now) {
    const sec = Math.ceil((existing.resendAfter - now) / 1000);
    return { ok: false, error: `Подождите ${sec} сек. перед повторной отправкой`, retryAfter: sec };
  }

  const code = generateCode();
  otpStore.set(normalized, {
    code,
    expires: now + 5 * 60 * 1000,
    resendAfter: now + 60 * 1000,
    attempts: 0,
  });

  const apiId = process.env.SMS_RU_API_ID;
  if (!apiId) {
    // Dev mode: skip actual SMS, log code to console
    console.warn(`[SMS DEV] OTP for ${normalized}: ${code}`);
    return { ok: true, _devCode: code };
  }

  try {
    const resp = await axios.get('https://sms.ru/sms/send', {
      params: {
        api_id: apiId,
        to: normalized,
        msg: `Siberi.AI: ваш код ${code}. Никому не сообщайте.`,
        json: 1,
      },
      timeout: 10000,
    });

    const smsStatus = resp.data?.sms?.[normalized]?.status;
    if (resp.data?.status !== 'OK' || smsStatus !== 'OK') {
      otpStore.delete(normalized);
      console.error('[SMS] API error:', JSON.stringify(resp.data));
      return { ok: false, error: 'Не удалось отправить SMS. Попробуйте позже.' };
    }

    return { ok: true };
  } catch (err) {
    otpStore.delete(normalized);
    console.error('[SMS] Request error:', err.message);
    return { ok: false, error: 'Ошибка отправки SMS. Попробуйте позже.' };
  }
}

function verifyOtp(phone, code) {
  const normalized = normalizePhone(phone);
  const entry = otpStore.get(normalized);

  if (!entry) return { ok: false, error: 'Код не найден — запросите новый' };
  if (Date.now() > entry.expires) {
    otpStore.delete(normalized);
    return { ok: false, error: 'Код истёк — запросите новый' };
  }

  entry.attempts += 1;
  if (entry.attempts > 5) {
    otpStore.delete(normalized);
    return { ok: false, error: 'Слишком много попыток — запросите новый код' };
  }

  if (entry.code !== String(code).trim()) {
    return { ok: false, error: 'Неверный код' };
  }

  otpStore.delete(normalized);
  return { ok: true, phone: normalized };
}

module.exports = { requestOtp, verifyOtp, normalizePhone };
