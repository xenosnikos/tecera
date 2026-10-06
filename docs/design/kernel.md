# Design lens: minimal kernel (2026-10-02)

Produced by a Plan agent under the "kernel first" framing, before the loop-centered re-centering. The
package list here was superseded by `docs/PLAN.md` (v3), but the API signatures, effect algebra, file
budget, runtime trace, reuse map and task breakdown remain the reference for `@tecera/worker`,
`@tecera/policy`, `@tecera/ledger` and `@tecera/brain`. Where this document says `invoke` package, read
`@tecera/worker`; where it says `runtime` drives goals directly, read `@tecera/loop`.

## 1. Packages and DAG (as originally proposed)

| Package | Responsibility | Deps |
|---|---|---|
| `@tecera/contracts` | Types, manifest parser (unknown-field rejection, hash), effect/span/lifecycle/memory/decision types, all ports (LLM, Repl, Tool, Ledger, Broker, Hook) | none |
| `@tecera/invoke` → `worker` | Supervisor: `invoke`/`scope`/`resume`, ConfigStack, hook dispatcher + effect composer, redacting serializer, never-raising parser, broker (ToolCall span) | contracts |
| `@tecera/sandbox` → `worker` | Disposable child process per REPLExec, IPC with size bounds, handles, process-tree kill, quotas | contracts |
| `@tecera/policy` | Mandatory deterministic hooks + snapshot/verdict/diff-boundary ports from EEZE; rule-based risk fallback | contracts |
| `@tecera/ledger` | SQLite append-only evidence, leases, reservations, approvals, checkpoints; in-memory twin | contracts, better-sqlite3 |
| `@tecera/brain` | Four memory tiers over the ledger, salience × relevance assembly, stage/graduate | contracts |
| `@tecera/runtime` | Composition root, Commit sequence, fs/shell/git tools, two providers, `bin/tecera` | all |

Siblings never import each other; wiring is by ports in `contracts/ports.ts`. Policy never sees the worker.

## 2. Public APIs

### `@tecera/contracts`
```ts
export interface Manifest {
  schemaVersion: 1; id: string; name: string; baseRevision?: string;
  seats: Record<string, { provider: 'anthropic'|'openai'; model: string; role: 'writer'|'reviewer' }>;
  capabilities: CapabilitySet;
  budgets: Limits;                         // { costUsd, calls, tokens, wallMs, depth, iterations, attempts }
  approvals: { required: string[]; quorum: 1; expiryMs: number; separationOfDuty: true };
  verify: Array<{ argv: string[]; timeoutMs: number }>;
  review: { seat: string; mandatory: true };
  secrets: Record<string, { ref: string }>;   // references only; never values
  memory: { contextBudgetTokens: number };
  hooks: { mandatory: string[] };          // must equal policy.MANDATORY; else startup refuses
}
export function manifestHash(m: Manifest): string;

export interface CapabilitySet { tools: string[]; paths: { read: string[]; write: string[]; protected: string[] };
  network: 'none'; budgets: Limits; sandbox: SandboxProfile }
export function narrow(parent: CapabilitySet, child: CapabilitySet): CapabilitySet;   // intersection only

export type SpanKind = 'Invoke'|'LLMQuery'|'REPLExec'|'ToolCall'|'Verify'|'Review'|'Commit';
export type Stage = 'Enter'|'Send'|'Complete'|'Exit'|'Retry';
export interface SpanEvent<K extends SpanKind = SpanKind> {
  readonly span: K; readonly stage: Stage; readonly spanId: string; readonly run: RunRef;
  readonly input: Readonly<SpanInput[K]>; readonly output?: Readonly<SpanOutput[K]>;
  readonly outcome?: 'Completed'|'Aborted'|'Failed'|'Suspended'; readonly attempt: number;
}
export type Effect =
  | { type:'PatchInput'; path: string; value: Json }
  | { type:'ReplaceOutput'; value: Json }
  | { type:'PatchOutput'; path: string; value: Json }
  | { type:'Abort'; reason: string; code: AbortCode }
  | { type:'Suspend'; request: SuspendRequest }
  | { type:'RestrictCapabilities'; to: Partial<CapabilitySet> }
  | { type:'ReserveBudget'; pool: string; amount: Cost }
  | { type:'Require'; gate: 'Verify'|'Review' }
  | { type:'AppendEvidence'; key: string; kind: string; body: Json }
  | { type:'BlackboardCAS'; key: string; expected: Json|undefined; value: Json };

export interface AchievementGoal { id: string; statement: string; check: Manifest['verify'];
  status: 'open'|'achieved'|'demoted'|'abandoned'; evidence: string[] }
export interface PlanOption { id: string; goalKinds: string[]; inputs: Record<string, Json>; hooks: string[]; config?: ConfigOverride }
export interface IntentionInstance { id: string; goalId: string; optionId: string; attempt: number;
  status: 'committed'|'running'|'suspended'|'verifying'|'reviewing'|'committing'|'done'|'dropped'|'failed';
  evidence: string[]; reconsider: ReconsiderTrigger[]; checkpointId?: string }
export type ReconsiderTrigger = 'belief-invalidated'|'verify-failed'|'budget-exhausted'|'dependency-demoted'|'superseded'|'human-intervened';
export function transition(i: IntentionInstance, to: IntentionInstance['status']): IntentionInstance; // throws on illegal edge

export interface MemoryEntry { id: string; tier: 'personal'|'working'|'semantic'|'episodic'; kind: string; content: string;
  provenance: { runId?: string; hookId?: string; evidenceKey?: string; commitSha?: string };
  salience: { createdAt: number; pain: number; importance: number; recurrence: number };
  state: 'active'|'candidate'|'rejected'|'retracted'; decisions: Array<{ by: Principal; verdict: string; rationale: string; at: number }> }

export interface DecisionRecord { id: string; question: string; kind: 'choice'|'score'|'bool'; stateDigest: string;
  answer: Json; probabilities?: Record<string, number>; confidence: number; provider: 'rule'|'jev'|'llm';
  policyOutcome: 'allow'|'suspend'|'abort'|'escalate'; runId: string; at: number }

// ports.ts
export interface LLM { id: string; provider: string; complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> }
export interface Repl { exec(req: ExecRequest, bridge: ToolBridge): Promise<ExecResult>; dispose(): Promise<void> }
export type ExecResult = { kind:'continue'; output: string; exception?: SerializedError } | { kind:'return'; value: Json; output: string } | { kind:'raise'; exception: SerializedError } | { kind:'suspended'; pending: ToolRequest };
export interface Tool { name: string; schema: JsonSchema; call(args: Json, ctx: ToolContext): Promise<Json> }
export type ToolBridge = (req: ToolRequest) => Promise<ToolResult>;
```

