import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180 },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
