import { Brain } from '@tecera/brain';
import type { Ledger, Redactor, TeceraEvent } from '@tecera/contracts';

/**
 * The production writer of episodic memory and candidate lessons: a deterministic projection of a run's
 * ledger, with no model call.
 *
 * - One episode per `step.completed`, per `step.failed` and per `run.ended` (each run segment's outcome).
 *   Its content is a short summary (goal, step, outcome, the recorded reason), redacted and cut to
 *   MAX_EPISODE_CHARS; its provenance names the source event.
 * - One candidate lesson per verified recovery: a `verify.passed` of a goal that had at least one
 *   `step.failed` since the goal's previous `verify.passed`. It cites the failures' episodes.
 *
 * Every write is keyed by its source event (brain `source`, ledger idempotency key), so projecting the same
 * run again, after a reload or a resume, writes nothing new. finish() and the resume path both call it, so
 * an interrupted run loses no learning: the next segment repairs it. A candidate is only a candidate: it is
 * retrievable once a human graduates it (`tecera memory graduate`), and even then it reaches a worker as
 * untrusted data.
 */

export const MAX_EPISODE_CHARS = 400;
/** At most this many new entries per projection (a pathological run cannot flood memory). */
export const MAX_ENTRIES_PER_PROJECTION = 500;

const LEARNER = { kind: 'system' as const, id: 'runtime.learning' };

export interface LearningResult {
  episodes: number;
  candidates: number;
  /** Lines for the run's notes (empty when nothing was written). */
  notes: string[];
}

/** Flatten, redact, then cut: a cut never leaves part of a secret behind. */
function line(text: string, redactor: Redactor, max = MAX_EPISODE_CHARS): string {
  return redactor.redactText(text.replace(/\s+/g, ' ').trim(), { maxChars: max });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function episodeOf(e: TeceraEvent, redactor: Redactor): { kind: string; content: string; pain: number } | null {
  const p = e.payload as Record<string, unknown>;
  const where = `goal ${e.trace.goalId ?? '-'} step ${e.trace.stepId ?? str(p.step) ?? '-'}`;
  if (e.kind === 'step.completed') {
    const r = p.result as Record<string, unknown> | undefined;
    const outcome = str(r?.outcome) ?? str(r?.kind);
    return { kind: 'step.completed', content: line(`${where} completed${outcome ? ` (${outcome})` : ''}`, redactor), pain: 2 };
  }
  if (e.kind === 'step.failed') {
    const reason = str(p.reason) ?? 'no reason recorded';
    return { kind: 'step.failed', content: line(`${where} failed${p.terminal === true ? ' (terminal)' : ''}: ${reason}`, redactor), pain: 6 };
  }
  if (e.kind === 'run.ended') {
    const code = typeof p.exitCode === 'number' ? p.exitCode : null;
    const reason = str(p.reason);
    return { kind: 'run.outcome', content: line(`run ended with exit ${code ?? 'unknown'}${reason ? `: ${reason}` : ''}`, redactor), pain: code === 0 ? 2 : 5 };
  }
  return null;
}

/** Project `runId`'s ledger into episodes and candidate lessons. Never throws: a failure becomes a note. */
export async function recordRunLearning(ledger: Ledger, runId: string, o: { redactor: Redactor; now: () => number }): Promise<LearningResult> {
  const out: LearningResult = { episodes: 0, candidates: 0, notes: [] };
  try {
    const brain = await Brain.load(ledger, { runId, budgetTokens: 0, now: o.now, actor: LEARNER });
    const known = new Set(brain.all().map((x) => x.id));
    const events: TeceraEvent[] = [];
    for await (const e of ledger.events({ runId, kinds: ['step.completed', 'step.failed', 'verify.passed', 'run.ended'] })) events.push(e);
    let budget = MAX_ENTRIES_PER_PROJECTION;
    /** goal → episode ids (and summaries) of the failures since its last verified pass. */
    const pending = new Map<string, Array<{ episode: string; content: string }>>();
    for (const e of events) {
      if (budget <= 0) {
        out.notes.push(`learning  stopped after ${MAX_ENTRIES_PER_PROJECTION} new entries`);
        break;
      }
      if (e.kind === 'verify.passed') {
        const g = e.trace.goalId;
        const failures = g ? pending.get(g) : undefined;
        if (!g || !failures?.length) continue;
        pending.delete(g);
        const content = line(`goal ${g}: after ${failures.length} failed attempt(s), a later attempt passed verification. First failure: ${failures[0]!.content}`, o.redactor);
        const c = await brain.stage({ content, sourceEpisodes: failures.map((f) => f.episode), pain: 6, source: e.id });
        if (!known.has(c.id)) {
          known.add(c.id);
          out.candidates++;
          budget--;
        }
        continue;
      }
      const ep = episodeOf(e, o.redactor);
      if (!ep) continue;
      const entry = await brain.record({ kind: ep.kind, content: ep.content, pain: ep.pain, provenance: { runId }, source: e.id });
      if (!known.has(entry.id)) {
        known.add(entry.id);
        out.episodes++;
        budget--;
      }
      if (e.kind === 'step.failed' && e.trace.goalId) pending.set(e.trace.goalId, [...(pending.get(e.trace.goalId) ?? []), { episode: entry.id, content: entry.content }]);
    }
    if (out.episodes || out.candidates) out.notes.push(`learning  ${out.episodes} episode(s), ${out.candidates} candidate lesson(s) recorded (a lesson is used only after \`tecera memory graduate\`)`);
  } catch (err) {
    out.notes.push(`learning  projection failed (${line(err instanceof Error ? err.message : String(err), o.redactor, 200)}); the next resume repeats it`);
  }
  return out;
}
