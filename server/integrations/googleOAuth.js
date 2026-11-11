'use strict';
const crypto = require('crypto');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function createClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/v1/integrations/google/callback'
  );
}

function _stateSecret() {
  return process.env.OAUTH_STATE_SECRET || process.env.SESSION_SECRET || '';
}

// Sign userId into a tamper-proof state token
function signState(userId) {
  const secret = _stateSecret();
  const sig = crypto.createHmac('sha256', secret).update(userId).digest('hex').slice(0, 24);
  return `${userId}.${sig}`;
}

// Verify state token; returns userId on success, null on failure
function verifyState(state) {
  if (!state || !state.includes('.')) return null;
  const dot = state.lastIndexOf('.');
  const userId = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const secret = _stateSecret();
  const expected = crypto.createHmac('sha256', secret).update(userId).digest('hex').slice(0, 24);
  if (sig !== expected) return null;
  return userId;
}

// Generates the Google OAuth consent URL with HMAC-signed state
function getAuthUrl(stateUserId) {
  const client = createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state: signState(stateUserId),
    prompt: 'consent', // always return refresh_token
  });
}

// Exchange auth code → tokens { access_token, refresh_token, expiry_date }
async function exchangeCode(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Build an authenticated OAuth2 client from stored tokens
function buildClient(tokens) {
  const client = createClient();
  client.setCredentials(tokens);
  // Auto-refresh when token expires
  client.on('tokens', (newTokens) => {
    if (newTokens.refresh_token) {
      tokens.refresh_token = newTokens.refresh_token;
    }
    tokens.access_token = newTokens.access_token;
    tokens.expiry_date = newTokens.expiry_date;
  });
  return client;
}

// Fetch the Google account email for a connected client
async function getGoogleEmail(authClient) {
  const oauth2 = google.oauth2({ version: 'v2', auth: authClient });
  const { data } = await oauth2.userinfo.get();
  return data.email;
}

module.exports = { getAuthUrl, verifyState, exchangeCode, buildClient, getGoogleEmail };
