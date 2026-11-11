'use strict';
const crypto = require('crypto');

// ── Secure password hashing via Node.js built-in scrypt ──────────────────────
// Backward-compatible: old base64 passwords still work, rehashed on next login.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`scrypt$${salt}$${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  if (stored && stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    const salt = parts[1];
    const hash = parts[2];
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, key) => {
        if (err) reject(err);
        else {
          try { resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), key)); }
          catch { resolve(false); }
        }
      });
    });
  }
  // Legacy base64 migration — resolves synchronously
  return Promise.resolve(Buffer.from(password).toString('base64') === stored);
}

module.exports = { hashPassword, verifyPassword };
