/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs separately on 3001; proxying keeps the browser on one origin (no CORS setup).
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  test: {
    environment: 'node',
  },
});
