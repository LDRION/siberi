const mongoose = require('mongoose');

const UserPermissionsSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  // Права обычных пользователей
  allowCreate: { type: Boolean, default: true },
  allowUpdate: { type: Boolean, default: false },
  allowDelete: { type: Boolean, default: false },
  allowSchemaCreate: { type: Boolean, default: false },
  // Права администраторов
  adminAllowCreate: { type: Boolean, default: true },
  adminAllowUpdate: { type: Boolean, default: true },
  adminAllowDelete: { type: Boolean, default: true },
  adminAllowSchemaCreate: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('UserPermissions', UserPermissionsSchema);
