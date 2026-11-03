import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'esnext',
    outDir: 'ui/build',
    emptyOutDir: true,
    lib: { entry: 'ui/src/main.tsx', formats: ['es'], fileName: () => 'app.js' },
  },
});
