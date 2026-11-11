import axios from 'axios';
import {
  AlertCircle,
  Bot,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Database,
  Download,
  Edit,
  Globe,
  Grid3x3,
  Link2,
  Loader2,
  MoreHorizontal,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Table2,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTutorial } from '../context/TutorialContext';
import './MyDataPage.css';

const TUTORIAL_STEPS = [
  {
    selector: '.schemas-panel',
    text: 'Левая панель — ваши схемы данных.\n\nСхема = таблица с информацией: меню, клиенты, услуги, расписание, прайс-лист...\n\nНажмите «+» чтобы создать схему вручную, или попросите AI сделать это за вас.',
  },
  {
    selector: 'a[href="/chat"]',
    text: '💡 Лайфхак для быстрого старта:\n\nНажмите «Чат с нейросетью» и напишите:\n«Создай и заполни примерами все нужные схемы данных для [опишите ваш бизнес]»\n\nAI создаст всё за 30 секунд — вернитесь сюда и увидите результат.',
  },
  {
    selector: '.schemas-sections',
    text: 'Схемы разбиты по AI-профилям.\n\nЕсли профилей несколько — перетащите схему мышкой в нужный раздел. Так каждый ассистент будет знать только нужные ему данные.\n\n«Общие данные» — доступны всем профилям сразу.',
  },
  {
    selector: '.records-toolbar',
    text: 'Верхняя панель — быстрые действия с записями:\n\n• Поиск — найдите запись по любому полю\n• «+ Запись» — создать новую запись вручную',
  },
  {
    selector: '.floating-dock',
    text: '⚡ Нижняя панель — форматы и интеграции:\n\n• День / Неделя / Календарь / Карточки / Таблица — переключайте вид как удобно\n• Excel / CSV — одноразовая загрузка данных\n• Google Sheets — живая синхронизация: стоит изменить данные в таблице — AI узнаёт об этом за считанные секунды. Новое расписание, новые цены, изменения в услугах — всё мгновенно\n• Внешняя БД — то же самое для MongoDB / PostgreSQL: данные поступают напрямую из вашей базы в нейросеть в реальном времени',
  },
  {
    selector: '.mydata-header-actions',
    text: 'Кнопки в правом верхнем углу:\n\n• «Подключить к сайту» — встроить AI-чат на ваш сайт (скрипт или iframe)\n• «Импорт» — загрузить Excel, CSV или JSON\n• «Экспорт» — скачать все данные в любой момент',
  },
  {
    selector: null,
    text: '✨ Всё здесь под вашим контролем.\n\nВы сами решаете, какие данные видит ваш ИИ-ассистент и в каком формате. А он, в свою очередь, готов помочь прямо из диалога:\n\n• «Добавь клиента Марию на 15:00» — запись появится мгновенно\n• «Обнови цену до 390 ₽» — изменит нужную строку в таблице\n• «Покажи всех клиентов за эту неделю» — выгрузит выборку в чат\n\nВаш помощник, ваши данные, ваши правила.',
  },
];

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const NICHE_LABELS = {
  cafe:        'Кафе и рестораны',
  travel:      'Туризм и путешествия',
  barbershop:  'Барбершоп',
  realty:      'Недвижимость',
  education:   'Онлайн-школа',
  medical:     'Медицина и клиники',
  shop:        'Интернет-магазин',
  office:      'B2B и офис',
  blogger:     'Блогеры и контент',
  beauty:      'Маникюр и beauty',
  auto:        'Автосалон',
  delivery:    'Доставка еды',
};

const NICHE_SETUP_PROMPTS = {
  cafe: `Ты настраиваешь систему данных для кафе/ресторана. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами с русскими именами и ценами в рублях:
1. "menu" (Меню) — название блюда, категория (enum: Завтраки;Супы;Салаты;Горячее;Напитки;Десерты), цена (number), вес г (number), состав, аллергены, в наличии (boolean)
2. "bookings" (Бронирования) — имя гостя, телефон, дата (date), время, количество гостей (number), статус (enum: Ожидает;Подтверждено;Отменено), комментарий
3. "staff" (Персонал) — имя, должность, рабочие дни, время начала, время окончания, телефон
4. "reviews" (Отзывы гостей) — имя гостя, оценка (number), текст отзыва, дата (date), платформа (enum: Google;Yandex;2ГИС;TripAdvisor)
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями о том, что создано.`,

  travel: `Ты настраиваешь систему данных для туристического агентства. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "tours" (Туры) — название тура, направление, страна, дата вылета (date), дата возврата (date), цена (number), мест доступно (number), включено в стоимость, тип (enum: Пляжный;Экскурсионный;Горнолыжный;Круиз;Детский)
2. "applications" (Заявки клиентов) — имя клиента, телефон, email (url), интересующий тур, бюджет (number), даты поездки, количество туристов (number), статус (enum: Новая;В обработке;Подтверждена;Оплачена;Отменена)
3. "hotels" (Отели) — название, страна, город, звёзды (number), цена за ночь (number), питание (enum: BB;HB;FB;AI), описание, пляж (boolean)
4. "countries" (Страны и визы) — страна, виза нужна (boolean), тип визы, срок оформления, стоимость визы (number), требования к документам
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,

  barbershop: `Ты настраиваешь систему данных для барбершопа. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "masters" (Мастера) — имя, специализация, опыт лет (number), телефон, рабочие дни, начало работы, конец работы, активен (boolean)
2. "services" (Услуги и прайс) — название услуги, категория (enum: Стрижка;Борода;Окрашивание;Уход;Комплекс), цена (number), длительность мин (number), описание
3. "bookings" (Записи клиентов) — имя клиента, телефон, мастер, услуга, дата (date), время, статус (enum: Ожидает;Подтверждено;Выполнено;Отменено), комментарий
4. "reviews" (Отзывы) — имя клиента, мастер, оценка (number), текст отзыва, дата (date)
Заполни каждую схему 2-3 реалистичными примерами с реальными русскими именами и актуальными ценами. Ответь 1-2 предложениями.`,

  realty: `Ты настраиваешь систему данных для агентства недвижимости. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "properties" (База объектов) — адрес, тип (enum: Квартира;Дом;Коммерческая;Земля), комнат (number), площадь м2 (number), этаж (number), цена (number), статус (enum: Продаётся;Аренда;Продано;Снято), описание, фото url (url)
2. "clients" (Клиенты и лиды) — имя, телефон, email, тип (enum: Покупатель;Арендатор;Продавец), бюджет (number), предпочтения, статус лида (enum: Новый;Квалифицирован;Просмотр;Сделка;Отказ)
3. "showings" (Показы) — объект, клиент, риелтор, дата (date), время, статус (enum: Запланирован;Состоялся;Отменён), комментарий
4. "deals" (Сделки) — объект, покупатель, продавец, цена сделки (number), дата сделки (date), комиссия % (number), статус (enum: В процессе;Задаток;Завершена), нотариус
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,

  education: `Ты настраиваешь систему данных для онлайн-школы. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "courses" (Курсы) — название, категория, длительность дней (number), цена (number), цена со скидкой (number), описание, формат (enum: Видеокурс;Интенсив;Марафон;Менторство), активен (boolean)
2. "students" (Студенты) — имя, телефон, email (url), курс, дата начала (date), дата окончания (date), оплачено (boolean), прогресс % (number), статус (enum: Активный;Завершил;Отчислен;Пауза)
3. "schedule" (Расписание занятий) — курс, дата (date), время начала, время окончания, тема занятия, ссылка на трансляцию (url), запись (url)
4. "tasks" (Задания и дедлайны) — название задания, курс, дедлайн (date), описание, максимальный балл (number), обязательное (boolean)
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,

  medical: `Ты настраиваешь систему данных для медицинской клиники. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "doctors" (Врачи) — имя, специальность, категория (enum: Без категории;Первая;Вторая;Высшая), стаж лет (number), телефон, расписание (по дням недели), ведёт приём (boolean)
2. "services" (Услуги и цены) — название услуги, отдел (enum: Терапия;Хирургия;Стоматология;Диагностика;Лаборатория;Косметология), цена (number), длительность мин (number), требует направления (boolean), описание
3. "appointments" (Записи пациентов) — имя пациента, телефон, врач, услуга, дата (date), время, статус (enum: Ожидает;Подтверждено;Состоялся;Отменён), комментарий
4. "reviews" (Отзывы о клинике) — имя пациента, врач, оценка (number), текст отзыва, дата (date), опубликован (boolean)
Заполни каждую схему 2-3 реалистичными примерами с реалистичными именами врачей, услугами и ценами в рублях. Ответь 1-2 предложениями.`,

  shop: `Ты настраиваешь систему данных для интернет-магазина. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "products" (Каталог товаров) — название, артикул, категория, цена (number), цена со скидкой (number), остаток на складе (number), описание, характеристики, в наличии (boolean), фото url (url)
2. "orders" (Заказы) — номер заказа, имя покупателя, телефон, email (url), товары, сумма (number), способ доставки (enum: Самовывоз;Курьер;Почта России;СДЭК), адрес, статус (enum: Новый;Оплачен;В сборке;Отправлен;Доставлен;Отменён), дата (date)
3. "categories" (Категории) — название, slug, описание, родительская категория, активна (boolean), сортировка (number)
4. "reviews" (Отзывы на товары) — товар, имя покупателя, оценка (number), текст, достоинства, недостатки, дата (date), опубликован (boolean)
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,

  office: `Ты настраиваешь систему данных для B2B-компании/офиса. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "leads" (Входящие лиды) — компания, контактное лицо, должность, телефон, email (url), источник (enum: Сайт;Холодный звонок;Реклама;Рефeral;Выставка), бюджет (number), потребность, статус (enum: Новый;Квалифицирован;Встреча;КП;Переговоры;Сделка;Отказ), ответственный
2. "clients" (Клиентская база) — компания, ИНН, контактное лицо, телефон, email (url), сегмент (enum: Малый бизнес;Средний бизнес;Крупный), оборот год (number), дата начала работы (date)
3. "tasks" (Задачи команды) — название задачи, ответственный, приоритет (enum: Низкий;Средний;Высокий;Срочно), дедлайн (date), статус (enum: Новая;В работе;На проверке;Выполнена), описание
4. "faq" (Регламенты и FAQ) — вопрос, ответ, отдел (enum: Продажи;Поддержка;HR;Бухгалтерия;IT), последнее обновление (date), активен (boolean)
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,

  blogger: `Ты настраиваешь систему данных для блогера/контент-мейкера. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "products" (Продукты и курсы) — название, тип (enum: Курс;Марафон;Консультация;Мерч;Закрытый клуб), цена (number), цена со скидкой (number), описание, длительность, доступен (boolean), ссылка (url)
2. "orders" (Заявки и заказы) — имя, телефон, email (url), продукт, цена (number), оплачен (boolean), дата заявки (date), источник (enum: Telegram;Instagram;VK;Прямая ссылка), статус (enum: Новая;Оплачена;Выдан доступ;Отменена)
3. "faq" (Вопросы и ответы) — вопрос, ответ, категория (enum: Оплата;Контент;Курсы;Общее), популярный (boolean)
4. "content_plan" (Контент-план) — платформа (enum: Telegram;YouTube;Instagram;VK), тема, формат (enum: Пост;Видео;Сторис;Рилс;Стрим), дата публикации (date), статус (enum: Идея;В работе;Готов;Опубликован), описание
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,

  beauty: `Ты настраиваешь систему данных для мастера красоты / beauty-студии. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "services" (Услуги и прайс) — название услуги, категория (enum: Маникюр;Педикюр;Наращивание;Покрытие;Дизайн;Уход за ногтями), цена (number), длительность мин (number), описание
2. "masters" (Мастера) — имя, специализация, опыт лет (number), рабочие дни, начало работы, конец работы, телефон, активен (boolean)
3. "bookings" (Записи клиентов) — имя клиентки, телефон, мастер, услуга, дата (date), время, статус (enum: Ожидает;Подтверждено;Выполнено;Отменено), комментарий, цена (number)
4. "reviews" (Отзывы) — имя клиентки, мастер, оценка (number), текст отзыва, дата (date), фото (boolean)
Заполни каждую схему 2-3 реалистичными примерами с женскими именами и реальными услугами. Ответь 1-2 предложениями.`,

  auto: `Ты настраиваешь систему данных для автосалона. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "cars" (Автомобили в наличии) — марка, модель, год (number), комплектация, цвет, пробег км (number), цена (number), тип кузова (enum: Седан;Хэтчбек;Универсал;Кроссовер;Внедорожник;Минивэн), двигатель, КПП (enum: Автомат;Механика;Робот;Вариатор), в наличии (boolean)
2. "test_drives" (Тест-драйвы) — имя клиента, телефон, автомобиль, дата (date), время, менеджер, статус (enum: Запланирован;Состоялся;Отменён), комментарий
3. "clients" (Клиенты и лиды) — имя, телефон, email (url), интерес (марка/модель), бюджет (number), способ покупки (enum: Наличные;Кредит;Трейд-ин;Лизинг), статус (enum: Новый;Консультация;Тест-драйв;Переговоры;Сделка;Отказ)
4. "promotions" (Акции и спецпредложения) — название акции, описание, скидка % (number), дата начала (date), дата окончания (date), на какие модели, активна (boolean)
Заполни каждую схему 2-3 реалистичными примерами с реальными марками авто и ценами в рублях. Ответь 1-2 предложениями.`,

  delivery: `Ты настраиваешь систему данных для службы доставки еды. Создай 4 схемы через DB_COMMAND и заполни каждую 2-3 реалистичными примерами:
1. "menu" (Меню) — название, категория (enum: Пицца;Суши;Бургеры;Паста;Салаты;Десерты;Напитки), цена (number), вес г (number), состав, аллергены, острое (boolean), в наличии (boolean)
2. "orders" (Заказы) — имя клиента, телефон, адрес доставки, состав заказа, сумма (number), стоимость доставки (number), способ оплаты (enum: Наличные;Карта;Онлайн), статус (enum: Новый;Принят;Готовится;В пути;Доставлен;Отменён), дата (date), комментарий
3. "zones" (Зоны доставки) — район, минимальный заказ (number), стоимость доставки (number), время доставки мин (number), активна (boolean)
4. "couriers" (Курьеры) — имя, телефон, транспорт (enum: Пешком;Велосипед;Мотоцикл;Авто), активен (boolean), зоны работы, смена начало, смена конец
Заполни каждую схему 2-3 реалистичными примерами. Ответь 1-2 предложениями.`,
};

