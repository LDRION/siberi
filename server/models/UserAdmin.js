const mongoose = require('mongoose');

const UserAdminSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['creator', 'admin'], default: 'admin' },
  platform: { type: String, enum: ['telegram', 'vk', 'web', 'whatsapp', 'other'], required: true },
  platformUserId: { type: String, required: true },
  displayName: { type: String, default: '' },
  username: { type: String, default: '' }, // @username (для показа в mini-app)
  // «Полные права»: равносильно создателю (полный доступ к данным/ИИ), КРОМЕ
  // удаления бота. Без флага — ограниченный админ (уведомления, воронка,
  // подтверждение заказов, просмотр базы), но БЕЗ изменений через ИИ.
  fullRights: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

UserAdminSchema.index({ ownerId: 1, platform: 1, platformUserId: 1 }, { unique: true });
module.exports = mongoose.model('UserAdmin', UserAdminSchema);
