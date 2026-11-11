const mongoose = require('mongoose');

// Диалог ChatGPT-подобного интерфейса /app. Один пользователь — много диалогов.
// История хранится отдельно (ConversationMessage). Генерация идёт через общий
// демо-путь AiService (context.customSystemPrompt + historyLines) — сам
// AI-пайплайн не затрагивается.
const ConversationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:     { type: String, default: 'Новый чат' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now, index: true },
});

ConversationSchema.index({ userId: 1, updatedAt: -1 });
module.exports = mongoose.model('Conversation', ConversationSchema);
