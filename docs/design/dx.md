# Design lens: day-one developer experience (2026-10-02)

Produced by a Plan agent. Adjusted in `docs/PLAN.md` (v3): the sample ships **no hand-written loop file**;
the planner seat writes the plan and it is staged as a candidate. Manifest `seats` are
`planner / workers[] / reviewer / reflex`, and `reflexes` + `commitment` fields were added. Everything
else below stands.

## 1. Day-one walkthrough

Target: any git repo with a test command and one failing test. The bundled sample is
`samples/fix-failing-test` (a `slugify` package, one failing test). Prerequisites: Node 20+, git, one or
two provider keys in env.

```
$ cd my-app
$ npx tecera@0.1 init
tecera 0.1.0 — init
  repo       my-app  git · base main@a1b2c3d · clean
  tests      `npm test` (package.json) → exit 1, 1 failing   ← this is the job
  providers  ANTHROPIC_API_KEY → planner/worker  anthropic/claude-sonnet-5
             OPENAI_API_KEY    → reviewer        openai/gpt-5.6-terra  (foreign: yes)
  sandbox    bwrap not found → profile "process" (restricted child, no network, 256MB/60s)
  wrote      tecera.json  .tecera/ (16 files)  CLAUDE.md [managed block]
             AGENTS.md [managed block]  .claude/settings.json [merged]  .gitignore [+2]
  ledger     .tecera/ledger.sqlite  #1 manifest.created sha256:9f3e…
Next: tecera doctor && tecera run "make the failing test pass"
```
`init` never asks questions when it can detect; `--interactive` runs the preferences wizard (ported from
agentic-stack) that fills `memory/personal/PREFERENCES.md`.

```
$ tecera doctor
✓ manifest   tecera.json schema v1 · no inline secrets · hash 9f3e…
✓ node       v22.4.0   ✓ git 2.45 · clean · base main@a1b2c3d
✓ planner    anthropic/claude-sonnet-5 — live completion ok (412ms, $0.0004)
✓ reviewer   openai/gpt-5.6-terra — live completion ok (690ms, $0.0003) · foreign
✓ sandbox    process profile: spawn ok · network blocked · limits enforced
✓ verify     `npm test` in sandbox → exit 1 (a failing test exists, as expected)
✓ ledger     sqlite writable · 3 events
✓ adapters   claude-code (settings+hooks) · codex (AGENTS.md block)
! policy     commit requires approval (default) — approve inline or `tecera approve`
9 ok · 1 note · 0 missing → exit 0
```

```
$ tecera run "make the failing test pass"
run r_01J9K2  goal g_fix-failing-test  budget $2.00 · 20min · depth 3
preflight  manifest hash matches lock · worktree clean · 2 providers · verify baseline exit 1
plan       no plan matched → planner wrote p_7c1 (5 steps) · validated · staged as candidate
intention  i_01 single-minded · steps analyze → edit → verify → review → verify → commit
step analyze  route worker · gate allow
  tool read  test/slugify.test.js                     allow
  tool read  src/slugify.js                           allow
step edit     route worker · gate allow
  tool edit  src/slugify.js (+3 −1)                   allow · inside allowedChanges
  tool edit  test/slugify.test.js                     DENY  · protected path (policy.protectedPaths)
freeze     candidate sha256:4c1d… (writer killed, 1 file changed, ≤ maxChangedFiles 5)
step verify   `npm test` (separate restricted process) → exit 0  1.8s          ✓
step review   openai/gpt-5.6-terra · foreign · VERDICT: PASS · BUGS: none       ✓
step verify   re-run on frozen candidate → exit 0                              ✓
step commit   HELD · commit 1 file (+3 −1) → branch tecera/fix-failing-test
           req ap_7f2a · expires 15m · requester agent:worker · approver you
           [a]pprove [d]eny [v]iew diff › a
commit     7e4f9a1  fix(slugify): collapse repeated separators
done       goal achieved: verify exit 0 · plan p_7c1 staged · evidence .tecera/runs/r_01J9K2/
cost       $0.21 · 18.4k tokens · 1m42s → exit 0
```
Non-TTY (`CI`, piped): the approval line is replaced by `held ap_7f2a → exit 4`; `tecera approve ap_7f2a`
resumes from the ledger checkpoint. The denied edit to the test file is the point of the demo.

Evidence the developer inspects:
```
.tecera/runs/r_01J9K2/
  summary.md        goal, outcome, cost, every gate with pass/fail and digest
  events.jsonl      every event with goal/intention/step/plan ids; `tecera why <event>` walks it
  program-1.js      the model-written program that ran (redacted inputs)
  diff.patch        frozen candidate
  verify-1.log  verify-2.log  review.md  approvals.json  decisions.jsonl
```

### Files created

`tecera.json` (v3 fields):
```json
{
  "$schema": "https://tecera.dev/schema/manifest-v1.json",
  "schemaVersion": 1,
  "id": "bc_8f1e2a9c",
  "name": "my-app",
  "owner": "nikoxenos@gmail.com",
  "runtime": { "tecera": ">=0.1.0 <0.2.0" },
  "repo": { "base": "main", "branchPrefix": "tecera/", "allowedChanges": ["src/**"] },
  "providers": {
    "anthropic": { "auth": "env:ANTHROPIC_API_KEY" },
    "openai":    { "auth": "env:OPENAI_API_KEY" }
  },
  "seats": {
    "planner":  { "provider": "anthropic", "model": "claude-sonnet-5",  "effort": "high" },
    "workers":  [{ "id": "worker", "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "effort": "medium" }],
    "reviewer": { "provider": "openai",    "model": "gpt-5.6-terra",    "effort": "high" },
    "reflex":   { "provider": "rules" }
  },
  "reflexes": { "triage": "rule", "choosePlan": "rule", "route": "rule", "gate": "rule",
                "reconsider": "rule", "closeOut": "rule", "threshold": 0.6 },
  "commitment": "single-minded",
  "concurrency": { "perAgent": 2 },
  "budgets": { "usd": 2, "tokens": 200000, "wallClockSec": 1200, "maxDepth": 3,
               "maxIterations": 20, "maxAttempts": 2, "maxChangedFiles": 5 },
  "sandbox": { "profile": "process", "isolation": "node", "network": false, "memoryMb": 256,
               "execTimeoutSec": 60, "envAllowlist": ["PATH", "HOME", "CI"] },
  "policy": {
    "protectedPaths": ["tecera.json", ".tecera/**", "CLAUDE.md", "AGENTS.md", ".claude/**",
                       ".github/**", "**/package.json", "**/*.lock", "**/tsconfig*.json",
                       "**/*.test.*", "**/*.spec.*", "**/tests/**", "**/__tests__/**"],
    "approvals": { "required": ["commit", "externalWrite"], "ttlSec": 900, "quorum": 1, "separationOfDuty": true },
    "failure": { "onVerifyFail": "retry-once", "onReviewFail": "retry-once", "onLedgerError": "stop" }
  },
  "verify":  { "command": "npm test", "timeoutSec": 300 },
  "review":  { "foreign": true, "maxAttempts": 1 },
  "board":   { "driver": "ledger" },
  "ledger":  { "driver": "sqlite", "path": ".tecera/ledger.sqlite", "retentionDays": 90 },
  "memory":  { "contextBudgetTokens": 40000 },
  "hooks":   { "mandatory": ["budgetPool","recursionLimit","iterationLimit","toolAllowlist","protectedPaths","diffBoundary",
                             "approvalGate","foreignReview","verifyGate","tamperCheck","progressCheck","secretCanary","evidenceRecorder","returnSchema"] },
  "adapters": { "claude-code": { "enabled": true }, "codex": { "enabled": true } }
}
```

`.tecera/` layout:
```
.tecera/
  goals/fix-failing-test.goal.md      what (desire + environmental check + commitment + budget)
  plans/                              graduated plans (empty on day one); candidates/ staged by runs
  skills/_index.md  _manifest.jsonl  fix-failing-test/SKILL.md
  protocols/permissions.json  permissions.md(view)  tool_schemas/*.schema.json  delegation.md
  memory/personal/PREFERENCES.md  working/WORKSPACE.md  working/REVIEW_QUEUE.md
  memory/semantic/DECISIONS.md  lessons.jsonl  LESSONS.md(view)  episodic/(view)
  gates/verify.sh
  adapters/claude-code/adapter.json  adapters/codex/adapter.json
  tecera.lock                         resolved-config hash, skill/adapter digests
  ledger.sqlite  runs/                gitignored
```

