'use strict';
const crypto = require('crypto');

// Middleware для admin-эндпоинтов: требует секретный заголовок X-Admin-Secret.
//
// Сравнение — постоянным по времени (timingSafeEqual), а не обычным !==. Обычное
// сравнение строк выходит на первом же несовпавшем символе, и время ответа
// зависит от того, сколько символов совпало. По сети разницу глушит джиттер, но
// приём известный, а цена защиты — три строки. Ровно так же уже сделано в
// routes/externalApi.js (timingEqual) — здесь просто не было доведено.
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // Длины сравниваем отдельно: timingSafeEqual на буферах разной длины бросает.
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

const adminGuard = (req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'Admin endpoints not configured (set ADMIN_SECRET)' });
  const provided = req.headers['x-admin-secret'];
  if (!provided || !timingSafeEqualStr(provided, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

module.exports = adminGuard;
