'use strict';

// Telegram retries a webhook delivery if it doesn't get a timely 200 OK (e.g. our
// server was mid-restart) — without this, the retried update gets processed a
// second time, which shows up to users as "everything got sent twice". Our
// webhook handlers already ACK instantly before doing any work, so this isn't
// about slow responses — it's about the FIRST attempt failing at the network
// level and Telegram redelivering the exact same update_id later.
//
// Dedup by (scope, update_id) for a short window. `scope` keeps independent
// bots' own update_id sequences (Telegram numbers them per-bot) from colliding
// with each other when multiple bots share one router (webhooks.js).
const seen = new Map(); // `${scope}:${updateId}` -> insertedAt ms
const TTL_MS = 10 * 60 * 1000;
const MAX_SIZE_BEFORE_SWEEP = 2000;

function isDuplicateUpdate(scope, updateId) {
  if (updateId == null) return false;
  const key = `${scope}:${updateId}`;
  const now = Date.now();
  if (seen.has(key)) return true;
  seen.set(key, now);
  if (seen.size > MAX_SIZE_BEFORE_SWEEP) {
    for (const [k, t] of seen) {
      if (now - t > TTL_MS) seen.delete(k);
    }
  }
  return false;
}

module.exports = { isDuplicateUpdate };