`.tecera/goals/fix-failing-test.goal.md`:
```md
---
id: fix-failing-test
kind: achievement
verify: npm test            # done = this exits 0 in a restricted process
commitment: single-minded
budget: { usd: 2, wallClockSec: 1200 }
on-violation: wake-human     # standing goals are re-gated; failure demotes
---
Make the failing test in this repository pass by fixing the implementation.
Do not modify tests, configs, or lockfiles.
```

`.tecera/skills/fix-failing-test/SKILL.md`:
```md
---
name: fix-failing-test
triggers: ["failing test", "test fails", "red suite"]
tools: [read, edit, runVerify]
preconditions: ["verify baseline exits non-zero"]
constraints: ["never edit test files", "one root cause per run", "smallest diff that passes"]
on_failure: stage-candidate-lesson
---
1. Run verify; read the failing assertion before any source.
2. Read the implementation under test; state the root cause in a comment.
3. Edit only files under allowedChanges. Return when verify passes.
```

`.tecera/protocols/permissions.json` (deterministic; the markdown is a rendered view):
```json
{ "always": ["read", "listFiles", "runVerify"],
  "requiresApproval": ["commit", "write_outside_allowed", "network"],
  "never": ["delete_tests", "edit_protected_paths", "git_push", "modify_tecera_config"] }
```

## 2. Manifest checks

| Field | Req | Notes |
|---|---|---|
| `schemaVersion` | yes | integer `1`; `tecera migrate` bumps |
| `id`, `name`, `owner` | yes | `id` stable, generated once |
| `runtime.tecera` | yes | semver range; mismatch fails startup |
| `repo.*` | yes | globs; no blanket `**` with protected exceptions (EEZE rule) |
| `providers.<name>.auth` | yes | reference only: `env:NAME`, `file:path#KEY`, `keychain:tecera/<name>`; inline key patterns rejected |
| `seats.planner/workers/reviewer/reflex` | yes | reviewer must differ in provider when `review.foreign` |
| `reflexes.*`, `commitment`, `concurrency` | no | defaults: all `rule`, threshold 0.6, single-minded, perAgent 2 |
| `budgets.*` | yes | scoped over the whole run |
| `sandbox.profile`, `isolation` | yes | `process` default; `isolation:"node"` records degraded evidence |
| `policy.*` | yes | `separationOfDuty` cannot be `false` |
| `verify.command` | yes | exit 0 = done, no model opinion |
| `review.foreign` | yes | `false` only with `--allow-same-vendor-review`, recorded |
| `board`, `ledger`, `memory`, `adapters`, `hooks` | no / yes for hooks | `hooks.mandatory` must equal `policy.MANDATORY` |
| unknown fields | — | rejected |

`validate` (offline, exit 2): schema, secret canary scan, glob sanity, seat/provider refs, runtime range,
lock drift. `doctor` (exit 3): validate + node/git, each seat with a real completion (cost shown), sandbox
spawn + network block + limits, verify in sandbox, ledger writable, adapters digest, `.tecera/**`
protected self-check. `preflight <goal>` (exit 3): doctor + goal resolves, worktree clean, base reachable,
baseline verify recorded, budget reservation possible, approvers configured.

## 3. Mounting `.tecera/` in Claude Code and Codex

`tecera adapters install` generates host files from `.tecera/adapters/<host>/adapter.json` (merge
policies: `owned`, `managed-block` between `<!-- tecera:start/end -->`, `json-merge`, `create-only`):
```json
{ "harness": "claude-code", "version": 1, "files": [
  { "target": "CLAUDE.md",             "from": "render:brain-summary", "merge": "managed-block" },
  { "target": ".claude/settings.json", "from": "render:permissions",   "merge": "json-merge" },
  { "target": ".claude/skills",        "from": ".tecera/skills",       "merge": "owned-symlink" },
  { "target": ".claude/agents/tecera-reviewer.md", "from": "render:reviewer", "merge": "owned" } ],
  "postInstall": ["tecera adapters doctor claude-code"] }
```
Claude Code reads the CLAUDE.md block (always-on memory slots, permissions, skill index), a settings
deny list derived from `never` + `protectedPaths`, hooks `PreToolUse → tecera hook pre-tool` and
`Stop → tecera hook stop`, and skills via `.claude/skills`. Codex reads the AGENTS.md block and
`.codex/config.toml` profiles from seats; no hooks, so the block instructs calling `tecera gate`.
Not in v1: enforcement inside a host beyond its own deny lists/hooks, sandboxing host-run tools, live
shared sessions, other hosts, memory transfer, secret sync, native Windows.

