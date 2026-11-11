import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Check, CreditCard, Loader2, AlertCircle, Clock, Zap,
  Shield, Crown, Star, X, ChevronLeft, ArrowRight, ShieldAlert, Send,
} from 'lucide-react';
import { YooMoneyIcon, SberPayIcon, SBPIcon } from '../components/BrandIcons';
import './Billing.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
const ym = (goal) => { try { window.ym?.(109332736, 'reachGoal', goal); } catch {} };

const PLANS = [
  {
    id: 'pro',
    name: 'Pro',
    price: 999,
    icon: Star,
    features: [
      { bold: 'без ограничений', prefix: 'Чат с ИИ ' },
      'Все возможности языковой модели',
      'Работа с документами и голосом',
      'Приоритетная скорость ответа',
      'Доступ ко всем функциям платформы',
    ],
    popular: true,
  },
  {
    id: 'family',
    name: 'Family',
    price: 2999,
    icon: Crown,
    features: [
      'Всё из Pro — для всей семьи',
      { bold: 'до 5 человек', prefix: 'Общий доступ на ' },
      'У каждого — свой аккаунт',
      'Оплатить может любой член семьи',
      'Одна подписка на всех',
    ],
    popular: false,
  },
];

const PERIODS = [
  { id: '1m',  label: '1 месяц',    months: 1,  discount: 0,    badge: null,  popular: false },
  { id: '3m',  label: '3 месяца',   months: 3,  discount: 0.10, badge: '-10%', popular: true  },
  { id: '12m', label: '12 месяцев', months: 12, discount: 0.20, badge: '-20%', popular: false },
];

const PAYMENT_METHODS = [
  { id: 'card',     label: 'Банковская карта', icon: <CreditCard size={30} strokeWidth={1.5} />, desc: 'Visa, Mastercard, Мир' },
  { id: 'sberpay',  label: 'SberPay',          icon: <SberPayIcon size={30} />,                  desc: 'Быстрая оплата через СберБанк' },
  { id: 'sbp',      label: 'СБП',              icon: <SBPIcon size={30} />,                      desc: 'Система быстрых платежей' },
  { id: 'yoomoney', label: 'ЮMoney',           icon: <YooMoneyIcon size={30} />,                 desc: 'Электронный кошелёк' },
];

function calcPrices(plan, period) {
  const total = Math.round(plan.price * period.months * (1 - period.discount));
  const perMonth = Math.round(total / period.months);
  const saved = Math.round(plan.price * period.months * period.discount);
  return { total, perMonth, saved };
}