### `@tecera/worker` (was `invoke`)
```ts
export function invoke<T>(inputs: Inputs, opts: InvokeOptions<T>): Promise<Outcome<T>>;
export function resume<T>(token: string, grant: ApprovalGrant): Promise<Outcome<T>>;
export function scope<R>(spec: ScopeSpec, body: () => Promise<R>): Promise<R>;   // AsyncLocalStorage; nested = narrowing

export interface InvokeOptions<T> { output: SchemaRef<T>; config?: ConfigOverride|ConfigOverrideByDepth; hooks?: Hook[]; signal?: AbortSignal }
export interface ScopeSpec { vars?: Record<string, Binding>; hooks?: Hook[]; config?: ConfigOverride|ConfigOverrideByDepth; capabilities?: Partial<CapabilitySet> }
export type Binding = { kind:'value'; value: Json; provenance: Provenance } | { kind:'handle'; id: string; methods: string[] } | { kind:'hidden'; value: Json };
// Reserved, unassignable: __history__, __depth__, __capabilities__

export interface Config { llm: LLM; repl: Repl; protocol: Protocol; ledger: Ledger; sandbox: SandboxProfile; limits: Limits }
export type ConfigOverride = Partial<Pick<Config,'llm'|'protocol'|'sandbox'|'limits'>>;   // ledger and hooks are not overridable
export interface ConfigOverrideByDepth { byDepth: Record<number|'default', ConfigOverride> }
export class ConfigStack { push(o: ConfigOverride|ConfigOverrideByDepth, depth: number): ConfigStack; resolve(depth: number): Config } // throws if child widens

export type Outcome<T> =
  | { kind:'returned'; value: T; run: RunRef }                       // never means the goal is done
  | { kind:'suspended'; request: SuspendRequest; resumeToken: string; run: RunRef }
  | { kind:'aborted'; reasons: Array<{ code: AbortCode; reason: string; hookId: string }>; run: RunRef }
  | { kind:'failed'; error: SerializedError; run: RunRef };
export interface RunRef { runId: string; invokeId: string; depth: number; parentInvokeId?: string; checkpointId?: string }

export interface Protocol { serialize(inputs: Inputs, view: AmbientView): Messages; parse(raw: string): Program|ParseFailure } // parse never throws
export function composeEffects(stage: Stage, effects: Array<[hookId: string, Effect]>): Composed|Refused;
export class Broker implements ToolBridge { constructor(tools: Map<string, Tool>, dispatcher: Dispatcher, ledger: Ledger) }

// sandbox half
export class ChildProcessRepl implements Repl { constructor(profile: SandboxProfile) }
export interface SandboxProfile { cwd: string; timeoutMs: number; maxOldSpaceMb: number; maxOutputBytes: number; maxMessageBytes: number; env: Record<string, never> }
export interface ExecRequest { execId: string; code: string; bindings: Record<string, Binding>; checkpoint?: Record<string, Json> }
export type HostToWorker = { t:'exec'; req: ExecRequest } | { t:'rpcResult'; callId: string; ok: boolean; value?: Json; error?: SerializedError } | { t:'cancel' };
export type WorkerToHost = { t:'ready' } | { t:'rpc'; callId: string; handle: string; method: string; args: Json[] }
  | { t:'result'; execId: string; result: ExecResult } | { t:'checkpoint'; key: string; value: Json };
export function killTree(pid: number): Promise<void>;
```

