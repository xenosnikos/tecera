# Sprint 1 (Phase 1 wave 1): Codex spot-checks and summary (2026-10-02)

Six lanes built concurrently by Opus 5.5 agents; each lane spot-checked read-only by Codex (gpt-6-astra) as it landed; a final Codex pass wrote the sprint summary. Lane self-reports are in `2026-10-02-sprint1-lane-reports.json`. Verdicts below are Codex's, verbatim. Integration check after the sprint: all eleven packages build and 565 tests pass (2 live tests skipped).

# Sprint 1 (Phase 1 wave 1) — where we stand
## Scoreboard — one table: lane | status | tests | build | Codex verdict | top risk
## What is done against docs/PLAN.md P1.1–P1.6 — bullet per item: done / partial / not started, one line each
## Blockers to wire `tecera run` end to end (wave 2) — ordered, concrete, with file paths
## Cross-lane integration risks — API mismatches between lanes, duplicated logic, contract changes that must land in packages/contracts before wave 2
## Security posture — the three weakest fail-closed points right now
## Recommended wave 2 — ordered task list with ≤ 1 day each
Be concrete and skeptical; cite file paths.
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
2026-10-02T15:54:34.766585Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer realm=\"OAuth\", resource_metadata=\"https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/eeze-2v\"" })
2026-10-02T15:54:35.492594Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer realm=\"OAuth\", resource_metadata=\"https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/eeze-2v\"" })
codex
I’ll read Phase 1 of `docs/PLAN.md` and check the repo paths to distinguish implemented pieces from integration blockers.
exec
/bin/bash -lc "rg -n 'P1\\.[1-6]|Phase 1|wave' docs/PLAN.md" in /mnt/c/Users/nikox/Desktop/Repos/tecera
 succeeded in 452ms:
29:- Loop-centered: Phase 1 kernel is the BDI event cycle on the ledger as event log; `invoke` is the
80:`Bus` adapter in Phase 3 after hardening; `auth`'s JWT validator is reused for approval ingress in Phase 1.
82:## The cycle (the article's sketch, as the Phase 1 kernel)
115:| Seam | Question | Answer | Phase 1 rule fallback |
209:**Phase 1 — the first job end to end through the loop**
210:- P1.1 Providers (Anthropic, OpenAI) with usage/cost; recorded fixtures; live gated on keys.
211:- P1.2 Planner seat prompt + plan schema output; validation; staging. Test: scripted planner yields the five-step plan; a plan requesting `git_push` is rejected.
212:- P1.3 Worker steps via `invoke` + broker tools (read, edit, listFiles, runVerify). Test: protected test edit aborted and recorded; output provenance tags.
213:- P1.4 Gate steps: verify runner, foreign review, commit with approval and tree comparison. Test: same-provider refused; planted/fenced verdict rejected; mutation after review → human; forged/replayed/self grant fails.
214:- P1.5 `bin/tecera` v1 commands + managed-block adapters (Claude Code, Codex). Test: live-gated e2e produces a commit, a complete event chain, `why` walks it, the plan is staged; offline replay re-derives `goal.achieved`.
215:- P1.6 Adversarial suite (≥ 35 cases from `docs/design/security.md`) + crash-at-each-step recovery + secret canaries across prompts, child env, verify env, review packet, ledger, logs, checkpoints, reflex state.
234:- `yarn test:adversarial`: P1.6 suite; any secret canary hit fails the build.
243:gate steps. Builderlync: tamper gates, reviewer prompt, `plan_waves` checks → `policy.validatePlan`

exec
/bin/bash -lc "pwd; rg --files -g AGENTS.md -g '*wiring*' -g '*ports*' -g '*canonical*'" in /mnt/c/Users/nikox/Desktop/Repos/tecera
 succeeded in 2388ms:
/mnt/c/Users/nikox/Desktop/Repos/tecera
packages/runtime/src/wiring.ts
packages/runtime/dist/wiring.js
packages/runtime/dist/wiring.d.ts.map
packages/runtime/dist/wiring.d.ts
packages/contracts/src/ports.ts
packages/contracts/dist/ports.js
packages/contracts/dist/ports.d.ts.map
packages/contracts/dist/ports.d.ts
node_modules/@colors/colors/lib/system/supports-colors.js
node_modules/logform/node_modules/@colors/colors/lib/system/supports-colors.js
node_modules/typescript/lib/lib.webworker.importscripts.d.ts

exec
/bin/bash -lc "sed -n '175,240p' docs/PLAN.md; rg --files packages/worker/src packages/gates/src packages/runtime/src packages/contracts/src packages/policy/src | rg '(sandbox/(host|verifyRunner|profile)|broker/broker|invoke/(invoke|span|stepWorker)|tools/paths|protocol/prompts|gitx|commitGate|reviewGate|verifyGate|ledgerGuard|commands/(run|approve|preflight)|manifest/validate|adapters/(merge|render)|hook|json.ts|rpc.ts|worker.ts|ports.ts|wiring|plans.ts)'" in /mnt/c/Users/nikox/Desktop/Repos/tecera
exec
/bin/bash -lc "sed -n '1,150p' packages/runtime/src/wiring.ts; rg -n 'resume\\(|worker.run|resumeToken|planner.write|actionHash|failStep' packages/loop/src/loop.ts; rg -n 'cgroup|final|fingerprint|S8|key|freeze' docs/design/security.md" in /mnt/c/Users/nikox/Desktop/Repos/tecera
 succeeded in 296ms:
import type { Budget, Ledger, Manifest, PlanLibrary, Planner, Reflex, VerifyRunner, Worker } from '@tecera/contracts';
import type { GateRunner, PlanValidator, SeatCost } from '@tecera/loop';
import type { PermissionsDoc } from '@tecera/policy';
import type { Frontier } from '@tecera/reflex';
import { NotWired } from './errors.js';
import type { GoalSpec } from './goals.js';
import type { Redactor } from './redact.js';
import type { Env } from './util/proc.js';

/**
 * The only seam between the runtime and the packages built in wave 2 (@tecera/providers, @tecera/planner,
 * @tecera/gates, worker invoke/sandbox). Everything the CLI does today works without them; `run` asks
 * `wireRunPorts` for the model-backed ports and stops with exit 9 while it throws NotWired. Wave 2 edits
 * this file only: construct the ports from `ctx` and return them.
 */

export interface WiringContext {
  root: string;
  manifest: Manifest;
  manifestHash: string;
  permissions: PermissionsDoc;
  ledger: Ledger;
  runId: string;
  /** Approval session. Always equal to runId so `tecera approve` can find it from the ledger. */
  sessionId: string;
  env: Env;
  now: () => number;
  ids: () => string;
  /** Host verify runner (scrubbed env). Gates may use the worker's sandboxed runner instead. */
  verifyRunner: VerifyRunner;
  /** Ledger-backed plan registry; the loop matches accepted plans and stages generated ones here. */
  library: PlanLibrary;
  goal: GoalSpec;
  budget: Budget;
  redact: Redactor;
  signal?: AbortSignal;
}

export interface WiredPorts {
  planner: Planner;
  worker: Worker;
  gates: GateRunner;
  /** Worker seats with a cost figure for the route reflex (cheapest allowed wins). */
  seats: SeatCost[];
  /** Escalation target when a reflex is unsure; normally the planner seat. */
  frontier?: Frontier;
  /** Decision-model reflex provider for seams set to `model` (Phase 2). */
  model?: Reflex;
  /** Override the default policy-backed plan validator. */
  validator?: PlanValidator;
  /** Tool names the worker exposes; plan validation rejects anything else. */
  toolCatalog?: string[];
  dispose?(): Promise<void>;
}

export type WireFn = (ctx: WiringContext) => Promise<WiredPorts>;

export async function wireRunPorts(ctx: WiringContext): Promise<WiredPorts> {
  void ctx;
  throw new NotWired('run wiring lands in wave 2');
}

// ---------- live seat probes (doctor) ----------

export interface SeatRef {
  role: 'planner' | 'worker' | 'reviewer';
  id: string;
  provider: string;
  model: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  usd: number;
  detail?: string;
}

/** One real, minimal completion against a seat. Must never print or return the credential. */
export type SeatProbe = (seat: SeatRef, ctx: { manifest: Manifest; env: Env; signal?: AbortSignal }) => Promise<ProbeResult>;

