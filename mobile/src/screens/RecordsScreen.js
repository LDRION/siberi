import axios from 'axios';
import { Database, Edit, Plus, Search, Trash2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
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

export default function RecordsScreen({ route, apiKey }) {
  const schema = route?.params?.schema;

  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);

  useEffect(() => {
    if (schema) fetchRecords();
  }, [schema, searchQuery]);

  const fetchRecords = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API_URL}/data/records/${schema.name}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params: { search: searchQuery },
      });
      setRecords(res.data.records || []);
    } catch (err) {
      console.error('Records fetch:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (record) => {
    Alert.alert('Удалить запись', 'Вы уверены?', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await axios.delete(`${API_URL}/data/records/${schema.name}/${record._id}`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            fetchRecords();
          } catch (err) {
            Alert.alert('Ошибка', err.response?.data?.error || 'Ошибка удаления');
          }
        },
      },
    ]);
  };

  if (!schema) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>Схема не выбрана</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search + Add */}
      <View style={styles.topBar}>
        <View style={styles.searchBox}>
          <Search size={16} color="#a0aec0" />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Поиск..."
            placeholderTextColor="#a0aec0"
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <X size={16} color="#a0aec0" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => {
            setEditingRecord(null);
            setShowForm(true);
          }}
        >
          <Plus size={20} color="white" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#667eea" />
        </View>
      ) : records.length === 0 ? (
        <View style={styles.centered}>
          <Database size={48} color="#cbd5e0" />
          <Text style={styles.emptyTitle}>Нет записей</Text>
          <Text style={styles.emptyText}>Нажмите + чтобы добавить первую запись</Text>
        </View>
      ) : (
        <FlatList
          data={records}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.recordCard}>
              {schema.fields.map((field) => (
                <View key={field.name} style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>{field.label}</Text>
                  <Text style={styles.fieldValue}>{item.data[field.name] || '—'}</Text>
                </View>
              ))}
              <View style={styles.recordActions}>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => {
                    setEditingRecord(item);
                    setShowForm(true);
                  }}
                >
                  <Edit size={15} color="#667eea" />
                  <Text style={styles.actionBtnText}>Изменить</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.deleteBtn]}
                  onPress={() => handleDelete(item)}
                >
                  <Trash2 size={15} color="#e53e3e" />
                  <Text style={styles.deleteBtnText}>Удалить</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {showForm && (
        <RecordFormModal
          apiKey={apiKey}
          schema={schema}
          record={editingRecord}
          onClose={() => {
            setShowForm(false);
            fetchRecords();
          }}
        />
      )}
    </View>
  );
}

function RecordFormModal({ apiKey, schema, record, onClose }) {
  const [formData, setFormData] = useState(
    record
      ? { ...record.data }
      : schema.fields.reduce((acc, f) => ({ ...acc, [f.name]: '' }), {})
  );
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const url = record
        ? `${API_URL}/data/records/${schema.name}/${record._id}`
        : `${API_URL}/data/records/${schema.name}`;
      const method = record ? 'put' : 'post';
      await axios[method](url, { data: formData }, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      onClose();
    } catch (err) {
      Alert.alert('Ошибка', err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={modal.header}>
          <Text style={modal.title}>{record ? 'Редактировать запись' : 'Новая запись'}</Text>
          <TouchableOpacity onPress={onClose}>
            <X size={24} color="#718096" />
          </TouchableOpacity>
        </View>

        <ScrollView style={modal.scroll} contentContainerStyle={modal.scrollContent}>
          {schema.fields.map((field) => (
            <View key={field.name}>
              <Text style={modal.label}>
                {field.label}
                {field.required ? ' *' : ''}
              </Text>
              <TextInput
                style={[modal.input, field.type === 'textarea' && modal.textarea]}
                value={formData[field.name] || ''}
                onChangeText={(v) => setFormData((p) => ({ ...p, [field.name]: v }))}
                placeholder={field.label}
                keyboardType={field.type === 'number' ? 'numeric' : field.type === 'email' ? 'email-address' : field.type === 'phone' ? 'phone-pad' : 'default'}
                multiline={field.type === 'textarea'}
                numberOfLines={field.type === 'textarea' ? 4 : 1}
              />
            </View>
          ))}
        </ScrollView>

        <View style={modal.footer}>
          <TouchableOpacity style={modal.cancelBtn} onPress={onClose}>
            <Text style={modal.cancelBtnText}>Отмена</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[modal.saveBtn, loading && { opacity: 0.7 }]}
            onPress={handleSubmit}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={modal.saveBtnText}>Сохранить</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f7fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#1a202c' },
  addBtn: {
    backgroundColor: '#667eea',
    width: 42,
    height: 42,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#4a5568' },
  emptyText: { color: '#a0aec0', textAlign: 'center' },
  list: { padding: 12, gap: 10 },
  recordCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  fieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f4ff',
  },
  fieldLabel: { fontSize: 13, color: '#718096', flex: 1 },
  fieldValue: { fontSize: 13, color: '#1a202c', fontWeight: '500', flex: 2, textAlign: 'right' },
  recordActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f0f4ff',
  },
  actionBtnText: { color: '#667eea', fontSize: 13, fontWeight: '500' },
  deleteBtn: { backgroundColor: '#fff5f5' },
  deleteBtnText: { color: '#e53e3e', fontSize: 13, fontWeight: '500' },
});

const modal = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: 'white',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#1a202c' },
  scroll: { flex: 1, backgroundColor: '#f7fafc' },
  scrollContent: { padding: 16, paddingBottom: 32 },
  label: { fontSize: 13, fontWeight: '600', color: '#4a5568', marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#1a202c',
  },
  textarea: { height: 100, textAlignVertical: 'top' },
  footer: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
    backgroundColor: 'white',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  cancelBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#f0f4ff',
    alignItems: 'center',
  },
  cancelBtnText: { color: '#667eea', fontWeight: '600', fontSize: 15 },
  saveBtn: {
    flex: 2,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#667eea',
    alignItems: 'center',
  },
  saveBtnText: { color: 'white', fontWeight: '600', fontSize: 15 },
});
