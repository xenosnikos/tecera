import { MANDATORY_HOOKS, SECRET_PATTERNS, stringLeaves, type AttemptFingerprint, type Effect, type Hook, type HookDescriptor, type Json, type Manifest, type SpanEvent } from '@tecera/contracts';
import { matchesAny, pathProblem } from '../glob.js';
import { MERGE_ACTIONS, PR_GATE_ACTIONS, classify, type PermissionsDoc } from '../permissions.js';
import { BudgetPool, IterationLimit, RecursionLimit } from './limits.js';
import { ProgressCheck } from './progress.js';

/**
 * The fourteen mandatory hooks. A manifest that does not list exactly these does not parse; a worker
 * started without all of them refuses to run. Several gate-level hooks (diffBoundary, foreignReview,
 * verifyGate, tamperCheck, progressCheck) act at the Commit step in the loop; their hook form records
 * their presence at Invoke/Enter so the governance record is complete.
 */

export class MissingMandatoryHooks extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(`mandatory hooks missing: ${missing.join(', ')}`);
    this.name = 'MissingMandatoryHooks';
  }
}

export function assertMandatory(hooks: readonly Hook[], m: Manifest): void {
  const have = new Set(hooks.filter((h) => h.mandatory).map((h) => h.id));
  const missing = [...new Set([...MANDATORY_HOOKS, ...m.hooks.mandatory])].filter((h) => !have.has(h));
  if (missing.length) throw new MissingMandatoryHooks(missing);
}

function simple(id: string, spans: SpanEvent['span'][], handle: (e: SpanEvent, view: Parameters<Hook['handle']>[1]) => Effect[], config: Record<string, Json> = {}): Hook {
  return { id, mandatory: true, spans: new Set(spans), handle, describe: (): HookDescriptor => ({ id, mandatory: true, config }) };
}

const toolCallInput = (e: SpanEvent) => e.input as { tool?: string; method?: string; args?: Json[]; path?: string };

/** A file write on the work branch (the protectedPaths hook decides where it may land). */
const isWrite = (tool: string | undefined, method: string | undefined): boolean => tool === 'edit' || method === 'write' || method === 'edit';

export interface MandatoryDeps {
  permissions: PermissionsDoc;
  /** Secret values resolved by the supervisor; the canary aborts if any appears in an input or output. */
  secretValues?: readonly string[];
  /**
   * progressCheck source: the candidate fingerprint (latest verify D1) each attempt of the intention
   * produced, and the current attempt. Two attempts with an equal fingerprint abort 'policy' (no progress).
   */
  /** Candidate history with the worker execution that produced each (preferred over fingerprintOf; ADV-8). */
  progressHistory?: () => AttemptFingerprint[];
  fingerprintOf?: (attempt: number) => string | null | undefined;
  attempt?: () => number;
}