export const defaultProbe: SeatProbe = async () => {
  throw new NotWired('live seat probes land in wave 2 (@tecera/providers)');
};
82: * The BDI cycle from the article: onEvent → match plans → planner writes one if none → choosePlan reflex
92:  private readonly held = new Map<string, { intentionId: string; stepId: string; requestId: string; actionHash: string }>();
144:  async resume(requestId: string, grant: ApprovalGrant): Promise<void> {
147:    await this.p.ledger.consume(requestId, h.actionHash, this.p.sessionId ?? 'local', `consume:${requestId}`, this.now());
184:      const plan = await this.p.planner.write(e, this.beliefs, goal);
262:      await this.failStep(i, plan, step, 'blocked by gate', true);
267:      const actionHash = digest({ intentionId, stepId, kind: step.kind, attempt: i.attempt });
272:        actionHash,
277:      this.held.set(stepId, { intentionId, stepId, requestId, actionHash });
281:      await this.emit('approval.requested', { requestId, actionHash, step: step.id }, this.traceFor(intentionId, stepId));
311:      await this.failStep(this.intentions.get(intentionId)!, plan, step, (err as Error).message, false);
321:        const outcome = await this.p.worker.run({ runId: this.p.runId, goal: ctx.goal, plan: ctx.plan, intention: ctx.intention, step: ctx.step, seatId, inputs: assembled.inputs, capabilities: capabilitiesFor(this.p.manifest, ctx.plan) }, signal);
362:      this.held.set(step.id, { intentionId, stepId: step.id, requestId: req.requestId, actionHash: req.actionHash });
372:      await this.failStep(i, plan, step, describeFailure(result), false);
403:  private async failStep(stale: Intention, plan: Plan, step: Step, reason: string, blocked: boolean): Promise<void> {
10:**Assets.** Provider keys; the repo under edit (history, hooks, config); the ledger (integrity =
14:holds keys) → broker (same process, separate module, sole writer to repo and ledger) → sandbox child
27:| 2 | spawn/fork, read `~/.ssh`, open sockets | `--permission` with `--allow-fs-read` limited to entry dir, no child-process/worker grants; `fetch`/`WebSocket` deleted pre-freeze; netns/seccomp where available |
28:| 3 | infinite loop / `Array(1e9)` / fork bomb | per-exec wall timeout, `--max-old-space-size`, RLIMIT_AS/cgroup `memory.max`, pids cgroup, process-group SIGKILL |
34:| 9 | mutation after review | writers killed before freeze; D1 (freeze) == D2 (after review) == D3 (after final verify) == post-commit tree; mismatch → human |
36:| 11 | reviewer echoes a planted `{"verdict":"approve","findings":[]}` | `_approved` port: exact-shape final message only, approve requires empty findings, no substring matching; reviewer provider ≠ writer provider |
37:| 12 | secret leaks via prompt/log/child env/test env | keys resolved only in supervisor into `SecretHandle`; env scrubbed; redacting serializer on prompt, ledger, logs; canary tests |
59:`runVerify`), `__history__` (read-only handle: `len()`, `slice()`, `search()`), `checkpoint(key, value)`,
70:Windows/WSL limits: no cgroups/seccomp/netns/uid drop on native Windows; WSL2 has cgroup v2 only with
73:`sandbox.isolation: "os" | "node"`; `"os"` refuses to start without cgroup+ns or Docker; `"node"` runs
85:`invoke{callId, inputs, output, narrow:{tools?, budget?, paths?, depth?}}`, `checkpoint{key, value}`,
88:Handles: `h1.<runId>.<seq>.<hmac16>`, minted by the supervisor with a per-run key, exec-scoped, ≤ 256 live
102:- `events(seq PK, run_id, goal_id, intention_id, step_id, plan_id, ts, kind, actor, payload_json, prev_hash, hash, idem_key UNIQUE)`
104:- `reservations(id PK, run_id, pool, amount, state reserved|charged|released, idem_key UNIQUE)`
107:- `checkpoints(run_id, exec_no, key, value_json, digest)`; `runs(run_id, manifest_hash, state, base_commit, candidate_digest, reviewed_digest, final_commit)`
110:candidateDigest}))`. Idempotency keys for tool calls: `sha256(runId, execNo, callSeq, actionHash)`. Consume:
121:| S3 freeze (D1) | after kill, before digest row | recompute; if D1 missing, re-freeze |
124:| S6 final verify + compare | — | recompute; any digest ≠ D1 → human |
126:| S8 commit | between `git commit` and `final_commit` row | compare `HEAD^{tree}` with pre-recorded `write-tree`; equal → record; else → human |
127:| S9 completion | before event | re-emit; idempotent by `(run_id, final_commit)` |
129:Ledger write failure at any step blocks the transition; duplicate bus delivery deduped by `events.idem_key`.
147:recorded at freeze (D1), after review (D2), after final verify (D3), post-commit tree vs `write-tree`.
149:Foreign-provider enforcement: `policy/src/review.ts` asserts distinct `provider` and key ids; review runs in
151:= `_approved`: only the provider's final structured message, exact key set `{verdict, findings}`, `approve`
152:requires empty `findings`, fences/extra keys/multiple documents/`permission_denials`/`is_error` → reject.
192:| `recover.crash_each_step` | kill supervisor at S2…S8 | matrix outcomes | runtime/e2e |
199:Manifest: `providers.<name>.auth` references only; schema rejects inline values matching key patterns
203:only; keys never enter the bus, ledger, child, verify, review packets, or reflex state. Child and verify env
207:reflex state: exact secret values plus base64/hex/URL-encoded forms, the key-pattern regexes, and

 succeeded in 419ms:
  plans/            graduated plans (procedural memory); candidates/ staged by runs
  skills/           SKILL.md fragments (prompt know-how, progressively loaded)
  protocols/        permissions.json (authority), permissions.md (view), tool_schemas/, delegation.md
  memory/           personal/ working/ semantic/ episodic/ (views over the log)
  adapters/         claude-code, codex adapter.json (managed blocks)
  tecera.lock  ledger.sqlite  runs/<id>/ (summary.md, events.jsonl, program-N.js, diff.patch, verify-N.log, review.md, decisions.jsonl)
```
`init` detects repo, test command, provider keys, sandbox profile; writes manifest, folder (no plans),
managed blocks; `validate` (schema, secret canary, globs), `doctor` (real completions per seat, sandbox
spawn, verify in sandbox, ledger, adapters), `preflight <goal>`, `run <goal|statement>` (exit 0; 4
suspended; 5 verify failed; 6 review rejected; 7 budget; 8 policy; 9 ledger; 130 interrupted),
`approve|deny <req>`, `status`, `evidence <run>`, `why <event>` (walks action → step → intention →
goal → event), `gate <goal>` (re-verify; failure demotes), `plans candidates|graduate|reject|retract`,
`memory candidates|graduate|reject|retract` (rationale required), `hook pre-tool|stop` (host adapters).
Approval ingress authenticated via the forked `auth` JWT validator; grants bound to `{requestId,
actionHash, session, requester, approver, expiry}`, one-use, requester ≠ approver.

## Phases (tasks ≤ 1 day, each with its proving test)

**Phase 0 — the cycle without models** (fake planner, fake worker, rule reflexes)
- P0.0 Persist design reports to `docs/design/{kernel,dx,security}.md`; `docs/threat-model.md`; article mapping to `docs/design/article-alignment.md`.
- P0.1 contracts: manifest, BDI vocabulary, event catalog, ports. Test: unknown field rejected; hash stable; every event type carries the trace ids; `transition()` rejects illegal edges.
- P0.2 ledger: append-only log + projections. Test: triggers block update/delete; hash chain; `BeliefProjection` rebuilt from log equals live state; concurrent reserves never oversubscribe; approval consume rules.
- P0.3 loop: `onEvent/deliberate/tick/dispatch/onStepDone` with `IntentionSet`. Test: two independent intentions run concurrently; dependent steps wait; per-agent cap honoured; `step.failed` → contingency or drop.
- P0.4 loop: commitment policies + reconsider. Test: blind ignores belief invalidation; single-minded drops on it; open-minded also drops on goal change; interrupted step is checkpointed.
- P0.5 loop: `PlanLibrary` matcher + `Planner` port + `policy.validatePlan`. Test: no match → planner called once; plan exceeding manifest budgets/permissions rejected; generated plan is staged, not accepted.
- P0.6 loop: `ContextFilter`. Test: worker inputs contain exactly the beliefs matched by the plan context + goal + history handle; token budget respected; always-on slots never dropped.
- P0.7 reflex: six seams with rules + `DecisionRecord`. Test: each seam's rule table; threshold → frontier fallback invoked; `off` bypasses; records written.
- P0.8 worker: compose/dispatcher/scope/config. Test: composition table; Abort dominance; hook throw → Abort; widening throws; by-depth config.
- P0.9 worker: serializer/parser/SecretStore + sandbox child + RPC. Test: canary never rendered; parse never throws; `require/import/eval/Function/__proto__` unavailable; loop/OOM/grandchild killed; forged/stale/oversize frames refused.
- P0.10 policy: permissions, budgets, protected paths, diff boundary, snapshot, verdict, tamper. Test: EEZE behaviour matrix; default allowed `[]`; ignored files and symlinks rejected; `.only` detected; verdict exact shape.
- P0.11 brain: tiers as views, salience, staging/graduation for lessons and plans. Test: golden salience; graduate requires human + rationale; rejected history kept; retraction append-only.
- P0.12 template + sample. Test: manifest loads; sample test fails at base; library empty; `mandatory` ids match.

**Phase 1 — the first job end to end through the loop**
- P1.1 Providers (Anthropic, OpenAI) with usage/cost; recorded fixtures; live gated on keys.
- P1.2 Planner seat prompt + plan schema output; validation; staging. Test: scripted planner yields the five-step plan; a plan requesting `git_push` is rejected.
- P1.3 Worker steps via `invoke` + broker tools (read, edit, listFiles, runVerify). Test: protected test edit aborted and recorded; output provenance tags.
- P1.4 Gate steps: verify runner, foreign review, commit with approval and tree comparison. Test: same-provider refused; planted/fenced verdict rejected; mutation after review → human; forged/replayed/self grant fails.
- P1.5 `bin/tecera` v1 commands + managed-block adapters (Claude Code, Codex). Test: live-gated e2e produces a commit, a complete event chain, `why` walks it, the plan is staged; offline replay re-derives `goal.achieved`.
- P1.6 Adversarial suite (≥ 35 cases from `docs/design/security.md`) + crash-at-each-step recovery + secret canaries across prompts, child env, verify env, review packet, ledger, logs, checkpoints, reflex state.

**Phase 2 — reflex models and learning.** Jev, OpenAI Decisions, Strands Decider adapters behind the
`Reflex` port with offline A/B against rules on recorded `DecisionRecord`s; `plans graduate` and
`memory graduate` flows; skills progressive loading; docs site (quickstart, manifest, safety-and-evidence,
why-trace).
**Phase 3 — team and transport.** `Bus` adapter on the hardened Mosaic `LocalEventBus` (reject absent
session, at-least-once + dedupe, serialized mailboxes), multi-agent sharing of facts, `Board` adapters
(Jira, Kanban), multiplayer sessions (roles, presence, handoff, routed approvals), OpenClaw adapter,
"finish setup by chatting".
**Phase 4 — evaluation.** StuLife long-horizon recall and AppWorld self-improvement harness as in the
article's planned post 5; promotion of generated plans gated on held-out evals.

## Verification
- `yarn test`: all Phase 0 suites run with zero model calls and no network.
- `yarn test:e2e`: `samples/fix-failing-test` with scripted planner/worker/reviewer offline; live when both
  keys are present: asserts a commit on `tecera/<goal>`, event chain `goal.adopted → plan.generated →
  intention.pushed → step.* → verify.pass → review.pass → step.held → approval.granted → commit → goal.
  achieved → plan.staged`, hash chain valid, D1 = D2 = D3, denied test edit present, decisions recorded.
- `yarn test:adversarial`: P1.6 suite; any secret canary hit fails the build.
- `tecera why <commit-event>` prints the full chain for the sample run.

