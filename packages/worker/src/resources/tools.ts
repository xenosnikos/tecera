import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { requireWriteGuard, resourceProblem, type Json, type ProvisionedResource, type ToolContext, type ToolRequest, type ToolResult, type WriteGuard } from '@tecera/contracts';
import { combinedSignal, type AuthorizingTool } from '../tools/common.js';

/**
 * Provisioned resources reach a worker only as brokered tools (the gap ladder's provision rung). The sandbox
 * child never gets a file or a socket: it holds a handle, the broker routes its calls here, and the tool
 * talks to the resource on the host side, scoped to the resource's locator and nothing else.
 *
 * - sqlite (kind 'sqlite'): the locator is an absolute path to a regular file (never a symlink). `query(sql,
 *   params?)` returns rows, `run(sql, params?)` returns changes. One statement per call; ATTACH, DETACH,
 *   VACUUM (INTO writes a file), PRAGMA and extension loading are refused, so a statement cannot reach any
 *   other file. Parameters are JSON scalars. The statement is model-written, so it never runs on the
 *   supervisor thread: each call runs in a short-lived child process that is SIGKILLed at the time bound,
 *   when the exec signal or the guard's signal fires, or when it writes more than the result bound. The
 *   child opens the file with a page cap (the database cannot grow past maxDbBytes), a hard heap limit and
 *   in-memory temp storage; rows stop at maxRows or maxResultBytes (truncated). Every bound fails closed
 *   (ok:false); a killed write is rolled back by sqlite's journal on the next open.
 * - http-stub (kind 'http-stub'): the locator is a loopback http URL (127.0.0.1, ::1 or localhost) with no
 *   credentials. `get|post|put|delete(path, body?)` take a path RELATIVE to the locator; anything that would
 *   leave its origin or base path (`..`, `//host`, a scheme, a backslash, `@`) is refused, redirects are
 *   never followed, the program sets no headers, and the response is capped.
 *
 * Both refuse an expired resource, check the call's write guard before every request, and tag results
 * `resource:<id>` (untrusted; the broker re-tags anyway). The fidelity a criterion proven against one can
 * claim ('provisioned') comes from the inventory, never from the tool.
 */

export const RESOURCE_TOOL_LIMITS = {
  maxSqlChars: 64 * 1024,
  maxRows: 1_000,
  maxParams: 256,
  maxPathChars: 2_048,
  maxBodyBytes: 256 * 1024,
  maxResponseBytes: 512 * 1024,
  timeoutMs: 10_000,
  /** sqlite: rows of one result, as JSON bytes. */
  maxResultBytes: 1024 * 1024,
  /** sqlite: size the database file may grow to (a file already larger cannot grow at all). */
  maxDbBytes: 64 * 1024 * 1024,
  /** sqlite: engine heap of one statement (page cache, sorters, in-memory temp storage). */
  maxSqlHeapBytes: 128 * 1024 * 1024,
} as const;

export class ResourceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceToolError';
  }
}

export interface ResourceToolOptions {
  /** Tool (and program binding) name; default the resource's capability id. */
  name?: string;
  now?: () => number;
  /** Time bound of one request (http) or one statement (sqlite). Default RESOURCE_TOOL_LIMITS.timeoutMs. */
  timeoutMs?: number;
  /** sqlite only: lower the result and database size bounds (never above RESOURCE_TOOL_LIMITS). */
  maxResultBytes?: number;
  maxDbBytes?: number;
}

