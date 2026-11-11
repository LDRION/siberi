# AiConstructor Mini App (@AI_ConstructorBot)

Telegram Mini App конструктора ботов: аккаунт/подписка, управление ботом,
«Мои данные», настройки. Отдельная Vite-сборка, НЕ часть client/.

## Как устроено

- Отдаётся nginx'ом по `https://siberi.online/tg-app/` из `webapp/dist`
  (локации `^~ /tg-app/` в `/etc/nginx/sites-enabled/siberi`).
- API — те же `/api/v1/*` (nginx проксирует на Node): сессия и специфичные
  эндпоинты в `server/routes/tgletbot.js` (`/tgletbot/miniapp/*`), данные —
  общие `/data/*`, `/integrations/*`, `/analyze` + `/result`.
- Авторизация: Telegram `initData` → `POST /tgletbot/miniapp/session` →
  короткоживущий EmbedToken (Bearer).
- URL мини-аппа для кнопок бота: `TGLETBOT_MINIAPP_URL` в `server/.env`.

## Тарифы

Два тарифа (см. `src/plans.js`, сервер: `TGLB_PLANS` в `routes/tgletbot.js`):
Standard 1000₽/мес (слаг `tgletbot`) и Premium 2000₽/мес (слаг `tgpremium` —
повышенная скорость ИИ, приоритетная очередь). Скидки: 6 мес −16%, 12 мес −33%.
Слаги и скидки на клиенте и сервере обязаны совпадать.

## Деплой

```bash
cd /var/www/siberi/webapp
npm run build          # соберёт в dist/ — nginx отдаёт его напрямую
```

Рестарт nginx не нужен (меняются только файлы). Если менялись серверные
роуты — `pm2 restart siberi-api --update-env`.