## Reuse map
JAZ (Apache-2.0): hooks/effects/dispatcher/README → `worker/src/hooks/*`; `repl/types.py` → `ExecResult`;
`protocol/*` → serializer/parser; limits hooks; permissions posture; by-depth config. agentic-stack
(Apache-2.0): salience, context_budget → `brain`; promote/validate/review_state → staging/graduation;
packages/policy/src/hooks/limits.ts
packages/policy/src/hooks/mandatory.ts
packages/worker/src/invoke/invoke.ts
packages/worker/src/invoke/invoke.test.ts
packages/worker/src/invoke/span.ts
packages/worker/src/invoke/stepWorker.test.ts
packages/worker/src/invoke/stepWorker.ts
packages/worker/src/tools/paths.ts
packages/worker/src/broker/broker.ts
packages/worker/src/broker/broker.test.ts
packages/worker/src/hooks/compose.ts
packages/worker/src/hooks/compose.test.ts
packages/worker/src/hooks/dispatcher.ts
packages/worker/src/protocol/prompts.ts
packages/worker/src/sandbox/profile.test.ts
packages/worker/src/sandbox/host.ts
packages/worker/src/sandbox/profile.ts
packages/worker/src/sandbox/verifyRunner.test.ts
packages/worker/src/sandbox/verifyRunner.ts
packages/contracts/src/json.ts
packages/contracts/src/ports.ts
packages/contracts/src/rpc.ts
packages/contracts/src/worker.ts
packages/runtime/src/ledgerGuard.ts
packages/runtime/src/hook.ts
packages/runtime/src/plans.ts
packages/runtime/src/wiring.ts
packages/runtime/src/manifest/validate.ts
packages/runtime/src/commands/hook.ts
packages/runtime/src/commands/approve.ts
packages/runtime/src/commands/run.ts
packages/runtime/src/commands/preflight.ts
packages/runtime/src/adapters/merge.ts
packages/runtime/src/adapters/render.ts
packages/gates/src/commitGate.test.ts
packages/gates/src/reviewGate.test.ts
packages/gates/src/gitx.ts
packages/gates/src/commitGate.ts
packages/gates/src/reviewGate.ts
packages/gates/src/verifyGate.test.ts
packages/gates/src/verifyGate.ts

codex
# Sprint 1 (Phase 1 wave 1) — where we stand

Six implementation lanes exist; **none passed its Codex spot-check**. The reported 354 green tests and clean builds establish useful component coverage, but do not establish a safe end-to-end run. Wave 2 requires correctness and security repairs before composition.

Assessment follows `docs/PLAN.md:209–215`, the supplied reviews, and read-only repository inspection. Test counts are lane-reported; this summary did not rerun tests or modify files.

## Scoreboard — one table: lane | status | tests | build | Codex verdict | top risk

| lane | status | tests | build | Codex verdict | top risk |
|---|---|---:|---|---|---|
| providers | Reported done; acceptance blocked | 45 green | Reported clean | **Fail** | Successful responses leak credentials; non-final output can become an accepted result |
| planner | Reported done; acceptance blocked | 45 green | Reported clean | **Fail** | Gate ordering, omitted budgets and empty seat restrictions admit unsafe plans |
| sandbox | Reported done; acceptance blocked | 63 green | Reported clean | **Fail** | Outstanding writes and escaped verify descendants survive completion |
| invoke | Reported done; acceptance blocked | 81 green | Reported clean | **Fail** | One grant authorizes multiple actions; ledger failures can return success |
| gates | Reported done; acceptance blocked | 78 green | Reported clean | **Fail** | Hostile Git programs execute on host; committed bytes are not bound to reviewed bytes |
| cli | Reported done; acceptance blocked | 42 green | Reported clean | **Fail** | Verify inherits manifest-allowlisted secrets; approval identity is unauthenticated |

## What is done against docs/PLAN.md P1.1–P1.6

- **P1.1 — Partial:** Provider adapters, usage/cost arithmetic, fixtures and key-gated live tests exist; response security fails, rates remain unverified, and live compatibility was not exercised (`packages/providers/src/`).
- **P1.2 — Partial:** Planner prompts, strict document parsing, repair and staging interfaces exist; authoritative validation, goal ceilings, rejection handling and durable staging integration remain incomplete (`packages/planner/src/`, `packages/loop/src/loop.ts`).
- **P1.3 — Partial:** Invoke, broker tools, provenance and basic protected-edit tests exist; real-child API compatibility, suspension, narrowing, replay and write containment fail (`packages/worker/src/`).
- **P1.4 — Partial:** Verify/review/commit gates and substantive rejection tests exist; approval ownership, frozen content binding, complete review coverage and crash recovery remain unsafe (`packages/gates/src/`).
- **P1.5 — Partial:** CLI commands and managed-block adapters exist; `wireRunPorts` still throws, cross-process resume is unavailable, and the required commit/event-chain/`why`/offline-replay proof is absent (`packages/runtime/src/wiring.ts`, `packages/runtime/src/commands/run.ts`).
- **P1.6 — Partial:** Component adversarial tests exist; ≥35 passing specification cases are not established, crash-at-each-step recovery is incomplete, and canary probes demonstrate leaks across required boundaries (`docs/design/security.md:192`, lane security tests).

## Blockers to wire `tecera run` end to end (wave 2)

1. **Establish one fail-closed secret boundary.** Redact decoded values before truncation/serialization; reject secret-bearing executable or schema content when redaction changes meaning. Cover provider responses, warnings, child traffic, checkpoints, evidence, adapters and CLI output. Current gaps span `packages/providers/src/base.ts`, `packages/planner/src/render.ts`, `packages/worker/src/invoke/invoke.ts`, `packages/gates/src/commitGate.ts` and `packages/runtime/src/ledgerGuard.ts`.

2. **Prevent execution after suspension or completion.** Track, invalidate and drain in-flight broker/sandbox calls; delayed suspension and ledger failure must override success. Fix `packages/worker/src/broker/broker.ts` and `packages/worker/src/sandbox/host.ts` before freezing any candidate.

3. **Contain verification and filesystem writes.** Reject symlink/hardlink bypasses with race-resistant operations in `packages/worker/src/tools/paths.ts` and `packages/runtime/src/vfs.ts`. Own all verify descendants, fail on incomplete cleanup, and stop treating partial OS isolation as fully isolated in `packages/worker/src/sandbox/{verifyRunner,profile}.ts`. Replace the unsafe runtime verify environment path in `packages/runtime/src/verify.ts`.

4. **Make approvals authenticate and authorize exactly one defined action.** Replace caller-asserted human identity in `packages/runtime/src/runtime.ts`; bind session identity through trusted ingress. Independently persist and approve every suspended request in `packages/worker/src/invoke/invoke.ts`. Choose one consumption owner and bind commit approval to the candidate, replacing the step-only hash in `packages/loop/src/loop.ts`.

5. **Make persistence failure terminal and recovery durable.** Propagate Exit-hook and settlement failures from `packages/worker/src/invoke/{invoke,span}.ts`. Fix invalid undefined serialization in `packages/contracts/src/json.ts`; make approval state/event transitions atomic; persist expected tree and approval context before commit in `packages/gates/src/commitGate.ts`.

6. **Align generated programs with the real sandbox.** Reconcile callable tool stubs and `{output, narrow}` invoke options across `packages/worker/src/protocol/prompts.ts`, `packages/worker/src/sandbox/child/entry.ts` and `packages/worker/src/invoke/stepWorker.ts`. Bind nested callbacks to the owning invocation; namespace and reauthorize journal replay.

7. **Move plan authority checks to the dispatch boundary.** Require a connected worker → verify → review → commit chain; materialize effective goal/manifest budgets; reject empty worker seat restrictions. Fix `packages/planner/src/{checks,llmPlanner}.ts`, shared validation in `packages/policy/src/`, and reused-plan validation in `packages/runtime/src/plans.ts`. Catch `PlanRejected` in `packages/loop/src/loop.ts`.

8. **Bind review and commit to complete, immutable content.** Reject truncated/omitted review coverage and new binaries; atomically claim review dispatch. Neutralize repository-controlled Git filters and validate staged bytes/modes against the approved candidate in `packages/gates/src/{reviewGate,commitGate,gitx}.ts`. Apply trusted read-only-test policy for the first job.

9. **Implement orchestration beyond `wiring.ts`.** Preserve worker resume tokens, restore held runs, suppress retries for terminal gate outcomes, propagate cancellation, and enforce effective budgets. `packages/loop/src/loop.ts` and `packages/runtime/src/commands/run.ts` require changes; the “wave 2 edits this file only” comment in `packages/runtime/src/wiring.ts` is incorrect.

10. **Prove the actual composition.** Wire readiness checks, SecretStore, seats, budget pools, Brain context, worktree leases/fencing, sandboxed baseline verification and durable plan staging. Then demonstrate the acceptance chain specified in `docs/PLAN.md:229–234`; structural TypeScript compatibility is insufficient.

## Cross-lane integration risks

- **Shared ports must land in `packages/contracts/src/ports.ts`.** Define gate context/results with approval, candidate fingerprints, cancellation and terminal outcomes; define worker resume and worktree/fencing context. Add goal-aware plan validation. Gates currently mirror loop-owned interfaces without behavioral agreement.

- **LLM identity and effort need explicit contracts.** Add per-call `effort`, vendor identity, model and credential fingerprint to the existing LLM declarations in `packages/contracts/src/`. Require foreign-review checks against vendor and key identity, with an explicit fail-closed rule for missing metadata. Manifest aliases must not imply independence.

- **RPC needs one supported dialect.** Amend `packages/contracts/src/rpc.ts` and `packages/contracts/src/worker.ts` for bounded NDJSON, callable stubs, invoke narrowing, host-function identifiers and promoted-value lifetimes. Align truncation handles across broker and sandbox. `Repl.exec` already includes `printed`; that proposed addition is unnecessary.

- **Approval and recovery need atomic ledger operations.** Extend `packages/contracts/src/ports.ts` with explicit claim/consume semantics, approval lookup, durable recovery state and evidence enumeration as needed. Idempotent evidence insertion is not a mutual-exclusion primitive. Fix canonical JSON centrally, rather than relying on `SanitizingLedger`.

