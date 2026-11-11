const mongoose = require('mongoose');

const demoVisitorSchema = new mongoose.Schema({
  visitorId:      { type: String, required: true, unique: true, index: true },
  messageCount:   { type: Number, default: 0 },
  firstMessageAt: Date,
  lastMessageAt:  Date,
  resetAt:        Date, // 24h after firstMessageAt
}, { timestamps: true });

module.exports = mongoose.model('DemoVisitor', demoVisitorSchema);
