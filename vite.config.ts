import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in web/ and is built into dist/web, which the CLI serves
// as static files. base: './' keeps it working from any mount path.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:4477',
    },
  },
});
