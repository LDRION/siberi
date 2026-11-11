import axios from 'axios';
import {
  AlertCircle,
  BadgeCheck,
  Bell,
  Building2,
  ChevronRight,
  CircleDollarSign,
  ClipboardCopy,
  FileText,
  HandCoins,
  Loader2,
  MessageCircle,
  Share2,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  Video,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './PartnerPage.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const FEATURES = [
  {
    icon: <CircleDollarSign size={28} />,
    title: '20% пожизненно',
    desc: 'С каждого платежа реферала — раз и навсегда, пока он активен.',
  },
  {
    icon: <Sparkles size={28} />,
    title: 'Бонус за первую оплату',
    desc: 'Первая подписка от реферала → вы получаете бесплатный месяц такого же тарифа.',
  },
  {
    icon: <Wallet size={28} />,
    title: 'Быстрые выплаты',
    desc: 'Минимальная сумма вывода — 1 000 ₽. Перевод в течение 3 рабочих дней.',
  },
];

function formatRub(num) {
  if (num == null) return '0 ₽';
  return Number(num).toLocaleString('ru-RU') + ' ₽';
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ── Withdrawal modal ──────────────────────────────────────────────────────────
function WithdrawModal({ balance, onClose, onSuccess, apiKey }) {
  const [amount, setAmount] = useState('');
  const [details, setDetails] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const num = Number(amount);
    if (!num || num < 1000) {
      setError('Минимальная сумма — 1 000 ₽');
      return;
    }
    if (num > balance) {
      setError('Недостаточно средств на балансе');
      return;
    }
    if (!details.trim()) {
      setError('Укажите реквизиты для выплаты');
      return;
    }
    setLoading(true);
    try {
      await axios.post(
        `${API_URL}/affiliate/withdraw`,
        { amount: num, paymentDetails: details.trim() },
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      );
      onSuccess();
    } catch (err) {
      setError(err.response?.data?.error || 'Ошибка при отправке запроса');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pp-modal-overlay" onClick={onClose}>
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-header">
          <h3>Запрос на вывод средств</h3>
          <button className="pp-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="pp-modal-balance">
            Доступно: <strong>{formatRub(balance)}</strong>
          </div>
          <label className="pp-label">
            Сумма вывода (мин. 1 000 ₽)
            <input
              type="number"
              className="pp-input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Например: 2500"
              min={1000}
              max={balance}
            />
          </label>
          <label className="pp-label">
            Реквизиты для выплаты
            <textarea
              className="pp-input pp-textarea"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Карта Сбер / Тинькофф / СБП: +7 900 000-00-00&#10;ФИО получателя"
              rows={3}
            />
          </label>
          {error && (
            <div className="pp-error">
              <AlertCircle size={14} /> {error}
            </div>
          )}
          <div className="pp-modal-note">
            Выплаты производятся в течение 3 рабочих дней. При суммах свыше 10 000 ₽/мес рекомендуем
            оформить статус самозанятого для корректного налогообложения.
          </div>
          <button type="submit" className="pp-btn-primary" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <HandCoins size={16} />}
            Отправить запрос
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Admin panel ───────────────────────────────────────────────────────────────
function AdminPanel({ apiKey }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creditCode, setCreditCode] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditStatus, setCreditStatus] = useState('');

  const loadRequests = async () => {
    try {
      const { data } = await axios.get(`${API_URL}/affiliate/admin/requests`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (data.success) setRequests(data.requests);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRequests();
  }, []);

  const handleApprove = async (req) => {
    await axios.post(
      `${API_URL}/affiliate/admin/approve/${req.payoutId}`,
      { affiliateId: req.affiliateId },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    loadRequests();
  };

  const handleReject = async (req) => {
    const note = window.prompt('Причина отклонения (необязательно):') ?? '';
    await axios.post(
      `${API_URL}/affiliate/admin/reject/${req.payoutId}`,
      { affiliateId: req.affiliateId, note },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    loadRequests();
  };

  const handleCredit = async (e) => {
    e.preventDefault();
    setCreditStatus('');
    try {
      const { data } = await axios.post(
        `${API_URL}/affiliate/admin/credit`,
        { referralCode: creditCode.trim().toUpperCase(), amount: Number(creditAmount) },
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      setCreditStatus(`✅ Начислено. Новый баланс: ${formatRub(data.newBalance)}`);
      setCreditCode('');
      setCreditAmount('');
    } catch (err) {
      setCreditStatus('❌ ' + (err.response?.data?.error || 'Ошибка'));
    }
  };

  if (loading)
    return (
      <div className="pp-loading">
        <Loader2 size={20} className="spin" />
      </div>
    );

  return (
    <div className="pp-admin">
      <h3 className="pp-admin-title">Запросы на вывод</h3>
      {requests.length === 0 ? (
        <div className="pp-empty-row">Нет ожидающих запросов</div>
      ) : (
        <div className="pp-table-wrap">
          <table className="pp-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Код</th>
                <th>Сумма</th>
                <th>Реквизиты</th>
                <th>Дата</th>
                <th>Баланс</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.payoutId}>
                  <td>{r.userEmail}</td>
                  <td>
                    <code>{r.referralCode}</code>
                  </td>
                  <td>
                    <strong>{formatRub(r.amount)}</strong>
                  </td>
                  <td className="pp-td-details">{r.paymentDetails}</td>
                  <td>{formatDate(r.requestedAt)}</td>
                  <td>{formatRub(r.balance)}</td>
                  <td className="pp-td-actions">
                    <button className="pp-btn-approve" onClick={() => handleApprove(r)}>
                      Одобрить
                    </button>
                    <button className="pp-btn-reject" onClick={() => handleReject(r)}>
                      Отклонить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="pp-admin-title" style={{ marginTop: 32 }}>
        Ручное начисление
      </h3>
      <form className="pp-credit-form" onSubmit={handleCredit}>
        <input
          className="pp-input"
          placeholder="Реферальный код партнёра"
          value={creditCode}
          onChange={(e) => setCreditCode(e.target.value)}
        />
        <input
          className="pp-input"
          type="number"
          placeholder="Сумма, ₽"
          value={creditAmount}
          onChange={(e) => setCreditAmount(e.target.value)}
          min={1}
        />
        <button type="submit" className="pp-btn-primary">
          Начислить
        </button>
      </form>
      {creditStatus && <div className="pp-credit-status">{creditStatus}</div>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PartnerPage({ apiKey }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [tab, setTab] = useState('docs');
  const [copied, setCopied] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [localUnread, setLocalUnread] = useState(0);

  const load = async () => {
    try {
      const res = await axios.get(`${API_URL}/affiliate/info`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setData(res.data);
    } catch {
      setData({ error: true });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (data?.unreadNotifications != null) setLocalUnread(data.unreadNotifications);
  }, [data?.unreadNotifications]);

  const handleJoin = async () => {
    setJoining(true);
    try {
      await axios.post(
        `${API_URL}/affiliate/join`,
        {},
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      );
      load();
    } finally {
      setJoining(false);
    }
  };

  const referralLink = data?.referralCode
    ? `${window.location.origin}/login?ref=${data.referralCode}`
    : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="pp-loading-full">
        <Loader2 size={28} className="spin" />
      </div>
    );
  }

  // ── NOT JOINED ──────────────────────────────────────────────────────────────
  if (!data?.joined) {
    return (
      <div className="pp-root">
        <div className="pp-hero">
          <div className="pp-hero-left">
            <div className="pp-hero-badge">
              <BadgeCheck size={16} /> Партнёрская программа
            </div>
            <h2>
              Получайте <span className="pp-highlight">20%</span> с каждого платежа
            </h2>
            <p>
              Поделитесь своей реферальной ссылкой — и получайте комиссию с каждой оплаты ваших
              рефералов пожизненно. Плюс бонус: первая оплата нового реферала даёт вам бесплатный
              месяц подписки.
            </p>
            <button className="pp-btn-primary pp-btn-join" onClick={handleJoin} disabled={joining}>
              {joining ? <Loader2 size={17} className="spin" /> : <ChevronRight size={17} />}
              Вступить в программу
            </button>
          </div>
          <div className="pp-hero-features">
            {FEATURES.map((f, i) => (
              <div key={i} className="pp-feature-card">
                <div className="pp-feature-icon">{f.icon}</div>
                <div>
                  <div className="pp-feature-title">{f.title}</div>
                  <div className="pp-feature-desc">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pp-how">
          <h3>Как это работает</h3>
          <div className="pp-steps">
            {[
              { n: '1', text: 'Вступите в программу и получите реферальную ссылку' },
              { n: '2', text: 'Поделитесь ссылкой в своих каналах, блоге или с клиентами' },
              { n: '3', text: 'Рефералы регистрируются и оплачивают подписку' },
              { n: '4', text: 'Вы получаете 20% с каждого платежа на свой баланс' },
            ].map((s) => (
              <div key={s.n} className="pp-step">
                <div className="pp-step-n">{s.n}</div>
                <div className="pp-step-text">{s.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── JOINED ──────────────────────────────────────────────────────────────────
  const hasPending = data.payouts?.some((p) => p.status === 'pending');

  return (
    <div className="pp-root">
      {/* Заголовок даёт шапка оболочки (HEAD в Layout) — как в эталоне.
          Одна колонка на всю ширину .main: ссылка → метрики → строка вывода → доска. */}

      {/* Реферальная ссылка */}
      <div className="ref card">
            <div className="ref__l">
              <span className="ref__lbl">Ваша реферальная ссылка</span>
              <div className="ref__row">
                <input className="inp" value={referralLink} readOnly />
                <button className="btn btn--primary" type="button" onClick={handleCopy}>
                  <ClipboardCopy size={15} />
                  {copied ? 'Скопировано!' : 'Копировать'}
                </button>
              </div>
              <span className="ref__code">
                Код: <b>{data.referralCode}</b>
              </span>
            </div>
          </div>

          {/* Статистика.
              Дельты (.stat__d вида «+2 за месяц») в эталоне — ДЕМО;
              бэкенд /affiliate/info их не отдаёт, поэтому не рисуем. */}
          <section className="stats stats--4">
            <div className="stat stat--head stat--accent">
              <div className="stat__hd">
                <div className="stat__ic">
                  <Wallet size={20} />
                </div>
                <span className="stat__l">Баланс</span>
              </div>
              <div className="stat__v">{formatRub(data.balance)}</div>
            </div>
            <div className="stat stat--head">
              <div className="stat__hd">
                <div className="stat__ic">
                  <CircleDollarSign size={20} />
                </div>
                <span className="stat__l">Всего заработано</span>
              </div>
              <div className="stat__v">{formatRub(data.totalEarned)}</div>
            </div>
            <div className="stat stat--head">
              <div className="stat__hd">
                <div className="stat__ic">
                  <Users size={20} />
                </div>
                <span className="stat__l">Рефералов</span>
              </div>
              <div className="stat__v">{data.referralCount ?? 0}</div>
            </div>
            <div className="stat stat--head">
              <div className="stat__hd">
                <div className="stat__ic">
                  <BadgeCheck size={20} />
                </div>
                <span className="stat__l">Активных</span>
              </div>
              <div className="stat__v">{data.activeReferrals ?? 0}</div>
            </div>
          </section>

          {/* Вывод */}
          <div className="card pp-withdraw-bar">
            <div className="pp-withdraw-info">
              {hasPending ? (
                <>
                  <AlertCircle size={14} className="pp-pending-icon" /> Запрос на вывод
                  обрабатывается
                </>
              ) : (
                <>
                  Доступно к выводу: <strong>{formatRub(data.balance)}</strong>
                </>
              )}
            </div>
            <button
              type="button"
              className={`btn ${
                hasPending || (data.balance ?? 0) < 1000 ? 'btn--disabled' : 'btn--primary'
              }`}
              onClick={() => setShowWithdraw(true)}
              disabled={hasPending || (data.balance ?? 0) < 1000}
            >
              <HandCoins size={15} /> Запросить вывод
            </button>
          </div>

          {/* Доска: вкладки + тело (эталон .board / .board__bar / .board__body).
              Тело скроллится внутри доски, контент — на всю ширину колонки. */}
          <section className="board">
            <div className="board__bar">
              <div className="tabs pp-tabs">
            {[
              { key: 'docs', label: 'Условия программы' },
              { key: 'referrals', label: 'Рефералы' },
              { key: 'payouts', label: 'Выплаты' },
              { key: 'notifications', label: 'Уведомления', badge: localUnread },
              { key: 'guide', label: 'Документация' },
              ...(data.isAdmin ? [{ key: 'admin', label: '⚙ Администратор' }] : []),
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tab${tab === t.key ? ' tab--active' : ''}`}
                onClick={() => {
                  setTab(t.key);
                  if (t.key === 'notifications' && localUnread > 0) {
                    setLocalUnread(0);
                    axios
                      .post(
                        `${API_URL}/affiliate/notifications/read`,
                        {},
                        {
                          headers: { Authorization: `Bearer ${apiKey}` },
                        }
                      )
                      .catch(() => {});
                  }
                }}
              >
                {t.label}
                {t.badge > 0 && <span className="tab__n">{t.badge}</span>}
              </button>
            ))}
              </div>
            </div>
            <div className="board__body" style={{ padding: '18px 20px' }}>

          {/* Рефералы */}
          {tab === 'referrals' && (
            <div className="pp-tab-content">
              {!data.referrals || data.referrals.length === 0 ? (
                <div className="empty">
                  <div className="empty__ic">
                    <Users size={26} />
                  </div>
                  <div className="empty__t">У вас пока нет рефералов</div>
                  <div className="empty__d">Поделитесь ссылкой, чтобы начать зарабатывать.</div>
                </div>
              ) : (
                <div className="pp-table-wrap">
                  <table className="pp-table">
                    <thead>
                      <tr>
                        <th>Дата регистрации</th>
                        <th>Оплат на сумму</th>
                        <th>Ваш заработок</th>
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.referrals.map((r, i) => (
                        <tr key={i}>
                          <td>{formatDate(r.joinedAt)}</td>
                          <td>{formatRub(r.totalPaid)}</td>
                          <td>{formatRub(r.earned)}</td>
                          <td>
                            <span
                              className={`pp-badge ${r.totalPaid > 0 ? 'pp-badge--active' : 'pp-badge--new'}`}
                            >
                              {r.totalPaid > 0 ? 'Активный' : 'Новый'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Выплаты */}
          {tab === 'payouts' && (
            <div className="pp-tab-content">
              {!data.payouts || data.payouts.length === 0 ? (
                <div className="empty">
                  <div className="empty__ic">
                    <Wallet size={26} />
                  </div>
                  <div className="empty__t">Запросов на вывод ещё не было</div>
                </div>
              ) : (
                <div className="pp-table-wrap">
                  <table className="pp-table">
                    <thead>
                      <tr>
                        <th>Дата запроса</th>
                        <th>Сумма</th>
                        <th>Реквизиты</th>
                        <th>Статус</th>
                        <th>Обработан</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payouts.map((p) => (
                        <tr key={p._id}>
                          <td>{formatDate(p.requestedAt)}</td>
                          <td>
                            <strong>{formatRub(p.amount)}</strong>
                          </td>
                          <td className="pp-td-details">{p.paymentDetails}</td>
                          <td>
                            <span className={`pp-badge pp-badge--${p.status}`}>
                              {
                                {
                                  pending: 'На рассмотрении',
                                  approved: 'Выплачено',
                                  rejected: 'Отклонено',
                                }[p.status]
                              }
                            </span>
                          </td>
                          <td>{formatDate(p.processedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Уведомления */}
          {tab === 'notifications' && (
            <div className="pp-tab-content">
              {!data.notifications || data.notifications.length === 0 ? (
                <div className="empty">
                  <div className="empty__ic">
                    <Bell size={26} />
                  </div>
                  <div className="empty__t">Уведомлений пока нет</div>
                  <div className="empty__d">Здесь появятся события по вашим рефералам.</div>
                </div>
              ) : (
                <div className="pp-notif-list">
                  {data.notifications.map((n) => (
                    <div key={n._id} className={`pp-notif${n.read ? '' : ' pp-notif--unread'}`}>
                      <div
                        className={`pp-notif__icon ${n.type === 'payment' ? 'pp-notif__icon--payment' : 'pp-notif__icon--reg'}`}
                      >
                        {n.type === 'payment' ? (
                          <CircleDollarSign size={18} />
                        ) : (
                          <UserPlus size={18} />
                        )}
                      </div>
                      <div className="pp-notif__body">
                        {n.type === 'registration' ? (
                          <span>
                            Пользователь успешно зарегистрировался на сайте{' '}
                            <strong>{formatDate(n.joinedAt)}</strong> по вашей реферальной ссылке!
                          </span>
                        ) : (
                          <span>
                            Пользователь, зарегистрировавшийся по вашей ссылке{' '}
                            <strong>{formatDate(n.joinedAt)}</strong>, оплатил подписку
                            {n.plan ? ` ${n.plan.charAt(0).toUpperCase() + n.plan.slice(1)}` : ''}.
                            Поздравляем, ваш баланс пополнен!
                          </span>
                        )}
                        <div className="pp-notif__date">{formatDate(n.createdAt)}</div>
                      </div>
                      {n.type === 'payment' && n.amount > 0 && (
                        <div className="pp-notif__amount">+{formatRub(n.amount)}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Условия — сетка карточек .pgrid/.pcard (эталон), на всю ширину */}
          {tab === 'docs' && (
            <div className="pp-tab-content pgrid">
              <div className="pcard">
                <div className="pcard__ic">
                  <CircleDollarSign size={18} />
                </div>
                <div className="pcard__t">Размер комиссии</div>
                <div className="pcard__d">
                  <strong>20%</strong> от каждого платежа реферала — пожизненно. Комиссия
                  начисляется автоматически в момент оплаты и сразу отображается на вашем балансе.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <Sparkles size={18} />
                </div>
                <div className="pcard__t">Бонус за первую оплату</div>
                <div className="pcard__d">
                  Когда реферал совершает первую оплату подписки, вы автоматически получаете такую
                  же. Если у вас уже есть аналогичная подписка, она продлится на{' '}
                  <strong>30 дней</strong>. В случае, когда тариф реферала выше вашего, ваша
                  подписка обновляется до уровня его тарифа и продлевается на{' '}
                  <strong>30 дней</strong>. Бонус засчитывается один раз с каждого нового реферала.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <Wallet size={18} />
                </div>
                <div className="pcard__t">Вывод средств</div>
                <div className="pcard__d">
                  Минимальная сумма вывода — <strong>1 000 ₽</strong>. Запрос обрабатывается в
                  течение 3 рабочих дней. Выплата производится на указанные реквизиты: банковская
                  карта, СБП или иной способ по договорённости.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <ShieldCheck size={18} />
                </div>
                <div className="pcard__t">Налогообложение</div>
                <div className="pcard__d">
                  Партнёрское вознаграждение является доходом физического лица. При суммах свыше{' '}
                  <strong>10 000 ₽/месяц</strong> рекомендуем оформить статус самозанятого для
                  простого и прозрачного налогообложения через приложение «Мой налог».
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <Users size={18} />
                </div>
                <div className="pcard__t">Привязка рефералов</div>
                <div className="pcard__d">
                  Реферал закрепляется за вами в момент регистрации по вашей ссылке. Привязка
                  постоянная — даже если позже реферал перейдёт по другой ссылке, комиссия
                  продолжит начисляться вам.
                </div>
              </div>
            </div>
          )}

          {/* Документация — сетка карточек .pgrid/.pcard (эталон), на всю ширину */}
          {tab === 'guide' && (
            <div className="pp-tab-content pgrid">
              <div className="pcard">
                <div className="pcard__ic">
                  <Video size={18} />
                </div>
                <div className="pcard__t">Shorts, Reels и TikTok</div>
                <div className="pcard__d">
                  Снимите короткое видео о том, как Siberi AI помогает в реальной жизни или
                  работе. Загляните во вкладку{' '}
                  <button type="button" className="pp-link" onClick={() => navigate('/solutions')}>«Для кого это?»</button>
                  {' '}в главном меню — там описаны конкретные сценарии для разных профессий. Выберите аудиторию, которая ближе
                  вашим подписчикам, и говорите на её языке. Покажите экран, живые эмоции,
                  реальный результат — не рекламу, а историю. Реферальную ссылку обязательно
                  упомяните вслух в конце видео и вставьте в описание или закреплённый комментарий.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <Building2 size={18} />
                </div>
                <div className="pcard__t">ИП и малый бизнес без ИИ</div>
                <div className="pcard__d">
                  Найдите предпринимателей в соцсетях и мессенджерах — тех, кто ещё не использует
                  ИИ в работе. Напишите короткое, дружелюбное сообщение: расскажите, что Siberi AI
                  позволяет внедрить ИИ-ассистента буквально за час — он помогает с клиентами,
                  документами и планированием, работает 24/7 без ошибок и выходных. Пишите как
                  человек, а не рекламный текст, и обязательно прикрепите вашу реферальную ссылку.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <FileText size={18} />
                </div>
                <div className="pcard__t">Статьи: Дзен, VC.ru, Хабр, Пикабу</div>
                <div className="pcard__d">
                  Напишите честную историю: «Как я начал использовать ИИ в работе» или «Почему я
                  выбрал Siberi AI для своего бизнеса». Алгоритмы Дзена и Пикабу любят такой
                  контент — хорошая история распространяется сама. Тематические форумы и
                  комментарии под нишевыми постами работают не хуже. Главное — реферальная ссылка
                  в конце.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <MessageCircle size={18} />
                </div>
                <div className="pcard__t">Telegram: каналы и чаты</div>
                <div className="pcard__d">
                  Поделитесь ссылкой в тематических Telegram-группах — предпринимателям,
                  фрилансерам, маркетологам, нишевым сообществам. Не нужно спамить: напишите
                  небольшой полезный пост или органично упомяните Siberi AI в дискуссии. Если у
                  вас есть собственный канал — это идеальное место для обзора или честного отзыва
                  о продукте.
                </div>
              </div>
              <div className="pcard">
                <div className="pcard__ic">
                  <Share2 size={18} />
                </div>
                <div className="pcard__t">Личная рекомендация</div>
                <div className="pcard__d">
                  Если вы сами используете Siberi AI в работе — расскажите об этом коллегам,
                  клиентам или партнёрам. Личная рекомендация конвертирует лучше любой рекламы.
                  Просто скажите: «Я пользуюсь этим инструментом, он реально помогает — вот
                  ссылка». Доверие — ваш главный актив как партнёра.
                </div>
              </div>
            </div>
          )}

          {/* Администратор */}
          {tab === 'admin' && data.isAdmin && (
            <div className="pp-tab-content">
              <AdminPanel apiKey={apiKey} />
            </div>
          )}
            </div>
          </section>

      {/* Модалка вывода */}
      {showWithdraw && (
        <WithdrawModal
          balance={data.balance ?? 0}
          apiKey={apiKey}
          onClose={() => setShowWithdraw(false)}
          onSuccess={() => {
            setShowWithdraw(false);
            load();
          }}
        />
      )}
    </div>
  );
}
