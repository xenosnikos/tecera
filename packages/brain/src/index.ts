import { randomUUID } from 'node:crypto';
import { event, type Binding, type Json, type Ledger, type MemoryEntry, type Principal, type TeceraEvent } from '@tecera/contracts';

/**
 * Four memory tiers as views over the ledger (agentic-stack port). Episodes are evidence written by
 * the runtime; lessons enter semantic memory only through staging and human graduation with a rationale;
 * retraction is append-only. Retrieval is salience × relevance under a token budget; always-on slots
 * (personal preferences, working state) are never dropped.
 *
 * Replay admits only what the live methods could have written: `evidence.appended` brings in a validated
 * episodic entry and nothing else; `lesson.staged` creates a semantic candidate whatever state or decisions
 * the payload claims; graduate, reject and retract apply only to an existing lesson, only from the state the
 * live state machine allows, only as the decision of the human who is the event's actor, with a non-empty
 * rationale. An id seen once is never overwritten, and an entry with a `source` (the ledger event it was
 * projected from) exists at most once per tier. Everything memory hands a worker is untrusted data:
 * graduation makes a lesson retrievable, not authoritative.
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

/** Bounds on what an entry may hold (live writes are refused past them; replay ignores them). */
export const MAX_MEMORY_CONTENT = 2000;
const MAX_ID = 128;
const KIND_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const PROVENANCE_KEYS = ['runId', 'hookId', 'evidenceKey', 'commitSha', 'source'] as const;

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
  /** Entry and event ids. Default: random UUIDs. */
  ids?: () => string;
  actor?: Principal;
}

type Verdict = 'promote' | 'reject' | 'retract';
const DECISION_KIND: Record<Verdict, TeceraEvent['kind']> = { promote: 'lesson.graduated', reject: 'lesson.rejected', retract: 'lesson.retracted' };
const VERDICT_OF: Partial<Record<TeceraEvent['kind'], Verdict>> = { 'lesson.graduated': 'promote', 'lesson.rejected': 'reject', 'lesson.retracted': 'retract' };
const STATE_AFTER: Record<Verdict, MemoryEntry['state']> = { promote: 'active', reject: 'rejected', retract: 'retracted' };
/** The one state each decision may start from: a candidate is promoted or rejected, an active lesson retracted. */
const STATE_BEFORE: Record<Verdict, MemoryEntry['state']> = { promote: 'candidate', reject: 'candidate', retract: 'active' };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const goodId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const goodText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_MEMORY_CONTENT;
const score10 = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(10, Math.max(0, v)) : dflt);

function cleanProvenance(v: unknown, runId: string | undefined): MemoryEntry['provenance'] {
  const out: MemoryEntry['provenance'] = {};
  if (isObj(v)) for (const k of PROVENANCE_KEYS) if (typeof v[k] === 'string' && (v[k] as string).length <= 4000) out[k] = v[k] as string;
  if (!out.runId && runId) out.runId = runId;
  return out;
}

/** An `evidence.appended` payload entry as replay admits it: episodic, active, no decisions, bounded. Else null. */
export function admitEpisode(raw: unknown, e: Pick<TeceraEvent, 'at' | 'runId'>): MemoryEntry | null {
  if (!isObj(raw) || raw.tier !== 'episodic' || raw.state !== 'active') return null;
  if (!goodId(raw.id) || typeof raw.kind !== 'string' || !KIND_RE.test(raw.kind) || !goodText(raw.content)) return null;
  if (!Array.isArray(raw.decisions) || raw.decisions.length !== 0) return null;
  const s = isObj(raw.salience) ? raw.salience : {};
  return {
    id: raw.id,
    tier: 'episodic',
    kind: raw.kind,
    content: raw.content,
    provenance: cleanProvenance(raw.provenance, e.runId),
    salience: { createdAt: typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : e.at, pain: score10(s.pain, 2), importance: score10(s.importance, 5), recurrence: 1 },
    state: 'active',
    decisions: [],
  };
}

/** A `lesson.staged` payload entry as replay admits it: always a semantic candidate with no decisions. Else null. */
export function admitCandidate(raw: unknown, e: Pick<TeceraEvent, 'at' | 'runId'>): MemoryEntry | null {
  if (!isObj(raw) || !goodId(raw.id) || !goodText(raw.content)) return null;
  const s = isObj(raw.salience) ? raw.salience : {};
  return {
    id: raw.id,
    tier: 'semantic',
    kind: 'lesson',
    content: raw.content,
    provenance: cleanProvenance(raw.provenance, e.runId),
    salience: { createdAt: typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : e.at, pain: score10(s.pain, 5), importance: score10(s.importance, 5), recurrence: 1 },
    state: 'candidate',
    decisions: [],
  };
}

