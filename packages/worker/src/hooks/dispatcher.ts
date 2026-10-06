import type { AmbientView, Effect, Hook, Json, SpanEvent } from '@tecera/contracts';
import { composeEffects, type Composed } from './compose.js';

/**
 * Emits one frozen event to every active hook at once, collects effects, composes them, and applies
 * blackboard CAS writes. A hook that throws or exceeds its time budget becomes an Abort (fail closed).
 * Hooks never see each other's effects at the same stage; the next stage carries the committed result.
 */
export class Dispatcher {
  private readonly board = new Map<string, Json>();

  constructor(
    private readonly hooks: readonly Hook[],
    private readonly opts: { hookTimeoutMs?: number } = {},
  ) {}

  descriptors() {
    return this.hooks.map((h) => h.describe());
  }

  blackboard(): Readonly<Record<string, Json>> {
    return Object.fromEntries(this.board);
  }

  async emit(event: SpanEvent, view: Omit<AmbientView, 'blackboard' | 'hooks'>): Promise<Composed> {
    const frozen = deepFreeze(structuredClone(event));
    const ambient: AmbientView = { ...view, blackboard: this.blackboard(), hooks: this.descriptors() };
    const timeout = this.opts.hookTimeoutMs ?? 5_000;
    const results = await Promise.allSettled(
      this.hooks
        .filter((h) => h.spans.has(event.span))
        .map(async (h): Promise<[string, Effect[]]> => {
          const effects = await withTimeout(Promise.resolve().then(() => h.handle(frozen, ambient)), timeout, h.id);
          return [h.id, effects];
        }),
    );
    const collected: Array<[string, Effect]> = [];
    for (const r of results) {
      if (r.status === 'fulfilled') for (const e of r.value[1]) collected.push([r.value[0], e]);
      else collected.push([(r.reason as HookFailure).hookId ?? 'unknown', { type: 'Abort', code: 'hookError', reason: `hook failed: ${(r.reason as Error).message}` }]);
    }
    const composed = composeEffects(event.stage, collected);
    if (!composed.abort) {
      for (const c of composed.cas) {
        const cur = this.board.get(c.key);
        if (JSON.stringify(cur) !== JSON.stringify(c.expected)) {
          composed.abort = { reasons: [{ code: 'conflict', reason: `blackboard CAS failed for ${c.key}`, hookId: c.hookId }] };
          break;
        }
      }
      if (!composed.abort) for (const c of composed.cas) this.board.set(c.key, c.value);
    }
    return composed;
  }
}

class HookFailure extends Error {
  constructor(public readonly hookId: string, message: string) {
    super(message);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, hookId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch((e: Error) => {
        throw new HookFailure(hookId, e.message);
      }),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new HookFailure(hookId, `hook ${hookId} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
