import AsyncStorage from '@react-native-async-storage/async-storage';

export const saveApiKey = (key) => AsyncStorage.setItem('apiKey', key);
export const getApiKey = () => AsyncStorage.getItem('apiKey');
export const clearApiKey = () => AsyncStorage.removeItem('apiKey');