export class Brain {
  private readonly entries = new Map<string, MemoryEntry>();
  /** `${tier}:${source}` → the entry id that source produced (or raised, for a repeated lesson). */
  private readonly sources = new Map<string, string>();
  /** Every entry id a memory event has carried, admitted or not: an id is used once. */
  private readonly seen = new Set<string>();
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly actor: Principal;

  constructor(private readonly ledger: Ledger, private readonly opts: BrainOptions) {
    this.now = opts.now ?? Date.now;
    this.ids = opts.ids ?? (() => randomUUID());
    this.actor = opts.actor ?? { kind: 'system', id: 'brain' };
  }

  /** Rebuild the tiers from the log: evidence.appended (episodes) and lesson.* events, under the admission rules. */
  static async load(ledger: Ledger, opts: BrainOptions): Promise<Brain> {
    const b = new Brain(ledger, opts);
    await b.replay();
    return b;
  }

  private async replay(): Promise<void> {
    this.entries.clear();
    this.sources.clear();
    this.seen.clear();
    for await (const e of this.ledger.events({ kinds: ['evidence.appended', 'lesson.staged', 'lesson.graduated', 'lesson.rejected', 'lesson.retracted'] })) this.apply(e);
  }

  apply(e: TeceraEvent): void {
    const p = e.payload as { entry?: unknown; id?: unknown; decision?: unknown };
    if (e.kind === 'evidence.appended') {
      if (p.entry === undefined) return; // other evidence (not memory)
      const entry = admitEpisode(p.entry, e);
      if (entry && !this.seen.has(entry.id) && !this.hasSource(entry)) this.admit(entry);
      if (entry) this.seen.add(entry.id);
      return;
    }
    if (e.kind === 'lesson.staged') {
      const entry = admitCandidate(p.entry, e);
      if (!entry || this.seen.has(entry.id) || this.hasSource(entry)) return;
      this.seen.add(entry.id);
      const dup = this.duplicateLesson(entry.content);
      if (!dup) return this.admit(entry);
      this.entries.set(dup.id, { ...dup, salience: { ...dup.salience, recurrence: dup.salience.recurrence + 1 } });
      if (entry.provenance.source) this.sources.set(`semantic:${entry.provenance.source}`, dup.id);
      return;
    }
    const verdict = VERDICT_OF[e.kind];
    if (!verdict || !goodId(p.id)) return;
    const cur = this.entries.get(p.id);
    if (!cur || cur.tier !== 'semantic' || cur.state !== STATE_BEFORE[verdict]) return;
    const d = p.decision;
    if (!isObj(d) || d.verdict !== verdict || typeof d.rationale !== 'string' || !d.rationale.trim() || typeof d.at !== 'number' || !Number.isFinite(d.at)) return;
    const by = d.by;
    // the decider is a human and is the event's own actor
    if (!isObj(by) || by.kind !== 'human' || !goodId(by.id) || e.actor.kind !== 'human' || e.actor.id !== by.id) return;
    const decision = { by: { kind: 'human' as const, id: by.id }, verdict, rationale: d.rationale, at: d.at };
    this.entries.set(cur.id, { ...cur, state: STATE_AFTER[verdict], decisions: [...cur.decisions, decision] });
  }

  private admit(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    if (entry.provenance.source) this.sources.set(`${entry.tier}:${entry.provenance.source}`, entry.id);
  }

  private hasSource(entry: Pick<MemoryEntry, 'tier' | 'provenance'>): boolean {
    return !!entry.provenance.source && this.sources.has(`${entry.tier}:${entry.provenance.source}`);
  }

  private duplicateLesson(content: string): MemoryEntry | undefined {
    return [...this.entries.values()].find((x) => x.tier === 'semantic' && x.content.trim() === content.trim() && x.state !== 'retracted');
  }

  private bySource(tier: Tier, source: string): MemoryEntry | undefined {
    const id = this.sources.get(`${tier}:${source}`);
    return id === undefined ? undefined : this.entries.get(id);
  }

  all(tier?: Tier): MemoryEntry[] {
    return [...this.entries.values()].filter((e) => !tier || e.tier === tier);
  }

  /**
   * Record an episode (what happened). Written as evidence. With `source` (the ledger event it describes) the
   * write is idempotent: a second record of the same source returns the first entry and writes nothing.
   */
  async record(e: { kind: string; content: string; pain?: number; importance?: number; provenance?: MemoryEntry['provenance']; source?: string }): Promise<MemoryEntry> {
    if (!KIND_RE.test(e.kind)) throw new GraduationError(`episode kind ${JSON.stringify(e.kind.slice(0, 40))} is not a lowercase identifier`);
    if (!goodText(e.content)) throw new GraduationError(`an episode needs content of 1 to ${MAX_MEMORY_CONTENT} characters`);
    const source = e.source ?? e.provenance?.source;
    if (source) {
      const seen = this.bySource('episodic', source);
      if (seen) return seen;
    }
    const entry: MemoryEntry = {
      id: this.ids(),
      tier: 'episodic',
      kind: e.kind,
      content: e.content,
      provenance: { ...(e.provenance ?? { runId: this.opts.runId }), ...(source ? { source } : {}) },
      salience: { createdAt: this.now(), pain: score10(e.pain, 2), importance: score10(e.importance, 5), recurrence: 1 },
      state: 'active',
      decisions: [],
    };
    const r = await this.emit('evidence.appended', { entry: entry as unknown as Json }, source ? `memory.episode:${source}` : undefined);
    if (r.duplicate && source) return this.reread('episodic', source, entry);
    this.seen.add(entry.id);
    this.admit(entry);
    return entry;
  }