function formatTimeLeft(endsAt) {
  const diff = new Date(endsAt) - Date.now();
  if (diff <= 0) return 'истёк';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} д. ${h % 24} ч.`;
  return `${h} ч. ${m} мин.`;
}

export default function Billing({ apiKey }) {
  const [loading, setLoading] = useState(null);
  const [userInfo, setUserInfo] = useState(null);
  const [infoLoading, setInfoLoading] = useState(true);

  // Modal flow
  const [pendingPlan, setPendingPlan] = useState(null);
  const [modalStep, setModalStep] = useState('period');
  const [selectedPeriod, setSelectedPeriod] = useState(PERIODS[1]); // default 3 months
  const [downgradeWarning, setDowngradeWarning] = useState(null); // { from, to }

  useEffect(() => {
    if (!apiKey) return;
    fetchUserInfo();
  }, [apiKey]);

  useEffect(() => {
    if (!pendingPlan) return;
    const onKey = (e) => e.key === 'Escape' && setPendingPlan(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPlan]);

  const fetchUserInfo = async () => {
    setInfoLoading(true);
    try {
      const res = await axios.get(`${API_URL}/user/info`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setUserInfo(res.data);
    } catch {}
    finally { setInfoLoading(false); }
  };

  const PLAN_LEVEL = { pro: 1, family: 2, standard: 1, premium: 2 };

  const openSubscribeModal = (plan) => {
    const isActiveNow = userInfo?.subscriptionStatus === 'active' && new Date(userInfo?.subscriptionEnd) > new Date();
    const currentPlanId = userInfo?.plan;
    if (isActiveNow && (PLAN_LEVEL[plan.id] || 1) < (PLAN_LEVEL[currentPlanId] || 1)) {
      setDowngradeWarning({ from: currentPlanId, to: plan.id });
      return;
    }
    setPendingPlan(plan);
    setModalStep('period');
    setSelectedPeriod(PERIODS[1]);
  };

  const handleSubscribe = async (paymentMethod) => {
    if (!pendingPlan || !selectedPeriod) return;
    setLoading(pendingPlan.id);
    try {
      const response = await axios.post(
        `${API_URL}/payment/create`,
        { plan: pendingPlan.id, months: selectedPeriod.months, paymentMethod },
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      if (response.data.success) {
        ym('payment_initiated');
        // Ecommerce: фиксируем начало оплаты в dataLayer для Метрики
        try {
          const total = Math.round(pendingPlan.price * selectedPeriod.months * (1 - selectedPeriod.discount));
          window.dataLayer = window.dataLayer || [];
          window.dataLayer.push({
            ecommerce: {
              currencyCode: 'RUB',
              add: {
                products: [{
                  id: pendingPlan.id,
                  name: `Siberi AI ${pendingPlan.name} × ${selectedPeriod.months}мес`,
                  price: pendingPlan.price,
                  quantity: selectedPeriod.months,
                  category: 'Subscription',
                }],
              },
              purchase: {
                actionField: { revenue: total, coupon: '' },
                products: [{
                  id: pendingPlan.id,
                  name: `Siberi AI ${pendingPlan.name}`,
                  price: pendingPlan.price,
                  quantity: selectedPeriod.months,
                  category: 'Subscription',
                }],
              },
            },
          });
        } catch {}
        window.location.href = response.data.paymentUrl;
      }
    } catch (err) {
      alert('Ошибка создания платежа: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(null);
    }
  };

  const isTrial = userInfo?.subscriptionStatus === 'trial';
  const isActive = userInfo?.subscriptionStatus === 'active';
  const currentPlan = isActive ? userInfo?.plan : null;

  return (
    <div className="bill-fill">
      {/* ── Текущий статус ─────────────────────────────────────────── */}
      {!infoLoading && userInfo && (
        <div className="bill-cur card">
          <div>
            <span className="muted-s">Текущий статус</span>
            <div className="bill-cur__n">
              {isTrial
                ? `Пробный период${userInfo.trialEndsAt && formatTimeLeft(userInfo.trialEndsAt) !== 'истёк' ? ` · осталось ${formatTimeLeft(userInfo.trialEndsAt)}` : ' · истёк'}`
                : isActive
                  ? `Тариф «${PLANS.find(p => p.id === currentPlan)?.name || currentPlan}» активен${userInfo.subscriptionEnd ? ` до ${new Date(userInfo.subscriptionEnd).toLocaleDateString('ru-RU')}` : ''}`
                  : 'Доступ ограничен — оформите подписку'}
            </div>
          </div>
          <span className="chip chip--soft">{isTrial ? 'Триал' : isActive ? 'Активна' : 'Нет доступа'}</span>
        </div>
      )}

      {/* ── Тарифные планы ─────────────────────────────────────────── */}
      <div className="plans">
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          return (
            <div key={plan.id} className={`plan ${plan.popular ? 'plan--hot' : ''}`}>
              {plan.popular && <span className="plan__badge">Популярный</span>}
              <div className="plan__n">{plan.name}</div>
              <div className="plan__p">{plan.price.toLocaleString('ru-RU')} ₽<small>/ месяц</small></div>
              <ul className="plan__list">
                {plan.features.map((f, i) => (
                  <li key={i}>
                    <Check size={14} className="check-icon" />
                    {typeof f === 'object' && f.note ? <span>{f.text}</span>
                      : typeof f === 'object' && f.bold ? <span>{f.prefix}<strong>{f.bold}</strong></span>
                        : <span>{f}</span>}
                  </li>
                ))}
              </ul>
              <button
                className={`btn ${plan.popular ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => openSubscribeModal(plan)}
                disabled={!!loading}
              >
                {loading === plan.id ? <Loader2 className="spin" size={16} />
                  : isCurrent ? <><ArrowRight size={15} /> Продлить</>
                    : <><CreditCard size={15} /> Выбрать тариф</>}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Гарантия + способы оплаты ──────────────────────────────── */}
      <div className="bill-guarantee"><Shield size={15} /> <span><strong>14 дней — гарантия возврата.</strong> Не подошло — вернём деньги без вопросов.</span></div>
      <div className="pay">
        <span className="muted-s">Принимаемые способы оплаты:</span>
        <span className="chip chip--soft">Банковские карты</span>
        <span className="chip chip--soft">SberPay</span>
        <span className="chip chip--soft">СБП</span>
        <span className="chip chip--soft">ЮMoney</span>
      </div>
      <div className="bill-help"><Send size={14} /> Остались вопросы по тарифам или оплате? Напишите менеджеру — <a className="link" href="https://t.me/SiberiManager" target="_blank" rel="noopener">@SiberiManager</a></div>

      {/* ── Модал выбора периода и оплаты ─────────────────────────── */}
      {pendingPlan && (
        <div className="sub-modal-overlay" onClick={(e) => e.target === e.currentTarget && setPendingPlan(null)}>
          <div className="sub-modal">

            {modalStep === 'period' && (
              <>
                {/* Clean minimal header */}
                <div className="sub-modal__head">
                  <div className="sub-modal__head-left">
                    <div className="sub-modal__plan-pill">
                      <pendingPlan.icon size={12} />
                      {pendingPlan.name}
                    </div>
                    <div className="sub-modal__title">
                      {isActive && pendingPlan.id === currentPlan ? 'Продлить подписку' : 'Выберите период'}
                    </div>
                    <div className="sub-modal__subtitle">
                      {isActive && new Date(userInfo?.subscriptionEnd) > new Date()
                        ? `Текущая подписка активна до ${new Date(userInfo.subscriptionEnd).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} — срок добавится сверху`
                        : 'Чем дольше — тем выгоднее'}
                    </div>
                  </div>
                  <button className="sub-modal__close-btn" onClick={() => setPendingPlan(null)}>
                    <X size={16} />
                  </button>
                </div>

                <div className="sub-modal__body">
                  <div className="period-rows">
                    {PERIODS.map((period) => {
                      const { total, perMonth, saved } = calcPrices(pendingPlan, period);
                      const isSelected = selectedPeriod.id === period.id;
                      return (
                        <button
                          key={period.id}
                          className={`period-row ${isSelected ? 'period-row--active' : ''}`}
                          onClick={() => setSelectedPeriod(period)}
                        >
                          <div className="period-row__radio">
                            {isSelected && <div className="period-row__dot" />}
                          </div>
                          <div className="period-row__info">
                            <div className="period-row__label">
                              {period.label}
                              {period.popular && <span className="period-row__pop">Выгоднее</span>}
                            </div>
                            {saved > 0
                              ? <div className="period-row__save">Экономия {saved.toLocaleString('ru-RU')} ₽</div>
                              : <div className="period-row__save period-row__save--muted">Оплата {total.toLocaleString('ru-RU')} ₽</div>
                            }
                          </div>
                          <div className="period-row__price">
                            <span className="period-row__num">{perMonth.toLocaleString('ru-RU')}</span>
                            <span className="period-row__unit">₽/мес</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="sub-modal__footer">
                    <div className="sub-modal__total-row">
                      <span className="sub-modal__total-label">Итого к оплате</span>
                      <div className="sub-modal__total-right">
                        <strong className="sub-modal__total-amount">
                          {calcPrices(pendingPlan, selectedPeriod).total.toLocaleString('ru-RU')} ₽
                        </strong>
                        {selectedPeriod.discount > 0 && (
                          <span className="sub-modal__save-pill">
                            −{Math.round(selectedPeriod.discount * 100)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      className="period-continue-btn"
                      onClick={() => setModalStep('payment')}
                    >
                      Выбрать способ оплаты
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              </>
            )}

            {modalStep === 'payment' && (
              <>
                <div className="sub-modal__head sub-modal__head--pay">
                  <button className="sub-modal__back-btn" onClick={() => setModalStep('period')}>
                    <ChevronLeft size={15} /> Назад
                  </button>
                  <div className="sub-modal__pay-summary">
                    <div className="sub-modal__pay-tags">
                      <span className="sub-modal__plan-pill">
                        <pendingPlan.icon size={11} />{pendingPlan.name}
                      </span>
                      <span className="sub-modal__period-pill">{selectedPeriod.label}</span>
                    </div>
                    <div className="sub-modal__pay-total">
                      {calcPrices(pendingPlan, selectedPeriod).total.toLocaleString('ru-RU')} ₽
                    </div>
                  </div>
                  <button className="sub-modal__close-btn" onClick={() => setPendingPlan(null)}>
                    <X size={16} />
                  </button>
                </div>

                <div className="sub-modal__body">
                  <p className="sub-modal__pay-title">Способ оплаты</p>
                  <div className="pay-methods-list">
                    {PAYMENT_METHODS.map((m) => (
                      <button
                        key={m.id}
                        className="pay-method-btn"
                        onClick={() => handleSubscribe(m.id)}
                        disabled={!!loading}
                      >
                        <span className="pay-method-btn__icon">{m.icon}</span>
                        <div className="pay-method-btn__info">
                          <span className="pay-method-btn__label">{m.label}</span>
                          <span className="pay-method-btn__desc">{m.desc}</span>
                        </div>
                        {loading === pendingPlan.id
                          ? <Loader2 size={16} className="spin" />
                          : <ArrowRight size={16} />
                        }
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

          </div>
        </div>
      )}

      {/* ── Downgrade warning modal ─────────────────────────────────── */}
      {downgradeWarning && (
        <div className="sub-modal-overlay" onClick={() => setDowngradeWarning(null)}>
          <div className="sub-modal downgrade-modal" onClick={e => e.stopPropagation()}>
            <div className="downgrade-modal__icon">
              <ShieldAlert size={36} />
            </div>
            <h3 className="downgrade-modal__title">У вас активен более мощный тариф</h3>
            <p className="downgrade-modal__text">
              Сейчас у вас действует тариф{' '}
              <strong style={{ textTransform: 'capitalize' }}>{downgradeWarning.from}</strong>.
              Переход на{' '}
              <strong style={{ textTransform: 'capitalize' }}>{downgradeWarning.to}</strong>{' '}
              возможен только после окончания текущей подписки
              {userInfo?.subscriptionEnd
                ? ` — ${new Date(userInfo.subscriptionEnd).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`
                : ''}.
            </p>
            <p className="downgrade-modal__hint">
              Дождитесь окончания периода, и тогда вы сможете выбрать любой тариф.
            </p>
            <button className="downgrade-modal__btn" onClick={() => setDowngradeWarning(null)}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
