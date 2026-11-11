'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const userScheduleConfigSchema = new Schema({
  userId:      { type: Types.ObjectId, ref: 'User', required: true, index: true },
  schemaName:  { type: String, required: true },
  workerField: { type: String, default: '' },
  workers: [{
    name:   { type: String, required: true },
    days:   { type: [Number], default: [0, 1, 2, 3, 4] }, // 0=Mon..6=Sun
    startH: { type: Number, default: 9 },
    endH:   { type: Number, default: 18 },
  }],
}, { timestamps: true });

userScheduleConfigSchema.index({ userId: 1, schemaName: 1 }, { unique: true });

module.exports = mongoose.model('UserScheduleConfig', userScheduleConfigSchema);