/** A tool serving one provisioned resource; `resourceId` names it. */
export interface ResourceTool extends AuthorizingTool {
  readonly resourceId: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function toolName(r: ProvisionedResource, o: ResourceToolOptions): string {
  const n = o.name ?? r.capability;
  if (!IDENT.test(n)) throw new ResourceToolError(`resource tool name ${JSON.stringify(n)} is not an identifier`);
  return n;
}

function admit(r: ProvisionedResource, kind: string): void {
  const why = resourceProblem(r);
  if (why) throw new ResourceToolError(why);
  if (r.kind !== kind) throw new ResourceToolError(`resource ${r.id} is ${r.kind}, not ${kind}`);
}

function ok(req: ToolRequest, r: ProvisionedResource, value: Json): ToolResult {
  return { callId: req.callId, ok: true, value, provenance: { src: `resource:${r.id}`, trust: 'untrusted' }, truncated: false };
}

function fail(req: ToolRequest, r: ProvisionedResource, e: unknown): ToolResult {
  const err = e instanceof Error ? e : new Error(String(e));
  return { callId: req.callId, ok: false, error: { name: err.name || 'ResourceToolError', message: err.message }, provenance: { src: `resource:${r.id}`, trust: 'untrusted' }, truncated: false };
}

function live(r: ProvisionedResource, o: ResourceToolOptions): void {
  if ((o.now ?? Date.now)() >= r.expiresAt) throw new ResourceToolError(`resource ${r.id} expired`);
}

// ---------------------------------------------------------------- sqlite

/** Statements that could reach another file or change the engine: never run through a resource tool. */
const SQL_REFUSED = /\b(?:attach|detach|vacuum|pragma|load_extension|fts3_tokenizer)\b/i;

function sqlOf(v: Json | undefined): string {
  if (typeof v !== 'string' || !v.trim()) throw new ResourceToolError('sql must be a non-empty string');
  if (v.length > RESOURCE_TOOL_LIMITS.maxSqlChars) throw new ResourceToolError(`sql is longer than ${RESOURCE_TOOL_LIMITS.maxSqlChars} characters`);
  if (v.includes('\0')) throw new ResourceToolError('sql contains NUL');
  const one = v.trim().replace(/;\s*$/, '');
  if (one.includes(';')) throw new ResourceToolError('one statement per call');
  if (SQL_REFUSED.test(one)) throw new ResourceToolError('ATTACH, DETACH, VACUUM, PRAGMA and extension functions are refused on a resource');
  return one;
}

function paramsOf(v: Json | undefined): Array<string | number | null> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > RESOURCE_TOOL_LIMITS.maxParams) throw new ResourceToolError(`params must be a list of at most ${RESOURCE_TOOL_LIMITS.maxParams} values`);
  return v.map((x) => {
    if (x === null || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))) return x;
    throw new ResourceToolError('params must be strings, finite numbers or null');
  });
}

interface SqlJob {
  path: string;
  method: string;
  sql: string;
  params: Array<string | number | null>;
  maxRows: number;
  maxResultBytes: number;
  maxDbBytes: number;
  heapBytes: number;
}

/**
 * The statement runner (CommonJS, run with `node -e` so it is the same from src and dist). Reads one SqlJob
 * as JSON on stdin, writes one JSON answer on stdout: { ok: true, value } or { ok: false, name, message }.
 * The PRAGMAs are the host's, set before the statement is prepared; the program can issue none.
 */
const SQL_CHILD = `
const { DatabaseSync } = require('node:sqlite');
const cell = (v) => {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return { blob: Buffer.from(v).toString('base64') };
  return String(v);
};
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let out;
  try {
    const q = JSON.parse(raw);
    const db = new DatabaseSync(q.path, { allowExtension: false });
    try {
      db.exec('PRAGMA temp_store = MEMORY');
      const heap = db.prepare('PRAGMA hard_heap_limit = ' + q.heapBytes).get();
      if (!heap || Number(heap.hard_heap_limit) !== q.heapBytes) throw new Error('the heap limit was not applied');
      const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
      const pages = Number(db.prepare('PRAGMA page_count').get().page_count);
      const want = Math.max(pages, Math.floor(q.maxDbBytes / pageSize), 1);
      const got = Number(db.prepare('PRAGMA max_page_count = ' + want).get().max_page_count);
      if (!(got <= want)) throw new Error('the database size limit was not applied');
      const stmt = db.prepare(q.sql);
      if (q.method === 'run') {
        const res = stmt.run(...q.params);
        out = { ok: true, value: { changes: Number(res.changes), lastInsertRowid: cell(res.lastInsertRowid) } };
      } else {
        const rows = [];
        let truncated = false;
        let bytes = 0;
        for (const row of stmt.iterate(...q.params)) {
          if (rows.length >= q.maxRows) {
            truncated = true;
            break;
          }
          const r = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]));
          const n = Buffer.byteLength(JSON.stringify(r), 'utf8');
          if (n > q.maxResultBytes) {
            const e = new Error('a row of the result is larger than ' + q.maxResultBytes + ' bytes');
            e.name = 'ResourceToolError';
            throw e;
          }
          if (bytes + n > q.maxResultBytes) {
            truncated = true;
            break;
          }
          bytes += n;
          rows.push(r);
        }
        out = { ok: true, value: { rows, truncated } };
      }
    } finally {
      db.close();
    }
  } catch (e) {
    out = { ok: false, name: String((e && e.name) || 'Error'), message: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(out));
});
`;

const SQL_KILL_GRACE_MS = 5_000;

/**
 * Run one statement in its own process. Resolves with the statement's value; rejects with the engine's
 * error, or a ResourceToolError when the child was stopped (time bound, cancel, oversized answer) or did
 * not answer. The child is SIGKILLed on every stop, so nothing keeps running after this settles; the
 * answer is read when the child's stdout has closed.
 */
function runStatement(job: SqlJob, timeoutMs: number, signal: AbortSignal): Promise<Json> {
  return new Promise<Json>((resolve, reject) => {
    if (signal.aborted) return reject(new ResourceToolError('the statement was not run: the exec was cancelled'));
    const child = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=256', '-e', SQL_CHILD], { stdio: ['pipe', 'pipe', 'ignore'], env: {}, cwd: '/', windowsHide: true });
    const maxAnswer = job.maxResultBytes + 4 * job.maxRows + 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped: ResourceToolError | null = null;
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const stop = (why: string): void => {
      if (stopped || done) return;
      stopped = new ResourceToolError(why);
      child.kill('SIGKILL');
      // A child that cannot be reaped is not waited for: the call still fails closed.
      grace = setTimeout(() => settle(), SQL_KILL_GRACE_MS);
    };
    const onAbort = (): void => stop('the statement was stopped: the exec was cancelled');
    const timer = setTimeout(() => stop(`the statement did not finish within ${timeoutMs}ms and was stopped`), timeoutMs);
    const settle = (spawnError?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal.removeEventListener('abort', onAbort);
      if (stopped) return reject(stopped);
      if (spawnError) return reject(new ResourceToolError(`the statement could not be run: ${spawnError.message}`));
      let answer: { ok?: unknown; value?: Json; name?: unknown; message?: unknown };
      try {
        answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof answer;
      } catch {
        return reject(new ResourceToolError('the statement runner ended without an answer'));
      }
      if (answer?.ok === true && answer.value !== undefined) return resolve(answer.value);
      const err = new Error(typeof answer?.message === 'string' ? answer.message : 'the statement failed');
      err.name = typeof answer?.name === 'string' && answer.name ? answer.name : 'Error';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxAnswer) return stop(`the result is larger than ${job.maxResultBytes} bytes`);
      chunks.push(c);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => settle(e));
    child.on('close', () => settle());
    child.stdin.end(JSON.stringify(job));
  });
}

const lowered = (v: number | undefined, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : max);

