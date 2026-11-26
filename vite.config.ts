import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || './',
  server: {port: 4173},
  // Versão publicada (commit curto) exibida no rodapé, para conferir qual build está no ar.
  define: { __BUILD_VERSION__: JSON.stringify((process.env.GITHUB_SHA || 'local').slice(0, 7)) },
});
