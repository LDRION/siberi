import axios from 'axios';
import { Database, Download, Edit, Loader2, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import './RecordsPage.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export default function RecordsPage({ apiKey }) {
  const [schemas, setSchemas] = useState([]);
  const [selectedSchema, setSelectedSchema] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // 🔥 Состояния для импорта/экспорта
  const [loadingExport, setLoadingExport] = useState(false);
  const [loadingImport, setLoadingImport] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetchSchemas();
  }, []);

  const fetchSchemas = async () => {
    try {
      const response = await axios.get(`${API_URL}/data/schemas`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setSchemas(response.data.schemas || []);
      if (response.data.schemas?.length > 0 && !selectedSchema) {
        setSelectedSchema(response.data.schemas[0].name);
      }
    } catch (err) {
      console.error('Ошибка загрузки схем:', err);
    }
  };

  const fetchRecords = async () => {
    if (!selectedSchema) return;
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/data/records/${selectedSchema}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params: { search: searchQuery },
      });
      setRecords(response.data.records || []);
    } catch (err) {
      console.error('Ошибка загрузки записей:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, [selectedSchema, searchQuery]);

  const handleDeleteRecord = async (recordId) => {
    if (!window.confirm('Удалить запись?')) return;
    try {
      await axios.delete(`${API_URL}/data/records/${selectedSchema}/${recordId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      fetchRecords();
    } catch (err) {
      console.error('Ошибка удаления:', err);
    }
  };

  // 🔥 ЭКСПОРТ
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

  // 🔥 ИМПОРТ
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
        fetchSchemas();
        fetchRecords();
      }
    } catch (err) {
      alert('❌ Ошибка импорта: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoadingImport(false);
      e.target.value = '';
    }
  };

  return (
    <div className="records-page">
      <div className="page-header">
        <h1>Управление записями</h1>
        <p>Добавьте данные для вашего AI</p>
      </div>

      {/* Верхняя панель управления */}
      <div className="records-controls-top">
        <div className="schema-selector">
          <label>Схема:</label>
          <select value={selectedSchema || ''} onChange={(e) => setSelectedSchema(e.target.value)}>
            {schemas.map((schema) => (
              <option key={schema.name} value={schema.name}>
                {schema.label}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn-glow-primary"
          onClick={() => {
            setEditingRecord(null);
            setShowForm(true);
          }}
          disabled={!selectedSchema}
        >
          <Plus size={18} /> Добавить запись
        </button>

        {/* Кнопки Импорт/Экспорт */}
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

      {/* Строка поиска (теперь отдельно) */}
      <div className="search-bar-container">
        <div className="search-box full-width">
          <Search size={18} />
          <input
            type="text"
            placeholder="Поиск по всем записям..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="loading-spinner">
          <Loader2 className="spin" size={32} />
        </div>
      ) : records.length === 0 ? (
        <div className="empty-state">
          <Database size={48} />
          <p>Нет записей. Добавьте первую!</p>
        </div>
      ) : (
        <div className="records-table">
          <table>
            <thead>
              <tr>
                {selectedSchema &&
                  schemas
                    .find((s) => s.name === selectedSchema)
                    ?.fields.map((field) => <th key={field.name}>{field.label}</th>)}
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record._id}>
                  {selectedSchema &&
                    schemas
                      .find((s) => s.name === selectedSchema)
                      ?.fields.map((field) => (
                        <td key={field.name}>{record.data[field.name] || '—'}</td>
                      ))}
                  <td className="record-actions">
                    <button
                      onClick={() => {
                        setEditingRecord(record);
                        setShowForm(true);
                      }}
                    >
                      <Edit size={16} />
                    </button>
                    <button onClick={() => handleDeleteRecord(record._id)}>
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && selectedSchema && (
        <RecordForm
          apiKey={apiKey}
          schema={schemas.find((s) => s.name === selectedSchema)}
          record={editingRecord}
          onClose={() => {
            setShowForm(false);
            fetchRecords();
          }}
        />
      )}
    </div>
  );
}

// Компонент формы для записи
function RecordForm({ apiKey, schema, record, onClose }) {
  const [formData, setFormData] = useState(
    record
      ? { ...record.data }
      : schema.fields.reduce((acc, field) => ({ ...acc, [field.name]: '' }), {})
  );
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const url = record
        ? `${API_URL}/data/records/${schema.name}/${record._id}`
        : `${API_URL}/data/records/${schema.name}`;
      const method = record ? 'put' : 'post';

      await axios[method](
        url,
        { data: formData },
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      );
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
        <h2>{record ? 'Редактировать запись' : 'Добавить запись'}</h2>
        <form onSubmit={handleSubmit}>
          {schema.fields.map((field) => (
            <div key={field.name} className="form-group">
              <label>{field.label}</label>
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                value={formData[field.name] || ''}
                onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                required={field.required}
              />
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn-glow-primary">
              {loading ? <Loader2 className="spin" size={18} /> : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
