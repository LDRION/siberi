const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true, index: true },

  // 🔥 Привязка к пользователю
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // Профиль AI (если указан — использует конкретный профиль вместо активного)
  profileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserAiConfig',
    default: null,
  },

  // Запрос и контекст
  prompt: { type: String, required: true },      // полный промт (с историей диалога)
  rawPrompt: { type: String, default: null },    // исходное сообщение пользователя (без истории)
  context: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Статус выполнения
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'error'],
    default: 'pending',
    index: true,
  },

  // Результат
  result: String,
  partialResult: { type: String, default: null }, // text-only result, set before commands execute
  attachments: { type: [String], default: [] }, // base64 PNG (charts, images)
  error: String,

  // Полный, непарсенный ответ AI (с тегами BOT_SETTINGS/BOT_COMMANDS/DB_COMMAND
  // и т.п.) — result хранит только то, что видит пользователь, а это поле даёт
  // возможность разобрать, что именно сгенерировала модель, когда сгенерированный
  // бот ведёт себя не так, как должен (например, кнопка без обработчика).
  rawAiResponse: { type: String, default: null },

  // Конечный пользователь (клиент владельца бота, не сам владелец)
  endUser: {
    platform:       { type: String, enum: ['telegram', 'vk', 'max', 'web', 'api', 'other', 'demo', 'studio', 'notification', 'tgletbot_miniapp'], default: 'api' },
    platformUserId: { type: String, default: '' }, // chatId для Telegram, peerId для VK
    username:       { type: String, default: '' }, // @username (Telegram/VK)
    displayName:    { type: String, default: '' }, // Имя пользователя
    ip:             { type: String, default: '' },
  },

  // Bot Studio: override system prompt for configurator AI
  studioSystemPrompt: { type: String, default: null },

  // Тайминги
  processingTime: Number, // мс до первого текстового ответа (то, что видит пользователь)
  totalProcessingTime: Number, // мс до полного завершения (с командами)
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  textCompletedAt: Date, // когда текстовый ответ был готов
});

// Индекс для быстрого поиска pending задач
taskSchema.index({ status: 1, createdAt: 1 });
// Для аналитики по конкретному боту (воронка, активные пользователи за период)
taskSchema.index({ profileId: 1, createdAt: 1 });

// Новая задача будит воркер, готовый ответ — ждущие маршруты (helpers/taskEvents).
taskSchema.post('save', (doc) => {
  try { require('../helpers/taskEvents').taskEvents.emit('saved', doc); } catch { /* события не критичны */ }
});

module.exports = mongoose.model('Task', taskSchema);
