const mongoose = require('mongoose');

// 🔥 Описание одного поля в схеме пользователя
const fieldSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_]+$/i, // только латиница, цифры, подчёркивание (для JSON-ключей)
      maxlength: 50,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    }, // "Имя клиента" — для отображения в UI
    type: {
      type: String,
      enum: ['text', 'number', 'date', 'boolean', 'url', 'image', 'file', 'enum'],
      default: 'text',
    },
    required: { type: Boolean, default: false },
    defaultValue: { type: mongoose.Schema.Types.Mixed },
    description: { type: String, maxlength: 500 }, // подсказка для AI и пользователя
    options: { type: [String] }, // для типа 'enum': ['маникюр', 'педикюр', 'наращивание']
  },
  { _id: false }
);

// 🔥 Основная схема: описывает "таблицу" пользователя
const schemaSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_]+$/i,
      maxlength: 50,
    }, // "schedule", "services", "clients" — ключ для AI
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    }, // "Расписание", "Услуги" — для UI
    description: {
      type: String,
      maxlength: 500,
    }, // описание для контекста нейросети
    fields: [fieldSchema], // массив полей
    isActive: { type: Boolean, default: true },
    // Profile assignment: empty = common (all profiles), non-empty = only these profiles
    profileIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'UserAiConfig' }],
    // 🔥 Мета для удобства
    icon: { type: String, default: '📋' }, // эмодзи для UI
    color: { type: String, default: '#3b82f6' }, // цвет для UI
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// 🔥 Составной индекс: один пользователь не может иметь две схемы с одинаковым name
schemaSchema.index({ userId: 1, name: 1 }, { unique: true });

// 🔥 Виртуальное поле: генерируем текстовое описание для AI-контекста
schemaSchema.virtual('aiContext').get(function () {
  if (!this.fields || this.fields.length === 0) return `${this.label}: (нет полей)`;

  const fieldsDesc = this.fields
    .map((f) => {
      const typeDesc =
        f.options && f.options.length > 0 ? `${f.type} (${f.options.join(', ')})` : f.type;
      return `- ${f.name} (${typeDesc}): ${f.description || f.label}`;
    })
    .join('\n');

  return `${this.label}: ${this.description || 'Данные пользователя'}\nПоля:\n${fieldsDesc}`.trim();
});

// 🔥 Метод для валидации данных перед сохранением
schemaSchema.methods.validateData = function (data) {
  const errors = [];

  for (const field of this.fields) {
    const value = data[field.name];

    // Проверка required
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`Поле "${field.label}" обязательно`);
      continue;
    }

    // Пропускаем, если значение не указано и не required
    if (value === undefined || value === null || value === '') continue;

    // Проверка типов
    switch (field.type) {
      case 'number':
        if (typeof value !== 'number' && isNaN(Number(value))) {
          errors.push(`Поле "${field.label}" должно быть числом`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`Поле "${field.label}" должно быть да/нет`);
        }
        break;
      case 'date':
        if (isNaN(new Date(value).getTime())) {
          errors.push(`Поле "${field.label}" должно быть датой`);
        }
        break;
      case 'url':
        if (typeof value !== 'string' || !value.startsWith('http')) {
          errors.push(`Поле "${field.label}" должно быть URL`);
        }
        break;
      case 'image':
        // Allow http URLs or base64 data URIs
        if (typeof value !== 'string' || (!value.startsWith('http') && !value.startsWith('data:image/'))) {
          errors.push(`Поле "${field.label}" должно быть URL или изображением`);
        }
        break;
      case 'file':
        // Allow http URLs, base64 data URIs, or JSON metadata string
        if (typeof value !== 'string') {
          errors.push(`Поле "${field.label}" должно быть файлом`);
        }
        break;
      case 'enum':
        if (field.options && !field.options.includes(value)) {
          errors.push(`Поле "${field.label}" должно быть одним из: ${field.options.join(', ')}`);
        }
        break;
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

module.exports = mongoose.model('UserSchema', schemaSchema);
