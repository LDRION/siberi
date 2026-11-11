'use strict';
const { google } = require('googleapis');
const axios = require('axios');

function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function parseValues(rawRows) {
  if (!rawRows || rawRows.length === 0) return { headers: [], rows: [] };
  const headers = rawRows[0].map((h) => String(h ?? '').trim()).filter(Boolean);
  const rows = rawRows.slice(1)
    .map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] !== undefined ? String(row[i]).trim() : '';
      });
      obj._sheetRow = idx + 2; // row 1 = headers, data starts at row 2
      return obj;
    })
    .filter((row) => {
      const { _sheetRow, ...rest } = row;
      return Object.values(rest).some((v) => v !== '');
    });
  return { headers, rows };
}

async function fetchPublicSheet(sheetId, sheetName = null) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY не настроен — добавьте в .env');
  const range = sheetName ? encodeURIComponent(sheetName) : 'A1:ZZ2000';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await axios.get(url);
  return parseValues(res.data.values || []);
}

async function fetchPrivateSheet(sheetId, authClient, sheetName = null) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const range = sheetName || 'A1:ZZ2000';
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return parseValues(res.data.values || []);
}

async function listSheetTabs(sheetId, authClient = null) {
  if (authClient) {
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const res = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    return res.data.sheets.map((s) => s.properties.title);
  }
  const apiKey = process.env.GOOGLE_API_KEY;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${apiKey}&fields=sheets.properties.title`;
  const res = await axios.get(url);
  return res.data.sheets.map((s) => s.properties.title);
}

async function listUserSheets(authClient) {
  const drive = google.drive({ version: 'v3', auth: authClient });
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 30,
  });
  return res.data.files;
}

// ── Write-back: обновить строку в Google Sheets ───────────────────────────────
async function updateSheetRow(sheetId, sheetName, rowNumber, headers, data, authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const values = [headers.map(h => {
    const v = data[h];
    return v !== undefined && v !== null ? String(v) : '';
  })];
  const tab = sheetName || 'Sheet1';
  const range = `${tab}!A${rowNumber}:ZZ${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

// ── Write-back: добавить строку в Google Sheets ───────────────────────────────
async function appendSheetRow(sheetId, sheetName, headers, data, authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const values = [headers.map(h => {
    const v = data[h];
    return v !== undefined && v !== null ? String(v) : '';
  })];
  const tab = sheetName || 'Sheet1';
  const range = `${tab}!A1`;
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  // Extract the row number of the newly appended row
  const updatedRange = res.data.updates?.updatedRange || '';
  const match = updatedRange.match(/!A(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ── Write-back: удалить строку в Google Sheets ────────────────────────────────
async function deleteSheetRow(sheetId, sheetName, rowNumber, authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  // Get spreadsheet to find sheetId (numeric) for the given tab name
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tab = sheetName || 'Sheet1';
  const sheetTab = meta.data.sheets.find(s => s.properties.title === tab);
  if (!sheetTab) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetTab.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }],
    },
  });
}

module.exports = {
  extractSheetId,
  fetchPublicSheet, fetchPrivateSheet,
  listSheetTabs, listUserSheets,
  updateSheetRow, appendSheetRow, deleteSheetRow,
};
