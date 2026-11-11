'use strict';
const express = require('express');
const multer = require('multer');
const router = express.Router();

const checkAccess = require('../middleware/checkAccess');
const { getAuthUrl, verifyState, exchangeCode, buildClient, getGoogleEmail } = require('../integrations/googleOAuth');
const { extractSheetId, fetchPublicSheet, fetchPrivateSheet, listSheetTabs, listUserSheets, updateSheetRow, appendSheetRow, deleteSheetRow } = require('../integrations/googleSheets');
const { parseExcelBuffer } = require('../integrations/excelParser');
const UserIntegrations = require('../models/UserIntegrations');
const UserSyncConfig = require('../models/UserSyncConfig');
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');
const User = require('../models/User');
const UserAiConfig = require('../models/UserAiConfig');
const { connectTelegramBot } = require('../helpers/telegramConnect');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Multer for Excel uploads (memory, 20MB)
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) cb(null, true);
    else cb(new Error('Разрешены только .xlsx, .xls и .csv файлы'));
  },
});

// ── Helper: get or create UserIntegrations record ────────────────────────────
async function getIntegrations(userId) {
  let doc = await UserIntegrations.findOne({ userId });
  if (!doc) {
    doc = new UserIntegrations({ userId });
    await doc.save();
  }
  return doc;
}

// ── Helper: total active integration slots across all channels ────────────────
// Counts: bot instances (TG/VK/MAX) + widget deploy flag + external API usage flag
async function countUserIntegrations(userId) {
  const [doc, user] = await Promise.all([
    getIntegrations(userId),
    User.findById(userId).select('apiIntegrationActive widgetIntegrationActive').lean(),
  ]);
  const bots = (doc.telegram?.length || 0) + (doc.vk?.length || 0) + (doc.max?.length || 0);
  const widgetSlot = user?.widgetIntegrationActive ? 1 : 0;
  const apiSlot    = user?.apiIntegrationActive    ? 1 : 0;
  return bots + widgetSlot + apiSlot;
}

// ── Helper: build Google auth client from stored tokens ───────────────────────
async function getGoogleClient(userId) {
  const doc = await UserIntegrations.findOne({ userId });
  if (!doc?.google?.connected || !doc.google.refreshToken) return null;
  return buildClient({
    access_token: doc.google.accessToken,
    refresh_token: doc.google.refreshToken,
    expiry_date: doc.google.expiryDate,
  });
}

// ── Transliterate Cyrillic header → valid field name ─────────────────────────
const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
  'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
  'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
  'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};

function toFieldName(header, idx) {
  const result = String(header).toLowerCase()
    .split('').map((c) => TRANSLIT[c] ?? (c.match(/[a-z0-9]/) ? c : '_'))
    .join('').replace(/_+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50);
  return result || `field_${idx}`;
}

// Remap row object keys from original headers → transliterated field names
function remapRow(headers, row) {
  const out = {};
  headers.forEach((h, i) => { out[toFieldName(h, i)] = row[h] ?? ''; });
  return out;
}

