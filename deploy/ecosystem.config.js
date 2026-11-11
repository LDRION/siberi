// PM2 конфигурация для Siberi.AI
// Использование: pm2 start deploy/ecosystem.config.js --env production

module.exports = {
  apps: [
    {
      name: 'siberi-api',
      script: 'server/index.js',
      cwd: '/var/www/siberi',

      // ВАЖНО: только 1 инстанс — Playwright-браузер stateful,
      // несколько воркеров создадут конфликт CDP-порта
      instances: 1,
      exec_mode: 'fork',

      // Автоматический перезапуск при крэше
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,

      // Перезапуск при утечке памяти (браузер может накапливать)
      max_memory_restart: '1500M',

      // Логи
      error_file: '/var/log/pm2/siberi-error.log',
      out_file:   '/var/log/pm2/siberi-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Не следить за изменениями файлов в проде
      watch: false,

      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
