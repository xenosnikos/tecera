import { defineConfig } from 'vitest/config';
// One file at a time: these suites run whole scripted runs whose verification executes under one shared
// unprivileged uid, and containment kills processes on that uid it does not own; parallel files kill each other.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false } });
