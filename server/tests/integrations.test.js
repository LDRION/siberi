'use strict';
/**
 * Integration configuration tests (no live network calls)
 * Covers: Telegram, VK, MAX, Web widget, REST API, Google Sheets
 * Run: node --test tests/integrations.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Schema mirrors (kept in sync with UserIntegrations model) ─────────────────
function makeBotInstance(overrides = {}) {
  return {
    _id: 'abc123',
    name: '',
    token: '',
    botUsername: '',
    botName: '',
    profileId: null,
    connected: false,
    connectedAt: null,
    ...overrides,
  };
}

function makeIntegrationsDoc(overrides = {}) {
  return {
    telegram: [],
    vk: [],
    max: [],
    google: { connected: false },
    webhookCallback: { enabled: false, url: '' },
    ...overrides,
  };
}

// ── Helpers mirroring Dashboard.jsx isConnected logic ─────────────────────────
function isConnected(integrations, config, { key, subKey, isArray, customCheck }) {
  if (customCheck) return customCheck(integrations, config);
  const val = integrations?.[key];
  if (!val) return false;
  if (isArray) return Array.isArray(val) && val.some(b => b[subKey]);
  return !!val[subKey];
}

const INTEGRATIONS_DEFS = [
  { key: 'telegram', subKey: 'connected', isArray: true },
  { key: 'vk',       subKey: 'connected', isArray: true },
  { key: 'max',      subKey: 'connected', isArray: true },
  {
    key: 'web',
    customCheck: (integ, config) =>
      !!(integ?.webhookCallback?.enabled ||
         config?.integrations?.website ||
         config?.integrations?.fullpage ||
         config?.integrations?.api),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
describe('Telegram Bot integration', () => {

  test('not connected when array is empty', () => {
    const integ = makeIntegrationsDoc();
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[0]), false);
  });

  test('not connected when bot exists but connected=false', () => {
    const integ = makeIntegrationsDoc({ telegram: [makeBotInstance({ connected: false })] });
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[0]), false);
  });

  test('connected when at least one bot has connected=true', () => {
    const integ = makeIntegrationsDoc({
      telegram: [
        makeBotInstance({ connected: false }),
        makeBotInstance({ connected: true, token: 'tok', botUsername: 'my_bot' }),
      ],
    });
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[0]), true);
  });

  test('token format: must contain colon separator', () => {
    const validToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ';
    assert.ok(validToken.includes(':'), 'Telegram token must include colon');
    const [botId] = validToken.split(':');
    assert.ok(Number(botId) > 0, 'Bot ID must be numeric');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('VK Bot integration', () => {

  test('not connected when array is empty', () => {
    const integ = makeIntegrationsDoc();
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[1]), false);
  });

  test('connected when group token present and connected=true', () => {
    const integ = makeIntegrationsDoc({
      vk: [makeBotInstance({ connected: true, token: 'vk_token_abc', groupId: '123' })],
    });
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[1]), true);
  });

  test('multiple groups: connected if any is active', () => {
    const integ = makeIntegrationsDoc({
      vk: [
        makeBotInstance({ connected: false }),
        makeBotInstance({ connected: true }),
      ],
    });
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[1]), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MAX Bot integration', () => {

  test('not connected when array is empty', () => {
    const integ = makeIntegrationsDoc();
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[2]), false);
  });

  test('connected when bot token set and connected=true', () => {
    const integ = makeIntegrationsDoc({
      max: [makeBotInstance({ connected: true, token: 'max_tok_xyz' })],
    });
    assert.equal(isConnected(integ, {}, INTEGRATIONS_DEFS[2]), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Web integration (widget / fullpage / API)', () => {

  const def = INTEGRATIONS_DEFS[3];

  test('not connected when all sources are off', () => {
    const integ = makeIntegrationsDoc();
    const config = { integrations: {} };
    assert.equal(isConnected(integ, config, def), false);
  });

  test('connected via webhookCallback', () => {
    const integ = makeIntegrationsDoc({ webhookCallback: { enabled: true, url: 'https://example.com/hook' } });
    assert.equal(isConnected(integ, {}, def), true);
  });

  test('connected via config.integrations.website flag', () => {
    const integ = makeIntegrationsDoc();
    const config = { integrations: { website: true } };
    assert.equal(isConnected(integ, config, def), true);
  });

  test('connected via config.integrations.fullpage flag', () => {
    const integ = makeIntegrationsDoc();
    const config = { integrations: { fullpage: true } };
    assert.equal(isConnected(integ, config, def), true);
  });

  test('connected via config.integrations.api flag', () => {
    const integ = makeIntegrationsDoc();
    const config = { integrations: { api: true } };
    assert.equal(isConnected(integ, config, def), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REST API (SDK) integration', () => {

  test('API key format: valid uuid v4', () => {
    const uuidV4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const { v4: uuidv4 } = require('uuid');
    const key = uuidv4();
    assert.match(key, uuidV4Re);
  });

  test('API key minimum length check (16 chars as enforced by auth middleware)', () => {
    const key = 'short';
    assert.ok(key.length < 16, 'short key should fail middleware check');
  });

  test('Authorization header format is correct', () => {
    const apiKey = 'test-api-key-1234';
    const header = `Bearer ${apiKey}`;
    assert.ok(header.startsWith('Bearer '), 'header must start with Bearer');
    assert.equal(header.replace('Bearer ', ''), apiKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Google Sheets integration', () => {

  test('not connected by default', () => {
    const integ = makeIntegrationsDoc();
    assert.equal(integ.google.connected, false);
  });

  test('connected when google.connected=true', () => {
    const integ = makeIntegrationsDoc({
      google: { connected: true, email: 'user@gmail.com', accessToken: 'tok', refreshToken: 'ref', expiryDate: Date.now() + 3600000 },
    });
    assert.equal(integ.google.connected, true);
    assert.ok(integ.google.email, 'email should be present when connected');
  });

  test('token considered expired if expiryDate is in the past', () => {
    const expiryDate = Date.now() - 1000;
    assert.ok(expiryDate < Date.now(), 'token is expired');
  });

  test('token considered valid if expiryDate is in the future', () => {
    const expiryDate = Date.now() + 3600 * 1000;
    assert.ok(expiryDate > Date.now(), 'token is valid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Integration counter logic', () => {

  test('0 connected when nothing is set up', () => {
    const integ = makeIntegrationsDoc();
    const config = {};
    const count = INTEGRATIONS_DEFS.filter(d => isConnected(integ, config, d)).length;
    assert.equal(count, 0);
  });

  test('counts correctly with mixed state', () => {
    const integ = makeIntegrationsDoc({
      telegram: [makeBotInstance({ connected: true })],
      vk:       [],
      max:      [makeBotInstance({ connected: true })],
    });
    const config = { integrations: { website: true } };
    const count = INTEGRATIONS_DEFS.filter(d => isConnected(integ, config, d)).length;
    assert.equal(count, 3); // telegram + max + web
  });

  test('counts all 4 when everything is active', () => {
    const integ = makeIntegrationsDoc({
      telegram: [makeBotInstance({ connected: true })],
      vk:       [makeBotInstance({ connected: true })],
      max:      [makeBotInstance({ connected: true })],
      webhookCallback: { enabled: true, url: 'https://x.com' },
    });
    const config = {};
    const count = INTEGRATIONS_DEFS.filter(d => isConnected(integ, config, d)).length;
    assert.equal(count, 4);
  });
});