export default function MyDataPage({ apiKey }) {
  const [schemas, setSchemas] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedSchema, setSelectedSchema] = useState(null);
  const [records, setRecords] = useState([]);
  const [loadingSchemas, setLoadingSchemas] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('viewMode') || 'visual');
  const [showSchemaForm, setShowSchemaForm] = useState(false);
  const [editingSchema, setEditingSchema] = useState(null);
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [viewRecord, setViewRecord] = useState(null);
  const [prefillData, setPrefillData] = useState(null);
  const [loadingImport, setLoadingImport] = useState(false);
  const fileInputRef = useRef(null);
  const [showImportFileModal, setShowImportFileModal] = useState(false);
  const [showImportSheetsModal, setShowImportSheetsModal] = useState(false);
  const [showExternalDbModal, setShowExternalDbModal] = useState(false);
  const [showOneCModal, setShowOneCModal] = useState(false);
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [paginationMeta, setPaginationMeta] = useState(null);
  const searchTimerRef = useRef(null);
  // drag state
  const [dragSchema, setDragSchema] = useState(null);
  const [dragOver, setDragOver] = useState(null); // 'common' | profileId
  const [syncConfigs, setSyncConfigs] = useState([]);
  const [syncingId, setSyncingId] = useState(null);
  const [userPlan, setUserPlan] = useState(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef(null);
  const [totalRecords, setTotalRecords] = useState(null);

  const [searchParams] = useSearchParams();
  const [nicheSetupPhase, setNicheSetupPhase] = useState(null);
  const [nicheSetupLabel, setNicheSetupLabel] = useState('');
  const nicheSetupRef = useRef(false);

  const PAGE_SIZE = 50;

  const { enabled, startTutorial, isActive, skipped, completedPaths } = useTutorial();
  useEffect(() => {
    if (enabled && !isActive && !skipped && !completedPaths.has('/data')) {
      const t = setTimeout(() => { if (window.location.pathname === '/data') startTutorial(TUTORIAL_STEPS, '/data'); }, 400);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isActive, skipped, completedPaths]);

  useEffect(() => { fetchSchemas(); fetchProfiles(); }, []);

  useEffect(() => {
    const nicheId = searchParams.get('nicheSetup');
    if (!nicheId || nicheSetupRef.current) return;
    nicheSetupRef.current = true;
    const prompt = NICHE_SETUP_PROMPTS[nicheId];
    const label = NICHE_LABELS[nicheId] || nicheId;
    if (!prompt) return;
    localStorage.removeItem('pendingNicheSetup');
    window.history.replaceState({}, '', '/data');
    setNicheSetupLabel(label);
    setNicheSetupPhase('loading');

    const run = async () => {
      try {
        const chatRes = await axios.post(
          `${API_URL}/studio/chat`,
          { message: prompt, currentConfig: {} },
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        const taskId = chatRes.data?.taskId;
        if (!taskId) throw new Error('no taskId');

        const poll = async () => {
          try {
            const r = await axios.get(`${API_URL}/result/${taskId}`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (r.data.status === 'completed') {
              setNicheSetupPhase('done');
              fetchSchemas();
              setTimeout(() => setNicheSetupPhase(null), 2500);
            } else if (r.data.status === 'error') {
              setNicheSetupPhase('error');
              setTimeout(() => setNicheSetupPhase(null), 3000);
            } else {
              setTimeout(poll, 1800);
            }
          } catch {
            setTimeout(poll, 2500);
          }
        };
        poll();
      } catch {
        setNicheSetupPhase('error');
        setTimeout(() => setNicheSetupPhase(null), 3000);
      }
    };
    run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    axios.get(`${API_URL}/user/info`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(r => setUserPlan(r.data?.plan))
      .catch(() => {});
  }, [apiKey]);

  useEffect(() => {
    if (!actionsOpen) return;
    const handler = (e) => { if (actionsRef.current && !actionsRef.current.contains(e.target)) setActionsOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [actionsOpen]);

  const fetchProfiles = async () => {
    try {
      const res = await axios.get(`${API_URL}/profiles`, { headers: { Authorization: `Bearer ${apiKey}` } });
      setProfiles(res.data.profiles || []);
    } catch {}
  };

  const handleAssign = async (schemaName, profileIds) => {
    try {
      await axios.patch(`${API_URL}/data/schemas/${schemaName}/assign`,
        { profileIds },
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      setSchemas(prev => prev.map(s => s.name === schemaName ? { ...s, profileIds } : s));
    } catch (err) {
      alert('Ошибка назначения: ' + (err.response?.data?.error || err.message));
    }
  };

  // Load sync configs + auto-sync stale ones (gate: 5 min)
  const loadSyncConfigs = useCallback(() => {
    axios.get(`${API_URL}/integrations/sync/list`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then((res) => {
      const configs = (res.data.configs || []).filter((c) => c.enabled);
      setSyncConfigs(configs);
      configs.forEach((cfg) => {
        const lastSync = cfg.lastSyncAt ? new Date(cfg.lastSyncAt) : null;
        if (lastSync && Date.now() - lastSync.getTime() < 5 * 60 * 1000) return;
        axios.post(`${API_URL}/integrations/sync/trigger/${cfg._id}`, {}, {
          headers: { Authorization: `Bearer ${apiKey}` },
        }).then(() => {
          fetchSchemas(null, true);
          loadSyncConfigs();
        }).catch(() => {});
      });
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => { loadSyncConfigs(); }, [loadSyncConfigs]);

  const handleSyncNow = useCallback(async (cfg) => {
    setSyncingId(cfg._id);
    try {
      await axios.post(`${API_URL}/integrations/sync/trigger/${cfg._id}`, {}, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      await Promise.all([fetchSchemas(null, true), loadSyncConfigs()]);
    } catch { /* silent */ } finally {
      setSyncingId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, loadSyncConfigs]);

  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    if (selectedSchema) {
      setCurrentPage(1);
      setPaginationMeta(null);
      // If there's an active search query, fetch search results in new schema; else fetch page 1
      if (searchQuery.trim()) {
        fetchRecords(1, true);
      } else {
        fetchRecords(1, false);
      }
    } else {
      setRecords([]);
      setPaginationMeta(null);
    }
  }, [selectedSchema?.name]);

  // Debounced search: fetch 2000 rows for client-side filtering, or revert to page 1
  useEffect(() => {
    if (!selectedSchema) return;
    clearTimeout(searchTimerRef.current);
    if (searchQuery.trim()) {
      searchTimerRef.current = setTimeout(() => fetchRecords(1, true), 300);
    } else {
      searchTimerRef.current = setTimeout(() => { setCurrentPage(1); fetchRecords(1, false); }, 150);
    }
  }, [searchQuery]);

  const changeViewMode = (mode) => {
    localStorage.setItem('viewMode', mode);
    setViewMode(mode);
  };

  // Restore saved view when schema changes; fall back if calendar not available
  useEffect(() => {
    if (!selectedSchema) return;
    const saved = localStorage.getItem('viewMode') || 'visual';
    const hasDate = selectedSchema.fields?.some((f) => f.type === 'date');
    if ((saved === 'calendar' || saved === 'week' || saved === 'day') && !hasDate) {
      setViewMode('visual');
    } else {
      setViewMode(saved);
    }
  }, [selectedSchema?.name]);

  // Client-side search filter (no text index required on server)
  const filteredRecords = useMemo(() => {
    if (!searchQuery.trim()) return records;
    const q = searchQuery.toLowerCase();
    return records.filter((rec) => {
      const flat = { ...(rec.data || {}), ...(rec.data?.data || {}) };
      return Object.values(flat).some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [records, searchQuery]);

  const fetchSchemas = async (autoSelectName = null, silent = false) => {
    try {
      if (!silent) setLoadingSchemas(true);
      const res = await axios.get(`${API_URL}/data/schemas`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const list = res.data.schemas || [];
      setSchemas(list);
      if (res.data.totalRecords !== undefined) setTotalRecords(res.data.totalRecords);
      if (list.length === 0) {
        setSelectedSchema(null);
      } else if (autoSelectName) {
        const target = list.find((s) => s.name === autoSelectName);
        setSelectedSchema(target || list[0]);
      } else if (!selectedSchema) {
        setSelectedSchema(list[0]);
      } else {
        const updated = list.find((s) => s.name === selectedSchema.name);
        setSelectedSchema(updated || list[0]);
      }
    } catch (err) {
      console.error('fetchSchemas error:', err);
    } finally {
      if (!silent) setLoadingSchemas(false);
    }
  };

  const fetchRecords = async (page = 1, forSearch = false) => {
    if (!selectedSchema) return;
    try {
      setLoadingRecords(true);
      const params = forSearch ? { limit: 2000, page: 1 } : { limit: PAGE_SIZE, page };
      const res = await axios.get(`${API_URL}/data/records/${selectedSchema.name}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params,
      });
      setRecords(res.data.records || []);
      if (forSearch) {
        setPaginationMeta(null);
      } else {
        setPaginationMeta(res.data.pagination || null);
        setCurrentPage(page);
      }
    } catch (err) {
      console.error('fetchRecords error:', err);
    } finally {
      setLoadingRecords(false);
    }
  };

  const handleDeleteSchema = async (schema) => {
    if (!window.confirm(`Удалить схему «${schema.label}» и все её записи?`)) return;
    try {
      await axios.delete(`${API_URL}/data/schemas/${schema.name}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (selectedSchema?.name === schema.name) setSelectedSchema(null);
      fetchSchemas(null, true);
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка удаления');
    }
  };

  const handleDeleteRecord = async (recordId) => {
    if (!window.confirm('Удалить запись?')) return;
    try {
      await axios.delete(`${API_URL}/data/records/${selectedSchema.name}/${recordId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      fetchRecords(currentPage, searchQuery.trim() !== '');
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка удаления');
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['json', 'csv', 'sql'].includes(ext)) {
      alert('Поддерживаются файлы: .json, .csv, .sql');
      return;
    }
    setLoadingImport(true);
    const formData = new FormData();
    formData.append('file', file);
    // CSV: всегда используем имя файла → схема попадает в Общие данные
    try {
      const res = await axios.post(`${API_URL}/data/import`, formData, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'multipart/form-data' },
      });
      if (res.data.success) {
        const { importedSchemas, importedRecords, errors } = res.data.summary;
        let msg = `Импортировано: ${importedSchemas} схем, ${importedRecords} записей.`;
        if (errors?.length) msg += `\nПропущено (${errors.length}): ${errors.slice(0, 3).join('; ')}`;
        alert(msg);
        fetchSchemas(null, true);
        fetchRecords();
      }
    } catch (err) {
      alert('Ошибка импорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoadingImport(false);
      e.target.value = '';
    }
  };

  const selectedSchemaObj = selectedSchema;
  const fields = selectedSchemaObj?.fields || [];

  return (
    <div className="mydata-page">
      {/* Niche AI setup overlay */}
      {nicheSetupPhase && (
        <div className={`niche-setup-overlay ${nicheSetupPhase}`}>
          <div className="niche-setup-overlay__card">
            {nicheSetupPhase === 'loading' && (
              <>
                <div className="niche-setup-overlay__spinner" />
                <h3>AI настраивает данные</h3>
                <p className="niche-setup-overlay__niche">«{nicheSetupLabel}»</p>
                <p className="niche-setup-overlay__sub">Создаём схемы, добавляем реалистичные примеры...</p>
                <p className="niche-setup-overlay__hint">Обычно занимает 10–30 секунд</p>
              </>
            )}
            {nicheSetupPhase === 'done' && (
              <>
                <div className="niche-setup-overlay__success">✓</div>
                <h3>Данные настроены!</h3>
                <p className="niche-setup-overlay__sub">Схемы для «{nicheSetupLabel}» созданы с примерами</p>
              </>
            )}
            {nicheSetupPhase === 'error' && (
              <>
                <div className="niche-setup-overlay__error">!</div>
                <h3>Что-то пошло не так</h3>
                <p className="niche-setup-overlay__sub">Попробуйте ещё раз или создайте схемы вручную</p>
              </>
            )}
          </div>
        </div>
      )}
      {/* Шапку («База знаний» + подзаголовок) рисует оболочка — своей здесь быть не должно.
          Кнопки действий переехали в панель инструментов .data__bar. */}

      {/* Body */}
      <div className="mydata-body data">
        {/* Left: Schemas Panel */}
        <aside className="schemas-panel data__side">
          <div className="schemas-panel-header data__sgrp">
            <span className="data__sl">Схемы</span>
            <button
              className="schema-add-btn data__addsm"
              onClick={() => { setEditingSchema(null); setShowSchemaForm(true); }}
              title="Создать схему"
            >
              <Plus size={16} />
            </button>
          </div>

          {loadingSchemas ? (
            <div className="panel-loading"><Loader2 size={24} className="spin" /></div>
          ) : schemas.length === 0 ? (
            <div className="panel-empty empty empty--inline">
              <span className="empty__ic"><Database size={26} /></span>
              <p className="empty__t">Нет схем</p>
              <button onClick={() => { setEditingSchema(null); setShowSchemaForm(true); }}>
                Создать первую
              </button>
            </div>
          ) : (
            <div className="schemas-sections">
              {/* Common / shared schemas */}
              <SchemaSection
                title="Общие данные"
                subtitle="для всех профилей"
                icon={<Database size={13} />}
                color="#667eea"
                schemas={schemas.filter(s => !s.profileIds?.length)}
                selectedSchema={selectedSchema}
                onSelect={setSelectedSchema}
                onEdit={(s) => { setEditingSchema(s); setShowSchemaForm(true); }}
                onDelete={handleDeleteSchema}
                syncConfigs={syncConfigs}
                syncingId={syncingId}
                onSyncNow={handleSyncNow}
                dropZoneId="common"
                dragOver={dragOver}
                onDragStart={setDragSchema}
                onDragOver={setDragOver}
                onDrop={(zoneId) => {
                  if (!dragSchema) return;
                  handleAssign(dragSchema, zoneId === 'common' ? [] : [zoneId]);
                  setDragSchema(null); setDragOver(null);
                }}
              />

              {/* One section per AI profile */}
              {profiles.map(profile => (
                <SchemaSection
                  key={profile._id}
                  title={profile.profileName}
                  subtitle="AI-профиль"
                  icon={<Bot size={13} />}
                  color={profile.color || '#764ba2'}
                  schemas={schemas.filter(s => s.profileIds?.map(String).includes(String(profile._id)))}
                  selectedSchema={selectedSchema}
                  onSelect={setSelectedSchema}
                  onEdit={(s) => { setEditingSchema(s); setShowSchemaForm(true); }}
                  onDelete={handleDeleteSchema}
                  syncConfigs={syncConfigs}
                  syncingId={syncingId}
                  onSyncNow={handleSyncNow}
                  dropZoneId={profile._id}
                  dragOver={dragOver}
                  onDragStart={setDragSchema}
                  onDragOver={setDragOver}
                  onDrop={(zoneId) => {
                    if (!dragSchema) return;
                    handleAssign(dragSchema, zoneId === 'common' ? [] : [zoneId]);
                    setDragSchema(null); setDragOver(null);
                  }}
                />
              ))}
            </div>
          )}
        </aside>

        {/* Right: Records Panel */}
        <div className="records-panel data__main">
          {/* Панель инструментов — единственная шапка экрана. Рендерится всегда:
              импорт/экспорт/подключение нужны и когда схема ещё не выбрана. */}
          <div className="records-toolbar data__bar">
            <div className="toolbar-left data__title">
              {selectedSchema && (
                <span className="schema-badge chip chip--soft">
                  {selectedSchema.icon} {selectedSchema.label}
                </span>
              )}
              <span className="data__cnt">{schemas.length} схем · {totalRecords ?? '…'} записей</span>
            </div>

            <div className="data__acts">
              {selectedSchema && (
                <div className="search-box search search--sm">
                  <Search size={15} />
                  <input
                    type="text"
                    placeholder="Поиск..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button className="search-clear" onClick={() => setSearchQuery('')}>
                      <X size={13} />
                    </button>
                  )}
                </div>
              )}

              {/* Desktop buttons */}
              <button className="btn-outline hdr-btn-desktop" onClick={() => setShowEmbedModal(true)}>
                <Globe size={16} /> Подключить к сайту
              </button>
              <button className="btn-outline hdr-btn-desktop" onClick={handleImportClick} disabled={loadingImport}>
                {loadingImport ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
                Импорт
              </button>
              <button className="btn-primary-grad hdr-btn-desktop" onClick={() => setShowExportModal(true)}>
                <Download size={16} />
                Экспорт
              </button>

              {/* Mobile: "Действия" dropdown */}
              <div className="hdr-actions-dropdown" ref={actionsRef}>
                <button className="btn-outline hdr-btn-mobile" onClick={() => setActionsOpen(v => !v)}>
                  <MoreHorizontal size={16} />
                  Действия
                  <ChevronDown size={14} style={{ marginLeft: 2, transition: 'transform .2s', transform: actionsOpen ? 'rotate(180deg)' : 'none' }} />
                </button>
                {actionsOpen && (
                  <div className="hdr-dropdown-menu">
                    <button onClick={() => { setShowEmbedModal(true); setActionsOpen(false); }}>
                      <Globe size={15} /> Подключить к сайту
                    </button>
                    <button onClick={() => { handleImportClick(); setActionsOpen(false); }} disabled={loadingImport}>
                      {loadingImport ? <Loader2 size={15} className="spin" /> : <Upload size={15} />} Импорт
                    </button>
                    <button onClick={() => { setShowExportModal(true); setActionsOpen(false); }}>
                      <Download size={15} /> Экспорт
                    </button>
                  </div>
                )}
              </div>

              <input
                type="file"
                ref={fileInputRef}
                accept=".json,.csv,.sql"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />

              {selectedSchema && (
                <button
                  className="btn-add-record"
                  onClick={() => { setEditingRecord(null); setShowRecordForm(true); }}
                >
                  <Plus size={16} /> Запись
                </button>
              )}
            </div>
          </div>

          {!selectedSchema ? (
            <div className="records-empty-state empty">
              <span className="empty__ic"><Database size={26} /></span>
              <h3 className="empty__t">Выберите схему</h3>
              <p className="empty__d">Выберите схему слева или создайте новую</p>
            </div>
          ) : (
            <>
              {/* Records content */}
              <div className={`records-content${(viewMode === 'calendar' || viewMode === 'week' || viewMode === 'day') ? ' records-content--calendar' : ''}`}>
                {loadingRecords ? (
                  <div className="records-loading"><Loader2 size={32} className="spin" /></div>
                ) : records.length === 0 ? (
                  <div className="records-empty empty empty--inline">
                    <span className="empty__ic"><Database size={26} /></span>
                    <h3 className="empty__t">Нет записей</h3>
                    <p className="empty__d">Добавьте первую запись в «{selectedSchema.label}»</p>
                    <button
                      className="btn-primary-grad"
                      onClick={() => { setEditingRecord(null); setPrefillData(null); setShowRecordForm(true); }}
                    >
                      <Plus size={16} /> Добавить запись
                    </button>
                  </div>
                ) : viewMode === 'day' ? (
                  <DayView
                    records={filteredRecords}
                    fields={fields}
                    schemaName={selectedSchema.name}
                    apiKey={apiKey}
                    onView={setViewRecord}
                    onEdit={(r) => { setEditingRecord(r); setPrefillData(null); setShowRecordForm(true); }}
                    onDelete={handleDeleteRecord}
                    onAddForDate={(date, time, extra = {}) => {
                      const dateField = fields.find((f) => f.type === 'date');
                      const timeField = fields.find((f) => f.name === 'time');
                      const fill = { ...extra };
                      if (dateField) fill[dateField.name] = date;
                      if (timeField && time) fill[timeField.name] = time;
                      setEditingRecord(null);
                      setPrefillData(fill);
                      setShowRecordForm(true);
                    }}
                  />
                ) : viewMode === 'week' ? (
                  <WeekView
                    records={filteredRecords}
                    fields={fields}
                    onView={setViewRecord}
                    onEdit={(r) => { setEditingRecord(r); setPrefillData(null); setShowRecordForm(true); }}
                    onDelete={handleDeleteRecord}
                    onAddForDate={(date, time) => {
                      const dateField = fields.find((f) => f.type === 'date');
                      const timeField = fields.find((f) => f.name === 'time');
                      const fill = {};
                      if (dateField) fill[dateField.name] = date;
                      if (timeField && time) fill[timeField.name] = time;
                      setEditingRecord(null);
                      setPrefillData(fill);
                      setShowRecordForm(true);
                    }}
                  />
                ) : viewMode === 'calendar' ? (
                  <CalendarView
                    records={filteredRecords}
                    fields={fields}
                    onView={setViewRecord}
                    onEdit={(r) => { setEditingRecord(r); setPrefillData(null); setShowRecordForm(true); }}
                    onDelete={handleDeleteRecord}
                    onAddForDate={(date, time) => {
                      const dateField = fields.find((f) => f.type === 'date');
                      const timeField = fields.find((f) => f.name === 'time');
                      const fill = {};
                      if (dateField) fill[dateField.name] = date;
                      if (timeField && time) fill[timeField.name] = time;
                      setEditingRecord(null);
                      setPrefillData(fill);
                      setShowRecordForm(true);
                    }}
                  />
                ) : viewMode === 'visual' ? (
                  <VisualView
                    records={filteredRecords}
                    fields={fields}
                    onEdit={(r) => { setEditingRecord(r); setPrefillData(null); setShowRecordForm(true); }}
                    onDelete={handleDeleteRecord}
                    onView={setViewRecord}
                  />
                ) : viewMode === 'table' ? (
                  <TableView
                    records={filteredRecords}
                    fields={fields}
                    onEdit={(r) => { setEditingRecord(r); setPrefillData(null); setShowRecordForm(true); }}
                    onDelete={handleDeleteRecord}
                    onView={setViewRecord}
                  />
                ) : (
                  <JsonView records={filteredRecords} />
                )}
              </div>

            </>
          )}

          {/* Футер карточки (.data__foot): режимы вида, пагинация и источники импорта.
              Раньше это был .floating-dock — position:fixed поверх таблицы, из-за чего
              плашка накрывала последние строки и фикс-скроллбар. Теперь он в потоке. */}
          <FloatingDock
            selectedSchema={selectedSchema}
            fields={fields}
            viewMode={viewMode}
            setViewMode={changeViewMode}
            onCreateSchema={() => { setEditingSchema(null); setShowSchemaForm(true); }}
            onImportFile={() => setShowImportFileModal(true)}
            onImportSheets={() => setShowImportSheetsModal(true)}
            onImportExternalDb={() => setShowExternalDbModal(true)}
            onImportOneC={() => setShowOneCModal(true)}
            currentPage={currentPage}
            totalPages={!searchQuery.trim() && paginationMeta ? paginationMeta.pages : 0}
            loadingRecords={loadingRecords}
            onPageChange={(p) => fetchRecords(p, false)}
            userPlan={userPlan}
          />
        </div>
      </div>

      {/* Modals */}
      {showSchemaForm && (
        <SchemaForm
          apiKey={apiKey}
          schema={editingSchema}
          onClose={() => { setShowSchemaForm(false); fetchSchemas(); }}
        />
      )}

      {showRecordForm && selectedSchema && (
        <RecordForm
          apiKey={apiKey}
          schema={selectedSchema}
          record={editingRecord}
          prefillData={prefillData}
          onClose={() => { setShowRecordForm(false); setPrefillData(null); fetchRecords(currentPage, searchQuery.trim() !== ''); }}
        />
      )}

      {showExportModal && (
        <ExportModal
          apiKey={apiKey}
          schemas={schemas}
          onClose={() => setShowExportModal(false)}
        />
      )}

      {viewRecord && selectedSchema && (
        <RecordDetailModal
          record={viewRecord}
          schema={selectedSchema}
          onEdit={() => { setViewRecord(null); setEditingRecord(viewRecord); setShowRecordForm(true); }}
          onClose={() => setViewRecord(null)}
        />
      )}

      {showImportFileModal && (
        <ImportFileModal
          apiKey={apiKey}
          onClose={() => setShowImportFileModal(false)}
          onImported={(schemaName) => fetchSchemas(schemaName)}
        />
      )}

      {showImportSheetsModal && (
        <ImportSheetsModal
          apiKey={apiKey}
          onClose={() => setShowImportSheetsModal(false)}
          onSynced={(schemaName) => fetchSchemas(schemaName)}
        />
      )}

      {showExternalDbModal && (
        <ExternalDbModal
          apiKey={apiKey}
          onClose={() => setShowExternalDbModal(false)}
          onImported={(schemaName) => fetchSchemas(schemaName)}
        />
      )}

      {showOneCModal && (
        <OneCModal
          apiKey={apiKey}
          onClose={() => setShowOneCModal(false)}
          onSynced={(schemaName) => fetchSchemas(schemaName)}
        />
      )}

      {showEmbedModal && (
        <EmbedModal
          apiKey={apiKey}
          selectedSchema={selectedSchema}
          onClose={() => setShowEmbedModal(false)}
        />
      )}

    </div>
  );
}

// ── Schema Section (profile block with drag-and-drop) ────────────────────────
function fmtSyncAge(lastSyncAt) {
  if (!lastSyncAt) return null;
  const mins = Math.floor((Date.now() - new Date(lastSyncAt)) / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  return `${Math.floor(hrs / 24)} д назад`;
}

function SchemaSection({ title, subtitle, icon, color, schemas, selectedSchema, onSelect, onEdit, onDelete, syncConfigs, syncingId, onSyncNow, dropZoneId, dragOver, onDragStart, onDragOver, onDrop }) {
  const isOver = dragOver === dropZoneId;
  return (
    // Монохром: инлайновые цвета профиля (--section-color / color) убраны —
    // они красили плашки секций и перебивали токены. Вид даёт CSS.
    <div
      className={`schema-section${isOver ? ' schema-section--over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(dropZoneId); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onDragOver(null); }}
      onDrop={(e) => { e.preventDefault(); onDrop(dropZoneId); }}
    >
      <div className="schema-section-header">
        <span className="schema-section-icon">{icon}</span>
        <div className="schema-section-titles">
          <span className="schema-section-title">{title}</span>
          <span className="schema-section-sub">{subtitle}</span>
        </div>
        <span className="schema-section-count">{schemas.length}</span>
      </div>

      <div className={`schema-section-body${isOver ? ' drop-highlight' : ''}`}>
        {schemas.length === 0 ? (
          <div className="schema-section-empty">
            Перетащи схему сюда
          </div>
        ) : (
          schemas.map((schema) => {
            const syncCfg = syncConfigs?.find(c => c.schemaName === schema.name);
            const isSyncing = syncCfg && syncingId === syncCfg._id;
            const ageLabel = syncCfg ? fmtSyncAge(syncCfg.lastSyncAt) : null;
            return (
              <div
                key={schema.name}
                className={`schema-item schema ${selectedSchema?.name === schema.name ? 'active schema--active' : ''}`}
                onClick={() => onSelect(schema)}
                draggable
                onDragStart={() => onDragStart(schema.name)}
                onDragEnd={() => { onDragStart(null); onDragOver(null); }}
              >
                <div className="schema-drag-handle">⠿</div>
                <div className="schema-item-icon">{schema.icon || '📋'}</div>
                <div className="schema-item-info">
                  <span className="schema-item-label">{schema.label}</span>
                  {syncCfg ? (
                    <span className="schema-sync-badge">
                      {ageLabel || '—'}
                    </span>
                  ) : (
                    <span className="schema-item-name">{schema.name}</span>
                  )}
                </div>
                <div className="schema-item-actions">
                  {syncCfg && (
                    <button
                      title="Обновить из Google Sheets"
                      className={isSyncing ? 'syncing' : ''}
                      onClick={(e) => { e.stopPropagation(); onSyncNow(syncCfg); }}
                      disabled={isSyncing}
                    >
                      <RefreshCw size={13} className={isSyncing ? 'spin' : ''} />
                    </button>
                  )}
                  <button title="Редактировать" onClick={(e) => { e.stopPropagation(); onEdit(schema); }}>
                    <Settings size={13} />
                  </button>
                  <button title="Удалить" className="danger" onClick={(e) => { e.stopPropagation(); onDelete(schema); }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Reads a field value, with fallback to rec.data.data for legacy nested records
function getVal(rec, fieldName) {
  const v = rec.data?.[fieldName];
  if (v !== undefined && v !== null && v !== '') return v;
  return rec.data?.data?.[fieldName] ?? null;
}

// ── Visual View ──────────────────────────────────────────────────────────────
// ── Render a field value (shared between views) ───────────────────────────────
function FieldValue({ f, val, compact = false, onImageClick }) {
  if (val == null || val === '') return <span className="null-val">—</span>;
  const s = String(val);
  if (f.type === 'image') {
    if (s.startsWith('data:image/') || s.startsWith('http')) {
      return (
        <img
          src={s}
          alt={f.label}
          className={compact ? 'field-thumb-sm' : 'field-thumb'}
          style={onImageClick && !compact ? { cursor: 'zoom-in' } : undefined}
          onClick={onImageClick && !compact ? (e) => { e.stopPropagation(); onImageClick(s); } : undefined}
        />
      );
    }
  }
  if (f.type === 'file') {
    const decoded = decodeFile(s);
    if (decoded) {
      return (
        <a href={decoded.data} download={decoded.name} className="td-file-link" onClick={e => e.stopPropagation()}>
          📎 {decoded.name}
        </a>
      );
    }
  }
  if (f.type === 'url' || (s.startsWith('http') && f.type !== 'text')) {
    return <a href={s} target="_blank" rel="noopener noreferrer" className="td-url-link" onClick={e => e.stopPropagation()}>{compact && s.length > 35 ? s.slice(0, 32) + '…' : s.length > 60 ? s.slice(0, 57) + '…' : s}</a>;
  }
  return <>{compact && s.length > 45 ? s.slice(0, 42) + '…' : s}</>;
}

function VisualView({ records, fields, onEdit, onDelete, onView }) {
  const PREVIEW = 5;
  // Find first image field to use as card cover
  const coverField = fields.find(f => f.type === 'image');
  return (
    <div className="visual-grid">
      {records.map((rec) => {
        const coverVal = coverField ? getVal(rec, coverField.name) : null;
        const hasCover = coverVal && (String(coverVal).startsWith('data:image/') || String(coverVal).startsWith('http'));
        return (
          <div key={rec._id} className={`visual-card${hasCover ? ' visual-card--has-cover' : ''}`} onClick={() => onView(rec)}>
            {hasCover && <div className="visual-card-cover"><img src={coverVal} alt={coverField.label} /></div>}
            <div className="visual-card-body">
              {fields.filter(f => f !== coverField).slice(0, PREVIEW).map((f) => {
                const val = getVal(rec, f.name);
                return (
                  <div key={f.name} className="visual-field">
                    <span className="visual-field-label">{f.label}</span>
                    <span className="visual-field-value"><FieldValue f={f} val={val} compact /></span>
                  </div>
                );
              })}
              {fields.length > PREVIEW + (hasCover ? 1 : 0) && (
                <div className="visual-more">+{fields.length - PREVIEW - (hasCover ? 1 : 0)} полей</div>
              )}
            </div>
            <div className="visual-card-actions" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => onEdit(rec)} title="Редактировать"><Edit size={14} /></button>
              <button onClick={() => onDelete(rec._id)} className="danger" title="Удалить"><Trash2 size={14} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Table View ───────────────────────────────────────────────────────────────
function TableView({ records, fields, onEdit, onDelete, onView }) {
  const wrapRef = useRef(null);
  const trackRef = useRef(null);
  const [thumbStyle, setThumbStyle] = useState(null);

  const updateScrollbar = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const { scrollWidth, clientWidth, scrollLeft } = el;
    if (scrollWidth <= clientWidth + 2) { setThumbStyle(null); return; }
    const ratio = clientWidth / scrollWidth;
    const thumbW = Math.max(ratio * 100, 12);
    const maxLeft = 100 - thumbW;
    const scrollRatio = scrollLeft / (scrollWidth - clientWidth);
    setThumbStyle({ width: `${thumbW}%`, left: `${scrollRatio * maxLeft}%` });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    updateScrollbar();
    el.addEventListener('scroll', updateScrollbar);
    const ro = new ResizeObserver(updateScrollbar);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', updateScrollbar); ro.disconnect(); };
  }, [updateScrollbar, records]);

  const handleTrackClick = (e) => {
    const track = trackRef.current;
    const el = wrapRef.current;
    if (!track || !el) return;
    const rect = track.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    el.scrollLeft = ratio * (el.scrollWidth - el.clientWidth);
  };

  const handleThumbDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startScroll = wrapRef.current?.scrollLeft || 0;
    const track = trackRef.current;
    const el = wrapRef.current;
    if (!track || !el) return;
    // Dragging the thumb shouldn't ever select page text — browsers can start a
    // native text-selection drag from the same mousedown otherwise.
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (me) => {
      const rect = track.getBoundingClientRect();
      const dx = me.clientX - startX;
      const thumbW = (el.clientWidth / el.scrollWidth) * rect.width;
      el.scrollLeft = startScroll + (dx / (rect.width - thumbW)) * (el.scrollWidth - el.clientWidth);
    };
    const onUp = () => {
      document.body.style.userSelect = prevUserSelect;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <>
      <div className="table-wrap" ref={wrapRef}>
        <table className="data-table">
          <thead>
            <tr>
              {fields.map((f) => <th key={f.name}>{f.label}</th>)}
              <th className="actions-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {records.map((rec) => (
              <tr key={rec._id} className="table-row-clickable" onClick={() => onView(rec)}>
                {fields.map((f) => {
                  const val = getVal(rec, f.name);
                  return (
                    <td key={f.name} className={f.type === 'image' ? 'td-image-cell' : ''}>
                      <FieldValue f={f} val={val} compact />
                    </td>
                  );
                })}
                <td className="actions-col" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onEdit(rec)} title="Редактировать"><Edit size={14} /></button>
                  <button onClick={() => onDelete(rec._id)} className="danger" title="Удалить"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {thumbStyle && (
        <div className="fixed-hscroll" ref={trackRef} onClick={handleTrackClick}>
          <div
            className="fixed-hscroll-thumb"
            style={thumbStyle}
            onMouseDown={handleThumbDrag}
          />
        </div>
      )}
    </>
  );
}

// ── Calendar View ─────────────────────────────────────────────────────────────
const RU_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const RU_DAYS = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const RU_WEEKDAYS = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
const RU_MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function CalendarView({ records, fields, onView, onEdit, onDelete, onAddForDate }) {
  const today = new Date();
  const todayStr = toDateStr(today);
  const [current, setCurrent] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [dayModal, setDayModal] = useState(null); // dateStr | null

  const dateField = fields.find((f) => f.type === 'date') || fields.find((f) => f.name === 'date');
  const timeField = fields.find((f) => f.name === 'time');
  const chipFields = fields.filter((f) => f.name !== dateField?.name && f.name !== timeField?.name);

  const byDate = useMemo(() => {
    const map = {};
    for (const rec of records) {
      const raw = dateField ? getVal(rec, dateField.name) : null;
      if (!raw) continue;
      const key = String(raw).slice(0, 10);
      if (!map[key]) map[key] = [];
      map[key].push(rec);
    }
    return map;
  }, [records, dateField]);

  const year = current.getFullYear();
  const month = current.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;
  const totalCells = Math.ceil((startDow + lastDay.getDate()) / 7) * 7;

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const d = i - startDow + 1;
    cells.push(d >= 1 && d <= lastDay.getDate() ? new Date(year, month, d) : null);
  }

  const goToday = () => setCurrent(new Date(today.getFullYear(), today.getMonth(), 1));

  return (
    <div className="cal-wrap">
      {/* Month nav */}
      <div className="cal-nav-row">
        <button className="cal-nav-btn" onClick={() => setCurrent(new Date(year, month - 1, 1))}>
          <ChevronLeft size={18} />
        </button>
        <h3 className="cal-month-title">{RU_MONTHS[month]} {year}</h3>
        <button className="cal-nav-btn" onClick={() => setCurrent(new Date(year, month + 1, 1))}>
          <ChevronRight size={18} />
        </button>
        <button className="cal-today-btn" onClick={goToday}>Сегодня</button>
      </div>

      {/* Day names */}
      <div className="cal-daynames">
        {RU_DAYS.map((d, i) => (
          <div key={d} className={`cal-dayname${i >= 5 ? ' weekend' : ''}`}>{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="cal-grid">
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="cal-cell cal-cell--empty" />;
          const key = toDateStr(date);
          const dayRecs = byDate[key] || [];
          const dow = (date.getDay() + 6) % 7;
          return (
            <div
              key={i}
              className={`cal-cell${key === todayStr ? ' cal-cell--today' : ''}${dow >= 5 ? ' cal-cell--weekend' : ''}${dayRecs.length ? ' cal-cell--has' : ''}`}
              onClick={() => setDayModal(key)}
            >
              <div className="cal-date-num">{date.getDate()}</div>
              <div className="cal-chips">
                {dayRecs.slice(0, 3).map((rec, ri) => {
                  const t = timeField ? getVal(rec, timeField.name) : null;
                  const lbl = chipFields[0] ? getVal(rec, chipFields[0].name) : null;
                  return (
                    <div key={ri} className="cal-chip"
                      onClick={(e) => { e.stopPropagation(); onView(rec); }}>
                      {t && <span className="cal-chip-time">{t}</span>}
                      {lbl && <span className="cal-chip-lbl">{lbl}</span>}
                    </div>
                  );
                })}
                {dayRecs.length > 3 && <div className="cal-chip-more">+{dayRecs.length - 3}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Day popup modal */}
      {dayModal && (
        <DayModal
          dateStr={dayModal}
          recs={byDate[dayModal] || []}
          timeField={timeField}
          chipFields={chipFields}
          onClose={() => setDayModal(null)}
          onView={onView}
          onEdit={onEdit}
          onDelete={onDelete}
          onAdd={() => { setDayModal(null); onAddForDate(dayModal, null); }}
        />
      )}
    </div>
  );
}

function DayModal({ dateStr, recs, timeField, chipFields, onClose, onView, onEdit, onDelete, onAdd }) {
  const d = new Date(dateStr + 'T12:00:00');
  const title = `${d.getDate()} ${RU_MONTHS_GEN[d.getMonth()]}, ${RU_WEEKDAYS[d.getDay()]}`;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box day-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2><CalendarDays size={20} /> {title}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-add-record" style={{ padding: '7px 14px', fontSize: 13 }} onClick={onAdd}>
              <Plus size={14} /> Событие
            </button>
            <button className="modal-close" onClick={onClose}><X size={20} /></button>
          </div>
        </div>
        <div className="modal-body day-modal-body">
          {recs.length === 0 ? (
            <div className="cal-day-empty" style={{ padding: '30px 0' }}>
              <CalendarDays size={36} />
              <p>Нет событий на этот день</p>
              <button onClick={onAdd}>Добавить событие</button>
            </div>
          ) : (
            <div className="cal-day-events">
              {recs.map((rec) => {
                const timeVal = timeField ? getVal(rec, timeField.name) : null;
                return (
                  <div key={rec._id} className="cal-event-card" onClick={() => { onClose(); onView(rec); }}>
                    {timeVal && <div className="cec-time">{timeVal}</div>}
                    <div className="cec-fields">
                      {chipFields.slice(0, 5).map((f) => {
                        const v = getVal(rec, f.name);
                        if (!v) return null;
                        return (
                          <div key={f.name} className="cec-row">
                            <span className="cec-label">{f.label}</span>
                            <span className="cec-value">{v}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="cec-actions" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { onClose(); onEdit(rec); }} title="Редактировать"><Edit size={13} /></button>
                      <button className="danger" onClick={() => { onDelete(rec._id); }} title="Удалить"><Trash2 size={13} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Week View ─────────────────────────────────────────────────────────────────
const WEEK_START_H = 8;
const WORKER_FIELD_NAMES_SHARED = ['worker', 'master', 'barber', 'employee', 'specialist', 'stylist', 'мастер', 'сотрудник', 'барбер'];
const WEEK_END_H = 21;
const SLOT_MINS = 30;
const EVENT_COLORS = [
  'linear-gradient(135deg,#667eea,#764ba2)',
  'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)',
  'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)',
];

function parseTimeToMin(val) {
  if (!val) return null;
  const m = String(val).match(/(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
}

// Stable color derived from worker name (same name → same color always)
function workerColor(name) {
  if (!name) return EVENT_COLORS[0];
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (h * 33 ^ name.charCodeAt(i)) >>> 0;
  return EVENT_COLORS[h % EVENT_COLORS.length];
}

function WeekView({ records, fields, onView, onEdit, onDelete, onAddForDate }) {
  const today = new Date();
  const todayStr = toDateStr(today);

  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date(today);
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const dateField = fields.find((f) => f.type === 'date') || fields.find((f) => f.name === 'date');
  const timeField = fields.find((f) => f.name === 'time' || f.type === 'time');
  const workerField = fields.find((f) => WORKER_FIELD_NAMES_SHARED.includes(f.name.toLowerCase()));
  const labelField = fields.find((f) => f !== dateField && f !== timeField && f !== workerField && f.type === 'text');

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  }), [weekStart]);

  // Group records by dateStr, each with parsed startMin
  const byDate = useMemo(() => {
    const map = {};
    for (const rec of records) {
      const raw = dateField ? getVal(rec, dateField.name) : null;
      if (!raw) continue;
      const key = String(raw).slice(0, 10);
      const startMin = timeField ? parseTimeToMin(getVal(rec, timeField.name)) : null;
      const wName = workerField ? (getVal(rec, workerField.name) || '') : '';
      if (!map[key]) map[key] = [];
      map[key].push({ rec, startMin, wName });
    }
    return map;
  }, [records, dateField, timeField, workerField]);

  const slots = useMemo(() => {
    const s = [];
    for (let h = WEEK_START_H; h < WEEK_END_H; h++) {
      s.push({ h, m: 0 });
      s.push({ h, m: SLOT_MINS });
    }
    return s;
  }, []);

  // Current time indicator
  const [nowMin, setNowMin] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    }, 60000);
    return () => clearInterval(id);
  }, []);

  const weekEnd = weekDays[6];
  const weekLabel = weekStart.getMonth() === weekEnd.getMonth()
    ? `${weekStart.getDate()}–${weekEnd.getDate()} ${RU_MONTHS_GEN[weekStart.getMonth()]} ${weekStart.getFullYear()}`
    : `${weekStart.getDate()} ${RU_MONTHS_GEN[weekStart.getMonth()]} – ${weekEnd.getDate()} ${RU_MONTHS_GEN[weekEnd.getMonth()]} ${weekEnd.getFullYear()}`;

  const goWeek = (delta) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(d);
  };
  const goNow = () => {
    const d = new Date(today);
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    d.setHours(0, 0, 0, 0);
    setWeekStart(d);
  };

  const todayIsInWeek = weekDays.some((d) => toDateStr(d) === todayStr);
  const scrollRef = useRef(null);

  // Auto-scroll to current time on mount
  useEffect(() => {
    if (!scrollRef.current) return;
    const slotH = 30; // px per 30-min slot
    const slotsFromTop = Math.max(0, (nowMin - WEEK_START_H * 60) / SLOT_MINS - 2);
    scrollRef.current.scrollTop = slotsFromTop * slotH;
  }, []);

  return (
    <div className="week-wrap">
      <div className="cal-nav-row">
        <button className="cal-nav-btn" onClick={() => goWeek(-1)}><ChevronLeft size={18} /></button>
        <h3 className="cal-month-title" style={{ minWidth: 240, textAlign: 'center' }}>{weekLabel}</h3>
        <button className="cal-nav-btn" onClick={() => goWeek(1)}><ChevronRight size={18} /></button>
        <button className="cal-today-btn" onClick={goNow}>Эта неделя</button>
      </div>

      <div className="week-scroll" ref={scrollRef}>
        <div className="week-grid">
          {/* Column headers */}
          <div className="week-gutter week-gutter--header" />
          {weekDays.map((day, di) => {
            const key = toDateStr(day);
            const isToday = key === todayStr;
            const isWeekend = di >= 5;
            return (
              <div key={key} className={`week-col-header${isToday ? ' week-col-header--today' : ''}${isWeekend ? ' week-col-header--weekend' : ''}`}>
                <span className="week-col-dayname">{RU_DAYS[di]}</span>
                <span className={`week-col-daynum${isToday ? ' week-col-daynum--today' : ''}`}>{day.getDate()}</span>
              </div>
            );
          })}

          {/* Time slots body */}
          {slots.map(({ h, m }, si) => {
            const slotMin = h * 60 + m;
            const isHour = m === 0;
            const timeLabel = isHour ? `${String(h).padStart(2, '0')}:00` : '';
            return (
              <React.Fragment key={si}>
              <div className={`week-gutter${isHour ? ' week-gutter--hour' : ''}`}>
                {timeLabel && <span className="week-gutter-label">{timeLabel}</span>}
              </div>
              {weekDays.map((day, di) => {
                const key = toDateStr(day);
                const isToday = key === todayStr;
                const isWeekend = di >= 5;
                const events = (byDate[key] || []).filter(({ startMin }) => {
                  if (startMin === null) return si === 0;
                  return startMin >= slotMin && startMin < slotMin + SLOT_MINS;
                });
                const showNow = isToday && todayIsInWeek && isHour && h === Math.floor(nowMin / 60);
                return (
                  <div
                    key={`${key}-${si}`}
                    className={`week-slot${isHour ? ' week-slot--hour' : ''}${isToday ? ' week-slot--today' : ''}${isWeekend ? ' week-slot--weekend' : ''}`}
                    onClick={() => {
                      const ts = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                      onAddForDate(key, ts);
                    }}
                  >
                    {showNow && (
                      <div
                        className="week-now-line"
                        style={{ top: `${((nowMin % 60) / 60) * 100}%` }}
                      />
                    )}
                    {events.map(({ rec, wName }, ri) => {
                      const lbl = labelField ? getVal(rec, labelField.name) : null;
                      const tval = timeField ? getVal(rec, timeField.name) : null;
                      return (
                        <div
                          key={ri}
                          className="week-event"
                          style={{ background: workerColor(wName) }}
                          onClick={(e) => { e.stopPropagation(); onView(rec); }}
                        >
                          {tval && <span className="week-event-time">{tval}</span>}
                          {wName && <span className="week-event-worker">{wName}</span>}
                          {lbl && <span className="week-event-lbl">{lbl}</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Day View (with worker columns) ────────────────────────────────────────────
const WORKER_FIELD_NAMES = WORKER_FIELD_NAMES_SHARED;

function loadScheduleConfig(schemaName) {
  try { return JSON.parse(localStorage.getItem(`schedule_cfg_${schemaName}`) || 'null') || {}; }
  catch { return {}; }
}
function saveScheduleConfig(schemaName, cfg) {
  localStorage.setItem(`schedule_cfg_${schemaName}`, JSON.stringify(cfg));
}

function DayView({ records, fields, schemaName, apiKey, onView, onEdit, onDelete, onAddForDate }) {
  const today = new Date();
  const todayStr = toDateStr(today);
  const [dateStr, setDateStr] = useState(todayStr);
  const [config, setConfig] = useState(() => loadScheduleConfig(schemaName));
  const [showConfig, setShowConfig] = useState(false);

  // Sync config from server on mount
  useEffect(() => {
    axios.get(`${API_URL}/data/schedule-config`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((res) => {
        const serverCfg = res.data?.configs?.[schemaName];
        if (!serverCfg) return;
        // Convert workers array to object map
        const workersMap = {};
        for (const w of (serverCfg.workers || [])) {
          const { name, ...rest } = w;
          workersMap[name] = rest;
        }
        const merged = { workerField: serverCfg.workerField || '', workers: workersMap };
        setConfig(merged);
        saveScheduleConfig(schemaName, merged);
      })
      .catch(() => {});
  }, [schemaName]);

  const workerField = useMemo(() => {
    const explicit = config.workerField;
    if (explicit) return fields.find((f) => f.name === explicit) || null;
    return fields.find((f) => WORKER_FIELD_NAMES.includes(f.name.toLowerCase())) || null;
  }, [fields, config]);

  const dateField = fields.find((f) => f.type === 'date');
  const timeField = fields.find((f) => f.name === 'time' || f.type === 'time');
  const labelField = fields.find((f) => f !== dateField && f !== timeField && f !== workerField && f.type === 'text');

  const dayRecords = useMemo(() => {
    return records
      .filter((rec) => {
        const raw = dateField ? getVal(rec, dateField.name) : null;
        return raw && String(raw).slice(0, 10) === dateStr;
      })
      .map((rec) => ({
        rec,
        startMin: timeField ? parseTimeToMin(getVal(rec, timeField.name)) : null,
        worker: workerField ? (getVal(rec, workerField.name) || '') : '',
      }));
  }, [records, dateField, timeField, workerField, dateStr]);

  const configWorkers = config.workers || {};
  const recordWorkers = [...new Set(dayRecords.map((d) => d.worker).filter(Boolean))];
  const allWorkers = [...new Set([...Object.keys(configWorkers), ...recordWorkers])];

  // Worker filter (shown when > 6 workers)
  const [hiddenWorkers, setHiddenWorkers] = useState(new Set());
  const toggleWorker = (name) => setHiddenWorkers((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const visWorkers = allWorkers.length
    ? allWorkers.filter((w) => !hiddenWorkers.has(w))
    : [''];
  const workers = visWorkers.length ? visWorkers : [''];

  const slots = useMemo(() => {
    const s = [];
    for (let h = WEEK_START_H; h < WEEK_END_H; h++) {
      s.push({ h, m: 0 });
      s.push({ h, m: SLOT_MINS });
    }
    return s;
  }, []);

  const [nowMin, setNowMin] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    }, 60000);
    return () => clearInterval(id);
  }, []);

  const scrollRef = useRef(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    const slotsFromTop = Math.max(0, (nowMin - WEEK_START_H * 60) / SLOT_MINS - 2);
    scrollRef.current.scrollTop = slotsFromTop * 30;
  }, []);

  const isToday = dateStr === todayStr;
  const dayDate = new Date(dateStr + 'T00:00:00');
  const dayDow = (dayDate.getDay() + 6) % 7;
  const dayLabel = `${RU_DAYS[dayDow]}, ${dayDate.getDate()} ${RU_MONTHS_GEN[dayDate.getMonth()]} ${dayDate.getFullYear()}`;

  const goDay = (delta) => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    setDateStr(toDateStr(d));
  };

  const updateConfig = (newCfg) => {
    setConfig(newCfg);
    saveScheduleConfig(schemaName, newCfg);
    // Sync to server for AI awareness
    const workersArr = Object.entries(newCfg.workers || {}).map(([name, cfg]) => ({ name, ...cfg }));
    axios.put(`${API_URL}/data/schedule-config/${encodeURIComponent(schemaName)}`,
      { workerField: newCfg.workerField || '', workers: workersArr },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    ).catch(() => {});
  };

  const isWorking = (workerName, h, m) => {
    const wCfg = configWorkers[workerName];
    if (!wCfg) return true;
    const { days = [0, 1, 2, 3, 4], startH = 9, endH = 18 } = wCfg;
    if (!days.includes(dayDow)) return false;
    const slotMin = h * 60 + m;
    return slotMin >= startH * 60 && slotMin < endH * 60;
  };

  const WORKER_COL_W = 140; // px min per column

  return (
    <div className="week-wrap">
      <div className="cal-nav-row">
        <button className="cal-nav-btn" onClick={() => goDay(-1)}><ChevronLeft size={18} /></button>
        <h3 className="cal-month-title" style={{ minWidth: 200, textAlign: 'center' }}>{dayLabel}</h3>
        <button className="cal-nav-btn" onClick={() => goDay(1)}><ChevronRight size={18} /></button>
        <button className="cal-today-btn" onClick={() => setDateStr(todayStr)}>Сегодня</button>
        <button className="cal-nav-btn" onClick={() => setShowConfig(true)} title="Настройки расписания">
          <Settings size={16} />
        </button>
      </div>

      {/* Worker filter chips (shown when 5+ workers) */}
      {allWorkers.length >= 5 && (
        <div className="day-worker-filter">
          {allWorkers.map((w) => {
            const active = !hiddenWorkers.has(w);
            return (
              <button
                key={w || '__none'}
                className={`day-filter-chip${active ? ' active' : ''}`}
                style={active ? { background: workerColor(w), border: 'none' } : {}}
                onClick={() => toggleWorker(w)}
              >
                {w || 'Без мастера'}
              </button>
            );
          })}
          {hiddenWorkers.size > 0 && (
            <button className="day-filter-chip day-filter-chip--reset" onClick={() => setHiddenWorkers(new Set())}>
              Все
            </button>
          )}
        </div>
      )}

      <div className="week-scroll" ref={scrollRef}>
        <div className="day-grid" style={{ gridTemplateColumns: `52px repeat(${workers.length}, minmax(${WORKER_COL_W}px, 1fr))` }}>
          {/* Column headers */}
          <div className="week-gutter week-gutter--header" />
          {workers.map((w) => {
            const wCfg = configWorkers[w];
            const offToday = wCfg && !wCfg.days?.includes(dayDow);
            return (
              <div key={w || '__none'} className={`week-col-header day-worker-header${offToday ? ' day-worker-header--off' : ''}`}>
                <span className="day-worker-name">{w || 'Все'}</span>
                {wCfg && !offToday && (
                  <span className="day-worker-hours">
                    {`${String(wCfg.startH ?? 9).padStart(2, '0')}:00–${String(wCfg.endH ?? 18).padStart(2, '0')}:00`}
                  </span>
                )}
                {offToday && <span className="day-worker-off">выходной</span>}
              </div>
            );
          })}

          {/* Time slots body */}
          {slots.map(({ h, m }, si) => {
            const slotMin = h * 60 + m;
            const isHour = m === 0;
            const timeLabel = isHour ? `${String(h).padStart(2, '0')}:00` : '';
            const showNow = isToday && isHour && h === Math.floor(nowMin / 60);
            return (
              <React.Fragment key={si}>
                <div className={`week-gutter${isHour ? ' week-gutter--hour' : ''}`}>
                  {timeLabel && <span className="week-gutter-label">{timeLabel}</span>}
                </div>
                {workers.map((w) => {
                  const working = isWorking(w, h, m);
                  const events = dayRecords.filter((d) => {
                    const match = w === '' ? !d.worker : d.worker === w;
                    if (!match) return false;
                    if (d.startMin === null) return si === 0;
                    return d.startMin >= slotMin && d.startMin < slotMin + SLOT_MINS;
                  });
                  return (
                    <div
                      key={w || '__none'}
                      className={`week-slot${isHour ? ' week-slot--hour' : ''}${!working ? ' week-slot--offhours' : ''}`}
                      onClick={() => {
                        if (!working) return;
                        const ts = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                        onAddForDate(dateStr, ts, workerField && w ? { [workerField.name]: w } : {});
                      }}
                    >
                      {showNow && (
                        <div className="week-now-line" style={{ top: `${((nowMin % 60) / 60) * 100}%` }} />
                      )}
                      {events.map(({ rec }, ri) => {
                        const lbl = labelField ? getVal(rec, labelField.name) : null;
                        const tval = timeField ? getVal(rec, timeField.name) : null;
                        return (
                          <div
                            key={ri}
                            className="week-event"
                            style={{ background: workerColor(w || null) }}
                            onClick={(e) => { e.stopPropagation(); onView(rec); }}
                          >
                            {tval && <span className="week-event-time">{tval}</span>}
                            {lbl && <span className="week-event-lbl">{lbl}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {showConfig && (
        <WorkerConfigModal
          fields={fields}
          config={config}
          workers={allWorkers}
          onSave={(cfg) => { updateConfig(cfg); setShowConfig(false); }}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  );
}

function WorkerConfigModal({ fields, config, workers, onSave, onClose }) {
  const [workerField, setWorkerField] = useState(config.workerField || '');
  const [wCfg, setWCfg] = useState(() => {
    const base = config.workers || {};
    const result = { ...base };
    for (const w of workers) {
      if (w && !result[w]) result[w] = { days: [0, 1, 2, 3, 4], startH: 9, endH: 18 };
    }
    return result;
  });
  const [newWorker, setNewWorker] = useState('');
  const textFields = fields.filter((f) => f.type === 'text' || !f.type);
  const workerList = Object.keys(wCfg);

  const toggleDay = (workerName, day) => {
    setWCfg((prev) => {
      const cur = prev[workerName] || { days: [0, 1, 2, 3, 4], startH: 9, endH: 18 };
      const days = cur.days.includes(day) ? cur.days.filter((d) => d !== day) : [...cur.days, day].sort((a, b) => a - b);
      return { ...prev, [workerName]: { ...cur, days } };
    });
  };

  const setHour = (workerName, key, val) => {
    setWCfg((prev) => {
      const cur = prev[workerName] || { days: [0, 1, 2, 3, 4], startH: 9, endH: 18 };
      return { ...prev, [workerName]: { ...cur, [key]: Math.max(0, Math.min(24, parseInt(val) || 0)) } };
    });
  };

  const addWorker = () => {
    const name = newWorker.trim();
    if (!name || wCfg[name]) return;
    setWCfg((prev) => ({ ...prev, [name]: { days: [0, 1, 2, 3, 4], startH: 9, endH: 18 } }));
    setNewWorker('');
  };

  const removeWorker = (name) => {
    setWCfg((prev) => { const next = { ...prev }; delete next[name]; return next; });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box worker-cfg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Settings size={18} />Настройки расписания</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body worker-cfg-body">
          <div className="wcfg-section">
            <label className="wcfg-label">Поле «Мастер / Сотрудник»</label>
            <select
              value={workerField}
              onChange={(e) => setWorkerField(e.target.value)}
              className="wcfg-select"
            >
              <option value="">Авто-определение</option>
              {textFields.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
            </select>
          </div>

          <div className="wcfg-section">
            <label className="wcfg-label">Рабочие часы по мастерам</label>
            <div className="wcfg-workers-list">
              {workerList.map((w) => {
                const cfg = wCfg[w] || { days: [0, 1, 2, 3, 4], startH: 9, endH: 18 };
                return (
                  <div key={w} className="wcfg-worker-card">
                    <div className="wcfg-worker-head">
                      <span className="wcfg-worker-name">{w}</span>
                      <button className="wcfg-remove-btn" onClick={() => removeWorker(w)}><Trash2 size={13} /></button>
                    </div>
                    <div className="wcfg-days">
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <button
                          key={d}
                          className={`wcfg-day-btn${cfg.days.includes(d) ? ' active' : ''}`}
                          onClick={() => toggleDay(w, d)}
                        >
                          {RU_DAYS[d]}
                        </button>
                      ))}
                    </div>
                    <div className="wcfg-hours">
                      <span className="wcfg-hours-label">С</span>
                      <input type="number" min={0} max={23} value={cfg.startH ?? 9} onChange={(e) => setHour(w, 'startH', e.target.value)} className="wcfg-hour-input" />
                      <span className="wcfg-hours-label">:00 до</span>
                      <input type="number" min={0} max={24} value={cfg.endH ?? 18} onChange={(e) => setHour(w, 'endH', e.target.value)} className="wcfg-hour-input" />
                      <span className="wcfg-hours-label">:00</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="wcfg-add-row">
              <input
                type="text"
                placeholder="Имя мастера..."
                value={newWorker}
                onChange={(e) => setNewWorker(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addWorker()}
                className="wcfg-add-input"
              />
              <button className="btn-primary-grad wcfg-add-btn" onClick={addWorker}><Plus size={14} /></button>
            </div>
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '14px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn-outline" onClick={onClose}>Отмена</button>
          <button className="btn-primary-grad" onClick={() => onSave({ workerField, workers: wCfg })}>
            <Check size={14} /> Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Image Lightbox ────────────────────────────────────────────────────────────
function ImageLightbox({ src, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Закрыть">
        <X size={18} />
      </button>
      <img
        className="lightbox-img"
        src={src}
        alt="preview"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ── Record Detail Modal ───────────────────────────────────────────────────────
function RecordDetailModal({ record, schema, onEdit, onClose }) {
  const fields = schema.fields || [];
  const [lightboxSrc, setLightboxSrc] = useState(null);

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <span className="detail-schema-icon">{schema.icon}</span>
            {schema.label}
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-outline" style={{ padding: '6px 14px', fontSize: 13 }} onClick={onEdit}>
              <Edit size={14} /> Редактировать
            </button>
            <button className="modal-close" onClick={onClose}><X size={20} /></button>
          </div>
        </div>
        <div className="modal-body detail-body">
          {fields.map((f) => {
            const val = getVal(record, f.name);
            return (
              <div key={f.name} className={`detail-field${f.type === 'image' ? ' detail-field--image' : ''}`}>
                <span className="detail-field-label">{f.label}</span>
                <span className="detail-field-value">
                  {val == null || val === '' ? <span className="null-val">—</span> : <FieldValue f={f} val={val} onImageClick={setLightboxSrc} />}
                </span>
              </div>
            );
          })}
          {/* Show any extra fields from the record not in schema */}
          {Object.keys(record.data || {})
            .filter((k) => k !== 'data' && !fields.find((f) => f.name === k))
            .map((k) => {
              const v = record.data[k];
              const vs = String(v);
              const isUrl = vs.startsWith('http');
              return (
                <div key={k} className="detail-field extra">
                  <span className="detail-field-label">{k}</span>
                  <span className="detail-field-value">
                    {isUrl ? <a href={vs} target="_blank" rel="noopener noreferrer" className="td-url-link">{vs.length > 60 ? vs.slice(0, 57) + '…' : vs}</a> : vs}
                  </span>
                </div>
              );
            })}
        </div>
      </div>
    </div>
    </>
  );
}

// ── JSON View ────────────────────────────────────────────────────────────────
function JsonView({ records }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(records.map((r) => r.data), null, 2);
  const handleCopy = () => {
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="json-view">
      <div className="json-header">
        <span>{records.length} записей</span>
        <button onClick={handleCopy}>
          {copied ? <><Check size={14} /> Скопировано</> : 'Копировать'}
        </button>
      </div>
      <pre className="json-body"><code>{json}</code></pre>
    </div>
  );
}

// ── Export Modal ─────────────────────────────────────────────────────────────
function ExportModal({ apiKey, schemas, onClose }) {
  const [format, setFormat] = useState('xlsx');
  const [schema, setSchema] = useState(schemas[0]?.name || '');
  const [loading, setLoading] = useState(false);

  const needsSchema = format === 'csv';

  const handleExport = async () => {
    setLoading(true);
    try {
      const params = { format };
      if (needsSchema && schema) params.schema = schema;
      const res = await axios.get(`${API_URL}/data/export`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params,
        responseType: 'blob',
      });
      const extMap = { csv: 'csv', json: 'json', xlsx: 'xlsx', mysql: 'sql', postgresql: 'sql' };
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      const disp = res.headers['content-disposition'];
      let filename = `siberiai-export.${extMap[format] || 'txt'}`;
      if (disp) { const m = disp.match(/filename="?(.+?)"?$/i); if (m) filename = m[1]; }
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      alert('Ошибка экспорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  };

  const formats = [
    { id: 'xlsx', label: 'Excel', desc: 'Все схемы, правильные типы', icon: '📊' },
    { id: 'json', label: 'JSON', desc: 'Все схемы и записи', icon: '{ }' },
    { id: 'csv', label: 'CSV', desc: 'Одна схема — текстовый', icon: '⊞' },
    { id: 'mysql', label: 'MySQL', desc: 'SQL дамп для MySQL', icon: '🐬' },
    { id: 'postgresql', label: 'PostgreSQL', desc: 'SQL дамп для PostgreSQL', icon: '🐘' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2><Download size={20} /> Экспорт данных</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">Выберите формат для экспорта</p>
          <div className="format-grid">
            {formats.map((f) => (
              <button
                key={f.id}
                className={`format-card ${format === f.id ? 'selected' : ''}`}
                onClick={() => setFormat(f.id)}
              >
                <span className="format-icon">{f.icon}</span>
                <span className="format-label">{f.label}</span>
                <span className="format-desc">{f.desc}</span>
                {format === f.id && <Check size={14} className="format-check" />}
              </button>
            ))}
          </div>

          {needsSchema && (
            <div className="export-schema-select">
              <label>Схема для экспорта</label>
              <div className="select-wrap">
                <select value={schema} onChange={(e) => setSchema(e.target.value)}>
                  {schemas.map((s) => (
                    <option key={s.name} value={s.name}>{s.label} ({s.name})</option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-outline" onClick={onClose}>Отмена</button>
          <button className="btn-primary-grad" onClick={handleExport} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
            Скачать
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Schema Form ──────────────────────────────────────────────────────────────
function SchemaForm({ apiKey, schema, onClose }) {
  const [formData, setFormData] = useState({
    name: schema?.name || '',
    label: schema?.label || '',
    description: schema?.description || '',
    icon: schema?.icon || '📋',
    color: schema?.color || '#667eea',
    fields: schema?.fields || [{ name: '', label: '', type: 'text', required: false, options: [] }],
  });
  const [loading, setLoading] = useState(false);

  const addField = () =>
    setFormData({ ...formData, fields: [...formData.fields, { name: '', label: '', type: 'text', required: false, options: [] }] });

  const removeField = (i) =>
    setFormData({ ...formData, fields: formData.fields.filter((_, idx) => idx !== i) });

  const updateField = (i, key, val) => {
    const fields = [...formData.fields];
    fields[i] = { ...fields[i], [key]: val };
    setFormData({ ...formData, fields });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const url = schema ? `${API_URL}/data/schemas/${schema.name}` : `${API_URL}/data/schemas`;
      const method = schema ? 'put' : 'post';
      await axios[method](url, formData, { headers: { Authorization: `Bearer ${apiKey}` } });
      onClose();
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box schema-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{schema ? 'Редактировать схему' : 'Создать схему'}</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-row">
              <div className="form-group">
                <label>Имя (латиницей)</label>
                <input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  pattern="[a-zA-Z0-9_]+"
                  placeholder="my_schema"
                  disabled={!!schema}
                />
              </div>
              <div className="form-group">
                <label>Название</label>
                <input
                  value={formData.label}
                  onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                  required
                  placeholder="Мои данные"
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group icon-field">
                <label>Иконка</label>
                <input
                  value={formData.icon}
                  onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
                  placeholder="📋"
                />
              </div>
              <div className="form-group color-field">
                <label>Цвет</label>
                <input
                  type="color"
                  value={formData.color}
                  onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label>Описание</label>
              <textarea
                rows={2}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Краткое описание схемы"
              />
            </div>

            <div className="fields-section">
              <div className="fields-header">
                <span>Поля ({formData.fields.length})</span>
                <button type="button" className="btn-add-field" onClick={addField}>
                  <Plus size={14} /> Добавить поле
                </button>
              </div>
              <div className="fields-list">
                {formData.fields.map((field, i) => (
                  <div key={i} className="field-row">
                    <input
                      placeholder="имя (en)"
                      value={field.name}
                      onChange={(e) => updateField(i, 'name', e.target.value)}
                      pattern="[a-zA-Z0-9_]*"
                    />
                    <input
                      placeholder="Название"
                      value={field.label}
                      onChange={(e) => updateField(i, 'label', e.target.value)}
                    />
                    <select value={field.type} onChange={(e) => updateField(i, 'type', e.target.value)}>
                      <option value="text">Текст</option>
                      <option value="number">Число</option>
                      <option value="boolean">Да/Нет</option>
                      <option value="date">Дата</option>
                      <option value="url">URL</option>
                      <option value="image">Изображение</option>
                      <option value="file">Файл</option>
                    </select>
                    <button type="button" className="remove-field" onClick={() => removeField(i)}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-outline" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary-grad" disabled={loading}>
              {loading ? <Loader2 size={16} className="spin" /> : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Floating Dock ─────────────────────────────────────────────────────────────
function PageJumper({ current, total, loading, onJump }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const inputRef = useRef(null);

  const startEdit = () => {
    setVal(String(current));
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 0);
  };

  const commit = () => {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n >= 1 && n <= total && n !== current) onJump(n);
    setEditing(false);
  };

  return (
    <div className="pag-jumper">
      <button
        className="pag-btn"
        onClick={() => onJump(current - 1)}
        disabled={current <= 1 || loading}
      >
        <ChevronLeft size={15} />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          className="pag-input"
          type="number"
          min={1}
          max={total}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span
          className="pag-info pag-clickable"
          onClick={startEdit}
          title="Нажмите, чтобы перейти к нужной странице"
        >
          {current} / {total}
        </span>
      )}

      <button
        className="pag-btn"
        onClick={() => onJump(current + 1)}
        disabled={current >= total || loading}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

function GoogleIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function FloatingDock({ selectedSchema, fields, viewMode, setViewMode, onCreateSchema, onImportFile, onImportSheets, onImportExternalDb, onImportOneC, currentPage, totalPages, loadingRecords, onPageChange, userPlan }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hasDate = fields.some((f) => f.type === 'date');
  const sheetsAllowed = userPlan === 'pro' || userPlan === 'premium';
  return (
    <div className="floating-dock data__foot">
      {totalPages > 1 && (
        <div className="data__pg">
          <PageJumper
            current={currentPage}
            total={totalPages}
            loading={loadingRecords}
            onJump={onPageChange}
          />
        </div>
      )}
      {selectedSchema && (
        <div className="data__views">
          {hasDate && (
            <>
              <button
                className={`vbtn${viewMode === 'day' ? ' vbtn--on' : ''}`}
                onClick={() => setViewMode('day')}
                title="День (по мастерам)"
              >
                <Clock size={16} />
              </button>
              <button
                className={`vbtn${viewMode === 'week' ? ' vbtn--on' : ''}`}
                onClick={() => setViewMode('week')}
                title="Неделя"
              >
                <CalendarRange size={16} />
              </button>
              <button
                className={`vbtn${viewMode === 'calendar' ? ' vbtn--on' : ''}`}
                onClick={() => setViewMode('calendar')}
                title="Месяц"
              >
                <CalendarDays size={16} />
              </button>
            </>
          )}
          <button
            className={`vbtn${viewMode === 'visual' ? ' vbtn--on' : ''}`}
            onClick={() => setViewMode('visual')}
            title="Карточки"
          >
            <Grid3x3 size={16} />
          </button>
          <button
            className={`vbtn${viewMode === 'table' ? ' vbtn--on' : ''}`}
            onClick={() => setViewMode('table')}
            title="Таблица"
          >
            <Table2 size={16} />
          </button>
          <button
            className={`vbtn${viewMode === 'json' ? ' vbtn--on' : ''}`}
            onClick={() => setViewMode('json')}
            title="JSON"
          >
            <Code2 size={16} />
          </button>
        </div>
      )}
      <div className="data__imp">
        {/* Desktop: "+" create schema button */}
        <button className="src dock-desktop-only" onClick={onCreateSchema} title="Создать схему">
          <Plus size={15} />
          <span>Схема</span>
        </button>
        {/* Mobile: Google Sheets button replacing "+" */}
        <button
          className={`src dock-mobile-only${!sheetsAllowed ? ' dock-btn--disabled' : ''}`}
          onClick={sheetsAllowed ? onImportSheets : undefined}
          title={sheetsAllowed ? 'Google Sheets' : 'Доступно на тарифе Pro / Premium'}
          disabled={!sheetsAllowed}
        >
          <GoogleIcon size={15} />
          <span>Google Sheets</span>
        </button>
        <button className="src" onClick={onImportFile} title="Загрузить Excel / CSV">
          <Upload size={15} style={{ color: '#217346' }} />
          <span>Excel / CSV</span>
        </button>
        <button className="src dock-desktop-only" onClick={onImportSheets} title="Подключить Google Sheets">
          <GoogleIcon size={15} />
          <span>Google Sheets</span>
        </button>
        <button className="src dock-desktop-only" onClick={onImportExternalDb} title="Синхронизация с MongoDB / PostgreSQL">
          <Database size={15} style={{ color: '#10b981' }} />
          <span>Внешняя БД</span>
        </button>
        <button className="src dock-desktop-only" onClick={onImportOneC} title="Синхронизация с 1С:Предприятие">
          <OneCDockIcon />
          <span>1C</span>
        </button>
        <button className="src src--ic" onClick={() => navigate('/settings')} title="Настройки AI">
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
}

// ── Embed Modal ───────────────────────────────────────────────────────────────
function EmbedModal({ apiKey, selectedSchema, onClose }) {
  const base = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1').replace('/api/v1', '');
  const schemaName = selectedSchema?.name || '{schema_name}';
  const [copiedKey, setCopiedKey] = useState(null);

  const copySnippet = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fetchSnippet = `// JavaScript (fetch)
const response = await fetch(
  '${base}/api/v1/data/records/${schemaName}',
  { headers: { Authorization: 'Bearer ${apiKey}' } }
);
const { records } = await response.json();`;

  const nodeSnippet = `// Node.js (axios)
const axios = require('axios');
const { data } = await axios.get(
  '${base}/api/v1/data/records/${schemaName}',
  { headers: { Authorization: 'Bearer ${apiKey}' } }
);
console.log(data.records);`;

  const phpSnippet = `<?php
$ch = curl_init('${base}/api/v1/data/records/${schemaName}');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
  'Authorization: Bearer ${apiKey}'
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$data = json_decode(curl_exec($ch), true);
$records = $data['records'];`;

  const widgetSnippet = `<!-- Виджет AI-помощника на вашем сайте -->
<script>
(function(){
  var s=document.createElement('script');
  s.src='${base}/siberi-sdk.js';
  s.onload=function(){ SiberiAI.init({ apiKey: '${apiKey}' }); };
  document.head.appendChild(s);
})();
</script>`;

  const snippets = [
    { key: 'js', label: 'JavaScript', tag: 'JS', code: fetchSnippet },
    { key: 'node', label: 'Node.js', tag: 'Node', code: nodeSnippet },
    { key: 'php', label: 'PHP', tag: 'PHP', code: phpSnippet },
    { key: 'widget', label: 'AI-виджет', tag: 'HTML', code: widgetSnippet },
  ];

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box embed-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2><Globe size={20} /> Подключить к сайту</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body">
          <p className="embed-intro">
            Используйте ваш API-ключ для запросов к данным прямо с вашего сервера или сайта.
            Данные доступны через REST API с авторизацией.
          </p>

          <div className="embed-key-row">
            <span className="embed-key-label">API-ключ</span>
            <code className="embed-key-code">{apiKey}</code>
            <button className="embed-copy-btn" onClick={() => copySnippet('apikey', apiKey)}>
              {copiedKey === 'apikey' ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>

          {selectedSchema && (
            <div className="embed-schema-hint">
              Выбрана схема: <strong>{selectedSchema.label}</strong> <code>({selectedSchema.name})</code>
            </div>
          )}

          <div className="embed-snippets">
            {snippets.map(({ key, label, tag, code }) => (
              <div key={key} className="embed-snippet">
                <div className="embed-snippet__head">
                  <span className="embed-snippet__tag">{tag}</span>
                  <span className="embed-snippet__label">{label}</span>
                  <button className="embed-copy-btn" onClick={() => copySnippet(key, code)}>
                    {copiedKey === key ? <><Check size={13} /> Скопировано</> : <><Copy size={13} /> Копировать</>}
                  </button>
                </div>
                <pre className="embed-snippet__pre"><code>{code}</code></pre>
              </div>
            ))}
          </div>

          <div className="embed-note">
            <strong>Безопасность:</strong> не публикуйте API-ключ в публичном frontend-коде.
            Используйте его только на вашем сервере или через переменные окружения.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Import File Modal (Excel / CSV — one-time) ────────────────────────────────
function ImportFileModal({ apiKey, onClose, onImported }) {
  const [dragOver, setDragOver] = useState(false);
  const [originalFile, setOriginalFile] = useState(null);
  const [parseResult, setParseResult] = useState(null);
  const [selectedSheetIdx, setSelectedSheetIdx] = useState(0);
  const [schemaName, setSchemaName] = useState('');
  const [schemaLabel, setSchemaLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext)) {
      alert('Поддерживаются: .xlsx, .xls, .csv');
      return;
    }
    setLoading(true);
    setParseResult(null);
    setOriginalFile(file);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await axios.post(`${API_URL}/integrations/excel/parse`, fd, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'multipart/form-data' },
      });
      setParseResult(res.data);
      setSelectedSheetIdx(0);
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'import';
      setSchemaName(base);
      setSchemaLabel(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      alert('Ошибка: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const sheet = parseResult?.sheets?.[selectedSheetIdx];
  const multiSheet = (parseResult?.sheets?.length ?? 0) > 1;

  // Send original file to server so ALL rows are imported (not just 200-row preview)
  const buildImportFd = (sName, sLabel, sheetIdx) => {
    const fd = new FormData();
    fd.append('file', originalFile);
    fd.append('schemaName', sName);
    fd.append('schemaLabel', sLabel);
    fd.append('sheetIndex', String(sheetIdx));
    return fd;
  };

  const handleImport = async () => {
    if (!sheet || !schemaName.trim() || !originalFile) return;
    setImporting(true);
    const sName = schemaName.trim();
    try {
      const res = await axios.post(`${API_URL}/integrations/excel/import`,
        buildImportFd(sName, schemaLabel.trim() || sName, selectedSheetIdx),
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'multipart/form-data' } }
      );
      onImported(res.data.schemaName || sName);
      onClose();
    } catch (err) {
      alert('Ошибка импорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setImporting(false);
    }
  };

  const handleImportAll = async () => {
    if (!originalFile || !schemaName.trim()) return;
    setImporting(true);
    const sName = schemaName.trim();
    const fd = new FormData();
    fd.append('file', originalFile);
    fd.append('schemaName', sName);
    fd.append('schemaLabel', schemaLabel.trim() || sName);
    fd.append('sheetIndex', 'all');
    try {
      const res = await axios.post(`${API_URL}/integrations/excel/import`, fd,
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'multipart/form-data' } }
      );
      onImported(res.data.schemaName || sName);
      onClose();
    } catch (err) {
      alert('Ошибка импорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2><Upload size={20} /> Загрузить Excel / CSV</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body">
          {!parseResult ? (
            <div
              className={`file-drop-zone${dragOver ? ' drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              {loading ? (
                <><Loader2 size={36} className="spin" style={{ color: '#667eea' }} /><p>Обработка файла...</p></>
              ) : (
                <>
                  <Upload size={36} style={{ color: '#a0aec0' }} />
                  <p className="drop-main">Перетащите файл сюда</p>
                  <p className="drop-sub">или нажмите для выбора · .xlsx · .xls · .csv</p>
                </>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; }}
              />
            </div>
          ) : (
            <>
              {parseResult.sheets.length > 1 && (
                <div className="sheet-tabs">
                  {parseResult.sheets.map((s, i) => (
                    <button
                      key={i}
                      className={`sheet-tab${selectedSheetIdx === i ? ' active' : ''}`}
                      onClick={() => setSelectedSheetIdx(i)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="import-meta">
                <span className="import-filename">📄 {parseResult.filename}</span>
                <span className="import-count">{sheet?.total ?? 0} строк · {sheet?.headers?.length ?? 0} колонок</span>
                {sheet?.truncated && <span className="import-truncated">предпросмотр: 200 строк</span>}
              </div>

              {sheet && (
                <div className="preview-table-wrap">
                  <table className="preview-table">
                    <thead>
                      <tr>{sheet.headers.map((h) => <th key={h}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(0, 8).map((row, i) => (
                        <tr key={i}>
                          {sheet.headers.map((h) => <td key={h}>{row[h] ?? ''}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="import-schema-row">
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label>Имя схемы <span style={{ color: '#a0aec0', fontWeight: 400 }}>(латиница, цифры, _)</span></label>
                  <input
                    value={schemaName}
                    onChange={(e) => setSchemaName(e.target.value)}
                    pattern="[a-zA-Z0-9_]+"
                    placeholder="my_import"
                    required
                  />
                </div>
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label>Название</label>
                  <input
                    value={schemaLabel}
                    onChange={(e) => setSchemaLabel(e.target.value)}
                    placeholder="Мой импорт"
                  />
                </div>
              </div>
            </>
          )}
        </div>
        {parseResult && (
          <div className="modal-footer">
            <button className="btn-outline" onClick={() => { setParseResult(null); setOriginalFile(null); }}>← Назад</button>
            {multiSheet && (
              <button
                className="btn-outline"
                onClick={handleImportAll}
                disabled={importing || !schemaName.trim()}
                title={`Импортировать все ${parseResult.sheets.length} листа как отдельные схемы`}
              >
                {importing ? <Loader2 size={16} className="spin" /> : '📑'}
                Все листы ({parseResult.sheets.length})
              </button>
            )}
            <button
              className="btn-primary-grad"
              onClick={handleImport}
              disabled={importing || !schemaName.trim() || !sheet || !originalFile}
            >
              {importing ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
              {sheet?.total ? `Импортировать (${sheet.total} записей)` : 'Импортировать'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[а-яёa-z0-9]+/gi, (m) => m)
    .replace(/[^a-z0-9а-яё]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/[а-яё]/g, '') || 'sheet';
}

// ── Import Sheets Modal (Google Sheets — auto-sync) ───────────────────────────
function ImportSheetsModal({ apiKey, onClose, onSynced }) {
  const [url, setUrl] = useState('');
  const [fetchResult, setFetchResult] = useState(null);
  const [selectedTab, setSelectedTab] = useState('');
  const [schemaName, setSchemaName] = useState('');
  const [schemaLabel, setSchemaLabel] = useState('Google Sheet');
  const [direction, setDirection] = useState('import');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const abortRef = useRef(null);

  const handleFetch = async (tab) => {
    const sheetName = tab !== undefined ? tab : selectedTab;
    if (!url.trim()) return;

    // Cancel any in-flight request
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setFetchError('');
    try {
      const res = await axios.post(
        `${API_URL}/integrations/sheets/fetch`,
        { url: url.trim(), sheetName: sheetName || null },
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal }
      );
      setFetchResult(res.data);
      if (!schemaName) setSchemaName('sheet_' + Date.now());
    } catch (err) {
      if (axios.isCancel(err)) return; // superseded by newer click
      setFetchError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (tab) => {
    setSelectedTab(tab);
    handleFetch(tab);
  };

  const handleSaveSync = async () => {
    if (!url.trim() || !schemaName.trim()) return;
    setSaving(true);
    const sName = schemaName.trim();
    try {
      await axios.post(`${API_URL}/integrations/sync/save`, {
        schemaName: sName,
        sourceUrl: url.trim(),
        sheetName: selectedTab || null,
        direction,
      }, { headers: { Authorization: `Bearer ${apiKey}` } });
      onSynced(sName);
      onClose();
    } catch (err) {
      setFetchError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAll = async () => {
    const tabs = fetchResult?.tabs;
    if (!tabs?.length || !url.trim()) return;
    setSaving(true);
    setFetchError('');
    try {
      const sheets = tabs.map((t, i) => ({
        sheetName: t,
        schemaName: (slugify(t) || `sheet_${i}`) + '_' + Date.now().toString(36).slice(-4),
        schemaLabel: t,
      }));
      const res = await axios.post(`${API_URL}/integrations/sync/save-all`, {
        sourceUrl: url.trim(),
        sheets,
      }, { headers: { Authorization: `Bearer ${apiKey}` } });
      res.data.results?.forEach(r => onSynced(r.schemaName));
      onClose();
    } catch (err) {
      setFetchError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const multiTab = (fetchResult?.tabs?.length ?? 0) > 1;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2><span style={{ fontSize: 20 }}>📊</span> Подключить Google Sheets</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">
            Вставьте ссылку на таблицу. Данные будут обновляться автоматически каждый раз при входе и раз в сутки.
          </p>

          <div className="sheets-url-row">
            <input
              className="sheets-url-input"
              type="url"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleFetch(); }}
            />
            <button
              className="btn-primary-grad"
              onClick={() => handleFetch()}
              disabled={loading || !url.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              {loading ? <Loader2 size={16} className="spin" /> : 'Просмотр'}
            </button>
          </div>

          {fetchError && (
            <div className="sheets-inline-error">{fetchError}</div>
          )}

          {fetchResult && (
            <>
              {fetchResult.tabs?.length > 1 && (
                <div className="sheet-tabs">
                  {fetchResult.tabs.map((t) => (
                    <button
                      key={t}
                      className={`sheet-tab${selectedTab === t || (!selectedTab && t === fetchResult.tabs[0]) ? ' active' : ''}`}
                      onClick={() => handleTabChange(t)}
                      disabled={loading}
                    >
                      {loading && (selectedTab === t) ? <Loader2 size={11} className="spin" style={{ marginRight: 4 }} /> : null}
                      {t}
                    </button>
                  ))}
                </div>
              )}

              {fetchResult.empty ? (
                <div className="sheets-empty-hint">Лист пустой или не содержит заголовков</div>
              ) : (
                <>
                  <div className="import-meta">
                    <span className="import-count">{fetchResult.total} строк · {fetchResult.headers?.length} колонок</span>
                    {fetchResult.truncated && <span className="import-truncated">предпросмотр: 200 строк</span>}
                  </div>

                  <div className="preview-table-wrap">
                    <table className="preview-table">
                      <thead>
                        <tr>{fetchResult.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {fetchResult.rows.slice(0, 8).map((row, i) => (
                          <tr key={i}>
                            {fetchResult.headers.map((h, j) => <td key={j}>{row[h] ?? ''}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {!multiTab && (
                <div className="import-schema-row">
                  <div className="form-group" style={{ margin: 0, flex: 1 }}>
                    <label>Имя схемы <span style={{ color: '#a0aec0', fontWeight: 400 }}>(латиница, цифры, _)</span></label>
                    <input
                      value={schemaName}
                      onChange={(e) => setSchemaName(e.target.value)}
                      pattern="[a-zA-Z0-9_]+"
                      placeholder="google_sheet"
                      required
                    />
                  </div>
                  <div className="form-group" style={{ margin: 0, flex: 1 }}>
                    <label>Название</label>
                    <input
                      value={schemaLabel}
                      onChange={(e) => setSchemaLabel(e.target.value)}
                      placeholder="Google Sheet"
                    />
                  </div>
                </div>
              )}

              {multiTab && (
                <div className="sheets-all-hint">
                  <span>📌 В таблице {fetchResult.tabs.length} листов — можно подключить все сразу, каждый станет отдельной схемой.</span>
                </div>
              )}
            </>
          )}
        </div>

        {fetchResult && (
          <div style={{ padding: '0 24px 8px', background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: '#475569', margin: '12px 0 8px' }}>Направление синхронизации</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[
                { id: 'import', label: '← Только получать', hint: 'Sheets → Siberi', icon: '↓' },
                { id: 'bidirectional', label: '↔ Двустороннее', hint: 'Изменения в обе стороны', icon: '↔' },
              ].map(opt => (
                <button key={opt.id} onClick={() => setDirection(opt.id)}
                  style={{
                    flex: 1, padding: '8px 6px', borderRadius: 8,
                    border: `2px solid ${direction === opt.id ? '#6366f1' : '#e5e7eb'}`,
                    background: direction === opt.id ? '#eef2ff' : '#fff',
                    color: direction === opt.id ? '#4f46e5' : '#6b7280',
                    fontWeight: direction === opt.id ? 700 : 400,
                    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                    transition: 'all 0.15s', textAlign: 'center',
                  }}>
                  <div style={{ fontSize: 16, marginBottom: 2 }}>{opt.icon}</div>
                  <div style={{ fontWeight: 600 }}>{opt.label}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{opt.hint}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {fetchResult && (
          <div className="modal-footer">
            <button className="btn-outline" onClick={onClose}>Отмена</button>
            {multiTab ? (
              <>
                <button
                  className="btn-outline"
                  onClick={handleSaveSync}
                  disabled={saving || fetchResult.empty}
                  title="Подключить только текущий лист"
                >
                  {saving ? <Loader2 size={16} className="spin" /> : '🔗'}
                  Этот лист
                </button>
                <button
                  className="btn-primary-grad"
                  onClick={handleSaveAll}
                  disabled={saving}
                >
                  {saving ? <Loader2 size={16} className="spin" /> : '📊'}
                  Все листы ({fetchResult.tabs.length})
                </button>
              </>
            ) : (
              <button
                className="btn-primary-grad"
                onClick={handleSaveSync}
                disabled={saving || !schemaName.trim() || fetchResult.empty}
              >
                {saving ? <Loader2 size={16} className="spin" /> : '🔗'}
                Подключить (авто-синхронизация)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Record Form ──────────────────────────────────────────────────────────────
// ── Compress image via Canvas (client-side, max 800px, JPEG 0.65) ─────────────
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 800;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.65));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Read file as base64 ───────────────────────────────────────────────────────
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

// ── File metadata format: "filename;;base64data" ──────────────────────────────
function encodeFile(name, base64) { return `${name};;${base64}`; }
function decodeFile(val) {
  if (!val || typeof val !== 'string') return null;
  const idx = val.indexOf(';;');
  if (idx === -1) return null;
  return { name: val.slice(0, idx), data: val.slice(idx + 2) };
}

const FILE_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB

function RecordForm({ apiKey, schema, record, prefillData, onClose }) {
  const [formData, setFormData] = useState(
    record
      ? { ...record.data }
      : {
          ...schema.fields.reduce((acc, f) => ({ ...acc, [f.name]: '' }), {}),
          ...(prefillData || {}),
        }
  );
  const [loading, setLoading] = useState(false);
  const [uploadingField, setUploadingField] = useState(null);

  const handleImageChange = async (fieldName, file) => {
    if (!file) return;
    if (file.size > FILE_SIZE_LIMIT) { alert('Файл слишком большой (максимум 5 МБ)'); return; }
    setUploadingField(fieldName);
    try {
      const compressed = await compressImage(file);
      setFormData(prev => ({ ...prev, [fieldName]: compressed }));
    } catch { alert('Ошибка при обработке изображения'); }
    finally { setUploadingField(null); }
  };

  const handleFileChange = async (fieldName, file) => {
    if (!file) return;
    if (file.size > FILE_SIZE_LIMIT) { alert('Файл слишком большой (максимум 5 МБ)'); return; }
    setUploadingField(fieldName);
    try {
      const b64 = await readFileAsBase64(file);
      setFormData(prev => ({ ...prev, [fieldName]: encodeFile(file.name, b64) }));
    } catch { alert('Ошибка при чтении файла'); }
    finally { setUploadingField(null); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const url = record
        ? `${API_URL}/data/records/${schema.name}/${record._id}`
        : `${API_URL}/data/records/${schema.name}`;
      const method = record ? 'put' : 'post';
      await axios[method](url, { data: formData }, { headers: { Authorization: `Bearer ${apiKey}` } });
      onClose();
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box record-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{record ? 'Редактировать запись' : `Новая запись — ${schema.label}`}</h2>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {schema.fields.map((field) => {
              const val = formData[field.name];
              return (
                <div key={field.name} className="form-group">
                  <label>{field.label}{field.required && <span className="required">*</span>}</label>
                  {field.type === 'boolean' ? (
                    <select value={val || ''} onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}>
                      <option value="">—</option>
                      <option value="true">Да</option>
                      <option value="false">Нет</option>
                    </select>
                  ) : field.type === 'image' ? (
                    <div className="field-image-upload">
                      {val && (val.startsWith('data:image/') || val.startsWith('http')) && (
                        <div className="field-image-preview">
                          <img src={val} alt={field.label} />
                          <button type="button" className="field-image-remove" onClick={() => setFormData({ ...formData, [field.name]: '' })} title="Удалить">×</button>
                        </div>
                      )}
                      <label className="field-upload-btn">
                        {uploadingField === field.name ? <Loader2 size={14} className="spin" /> : <>{val ? '📷 Заменить' : '📷 Загрузить'}</>}
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => e.target.files[0] && handleImageChange(field.name, e.target.files[0])} />
                      </label>
                      {val && val.startsWith('http') && <input type="url" value={val} onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })} placeholder="или вставьте URL" className="field-url-fallback" />}
                    </div>
                  ) : field.type === 'file' ? (
                    <div className="field-file-upload">
                      {val && (() => { const f = decodeFile(val); return f ? (
                        <div className="field-file-info">
                          <span className="field-file-icon">📎</span>
                          <span className="field-file-name">{f.name}</span>
                          <button type="button" onClick={() => setFormData({ ...formData, [field.name]: '' })} title="Удалить" className="field-file-remove">×</button>
                        </div>
                      ) : null; })()}
                      <label className="field-upload-btn">
                        {uploadingField === field.name ? <Loader2 size={14} className="spin" /> : <>{val ? '📎 Заменить файл' : '📎 Загрузить файл'}</>}
                        <input type="file" style={{ display: 'none' }} onChange={(e) => e.target.files[0] && handleFileChange(field.name, e.target.files[0])} />
                      </label>
                    </div>
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'}
                      value={val || ''}
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      required={field.required}
                      placeholder={field.label}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-outline" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary-grad" disabled={loading || !!uploadingField}>
              {loading ? <Loader2 size={16} className="spin" /> : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── ExternalDbModal — sync from MongoDB / PostgreSQL ─────────────────────────
function ExternalDbModal({ apiKey, onClose, onImported }) {
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
  const [dbType, setDbType]         = useState('mongodb');
  const [connStr, setConnStr]       = useState('');
  const [collections, setCollections] = useState([]);
  const [selectedColl, setSelectedColl] = useState('');
  const [schemaName, setSchemaName] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(true); // default: sync mode
  const [direction, setDirection]   = useState('import'); // import | bidirectional
  const [step, setStep]             = useState('connect'); // connect | select | done
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [importedCount, setImportedCount] = useState(0);

  const headers = () => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  const handleConnect = async () => {
    setError('');
    if (!connStr.trim()) { setError('Введите строку подключения'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/integrations/external-db/test`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ connectionString: connStr.trim(), type: dbType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка подключения');
      const items = data.collections || data.tables || [];
      setCollections(items);
      setSelectedColl(items[0] || '');
      setSchemaName(items[0] ? items[0].toLowerCase().replace(/[^a-z0-9_]/g, '_') : '');
      setStep('select');
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const handleImport = async () => {
    setError('');
    if (!selectedColl || !schemaName.trim()) { setError('Выберите коллекцию и укажите имя схемы'); return; }
    setLoading(true);
    try {
      const endpoint = syncEnabled
        ? `${API_URL}/integrations/external-db/sync/save`
        : `${API_URL}/integrations/external-db/import`;
      const res = await fetch(endpoint, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({
          connectionString: connStr.trim(), type: dbType, dbType,
          collection: selectedColl, schemaName: schemaName.trim(),
          direction: syncEnabled ? direction : 'import',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка');
      setImportedCount(data.imported);
      setStep('done');
      onImported(schemaName.trim());
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const DB_TYPES = [
    { id: 'mongodb',    label: 'MongoDB',    color: '#059669', bg: '#ecfdf5', border: '#6ee7b7' },
    { id: 'postgresql', label: 'PostgreSQL', color: '#2563eb', bg: '#eff6ff', border: '#93c5fd' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <Database size={20} style={{ color: '#10b981' }} />
          <div>
            <span>Синхронизация с внешней БД</span>
            <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', fontWeight: 400 }}>
              MongoDB и PostgreSQL — данные обновляются автоматически
            </p>
          </div>
          <button className="modal-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="onec-security-badge onec-security-badge--top">
          <Shield size={13} />
          Безопасно — строка подключения хранится в зашифрованном виде и не передаётся третьим лицам
        </div>
        <div className="modal-body">
          {step === 'done' ? (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <CheckCircle2 size={48} style={{ color: '#10b981', marginBottom: 16 }} />
              <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
                {syncEnabled ? 'Синхронизация включена!' : 'Импортировано!'}
              </p>
              <p style={{ color: '#6b7280' }}>{importedCount} записей → схема «{schemaName}»</p>
              {syncEnabled ? (
                <p style={{ color: '#059669', fontSize: 13, marginTop: 10, fontWeight: 500 }}>
                  <RefreshCw size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  Данные будут автоматически обновляться каждую ночь
                </p>
              ) : (
                <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 8 }}>
                  Разовый снимок. Чтобы обновить — повторите импорт.
                </p>
              )}
              <button className="btn-primary-grad" style={{ marginTop: 24 }} onClick={onClose}>Готово</button>
            </div>
          ) : step === 'select' ? (
            <>
              <div className="form-group">
                <label>Коллекция / таблица</label>
                <select value={selectedColl} onChange={e => {
                  setSelectedColl(e.target.value);
                  setSchemaName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
                }}>
                  {collections.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Имя схемы в Siberi</label>
                <input value={schemaName} onChange={e => setSchemaName(e.target.value)} placeholder="my_schema" />
                <span style={{ fontSize: 12, color: '#9ca3af' }}>Только латиница, цифры, _</span>
              </div>

              {/* Sync toggle */}
              <div className="extdb-sync-toggle" onClick={() => setSyncEnabled(v => !v)}>
                <div className={`extdb-sync-toggle__track${syncEnabled ? ' on' : ''}`}>
                  <div className="extdb-sync-toggle__thumb" />
                </div>
                <div>
                  <p className="extdb-sync-toggle__label">
                    {syncEnabled ? <><RefreshCw size={13} /> Автосинхронизация включена</> : <><Database size={13} /> Разовый импорт</>}
                  </p>
                  <p className="extdb-sync-toggle__hint">
                    {syncEnabled
                      ? 'Данные будут обновляться автоматически каждую ночь'
                      : 'Данные импортируются один раз — снимок на сейчас'}
                  </p>
                </div>
              </div>

              {/* Direction selector — показываем только если sync включён */}
              {syncEnabled && (
                <div style={{ marginTop: 12, background: '#f8fafc', borderRadius: 10, padding: '12px 14px', border: '1px solid #e2e8f0' }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8 }}>Направление синхронизации</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[
                      { id: 'import', label: '← Только получать', hint: 'Изменения в БД → Siberi', icon: '↓' },
                      { id: 'bidirectional', label: '↔ Двустороннее', hint: 'Изменения в обе стороны', icon: '↔' },
                    ].map(opt => (
                      <button key={opt.id} onClick={() => setDirection(opt.id)}
                        style={{
                          flex: 1, padding: '8px 6px', borderRadius: 8,
                          border: `2px solid ${direction === opt.id ? '#6366f1' : '#e5e7eb'}`,
                          background: direction === opt.id ? '#eef2ff' : '#fff',
                          color: direction === opt.id ? '#4f46e5' : '#6b7280',
                          fontWeight: direction === opt.id ? 700 : 400,
                          cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                          transition: 'all 0.15s', textAlign: 'center',
                        }}>
                        <div style={{ fontSize: 16, marginBottom: 2 }}>{opt.icon}</div>
                        <div style={{ fontWeight: 600 }}>{opt.label}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{opt.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {error && <div className="import-error"><AlertCircle size={14} />{error}</div>}
              <div className="modal-footer" style={{ marginTop: 16 }}>
                <button className="btn-outline" onClick={() => setStep('connect')}>Назад</button>
                <button className="btn-primary-grad" onClick={handleImport} disabled={loading}>
                  {loading ? <Loader2 size={16} className="spin" /> : <Database size={16} />}
                  {syncEnabled ? 'Включить синхронизацию' : 'Импортировать'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {DB_TYPES.map(t => (
                  <button key={t.id} onClick={() => setDbType(t.id)}
                    style={{
                      flex: 1, padding: '10px 8px', borderRadius: 10, border: '2px solid',
                      borderColor: dbType === t.id ? t.border : '#e5e7eb',
                      background: dbType === t.id ? t.bg : '#fff',
                      color: dbType === t.id ? t.color : '#6b7280',
                      fontWeight: 700, cursor: 'pointer', fontSize: 14,
                      transition: 'all 0.15s', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', gap: 7,
                      fontFamily: 'inherit',
                    }}>
                    <Database size={16} style={{ color: dbType === t.id ? t.color : '#9ca3af' }} />
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="form-group">
                <label>Строка подключения</label>
                <input
                  value={connStr}
                  onChange={e => setConnStr(e.target.value)}
                  placeholder={dbType === 'mongodb'
                    ? 'mongodb+srv://user:pass@cluster.mongodb.net/dbname'
                    : 'postgresql://user:pass@host:5432/dbname'}
                  style={{ fontFamily: 'monospace', fontSize: 13 }}
                />
              </div>
              {error && <div className="import-error"><AlertCircle size={14} />{error}</div>}
              <div className="modal-footer" style={{ marginTop: 16 }}>
                <button className="btn-outline" onClick={onClose}>Отмена</button>
                <button className="btn-primary-grad" onClick={handleConnect} disabled={loading}>
                  {loading ? <Loader2 size={16} className="spin" /> : <Database size={16} />}
                  Подключиться
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small inline icon for dock button ────────────────────────────────────────
function OneCDockIcon() {
  return (
    <img src="/1c-logo.png" alt="1С" width={18} height={11}
      style={{ objectFit: 'contain', display: 'block' }} />
  );
}

// ── OneCModal ─────────────────────────────────────────────────────────────────
const API_URL_1C = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1');

function OneCModal({ apiKey, onClose, onSynced }) {
  const [tab, setTab]           = useState('webhook');
  const [cfg, setCfg]           = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [error, setError]       = useState('');
  const [syncResult, setSyncResult] = useState(null); // { count, schema }
  const [entities, setEntities] = useState([]);

  const [schemaName, setSchemaName]       = useState('1c_данные');
  const [odataUrl, setOdataUrl]           = useState('');
  const [odataLogin, setOdataLogin]       = useState('');
  const [odataPassword, setOdataPassword] = useState('');
  const [odataEntity, setOdataEntity]     = useState('');

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL_1C}/1c/config`, { headers });
        const d = await r.json();
        if (d.success) {
          setCfg(d.onec);
          setSchemaName(d.onec.schemaName || '1c_данные');
          setTab(d.onec.mode || 'webhook');
          setOdataUrl(d.onec.odataUrl || '');
          setOdataLogin(d.onec.odataLogin || '');
          setOdataEntity(d.onec.odataEntity || '');
        }
      } catch { setError('Не удалось загрузить конфигурацию'); }
      setLoading(false);
    })();
  }, []);

  // Auto-derive schema name from entity selection
  const handleEntityChange = (val) => {
    setOdataEntity(val);
    if (val) {
      const derived = val
        .replace(/^(Catalog_|Document_|InformationRegister_|AccumulationRegister_)/, '')
        .toLowerCase();
      setSchemaName(derived || '1c_данные');
    }
  };

  const handleRegenToken = async () => {
    if (!window.confirm('Старый код перестанет работать. Продолжить?')) return;
    const r = await fetch(`${API_URL_1C}/1c/regen-token`, { method: 'POST', headers });
    const d = await r.json();
    if (d.success) setCfg(prev => ({ ...prev, webhookToken: d.webhookToken }));
  };

  // Save + copy in one action for webhook
  const handleCopyCode = async () => {
    setError('');
    // Auto-save schema name silently before copying
    await fetch(`${API_URL_1C}/1c/config`, {
      method: 'POST', headers,
      body: JSON.stringify({ schemaName, mode: 'webhook' }),
    }).catch(() => {});
    setCfg(prev => ({ ...prev, schemaName, mode: 'webhook' }));
    navigator.clipboard.writeText(buildCode());
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 3000);
  };

  // Connect to OData + auto-save
  const handleConnect = async () => {
    if (!odataUrl.trim()) { setError('Введите URL 1С-сервера'); return; }
    setConnecting(true); setError(''); setEntities([]);
    try {
      const r = await fetch(`${API_URL_1C}/1c/test-odata`, {
        method: 'POST', headers,
        body: JSON.stringify({ odataUrl, odataLogin, odataPassword }),
      });
      const d = await r.json();
      if (d.success) {
        setEntities(d.entities || []);
        // Auto-save connection settings
        await fetch(`${API_URL_1C}/1c/config`, {
          method: 'POST', headers,
          body: JSON.stringify({ mode: 'odata', odataUrl, odataLogin, odataPassword }),
        }).catch(() => {});
      } else setError(d.error || 'Не удалось подключиться');
    } catch { setError('Ошибка сети'); }
    setConnecting(false);
  };

  const handleSync = async () => {
    if (!odataEntity) { setError('Выберите что синхронизировать'); return; }
    setSyncing(true); setError(''); setSyncResult(null);
    // Save entity + schema name first
    await fetch(`${API_URL_1C}/1c/config`, {
      method: 'POST', headers,
      body: JSON.stringify({ schemaName, mode: 'odata', odataUrl, odataLogin, odataPassword, odataEntity }),
    }).catch(() => {});
    try {
      const r = await fetch(`${API_URL_1C}/1c/sync-odata`, { method: 'POST', headers });
      const d = await r.json();
      if (d.success) {
        setSyncResult({ count: d.imported, schema: d.schemaName });
        if (onSynced) onSynced(d.schemaName);
      } else setError(d.error || 'Ошибка синхронизации');
    } catch { setError('Ошибка сети'); }
    setSyncing(false);
  };

  const buildCode = () => {
    const host = window.location.hostname;
    const token = cfg?.webhookToken || 'TOKEN';
    return `// Вставьте в модуль объекта 1С
// (например, в событие "При записи" нужного справочника или документа)

Процедура ОтправитьВSiberiAI() Экспорт
    ЗащЛоединение = Новый ЗащищенноеСоединениеOpenSSL();
    Соед = Новый HTTPСоединение(
        "${host}", 443, , , , , ЗащЛоединение);
    Запрос = Новый HTTPЗапрос(
        "/api/v1/1c/push/${token}");
    Запрос.Заголовки.Вставить("Content-Type", "application/json");

    // Замените поля на нужные вам:
    Зап = Новый Структура(
        "Наименование,Цена,Количество",
        Наименование, Цена, Количество);
    Данные = Новый Массив();
    Данные.Добавить(Зап);

    Запрос.УстановитьТелоИзСтроки(
        ФорматЖон.ЗаписатьЗначение(Данные),
        КодировкаТекста.UTF8);
    Соед.ОтправитьДляОбработки(Запрос);
КонецПроцедуры

// Вызовите в обработчике события "ПриЗаписи":
// ОтправитьВSiberiAI();`;
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 580 }}>

        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/1c-logo.png" alt="1С" height={22} style={{ objectFit: 'contain' }} />
            <span style={{ fontWeight: 700, fontSize: 17 }}>Синхронизация с 1С:Предприятие</span>
          </div>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', animation: 'fadeIn 0.18s ease' }}><Loader2 size={28} className="spin" /></div>
        ) : (
          <div className="onec-tab-content">
            <div className="onec-security-badge onec-security-badge--top">
              <Shield size={13} />
              Безопасно — только вы знаете свой токен, данные передаются по HTTPS
            </div>

            <div className="onec-tabs">
              <button className={`onec-tab${tab === 'webhook' ? ' onec-tab--active' : ''}`} onClick={() => { setTab('webhook'); setError(''); }}>
                <Link2 size={14} /> Webhook
                <span className="onec-tab-hint">Локальная 1С</span>
              </button>
              <button className={`onec-tab${tab === 'odata' ? ' onec-tab--active' : ''}`} onClick={() => { setTab('odata'); setError(''); }}>
                <Globe size={14} /> OData
                <span className="onec-tab-hint">Сервер в интернете</span>
              </button>
            </div>

            <div className="onec-body">

              {/* ── WEBHOOK TAB ─────────────────────────────────── */}
              {tab === 'webhook' && (
                <div className="onec-tab-content">
                  <div className="onec-auto-badge">
                    <Zap size={13} />
                    Данные приходят автоматически каждый раз при сохранении объекта в 1С
                  </div>

                  <div className="onec-steps">
                    <div className="onec-step">
                      <span className="onec-step-num">1</span>
                      <div className="onec-step-body">
                        <p className="onec-step-title">Укажите имя для данных</p>
                        <input
                          className="onec-input"
                          placeholder="1c_данные"
                          value={schemaName}
                          onChange={e => setSchemaName(e.target.value.replace(/\s/g, '_').toLowerCase())}
                        />
                        <p className="onec-hint">Под этим именем данные появятся в «Мои данные»</p>
                      </div>
                    </div>

                    <div className="onec-step">
                      <span className="onec-step-num">2</span>
                      <div className="onec-step-body">
                        <p className="onec-step-title">Скопируйте готовый код</p>
                        <pre className="onec-code">{buildCode()}</pre>
                        <button className="onec-primary-btn" onClick={handleCopyCode}>
                          {codeCopied
                            ? <><CheckCircle2 size={15} /> Скопировано!</>
                            : <><Copy size={15} /> Скопировать код</>}
                        </button>
                      </div>
                    </div>

                    <div className="onec-step">
                      <span className="onec-step-num">3</span>
                      <div className="onec-step-body">
                        <p className="onec-step-title">Вставьте код в 1С</p>
                        <p className="onec-hint" style={{ margin: 0 }}>
                          Откройте <strong>Конфигуратор 1С</strong> → найдите нужный справочник или документ →
                          откройте его модуль → вставьте код в обработчик события <strong>«ПриЗаписи»</strong>.
                          Готово — данные будут автоматически поступать в Siberi AI.
                        </p>
                      </div>
                    </div>
                  </div>

                  {cfg?.lastSync && (
                    <div className="onec-lastsync">
                      <CheckCircle2 size={13} style={{ color: '#16a34a' }} />
                      Последняя синхронизация: {new Date(cfg.lastSync).toLocaleString('ru-RU')}
                      {cfg.lastSyncCount != null && ` · ${cfg.lastSyncCount} записей`}
                    </div>
                  )}

                  <button className="onec-regen-btn" onClick={handleRegenToken}>
                    <RefreshCw size={12} /> Сбросить токен
                  </button>
                </div>
              )}

              {/* ── ODATA TAB ───────────────────────────────────── */}
              {tab === 'odata' && (
                <div className="onec-tab-content">
                  <div className="onec-auto-badge">
                    <Zap size={13} />
                    Siberi AI подключается к вашему серверу и принимает данные напрямую
                  </div>

                  <div className="onec-steps">
                    <div className="onec-step">
                      <span className="onec-step-num">1</span>
                      <div className="onec-step-body">
                        <p className="onec-step-title">Введите адрес 1С-сервера</p>
                        <input
                          className="onec-input"
                          placeholder="http://ваш-сервер/база/odata/standard.odata/"
                          value={odataUrl}
                          onChange={e => { setOdataUrl(e.target.value); setEntities([]); }}
                        />
                        <div className="onec-row2" style={{ marginTop: 8 }}>
                          <input className="onec-input" placeholder="Логин (необязательно)" value={odataLogin} onChange={e => setOdataLogin(e.target.value)} />
                          <input className="onec-input" type="password" placeholder="Пароль" value={odataPassword} onChange={e => setOdataPassword(e.target.value)} />
                        </div>
                        <button className="onec-primary-btn" onClick={handleConnect} disabled={connecting} style={{ marginTop: 10 }}>
                          {connecting
                            ? <><Loader2 size={14} className="spin" /> Подключение…</>
                            : <><Plug size={14} /> Подключить и получить список данных</>}
                        </button>
                      </div>
                    </div>

                    {entities.length > 0 && (
                      <div className="onec-step">
                        <span className="onec-step-num">2</span>
                        <div className="onec-step-body">
                          <p className="onec-step-title">Выберите что синхронизировать</p>
                          <select
                            className="onec-input"
                            value={odataEntity}
                            onChange={e => handleEntityChange(e.target.value)}
                          >
                            <option value="">— выберите справочник или документ —</option>
                            {entities.map(e => <option key={e} value={e}>{e}</option>)}
                          </select>
                          {odataEntity && (
                            <p className="onec-hint">
                              Данные сохранятся в схему <strong>«{schemaName}»</strong>
                            </p>
                          )}
                          <button
                            className="onec-primary-btn"
                            style={{ marginTop: 10 }}
                            onClick={handleSync}
                            disabled={syncing || !odataEntity}
                          >
                            {syncing
                              ? <><Loader2 size={14} className="spin" /> Загружаю данные…</>
                              : <><RefreshCw size={14} /> Синхронизировать сейчас</>}
                          </button>
                        </div>
                      </div>
                    )}

                    {syncResult && (
                      <div className="onec-success" style={{ marginTop: 0 }}>
                        <CheckCircle2 size={14} />
                        Готово! Загружено {syncResult.count} записей в схему «{syncResult.schema}»
                      </div>
                    )}
                  </div>
                </div>
              )}

              {error && <div className="onec-error"><AlertCircle size={14} /> {error}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
