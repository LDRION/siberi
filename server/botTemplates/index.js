'use strict';
// ── Эталонные макеты ботов ─────────────────────────────────────────────────
// Полноценные РАБОЧИЕ скелеты на нативных примитивах платформы (listSchema,
// addToCart, showCart/checkoutSchema, queryMySchema, сценарии записи, роли).
// При сборке бота с нуля подходящий макет инъектируется в контекст Mistral как
// образец: модель берёт готовую рабочую структуру и полирует её под запрос
// пользователя (тексты, товары, названия), НЕ ломая механику.
//
// Как добавить новый макет: добавь объект в TEMPLATES ниже (id, name, keywords,
// blueprint). blueprint — человекочитаемый эталон в ФОРМАТЕ ВЫВОДА модели
// (WELCOME_MESSAGE + BOT_COMMANDS(JSON) + DB_COMMAND схемы/примеры).

const ECOMMERCE = `ЭТАЛОН: ИНТЕРНЕТ-МАГАЗИН С КОРЗИНОЙ
Схемы данных (DB_COMMAND create_schema):
• products — товары: name(text*), description(text), price(number*), category(text), stock(number). Это СПРАВОЧНАЯ схема → добавь 2 примера-товара.
• orders — заказы: items(text), total(number), status(text). ПЕРСОНАЛЬНАЯ → БЕЗ примеров.

Приветствие (WELCOME_MESSAGE), HTML:
<b>🛍 Добро пожаловать в &lt;Название магазина&gt;!</b>
Каталог, корзина и быстрое оформление — всё в пару касаний.
Выберите раздел:

Команды (BOT_COMMANDS) — механика корзины НАТИВНАЯ (сервер, без aiAction):
[
 {"command":"/start","response":"<b>🛍 &lt;Магазин&gt;</b>\\nВыберите раздел:","keyboard":[["🛍 Каталог","🛒 Корзина"],["📦 Мои заказы"],["ℹ️ О нас","📞 Контакты"]]},
 {"command":"🛍 Каталог","description":"Товары","response":"<b>🛍 Наш каталог:</b>","listSchema":"products","addToCart":true,"cartCurrency":"₽","keyboard":[["🛒 Корзина"],["Назад"]]},
 {"command":"🛒 Корзина","description":"Ваша корзина","showCart":true,"checkoutSchema":"orders","cartCurrency":"₽","keyboard":[["🛍 Каталог"],["Назад"]]},
 {"command":"📦 Мои заказы","description":"История заказов","queryMySchema":"orders","emptyResponse":"У вас пока нет заказов.","keyboard":[["Назад"]]},
 {"command":"ℹ️ О нас","response":"<b>О нас</b>\\n&lt;коротко о магазине&gt;","keyboard":[["Назад"]]},
 {"command":"📞 Контакты","response":"<b>Контакты</b>\\nТелефон: +79000000000\\nРаботаем ежедневно 9:00–21:00.","keyboard":[["Назад"]]},
 {"command":"📊 Аналитика","minRole":"admin","aiAction":"Проанализируй схему orders: выручка и число заказов за последние 7 дней, построй график и кратко опиши тренд.","keyboard":[["Назад"]]},
 {"command":"Назад","response":"<b>🛍 &lt;Магазин&gt;</b>\\nВыберите раздел:","keyboard":[["🛍 Каталог","🛒 Корзина"],["📦 Мои заказы"],["ℹ️ О нас","📞 Контакты"]]}
]
Правила: товары НИКОГДА не перечисляй командами — только listSchema+addToCart. Корзина/итог/оформление — сервер. Телефон — в кликабельном формате.`;