### `@tecera/policy`
```ts
export interface Hook { readonly id: string; readonly mandatory: boolean; readonly spans: ReadonlySet<SpanKind>;
  handle(event: SpanEvent, view: AmbientView): Effect[] | Promise<Effect[]>; describe(): HookDescriptor }  // descriptor = governance record
export const MANDATORY: readonly string[];   // ['budgetPool','recursionLimit','iterationLimit','toolAllowlist','protectedPaths','diffBoundary','approvalGate','foreignReview','verifyGate','tamperCheck','progressCheck','secretCanary','evidenceRecorder','returnSchema']
export function mandatorySet(m: Manifest, deps: { ledger: Ledger; snapshot: Snapshotter }): Hook[];
export function assertMandatory(hooks: Hook[], m: Manifest): void;   // throws before any model runs
export function enforceChanges(task: ChangeBoundary, protectedPaths: string[], changes: Change[]): void; // EEZE guards.py port, default allowed = []
export function snapshot(worktree: string, base: string): Promise<{ fingerprint: string; packet: string }>;
export function parseVerdict(raw: string, provider: string): Verdict|null;   // EEZE _approved port
export function riskClass(req: ToolRequest, m: Manifest): 'low'|'medium'|'high'|'irreversible';
```

### `@tecera/ledger`
```ts
export interface Ledger {
  append(e: { key: string; kind: string; runId: string; body: Json; provenance: Provenance }): Promise<EvidenceRecord>; // idempotent on key; throws on body mismatch
  lease(resource: string, holder: string, ttlMs: number): Promise<Lease|null>; renew(l: Lease): Promise<Lease>; release(l: Lease): Promise<void>;
  reserve(pool: string, amount: Cost, runId: string): Promise<Reservation>;   // atomic; throws BudgetExceeded
  settle(reservationId: string, actual: Cost): Promise<void>;
  requestApproval(r: ApprovalRequest): Promise<ApprovalRequest>;             // {requestId, actionHash, runId, session, requester, expiresAt}
  approve(requestId: string, g: { approver: Principal; at: number }): Promise<ApprovalGrant>;  // rejects self-approval, expiry, unknown id
  consume(grantId: string, actionHash: string): Promise<void>;               // one-use; hash must match
  checkpoint(run: RunRef, state: CheckpointState): Promise<string>; loadCheckpoint(id: string): Promise<CheckpointState>;
  query(f: { runId?: string; kind?: string; since?: number }): AsyncIterable<EvidenceRecord>;
}
export class SqliteLedger implements Ledger { constructor(path: string) }  export class MemoryLedger implements Ledger {}
```

### `@tecera/brain`
```ts
export class Brain {
  constructor(ledger: Ledger, root: string /* .tecera/ */, budgetTokens: number)
  assembleContext(q: { goal: string; query: string; alwaysOn?: string[] }): Promise<{ inputs: Record<string, Binding>; tokens: number; dropped: string[] }>;
  recall(q: { query: string; tiers?: MemoryEntry['tier'][]; k: number }): Promise<Array<{ entry: MemoryEntry; score: number }>>;
  record(e: Omit<MemoryEntry,'id'|'state'|'decisions'> & { tier:'episodic' }): Promise<MemoryEntry>;
  stage(c: { content: string; sourceEpisodes: string[]; pain: number }): Promise<MemoryEntry>;
  graduate(id: string, d: { by: Principal; verdict: 'promote'|'reject'|'retract'; rationale: string }): Promise<MemoryEntry>;
  render(tier: MemoryEntry['tier']): Promise<string>;
}
export function salience(e: MemoryEntry, now: number): number;  // recency × pain × importance × min(recurrence,3)
```

