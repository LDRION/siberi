// Тарифы AiConstructor: два плана. Слаги, цены и скидки за срок должны
// совпадать с сервером (server/routes/tgletbot.js: TGLB_PLANS /
// TGLB_PERIOD_DISCOUNTS) — итоговую сумму в платёжке всё равно считает сервер,
// здесь цифры только для отображения.
export const plans = [
  {
    id: 'standard',
    name: 'Standard',
    price: 1000,
    features: [
      'Хостинг бота 24/7 — без своих серверов',
      'Все функции конструктора и AI-помощник',
      'База данных и интеграции',
      'Автоматические уведомления и отчёты',
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    price: 2000,
    popular: true,
    features: [
      'Всё из тарифа Standard',
      'Повышенная скорость отработки ИИ',
      'Приоритетная очередь при высокой нагрузке',
      'Приоритетная поддержка',
    ],
  },
]

// Сроки подписки со скидкой за длительность.
export const periods = [
  { id: 'm1', label: 'Месяц', months: 1, discount: 0 },
  { id: 'm6', label: '6 месяцев', months: 6, discount: 0.16 },
  { id: 'm12', label: '12 месяцев', months: 12, discount: 0.33 },
]

// Итоговая цена выбранного плана за выбранный срок (округление до 10 ₽ — как на сервере).
export function planTotal(planId, periodId) {
  const plan = plans.find((p) => p.id === planId)
  const period = periods.find((p) => p.id === periodId)
  if (!plan || !period) return 0
  const raw = plan.price * period.months * (1 - period.discount)
  return Math.round(raw / 10) * 10
}

// Партнёрская программа — параметры для отображения (правила живут на сервере:
// комиссия начисляется в routes/payment.js, вывод — /tgletbot/miniapp/referral/withdraw).
export const REF_PERCENT = 20
export const REF_MIN_PAYOUT = 1000
