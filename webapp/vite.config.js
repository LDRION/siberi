import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Мини-апп AiConstructor отдаётся nginx'ом с siberi.online/tg-app/ —
// base абсолютный, чтобы ассеты резолвились из подпапки.
export default defineConfig({
  plugins: [react()],
  base: '/tg-app/',
  server: {
    host: true,
    port: 5173,
  },
})