  /**
   * Stage a candidate lesson (mechanical; no judgment). The same content again raises the existing lesson's
   * recurrence, recorded as another lesson.staged so a reload sees it too. With `source` the write is
   * idempotent per source.
   */
  async stage(c: { content: string; sourceEpisodes: string[]; pain?: number; importance?: number; source?: string }): Promise<MemoryEntry> {
    if (!goodText(c.content)) throw new GraduationError(`a lesson needs content of 1 to ${MAX_MEMORY_CONTENT} characters`);
    if (c.source) {
      const seen = this.bySource('semantic', c.source);
      if (seen) return seen;
    }
    const entry: MemoryEntry = {
      id: this.ids(),
      tier: 'semantic',
      kind: 'lesson',
      content: c.content,
      provenance: { runId: this.opts.runId, evidenceKey: c.sourceEpisodes.join(','), ...(c.source ? { source: c.source } : {}) },
      salience: { createdAt: this.now(), pain: score10(c.pain, 5), importance: score10(c.importance, 5), recurrence: 1 },
      state: 'candidate',
      decisions: [],
    };
    const r = await this.emit('lesson.staged', { entry: entry as unknown as Json }, c.source ? `lesson.staged:${c.source}` : undefined);
    if (r.duplicate && c.source) return this.reread('semantic', c.source, entry);
    // the live projection takes the path replay takes (a repeated content raises the existing lesson)
    this.apply({ id: entry.id, kind: 'lesson.staged', at: entry.salience.createdAt, actor: this.actor, trace: {}, runId: this.opts.runId, payload: { entry: entry as unknown as Json } });
    return this.entries.get(entry.id) ?? this.duplicateLesson(entry.content) ?? entry;
  }

  /** Only a human with a non-empty rationale can promote, reject or retract. Rejections keep history. */
  async graduate(id: string, d: { by: Principal; verdict: Verdict; rationale: string }): Promise<MemoryEntry> {
    const cur = this.entries.get(id);
    if (!cur) throw new GraduationError(`unknown memory entry ${id}`);
    if (cur.tier !== 'semantic') throw new GraduationError(`entry ${id} is ${cur.tier}, not a lesson`);
    if (d.by.kind !== 'human') throw new GraduationError('only a human principal can graduate, reject or retract');
    if (!d.rationale.trim()) throw new GraduationError('a rationale is required');
    if (d.verdict === 'retract' && cur.state !== 'active') throw new GraduationError('only an active lesson can be retracted');
    if ((d.verdict === 'promote' || d.verdict === 'reject') && cur.state !== 'candidate') throw new GraduationError(`entry ${id} is ${cur.state}, not a candidate`);
    const decision = { by: d.by, verdict: d.verdict, rationale: d.rationale, at: this.now() };
    // The decider is the event's actor: replay admits a decision only from the human it names.
    await this.emit(DECISION_KIND[d.verdict], { id, decision: decision as unknown as Json }, undefined, d.by);
    const next: MemoryEntry = { ...cur, state: STATE_AFTER[d.verdict], decisions: [...cur.decisions, decision] };
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

  /**
   * Always-on slots first (never dropped), then lessons and episodes by score until the budget is spent.
   * Lessons and episodes are untrusted data for the worker (wrapped as such), whoever graduated them.
   */
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
      const b: Binding = { kind: 'value', value, provenance: { src: `memory:${name}`, trust: 'untrusted' } };
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

  /** Another writer recorded this source first: re-read the log and return its entry. */
  private async reread(tier: Tier, source: string, fallback: MemoryEntry): Promise<MemoryEntry> {
    await this.replay();
    return this.bySource(tier, source) ?? fallback;
  }

  private async emit(kind: TeceraEvent['kind'], payload: Record<string, Json>, idemKey?: string, actor: Principal = this.actor): Promise<{ duplicate: boolean }> {
    const r = await this.ledger.append(event(kind, { id: this.ids(), at: this.now(), actor, payload, runId: this.opts.runId, ...(idemKey ? { idemKey } : {}) }));
    return { duplicate: r.duplicate === true };
  }
}
