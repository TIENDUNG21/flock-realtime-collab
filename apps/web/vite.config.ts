import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@flock/crdt': here('../../packages/crdt/src/index.ts'),
      '@flock/sync': here('../../packages/sync/src/index.ts'),
    },
  },
  server: { port: 5135, strictPort: true },
  preview: { port: 5136, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: here('index.html'),
      },
    },
  },
});
