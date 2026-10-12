import { createServer, type Server } from 'node:http';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySet, Json, JsonObject, ProvisionedResource, ToolContext, ToolRequest } from '@tecera/contracts';
import { Broker } from '../broker/broker.js';
import { FakeLLM, FakeWriteGuard, liveWriteGuard } from '../invoke/fakes.js';
import { invoke, type ReplFactory } from '../invoke/invoke.js';
import { ChildProcessRepl } from '../sandbox/host.js';
import { createHttpResourceTool, createSqliteResourceTool, resourceTools, ResourceToolError } from './tools.js';

/**
 * Provisioned resources reach a worker only as brokered tools scoped to the resource's locator (owner
 * decision D10, local provisioning): a provisioned sqlite file and a loopback HTTP stub. Statements and
 * paths that would leave the locator are refused; the sandbox child itself has no file or network access.
 */

const NOW = 1_800_000_000_000;
const resource = (over: Partial<ProvisionedResource>): ProvisionedResource => ({ id: 'res_1', capability: 'sessions_db', kind: 'sqlite', provider: 'local', locator: '/nonexistent', teardown: 'rm -f /nonexistent', createdAt: NOW - 1000, expiresAt: NOW + 3_600_000, transfer: 'pending', ...over });
const req = (method: string, ...args: Json[]): ToolRequest => ({ callId: 'c', tool: 't', method, args, idemKey: '' });
const ctx: ToolContext = { runId: 'r', worktree: '', capabilities: { tools: [], paths: { read: [], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 1, calls: 1, wallMs: 1, depth: 1, iterations: 1 } } };
const now = () => NOW;

let dir: string;
let db: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tecera-res-'));
  db = join(dir, 'store.sqlite');
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x');");
  d.close();
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('sqlite resource tool', () => {
  const tool = (over: Partial<ProvisionedResource> = {}) => createSqliteResourceTool(resource({ locator: db, teardown: `rm -f ${db}`, ...over }), { now });

  it('query and run work against the provisioned file only', async () => {
    const t = tool();
    expect(t.name).toBe('sessions_db');
    expect((await t.call(req('run', 'INSERT INTO t (v) VALUES (?)', ['y']), ctx, liveWriteGuard())).value).toEqual({ changes: 1, lastInsertRowid: 2 });
    const r = await t.call(req('query', 'SELECT v FROM t ORDER BY id', []), ctx, liveWriteGuard());
    expect(r.value).toEqual({ rows: [{ v: 'x' }, { v: 'y' }], truncated: false });
    expect(r.provenance).toEqual({ src: 'resource:res_1', trust: 'untrusted' });
  });

  for (const [label, sql] of [
    ['ATTACH another file', `ATTACH DATABASE '${'OUT'}' AS e`],
    ['attach in lower case after a comment', `/* hi */ attach database 'OUT' as e`],
    ['VACUUM INTO a file', `VACUUM INTO 'OUT'`],
    ['a PRAGMA', 'PRAGMA writable_schema = 1'],
    ['an extension load', "SELECT load_extension('OUT')"],
    ['two statements', "SELECT 1; DROP TABLE t"],
  ] as const) {
    it(`refuses ${label}: nothing outside the locator is created, the database is unchanged`, async () => {
      const out = join(dir, 'escape.sqlite');
      const r = await tool().call(req(label.startsWith('a PRAGMA') || label.startsWith('two') ? 'run' : 'query', sql.replace('OUT', out)), ctx, liveWriteGuard());
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe('ResourceToolError');
      expect(existsSync(out)).toBe(false);
      expect((await tool().call(req('query', 'SELECT count(*) AS n FROM t'), ctx, liveWriteGuard())).value).toEqual({ rows: [{ n: 1 }], truncated: false });
    });
  }

  it('refuses an expired resource, a symlinked locator, a lost write guard and non-scalar params', async () => {
    expect((await tool({ expiresAt: NOW - 1, createdAt: NOW - 10 }).call(req('query', 'SELECT 1'), ctx, liveWriteGuard())).error?.message).toMatch(/expired/);
    const link = join(dir, 'link.sqlite');
    symlinkSync(db, link);
    expect((await tool({ locator: link }).call(req('query', 'SELECT 1'), ctx, liveWriteGuard())).error?.message).toMatch(/not a regular file/);
    const g = new FakeWriteGuard();
    g.revoke('exec stopped');
    expect((await tool().call(req('run', "INSERT INTO t (v) VALUES ('z')"), ctx, g.guard)).error?.name).toBe('FenceLost');
    expect((await tool().call(req('query', 'SELECT ?', [{ a: 1 } as unknown as Json]), ctx, liveWriteGuard())).error?.message).toMatch(/params must be/);
    expect((await tool().call(req('query', 'SELECT count(*) AS n FROM t'), ctx, liveWriteGuard())).value).toEqual({ rows: [{ n: 1 }], truncated: false });
  });

  it('a resource that is not recordable (relative locator, credential in the locator, wrong kind) gets no tool', () => {
    expect(() => createSqliteResourceTool(resource({ locator: 'file:///tmp/x.db?password=hunter2' }))).toThrow(ResourceToolError);
    expect(() => createSqliteResourceTool(resource({ locator: db, transfer: 'released' }))).toThrow(/not pending/);
    expect(() => createSqliteResourceTool(resource({ locator: db, kind: 'tmpdir' }))).toThrow(/not sqlite/);
    expect(() => resourceTools([resource({ locator: db, kind: 'git-remote' })])).toThrow(/has no worker tool/);
  });
});

