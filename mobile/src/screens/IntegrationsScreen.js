import axios from 'axios';
import { Check, Copy, Globe, MessageSquare, Monitor, RefreshCw, Share2, Zap } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../api';

const BASE_URL = API_URL.replace('/api/v1', '');

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function getTelegramCode(apiKey, aiName) {
  return `const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const API_KEY = '${apiKey}';
const API_BASE = '${BASE_URL}';
const TG_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';

const bot = new TelegramBot(TG_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const { data } = await axios.post(API_BASE + '/api/v1/analyze',
    { prompt: msg.text },
    { headers: { Authorization: 'Bearer ' + API_KEY } }
  );
  const poll = async (n = 0) => {
    const r = await axios.get(API_BASE + '/api/v1/result/' + data.taskId,
      { headers: { Authorization: 'Bearer ' + API_KEY } }
    );
    if (r.data.status === 'completed') bot.sendMessage(chatId, r.data.result);
    else if (r.data.status === 'error') bot.sendMessage(chatId, '❌ ' + r.data.error);
    else if (n < 120) setTimeout(() => poll(n + 1), 1500);
  };
  poll();
});`;
}

function getWidgetCode(apiKey, aiName) {
  return `<!-- Вставьте перед </body> на вашем сайте -->
<div id="siberi-btn" onclick="siberiToggle()">💬</div>
<div id="siberi-widget" style="display:none;">
  <div class="sw-h">${aiName} <span onclick="siberiToggle()">✕</span></div>
  <div id="sw-msgs"></div>
  <div class="sw-in">
    <input id="sw-inp" placeholder="Вопрос..." onkeypress="if(event.key==='Enter')siberiSend()">
    <button onclick="siberiSend()">➤</button>
  </div>
</div>
<script>
const _K='${apiKey}',_B='${BASE_URL}';
function siberiToggle(){var w=document.getElementById('siberi-widget'),b=document.getElementById('siberi-btn');w.style.display=w.style.display==='none'?'flex':'none';b.style.display=w.style.display==='flex'?'none':'flex';}
async function siberiSend(){var i=document.getElementById('sw-inp'),t=i.value.trim();if(!t)return;swAdd(t,'u');i.value='';i.disabled=true;swAdd('...','ai');try{var r=await fetch(_B+'/api/v1/analyze',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+_K},body:JSON.stringify({prompt:t})});var d=await r.json();var p=async()=>{var r2=await fetch(_B+'/api/v1/result/'+d.taskId);var d2=await r2.json();if(d2.status==='completed'){document.querySelector('.sw-msg.ai:last-child').remove();swAdd(d2.result,'ai');i.disabled=false;}else if(d2.status==='error'){document.querySelector('.sw-msg.ai:last-child').remove();swAdd('❌ '+d2.error,'e');i.disabled=false;}else setTimeout(p,1500);};p();}catch(e){i.disabled=false;}}
function swAdd(t,c){var m=document.getElementById('sw-msgs'),d=document.createElement('div');d.className='sw-msg '+c;d.textContent=t;m.appendChild(d);m.scrollTop=m.scrollHeight;}
</script>
<style>
#siberi-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;background:#667eea;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;cursor:pointer;z-index:9999;}
#siberi-widget{position:fixed;bottom:24px;right:24px;width:350px;max-height:500px;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.15);flex-direction:column;z-index:9999;}
</style>`;
}

