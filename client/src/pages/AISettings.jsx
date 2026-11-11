import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTutorial } from '../context/TutorialContext';
import axios from 'axios';
import {
  Save, Loader2, Sparkles, AlertCircle, Shield, Plus, X, Users, Crown,
  Check, FlaskConical, Edit2, Trash2, Bell, BellOff, ChevronDown,
  MessageSquare, Monitor, Code2, Settings, Ban, Database,
} from 'lucide-react';
import { TelegramIcon, VKIcon } from '../components/BrandIcons';
import './AISettings.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const PROFILE_COLORS = [
  '#667eea', '#10b981', '#f59e0b', '#ef4444',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#84cc16',
];

const PLATFORMS = [
  { value: 'telegram', label: 'Telegram', color: '#2aabee' },
  { value: 'vk',       label: 'VK',       color: '#4a76a8' },
  { value: 'web',      label: 'Веб-сайт', color: '#667eea' },
];

const TUTORIAL_STEPS = [
  {
    selector: '.profile-chip',
    text: 'AI-профили — каждый профиль это отдельный ассистент со своим именем, промтом и настройками.\n\nНажмите на профиль для переключения. Наведите мышь, чтобы переименовать или удалить.',
  },
  {
    selector: '.profile-add-btn',
    text: 'Кнопка «+» — создать новый AI-профиль.\n\nНапример: один профиль для Telegram-бота, другой — для виджета на сайте. У каждого свои данные, промт и интеграции.',
  },
  {
    selector: '[data-tut="prompt"]',
    text: 'Системный промт — главная инструкция вашему AI.\n\nОписывайте: кто он, что знает, как отвечает, какой тон общения. Чем точнее инструкция — тем профессиональнее ответы клиентам.',
  },
  {
    selector: '[data-tut="restrictions"]',
    text: '«Ограничения» — темы, которые AI вежливо игнорирует.\n\nПример: не обсуждать конкурентов, не давать медицинских советов, не говорить о политике. Просто перечислите — AI сам поймёт.',
  },
  {
    selector: '.platform-grid',
    text: '«Где будете использовать?» — выберите платформы для этого профиля.\n\nПосле сохранения появятся готовые пошаговые инструкции по подключению к каждой выбранной платформе.',
  },
  {
    selector: '.save-btn',
    text: '«Сохранить и продолжить» — применяет все изменения профиля.\n\nФорма сохраняется автоматически раз в несколько секунд — но лучше нажать явно перед переходом к интеграциям.',
  },
  {
    selector: '.notif-section',
    text: '🔔 Автоматические уведомления — самая мощная фича.\n\nНастройте правила, по которым AI сам отправляет сообщения:\n\n• Клиент записался → уведомление администратору в Telegram\n• Изменилась запись → автоматический отчёт владельцу\n• Новый отзыв → мгновенный алерт нужному человеку\n• За N часов до приёма → клиент получает напоминание автоматически\n\nВозможности не ограничены: всё зависит от вашей фантазии. Любые правила можно создавать, дополнять и редактировать прямо через промт — без единой строки кода.',
  },
  {
    selector: null,
    text: 'Мы всегда рады обратной связи!\n\nЕсли нашли баг, есть идея или хочется поделиться впечатлениями — напишите нам:\n\nВаш фидбек напрямую влияет на развитие Siberi AI. Спасибо, что вы с нами!',
    email: 'hello@siberi.online',
  },
];

