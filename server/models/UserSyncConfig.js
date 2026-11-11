const mongoose = require('mongoose');

const userSyncConfigSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    schemaName: { type: String, required: true },
    sourceType: { type: String, enum: ['google_sheets', 'external_db'], default: 'google_sheets' },
    enabled:   { type: Boolean, default: true },
    lastSyncAt:    Date,
    lastSyncCount: Number,

    // Направление синхронизации: только получаем или двустороннее
    direction: { type: String, enum: ['import', 'bidirectional'], default: 'import' },

    // google_sheets fields
    sourceUrl: String,
    sheetId:   String,
    sheetName: String,

    // external_db fields
    connectionString: String,
    dbType:    { type: String, enum: ['mongodb', 'postgresql'] },
    collection: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserSyncConfig', userSyncConfigSchema);
