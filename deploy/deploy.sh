#!/bin/bash
# ══════════════════════════════════════════
#   SIBERI.AI — Скрипт обновления (деплой)
#   Запуск: bash deploy/deploy.sh
# ══════════════════════════════════════════
set -e

PROJECT_DIR="/var/www/siberi"

echo "🚀 Обновление Siberi.AI..."
cd $PROJECT_DIR

# ── 1. Забираем изменения ─────────────────
echo "📥 git pull..."
git pull origin main

# ── 2. Зависимости сервера ────────────────
echo "📦 npm install (server)..."
cd server && npm install --production && cd ..

# ── 3. Сборка клиента ─────────────────────
echo "🔨 Сборка клиента..."
cd client && npm install && npm run build && cd ..

# ── 4. Перезапуск сервера ─────────────────
echo "🔄 Перезапуск PM2..."
pm2 restart siberi-api || pm2 start deploy/ecosystem.config.js --env production
pm2 save

# ── 5. Перезагрузка nginx (на случай смены конфига) ──
nginx -t && systemctl reload nginx

echo ""
echo "✅ Деплой завершён!"
pm2 status siberi-api
