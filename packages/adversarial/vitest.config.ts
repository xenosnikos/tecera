import { defineConfig } from 'vitest/config';
// One file at a time: the suite spawns sandbox children, verify process trees and whole scripted runs, and
// several cases scan /proc for leftover processes; parallel files would see each other's processes.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } });
