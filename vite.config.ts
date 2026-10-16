import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH: '/evenly/' for GitHub Pages (richlovegod.github.io/evenly/), '/' for a custom domain.
// VITE_API_BASE: the Worker URL the built app talks to (see src/web/config.ts).
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: ['es2020', 'safari15'],
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
