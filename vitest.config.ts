import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lrs/shared': resolvePkg('./packages/shared/src/index.ts'),
      '@lrs/core-engine': resolvePkg('./packages/core-engine/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
  },
});
