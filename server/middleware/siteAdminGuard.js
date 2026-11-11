'use strict';
const User = require('../models/User');

const siteAdminGuard = async (req, res, next) => {
  try {
    const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!key) return res.status(401).json({ error: 'Unauthorized' });
    const user = await User.findOne({ apiKey: key });
    if (!user || !user.isSiteAdmin) return res.status(403).json({ error: 'Forbidden' });
    req.adminUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = siteAdminGuard;
