import {
  canonicalJson,
  requireWriteGuard,
  simulatedProvenance,
  type Json,
  type JsonObject,
  type MockToolDeclaration,
  type Tool,
  type ToolContext,
  type ToolRequest,
  type ToolResult,
  type WriteGuard,
} from '@tecera/contracts';

/**
 * Generic stand-ins for the mock rung of the gap ladder (use → provision → mock → ask). A stand-in is a
 * host-side tool behind the broker: deterministic, in-memory, never touching a file, a socket or a real
 * service. It serves the declaration's tool name, methods and schema (the call schema a real connector
 * would expose), and every result carries simulatedProvenance; the broker re-tags it anyway, so nothing a
 * stand-in returns can pass as real.
 *
 * - Store (kinds STORE_KINDS): a key-value map plus SQL-ish tables (insert / select / update / remove by
 *   equality on fields). Ids are sequential per table; listings are sorted; nothing depends on time.
 * - Message sink (kinds MESSAGE_KINDS): `send(message)` records what would have been sent and answers
 *   {id, accepted: true, simulated: true}; `outbox()` lists the records. The host reads them with `sent()`.
 *
 * Every mutation checks the call's write guard first (a stopped exec records nothing).
 */

export const STORE_KINDS: readonly string[] = ['kv', 'store', 'database', 'db', 'sql', 'sqlite', 'postgres', 'mysql', 'redis'];
export const MESSAGE_KINDS: readonly string[] = ['mail', 'email', 'smtp', 'message', 'messaging', 'sms', 'chat', 'webhook', 'notification', 'queue'];

export const STORE_METHODS: readonly string[] = ['get', 'set', 'delete', 'list', 'insert', 'select', 'update', 'remove'];
export const MESSAGE_METHODS: readonly string[] = ['send', 'outbox'];

export const STAND_IN_LIMITS = {
  maxKeys: 10_000,
  maxRowsPerTable: 10_000,
  maxMessages: 1_000,
  maxValueBytes: 64 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxNameChars: 256,
} as const;

/** A stand-in tool plus host-side views of what it holds (tests and the bench read them; programs never do). */
export interface StandInTool extends Tool {
  /** Re-authorization for journal replay: the method must be a declared one (a stand-in touches no path). */
  authorize(req: ToolRequest, ctx: ToolContext): Promise<void>;
  readonly standsIn: string;
  /** Messages a sink recorded, in order (empty for a store). */
  sent(): readonly Json[];
  /** A snapshot of a store's state (empty for a sink). */
  snapshot(): { kv: Record<string, Json>; tables: Record<string, Json[]> };
}

export class StandInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandInError';
  }
}

const bytes = (v: Json): number => Buffer.byteLength(canonicalJson(v), 'utf8');

function name(v: Json | undefined, what: string): string {
  if (typeof v !== 'string' || !v || v.length > STAND_IN_LIMITS.maxNameChars) throw new StandInError(`${what} must be a non-empty string of at most ${STAND_IN_LIMITS.maxNameChars} characters`);
  if (v === '__proto__' || v === 'constructor' || v === 'prototype') throw new StandInError(`${what} ${v} is not allowed`);
  return v;
}

function plainObject(v: Json | undefined, what: string): JsonObject {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StandInError(`${what} must be an object`);
  return v;
}

function sized(v: Json, what: string): Json {
  if (bytes(v) > STAND_IN_LIMITS.maxValueBytes) throw new StandInError(`${what} is larger than ${STAND_IN_LIMITS.maxValueBytes} bytes`);
  return structuredClone(v);
}

const matches = (row: JsonObject, where: JsonObject): boolean => Object.entries(where).every(([k, v]) => canonicalJson(row[k] ?? null) === canonicalJson(v));

function result(req: ToolRequest, capability: string, value: Json): ToolResult {
  return { callId: req.callId, ok: true, value, provenance: simulatedProvenance(capability), truncated: false };
}

