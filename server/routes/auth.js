'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { hashPassword, verifyPassword } = require('../helpers/crypto');
const User = require('../models/User');
const UserAiConfig = require('../models/UserAiConfig');
const aiService = require('../AiService');
const emailService = require('../emailService');

// === РЕГИСТРАЦИЯ ===
router.post('/auth/register', async (req, res) => {
  try {
    const { email, password, ref, acceptTerms } = req.body;

    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email и пароль (минимум 6 символов) обязательны' });
    }
    if (!acceptTerms) {
      return res.status(400).json({ error: 'Необходимо принять условия использования и политику конфиденциальности' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    const passwordHash = await hashPassword(password);
    const verifyToken = uuidv4();
    const user = new User({
      email: normalizedEmail,
      passwordHash,
      trialStart: new Date(),
      subscriptionStatus: 'expired',   // без бесплатного триала — доступ только по платному тарифу
      referredBy: ref ? ref.toUpperCase().trim() : null,
      emailVerified: false,
      emailVerifyToken: verifyToken,
      emailVerifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });
    await user.save();

    // Реферальная программа
    if (ref) {
      try {
        const UserAffiliate = require('../models/UserAffiliate');
        const referrer = await UserAffiliate.findOne({ referralCode: ref.toUpperCase().trim() });
        if (referrer) {
          referrer.referrals.push({ userId: user._id });
          referrer.notifications.push({ type: 'registration', joinedAt: user.createdAt || new Date() });
          await referrer.save();
        }
      } catch (e) {
        console.warn('Affiliate ref tracking error:', e.message);
      }
    }

    // Отправляем письмо подтверждения (async, не блокируем ответ)
    emailService.sendVerification(normalizedEmail, verifyToken).catch((e) =>
      console.error('Email send error:', e.message)
    );

    // Создание AI-чата
    setImmediate(async () => {
      try {
        let retries = 0;
        while (!aiService.isReady && retries < 30) {
          await new Promise((r) => setTimeout(r, 1000));
          retries++;
        }
        if (aiService.isReady) {
          const chatId = await aiService.createChatOnRegistration(user._id.toString(), normalizedEmail);
          if (chatId) {
            const config = new UserAiConfig({
              userId: user._id,
              aiName: 'Помощник',
              systemPrompt: 'Ты — полезный AI-помощник Siberi AI',
              mistralChatId: chatId,
              hasPersonalThread: true,
            });
            await config.save();
          }
        }
      } catch (chatErr) {
        console.error('⚠️ Не удалось создать чат при регистрации:', chatErr.message);
      }
    });

    const DEV_EMAIL = process.env.DEV_EMAIL || '';
    if (process.env.NODE_ENV !== 'production' && DEV_EMAIL && normalizedEmail === DEV_EMAIL) {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 9999);
      user.subscriptionStatus = 'active';
      user.subscriptionEnd = farFuture;
      user.emailVerified = true;
      user.emailVerifyToken = null;
      await user.save();
    }

    res.status(201).json({
      success: true,
      message: 'Регистрация успешна! Проверьте email для подтверждения.',
      emailSent: true,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Ошибка регистрации: ' + err.message });
  }
});

// === ПОДТВЕРЖДЕНИЕ EMAIL ===
router.get('/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Токен не указан' });

    const user = await User.findOne({
      emailVerifyToken: token,
      emailVerifyExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ error: 'Ссылка недействительна или устарела' });
    }

    user.emailVerified = true;
    user.emailVerifyToken = null;
    user.emailVerifyExpires = null;
    await user.save();

    // Отправляем приветственное письмо
    emailService.sendWelcome(user.email).catch(() => {});

    res.json({ success: true, apiKey: user.apiKey });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка подтверждения: ' + err.message });
  }
});

// === ПОВТОРНАЯ ОТПРАВКА ПИСЬМА ПОДТВЕРЖДЕНИЯ ===
router.post('/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обязателен' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email уже подтверждён' });

    const verifyToken = uuidv4();
    user.emailVerifyToken = verifyToken;
    user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    await emailService.sendVerification(user.email, verifyToken);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});

// === ЗАБЫЛИ ПАРОЛЬ ===
router.post('/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обязателен' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Always respond ok to prevent email enumeration
    if (!user) return res.json({ success: true });

    const resetToken = uuidv4();
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    emailService.sendPasswordReset(user.email, resetToken).catch((e) =>
      console.error('Password reset email error:', e.message)
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});

// === СБРОС ПАРОЛЯ ===
router.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 6) {
      return res.status(400).json({ error: 'Токен и новый пароль (минимум 6 символов) обязательны' });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: 'Ссылка недействительна или устарела' });

    user.passwordHash = await hashPassword(password);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});