function getFullpageCode(apiKey, aiName) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${aiName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f8fafc;height:100vh;display:flex;flex-direction:column}
header{background:#667eea;color:#fff;padding:16px 24px;font-size:18px;font-weight:700}
#msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:70%;padding:12px 16px;border-radius:16px;font-size:15px}
.msg.u{background:#667eea;color:#fff;align-self:flex-end}
.msg.ai{background:#fff;color:#1a202c;border:1px solid #e2e8f0;align-self:flex-start}
footer{padding:16px;background:#fff;border-top:1px solid #e2e8f0;display:flex;gap:10px}
input{flex:1;padding:12px 16px;border:1px solid #e2e8f0;border-radius:24px;font-size:15px}
button{background:#667eea;color:#fff;border:none;border-radius:24px;padding:12px 24px;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<header>🤖 ${aiName}</header>
<div id="msgs"></div>
<footer>
  <input id="inp" placeholder="Напишите сообщение..." onkeypress="if(event.key==='Enter')send()">
  <button onclick="send()">Отправить</button>
</footer>
<script>
const K='${apiKey}',B='${BASE_URL}';
const msgs=document.getElementById('msgs'),inp=document.getElementById('inp');
function add(t,c){const d=document.createElement('div');d.className='msg '+c;d.textContent=t;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d;}
async function send(){
  const t=inp.value.trim();if(!t)return;inp.value='';
  add(t,'u');const ai=add('...','ai');
  const r=await fetch(B+'/api/v1/analyze',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+K},body:JSON.stringify({prompt:t})});
  const d=await r.json();
  const poll=async(n=0)=>{const r2=await fetch(B+'/api/v1/result/'+d.taskId,{headers:{'Authorization':'Bearer '+K}});const d2=await r2.json();if(d2.status==='completed')ai.textContent=d2.result;else if(d2.status==='error')ai.textContent='❌ '+d2.error;else if(n<120)setTimeout(()=>poll(n+1),1500);};poll();
}
</script>
</body>
</html>`;
}

const CODE_TEMPLATES = [
  {
    id: 'widget',
    Icon: Globe,
    title: 'Виджет на сайт',
    desc: 'Плавающий AI-чат. Без зависимостей.',
    filename: 'siberi-widget.html',
    steps: ['Скопируйте код', 'Вставьте перед </body> на сайте', 'Кнопка 💬 появится автоматически'],
  },
  {
    id: 'fullpage',
    Icon: Monitor,
    title: 'Полноэкранный AI-чат',
    desc: 'Интерфейс как у ChatGPT. Для лендингов.',
    filename: 'ai-chat.html',
    steps: ['Сохраните код как ai-chat.html', 'Откройте в браузере или разместите на хостинге'],
  },
  {
    id: 'telegram',
    Icon: MessageSquare,
    title: 'Telegram Bot (шаблон)',
    desc: 'Node.js шаблон с поллингом',
    filename: 'siberi-bot.js',
    steps: ['npm install node-telegram-bot-api axios', 'Создайте бота у @BotFather', 'Замените YOUR_TELEGRAM_BOT_TOKEN', 'node siberi-bot.js'],
  },
];

export default function IntegrationsScreen({ apiKey }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [config, setConfig] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setLoadingStatus(true);
    try {
      const [statusRes, configRes] = await Promise.all([
        axios.get(`${API_URL}/integrations/status`, { headers: { Authorization: `Bearer ${apiKey}` } })
          .catch(() => ({ data: {} })),
        axios.get(`${API_URL}/config`, { headers: { Authorization: `Bearer ${apiKey}` } })
          .catch(() => ({ data: {} })),
      ]);
      setStatus(statusRes.data);
      if (configRes.data.success) setConfig(configRes.data.config);
    } finally { setLoadingStatus(false); }
  };

  const aiName = config?.aiName || 'AI-Помощник';

  const getCode = (id) => {
    if (id === 'telegram') return getTelegramCode(apiKey, aiName);
    if (id === 'widget') return getWidgetCode(apiKey, aiName);
    if (id === 'fullpage') return getFullpageCode(apiKey, aiName);
    return '';
  };

  const handleShare = async (item) => {
    try {
      await Share.share({ message: getCode(item.id), title: item.filename });
    } catch {
      Alert.alert('Ошибка', 'Не удалось открыть меню поделиться');
    }
  };

  const handleCopy = (item) => {
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 2000);
    Alert.alert('Код готов', `Поделитесь файлом ${item.filename}`, [
      { text: 'Поделиться', onPress: () => handleShare(item) },
      { text: 'OK', style: 'cancel' },
    ]);
  };

  // Build active integrations list
  const tgBots = status?.telegram || [];
  const vkGroups = status?.vk || [];
  const maxBots = status?.max || [];
  const hasWidget = status?.widget?.active;
  const hasApi = status?.api?.active;
  const totalActive = tgBots.length + vkGroups.length + maxBots.length + (hasWidget ? 1 : 0) + (hasApi ? 1 : 0);

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <View style={s.pageHeader}>
        <Text style={s.title}>Интеграции</Text>
        <Text style={s.subtitle}>Подключённые каналы и инструменты</Text>
      </View>

      {/* Active integrations status */}
      <View style={s.card}>
        <View style={s.cardHeaderRow}>
          <Text style={s.cardTitle}>Активные подключения</Text>
          <TouchableOpacity onPress={fetchAll} style={s.refreshBtn}>
            {loadingStatus ? <ActivityIndicator size="small" color="#667eea" /> : <RefreshCw size={16} color="#667eea" />}
          </TouchableOpacity>
        </View>

        {loadingStatus ? (
          <ActivityIndicator color="#667eea" style={{ marginVertical: 16 }} />
        ) : totalActive === 0 ? (
          <Text style={s.emptyText}>Нет активных интеграций</Text>
        ) : (
          <>
            {tgBots.map((b, i) => (
              <View key={i} style={s.integRow}>
                <Text style={s.integEmoji}>🤖</Text>
                <View style={s.integInfo}>
                  <Text style={s.integName}>{b.name || b.botUsername || `Telegram Bot ${i + 1}`}</Text>
                  <Text style={s.integSub}>@{b.botUsername} · Telegram</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: b.connected ? '#16a34a' : '#f59e0b' }]} />
              </View>
            ))}
            {vkGroups.map((g, i) => (
              <View key={i} style={s.integRow}>
                <Text style={s.integEmoji}>💬</Text>
                <View style={s.integInfo}>
                  <Text style={s.integName}>{g.name || `VK Группа ${i + 1}`}</Text>
                  <Text style={s.integSub}>ID {g.groupId} · ВКонтакте</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: g.connected ? '#16a34a' : '#f59e0b' }]} />
              </View>
            ))}
            {maxBots.map((b, i) => (
              <View key={i} style={s.integRow}>
                <Text style={s.integEmoji}>📱</Text>
                <View style={s.integInfo}>
                  <Text style={s.integName}>{b.name || b.botUsername || `MAX Bot ${i + 1}`}</Text>
                  <Text style={s.integSub}>MAX · {b.connected ? 'Подключён' : 'Ожидание'}</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: b.connected ? '#16a34a' : '#f59e0b' }]} />
              </View>
            ))}
            {hasWidget && (
              <View style={s.integRow}>
                <Text style={s.integEmoji}>🌐</Text>
                <View style={s.integInfo}>
                  <Text style={s.integName}>AI виджет на сайте</Text>
                  <Text style={s.integSub}>Активен</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: '#16a34a' }]} />
              </View>
            )}
            {hasApi && (
              <View style={s.integRow}>
                <Text style={s.integEmoji}>⚡</Text>
                <View style={s.integInfo}>
                  <Text style={s.integName}>REST API</Text>
                  <Text style={s.integSub}>Используется</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: '#16a34a' }]} />
              </View>
            )}
          </>
        )}
      </View>

      {/* Code templates */}
      <Text style={s.sectionLabel}>Шаблоны кода</Text>
      {CODE_TEMPLATES.map((item) => (
        <View key={item.id} style={s.card}>
          <TouchableOpacity
            style={s.templateHeader}
            onPress={() => setExpanded(expanded === item.id ? null : item.id)}
          >
            <View style={s.templateIconWrap}>
              <item.Icon size={20} color="#667eea" />
            </View>
            <View style={s.templateHeaderText}>
              <Text style={s.templateTitle}>{item.title}</Text>
              <Text style={s.templateDesc}>{item.desc}</Text>
            </View>
            <Text style={s.chevron}>{expanded === item.id ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expanded === item.id && (
            <View style={s.templateBody}>
              <View style={s.actions}>
                <TouchableOpacity style={s.actionBtn} onPress={() => handleCopy(item)}>
                  {copiedId === item.id ? <Check size={15} color="#22543d" /> : <Copy size={15} color="#667eea" />}
                  <Text style={s.actionBtnText}>{copiedId === item.id ? 'Готово!' : 'Получить'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtn, s.shareBtn]} onPress={() => handleShare(item)}>
                  <Share2 size={15} color="white" />
                  <Text style={s.shareBtnText}>Поделиться</Text>
                </TouchableOpacity>
              </View>
              <View style={s.steps}>
                {item.steps.map((step, i) => (
                  <View key={i} style={s.stepRow}>
                    <View style={s.stepNum}><Text style={s.stepNumText}>{i + 1}</Text></View>
                    <Text style={s.stepText}>{step}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      ))}

      <View style={s.infoCard}>
        <Zap size={16} color="#4338ca" />
        <Text style={s.infoText}>
          Код уже содержит ваш API-ключ. Нажмите «Поделиться» — отправьте в Notes, Telegram или Email.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  content: { padding: 16, paddingBottom: 40 },
  pageHeader: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '800', color: '#1a202c' },
  subtitle: { color: '#718096', marginTop: 4, fontSize: 13 },
  card: {
    backgroundColor: 'white', borderRadius: 14, padding: 16, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, overflow: 'hidden',
  },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#1a202c' },
  refreshBtn: { padding: 4 },
  emptyText: { color: '#a0aec0', fontSize: 14, paddingVertical: 8 },
  integRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  integEmoji: { fontSize: 20, width: 28, textAlign: 'center' },
  integInfo: { flex: 1 },
  integName: { fontSize: 14, fontWeight: '600', color: '#1a202c' },
  integSub: { fontSize: 12, color: '#94a3b8', marginTop: 1 },
  statusDot: { width: 9, height: 9, borderRadius: 5, flexShrink: 0 },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: '#718096', marginBottom: 10, marginTop: 4, letterSpacing: 0.5, textTransform: 'uppercase' },
  templateHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  templateIconWrap: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#f0f4ff', alignItems: 'center', justifyContent: 'center' },
  templateHeaderText: { flex: 1 },
  templateTitle: { fontSize: 14, fontWeight: '700', color: '#1a202c' },
  templateDesc: { fontSize: 12, color: '#718096', marginTop: 1 },
  chevron: { fontSize: 11, color: '#a0aec0' },
  templateBody: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#f0f4ff', gap: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: 11, borderRadius: 10, backgroundColor: '#f0f4ff', borderWidth: 1, borderColor: '#667eea',
  },
  actionBtnText: { color: '#667eea', fontWeight: '600', fontSize: 13 },
  shareBtn: { backgroundColor: '#667eea', borderColor: '#667eea' },
  shareBtnText: { color: 'white', fontWeight: '600', fontSize: 13 },
  steps: { gap: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stepNum: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#667eea', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  stepNumText: { color: 'white', fontSize: 11, fontWeight: '700' },
  stepText: { flex: 1, fontSize: 13, color: '#4a5568', lineHeight: 19 },
  infoCard: {
    backgroundColor: '#f0f4ff', borderRadius: 12, padding: 14, marginTop: 4,
    borderWidth: 1, borderColor: '#c7d2fe', flexDirection: 'row', gap: 10, alignItems: 'flex-start',
  },
  infoText: { flex: 1, fontSize: 13, color: '#4338ca', lineHeight: 19 },
});
