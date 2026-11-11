import { BarChart3 } from 'lucide-react';
import './Analytics.css';

/* Раздел «Аналитика» — новый в редизайне. Пока дизайн-заглушка «Скоро»:
   полноценный экран (KPI, динамика, каналы, воронка, качество) требует
   отдельных аналитических эндпоинтов бэкенда и делается следующим этапом. */
export default function Analytics() {
  const items = [
    ['KPI с дельтами', 'Запросы, пользователи, конверсия и выручка — с динамикой за период'],
    ['Динамика и каналы', 'График активности по дням и разбивка по Telegram / VK / сайту / API'],
    ['Воронка и retention', 'Путь клиента, новые/вернувшиеся, удержание'],
    ['Качество ответов', 'Топ-вопросы, пробелы базы знаний, оценка ответов AI'],
  ];
  return (
    <div className="an-stub">
      <div className="card an-soon">
        <div className="an-soon__ic"><BarChart3 size={30} /></div>
        <h2 className="an-soon__t">Аналитика — скоро</h2>
        <p className="an-soon__d">Здесь появится полная аналитика вашего AI на реальных данных. Раздел в активной разработке.</p>
        <div className="an-soon__grid">
          {items.map(([t, d]) => (
            <div className="an-soon__item" key={t}>
              <div className="an-soon__item-t">{t}</div>
              <div className="an-soon__item-d">{d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
