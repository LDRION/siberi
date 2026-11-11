'use strict';
const User = require('../models/User');

// Lightweight auth: verifies API key only, no subscription check (used for payment/billing)
async function authenticateOnly(req, res, next) {
  try {
    const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!key || key.length < 16) return res.status(401).json({ error: 'API key missing' });
    const user = await User.findOne({ apiKey: key });
    if (!user) return res.status(403).json({ error: 'Invalid API key' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = authenticateOnly;
