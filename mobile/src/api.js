import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

export const API_URL = 'https://siberi.online/api/v1';

const api = axios.create({
  baseURL: API_URL,
  timeout: 90000,
});

api.interceptors.request.use(async (config) => {
  const key = await AsyncStorage.getItem('apiKey');
  if (key) config.headers.Authorization = `Bearer ${key}`;
  return config;
});

export default api;
