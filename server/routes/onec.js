'use strict';
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

const checkAccess       = require('../middleware/checkAccess');
const UserIntegrations  = require('../models/UserIntegrations');
const UserSchema        = require('../models/UserSchema');
const UserRecord        = require('../models/UserRecord');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Parse whatever 1C sends into a flat array of plain objects
function parseOneCPayload(body) {
  // OData standard: { value: [...] }
  if (body && Array.isArray(body.value))  return body.value;
  // Common 1C patterns
  if (body && Array.isArray(body.Данные)) return body.Данные;
  if (body && Array.isArray(body.Data))   return body.Data;
  if (body && Array.isArray(body.Items))  return body.Items;
  if (body && Array.isArray(body.Rows))   return body.Rows;
  // Single object → wrap
  if (body && typeof body === 'object' && !Array.isArray(body)) return [body];
  // Direct array
  if (Array.isArray(body)) return body;
  return [];
}

// Build a Siberi schema from the keys of the first record
function inferSchema(records) {
  if (!records.length) return [];
  const sample = records[0];
  return Object.keys(sample).map(key => {
    const val = sample[key];
    let type = 'text';
    if (typeof val === 'number')  type = 'number';
    if (typeof val === 'boolean') type = 'boolean';
    if (val instanceof Date || (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val))) type = 'date';
    return { name: key, label: key, type, required: false };
  });
}

// Upsert records into a schema (create schema if missing)
async function upsertRecords(userId, schemaName, records) {
  if (!records.length) return 0;

  let schema = await UserSchema.findOne({ userId, name: schemaName });
  if (!schema) {
    schema = await UserSchema.create({
      userId,
      name:   schemaName,
      label:  schemaName,
      fields: inferSchema(records),
    });
  }

  let count = 0;
  for (const rec of records) {
    // Use first string field that looks like an ID/name as upsert key, or _id / Ref_Key
    const keyField =
      rec['_id']     ? '_id'     :
      rec['Ref_Key'] ? 'Ref_Key' :
      rec['Code']    ? 'Code'    :
      rec['Код']     ? 'Код'     : null;

    if (keyField && rec[keyField]) {
      await UserRecord.findOneAndUpdate(
        { userId, schemaName, [`data.${keyField}`]: String(rec[keyField]) },
        { $set: { userId, schemaName, data: rec, 'metadata.updatedBy': '1c', 'metadata.source': '1c' } },
        { upsert: true, returnDocument: 'after' }
      );
    } else {
      await UserRecord.create({
        userId, schemaName, data: rec,
        metadata: { createdBy: '1c', source: '1c' },
      });
    }
    count++;
  }
  return count;
}