- **Authority and budget defaults currently broaden behavior.** Add explicit per-step tool narrowing to the Step contract; remove reliance on `inputs.tools`. Apply scope variables and supported hook effects consistently. Reserve each physical LLM attempt, await settlement, and open every required ledger pool.

- **Redaction and process handling are duplicated.** Provider, planner, worker, gates and runtime serializers disagree; runtime and sandbox verify runners enforce different environments and cleanup. Establish shared contracts and implementations, including fixed failures when redaction fails. Correct `VerifyOutcome.truncated` documentation to mean output truncation; keep tree mutation separate.

- **Packaging remains unfinished.** Worker invoke/sandbox exports, provider fixture assets and runtime templates must work outside the checkout (`packages/worker/package.json`, `packages/providers/src/testing/`, `packages/runtime/package.json`). Align event names and exit-code meanings before consumers depend on them.

## Security posture — the three weakest fail-closed points right now

1. **The freeze boundary is not real.** Broker calls and verify descendants can keep writing after reported completion, while Git can execute repository programs or stage changed content after D3. Reviewed content is therefore not reliably the committed content (`packages/worker/src/sandbox/host.ts`, `packages/worker/src/broker/broker.ts`, `packages/gates/src/commitGate.ts`).

2. **Approval and accounting failures can become authority or success.** A single grant can authorize multiple pending actions; identity is caller-asserted; persistence failures are swallowed; concurrent evidence writes are used as claims. These undermine both permission and audit guarantees (`packages/worker/src/invoke/`, `packages/runtime/src/commands/approve.ts`, `packages/gates/src/`).

3. **Secrets cross almost every trust boundary.** Protection is strongest on selected prompt/error paths, but successful responses, schemas, child bindings, verify environments, checkpoints and evidence remain exposed. Short, escaped and truncated secrets defeat current matching (`packages/providers/src/redact.ts`, `packages/planner/src/render.ts`, `packages/runtime/src/verify.ts`).

## Recommended wave 2

Each item is a **≤1 engineer-day slice with a proving test**. Split any item that exceeds its timebox; do not treat the list as a commitment to finish all repairs in one day.

1. **Contracts: execution APIs.** Land shared gate/worker contexts, resume, terminal results, LLM metadata and RPC narrowing definitions in `packages/contracts/src/`; typecheck consumers.
2. **Contracts: persistence semantics.** Fix canonical JSON; specify atomic approval/review claims and pre-commit recovery records; add serialization and claim-concurrency tests.
3. **Shared serialization.** Implement safe decoded-value redaction before truncation; prove short, escaped, encoded, getter and throwing-redactor cases.
4. **Provider hardening.** Enforce final assistant output, whole-request secret checks and sanitized responses/warnings; test ambiguous tool calls and non-final verdicts.
5. **Planner authority.** Fix connected gate ordering, effective budgets, seat restrictions and awaited usage callbacks; add all supplied counterexamples.
6. **Worker lifecycle.** Drain/cancel outstanding calls across broker and sandbox; prove delayed writes and suspension cannot survive completion.
7. **Real-child protocol.** Align callable stubs and narrowing; make caught limit violations fatal; run prompt examples against `ChildProcessRepl`.
8. **Nested invoke/replay.** Scope callbacks and journals per invocation; reauthorize replay and preserve child checkpoints; test nested suspension.
9. **Filesystem containment.** Close new-file symlink and hardlink bypasses; test protected aliases and path replacement races.
10. **Verify containment.** Implement one supported descendant-owning profile, truthful degraded reporting and safe environment construction; test escaped descendants and failed cleanup.
11. **Accounting failures.** Propagate every Exit/settlement failure; reserve physical retries correctly; test that no failed persistence path returns success.
12. **Approval ingress.** Wire trusted authentication and atomic grant/event recording; reject spoofed identities and cross-session grants.
13. **Approval/resume integration.** Enforce independent pending approvals, one consumption owner and persisted worker resume tokens; prove hold → grant → resume.
14. **Review completeness.** Reject omitted/truncated content and unsupported binaries; implement atomic review claims and vendor/key separation.
15. **Commit integrity.** Use host-controlled Git staging bound to approved bytes/modes; prove hostile filters and late mutation cannot alter the commit.
16. **Commit recovery.** Persist expected tree before commit; inject crashes around commit/evidence and prove S8 reconciliation.
17. **CLI execution readiness.** Enforce locks, ledger integrity, safe scans and effective limits; route baseline verification to the owned worktree and propagate cancellation.
18. **Adapter and package closure.** Fix shell-policy bypasses, merge conflicts, rendered-secret leaks and installed asset/export failures; test an installed package.
19. **Composition.** Implement `packages/runtime/src/wiring.ts` plus required loop/run changes; connect Brain context, budgets, leases and durable plan staging.
20. **Acceptance.** Run scripted sample E2E, offline replay, ≥35 named adversarial cases and cross-boundary canary scans. Run key-gated live probes when credentials are available; leave live compatibility explicitly unverified otherwise.

---

# Lane: providers

VERDICT: fail

## Findings

1. **[blocker] Successful responses and warnings can expose credentials.** `packages/providers/src/anthropic.ts:185` and `packages/providers/src/openai.ts:120` return unsanitized `content` and provider-controlled `model`; only `raw` is scrubbed. `packages/providers/src/pricing.ts:47` also interpolates that model directly into `onWarning`. Synthetic probes confirmed a credential echoed in content survives, and a credential echoed as the model reaches both the response and warning callback. This contradicts the claimed “never surface the credential” guarantee. **Fix:** sanitize every outgoing response field and warning; reject secret-bearing output with a sanitized error before consumers can execute, persist, or reprompt it.

2. **[blocker] Response parsing does not enforce final assistant output.** `packages/providers/src/openai.ts:45` does not validate message role/status; lines 108–115 concatenate every message’s text and trust the outer status. A synthetic response containing an `in_progress`, `role: user` message with approve JSON returned `finishReason: 'stop'`. Anthropic tool mode similarly selects the first matching call at `packages/providers/src/anthropic.ts:156`, ignoring additional conflicting calls. These lose distinctions required by security.md §5’s final-message review boundary. **Fix:** validate supported block shapes, assistant role and completion status, and require one unambiguous final structured result; reject conflicting calls or unsupported output.

3. **[major] Prompt protection misses schemas and direct-constructor calls.** `packages/providers/src/openai.ts:40` and `packages/providers/src/anthropic.ts:70` insert `req.schema` unchanged. A schema description containing a registered secret reached the captured HTTP body despite default factory redaction. Direct constructors additionally pass no message redactor unless explicitly configured (`openai.ts:85`, `anthropic.ts:121`). **Fix:** scan the entire outgoing body, including schema descriptions/defaults/enums, using the credential and store redactors. Reject requests where safe sanitization would change schema semantics.

4. **[major] Redaction has reproducible bypasses and fails open on errors.** `packages/providers/src/redact.ts:40` deliberately ignores secrets shorter than six characters, although resolution accepts them. `packages/providers/src/base.ts:76` and `packages/providers/src/testing/recording.ts:53` redact *after* JSON serialization: an opaque credential containing `"` becomes escaped and survives; parsing the redacted JSON recovers it. `base.ts:59` also suppresses redactor failures and continues with potentially sensitive text. **Fix:** redact decoded string values before serialization, cover every accepted secret length, and return a fixed sanitized failure if redaction fails. Update `secrets.test.ts:139`, which currently asserts the short-secret exemption.

5. **[major] Claimed adaptive thinking is absent from the Anthropic request.** `packages/providers/src/anthropic.ts:57` adds only `output_config.effort`; it never emits `thinking: {type: 'adaptive'}`. The report’s statement that these models receive effort “with adaptive thinking” is false. The default schema path also differs from the requested forced-tool path, as disclosed. **Fix:** implement and test the intended adaptive configuration, and reconcile the default schema behavior with the lane specification. The existing exact-body assertion at `providers.test.ts:55` currently locks in the missing field.

6. **[major] Live tests explicitly retain real keys in the test environment.** `packages/providers/src/live.test.ts:13` and `:33` set `deleteFromEnv: false`, bypassing the required deletion. Those credentials remain available to subsequent code and inherited child environments in that test process. **Fix:** resolve with deletion enabled; keep handles for subsequent calls instead of retaining environment variables.

7. **[minor] Multiple provider entries cannot share an environment reference.** `packages/providers/src/secrets.ts:149` resolves entries sequentially, while `:228` immediately deletes each referenced variable. Two provider aliases using `env:K` cause the second resolution to fail; a synthetic probe confirmed this. **Fix:** cache resolved references privately and construct distinct handles from that cache while deleting the environment variable once.

8. **[minor] Some error responses contradict the documented `raw.error` API.** `packages/providers/src/anthropic.ts:152` and `packages/providers/src/openai.ts:107` overwrite `errorResponse(...).raw` with the provider body. Refusal and structured-output failures therefore need not contain `raw.error`, contrary to the report. **Fix:** preserve a consistent sanitized error envelope, or correct the public documentation and require callers to use `content`.

## Missing tests

The existing tests contain meaningful assertions: handle serialization, environment deletion, exact request bodies, arithmetic, retry limits, cancellation, and HTTP-error credential echoes. They do not establish the full security guarantee.

- **`secret.canary_*` — security.md §6–7:** successful response text/tool inputs/model metadata; warning callbacks; schema strings; escaped JSON secrets; short secrets; throwing redactors; and byte scans of transcripts. The successful-response test at `providers.test.ts:300` puts the credential only in an unused `echo` field.
- **`review.planted_verdict`:** non-final or non-assistant messages, fragmented approve JSON across messages, conflicting tool calls, and mixed valid/unsupported blocks. Gate-level verdict validation remains necessary separately.
- **`review.same_provider`:** distinct manifest aliases for the same vendor, recording wrappers, and an explicit policy for missing credential fingerprints.
- Shared environment references, throwing global `ScriptedLLM` matchers, and error-envelope consistency.
- An installed-package fixture test: fixtures currently depend on the checkout’s `src/fixtures` directory.

Vitest was not rerun because this review prohibited writes. The direct installed compiler passed: `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`. The requested `npx` invocation failed before config resolution with a DNS error. Read-only synthetic probes reproduced the findings above against compiled modules verified to match source.

