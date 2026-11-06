import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@asm\/shared$/, replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
      { find: /^@asm\/shared\/excel$/, replacement: fileURLToPath(new URL('../../packages/shared/src/excelRead.ts', import.meta.url)) },
    ],
  },
  build: {
    sourcemap: false,
    outDir: 'dist',
  },
  server: { port: 5173 },
});
