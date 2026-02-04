import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/auth': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      },
      '/my': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      },
      '/ingest': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      },
      '/abilities': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      },
      '/analytics': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      }
    }
  }
});
