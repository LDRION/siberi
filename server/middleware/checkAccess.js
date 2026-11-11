// middleware/checkAccess.js
const User = require('../models/User');
const EmbedToken = require('../models/EmbedToken');

// DEV bypass только по email — не по префиксу ключа (небезопасно)
const DEV_EMAIL = process.env.DEV_EMAIL || '';

module.exports = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({
                error: 'API key is missing',
                hint: 'Add header: Authorization: Bearer YOUR_API_KEY'
            });
        }

        const key = authHeader.replace('Bearer ', '').trim();

        // Базовая валидация формата ключа (UUID v4 без дефисов или стандартный)
        if (!key || key.length < 16 || key.length > 128) {
            return res.status(401).json({ error: 'Invalid API key format' });
        }

        let user = await User.findOne({ apiKey: key });

        if (!user) {
            // Try embed token lookup (short-lived token for widget embeds)
            const embedToken = await EmbedToken.findOne({ token: key, expiresAt: { $gt: new Date() } });
            if (embedToken) {
                user = await User.findById(embedToken.userId);
            }
        }

        if (!user) {
            return res.status(403).json({ error: 'Invalid API Key' });
        }

        // DEV bypass: только по email, только вне production
        if (process.env.NODE_ENV !== 'production' && DEV_EMAIL && user.email === DEV_EMAIL) {
            const farFuture = new Date();
            farFuture.setFullYear(farFuture.getFullYear() + 9999);
            if (user.subscriptionStatus !== 'active' || !user.subscriptionEnd || user.subscriptionEnd < new Date()) {
                user.subscriptionStatus = 'active';
                user.trialStart = user.trialStart || new Date();
                user.subscriptionEnd = farFuture;
                await user.save();
            }
            req.user = user;
            return next();
        }

        // Activate pending referral bonus once the current subscription expires
        const now = new Date();
        if (
          user.pendingBonus?.plan &&
          user.pendingBonus?.days &&
          !(user.subscriptionStatus === 'active' && user.subscriptionEnd > now)
        ) {
          user.plan             = user.pendingBonus.plan;
          user.subscriptionStatus = 'active';
          user.subscriptionEnd  = new Date(now.getTime() + user.pendingBonus.days * 86400000);
          user.pendingBonus     = undefined;
          await user.save();
        }

        if (!user.isAccessActive?.()) {
            let hint = 'Please renew your subscription';
            if (user.subscriptionStatus === 'trial') hint = 'Trial period ended. Subscribe to continue.';
            else if (user.subscriptionStatus === 'expired') hint = 'Subscription expired. Please renew.';
            else if (user.subscriptionStatus === 'cancelled') hint = 'Subscription cancelled.';

            return res.status(403).json({
                error: 'Access denied',
                reason: user.subscriptionStatus,
                subscriptionEnd: user.subscriptionEnd,
                hint,
            });
        }

        req.user = user;
        user.lastActiveAt = new Date();
        user.save().catch(() => {});
        next();

    } catch (err) {
        console.error('❌ checkAccess error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};