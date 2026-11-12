import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'esnext',
    outDir: 'dist/frontend',
    emptyOutDir: true,
    lib: { entry: 'src/frontend/main.tsx', formats: ['es'], fileName: () => 'app.js' },
  },
});
