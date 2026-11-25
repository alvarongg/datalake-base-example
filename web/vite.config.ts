import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // amazon-cognito-identity-js espera `global` (Node); en el navegador es globalThis.
  define: { global: 'globalThis' },
  // El visor de código importa los archivos de backend/, infra/ y deplo.sh como texto:
  // en modo dev hay que permitir que Vite lea fuera de web/.
  server: { fs: { allow: [repoRoot] } },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Separa las librerías grandes para que el navegador las cachee por separado.
        manualChunks: {
          react: ['react', 'react-dom'],
          flow: ['@xyflow/react', '@dagrejs/dagre'],
          d3: ['d3'],
          heroui: ['@heroui/react'],
          code: ['prism-react-renderer'],
        },
      },
    },
  },
});
