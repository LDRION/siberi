'use strict';
const mongoose = require('mongoose');

// Макет бота на продажу в маркетплейсе. Хранит СТРУКТУРУ бота (botSettings +
// промпт + определения схем), но НЕ пользовательские данные/записи. Покупатель
// применяет макет к своему боту (см. templates/apply), схемы создаются пустыми.
const botTemplateSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, index: true }, // делимый код, напр. SHOP-A7F3
  authorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  category:    { type: String, default: 'other' }, // ecommerce | restaurant | booking | other
  price:       { type: Number, default: 0 },       // ₽; 0 = бесплатно
  status:      { type: String, enum: ['pending', 'approved', 'rejected', 'delisted'], default: 'pending', index: true },
  moderationNote: { type: String, default: '' },

  // Снимок макета (структура/поведение)
  aiName:       { type: String, default: '' },
  systemPrompt: { type: String, default: '' },
  botSettings:  { type: mongoose.Schema.Types.Mixed, default: {} },
  // Определения схем данных (name/label/fields) — без записей.
  schemas:      { type: mongoose.Schema.Types.Mixed, default: [] },

  sales:       { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('BotTemplate', botTemplateSchema);
