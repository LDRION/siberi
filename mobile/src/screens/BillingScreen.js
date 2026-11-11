import axios from 'axios';
import { Check, Zap } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../api';

const PLANS = [
  {
    id: 'standard',
    name: 'Standard',
    price: 2500,
    color: '#667eea',
    features: [
      '1 AI-профиль',
      'Основные функции платформы',
      '1 интеграция на выбор',
      'API-ключ для разработки с ИИ',
      'AI внутри данных',
      'Токены, промты без ограничений',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 5000,
    color: '#764ba2',
    popular: true,
    features: [
      '2 AI-профиля',
      'До 2 активных интеграций',
      'Все функции платформы',
      'Google Sheets синхронизация',
      '+ все доступы меньших тарифов',
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    price: 10000,
    color: '#f59e0b',
    features: [
      '3 AI-профиля',
      'Безлимитные интеграции',
      'Все функции платформы',
      'Приоритетная поддержка',
      'Максимальная скорость ИИ',
      '+ все доступы меньших тарифов',
    ],
  },
];

const STATUS_LABELS = { trial: 'Пробный период', active: 'Активна', expired: 'Истекла', cancelled: 'Отменена' };
const STATUS_COLORS = { trial: '#d97706', active: '#16a34a', expired: '#dc2626', cancelled: '#6b7280' };

export default function BillingScreen({ apiKey }) {
  const [userInfo, setUserInfo] = useState(null);
  const [infoLoading, setInfoLoading] = useState(true);
  const [payLoading, setPayLoading] = useState(null);

  useEffect(() => { fetchUserInfo(); }, []);

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

  const handleSubscribe = async (plan) => {
    setPayLoading(plan.id);
    try {
      const res = await axios.post(
        `${API_URL}/payment/create`,
        { plan: plan.id, months: 1, paymentMethod: 'card' },
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      if (res.data.success && res.data.paymentUrl) {
        await Linking.openURL(res.data.paymentUrl);
      }
    } catch (err) {
      Alert.alert('Ошибка', err.response?.data?.error || 'Не удалось создать платёж');
    } finally {
      setPayLoading(null);
    }
  };

  const isTrial = userInfo?.subscriptionStatus === 'trial';
  const isActive = userInfo?.subscriptionStatus === 'active';
  const currentPlan = isActive ? userInfo?.plan : null;
  const statusColor = STATUS_COLORS[userInfo?.subscriptionStatus] || '#6b7280';

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <View style={s.pageHeader}>
        <Text style={s.title}>Подписка</Text>
        <Text style={s.subtitle}>Выберите тариф для вашего бизнеса</Text>
      </View>

      {!infoLoading && userInfo && (
        <View style={[s.statusCard, { borderLeftColor: statusColor }]}>
          <View style={s.statusRow}>
            <Zap size={18} color={statusColor} />
            <Text style={[s.statusTitle, { color: statusColor }]}>
              {STATUS_LABELS[userInfo.subscriptionStatus] || userInfo.subscriptionStatus}
            </Text>
          </View>
          {isTrial && (
            <Text style={s.statusSub}>
              Промптов использовано: {userInfo.promptsUsed || 0} / 20
            </Text>
          )}
          {isActive && userInfo.subscriptionEnd && (
            <Text style={s.statusSub}>
              Тариф «{PLANS.find(p => p.id === currentPlan)?.name || currentPlan}» · до{' '}
              {new Date(userInfo.subscriptionEnd).toLocaleDateString('ru-RU')}
            </Text>
          )}
        </View>
      )}

      {PLANS.map((plan) => {
        const isCurrent = currentPlan === plan.id;
        return (
          <View key={plan.id} style={[s.planCard, isCurrent && s.planCardActive, plan.popular && s.planCardPopular]}>
            {plan.popular && !isCurrent && (
              <View style={[s.badge, { backgroundColor: plan.color }]}>
                <Text style={s.badgeText}>Популярный</Text>
              </View>
            )}
            {isCurrent && (
              <View style={[s.badge, { backgroundColor: '#10b981' }]}>
                <Text style={s.badgeText}>Ваш тариф</Text>
              </View>
            )}

            <View style={s.planHeader}>
              <Text style={[s.planName, { color: plan.color }]}>{plan.name}</Text>
              <Text style={s.planPriceLine}>
                <Text style={[s.planPriceNum, { color: plan.color }]}>
                  {plan.price.toLocaleString('ru-RU')} ₽
                </Text>
                <Text style={s.planPricePer}> / мес</Text>
              </Text>
            </View>

            <View style={s.featuresList}>
              {plan.features.map((f, i) => {
                const isNote = f.startsWith('+');
                return (
                  <View key={i} style={[s.featureRow, isNote && { marginTop: 4 }]}>
                    {!isNote && <Check size={14} color="#16a34a" />}
                    <Text style={[s.featureText, isNote && s.featureNote]}>{f}</Text>
                  </View>
                );
              })}
            </View>

            <TouchableOpacity
              style={[
                s.subscribeBtn,
                { borderColor: plan.color },
                plan.popular && !isCurrent && { backgroundColor: plan.color, borderColor: plan.color },
                isCurrent && { borderColor: '#10b981' },
              ]}
              onPress={() => !isCurrent && handleSubscribe(plan)}
              disabled={isCurrent || !!payLoading}
            >
              {payLoading === plan.id ? (
                <ActivityIndicator size="small" color={plan.popular && !isCurrent ? 'white' : plan.color} />
              ) : (
                <Text style={[
                  s.subscribeBtnText,
                  { color: plan.popular && !isCurrent ? 'white' : plan.color },
                  isCurrent && { color: '#10b981' },
                ]}>
                  {isCurrent ? '✓ Активный план' : 'Выбрать тариф'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        );
      })}

      <Text style={s.payNote}>💳 Visa · Mastercard · СБП · SberPay · ЮMoney</Text>
      <Text style={s.payNote2}>Оплата открывается в браузере</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  content: { padding: 16, paddingBottom: 40 },
  pageHeader: { marginBottom: 20, paddingTop: 8 },
  title: { fontSize: 26, fontWeight: '800', color: '#1a202c' },
  subtitle: { color: '#718096', marginTop: 4, fontSize: 14 },
  statusCard: {
    backgroundColor: 'white', borderRadius: 12, padding: 14,
    marginBottom: 20, borderLeftWidth: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  statusTitle: { fontSize: 15, fontWeight: '700' },
  statusSub: { fontSize: 13, color: '#718096', marginTop: 2 },
  planCard: {
    backgroundColor: 'white', borderRadius: 16, padding: 20,
    marginBottom: 16, borderWidth: 2, borderColor: '#e2e8f0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, position: 'relative',
  },
  planCardActive: { borderColor: '#10b981' },
  planCardPopular: { borderColor: '#764ba2' },
  badge: {
    position: 'absolute', top: -12, alignSelf: 'center',
    paddingHorizontal: 14, paddingVertical: 4, borderRadius: 20,
  },
  badgeText: { color: 'white', fontSize: 11, fontWeight: '700' },
  planHeader: { marginBottom: 16, marginTop: 8 },
  planName: { fontSize: 20, fontWeight: '800', marginBottom: 4 },
  planPriceLine: {},
  planPriceNum: { fontSize: 28, fontWeight: '800' },
  planPricePer: { fontSize: 14, color: '#718096' },
  featuresList: { marginBottom: 16, gap: 8 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureText: { fontSize: 14, color: '#4a5568', flex: 1 },
  featureNote: { color: '#16a34a', fontWeight: '700', fontSize: 12, marginLeft: 0 },
  subscribeBtn: {
    borderWidth: 2, borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  subscribeBtnText: { fontSize: 15, fontWeight: '700' },
  payNote: { textAlign: 'center', color: '#a0aec0', fontSize: 13, marginTop: 8 },
  payNote2: { textAlign: 'center', color: '#cbd5e0', fontSize: 11, marginTop: 4 },
});