const RESTAURANT = `ЭТАЛОН: РЕСТОРАН/КОФЕЙНЯ С ДОСТАВКОЙ И БРОНИРОВАНИЕМ
Схемы (DB_COMMAND create_schema):
• menu — блюда: name(text*), description(text), price(number*), category(text). СПРАВОЧНАЯ → 2 примера.
• orders — заказы: items(text), total(number), address(text), phone(text). ПЕРСОНАЛЬНАЯ → без примеров.
• bookings — брони столиков: date(date*), guests(number), phone(text*), comment(text). ПЕРСОНАЛЬНАЯ → без примеров.

Приветствие (HTML):
<b>☕ Добро пожаловать в &lt;Заведение&gt;!</b>
Закажите с доставкой или забронируйте столик. Быстро и вкусно!
Что вас интересует?

Команды (BOT_COMMANDS):
[
 {"command":"/start","response":"<b>☕ &lt;Заведение&gt;</b>\\nЧто вас интересует?","keyboard":[["🍽 Меню","🛒 Корзина"],["🪑 Забронировать столик","📋 Мои заказы"],["🚚 Доставка","📞 Контакты"]]},
 {"command":"🍽 Меню","description":"Меню","response":"<b>🍽 Наше меню:</b>","listSchema":"menu","addToCart":true,"cartCurrency":"₽","keyboard":[["🛒 Корзина"],["Назад"]]},
 {"command":"🛒 Корзина","description":"Корзина и заказ","showCart":true,"checkoutSchema":"orders","cartCurrency":"₽","keyboard":[["🍽 Меню"],["Назад"]]},
 {"command":"🪑 Забронировать столик","description":"Бронь","response":"<b>🪑 Бронирование столика</b>\\nНапишите желаемые дату и время, число гостей и телефон — я забронирую.","keyboard":[["Назад"]]},
 {"command":"🚚 Доставка","description":"Условия доставки","response":"<b>🚚 Доставка</b>\\nВыберите блюда в «Меню», добавьте в корзину и оформите — при оформлении укажете адрес и телефон. Или просто напишите заказ сообщением.","keyboard":[["🍽 Меню","🛒 Корзина"],["Назад"]]},
 {"command":"📞 Контакты","response":"<b>Контакты</b>\\nТелефон: +79000000000\\nАдрес: &lt;город, улица&gt;.","keyboard":[["Назад"]]},
 {"command":"📋 Мои заказы","description":"Мои заказы","queryMySchema":"orders","response":"<b>📋 Ваш заказ:</b>\\n«Где мой заказ» — уточнить статус доставки.","emptyResponse":"У вас пока нет заказов.","keyboard":[["🚚 Где мой заказ?"],["Назад"]]},
 {"command":"🚚 Где мой заказ?","notifyOwner":"спрашивает, где его заказ (уточнить статус доставки)","response":"Уточняем статус вашего заказа — скоро свяжемся! 🚚","keyboard":[["📋 Мои заказы"],["Назад"]]},
 {"command":"Назад","response":"<b>☕ &lt;Заведение&gt;</b>\\nЧто вас интересует?","keyboard":[["🍽 Меню","🛒 Корзина"],["🪑 Забронировать столик","📋 Мои заказы"],["🚚 Доставка","📞 Контакты"]]}
]
Бронь и заказ через доставку — клиент пишет детали текстом, сервер сам соберёт обязательные поля схемы (date/phone у bookings) и оформит. НЕ используй aiAction для показа условий доставки. Для доставки добавляй «Мои заказы» с кнопкой «🚚 Где мой заказ?» (notifyOwner) — как выше. ⛔️ НЕ создавай клиентскую кнопку подтверждения заказа («Подтвердить заказ» и т.п.): ВЫПОЛНЕНИЕ заказа подтверждают АДМИНИСТРАТОРЫ в своём боте — это делает сервер автоматически, клиенту такая кнопка не нужна.`;

