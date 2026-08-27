import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.WEB_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': apiTarget, '/auth': apiTarget, '/events': apiTarget } },
  preview: { host: '0.0.0.0', port: 4173, proxy: { '/api': apiTarget, '/auth': apiTarget, '/events': apiTarget } }
});
