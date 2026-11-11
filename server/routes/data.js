'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');

const checkAccess = require('../middleware/checkAccess');
const UserSchema = require('../models/UserSchema');
const UserRecord = require('../models/UserRecord');
const UserAiConfig = require('../models/UserAiConfig');
const UserScheduleConfig = require('../models/UserScheduleConfig');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['json', 'csv', 'sql'].includes(ext)) cb(null, true);
    else cb(new Error('Разрешены только .json, .csv и .sql файлы'));
  },
});

// ==================== API ДЛЯ УПРАВЛЕНИЯ ДАННЫМИ ====================

// 🔥 Получить все схемы пользователя
router.get('/data/schemas', checkAccess, async (req, res) => {
  try {
    const schemas = await UserSchema.find({ userId: req.user._id, isActive: true })
      .sort({ createdAt: 1 })
      .lean();

    const totalRecords = await UserRecord.countDocuments({ userId: req.user._id });

    // Кол-во записей по каждой схеме — мини-апп показывает его на карточках
    const countsAgg = await UserRecord.aggregate([
      { $match: { userId: req.user._id } },
      { $group: { _id: '$schemaName', n: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(countsAgg.map((c) => [c._id, c.n]));
    const schemasWithCounts = schemas.map((s) => ({ ...s, recordCount: counts[s.name] || 0 }));

    res.json({ success: true, count: schemas.length, schemas: schemasWithCounts, totalRecords });
  } catch (err) {
    console.error('Get schemas error:', err);
    res.status(500).json({ error: 'Failed to fetch schemas' });
  }
});

// 🔥 Создать новую схему
router.post('/data/schemas', checkAccess, async (req, res) => {
  try {
    const { name, label, description, fields, icon, color } = req.body;

    if (!name || !label || !fields?.length) {
      return res.status(400).json({ error: 'name, label и fields обязательны' });
    }

    // Валидация name: только латиница, цифры, подчёркивание
    if (!/^[a-z0-9_]+$/i.test(name)) {
      return res
        .status(400)
        .json({ error: 'name должен содержать только латиницу, цифры и подчёркивание' });
    }

    // Проверка на уникальность
    const existing = await UserSchema.findOne({ userId: req.user._id, name });
    if (existing) {
      return res.status(409).json({ error: `Схема "${name}" уже существует` });
    }

    const schema = new UserSchema({
      userId: req.user._id,
      name,
      label,
      description,
      fields,
      icon: icon || '📋',
      color: color || '#3b82f6',
    });

    await schema.save();

    res.status(201).json({ success: true, schema });
  } catch (err) {
    console.error('Create schema error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Схема с таким именем уже существует' });
    }
    res.status(500).json({ error: 'Failed to create schema' });
  }
});

// 🔥 Обновить схему
router.put('/data/schemas/:schemaName', checkAccess, async (req, res) => {
  try {
    const { schemaName } = req.params;
    const { fields, ...updates } = req.body;

    const schema = await UserSchema.findOne({ userId: req.user._id, name: schemaName });
    if (!schema) {
      return res.status(404).json({ error: 'Schema not found' });
    }

    // Если обновляем поля — валидируем их
    if (fields) {
      for (const field of fields) {
        if (field.name && !/^[a-z0-9_]+$/i.test(field.name)) {
          return res
            .status(400)
            .json({ error: `Поле name "${field.name}" содержит недопустимые символы` });
        }
      }
      updates.fields = fields;
    }

    updates.updatedAt = new Date();

    const updated = await UserSchema.findOneAndUpdate(
      { userId: req.user._id, name: schemaName },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    res.json({ success: true, schema: updated });
  } catch (err) {
    console.error('Update schema error:', err);
    res.status(500).json({ error: 'Failed to update schema' });
  }
});

// Назначить схему профилям ([] = общая, [id, ...] = только эти профили)
router.patch('/data/schemas/:schemaName/assign', checkAccess, async (req, res) => {
  try {
    const { profileIds = [] } = req.body;
    const schema = await UserSchema.findOne({ userId: req.user._id, name: req.params.schemaName });
    if (!schema) return res.status(404).json({ error: 'Schema not found' });
    schema.profileIds = profileIds;
    await schema.save();
    res.json({ success: true, profileIds: schema.profileIds });
  } catch (err) {
    console.error('Assign schema error:', err);
    res.status(500).json({ error: 'Failed to assign schema' });
  }
});

// 🔥 Удалить схему
router.delete('/data/schemas/:schemaName', checkAccess, async (req, res) => {
  try {
    const { schemaName } = req.params;

    // Удаляем все записи этой схемы
    await UserRecord.deleteMany({ userId: req.user._id, schemaName });

    // Удаляем саму схему
    const deleted = await UserSchema.findOneAndDelete({
      userId: req.user._id,
      name: schemaName,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Schema not found' });
    }

    // Останавливаем синхронизацию Google Sheets для этой схемы
    const UserSyncConfig = require('../models/UserSyncConfig');
    await UserSyncConfig.deleteMany({ userId: req.user._id, schemaName });

    res.json({ success: true, message: `Schema "${schemaName}" и все записи удалены` });
  } catch (err) {
    console.error('Delete schema error:', err);
    res.status(500).json({ error: 'Failed to delete schema' });
  }
});

// 🔥 Получить записи по схеме (с пагинацией и поиском)
router.get('/data/records/:schemaName', checkAccess, async (req, res) => {
  try {
    const { schemaName } = req.params;
    const { limit = 50, page = 1, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // Auto-detect external API integration (exclude dashboard calls from siberi.online)
    if (!req.user.apiIntegrationActive) {
      const origin = req.headers.origin || req.headers.referer || '';
      const isInternal = origin.includes('siberi.online') || origin.includes('localhost');
      if (!isInternal) {
        req.user.apiIntegrationActive = true;
        req.user.save().catch(() => {});
      }
    }

    const query = { userId: req.user._id, schemaName };

    // 🔥 Поиск по всем полям data
    if (search) {
      query.$text = { $search: search };
    }

    // 🔥 Пагинация
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // 🔥 Сортировка — whitelist allowed fields to prevent NoSQL injection
    const ALLOWED_SORT = ['createdAt', 'updatedAt'];
    const safeSortBy = ALLOWED_SORT.includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [safeSortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [records, total] = await Promise.all([
      UserRecord.find(query).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      UserRecord.countDocuments(query),
    ]);

    res.json({
      success: true,
      records,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Get records error:', err);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

// 🔥 Создать запись
router.post('/data/records/:schemaName', checkAccess, async (req, res) => {
  try {
    const { schemaName } = req.params;
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data должен быть объектом' });
    }

    const schema = await UserSchema.findOne({ userId: req.user._id, name: schemaName });
    if (!schema) {
      return res.status(404).json({ error: 'Schema not found' });
    }

    const validation = schema.validateData(data);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.errors.join('; ') });
    }

    const record = await UserRecord.create({
      userId: req.user._id,
      schemaName,
      data,
      metadata: { createdBy: 'user', source: 'web' },
    });

    res.status(201).json({ success: true, record });
  } catch (err) {
    console.error('Create record error:', err);
    res.status(500).json({ error: 'Failed to create record' });
  }
});

// 🔥 Обновить запись
router.put('/data/records/:schemaName/:recordId', checkAccess, async (req, res) => {
  try {
    const { schemaName, recordId } = req.params;
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data должен быть объектом' });
    }

    const schema = await UserSchema.findOne({ userId: req.user._id, name: schemaName });
    if (!schema) {
      return res.status(404).json({ error: 'Schema not found' });
    }

    const validation = schema.validateData(data);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.errors.join('; ') });
    }

    const record = await UserRecord.findOneAndUpdate(
      { _id: recordId, userId: req.user._id, schemaName },
      {
        $set: {
          data,
          'metadata.lastModifiedBy': 'user',
          'metadata.source': 'web',
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after', runValidators: true }
    );

    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ success: true, record });
  } catch (err) {
    console.error('Update record error:', err);
    res.status(500).json({ error: 'Failed to update record' });
  }
});

// 🔥 Удалить запись
router.delete('/data/records/:schemaName/:recordId', checkAccess, async (req, res) => {
  try {
    const { schemaName, recordId } = req.params;

    const record = await UserRecord.findOneAndDelete({
      _id: recordId,
      userId: req.user._id,
      schemaName,
    });

    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ success: true, message: 'Record deleted', record });
  } catch (err) {
    console.error('Delete record error:', err);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

// ==================== ЭКСПОРТ ДАННЫХ ====================
router.get('/data/export', checkAccess, async (req, res) => {
  try {
    const userId = req.user._id;
    const format = req.query.format || 'json'; // json | csv | mysql | postgresql
    const schemaFilter = req.query.schema || null;

    const schemaQuery = { userId, isActive: true };
    if (schemaFilter) schemaQuery.name = schemaFilter;

    const [schemas, records] = await Promise.all([
      UserSchema.find(schemaQuery).lean(),
      UserRecord.find(schemaFilter ? { userId, schemaName: schemaFilter } : { userId }).lean(),
    ]);

    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      const recordsBySchema = {};
      for (const rec of records) {
        if (!recordsBySchema[rec.schemaName]) recordsBySchema[rec.schemaName] = [];
        recordsBySchema[rec.schemaName].push({ data: rec.data });
      }
      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        schemas: schemas.map((s) => ({ name: s.name, label: s.label, description: s.description, fields: s.fields, icon: s.icon, color: s.color })),
        records: recordsBySchema,
      };
      res.attachment(`siberiai-export-${dateStr}.json`);
      res.setHeader('Content-Type', 'application/json');
      return res.json(exportData);
    }

    if (format === 'csv') {
      const schema = schemas[0];
      if (!schema) return res.status(400).json({ error: 'Схема не найдена' });
      const schemaRecords = records.filter((r) => r.schemaName === schema.name);
      const fields = schema.fields || [];
      // Use semicolon delimiter — Excel in Russian locale (and most European locales)
      // treats semicolons as the list separator, so this opens correctly by double-click.
      const SEP = ';';
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = fields.map((f) => esc(f.label || f.name)).join(SEP);
      const rows = schemaRecords.map((rec) =>
        fields.map((f) => esc(rec.data?.[f.name] ?? '')).join(SEP)
      );
      // BOM (EF BB BF) tells Excel this is UTF-8. No sep= line — combining sep= with
      // BOM causes Excel to ignore the BOM and read as ANSI, garbling Cyrillic text.
      // Semicolon delimiter works out-of-the-box in Russian/European Excel locale.
      const csv = '﻿' + [header, ...rows].join('\r\n');
      res.attachment(`siberiai-${schema.name}-${dateStr}.csv`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(csv);
    }

    if (format === 'xlsx') {
      const XLSX = require('xlsx');
      const wb = XLSX.utils.book_new();

      // Convert ISO date string YYYY-MM-DD to Excel date serial number.
      // Storing as a real Excel date with an explicit format guarantees
      // the cell always shows as DD.MM.YYYY regardless of regional settings.
      const isoToSerial = (str) => {
        const m = str && str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        if (isNaN(d)) return null;
        // Excel epoch: Jan 1 1900 = serial 1 (with the 1900 leap-year bug: serial 60 = Feb 29 1900 which doesn't exist)
        const serial = Math.round((d - new Date(Date.UTC(1899, 11, 31))) / 86400000);
        return serial > 0 ? serial : null;
      };

      for (const schema of schemas) {
        const fields = schema.fields || [];
        const schemaRecords = records.filter((r) => r.schemaName === schema.name);

        const ws = {};
        const numRows = schemaRecords.length;
        const numCols = fields.length;

        // Header row
        fields.forEach((f, ci) => {
          ws[XLSX.utils.encode_cell({ r: 0, c: ci })] = { t: 's', v: f.label || f.name };
        });

        // Wrap a value in a formula string ="value" so Excel always treats it as text.
        // t:'str' with f element is the only reliable way — t:'s' without shared strings
        // produces t="str" without <f>, which Excel misinterprets for numeric-looking values.
        const textCell = (v) => {
          const s = String(v);
          // Escape double-quotes inside the formula string by doubling them
          return { t: 'str', f: `"${s.replace(/"/g, '""')}"`, v: s };
        };

        // Data rows
        schemaRecords.forEach((rec, ri) => {
          fields.forEach((f, ci) => {
            const raw = rec.data?.[f.name] ?? '';
            let cell;

            if (f.type === 'number' && raw !== '' && !isNaN(raw)) {
              cell = { t: 'n', v: Number(raw) };
            } else {
              // Try to detect ISO date strings (YYYY-MM-DD) and store as real Excel dates.
              const serial = isoToSerial(String(raw));
              if (serial !== null) {
                cell = { t: 'n', v: serial, z: 'DD.MM.YYYY' };
              } else {
                // Formula string: Excel evaluates ="value" → always text, never converted
                cell = textCell(raw);
              }
            }

            ws[XLSX.utils.encode_cell({ r: ri + 1, c: ci })] = cell;
          });
        });

        ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: numRows, c: numCols - 1 } });

        // Column widths: dates always need at least 12 chars (DD.MM.YYYY + padding),
        // Cyrillic headers need ×1.8 to match pixel width of ASCII chars in Excel
        ws['!cols'] = fields.map((f) => {
          const headerLen = Math.ceil((f.label || f.name).length * 1.8);
          const maxDataLen = schemaRecords.reduce((max, rec) => {
            const v = String(rec.data?.[f.name] ?? '');
            // ISO dates will be shown as DD.MM.YYYY = 10 chars
            const displayLen = /^\d{4}-\d{2}-\d{2}$/.test(v) ? 10 : v.length;
            return Math.max(max, displayLen);
          }, 0);
          return { wch: Math.min(Math.max(headerLen, maxDataLen + 2, 12), 60) };
        });

        const sheetName = (schema.label || schema.name).replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1';
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      }

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.attachment(`siberiai-export-${dateStr}.xlsx`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(buf);
    }

    if (format === 'mysql' || format === 'postgresql') {
      const isMySQL = format === 'mysql';
      const q = (s) => isMySQL ? `\`${s}\`` : `"${s}"`;
      const lines = [
        `-- Siberi AI Export | Format: ${isMySQL ? 'MySQL' : 'PostgreSQL'} | Date: ${new Date().toISOString()}`,
        '',
      ];
      for (const schema of schemas) {
        const fields = schema.fields || [];
        const schemaRecords = records.filter((r) => r.schemaName === schema.name);
        lines.push(`-- Table: ${schema.name} (${schema.label || schema.name})`);
        lines.push(`DROP TABLE IF EXISTS ${q(schema.name)};`);
        if (isMySQL) {
          lines.push(`CREATE TABLE ${q(schema.name)} (`);
          lines.push(`  ${q('id')} INT AUTO_INCREMENT PRIMARY KEY,`);
          fields.forEach((f, i) => {
            const t = f.type === 'number' ? 'DECIMAL(15,4)' : 'TEXT';
            lines.push(`  ${q(f.name)} ${t}${i < fields.length - 1 ? ',' : ''}`);
          });
          lines.push(`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        } else {
          lines.push(`CREATE TABLE ${q(schema.name)} (`);
          lines.push(`  id SERIAL PRIMARY KEY,`);
          fields.forEach((f, i) => {
            const t = f.type === 'number' ? 'NUMERIC' : 'TEXT';
            lines.push(`  ${q(f.name)} ${t}${i < fields.length - 1 ? ',' : ''}`);
          });
          lines.push(`);`);
        }
        if (schemaRecords.length > 0) {
          const cols = fields.map((f) => q(f.name)).join(', ');
          lines.push(`INSERT INTO ${q(schema.name)} (${cols}) VALUES`);
          schemaRecords.forEach((rec, i) => {
            const vals = fields.map((f) => {
              const v = rec.data?.[f.name];
              if (v === null || v === undefined || v === '') return 'NULL';
              if (f.type === 'number' && !isNaN(v)) return Number(v);
              return `'${String(v).replace(/'/g, "''")}'`;
            }).join(', ');
            lines.push(`  (${vals})${i < schemaRecords.length - 1 ? ',' : ';'}`);
          });
        }
        lines.push('');
      }
      res.attachment(`siberiai-${format}-${dateStr}.sql`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(lines.join('\n'));
    }

    res.status(400).json({ error: 'Неизвестный формат: ' + format });
  } catch (err) {
    console.error('❌ Export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ==================== ИМПОРТ ДАННЫХ ====================
function transliterate(str) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo',
    'ж':'zh','з':'z','и':'i','й':'j','к':'k','л':'l','м':'m',
    'н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u',
    'ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch',
    'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
  };
  return str.toLowerCase().split('').map((c) => {
    if (map[c] !== undefined) return map[c];
    if (/[a-z0-9]/.test(c)) return c;
    return '_';
  }).join('').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'field';
}

