import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',      // Replit: allow external connections
    port: 5000,           // Replit: required for web preview
    allowedHosts: true,   // Replit: bypass host header verification
    proxy: {
      '/get-token': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api': {           // Replit: forward all /api/* calls to Express
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