// ── Trim data to AI-friendly size ─────────────────────────────────────────────
function trimForAI(rows, maxRows = 200) {
  const trimmed = rows.slice(0, maxRows);
  return { rows: trimmed, total: rows.length, truncated: rows.length > maxRows };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/integrations/status  — what is connected for this user
// ────────────────────────────────────────────────────────────────────────────
router.get('/status', checkAccess, async (req, res) => {
  try {
    const doc = await getIntegrations(req.user._id);
    res.json({
      success: true,
      google: {
        connected: doc.google?.connected || false,
        email: doc.google?.email || null,
        connectedAt: doc.google?.connectedAt || null,
      },
      telegram: (doc.telegram || []).map(b => ({
        id: b._id, name: b.name, botUsername: b.botUsername,
        profileId: b.profileId, connected: b.connected, connectedAt: b.connectedAt,
      })),
      vk: (doc.vk || []).map(g => ({
        id: g._id, name: g.name, groupId: g.groupId,
        profileId: g.profileId, connected: g.connected, connectedAt: g.connectedAt,
      })),
      max: (doc.max || []).map(b => ({
        id: b._id, name: b.name, botName: b.botName, botUsername: b.botUsername,
        profileId: b.profileId, connected: b.connected, connectedAt: b.connectedAt,
      })),
      webhookCallback: {
        enabled: doc.webhookCallback?.enabled || false,
        url: doc.webhookCallback?.url || '',
      },
      api:    { active: req.user.apiIntegrationActive    || false },
      widget: { active: req.user.widgetIntegrationActive || false },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/integrations/google/auth  — start OAuth flow
// ────────────────────────────────────────────────────────────────────────────
router.get('/google/auth', checkAccess, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google OAuth не настроен (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET в .env)' });
  }
  const authUrl = getAuthUrl(req.user._id.toString());
  res.json({ success: true, authUrl });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/integrations/google/callback  — OAuth callback from Google
// ────────────────────────────────────────────────────────────────────────────
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Google OAuth error:', error);
    return res.redirect(`${FRONTEND_URL}/integrations?google=error&reason=${encodeURIComponent(error)}`);
  }

  const userId = verifyState(state || '');
  if (!userId) {
    console.error('Google OAuth: invalid or missing state parameter');
    return res.redirect(`${FRONTEND_URL}/integrations?google=error&reason=invalid_state`);
  }

  try {
    const tokens = await exchangeCode(code);
    const authClient = buildClient(tokens);
    const email = await getGoogleEmail(authClient);

    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    await UserIntegrations.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          'google.connected': true,
          'google.email': email,
          'google.accessToken': tokens.access_token,
          'google.refreshToken': tokens.refresh_token,
          'google.expiryDate': tokens.expiry_date,
          'google.connectedAt': new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    console.log(`✅ Google подключён для ${user.email}: ${email}`);
    res.redirect(`${FRONTEND_URL}/integrations?google=connected&gEmail=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    res.redirect(`${FRONTEND_URL}/integrations?google=error&reason=auth_failed`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/integrations/google/disconnect
// ────────────────────────────────────────────────────────────────────────────
router.delete('/google/disconnect', checkAccess, async (req, res) => {
  try {
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { google: { connected: false } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/sheets/fetch
// Body: { url: string, sheetName?: string }
// Fetches sheet data (auto-detects public vs private)
// ────────────────────────────────────────────────────────────────────────────
router.post('/sheets/fetch', checkAccess, async (req, res) => {
  try {
    const { url, sheetName } = req.body;
    if (!url) return res.status(400).json({ error: 'url обязателен' });

    const sheetId = extractSheetId(url);
    if (!sheetId) return res.status(400).json({ error: 'Не удалось извлечь ID таблицы из URL' });

    const authClient = await getGoogleClient(req.user._id);

    // Fetch tabs first (best effort) so they're always returned
    let tabs = [];
    try { tabs = await listSheetTabs(sheetId, authClient); } catch {}

    let data;
    if (authClient) {
      data = await fetchPrivateSheet(sheetId, authClient, sheetName || null);
    } else {
      data = await fetchPublicSheet(sheetId, sheetName || null);
    }

    const { rows, total, truncated } = trimForAI(data.rows);

    res.json({
      success: true,
      sheetId,
      headers: data.headers,
      rows,
      total,
      truncated,
      tabs,
      empty: data.rows.length === 0,
    });
  } catch (err) {
    console.error('Sheets fetch error:', err.message);
    const isAuth = err.message?.includes('403') || err.message?.includes('401') || err.message?.includes('PERMISSION');
    res.status(isAuth ? 403 : 500).json({
      error: isAuth
        ? 'Нет доступа. Убедитесь что таблица открыта "для всех по ссылке" или подключите Google аккаунт.'
        : err.message,
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/sync/save-all
// Body: { sourceUrl, sheets: [{ sheetName, schemaName, schemaLabel }] }
// Saves + syncs all sheets as separate schemas in one call
// ────────────────────────────────────────────────────────────────────────────
router.post('/sync/save-all', checkAccess, async (req, res) => {
  try {
    const { sourceUrl, sheets } = req.body;
    if (!sourceUrl || !Array.isArray(sheets) || sheets.length === 0)
      return res.status(400).json({ error: 'sourceUrl и sheets[] обязательны' });

    const sheetId = extractSheetId(sourceUrl);
    if (!sheetId) return res.status(400).json({ error: 'Не удалось определить ID таблицы' });

    const results = [];
    for (const { sheetName, schemaName, schemaLabel } of sheets) {
      if (!schemaName) continue;
      const config = await UserSyncConfig.findOneAndUpdate(
        { userId: req.user._id, schemaName },
        { $set: { sourceType: 'google_sheets', sourceUrl, sheetId, sheetName: sheetName || null, enabled: true } },
        { upsert: true, returnDocument: 'after' }
      );
      let syncedCount = 0;
      try { syncedCount = await runSync(config); } catch (e) { console.error('sync error', sheetName, e.message); }
      results.push({ schemaName, sheetName, syncedCount });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('save-all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/integrations/sheets/my-files
// List Google Sheets files from connected Drive account
// ────────────────────────────────────────────────────────────────────────────
router.get('/sheets/my-files', checkAccess, async (req, res) => {
  try {
    const authClient = await getGoogleClient(req.user._id);
    if (!authClient) return res.status(400).json({ error: 'Google аккаунт не подключён' });

    const files = await listUserSheets(authClient);
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/excel/parse
// Upload Excel file, get preview (headers + first rows)
// ────────────────────────────────────────────────────────────────────────────
router.post('/excel/parse', checkAccess, xlsxUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    const sheets = parseExcelBuffer(req.file.buffer, { ext });
    if (!sheets.length) return res.status(400).json({ error: 'Файл не содержит данных' });

    const result = sheets.map(({ name, headers, rows }) => {
      const { rows: trimmed, total, truncated } = trimForAI(rows);
      return { name, headers, rows: trimmed, total, truncated };
    });

    res.json({ success: true, sheets: result, filename: req.file.originalname });
  } catch (err) {
    console.error('Excel parse error:', err.message);
    res.status(500).json({ error: 'Ошибка парсинга файла: ' + err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SYNC ENGINE — replaces google-synced records for a given schema
// ────────────────────────────────────────────────────────────────────────────
async function runSync(syncConfig) {
  const authClient = await (async () => {
    const doc = await UserIntegrations.findOne({ userId: syncConfig.userId });
    if (!doc?.google?.connected || !doc.google.refreshToken) return null;
    return buildClient({
      access_token: doc.google.accessToken,
      refresh_token: doc.google.refreshToken,
      expiry_date: doc.google.expiryDate,
    });
  })();

  let data;
  if (authClient) {
    data = await fetchPrivateSheet(syncConfig.sheetId, authClient, syncConfig.sheetName || null);
  } else {
    data = await fetchPublicSheet(syncConfig.sheetId, syncConfig.sheetName || null);
  }

  if (!data.headers.length) throw new Error('Таблица пустая');

  // Ensure schema exists (create if needed)
  let schema = await UserSchema.findOne({ userId: syncConfig.userId, name: syncConfig.schemaName });
  if (!schema) {
    schema = await UserSchema.create({
      userId: syncConfig.userId,
      name: syncConfig.schemaName,
      label: syncConfig.schemaName,
      description: `Синхронизация из Google Sheets`,
      fields: data.headers.map((h, i) => ({ name: toFieldName(h, i), label: h, type: 'text', required: false, options: [] })),
      icon: '📊',
      color: '#34a853',
    });
  }

  // Replace synced records (keep manually added ones)
  await UserRecord.deleteMany({
    userId: syncConfig.userId,
    schemaName: schema.name,
    'metadata.source': 'google_sync',
    'metadata.sourceUrl': syncConfig.sourceUrl,
  });

  if (data.rows.length > 0) {
    const docs = data.rows.slice(0, 5000).map((row) => {
      const { _sheetRow, ...rowData } = row;
      return {
        userId: syncConfig.userId,
        schemaName: schema.name,
        data: remapRow(data.headers, rowData),
        // Храним номер строки и заголовки для write-back
        metadata: {
          source: 'google_sync',
          sourceUrl: syncConfig.sourceUrl,
          syncedAt: new Date(),
          sheetRow: _sheetRow,
          sheetHeaders: data.headers,
        },
      };
    });
    await UserRecord.insertMany(docs, { ordered: false });
  }

  await UserSyncConfig.findByIdAndUpdate(syncConfig._id, {
    lastSyncAt: new Date(),
    lastSyncCount: data.rows.length,
  });

  return data.rows.length;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/excel/import
// multipart/form-data: file, schemaName, schemaLabel?, sheetIndex? ('all' | number)
// Re-parses the full original file server-side → saves ALL rows (up to 10 000 per sheet)
// ────────────────────────────────────────────────────────────────────────────
router.post('/excel/import', checkAccess, xlsxUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const schemaName  = (req.body.schemaName  || '').trim();
    const schemaLabel = (req.body.schemaLabel || schemaName).trim();
    const sheetParam  = req.body.sheetIndex ?? '0';   // '0' | '1' | ... | 'all'
    const importAll   = sheetParam === 'all';

    if (!schemaName) return res.status(400).json({ error: 'schemaName обязателен' });

    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    const sheets = parseExcelBuffer(req.file.buffer, { ext });
    if (!sheets.length) return res.status(400).json({ error: 'Файл не содержит данных' });

    const userId = req.user._id;
    const results = [];

    const sheetsToImport = importAll
      ? sheets.map((s, i) => ({ sheet: s, idx: i }))
      : [{ sheet: sheets[parseInt(sheetParam, 10) || 0], idx: parseInt(sheetParam, 10) || 0 }];

    for (const { sheet, idx } of sheetsToImport) {
      if (!sheet || !sheet.rows.length) continue;

      const sName = importAll
        ? (schemaName + '_' + sheet.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')).substring(0, 50)
        : schemaName;
      const sLabel = importAll ? sheet.name : schemaLabel;

      let schema = await UserSchema.findOne({ userId, name: sName });
      if (!schema) {
        schema = await UserSchema.create({
          userId,
          name: sName,
          label: sLabel,
          description: 'Импортировано из файла',
          fields: sheet.headers.map((h, i) => ({
            name: toFieldName(h, i),
            label: h,
            type: 'text',
            required: false,
            options: [],
          })),
          icon: '📂',
          color: '#667eea',
        });
      }

      const docs = sheet.rows.slice(0, 10000).map((row) => ({
        userId,
        schemaName: schema.name,
        data: remapRow(sheet.headers, row),
        metadata: { source: 'file_import', importedAt: new Date() },
      }));
      const inserted = await UserRecord.insertMany(docs, { ordered: false });
      results.push({ schemaName: sName, importedCount: inserted.length, total: sheet.rows.length });
    }

    const first = results[0]?.schemaName || schemaName;
    res.json({ success: true, schemaName: first, results });
  } catch (err) {
    console.error('Excel import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── External DB sync ─────────────────────────────────────────────────────────
async function runExternalDbSync(syncConfig) {
  const { connectionString, dbType, collection } = syncConfig;
  if (!connectionString || !dbType || !collection) throw new Error('Неполная конфигурация синхронизации');

  let rows = [];
  if (dbType === 'mongodb') {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    try {
      const dbName = new URL(connectionString.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
      const db = client.db(dbName || undefined);
      // Включаем _id чтобы хранить для write-back
      rows = await db.collection(collection).find({}).limit(2000).toArray();
    } finally { await client.close(); }
  } else {
    const { Client } = require('pg');
    const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
      const result = await client.query(`SELECT * FROM "${collection}" LIMIT 2000`);
      rows = result.rows;
    } finally { await client.end(); }
  }

  if (!rows.length) return 0;

  // Ensure schema exists
  let schema = await UserSchema.findOne({ userId: syncConfig.userId, name: syncConfig.schemaName });
  if (!schema) {
    const sample = rows[0];
    schema = await UserSchema.create({
      userId:    syncConfig.userId,
      name:      syncConfig.schemaName,
      label:     collection,
      fields:    Object.keys(sample).map(k => {
        const v = sample[k];
        const type = typeof v === 'number' ? 'number' : v instanceof Date ? 'date' : typeof v === 'boolean' ? 'boolean' : 'text';
        return { name: k, label: k, type, required: false };
      }),
      isActive: true,
    });
  }

  // Replace previously synced records, keep manually added ones
  await UserRecord.deleteMany({
    userId: syncConfig.userId,
    schemaName: syncConfig.schemaName,
    'metadata.source': 'ext_db_sync',
  });

  const docs = rows.map(row => {
    // Извлекаем внешний ID для write-back
    const extId = row._id ? String(row._id) : null;
    const { _id, ...rowData } = row;
    return {
      userId:     syncConfig.userId,
      schemaName: syncConfig.schemaName,
      data:       rowData,
      metadata:   { source: 'ext_db_sync', syncedAt: new Date(), extId, extCollection: syncConfig.collection },
    };
  });
  await UserRecord.insertMany(docs, { ordered: false });

  await UserSyncConfig.findByIdAndUpdate(syncConfig._id, {
    lastSyncAt: new Date(), lastSyncCount: rows.length,
  });

  return rows.length;
}

// Export so server.js can call it for the nightly job
async function runAllSyncs() {
  const configs = await UserSyncConfig.find({ enabled: true });
  for (const cfg of configs) {
    try {
      const count = cfg.sourceType === 'external_db'
        ? await runExternalDbSync(cfg)
        : await runSync(cfg);
      console.log(`🔄 Sync [${cfg.sourceType}]: ${cfg.schemaName} → ${count} записей`);
    } catch (err) {
      console.warn(`⚠️ Sync failed for ${cfg.schemaName}:`, err.message);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// writeBackToSource — при изменении записи в Siberi → отправить обратно в источник
// Вызывается из AiService.executeDbCommand для схем с direction='bidirectional'
// ────────────────────────────────────────────────────────────────────────────
async function writeBackToSource(userId, schemaName, recordData, action, recordMeta) {
  try {
    const config = await UserSyncConfig.findOne({
      userId, schemaName, enabled: true, direction: 'bidirectional',
    });
    if (!config) return; // нет двусторонней синхронизации

    if (config.sourceType === 'google_sheets') {
      // Write-back в Google Sheets
      const intDoc = await UserIntegrations.findOne({ userId });
      if (!intDoc?.google?.connected || !intDoc.google.refreshToken) return;
      const authClient = buildClient({
        access_token: intDoc.google.accessToken,
        refresh_token: intDoc.google.refreshToken,
        expiry_date: intDoc.google.expiryDate,
      });
      const headers = recordMeta?.sheetHeaders;
      if (!headers) return;

      if (action === 'create') {
        const newRow = await appendSheetRow(config.sheetId, config.sheetName, headers, recordData, authClient);
        console.log(`↑ Write-back Google Sheets: append row ${newRow} → ${schemaName}`);
      } else if (action === 'update' && recordMeta?.sheetRow) {
        await updateSheetRow(config.sheetId, config.sheetName, recordMeta.sheetRow, headers, recordData, authClient);
        console.log(`↑ Write-back Google Sheets: update row ${recordMeta.sheetRow} → ${schemaName}`);
      } else if (action === 'delete' && recordMeta?.sheetRow) {
        await deleteSheetRow(config.sheetId, config.sheetName, recordMeta.sheetRow, authClient);
        console.log(`↑ Write-back Google Sheets: delete row ${recordMeta.sheetRow} → ${schemaName}`);
      }

    } else if (config.sourceType === 'external_db') {
      // Write-back в MongoDB или PostgreSQL
      const { connectionString, dbType, collection } = config;

      if (dbType === 'mongodb') {
        const { MongoClient, ObjectId } = require('mongodb');
        const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });
        await client.connect();
        try {
          const dbName = new URL(connectionString.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
          const db = client.db(dbName || undefined);
          const col = db.collection(collection);
          if (action === 'create') {
            const res = await col.insertOne(recordData);
            console.log(`↑ Write-back MongoDB: insert → ${collection}`);
          } else if (action === 'update' && recordMeta?.extId) {
            await col.updateOne({ _id: new ObjectId(recordMeta.extId) }, { $set: recordData });
            console.log(`↑ Write-back MongoDB: update ${recordMeta.extId} → ${collection}`);
          } else if (action === 'delete' && recordMeta?.extId) {
            await col.deleteOne({ _id: new ObjectId(recordMeta.extId) });
            console.log(`↑ Write-back MongoDB: delete ${recordMeta.extId} → ${collection}`);
          }
        } finally { await client.close(); }

      } else if (dbType === 'postgresql') {
        const { Client } = require('pg');
        const client = new Client({ connectionString, connectionTimeoutMillis: 8000 });
        await client.connect();
        try {
          if (action === 'create') {
            const keys = Object.keys(recordData);
            const vals = keys.map((_, i) => `$${i + 1}`);
            await client.query(
              `INSERT INTO "${collection}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${vals})`,
              keys.map(k => recordData[k])
            );
            console.log(`↑ Write-back PostgreSQL: insert → ${collection}`);
          } else if (action === 'update' && recordMeta?.extId) {
            const keys = Object.keys(recordData);
            const sets = keys.map((k, i) => `"${k}"=$${i + 2}`);
            await client.query(
              `UPDATE "${collection}" SET ${sets.join(',')} WHERE id=$1`,
              [recordMeta.extId, ...keys.map(k => recordData[k])]
            );
            console.log(`↑ Write-back PostgreSQL: update ${recordMeta.extId} → ${collection}`);
          } else if (action === 'delete' && recordMeta?.extId) {
            await client.query(`DELETE FROM "${collection}" WHERE id=$1`, [recordMeta.extId]);
            console.log(`↑ Write-back PostgreSQL: delete ${recordMeta.extId} → ${collection}`);
          }
        } finally { await client.end(); }
      }
    }
  } catch (err) {
    console.warn(`⚠️ writeBackToSource(${schemaName}):`, err.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/integrations/sync/list
// ────────────────────────────────────────────────────────────────────────────
router.get('/sync/list', checkAccess, async (req, res) => {
  try {
    const configs = await UserSyncConfig.find({ userId: req.user._id }).lean();
    res.json({ success: true, configs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/sync/save
// Body: { schemaName, sourceUrl, sheetName? }
// ────────────────────────────────────────────────────────────────────────────
router.post('/sync/save', checkAccess, async (req, res) => {
  try {
    const { schemaName, sourceUrl, sheetName, direction } = req.body;
    if (!schemaName || !sourceUrl) return res.status(400).json({ error: 'schemaName и sourceUrl обязательны' });

    const limits = req.user.getPlanLimits();
    if (limits.label === 'Standard') {
      return res.status(403).json({ error: 'Google Sheets синхронизация доступна начиная с тарифа Pro', planLimits: limits });
    }

    const sheetId = extractSheetId(sourceUrl);
    if (!sheetId) return res.status(400).json({ error: 'Не удалось определить ID таблицы' });

    const config = await UserSyncConfig.findOneAndUpdate(
      { userId: req.user._id, schemaName },
      { $set: {
        sourceType: 'google_sheets', sourceUrl, sheetId,
        sheetName: sheetName || null, enabled: true,
        direction: direction || 'import',
      }},
      { upsert: true, returnDocument: 'after' }
    );

    const count = await runSync(config);
    res.json({ success: true, config, syncedCount: count });
  } catch (err) {
    console.error('Sync save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/sync/trigger/:id  — manual refresh
// ────────────────────────────────────────────────────────────────────────────
router.post('/sync/trigger/:id', checkAccess, async (req, res) => {
  try {
    const config = await UserSyncConfig.findOne({ _id: req.params.id, userId: req.user._id });
    if (!config) return res.status(404).json({ error: 'Конфигурация не найдена' });
    const count = await runSync(config);
    res.json({ success: true, syncedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/integrations/sync/:id
// ────────────────────────────────────────────────────────────────────────────
router.delete('/sync/:id', checkAccess, async (req, res) => {
  try {
    await UserSyncConfig.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/vk/setup
// Body: { token, groupId, secret?, profileId?, name? }
// Adds a new VK group instance, returns instanceId + webhookUrl
// ────────────────────────────────────────────────────────────────────────────
router.post('/vk/setup', checkAccess, async (req, res) => {
  try {
    const { token, secret, profileId, name } = req.body;
    const rawGroupId = String(req.body.groupId || '').trim();
    const numericOnly = rawGroupId.replace(/\D/g, '');
    const groupIdParam = numericOnly || rawGroupId;
    if (!token || !groupIdParam) {
      return res.status(400).json({ error: 'token и groupId обязательны' });
    }

    const limits = req.user.getPlanLimits();
    if (limits.integrations === 0) {
      return res.status(403).json({ error: 'Хостинговые интеграции доступны начиная с тарифа Pro', planLimits: limits });
    }

    const serverUrl = process.env.SERVER_URL || '';
    if (!serverUrl) return res.status(500).json({ error: 'SERVER_URL не задан в .env' });

    // Check plan limit on total instances
    const totalActive = await countUserIntegrations(req.user._id);
    if (limits.integrations !== Infinity && totalActive >= limits.integrations) {
      return res.status(403).json({ error: `Достигнут лимит интеграций (${limits.integrations})` });
    }

    const vkCheck = await fetch(
      `https://api.vk.com/method/groups.getById?group_id=${encodeURIComponent(groupIdParam)}&access_token=${token}&v=5.199`
    ).then((r) => r.json()).catch(() => null);

    if (!vkCheck || vkCheck.error) {
      return res.status(400).json({ error: 'Неверный токен или ID сообщества. ' + (vkCheck?.error?.error_msg || '') });
    }

    const resolvedId = String(vkCheck.response?.groups?.[0]?.id || vkCheck.response?.[0]?.id || groupIdParam);

    const newInstance = {
      name: name || '',
      token,
      groupId: resolvedId,
      confirmString: '',
      secret: secret || '',
      connected: false,
      ...(profileId ? { profileId } : {}),
    };

    const updated = await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $push: { vk: newInstance } },
      { upsert: true, returnDocument: 'after' }
    );

    const instance = updated.vk[updated.vk.length - 1];
    const webhookUrl = `${serverUrl}/api/v1/webhook/vk/${req.user._id}/${instance._id}`;

    res.json({ success: true, instanceId: instance._id, webhookUrl, step: 'confirm' });
  } catch (err) {
    console.error('VK setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/vk/:instanceId/activate
// ────────────────────────────────────────────────────────────────────────────
router.post('/vk/:instanceId/activate', checkAccess, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { confirmString } = req.body;
    if (!confirmString?.trim()) {
      return res.status(400).json({ error: 'Введите строку подтверждения из настроек VK Callback API' });
    }
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id, 'vk._id': instanceId },
      { $set: { 'vk.$.confirmString': confirmString.trim(), 'vk.$.connected': true, 'vk.$.connectedAt': new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/integrations/vk/:instanceId/disconnect
// ────────────────────────────────────────────────────────────────────────────
router.delete('/vk/:instanceId/disconnect', checkAccess, async (req, res) => {
  try {
    const { instanceId } = req.params;
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $pull: { vk: { _id: instanceId } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/max/connect  — Body: { token, profileId?, name? }
// ────────────────────────────────────────────────────────────────────────────
router.post('/max/connect', checkAccess, async (req, res) => {
  try {
    const { token, profileId, name } = req.body;
    if (!token) return res.status(400).json({ error: 'Токен бота обязателен' });

    const limits = req.user.getPlanLimits();
    if (limits.integrations === 0) {
      return res.status(403).json({ error: 'Хостинговые интеграции доступны начиная с тарифа Pro' });
    }

    const serverUrl = process.env.SERVER_URL || '';
    if (!serverUrl) return res.status(500).json({ error: 'SERVER_URL не задан в .env' });

    // Check plan limit
    const totalActiveMax = await countUserIntegrations(req.user._id);
    if (limits.integrations !== Infinity && totalActiveMax >= limits.integrations) {
      return res.status(403).json({ error: `Достигнут лимит интеграций (${limits.integrations})` });
    }

    const meResp = await fetch(`https://botapi.max.ru/me?access_token=${token}`)
      .then((r) => r.json()).catch(() => null);
    if (!meResp || meResp.name === undefined) {
      return res.status(400).json({ error: 'Неверный токен. Проверьте токен на bots.max.ru' });
    }

    // Reserve placeholder to get _id before registering webhook
    const updated = await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $push: { max: { name: name || '', token, botName: meResp.name || '', botUsername: meResp.username || '', connected: false, ...(profileId ? { profileId } : {}) } } },
      { upsert: true, returnDocument: 'after' }
    );
    const instance = updated.max[updated.max.length - 1];

    const webhookUrl = `${serverUrl}/api/v1/webhook/max/${req.user._id}/${instance._id}`;
    const subResp = await fetch(`https://botapi.max.ru/subscriptions?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, update_types: ['message_created'] }),
    }).then((r) => r.json()).catch(() => null);

    if (!subResp || subResp.success === false) {
      // Roll back the added instance
      await UserIntegrations.findOneAndUpdate({ userId: req.user._id }, { $pull: { max: { _id: instance._id } } });
      return res.status(400).json({ error: 'Не удалось зарегистрировать webhook: ' + (subResp?.message || 'ошибка MAX API') });
    }

    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id, 'max._id': instance._id },
      { $set: { 'max.$.connected': true, 'max.$.connectedAt': new Date() } }
    );

    res.json({ success: true, instanceId: instance._id, botName: meResp.name, botUsername: meResp.username });
  } catch (err) {
    console.error('MAX connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/integrations/max/:instanceId/disconnect
// ────────────────────────────────────────────────────────────────────────────
router.delete('/max/:instanceId/disconnect', checkAccess, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const doc = await UserIntegrations.findOne({ userId: req.user._id });
    const instance = doc?.max?.id(instanceId);
    if (instance?.token) {
      await fetch(`https://botapi.max.ru/subscriptions?access_token=${instance.token}`, { method: 'DELETE' }).catch(() => {});
    }
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $pull: { max: { _id: instanceId } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/telegram/connect
// Body: { token, profileId?, name? }
// Adds a new Telegram bot instance for this user
// ────────────────────────────────────────────────────────────────────────────
router.post('/telegram/connect', checkAccess, async (req, res) => {
  try {
    const { token, profileId, name } = req.body;
    const result = await connectTelegramBot(req.user, token, profileId, name);
    if (!result.success) {
      return res.status(result.status).json({ error: result.error, ...(result.planLimits ? { planLimits: result.planLimits } : {}) });
    }
    console.log(`✅ Telegram подключён для ${req.user.email}: @${result.botUsername}`);
    res.json({ success: true, instanceId: result.instanceId, botUsername: result.botUsername, webhookUrl: result.webhookUrl });
  } catch (err) {
    console.error('Telegram connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/integrations/telegram/:instanceId/disconnect
// ────────────────────────────────────────────────────────────────────────────
router.delete('/telegram/:instanceId/disconnect', checkAccess, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const doc = await UserIntegrations.findOne({ userId: req.user._id });
    const instance = doc?.telegram?.id(instanceId);
    if (instance?.token) {
      await fetch(`https://api.telegram.org/bot${instance.token}/deleteWebhook`).catch(() => {});
    }
    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $pull: { telegram: { _id: instanceId } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/integrations/webhook-callback
// Body: { url: string, enabled: boolean }
// ────────────────────────────────────────────────────────────────────────────
router.put('/webhook-callback', checkAccess, async (req, res) => {
  try {
    const { url, enabled } = req.body;

    if (enabled && url) {
      try { new URL(url); } catch {
        return res.status(400).json({ error: 'Неверный URL webhook-callback' });
      }
    }

    await UserIntegrations.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { 'webhookCallback.enabled': !!enabled, 'webhookCallback.url': url || '' } },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/external-db/test
// Body: { connectionString, type: 'mongodb' | 'postgresql' }
// Tests connection and returns list of collections/tables
// ────────────────────────────────────────────────────────────────────────────
router.post('/external-db/test', checkAccess, async (req, res) => {
  const { connectionString, type } = req.body;
  if (!connectionString || !type) return res.status(400).json({ error: 'connectionString and type required' });

  const isMongo = type === 'mongodb';
  const isPg    = type === 'postgresql';
  if (!isMongo && !isPg) return res.status(400).json({ error: 'type must be mongodb or postgresql' });

  // Basic security: disallow local/private addresses
  const stripped = connectionString.replace(/^(mongodb|postgresql|postgres):\/\//i, '');
  const hostPart = stripped.split('/')[0].split('@').pop().split(':')[0];
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i.test(hostPart)) {
    return res.status(400).json({ error: 'Локальные адреса не поддерживаются для внешней синхронизации' });
  }

  try {
    if (isMongo) {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
      await client.connect();
      const dbName = new URL(connectionString.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
      const db = client.db(dbName || undefined);
      const cols = await db.listCollections().toArray();
      await client.close();
      res.json({ success: true, type: 'mongodb', collections: cols.map(c => c.name) });
    } else {
      const { Client } = require('pg');
      const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
      await client.connect();
      const result = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
      await client.end();
      res.json({ success: true, type: 'postgresql', tables: result.rows.map(r => r.table_name) });
    }
  } catch (err) {
    res.status(400).json({ error: 'Не удалось подключиться: ' + err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/integrations/external-db/import
// Body: { connectionString, type, collection, schemaName, limit }
// Imports records from external DB into user's Siberi schema
// ────────────────────────────────────────────────────────────────────────────
router.post('/external-db/import', checkAccess, async (req, res) => {
  const { connectionString, type, collection, schemaName, limit = 500 } = req.body;
  if (!connectionString || !type || !collection || !schemaName) {
    return res.status(400).json({ error: 'connectionString, type, collection, schemaName required' });
  }

  // Security: block local addresses
  const stripped = connectionString.replace(/^(mongodb|postgresql|postgres):\/\//i, '');
  const hostPart = stripped.split('/')[0].split('@').pop().split(':')[0];
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i.test(hostPart)) {
    return res.status(400).json({ error: 'Локальные адреса не поддерживаются' });
  }

  const safeLimit = Math.min(Number(limit) || 500, 2000);

  try {
    let rows = [];
    if (type === 'mongodb') {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const dbName = new URL(connectionString.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
      const db = client.db(dbName || undefined);
      const docs = await db.collection(collection).find({}, { projection: { _id: 0 } }).limit(safeLimit).toArray();
      rows = docs;
      await client.close();
    } else {
      const { Client } = require('pg');
      const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
      await client.connect();
      const result = await client.query(`SELECT * FROM "${collection}" LIMIT $1`, [safeLimit]);
      rows = result.rows;
      await client.end();
    }

    if (rows.length === 0) return res.json({ success: true, imported: 0 });

    // Auto-create schema from first row's keys
    const sampleKeys = Object.keys(rows[0]);
    let schema = await UserSchema.findOne({ userId: req.user._id, name: schemaName });
    if (!schema) {
      schema = await UserSchema.create({
        userId: req.user._id,
        name: schemaName,
        label: collection,
        fields: sampleKeys.map(k => ({ name: k, label: k, type: 'text', required: false })),
        isActive: true,
      });
    }

    // Batch import records
    const UserRecord = require('../models/UserRecord');
    const docs = rows.map(row => ({
      userId: req.user._id,
      schemaId: schema._id,
      schemaName,
      data: row,
      createdAt: new Date(),
    }));
    await UserRecord.insertMany(docs, { ordered: false });

    res.json({ success: true, imported: docs.length, schemaName });
  } catch (err) {
    console.error('External DB import error:', err.message);
    res.status(500).json({ error: 'Ошибка импорта: ' + err.message });
  }
});

// ── External DB sync config: save + first run ─────────────────────────────────
// POST /api/v1/integrations/external-db/sync/save
router.post('/external-db/sync/save', checkAccess, async (req, res) => {
  try {
    const { connectionString, dbType, collection, schemaName, direction } = req.body;
    if (!connectionString || !dbType || !collection || !schemaName) {
      return res.status(400).json({ error: 'connectionString, dbType, collection, schemaName required' });
    }
    const config = await UserSyncConfig.findOneAndUpdate(
      { userId: req.user._id, sourceType: 'external_db', schemaName },
      { $set: { connectionString, dbType, collection, schemaName, sourceType: 'external_db', enabled: true, direction: direction || 'import' } },
      { upsert: true, returnDocument: 'after' }
    );
    const count = await runExternalDbSync(config);
    res.json({ success: true, imported: count, configId: config._id });
  } catch (err) {
    console.error('External DB sync save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/integrations/external-db/sync/trigger/:id — manual refresh
router.post('/external-db/sync/trigger/:id', checkAccess, async (req, res) => {
  try {
    const config = await UserSyncConfig.findOne({ _id: req.params.id, userId: req.user._id, sourceType: 'external_db' });
    if (!config) return res.status(404).json({ error: 'Конфигурация не найдена' });
    const count = await runExternalDbSync(config);
    res.json({ success: true, imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/integrations/external-db/sync/:id
router.delete('/external-db/sync/:id', checkAccess, async (req, res) => {
  try {
    await UserSyncConfig.findOneAndDelete({ _id: req.params.id, userId: req.user._id, sourceType: 'external_db' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/integrations/external-db/sync/list
router.get('/external-db/sync/list', checkAccess, async (req, res) => {
  try {
    const configs = await UserSyncConfig.find({ userId: req.user._id, sourceType: 'external_db' }).lean();
    res.json({ success: true, configs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.runAllSyncs = runAllSyncs;
module.exports.writeBackToSource = writeBackToSource;
