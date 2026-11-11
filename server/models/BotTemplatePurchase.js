'use strict';
const mongoose = require('mongoose');

// Факт покупки макета покупателем. Отдельная коллекция — чтобы «мои покупки»
// и проверка владения были простыми и идемпотентными (по paymentId).
const botTemplatePurchaseSchema = new mongoose.Schema({
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotTemplate', required: true, index: true },
  code:       { type: String, required: true },
  buyerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount:     { type: Number, default: 0 },       // сколько заплатил покупатель, ₽
  authorPayout: { type: Number, default: 0 },     // сколько начислено автору (70%)
  paymentId:  { type: String, index: true },      // operation_id провайдера (идемпотентность)
  createdAt:  { type: Date, default: Date.now },
});

botTemplatePurchaseSchema.index({ buyerId: 1, templateId: 1 });

module.exports = mongoose.model('BotTemplatePurchase', botTemplatePurchaseSchema);