## Wiring notes for wave 2

- The providers satisfy the current `LLM` interface. `loop.ts` routes **seat IDs** through `Worker`; composition must maintain the seat-ID-to-LLM map and supply `SeatCost` entries separately.
- OpenAI uses **POST `/v1/responses`**. Per-call effort remains outside `LLMRequest`; factory-returned `LLM` values cannot accept an effort-bearing object literal without a contract extension or adapter.
- Resolve one supervisor store before spawning children; use the same provider-kind map for resolution and construction. Child and verify environment allowlists remain independently necessary.
- Run `foreignCheck` before review. Check `finishReason`, then validate the actual schema and exact verdict shape; JSON parseability alone is insufficient.
- `redactPrompts: false` also removes store-wide **error** redaction (`factory.ts:62`). Separate those controls before exposing this option.
- `FixtureFetch` cannot find bundled fixtures after installation from the current package contents. Copy/include fixtures for distribution.
- Pricing values and live API compatibility were not independently verified here; passing arithmetic tests does not verify rates.

## What is solid

- SecretHandle uses a private WeakMap, frozen metadata, and throwing coercion/inspection methods.
- Default environment resolution deletes the resolved variable.
- Retry tests exercise bounded attempts, backoff, timeout, and cancellation.
- Ordinary HTTP errors and malformed JSON become error responses.
- RecordingLLM preserves provider identity and credential fingerprints through its wrapper.

---

# Lane: planner

VERDICT: fail

## Findings

1. **[major] `packages/planner/src/checks.ts:58` — Gate ordering admits a parallel verify/review after edits.** Each review merely needs *some* preceding verify; the commit separately needs a verify and review covering every worker. Consequently, `earlyVerify → edit → {lateVerify, review} → commit`, with review also depending on earlyVerify, passes validation. Review can run before the edited code passes verification. Reproduced: `validateCandidate` returned no issues. **Fix:** require a connected chain where a verify covering every worker precedes the review used to authorize commit.

2. **[major] `packages/planner/src/llmPlanner.ts:193` — Omitted budget fields bypass goal ceilings.** The comparison only runs when the model supplies a number. `budget: {}` was accepted against `goal.budget.usd = 0.01`; the loop subsequently defaults omitted limits to the larger manifest budget (`packages/loop/src/loop.ts:494`). The report’s claim that goal ceilings are enforced is incomplete. **Fix:** resolve omitted limits against the minimum of manifest and goal ceilings before hashing and returning the plan; reject explicitly excessive values.

3. **[major] `packages/planner/src/prompt.ts:110`, `packages/planner/src/render.ts:20` — Redaction happens after truncation and serialization.** Truncating a registered secret before exact matching leaks its prefix; a read-only probe confirmed this. JSON escaping can also prevent matching secrets containing quotes or backslashes. Secrets shorter than six characters are explicitly skipped. `show()` additionally invokes `JSON.stringify`, including getters/`toJSON`, contrary to security §7. The report’s “fully redacted” claim is false. **Fix:** redact string values before truncation and encoding, use safe serialization, and honor every explicitly registered secret.

4. **[major] `packages/planner/src/llmPlanner.ts:37`, `:140`, `:186` — Planner outputs and diagnostics bypass secret hygiene.** Unknown model-supplied keys appear verbatim in Zod issues and `PlanRejected.message`. Provider errors and model-generated reasons reach `onDeliberation` unchanged. Parsed plans retain arbitrary model text and are subsequently staged and emitted in `plan.generated`. Reproduced canary leakage in rejection messages and provider-error deliberation records. **Fix:** sanitize diagnostics and callback records; reject secret-bearing candidate plans or sanitize and revalidate them before hashing and publishing.

5. **[major] `packages/planner/src/llmPlanner.ts:174` — Accounting failures can become successful deliberation.** `onUsage` is synchronous and unawaited, although the proposed ledger settlement is asynchronous. A synchronous callback exception is caught at line 147 as a provider error, returning the first plan; reproduced with a callback throwing “ledger failed.” An asynchronous rejection likewise cannot stop plan return. This violates the requirement that ledger failure block transitions. **Fix:** support and await asynchronous callbacks, propagate accounting failures, and limit provider fallback to transport failures.

6. **[major] `packages/planner/src/schema.ts:64`, `packages/planner/src/checks.ts:46` — Empty worker seat restrictions silently broaden routing.** Missing worker entries and empty seat arrays pass validation. The loop treats either as permission to route across every configured worker seat (`packages/loop/src/loop.ts:295`). A hostile model can therefore turn an empty restriction into broader authority. **Fix:** require a nonempty `allowedModels` entry for every worker, or explicitly materialize the intended default before validation; never interpret an empty list as unrestricted.

## Missing tests

- **Security §6 `secret.canary_*`:** scan repair requests, returned/rejected plans, exception messages, deliberation records, and usage metadata. Include truncation boundaries, escaped secrets, short registered secrets, and encoded forms.
- **`inject.tool_output_authority` / `inject.history_reference`:** exercise hostile beliefs and lessons through `write()` and repair, asserting rejected authority escalation. Current wrapper assertions do not establish that end-to-end property.
- Extend **`inject.nonce_escape`** to lessons, skills, event payloads, and model-derived repair diagnostics.
- Add the parallel verify/review counterexample, omitted goal limits, empty worker seat restrictions, and synchronous/asynchronous accounting failures.
- Add a loop integration test proving exhausted repair emits `plan.rejected`, drops the goal, and never stages or executes the candidate.

The 45 test cases contain meaningful assertions, including explicit rejection messages, exact repair counts, and actual sample-manifest validation. Vitest was not rerun to preserve the no-write constraint. The installed TypeScript compiler passed `--noEmit`; `npx` failed before configuration resolution. Behavioral probes used existing `dist` modules, checked against the corresponding source.

## Wiring notes for wave 2

- `Planner` method signatures and `createPlanValidator` structurally fit the current ports.
- **Rejection handling remains unwired:** `llmPlanner.ts:132` throws, while `packages/loop/src/loop.ts:184` has no catch. The report correctly identifies this; wave 2 must implement the rejection/drop transition.
- The sample’s read-only analyze step depends on the `inputs.tools` convention. The loop supplies plan-wide capabilities; the worker adapter must enforce the narrower list.
- Supply parsed repository permissions and the actual broker catalog. Pass goal ceilings into revalidation, including reused plans.
- Await usage settlement and evidence persistence before continuing. Wrap the LLM port for reservation before calls.
- Root `.tecera/goals/*.goal.md` was absent; the sample’s goal file was available and reviewed.

## What is solid

- Host-owned identity, origin, status, and trigger cannot be supplied through the plan document.
- Parsing is bounded, string-aware, and catches malformed-output exceptions.
- Normal validation failures receive exactly one repair attempt.
- Sample validation uses the real parsed manifest and permissions.
- Beliefs, lessons, and skills receive provenance-bearing untrusted wrappers with delimiter escaping.

---

# Lane: sandbox

VERDICT: fail

## Findings

1. **[blocker] [sandbox/host.ts:393](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/host.ts:393) — Outstanding tool operations can outlive successful completion and `dispose()`.** Calls run asynchronously without being tracked; a result immediately settles the exec, and finalization never waits for bridge operations. `fs.write(...); return 1` can therefore return successfully before the write completes. A later `SuspendExec` is ignored because `finished` is already true. This undermines suspension and the freeze-before-verify boundary. **Fix:** track outstanding calls, propagate cancellation, and await their termination before settling or disposing; pending suspension/failure must dominate success.

2. **[blocker] [sandbox/verifyRunner.ts:117](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/verifyRunner.ts:117) — Hostile verify descendants can survive a passing verification.** Verify code can create a new session/process group; `killTree` only kills the original group. A detached descendant with redirected stdio can keep modifying the candidate after the shell exits zero. Additionally, line 136 ignores `killTree().gone`, allowing success even when cleanup explicitly fails. The report’s “background daemons do not outlive verify” claim is false. **Fix:** use containment that owns all descendants, such as a dedicated cgroup/container, and make failed cleanup a non-passing outcome.

3. **[major] [sandbox/host.ts:224](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/host.ts:224) — Async failures can escape into the supervisor.** Evidence promises receive rejection handlers only during finalization, potentially seconds later. An immediately rejecting ledger sink can cause an unhandled rejection before that. Likewise, `void this.onCall(...)` has no rejection handler; serialization of a sufficiently deeply nested tool result at line 503 can throw outside the bridge catch. **Fix:** attach rejection handlers immediately, route every handler failure through controlled termination, and bound finalization waits. The claimed “sink failure becomes a raise” guarantee is incomplete.

4. **[major] [sandbox/host.ts:447](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/host.ts:447) — Secret-bearing data and error messages cross boundaries unchanged.** Bridge exceptions and tool errors are sent verbatim to the child; bindings, successful tool output, printed output and checkpoints also have no redaction boundary here. A canary in tool output can become child input, printed output and checkpoint contents. Environment scrubbing does not cover these paths. **Fix:** wire a supervisor-owned redactor before child transmission and before evidence/checkpoint/output sinks, including error messages and provenance. Downstream prompt redaction alone is too late.

5. **[major] [sandbox/child/entry.ts:141](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/child/entry.ts:141) — Unsupported capability restrictions silently disappear.** `invoke` copies only `tools`, `limits` and `depth`. Requests using the design’s `paths` or `budget` fields never reach host validation; requested path narrowing therefore leaves the child with the parent’s broader paths. **Fix:** define and validate one exact options schema, reject unknown fields, and implement path/budget mapping through the contracts’ narrowing functions.

6. **[major] [sandbox/child/entry.ts:84](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/child/entry.ts:84) — Child-side limit violations are catchable, contrary to the specification and report.** Oversized frames, excess calls and excess checkpoints throw/reject locally without notifying the supervisor of a fatal violation. An in-memory bootstrap reproduction of `try { await fs.read('x'.repeat(2*1024*1024)); } catch {} return 'accepted'` emitted a successful return. **Fix:** latch a terminal violation and notify the host independently of the program’s promise/error handling.

