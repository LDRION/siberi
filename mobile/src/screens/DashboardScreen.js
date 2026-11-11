import { useNavigation } from '@react-navigation/native';
import axios from 'axios';
import { Activity, Bot, Clock, CreditCard, MessageSquare, Settings, Zap } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../api';

const STATUS_COLORS = { trial: '#d97706', active: '#16a34a', expired: '#dc2626', cancelled: '#6b7280' };
const STATUS_LABELS = { trial: 'Пробный период', active: 'Активна', expired: 'Истекла', cancelled: 'Отменена' };
const PLAN_COLORS = { standard: '#667eea', pro: '#764ba2', premium: '#f59e0b' };
const PLAN_LABELS = { standard: 'Standard', pro: 'Pro', premium: 'Premium' };

function formatTimeLeft(endsAt) {
  const diff = new Date(endsAt) - Date.now();
  if (diff <= 0) return 'истёк';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} д. ${h % 24} ч.`;
  return `${h} ч. ${m} мин.`;
}

export default function DashboardScreen({ apiKey }) {
  const navigation = useNavigation();
  const [userInfo, setUserInfo] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [integrations, setIntegrations] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${apiKey}` };
      const [infoRes, profilesRes, integRes] = await Promise.all([
        axios.get(`${API_URL}/user/info`, { headers }),
        axios.get(`${API_URL}/profiles`, { headers }).catch(() => ({ data: { profiles: [] } })),
        axios.get(`${API_URL}/integrations/status`, { headers }).catch(() => ({ data: {} })),
      ]);
      setUserInfo(infoRes.data);
      setProfiles(profilesRes.data.profiles || []);
      setIntegrations(integRes.data);
    } catch (err) {
      console.error('Dashboard fetch:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => { setRefreshing(true); fetchData(true); };

  if (loading) {
    return (
      <View style={s.loading}>
        <ActivityIndicator size="large" color="#667eea" />
      </View>
    );
  }

  const isTrial = userInfo?.subscriptionStatus === 'trial';
  const isActive = userInfo?.subscriptionStatus === 'active';
  const statusColor = STATUS_COLORS[userInfo?.subscriptionStatus] || '#6b7280';
  const planColor = PLAN_COLORS[userInfo?.plan] || '#667eea';

  // Count active integrations
  const tgCount = integrations?.telegram?.length || 0;
  const vkCount = integrations?.vk?.length || 0;
  const maxCount = integrations?.max?.length || 0;
  const totalInteg = tgCount + vkCount + maxCount
    + (integrations?.api?.active ? 1 : 0)
    + (integrations?.widget?.active ? 1 : 0);

  const integItems = [
    tgCount > 0 && { label: `Telegram (${tgCount} бот${tgCount > 1 ? 'а' : ''})`, emoji: '🤖', active: true },
    vkCount > 0 && { label: `VK (${vkCount} групп${vkCount > 1 ? 'ы' : 'а'})`, emoji: '💬', active: true },
    maxCount > 0 && { label: `MAX (${maxCount} бот${maxCount > 1 ? 'а' : ''})`, emoji: '📱', active: true },
    integrations?.widget?.active && { label: 'AI виджет на сайте', emoji: '🌐', active: true },
    integrations?.api?.active && { label: 'REST API', emoji: '⚡', active: true },
  ].filter(Boolean);

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#667eea" />}
    >
      <View style={s.pageHeader}>
        <Text style={s.title}>Siberi.AI</Text>
        <Text style={s.subtitle}>Панель управления</Text>
      </View>

      {/* Subscription status */}
      {userInfo && (
        <View style={[s.card, { borderLeftWidth: 4, borderLeftColor: statusColor }]}>
          <View style={s.cardRow}>
            <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[s.statusLabel, { color: statusColor }]}>
              {STATUS_LABELS[userInfo.subscriptionStatus] || userInfo.subscriptionStatus}
            </Text>
            {isActive && (
              <View style={[s.planBadge, { backgroundColor: planColor + '18' }]}>
                <Text style={[s.planBadgeText, { color: planColor }]}>
                  {PLAN_LABELS[userInfo.plan] || userInfo.plan}
                </Text>
              </View>
            )}
          </View>

          {isTrial && userInfo.trialEndsAt && (
            <>
              <Text style={s.cardSub}>
                Осталось: {formatTimeLeft(userInfo.trialEndsAt)}
              </Text>
              <View style={s.trialBar}>
                <View style={[s.trialBarFill, {
                  width: `${Math.min(100, ((userInfo.promptsUsed || 0) / 20) * 100)}%`,
                }]} />
              </View>
              <Text style={s.trialHint}>
                Промптов: {userInfo.promptsUsed || 0} / 20
              </Text>
            </>
          )}
          {isActive && userInfo.subscriptionEnd && (
            <Text style={s.cardSub}>
              До {new Date(userInfo.subscriptionEnd).toLocaleDateString('ru-RU')}
            </Text>
          )}
        </View>
      )}

      {/* Metrics row */}
      <View style={s.metricsRow}>
        <View style={s.metric}>
          <Bot size={20} color="#667eea" />
          <Text style={s.metricVal}>{profiles.length || 0}</Text>
          <Text style={s.metricLabel}>Профили</Text>
        </View>
        <View style={s.metric}>
          <Zap size={20} color="#667eea" />
          <Text style={s.metricVal}>{totalInteg}</Text>
          <Text style={s.metricLabel}>Интеграции</Text>
        </View>
        <View style={s.metric}>
          <Activity size={20} color="#667eea" />
          <Text style={s.metricVal}>
            {profiles.reduce((sum, p) => sum + (p.totalRequests || 0), 0)}
          </Text>
          <Text style={s.metricLabel}>Запросов</Text>
        </View>
      </View>

      {/* Active integrations */}
      {integItems.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Активные интеграции</Text>
          {integItems.map((item, i) => (
            <View key={i} style={s.integRow}>
              <Text style={s.integEmoji}>{item.emoji}</Text>
              <Text style={s.integLabel}>{item.label}</Text>
              <View style={s.integDotActive} />
            </View>
          ))}
        </View>
      )}

      {/* Profiles */}
      {profiles.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>AI-профили</Text>
          {profiles.map((p) => (
            <View key={p._id} style={s.profileRow}>
              <View style={[s.profileDot, { backgroundColor: p.color || '#667eea' }]} />
              <Text style={s.profileName}>{p.profileName || 'Профиль'}</Text>
              <Text style={s.profileStats}>{p.totalRequests || 0} запр.</Text>
            </View>
          ))}
        </View>
      )}

      {/* Quick actions */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Быстрые действия</Text>
        <TouchableOpacity style={s.primaryBtn} onPress={() => navigation.navigate('Chat')}>
          <MessageSquare size={18} color="white" />
          <Text style={s.primaryBtnText}>Чат с AI</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.secondaryBtn} onPress={() => navigation.navigate('Settings')}>
          <Settings size={18} color="#667eea" />
          <Text style={s.secondaryBtnText}>Настройки AI</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.secondaryBtn} onPress={() => navigation.navigate('Billing')}>
          <CreditCard size={18} color="#667eea" />
          <Text style={s.secondaryBtnText}>Подписка</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f7fafc' },
  container: { flex: 1, backgroundColor: '#f7fafc' },
  content: { padding: 16, paddingBottom: 32 },
  pageHeader: { marginBottom: 20, paddingTop: 8 },
  title: { fontSize: 26, fontWeight: '800', color: '#1a202c' },
  subtitle: { color: '#718096', marginTop: 2, fontSize: 14 },
  card: {
    backgroundColor: 'white', borderRadius: 14, padding: 16,
    marginBottom: 14, shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06,
    shadowRadius: 8, elevation: 2,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#1a202c', marginBottom: 12 },
  cardSub: { fontSize: 13, color: '#718096', marginTop: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 14, fontWeight: '700', flex: 1 },
  planBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  planBadgeText: { fontSize: 12, fontWeight: '700' },
  trialBar: {
    height: 4, backgroundColor: '#e2e8f0', borderRadius: 2,
    marginTop: 10, overflow: 'hidden',
  },
  trialBarFill: {
    height: '100%', borderRadius: 2,
    backgroundColor: '#667eea',
  },
  trialHint: { fontSize: 12, color: '#94a3b8', marginTop: 6 },
  metricsRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  metric: {
    flex: 1, backgroundColor: 'white', borderRadius: 14,
    padding: 14, alignItems: 'center', gap: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  metricVal: { fontSize: 20, fontWeight: '800', color: '#1a202c' },
  metricLabel: { fontSize: 11, color: '#718096' },
  integRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  integEmoji: { fontSize: 18 },
  integLabel: { flex: 1, fontSize: 14, color: '#334155', fontWeight: '500' },
  integDotActive: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#16a34a' },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  profileDot: { width: 10, height: 10, borderRadius: 5 },
  profileName: { flex: 1, fontSize: 14, color: '#334155', fontWeight: '500' },
  profileStats: { fontSize: 12, color: '#94a3b8' },
  primaryBtn: {
    backgroundColor: '#667eea', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, padding: 14, borderRadius: 10, marginTop: 8,
  },
  primaryBtnText: { color: 'white', fontWeight: '600', fontSize: 15 },
  secondaryBtn: {
    backgroundColor: '#f0f4ff', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, padding: 14, borderRadius: 10, marginTop: 8,
  },
  secondaryBtnText: { color: '#667eea', fontWeight: '600', fontSize: 15 },
});
