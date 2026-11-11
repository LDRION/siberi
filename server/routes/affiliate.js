const express = require('express');
const router = express.Router();
const UserAffiliate = require('../models/UserAffiliate');
const User = require('../models/User');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function isAdmin(user) {
  return ADMIN_EMAILS.includes(user.email.toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

// GET /api/v1/affiliate/info
router.get('/info', async (req, res) => {
  try {
    const affiliate = await UserAffiliate.findOne({ userId: req.user._id }).lean();
    if (!affiliate) {
      return res.json({ success: true, joined: false, isAdmin: isAdmin(req.user) });
    }

    const notifications = (affiliate.notifications || []).slice().reverse().slice(0, 100);
    res.json({
      success: true,
      joined: true,
      isAdmin: isAdmin(req.user),
      referralCode:        affiliate.referralCode,
      balance:             affiliate.balance,
      totalEarned:         affiliate.totalEarned,
      totalWithdrawn:      affiliate.totalWithdrawn,
      referralCount:       affiliate.referrals.length,
      activeReferrals:     affiliate.referrals.filter(r => r.totalPaid > 0).length,
      referrals:           affiliate.referrals.slice(-50).reverse(),
      payouts:             (affiliate.payouts || []).sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt)),
      notifications,
      unreadNotifications: (affiliate.notifications || []).filter(n => !n.read).length,
      joinedAt:            affiliate.joinedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/affiliate/join
router.post('/join', async (req, res) => {
  try {
    const existing = await UserAffiliate.findOne({ userId: req.user._id });
    if (existing) return res.json({ success: true, referralCode: existing.referralCode });

    let code, attempts = 0;
    do {
      code = generateCode();
      attempts++;
    } while (attempts < 10 && await UserAffiliate.findOne({ referralCode: code }));

    const affiliate = new UserAffiliate({ userId: req.user._id, referralCode: code });
    await affiliate.save();
    res.json({ success: true, referralCode: code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/affiliate/notifications/read
router.post('/notifications/read', async (req, res) => {
  try {
    const affiliate = await UserAffiliate.findOne({ userId: req.user._id });
    if (!affiliate) return res.status(404).json({ error: 'Не участник программы' });
    affiliate.notifications.forEach(n => { n.read = true; });
    await affiliate.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/affiliate/withdraw
router.post('/withdraw', async (req, res) => {
  try {
    const { amount, paymentDetails } = req.body;
    const num = Number(amount);
    if (!num || num < 1000) return res.status(400).json({ error: 'Минимальная сумма вывода — 1 000 ₽' });
    if (!paymentDetails?.trim()) return res.status(400).json({ error: 'Укажите реквизиты для выплаты' });

    const affiliate = await UserAffiliate.findOne({ userId: req.user._id });
    if (!affiliate) return res.status(404).json({ error: 'Вы не участник партнёрской программы' });
    if (affiliate.balance < num) return res.status(400).json({ error: 'Недостаточно средств на балансе' });
    if (affiliate.payouts.some(p => p.status === 'pending')) {
      return res.status(400).json({ error: 'У вас уже есть необработанный запрос на вывод' });
    }

    affiliate.payouts.push({ amount: num, paymentDetails: paymentDetails.trim() });
    await affiliate.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

// GET /api/v1/affiliate/admin/requests
router.get('/admin/requests', requireAdmin, async (req, res) => {
  try {
    const affiliates = await UserAffiliate.find({ 'payouts.status': 'pending' })
      .populate('userId', 'email').lean();

    const requests = [];
    for (const aff of affiliates) {
      for (const payout of aff.payouts) {
        if (payout.status === 'pending') {
          requests.push({
            affiliateId:    aff._id,
            payoutId:       payout._id,
            userEmail:      aff.userId?.email,
            referralCode:   aff.referralCode,
            amount:         payout.amount,
            paymentDetails: payout.paymentDetails,
            requestedAt:    payout.requestedAt,
            balance:        aff.balance,
          });
        }
      }
    }

    requests.sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt));
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/affiliate/admin/approve/:payoutId
router.post('/admin/approve/:payoutId', requireAdmin, async (req, res) => {
  try {
    const { affiliateId } = req.body;
    const affiliate = await UserAffiliate.findById(affiliateId);
    if (!affiliate) return res.status(404).json({ error: 'Партнёр не найден' });

    const payout = affiliate.payouts.id(req.params.payoutId);
    if (!payout || payout.status !== 'pending') {
      return res.status(400).json({ error: 'Запрос не найден или уже обработан' });
    }
    if (affiliate.balance < payout.amount) {
      return res.status(400).json({ error: 'Недостаточно средств у партнёра' });
    }

    payout.status = 'approved';
    payout.processedAt = new Date();
    affiliate.balance -= payout.amount;
    affiliate.totalWithdrawn += payout.amount;
    await affiliate.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/affiliate/admin/reject/:payoutId
router.post('/admin/reject/:payoutId', requireAdmin, async (req, res) => {
  try {
    const { affiliateId, note } = req.body;
    const affiliate = await UserAffiliate.findById(affiliateId);
    if (!affiliate) return res.status(404).json({ error: 'Партнёр не найден' });

    const payout = affiliate.payouts.id(req.params.payoutId);
    if (!payout || payout.status !== 'pending') {
      return res.status(400).json({ error: 'Запрос не найден или уже обработан' });
    }

    payout.status = 'rejected';
    payout.processedAt = new Date();
    if (note) payout.adminNote = note.trim();
    await affiliate.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/affiliate/admin/credit  — ручное начисление
router.post('/admin/credit', requireAdmin, async (req, res) => {
  try {
    const { referralCode, amount } = req.body;
    const num = Number(amount);
    if (!referralCode || !num || num <= 0) {
      return res.status(400).json({ error: 'Укажите код партнёра и сумму' });
    }
    const affiliate = await UserAffiliate.findOne({ referralCode: referralCode.toUpperCase() });
    if (!affiliate) return res.status(404).json({ error: 'Партнёр с таким кодом не найден' });

    affiliate.balance += num;
    affiliate.totalEarned += num;
    await affiliate.save();
    res.json({ success: true, newBalance: affiliate.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
