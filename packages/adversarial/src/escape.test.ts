import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RESERVED_BINDINGS, type CapabilitySet, type ToolRequest } from '@tecera/contracts';
import { buildChildProfile, createReadTool, detectIsolation, parseProgram, resolveIsolation } from '@tecera/worker';
import { execReq, FILES, recorder, replRig, SANDBOX } from './harness/sandbox.js';
import { cleanupTemps, PACKAGES, tmp } from './harness/tmp.js';

/**
 * security.md §6 escape.*: hostile generated code against the REAL sandbox child (ChildProcessRepl: vm
 * realm inside a `--permission` node with code generation off, frozen intrinsics, proto throw). The
 * "harness bug" cases spawn the exact child profile (buildChildProfile/resolveIsolation, same flags, env
 * and OS wrappers) with a script that HAS `process`, to prove the OS/runtime layer holds on its own.
 */

afterAll(cleanupTemps);

async function run(code: string) {
  const rig = replRig();
  const rec = recorder();
  const r = await rig.repl.exec(execReq(code), rec.bridge);
  return { r, rec, rig };
}

/** Spawn the real child profile with our own entry script (a harness bug that leaked `process`). */
async function leakedChild(script: string): Promise<{ out: Record<string, string>; stderr: string; isolation: ReturnType<typeof resolveIsolation> }> {
  const scratch = tmp('tecera-adv-leak-');
  chmodSync(scratch, 0o711);
  const childDir = join(scratch, 'child');
  const homeDir = join(scratch, 'home');
  mkdirSync(childDir, { mode: 0o755 });
  mkdirSync(homeDir, { mode: 0o777 });
  chmodSync(homeDir, 0o777);
  const isolation = resolveIsolation(SANDBOX);
  const profile = buildChildProfile(SANDBOX, scratch, isolation);
  writeFileSync(profile.entryPath, script, { mode: 0o644 });
  const child = spawn(profile.command, profile.args, { ...profile.spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  await new Promise<void>((res) => child.on('close', () => res()));
  clearTimeout(timer);
  let out: Record<string, string> = {};
  try {
    out = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
  } catch {
    throw new Error(`leaked child produced no report: stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`);
  }
  return { out, stderr, isolation };
}

const codeOf = (e: string) => `(e) => (e && (e.code || e.name)) || String(e)`;

describe('escape (security.md §6)', () => {
  it('escape.function_ctor', async () => {
    const vectors = [
      "fs.constructor.constructor('return process')()",
      "fs.read.constructor('return process')()",
      "invoke.constructor('return process')()",
      "console.log.constructor('return process')()",
      "(async () => {}).constructor('return process')()",
      "(function* () {}).constructor('return process')()",
      "(async function* () {}).constructor('return process')()",
      "(await fs.read('a')).constructor.constructor('return process')()",
      "Object.getPrototypeOf(fs.read).constructor('return process')()",
      "[].map.constructor('return process')()",
      "__history__.len.constructor('return process')()",
    ];
    for (const v of vectors) {
      const { r } = await run(`const p = ${v}; return typeof p === 'object' && p !== null ? Object.keys(p).slice(0, 3) : String(p)`);
      expect(r.kind, v).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name, v).toBe('EvalError');
      expect(JSON.stringify(r), v).not.toMatch(/"(env|argv|pid|versions)"/);
    }
    // the parser rejects the spelling before it reaches a child (defence in depth)
    expect(parseProgram("```js\nreturn fs.constructor.constructor('return process')()\n```").ok).toBe(false);
    expect(parseProgram("```js\nreturn fs['constructor']['constructor']('return process')()\n```").ok).toBe(false);
  });

  it('escape.eval', async () => {
    for (const code of [
      "return eval('1')",
      "return (0, eval)('1')",
      "return globalThis.eval('1')",
      "return new Function('return 1')()",
      "return Reflect.construct(Function, ['return 1'])()",
      "return Function.prototype.constructor('return 1')()",
    ]) {
      const { r } = await run(code);
      expect(r.kind, code).toBe('raise');
      if (r.kind === 'raise') expect(r.exception.name, code).toBe('EvalError');
    }
    // WebAssembly code generation is closed too (absent or refuses to compile)
    const { r: w } = await run('return typeof WebAssembly === "object" ? await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => "compiled", (e) => "refused:" + e.name) : "absent"');
    expect(w.kind === 'raise' || (w.kind === 'return' && w.value !== 'compiled')).toBe(true);
  });

  it('escape.require_import', async () => {
    for (const src of ["return require('fs')", "const m = await import('node:fs'); return 1", "return import.meta.url"]) {
      const p = parseProgram('```js\n' + src + '\n```');
      expect(p.ok, src).toBe(false);
    }
    const r1 = (await run("return require('fs')")).r;
    expect(r1.kind).toBe('raise');
    if (r1.kind === 'raise') expect(r1.exception.name).toBe('ReferenceError');
    const r2 = (await run("const m = await import('node:child_process'); return typeof m.spawn")).r;
    expect(r2.kind).toBe('raise');
    const r3 = (await run("const m = await import('data:text/javascript,export default 1'); return m.default")).r;
    expect(r3.kind).toBe('raise');
    const r4 = (await run('return [typeof module, typeof exports, typeof __filename, typeof __dirname, typeof globalThis.require]')).r;
    expect(r4).toMatchObject({ kind: 'return', value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
  });

  it('escape.proto', async () => {
    const { r } = await run('const o = {}; o.__proto__ = { polluted: true }; return o.polluted');
    expect(r.kind).toBe('raise');
    if (r.kind === 'raise') expect(r.exception.message).toMatch(/__proto__/);
    for (const code of [
      "const o = {}; o['__pro' + 'to__'] = { polluted: true }; return o.polluted",
      "return ({}).__proto__",
      "const o = JSON.parse('{\"__proto__\": {\"polluted\": 1}}'); return Object.getPrototypeOf(o).polluted",
    ]) {
      const x = (await run(code)).r;
      expect(x.kind === 'raise' || (x.kind === 'return' && (x.value === null || x.value === undefined)), code).toBe(true);
    }
    // the realm's own prototypes may be scribbled on, but that never survives the exec (fresh process each time)
    const rig = replRig();
    const rec = recorder();
    await rig.repl.exec(execReq("Object.prototype.polluted = 'yes'; return 1"), rec.bridge);
    const next = await rig.repl.exec(execReq('return [({}).polluted === undefined, typeof Object.prototype.polluted]'), rec.bridge);
    expect(next).toMatchObject({ kind: 'return', value: [true, 'undefined'] });
    // nothing reached the supervisor's realm
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('escape.child_process_via_leak', async () => {
    const { out, stderr } = await leakedChild(`
      const out = {};
      const code = ${codeOf('')};
      const cp = await import('node:child_process');
      try { const r = cp.spawnSync('/bin/sh', ['-c', 'echo pwned']); out.spawnSync = r.error ? code(r.error) : 'ran:' + String(r.stdout).trim(); } catch (e) { out.spawnSync = code(e); }
      try { cp.execSync('id'); out.execSync = 'ran'; } catch (e) { out.execSync = code(e); }
      try { const c = cp.spawn('/bin/sh', ['-c', 'echo pwned']); await new Promise((res, rej) => { c.on('error', rej); c.on('exit', res); }); out.spawn = 'ran'; } catch (e) { out.spawn = code(e); }
      try { const c = cp.fork('/bin/true'); out.fork = 'ran'; c.kill(); } catch (e) { out.fork = code(e); }
      try { const { Worker } = await import('node:worker_threads'); new Worker('1', { eval: true }); out.worker = 'ran'; } catch (e) { out.worker = code(e); }
      try { process.binding('spawn_sync'); out.binding = 'ran'; } catch (e) { out.binding = code(e); }
      try { process.dlopen({ exports: {} }, '/lib/x86_64-linux-gnu/libc.so.6'); out.dlopen = 'ran'; } catch (e) { out.dlopen = code(e); }
      process.stdout.write(JSON.stringify(out) + '\\n');
    `);
    expect(out, stderr).toMatchObject({ spawnSync: 'ERR_ACCESS_DENIED', execSync: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', fork: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED' });
    expect(out.binding).not.toBe('ran');
    expect(out.dlopen).not.toBe('ran');
  });

  it('escape.fs_read_outside', async () => {
    // 1. inside the realm there is no fs, process or Buffer at all
    const { r } = await run(
      'return [typeof process, typeof Buffer, Object.getOwnPropertyNames(globalThis).filter((n) => ["process", "require", "Buffer", "fs", "module", "global"].includes(n))]',
    );
    expect(r).toMatchObject({ kind: 'return', value: ['undefined', 'undefined', []] });
    // 2. a leaked `process` still cannot read outside the entry dir (--permission --allow-fs-read=<child dir>)
    const secretFile = join(PACKAGES, 'adversarial', 'package.json');
    const { out } = await leakedChild(`
      import fs from 'node:fs';
      const out = {};
      const code = ${codeOf('')};
      for (const [k, p] of [['passwd', '/etc/passwd'], ['repo', ${JSON.stringify(secretFile)}], ['proc', '/proc/self/environ'], ['home', '/root/.ssh/id_rsa']]) {
        try { fs.readFileSync(p); out[k] = 'read'; } catch (e) { out[k] = code(e); }
      }
      try { fs.writeFileSync('/tmp/tecera-adv-escape-probe', 'x'); out.write = 'wrote'; } catch (e) { out.write = code(e); }
      process.stdout.write(JSON.stringify(out) + '\\n');
    `);
    expect(out).toMatchObject({ passwd: 'ERR_ACCESS_DENIED', repo: 'ERR_ACCESS_DENIED', proc: 'ERR_ACCESS_DENIED', home: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED' });
    // 3. the read tool (the only file path the program has) refuses traversal and absolute paths
    const wt = tmp('tecera-adv-wt-');
    mkdirSync(join(wt, 'src'));
    writeFileSync(join(wt, 'src/a.ts'), 'x');
    const read = createReadTool();
    const caps: CapabilitySet = { tools: ['read'], paths: { read: ['**'], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } };
    for (const p of ['/etc/passwd', '../../../../etc/passwd', 'src/../../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', 'src/a.ts\u0000/etc/passwd']) {
      const req: ToolRequest = { callId: 'c1', tool: 'read', method: 'call', args: [p], idemKey: 'k' };
      const res = await read.call(req, { runId: 'r', worktree: wt, capabilities: caps });
      expect(res.ok, p).toBe(false);
      expect(JSON.stringify(res.value ?? null), p).not.toMatch(/root:x:0:0/);
    }
  });

  it('escape.network', async () => {
    // in the realm: no network primitive exists
    const { r } = await run('return [typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof navigator, typeof EventSource, typeof Request]');
    expect(r).toMatchObject({ kind: 'return', value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
    // with a leaked process: a loopback server of the supervisor must be unreachable (fresh netns), or
    // the run must carry isolation.degraded evidence naming the missing control.
    const server: Server = createServer((s) => s.end('hello'));
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as { port: number }).port;
    try {
      const { out, isolation } = await leakedChild(`
        import net from 'node:net';
        const out = {};
        out.connect = await new Promise((res) => {
          const s = net.connect(${port}, '127.0.0.1');
          const t = setTimeout(() => { s.destroy(); res('timeout'); }, 3000);
          s.on('connect', () => { clearTimeout(t); s.destroy(); res('connected'); });
          s.on('error', (e) => { clearTimeout(t); res(e.code || e.name); });
        });
        try { const r = await fetch('http://127.0.0.1:${port}/'); out.fetch = 'status:' + r.status; } catch (e) { out.fetch = (e.cause && e.cause.code) || e.name; }
        process.stdout.write(JSON.stringify(out) + '\\n');
      `);
      expect(typeof out.connect).toBe('string');
      if (isolation.applied.includes('netns')) {
        expect(out.connect).not.toBe('connected');
        expect(out.fetch).not.toMatch(/^status:/);
      } else {
        // no network namespace on this host: the REPL must record degraded isolation naming it
        const rig = replRig();
        await rig.repl.exec(execReq('return 1'), recorder().bridge);
        const deg = rig.evidence.find((e) => e.kind === 'isolation.degraded');
        expect(deg).toBeTruthy();
        expect(JSON.stringify(deg)).toMatch(/netns/);
      }
    } finally {
      server.close();
    }
  });

  it('escape.network [no-netns branch, forced]: a probe without netns records isolation.degraded naming netns', async () => {
    const real = detectIsolation();
    // no-netns branch (forced by the injected probe, whatever this host has)
    const noNet = replRig({ probe: { ...real, netns: null } });
    const r1 = await noNet.repl.exec(execReq('return 1'), recorder().bridge);
    expect(r1).toMatchObject({ kind: 'return', value: 1 });
    expect(resolveIsolation(SANDBOX, { ...real, netns: null }).applied).not.toContain('netns');
    const deg = noNet.evidence.filter((e) => e.kind === 'isolation.degraded');
    expect(deg.length, JSON.stringify(noNet.evidence)).toBeGreaterThan(0);
    expect(deg.flatMap((e) => ((e as { body?: { missing?: string[] } }).body?.missing ?? []))).toContain('netns');
  });

  // explicit environment skip (reported by vitest as skipped), never a silent omission
  it.skipIf(!detectIsolation().netns)('escape.network [netns branch, host-dependent]: with a network namespace the realm child applies netns and records no netns gap', async () => {
    const real = detectIsolation();
    expect(resolveIsolation(SANDBOX, real).applied).toContain('netns');
    const withNet = replRig({ probe: real });
    const r2 = await withNet.repl.exec(execReq('return 2'), recorder().bridge);
    expect(r2).toMatchObject({ kind: 'return', value: 2 });
    const missing = withNet.evidence.filter((e) => e.kind === 'isolation.degraded').flatMap((e) => ((e as { body?: { missing?: string[] } }).body?.missing ?? []));
    expect(missing).not.toContain('netns');
  });

  it('escape (reserved bindings): generated code cannot rebind __history__/__depth__/__capabilities__', async () => {
    for (const name of RESERVED_BINDINGS) {
      expect(parseProgram('```js\n' + `${name} = 1; return 1` + '\n```').ok, name).toBe(false);
    }
    // the isolation actually applied on this host is recorded truthfully
    const probe = detectIsolation();
    const iso = resolveIsolation(SANDBOX, probe);
    expect(iso.mode).toBe('node');
    expect(iso.degraded?.missing).toEqual((['netns', 'cgroup', 'uid'] as const).filter((c) => !(c === 'netns' ? probe.netns : c === 'cgroup' ? probe.systemdRun : probe.uidDrop)));
    void FILES;
  });
});