export function mandatoryHooks(m: Manifest, deps: MandatoryDeps): Hook[] {
  const secrets = (deps.secretValues ?? []).filter((s) => s.length >= 8);
  const leaks = (v: Json): string | null => {
    for (const leaf of stringLeaves(v)) {
      for (const p of SECRET_PATTERNS) if (p.re.test(leaf.value)) return `${p.kind} pattern at ${leaf.path}`;
      for (const s of secrets) if (leaf.value.includes(s)) return `secret value at ${leaf.path}`;
    }
    return null;
  };

  return [
    new BudgetPool({ usd: m.budgets.usd, tokens: m.budgets.tokens, calls: 200, wallMs: m.budgets.wallClockSec * 1000 }, undefined, { enforce: m.budgets.enforce === true }),
    new RecursionLimit(m.budgets.maxDepth),
    new IterationLimit(m.budgets.maxIterations),

    simple('toolAllowlist', ['ToolCall'], (e, view) => {
      if (e.stage !== 'Enter') return [];
      const { tool } = toolCallInput(e);
      if (!tool || !view.capabilities.tools.includes(tool)) return [{ type: 'Abort', code: 'allowlist', reason: `tool ${tool ?? '<none>'} is not in the capability set` }];
      if (classify(tool, deps.permissions) === 'never') return [{ type: 'Abort', code: 'policy', reason: `tool ${tool} is never allowed` }];
      return [];
    }),

    simple('protectedPaths', ['ToolCall'], (e, view) => {
      if (e.stage !== 'Enter') return [];
      const { tool, method, path } = toolCallInput(e);
      if (!path) return [];
      const problem = pathProblem(path);
      if (problem) return [{ type: 'Abort', code: 'protected', reason: `${problem}: ${path}` }];
      const writes = method === 'write' || method === 'edit' || method === 'delete' || tool === 'edit';
      const prot = matchesAny(path, view.capabilities.paths.protected);
      if (prot && writes) return [{ type: 'Abort', code: 'protected', reason: `${path} is protected by ${prot}` }];
      if (writes && !matchesAny(path, view.capabilities.paths.write)) return [{ type: 'Abort', code: 'protected', reason: `${path} is outside the write allowlist` }];
      if (!writes && view.capabilities.paths.read.length && !matchesAny(path, view.capabilities.paths.read)) return [{ type: 'Abort', code: 'protected', reason: `${path} is outside the read allowlist` }];
      return [];
    }, { protectedPaths: m.policy.protectedPaths }),

    simple('diffBoundary', ['Invoke'], () => [], { allowedChanges: m.repo.allowedChanges }),

    simple('approvalGate', ['ToolCall'], (e) => {
      if (e.stage !== 'Send') return [];
      const { tool, method } = toolCallInput(e);
      const action = method && method !== 'call' ? `${tool}_${method}` : (tool ?? '');
      const names = [action, method ?? '', tool ?? ''].filter((a) => a !== '');
      // D6: merging is never done; pushing and opening a PR happen only at the gate.pr step, on the human
      // approval it consumes — a worker can neither do them nor hold an approval for them.
      const merge = names.find((a) => MERGE_ACTIONS.has(a));
      if (merge) return [{ type: 'Abort', code: 'policy', reason: `${merge}: Tecera never merges` }];
      const pr = names.find((a) => PR_GATE_ACTIONS.has(a));
      if (pr) return [{ type: 'Abort', code: 'policy', reason: `${pr} happens only at the gate.pr step, on its human approval` }];
      // D6: writes inside allowedChanges on the leased work branch need no approval under any isolation; the
      // protectedPaths hook, the write guard and the tamper/diff gates confine them.
      if (isWrite(tool, method)) return [];
      // Most specific name first: tool_method, then the method alone, then the tool.
      const cls = names.map((a) => classify(a, deps.permissions)).find((c) => c !== undefined);
      if (cls === 'requiresApproval') {
        const requestId = `ap_${e.run.runId}_${e.spanId}`;
        return [{ type: 'Suspend', request: { requestId, action, actionHash: (e.input as { actionHash?: string }).actionHash ?? e.spanId, reason: `${action} requires approval`, requester: 'worker' } }];
      }
      return [];
    }, { requiresApproval: m.policy.approvals.required }),

    simple('foreignReview', ['Invoke'], () => [], { reviewer: m.seats.reviewer.provider, foreign: true }),
    simple('verifyGate', ['Invoke'], () => [], { command: m.verify.command }),
    simple('tamperCheck', ['Invoke'], () => [], {}),
    new ProgressCheck({ ...(deps.progressHistory ? { history: deps.progressHistory } : {}), ...(deps.fingerprintOf ? { fingerprintOf: deps.fingerprintOf } : {}), ...(deps.attempt ? { attempt: deps.attempt } : {}) }),

    simple('secretCanary', ['Invoke', 'LLMQuery', 'ToolCall'], (e) => {
      if (e.stage === 'Enter') {
        const hit = leaks(e.input as Json);
        if (hit) return [{ type: 'Abort', code: 'policy', reason: `secret canary tripped on input: ${hit}` }];
      }
      if (e.stage === 'Complete' && e.output) {
        const hit = leaks(e.output as Json);
        if (hit) return [{ type: 'Abort', code: 'policy', reason: `secret canary tripped on output: ${hit}` }];
      }
      return [];
    }),

    simple('evidenceRecorder', ['Invoke', 'LLMQuery', 'REPLExec', 'ToolCall'], (e, view) => {
      if (e.span === 'Invoke' && e.stage === 'Enter') {
        return [{ type: 'AppendEvidence', key: `hooks:${e.run.runId}:${e.run.invokeId}`, kind: 'governance', body: view.hooks as unknown as Json }];
      }
      if (e.stage === 'Exit') {
        return [{ type: 'AppendEvidence', key: `span:${e.run.runId}:${e.spanId}:${e.attempt}`, kind: `span.${e.span}`, body: { outcome: e.outcome ?? null, input: e.input, output: e.output ?? null } }];
      }
      return [];
    }),

    simple('returnSchema', ['Invoke'], (e) => {
      if (e.stage !== 'Complete') return [];
      const out = e.output as { kind?: string; value?: Json } | undefined;
      if (out?.kind === 'returned' && (out.value === undefined || out.value === null)) return [{ type: 'Abort', code: 'schema', reason: 'worker returned nothing' }];
      return [];
    }),
  ];
}
