'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const Lead = require('../models/Lead');

const router = express.Router();

// Заявки с лендинга — публичный эндпоинт. Небольшой лимит от спама.
const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много заявок. Попробуйте позже или напишите нам в Telegram.' },
});

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Уведомление владельцу/админам в Telegram (тем же ботом @SiberiAi_bot).
// Работает независимо от рубильника BOTS_DISABLED — это исходящее сообщение.
async function notifyAdmins(lead) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const ids = (process.env.PLATFORM_ADMIN_IDS || '').split(/[\s,]+/).filter(Boolean);
    if (!token || !ids.length) return;
    const text =
      `🔥 <b>Новая заявка — Siberi</b>\n\n` +
      `<b>Имя:</b> ${esc(lead.name) || '—'}\n` +
      `<b>Контакт:</b> ${esc(lead.contact)}\n` +
      (lead.niche ? `<b>Сфера:</b> ${esc(lead.niche)}\n` : '') +
      (lead.message ? `<b>Сообщение:</b> ${esc(lead.message)}\n` : '') +
      `\n<i>${new Date().toLocaleString('ru-RU')} · источник: ${esc(lead.source)}</i>`;
    await Promise.all(ids.map((id) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      }).catch(() => {})
    ));
  } catch { /* уведомление — best-effort, на сохранение заявки не влияет */ }
}

router.post('/lead', leadLimiter, async (req, res) => {
  try {
    const { name, contact, niche, message, source } = req.body || {};
    if (!contact || !String(contact).trim()) {
      return res.status(400).json({ error: 'Оставьте контакт, чтобы мы связались с вами.' });
    }
    const lead = await Lead.create({
      name, contact, niche, message,
      source: (source || 'landing').slice(0, 60),
      ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    notifyAdmins(lead); // fire-and-forget
    return res.json({ success: true });
  } catch (err) {
    console.error('Lead submit error:', err.message);
    return res.status(500).json({ error: 'Не удалось отправить заявку. Попробуйте ещё раз.' });
  }
});

module.exports = router;
