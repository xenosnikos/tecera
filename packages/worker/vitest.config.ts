import { defineConfig } from 'vitest/config';
// One file at a time: sandbox and verify tests spawn process trees under one shared unprivileged uid and scan
// for leftovers; parallel files see and kill each other's processes.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', fileParallelism: false } });
