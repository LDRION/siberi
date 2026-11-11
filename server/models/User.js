const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: { type: String, required: true },

  // OAuth provider IDs
  telegramId: { type: String, unique: true, sparse: true },
  // @username в Telegram (обновляется при общении с конструктором) — нужен, чтобы
  // владелец мог добавить этого человека в админы по @username в mini-app.
  telegramUsername: { type: String, default: '' },
  googleId:   { type: String, unique: true, sparse: true },
  yandexId:   { type: String, unique: true, sparse: true },
  vkId:       { type: String, unique: true, sparse: true },

  // Display name (from OAuth providers; email users don't set this)
  displayName: { type: String, default: '' },

  // Phone (from OAuth providers that don't expose email)
  phone: { type: String, default: null, unique: true, sparse: true },

  // API доступ
  apiKey: {
    type: String,
    default: () => uuidv4(),
    unique: true,
    index: true,
  },

  // 🔥 Триал и подписка
  trialStart: { type: Date },
  // Длительность триала в днях. Сайт — 7; AiConstructor (@AI_ConstructorBot) — 1
  // сутки + 6 дней за подписку на @aicupdates (см. routes/tgletbot.js TRIAL_DAYS).
  trialDurationDays: { type: Number, default: 7 },
  // Бонус +6 дней за подписку на @aicupdates выдаётся ОДИН раз на аккаунт —
  // после этого отписка/переподписка бонус не возвращает.
  channelBonusClaimed: { type: Boolean, default: false },
  subscriptionStatus: {
    type: String,
    enum: ['trial', 'active', 'expired', 'cancelled'],
    default: 'trial',
  },
  subscriptionEnd: Date,

  // Тарифный план
  // tgletbot / tgpremium — тарифы AiConstructor (@AI_ConstructorBot):
  // Standard 1000₽/мес и Premium 2000₽/мес (приоритетная очередь и скорость AI)
  plan: {
    type: String,
    enum: ['standard', 'pro', 'premium', 'family', 'tgletbot', 'tgpremium'],
    default: 'pro',
  },

  // Счётчик промптов (для ограничения триала)
  promptsUsed: { type: Number, default: 0 },

  // Дневной лимит чата /app для пользователей БЕЗ активного платного тарифа
  // (10 запросов/сутки; сбрасывается по chatDayResetAt).
  chatDayCount:   { type: Number, default: 0 },
  chatDayResetAt: { type: Date },

  // ID активного профиля AI
  activeProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserAiConfig', default: null },

  // Бонус от реферальной программы (ожидает активации после истечения текущей подписки)
  pendingBonus: {
    plan:      { type: String, enum: ['standard', 'pro', 'premium'] },
    days:      Number,
    grantedAt: Date,
  },

  // Платёжная информация (последний платёж — для обратной совместимости)
  paymentProvider: String,
  paymentId: String,

  // ── Полная история платежей ──────────────────────────────────
  paymentHistory: [{
    provider:        { type: String },            // 'yoomoney', 'manual', etc
    paymentId:       { type: String },            // operation_id от провайдера
    plan:            { type: String },            // 'standard' | 'pro' | 'premium'
    durationDays:    { type: Number },
    amount:          { type: Number },            // сумма в рублях
    currency:        { type: String, default: 'RUB' },
    label:           { type: String },            // raw label из платёжки
    paidAt:          { type: Date },              // точное время платежа (от провайдера)
    activatedAt:     { type: Date, default: Date.now }, // когда сервер обработал
    subscriptionEnd: { type: Date },              // до какого числа продлено
    refunded:        { type: Boolean, default: false }, // возвращён (доступ отозван) — идемпотентность
    refundedAt:      { type: Date },
  }],

  // Настройки пользователя
  // Автопродление (рекуррентные платежи). ТОЛЬКО по явному действию пользователя:
  // Оферта п. 8.1 и Политика рекуррентных платежей п. 2.1 прямо запрещают включать
  // его по умолчанию. Поэтому default: false и везде проверяем === true (а не !== false).
  autoRenew:    { type: Boolean, default: false },

  // ── Рекуррентные платежи (Т-Касса) ──────────────────────────────────────
  // RebillId приходит в нотификации РОДИТЕЛЬСКОГО платежа (Init с Recurrent:'Y')
  // и позволяет списывать с привязанной карты без участия пользователя.
  // CustomerKey — наш идентификатор покупателя на стороне Т-Кассы (= userId).
  tbankRebillId:     { type: String, default: null },
  tbankCustomerKey:  { type: String, default: null },
  // Какие уведомления о конце подписки уже отправлены (за неделю, за сутки,
  // в момент окончания) — чтобы не слать повторно на каждом тике планировщика.
  // `for` — на какой именно subscriptionEnd эти отметки: после продления дата
  // меняется, отметки автоматически считаются устаревшими и цикл идёт заново.
  subEndNotify: {
    for:   { type: Date, default: null },
    week:  { type: Boolean, default: false },
    day:   { type: Boolean, default: false },
    ended: { type: Boolean, default: false },
  },
  // Диагностика неудачных автосписаний (нет денег, карта истекла и т.п.).
  autoRenewFailCount: { type: Number, default: 0 },
  autoRenewLastError: { type: String, default: null },
  autoRenewLastTryAt: { type: Date, default: null },
  hintsEnabled: { type: Boolean, default: true },

  // Биллинг (пока безлимит, но структура на будущее)
  credits: { type: Number, default: Infinity },

  // Реферальная программа
  referredBy: { type: String, default: null }, // referralCode партнёра

  // Email verification
  emailVerified: { type: Boolean, default: false },
  emailVerifyToken: { type: String, default: null },
  emailVerifyExpires: { type: Date, default: null },

  // Password reset
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },

  // Site administration
  isSiteAdmin: { type: Boolean, default: false },
  blocked: {
    isBlocked:    { type: Boolean, default: false },
    reason:       { type: String, default: '' },
    blockedAt:    { type: Date, default: null },
    blockedUntil: { type: Date, default: null }, // null = permanent
    blockedIps:   [{ type: String }],
  },

  createdAt: { type: Date, default: Date.now },
  lastActiveAt: Date,
});

// 🔥 Метод проверки доступа
// Есть ли активный ПЛАТНЫЙ тариф (триал больше не даёт доступа — «ничего бесплатно»).
// Всё, кроме чата /app (с дневным лимитом), требует именно этого.
userSchema.methods.hasPaidPlan = function () {
  return this.subscriptionStatus === 'active' && this.subscriptionEnd && this.subscriptionEnd > new Date();
};

userSchema.methods.isAccessActive = function () {
  const now = new Date();

  // Активная платная подписка
  if (this.subscriptionStatus === 'active' && this.subscriptionEnd > now) {
    return true;
  }

  // Триал: 7 дней с момента регистрации (см. trialDurationDays), без лимита промптов
  if (this.subscriptionStatus === 'trial' && this.trialStart) {
    const trialEnd = new Date(this.trialStart.getTime() + (this.trialDurationDays || 7) * 24 * 60 * 60 * 1000);
    const withinTime = now < trialEnd;
    return withinTime;
  }

  return false;
};

// Заблокирован ли аккаунт платформенным админом (AiConstructor). Временная
// блокировка (blockedUntil в прошлом) считается снятой.
userSchema.methods.isBlocked = function () {
  if (!this.blocked || !this.blocked.isBlocked) return false;
  if (this.blocked.blockedUntil && new Date(this.blocked.blockedUntil) < new Date()) return false;
  return true;
};

// Лимиты по тарифу
userSchema.methods.getPlanLimits = function () {
  // Во время триала — Premium-уровень доступа
  const isTrial = this.subscriptionStatus === 'trial' && this.isAccessActive();
  const plan = isTrial ? 'premium_trial' : (this.plan || 'standard');

  const limits = {
    standard:      { profiles: 1, integrations: 1, label: 'Standard' },
    pro:           { profiles: 3, integrations: Infinity, label: 'Pro' },
    family:        { profiles: 3, integrations: Infinity, label: 'Family' },
    premium:       { profiles: 3, integrations: Infinity, label: 'Premium' },
    premium_trial: { profiles: 3, integrations: Infinity, label: 'Пробный период' },
    tgletbot:      { profiles: 1, integrations: 1, label: 'Standard' },
    tgpremium:     { profiles: 1, integrations: 1, label: 'Premium' },
  };
  return limits[plan] || limits.standard;
};

// Экспорт полного кода бота из Bot Studio — только реально оплаченные Pro/Premium.
// Триал даёт Premium-уровень доступа ко всему ОСТАЛЬНОМУ в платформе (см. getPlanLimits),
// но эту конкретную фичу триал и Standard не получают — только активная платная подписка.
userSchema.methods.canExportBotCode = function () {
  return (this.plan === 'pro' || this.plan === 'premium' || this.plan === 'family') && this.subscriptionStatus === 'active';
};

// Флаги авто-детекции интеграций
userSchema.add({
  apiIntegrationActive:    { type: Boolean, default: false },
  widgetIntegrationActive: { type: Boolean, default: false },
});

// Метод для активации подписки
userSchema.methods.activateSubscription = function ({
  provider, paymentId, durationDays = 30, plan,
  amount = 0, currency = 'RUB', label = '', paidAt = null,
}) {
  const PLAN_LEVEL = { standard: 1, pro: 2, premium: 3, tgletbot: 1, tgpremium: 2 };
  const incomingLevel = PLAN_LEVEL[plan] || 1;
  const currentLevel  = PLAN_LEVEL[this.plan] || 1;

  const now = Date.now();
  const hasActive = this.subscriptionStatus === 'active' && this.subscriptionEnd && this.subscriptionEnd > now;

  if (hasActive && incomingLevel < currentLevel) {
    // Downgrade — don't activate immediately; queue for after current period
    return;
  }

  // Extend from remaining time if active, otherwise start now
  const base = hasActive ? this.subscriptionEnd.getTime() : now;
  this.subscriptionStatus = 'active';
  this.subscriptionEnd    = new Date(base + durationDays * 24 * 60 * 60 * 1000);
  this.paymentProvider = provider;
  this.paymentId = paymentId;
  if (plan) this.plan = plan;

  // ── Фиксируем в истории платежей ──────────────────────────────
  if (!this.paymentHistory) this.paymentHistory = [];
  this.paymentHistory.push({
    provider,
    paymentId,
    plan: plan || this.plan,
    durationDays,
    amount,
    currency,
    label,
    paidAt:          paidAt ? new Date(paidAt) : new Date(now),
    activatedAt:     new Date(now),
    subscriptionEnd: this.subscriptionEnd,
  });
};

// Индексы под метрики платформы (active_users / new_users по периодам).
userSchema.index({ lastActiveAt: -1 });
userSchema.index({ createdAt: -1 });

module.exports = mongoose.model('User', userSchema);
