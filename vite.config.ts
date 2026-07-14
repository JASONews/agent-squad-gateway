import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: 28773,
    proxy: {
      '/admin': 'http://127.0.0.1:28772',
      '/health': 'http://127.0.0.1:28772',
    },
  },
});
