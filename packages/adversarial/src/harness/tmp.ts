import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Temp space and repository paths for the adversarial suite. Every file the suite writes lives under
 * os.tmpdir() (ext4 on WSL2), never under the repository (which sits on DrvFs).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** Monorepo root (src/harness and dist/harness are both three levels below packages/). */
export const REPO = resolve(HERE, '../../../..');
export const PACKAGES = join(REPO, 'packages');
export const SAMPLE = join(REPO, 'samples/fix-failing-test');
export const RUNTIME_FIXTURES = join(PACKAGES, 'runtime/test-fixtures/fix-failing-test');

const temps: string[] = [];

export function tmp(prefix = 'tecera-adv-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

export function cleanupTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** True when a path lives on a Windows mount (DrvFs): symlink, mode and nlink fidelity are unreliable there. */
export function onDrvFs(p: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(resolve(p));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
