import { readFileSync } from 'node:fs';
import { parseManifest, type AchievementGoal, type Belief, type BeliefProjection, type Json, type LLM, type LLMRequest, type LLMResponse, type Manifest, type TeceraEvent } from '@tecera/contracts';
import { parsePermissions, type PermissionsDoc } from '@tecera/policy';
import type { PlanDocumentInput } from './schema.js';

/** Shared test fixtures: the sample manifest/permissions, a goal, an event, beliefs and a fake LLM. */

const sample = (rel: string) => new URL(`../../../samples/fix-failing-test/${rel}`, import.meta.url);

/**
 * The sample files belong to another lane and may still predate owner decision D6 (2026-10-05). Both
 * readers apply the D6 migration, which is a no-op once the sample is updated: 'commit' leaves
 * policy.approvals.required (the manifest adds 'open_pr' itself) and moves from requiresApproval to always
 * in permissions.json, where 'open_pr' requires approval and 'git_push' requires approval instead of never.
 */
export function sampleManifest(): Manifest {
  const raw = JSON.parse(readFileSync(sample('tecera.json'), 'utf8')) as { policy?: { approvals?: { required?: string[] } } };
  const req = raw.policy?.approvals?.required;
  if (Array.isArray(req)) raw.policy!.approvals!.required = req.filter((a) => a !== 'commit');
  return parseManifest(raw);
}

export function samplePermissions(): PermissionsDoc {
  const raw = JSON.parse(readFileSync(sample('.tecera/protocols/permissions.json'), 'utf8')) as { always?: string[]; requiresApproval?: string[]; never?: string[] };
  const without = (xs: string[] | undefined, drop: string[]) => (xs ?? []).filter((x) => !drop.includes(x));
  const always = [...new Set([...without(raw.always, []), 'commit'])];
  const requiresApproval = [...new Set([...without(raw.requiresApproval, ['commit']), 'open_pr', 'git_push'])];
  const never = [...new Set([...without(raw.never, ['git_push']), 'merge'])];
  return parsePermissions({ always, requiresApproval, never });
}

export const goal: AchievementGoal = {
  id: 'fix-failing-test',
  statement: 'Make the failing test in this repository pass by fixing the implementation. Do not modify tests, configs, or lockfiles.',
  check: { command: 'node --test', timeoutSec: 300 },
  commitment: 'single-minded',
  budget: { usd: 2, wallClockSec: 1200 },
  status: 'open',
  evidence: [],
};

export const adopted: TeceraEvent = {
  id: 'e1',
  kind: 'goal.adopted',
  at: 1,
  actor: { kind: 'system', id: 'loop' },
  runId: 'r1',
  trace: { goalId: goal.id },
  payload: { goal: goal as unknown as Json },
};

export class FakeBeliefs implements BeliefProjection {
  constructor(private readonly list: Belief[] = []) {}
  get(key: string) {
    return this.list.find((b) => b.key === key);
  }
  all() {
    return [...this.list];
  }
  match(p: { key: string; equals?: Json; exists?: boolean }) {
    const b = this.get(p.key);
    if (p.exists === false) return !b;
    if (!b) return false;
    return p.equals === undefined || JSON.stringify(b.value) === JSON.stringify(p.equals);
  }
}

export const belief = (key: string, value: Json, trust: 'trusted' | 'untrusted' = 'untrusted'): Belief => ({
  id: `b_${key}`,
  key,
  value,
  provenance: { src: 'tool:readFile', trust },
  at: 1,
});

/** A plan document that passes every check against the sample manifest. */
export function goodDoc(): PlanDocumentInput {
  return {
    steps: [
      { id: 'analyze', kind: 'worker', dependsOn: [], instruction: 'read the failing test', tools: ['read', 'listFiles', 'runVerify'] },
      { id: 'edit', kind: 'worker', dependsOn: ['analyze'], instruction: 'fix src' },
      { id: 'verify', kind: 'gate.verify', dependsOn: ['edit'] },
      { id: 'review', kind: 'gate.review', dependsOn: ['verify'] },
      { id: 'verify2', kind: 'gate.verify', dependsOn: ['review'] },
      { id: 'commit', kind: 'gate.commit', dependsOn: ['verify2'] },
      { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'] },
    ],
    allowedModels: { analyze: ['worker'], edit: ['worker'] },
    permissions: { tools: ['read', 'listFiles', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] },
    budget: { usd: 1, tokens: 100000, wallClockSec: 900 },
    goalKinds: ['fix-failing-test'],
    rationale: 'read, edit, gates',
  };
}

export type Scripted = string | Partial<LLMResponse> | Error;

/** Returns scripted responses in order; records every request. */
export class FakeLLM implements LLM {
  readonly id = 'fake';
  readonly provider = 'fake';
  readonly requests: LLMRequest[] = [];
  constructor(private readonly script: Scripted[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)) as LLMRequest);
    const next = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    if (next instanceof Error) throw next;
    const base: LLMResponse = { content: '', usage: { inputTokens: 100, outputTokens: 50, usd: 0.001 }, model: req.model, finishReason: 'stop' };
    return typeof next === 'string' ? { ...base, content: next } : { ...base, ...next };
  }
}
