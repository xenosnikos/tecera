import { defineConfig } from 'vitest/config';
// One file at a time: scenarios spawn whole runs and verify process trees.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false } });
