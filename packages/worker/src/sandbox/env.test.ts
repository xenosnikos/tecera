import { describe, expect, it } from 'vitest';
import { EnvRefused, SANDBOX_SAFE_ENV, assertEnvAllowlist, isDeniedEnvName, scrubEnv } from './env.js';

describe('env construction: allowlist ∩ SANDBOX_SAFE_ENV, dangerous names refused', () => {
  it('copies only names that are both allowlisted and in SANDBOX_SAFE_ENV; others are dropped by name', () => {
    const src = { PATH: '/bin', CI: '1', HOME: '/h', TERM: 'xterm', OTHER: 'o', TECERA_CANARY_X: 'c', EDITOR: 'vi' };
    const { env, dropped } = scrubEnv(['PATH', 'CI', 'OTHER', 'TECERA_CANARY_X', 'EDITOR', 'MISSING', 'TERM'], src, { LANG: 'C.UTF-8' });
    expect(env).toEqual({ PATH: '/bin', CI: '1', TERM: 'xterm', LANG: 'C.UTF-8' });
    expect(dropped.sort()).toEqual(['EDITOR', 'MISSING', 'OTHER', 'TECERA_CANARY_X']);
    expect(SANDBOX_SAFE_ENV).toEqual(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'TERM', 'NO_COLOR']);
  });

  it('dangerous env names are refused with an error even when allowlisted', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'GIT_CREDENTIALS', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'bad-name']) {
      expect(isDeniedEnvName(name), name).toBe(true);
      expect(() => scrubEnv(['PATH', name], { PATH: '/bin', [name]: 'value' }), name).toThrow(EnvRefused);
      expect(() => assertEnvAllowlist([name]), name).toThrow(EnvRefused);
    }
    try {
      scrubEnv(['PATH', 'OPENAI_API_KEY'], { OPENAI_API_KEY: 'sk-secret-value-123456789' });
    } catch (e) {
      expect(e).toBeInstanceOf(EnvRefused);
      expect((e as EnvRefused).names).toEqual(['OPENAI_API_KEY']);
      expect((e as Error).message).not.toContain('sk-secret');
    }
    for (const n of ['PATH', 'CI', 'LANG', 'NO_COLOR', 'TERM']) expect(isDeniedEnvName(n)).toBe(false);
  });

  it('a safe name whose value carries a secret pattern is refused; forced names must be safe', () => {
    expect(() => scrubEnv(['TERM'], { TERM: 'xterm-TECERA_CANARY_TERMVALUE' })).toThrow(EnvRefused);
    expect(() => scrubEnv(['PATH'], { PATH: '/bin' }, { FOO: 'x' })).toThrow(EnvRefused);
  });
});
