'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const notificationRuleSchema = new Schema({
  userId:    { type: Types.ObjectId, ref: 'User',         required: true, index: true },
  profileId: { type: Types.ObjectId, ref: 'UserAiConfig', required: true },

  name:    { type: String, default: 'Новое правило' },
  enabled: { type: Boolean, default: true },

  // Кому отправлять
  recipientType: {
    type: String,
    enum: ['specific_id', 'user_field'],
    default: 'specific_id',
  },
  recipientChatId:      String,   // legacy single recipient
  recipients:           [String], // multiple recipients (specific_id): @username or numeric chatId
  recipientChatIdField: { type: String, default: '_tg_chat_id' }, // for user_field: record field name

  // Когда срабатывать
  // Polling-based: new_record, time_before, daily_report (проверяют раз в 60с)
  // Event-driven:  record_created, record_updated, record_deleted, schema_created, any_change (мгновенно)
  triggerType: {
    type: String,
    enum: [
      'new_record',       // polling: новые записи за последние 60с
      'time_before',      // polling: за N минут до события в поле dateField
      'daily_report',     // polling: раз в день в reportHour
      'record_created',   // event: при создании записи (мгновенно)
      'record_updated',   // event: при изменении записи (мгновенно)
      'record_deleted',   // event: при удалении записи (мгновенно)
      'schema_created',   // event: при создании новой схемы данных (мгновенно)
      'any_change',       // event: при любом изменении — создание/обновление/удаление (мгновенно)
    ],
    default: 'new_record',
  },
  schemaName: String,

  // time_before fields
  dateField:     { type: String, default: 'date' },
  minutesBefore: { type: Number, default: 120 },

  // daily_report — reportHour трактуется в ЛОКАЛЬНОМ времени владельца бота
  // (tzOffset — смещение от UTC в часах; по умолчанию МСК +3). Планировщик
  // считает UTC-час срабатывания как (reportHour - tzOffset).
  reportHour: { type: Number, default: 9, min: 0, max: 23 },
  // Минута срабатывания внутри reportHour. Для ботов по умолчанию 23:50 — чтобы
  // отчёт «Воронка продаж» захватывал ПОЧТИ ВЕСЬ прошедший день (с 00:00), а не
  // стрелял в 00:00, когда новый день пуст и все цифры по нулям.
  reportMinute: { type: Number, default: 0, min: 0, max: 59 },
  tzOffset:   { type: Number, default: 3, min: -12, max: 14 },

  // Промпт для AI (что сгенерировать)
  messagePrompt: { type: String, default: '' },

  // Отслеживание отправленных
  lastRunAt:    Date,
  sentRecordIds: [{ type: Types.ObjectId }],

}, { timestamps: true });

notificationRuleSchema.index({ userId: 1, enabled: 1 });

module.exports = mongoose.model('NotificationRule', notificationRuleSchema);