export default function AISettings({ apiKey }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { enabled, startTutorial, isActive, skipped, completedPaths } = useTutorial();
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [formData, setFormData] = useState({
    aiName: '',
    systemPrompt: '',
    restrictions: '',
    integrations: { telegram: false, vk: false, max: false, website: false, fullpage: false, api: false },
  });

  // ── Профили ──────────────────────────────────────────────────
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [planLimits, setPlanLimits] = useState(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [showNewProfileInput, setShowNewProfileInput] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameColor, setRenameColor] = useState(null);

  // Dev: Qwen test mode
  const [forceQwen, setForceQwen] = useState(null);
  const [qwenToggleLoading, setQwenToggleLoading] = useState(false);

  // Управление доступом
  const [admins, setAdmins] = useState([]);
  const [newCreator, setNewCreator] = useState({ platform: 'telegram', platformUserId: '', displayName: '' });
  const [newAdmin, setNewAdmin] = useState({ platform: 'telegram', platformUserId: '', displayName: '' });
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [permissions, setPermissions] = useState({
    allowCreate: true, allowUpdate: false, allowDelete: false, allowSchemaCreate: false,
    adminAllowCreate: true, adminAllowUpdate: true, adminAllowDelete: true, adminAllowSchemaCreate: true,
  });

  const [schemaVisibility, setSchemaVisibility] = useState({});
  const [availableSchemas, setAvailableSchemas] = useState([]);
  const [visibilityLoading, setVisibilityLoading] = useState(false);
  const [visDropdownOpen, setVisDropdownOpen] = useState(null);

  const [highlightNewProfile, setHighlightNewProfile] = useState(false);

  // ── Уведомления ──────────────────────────────────────────────
  const [notifRules, setNotifRules] = useState([]);
  const [notifContext, setNotifContext] = useState({ schemas: [], profiles: [] });
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifFormOpen, setNotifFormOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [notifForm, setNotifForm] = useState({
    name: '',
    enabled: true,
    profileId: '',
    recipientType: 'specific_id',
    recipients: [''],
    recipientChatIdField: '_tg_chat_id',
    triggerType: 'time_before',
    schemaName: '',
    dateField: 'date',
    minutesBefore: 120,
    reportHour: 9,
    messagePrompt: '',
  });
  const [recipientResolutions, setRecipientResolutions] = useState([null]); // null | 'resolving' | 'ok' | 'not_found'

  // ── Auto-save ─────────────────────────────────────────────────
  const [autoSaveStatus, setAutoSaveStatus] = useState(null); // null | 'saving' | 'saved'
  const isDirtyRef = useRef(false);
  const autoSaveTimerRef = useRef(null);
  const formDataRef = useRef(formData);
  const activeProfileIdRef = useRef(null);

  // Keep refs in sync
  useEffect(() => { formDataRef.current = formData; }, [formData]);
  useEffect(() => { activeProfileIdRef.current = activeProfileId; }, [activeProfileId]);

  useEffect(() => {
    if (enabled && !isActive && !skipped && !completedPaths.has('/settings')) {
      const t = setTimeout(() => { if (window.location.pathname === '/settings') startTutorial(TUTORIAL_STEPS, '/settings'); }, 900);
      return () => clearTimeout(t);
    }
  }, [enabled, isActive, skipped, completedPaths]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (apiKey) {
      fetchProfiles();
      fetchAdmins();
      fetchPermissions();
      fetchNotifRules();
      fetchNotifContext();
      axios.get(`${API_URL}/dev/toggle-qwen`, { headers: headers() })
        .then(r => setForceQwen(r.data.forceQwen))
        .catch(() => {});
    }
  }, [apiKey]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('highlight') === 'new-profile') {
      setHighlightNewProfile(true);
      const t = setTimeout(() => setHighlightNewProfile(false), 7000);
      return () => clearTimeout(t);
    }
  }, [location.search]);

  useEffect(() => {
    if (apiKey && activeProfileId) {
      fetchConfig(activeProfileId);
      fetchSchemaVisibility(activeProfileId);
    }
  }, [activeProfileId]);

  // Close schema visibility dropdown on outside click
  useEffect(() => {
    if (!visDropdownOpen) return;
    const handler = (e) => {
      if (!e.target.closest('.schema-vis-dropdown')) setVisDropdownOpen(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [visDropdownOpen]);

  // ── Auto-save effect ──────────────────────────────────────────
  useEffect(() => {
    if (!isDirtyRef.current || !apiKey) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setAutoSaveStatus('saving');
    autoSaveTimerRef.current = setTimeout(autoSaveConfig, 1400);
  }, [formData]);

  const headers = () => ({ Authorization: `Bearer ${apiKey}` });

  const updateFormData = (patch) => {
    isDirtyRef.current = true;
    setFormData(prev => ({ ...prev, ...patch }));
  };

  const autoSaveConfig = async () => {
    const data = formDataRef.current;
    const profileId = activeProfileIdRef.current;
    if (!apiKey || !data) return;
    try {
      await axios.post(
        `${API_URL}/config`,
        { ...data, profileId },
        { headers: headers(), timeout: 10000 }
      );
      setAutoSaveStatus('saved');
      setTimeout(() => setAutoSaveStatus(null), 2500);
    } catch {
      setAutoSaveStatus(null);
    }
  };

  const fetchProfiles = async () => {
    setProfilesLoading(true);
    try {
      const res = await axios.get(`${API_URL}/profiles`, { headers: headers() });
      if (res.data.success) {
        setProfiles(res.data.profiles || []);
        setPlanLimits(res.data.planLimits);
        const aid = res.data.activeProfileId;
        setActiveProfileId(aid || res.data.profiles[0]?._id || null);
      }
    } catch {}
    finally { setProfilesLoading(false); }
  };

  const fetchAdmins = async () => {
    try {
      const res = await axios.get(`${API_URL}/access/admins`, { headers: headers() });
      if (res.data.success) setAdmins(res.data.admins);
    } catch {}
  };

  const fetchPermissions = async () => {
    try {
      const res = await axios.get(`${API_URL}/access/permissions`, { headers: headers() });
      if (res.data.success) setPermissions(res.data.permissions);
    } catch {}
  };

  const fetchNotifRules = async () => {
    try {
      const res = await axios.get(`${API_URL}/notifications/rules`, { headers: headers() });
      if (res.data.success) setNotifRules(res.data.rules);
    } catch {}
  };

  const fetchNotifContext = async () => {
    try {
      const res = await axios.get(`${API_URL}/notifications/context`, { headers: headers() });
      if (res.data.success) setNotifContext(res.data);
    } catch {}
  };

  const openNotifForm = (rule = null) => {
    if (rule) {
      setEditingRule(rule._id);
      const recs = rule.recipients?.length ? rule.recipients : (rule.recipientChatId ? [rule.recipientChatId] : ['']);
      setNotifForm({
        name: rule.name || '',
        enabled: rule.enabled !== false,
        profileId: rule.profileId || '',
        recipientType: rule.recipientType || 'specific_id',
        recipients: recs,
        recipientChatIdField: rule.recipientChatIdField || '_tg_chat_id',
        triggerType: rule.triggerType || 'time_before',
        schemaName: rule.schemaName || '',
        dateField: rule.dateField || 'date',
        minutesBefore: rule.minutesBefore ?? 120,
        reportHour: rule.reportHour ?? 9,
        messagePrompt: rule.messagePrompt || '',
      });
      setRecipientResolutions(recs.map(() => null));
    } else {
      setEditingRule(null);
      setNotifForm({
        name: '',
        enabled: true,
        profileId: notifContext.profiles[0]?._id || '',
        recipientType: 'specific_id',
        recipients: [''],
        recipientChatIdField: '_tg_chat_id',
        triggerType: 'time_before',
        schemaName: notifContext.schemas[0]?.name || '',
        dateField: 'date',
        minutesBefore: 120,
        reportHour: 9,
        messagePrompt: '',
      });
      setRecipientResolutions([null]);
    }
    setNotifFormOpen(true);
  };

  const saveNotifRule = async () => {
    setNotifLoading(true);
    try {
      const payload = {
        ...notifForm,
        recipients: notifForm.recipients.filter(r => r.trim()),
      };
      if (editingRule) {
        await axios.put(`${API_URL}/notifications/rules/${editingRule}`, payload, { headers: headers() });
      } else {
        await axios.post(`${API_URL}/notifications/rules`, payload, { headers: headers() });
      }
      await fetchNotifRules();
      setNotifFormOpen(false);
      setEditingRule(null);
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setNotifLoading(false);
    }
  };

  const updateRecipient = (idx, val) => {
    setNotifForm(f => {
      const recs = [...f.recipients];
      recs[idx] = val;
      return { ...f, recipients: recs };
    });
    setRecipientResolutions(prev => { const n = [...prev]; n[idx] = null; return n; });
  };

  const addEmptyRecipient = () => {
    setNotifForm(f => ({ ...f, recipients: [...f.recipients, ''] }));
    setRecipientResolutions(prev => [...prev, null]);
  };

  const removeRecipient = (idx) => {
    setNotifForm(f => {
      const recs = f.recipients.filter((_, i) => i !== idx);
      return { ...f, recipients: recs.length ? recs : [''] };
    });
    setRecipientResolutions(prev => {
      const n = prev.filter((_, i) => i !== idx);
      return n.length ? n : [null];
    });
  };

  const addContactRecipient = (chatId, currentRecipients) => {
    if (currentRecipients.includes(chatId)) return;
    setNotifForm(f => {
      const recs = [...f.recipients];
      const emptyIdx = recs.findIndex(r => !r.trim());
      if (emptyIdx >= 0) recs[emptyIdx] = chatId;
      else recs.push(chatId);
      return { ...f, recipients: recs };
    });
    setRecipientResolutions(prev => {
      const n = [...prev];
      const emptyIdx = currentRecipients.findIndex(r => !r.trim());
      if (emptyIdx >= 0) n[emptyIdx] = 'ok';
      else n.push('ok');
      return n;
    });
  };

  const resolveRecipient = async (idx) => {
    const val = notifForm.recipients[idx]?.trim();
    if (!val || /^-?\d+$/.test(val)) return;
    const profileId = notifForm.profileId;
    if (!profileId) return;
    setRecipientResolutions(prev => { const n = [...prev]; n[idx] = 'resolving'; return n; });
    try {
      const res = await axios.get(`${API_URL}/notifications/resolve-contact`, {
        headers: headers(),
        params: { input: val, profileId },
      });
      setRecipientResolutions(prev => {
        const n = [...prev];
        n[idx] = res.data.success ? 'ok' : 'not_found';
        return n;
      });
    } catch {
      setRecipientResolutions(prev => { const n = [...prev]; n[idx] = 'not_found'; return n; });
    }
  };

  const deleteNotifRule = async (id) => {
    if (!window.confirm('Удалить правило уведомления?')) return;
    try {
      await axios.delete(`${API_URL}/notifications/rules/${id}`, { headers: headers() });
      setNotifRules(prev => prev.filter(r => r._id !== id));
    } catch {}
  };

  const toggleNotifRule = async (rule) => {
    try {
      await axios.put(`${API_URL}/notifications/rules/${rule._id}`, { enabled: !rule.enabled }, { headers: headers() });
      setNotifRules(prev => prev.map(r => r._id === rule._id ? { ...r, enabled: !r.enabled } : r));
    } catch {}
  };

  const fetchSchemaVisibility = async (profileId) => {
    if (!apiKey || !profileId) return;
    try {
      const res = await axios.get(`${API_URL}/config/schema-visibility`, {
        headers: headers(),
        params: { profileId },
      });
      if (res.data.success) {
        setAvailableSchemas(res.data.schemas || []);
        setSchemaVisibility(res.data.visibility || {});
      }
    } catch {}
  };

  const updateVisibility = async (schemaName, level) => {
    if (!apiKey || !activeProfileId) return;
    setSchemaVisibility(prev => ({ ...prev, [schemaName]: level }));
    try {
      await axios.patch(`${API_URL}/config/schema-visibility`, {
        profileId: activeProfileId,
        schemaName,
        level,
      }, { headers: headers() });
    } catch {
      // revert on error
      fetchSchemaVisibility(activeProfileId);
    }
  };

  const fetchConfig = async (profileId) => {
    if (!apiKey) return;
    try {
      const params = profileId ? { profileId } : {};
      const response = await axios.get(`${API_URL}/config`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        params,
        timeout: 10000,
      });
      if (response.data.success && response.data.config) {
        const cfg = response.data.config;
        isDirtyRef.current = false;
        setFormData({
          aiName: cfg.aiName || '',
          systemPrompt: cfg.systemPrompt || '',
          restrictions: cfg.restrictions || '',
          integrations: { telegram: false, vk: false, max: false, website: false, fullpage: false, api: false, ...(cfg.integrations || {}) },
        });
        setFetchError(null);
      }
    } catch (err) {
      if (err.response?.status === 403) setFetchError('⚠️ Доступ запрещён. Проверьте API-ключ.');
      else if (err.response?.status === 401) setFetchError('🔐 Неавторизован. Пожалуйста, войдите снова.');
      else if (err.code === 'ERR_NETWORK') setFetchError('🌐 Сервер недоступен.');
      else setFetchError('Ошибка: ' + (err.response?.data?.error || err.message));
    }
  };

  const switchProfile = async (profileId) => {
    try {
      await axios.put(`${API_URL}/profiles/${profileId}/activate`, {}, { headers: headers() });
      setActiveProfileId(profileId);
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка');
    }
  };

  const createProfile = async () => {
    if (!newProfileName.trim()) return;
    setCreatingProfile(true);
    try {
      const res = await axios.post(`${API_URL}/profiles`, {
        profileName: newProfileName.trim(),
        systemPrompt: 'Ты — полезный AI-помощник.',
      }, { headers: headers() });
      if (res.data.success) {
        await fetchProfiles();
        setShowNewProfileInput(false);
        setNewProfileName('');
        switchProfile(res.data.profile._id);
      }
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка создания профиля');
    } finally {
      setCreatingProfile(false);
    }
  };

  const deleteProfile = async (id) => {
    if (!confirm('Удалить профиль? Все настройки этого профиля будут потеряны.')) return;
    try {
      const res = await axios.delete(`${API_URL}/profiles/${id}`, { headers: headers() });
      if (res.data.success) {
        await fetchProfiles();
        if (res.data.activeProfileId) setActiveProfileId(res.data.activeProfileId);
      }
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка');
    }
  };

  const startRename = (profile) => {
    setRenamingId(profile._id);
    setRenameValue(profile.profileName || '');
    setRenameColor(profile.color || null);
  };

  const saveRename = async (id) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    try {
      await axios.patch(`${API_URL}/profiles/${id}`, { profileName: renameValue.trim(), color: renameColor }, { headers: headers() });
      setProfiles(prev => prev.map(p => p._id === id ? { ...p, profileName: renameValue.trim(), color: renameColor } : p));
    } catch {}
    setRenamingId(null);
  };

  const addEntry = async (role) => {
    const entry = role === 'creator' ? newCreator : newAdmin;
    const setEntry = role === 'creator' ? setNewCreator : setNewAdmin;
    const setLoad = role === 'creator' ? setCreatorLoading : setAdminLoading;
    if (!entry.platformUserId.trim()) return;
    setLoad(true);
    try {
      const res = await axios.post(`${API_URL}/access/admins`, { ...entry, role }, { headers: headers() });
      if (res.data.success) {
        setAdmins(prev => [...prev, res.data.admin]);
        setEntry({ platform: 'telegram', platformUserId: '', displayName: '' });
      }
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка');
    } finally {
      setLoad(false);
    }
  };

  const removeAdmin = async (id) => {
    try {
      await axios.delete(`${API_URL}/access/admins/${id}`, { headers: headers() });
      setAdmins(prev => prev.filter(a => a._id !== id));
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка');
    }
  };

  const savePermissionsAuto = async (newPerms) => {
    try {
      await axios.put(`${API_URL}/access/permissions`, newPerms, { headers: headers() });
    } catch {}
  };

  const toggleQwen = async () => {
    setQwenToggleLoading(true);
    try {
      const res = await axios.post(`${API_URL}/dev/toggle-qwen`, {}, { headers: headers() });
      setForceQwen(res.data.forceQwen);
    } catch {}
    finally { setQwenToggleLoading(false); }
  };

  const renderAddRow = (role, entry, setEntry, isLoading) => (
    <div className="acc__row">
      <span className="pseg">
        {PLATFORMS.map(p => (
          <button
            key={p.value}
            type="button"
            className={`pseg__b${entry.platform === p.value ? ' pseg__b--active' : ''}`}
            onClick={() => setEntry({ ...entry, platform: p.value })}
          >
            {p.label}
          </button>
        ))}
      </span>
      <input
        className="inp inp--id"
        placeholder="ID пользователя"
        value={entry.platformUserId}
        onChange={e => setEntry({ ...entry, platformUserId: e.target.value })}
        onKeyDown={e => e.key === 'Enter' && addEntry(role)}
      />
      <button type="button" className="btn btn--ghost" onClick={() => addEntry(role)} disabled={isLoading || !entry.platformUserId.trim()}>
        {isLoading ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
        Добавить
      </button>
    </div>
  );

  const renderPermToggles = (keys) => keys.map(({ key, label, desc }) => (
    <label
      key={key}
      className="opt"
      onClick={() => setPermissions(p => {
        const updated = { ...p, [key]: !p[key] };
        savePermissionsAuto(updated);
        return updated;
      })}
    >
      <span className="opt__main">
        <span className="opt__n">{label}</span>
        <span className="opt__d">{desc}</span>
      </span>
      <span className={`sw${permissions[key] ? ' sw--on' : ''}`} role="switch" aria-checked={!!permissions[key]}>
        <span className="sw__k" />
      </span>
    </label>
  ));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!apiKey) { alert('❌ API ключ не найден.'); return; }
    if (!formData.systemPrompt || formData.systemPrompt.trim().length < 20) {
      alert('⚠️ Инструкция должна содержать минимум 20 символов');
      return;
    }
    setLoading(true);
    try {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      await autoSaveConfig();
      navigate('/integrations?onboarding=true', {
        state: { aiName: formData.aiName, integrations: formData.integrations },
      });
    } catch (err) {
      alert(err.response?.data?.error || err.message || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  if (!apiKey) {
    return (
      <div className="ai-settings-page">
        <div className="card auth-required">
          <AlertCircle size={40} />
          <h2>Требуется авторизация</h2>
          <button onClick={() => navigate('/login')} className="btn btn--primary">Войти</button>
        </div>
      </div>
    );
  }

  const canAddProfile = planLimits && profiles.length < planLimits.profiles;

  return (
    <div className="ai-settings-page">
      {fetchError && (
        <div className="error-banner">
          <AlertCircle size={16} />
          <span>{fetchError}</span>
          <button onClick={() => fetchConfig(activeProfileId)}>Повторить</button>
        </div>
      )}

      {/* ── Переключатель профилей ──────────────────────────────── */}
      {!profilesLoading && (
        <div className="card profiles-switcher">
          <div className="card__head">
            <h3><Users size={16} /> AI-профили</h3>
            {planLimits && (
              <span className="muted-s">
                {profiles.length} / {planLimits.profiles === Infinity ? '∞' : planLimits.profiles}
              </span>
            )}
          </div>
          <div className="profiles-list">
            {profiles.map(p => (
              <div key={p._id} className={`profile-chip ${p._id === activeProfileId ? 'active' : ''}`}
                style={p.color ? { '--profile-color': p.color } : {}}>
                {renamingId === p._id ? (
                  <div className="profile-rename-wrap">
                    <input
                      className="profile-rename-input"
                      value={renameValue}
                      autoFocus
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveRename(p._id); if (e.key === 'Escape') setRenamingId(null); }}
                    />
                    <div className="profile-color-palette">
                      {PROFILE_COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          className={`profile-color-swatch${renameColor === c ? ' selected' : ''}`}
                          style={{ background: c }}
                          onClick={() => setRenameColor(renameColor === c ? null : c)}
                          title={c}
                        />
                      ))}
                    </div>
                    <div className="profile-rename-actions">
                      <button className="profile-rename-save" onClick={() => saveRename(p._id)}><Check size={12} /></button>
                      <button className="profile-rename-cancel" onClick={() => setRenamingId(null)}><X size={12} /></button>
                    </div>
                  </div>
                ) : (
                  <button className="profile-chip__name" onClick={() => switchProfile(p._id)}>
                    {p.color && <span className="profile-color-dot" style={{ background: p.color }} />}
                    {p.profileName || p.aiName || 'Профиль'}
                  </button>
                )}
                {renamingId !== p._id && (
                  <div className="profile-chip__actions">
                    <button onClick={() => startRename(p)} title="Переименовать"><Edit2 size={12} /></button>
                    {profiles.length > 1 && (
                      <button onClick={() => deleteProfile(p._id)} title="Удалить" className="delete-profile-btn">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {canAddProfile && (
              showNewProfileInput ? (
                <div className="profile-new-input-row">
                  <input
                    className="profile-rename-input"
                    placeholder="Имя профиля"
                    value={newProfileName}
                    autoFocus
                    onChange={e => setNewProfileName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') createProfile(); if (e.key === 'Escape') setShowNewProfileInput(false); }}
                  />
                  <button className="profile-create-btn" onClick={createProfile} disabled={creatingProfile}>
                    {creatingProfile ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                  </button>
                  <button className="profile-cancel-btn" onClick={() => setShowNewProfileInput(false)}><X size={13} /></button>
                </div>
              ) : (
                <button
                  className={`profile-add-btn${highlightNewProfile ? ' profile-add-btn--highlight' : ''}`}
                  onClick={() => setShowNewProfileInput(true)}
                >
                  <Plus size={14} /> Новый профиль
                </button>
              )
            )}

            {!canAddProfile && planLimits && (
              <button className="profile-add-btn profile-add-btn--locked" onClick={() => navigate('/billing')} title={`Тариф «${planLimits.label}» — лимит профилей`}>
                <Crown size={14} /> Улучшить план
              </button>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="settings-form">
        {/* ── Основная информация ────────────────────────────────── */}
        <div className="card">
          <div className="card__head"><h3><Settings size={16} /> Основная информация</h3></div>
          <div className="field">
            <label>Имя AI-помощника</label>
            <input
              className="inp"
              type="text"
              value={formData.aiName ?? ''}
              onChange={(e) => updateFormData({ aiName: e.target.value })}
              placeholder="Например: Анна-консультант"
              maxLength={50}
            />
          </div>
        </div>

        {/* ── Системный промпт ───────────────────────────────────── */}
        <div className="card" data-tut="prompt">
          <div className="card__head"><h3><MessageSquare size={16} /> Системный промпт</h3></div>
          <div className="field">
            <label>Инструкция для AI</label>
            <textarea
              className="inp inp--area"
              value={formData.systemPrompt ?? ''}
              onChange={(e) => updateFormData({ systemPrompt: e.target.value })}
              placeholder="Ты — вежливый консультант..."
              rows={10}
              minLength={20}
              maxLength={10000}
            />
            <span className="field__hint">{(formData.systemPrompt || '').length}/10000 · мин. 20 символов</span>
          </div>
        </div>

        {/* ── Ограничения ────────────────────────────────────────── */}
        <div className="card" data-tut="restrictions">
          <div className="card__head"><h3><Ban size={16} /> Ограничения</h3></div>
          <div className="field">
            <label>О чём нейросеть не должна говорить</label>
            <textarea
              className="inp inp--area"
              value={formData.restrictions ?? ''}
              onChange={(e) => updateFormData({ restrictions: e.target.value })}
              placeholder="Например: не обсуждать конкурентов, не давать юридических советов..."
              rows={5}
              maxLength={10000}
            />
            <span className="field__hint">{(formData.restrictions || '').length}/10000 · AI будет вежливо уходить от этих тем</span>
          </div>
        </div>

        {/* ── Где будете использовать? ───────────────────────────── */}
        <div className="card">
          <div className="card__head"><h3><Code2 size={16} /> Где будете использовать?</h3></div>
          <p className="card__note">Выберите платформы — после сохранения покажем готовые инструкции</p>

          <div className="platform-grid chgrid">
            {[
              { key: 'telegram', icon: <TelegramIcon size={17} />, label: 'Telegram',    desc: 'Бот для клиентов' },
              { key: 'vk',       icon: <VKIcon size={17} />,       label: 'VK',          desc: 'Сообщество ВКонтакте' },
              { key: 'website',  icon: <MessageSquare size={17} />, label: 'Виджет',       desc: 'Онлайн-консультант' },
              { key: 'fullpage', icon: <Monitor size={17} />,      label: 'AI-страница',  desc: 'Отдельный чат-сайт' },
              { key: 'api',      icon: <Code2 size={17} />,        label: 'API / SDK',    desc: 'Свой проект / код' },
            ].map(({ key, icon, label, desc }) => {
              const checked = !!formData.integrations?.[key];
              return (
                <button
                  key={key}
                  type="button"
                  className={`chbox${checked ? ' chbox--on' : ''}`}
                  onClick={() => updateFormData({ integrations: { ...formData.integrations, [key]: !checked } })}
                >
                  <span className="chbox__ic">{icon}</span>
                  <span className="chbox__t">
                    <span className="chbox__n">{label}</span>
                    <span className="chbox__sub">{desc}</span>
                  </span>
                  <span className="chbox__ck"><Check size={14} /></span>
                </button>
              );
            })}
          </div>

          <div className="integration-hint">
            <Sparkles size={16} />
            <span>После сохранения откроется страница с готовыми инструкциями</span>
          </div>
        </div>

        {/* Футер формы: отдельная карточка — кнопка не висит в пустоте,
            слева поясняем, что правки и так сохраняются сами. */}
        <div className="card form-actions">
          <div className="form-actions__l">
            <span className="opt__n">Изменения сохраняются автоматически</span>
            <span className="opt__d">Нажмите, чтобы применить их сразу и перейти к подключению платформ.</span>
            <div className="autosave-status">
              {autoSaveStatus === 'saving' && <span className="autosave-indicator autosave-indicator--saving"><Loader2 size={13} className="spin" /> Сохраняю…</span>}
              {autoSaveStatus === 'saved' && <span className="autosave-indicator autosave-indicator--saved"><Check size={13} /> Автосохранено</span>}
            </div>
          </div>
          <button type="submit" className="btn btn--primary save-btn" disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <><Save size={16} /> Сохранить и продолжить</>}
          </button>
        </div>
      </form>

      {/* ── Управление доступом ───────────────────────────────────── */}
      <div className="card">
        <div className="card__head"><h3><Shield size={16} /> Управление доступом</h3></div>

        <div className="acc">
          <div className="acc__t"><Crown size={15} /> Создатель</div>
          <p className="acc__d">
            Создатель обладает абсолютными правами к схемам данных этого аккаунта. Укажите платформу и ваш ID на ней.
          </p>
          {admins.filter(a => a.role === 'creator').length > 0 && (
            <div className="admins-list">
              {admins.filter(a => a.role === 'creator').map(a => (
                <div key={a._id} className="admin-row">
                  <span className="chip">{PLATFORMS.find(p => p.value === a.platform)?.label ?? a.platform}</span>
                  <span className="admin-id">{a.platformUserId}</span>
                  <span className="admin-name">{a.displayName || '—'}</span>
                  <button type="button" className="admin-remove" onClick={() => removeAdmin(a._id)}><X size={14} /></button>
                </div>
              ))}
            </div>
          )}
          {renderAddRow('creator', newCreator, setNewCreator, creatorLoading)}
        </div>

        <div className="acc acc--bordered">
          <div className="acc__t"><Users size={15} /> Администраторы</div>
          <p className="acc__d">Администраторы могут управлять данными в рамках разрешённых прав.</p>
          {admins.filter(a => a.role !== 'creator').length > 0 && (
            <div className="admins-list">
              {admins.filter(a => a.role !== 'creator').map(a => (
                <div key={a._id} className="admin-row">
                  <span className="chip">{PLATFORMS.find(p => p.value === a.platform)?.label ?? a.platform}</span>
                  <span className="admin-id">{a.platformUserId}</span>
                  <span className="admin-name">{a.displayName || '—'}</span>
                  <button type="button" className="admin-remove" onClick={() => removeAdmin(a._id)}><X size={14} /></button>
                </div>
              ))}
            </div>
          )}
          {renderAddRow('admin', newAdmin, setNewAdmin, adminLoading)}

          <div className="acc__sub">
            <Shield size={14} /> Права администраторов <span className="muted-s">· что могут делать через бота</span>
          </div>
          {renderPermToggles([
            { key: 'adminAllowCreate', label: 'Создавать записи', desc: 'Добавлять новые записи в базу данных' },
            { key: 'adminAllowUpdate', label: 'Редактировать записи', desc: 'Изменять существующие данные' },
            { key: 'adminAllowDelete', label: 'Удалять записи', desc: 'Удалять данные из базы' },
            { key: 'adminAllowSchemaCreate', label: 'Создавать новые схемы', desc: 'Создавать новые типы данных' },
          ])}
        </div>
      </div>

      {/* ── Права пользователей ───────────────────────────────────── */}
      <div className="card">
        <div className="card__head"><h3><Users size={16} /> Права пользователей</h3></div>
        <p className="card__note">Что могут делать обычные пользователи (не администраторы) через бота. Изменения сохраняются автоматически.</p>
        {renderPermToggles([
          { key: 'allowCreate', label: 'Создавать записи', desc: 'Записаться на приём, добавить задачу и т.д.' },
          { key: 'allowUpdate', label: 'Редактировать записи', desc: 'Изменять существующие данные' },
          { key: 'allowDelete', label: 'Удалять записи', desc: 'Удалять данные из базы' },
          { key: 'allowSchemaCreate', label: 'Создавать новые схемы', desc: 'Создавать новые типы данных' },
        ])}
      </div>

      {/* ── Видимость данных (схемы) ─────────────────────────────── */}
      {availableSchemas.length > 0 && (() => {
        const VIS_OPTS = [
          {
            value: 'all',
            label: 'Открыто всем',
            desc: 'Нейросеть может использовать эти данные в ответах обычным пользователям',
            dot: 'dot--ok',
          },
          {
            value: 'admin',
            label: 'Создатели и администраторы',
            desc: 'Обычные пользователи не увидят эти данные в ответах ИИ',
            dot: '',
          },
          {
            value: 'creator',
            label: 'Только создатель',
            desc: 'Данные доступны исключительно вам как создателю',
            dot: 'dot--off',
          },
        ];
        return (
          <div className="card">
            <div className="card__head"><h3><Shield size={16} /> Видимость данных</h3></div>
            <p className="card__note">
              Управляйте тем, какие данные нейросеть может раскрывать обычным пользователям в своих ответах.
              Создатель и администраторы всегда видят всё.
            </p>
            <div className="schema-vis-list">
              {availableSchemas.map(schema => {
                const level = schemaVisibility[schema.name] || 'all';
                const current = VIS_OPTS.find(o => o.value === level) || VIS_OPTS[0];
                const isOpen = visDropdownOpen === schema.name;
                return (
                  <div key={schema.name} className="vis-row">
                    <span className="vis-row__l">
                      {schema.icon
                        ? <span className="schema-vis-icon">{schema.icon}</span>
                        : <Database size={16} />}
                      {schema.label || schema.name}
                      <span className="muted-s">{schema.name}</span>
                    </span>
                    <div className="schema-vis-dropdown" style={{ position: 'relative' }}>
                      <button
                        type="button"
                        className="vis-sel"
                        onClick={() => setVisDropdownOpen(isOpen ? null : schema.name)}
                      >
                        <span className={`dot ${current.dot}`}>{current.label}</span>
                        <ChevronDown size={14} style={{ transition: 'transform 0.15s', transform: isOpen ? 'rotate(180deg)' : 'none', flexShrink: 0 }} />
                      </button>
                      {isOpen && (
                        <div className="schema-vis-popover">
                          {VIS_OPTS.map(opt => (
                            <button
                              key={opt.value}
                              type="button"
                              className={`schema-vis-opt${opt.value === level ? ' schema-vis-opt--active' : ''}`}
                              onClick={() => { updateVisibility(schema.name, opt.value); setVisDropdownOpen(null); }}
                            >
                              <span className={`dot ${opt.dot} schema-vis-opt-dot`} />
                              <span className="schema-vis-opt-text">
                                <span className="schema-vis-opt-label">{opt.label}</span>
                                <span className="schema-vis-opt-desc">{opt.desc}</span>
                              </span>
                              {opt.value === level && <Check size={13} className="schema-vis-opt-check" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Автоматические уведомления ───────────────────────────── */}
      <div className="card notif-section">
        <div className="card__head">
          <h3><Bell size={16} /> Автоматические уведомления</h3>
          <button type="button" className="btn btn--ghost" onClick={() => openNotifForm()}>
            <Plus size={14} /> Добавить правило
          </button>
        </div>
        <p className="card__note">
          Ваш AI-бот сам напомнит клиентам о записях, отправит сводку дня или оповестит о новых заявках — прямо в Telegram.
        </p>

        {notifRules.length === 0 && !notifFormOpen && (
          <div className="empty empty--inline">
            <div className="empty__ic"><BellOff size={24} /></div>
            <div className="empty__d">Нет правил. Создайте первое — и бот начнёт работать автоматически.</div>
          </div>
        )}

        <div className="rules">
          {notifRules.map(rule => {
            const profile = notifContext.profiles.find(p => p._id === rule.profileId);
            const triggerLabel = { new_record: 'Новая запись', time_before: 'За N минут до события', daily_report: 'Ежедневный отчёт' }[rule.triggerType] || rule.triggerType;
            return (
              <div key={rule._id} className={`rule${rule.enabled ? '' : ' rule--off'}`}>
                <span className="rule__ic">{rule.enabled ? <Bell size={16} /> : <BellOff size={16} />}</span>
                <span className="rule__main">
                  <span className="rule__t">{rule.name || 'Правило'}</span>
                  <span className="rule__d">
                    {profile?.label || 'AI-профиль'} · {triggerLabel}
                    {rule.triggerType === 'time_before' && ` · ${rule.minutesBefore} мин`}
                    {rule.triggerType === 'daily_report' && ` · ${rule.reportHour}:00`}
                  </span>
                </span>
                <span
                  className={`sw${rule.enabled ? ' sw--on' : ''}`}
                  role="switch"
                  aria-checked={!!rule.enabled}
                  title={rule.enabled ? 'Выключить' : 'Включить'}
                  onClick={() => toggleNotifRule(rule)}
                >
                  <span className="sw__k" />
                </span>
                <button type="button" className="cmd__x" title="Изменить" onClick={() => openNotifForm(rule)}><Edit2 size={13} /></button>
                <button type="button" className="cmd__x" title="Удалить" onClick={() => deleteNotifRule(rule._id)}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>

        {notifFormOpen && (
          <div className="notif-form-overlay" onClick={e => { if (e.target === e.currentTarget) setNotifFormOpen(false); }}>
            <div className="notif-form-card">
              <div className="notif-form-head">
                <span>{editingRule ? 'Изменить правило' : 'Новое правило'}</span>
                <button onClick={() => setNotifFormOpen(false)}><X size={16} /></button>
              </div>

              <div className="notif-form-body">
                {/* Название */}
                <label className="notif-field-label">Название</label>
                <input className="notif-input" placeholder="Напр. «Напоминание о записи»"
                  value={notifForm.name} onChange={e => setNotifForm(f => ({ ...f, name: e.target.value }))} />

                {/* AI-профиль */}
                <label className="notif-field-label">AI-профиль (Telegram-бот)</label>
                <select className="notif-select" value={notifForm.profileId}
                  onChange={e => setNotifForm(f => ({ ...f, profileId: e.target.value }))}>
                  <option value="">— выберите профиль —</option>
                  {notifContext.profiles.filter(p => p.hasTelegram).map(p => (
                    <option key={p._id} value={p._id}>{p.label}</option>
                  ))}
                </select>
                {notifContext.profiles.filter(p => p.hasTelegram).length === 0 && (
                  <p className="notif-hint">Подключите Telegram-бота к одному из AI-профилей в разделе «Интеграции».</p>
                )}

                {/* Триггер */}
                <label className="notif-field-label">Триггер</label>
                <div className="notif-trigger-tabs">
                  {[
                    { v: 'new_record', l: 'Новая запись' },
                    { v: 'time_before', l: 'До события' },
                    { v: 'daily_report', l: 'Ежедневный отчёт' },
                  ].map(t => (
                    <button key={t.v} type="button"
                      className={`notif-trigger-tab${notifForm.triggerType === t.v ? ' active' : ''}`}
                      onClick={() => setNotifForm(f => ({ ...f, triggerType: t.v }))}>
                      {t.l}
                    </button>
                  ))}
                </div>

                {/* Схема */}
                {(notifForm.triggerType === 'new_record' || notifForm.triggerType === 'time_before') && (<>
                  <label className="notif-field-label">Схема данных</label>
                  <select className="notif-select" value={notifForm.schemaName}
                    onChange={e => setNotifForm(f => ({ ...f, schemaName: e.target.value }))}>
                    <option value="">— выберите схему —</option>
                    {notifContext.schemas.map(s => (
                      <option key={s.name} value={s.name}>{s.label}</option>
                    ))}
                  </select>
                </>)}

                {notifForm.triggerType === 'daily_report' && (<>
                  <label className="notif-field-label">Схема данных</label>
                  <select className="notif-select" value={notifForm.schemaName}
                    onChange={e => setNotifForm(f => ({ ...f, schemaName: e.target.value }))}>
                    <option value="">— выберите схему —</option>
                    {notifContext.schemas.map(s => (
                      <option key={s.name} value={s.name}>{s.label}</option>
                    ))}
                  </select>
                  <label className="notif-field-label">Час отправки (0–23)</label>
                  <input className="notif-input notif-input--sm" type="number" min={0} max={23}
                    value={notifForm.reportHour}
                    onChange={e => setNotifForm(f => ({ ...f, reportHour: Number(e.target.value) }))} />
                </>)}

                {/* time_before: поля даты и window */}
                {notifForm.triggerType === 'time_before' && (<>
                  <label className="notif-field-label">Поле даты в записи</label>
                  <input className="notif-input" placeholder="date"
                    value={notifForm.dateField}
                    onChange={e => setNotifForm(f => ({ ...f, dateField: e.target.value }))} />
                  <label className="notif-field-label">За сколько минут уведомлять</label>
                  <input className="notif-input notif-input--sm" type="number" min={5}
                    value={notifForm.minutesBefore}
                    onChange={e => setNotifForm(f => ({ ...f, minutesBefore: Number(e.target.value) }))} />
                </>)}

                {/* Получатель */}
                <label className="notif-field-label">Кому отправлять</label>

                <div className="notif-recipient-cards">
                  {/* Карточка: всем клиентам */}
                  <button type="button"
                    className={`notif-recipient-card${notifForm.recipientType === 'user_field' ? ' active' : ''}`}
                    onClick={() => setNotifForm(f => ({ ...f, recipientType: 'user_field' }))}>
                    <div className="notif-recipient-icon">👥</div>
                    <div className="notif-recipient-text">
                      <span className="notif-recipient-title">Каждому клиенту автоматически</span>
                      <span className="notif-recipient-desc">Бот сам найдёт всех, кому нужно написать, и отправит каждому своё личное сообщение</span>
                    </div>
                    {notifForm.recipientType === 'user_field' && <Check size={16} className="notif-recipient-check" />}
                  </button>

                  {/* Карточка: конкретному человеку */}
                  <button type="button"
                    className={`notif-recipient-card${notifForm.recipientType === 'specific_id' ? ' active' : ''}`}
                    onClick={() => setNotifForm(f => ({ ...f, recipientType: 'specific_id' }))}>
                    <div className="notif-recipient-icon">👤</div>
                    <div className="notif-recipient-text">
                      <span className="notif-recipient-title">Конкретному человеку</span>
                      <span className="notif-recipient-desc">Всегда одному получателю — например, себе как владельцу</span>
                    </div>
                    {notifForm.recipientType === 'specific_id' && <Check size={16} className="notif-recipient-check" />}
                  </button>
                </div>

                {notifForm.recipientType === 'user_field' && (
                  <div className="notif-auto-info">
                    ✅ Работает автоматически. Клиент бронирует через Telegram-бота → его chat_id сохраняется → бот напишет ему в нужный момент.
                  </div>
                )}

                {notifForm.recipientType === 'specific_id' && (() => {
                  const profile = notifContext.profiles.find(p => p._id === notifForm.profileId);
                  const contacts = profile?.contacts || [];
                  return (<>
                    {contacts.length > 0 && (
                      <div className="notif-contacts-list">
                        <p className="notif-hint" style={{ marginBottom: 6 }}>Кто уже писал боту — нажмите для добавления:</p>
                        {contacts.map(c => (
                          <button
                            key={c.chatId}
                            type="button"
                            className={`notif-contact-chip${notifForm.recipients.includes(c.chatId) ? ' active' : ''}`}
                            onClick={() => addContactRecipient(c.chatId, notifForm.recipients)}
                          >
                            {c.username ? `@${c.username}` : c.displayName || c.chatId}
                            {c.displayName && c.username ? <span className="notif-contact-name">{c.displayName}</span> : null}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="notif-recipients-rows">
                      {notifForm.recipients.map((rec, idx) => (
                        <div key={idx} className="notif-recipient-row">
                          <div className="notif-recipient-input-wrap">
                            <input
                              className="notif-input"
                              placeholder="@username или chat_id"
                              value={rec}
                              onChange={e => updateRecipient(idx, e.target.value)}
                              onBlur={() => resolveRecipient(idx)}
                            />
                            <div className="notif-recipient-status">
                              {recipientResolutions[idx] === 'resolving' && <Loader2 size={13} className="spin" />}
                              {recipientResolutions[idx] === 'ok' && <Check size={13} style={{ color: 'var(--ok)' }} />}
                              {recipientResolutions[idx] === 'not_found' && <span className="notif-resolve-warn" title="Пользователь не найден в базе контактов — попробует разрешить при отправке">?</span>}
                            </div>
                          </div>
                          {notifForm.recipients.length > 1 && (
                            <button type="button" className="notif-recipient-remove" onClick={() => removeRecipient(idx)}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    <button type="button" className="notif-add-recipient-btn" onClick={addEmptyRecipient}>
                      <Plus size={13} /> Ещё получатель
                    </button>

                    {contacts.length === 0 && (
                      <p className="notif-hint" style={{ marginTop: 8 }}>Напишите что-нибудь своему боту в Telegram — и вы появитесь здесь.</p>
                    )}
                  </>);
                })()}

                {/* Промпт */}
                <label className="notif-field-label">Инструкция для AI</label>
                <textarea className="notif-textarea" rows={4}
                  placeholder="Напр. «Напомни пользователю о записи завтра. Укажи время и специалиста. Пиши дружелюбно.»"
                  value={notifForm.messagePrompt}
                  onChange={e => setNotifForm(f => ({ ...f, messagePrompt: e.target.value }))} />

                <label className="notif-field-label notif-toggle-row">
                  <input type="checkbox" checked={notifForm.enabled}
                    onChange={e => setNotifForm(f => ({ ...f, enabled: e.target.checked }))} />
                  Правило активно
                </label>
              </div>

              <div className="notif-form-foot">
                <button className="notif-cancel-btn" onClick={() => setNotifFormOpen(false)}>Отмена</button>
                <button className="notif-save-btn" onClick={saveNotifRule} disabled={notifLoading}>
                  {notifLoading ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                  {editingRule ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Dev: тест резервного провайдера ──────────────────────── */}
      {false && forceQwen !== null && (
        <div className={`dev-panel ${forceQwen ? 'dev-panel--active' : ''}`}>
          <div className="dev-panel-left">
            <FlaskConical size={16} />
            <div>
              <span className="dev-panel-title">Режим тестирования</span>
              <span className="dev-panel-desc">
                {forceQwen
                  ? '⚡ Запросы идут через Qwen (Mistral игнорируется)'
                  : 'Запросы идут через Mistral (штатный режим)'}
              </span>
            </div>
          </div>
          <button className="dev-panel-btn" onClick={toggleQwen} disabled={qwenToggleLoading}>
            {qwenToggleLoading ? <Loader2 size={14} className="spin" /> : null}
            {forceQwen ? 'Вернуть Mistral' : 'Симулировать отказ Mistral → Qwen'}
          </button>
        </div>
      )}
    </div>
  );
}
