import type { HistoryEntry, Json, Redactor } from '@tecera/contracts';

/**
 * Turn history of one invoke. The prompt shows only the newest turns that fit the budget; the program
 * reaches the rest by reference through the `__history__` handle (len, slice, search), served by the
 * broker as untrusted data. Entries are append-only; reads return copies with bounded output.
 *
 * With a redactor, every entry is redacted IN FULL when it is added (and when restored), so the bounded
 * slices and search snippets cut already-redacted text and can never start or end mid-secret.
 */

export const HISTORY_LIMITS = { maxEntryChars: 50_000, maxSearchHits: 20, snippetChars: 400 } as const;

export class History {
  private readonly entries: HistoryEntry[] = [];

  constructor(initial: readonly HistoryEntry[] = [], private readonly red?: Redactor) {
    for (const e of initial) this.push(e);
  }

  push(e: HistoryEntry): void {
    const code = typeof e.code === 'string' ? e.code : '';
    const output = typeof e.output === 'string' ? e.output : '';
    this.entries.push({ ...e, code: this.red ? this.red.redactText(code) : code, output: this.red ? this.red.redactText(output) : output });
  }

  len(): number {
    return this.entries.length;
  }

  all(): HistoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Entry text as served: redacted in full with `red` (when it is not the redactor already applied) BEFORE any cut. */
  private view(t: string, red?: Redactor): string {
    return red && red !== this.red ? red.redactText(t) : t;
  }

  slice(start = 0, end?: number, red?: Redactor): HistoryEntry[] {
    const s = Number.isInteger(start) ? start : 0;
    const e = end === undefined || !Number.isInteger(end) ? undefined : end;
    return this.entries.slice(s, e).map((x) => ({ ...x, output: bound(this.view(x.output, red)), code: bound(this.view(x.code, red)) }));
  }

  search(query: string, limit: number = HISTORY_LIMITS.maxSearchHits, red?: Redactor): Array<{ turn: number; where: 'code' | 'output'; snippet: string }> {
    if (typeof query !== 'string' || query.length === 0) return [];
    const q = query.toLowerCase();
    const hits: Array<{ turn: number; where: 'code' | 'output'; snippet: string }> = [];
    const cap = Math.max(1, Math.min(Number.isInteger(limit) ? limit : HISTORY_LIMITS.maxSearchHits, HISTORY_LIMITS.maxSearchHits));
    for (const e of this.entries) {
      for (const where of ['code', 'output'] as const) {
        const text = this.view(e[where], red);
        const at = text.toLowerCase().indexOf(q);
        if (at === -1) continue;
        const from = Math.max(0, at - HISTORY_LIMITS.snippetChars / 2);
        hits.push({ turn: e.turn, where, snippet: text.slice(from, from + HISTORY_LIMITS.snippetChars) });
        if (hits.length >= cap) return hits;
      }
    }
    return hits;
  }

  /**
   * Handle-method dispatch used by the broker. Unknown methods throw (the broker turns that into E_DENIED).
   * `red` (the broker's tree redactor) redacts complete entries before slice/search cut them.
   */
  call(method: string, args: Json[], red?: Redactor): Json {
    switch (method) {
      case 'len':
        return this.len();
      case 'slice':
        return this.slice(args[0] as number, args[1] as number | undefined, red) as unknown as Json;
      case 'search':
        return this.search(String(args[0] ?? ''), args[1] as number | undefined, red) as unknown as Json;
      default:
        throw new Error(`__history__ has no method ${method}`);
    }
  }
}

const bound = (s: string): string => (s.length > HISTORY_LIMITS.maxEntryChars ? `${s.slice(0, HISTORY_LIMITS.maxEntryChars)}…[truncated ${s.length - HISTORY_LIMITS.maxEntryChars} chars]` : s);

export const HISTORY_METHODS = ['len', 'slice', 'search'] as const;
