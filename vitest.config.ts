import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@flock/crdt': src('./packages/crdt/src/index.ts'),
      '@flock/sync': src('./packages/sync/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    pool: 'threads',
    maxWorkers: 4,
  },
});