const BOOKING = `ЭТАЛОН: УСЛУГИ/ЗАПИСЬ (салон, барбершоп, мастер)
Схемы (DB_COMMAND create_schema):
• services — услуги: name(text*), description(text), price(number*), duration(text). СПРАВОЧНАЯ → 2 примера.
• bookings — записи: service(text), master(text), date(date*), phone(text*), name(text). ПЕРСОНАЛЬНАЯ → без примеров.

Приветствие (HTML):
<b>💈 &lt;Салон&gt; — онлайн-запись</b>
Услуги, цены и запись в пару касаний. Выберите:

Команды (BOT_COMMANDS):
[
 {"command":"/start","response":"<b>💈 &lt;Салон&gt;</b>\\nВыберите:","keyboard":[["💇 Услуги","📝 Записаться"],["🗓 Мои записи"],["📞 Контакты"]]},
 {"command":"💇 Услуги","description":"Прайс","response":"<b>💇 Наши услуги:</b>","listSchema":"services","cartCurrency":"₽","keyboard":[["📝 Записаться"],["Назад"]]},
 {"command":"📝 Записаться","description":"Запись","response":"<b>📝 Запись</b>\\nНапишите желаемую услугу, дату/время и ваш телефон — я запишу вас.","keyboard":[["Назад"]]},
 {"command":"🗓 Мои записи","description":"Мои записи","queryMySchema":"bookings","emptyResponse":"У вас пока нет записей. Нажмите «Записаться».","keyboard":[["Назад"]]},
 {"command":"📞 Контакты","response":"<b>Контакты</b>\\nТелефон: +79000000000\\nАдрес: &lt;город, улица&gt;.","keyboard":[["Назад"]]},
 {"command":"Назад","response":"<b>💈 &lt;Салон&gt;</b>\\nВыберите:","keyboard":[["💇 Услуги","📝 Записаться"],["🗓 Мои записи"],["📞 Контакты"]]}
]
Запись: клиент пишет детали текстом, сервер соберёт обязательные поля (date/phone) и оформит в bookings. «Мои записи» — queryMySchema (только записи этого клиента, привязка автоматическая).`;

// Структурированные схемы макетов — сервер создаёт их ДЕТЕРМИНИРОВАННО при
// сборке (не полагаясь на то, что Mistral эмитит DB_COMMAND). samples только
// для справочных/каталожных схем; персональные (orders/bookings) создаются пустыми.
const F = (name, label, type, required) => ({ name, label, type, ...(required ? { required: true } : {}) });
// Единая схема заказа: состав/сумма считает сервер, клиент/Telegram ID — авто,
// адрес/телефон собираются при оформлении, статус для владельца.
const ORDER_FIELDS = [F('items', 'Состав заказа', 'text'), F('total', 'Сумма', 'number'), F('customer', 'Клиент', 'text'), F('tg_id', 'Telegram ID', 'text'), F('phone', 'Телефон', 'text'), F('address', 'Адрес доставки', 'text'), F('status', 'Статус', 'text')];
const SCHEMAS = {
  ecommerce: [
    { name: 'products', label: 'Товары', icon: '🛍', fields: [F('name', 'Название', 'text', true), F('description', 'Описание', 'text'), F('price', 'Цена', 'number', true), F('category', 'Категория', 'text'), F('stock', 'Остаток', 'number')],
      samples: [{ name: 'Товар пример 1', description: 'Замени на свой товар', price: 1990, category: 'Категория', stock: 10 }, { name: 'Товар пример 2', description: 'Замени на свой товар', price: 2990, category: 'Категория', stock: 5 }] },
    { name: 'orders', label: 'Заказы', icon: '📦', fields: ORDER_FIELDS, samples: [] },
  ],
  restaurant: [
    { name: 'menu', label: 'Меню', icon: '🍽', fields: [F('name', 'Название', 'text', true), F('description', 'Описание', 'text'), F('price', 'Цена', 'number', true), F('category', 'Категория', 'text')],
      samples: [{ name: 'Капучино', description: 'Классический эспрессо с молочной пенкой', price: 250, category: 'Кофе' }, { name: 'Тирамису', description: 'Итальянский десерт с кофейным вкусом', price: 350, category: 'Десерты' }] },
    { name: 'orders', label: 'Заказы', icon: '📦', fields: ORDER_FIELDS, samples: [] },
    { name: 'bookings', label: 'Брони столиков', icon: '🪑', fields: [F('date', 'Дата и время', 'date', true), F('guests', 'Гостей', 'number'), F('phone', 'Телефон', 'text', true), F('customer', 'Клиент', 'text'), F('tg_id', 'Telegram ID', 'text'), F('comment', 'Комментарий', 'text')], samples: [] },
  ],
  booking: [
    { name: 'services', label: 'Услуги', icon: '💇', fields: [F('name', 'Название', 'text', true), F('description', 'Описание', 'text'), F('price', 'Цена', 'number', true), F('duration', 'Длительность', 'text')],
      samples: [{ name: 'Услуга пример 1', description: 'Замени на свою услугу', price: 1500, duration: '60 мин' }, { name: 'Услуга пример 2', description: 'Замени на свою услугу', price: 2500, duration: '90 мин' }] },
    { name: 'bookings', label: 'Записи', icon: '🗓', fields: [F('service', 'Услуга', 'text'), F('date', 'Дата и время', 'date', true), F('phone', 'Телефон', 'text', true), F('name', 'Имя', 'text')], samples: [] },
  ],
};

