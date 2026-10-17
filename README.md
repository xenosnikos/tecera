# Tecera

Tecera is an execution node for rule-bound work. You hand it a goal with a check that proves the goal is
done. A frontier model writes the plan, cheaper models do the work inside a restricted sandbox, a model
from a different vendor reviews the result, and a human approves once, at the pull request. Every action is
appended to an append-only, hash-chained log, and a goal is marked achieved only with proof that its check
passed.

It is not an assistant and not a framework for writing agents. Assistants and people delegate to it; it
returns the result, the record of how it got there, and what it cost.

> **Status: research-grade.** One end-to-end job with real models has been delivered; harder ones have not,
> and a review of the code found safety defects that are still being fixed. Do not point it at a repository
> or credentials you care about. Coding is the only implemented kind of work. See
> [Status and known limitations](#status-and-known-limitations).

## How it works

Tecera's control structure is the BDI cycle (beliefs, desires, intentions) over an append-only event log.

```
request ──► acceptance contract (criteria, each with its own check; the requestor signs it off)
                  │
                  ▼
goal + criteria ──► capability inventory (declared connections probed; a missing one is provisioned
                  │                       locally, mocked behind the broker, or asked for)
                  ▼
              plan (frontier model writes one if none matches; staged until a human promotes it)
                  │
                  ▼
        worker steps ──► gate.verify ──► gate.review ──► gate.verify ──► gate.commit ──► gate.pr
        (cheap models,    (run the        (different      (re-run on      (work branch,   (the one human
         sandboxed)        check)          vendor)         the frozen      no approval)    approval; never
                                                           candidate)                      merges)
```

- **Beliefs** are a projection of the log. Nothing is remembered that cannot be traced to an event.
- **Goals** carry an environmental check. A worker returning is never completion; the check passing is.
- **Acceptance contracts** turn a request into criteria, each proven by a command or a named human
  judgment, and the list of paths the change may touch. A free-text request holds until the requestor
  accepts the contract; a goal file that carries criteria is already accepted. Every proof records how the criterion was met: `real`, `provisioned`
  or `mocked`. A goal that rests on a mock is `provisional`, never achieved.
- **Provisioned resources are debts.** When a criterion needs a capability the project lacks, Tecera can
  create a local stand-in (a temporary directory, a bare git remote, a SQLite file, a loopback HTTP stub)
  inside a declared allowance. Each is logged with its teardown and listed in the PR until a human
  transfers or releases it. Tecera never widens its own access in your systems. (The HTTP stub is not yet
  usable by a criterion's check; see the limitations below.)
- **Intentions** are committed plans. Independent steps run concurrently; dependencies impose order.
- **Reflexes** make the small decisions between steps (which plan, which model, allow or hold, interrupt,
  did it work). They are rules by default and escalate to the frontier model when unsure.
- **The harness holds authority, not the model.** Fourteen mandatory hooks (budget accounting, recursion
  and iteration limits, tool allowlist, protected paths, diff boundary, approval gate, foreign review,
  verify gate, tamper check, progress check, secret canary, evidence recorder, return schema) are enforced
  in code. A project that does not enable all of them does not start.

More detail: [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md).

## Quickstart

Requirements: Node 22, git, Linux or WSL2. Yarn 4 comes through corepack. Checks run only inside a
contained process (its own network namespace and an owned process tree); on a host that cannot provide
that, `tecera run` stops with exit 3 and the check is not run.

```bash
corepack enable
yarn install
yarn build
yarn test                 # every package, offline, no model calls
```

### Run the sample offline (scripted models)

A scripted run replaces only the model transport: no network and no model is used, but the readiness check
still requires the key of every provider a seat uses to be set. Any two different placeholder values of
at least eight characters will do (the reviewer's key must differ from the writers' key).

```bash
cp -r samples/fix-failing-test /tmp/tecera-demo && cd /tmp/tecera-demo
git init -q -b main && git add -A && git commit -q -m base
TECERA=/path/to/tecera/packages/tecera/bin/tecera.js
FIXTURES=/path/to/tecera/packages/runtime/test-fixtures/fix-failing-test

# Placeholders, never sent anywhere in a scripted run. Without them the run exits 3 (not ready).
export OPENROUTER_API_KEY=offline-placeholder-writer OPENAI_API_KEY=offline-placeholder-reviewer
# As root only (see the note below): export TECERA_VERIFY_ALLOW_ROOT=1

node $TECERA init
node $TECERA run fix-failing-test --scripted $FIXTURES
# exit 4: held at the PR gate. The output names the approval request and the run id.
# (A free-text request holds first for the acceptance contract: `tecera criteria show|accept <runId>`.)
node $TECERA approve <request> --as you
node $TECERA run --resume <runId> --scripted $FIXTURES      # exit 0: goal achieved
node $TECERA evidence <runId> --export ./evidence           # summary.md, events.jsonl, the evidence
node $TECERA why <event id>             # an id from events.jsonl: action → step → intention → goal
```

The sample repository has no remote, so the approved run writes a patch bundle under
`.tecera/runs/<runId>/pr/` instead of opening a pull request.

### Run it with real models

The shipped sample seats the planner and worker on OpenRouter and the reviewer on OpenAI.

```bash
export OPENROUTER_API_KEY=...   OPENAI_API_KEY=...
node $TECERA doctor                    # probes every seat live, under a $0.05 cap
node $TECERA preflight fix-failing-test
node $TECERA run fix-failing-test      # then approve and resume as above
```

Running as root (common on WSL): verification refuses to run as root, and the run stops with exit 3. Set
`TECERA_VERIFY_UID` and `TECERA_VERIFY_GID` to an unprivileged user that can execute `node`, and
`TECERA_WORKTREES` to a directory that user can read. `TECERA_VERIFY_ALLOW_ROOT=1` instead accepts a root
verify with weaker containment; the run records it as degraded. That is acceptable for the scripted
sample, not for code you do not trust.

## What a run gives you

- A commit on `tecera/<goal>` and either an opened pull request (when the repository has a remote and `gh`
  is authenticated) or a patch bundle under `.tecera/runs/<run>/pr/`. Tecera never merges. When a goal is
  planned again in the same run (its acceptance contract was amended, or its plan was interrupted), the new
  plan works on a fresh branch cut from the base the run started on: `tecera/<goal>.2`, then `.3`. The
  earlier branch is kept as it was and is not delivered.
- `goal.achieved` with a proof: the check command, exit code 0, the candidate fingerprint and the evidence
  key of the passing verification, plus one proof per acceptance criterion with its fidelity. The PR
  body lists every criterion, how it was proven, and any provisioned resource awaiting transfer.
- A hash-chained ledger of every event, decision and model call, with cost per step and per model.
- A generated plan staged as a candidate once its goal is achieved. It joins the plan library only when a
  human graduates it with a written rationale (`tecera plans graduate`).

## Command line

```
tecera init | validate | doctor | preflight <goal>
tecera run <goal|statement> [--dry-run --scripted <dir>]      tecera run --resume <runId>
tecera approve <request> [--as <you>]      tecera deny <request> [--as <you>] --reason <text>
tecera criteria show|accept|amend <run> [--as <you>]      tecera resources list|release|transfer <id>
tecera status | evidence <run> [--export <dir>] | why <event> | gate <goal>
tecera plans|memory candidates|graduate|reject|retract <id> --rationale <text>
tecera adapters install|upgrade|doctor <host>        tecera hook pre-tool|stop
tecera hardened init|enroll [--import <ledger>]|status|abandon <run> --reason <text>
```

Exit codes: 0 ok · 1 error · 2 invalid or usage · 3 not ready · 4 held for approval · 5 verify failed ·
6 review rejected · 7 budget (only when `budgets.enforce` is true) · 8 policy · 9 ledger or human needed ·
10 provisional (every criterion proven, at least one on a mock) · 130 interrupted.

In single-user mode (the default) approvals are local and unauthenticated. `tecera approve`, `criteria accept` and the other decision
commands record whoever `--as` names (default `$USER`) as a human principal; there are no tokens and no
login. The ledger refuses a grant from the requester (the loop) or from a non-human principal, binds each
grant to one action and consumes it once, but it cannot tell which local process typed the command. The
decision commands refuse (exit 8) when they run under an agent host (Claude Code, Codex, Tecera's own
sandbox) or without a terminal; set `TECERA_DECISION_NONINTERACTIVE=1` to decide from a script you control.
This guard prevents accidents and is not authentication. In hardened mode the same commands also refuse
(exit 8) unless they run as the operator's uid, read from the process credentials.

## Configuration

A project is a *business case*: a `tecera.json` manifest plus a `.tecera/` folder.

- **`tecera.json`**: seats (planner, workers, reviewer), reflex settings, commitment policy, budgets,
  sandbox, protected paths, the verify command, declared `connections` (each with a probe command and
  whether a stand-in may serve it), the local `provisioning` allowance, and the mandatory hooks. Secrets
  are references (`env:NAME`), never values; unknown fields are rejected.
- **`.tecera/`**: goals (what, the check, and optionally the acceptance criteria and the change-path
  envelope: the only paths the change may create, modify or delete), graduated plans, skills, permissions,
  and memory. The ledger and run folders live here too and are git-ignored.

`tecera adapters install <host>` (also run by `tecera init`) mounts a business case into a host
assistant. What is installed differs by host:

- **Claude Code** (`claude-code`): a managed block in `CLAUDE.md`, and a fragment merged into
  `.claude/settings.json` holding a deny list (edits to protected paths and, with the shipped
  permissions, `git push`, `gh pr create`, `git merge`, `gh pr merge`), a pre-tool hook (`tecera hook pre-tool`) and a stop hook
  (`tecera hook stop`). The pre-tool hook is meant to keep the assistant's edits inside the allowed paths
  and to keep it from running Tecera's human decision commands; the stop hook is meant to refuse the end
  of a session while a run of the business case is active without proof of achievement. Both call the
  `tecera` binary, which must be on `PATH`.
- **Codex** (`codex`): a managed block in `AGENTS.md` and nothing else. No deny list and no hooks are
  installed; the block tells the agent to run `tecera gate <goal>` itself before it stops. Under Codex
  nothing installed by Tecera keeps an agent from editing protected paths. `tecera approve` and the other
  decision commands refuse when they see a `CODEX_*` variable, as they do under Claude Code; an agent that
  clears its environment gets past that.

The host adapters are a second layer. Enforcement proper is `tecera run`: sandboxed workers and gates run
by the harness.

**Hardened mode** (opt-in) separates the person from the assistant at the operating-system level. The
host assistant runs as its own account; Tecera's ledger, its run registry and a checkpoint of the ledger's
head live in a directory owned by the operator's account, which the assistant can read but not write; and
every human decision command checks that it runs as the operator's uid. It is configured by a host file,
`/etc/tecera/hardened.json`, not by the manifest the assistant can edit. `tecera hardened init` prints the
setup commands for an administrator (it changes nothing itself), `tecera hardened enroll` creates or imports
a business case's ledger, and `tecera doctor` reports whether the host meets the preconditions. Checks
run repository code and never run as the operator in this mode, which today means a root supervisor that
runs them as another account (`TECERA_VERIFY_UID`). What it does and does not guarantee is in
[docs/security.md](docs/security.md) (section 4, "Hardened mode").

## Packages

| Package | Responsibility |
|---|---|
| `@tecera/contracts` | Manifest schema, BDI types, event catalog, ports, redaction, replay derivation |
| `@tecera/ledger` | Append-only hash-chained log (SQLite and in-memory), budgets, leases, approvals |
| `@tecera/loop` | The cycle: plan matching and generation, intentions, dispatch, recovery |
| `@tecera/reflex` | The six decision seams as rules, with a router that escalates and records |
| `@tecera/worker` | Model-written programs in a restricted child process, broker, tools, verify runner |
| `@tecera/policy` | Permissions, diff boundary, tamper checks, plan validation, mandatory hooks |
| `@tecera/brain` | Memory tiers over the log; replay admits only valid entries; human-only graduation of lessons |
| `@tecera/providers` | Anthropic, OpenAI and OpenRouter adapters with usage and cost |
| `@tecera/planner` | Planner prompt, strict plan schema, validation and repair |
| `@tecera/gates` | Verify, foreign review, commit and pull-request gates |
| `@tecera/runtime`, `tecera` | Composition root and the CLI |
| `@tecera/adversarial` | The named attack cases from the security design, run against the real components |
| `@tecera/bench` | Benchmark scenarios, a runner that drives the real CLI, and a scorer; its pass rules are being revised |

## Status and known limitations

Tecera is research-grade. What follows is the state of the code, not a roadmap.

- **Scope.** Coding is the only implemented kind of work. Only the `process` sandbox profile exists;
  `bwrap` and `docker` are accepted by the manifest and refused at run time.
- **Live results.** In the latest live run on the five bundled benchmark scenarios, 3 passed their
  scenario rules and 2 reached their goal with a delivered, human-approved pull request (fixing a failing
  test, and persisting sessions in a provisioned SQLite database); the mocked-mail scenario ended
  provisional as its rules require. The rate-limiting and CSV-export scenarios did not reach their goal in
  two attempts. In six live runs no goal was falsely reported achieved and no policy violation landed.
  The failures of that run and what changed since: a worker could call the test runner, ignore a failing
  result and return anyway (now the last writing step before the verify gate cannot return until its own
  check has passed, on the tree as it still is, after its last edit; after three refused returns the gate
  decides); whole-file rewrites that kept a module's exports but changed its behaviour were caught only by
  review (an edit that drops any top-level name, or edits a file the step has not read, is now refused, and
  every writing step carries a keep-list of what must stay; a rewrite that keeps every name can still change
  behaviour, and review remains the check for that);
  and a review rework re-ran every writing step, including ones with nothing left to change (a rejection
  whose findings name paths now re-runs only the writers that declared them). These changes have not yet
  been measured in a live run.
- **In the default single-user mode the ledger is not a trust anchor against its own user.** An internal
  review found ways for a host assistant to reach a human decision command, for forged ledger events to make
  the stop hook allow, and for repository git configuration to influence the pull-request push. Those
  specific paths are fixed and have adversarial cases. What remains is structural: Tecera, the host
  assistant and the ledger run as one operating-system user, so the ledger's hash chain shows internal
  consistency, not who wrote a record. A forged end-of-run event can still hide a run that has no open
  approval, and a truncated ledger tail is not detected. Treat the host adapters as protection against
  accidents, not against a determined agent, and read every acceptance contract and pull request yourself.
  Hardened mode (see Configuration) closes these three for an assistant that runs as a separate account;
  it does not hold against root, against anything that can run code as the operator, or against an
  assistant that can remove the host's Stop hook, and it does not say which person used the operator
  account.
- **In single-user mode approvals are not authenticated.** A decision is a local command and the approver
  is the name given with `--as`. The decision commands refuse under an agent-host marker or without a
  terminal, which stops accidents only: any local process that can run `tecera`, allocate a terminal and
  choose its own environment can approve under any name. In hardened mode a decision needs the operator's
  uid; `--as` remains a label.
- **Codex gets no hooks** (see Configuration).
- **The benchmark is not yet a measurement.** Its pass rules are being tightened: at present a scenario
  can pass its rule without the delivered work being complete. Do not read its scorecard, including its
  control and compliance figures, as evidence of what works.
- **Learning is modest.** Every run records one short episode per step completion, step failure and run
  outcome, and stages a candidate lesson when a failed step is followed by a passing verification. Both are
  deterministic summaries of the ledger, not generalizations. A lesson is used only after a human graduates
  it (`tecera memory graduate`), and workers receive lessons and episodes as untrusted data. A graduation is
  recorded under the local `--as` name, which is not authenticated.
- **HTTP stub provisioning.** A provisioned loopback HTTP stub is served to workers as a brokered tool, but
  a criterion's check runs in a network namespace of its own and cannot reach it. A criterion that needs
  the stub fails verification.
- **The change-path envelope controls paths, not content.** A file outside the accepted envelope cannot be
  written, deleted or committed, whatever a reviewer says. Every contract the planner drafts for a free-text
  request carries one. It does not detect unrequested behaviour inside a file the envelope allows. A goal
  file that states criteria but no envelope leaves `repo.allowedChanges` as the only path boundary: an extra
  file inside it is then stopped by review alone.
- **Degraded hosts.** With `sandbox.isolation: "node"` (the shipped sample) the worker child runs with
  Node's permission model and whatever OS controls the host offers; the missing ones are recorded as
  `isolation.degraded`. A non-root supervisor runs checks under its own uid.

## Lineage

Tecera's worker runtime is a TypeScript port of the invoke loop from JAZ (arXiv 2609.26891). Its memory
tiers and graduation lifecycle are ported from agentic-stack. The BDI vocabulary follows the classic
belief-desire-intention literature. See [NOTICE](NOTICE).

## Contributing

Issues and pull requests are welcome. Run `yarn test` and `yarn test:adversarial` before opening one. The
adversarial suite is strict by default: a case that does not hold fails. It does not yet have a case for
every finding listed above.

## License

Apache License 2.0. See [LICENSE](LICENSE).