function failure(req: ToolRequest, capability: string, e: unknown): ToolResult {
  const err = e instanceof Error ? e : new Error(String(e));
  return { callId: req.callId, ok: false, error: { name: err.name || 'StandInError', message: err.message }, provenance: simulatedProvenance(capability), truncated: false };
}

/** Methods the declaration names that this stand-in cannot serve (empty when it serves all of them). */
function unsupported(decl: MockToolDeclaration, served: readonly string[]): string[] {
  return decl.methods.filter((m) => !served.includes(m));
}

/** The in-memory store stand-in for `decl` (kind in STORE_KINDS; every declared method in STORE_METHODS). */
export function createStoreStandIn(decl: MockToolDeclaration): StandInTool {
  const missing = unsupported(decl, STORE_METHODS);
  if (missing.length) throw new StandInError(`the store stand-in has no method ${missing.join(', ')}`);
  const kv = new Map<string, Json>();
  const tables = new Map<string, { next: number; rows: JsonObject[] }>();
  let total = 0;
  const account = (delta: number): void => {
    if (total + delta > STAND_IN_LIMITS.maxTotalBytes) throw new StandInError(`the store stand-in is full (${STAND_IN_LIMITS.maxTotalBytes} bytes)`);
    total += delta;
  };
  const table = (t: string) => {
    let x = tables.get(t);
    if (!x) tables.set(t, (x = { next: 1, rows: [] }));
    return x;
  };
  const mutate = (guard: WriteGuard): void => requireWriteGuard(guard).check();

  const methods: Record<string, (args: Json[], guard: WriteGuard) => Json> = {
    get: ([k]) => structuredClone(kv.get(name(k, 'key')) ?? null),
    set: ([k, v], g) => {
      const key = name(k, 'key');
      const val = sized(v ?? null, `value of ${key}`);
      if (!kv.has(key) && kv.size >= STAND_IN_LIMITS.maxKeys) throw new StandInError(`the store stand-in holds at most ${STAND_IN_LIMITS.maxKeys} keys`);
      mutate(g);
      account(bytes(val) - (kv.has(key) ? bytes(kv.get(key)!) : 0));
      kv.set(key, val);
      return { ok: true };
    },
    delete: ([k], g) => {
      const key = name(k, 'key');
      mutate(g);
      const had = kv.get(key);
      if (had !== undefined) account(-bytes(had));
      return { deleted: kv.delete(key) };
    },
    list: ([prefix]) => {
      const p = prefix === undefined || prefix === null ? '' : name(prefix, 'prefix');
      return [...kv.keys()].filter((k) => k.startsWith(p)).sort();
    },
    insert: ([t, row], g) => {
      const tb = table(name(t, 'table'));
      const r = plainObject(sized(row ?? null, 'row'), 'row');
      if (tb.rows.length >= STAND_IN_LIMITS.maxRowsPerTable) throw new StandInError(`table ${String(t)} holds at most ${STAND_IN_LIMITS.maxRowsPerTable} rows`);
      mutate(g);
      const stored: JsonObject = { ...r, id: tb.next++ };
      account(bytes(stored));
      tb.rows.push(stored);
      return { id: stored.id as number };
    },
    select: ([t, where]) => {
      const w = where === undefined || where === null ? {} : plainObject(where, 'where');
      return structuredClone((tables.get(name(t, 'table'))?.rows ?? []).filter((r) => matches(r, w)));
    },
    update: ([t, where, patch], g) => {
      const tb = tables.get(name(t, 'table'));
      const w = plainObject(where ?? null, 'where');
      const p = plainObject(sized(patch ?? null, 'patch'), 'patch');
      if ('id' in p) throw new StandInError('a row id cannot be changed');
      mutate(g);
      let n = 0;
      for (const [i, r] of (tb?.rows ?? []).entries()) {
        if (!matches(r, w)) continue;
        const next = { ...r, ...p };
        account(bytes(next) - bytes(r));
        tb!.rows[i] = next;
        n++;
      }
      return { updated: n };
    },
    remove: ([t, where], g) => {
      const tb = tables.get(name(t, 'table'));
      const w = plainObject(where ?? null, 'where');
      mutate(g);
      if (!tb) return { removed: 0 };
      const keep = tb.rows.filter((r) => !matches(r, w));
      for (const r of tb.rows) if (!keep.includes(r)) account(-bytes(r));
      const n = tb.rows.length - keep.length;
      tb.rows = keep;
      return { removed: n };
    },
  };
  return {
    name: decl.tool,
    methods: [...decl.methods],
    schema: structuredClone(decl.schema),
    risk: 'write',
    standsIn: decl.capability,
    async authorize(req: ToolRequest): Promise<void> {
      if (!decl.methods.includes(req.method)) throw new StandInError(`${decl.tool} has no method ${req.method}`);
    },
    async call(req: ToolRequest, _ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        if (!decl.methods.includes(req.method)) throw new StandInError(`${decl.tool} has no method ${req.method}`);
        return result(req, decl.capability, methods[req.method]!(Array.isArray(req.args) ? req.args : [], requireWriteGuard(guard)));
      } catch (e) {
        return failure(req, decl.capability, e);
      }
    },
    sent: () => [],
    snapshot: () => ({ kv: Object.fromEntries([...kv.entries()].map(([k, v]) => [k, structuredClone(v)])), tables: Object.fromEntries([...tables.entries()].map(([k, t]) => [k, structuredClone(t.rows)])) }),
  };
}

