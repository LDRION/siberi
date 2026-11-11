import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Bot, Lock, Mail } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../api';

WebBrowser.maybeCompleteAuthSession();

const OAUTH_BASE = API_URL.replace('/api/v1', '');

const OAUTH_PROVIDERS = [
  { id: 'google',  label: 'Google',  emoji: '🔵', color: '#4285F4', textColor: '#fff' },
  { id: 'yandex',  label: 'Яндекс',  emoji: '🔴', color: '#FC3F1D', textColor: '#fff' },
  { id: 'vk',      label: 'VK ID',   emoji: '🔷', color: '#0077FF', textColor: '#fff' },
];

export default function LoginScreen({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(null);
  const [error, setError] = useState('');

  // Handle deep link callback (siberi://login?token=xxx)
  useEffect(() => {
    const handleUrl = ({ url }) => {
      const parsed = Linking.parse(url);
      if (parsed.path === 'login' && parsed.queryParams?.token) {
        AsyncStorage.setItem('apiKey', parsed.queryParams.token);
        onLogin(parsed.queryParams.token);
      }
      if (parsed.queryParams?.error) {
        setError(decodeURIComponent(parsed.queryParams.error));
        setOauthLoading(null);
      }
    };

    const sub = Linking.addEventListener('url', handleUrl);

    // Handle cold-start deep link (app opened via deep link)
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    });

    return () => sub.remove();
  }, []);

  const handleOAuth = async (provider) => {
    setError('');
    setOauthLoading(provider);
    try {
      const redirectUrl = Linking.createURL('login');
      const authUrl = `${OAUTH_BASE}/api/v1/auth/${provider}?redirect_url=${encodeURIComponent(redirectUrl)}`;
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);

      if (result.type === 'success' && result.url) {
        const parsed = Linking.parse(result.url);
        const token = parsed.queryParams?.token;
        const err   = parsed.queryParams?.error;
        if (token) {
          await AsyncStorage.setItem('apiKey', token);
          onLogin(token);
        } else if (err) {
          setError(decodeURIComponent(err));
        }
      } else if (result.type === 'cancel') {
        // user closed browser, no action
      }
    } catch (e) {
      setError('Ошибка при открытии браузера');
    } finally {
      setOauthLoading(null);
    }
  };

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const response = await axios.post(`${API_URL}${endpoint}`, { email, password });
      if (response.data.success) {
        await AsyncStorage.setItem('apiKey', response.data.apiKey);
        onLogin(response.data.apiKey);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          {/* Header */}
          <View style={styles.header}>
            <Bot size={48} color="#667eea" />
            <Text style={styles.title}>Siberi.AI</Text>
            <Text style={styles.subtitle}>AI-ассистент для вашего бизнеса за 5 минут</Text>
          </View>

          {/* OAuth buttons */}
          <View style={styles.oauthSection}>
            {OAUTH_PROVIDERS.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={[styles.oauthBtn, { backgroundColor: p.color }]}
                onPress={() => handleOAuth(p.id)}
                disabled={!!oauthLoading || loading}
              >
                {oauthLoading === p.id ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <Text style={[styles.oauthBtnText, { color: p.textColor }]}>
                    {p.emoji}  Войти через {p.label}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </View>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>или по email</Text>
            <View style={styles.dividerLine} />
          </View>

          <Text style={styles.formTitle}>{isRegister ? 'Регистрация' : 'Вход'}</Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.fieldLabel}>
            <Mail size={16} color="#4a5568" />
            <Text style={styles.label}>Email</Text>
          </View>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="your@email.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />

          <View style={styles.fieldLabel}>
            <Lock size={16} color="#4a5568" />
            <Text style={styles.label}>Пароль</Text>
          </View>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleSubmit}
            disabled={loading || !!oauthLoading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.btnText}>{isRegister ? 'Зарегистрироваться' : 'Войти'}</Text>
            )}
          </TouchableOpacity>

          <View style={styles.switchRow}>
            <Text style={styles.switchText}>
              {isRegister ? 'Уже есть аккаунт?' : 'Нет аккаунта?'}
            </Text>
            <TouchableOpacity onPress={() => setIsRegister(!isRegister)}>
              <Text style={styles.switchLink}>{isRegister ? ' Войти' : ' Зарегистрироваться'}</Text>
            </TouchableOpacity>
          </View>

          {isRegister && (
            <View style={styles.trial}>
              <Text style={styles.trialTitle}>🎁 Пробный период</Text>
              <Text style={styles.trialText}>
                После регистрации вы получите 24 часа бесплатного доступа ко всем функциям
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#667eea' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: {
    backgroundColor: 'white', borderRadius: 16, padding: 28,
    shadowColor: '#000', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3, shadowRadius: 20, elevation: 10,
  },
  header: { alignItems: 'center', marginBottom: 22 },
  title: { fontSize: 28, fontWeight: '800', color: '#1a202c', marginTop: 10 },
  subtitle: { color: '#718096', marginTop: 5, textAlign: 'center', fontSize: 13 },
  oauthSection: { gap: 10, marginBottom: 20 },
  oauthBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    padding: 13, borderRadius: 10, minHeight: 48,
  },
  oauthBtnText: { fontSize: 15, fontWeight: '600' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e2e8f0' },
  dividerText: { fontSize: 12, color: '#a0aec0', flexShrink: 0 },
  formTitle: { fontSize: 20, fontWeight: '700', color: '#1a202c', marginBottom: 15 },
  error: {
    backgroundColor: '#fed7d7', color: '#c53030',
    padding: 12, borderRadius: 8, marginBottom: 15, textAlign: 'center',
  },
  fieldLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  label: { fontSize: 14, fontWeight: '500', color: '#4a5568' },
  input: {
    borderWidth: 2, borderColor: '#e2e8f0', borderRadius: 8,
    padding: 12, fontSize: 16, marginBottom: 15, color: '#1a202c',
  },
  btn: {
    backgroundColor: '#667eea', padding: 16, borderRadius: 8,
    alignItems: 'center', marginTop: 5,
  },
  btnDisabled: { opacity: 0.7 },
  btnText: { color: 'white', fontSize: 16, fontWeight: '600' },
  switchRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 20 },
  switchText: { color: '#718096' },
  switchLink: { color: '#667eea', fontWeight: '600' },
  trial: { marginTop: 20, padding: 15, backgroundColor: '#f0fff4', borderRadius: 8 },
  trialTitle: { color: '#22543d', fontWeight: '700', marginBottom: 5 },
  trialText: { color: '#2f855a', fontSize: 13 },
});
