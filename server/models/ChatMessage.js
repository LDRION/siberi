const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['user', 'ai'], required: true },
  content: { type: String, required: true },
  image: { type: String, default: null },
  attachments: { type: [String], default: [] },
  taskId: { type: String, index: true },
  createdAt: { type: Date, default: Date.now },
});

ChatMessageSchema.index({ userId: 1, createdAt: 1 });
module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
