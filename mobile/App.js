import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import TabNavigator from './src/components/TabNavigator';
import LoginScreen from './src/screens/LoginScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem('apiKey').then((key) => {
      if (key) setApiKey(key);
      setLoading(false);
    });
  }, []);

  const handleLogin = async (key) => {
    await AsyncStorage.setItem('apiKey', key);
    setApiKey(key);
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem('apiKey');
    setApiKey(null);
  };

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: '#f7fafc',
        }}
      >
        <ActivityIndicator size="large" color="#667eea" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {apiKey ? (
          <Stack.Screen name="Main">
            {() => <TabNavigator apiKey={apiKey} onLogout={handleLogout} />}
          </Stack.Screen>
        ) : (
          <Stack.Screen name="Login">{() => <LoginScreen onLogin={handleLogin} />}</Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