// === ЛОГИН ===
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Введите корректный email адрес' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Один и тот же ответ и при отсутствии пользователя, и при неверном пароле.
    // Раньше здесь было «Пользователь с таким email не найден», и по разнице
    // ответов можно было прогнать список адресов и узнать, кто зарегистрирован.
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

    // OAuth-only accounts have no real password — guide user to reset
    if (user.passwordHash && user.passwordHash.startsWith('oauth:')) {
      const provider = user.passwordHash.split(':')[1];
      const names = { google: 'Google', yandex: 'Яндекс', vk: 'VK' };
      const pname = names[provider] || provider;
      return res.status(401).json({
        error: `Этот аккаунт был создан через ${pname}. Нажмите «Забыли пароль?» — мы пришлём ссылку на вашу почту, чтобы вы могли установить пароль и войти.`,
        isOAuthAccount: true,
      });
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk) return res.status(401).json({ error: 'Неверный email или пароль' });

    // Check if user is blocked
    if (user.blocked && user.blocked.isBlocked) {
      const now = new Date();
      if (!user.blocked.blockedUntil || user.blocked.blockedUntil > now) {
        const until = user.blocked.blockedUntil
          ? ` до ${user.blocked.blockedUntil.toLocaleDateString('ru-RU')}`
          : '';
        const reason = user.blocked.reason ? ` Причина: ${user.blocked.reason}.` : '';
        return res.status(403).json({
          error: `Ваш аккаунт заблокирован администрацией сайта${until}.${reason} По вопросам разблокировки обратитесь на hello@siberi.online`,
          blocked: true,
        });
      }
      // Block expired — auto-unblock
      user.blocked.isBlocked = false;
      user.blocked.reason = '';
      user.blocked.blockedAt = null;
      user.blocked.blockedUntil = null;
    }

    // Upgrade legacy base64 hash to scrypt on first successful login
    if (!user.passwordHash.startsWith('scrypt$')) {
      user.passwordHash = await hashPassword(password);
    }

    // Auto-verify legacy users (registered before email verification was introduced)
    if (user.emailVerified === undefined || user.emailVerified === null) {
      user.emailVerified = true;
    }

    user.lastActiveAt = new Date();
    await user.save();

    const DEV_EMAIL = process.env.DEV_EMAIL || '';
    if (process.env.NODE_ENV !== 'production' && DEV_EMAIL && user.email === DEV_EMAIL) {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 9999);
      if (user.subscriptionStatus !== 'active') {
        user.subscriptionStatus = 'active';
        user.subscriptionEnd = farFuture;
        await user.save();
      }
    }

    res.json({
      success: true,
      apiKey: user.apiKey,
      subscriptionStatus: user.subscriptionStatus,
      isAccessActive: user.isAccessActive(),
      emailVerified: user.emailVerified,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка входа: ' + err.message });
  }
});

// === PHONE OTP: REQUEST CODE ===
router.post('/auth/phone/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });

    const smsService = require('../services/smsService');
    const result = await smsService.requestOtp(phone);
    if (!result.ok) {
      return res.status(429).json({ error: result.error, retryAfter: result.retryAfter });
    }

    const resp = { success: true };
    if (result._devCode) resp._devCode = result._devCode;
    res.json(resp);
  } catch (err) {
    console.error('Phone OTP request error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === PHONE OTP: VERIFY & LOGIN/REGISTER ===
router.post('/auth/phone/verify', async (req, res) => {
  try {
    const { phone, code, acceptTerms, ref } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Укажите телефон и код' });

    const smsService = require('../services/smsService');
    const check = smsService.verifyOtp(phone, code);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const normalized = check.phone;
    let user = await User.findOne({ phone: normalized });

    if (!user) {
      if (!acceptTerms) {
        return res.status(400).json({ error: 'Необходимо принять условия использования', requireTerms: true });
      }

      const placeholderEmail = `+${normalized}@siberi.phone`;
      user = new User({
        email: placeholderEmail,
        phone: normalized,
        passwordHash: 'oauth:phone',
        trialStart: new Date(),
        subscriptionStatus: 'expired',   // без бесплатного триала — доступ только по платному тарифу
        emailVerified: true,
        referredBy: ref ? ref.toUpperCase().trim() : null,
      });
      await user.save();

      if (ref) {
        try {
          const UserAffiliate = require('../models/UserAffiliate');
          const referrer = await UserAffiliate.findOne({ referralCode: ref.toUpperCase().trim() });
          if (referrer) {
            referrer.referrals.push({ userId: user._id });
            referrer.notifications.push({ type: 'registration', joinedAt: new Date() });
            await referrer.save();
          }
        } catch (e) {
          console.warn('Affiliate ref tracking error:', e.message);
        }
      }

      setImmediate(async () => {
        try {
          let retries = 0;
          while (!aiService.isReady && retries < 30) {
            await new Promise((r) => setTimeout(r, 1000));
            retries++;
          }
          if (aiService.isReady) {
            const chatId = await aiService.createChatOnRegistration(user._id.toString(), placeholderEmail);
            if (chatId) {
              const config = new UserAiConfig({
                userId: user._id,
                aiName: 'Помощник',
                systemPrompt: 'Ты — полезный AI-помощник Siberi AI',
                mistralChatId: chatId,
                hasPersonalThread: true,
              });
              await config.save();
            }
          }
        } catch (chatErr) {
          console.error('⚠️ Не удалось создать чат при регистрации (phone):', chatErr.message);
        }
      });
    }

    if (user.blocked?.isBlocked) {
      const now = new Date();
      if (!user.blocked.blockedUntil || user.blocked.blockedUntil > now) {
        return res.status(403).json({ error: 'Ваш аккаунт заблокирован', blocked: true });
      }
      user.blocked.isBlocked = false;
    }

    user.lastActiveAt = new Date();
    await user.save();

    res.json({
      success: true,
      apiKey: user.apiKey,
      subscriptionStatus: user.subscriptionStatus,
      isAccessActive: user.isAccessActive(),
      emailVerified: user.emailVerified,
    });
  } catch (err) {
    console.error('Phone OTP verify error:', err);
    res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
  }
});

module.exports = router;
