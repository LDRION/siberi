#!/bin/bash
# ══════════════════════════════════════════════════════
#   SIBERI.AI — Первоначальная настройка VPS
#   Протестировано на Ubuntu 22.04 LTS
#   Запуск: sudo bash deploy/setup.sh
# ══════════════════════════════════════════════════════
set -e

DOMAIN="YOURDOMAIN.COM"        # <- Замените
PROJECT_DIR="/var/www/siberi"
REPO_URL="https://github.com/YOURUSER/YOURREPO.git"  # <- Замените

echo "🚀 Настройка сервера Siberi.AI..."

# ── 1. Обновление системы ─────────────────────────────
echo "📦 Обновление пакетов..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Node.js 20 ─────────────────────────────────────
echo "📦 Установка Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
apt-get install -y nodejs

# ── 3. PM2 ────────────────────────────────────────────
echo "📦 Установка PM2..."
npm install -g pm2 > /dev/null

# ── 4. nginx ──────────────────────────────────────────
echo "📦 Установка nginx..."
apt-get install -y nginx

# ── 5. MongoDB 7 ──────────────────────────────────────
echo "📦 Установка MongoDB..."
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
    gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
    https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
    tee /etc/apt/sources.list.d/mongodb-org-7.0.list > /dev/null
apt-get update -qq && apt-get install -y mongodb-org
systemctl start mongod && systemctl enable mongod

# ── 6. Microsoft Edge (для Playwright + Mistral) ──────
echo "📦 Установка Microsoft Edge..."
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | \
    gpg --dearmor -o /usr/share/keyrings/microsoft-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] \
    https://packages.microsoft.com/repos/edge stable main" | \
    tee /etc/apt/sources.list.d/microsoft-edge.list > /dev/null
apt-get update -qq && apt-get install -y microsoft-edge-stable

# ── 7. Зависимости Playwright ─────────────────────────
echo "📦 Зависимости Playwright..."
apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2

# Виртуальный дисплей (нужен если Edge запускается не в headless)
apt-get install -y xvfb

# ── 8. Certbot (SSL) ──────────────────────────────────
echo "📦 Установка certbot..."
apt-get install -y certbot python3-certbot-nginx

# ── 9. Структура проекта ──────────────────────────────
echo "📁 Создание директорий..."
mkdir -p $PROJECT_DIR
mkdir -p /var/log/pm2

# ── 10. Клонирование репозитория ──────────────────────
echo "📥 Клонирование кода..."
if [ -d "$PROJECT_DIR/.git" ]; then
    echo "Репозиторий уже существует, пропускаем clone"
else
    git clone $REPO_URL $PROJECT_DIR
fi

# ── 11. Зависимости Node.js ───────────────────────────
echo "📦 npm install..."
cd $PROJECT_DIR/server && npm install --production
cd $PROJECT_DIR/client && npm install

# ── 12. .env (продакшен) ──────────────────────────────
if [ ! -f "$PROJECT_DIR/.env" ]; then
    cp $PROJECT_DIR/.env.production.example $PROJECT_DIR/.env
    echo ""
    echo "⚠️  ВАЖНО: Заполните $PROJECT_DIR/.env реальными значениями!"
    echo "    nano $PROJECT_DIR/.env"
    echo ""
fi

# ── 13. Сборка клиента ────────────────────────────────
echo "🔨 Сборка React-приложения..."
cd $PROJECT_DIR/client
if [ ! -f ".env.production" ]; then
    echo "VITE_API_URL=https://$DOMAIN/api/v1" > .env.production
fi
npm run build

# ── 14. nginx конфиг ──────────────────────────────────
echo "⚙️  Настройка nginx..."
sed "s/YOURDOMAIN.COM/$DOMAIN/g" $PROJECT_DIR/deploy/nginx.conf > \
    /etc/nginx/sites-available/siberi
ln -sf /etc/nginx/sites-available/siberi /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 15. SSL сертификат ────────────────────────────────
echo "🔐 Получение SSL сертификата..."
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos \
    --email admin@$DOMAIN --redirect || \
    echo "⚠️  Certbot не удался. Запустите вручную: certbot --nginx -d $DOMAIN"

# ── 16. PM2 автозапуск ────────────────────────────────
echo "⚙️  PM2 автозапуск..."
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

# ── 17. Запуск приложения ─────────────────────────────
echo "▶️  Запуск Siberi.AI..."
cd $PROJECT_DIR
pm2 start deploy/ecosystem.config.js --env production
pm2 save

echo ""
echo "════════════════════════════════════════"
echo "✅ Siberi.AI успешно установлен!"
echo ""
echo "📌 Следующие шаги:"
echo "   1. Заполните .env: nano $PROJECT_DIR/.env"
echo "   2. Перезапустите: pm2 restart siberi-api"
echo "   3. Настройте Mistral-авторизацию через браузер"
echo "   4. Проверьте: https://$DOMAIN"
echo ""
echo "📊 Статус: pm2 status"
echo "📋 Логи:   pm2 logs siberi-api"
echo "════════════════════════════════════════"
