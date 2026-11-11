import axios from 'axios';
import { Bot, Plus, Save, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

const PROFILE_COLORS = ['#667eea', '#764ba2', '#f59e0b', '#10b981', '#ef4444', '#06b6d4'];

export default function AISettingsScreen({ apiKey }) {
  const [profiles, setProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [config, setConfig] = useState({ aiName: '', systemPrompt: '' });
  const [profileName, setProfileName] = useState('');
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => { fetchProfiles(); }, []);

  const fetchProfiles = async () => {
    setLoadingProfiles(true);
    try {
      const res = await axios.get(`${API_URL}/profiles`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const list = res.data.profiles || [];
      setProfiles(list);
      if (list.length > 0) selectProfile(list[0]._id);
    } catch {}
    finally { setLoadingProfiles(false); }
  };

  const selectProfile = async (id) => {
    setSelectedId(id);
    setLoadingConfig(true);
    try {
      const res = await axios.get(`${API_URL}/config?profileId=${id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const c = res.data.config || {};
      setConfig({ aiName: c.aiName || '', systemPrompt: c.systemPrompt || '' });
      setProfileName(c.profileName || '');
    } catch {}
    finally { setLoadingConfig(false); }
  };

  const handleSave = async () => {
    if (!config.systemPrompt || config.systemPrompt.trim().length < 20) {
      Alert.alert('Ошибка', 'Инструкция должна содержать минимум 20 символов');
      return;
    }
    setSaving(true);
    try {
      await axios.post(`${API_URL}/config`, {
        aiName: config.aiName,
        systemPrompt: config.systemPrompt,
        profileId: selectedId,
      }, { headers: { Authorization: `Bearer ${apiKey}` } });

      if (profileName.trim()) {
        await axios.patch(`${API_URL}/profiles/${selectedId}`, {
          profileName: profileName.trim(),
        }, { headers: { Authorization: `Bearer ${apiKey}` } });
        setProfiles((prev) => prev.map((p) =>
          p._id === selectedId ? { ...p, profileName: profileName.trim() } : p
        ));
      }

      Alert.alert('Сохранено!', 'Настройки AI-профиля обновлены');
    } catch (err) {
      Alert.alert('Ошибка', err.response?.data?.error || 'Ошибка сохранения');
    } finally { setSaving(false); }
  };

  const handleCreate = () => {
    Alert.prompt(
      'Новый профиль',
      'Введите название профиля',
      async (name) => {
        if (!name?.trim()) return;
        setCreating(true);
        try {
          const res = await axios.post(`${API_URL}/profiles`, {
            profileName: name.trim(),
            aiName: 'Помощник',
            systemPrompt: 'Ты — полезный AI-помощник. Отвечай по существу.',
          }, { headers: { Authorization: `Bearer ${apiKey}` } });
          const newProfile = res.data.profile;
          setProfiles((prev) => [...prev, newProfile]);
          selectProfile(newProfile._id);
        } catch (err) {
          Alert.alert('Ошибка', err.response?.data?.error || 'Не удалось создать профиль');
        } finally { setCreating(false); }
      },
      'plain-text',
      '',
      'default'
    );
  };

  const handleDelete = (profile) => {
    Alert.alert(
      'Удалить профиль',
      `Удалить «${profile.profileName || 'Профиль'}»? Это действие необратимо.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            try {
              await axios.delete(`${API_URL}/profiles/${profile._id}`, {
                headers: { Authorization: `Bearer ${apiKey}` },
              });
              const remaining = profiles.filter((p) => p._id !== profile._id);
              setProfiles(remaining);
              if (remaining.length > 0) selectProfile(remaining[0]._id);
              else { setSelectedId(null); setConfig({ aiName: '', systemPrompt: '' }); }
            } catch (err) {
              Alert.alert('Ошибка', err.response?.data?.error || 'Не удалось удалить');
            }
          },
        },
      ]
    );
  };

  if (loadingProfiles) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color="#667eea" />
      </View>
    );
  }

  const selectedProfile = profiles.find((p) => p._id === selectedId);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView style={s.container} contentContainerStyle={s.content}>

        {/* Profile list */}
        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>AI-профили</Text>
            <TouchableOpacity style={s.addBtn} onPress={handleCreate} disabled={creating}>
              {creating ? <ActivityIndicator size="small" color="#667eea" /> : <Plus size={16} color="#667eea" />}
              <Text style={s.addBtnText}>Создать</Text>
            </TouchableOpacity>
          </View>

          {profiles.length === 0 ? (
            <Text style={s.emptyText}>Нет профилей. Создайте первый!</Text>
          ) : (
            profiles.map((p) => {
              const isSelected = p._id === selectedId;
              const color = p.color || '#667eea';
              return (
                <TouchableOpacity
                  key={p._id}
                  style={[s.profileRow, isSelected && s.profileRowActive]}
                  onPress={() => selectProfile(p._id)}
                >
                  <View style={[s.profileDot, { backgroundColor: color }]} />
                  <View style={s.profileInfo}>
                    <Text style={[s.profileName, isSelected && s.profileNameActive]}>
                      {p.profileName || 'Профиль'}
                    </Text>
                    <Text style={s.profileSub}>{p.totalRequests || 0} запросов</Text>
                  </View>
                  {isSelected && (
                    <View style={s.activeBadge}>
                      <Text style={s.activeBadgeText}>Редактируется</Text>
                    </View>
                  )}
                  {profiles.length > 1 && (
                    <TouchableOpacity style={s.deleteBtn} onPress={() => handleDelete(p)}>
                      <Trash2 size={16} color="#e53e3e" />
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              );
            })
          )}
        </View>

        {/* Edit selected profile */}
        {selectedId && (
          loadingConfig ? (
            <View style={s.center}>
              <ActivityIndicator color="#667eea" />
            </View>
          ) : (
            <>
              <View style={s.section}>
                <Text style={s.sectionTitle}>Название профиля</Text>
                <TextInput
                  style={s.input}
                  value={profileName}
                  onChangeText={setProfileName}
                  placeholder="Например: Консультант по продажам"
                  maxLength={60}
                />
              </View>

              <View style={s.section}>
                <Text style={s.sectionTitle}>Имя AI-помощника</Text>
                <TextInput
                  style={s.input}
                  value={config.aiName}
                  onChangeText={(v) => setConfig((p) => ({ ...p, aiName: v }))}
                  placeholder="Например: Анна-консультант"
                  maxLength={50}
                />
              </View>

              <View style={s.section}>
                <Text style={s.sectionTitle}>Системный промпт</Text>
                <Text style={s.hint}>Инструкция для AI (минимум 20 символов)</Text>
                <TextInput
                  style={[s.input, s.textarea]}
                  value={config.systemPrompt}
                  onChangeText={(v) => setConfig((p) => ({ ...p, systemPrompt: v }))}
                  placeholder="Ты — вежливый консультант интернет-магазина..."
                  multiline
                  textAlignVertical="top"
                  maxLength={10000}
                />
                <Text style={s.charCount}>{config.systemPrompt.length}/10000 (мин. 20)</Text>
              </View>

              <TouchableOpacity
                style={[s.saveBtn, saving && { opacity: 0.7 }]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <>
                    <Save size={18} color="white" />
                    <Text style={s.saveBtnText}>Сохранить профиль</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )
        )}

        {profiles.length === 0 && (
          <TouchableOpacity style={s.createFirstBtn} onPress={handleCreate}>
            <Bot size={24} color="white" />
            <Text style={s.createFirstBtnText}>Создать первый AI-профиль</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  container: { flex: 1, backgroundColor: '#f7fafc' },
  content: { padding: 16, paddingBottom: 40 },
  section: {
    backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#1a202c' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, backgroundColor: '#f0f4ff', borderRadius: 8 },
  addBtnText: { fontSize: 13, color: '#667eea', fontWeight: '600' },
  emptyText: { color: '#a0aec0', fontSize: 14, textAlign: 'center', paddingVertical: 8 },
  profileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 2,
    borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  profileRowActive: { backgroundColor: '#fafbff', marginHorizontal: -2, paddingHorizontal: 4, borderRadius: 8 },
  profileDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 14, fontWeight: '600', color: '#4a5568' },
  profileNameActive: { color: '#667eea' },
  profileSub: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  activeBadge: { backgroundColor: '#e8ecfd', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  activeBadgeText: { fontSize: 11, color: '#667eea', fontWeight: '600' },
  deleteBtn: { padding: 6 },
  hint: { fontSize: 12, color: '#a0aec0', marginBottom: 8 },
  input: {
    borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8,
    padding: 12, fontSize: 15, color: '#1a202c', backgroundColor: '#f7fafc',
  },
  textarea: { height: 160, textAlignVertical: 'top' },
  charCount: { fontSize: 12, color: '#a0aec0', marginTop: 6, textAlign: 'right' },
  saveBtn: {
    backgroundColor: '#667eea', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, padding: 16, borderRadius: 12, marginTop: 4,
  },
  saveBtnText: { color: 'white', fontWeight: '700', fontSize: 16 },
  createFirstBtn: {
    backgroundColor: '#667eea', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 10, padding: 18, borderRadius: 12, marginTop: 8,
  },
  createFirstBtnText: { color: 'white', fontWeight: '700', fontSize: 16 },
});
