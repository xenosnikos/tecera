import { defineConfig } from 'vitest/config';
// Gate tests drive real git in temp repos; WSL2 under parallel load needs more than the 5 s default.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000 } });
