import { isWritingStep, statedEnvelope, unexpectedChanges, type ChangePath, type PathChange, type StatedEnvelope } from '@tecera/contracts';
import type { Candidate } from './candidate.js';
import type { StepContext } from './types.js';

/**
 * The change-path envelope at the gates: the final candidate against what the requestor accepted.
 *
 * The envelope is the accepted contract's. When the contract states none but every writing step of the plan
 * declared its change paths, the union of those declarations is the envelope (the plan narrowed
 * repo.allowedChanges for itself). Otherwise none was stated and repo.allowedChanges alone applies, as it
 * always did (the commit gate's boundary check); that is recorded as source 'manifest'.
 *
 * Unexpected paths refuse the candidate deterministically at verify and at commit: no review verdict
 * changes that. The review packet lists them, with the criteria and the envelope, for the reviewer to see.
 */

export interface EnvelopeView {
  source: 'contract' | 'plan' | 'manifest';
  /** The stated entries (empty for 'manifest'). */
  entries: ChangePath[];
  /** Candidate paths outside the envelope (always empty for 'manifest'). */
  unexpected: PathChange[];
}

/** The envelope stated for a whole candidate (see above), or null. */
export function candidateEnvelope(ctx: Pick<StepContext, 'contract' | 'plan'>): { source: 'contract' | 'plan'; env: StatedEnvelope } | null {
  const fromContract = statedEnvelope(ctx.contract ?? null, null);
  if (fromContract) return { source: 'contract', env: fromContract };
  const writers = ctx.plan.steps.filter((s) => isWritingStep(ctx.plan, s));
  if (!writers.length || !writers.every((s) => Array.isArray(s.changes) && s.changes.length)) return null;
  return { source: 'plan', env: { source: 'step', layers: [writers.flatMap((s) => s.changes!)] } };
}

/** Every committable change of the candidate as a path and its operation against the base. Ignored files are the commit gate's. */
export function candidateChanges(snap: Candidate): PathChange[] {
  const out: PathChange[] = [];
  for (const f of snap.files) {
    if (f.status === 'A') out.push({ path: f.path, op: 'create' });
    else if (f.status === 'M') out.push({ path: f.path, op: 'modify' });
    else if (f.status === 'D') out.push({ path: f.path, op: 'delete' });
  }
  return out;
}

export function envelopeView(ctx: Pick<StepContext, 'contract' | 'plan'>, snap: Candidate): EnvelopeView {
  const stated = candidateEnvelope(ctx);
  if (!stated) return { source: 'manifest', entries: [], unexpected: [] };
  return { source: stated.source, entries: stated.env.layers.flat(), unexpected: unexpectedChanges(stated.env, candidateChanges(snap)) };
}