## 3. Effect composition rules

| Effect | Stages allowed | Composition (same stage, all hooks) | Conflict → |
|---|---|---|---|
| Abort | Enter, Send, Complete, Retry | All grouped into one `aborted` with reasons[]; dominates every other effect | never conflicts |
| Suspend | Send | Merged into one request (reasons[]); dominates Replace/Patch/Reserve; loses to Abort | never conflicts |
| PatchInput | Enter | Disjoint paths merge; identical values dedupe; applied atomically; inputs revalidated at Send | same path, different value → whole set refused (Abort `conflict`) |
| ReplaceOutput | Send | One distinct value allowed; identical dedupe; skips the operation | two distinct values → refused |
| PatchOutput | Complete | Disjoint paths merge | overlapping paths → refused |
| RestrictCapabilities | Enter | Intersection (tools ∩, paths allow ∩, protected ∪, limits min); never widens | widening attempt → refused |
| ReserveBudget | Send | Amounts summed per pool; charged atomically before execution | pool exhausted → Abort `budget` |
| Require | Enter (Commit) | Set union of gates | none |
| AppendEvidence | all incl. Exit | Sorted by key; written before state transition | duplicate key with different body → refused; ledger failure → Abort `ledger` |
| BlackboardCAS | all incl. Exit | Per-key, expected checked against current | two CAS on one key, or expected mismatch → refused |
| hook throws | any | Treated as Abort `hookError` (fail closed) | — |
| Exit stage | — | Only AppendEvidence and BlackboardCAS honoured; other effects ignored and logged | — |

## 4. File tree (LOC targets; kernel ≈ 5.1k, runtime ≈ 0.9k)

```
packages/contracts/src   index 30 · manifest 220 · effects 110 · spans 110 · capability 90 · lifecycle 120 · memory 70 · decision 40 · ports 150 · outcome 50 · errors 40          ≈1030
packages/worker/src      index 30 · invoke 240 · scope 90 · config 120 · hooks/dispatcher 130 · hooks/compose 200 · hooks/blackboard 50 · protocol/serializer 170 · protocol/parser 80 · protocol/prompts 70 · broker 150 · history 60
                         sandbox/host 200 · sandbox/worker 200 · sandbox/protocol 70 · sandbox/profile 50 · sandbox/killTree 40   ≈1970
packages/policy/src      index 40 · mandatory 70 · hooks/limits 130 · hooks/toolAllowlist 50 · hooks/protectedPaths 110 · hooks/diffBoundary 60 · hooks/approvalGate 90 · hooks/foreignReview 80 · hooks/verifyGate 90 · hooks/tamper 50 · hooks/progress 40 · hooks/secretCanary 50 · hooks/evidence 50 · hooks/returnSchema 40 · snapshot 140 · verdict 90 · risk 50   ≈1230
packages/ledger/src      index 20 · schema 60 · sqlite 250 · memory 110 · hash 30          ≈470
packages/brain/src       index 20 · salience 50 · assemble 130 · recall 70 · graduate 100 · views 70          ≈440
packages/runtime/src     index 20 · compose 110 · job 190 · commit 150 · tools/fs 70 · tools/shell 60 · tools/git 60 · providers/anthropic 80 · providers/openai 80 · bin/tecera 80   ≈900
```

## 5. Runtime trace of the first job (kernel-first version)

