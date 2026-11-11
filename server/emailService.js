/**
 * emailService.js — Siberi.AI
 * Sends transactional emails via SMTP (nodemailer).
 * Falls back to console logging if SMTP env vars are not configured.
 *
 * Required env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * Optional:
 *   APP_URL (defaults to https://siberi.online)
 */

const APP_URL = process.env.APP_URL || 'https://siberi.online';
const FROM    = process.env.SMTP_FROM || '"Siberi.AI" <noreply@siberi.online>';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host:             process.env.SMTP_HOST,
      port:             parseInt(process.env.SMTP_PORT),
      secure:           process.env.SMTP_SECURE === 'true',
      auth:             { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 8000,
      greetingTimeout:   8000,
    });
    return transporter;
  } catch {
    return null;
  }
}

// ── Shared HTML layout ────────────────────────────────────────────────────────
function layout(title, bodyHtml) {
  const robot = `${APP_URL}/email/robot.png`;
  return `<!DOCTYPE html>
<html lang="ru" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark light" />
  <meta name="supported-color-schemes" content="dark light" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#000000;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#000000;">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">

          <!-- Card -->
          <tr>
            <td style="background:#141417;border:1px solid #26262b;border-radius:20px;padding:30px 36px 26px;">

              <!-- Header: robot + brand -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 22px;">
                <tr><td align="center" style="padding-bottom:14px;">
                  <img src="${robot}" width="112" height="112" alt="Siberi AI" style="display:block;width:112px;height:112px;border:0;border-radius:28px;margin:0 auto;" />
                </td></tr>
                <tr><td align="center" style="font-family:'Space Grotesk','Segoe UI',Arial,sans-serif;font-size:19px;font-weight:bold;color:#f3f3f6;line-height:1.4;">
                  <span style="letter-spacing:2px;">SIBERI<span style="color:#b9b9c6;">&nbsp;AI</span></span><span style="color:#4a4a52;padding:0 7px;">·</span><span>${title}</span>
                </td></tr>
              </table>

              ${bodyHtml}

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px 4px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#4a4a52;">
              <a href="https://t.me/SiberiNews" style="color:#5c5c64;text-decoration:underline;">Новости продукта в Telegram · @SiberiNews</a><br />
              <span style="display:inline-block;padding-top:6px;"><a href="${APP_URL}/oferta" style="color:#5c5c64;text-decoration:underline;">Оферта</a>&nbsp;·&nbsp;<a href="${APP_URL}/privacy" style="color:#5c5c64;text-decoration:underline;">Конфиденциальность</a>&nbsp;·&nbsp;© Siberi&nbsp;AI</span>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function btn(url, text) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 4px;">
    <tr>
      <td align="center" bgcolor="#f3f3f6" style="border-radius:12px;">
        <a href="${url}" target="_blank" style="display:inline-block;padding:14px 36px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#0b0b0d;text-decoration:none;border-radius:12px;">${text}</a>
      </td>
    </tr>
  </table>`;
}

function note(text) {
  return `<p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.55;color:#74747e;text-align:center;">${text}</p>`;
}

// ── Templates ─────────────────────────────────────────────────────────────────

function verifyEmailHtml(email, token) {
  const url = `${APP_URL}/verify-email?verify=${token}`;
  const body = `
    <p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;color:#9a9aa3;line-height:1.55;text-align:center;">
      Вы зарегистрировались на <strong style="color:#f3f3f6;">Siberi&nbsp;AI</strong>. Остался один шаг — подтвердите адрес электронной почты.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;"><tr>
      <td style="background:#0e0f12;border:1px solid #26262b;border-radius:12px;padding:15px 22px;text-align:center;">
        <span style="font-family:Arial,sans-serif;font-size:12px;color:#74747e;">Ваш email:&nbsp;</span>
        <span style="font-family:Arial,sans-serif;font-size:15px;font-weight:600;color:#f3f3f6;">${email}</span>
      </td>
    </tr></table>
    ${btn(url, 'Подтвердить email')}
    ${note('Ссылка действует 24 часа. Если вы не регистрировались — просто проигнорируйте это письмо.')}
  `;
  return layout('Подтвердите email', body);
}

function resetPasswordHtml(email, token) {
  const url = `${APP_URL}/reset-password?reset=${token}`;
  const body = `
    <p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;color:#9a9aa3;line-height:1.55;text-align:center;">
      Мы получили запрос на сброс пароля для аккаунта <strong style="color:#f3f3f6;">${email}</strong>.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;"><tr>
      <td style="background:#1c1408;border:1px solid #6a4e1a;border-radius:12px;padding:14px 20px;">
        <span style="font-family:Arial,sans-serif;font-size:12.5px;color:#e6a23c;line-height:1.5;">⚠️ Если вы не запрашивали сброс — смените пароль и напишите нам на <a href="mailto:hello@siberi.online" style="color:#e6a23c;">hello@siberi.online</a></span>
      </td>
    </tr></table>
    ${btn(url, 'Сбросить пароль')}
    ${note('Ссылка действует 1 час. После использования она становится недействительной.')}
  `;
  return layout('Сброс пароля', body);
}

function welcomeHtml(email) {
  const body = `
    <p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;color:#9a9aa3;line-height:1.55;text-align:center;">
      Ваш email подтверждён 🎉 Теперь доступны все функции: AI-ассистент, интеграции с Telegram, VK и сайтом, управление данными и многое другое.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;"><tr>
      <td style="background:#0a1a12;border:1px solid #1f5a3a;border-radius:12px;padding:18px 22px;">
        <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;color:#46d39a;">🎁 Ваш пробный период:</p>
        <ul style="margin:0;padding-left:20px;font-family:Arial,sans-serif;font-size:13.5px;color:#8fcdb0;line-height:1.8;">
          <li>7 дней бесплатного доступа</li>
          <li>Все функции Premium уровня</li>
          <li>Без банковской карты и ограничений по запросам</li>
        </ul>
      </td>
    </tr></table>
    ${btn(`${APP_URL}/dashboard`, 'Перейти в личный кабинет')}
    ${note('Есть вопросы? Напишите нам: <a href="mailto:hello@siberi.online" style="color:#9a9aa3;">hello@siberi.online</a>')}
  `;
  return layout('Email подтверждён', body);
}

// ── Send helper ───────────────────────────────────────────────────────────────
async function send({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    // No SMTP configured — log to console for local dev
    console.log(`\n📧 [EMAIL — no SMTP configured, printing to console]\nTo: ${to}\nSubject: ${subject}\n`);
    return;
  }
  await t.sendMail({ from: FROM, to, subject, html });
}

// ── Public API ────────────────────────────────────────────────────────────────
module.exports = {
  async sendVerification(email, token) {
    await send({
      to: email,
      subject: 'Siberi.AI — Подтвердите email',
      html: verifyEmailHtml(email, token),
    });
  },

  async sendPasswordReset(email, token) {
    await send({
      to: email,
      subject: 'Siberi.AI — Сброс пароля',
      html: resetPasswordHtml(email, token),
    });
  },

  async sendWelcome(email) {
    await send({
      to: email,
      subject: 'Siberi.AI — Добро пожаловать! 🎉',
      html: welcomeHtml(email),
    });
  },
};
