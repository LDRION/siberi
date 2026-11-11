import { useEffect, useRef, useState } from 'react';
import {
  Ban,
  Bot,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Pencil,
  Search,
  Shield,
  Users,
  Wallet,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import './AdminPanel.css';

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

const PLAN_LABELS = { standard: 'Standard', pro: 'Pro', premium: 'Premium' };
const getPlanLabel = (u) =>
  u.subscriptionStatus === 'trial' ? 'Premium ⭐' : (PLAN_LABELS[u.plan] || u.plan || '—');
const STATUS_LABELS = { trial: 'Триал', active: 'Активна', expired: 'Истекла', cancelled: 'Отменена' };

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru-RU');
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AdminPanel({ apiKey, onClose }) {
  const [tab, setTab] = useState('users');

  return (
    <div className="adm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="adm-panel">
        <div className="adm-header">
          <div className="adm-header-left">
            <Shield size={20} />
            <span>Панель администратора</span>
          </div>
          <button className="adm-close" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="adm-tabs">
          <button className={`adm-tab${tab === 'users' ? ' active' : ''}`} onClick={() => setTab('users')}>
            <Users size={16} /> Пользователи
          </button>
          <button className={`adm-tab${tab === 'withdrawals' ? ' active' : ''}`} onClick={() => setTab('withdrawals')}>
            <Wallet size={16} /> Выплаты
          </button>
          <button className={`adm-tab${tab === 'apis' ? ' active' : ''}`} onClick={() => setTab('apis')}>
            <Zap size={16} /> Активные API
          </button>
        </div>

        <div className="adm-body">
          {tab === 'users' && <UsersTab apiKey={apiKey} />}
          {tab === 'withdrawals' && <WithdrawalsTab apiKey={apiKey} />}
          {tab === 'apis' && <ActiveApisTab apiKey={apiKey} />}
        </div>
      </div>
    </div>
  );
}

// ── Users tab ──────────────────────────────────────────────────────────────────

function UsersTab({ apiKey }) {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const debounce = useRef(null);

  const load = async (qVal, pageVal) => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/siteadmin/users?q=${encodeURIComponent(qVal)}&page=${pageVal}&limit=30`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const d = await r.json();
      setUsers(d.users || []);
      setTotal(d.total || 0);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(q, page); }, [page]);

  const handleSearch = (val) => {
    setQ(val);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { setPage(1); load(val, 1); }, 350);
  };

  const handleBlock = () => { setSelected(null); load(q, page); };

  const totalPages = Math.ceil(total / 30);

  return (
    <div className="adm-users">
      <div className="adm-search-row">
        <div className="adm-search">
          <Search size={15} />
          <input
            placeholder="Поиск по email или имени..."
            value={q}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <span className="adm-total">{total} польз.</span>
      </div>

      {loading && <div className="adm-loading">Загрузка...</div>}

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Тариф</th>
              <th>Статус</th>
              <th>Регистрация</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u._id} className={u.blocked?.isBlocked ? 'adm-row--blocked' : ''}>
                <td>
                  <div className="adm-email">
                    {u.email}
                    {u.isSiteAdmin && <span className="adm-badge adm-badge--admin">admin</span>}
                    {u.blocked?.isBlocked && <span className="adm-badge adm-badge--blocked">блок</span>}
                  </div>
                  {u.displayName && <div className="adm-subtext">{u.displayName}</div>}
                </td>
                <td>{getPlanLabel(u)}</td>
                <td>
                  <span className={`adm-status adm-status--${u.subscriptionStatus}`}>
                    {STATUS_LABELS[u.subscriptionStatus] || u.subscriptionStatus}
                  </span>
                </td>
                <td>{fmtDate(u.createdAt)}</td>
                <td>
                  <button className="adm-action-btn" onClick={() => setSelected(u)}>
                    Управление
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="adm-pagination">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
        </div>
      )}

      {selected && (
        <UserModal
          user={selected}
          apiKey={apiKey}
          onDone={handleBlock}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function UserModal({ user, apiKey, onDone, onClose }) {
  const isBlocked = user.blocked?.isBlocked;
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [payHistory, setPayHistory] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/siteadmin/users/${user._id}/payment-history`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((d) => setPayHistory(d.history || []))
      .catch(() => setPayHistory([]));
  }, [user._id, apiKey]);

  const handleUnblock = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/siteadmin/users/${user._id}/unblock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (r.ok) onDone();
      else setErr('Ошибка');
    } catch { setErr('Ошибка'); }
    setLoading(false);
  };

  const handleBlock = async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(`${API_BASE}/siteadmin/users/${user._id}/block`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, durationDays: duration ? Number(duration) : null }),
      });
      if (r.ok) onDone();
      else { const d = await r.json(); setErr(d.error || 'Ошибка'); }
    } catch { setErr('Ошибка'); }
    setLoading(false);
  };

  const PLAN_LABELS_M = { standard: 'Standard', pro: 'Pro', premium: 'Premium' };
  const planLabelM = user.subscriptionStatus === 'trial' ? 'Premium ⭐' : (PLAN_LABELS_M[user.plan] || user.plan || '—');

  return (
    <div className="adm-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="adm-modal adm-modal--wide">
        <div className="adm-modal-header">
          <span>Пользователь: {user.email}</span>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="adm-modal-body">

          {/* User info row */}
          <div className="adm-user-meta">
            <span>Тариф: <strong>{planLabelM}</strong></span>
            <span>Статус: <strong>{STATUS_LABELS[user.subscriptionStatus] || user.subscriptionStatus}</strong></span>
            {user.subscriptionEnd && <span>До: <strong>{fmtDate(user.subscriptionEnd)}</strong></span>}
            <span>Зарег.: <strong>{fmtDate(user.createdAt)}</strong></span>
          </div>

          {/* Telegram bots — view/edit raw config, whether connected via the
              website's Bot Studio or via TGLetBot/AIConstructorBot */}
          <TelegramBotsSection userId={user._id} apiKey={apiKey} />

          {/* Payment history */}
          <div className="adm-pay-section">
            <div className="adm-pay-title"><CreditCard size={14} /> История платежей</div>
            {payHistory === null && <div className="adm-pay-loading">Загрузка...</div>}
            {payHistory !== null && payHistory.length === 0 && (
              <div className="adm-pay-empty">Нет платежей</div>
            )}
            {payHistory !== null && payHistory.length > 0 && (
              <div className="adm-pay-table-wrap">
                <table className="adm-pay-table">
                  <thead>
                    <tr>
                      <th>Дата оплаты</th>
                      <th>Тариф</th>
                      <th>Сумма</th>
                      <th>Дней</th>
                      <th>Действует до</th>
                      <th>ID платежа</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payHistory.map((p, i) => (
                      <tr key={i}>
                        <td>{fmtDateTime(p.paidAt)}</td>
                        <td>{PLAN_LABELS_M[p.plan] || p.plan || '—'}</td>
                        <td>{p.amount ? `${p.amount} ${p.currency || 'RUB'}` : '—'}</td>
                        <td>{p.durationDays || '—'}</td>
                        <td>{fmtDate(p.subscriptionEnd)}</td>
                        <td className="adm-pay-id">{p.paymentId || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Block / Unblock section */}
          <div className="adm-block-section">
            {isBlocked ? (
              <>
                <div className="adm-modal-info">
                  <p>Причина блокировки: <strong>{user.blocked.reason || '—'}</strong></p>
                  <p>Заблокирован: {fmtDate(user.blocked.blockedAt)}</p>
                  {user.blocked.blockedUntil && <p>До: {fmtDate(user.blocked.blockedUntil)}</p>}
                </div>
                <button className="adm-btn adm-btn--green" onClick={handleUnblock} disabled={loading}>
                  <CheckCircle size={16} /> {loading ? 'Снимаем...' : 'Разблокировать'}
                </button>
              </>
            ) : (
              <>
                <div className="adm-form-row">
                  <label>Причина блокировки</label>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Например: нарушение правил"
                  />
                </div>
                <div className="adm-form-row">
                  <label>Срок (дней, пусто = навсегда)</label>
                  <input
                    type="number"
                    min="1"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    placeholder="Навсегда"
                  />
                </div>
                {err && <div className="adm-err">{err}</div>}
                <button className="adm-btn adm-btn--red" onClick={handleBlock} disabled={loading}>
                  <Ban size={16} /> {loading ? 'Блокируем...' : 'Заблокировать'}
                </button>
              </>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Telegram bots — view/edit raw config, regardless of whether the bot was
// connected through the website's Bot Studio or through TGLetBot/AIConstructorBot
// (both write to the same UserIntegrations.telegram[] / UserAiConfig models).

function TelegramBotsSection({ userId, apiKey }) {
  const [bots, setBots] = useState(null);
  const [error, setError] = useState('');
  const [editingProfileId, setEditingProfileId] = useState(null);
  const [revealedToken, setRevealedToken] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/siteadmin/users/${userId}/telegram-bots`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setBots(d.bots); else setError(d.error || 'Ошибка'); })
      .catch(() => setError('Ошибка загрузки'));
  }, [userId, apiKey]);

  return (
    <div className="adm-tg-section">
      <div className="adm-pay-title"><Bot size={14} /> Telegram-боты</div>
      {error && <div className="adm-err">{error}</div>}
      {bots === null && !error && <div className="adm-pay-loading">Загрузка...</div>}
      {bots !== null && bots.length === 0 && <div className="adm-pay-empty">Нет подключённых ботов</div>}
      {bots !== null && bots.length > 0 && (
        <div className="adm-tg-list">
          {bots.map((b) => (
            <div key={b.instanceId} className="adm-tg-row">
              <div className="adm-tg-row-top">
                <div className="adm-tg-info">
                  <span className="adm-tg-username">@{b.botUsername || b.botName || '—'}</span>
                  {!b.connected && <span className="adm-badge adm-badge--blocked">отключён</span>}
                  {b.profileName && (
                    <span className="adm-subtext">{b.profileName}{b.aiName ? ` · ${b.aiName}` : ''}</span>
                  )}
                </div>
                <div className="adm-tg-actions">
                  <button
                    className="adm-icon-action"
                    title={revealedToken === b.instanceId ? 'Скрыть токен' : 'Показать токен'}
                    onClick={() => setRevealedToken(revealedToken === b.instanceId ? null : b.instanceId)}
                  >
                    {revealedToken === b.instanceId ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {b.profileId && (
                    <button className="adm-action-btn" onClick={() => setEditingProfileId(b.profileId)}>
                      <Pencil size={13} /> Открыть конфиг
                    </button>
                  )}
                </div>
              </div>
              {revealedToken === b.instanceId && <div className="adm-tg-token">{b.token || '—'}</div>}
            </div>
          ))}
        </div>
      )}

      {editingProfileId && (
        <ProfileEditorModal profileId={editingProfileId} apiKey={apiKey} onClose={() => setEditingProfileId(null)} />
      )}
    </div>
  );
}

function ProfileEditorModal({ profileId, apiKey, onClose }) {
  const [raw, setRaw] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/siteadmin/profiles/${profileId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) { setError(d.error || 'Ошибка'); return; }
        setRaw(JSON.stringify(d.profile, null, 2));
      })
      .catch(() => setError('Ошибка загрузки'))
      .finally(() => setLoading(false));
  }, [profileId, apiKey]);

  const handleSave = async () => {
    setError('');
    setSavedOk(false);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError('Невалидный JSON — проверь синтаксис');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/siteadmin/profiles/${profileId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const d = await r.json();
      if (!r.ok || !d.success) { setError(d.error || 'Ошибка сохранения'); return; }
      setRaw(JSON.stringify(d.profile, null, 2));
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch { setError('Ошибка сохранения'); }
    setSaving(false);
  };

  return (
    <div className="adm-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="adm-modal adm-modal--wide">
        <div className="adm-modal-header">
          <span>Конфиг бота (raw JSON)</span>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="adm-modal-body">
          {loading && <div className="adm-pay-loading">Загрузка...</div>}
          {!loading && (
            <>
              <p className="adm-subtext" style={{ marginBottom: 8 }}>
                Любое поле — systemPrompt, botSettings.commands, welcomeMessage и т.д. Сохранение применяется мгновенно к живому боту, без участия AI.
              </p>
              <textarea className="adm-json-editor" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
              {error && <div className="adm-err">{error}</div>}
              {savedOk && <div className="adm-saved-ok">Сохранено ✅</div>}
              <button className="adm-btn adm-btn--green" onClick={handleSave} disabled={saving}>
                {saving ? 'Сохраняю...' : 'Сохранить'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Active APIs tab ────────────────────────────────────────────────────────────

function CopyKey({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  const masked = value ? value.slice(0, 8) + '••••••••' + value.slice(-4) : '—';
  return (
    <span className="adm-apikey-wrap">
      <code className="adm-apikey">{masked}</code>
      <button className="adm-copy-btn" onClick={copy} title="Скопировать ключ">
        {copied ? <CheckCircle size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}

function ActiveApisTab({ apiKey }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(`${API_BASE}/siteadmin/active-apis`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Ошибка');
      setItems(d.integrations || []);
      setTotal(d.total || 0);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="adm-apis">
      <div className="adm-apis-header">
        <span className="adm-total">{total} интеграц.</span>
        <button className="adm-action-btn" onClick={load} disabled={loading}>
          {loading ? 'Загрузка...' : 'Обновить'}
        </button>
      </div>

      {err && <div className="adm-err">{err}</div>}
      {loading && <div className="adm-loading">Загрузка...</div>}

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Профиль / Владелец</th>
              <th>API-ключ</th>
              <th>Запросов</th>
              <th>Последний запрос</th>
              <th>Подключено с</th>
              <th>Боты / Webhook</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr><td colSpan="6" className="adm-empty">Нет активных API-интеграций</td></tr>
            )}
            {items.map((it) => (
              <tr key={it.profileId}>
                <td>
                  <div className="adm-email">{it.profileName}</div>
                  <div className="adm-subtext">{it.ownerEmail}{it.ownerName ? ` · ${it.ownerName}` : ''}</div>
                </td>
                <td><CopyKey value={it.apiKey} /></td>
                <td>
                  <strong>{it.totalRequests.toLocaleString('ru-RU')}</strong>
                </td>
                <td>{fmtDateTime(it.lastUsed)}</td>
                <td>{fmtDate(it.createdAt)}</td>
                <td>
                  <div className="adm-bots">
                    {it.tgBots.map((b, i) => (
                      <span key={`tg-${i}`} className="adm-badge adm-badge--tg">TG: {b}</span>
                    ))}
                    {it.vkBots.map((b, i) => (
                      <span key={`vk-${i}`} className="adm-badge adm-badge--vk">VK: {b}</span>
                    ))}
                    {it.hasWebhook && <span className="adm-badge adm-badge--wh">Webhook</span>}
                    {!it.tgBots.length && !it.vkBots.length && !it.hasWebhook && (
                      <span className="adm-subtext">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Withdrawals tab ────────────────────────────────────────────────────────────

function WithdrawalsTab({ apiKey }) {
  const [withdrawals, setWithdrawals] = useState([]);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [loading, setLoading] = useState(false);
  const [actionModal, setActionModal] = useState(null);

  const load = async (s) => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/siteadmin/withdrawals?status=${s}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const d = await r.json();
      setWithdrawals(d.withdrawals || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const handleAction = () => { setActionModal(null); load(statusFilter); };

  return (
    <div className="adm-withdrawals">
      <div className="adm-filter-row">
        {['pending', 'approved', 'rejected', 'all'].map((s) => (
          <button
            key={s}
            className={`adm-filter-btn${statusFilter === s ? ' active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === 'pending' ? 'Ожидают' : s === 'approved' ? 'Одобрены' : s === 'rejected' ? 'Отклонены' : 'Все'}
          </button>
        ))}
      </div>

      {loading && <div className="adm-loading">Загрузка...</div>}

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Пользователь</th>
              <th>Сумма</th>
              <th>Реквизиты</th>
              <th>Дата</th>
              <th>Статус</th>
              {statusFilter === 'pending' && <th>Действие</th>}
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w._id}>
                <td>{w.userEmail || '—'}</td>
                <td><strong>{w.amount} ₽</strong></td>
                <td className="adm-details">{w.paymentDetails}</td>
                <td>{fmtDate(w.requestedAt)}</td>
                <td>
                  <span className={`adm-status adm-status--${w.status}`}>
                    {w.status === 'pending' ? 'Ожидает' : w.status === 'approved' ? 'Одобрена' : 'Отклонена'}
                  </span>
                  {w.adminNote && <div className="adm-subtext">{w.adminNote}</div>}
                </td>
                {statusFilter === 'pending' && (
                  <td>
                    <div className="adm-action-group">
                      <button
                        className="adm-action-btn adm-action-btn--green"
                        onClick={() => setActionModal({ w, action: 'approve' })}
                      >
                        <CheckCircle size={14} /> Одобрить
                      </button>
                      <button
                        className="adm-action-btn adm-action-btn--red"
                        onClick={() => setActionModal({ w, action: 'reject' })}
                      >
                        <XCircle size={14} /> Отклонить
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {!loading && withdrawals.length === 0 && (
              <tr><td colSpan="6" className="adm-empty">Нет заявок</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {actionModal && (
        <WithdrawalActionModal
          item={actionModal}
          apiKey={apiKey}
          onDone={handleAction}
          onClose={() => setActionModal(null)}
        />
      )}
    </div>
  );
}

function WithdrawalActionModal({ item, apiKey, onDone, onClose }) {
  const { w, action } = item;
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const handle = async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(
        `${API_BASE}/siteadmin/withdrawals/${w.affiliateId}/${w._id}/${action}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        }
      );
      if (r.ok) onDone();
      else { const d = await r.json(); setErr(d.error || 'Ошибка'); }
    } catch { setErr('Ошибка'); }
    setLoading(false);
  };

  return (
    <div className="adm-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="adm-modal">
        <div className="adm-modal-header">
          <span>{action === 'approve' ? 'Одобрить выплату' : 'Отклонить выплату'}</span>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="adm-modal-body">
          <p className="adm-modal-email">{w.userEmail} — <strong>{w.amount} ₽</strong></p>
          <p className="adm-subtext">{w.paymentDetails}</p>
          <div className="adm-form-row">
            <label>Комментарий (необязательно)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Примечание для пользователя" />
          </div>
          {err && <div className="adm-err">{err}</div>}
          <button
            className={`adm-btn ${action === 'approve' ? 'adm-btn--green' : 'adm-btn--red'}`}
            onClick={handle}
            disabled={loading}
          >
            {action === 'approve'
              ? <><CheckCircle size={16} /> {loading ? 'Обрабатываем...' : 'Одобрить'}</>
              : <><XCircle size={16} /> {loading ? 'Обрабатываем...' : 'Отклонить'}</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