7. **[major] [sandbox/host.ts:683](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/host.ts:683) — Returned promoted values become unusable handles.** Returning a large tool result serializes its stub as `{$handle: ...}`. Finalization forwards that reference unchanged and immediately clears its table. The caller receives neither the original value nor a usable resolver. **Fix:** materialize permitted value handles before returning, or provide an explicitly owned result-handle lifetime and resolution API.

8. **[major] [sandbox/handles.ts:14](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/handles.ts:14) — Reusing the advertised stable key reissues stale handles.** Every `HandleMint` restarts its sequence at zero; the MAC contains no execution or instance nonce. Recreating a REPL with the same run ID/key can make an old handle resolve to a different new entry. An in-memory reproduction confirmed this. **Fix:** incorporate an execution/instance nonce or persist a never-reused sequence. Remove the report’s stable-key restart guidance until restart semantics are implemented.

9. **[major] [sandbox/profile.ts:136](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/profile.ts:136) — Partial isolation is reported as non-degraded OS isolation.** `prlimit` alone is sufficient, with no network namespace or cgroup and no `degraded` flag. This matches the lane text’s weaker minimum, but violates security.md §2’s explicit cgroup-plus-namespace requirement and bypasses wiring based solely on `repl.degraded`. **Fix:** resolve that specification conflict explicitly; require the documented controls for `os`, or represent partial isolation as degraded and enforce its policy consequences.

10. **[minor] [sandbox/host.ts:245](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/worker/src/sandbox/host.ts:245) — Runtime setup failures reject instead of returning a raise.** `mkdtemp` is outside the cleanup `try`, and profile/directory/entry creation errors have no conversion catch. Disk exhaustion or permission failures contradict the report’s “never rejects for sandbox failures” claim. **Fix:** catch setup failures and return a named sandbox error while cleaning any partially created scratch directory.

## Missing tests

- Unawaited tool writes, delayed suspension, and cancellation/disposal with outstanding bridge work; assert nothing mutates after completion.
- Verify descendants escaping through a new session, plus failed reap checks; neither may yield a passing result.
- Caught oversized frames, caught call/checkpoint limits, ignored invocation options, and stale handles across REPL reconstruction.
- Immediate evidence rejection, hanging sinks, and deeply nested tool output without supervisor failure.
- security.md §6 `secret.canary_*` beyond environment variables: bindings/history, tool replies, errors, printed output and checkpoints.
- Stronger `inject.history_reference`: assert malicious history remains data, cannot trigger bridge calls, and cannot mutate host-held history. The existing history test mainly checks retrieval.
- `inject.nonce_escape` needs a joint protocol/sandbox integration assertion. Recursive invoke budget/depth accounting likewise requires invoke/policy integration rather than an isolated sandbox test.

The existing tests contain meaningful security assertions, including real permission-denial and process-group checks. I did not rerun Vitest under the read-only filesystem. The installed compiler passed `tsc --noEmit -p tsconfig.sandbox.json`; the requested `npx` invocation failed before config resolution.

## Wiring notes for wave 2

- The implementations structurally fit `Repl` and `VerifyRunner`. `Repl.exec` already includes `printed`; that proposed contract change is unnecessary.
- The loop consumes `Worker` outcomes, not `ExecResult`. Preserve real approval metadata when converting sandbox suspension: `SuspendRequest` cannot safely be cast to `ToolRequest` as suggested in the report.
- Supply effective capabilities per owning invocation, recursive budget/depth enforcement, durable checkpoints, redaction and degraded-write approval policy.
- Treat NDJSON as an explicit protocol amendment. Its pre-parse bounds are justified, but it is not the requested IPC transport.
- Resolve `VerifyOutcome.truncated` semantics and keep candidate-digest checks separate. Verification without containment/degraded evidence is not ready for the documented hostile-repository boundary.
- Re-export the sandbox barrel during integration; this review changed no files.

## What is solid

- Requested Node restrictions, isolated scratch layout and explicit environment construction are implemented.
- Stubs and value bindings are created inside the VM realm; escape tests cover several constructor routes.
- Incoming host frames receive byte/depth checks before parsing, with tests proving the parser is bypassed.
- Handle authentication and stale-handle rejection work within one persistent REPL instance.
- Timeout, OOM, output-flood, environment-canary and permission-denial tests assert concrete outcomes.

---

# Lane: invoke

VERDICT: fail

## Findings

1. **[blocker] `packages/worker/src/tools/paths.ts:65` — New-file writes bypass protected paths through an in-worktree directory symlink.** The resolver checks the ancestor’s realpath but returns the original lexical path at line 74. With `src/link → test`, writing `src/link/new.test.ts` passes `write: ['src/**']` and `protected: ['test/**']`, then writes into `test`. The same applies to `.git` aliases. A mocked-filesystem probe confirmed acceptance. This contradicts the report’s claim that writes through symlinks are refused. **Fix:** reject symlinks throughout the write path, authorize the resolved destination, and use race-resistant filesystem operations. Re-resolving before `writeFile` alone does not close the race.

2. **[blocker] `packages/worker/src/broker/broker.ts:432` — Calls already awaiting hooks can execute after suspension or exec termination.** Suspension/fatal checks occur only at entry, before asynchronous hook execution. `endExec()` revokes handles but does not invalidate or drain calls already admitted. A read-only probe delayed one call’s Enter hook, suspended another call, ended the exec, then released the first: its write-class tool still executed successfully. **Fix:** track exec generations and in-flight calls; recheck cancellation immediately before execution and drain/cancel outstanding operations before checkpointing or returning.

3. **[blocker] `packages/worker/src/invoke/invoke.ts:175` — One approval authorizes every pending request.** Resume consumes only the primary request’s grant, then binds that grant to all `pending.requests` action hashes. A probe with two distinct Suspend requests returned successfully after approving only the first; the ledger contained only that first approval request. **Fix:** persist and independently approve/consume every request, or explicitly approve a composite action whose hash covers the complete set.

4. **[blocker] `packages/worker/src/invoke/invoke.ts:380` — Ledger failures can produce successful outcomes.** REPLExec and LLMQuery Exit results are discarded, including their ledger Abort effects (`invoke.ts:482`). Budget settlement exceptions are swallowed at `packages/worker/src/invoke/span.ts:110`. Probes for all three failures returned `kind: 'returned'`. **Fix:** propagate persistence and settlement failures into a terminal ledger abort and prevent subsequent execution. An action already having happened does not justify reporting successful completion without its required records.

5. **[blocker] `packages/worker/src/invoke/invoke.ts:238` — Secret hygiene stops at prompt rendering.** Suspension persists raw inputs, checkpoint values, pending program/arguments, journal results and extra metadata. Raw inputs also reach `repl.exec` at line 346; broker results and history handles return raw strings. Probes found a canary in both a ledger checkpoint and captured child bindings. The report acknowledges hidden inputs, but ordinary value inputs leak too. Error reasons and trace abort reasons also lack a final redaction boundary. **Fix:** sanitize every child, outcome, trace and persistence boundary; use opaque references for state that cannot safely be redacted without changing replay semantics.

6. **[major] `packages/worker/src/broker/broker.ts:386` — Replay keys collide across nested invokes and replay bypasses policy hooks.** Child brokers share a journal, but keys omit invoke identity while each invoke restarts `execNo` and `callSeq`. A probe where parent and child each made their first identical tool call executed the tool only once: the child received the parent’s result. Replay happens before Enter restrictions and path-policy checks, allowing cached data to cross narrower scopes. **Fix:** give executions tree-wide unique identities, namespace replay records accordingly, and reauthorize cached results under the current scope.

7. **[major] `packages/worker/src/invoke/invoke.ts:417` — Nested execution reuses root-bound sandbox callbacks.** The child receives a new broker but inherits `opts.repl`; `StepWorker` creates callbacks only for the root broker at `stepWorker.ts:132`. With the reported composition, further nested invoke/checkpoint frames route to that root broker rather than the child’s broker, undermining depth accounting, checkpoint ownership and capability narrowing. **Fix:** create a REPL with callbacks bound to each nested broker, or make callbacks explicitly session-scoped. FakeRepl’s direct bridge routing masks this integration defect.

8. **[major] `packages/worker/src/protocol/prompts.ts:22` — The advertised program API does not match the real child.** Prompts teach `readFile(path)` and `invoke(inputs, {output, narrow})`. The current child creates method objects and reads narrowing options directly as `{tools, limits, depth}`. Thus ordinary tool calls fail, and the documented nested narrowing can be silently omitted. **Fix:** agree on one callable-stub and invoke-options contract, implement it consistently, and run the prompt examples against ChildProcessRepl. The report identifies only the callable-stub mismatch.

9. **[major] `packages/worker/src/invoke/invoke.ts:193` — Scope variables and valid effects are ignored.** `currentScope()` supplies hooks/config/capabilities, but `frame.vars` is never merged into inputs. REPLExec Enter `PatchInput` is ignored at line 320; LLMQuery Enter `RestrictCapabilities` is ignored at line 439. A hook can therefore appear to sanitize executable input without affecting execution. **Fix:** use the existing input-resolution semantics, apply supported effects before execution, and explicitly refuse effects that cannot be honored. This contradicts the claim that every boundary applies composed effects.

10. **[major] `packages/worker/src/invoke/span.ts:72` — Budget effects do not follow suspension/retry semantics.** Reservations execute even when composition contains Suspend, although Suspend should dominate ReserveBudget. Conversely, LLM retries at `invoke.ts:457` perform additional provider requests without another Send reservation. **Fix:** reserve only when an operation will execute, reserve each physical retry, and settle/release reservations consistently.

11. **[minor] `packages/worker/src/protocol/parser.ts:183` — Escaped identifiers bypass the rejection table.** `parseProgram(String.raw\`return ev\u0061l('1');\`)` returned `ok: true` in a probe. Identifier escapes are not normalized, although string-literal escapes are. **Fix:** tokenize and normalize identifiers before checking forbidden vocabulary, or conservatively reject identifier escapes. The sandbox remains necessary; the parser does not currently satisfy its advertised rejection behavior.

## Missing tests

The existing tests contain meaningful assertions: denied writes leave files unchanged, forged/stale handles fail, provenance is overwritten, and ordinary approval replay fails. They are insufficient for the fail-closed claims.

