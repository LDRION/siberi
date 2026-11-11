'use strict';
const mongoose = require('mongoose');

// Заявка с продающего лендинга («Сделаем за вас»). Публичная форма → сюда.
const leadSchema = new mongoose.Schema({
  name:      { type: String, trim: true, maxlength: 200 },
  contact:   { type: String, trim: true, maxlength: 300 },   // телефон / telegram / email
  niche:     { type: String, trim: true, maxlength: 200 },   // сфера бизнеса
  message:   { type: String, trim: true, maxlength: 3000 },
  source:    { type: String, default: 'landing', maxlength: 60 },
  status:    { type: String, enum: ['new', 'contacted', 'won', 'lost'], default: 'new' },
  ip:        { type: String, maxlength: 64 },
  userAgent: { type: String, maxlength: 300 },
}, { timestamps: true });

module.exports = mongoose.model('Lead', leadSchema);