const TEMPLATES = [
  { id: 'ecommerce',  name: 'Интернет-магазин с корзиной', keywords: ['магазин', 'интернет-магазин', 'товар', 'shop', 'store', 'продаж', 'ecommerce', 'маркетплейс', 'каталог товаров', 'одежд', 'косметик', 'электроник'], blueprint: ECOMMERCE, schemas: SCHEMAS.ecommerce },
  { id: 'restaurant', name: 'Ресторан/кофейня с доставкой', keywords: ['ресторан', 'кафе', 'кофейн', 'доставк', 'еда', 'пицц', 'суши', 'бар', 'столик', 'бронир', 'меню', 'food', 'delivery', 'напитк', 'десерт'], blueprint: RESTAURANT, schemas: SCHEMAS.restaurant },
  { id: 'booking',    name: 'Услуги и онлайн-запись',        keywords: ['салон', 'барбершоп', 'запис', 'мастер', 'услуг', 'маникюр', 'стрижк', 'бронир', 'booking', 'клиник', 'массаж', 'ногт', 'бров'], blueprint: BOOKING, schemas: SCHEMAS.booking },
];

// Подбираем макет по тексту запроса (по числу совпавших ключевых слов).
function matchTemplate(text) {
  const t = (text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const tpl of TEMPLATES) {
    const score = tpl.keywords.reduce((s, kw) => s + (t.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = tpl; }
  }
  return bestScore > 0 ? best : null;
}

// Готовый блок для инъекции в промпт сборки (или null, если макет не подошёл).
function templateContextBlock(text) {
  const tpl = matchTemplate(text);
  if (!tpl) return '';
  return `\n\n[ЭТАЛОННЫЙ МАКЕТ — «${tpl.name}»]\nНиже проверенный РАБОЧИЙ скелет бота этого типа, собранный по всем правилам платформы (нативная корзина, listSchema, сценарии, роли). ВОЗЬМИ ЕГО ЗА ОСНОВУ: адаптируй названия, тексты, товары и детали под [ЗАПРОС] пользователя, но СОХРАНИ все рабочие механизмы и флаги (listSchema/addToCart/showCart/checkoutSchema/queryMySchema, сценарии записи, minRole). Можешь расширять его под пожелания пользователя, но не ломай механику. Верни ответ в обычном формате (текст пользователю + WELCOME_MESSAGE + BOT_COMMANDS + DB_COMMAND для схем и примеров).\n\n${tpl.blueprint}`;
}

module.exports = { TEMPLATES, matchTemplate, templateContextBlock };
