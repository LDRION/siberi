'use strict';
/**
 * Bot-analyzer access control (botSettings.aiAccessRole)
 * Covers:
 *   1) The webhook gate truth-table: who may talk to the AI by free text
 *      when a bot restricts the AI chat to admins/creators.
 *   2) BOT_SETTINGS extraction of aiAccessRole (valid JSON + regex fallback),
 *      mirroring AiService._applyStudioChanges field-copy.
 * These are faithful logic mirrors of routes/webhooks.js and AiService.js —
 * kept in the same self-contained style as the other tests (no live DB/worker).
 * Run: node --test tests/aiAccessRole.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Mirror of routes/webhooks.js role ranking (lines ~450-467) ────────────────
const ROLE_RANK = { user: 1, admin: 2, creator: 3 };
function roleSatisfies(callerRole, minRole) {
  if (!minRole) return true;
  return (ROLE_RANK[callerRole] || 1) >= (ROLE_RANK[minRole] || 1);
}

// Mirror of the gate placed right before free-text→AI dispatch. Returns true
// when the message reaches the AI, false when it is silently ignored.
function aiReaches({ aiAccessRole, callerRole, hasText = true, hasVoice = false }) {
  const role = aiAccessRole || 'all';
  const hasInput = hasText || hasVoice;
  if (role !== 'all' && hasInput) {
    if (!roleSatisfies(callerRole, role)) return false; // тихо игнорируем
  }
  return true;
}

describe('aiAccessRole — webhook gate truth-table', () => {
  test("default 'all' — everyone reaches the AI (client bots unchanged)", () => {
    for (const callerRole of ['user', 'admin', 'creator']) {
      assert.equal(aiReaches({ aiAccessRole: 'all', callerRole }), true);
      // Missing field behaves exactly like 'all'.
      assert.equal(aiReaches({ aiAccessRole: undefined, callerRole }), true);
    }
  });

  test("'admin' — clients blocked, admins & creator (owner) pass", () => {
    assert.equal(aiReaches({ aiAccessRole: 'admin', callerRole: 'user' }), false);
    assert.equal(aiReaches({ aiAccessRole: 'admin', callerRole: 'admin' }), true);
    assert.equal(aiReaches({ aiAccessRole: 'admin', callerRole: 'creator' }), true);
  });

  test("'creator' — only the owner passes", () => {
    assert.equal(aiReaches({ aiAccessRole: 'creator', callerRole: 'user' }), false);
    assert.equal(aiReaches({ aiAccessRole: 'creator', callerRole: 'admin' }), false);
    assert.equal(aiReaches({ aiAccessRole: 'creator', callerRole: 'creator' }), true);
  });

  test('gate applies to voice-only messages too', () => {
    assert.equal(aiReaches({ aiAccessRole: 'admin', callerRole: 'user', hasText: false, hasVoice: true }), false);
    assert.equal(aiReaches({ aiAccessRole: 'admin', callerRole: 'creator', hasText: false, hasVoice: true }), true);
  });

  test('empty input (no text, no voice) is never gated', () => {
    // e.g. a photo with no caption — the gate condition requires text||voice.
    assert.equal(aiReaches({ aiAccessRole: 'admin', callerRole: 'user', hasText: false, hasVoice: false }), true);
  });
});

// ── Mirror of AiService._applyStudioChanges BOT_SETTINGS extraction ───────────
// Valid-JSON path: copy known fields. Regex fallback path: the exact strVal
// regex used when JSON.parse fails on unescaped quotes.
function extractSettings(settingsRaw) {
  const changes = {};
  let s = null;
  try { s = JSON.parse(settingsRaw); } catch { s = null; }
  if (!s) {
    const strVal = (key) => {
      const m = settingsRaw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*?)"`));
      return m ? m[1] : null;
    };
    const tm = strVal('triggerMode');
    const hm = strVal('historyMode');
    const ar = strVal('aiAccessRole');
    s = {};
    if (tm) s.triggerMode = tm;
    if (hm) s.historyMode = hm;
    if (ar) s.aiAccessRole = ar;
    if (Object.keys(s).length === 0) s = null;
  }
  if (s) {
    if (s.triggerMode  != null) changes.triggerMode  = s.triggerMode;
    if (s.historyMode  != null) changes.historyMode  = s.historyMode;
    if (s.aiAccessRole != null) changes.aiAccessRole = s.aiAccessRole;
  }
  return changes;
}

describe('aiAccessRole — BOT_SETTINGS extraction', () => {
  test('valid JSON with aiAccessRole is picked up', () => {
    const raw = '{"triggerMode":"respond_all","aiAccessRole":"admin"}';
    assert.equal(extractSettings(raw).aiAccessRole, 'admin');
  });

  test('absent aiAccessRole leaves the field untouched (no accidental reset)', () => {
    const raw = '{"triggerMode":"respond_all","historyMode":"personal"}';
    assert.equal('aiAccessRole' in extractSettings(raw), false);
  });

  test('regex fallback recovers aiAccessRole from invalid JSON (unescaped quote)', () => {
    // A stray double-quote in systemPrompt breaks JSON.parse — aiAccessRole must
    // still survive via the regex path (it did NOT before this fix).
    const raw = '{"aiAccessRole":"admin","systemPrompt":"Ты аналитик "данных" компании"}';
    assert.throws(() => JSON.parse(raw)); // sanity: this really is invalid JSON
    assert.equal(extractSettings(raw).aiAccessRole, 'admin');
  });

  test("'creator' value flows through as-is", () => {
    assert.equal(extractSettings('{"aiAccessRole":"creator"}').aiAccessRole, 'creator');
  });
});
