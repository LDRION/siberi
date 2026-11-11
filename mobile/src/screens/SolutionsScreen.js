import { useNavigation } from '@react-navigation/native';
import { ArrowRight, Briefcase, Check, Code, Scissors, Sparkles, TrendingUp, User } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const personas = [
  {
    id: 'developer',
    title: 'Я разработчик',
    Icon: Code,
    shortDesc: 'API, гибкая настройка, готовые интеграции',
    benefits: [
      'Доступ к AI через персональный API-ключ в любых проектах',
      'Детальная настройка промпта, тональности и ограничений',
      'Готовые шаблоны: Telegram-бот, виджет, полноэкранный чат',
      'Управление данными через UI или AI-команды в чате',
      'Создание и удаление схем данных без SQL',
      'Экспорт/импорт в один клик',
    ],
    fullText:
      'С Siberi.AI вы получаете полноценный AI-шлюз с памятью и доступом к вашим данным. Внедрение за минуты, а не недели.',
  },
  {
    id: 'office',
    title: 'Я офисный работник',
    Icon: Briefcase,
    shortDesc: 'Автоматизация рутины, умный помощник с памятью',
    benefits: [
      'Структурирование баз знаний и регламентов без программистов',
      'Мгновенный поиск по внутренним данным через чат',
      'Автоматическое ведение расписаний и заметок',
      'Экономия 2–4 часов в день на рутинных задачах',
      'Приватность: ваши данные хранятся изолированно',
    ],
    fullText:
      'Настройте AI под свои задачи один раз — и он будет помнить регламенты, шаблоны писем, расписания. Фокусируйтесь на важном.',
  },
  {
    id: 'freelancer',
    title: 'Я ИП / мастер своего дела',
    Icon: Scissors,
    shortDesc: 'Персональный ассистент 24/7, учёт клиентов',
    benefits: [
      'База клиентов, записей и прайс-листов в одном окне',
      'Автоматические ответы на частые вопросы',
      'Напоминания о записях, оплатах и поставках',
      'Простой интерфейс без кода и сложных настроек',
      'Запуск за 10 минут. Работает с телефона',
    ],
    fullText:
      'Создайте базу клиентов и расписание — ваш AI-помощник будет отвечать на вопросы и вести учёт. Без программистов.',
  },
  {
    id: 'business',
    title: 'Я предприниматель',
    Icon: TrendingUp,
    shortDesc: 'Снижение расходов, современный имидж',
    benefits: [
      'Замена первой линии поддержки и онлайн-консультантов',
      'Обучение AI на ваших FAQ и технических спецификациях',
      'Круглосуточные ответы клиентам без ошибок',
      'Виджет на сайт или Telegram-бот за один вечер',
      'Снижение расходов на поддержку в 3–5 раз',
    ],
    fullText:
      'Нейросеть запомнит регламенты и будет отвечать клиентам точно и вежливо 24/7. Подключите за один вечер.',
  },
  {
    id: 'personal',
    title: 'Я просто пользователь',
    Icon: User,
    shortDesc: 'Личный AI-органайзер без навыков кода',
    benefits: [
      'Учёт расписания, привычек и личных заметок',
      'Общение с AI в привычном мессенджер-формате',
      'Никакого кода, серверов и сложных настроек',
      'Приватное хранилище: ваши данные видите только вы',
      'Работает на любом устройстве',
    ],
    fullText:
      'Загружайте расписание, заметки, рецепты — и спрашивайте о них в чате. Нейросеть запомнит всё о вас.',
  },
];

export default function SolutionsScreen() {
  const navigation = useNavigation();
  const [selected, setSelected] = useState(null);
  const scrollViewRef = useRef(null);
  const detailCardRef = useRef(null);

  const activePersona = personas.find((p) => p.id === selected);

  const handleSelect = (id) => {
    const next = selected === id ? null : id;
    setSelected(next);
    if (next) {
      setTimeout(() => {
        detailCardRef.current?.measureLayout(
          scrollViewRef.current,
          (x, y) => scrollViewRef.current?.scrollTo({ y: y - 16, animated: true }),
          () => {}
        );
      }, 50);
    }
  };

  return (
    <ScrollView ref={scrollViewRef} style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.pageHeader}>
        <Text style={styles.title}>Кому пригодится Siberi.AI?</Text>
        <Text style={styles.subtitle}>Выберите свою роль</Text>
      </View>

      <View style={styles.grid}>
        {personas.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[styles.personaCard, selected === p.id && styles.personaCardActive]}
            onPress={() => handleSelect(p.id)}
          >
            <View style={[styles.personaIcon, selected === p.id && styles.personaIconActive]}>
              <p.Icon size={24} color={selected === p.id ? 'white' : '#667eea'} />
            </View>
            <Text style={[styles.personaTitle, selected === p.id && styles.personaTitleActive]}>
              {p.title}
            </Text>
            <Text style={[styles.personaDesc, selected === p.id && styles.personaDescActive]} numberOfLines={2}>
              {p.shortDesc}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {activePersona && (
        <View ref={detailCardRef} style={styles.detailCard}>
          <View style={styles.detailHeader}>
            <Sparkles size={20} color="#667eea" />
            <Text style={styles.detailTitle}>{activePersona.title}</Text>
          </View>

          <View style={styles.benefits}>
            {activePersona.benefits.map((b, i) => (
              <View key={i} style={styles.benefitRow}>
                <Check size={15} color="#667eea" />
                <Text style={styles.benefitText}>{b}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.fullText}>{activePersona.fullText}</Text>

          <TouchableOpacity
            style={styles.ctaBtn}
            onPress={() => navigation.navigate('AISettings')}
          >
            <Text style={styles.ctaBtnText}>Настроить AI под себя</Text>
            <ArrowRight size={18} color="white" />
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  content: { padding: 16, paddingBottom: 40 },
  pageHeader: { marginBottom: 20 },
  title: { fontSize: 20, fontWeight: '800', color: '#1a202c' },
  subtitle: { color: '#718096', marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  personaCard: {
    width: '47%',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 14,
    borderWidth: 2,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    gap: 8,
  },
  personaCardActive: { borderColor: '#667eea', backgroundColor: '#f0f4ff' },
  personaIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#f0f4ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  personaIconActive: { backgroundColor: '#667eea' },
  personaTitle: { fontSize: 13, fontWeight: '700', color: '#1a202c', textAlign: 'center' },
  personaTitleActive: { color: '#667eea' },
  personaDesc: { fontSize: 11, color: '#718096', textAlign: 'center' },
  personaDescActive: { color: '#4a5568' },
  detailCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  detailTitle: { fontSize: 17, fontWeight: '700', color: '#1a202c' },
  benefits: { gap: 10, marginBottom: 16 },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  benefitText: { flex: 1, fontSize: 14, color: '#4a5568', lineHeight: 20 },
  fullText: { fontSize: 14, color: '#718096', lineHeight: 20, marginBottom: 20, fontStyle: 'italic' },
  ctaBtn: {
    backgroundColor: '#667eea',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 10,
  },
  ctaBtnText: { color: 'white', fontWeight: '700', fontSize: 15 },
});