// ── PUBLIC: receive push from 1C ─────────────────────────────────────────────
// POST /api/v1/1c/push/:token
router.post('/push/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const integDoc = await UserIntegrations.findOne({ 'onec.webhookToken': token });
    if (!integDoc || !integDoc.onec?.enabled) {
      return res.status(401).json({ error: 'Invalid token or integration disabled' });
    }

    const records = parseOneCPayload(req.body);
    if (!records.length) return res.status(200).json({ success: true, imported: 0 });

    const schemaName = integDoc.onec.schemaName || '1c_data';
    const count = await upsertRecords(integDoc.userId, schemaName, records);

    await UserIntegrations.updateOne(
      { _id: integDoc._id },
      { $set: { 'onec.lastSync': new Date(), 'onec.lastSyncCount': count } }
    );

    console.log(`✅ 1C webhook: ${count} записей → ${schemaName} (user ${integDoc.userId})`);
    res.status(200).json({ success: true, imported: count });
  } catch (err) {
    console.error('1C webhook error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── AUTHENTICATED: get / save config ─────────────────────────────────────────
router.get('/config', checkAccess, async (req, res) => {
  try {
    let doc = await UserIntegrations.findOne({ userId: req.user._id });
    if (!doc) {
      doc = await UserIntegrations.create({ userId: req.user._id });
    }
    // Auto-generate token on first access
    if (!doc.onec?.webhookToken) {
      await UserIntegrations.updateOne(
        { userId: req.user._id },
        { $set: { 'onec.webhookToken': uuidv4(), 'onec.enabled': true } }
      );
      doc = await UserIntegrations.findOne({ userId: req.user._id });
    }
    res.json({ success: true, onec: doc.onec || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/config', checkAccess, async (req, res) => {
  try {
    const { schemaName, mode, odataUrl, odataLogin, odataPassword, odataEntity } = req.body;
    const update = { 'onec.enabled': true };
    if (schemaName)    update['onec.schemaName']    = schemaName.trim();
    if (mode)          update['onec.mode']          = mode;
    if (odataUrl)      update['onec.odataUrl']      = odataUrl.trim();
    if (odataLogin !== undefined) update['onec.odataLogin']    = odataLogin;
    if (odataPassword !== undefined) update['onec.odataPassword'] = odataPassword;
    if (odataEntity)   update['onec.odataEntity']   = odataEntity.trim();

    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $set: update },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Regenerate webhook token
router.post('/regen-token', checkAccess, async (req, res) => {
  try {
    const newToken = uuidv4();
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { 'onec.webhookToken': newToken } },
      { upsert: true }
    );
    res.json({ success: true, webhookToken: newToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Test OData connection ─────────────────────────────────────────────────────
router.post('/test-odata', checkAccess, async (req, res) => {
  try {
    const { odataUrl, odataLogin, odataPassword } = req.body;
    if (!odataUrl) return res.status(400).json({ error: 'URL обязателен' });

    // Block local IPs
    const url = new URL(odataUrl);
    const host = url.hostname.toLowerCase();
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
      return res.status(400).json({ error: 'Локальные адреса недоступны с нашего сервера. Используйте Webhook-режим.' });
    }

    // Fetch the OData service document to list available entities
    const baseUrl = odataUrl.replace(/\/$/, '');
    const headers = { Accept: 'application/json' };
    if (odataLogin) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${odataLogin}:${odataPassword || ''}`).toString('base64');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const fetchRes = await fetch(`${baseUrl}/?$format=json`, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!fetchRes.ok) {
      return res.status(400).json({ error: `1С вернула ${fetchRes.status}: ${fetchRes.statusText}` });
    }

    const data = await fetchRes.json();
    // OData service document has "value" array with entity names
    const entities = (data.value || []).map(e => e.name || e.url).filter(Boolean);
    res.json({ success: true, entities });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Таймаут подключения (10с)' : err.message;
    res.status(400).json({ error: msg });
  }
});

// ── Manual OData sync ─────────────────────────────────────────────────────────
router.post('/sync-odata', checkAccess, async (req, res) => {
  try {
    const doc = await UserIntegrations.findOne({ userId: req.user._id });
    const cfg = doc?.onec;
    if (!cfg?.odataUrl || !cfg?.odataEntity) {
      return res.status(400).json({ error: 'Укажите URL и сущность в настройках OData' });
    }

    const baseUrl = cfg.odataUrl.replace(/\/$/, '');
    const entity  = cfg.odataEntity;
    const headers = { Accept: 'application/json' };
    if (cfg.odataLogin) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${cfg.odataLogin}:${cfg.odataPassword || ''}`).toString('base64');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const fetchRes = await fetch(`${baseUrl}/${entity}?$format=json&$top=1000`, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!fetchRes.ok) {
      return res.status(400).json({ error: `1С вернула ${fetchRes.status}` });
    }

    const data = await fetchRes.json();
    const records = parseOneCPayload(data);
    if (!records.length) return res.json({ success: true, imported: 0 });

    const schemaName = cfg.schemaName || '1c_data';
    const count = await upsertRecords(req.user._id, schemaName, records);

    await UserIntegrations.updateOne(
      { userId: req.user._id },
      { $set: { 'onec.lastSync': new Date(), 'onec.lastSyncCount': count } }
    );

    console.log(`✅ 1C OData sync: ${count} записей → ${schemaName}`);
    res.json({ success: true, imported: count, schemaName });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Таймаут (30с). Проверьте URL.' : err.message;
    res.status(400).json({ error: msg });
  }
});

module.exports = router;
