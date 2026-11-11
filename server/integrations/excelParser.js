'use strict';
const XLSX = require('xlsx');

// Parse an Excel buffer (.xlsx / .xls / .csv) into { sheets: [{ name, headers, rows }] }
function parseExcelBuffer(buffer, opts = {}) {
  const ext = (opts.ext || '').toLowerCase();
  let workbook;

  if (ext === 'csv') {
    // XLSX mishandles UTF-8 Cyrillic in CSV. Convert buffer → UTF-8 string first.
    const text = buffer.toString('utf-8').replace(/^﻿/, ''); // strip BOM
    workbook = XLSX.read(text, { type: 'string', cellDates: true });
  } else {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  }

  const result = [];
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (raw.length === 0) continue;

    const headers = Object.keys(raw[0]);
    const rows = raw.map((row) => {
      const obj = {};
      headers.forEach((h) => {
        const v = row[h];
        obj[h] = v !== undefined && v !== null ? String(v).trim() : '';
      });
      return obj;
    }).filter((row) => Object.values(row).some((v) => v !== ''));

    result.push({ name: sheetName, headers, rows });
  }

  return result; // array of sheets
}

module.exports = { parseExcelBuffer };
