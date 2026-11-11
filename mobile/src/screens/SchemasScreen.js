import { useNavigation } from '@react-navigation/native';
import axios from 'axios';
import { ChevronRight, Database, Edit, Plus, Trash2, X } from 'lucide-react-native';
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

const FIELD_TYPES = ['text', 'number', 'email', 'phone', 'date', 'textarea'];

export default function SchemasScreen({ apiKey }) {
  const navigation = useNavigation();
  const [schemas, setSchemas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingSchema, setEditingSchema] = useState(null);

  useEffect(() => {
    fetchSchemas();
  }, []);

  const fetchSchemas = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API_URL}/data/schemas`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setSchemas(res.data.schemas || []);
    } catch (err) {
      Alert.alert('Ошибка', err.response?.data?.error || 'Не удалось загрузить схемы');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (schema) => {
    Alert.alert('Удалить схему', `Удалить "${schema.label}" и все её записи?`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await axios.delete(`${API_URL}/data/schemas/${schema.name}`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            fetchSchemas();
          } catch (err) {
            Alert.alert('Ошибка', err.response?.data?.error || 'Ошибка удаления');
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.actionBar}>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => {
            setEditingSchema(null);
            setShowForm(true);
          }}
        >
          <Plus size={18} color="white" />
          <Text style={styles.addBtnText}>Создать схему</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#667eea" />
        </View>
      ) : schemas.length === 0 ? (
        <View style={styles.centered}>
          <Database size={52} color="#cbd5e0" />
          <Text style={styles.emptyTitle}>Нет схем</Text>
          <Text style={styles.emptyText}>Создайте первую схему данных для AI</Text>
        </View>
      ) : (
        <FlatList
          data={schemas}
          keyExtractor={(item) => item.name}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.schemaCard}>
              <TouchableOpacity
                style={styles.schemaMain}
                onPress={() => navigation.navigate('Records', { schema: item })}
              >
                <View style={[styles.schemaIcon, { backgroundColor: item.color || '#667eea' }]}>
                  <Text style={styles.schemaIconText}>{item.icon || '📋'}</Text>
                </View>
                <View style={styles.schemaInfo}>
                  <Text style={styles.schemaLabel}>{item.label}</Text>
                  {item.description ? (
                    <Text style={styles.schemaDesc} numberOfLines={1}>
                      {item.description}
                    </Text>
                  ) : null}
                  <Text style={styles.schemaFieldCount}>{item.fields?.length || 0} полей</Text>
                </View>
                <ChevronRight size={20} color="#a0aec0" />
              </TouchableOpacity>
              <View style={styles.schemaActions}>
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={() => {
                    setEditingSchema(item);
                    setShowForm(true);
                  }}
                >
                  <Edit size={16} color="#667eea" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.iconBtn} onPress={() => handleDelete(item)}>
                  <Trash2 size={16} color="#e53e3e" />
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {showForm && (
        <SchemaFormModal
          apiKey={apiKey}
          schema={editingSchema}
          onClose={() => {
            setShowForm(false);
            fetchSchemas();
          }}
        />
      )}
    </View>
  );
}

function SchemaFormModal({ apiKey, schema, onClose }) {
  const [formData, setFormData] = useState({
    name: schema?.name || '',
    label: schema?.label || '',
    description: schema?.description || '',
    icon: schema?.icon || '📋',
    color: schema?.color || '#667eea',
    fields: schema?.fields?.length
      ? schema.fields
      : [{ name: '', label: '', type: 'text', required: false }],
  });
  const [loading, setLoading] = useState(false);

  const addField = () =>
    setFormData((prev) => ({
      ...prev,
      fields: [...prev.fields, { name: '', label: '', type: 'text', required: false }],
    }));

  const removeField = (index) =>
    setFormData((prev) => ({
      ...prev,
      fields: prev.fields.filter((_, i) => i !== index),
    }));

  const updateField = (index, key, value) =>
    setFormData((prev) => {
      const fields = [...prev.fields];
      fields[index] = { ...fields[index], [key]: value };
      return { ...prev, fields };
    });

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.label.trim()) {
      Alert.alert('Ошибка', 'Заполните имя и название схемы');
      return;
    }
    setLoading(true);
    try {
      const url = schema ? `${API_URL}/data/schemas/${schema.name}` : `${API_URL}/data/schemas`;
      const method = schema ? 'put' : 'post';
      await axios[method](url, formData, {
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
          <Text style={modal.title}>{schema ? 'Редактировать схему' : 'Новая схема'}</Text>
          <TouchableOpacity onPress={onClose}>
            <X size={24} color="#718096" />
          </TouchableOpacity>
        </View>

        <ScrollView style={modal.scroll} contentContainerStyle={modal.scrollContent}>
          <Text style={modal.label}>Имя (латиницей, без пробелов)</Text>
          <TextInput
            style={[modal.input, schema && modal.inputDisabled]}
            value={formData.name}
            onChangeText={(v) =>
              setFormData((p) => ({ ...p, name: v.replace(/[^a-zA-Z0-9_]/g, '') }))
            }
            placeholder="my_schema"
            autoCapitalize="none"
            editable={!schema}
          />

          <Text style={modal.label}>Название для отображения</Text>
          <TextInput
            style={modal.input}
            value={formData.label}
            onChangeText={(v) => setFormData((p) => ({ ...p, label: v }))}
            placeholder="Моя схема"
          />

          <Text style={modal.label}>Описание</Text>
          <TextInput
            style={[modal.input, modal.textarea]}
            value={formData.description}
            onChangeText={(v) => setFormData((p) => ({ ...p, description: v }))}
            placeholder="Описание схемы..."
            multiline
            numberOfLines={3}
          />

          <View style={modal.row}>
            <View style={{ flex: 1 }}>
              <Text style={modal.label}>Иконка (эмодзи)</Text>
              <TextInput
                style={modal.input}
                value={formData.icon}
                onChangeText={(v) => setFormData((p) => ({ ...p, icon: v }))}
                placeholder="📋"
              />
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={modal.label}>Цвет (HEX)</Text>
              <TextInput
                style={modal.input}
                value={formData.color}
                onChangeText={(v) => setFormData((p) => ({ ...p, color: v }))}
                placeholder="#667eea"
                autoCapitalize="none"
              />
            </View>
          </View>

          <View style={modal.fieldsHeader}>
            <Text style={modal.sectionTitle}>Поля схемы</Text>
            <TouchableOpacity style={modal.addFieldBtn} onPress={addField}>
              <Plus size={15} color="white" />
              <Text style={modal.addFieldBtnText}>Добавить</Text>
            </TouchableOpacity>
          </View>

          {formData.fields.map((field, index) => (
            <View key={index} style={modal.fieldCard}>
              <View style={modal.fieldCardHeader}>
                <Text style={modal.fieldIndex}>Поле {index + 1}</Text>
                <TouchableOpacity onPress={() => removeField(index)}>
                  <X size={16} color="#e53e3e" />
                </TouchableOpacity>
              </View>
              <TextInput
                style={modal.input}
                value={field.name}
                onChangeText={(v) => updateField(index, 'name', v.replace(/[^a-zA-Z0-9_]/g, ''))}
                placeholder="field_name"
                autoCapitalize="none"
              />
              <TextInput
                style={modal.input}
                value={field.label}
                onChangeText={(v) => updateField(index, 'label', v)}
                placeholder="Название поля"
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 10 }}
              >
                {FIELD_TYPES.map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[modal.typeChip, field.type === type && modal.typeChipActive]}
                    onPress={() => updateField(index, 'type', type)}
                  >
                    <Text
                      style={[modal.typeChipText, field.type === type && modal.typeChipTextActive]}
                    >
                      {type}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={modal.requiredRow}
                onPress={() => updateField(index, 'required', !field.required)}
              >
                <View style={[modal.checkbox, field.required && modal.checkboxChecked]}>
                  {field.required ? <Text style={{ color: 'white', fontSize: 11 }}>✓</Text> : null}
                </View>
                <Text style={modal.requiredText}>Обязательное поле</Text>
              </TouchableOpacity>
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
  actionBar: {
    padding: 12,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  addBtn: {
    backgroundColor: '#667eea',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 12,
    borderRadius: 10,
  },
  addBtnText: { color: 'white', fontWeight: '600', fontSize: 15 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#4a5568' },
  emptyText: { color: '#a0aec0', textAlign: 'center' },
  list: { padding: 12, gap: 10 },
  schemaCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
    overflow: 'hidden',
  },
  schemaMain: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  schemaIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  schemaIconText: { fontSize: 22 },
  schemaInfo: { flex: 1 },
  schemaLabel: { fontSize: 15, fontWeight: '700', color: '#1a202c' },
  schemaDesc: { fontSize: 13, color: '#718096', marginTop: 2 },
  schemaFieldCount: { fontSize: 12, color: '#a0aec0', marginTop: 2 },
  schemaActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#f0f4ff',
  },
  iconBtn: {
    flex: 1,
    alignItems: 'center',
    padding: 10,
  },
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
    marginBottom: 4,
  },
  inputDisabled: { backgroundColor: '#f7fafc', color: '#a0aec0' },
  textarea: { height: 80, textAlignVertical: 'top' },
  row: { flexDirection: 'row' },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#1a202c' },
  fieldsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    marginBottom: 8,
  },
  addFieldBtn: {
    backgroundColor: '#667eea',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  addFieldBtnText: { color: 'white', fontSize: 13, fontWeight: '600' },
  fieldCard: {
    backgroundColor: 'white',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  fieldCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  fieldIndex: { fontSize: 13, fontWeight: '600', color: '#4a5568' },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#f0f4ff',
    marginRight: 6,
  },
  typeChipActive: { backgroundColor: '#667eea' },
  typeChipText: { fontSize: 13, color: '#667eea', fontWeight: '500' },
  typeChipTextActive: { color: 'white' },
  requiredRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#667eea', borderColor: '#667eea' },
  requiredText: { fontSize: 14, color: '#4a5568' },
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
