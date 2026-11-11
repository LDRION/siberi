const mongoose = require('mongoose');

const recordSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    schemaName: {
      type: String,
      required: true,
      index: true,
    }, // ссылка на UserSchema.name
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    }, // 🔥 ГИБКОЕ ПОЛЕ: любые данные по схеме
    metadata: {
      createdBy: { type: String, enum: ['user', 'ai'], default: 'user' },
      lastModifiedBy: { type: String, enum: ['user', 'ai'] },
      source: { type: String, enum: ['web', 'telegram', 'api', 'ai', 'file_import', 'google_sync', 'niche_template'] },
      sourceUrl: { type: String },
      syncedAt: { type: Date },
      importedAt: { type: Date },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// 🔥 Индекс для быстрого поиска: пользователь + схема + фильтрация
recordSchema.index({ userId: 1, schemaName: 1 });

// 🔥 Индекс для полнотекстового поиска по всем данным (опционально)
recordSchema.index({ data: 'text' });

// 🔥 Индекс для поиска по дате (если в data есть поле date)
recordSchema.index({ 'data.date': 1 });

// 🔥 Виртуальное: ссылка на схему (для удобства)
recordSchema.virtual('linkedSchema', {
  ref: 'UserSchema',
  localField: ['userId', 'schemaName'],
  foreignField: ['userId', 'name'],
  justOne: true,
});

// 🔥 Метод: получить текстовое представление записи для AI-контекста
recordSchema.methods.toAIText = function (schema) {
  if (!schema || !schema.fields) return JSON.stringify(this.data);

  const parts = [];
  for (const field of schema.fields) {
    const value = this.data[field.name];
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${field.label}: ${value}`);
    }
  }
  return parts.length > 0 ? parts.join(' | ') : '(пустая запись)';
};

// 🔥 Статический метод: получить последние записи для контекста
recordSchema.statics.getRecentForAI = async function (userId, schemaName, limit = 20) {
  const records = await this.find({ userId, schemaName })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return records.map((r) => r.data);
};

module.exports = mongoose.model('UserRecord', recordSchema);
