'use strict';
const mongoose = require('mongoose');

// Снимок «макета» бота — его структуры и поведения (не данных).
// Позволяет сохранить текущий бот и вернуться к нему (в т.ч. после покупки
// чужого макета или сборки заново). Данные (схемы/записи) не трогаются.
const botSnapshotSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserAiConfig' },
  name:      { type: String, default: 'Макет' },
  source:    { type: String, enum: ['manual', 'auto', 'purchase'], default: 'manual' },
  // Снимок конфигурации бота
  aiName:       { type: String, default: '' },
  systemPrompt: { type: String, default: '' },
  botSettings:  { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt:    { type: Date, default: Date.now },
});

botSnapshotSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('BotSnapshot', botSnapshotSchema);
