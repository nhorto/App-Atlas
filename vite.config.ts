import { copyFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite only emits files something imports, and nothing imports a license. The
// woff2 files would otherwise ship in the tarball on their own, which SIL OFL
// 1.1 §2 does not allow: every copy of the font must carry the license with it.
function ofl() {
  return {
    name: 'ofl-license',
    closeBundle() {
      copyFileSync(
        new URL('web/src/fonts/OFL.txt', import.meta.url),
        new URL('dist/web/OFL.txt', import.meta.url),
      );
    },
  };
}

// The web app lives in web/ and is built into dist/web, which the CLI serves
// as static files. base: './' keeps it working from any mount path.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react(), ofl()],
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
