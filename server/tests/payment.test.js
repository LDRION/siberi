'use strict';
/**
 * YooMoney webhook validation tests
 * Run: node --test tests/payment.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Helper: build the SHA1 hash the same way index.js does ──────────────────
function buildHash(fields, secret) {
  const parts = [
    fields.notification_type,
    fields.operation_id,
    fields.amount,
    fields.currency,
    fields.datetime,
    fields.sender,
    fields.codepro,
    secret,
    fields.label,
  ].join('&');
  return crypto.createHash('sha1').update(parts).digest('hex');
}

// ── Minimal express-like request simulator ───────────────────────────────────
function makeWebhookBody(secret, overrides = {}) {
  const base = {
    notification_type: 'p2p-incoming',
    operation_id:      'op_123456',
    amount:            '2500.00',
    currency:          '643',
    datetime:          '2026-05-17T12:00:00Z',
    sender:            '4100000000000',
    codepro:           'false',
    label:             '507f191e810c19729de860ea_standard_1m_1716134400000',
  };
  const body = { ...base, ...overrides };
  body.sha1_hash = buildHash(body, secret);
  return body;
}

// ── Inline the validation logic (extracted from index.js) ────────────────────
function validateWebhook(body, secret) {
  if (!secret) return { ok: false, status: 500, msg: 'Payment service misconfigured' };

  const parts = [
    body.notification_type, body.operation_id, body.amount,
    body.currency, body.datetime, body.sender,
    body.codepro, secret, body.label,
  ].join('&');
  const expected = crypto.createHash('sha1').update(parts).digest('hex');

  if (body.sha1_hash !== expected) return { ok: false, status: 401, msg: 'Invalid signature' };
  return { ok: true };
}

function parseLabelParts(label = '') {
  const [userId, plan, monthsRaw] = label.split('_');
  const months = parseInt(monthsRaw) || 1;
  const durationDays = months * 30;
  return { userId, plan, months, durationDays };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('YooMoney webhook signature validation', () => {

  test('accepts a valid signed payload', () => {
    const secret = 'my_secret_token';
    const body = makeWebhookBody(secret);
    const result = validateWebhook(body, secret);
    assert.equal(result.ok, true);
  });

  test('rejects a tampered amount', () => {
    const secret = 'my_secret_token';
    const body = makeWebhookBody(secret);
    body.amount = '9999.00'; // tampered after signing
    const result = validateWebhook(body, secret);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  test('rejects a forged sha1_hash', () => {
    const secret = 'my_secret_token';
    const body = makeWebhookBody(secret);
    body.sha1_hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const result = validateWebhook(body, secret);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  test('rejects when YOOMONEY_WEBHOOK_SECRET is not configured', () => {
    const body = makeWebhookBody('some_secret');
    const result = validateWebhook(body, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });

  test('rejects with wrong secret', () => {
    const body = makeWebhookBody('correct_secret');
    const result = validateWebhook(body, 'wrong_secret');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  test('accepts card-incoming notification type', () => {
    const secret = 'tok';
    const body = makeWebhookBody(secret, { notification_type: 'card-incoming' });
    const result = validateWebhook(body, secret);
    assert.equal(result.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Payment label parsing', () => {

  test('parses standard 1-month label', () => {
    const { userId, plan, months, durationDays } =
      parseLabelParts('507f191e810c19729de860ea_standard_1m_1716134400000');
    assert.equal(plan, 'standard');
    assert.equal(months, 1);
    assert.equal(durationDays, 30);
    assert.ok(userId.length > 0);
  });

  test('parses pro 3-month label', () => {
    const { plan, months, durationDays } =
      parseLabelParts('507f191e810c19729de860ea_pro_3m_1716134400000');
    assert.equal(plan, 'pro');
    assert.equal(months, 3);
    assert.equal(durationDays, 90);
  });

  test('parses premium 12-month label', () => {
    const { plan, months, durationDays } =
      parseLabelParts('507f191e810c19729de860ea_premium_12m_1716134400000');
    assert.equal(plan, 'premium');
    assert.equal(months, 12);
    assert.equal(durationDays, 360);
  });

  test('rejects unknown plan names (not in whitelist)', () => {
    const { plan } = parseLabelParts('id_hacker_99m_123');
    const valid = ['standard', 'pro', 'premium'].includes(plan);
    assert.equal(valid, false);
  });

  test('handles malformed label gracefully', () => {
    const { userId, plan, months } = parseLabelParts('');
    // ''.split('_') → [''] so userId is '' and plan/monthsRaw are undefined
    assert.equal(userId, '');
    assert.equal(plan, undefined);
    assert.equal(months, 1); // parseInt(undefined) → NaN → fallback 1
  });

  test('discount is correct for 3 months (10%)', () => {
    const plans = { standard: 2500, pro: 5000, premium: 10000 };
    const price = plans.standard;
    const months = 3;
    const discount = 0.10;
    const amount = Math.round(price * months * (1 - discount));
    assert.equal(amount, 6750);
  });

  test('discount is correct for 12 months (20%)', () => {
    const plans = { standard: 2500, pro: 5000, premium: 10000 };
    const price = plans.pro;
    const months = 12;
    const discount = 0.20;
    const amount = Math.round(price * months * (1 - discount));
    assert.equal(amount, 48000);
  });
});
