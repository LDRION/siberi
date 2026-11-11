import { useNavigation } from '@react-navigation/native';
import { Bot, CreditCard, Globe, LogOut, Sparkles } from 'lucide-react-native';
import { Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function SettingsScreen({ apiKey, onLogout }) {
  const navigation = useNavigation();

  const menuItems = [
    {
      icon: Bot,
      label: 'Настройки AI',
      sub: 'Имя, инструкция, поведение',
      onPress: () => navigation.navigate('AISettings'),
    },
    {
      icon: Globe,
      label: 'Интеграции',
      sub: 'Telegram, виджет, полный чат',
      onPress: () => navigation.navigate('Integrations'),
    },
    {
      icon: CreditCard,
      label: 'Тариф',
      sub: 'Управление подпиской',
      onPress: () => navigation.navigate('Billing'),
    },
    {
      icon: Sparkles,
      label: 'Сценарии',
      sub: 'Кому пригодится Siberi.AI',
      onPress: () => navigation.navigate('Solutions'),
    },
  ];

  const handleLogout = () => {
    Alert.alert('Выйти из аккаунта', 'Вы уверены?', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Выйти', style: 'destructive', onPress: onLogout },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.accountCard}>
        <Text style={styles.accountLabel}>Ваш аккаунт</Text>
        <Text selectable style={styles.apiKeyText} numberOfLines={1}>
          {apiKey}
        </Text>
        <Text style={styles.hint}>Нажмите и удерживайте для копирования</Text>
      </View>

      <View style={styles.menu}>
        {menuItems.map((item, index) => (
          <TouchableOpacity
            key={index}
            style={[styles.menuItem, index < menuItems.length - 1 && styles.menuItemBorder]}
            onPress={item.onPress}
          >
            <View style={styles.menuIcon}>
              <item.icon size={20} color="#667eea" />
            </View>
            <View style={styles.menuText}>
              <Text style={styles.menuLabel}>{item.label}</Text>
              <Text style={styles.menuSub}>{item.sub}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <LogOut size={18} color="white" />
        <Text style={styles.logoutText}>Выйти из аккаунта</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  content: { padding: 16, paddingBottom: 40 },
  accountCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  accountLabel: { fontSize: 13, fontWeight: '600', color: '#718096', marginBottom: 8 },
  apiKeyText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    color: '#4a5568',
    backgroundColor: '#f7fafc',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  hint: { color: '#a0aec0', fontSize: 11, marginTop: 6 },
  menu: {
    backgroundColor: 'white',
    borderRadius: 12,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 14,
  },
  menuItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#f0f4ff',
  },
  menuIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#f0f4ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuText: { flex: 1 },
  menuLabel: { fontSize: 15, fontWeight: '600', color: '#1a202c' },
  menuSub: { fontSize: 12, color: '#a0aec0', marginTop: 2 },
  chevron: { fontSize: 22, color: '#cbd5e0', fontWeight: '300' },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
    backgroundColor: '#e53e3e',
    borderRadius: 12,
    shadowColor: '#e53e3e',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  logoutText: { color: 'white', fontWeight: '700', fontSize: 15 },
});
