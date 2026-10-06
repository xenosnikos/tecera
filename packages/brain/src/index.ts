import { event, type Binding, type Json, type Ledger, type MemoryEntry, type Principal, type TeceraEvent } from '@tecera/contracts';

/**
 * Four memory tiers as views over the ledger (agentic-stack port). Episodes are evidence written by
 * the loop; lessons enter semantic memory only through staging and human graduation with a rationale;
 * retraction is append-only. Retrieval is salience × relevance under a token budget; always-on slots
 * (personal preferences, working state) are never dropped.
 */

export type Tier = MemoryEntry['tier'];

/** recency × pain × importance × min(recurrence, 3); recency decays 0.3 per day from 10. Verbatim from agentic-stack salience.py. */
export function salience(e: Pick<MemoryEntry, 'salience'>, now: number): number {
  const ageDays = Math.max(0, (now - e.salience.createdAt) / 86_400_000);
  const recency = Math.max(0, Math.min(10, 10 - ageDays * 0.3));
  return recency * (e.salience.pain / 10) * (e.salience.importance / 10) * Math.min(e.salience.recurrence, 3);
}

const RELEVANCE_FLOOR = 0.3;
const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
export function relevance(text: string, query: string): number {
  const q = words(query);
  if (q.size === 0) return 1;
  const t = words(text);
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

export class GraduationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraduationError';
  }
}

export interface BrainOptions {
  runId: string;
  budgetTokens: number;
  now?: () => number;
  ids?: () => string;
  actor?: Principal;
}

export class Brain {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly actor: Principal;
  private seq = 0;

  constructor(private readonly ledger: Ledger, private readonly opts: BrainOptions) {
    this.now = opts.now ?? Date.now;
    this.ids = opts.ids ?? (() => `m_${opts.runId}_${++this.seq}`);
    this.actor = opts.actor ?? { kind: 'system', id: 'brain' };
  }

  /** Rebuild the tiers from the log: evidence.appended(kind=memory) and lesson.* events. */
  static async load(ledger: Ledger, opts: BrainOptions): Promise<Brain> {
    const b = new Brain(ledger, opts);
    for await (const e of ledger.events({ kinds: ['evidence.appended', 'lesson.staged', 'lesson.graduated', 'lesson.rejected', 'lesson.retracted'] })) b.apply(e);
    return b;
  }

  apply(e: TeceraEvent): void {
    const p = e.payload as { entry?: MemoryEntry; id?: string; decision?: MemoryEntry['decisions'][number] };
    if (e.kind === 'evidence.appended' && p.entry?.tier) this.entries.set(p.entry.id, p.entry);
    if (e.kind === 'lesson.staged' && p.entry) this.entries.set(p.entry.id, p.entry);
    if ((e.kind === 'lesson.graduated' || e.kind === 'lesson.rejected' || e.kind === 'lesson.retracted') && p.id && p.decision) {
      const cur = this.entries.get(p.id);
      if (!cur) return;
      const state = e.kind === 'lesson.graduated' ? 'active' : e.kind === 'lesson.rejected' ? 'rejected' : 'retracted';
      this.entries.set(p.id, { ...cur, state, decisions: [...cur.decisions, p.decision] });
    }
  }

  all(tier?: Tier): MemoryEntry[] {
    return [...this.entries.values()].filter((e) => !tier || e.tier === tier);
  }