/** The outbound message sink stand-in for `decl` (kind in MESSAGE_KINDS; every declared method in MESSAGE_METHODS). */
export function createMessageSinkStandIn(decl: MockToolDeclaration): StandInTool {
  const missing = unsupported(decl, MESSAGE_METHODS);
  if (missing.length) throw new StandInError(`the message sink stand-in has no method ${missing.join(', ')}`);
  const outbox: JsonObject[] = [];
  const methods: Record<string, (args: Json[], guard: WriteGuard) => Json> = {
    send: ([message], g) => {
      const m = plainObject(sized(message ?? null, 'message'), 'message');
      if (outbox.length >= STAND_IN_LIMITS.maxMessages) throw new StandInError(`the message sink holds at most ${STAND_IN_LIMITS.maxMessages} messages`);
      requireWriteGuard(g).check();
      const id = `sim-msg-${outbox.length + 1}`;
      outbox.push({ id, message: m });
      return { id, accepted: true, simulated: true };
    },
    outbox: () => structuredClone(outbox),
  };
  return {
    name: decl.tool,
    methods: [...decl.methods],
    schema: structuredClone(decl.schema),
    // What the real connector would be: a sent message cannot be called back.
    risk: 'irreversible',
    standsIn: decl.capability,
    async authorize(req: ToolRequest): Promise<void> {
      if (!decl.methods.includes(req.method)) throw new StandInError(`${decl.tool} has no method ${req.method}`);
    },
    async call(req: ToolRequest, _ctx: ToolContext, guard?: WriteGuard): Promise<ToolResult> {
      try {
        if (!decl.methods.includes(req.method)) throw new StandInError(`${decl.tool} has no method ${req.method}`);
        return result(req, decl.capability, methods[req.method]!(Array.isArray(req.args) ? req.args : [], requireWriteGuard(guard)));
      } catch (e) {
        return failure(req, decl.capability, e);
      }
    },
    sent: () => structuredClone(outbox),
    snapshot: () => ({ kv: {}, tables: {} }),
  };
}

/**
 * The generic stand-in for a declaration, by kind: a store for STORE_KINDS, a message sink for
 * MESSAGE_KINDS. Throws StandInError for any other kind or a method the stand-in cannot serve.
 */
export function standInFor(decl: MockToolDeclaration): StandInTool {
  const kind = typeof decl?.kind === 'string' ? decl.kind.toLowerCase() : '';
  if (STORE_KINDS.includes(kind)) return createStoreStandIn(decl);
  if (MESSAGE_KINDS.includes(kind)) return createMessageSinkStandIn(decl);
  throw new StandInError(`no generic stand-in serves kind ${JSON.stringify(decl?.kind ?? null)}`);
}
