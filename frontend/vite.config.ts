import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/termag/',
  server: {
    port: 5174,
    proxy: {
      '/termag/auth': 'http://localhost:3040',
      '/termag/api': 'http://localhost:3040',
      '/termag/ws': {
        target: 'ws://localhost:3040',
        ws: true,
      },
      '/termag/health': 'http://localhost:3040',
    },
  },
});
