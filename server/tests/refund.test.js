'use strict';
/**
 * Refund handling + idempotency (T-Bank webhook → grantSubscription/revokeSubscription).
 * Faithful logic mirror of routes/payment.js — same self-contained style as the
 * other tests (no live DB). Locks the two "leaky cash register" guards зверёныш
 * asked to verify: repeat notifications don't double-grant, and a refund revokes
 * access. The full path is additionally covered by a live isolated E2E.
 * Run: node --test tests/refund.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const DAY = 86400000;

// Mirror of grantSubscription's idempotency + activation (simplified to the
// fields that matter here).
function grant(user, { paymentId, durationDays, plan }) {
  if (paymentId && (user.paymentHistory || []).some((p) => p.paymentId === String(paymentId))) return; // idempotent
  const now = Date.now();
  const hasActive = user.subscriptionStatus === 'active' && user.subscriptionEnd && user.subscriptionEnd.getTime() > now;
  const base = hasActive ? user.subscriptionEnd.getTime() : now;
  user.subscriptionStatus = 'active';
  user.subscriptionEnd = new Date(base + durationDays * DAY);
  if (plan) user.plan = plan;
  user.paymentHistory.push({ paymentId: String(paymentId), durationDays, plan, refunded: false });
}

// Mirror of revokeSubscription.
function revoke(user, { paymentId }) {
  const entry = (user.paymentHistory || []).find((p) => p.paymentId === String(paymentId));
  if (!entry || entry.refunded) return; // idempotent
  entry.refunded = true;
  const days = Number(entry.durationDays) || 0;
  if (user.subscriptionEnd && days > 0) {
    const rolled = new Date(user.subscriptionEnd.getTime() - days * DAY);
    user.subscriptionEnd = rolled;
    if (rolled.getTime() <= Date.now()) user.subscriptionStatus = 'expired';
  }
}

const mkUser = () => ({ subscriptionStatus: 'trial', subscriptionEnd: null, plan: 'standard', paymentHistory: [] });

describe('idempotency — repeat CONFIRMED notification', () => {
  test('same PaymentId twice grants only once', () => {
    const u = mkUser();
    grant(u, { paymentId: 'p1', durationDays: 360, plan: 'tgpremium' });
    const end1 = u.subscriptionEnd.getTime();
    grant(u, { paymentId: 'p1', durationDays: 360, plan: 'tgpremium' }); // retry
    assert.equal(u.paymentHistory.length, 1);
    assert.equal(u.subscriptionEnd.getTime(), end1); // not extended twice
    assert.equal(u.subscriptionStatus, 'active');
  });

  test('different PaymentIds stack (real renewals still work)', () => {
    const u = mkUser();
    grant(u, { paymentId: 'p1', durationDays: 30, plan: 'tgletbot' });
    const end1 = u.subscriptionEnd.getTime();
    grant(u, { paymentId: 'p2', durationDays: 30, plan: 'tgletbot' });
    assert.equal(u.paymentHistory.length, 2);
    assert.ok(u.subscriptionEnd.getTime() > end1); // extended
  });
});

describe('refund — revoke access', () => {
  test('REFUNDED rolls back the granted term and expires when it falls in the past', () => {
    const u = mkUser();
    grant(u, { paymentId: 'p1', durationDays: 360, plan: 'tgpremium' });
    revoke(u, { paymentId: 'p1' });
    const entry = u.paymentHistory.find((p) => p.paymentId === 'p1');
    assert.equal(entry.refunded, true);
    assert.equal(u.subscriptionStatus, 'expired');
    assert.ok(u.subscriptionEnd.getTime() <= Date.now());
  });

  test('repeat REFUNDED does not roll back twice', () => {
    const u = mkUser();
    grant(u, { paymentId: 'p1', durationDays: 360, plan: 'tgpremium' });
    revoke(u, { paymentId: 'p1' });
    const endAfter = u.subscriptionEnd.getTime();
    revoke(u, { paymentId: 'p1' }); // retry
    assert.equal(u.subscriptionEnd.getTime(), endAfter);
  });

  test('refund of one of two payments leaves remaining term active', () => {
    const u = mkUser();
    grant(u, { paymentId: 'p1', durationDays: 30, plan: 'tgletbot' });
    grant(u, { paymentId: 'p2', durationDays: 30, plan: 'tgletbot' }); // now ~60 days out
    revoke(u, { paymentId: 'p1' }); // remove 30 days → still ~30 days in the future
    assert.equal(u.subscriptionStatus, 'active');
    assert.ok(u.subscriptionEnd.getTime() > Date.now());
  });

  test('revoke on an unknown paymentId is a no-op', () => {
    const u = mkUser();
    grant(u, { paymentId: 'p1', durationDays: 30, plan: 'tgletbot' });
    const before = u.subscriptionEnd.getTime();
    revoke(u, { paymentId: 'nope' });
    assert.equal(u.subscriptionEnd.getTime(), before);
    assert.equal(u.subscriptionStatus, 'active');
  });
});
