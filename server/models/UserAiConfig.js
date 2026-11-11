const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  profileName: {
    type: String,
    default: 'Основной профиль',
    maxlength: 60,
  },
  color: {
    type: String,
    default: null,
    maxlength: 20,
  },
  isDefault: { type: Boolean, default: false },
  aiName: {
    type: String,
    default: 'Помощник',
    maxlength: 50,
  },
  systemPrompt: {
    type: String,
    required: true,
    minlength: 20,
    // Студийный промт (STUDIO_SYSTEM_PROMPT — персона конструктора) легитимно
    // большой и растёт с каждым новым кирпичом; при превышении лимита save
    // студийного профиля падал → getOrCreateStudioProfile кидал → бот НЕ отвечал
    // на промты. Дан запас. Пользовательские боты (их персона) сильно меньше.
    maxlength: 120000,
  },
  // When true, AI-driven edits (Studio chat, TGLetBot builder) must never
  // overwrite systemPrompt/restrictions via BOT_SETTINGS — the owner has
  // chosen to manage these two fields only through the dedicated "Настройки
  // AI" menu. Everything else (commands, schemas, welcome message, etc.)
  // stays promptable regardless of this flag.
  promptEditLocked: { type: Boolean, default: false },
  restrictions: {
    type: String,
    default: '',
    maxlength: 10000,
  },
  mistralChatId: { type: String, default: null, index: true },
  qwenThreadDemoId: {
    type: String,
    default: 'ca1657da-2916-41f7-bbef-e7837ac7030e',
  },
  qwenThreadId: { type: String, default: null },
  // Was used throughout AiService.js (config.qwenStudioThreadId = ...; await
  // config.save()) but never declared here — Mongoose silently drops unknown
  // fields on save without strict:false, so this never actually persisted.
  // Every studio turn that fell back to Qwen was starting a brand new chat
  // thread from scratch instead of resuming the conversation.
  qwenStudioThreadId: { type: String, default: null },
  // Running AI-maintained memory of the build: confirmed decisions, open
  // suggestions not yet adopted, known gaps deliberately left as-is for now.
  // Injected into every studio turn's [ТЕКУЩИЙ КОНФИГ] so context survives
  // independently of raw chat history (which Mistral/Qwen chats get deleted
  // after each turn) — see STUDIO_SYSTEM_PROMPT's <BUILD_NOTES> tag.
  studioBuildNotes: { type: String, default: '', maxlength: 8000 },
  hasPersonalThread: { type: Boolean, default: false },
  temperature: {
    type: Number,
    default: 0.7,
    min: 0,
    max: 1,
  },
  integrations: {
    telegram: { type: Boolean, default: false },
    websiteWidget: { type: Boolean, default: false },
    api: { type: Boolean, default: false },
  },
  ownerCode: { type: String, default: null },
  adminCode: { type: String, default: null },
  totalRequests: { type: Number, default: 0 },
  lastUsed: Date,
  schemaVisibility: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Bot Studio settings (Telegram behaviour)
  botSettings: {
    triggerMode:     { type: String, enum: ['respond_all', 'mention_only'], default: 'respond_all' },
    triggerKeyword:  { type: String, default: '' },
    historyMode:     { type: String, enum: ['personal', 'shared'], default: 'personal' },
    // Кто может ОБЩАТЬСЯ с ИИ бота свободным текстом: all — все (по умолчанию),
    // admin — только админы/создатели, creator — только создатели. Для внутренних
    // ботов-аналитиков (данные бизнеса) — ставить 'admin'.
    aiAccessRole:    { type: String, enum: ['all', 'admin', 'creator'], default: 'all' },
    welcomeMessage:  { type: String, default: '' },
    commands: [{
      command:     { type: String }, // e.g. "/start" OR button text "💇 Записаться"
      description: { type: String, default: '' },
      response:    { type: String, default: '' },
      keyboard:    { type: mongoose.Schema.Types.Mixed, default: null }, // [[row1btn1, row1btn2], [row2btn1]]
      // Optional dynamic/extended behaviors — see studio.js's STUDIO_SYSTEM_PROMPT
      // for what each means. ⚠️ This array element is a STRICT sub-schema: any
      // field used elsewhere in the codebase that ISN'T declared here gets
      // SILENTLY stripped on every save, with no error anywhere — confirmed
      // live, this bit hard (queryMySchema/aiAction were being written, then
      // vanishing on the very next save). Add new BOT_COMMANDS fields HERE
      // the moment you introduce them anywhere else.
      aiAction:      { type: String, default: null },   // live AI turn instead of a static response
      minRole:       { type: String, default: null },    // 'admin' | 'creator' — null = everyone
      queryMySchema: { type: String, default: null },    // show only THIS chat's own records from this schema
      listSchema:    { type: String, default: null },    // show ALL records of this schema (public catalog/price list)
      listFields:    { type: mongoose.Schema.Types.Mixed, default: null }, // optional [fieldName,...] to display; null = auto
      listFilter:    { type: mongoose.Schema.Types.Mixed, default: null }, // optional {field:value} — show only matching (category filter)
      // Нативная корзина (детерминированная, без AI). addToCart на команде-каталоге
      // делает товары кнопками «в корзину»; showCart — команда просмотра корзины;
      // checkoutSchema — куда сохранять оформленный заказ.
      addToCart:     { type: Boolean, default: null },   // catalog items become add-to-cart buttons
      // productCard: товары каталога открываются КАРТОЧКОЙ (состав/цена/категория) с
      // кнопками добавок «−/+» и «В корзину» — вместо прямого добавления. Добавки
      // берутся из схемы product_extras по категории товара. Детерминированно, без AI.
      productCard:   { type: Boolean, default: null },
      showCart:      { type: Boolean, default: null },   // this command renders the cart
      checkoutSchema:{ type: String, default: null },    // schema to save the order into on checkout
      cartCurrency:  { type: String, default: null },    // '₽' | '₸' | ... (по умолчанию ₽)
      notifyOwner:   { type: String, default: null },    // при нажатии шлёт владельцу уведомление (текст = суть запроса клиента)
      paidAction:    { type: String, default: null },    // витрина оплаты: 'premium' (продать премиум-доступ) | 'products' (список платных товаров)
      bookingAction: { type: String, default: null },    // кирпич записи: 'services' (карточки услуг) | 'masters' (карточки мастеров) | 'book' (визард записи)
      emptyResponse: { type: String, default: null },    // shown when queryMySchema/listSchema finds nothing
      mediaSchema:   { type: String, default: null },
      mediaField:    { type: String, default: null },
      mediaCount:    { type: Number, default: null },
      mediaMode:     { type: String, default: null },    // 'random' | 'sequential'
      mediaType:     { type: String, default: null },    // 'file' (omit for image)
      // Marks this button as a conversion-funnel step for daily-report analytics
      // (see notificationProcessor.js computeDailyStats) — null = not tracked.
      funnelStep:    { type: String, enum: ['catalog', 'pricing', 'purchase', null], default: null },
    }],
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// 🔥 ИСПРАВЛЕНО: Обновляем updatedAt без pre-save хука (чтобы избежать "next is not a function")
configSchema.pre('save', function (next) {
  // 🔥 Проверяем, что next — это функция (защита от async-контекстов)
  if (typeof next === 'function') {
    this.updatedAt = Date.now();
    next();
  } else {
    // Если next не функция — просто обновляем поле
    this.updatedAt = Date.now();
  }
});

module.exports = mongoose.model('UserAiConfig', configSchema);