/** The database file: absolute, a regular file, not a symlink (checked on every call). */
function dbPath(r: ProvisionedResource): string {
  if (!isAbsolute(r.locator)) throw new ResourceToolError(`resource ${r.id}: the sqlite locator must be an absolute path`);
  let st;
  try {
    st = lstatSync(r.locator);
  } catch {
    throw new ResourceToolError(`resource ${r.id}: the database file is missing`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new ResourceToolError(`resource ${r.id}: the database is not a regular file`);
  return r.locator;
}

/** A tool over a provisioned sqlite file (methods query, run). */
export function createSqliteResourceTool(resource: ProvisionedResource, o: ResourceToolOptions = {}): ResourceTool {
  admit(resource, 'sqlite');
  const r = structuredClone(resource);
  const name = toolName(r, o);
  const methods = ['query', 'run'];
  return {
    name,
    resourceId: r.id,
    methods,
    risk: 'write',
    schema: {
      type: 'object',
      description: `provisioned sqlite database ${r.id} (${r.capability})`,
      properties: { sql: { type: 'string' }, params: { type: 'array', items: { type: ['string', 'number', 'null'] } } },
      required: ['sql'],
    },
    async authorize(req: ToolRequest): Promise<void> {
      if (!methods.includes(req.method)) throw new ResourceToolError(`${name} has no method ${req.method}`);
      live(r, o);
    },
    async call(req: ToolRequest, ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        if (!methods.includes(req.method)) throw new ResourceToolError(`${name} has no method ${req.method}`);
        live(r, o);
        const [sqlArg, paramArg] = Array.isArray(req.args) ? req.args : [];
        const sql = sqlOf(sqlArg);
        const params = paramsOf(paramArg);
        const path = dbPath(r);
        const g = requireWriteGuard(guard);
        g.check();
        const job: SqlJob = {
          path,
          method: req.method,
          sql,
          params,
          maxRows: RESOURCE_TOOL_LIMITS.maxRows,
          maxResultBytes: lowered(o.maxResultBytes, RESOURCE_TOOL_LIMITS.maxResultBytes),
          maxDbBytes: lowered(o.maxDbBytes, RESOURCE_TOOL_LIMITS.maxDbBytes),
          heapBytes: RESOURCE_TOOL_LIMITS.maxSqlHeapBytes,
        };
        try {
          return ok(req, r, await runStatement(job, typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : RESOURCE_TOOL_LIMITS.timeoutMs, combinedSignal(ctx, g)));
        } catch (e) {
          // A statement stopped because the fence was lost reports the fence, as every other write does.
          g.check();
          throw e;
        }
      } catch (e) {
        return fail(req, r, e);
      }
    },
  };
}

// ---------------------------------------------------------------- http stub

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The locator as a base URL: loopback http, no credentials, no query or fragment, a trailing slash. */
function baseOf(r: ProvisionedResource): URL {
  let u: URL;
  try {
    u = new URL(r.locator);
  } catch {
    throw new ResourceToolError(`resource ${r.id}: the http-stub locator is not a URL`);
  }
  if (u.protocol !== 'http:') throw new ResourceToolError(`resource ${r.id}: the http-stub locator must be http`);
  if (!LOOPBACK.has(u.hostname)) throw new ResourceToolError(`resource ${r.id}: the http-stub locator must be a loopback address`);
  if (u.username || u.password) throw new ResourceToolError(`resource ${r.id}: the http-stub locator carries credentials`);
  if (u.search || u.hash) throw new ResourceToolError(`resource ${r.id}: the http-stub locator may not carry a query or fragment`);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

/** The request URL for a program-given path, which must stay under the base (same origin, same base path). */
function targetOf(base: URL, v: Json | undefined): URL {
  const p = v === undefined || v === null ? '' : v;
  if (typeof p !== 'string' || p.length > RESOURCE_TOOL_LIMITS.maxPathChars) throw new ResourceToolError(`path must be a string of at most ${RESOURCE_TOOL_LIMITS.maxPathChars} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\@]/.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || p.split(/[?#]/)[0]!.split('/').some((s) => s === '..' || s === '.' || /^%2e/i.test(s) || /%2f|%5c/i.test(s))) {
    throw new ResourceToolError('path must be relative to the resource (no scheme, //host, .., backslash or @)');
  }
  const u = new URL(p.replace(/^\/+/, ''), base);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname) || u.username || u.password) throw new ResourceToolError('path leaves the resource');
  return u;
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) {
      chunks.push(value.subarray(0, max - n));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    n += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** A tool over a provisioned loopback HTTP stub (methods get, post, put, delete). */
export function createHttpResourceTool(resource: ProvisionedResource, o: ResourceToolOptions = {}): ResourceTool {
  admit(resource, 'http-stub');
  const r = structuredClone(resource);
  const base = baseOf(r);
  const name = toolName(r, o);
  const methods = ['get', 'post', 'put', 'delete'];
  return {
    name,
    resourceId: r.id,
    methods,
    risk: 'write',
    schema: { type: 'object', description: `provisioned http stub ${r.id} (${r.capability})`, properties: { path: { type: 'string' }, body: {} } },
    async authorize(req: ToolRequest): Promise<void> {
      if (!methods.includes(req.method)) throw new ResourceToolError(`${name} has no method ${req.method}`);
      live(r, o);
      targetOf(base, Array.isArray(req.args) ? req.args[0] : undefined);
    },
    async call(req: ToolRequest, ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        if (!methods.includes(req.method)) throw new ResourceToolError(`${name} has no method ${req.method}`);
        live(r, o);
        const [pathArg, bodyArg] = Array.isArray(req.args) ? req.args : [];
        const url = targetOf(base, pathArg);
        let body: string | undefined;
        if (bodyArg !== undefined && req.method !== 'get') {
          body = typeof bodyArg === 'string' ? bodyArg : JSON.stringify(bodyArg);
          if (Buffer.byteLength(body, 'utf8') > RESOURCE_TOOL_LIMITS.maxBodyBytes) throw new ResourceToolError(`body is larger than ${RESOURCE_TOOL_LIMITS.maxBodyBytes} bytes`);
        }
        const g = requireWriteGuard(guard);
        g.check();
        const res = await fetch(url, {
          method: req.method.toUpperCase(),
          redirect: 'manual',
          signal: AbortSignal.any([AbortSignal.timeout(o.timeoutMs ?? RESOURCE_TOOL_LIMITS.timeoutMs), combinedSignal(ctx, g)]),
          ...(body !== undefined ? { body, headers: { 'content-type': typeof bodyArg === 'string' ? 'text/plain' : 'application/json' } } : {}),
        });
        const { text, truncated } = await readCapped(res, RESOURCE_TOOL_LIMITS.maxResponseBytes);
        return { ...ok(req, r, { status: res.status, contentType: res.headers.get('content-type') ?? null, body: text }), truncated };
      } catch (e) {
        return fail(req, r, e);
      }
    },
  };
}

/** Tools for the provisioned resources a worker step may use (sqlite and http-stub kinds; others are refused). */
export function resourceTools(resources: readonly ProvisionedResource[], o: Omit<ResourceToolOptions, 'name'> = {}): ResourceTool[] {
  return resources.map((r) => {
    if (r?.kind === 'sqlite') return createSqliteResourceTool(r, o);
    if (r?.kind === 'http-stub') return createHttpResourceTool(r, o);
    throw new ResourceToolError(`resource kind ${JSON.stringify(r?.kind ?? null)} has no worker tool`);
  });
}
