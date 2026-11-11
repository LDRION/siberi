const mongoose = require('mongoose');

// Заблокированные конечные пользователи (не владельцы, а их клиенты)
const schema = new mongoose.Schema({
  platform:       { type: String, enum: ['telegram', 'vk', 'web', 'api', 'other'], required: true },
  platformUserId: { type: String, required: true }, // chatId для Telegram, peerId для VK
  blockedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isGlobal:       { type: Boolean, default: false }, // true = блокировка работает у всех наших пользователей
  reason:         { type: String, default: '' },
  blockedAt:      { type: Date, default: Date.now },
});

schema.index({ platform: 1, platformUserId: 1 });
schema.index({ blockedBy: 1 });
schema.index({ platform: 1, platformUserId: 1, isGlobal: 1 });

module.exports = mongoose.model('BlockedEndUser', schema);
