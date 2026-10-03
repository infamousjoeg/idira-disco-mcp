import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The process entry point only wires config, listen and signals together.
      exclude: ['src/index.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
});