- **`tamper.symlink_hardlink`:** in-worktree directory symlinks into protected paths, new files through aliases, hardlinks, and path replacement races. Existing tests mostly cover outward symlink escapes.
- **`recover.crash_each_step`:** evidence failure at every span Exit, settlement failure, and outstanding calls completing after suspension/cancellation.
- **`approval.hash_mismatch` / `approval.replay`:** multiple simultaneous approval requirements, changed arguments on resume, cross-session grants, and nested suspension recovery.
- **`rpc.widen_caps` / `inject.history_reference`:** replayed data under narrower path permissions, cross-invoke journal collisions, and another invoke’s handles/history.
- **`dos.fork_bomb_subinvoke`:** actual ChildProcessRepl recursion through the proposed factory/callback wiring, including budget accounting.
- **`secret.canary_*`:** scan checkpoints, journal entries, child bindings/replies, returned values, errors and traces—not only captured prompts.
- **`escape.eval` / parser rejection:** escaped identifiers and lexer edge cases.
- **`rpc.oversized_frame`:** direct broker argument limits and aggregate reply limits.
- Real-child tests for callable tools, nested narrowing, checkpoint ownership and truncated-result handles.

The lane’s TypeScript check passed using the installed compiler directly. I did not rerun Vitest because the review prohibited file changes; the claimed 81 passing tests were not independently reproduced. The probes above ran in memory without modifying files.

## Wiring notes for wave 2

- **Loop resumption is not wired:** `packages/loop/src/loop.ts:362` discards `resumeToken`; line 147 consumes the grant, then execution eventually calls `worker.run()` again at line 321. Persist the token and call `worker.resume(token, grant)`. Choose exactly one grant-consumption owner.
- Resolve findings 7–8 before using the report’s ChildProcessRepl composition example.
- Re-export the invoke barrel from the package root. `packages/worker/package.json` currently exports only `"."`; a built `dist/invoke/index.js` does not establish a public package subpath.
- Supply worktree/fencing-token resolvers, authenticated session identity, shared mandatory hooks, and opened `calls`/`usd`/`tokens` ledger pools.
- Define contract-supported transport for truncated-result handles. The local `BrokeredResult.handles` extension alone does not make those handles usable by generated programs.
- Nested suspension currently restarts child planning instead of resuming the saved child checkpoint; treat this as unfinished recovery behavior.

## What is solid

- The lane type-checks and depends on contracts rather than sibling policy implementations.
- Ordinary forged, stale and unknown handles fail closed.
- Broker results are forcibly tagged untrusted regardless of tool claims.
- Serializer tests meaningfully cover value getters, `toJSON`, nonce escaping and common secret encodings.
- Basic schema feedback, protected-write denial and single-request suspension/resumption have substantive tests.

---

# Lane: gates

VERDICT: fail

## Findings

1. **[blocker] Repository-controlled Git programs can execute on the host.** [gitx.ts:20](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/gitx.ts:20) disables hooks and signing but leaves local Git configuration and attribute-driven filters active. `git add` at [commitGate.ts:152](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:152) can execute a pre-existing clean/process filter. Protecting modifications to `.gitattributes` does not neutralize existing hostile configuration. **Fix:** use a host-controlled Git configuration/object-staging path that cannot execute repository programs; cover snapshot operations too.

2. **[blocker] Tree equality does not bind the commit to the reviewed content.** [commitGate.ts:134](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:134) performs the last fingerprint check before checkout, reset and staging. Afterwards, only staged *names* are checked; comparing `HEAD^{tree}` with the subsequently computed `write-tree` proves that Git committed its index, not that the index contains the approved candidate. A late writer or Git filter can change an allowed file without failing that comparison. **Fix:** enforce exclusive, frozen worktree ownership and construct/validate the index against the approved content and modes before committing.

3. **[major] New untracked binaries bypass tamper rejection.** [commitGate.ts:234](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:234) recognizes NUL-containing content but simply skips it. The supplied snapshot implementation does not set `binary` for untracked files, so `tamperFindings` receives no binary flag. An allowed, sufficiently small untracked binary can therefore reach commit, while its content is also absent from the review packet. **Fix:** classify every new file before boundary/tamper checks and reject binary or unreadable content explicitly.

4. **[major] Incomplete review packets can approve the entire candidate.** [reviewGate.ts:112](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/reviewGate.ts:112) merely labels truncation; [reviewGate.ts:149](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/reviewGate.ts:149) still accepts approval. Malicious changes beyond the packet cap need never reach the reviewer. Additionally, the snapshot omits oversized new-file contents without necessarily setting `truncated`. **Fix:** require demonstrably complete review coverage, or reject with an incomplete-packet reason.

5. **[major] At-most-once review is only sequential.** [reviewGate.ts:89](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/reviewGate.ts:89) checks evidence before the provider call but records it only at line 173. Concurrent calls for the same `(runId, D1)` both invoke the reviewer; a later evidence collision cannot undo the second call. This contradicts the report’s unconditional at-most-once claim. **Fix:** claim the review key atomically before dispatch, with defined recovery for an interrupted claim.

6. **[major] Secret redaction misses evidence fields and happens after truncation.** [commitGate.ts:82](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:82) writes raw failure details, including tamper findings containing source lines, paths and Git errors; `CommitGate` has no redactor option. [reviewGate.ts:139](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/reviewGate.ts:139) stores raw snapshot errors, and line 160 stores the provider-returned model string unchanged. [verifyGate.ts:114](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/verifyGate.ts:114) and review line 165 truncate before redaction, potentially exposing secret fragments that no longer match the full secret. **Fix:** redact all evidence strings through the supplied serializer before truncating or persisting, and pass that serializer into commit.

7. **[major] S8 recovery lacks the required durable pre-commit record.** [commitGate.ts:159](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:159) assigns `writeTree` only to an in-memory object. Its evidence write happens after `git commit`, at line 176. A crash or ledger failure leaves a real commit without the durable expected tree needed to reconcile it. This is an acknowledged gap, but contradicts completion of the required §4 recovery behavior. **Fix:** persist candidate, parent, branch, approval and expected tree before committing; reconcile HEAD against that record on restart.

8. **[major] The loop-consumed replay marker is not an atomic claim.** [commitGate.ts:211](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:211) uses `getEvidence` followed by `evidence`. Both ledger implementations permit an identical evidence write to return the existing record. Concurrent calls with identical marker bodies—including the same millisecond timestamp—can both proceed. **Fix:** use an atomic consume/claim operation whose result distinguishes the sole winner; do not use idempotent evidence insertion as a lock.

9. **[major] Default wiring fails approval consumption, and terminal failures remain retryable.** [index.ts:77](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/index.ts:77) leaves consumption with the gate by default, but `loop.ts:147` already consumes before calling it. Ordinary resume therefore returns exit 8. Separately, `loop.ts:328–339` discards gate outcome/reason, and `loop.ts:412` retries ordinary gate failures. The test named “never retried” checks only evidence metadata. **Fix:** agree on one consumption owner and propagate terminal outcomes into loop retry decisions. The report identifies these dependencies correctly; they remain integration blockers.

10. **[major] Fix-failing-test protection is disabled by default.** [commitGate.ts:125](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/commitGate.ts:125) defaults `testsReadOnly` to false. Replacing a failing assertion with a trivial passing assertion can therefore pass deterministic tamper checks, provided it avoids focus/skip syntax. Security §5 requires modified tests to be refused for this goal class. **Fix:** derive this restriction from trusted task policy and require it for the first-job workflow.

11. **[minor] Test Git processes inherit supervisor secrets.** [fixtures.ts:25](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/testkit/fixtures.ts:25) spreads `process.env` into Git’s environment. The hook test deliberately executes a repository hook using that environment, so any supervisor key/canary is available to it. **Fix:** construct an explicit minimal test environment with only required executable paths, locale and test identity.

## Missing tests

- §6 `recover.crash_each_step`: interrupted verify/review, approval consumption, pre-commit persistence, and crash or ledger failure immediately after commit.
- §6 `secret.canary_*`: scan all evidence, error fields, provider metadata and subprocess environments; include encoded secrets and secrets crossing truncation boundaries.
- §6 tamper cases: untracked binaries, mode changes, oversized files, ordinary assertion weakening, and scripts edits that do not add a `"scripts"` header or one of the specifically matched script names.
- Hostile Git clean/process filters and mutation between D3 and staging; assert the committed bytes equal the approved bytes.
- Concurrent review and concurrent approval reuse against both ledger implementations.
- Complete-packet enforcement and omitted oversized new files.
- Real loop hold → grant → resume integration; assert tooling/mutation outcomes do not retry.
- The “ignored file written by tests” case at [verifyGate.test.ts:71](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/gates/src/verifyGate.test.ts:71) creates `.coverage-ignored`, but the fixture ignores only `ignored/`. It tests an **untracked** file, not an ignored file.

## Wiring notes for wave 2

- The method signatures structurally match `GateRunner`; behavioral compatibility needs the approval and terminal-outcome fixes above.
- Move both approval producer and consumer to candidate-bound hashing together. The default step hash does not bind the grant to a worktree or candidate; exporting `commitActionHash` alone does not enforce §4.
- Composition must establish leases, stop writers before freeze, prevent overlapping worktree operations, and arrange the required final verify.
- Pre-existing ignored dependency/build artifacts currently block commits. Establish a protected baseline rather than simply excluding ignored files.
- Foreign API-key identity cannot be checked through the current `LLM` port.
- **Validation:** direct local `tsc --noEmit` passed. The requested `npx` invocation failed before configuration resolution with a DNS error. Tests were reviewed statically, not rerun under the read-only sandbox; the reported 78 passes were not independently verified. No files were modified.

## What is solid

- Gates return evidence keys without duplicating loop-owned events.
- Exact-shape verdict rejection, same-provider refusal and mutation checks have meaningful assertions.
- Default consume-mode approval tests exercise both MemoryLedger and SqliteLedger.
- Hook tests assert marker absence and verify that the planted hook actually runs under ordinary Git.
- Happy-path tests inspect the branch, committed files, SHA, tree and evidence rather than merely checking successful execution.

---

# Lane: cli

VERDICT: fail

## Findings

