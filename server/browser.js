const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { chromium } = require('playwright');

const IS_WINDOWS = process.platform === 'win32';

const USER_DATA_DIR = path.join(__dirname, 'edge-profile-master');
const MISTRAL_URL = 'https://chat.mistral.ai';
const ULTRAGPT_URL = 'https://app.ultragpt.pro';
const DEBUG_DIR = path.join(__dirname, 'debug');
const STORAGE_STATE_PATH = path.join(__dirname, 'mistral-auth-state.json');

// Создание папок
[DEBUG_DIR, USER_DATA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Проверка порта
async function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(2000);
  });
}

// Проверка CDP-интерфейса
async function isBrowserRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Запуск браузера
async function launchBrowser() {
  console.log('🔄 Проверка браузера...');

  if ((await isPortOpen(9223)) && (await isBrowserRunning(9223))) {
    console.log('✅ Браузер уже запущен на порту 9223');
    return true;
  }

  console.log('🚀 Запуск изолированного экземпляра Edge...');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const flags = [
    '--remote-debugging-port=9223',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,PlzServiceWorker,BackForwardCache',
    '--no-startup-window',
    ...(IS_WINDOWS ? [] : ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage']),
  ].join(' ');

  const edgePaths = IS_WINDOWS
    ? [
        '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
        '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
        'msedge',
      ]
    : [
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/microsoft-edge',
        '/opt/microsoft/msedge/msedge',
        'microsoft-edge-stable',
        'microsoft-edge',
      ];

  let launched = false;
  for (const edgePath of edgePaths) {
    try {
      console.log(`🔍 Пробуем путь: ${edgePath}`);
      const cmd = IS_WINDOWS
        ? `start "" ${edgePath} ${flags}`
        : `${edgePath} ${flags} > /dev/null 2>&1 &`;
      exec(cmd, { detached: true }, (err) => {
        if (err) console.warn(`⚠️ Не удалось запустить: ${err.message}`);
      });
      launched = true;
      break;
    } catch (e) {
      console.warn(`⚠️ Ошибка: ${e.message}`);
    }
  }

  if (!launched) {
    throw new Error('Не удалось найти Edge. Установите Microsoft Edge.');
  }

  console.log('⏳ Ожидание готовности браузера (60 сек)...');
  for (let i = 0; i < 60; i++) {
    if ((await isPortOpen(9223)) && (await isBrowserRunning(9223))) {
      console.log('✅ Браузер готов к подключению');
      await new Promise((r) => setTimeout(r, 2000)); // Даем время на стабилизацию
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('Таймаут запуска браузера.');
}

// 🔥 ЭКСПОРТ СОСТОЯНИЯ АВТОРИЗАЦИИ
async function exportAuthState(browser, filePath = STORAGE_STATE_PATH) {
  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      console.warn('⚠️ Нет активных контекстов для экспорта');
      return false;
    }
    const context = contexts[0];
    const state = await context.storageState({ path: filePath });
    console.log(`✅ Auth state экспортирован: ${filePath}`);
    return true;
  } catch (err) {
    console.error('❌ Ошибка экспорта auth state:', err.message);
    return false;
  }
}

// 🔥 ИМПОРТ СОСТОЯНИЯ АВТОРИЗАЦИИ
function loadAuthState(filePath = STORAGE_STATE_PATH) {
  try {
    if (fs.existsSync(filePath)) {
      const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`✅ Auth state загружен: ${filePath}`);
      return state;
    }
    return null;
  } catch (err) {
    console.error('❌ Ошибка загрузки auth state:', err.message);
    return null;
  }
}

// Скриншот для отладки
async function takeDebugScreenshot(page, userId, label) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(DEBUG_DIR, `${userId}_${label}_${timestamp}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`📸 Скриншот: ${filename}`);
  } catch (err) {
    console.error('❌ Ошибка скриншота:', err.message);
  }
}

module.exports = {
  launchBrowser,
  exportAuthState,
  loadAuthState,
  STORAGE_STATE_PATH,
  USER_DATA_DIR,
  MISTRAL_URL,
  ULTRAGPT_URL,
  DEBUG_DIR,
  takeDebugScreenshot,
  isPortOpen,
};
