import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HANDLE_RE, RPC_LIMITS, isHandleRef as contractsIsHandleRef, type Json, type Provenance } from '@tecera/contracts';

/**
 * Handle minting and the exec-scoped handle table. A handle is `h1.<runId>.<seq>.<hmac16>` where
 * hmac16 is HMAC-SHA256(instance key, `h1.<runId>.<seq>`) truncated to 16 hex chars. The instance key is
 * HMAC-SHA256(per-run key, random 32-byte instance nonce): every HandleMint (every REPL) has its own MAC
 * key even when the caller passes the same per-run key, so a handle minted by an earlier REPL instance
 * never verifies in a reconstructed one. Handles do not survive REPL reconstruction or a process restart.
 * Sequence numbers never repeat within an instance, and each exec gets a fresh table, so a handle from a
 * previous exec, a forged string, or a handle for another run or instance all fail lookup the same way:
 * E_HANDLE.
 */

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class HandleMint {
  private seq = 0;
  private readonly key: Buffer;

  constructor(
    public readonly runId: string,
    key?: Buffer,
  ) {
    if (!RUN_ID_RE.test(runId)) throw new Error(`runId must match ${RUN_ID_RE}`);
    if (key && key.length < 16) throw new Error('handle key must be at least 16 bytes');
    const runKey = key ? Buffer.from(key) : randomBytes(32);
    this.key = createHmac('sha256', runKey).update(randomBytes(32)).digest();
    runKey.fill(0);
  }

  private mac(seq: number): string {
    return createHmac('sha256', this.key).update(`h1.${this.runId}.${seq}`).digest('hex').slice(0, 16);
  }

  mint(): string {
    const seq = ++this.seq;
    return `h1.${this.runId}.${seq}.${this.mac(seq)}`;
  }

  /** True only for a well-formed handle of this run whose MAC verifies. */
  verify(handle: string): boolean {
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return false;
    const parts = handle.split('.');
    if (parts.length !== 4 || parts[1] !== this.runId) return false;
    const seq = Number(parts[2]);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > this.seq) return false;
    const want = Buffer.from(this.mac(seq), 'hex');
    const got = Buffer.from(parts[3]!, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

export type HandleEntry =
  | { kind: 'tool'; tool: string; methods: string[]; description: string }
  | { kind: 'text'; text: string; provenance: Provenance }
  | { kind: 'list'; items: Json[]; provenance: Provenance };

/** Methods every host-served (text/list) handle answers. */
export const VIEW_METHODS = ['len', 'slice', 'search'] as const;

export class HandleLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleLimitError';
  }
}

export class ExecHandleTable {
  private readonly entries = new Map<string, HandleEntry>();

  constructor(
    private readonly mint: HandleMint,
    public readonly execNo: number,
    private readonly maxLive: number = RPC_LIMITS.maxLiveHandles,
  ) {}

  add(entry: HandleEntry): string {
    if (this.entries.size >= this.maxLive) throw new HandleLimitError(`more than ${this.maxLive} live handles in exec ${this.execNo}`);
    const h = this.mint.mint();
    this.entries.set(h, entry);
    return h;
  }

  /** Fail-closed lookup: MAC check first, then this exec's table. */
  get(handle: string): HandleEntry | undefined {
    if (!this.mint.verify(handle)) return undefined;
    return this.entries.get(handle);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** `{ "$handle": "h1..." }` (contracts rpc.ts HandleRef) is how a handle travels inside a Json value in either direction. */
export function isHandleRef(v: Json): v is { $handle: string } {
  return contractsIsHandleRef(v);
}

/**
 * Replace every string longer than the inline limit with a `{ $handle }` reference to a host-served
 * text handle. Returns the rewritten value; the caller decides how to send a promoted top-level string.
 */
export function promoteStrings(value: Json, table: ExecHandleTable, provenance: Provenance, maxInline: number = RPC_LIMITS.maxInlineString): Json {
  if (typeof value === 'string') {
    return value.length > maxInline ? { $handle: table.add({ kind: 'text', text: value, provenance }) } : value;
  }
  if (Array.isArray(value)) return value.map((v) => promoteStrings(v, table, provenance, maxInline));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, { value: promoteStrings(v, table, provenance, maxInline), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}