  /** Record an episode (what happened). Written as evidence; untrusted unless the caller says otherwise. */
  async record(e: { kind: string; content: string; pain?: number; importance?: number; provenance?: MemoryEntry['provenance'] }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: this.ids(),
      tier: 'episodic',
      kind: e.kind,
      content: e.content,
      provenance: e.provenance ?? { runId: this.opts.runId },
      salience: { createdAt: this.now(), pain: e.pain ?? 2, importance: e.importance ?? 5, recurrence: 1 },
      state: 'active',
      decisions: [],
    };
    await this.emit('evidence.appended', { entry: entry as unknown as Json });
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Stage a candidate lesson (mechanical; no judgment). */
  async stage(c: { content: string; sourceEpisodes: string[]; pain?: number; importance?: number }): Promise<MemoryEntry> {
    const dup = [...this.entries.values()].find((e) => e.tier === 'semantic' && e.content.trim() === c.content.trim() && e.state !== 'retracted');
    if (dup) {
      const bumped = { ...dup, salience: { ...dup.salience, recurrence: dup.salience.recurrence + 1 } };
      this.entries.set(dup.id, bumped);
      return bumped;
    }
    const entry: MemoryEntry = {
      id: this.ids(),
      tier: 'semantic',
      kind: 'lesson',
      content: c.content,
      provenance: { runId: this.opts.runId, evidenceKey: c.sourceEpisodes.join(',') },
      salience: { createdAt: this.now(), pain: c.pain ?? 5, importance: c.importance ?? 5, recurrence: 1 },
      state: 'candidate',
      decisions: [],
    };
    await this.emit('lesson.staged', { entry: entry as unknown as Json });
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Only a human with a non-empty rationale can promote, reject or retract. Rejections keep history. */
  async graduate(id: string, d: { by: Principal; verdict: 'promote' | 'reject' | 'retract'; rationale: string }): Promise<MemoryEntry> {
    const cur = this.entries.get(id);
    if (!cur) throw new GraduationError(`unknown memory entry ${id}`);
    if (d.by.kind !== 'human') throw new GraduationError('only a human principal can graduate, reject or retract');
    if (!d.rationale.trim()) throw new GraduationError('a rationale is required');
    if (d.verdict === 'retract' && cur.state !== 'active') throw new GraduationError('only an active lesson can be retracted');
    if ((d.verdict === 'promote' || d.verdict === 'reject') && cur.state !== 'candidate') throw new GraduationError(`entry ${id} is ${cur.state}, not a candidate`);
    const decision = { by: d.by, verdict: d.verdict, rationale: d.rationale, at: this.now() };
    const kind = d.verdict === 'promote' ? 'lesson.graduated' : d.verdict === 'reject' ? 'lesson.rejected' : 'lesson.retracted';
    await this.emit(kind, { id, decision: decision as unknown as Json });
    const state = d.verdict === 'promote' ? 'active' : d.verdict === 'reject' ? 'rejected' : 'retracted';
    const next: MemoryEntry = { ...cur, state, decisions: [...cur.decisions, decision] };
    this.entries.set(id, next);
    return next;
  }

  /** Active entries ranked by salience × (floor + (1 - floor) × relevance). */
  recall(q: { query: string; tiers?: Tier[]; k: number }): Array<{ entry: MemoryEntry; score: number }> {
    const now = this.now();
    return [...this.entries.values()]
      .filter((e) => e.state === 'active' && (!q.tiers || q.tiers.includes(e.tier)))
      .map((entry) => ({ entry, score: salience(entry, now) * (RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * relevance(entry.content, q.query)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, q.k);
  }

  /** Always-on slots first (never dropped), then lessons and episodes by score until the budget is spent. */
  assembleContext(q: { query: string; alwaysOn?: Record<string, Binding>; kLessons?: number; kEpisodes?: number }): { inputs: Record<string, Binding>; tokens: number; dropped: string[] } {
    const inputs: Record<string, Binding> = {};
    let tokens = 0;
    const dropped: string[] = [];
    const cost = (b: Binding): number => (b.kind === 'handle' ? 8 : Math.ceil(JSON.stringify(b.value).length / 4));
    for (const [name, b] of Object.entries(q.alwaysOn ?? {})) {
      inputs[name] = b;
      tokens += cost(b);
    }
    const lessons = this.recall({ query: q.query, tiers: ['semantic'], k: q.kLessons ?? 8 }).map((r) => r.entry.content);
    const episodes = this.recall({ query: q.query, tiers: ['episodic'], k: q.kEpisodes ?? 5 }).map((r) => `${r.entry.kind}: ${r.entry.content}`);
    const tryPut = (name: string, value: Json): void => {
      const b: Binding = { kind: 'value', value, provenance: { src: `memory:${name}`, trust: 'trusted' } };
      const c = cost(b);
      if (tokens + c > this.opts.budgetTokens) dropped.push(name);
      else {
        inputs[name] = b;
        tokens += c;
      }
    };
    if (lessons.length) tryPut('lessons', lessons);
    if (episodes.length) tryPut('episodes', episodes);
    return { inputs, tokens, dropped };
  }

  render(tier: Tier): string {
    const lines = this.all(tier).map((e) => `- ${e.content} <!-- id=${e.id} status=${e.state} -->`);
    return `# ${tier}\n\n${lines.join('\n') || '- (empty)'}\n`;
  }

  private async emit(kind: TeceraEvent['kind'], payload: Record<string, Json>): Promise<void> {
    await this.ledger.append(event(kind, { id: this.ids(), at: this.now(), actor: this.actor, payload, runId: this.opts.runId }));
  }
}
