import axios from 'axios';
import { Database, Download, Edit, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import './SchemasPage.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export default function SchemasPage({ apiKey }) {
  const [schemas, setSchemas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingSchema, setEditingSchema] = useState(null);

  // 🔥 Состояния для импорта/экспорта
  const [loadingExport, setLoadingExport] = useState(false);
  const [loadingImport, setLoadingImport] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetchSchemas();
  }, []);

  const fetchSchemas = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/data/schemas`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setSchemas(response.data.schemas || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Ошибка загрузки схем');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSchema = async (schemaName) => {
    if (!window.confirm(`Удалить схему "${schemaName}" и все её записи?`)) return;
    try {
      await axios.delete(`${API_URL}/data/schemas/${schemaName}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      fetchSchemas();
    } catch (err) {
      setError(err.response?.data?.error || 'Ошибка удаления');
    }
  };

  // 🔥 ЭКСПОРТ ВСЕХ ДАННЫХ
  const handleExport = async () => {
    try {
      setLoadingExport(true);
      const response = await axios.get(`${API_URL}/data/export`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;

      const disposition = response.headers['content-disposition'];
      let filename = 'siberiai-export.json';
      if (disposition) {
        const match = disposition.match(/filename="?(.+)"?/i);
        if (match) filename = match[1];
      }

      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('❌ Ошибка экспорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoadingExport(false);
    }
  };

  // 🔥 ИМПОРТ ДАННЫХ
  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      alert('⚠️ Пожалуйста, выберите .json файл');
      return;
    }

    setLoadingImport(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post(`${API_URL}/data/import`, formData, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'multipart/form-data',
        },
      });

      if (response.data.success) {
        const { importedSchemas, importedRecords, errors } = response.data.summary;
        let msg = `✅ Импортировано: ${importedSchemas} схем, ${importedRecords} записей.`;
        if (errors?.length > 0) {
          msg += `\n⚠️ Пропущено (${errors.length}): ${errors.slice(0, 3).join('; ')}`;
        }
        alert(msg);
        fetchSchemas(); // Обновляем список
      }
    } catch (err) {
      alert('❌ Ошибка импорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoadingImport(false);
      e.target.value = ''; // Сброс input для повторной загрузки того же файла
    }
  };

  return (
    <div className="schemas-page">
      <div className="page-header">
        <h1>Управление схемами</h1>
        <p>Создайте структуры данных для вашего AI</p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="schemas-actions">
        {/* 🔥 ИСПРАВЛЕНО: Класс изменен на btn-glow-primary */}
        <button
          className="btn-glow-primary"
          onClick={() => {
            setEditingSchema(null);
            setShowForm(true);
          }}
        >
          <Plus size={18} /> Создать схему
        </button>

        {/* 🔥 Кнопки Импорт/Экспорт */}
        <div className="data-transfer-btns">
          <button className="btn-secondary" onClick={handleExport} disabled={loadingExport}>
            {loadingExport ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
            Экспорт
          </button>
          <button className="btn-secondary" onClick={handleImportClick} disabled={loadingImport}>
            {loadingImport ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            Импорт
          </button>
          <input
            type="file"
            ref={fileInputRef}
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      </div>

      {loading ? (
        <div className="loading-spinner">
          <Loader2 className="spin" size={32} />
        </div>
      ) : schemas.length === 0 ? (
        <div className="empty-state">
          <Database size={48} />
          <p>У вас ещё нет схем. Создайте первую!</p>
        </div>
      ) : (
        <div className="schemas-grid">
          {schemas.map((schema) => (
            <div key={schema.name} className="schema-card">
              <div className="schema-header">
                <div className="schema-icon" style={{ backgroundColor: schema.color }}>
                  {schema.icon}
                </div>
                <h3>{schema.label}</h3>
              </div>
              <p className="schema-description">{schema.description}</p>
              <div className="schema-actions">
                <button
                  onClick={() => {
                    setEditingSchema(schema);
                    setShowForm(true);
                  }}
                >
                  <Edit size={16} /> Редактировать
                </button>
                <button onClick={() => handleDeleteSchema(schema.name)}>
                  <Trash2 size={16} /> Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <SchemaForm
          apiKey={apiKey}
          schema={editingSchema}
          onClose={() => {
            setShowForm(false);
            fetchSchemas();
          }}
        />
      )}
    </div>
  );
}

// Компонент формы для схемы
function SchemaForm({ apiKey, schema, onClose }) {
  const [formData, setFormData] = useState({
    name: schema?.name || '',
    label: schema?.label || '',
    description: schema?.description || '',
    icon: schema?.icon || '📋',
    color: schema?.color || '#3b82f6',
    fields: schema?.fields || [{ name: '', label: '', type: 'text' }],
  });

  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const url = schema ? `${API_URL}/data/schemas/${schema.name}` : `${API_URL}/data/schemas`;
      const method = schema ? 'put' : 'post';

      await axios[method](url, formData, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      onClose();
    } catch (err) {
      alert(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>{schema ? 'Редактировать схему' : 'Создать новую схему'}</h2>
        <form onSubmit={handleSubmit}>
          {/* Поля формы */}
          <div className="form-group">
            <label>Имя (латиницей)</label>
            <input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
              pattern="[a-zA-Z0-9_]+"
            />
          </div>

          <div className="form-group">
            <label>Название (для отображения)</label>
            <input
              value={formData.label}
              onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              required
            />
          </div>

          <div className="form-group">
            <label>Описание</label>
            <textarea
              rows={3}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Иконка (эмодзи)</label>
            <input
              value={formData.icon}
              onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Цвет (HEX)</label>
            <input
              type="color"
              value={formData.color}
              onChange={(e) => setFormData({ ...formData, color: e.target.value })}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            {/* 🔥 ИСПРАВЛЕНО: Класс модальной кнопки тоже обновлен */}
            <button type="submit" className="btn-glow-primary" disabled={loading}>
              {loading ? <Loader2 className="spin" size={18} /> : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
