import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { CreditCard, Database, LayoutDashboard, MessageSquare, Settings } from 'lucide-react-native';
import BillingScreen from '../screens/BillingScreen';
import ChatScreen from '../screens/ChatScreen';
import DashboardScreen from '../screens/DashboardScreen';
import DataStack from './DataStack';
import SettingsStack from './SettingsStack';

const Tab = createBottomTabNavigator();

export default function TabNavigator({ apiKey, onLogout }) {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'white',
          borderTopColor: '#e2e8f0',
          paddingBottom: 5,
          height: 60,
        },
        tabBarActiveTintColor: '#667eea',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tab.Screen
        name="Dashboard"
        options={{
          tabBarLabel: 'Главная',
          tabBarIcon: ({ color, size }) => <LayoutDashboard color={color} size={size} />,
        }}
      >
        {() => <DashboardScreen apiKey={apiKey} onLogout={onLogout} />}
      </Tab.Screen>

      <Tab.Screen
        name="Chat"
        options={{
          tabBarLabel: 'Чат',
          tabBarIcon: ({ color, size }) => <MessageSquare color={color} size={size} />,
        }}
      >
        {() => <ChatScreen apiKey={apiKey} />}
      </Tab.Screen>

      <Tab.Screen
        name="Data"
        options={{
          tabBarLabel: 'Данные',
          tabBarIcon: ({ color, size }) => <Database color={color} size={size} />,
        }}
      >
        {() => <DataStack apiKey={apiKey} />}
      </Tab.Screen>

      <Tab.Screen
        name="Billing"
        options={{
          tabBarLabel: 'Тариф',
          tabBarIcon: ({ color, size }) => <CreditCard color={color} size={size} />,
        }}
      >
        {() => <BillingScreen apiKey={apiKey} />}
      </Tab.Screen>

      <Tab.Screen
        name="Settings"
        options={{
          tabBarLabel: 'Ещё',
          tabBarIcon: ({ color, size }) => <Settings color={color} size={size} />,
        }}
      >
        {() => <SettingsStack apiKey={apiKey} onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}
