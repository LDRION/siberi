'use strict';
/**
 * T-Bank (Т-Касса) acquiring helper — token, notification verification, OrderId.
 * The token vector below was ACCEPTED by the live DEMO terminal (Init returned
 * Success:true), so it locks the signature algorithm against regressions.
 * Run: node --test tests/tbank.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const tbank = require('../helpers/tbank');

const DEMO_PASS = 'XqF6OHT&3NSilB^F';

describe('tbank.signToken', () => {
  test('reproduces the token the live DEMO terminal accepted', () => {
    const token = tbank.signToken({
      TerminalKey: '1783700349076DEMO',
      Amount: 10000,
      OrderId: 'probe_1783940814608',
      Description: 'Siberi.AI — проверка терминала',
    }, DEMO_PASS);
    assert.equal(token, '52880309390f97e3410965a6816f258f07a6f674767386dda9f0aa07d448591a');
  });

  test('excludes nested objects (DATA/Receipt) and the Token field itself', () => {
    const base = { TerminalKey: 'T', Amount: 100, OrderId: 'o1' };
    const withNested = { ...base, DATA: { a: 1 }, Receipt: { items: [] }, Token: 'zzz' };
    assert.equal(tbank.signToken(base, DEMO_PASS), tbank.signToken(withNested, DEMO_PASS));
  });

  test('booleans serialize as true/false (T-Bank notification rule)', () => {
    const t1 = tbank.signToken({ TerminalKey: 'T', Success: true, Status: 'CONFIRMED' }, DEMO_PASS);
    const t2 = tbank.signToken({ TerminalKey: 'T', Success: 'true', Status: 'CONFIRMED' }, DEMO_PASS);
    assert.equal(t1, t2); // boolean true and string 'true' must produce the same hash
  });

  test('is order-independent (keys are sorted before concatenation)', () => {
    const a = tbank.signToken({ TerminalKey: 'T', Amount: 100, OrderId: 'o' }, DEMO_PASS);
    const b = tbank.signToken({ OrderId: 'o', Amount: 100, TerminalKey: 'T' }, DEMO_PASS);
    assert.equal(a, b);
  });
});

describe('tbank.verifyNotification', () => {
  // A realistic CONFIRMED notification, signed with the DEMO password.
  function signedNotification(overrides = {}) {
    const body = {
      TerminalKey: '1783700349076DEMO',
      OrderId: '6512a1b2c3d4e5f60718293a_p12_abc123',
      Success: true,
      Status: 'CONFIRMED',
      PaymentId: '8848612270',
      ErrorCode: '0',
      Amount: 160000,
      ...overrides,
    };
    body.Token = tbank.signToken(body, DEMO_PASS);
    return body;
  }

  test('accepts a correctly signed notification', () => {
    assert.equal(tbank.verifyNotification(signedNotification(), DEMO_PASS), true);
  });

  test('rejects a tampered amount (signature no longer matches)', () => {
    const n = signedNotification();
    n.Amount = 1; // tamper after signing
    assert.equal(tbank.verifyNotification(n, DEMO_PASS), false);
  });

  test('rejects a wrong password', () => {
    assert.equal(tbank.verifyNotification(signedNotification(), 'wrong-password'), false);
  });

  test('rejects a missing/empty Token', () => {
    const n = signedNotification();
    delete n.Token;
    assert.equal(tbank.verifyNotification(n, DEMO_PASS), false);
    assert.equal(tbank.verifyNotification({}, DEMO_PASS), false);
  });
});

describe('tbank.isTestMode (safety gate)', () => {
  test('detects a DEMO terminal key (case-insensitive)', () => {
    const prev = process.env.TBANK_TERMINAL_KEY;
    process.env.TBANK_TERMINAL_KEY = '1783700349076DEMO';
    assert.equal(tbank.isTestMode(), true);
    process.env.TBANK_TERMINAL_KEY = 'demo123';
    assert.equal(tbank.isTestMode(), true);
    if (prev === undefined) delete process.env.TBANK_TERMINAL_KEY; else process.env.TBANK_TERMINAL_KEY = prev;
  });

  test('a real (non-DEMO) key is NOT test mode', () => {
    const prevK = process.env.TBANK_TERMINAL_KEY, prevF = process.env.TBANK_TEST_MODE;
    process.env.TBANK_TERMINAL_KEY = '1783700349076';
    delete process.env.TBANK_TEST_MODE;
    assert.equal(tbank.isTestMode(), false);
    if (prevK === undefined) delete process.env.TBANK_TERMINAL_KEY; else process.env.TBANK_TERMINAL_KEY = prevK;
    if (prevF !== undefined) process.env.TBANK_TEST_MODE = prevF;
  });

  test('explicit TBANK_TEST_MODE=true forces test mode even on a real key', () => {
    const prevK = process.env.TBANK_TERMINAL_KEY, prevF = process.env.TBANK_TEST_MODE;
    process.env.TBANK_TERMINAL_KEY = '1783700349076';
    process.env.TBANK_TEST_MODE = 'true';
    assert.equal(tbank.isTestMode(), true);
    if (prevK === undefined) delete process.env.TBANK_TERMINAL_KEY; else process.env.TBANK_TERMINAL_KEY = prevK;
    if (prevF === undefined) delete process.env.TBANK_TEST_MODE; else process.env.TBANK_TEST_MODE = prevF;
  });
});

describe('tbank OrderId encode/decode (subscriptions)', () => {
  test('roundtrips and stays within the 50-char terminal limit', () => {
    for (const [slug, months] of [['tgletbot', 1], ['tgpremium', 12], ['tgletbot', 6]]) {
      const oid = tbank.encodeSubOrderId('6512a1b2c3d4e5f60718293a', slug, months);
      assert.ok(oid.length <= 50, `OrderId too long: ${oid.length}`);
      assert.deepEqual(tbank.decodeSubOrderId(oid), { userId: '6512a1b2c3d4e5f60718293a', slug, months });
    }
  });

  test('decode rejects garbage and non-ObjectId userIds', () => {
    assert.equal(tbank.decodeSubOrderId('garbage'), null);
    assert.equal(tbank.decodeSubOrderId(''), null);
    assert.equal(tbank.decodeSubOrderId('notanid_p12_abc'), null);
    assert.equal(tbank.decodeSubOrderId('6512a1b2c3d4e5f60718293a_x1_abc'), null); // unknown plan char
  });

  test('unknown slug falls back to standard char but still decodes to a real plan', () => {
    const oid = tbank.encodeSubOrderId('6512a1b2c3d4e5f60718293a', 'weird', 3);
    assert.equal(tbank.decodeSubOrderId(oid).slug, 'tgletbot'); // 's' default
  });
});
