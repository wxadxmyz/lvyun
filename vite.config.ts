import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// 单入口：律云 App（music.html）
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: {
    rollupOptions: {
      input: {
        music: resolve(__dirname, 'music.html'),
      },
    },
  },
});
