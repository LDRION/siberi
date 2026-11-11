const mongoose = require('mongoose');

// Сообщение внутри диалога /app. role: 'user' | 'ai'.
const ConversationMessageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role:           { type: String, enum: ['user', 'ai'], required: true },
  content:        { type: String, required: true },
  image:          { type: String, default: null },
  createdAt:      { type: Date, default: Date.now },
});

ConversationMessageSchema.index({ conversationId: 1, createdAt: 1 });
module.exports = mongoose.model('ConversationMessage', ConversationMessageSchema);
