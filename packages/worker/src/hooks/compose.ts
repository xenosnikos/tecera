import type { AbortCode, CapabilitySet, Effect, Json, Limits, Stage, SuspendRequest } from '@tecera/contracts';

/**
 * Effect composition (docs/design/kernel.md §3). All hooks see one frozen event; their effects are
 * collected, then composed with explicit, order-independent rules:
 *   Abort dominates everything; Suspend beats Replace/Patch/Reserve; disjoint patches merge, identical
 *   values dedupe, a same-path conflict refuses the whole set; one distinct ReplaceOutput; restrictions
 *   intersect; reservations sum per pool; evidence keys must be unique per body; CAS conflicts refuse.
 * A refusal is itself an Abort with code 'conflict'. Effects at a stage that does not accept them are
 * hook bugs and refuse with code 'hookError'. Exit honours only AppendEvidence and BlackboardCAS.
 */

export interface Composed {
  abort?: { reasons: Array<{ code: AbortCode; reason: string; hookId: string }> };
  suspend?: SuspendRequest[];
  patchInput: Map<string, Json>;
  replaceOutput?: Json;
  patchOutput: Map<string, Json>;
  restrict?: Partial<CapabilitySet>;
  reserve: Map<keyof Limits, number>;
  evidence: Array<{ key: string; kind: string; body: Json; hookId: string }>;
  cas: Array<{ key: string; expected: Json | undefined; value: Json; hookId: string }>;
  ignored: Array<{ hookId: string; effect: Effect }>;
}

const ALLOWED: Record<Effect['type'], ReadonlySet<Stage>> = {
  PatchInput: new Set(['Enter']),
  ReplaceOutput: new Set(['Send']),
  PatchOutput: new Set(['Complete']),
  Abort: new Set(['Enter', 'Send', 'Complete', 'Retry']),
  Suspend: new Set(['Send']),
  RestrictCapabilities: new Set(['Enter']),
  ReserveBudget: new Set(['Send']),
  AppendEvidence: new Set(['Enter', 'Send', 'Complete', 'Exit', 'Retry']),
  BlackboardCAS: new Set(['Enter', 'Send', 'Complete', 'Exit', 'Retry']),
};

const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

export function composeEffects(stage: Stage, effects: Array<[hookId: string, Effect]>): Composed {
  const out: Composed = { patchInput: new Map(), patchOutput: new Map(), reserve: new Map(), evidence: [], cas: [], ignored: [] };
  const aborts: Composed['abort'] = { reasons: [] };
  const refuse = (hookId: string, reason: string, code: AbortCode = 'conflict'): void => {
    aborts.reasons.push({ code, reason, hookId });
  };

  const restrictions: Partial<CapabilitySet>[] = [];
  const replaces: Array<[string, Json]> = [];
  const evidenceBodies = new Map<string, Json>();
  const casKeys = new Map<string, string>();

  for (const [hookId, ef] of effects) {
    if (stage === 'Exit' && ef.type !== 'AppendEvidence' && ef.type !== 'BlackboardCAS') {
      out.ignored.push({ hookId, effect: ef });
      continue;
    }
    if (!ALLOWED[ef.type].has(stage)) {
      refuse(hookId, `effect ${ef.type} is not valid at stage ${stage}`, 'hookError');
      continue;
    }
    switch (ef.type) {
      case 'Abort':
        aborts.reasons.push({ code: ef.code, reason: ef.reason, hookId });
        break;
      case 'Suspend':
        (out.suspend ??= []).push(ef.request);
        break;
      case 'PatchInput': {
        const prev = out.patchInput.get(ef.path);
        if (prev !== undefined && !same(prev, ef.value)) refuse(hookId, `conflicting PatchInput at ${ef.path}`);
        else out.patchInput.set(ef.path, ef.value);
        break;
      }
      case 'PatchOutput': {
        const prev = out.patchOutput.get(ef.path);
        if (prev !== undefined && !same(prev, ef.value)) refuse(hookId, `conflicting PatchOutput at ${ef.path}`);
        else out.patchOutput.set(ef.path, ef.value);
        break;
      }
      case 'ReplaceOutput':
        replaces.push([hookId, ef.value]);
        break;
      case 'RestrictCapabilities':
        restrictions.push(ef.to);
        break;
      case 'ReserveBudget':
        out.reserve.set(ef.pool, (out.reserve.get(ef.pool) ?? 0) + ef.amount);
        break;
      case 'AppendEvidence': {
        const prev = evidenceBodies.get(ef.key);
        if (prev !== undefined && !same(prev, ef.body)) refuse(hookId, `duplicate evidence key ${ef.key} with a different body`);
        else if (prev === undefined) {
          evidenceBodies.set(ef.key, ef.body);
          out.evidence.push({ key: ef.key, kind: ef.kind, body: ef.body, hookId });
        }
        break;
      }
      case 'BlackboardCAS': {
        const owner = casKeys.get(ef.key);
        if (owner && owner !== hookId) refuse(hookId, `two hooks CAS the same blackboard key ${ef.key}`);
        else {
          casKeys.set(ef.key, hookId);
          out.cas.push({ key: ef.key, expected: ef.expected, value: ef.value, hookId });
        }
        break;
      }
    }
  }

  if (replaces.length) {
    const [first] = replaces[0]!;
    const distinct = replaces.filter(([, v]) => !same(v, replaces[0]![1]));
    if (distinct.length) refuse(first, `two distinct ReplaceOutput values`);
    else out.replaceOutput = replaces[0]![1];
  }
  if (restrictions.length) out.restrict = mergeRestrictions(restrictions);
  if (aborts.reasons.length) out.abort = aborts;
  out.evidence.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** Intersection of several partial capability sets: tools ∩, read/write ∩, protected ∪, limits min. */
export function mergeRestrictions(rs: Partial<CapabilitySet>[]): Partial<CapabilitySet> {
  const out: Partial<CapabilitySet> = {};
  const intersect = (lists: string[][]): string[] | undefined => (lists.length ? lists.reduce((a, b) => a.filter((x) => b.includes(x))) : undefined);
  const tools = intersect(rs.filter((r) => r.tools).map((r) => r.tools!));
  if (tools) out.tools = tools;
  const read = intersect(rs.filter((r) => r.paths?.read).map((r) => r.paths!.read!));
  const write = intersect(rs.filter((r) => r.paths?.write).map((r) => r.paths!.write!));
  const prot = [...new Set(rs.flatMap((r) => r.paths?.protected ?? []))];
  if (read || write || prot.length) out.paths = { read: read ?? [], write: write ?? [], protected: prot };
  const limitSets = rs.filter((r) => r.limits).map((r) => r.limits!);
  if (limitSets.length) {
    const merged: Partial<Limits> = {};
    for (const l of limitSets) {
      for (const k of Object.keys(l) as Array<keyof Limits>) {
        const v = l[k];
        if (typeof v === 'number') merged[k] = merged[k] === undefined ? v : Math.min(merged[k]!, v);
      }
    }
    out.limits = merged as Limits;
  }
  return out;
}
