const mongoose = require('mongoose');

// Отзывы/идеи пользователей воронки @AI_ConstructorBot. Пользователь жмёт
// «Оставить отзыв» на /start → пишет сообщение → оно падает сюда и уходит
// алертом всем платформенным админам. В /admin — листалка этих отзывов.
const BotFeedbackSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  telegramId:       { type: String, index: true },
  telegramUsername: { type: String, default: '' }, // без @
  displayName:      { type: String, default: '' },
  text:             { type: String, required: true },
  status:           { type: String, enum: ['new', 'read'], default: 'new', index: true },
  createdAt:        { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('BotFeedback', BotFeedbackSchema);
