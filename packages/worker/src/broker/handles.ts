import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HANDLE_RE, RPC_LIMITS } from '@tecera/contracts';

/**
 * Exec-scoped capability handles `h1.<runId>.<seq>.<hmac16>`. Minted by the supervisor with a per-broker
 * key; the MAC binds run, sequence and exec number, so a forged string, a handle from another run or a
 * handle kept from an earlier exec fails lookup. Lookup is fail-closed: anything not in the live table
 * is refused. At most maxLiveHandles are live per exec.
 */

export class HandleError extends Error {
  constructor(message: string, readonly code: 'E_HANDLE' | 'E_LIMIT') {
    super(message);
    this.name = 'HandleError';
  }
}

export class HandleTable<E> {
  private readonly live = new Map<string, { execNo: number; entry: E }>();
  private seq = 0;
  private readonly runTag: string;

  constructor(
    runId: string,
    private readonly key: Uint8Array = randomBytes(32),
    private readonly maxLive: number = RPC_LIMITS.maxLiveHandles,
  ) {
    this.runTag = runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'run';
  }

  private mac(seq: number, execNo: number): string {
    return createHmac('sha256', this.key).update(`${this.runTag}.${seq}.${execNo}`).digest('hex').slice(0, 16);
  }

  mint(execNo: number, entry: E): string {
    if (this.live.size >= this.maxLive) throw new HandleError(`too many live handles (${this.maxLive})`, 'E_LIMIT');
    const seq = ++this.seq;
    const id = `h1.${this.runTag}.${seq}.${this.mac(seq, execNo)}`;
    this.live.set(id, { execNo, entry });
    return id;
  }

  resolve(id: unknown, execNo: number): E {
    if (typeof id !== 'string' || !HANDLE_RE.test(id)) throw new HandleError('malformed handle', 'E_HANDLE');
    const parts = id.split('.');
    const seq = Number(parts[2]);
    const given = Buffer.from(parts[3]!, 'utf8');
    const want = Buffer.from(this.mac(seq, execNo), 'utf8');
    if (parts[1] !== this.runTag || given.length !== want.length || !timingSafeEqual(given, want)) throw new HandleError('unknown, forged or stale handle', 'E_HANDLE');
    const hit = this.live.get(id);
    if (!hit || hit.execNo !== execNo) throw new HandleError('unknown or revoked handle', 'E_HANDLE');
    return hit.entry;
  }

  revokeAll(): void {
    this.live.clear();
  }

  size(): number {
    return this.live.size;
  }
}