describe('http-stub resource tool', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => (body += c));
      rq.on('end', () => {
        if (rq.url === '/api/hello') return rs.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}');
        if (rq.url === '/api/items' && rq.method === 'POST') return rs.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ got: JSON.parse(body), auth: rq.headers.authorization ?? null }));
        if (rq.url === '/api/redirect') return rs.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
        if (rq.url === '/secret') return rs.writeHead(200).end('OUTSIDE-THE-RESOURCE');
        rs.writeHead(404).end('nope');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));
  const tool = (over: Partial<ProvisionedResource> = {}) => createHttpResourceTool(resource({ id: 'res_http', capability: 'stub_api', kind: 'http-stub', locator: `http://127.0.0.1:${port}/api`, teardown: 'kill %1', ...over }), { now });

  it('get and post reach paths under the locator; the program sets no headers', async () => {
    const t = tool();
    expect((await t.call(req('get', 'hello'), ctx, liveWriteGuard())).value).toEqual({ status: 200, contentType: 'application/json', body: '{"hello":"world"}' });
    const p = await t.call(req('post', '/items', { a: 1 }), ctx, liveWriteGuard());
    expect(p.value).toMatchObject({ status: 201 });
    expect(JSON.parse((p.value as JsonObject).body as string)).toEqual({ got: { a: 1 }, auth: null });
  });

  for (const path of ['../secret', '/../secret', 'a/../../secret', '%2e%2e/secret', '..%2fsecret', '//evil.example/x', 'http://127.0.0.1/secret', 'javascript:alert(1)', 'u@evil.example', '..\\secret', 'a\nb']) {
    it(`a path that would leave the resource is refused: ${JSON.stringify(path)}`, async () => {
      const r = await tool().call(req('get', path), ctx, liveWriteGuard());
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/OUTSIDE-THE-RESOURCE/);
    });
  }

  it('redirects are never followed', async () => {
    const r = await tool().call(req('get', 'redirect'), ctx, liveWriteGuard());
    expect(r.value).toMatchObject({ status: 302, body: '' });
    expect(JSON.stringify(r)).not.toMatch(/OUTSIDE-THE-RESOURCE/);
  });

  it('only a credential-free loopback http locator gets a tool', () => {
    expect(() => tool({ locator: 'http://10.0.0.7/api' })).toThrow(/loopback/);
    expect(() => tool({ locator: 'http://example.test/api' })).toThrow(/loopback/);
    expect(() => tool({ locator: `https://127.0.0.1:${port}/api` })).toThrow(/must be http/);
    expect(() => tool({ locator: `http://u:p@127.0.0.1:${port}/api` })).toThrow(ResourceToolError);
    expect(() => tool({ locator: `http://127.0.0.1:${port}/api?x=1` })).toThrow(/query or fragment/);
  });
});

describe('the sandbox child reaches a provisioned resource only through the broker', () => {
  let server: Server;
  let url = '';
  beforeAll(async () => {
    server = createServer((rq, rs) => rs.writeHead(rq.url === '/api/hello' ? 200 : 404).end('hi'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  it('on the real child: no fetch, no fs, no import; the brokered tools answer', async () => {
    const sandbox = { profile: 'process' as const, isolation: 'node' as const, memoryMb: 128, execTimeoutSec: 20, envAllowlist: ['PATH', 'HOME'] };
    const factory: ReplFactory = (c) => new ChildProcessRepl({ runId: c.runId, sandbox, capabilities: c.capabilities, onInvoke: c.callbacks.onInvoke, onCheckpoint: c.callbacks.onCheckpoint, handleKey: Buffer.alloc(32, 9) });
    const tools = resourceTools([resource({ locator: db, teardown: `rm -f ${db}`, createdAt: Date.now() - 1000, expiresAt: Date.now() + 3_600_000 }), resource({ id: 'res_http', capability: 'stub_api', kind: 'http-stub', locator: url, teardown: 'kill %1', createdAt: Date.now() - 1000, expiresAt: Date.now() + 3_600_000 })]);
    const caps: CapabilitySet = { tools: ['sessions_db', 'stub_api'], paths: { read: [], write: [], protected: [] }, network: 'none', limits: { usd: 1, tokens: 100_000, calls: 50, wallMs: 60_000, depth: 2, iterations: 4 } };
    // Turn 1: a direct import of fs / http / sqlite is refused before the child runs anything.
    const importing = '```js\nconst fs = await import(\'node:fs\');\nreturn { read: fs.readFileSync(' + JSON.stringify(db) + ', \'utf8\') };\n```';
    // Turn 2: no network or file global exists in the child (process/require are refused by the parser as
    // import is); the brokered tools answer.
    const program = [
      '```js',
      `const direct = [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof Buffer, typeof Deno];`,
      `const rows = await sessions_db.query('SELECT v FROM t');`,
      `const res = await stub_api.get('hello');`,
      `return { direct, rows: rows.rows, status: res.status, body: res.body };`,
      '```',
    ].join('\n');
    const broker = new Broker({ tools, runId: 'run_res', worktree: '', capabilities: caps, guard: liveWriteGuard() });
    const llm = new FakeLLM([importing, program]);
    const out = await invoke({}, { output: { type: 'object' }, hooks: [], llm, repl: factory, broker, run: { runId: 'run_res', invokeId: 'inv_res', depth: 0 }, capabilities: caps });
    expect(String(llm.requests[1]?.messages.at(-1)?.content)).toMatch(/Result of turn 1 \(raise\)[\s\S]*dynamic import is not available/);
    expect(out).toMatchObject({ kind: 'returned', value: { direct: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'], rows: [{ v: 'x' }], status: 200, body: 'hi' } });
  }, 60_000);
});
