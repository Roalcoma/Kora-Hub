import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': 'http://localhost:4300', '/ws': { target: 'ws://localhost:4300', ws: true } },
  },
  preview: { port: 5181, proxy: { '/api': 'http://localhost:4300' } },
});
