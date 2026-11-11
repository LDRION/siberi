import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AISettingsScreen from '../screens/AISettingsScreen';
import BillingScreen from '../screens/BillingScreen';
import IntegrationsScreen from '../screens/IntegrationsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import SolutionsScreen from '../screens/SolutionsScreen';

const Stack = createNativeStackNavigator();

export default function SettingsStack({ apiKey, onLogout }) {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#667eea' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Stack.Screen name="SettingsHub" options={{ title: 'Настройки' }}>
        {() => <SettingsScreen apiKey={apiKey} onLogout={onLogout} />}
      </Stack.Screen>
      <Stack.Screen name="AISettings" options={{ title: 'Настройки AI' }}>
        {() => <AISettingsScreen apiKey={apiKey} />}
      </Stack.Screen>
      <Stack.Screen name="Integrations" options={{ title: 'Интеграции' }}>
        {() => <IntegrationsScreen apiKey={apiKey} />}
      </Stack.Screen>
      <Stack.Screen name="Billing" options={{ title: 'Подписка' }}>
        {() => <BillingScreen apiKey={apiKey} />}
      </Stack.Screen>
      <Stack.Screen name="Solutions" options={{ title: 'Сценарии использования' }}>
        {() => <SolutionsScreen />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
