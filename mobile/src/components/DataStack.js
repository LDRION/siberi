import { createNativeStackNavigator } from '@react-navigation/native-stack';
import RecordsScreen from '../screens/RecordsScreen';
import SchemasScreen from '../screens/SchemasScreen';

const Stack = createNativeStackNavigator();

export default function DataStack({ apiKey }) {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#667eea' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Stack.Screen name="SchemasList" options={{ title: 'Схемы данных' }}>
        {() => <SchemasScreen apiKey={apiKey} />}
      </Stack.Screen>
      <Stack.Screen
        name="Records"
        options={({ route }) => ({ title: route.params?.schema?.label || 'Записи' })}
      >
        {(props) => <RecordsScreen {...props} apiKey={apiKey} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
