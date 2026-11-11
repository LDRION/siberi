const mongoose = require('mongoose');

// Снапшот записи ДО изменения, сделанного AI по запросу конечного пользователя
// Используется для отката данных к предыдущему состоянию
const schema = new mongoose.Schema({
  taskId:     { type: String, required: true, index: true },    // ID задачи, вызвавшей изменение
  ownerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recordId:   { type: mongoose.Schema.Types.ObjectId, required: true }, // _id записи
  schemaName: { type: String, required: true },
  operation:  { type: String, enum: ['create', 'update', 'delete'], required: true },
  // Для update/delete: полный документ ДО изменения (для точного восстановления)
  // Для create: null
  fullDocBefore: { type: mongoose.Schema.Types.Mixed, default: null },
  // Для create: _id созданного документа (чтобы знать что удалить при откате)
  // Для update/delete: null (уже есть в fullDocBefore._id)
  createdRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt:  { type: Date, default: Date.now },
});

schema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('UserRecordSnapshot', schema);
