'use strict';
const User = require('../models/User');

// ── Find or create user by OAuth-style provider identity ──────────────────────
// Shared by website OAuth logins (google/yandex/vk) and TGLetBot's Telegram-ID
// based onboarding. `trialDurationDays` lets callers shorten the trial for
// channels other than the website (e.g. TGLetBot's 7-day trial vs the default 30).
async function findOrCreateOAuthUser({ provider, providerId, email, displayName, phone, trialDurationDays }) {
  const field = `${provider}Id`;

  // 1. Find by provider ID
  let user = await User.findOne({ [field]: providerId });
  if (user) {
    if (phone && !user.phone) { user.phone = phone; }
    user.lastActiveAt = new Date();
    await user.save();
    return { user, isNew: false };
  }

  // 2. Link to existing account by email
  if (email) {
    user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      user[field]        = providerId;
      user.emailVerified = true;
      if (displayName && !user.displayName) user.displayName = displayName;
      if (phone && !user.phone) user.phone = phone;
      user.lastActiveAt  = new Date();
      await user.save();
      return { user, isNew: false };
    }
  }

  // 3. Create new user
  const now = new Date();
  user = new User({
    email:              email?.toLowerCase() || `${provider}_${providerId}@oauth.local`,
    passwordHash:       `oauth:${provider}:${providerId}`,
    [field]:            providerId,
    displayName:        displayName || '',
    phone:              phone || null,
    emailVerified:      true,
    subscriptionStatus: 'trial',
    trialStart:         now,
    trialDurationDays:  trialDurationDays || 30,
    lastActiveAt:       now,
  });
  await user.save();
  return { user, isNew: true };
}

module.exports = { findOrCreateOAuthUser };
