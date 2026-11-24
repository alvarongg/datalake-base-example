import { defineConfig } from 'vite';

// amazon-cognito-identity-js espera `global` (Node); en el navegador es globalThis.
export default defineConfig({
  define: { global: 'globalThis' },
  build: { outDir: 'dist', sourcemap: false },
});
