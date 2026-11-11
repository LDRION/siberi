import axios from 'axios';
import { Bot, ChevronDown, Send, Trash2, User } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../api';

export default function ChatScreen({ apiKey }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const flatListRef = useRef(null);
  const pollTimeoutRef = useRef(null);

  useEffect(() => {
    fetchProfiles();
    fetchHistory();
    return () => { if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current); };
  }, []);

  const fetchProfiles = async () => {
    try {
      const res = await axios.get(`${API_URL}/profiles`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const list = res.data.profiles || [];
      setProfiles(list);
      if (list.length > 0) setSelectedProfile(list[0]);
    } catch {}
  };

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${API_URL}/chat/history`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.data.success) setMessages(res.data.messages || []);
    } catch {}
  };

  const pollResult = async (id) => {
    try {
      const res = await axios.get(`${API_URL}/result/${id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = res.data;
      if (data.status === 'completed') {
        setMessages((prev) => [...prev, { role: 'ai', content: data.result, createdAt: new Date().toISOString() }]);
        setLoading(false);
      } else if (data.status === 'error') {
        setMessages((prev) => [...prev, { role: 'ai', content: `❌ ${data.error}`, createdAt: new Date().toISOString() }]);
        setLoading(false);
      } else {
        pollTimeoutRef.current = setTimeout(() => pollResult(id), 1500);
      }
    } catch {
      pollTimeoutRef.current = setTimeout(() => pollResult(id), 2000);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: 'user', content: text, createdAt: new Date().toISOString() }]);
    setInput('');
    setLoading(true);

    const body = { prompt: text };
    if (selectedProfile) body.activeProfileIds = [selectedProfile._id];

    try {
      const res = await axios.post(`${API_URL}/chat/send`, body, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.data.success) pollResult(res.data.taskId);
    } catch {
      setMessages((prev) => [...prev, { role: 'ai', content: '❌ Ошибка отправки', createdAt: new Date().toISOString() }]);
      setLoading(false);
    }
  };

  const clearHistory = () => {
    Alert.alert('Очистить историю', 'Удалить все сообщения?', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить', style: 'destructive',
        onPress: async () => {
          try {
            await axios.delete(`${API_URL}/chat/history`, { headers: { Authorization: `Bearer ${apiKey}` } });
            setMessages([]);
          } catch (err) {
            Alert.alert('Ошибка', err.response?.data?.error || err.message);
          }
        },
      },
    ]);
  };

  const formatTime = (date) =>
    new Date(date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const renderMessage = ({ item }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[st.msgRow, isUser ? st.msgRowUser : st.msgRowAi]}>
        <View style={[st.avatar, isUser ? st.avatarUser : st.avatarAi]}>
          {isUser ? <User size={14} color="white" /> : <Bot size={14} color="#667eea" />}
        </View>
        <View style={[st.bubble, isUser ? st.bubbleUser : st.bubbleAi]}>
          <Text style={isUser ? st.bubbleTextUser : st.bubbleTextAi}>{item.content}</Text>
          <Text style={isUser ? st.timeUser : st.timeAi}>{formatTime(item.createdAt)}</Text>
        </View>
      </View>
    );
  };

  const profileColor = selectedProfile?.color || '#667eea';

  return (
    <KeyboardAvoidingView
      style={st.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity
          style={st.profilePicker}
          onPress={() => profiles.length > 1 && setShowPicker(true)}
          disabled={profiles.length <= 1}
        >
          <View style={[st.profileDot, { backgroundColor: profileColor }]} />
          <Text style={st.headerTitle} numberOfLines={1}>
            {selectedProfile?.aiName || selectedProfile?.profileName || 'AI-Помощник'}
          </Text>
          {profiles.length > 1 && <ChevronDown size={16} color="#94a3b8" />}
        </TouchableOpacity>
        <TouchableOpacity onPress={clearHistory} style={st.clearBtn}>
          <Trash2 size={20} color="#718096" />
        </TouchableOpacity>
      </View>

      {/* Profile picker modal */}
      <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
        <TouchableOpacity style={st.modalOverlay} onPress={() => setShowPicker(false)} activeOpacity={1}>
          <View style={st.modalSheet}>
            <Text style={st.modalTitle}>Выберите профиль</Text>
            <ScrollView>
              {profiles.map((p) => {
                const isActive = p._id === selectedProfile?._id;
                const color = p.color || '#667eea';
                return (
                  <TouchableOpacity
                    key={p._id}
                    style={[st.modalItem, isActive && st.modalItemActive]}
                    onPress={() => { setSelectedProfile(p); setShowPicker(false); }}
                  >
                    <View style={[st.profileDot, { backgroundColor: color }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[st.modalItemName, isActive && { color: '#667eea' }]}>
                        {p.profileName || 'Профиль'}
                      </Text>
                      {p.aiName ? <Text style={st.modalItemSub}>{p.aiName}</Text> : null}
                    </View>
                    {isActive && <Text style={st.modalCheckmark}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(_, i) => i.toString()}
        renderItem={renderMessage}
        contentContainerStyle={st.messagesList}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          !loading ? (
            <View style={st.emptyChat}>
              <Bot size={48} color="#cbd5e0" />
              <Text style={st.emptyChatTitle}>Начните диалог с AI-помощником</Text>
              <Text style={st.emptyChatSub}>
                {selectedProfile?.aiName || 'AI'} готов ответить на ваши вопросы
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          loading ? (
            <View style={[st.msgRow, st.msgRowAi]}>
              <View style={[st.avatar, st.avatarAi]}><Bot size={14} color="#667eea" /></View>
              <View style={[st.bubble, st.bubbleAi, { paddingHorizontal: 20 }]}>
                <ActivityIndicator size="small" color="#667eea" />
              </View>
            </View>
          ) : null
        }
      />

      {/* Input */}
      <View style={st.inputRow}>
        <TextInput
          style={st.input}
          value={input}
          onChangeText={setInput}
          placeholder="Напишите сообщение..."
          placeholderTextColor="#a0aec0"
          multiline
          maxHeight={100}
          editable={!loading}
        />
        <TouchableOpacity
          style={[st.sendBtn, (!input.trim() || loading) && st.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || loading}
        >
          <Send size={20} color="white" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  header: {
    flexDirection: 'row', alignItems: 'center', padding: 14,
    backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 10,
  },
  profilePicker: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  profileDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: '#1a202c' },
  clearBtn: { padding: 4 },
  messagesList: { padding: 16, flexGrow: 1 },
  emptyChat: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyChatTitle: { fontSize: 16, color: '#4a5568', fontWeight: '600', textAlign: 'center' },
  emptyChatSub: { color: '#a0aec0', fontSize: 14, textAlign: 'center' },
  msgRow: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end', gap: 8 },
  msgRowUser: { flexDirection: 'row-reverse' },
  msgRowAi: {},
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarUser: { backgroundColor: '#667eea' },
  avatarAi: { backgroundColor: '#e8ecfd' },
  bubble: { maxWidth: '75%', padding: 12, borderRadius: 16 },
  bubbleUser: { backgroundColor: '#667eea', borderBottomRightRadius: 4 },
  bubbleAi: { backgroundColor: 'white', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#e2e8f0' },
  bubbleTextUser: { color: 'white', fontSize: 15, lineHeight: 21 },
  bubbleTextAi: { color: '#1a202c', fontSize: 15, lineHeight: 21 },
  timeUser: { color: 'rgba(255,255,255,0.65)', fontSize: 11, marginTop: 4, textAlign: 'right' },
  timeAi: { color: '#a0aec0', fontSize: 11, marginTop: 4 },
  inputRow: {
    flexDirection: 'row', padding: 12, backgroundColor: 'white',
    borderTopWidth: 1, borderTopColor: '#e2e8f0', alignItems: 'flex-end', gap: 10,
  },
  input: {
    flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#1a202c', backgroundColor: '#f7fafc',
  },
  sendBtn: { backgroundColor: '#667eea', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.45 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: 'white', borderRadius: 20, padding: 20, paddingBottom: 36, maxHeight: '60%' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1a202c', marginBottom: 16 },
  modalItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  modalItemActive: { backgroundColor: '#fafbff', marginHorizontal: -4, paddingHorizontal: 4, borderRadius: 8 },
  modalItemName: { fontSize: 15, fontWeight: '600', color: '#1a202c' },
  modalItemSub: { fontSize: 12, color: '#94a3b8', marginTop: 1 },
  modalCheckmark: { color: '#667eea', fontSize: 18, fontWeight: '700' },
});
