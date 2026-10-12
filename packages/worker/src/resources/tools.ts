import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { requireWriteGuard, resourceProblem, type Json, type JsonObject, type ProvisionedResource, type ToolContext, type ToolRequest, type ToolResult, type WriteGuard } from '@tecera/contracts';
import { combinedSignal, type AuthorizingTool } from '../tools/common.js';

/**
 * Provisioned resources reach a worker only as brokered tools (the gap ladder's provision rung). The sandbox
 * child never gets a file or a socket: it holds a handle, the broker routes its calls here, and the tool
 * talks to the resource on the host side, scoped to the resource's locator and nothing else.
 *
 * - sqlite (kind 'sqlite'): the locator is an absolute path to a regular file (never a symlink). `query(sql,
 *   params?)` returns rows, `run(sql, params?)` returns changes. One statement per call; ATTACH, DETACH,
 *   VACUUM (INTO writes a file), PRAGMA and extension loading are refused, so a statement cannot reach any
 *   other file. Parameters are JSON scalars.
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
  timeoutMs?: number;
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

function cell(v: unknown): Json {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v as Json;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return { blob: Buffer.from(v).toString('base64') };
  return String(v);
}

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
    async call(req: ToolRequest, _ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        if (!methods.includes(req.method)) throw new ResourceToolError(`${name} has no method ${req.method}`);
        live(r, o);
        const [sqlArg, paramArg] = Array.isArray(req.args) ? req.args : [];
        const sql = sqlOf(sqlArg);
        const params = paramsOf(paramArg);
        const path = dbPath(r);
        requireWriteGuard(guard).check();
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path, { allowExtension: false });
        try {
          const stmt = db.prepare(sql);
          if (req.method === 'run') {
            const res = stmt.run(...params);
            return ok(req, r, { changes: Number(res.changes), lastInsertRowid: cell(res.lastInsertRowid) });
          }
          const rows: JsonObject[] = [];
          let truncated = false;
          for (const row of stmt.iterate(...params)) {
            if (rows.length >= RESOURCE_TOOL_LIMITS.maxRows) {
              truncated = true;
              break;
            }
            rows.push(Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, cell(v)])));
          }
          return ok(req, r, { rows, truncated });
        } finally {
          db.close();
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