1. `tecera run` → parse + hash manifest; open `SqliteLedger`; `policy.mandatorySet` → `assertMandatory`. Missing hook → exit. Evidence `run.start{manifestHash}`.
2. Goal/intention created; `ledger.lease(worktree)`; `git worktree add` at base; `checkpoint`.
3. `brain.assembleContext` → inputs under `contextBudgetTokens`, tagged `provenance: memory`.
4. Invoke/Enter (depth 0): recursionLimit, budgetPool, secretCanary, evidenceRecorder (hook descriptors = governance record), returnSchema; `RestrictCapabilities(manifest.capabilities)`.
5. Invoke/Send: inputs revalidated; checkpoint.
6. LLMQuery/Enter: serialize. Send: `ReserveBudget(tokens)` → writer seat. Complete: usage settled. Transport failure → Retry ≤ limit.
7. Parse → REPLExec/Enter (code validation, iterationLimit) → Send: fresh child with handle bindings.
8. `readFile` → ToolCall Enter (allowlist, protected read) → Send (riskClass, reserve) → Complete (bounded, `untrusted:tool`) → Exit (evidence).
9. `writeFile src/…` allowed; `writeFile *.test.ts` → Abort protected.
10. Approval-gated tool → `Suspend` → `Outcome.suspended{resumeToken}`; `ledger.requestApproval{actionHash}`.
11. `tecera approve` → `ledger.approve` (requester ≠ approver, expiry) → `resume` → `consume` one-use → REPLExec re-runs from checkpoint.
12. Program `return` → returnSchema → Invoke/Complete → `returned`; intention `verifying` (not done).
13. Commit/Enter: progressCheck, diffBoundary (incl. untracked+ignored, symlinks), protectedPaths, tamperCheck, `Require(Verify)`, `Require(Review)`; `sandbox.dispose()` kills writers; freeze F1.
14. Verify/Send: each `manifest.verify` argv in a fresh restricted child; exit 0 → `verify.pass`; else Abort → attempt+1.
15. Review/Send: reviewer seat; same provider → Abort; `parseVerdict` exact; F2 ≠ F1 → Abort mutation-after-review.
16. Verify again; F3 == F2.
17. Commit/Send: host runs `git add/commit`; `expectedTree === HEAD^{tree}`; evidence `commit{sha, F3}`. Intention `done`; goal `achieved`.
18. Invoke/Exit, `run.end`; `brain.record(episode)`.

## 6. Reuse map

JAZ: `hooks/effects.py` + `hooks/dispatcher.py` + `hooks/README.md` → `worker/src/hooks/*`; `repl/types.py` → `ExecResult` (+ `suspended`); `protocol/code_only.py` + `prompts.py` → `worker/src/protocol/*`; `BudgetPool/IterationLimit/RecursionLimit` → `policy/src/hooks/limits.ts` (scoped); `repl/permissions.py` posture → sandbox realm; `ConfigOverrideByDepth` → `worker/src/config.ts`; `_library/swe.py` tool shapes → `runtime/src/tools/*`.
agentic-stack: `harness/salience.py` → `brain/src/salience.ts` (verbatim formula); `harness/context_budget.py` → `brain/src/assemble.ts`; `memory/promote.py`/`validate.py`/`review_state.py` → `brain/src/graduate.ts`; `memory/` layout → `templates/business-case/.tecera/`; `loops/budget.json`+`constraints.json` → manifest budgets/paths.
EEZE: `guards.py enforce_changes` → `policy/src/hooks/diffBoundary.ts` (fix default `allowed_changes` to `[]`; feed ignored files); `runtime.py _snapshot` → `policy/src/snapshot.ts`; `_approved` + `_writer_completed` → `policy/src/verdict.ts`; `_verify` → `verifyGate.ts`; `_review_and_commit` → `runtime/src/commit.ts`; `_run_task` no-progress-twice → `progress.ts`; `policy.json protected_paths` → template.
Builderlync: `plan_waves.py` deferred; `gates/` tamper idea → `tamper.ts`; `prompts/REVIEWER_PROMPT.md` → reviewer prompt.
Mosaic forks: `plugins/llm/LLMProvider.ts` → `contracts LLM` port; `AnthropicProvider.ts`/`OpenAIProvider.ts` → `runtime/src/providers/*` without import-time registration; `utils/PIIRedactor.ts` → serializer; `plugins/tools/ToolProvider.ts` → `contracts Tool`. Delete later: `middleware/approval.ts`, `bdi/{Desire,Intention}Set`.

## 7. Original Phase 0 / Phase 1 tasks

See `docs/PLAN.md` for the loop-centered task list; the per-package tests listed there are derived from this
report: P0.1–P0.11 (contracts, compose, dispatcher/scope/config, serializer/parser, sandbox, ledger
conformance, policy limits/allowlist/protectedPaths/diffBoundary, snapshot/verdict/verifyGate/tamper, brain,
template + sample) and P1.1–P1.8 (invoke loop with scripted LLM, broker + tools, suspend/resume, commit
sequence, goal driver, providers, bin, adversarial suite).
