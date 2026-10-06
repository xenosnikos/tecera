import { matchesAny } from './glob.js';
import type { Change } from './diffBoundary.js';

/**
 * Gate tamper checks (Builderlync verify-be.sh + security.md §5): never weaken the gate to pass it.
 * Findings are returned, never silently fixed; the caller fails the gate on any finding.
 */

export interface Hunk {
  path: string;
  added: string[];
}

export interface TamperOptions {
  testGlobs: readonly string[];
  configGlobs: readonly string[];
  /** When true (fix-failing-test goals), tests are read-only inputs: any modification is tampering. */
  testsReadOnly: boolean;
  maxFileBytes?: number;
}

export interface Finding {
  code: 'deleted-test' | 'modified-test' | 'focus-or-skip' | 'config-edit' | 'scripts-edit' | 'symlink' | 'mode-change' | 'binary' | 'large-file' | 'hooks-dir' | 'ignored-file';
  path: string;
  detail: string;
}

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/tests/**', '**/__tests__/**', '**/test/**'];
export const DEFAULT_CONFIG_GLOBS = [
  'vitest.config.*',
  'jest.config.*',
  'eslint.config.*',
  '.eslintrc*',
  'tsconfig*.json',
  '.github/**',
  '.husky/**',
  '.gitattributes',
  '.gitmodules',
  '.git/**',
  '.yarn/**',
  '.yarnrc.yml',
  '.pnp.*',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '.nvmrc',
  'tecera.json',
  '.tecera/**',
  'CLAUDE.md',
  'AGENTS.md',
  '.claude/**',
];

const FOCUS_RE = /\b(it|test|describe)\.(only|skip|todo)\b|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/;

export function tamperFindings(changes: readonly Change[], hunks: readonly Hunk[], opts: TamperOptions): Finding[] {
  const f: Finding[] = [];
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  for (const c of changes) {
    const isTest = matchesAny(c.path, opts.testGlobs) !== null;
    if (isTest && c.status === 'D') f.push({ code: 'deleted-test', path: c.path, detail: 'diff deletes a test file' });
    else if (isTest && opts.testsReadOnly && c.status !== 'A') f.push({ code: 'modified-test', path: c.path, detail: 'tests are read-only for this goal' });
    if (matchesAny(c.path, opts.configGlobs)) f.push({ code: 'config-edit', path: c.path, detail: 'gate or toolchain configuration changed' });
    if (c.path.startsWith('.git/') || c.path.startsWith('.husky/')) f.push({ code: 'hooks-dir', path: c.path, detail: 'git hooks directory touched' });
    if (c.symlink) f.push({ code: 'symlink', path: c.path, detail: 'new or changed symlink' });
    if (c.modeChanged) f.push({ code: 'mode-change', path: c.path, detail: 'file mode changed' });
    if (c.binary) f.push({ code: 'binary', path: c.path, detail: 'binary content' });
    if (c.bytes !== undefined && c.bytes > maxBytes) f.push({ code: 'large-file', path: c.path, detail: `${c.bytes} bytes` });
    if (c.status === '!') f.push({ code: 'ignored-file', path: c.path, detail: 'ignored file changed' });
  }
  for (const h of hunks) {
    for (const line of h.added) {
      if (FOCUS_RE.test(line)) f.push({ code: 'focus-or-skip', path: h.path, detail: line.trim().slice(0, 120) });
    }
    if (h.path.endsWith('package.json') && h.added.some((l) => /"scripts"\s*:/.test(l) || /^\s*"(test|pretest|posttest|prepare|postinstall|preinstall)"\s*:/.test(l))) {
      f.push({ code: 'scripts-edit', path: h.path, detail: 'package.json scripts changed' });
    }
  }
  return f;
}
