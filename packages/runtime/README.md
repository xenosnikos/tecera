# @tecera/runtime

The composition root and the `tecera` CLI. `wireRunPorts` (src/wiring.ts) builds every port of one run;
`commands/run.ts` drives the Loop over them.

## Behaviour

- **no auth package.** `@tecera/auth` is gone from this package and the JWT ingress is deleted. Approvals and
  learning decisions are made by the local human principal (`--as <id>`, default `$USER`; src/principal.ts),
  recorded in the audited `approval.granted` event and its `approval.identity` evidence. Separation of duty is
  the ledger's: the requester (the loop) can never approve, a principal never approves its own request (exit 8).
  Agents cannot reach `tecera approve` (the pre-tool hook refuses it from a mediated shell).
- **reflexes on.** Seams are `rule` / `model` / `frontier` (the manifest refuses `off`); the planner seat is
  the frontier, wired into the reflex router and as `LoopPorts.frontier` (metered by its own SeatMeter).
- **budgets off by default.** `openRunPools` opens usd / tokens / calls / wallMs with `budgets.enforce`
  (default false): usage is reserved, settled and reported (`budget.exhausted` once per pool), never a stop.
  The durable deadline and the reviewer / frontier seat meters follow the same switch. Loop-safety limits
  (depth, iterations, attempts, exec timeouts) always hold. Every run ends with a cost line; `tecera evidence`
  writes the cost per step, per model and per seat into summary.md (src/cost.ts: one `cost.call` event per
  model call, plus the pools' usage).
- **proof of achievement.** "Achieved" has one source: `@tecera/contracts` `ledgerProvenRun` (the hash chain,
  the verify evidence and its digest, the `verify.passed` it follows, the accepted contract and every
  criterion proof), called with the manifest's provisioning allowance, `acceptance.signoff: always` as
  `requireApproval`, and the run's secrets (src/proof.ts). The run's exit status uses it (a `goal.achieved`
  event alone exits 9, not 0), and so do `tecera status` and `tecera criteria show`. `tecera hook stop`
  (Claude Code's Stop hook, src/stopHook.ts, through `@tecera/policy` `evaluateStopLedger`) exits 2 with
  `goal not achieved: …` while a run of this business case is active (running, held, interrupted) and not
  proven, while a run ended provisional (exit 10) and neither it nor a later run of the same goal is
  proven, when the ledger's chain does not verify, or when the business case's `tecera.json` (or the one
  named with `--manifest`) cannot be found, read or validated; exit 0 otherwise (also outside any business
  case). It never considers budget. Every decision is recorded (`stop.blocked` / `stop.allowed`).
- **review plugged in.** `review.foreign` must be true; the reviewer seat runs live on its own key and the
  review gate checks provider AND key fingerprint against every writer. `--allow-same-vendor-review` is gone.
- **PR-level gating.** Writes inside `repo.allowedChanges` on the leased work branch proceed under any
  isolation (fenced, protected paths and tamper rules apply); the commit lands on `tecera/<goal>` without
  approval; `gate.pr` is the only approval point (exit 4 while it waits). After `tecera approve` the resume
  pushes the branch to `origin` and opens the PR with `gh pr create` when gh is on PATH and authenticated, or
  records `pr.requested` with a patch bundle under `.tecera/runs/<run>/pr/`. Tecera never merges (`merge` is in
  `never`; the host settings deny `git push`, `gh pr create`, `git merge` and `gh pr merge`).
- **live keys.** Providers come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. The shipped
  template and sample seat the planner (`anthropic/claude-sonnet-4.5`) and the worker (`anthropic/claude-haiku-4.5`)
  on OpenRouter and the reviewer (`gpt-5.6-terra`) on OpenAI. `tecera doctor` probes every seat live (under a
  $0.05 cap). `src/live.test.ts` runs only with the keys in the test process (source
  an env file that exports them): the doctor probes and the sample end to end through real models.

## A run, as the end-to-end test produces it

`src/e2e.test.ts` runs `samples/fix-failing-test` as shipped (a temp git copy; `verify.command` and
`scripts.test` are `node --test`) with scripted models: real ledger, real provider adapters behind a scripted
transport, real sandbox child, real verify runner, real gates and git. The sample uses `sandbox.isolation:
"node"` (degraded, recorded): both worker steps, the gates and the commit run without any approval; the run
holds only at the PR. This is the transcript it writes (`TECERA_E2E_TRANSCRIPT=<file>`; this host runs as root,
hence `TECERA_VERIFY_ALLOW_ROOT=1` and the `verify degraded` line):

```
$ tecera run fix-failing-test --scripted <fixtures>
run        r_e4  goal fix-failing-test
worktree   /tmp/tecera-wt-XXXXXX/r_e4 (git worktree at main@7dac388) · lease token 1
verify     degraded: verify controls missing: uid; runs as root (uid 0): can write supervisor files and start work outside containment
scripted   replies from /tmp/tecera-scripts-XXXXXX (no network, no model)
isolation  node: the worker child has no OS isolation beyond what the host provides (recorded as isolation.degraded); writes to the work branch proceed fenced, the PR gate is the approval point
cost       $0.0111 · 7,240 tokens · 3 model call(s) · usd pool $0.0652/$2.0000 incl. reservations (not enforced) · by model: openrouter/anthropic/claude-haiku-4.5 $0.0070, openai/gpt-5.6-terra $0.0041
run r_e4  goal fix-failing-test  → held for PR approval ap_ev_e86 → exit 4
→ exit 4
$ tecera hook stop          # Claude Code Stop hook, payload on stdin
tecera: goal not achieved: run r_e4 (goal fix-failing-test) is held for a human decision and has no goal.achieved proof — Tecera run r_e4 for goal fix-failing-test is active without a goal.achieved proof (no proof of achievement). Keep working until the goal's check passes through the run (`tecera run --resume`, `tecera status`), or hand back to a human (`tecera approve` / `tecera deny`) — do not stop yet.
→ exit 2
$ tecera approve ap_ev_e86 --as reviewer-human --yes
note: --yes never approves; this decision is the explicit command you ran
approved ap_ev_e86 as reviewer-human (local principal, --as) (step pr, run r_e4) · event ev_e92
resume the run with `tecera run --resume r_e4`
$ tecera run --resume r_e4 --scripted <fixtures>
run        r_e4  goal fix-failing-test  (resume)
worktree   /tmp/tecera-wt-XXXXXX/r_e4 (git worktree at main@7dac388) · lease token 2
verify     degraded: verify controls missing: uid; runs as root (uid 0): can write supervisor files and start work outside containment
scripted   replies from /tmp/tecera-scripts-XXXXXX (no network, no model)
isolation  node: the worker child has no OS isolation beyond what the host provides (recorded as isolation.degraded); writes to the work branch proceed fenced, the PR gate is the approval point
recovered gate.pr pr: held (approval ap_ev_e86 is granted)
plan p_a529e0b9 staged as a candidate (its goal was achieved)
cost       $0.0111 · 7,240 tokens · 3 model call(s) · usd pool $0.0652/$2.0000 incl. reservations (not enforced) · by model: openrouter/anthropic/claude-haiku-4.5 $0.0070, openai/gpt-5.6-terra $0.0041
run r_e4  goal fix-failing-test  → goal achieved (environmental check passed) → exit 0
→ exit 0
$ tecera hook stop
tecera: run r_e4 proved its goal: `node --test` exited 0 on ea104c66e9a3 (evidence verify:r_e4:ev_e16:verify2:1:0)
→ exit 0
```

Events of that run (belief.added and decision.recorded omitted):

```
evidence.appended(run.scripted, worktree.leased, verify.degraded) run.started evidence.appended(run.policy)
isolation.degraded goal.adopted plan.generated intention.pushed
step.* analyze · step.* edit (evidence.appended tool.denied: test/slugify.test.js; the src write lands, no approval)
verify.passed → review.passed → verify.passed → commit.recorded (tecera/fix-failing-test, no approval)
approval.requested(pr, sha) step.held intention.held run.ended(4) · stop.blocked
approval.granted · step.requested step.started approval.consumed(by gate.pr) pr.requested(branch, base, bundle)
step.completed intention.done goal.achieved(proof) plan.staged run.ended(0) · stop.allowed
```

The test also asserts: the commit is on `tecera/fix-failing-test` before any approval and touches only
`src/slugify.js`; the developer's checkout is untouched; the PR approval is bound to the committed sha
(`prActionHash`) and consumed once by the PR gate; the patch bundle and request.json are under
`.tecera/runs/<run>/pr/`; `goal.achieved` carries `{command, exitCode 0, fingerprint, evidenceKey, verifiedAt}` of
the final verify; the hash chain verifies; `tecera why <pr event>` walks back to `goal.adopted`; `tecera evidence
<run>` writes the proof, the PR and the cost tables with no missing record; the plan is staged exactly once,
after `goal.achieved`; `replayRun(ledger, runId)` re-derives `goal.achieved` (the PR's audited, consumed
approval, the proof); main never moves. A second test adds a bare `origin` and a fake `gh` first on PATH: the
branch is pushed, `gh pr create` opens the PR (`pr.opened` with its url), gh sees no model key, nothing merges.

`src/recovery.test.ts` runs the security.md §4 crash matrix: the first segment of the run executes in a child
process (the real CLI and wiring, from `dist`) that SIGKILLs itself at S2–S8; the harness does NOT clean up
after it. The restart (`tecera run --resume`) reaps the dead supervisor's processes itself, restores the
worktree to the loop's required checkpoint before `confirmWorktreeRestored`, and the matrix outcome is asserted
(worker restart with attempt + 1; interrupted verify re-run; a lost review stops for a human without another
reviewer call; the durable PR approval re-held; commit reconciled, never repeated; one commit, one PR).

## Acceptance contracts, capabilities and provisioning (D8–D12)

- **A request is a contract.** `tecera run "<statement>"` adopts the goal with `draftContract`: the planner
  drafts an acceptance contract (criteria, each with its own check; out of scope; assumptions; the
  capabilities the criteria need), recorded as `criteria.drafted`. Nothing is planned and no worker runs
  until the requestor signs it off: the run holds (exit 4, `held for criteria sign-off approval …`).
  `tecera criteria show <run>` prints it; `tecera criteria accept <run> [--as you]` grants the pending
  `accept_criteria` approval (exactly `tecera approve`: a local human, never the requester, which is
  Tecera); `tecera run --resume <run>` then records `criteria.accepted` and plans against that contract.
- **Goal files carry criteria.** Front matter `criteria:` is a one-line JSON flow list:
  `criteria: [{"id": "tests-pass", "statement": "the suite passes", "verify": "node --test", "timeoutSec": 120, "requires": ["db"]}, {"id": "readme", "statement": "the README explains it", "ask": "Is the README clear?"}]`.
  `verify` is a command criterion, `ask` a human one; at least one must be a command. Such a file is its
  own accepted contract under `acceptance.signoff: statement` (no sign-off hold); `always` holds every run.
  A goal file without `criteria:` keeps the single-check path (its `verify` alone), exactly as before.
- **One id, one branch.** The ledger goal id is the goal file's id, or the statement's slug
  (`make-the-failing-test-pass`); it names the work branch (`tecera/<id>`) on the first segment and on every
  resume. The gates look the goal up by that id. Runs adopted before (with `g_<id>`) still commit to the
  named branch. `g_` is reserved: `g_<id>` refers to the goal file `<id>`, so no goal file id starts with it.
- **Every criterion is verified.** The verify gate runs each command criterion on the frozen candidate;
  the PR lists every criterion, how it was proven and at what fidelity. Human criteria are asked at the PR
  hold, one `answer_criterion` approval each (`tecera approve <request>`).
- **Capabilities are probed, provisioned, mocked or asked for.** Manifest `connections` are probed for real
  (their `probe` command through the contained verify runner in the worktree, or their `auth` reference
  resolved without printing it). For each capability a criterion requires, the loop takes the gap ladder:
  use it; provision it in Tecera's own space (`provisioning`: local `tmpdir`, `git-remote`, `sqlite`,
  `http-stub`, at most `maxResources` per run, `ttlSec` each, under `$TECERA_RESOURCES`, default
  `~/.tecera/resources`); serve a stand-in when the connection is `mockable`; or hold and ask
  (`provide_capability`, exit 4). `tecera doctor` and `tecera preflight` print the inventory.
- **Stand-ins never count as real.** A capability resolved to `mock` is served to the step by the broker
  (a generic store for store kinds, a message sink for mail-like kinds), named after the capability; its
  first use records `capability.mocked`. A goal with a criterion on a mock is `goal.provisional`: the PR opens
  marked provisional, the run exits **10** (never 0) and the Stop hook keeps blocking.
- **Provisioned resources are debts.** Each `resource.provisioned` carries its locator (an absolute path or
  a loopback URL, never a credential nor another host), teardown (no credential either, in any encoding) and
  expiry. While the run's registry reports a problem or a resource past `maxResources`, no resource is
  handed to a worker and no provisioned remote is pushed to. A provisioned sqlite or http-stub is a brokered tool named after its capability. A
  provisioned `git-remote` (its locator an absolute local path) receives the work-branch push when the
  repository has no remote of that name (added to the worktree for the delivery only). The PR lists every pending resource. `tecera resources list`
  shows them; `tecera resources transfer <id> [--to who]` hands one to a human; `tecera resources release <id>`
  runs its recorded teardown. Expired resources are released at the start of every run. Agents cannot reach
  `tecera criteria accept|amend` or `tecera resources release|transfer` (the pre-tool hook refuses them).
- **Amendments re-plan.** `tecera criteria amend <run> --file contract.json --reason text [--as you]` records
  `criteria.amended` with the human as actor. `accept` and `amend` refuse (exit 9) on a ledger whose hash
  chain does not verify. The acceptance is stale: the next resume drops the running
  intention (no step of it runs again) and holds for a sign-off of the new contract, then re-plans for it.
- **Scripted.** A scripted directory may hold `contract.json`: the contract proposal(s) the planner drafts
  for a statement (`{criteria, outOfScope?, assumptions?, needs?}`, or a list with `when` substrings). The
  scripted `plan.json` is stamped with the accepted contract's hash and capabilities, and its `gate.verify`
  steps are bound to the contract's command criteria. `test-fixtures/fix-failing-test` has all three files:
  `tecera run "make the failing test pass" --scripted test-fixtures/fix-failing-test` runs offline.

`src/criteria.e2e.test.ts` proves it end to end with scripted models, the real sandbox and real gates: a goal
file with criteria reaches achievement through the PR hold alone; a statement run holds for sign-off, then
the PR, then is achieved on `tecera/make-the-failing-test-pass`; a mocked capability ends provisional (exit
10, PR marked, Stop blocks); a provisioned bare remote receives the push, is listed for transfer and is torn
down by `tecera resources release`; an amendment at the PR hold drops the intention, holds for sign-off and
re-plans for the new hash.

## What wiring builds (src/wiring.ts)

1. **Scripted mode** (`--scripted <dir>` or `TECERA_SCRIPTED=<dir>`). The directory holds `plan.json`
   (optional), `contract.json` (optional) and `replies.json` (`{seat: [reply...]}`). Only the provider transport is replaced (src/scripted.ts);
   the run records `run.scripted` evidence. A run cannot switch between scripted and live across resume.
2. **One provider per seat.** `createProvider` runs over the run's SecretStore, with the shared redactor on top
   (`anthropic`, `openai`, `openrouter`; src/providerSetup.ts maps OpenRouter onto an older providers build).
   Every completed call is recorded as a `cost.call` event (worker and review calls with the step's trace).
3. **The worktree lease** (src/worktree.ts):
   - The worktree lives at `$TECERA_WORKTREES/<runId>` (default `~/.tecera/worktrees`), outside the business case.
     The root is created 0711 so the verify identity can enter the worktree; when the home directory does not let
     others traverse it (root's 0700 home), the default is `<tmpdir>/tecera-<uid>/worktrees`, which must be
     owned by this uid and writable by nobody else.
   - A git repository gets `git worktree add --detach <base>` under host-controlled git, after `assertSafeRepo`.
   - A business case that is not a git repository gets a private copy with a fresh one-commit repository,
     recorded as `worktree.no-git`.
   - The lease is `ledger.lease('worktree:<runId>')`, renewed while the run lives. Its fencing token goes to every
     worker step. Resume reuses the worktree and refuses if it is missing or foreign.
   - **Losing the lease revokes authority**: `lost` fires, the Loop stops (`leaseSignal`) and aborts its running
     steps, live sandbox children are disposed, every write-class tool (src/fencing.ts) and every gate call
     re-proves the lease on the ledger right before it runs (a stale token or a refused renewal refuses it).
4. **Verify runner.** `ProcessVerifyRunner` gives an owned process tree, a scrubbed env and a network namespace.
   A host without containment refuses the run with exit 3. A root supervisor is refused unless the operator
   names an unprivileged identity (`TECERA_VERIFY_UID` / `TECERA_VERIFY_GID`, which must be able to read the
   worktree and run the check) or explicitly accepts a degraded root verify (`TECERA_VERIFY_ALLOW_ROOT=1`,
   recorded as `verify.degraded`; the run is then recorded as degraded — never a hold, D6).
   These switches are read from the operator's environment, never from the manifest.
5. **Worker.** `StepWorker` runs a `ChildProcessRepl` per exec, built from the manifest's sandbox profile, plus:
   - the fourteen mandatory hooks (`assertMandatory`);
   - the tools read/edit/listFiles, and runVerify bound to the goal check;
   - every known secret, for redaction and the canary;
   - Brain context (lessons, episodes) added to each step's inputs.

   The tool kinds `tool.denied`, `sandbox.*` become `evidence.appended` events that carry the step trace.
   Provisioned sqlite / http-stub resources join the tools under their capability's name; a step whose plan
   names a capability the loop resolved to `mock` gets its stand-in (`WorkerStepRequest.mocks`), and the
   stand-in's first use is recorded as `capability.mocked` on the step's goal.
6. **Gates.** `createGates` gets the METERED reviewer seat (src/metering.ts: reserve before, settle at actual
   after, an overrun is exhaustion → exit 7), every writer identity, the redactor, the worktree and the
   session. verify/review/commit/pr/reconcile are exposed. The commit branch is `<branchPrefix><goal name>`;
   the PR gate gets `.tecera/runs` for its bundle, the run's PATH for gh (gh sees only its own variables) and
   the run's cost line for the PR body. A gates build without a PR gate fails `gate.pr` for a human.
7. **Planner.** `ScriptedRunPlanner` (src/scripted.ts) is used when a scripted plan is given. Otherwise
   `LLMPlanner` runs on the planner seat, with Brain lessons and deliberations recorded as evidence. The Loop
   reserves before and settles after every planner call and every contract draft; the planner's usage reports
   are bridged onto the Loop's meter (counted once). The planning context (accepted contract, inventory,
   allowance) reaches the planner and the validator.
8. **Validator, route costs and frontier.** The goal-aware `createPlanValidator` runs over the real tool catalog
   (plus, under a contract, the capabilities its criteria require) and worker seats. Route costs come from the price table. The planner seat is the frontier, metered like the
   reviewer (a budget refusal propagates); it can only tighten a reflex answer (src/frontier.ts).

9. **Capabilities.** `ConnectionProbe` (`LoopPorts.probe`), the `LocalProvisioner` (`LoopPorts.provisioner`;
   tmpdir and sqlite payloads are handed to the verify identity when the supervisor is root), the secrets
   predicate (`LoopPorts.secrets`) and the expiry sweep (`sweep()`).

`executeRun` opens the `usd`, `tokens`, `calls` and `wallMs` pools (`openRunPools`, soft unless
`budgets.enforce`), binds the goal's check into the effective
manifest (gates, worker and baseline run the same command) and records the run's policy fingerprint. It runs
the baseline through the verify gate (which also records the ignored-file baseline the commit gate needs),
cancelled by the durable run deadline when budgets are enforced. A generated plan is staged only after its goal is achieved
(src/staging.ts).

`resumeRun` re-validates the restored authority against the current policy (exit 8 when a plan is no longer
allowed, or a worker suspension's policy changed), then `Loop.restore()` recovers every unfinished step,
granted and audited holds are resumed, and the loop is driven whenever anything was resumed, recovered or is
dispatchable.

`defaultProbe` (doctor) is a real completion per seat through the provider adapters and
`@tecera/providers` `doctorProbe`; doctor and preflight run it last, only when every offline check passed.

## Exit codes (dx.md §4)

| Code | Meaning |
|---|---|
| 0 | goal achieved (proven by `ledgerProvenRun`) |
| 3 | not ready / wiring refused |
| 4 | held: criteria sign-off (`tecera criteria accept`), a capability ask, a human criterion or the PR (`tecera approve`), then `tecera run --resume` |
| 5 | verify failed |
| 6 | review rejected |
| 7 | budget (only with `budgets.enforce: true`) |
| 8 | policy |
| 9 | ledger / loop stopped / lease lost / a human is needed (no progress, unreconciled commit) / a `goal.achieved` the ledger does not prove |
| 10 | provisional: every criterion proven, one on a mocked capability; the PR says so; never achieved |
| 130 | interrupted |

Only the current execution segment counts: a run that was interrupted and then resumed to success exits 0.