1. **[blocker] Secrets reach persistent storage and host prompts.** [ledgerGuard.ts:31](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/ledgerGuard.ts:31) strips `undefined` but does not redact events, evidence, approvals or checkpoints. A read-only `MemoryLedger` probe confirmed a canary survives unchanged. `commands/doctor.ts:114` records provider error messages verbatim; `cli/io.ts:29` prints unredacted output; `adapters/render.ts:61` copies memory into CLAUDE.md/AGENTS.md without redaction. Evidence export cannot repair previously leaked ledger rows or prompts. **Fix:** enforce redaction at every persistence/output boundary and before adapter rendering, including resolved credentials, encoded forms and authorization headers.

2. **[blocker] The repository can allowlist provider credentials into the test environment.** [verify.ts:11](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/verify.ts:11) copies any requested environment variable. A valid manifest can include `ANTHROPIC_API_KEY`, `NODE_OPTIONS`, or arbitrary credential variables in `sandbox.envAllowlist`; validation rejects none of these names. The probe confirmed credential inclusion. **Fix:** intersect repository requests with a supervisor-owned safe allowlist, exclude resolved secret variables and loader-injection variables, and reject unsafe configuration before spawning.

3. **[major] Filesystem confinement is lexical and follows hostile links.** [vfs.ts:75](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/vfs.ts:75) writes through existing symlinks. Adapter target validation only checks path text, so `.claude` or CLAUDE.md can redirect initialization/installation outside the repository. Separately, `hook.ts:37` treats dangling symlinks as nonexistent, and `hook.ts:45` falls back to the original path on resolution failure; a permitted `src/` path can therefore redirect a write. Hard links are unchecked. **Fix:** reject unsafe links and resolution failures, enforce real filesystem containment, and use race-resistant write operations. Test both existing and dangling links.

4. **[major] Bash bypasses the hook’s protected-path policy.** [hook.ts:55](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/hook.ts:55) allows every Bash command except a narrow `git push` regex match. `printf compromised > test/slugify.test.js` was explicitly allowed by the probe. Shell scripts can also modify `.tecera`, disable hooks, or invoke the approval CLI. **Fix:** deny unmediated shell operations that cannot be authorized safely, or route them through constrained operations with deterministic policy checks. The disclosed limitation does not satisfy the requested fail-closed write boundary.

5. **[major] Adapter doctor can certify missing security settings.** [adapters/merge.ts:85](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/adapters/merge.ts:85) returns `true` for incompatible scalar/object types. For example, `{permissions:{deny:false},hooks:false}` counts as containing the generated deny list and hooks. Installation preserves those conflicting values and returns success. **Fix:** compare types and scalar values accurately; preserve user content but report security-setting conflicts as installation/readiness failures.

6. **[major] Execution does not consistently enforce startup validation.** [commands/run.ts:131](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/commands/run.ts:131) loads the schema but never checks runtime compatibility, lock drift, the full secret scan, or ledger integrity before wiring/execution. In `commands/preflight.ts:53`, baseline execution proceeds even when doctor has reported lock drift or a broken ledger. **Fix:** introduce a mandatory execution-readiness check and stop before repository code or model calls when authority/integrity checks fail. A failing test baseline may be expected; failed readiness checks are different.

7. **[major] Narrowed budgets are not the budgets Loop enforces.** [commands/run.ts:209](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/commands/run.ts:209) passes the original manifest to Loop, although `effectiveBudget` calculated stricter goal/CLI limits. Loop derives worker depth, iterations, wall time and retry limits from that manifest/plan; storing the narrower budget on the goal does not enforce it. Only USD and token pools receive narrowed caps here. **Fix:** pass an immutable effective manifest/policy to Loop and validate plans against it. Test actual worker capabilities and retries under `--max-depth` and goal budget overrides.

8. **[major] Accepted plans bypass current-policy validation.** [plans.ts:90](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/plans.ts:90) matches accepted plans using only triggers and beliefs. Loop validates newly generated plans, not library matches. After permissions or budgets are tightened and legitimately re-pinned, an older accepted plan can still execute with obsolete authority. **Fix:** revalidate every matched plan against the current effective policy and budgets before selection or dispatch.

9. **[major] Approval identity is self-asserted.** [runtime.ts:117](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/runtime.ts:117) converts any `--as` value into a human principal; `commands/approve.ts:43` also accepts a caller-supplied session. Ledger separation-of-duty checks do not authenticate that identity. This implements the lane’s local CLI interface, but leaves the explicit authenticated-ingress requirement in the security design unmet, as the report acknowledges. **Fix:** derive the authenticated actor/session from trusted ingress and authorize any requested `--as` identity.

10. **[major] Approval grants survive failure to record their audit event.** [commands/approve.ts:47](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/commands/approve.ts:47) commits the grant before appending `approval.granted` at line 59. A crash or append failure leaves a consumable grant without the corresponding event; retry then fails because it is already granted. Denial has the same projection-consistency problem. **Fix:** make the state transition and audit append atomic, or keep the decision non-consumable until its durable event is committed.

11. **[major] The “wave 2 edits only wiring.ts” claim is false.** [commands/run.ts:145](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/commands/run.ts:145) rejects resume before calling wiring. At line 230, baseline execution uses `rt.verifyRunner` and the original root; `WiredPorts` cannot return a replacement baseline runner/worktree. A tooling failure becomes an `unknown` belief and execution continues. Cancellation is only checked around the complete Loop run; there is no cancellation bridge into Loop, and the bin installs no signal handler. **Fix:** complete lifecycle integration outside the seam, expose the selected execution context/runner, stop on tooling failure, and implement durable resume and cancellation explicitly.

12. **[major] The default verifier does not fully enforce interruption/output limits.** [util/proc.ts:40](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/util/proc.ts:40) spawns before checking whether the signal is already aborted; a probe with an already-aborted signal still executed successfully. At line 59, output overflow merely truncates strings without killing the process; `toolingProblem` ignores `truncated`, allowing an overflowing command that exits zero to pass `gate`. **Fix:** reject pre-aborted requests, kill the process group on overflow, classify overflow as unsuccessful verification, and verify descendant cleanup.

13. **[major] Secret validation silently skips requested inputs.** [manifest/validate.ts:70](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/manifest/validate.ts:70) excludes all `runs/` content, files over 1 MiB and unreadable files. `util/fs.ts:54` follows symlinked directories and suppresses traversal errors. Thus validation can return success without scanning `.tecera/**` text files as specified. **Fix:** stream large files, report unreadable inputs as failures, and use bounded traversal with an explicit link policy.

14. **[minor] Evidence export can silently omit or overwrite evidence.** [commands/evidence.ts:17](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/commands/evidence.ts:17) documents support for `evidence` arrays but only collects `evidenceKey` properties; the probe returned no keys for `{evidence:['verify:123']}`. Missing records are silently skipped, and filename sanitization/truncation can map different keys to the same output file. **Fix:** define supported evidence references, fail/report unresolved references, and use collision-resistant filenames with an index.

15. **[major] Published-package initialization cannot locate its assets.** [commands/init.ts:31](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/commands/init.ts:31) searches ancestors for monorepo `templates/` and `samples/`. `packages/runtime/package.json:9` ships only `dist` and README; `tecera` ships only its bin and README. The documented installed CLI therefore lacks the required assets. **Fix:** bundle assets with runtime and resolve them package-relatively; test initialization from an installed package outside the checkout.

## Missing tests

The source contains **42 cases**, including 11 semver cases. Many tests assert real behavior: managed-block idempotency, unchanged dry-run files, persisted events, protected Edit rejection, and self-approval rejection.

However, [cli.test.ts:493](/mnt/c/Users/nikox/Desktop/Repos/tecera/packages/runtime/src/cli.test.ts:493) claims redacted evidence coverage without planting a secret or asserting an evidence JSON file’s contents. The probe test at line 339 claims the probe never sees credentials, but ignores its second argument—the production call passes the environment.

Missing adversarial coverage includes:

- **`secret.canary_*`:** capture adapter prompts, CLI output/errors, raw ledger/checkpoint storage, verify environment and exported evidence; include encoded secrets and auth headers.
- **`tamper.symlink_hardlink`, `tamper.delete_test`, `tamper.config_edit`, `tamper.ignored_file`:** exercise hook and initialization/adapter boundaries, including Bash writes and dangling links.
- **`approval.replay`, `approval.hash_mismatch`, spoofed identity:** test CLI ingress through consumption, not just repeated approval.
- **`recover.crash_each_step`:** especially grant-before-event failure, ledger failures before execution, interruption and cleanup.
- **`dos.output_flood`:** assert termination and failure, plus already-aborted signals and surviving descendants.
- For wave-2 runtime integration: **`tamper.git_hook`, `review.mutation_after`, `recover.noop_twice`**, and approval-bound resume.
- Narrowed-budget enforcement, accepted-plan revalidation, malformed settings, scan omissions, and installed-package initialization.

Vitest was not rerun because the suite writes fixtures/cache files. The direct local TypeScript compiler passed with `--noEmit`; the `npx` launcher failed before compilation with a DNS/configuration error. Read-only behavioral probes confirmed findings 1, 2, 4, 5, 12 and 14.

## Wiring notes for wave 2

- `main`, `createRuntime`, `WiringContext` and `WiredPorts` fit the current basic Loop interfaces; prohibited concurrent-package imports are absent.
- Resume/recovery, effective budgets, execution readiness, baseline runner/worktree selection and cancellation require changes beyond `wiring.ts`.
- `GateRunner` has no signal or approval-grant parameter. Wiring must establish cancellation and approval context explicitly; it cannot infer authenticated authorization from a successful CLI command.
- The run path does not assemble Brain memory or always-on slots. A worker wrapper must supply them within the context budget, or the composition contract must grow.
- `plan.graduated` is a reasonable catalog-compatible substitution for the requested `plan.accepted`. The default NotWired exit and direct host verifier are explicitly permitted phase boundaries.

## What is solid

- Broad command coverage, injectable I/O and typed composition interfaces.
- Initialization stages writes and meaningfully tests dry-run/idempotency.
- Unknown manifest fields and ordinary inline-key cases are rejected.
- `--yes` does not itself grant approval; candidates require explicit graduation.
- Default unwired execution stops with exit 9, and local typechecking passes.