## 4. CLI v1

Global: `--json --quiet --manifest <path> --no-color --yes` (never auto-approves).

| Command | Key flags | Exit | Ledger writes |
|---|---|---|---|
| `init` | `--interactive --sample --profile --writer --reviewer --dry-run` | 0/1/2 | manifest.created, adapters.installed |
| `validate` | `--strict` | 0/2 | none |
| `doctor` | `--fix --skip-live` | 0/3 | doctor.ran |
| `preflight <goal>` | | 0/3 | preflight.ran |
| `run <goal|statement>` | `--budget-usd --max-depth --dry-run --resume --allow-same-vendor-review` | 0; 4 held; 5 verify failed; 6 review rejected; 7 budget; 8 policy; 9 ledger; 130 interrupted | every event |
| `approve|deny <req>` | `--as --reason` | 0/1/8 | approval.granted\|denied |
| `status` | `--run --watch` | 0 | none |
| `evidence <run>` | `--export --redact` | 0 | evidence.exported |
| `why <event>` | | 0 | none |
| `gate <goal>` | | 0/5 | gate.ran, goal.demoted |
| `plans|memory candidates|graduate|reject|retract` | `--rationale` (required) | 0/2 | plan.*/lesson.* |
| `adapters install|doctor|upgrade <host>` | `--force` | 0/1/3 | adapters.* |
| `migrate` | `--to` | 0/2 | manifest.migrated |

## 5. Public API, packaging, licensing, docs

Packages (npm scope `@tecera`): `tecera` (CLI), `@tecera/contracts`, `@tecera/ledger`, `@tecera/loop`,
`@tecera/reflex`, `@tecera/worker`, `@tecera/policy`, `@tecera/brain`, `@tecera/runtime`. Mosaic forks
(`packages/core|intent|auth`) `private: true`.

Semver: 0.x; minor = breaking, patch = additive; CHANGELOG with `migrate` notes. Stable from 0.1: CLI
commands and exit codes, `tecera.json` v1, `.tecera/` layout, ledger event names, `permissions.json`.
`@experimental` (JSDoc + `/experimental` subpath): programmatic `invoke()/scope()`, hook authoring, reflex
model providers, codex adapter, graduation flows, `sandbox.profile:"docker"`.

Licensing: kernel packages are ports of Apache-2.0 code (JAZ, agentic-stack) → release `tecera` and
`@tecera/*` under **Apache-2.0** with `NOTICE` crediting both upstreams and `THIRD_PARTY_NOTICES.md`.
Mosaic forks remain PROPRIETARY and never ship in public packages. Root `package.json` `license` must
become per-package before first publish. (Owner to confirm.)

README outline: thesis → 60-second quickstart (transcript above) → what a run does → the files you edit
(goal, permissions, preferences) → mounting in Claude Code/Codex → safety model in five bullets → packages
and stability table → license. Three launch docs: `docs/quickstart.md`, `docs/manifest.md`,
`docs/safety-and-evidence.md` (+ `docs/why-trace.md` in v3).

## 6. Day-one adoption risks

| Risk | Mitigation |
|---|---|
| Two API keys required | one key works: reviewer falls back to another model of the same vendor with a loud warning, `review.foreign:false` recorded, `--allow-same-vendor-review` required |
| Sandbox prerequisites | `process` profile default; `doctor` names the upgrade path |
| Time-to-first-success > 10 min | `init --sample`; full detection; `run --dry-run` shows plan and cost without model calls |
| Concept overload | `init` creates one goal and one skill; plans are generated; `IntentionInstance` is never a user file |
| Hidden costs | every live call prints cost; `budgets.usd` mandatory and shown at run start |
| "returned ≠ done" confusion | `status`/`summary.md` show gate state; exits 5/6 distinguish verify vs review |
| Approval friction | inline TTY approval with diff; non-TTY holds durably |
| Secrets committed | references only; canary scan; ledger and runs gitignored |
| Host users expect enforcement | docs state plainly what hosts get; enforcement is `tecera run` |