function uniqueName(base, existing) {
  if (!existing.has(base)) { existing.add(base); return base; }
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  const name = `${base}_${i}`;
  existing.add(name);
  return name;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  // Auto-detect delimiter: semicolon (Excel RU) vs comma
  const firstLine = lines[0];
  const commas = (firstLine.match(/,/g) || []).length;
  const semis  = (firstLine.match(/;/g) || []).length;
  const delim  = semis > commas ? ';' : ',';

  const parseRow = (line) => {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === delim && !inQ) { result.push(cur); cur = ''; }
      else cur += c;
    }
    result.push(cur);
    return result;
  };

  const headers = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim() ?? ''; });
    return obj;
  });
}

function parseSQLDump(text) {
  const schemas = [];
  const recordsBySchema = {};
  const createRe = /CREATE TABLE\s+[`"]?(\w+)[`"]?\s*\(([\s\S]*?)\);/gi;
  const insertRe = /INSERT INTO\s+[`"]?(\w+)[`"]?\s*\(([^)]+)\)\s*VALUES\s*([\s\S]*?);/gi;
  let m;
  while ((m = createRe.exec(text)) !== null) {
    const tableName = m[1];
    const body = m[2];
    const fields = [];
    const colRe = /^\s*[`"]?(\w+)[`"]?\s+(TEXT|VARCHAR|CHAR|INT|BIGINT|NUMERIC|DECIMAL|FLOAT|DOUBLE|BOOL|BOOLEAN|DATE|TIMESTAMP)/im;
    for (const line of body.split('\n')) {
      if (/PRIMARY KEY|UNIQUE|KEY\s|INDEX\s|CONSTRAINT/i.test(line)) continue;
      const cm = colRe.exec(line);
      if (cm && cm[1].toLowerCase() !== 'id') {
        const sqlType = cm[2].toUpperCase();
        const fieldType = /INT|NUMERIC|DECIMAL|FLOAT|DOUBLE/.test(sqlType) ? 'number' : 'text';
        fields.push({ name: cm[1], label: cm[1], type: fieldType, required: false, options: [] });
      }
    }
    if (fields.length > 0) schemas.push({ name: tableName, label: tableName, fields, icon: '📋', color: '#3b82f6' });
  }
  while ((m = insertRe.exec(text)) !== null) {
    const tableName = m[1];
    const cols = m[2].split(',').map((c) => c.trim().replace(/[`"]/g, ''));
    const valuesStr = m[3];
    const rowRe = /\(([^)]*)\)/g;
    let rv;
    if (!recordsBySchema[tableName]) recordsBySchema[tableName] = [];
    while ((rv = rowRe.exec(valuesStr)) !== null) {
      const parts = rv[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1').replace(/''/g, "'").replace(/^NULL$/i, ''));
      const data = {};
      cols.forEach((c, i) => { if (c !== 'id') data[c] = parts[i] ?? ''; });
      recordsBySchema[tableName].push({ data });
    }
  }
  return { schemas, records: recordsBySchema };
}

router.post('/data/import', checkAccess, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    const rawText = req.file.buffer.toString('utf8').replace(/^﻿/, '');
    let importData;

    if (ext === 'csv') {
      const rawSchemaName = req.body.schema || req.file.originalname.replace(/\.csv$/i, '');
      const schemaName = transliterate(rawSchemaName) || 'imported';
      const rows = parseCSV(rawText);
      if (rows.length === 0) return res.status(400).json({ error: 'CSV файл пуст или не распознан' });

      // Build keyMap: original header → valid Latin field name (deduped)
      const usedNames = new Set();
      const keyMap = {};
      for (const k of Object.keys(rows[0])) {
        const base = transliterate(k) || 'field';
        keyMap[k] = uniqueName(base, usedNames);
      }

      const fields = Object.keys(rows[0]).map((k) => ({
        name: keyMap[k],
        label: k,
        type: 'text',
        required: false,
        options: [],
      }));

      importData = {
        schemas: [{ name: schemaName, label: rawSchemaName, description: 'Импортировано из CSV', fields, icon: '📊', color: '#10b981' }],
        records: {
          [schemaName]: rows.map((r) => {
            const data = {};
            for (const [orig, val] of Object.entries(r)) data[keyMap[orig]] = val;
            return { data };
          }),
        },
      };
    } else if (ext === 'sql') {
      importData = parseSQLDump(rawText);
      if (!importData.schemas.length) return res.status(400).json({ error: 'Не найдено таблиц в SQL файле' });
    } else {
      try {
        importData = JSON.parse(rawText);
      } catch {
        return res.status(400).json({ error: 'Невалидный JSON файл' });
      }
    }

    const userId = req.user._id;

    let importedSchemas = 0;
    let importedRecords = 0;
    const errors = [];

    // 1️⃣ Импорт схем (если есть)
    if (Array.isArray(importData.schemas)) {
      for (const schemaDef of importData.schemas) {
        if (!schemaDef.name || !Array.isArray(schemaDef.fields)) continue;

        const existing = await UserSchema.findOne({ userId, name: schemaDef.name });
        if (!existing) {
          await UserSchema.create({
            userId,
            name: schemaDef.name,
            label: schemaDef.label || schemaDef.name,
            description: schemaDef.description || '',
            fields: schemaDef.fields,
            icon: schemaDef.icon || '📋',
            color: schemaDef.color || '#3b82f6',
            profileIds: [], // всегда в Общие данные
          });
          importedSchemas++;
        } else if (existing.profileIds?.length) {
          // Переносим в Общие данные, если была привязана к профилю
          await UserSchema.updateOne({ _id: existing._id }, { $set: { profileIds: [] } });
        }
      }
    }

    // 2️⃣ Импорт записей
    if (importData.records && typeof importData.records === 'object') {
      for (const [schemaName, recordsArray] of Object.entries(importData.records)) {
        if (!Array.isArray(recordsArray)) continue;

        const schema = await UserSchema.findOne({ userId, name: schemaName });
        if (!schema) {
          errors.push(
            `Схема "${schemaName}" не найдена. Пропущено ${recordsArray.length} записей.`
          );
          continue;
        }

        const validRecords = [];
        for (const rec of recordsArray) {
          if (!rec.data || typeof rec.data !== 'object') continue;
          validRecords.push({
            userId,
            schemaName,
            data: rec.data,
            metadata: { createdBy: 'user', source: 'file_import', importedAt: new Date() },
          });
        }

        if (validRecords.length > 0) {
          const BATCH = 500;
          for (let i = 0; i < validRecords.length; i += BATCH) {
            const chunk = validRecords.slice(i, i + BATCH);
            try {
              const inserted = await UserRecord.insertMany(chunk, { ordered: false });
              importedRecords += inserted.length;
            } catch (batchErr) {
              const n = batchErr.insertedDocs?.length ?? batchErr.result?.insertedCount ?? 0;
              importedRecords += n;
              if (batchErr.code !== 11000) {
                errors.push(`Ошибка пакета "${schemaName}" [${i}–${i + BATCH}]: ${batchErr.message.slice(0, 120)}`);
              }
            }
          }
        }
      }
    }

    console.log(`📥 Import (${ext}): schemas=${importedSchemas}, records=${importedRecords}, errors=${errors.length}`);
    res.json({
      success: true,
      summary: {
        importedSchemas,
        importedRecords,
        errors: errors.slice(0, 50),
      },
    });
  } catch (err) {
    console.error('❌ Import error:', err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'Ошибка загрузки: ' + err.message });
    }
    if (!res.headersSent) res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ==================== ШАБЛОНЫ НИШ ====================
const NICHE_TEMPLATES = require('../helpers/nicheTemplates');

router.post('/data/niche-setup/:nicheId', checkAccess, async (req, res) => {
  try {
    const { nicheId } = req.params;
    const userId = req.user._id;
    const niche = NICHE_TEMPLATES[nicheId];
    if (!niche) return res.status(404).json({ error: 'Шаблон не найден' });

    const created = [], skipped = [];
    for (const tpl of niche.schemas) {
      const existing = await UserSchema.findOne({ userId, name: tpl.name });
      if (existing) { skipped.push(tpl.label); continue; }
      const schema = new UserSchema({
        userId,
        name: tpl.name,
        label: tpl.label,
        description: tpl.description || '',
        fields: tpl.fields,
        icon: tpl.icon || '📋',
        color: tpl.color || '#3b82f6',
        profileIds: [],
      });
      await schema.save();
      for (const record of (tpl.examples || [])) {
        await new UserRecord({
          userId,
          schemaName: tpl.name,
          data: record,
          metadata: { createdBy: 'user', source: 'niche_template' },
        }).save();
      }
      created.push(tpl.label);
    }
    res.json({ success: true, niche: niche.label, created, skipped });
  } catch (err) {
    console.error('Niche setup error:', err);
    res.status(500).json({ error: 'Failed to setup niche templates' });
  }
});

// ==================== РАСПИСАНИЕ: КОНФИГ МАСТЕРОВ ====================

router.get('/data/schedule-config', checkAccess, async (req, res) => {
  try {
    const configs = await UserScheduleConfig.find({ userId: req.user._id }).lean();
    const map = {};
    for (const c of configs) map[c.schemaName] = { workerField: c.workerField, workers: c.workers };
    res.json({ success: true, configs: map });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/data/schedule-config/:schemaName', checkAccess, async (req, res) => {
  try {
    const { schemaName } = req.params;
    const { workerField = '', workers = [] } = req.body;
    await UserScheduleConfig.findOneAndUpdate(
      { userId: req.user._id, schemaName },
      { workerField, workers },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
