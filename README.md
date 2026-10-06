# Tecera

Tecera is an execution node for rule-bound work. You hand it a goal with a check that proves the goal is
done. A frontier model writes the plan, cheaper models do the work inside a restricted sandbox, a model
from a different vendor reviews the result, and a human approves once, at the pull request. Every action is
appended to a tamper-evident log, and a goal is marked achieved only with proof that its check passed.

It is not an assistant and not a framework for writing agents. Assistants and people delegate to it; it
returns the result, the record of how it got there, and what it cost.

> **Status: research-grade.** The first end-to-end job with real models has run, but independent
> second-vendor reviews still fail several components and the strict adversarial suite has open gaps. Do
> not point it at a repository or credentials you care about. Coding is the only implemented kind of work.

## How it works

Tecera's control structure is the BDI cycle (beliefs, desires, intentions) over an append-only event log.

```
goal + check ──► plan (frontier model writes one if none matches; staged until a human promotes it)
                  │
                  ▼
        worker steps ──► gate.verify ──► gate.review ──► gate.verify ──► gate.commit ──► gate.pr
        (cheap models,    (run the        (different      (re-run on      (work branch,   (the one human
         sandboxed)        check)          vendor)         the frozen      no approval)    approval; never
                                                           candidate)                      merges)
```

- **Beliefs** are a projection of the log. Nothing is remembered that cannot be traced to an event.
- **Goals** carry an environmental check. A worker returning is never completion; the check passing is.
- **Intentions** are committed plans. Independent steps run concurrently; dependencies impose order.
- **Reflexes** make the small decisions between steps (which plan, which model, allow or hold, interrupt,
  did it work). They are rules by default and escalate to the frontier model when unsure.
- **The harness holds authority, not the model.** Fourteen mandatory hooks (budget accounting, recursion
  and iteration limits, tool allowlist, protected paths, diff boundary, approval gate, foreign review,
  verify gate, tamper check, progress check, secret canary, evidence recorder, return schema) are enforced
  in code. A project that does not enable all of them does not start.

More detail: [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md).

## Quickstart

Requirements: Node 22, git, Linux or WSL2. Yarn 4 comes through corepack.

```bash
corepack enable
yarn install
yarn build
yarn test                 # every package, offline, no model calls
```

### Run the sample offline (scripted models)

```bash
cp -r samples/fix-failing-test /tmp/tecera-demo && cd /tmp/tecera-demo
git init -q -b main && git add -A && git commit -q -m base
TECERA=/path/to/tecera/packages/tecera/bin/tecera.js

node $TECERA init
node $TECERA run fix-failing-test --scripted /path/to/tecera/packages/runtime/test-fixtures/fix-failing-test
# exit 4: held at the PR gate. The output names the approval request and the run id.
node $TECERA approve <request> --as you
node $TECERA run --resume <runId> --scripted /path/to/tecera/packages/runtime/test-fixtures/fix-failing-test
node $TECERA why <commit event id>      # action → step → intention → goal → event
node $TECERA evidence <runId> --export ./evidence
```

### Run it with real models

The shipped sample seats the planner and worker on OpenRouter and the reviewer on OpenAI.

```bash
export OPENROUTER_API_KEY=...   OPENAI_API_KEY=...
node $TECERA doctor                    # probes every seat live, a few hundredths of a cent
node $TECERA preflight fix-failing-test
node $TECERA run fix-failing-test      # then approve and resume as above
```

Running as root (common on WSL): verification refuses to run as root. Set `TECERA_VERIFY_UID` and
`TECERA_VERIFY_GID` to an unprivileged user that can execute `node`, and `TECERA_WORKTREES` to a directory
that user can read.

## What a run gives you

- A commit on `tecera/<goal>` and either an opened pull request (when the repository has a remote and `gh`
  is authenticated) or a patch bundle under `.tecera/runs/<run>/pr/`. Tecera never merges.
- `goal.achieved` with a proof: the check command, exit code 0, the candidate fingerprint and the evidence
  key of the passing verification.
- A hash-chained ledger of every event, decision and model call, with cost per step and per model.
- A generated plan staged as a candidate. It joins the plan library only when a human graduates it with a
  written rationale (`tecera plans graduate`).

## Command line

```
tecera init | validate | doctor | preflight <goal>
tecera run <goal|statement> [--dry-run --scripted <dir>]      tecera run --resume <runId>
tecera approve|deny <request> [--as <you>]
tecera status | evidence <run> | why <event> | gate <goal>
tecera plans|memory candidates|graduate|reject|retract <id> --rationale <text>
tecera adapters install|doctor <host>        tecera hook pre-tool|stop
```

Exit codes: 0 ok · 2 invalid · 3 not ready · 4 held for approval · 5 verify failed · 6 review rejected ·
7 budget (only when `budgets.enforce` is true) · 8 policy · 9 ledger or human needed · 130 interrupted.

## Configuration

A project is a *business case*: a `tecera.json` manifest plus a `.tecera/` folder.

- **`tecera.json`**: seats (planner, workers, reviewer), reflex settings, commitment policy, budgets,
  sandbox, protected paths, the verify command, and the mandatory hooks. Secrets are references
  (`env:NAME`), never values; unknown fields are rejected.
- **`.tecera/`**: goals (what, plus the check), graduated plans, skills, permissions, and memory. The
  ledger and run folders live here too and are git-ignored.

Tecera mounts into Claude Code and Codex through `tecera adapters install`: a managed block in
`CLAUDE.md` / `AGENTS.md`, a deny list, a pre-tool hook that blocks edits to protected paths, and a stop
hook that refuses to let a session end while a run has no proof of achievement.

## Packages

| Package | Responsibility |
|---|---|
| `@tecera/contracts` | Manifest schema, BDI types, event catalog, ports, redaction, replay derivation |
| `@tecera/ledger` | Append-only hash-chained log (SQLite and in-memory), budgets, leases, approvals |
| `@tecera/loop` | The cycle: plan matching and generation, intentions, dispatch, recovery |
| `@tecera/reflex` | The six decision seams as rules, with a router that escalates and records |
| `@tecera/worker` | Model-written programs in a restricted child process, broker, tools, verify runner |
| `@tecera/policy` | Permissions, diff boundary, tamper checks, plan validation, mandatory hooks |
| `@tecera/brain` | Memory tiers over the log; human-only graduation of lessons |
| `@tecera/providers` | Anthropic, OpenAI and OpenRouter adapters with usage and cost |
| `@tecera/planner` | Planner prompt, strict plan schema, validation and repair |
| `@tecera/gates` | Verify, foreign review, commit and pull-request gates |
| `@tecera/runtime`, `tecera` | Composition root and the CLI |
| `@tecera/adversarial` | The named attack cases from the security design, run against the real components |

## Lineage

Tecera's worker runtime is a TypeScript port of the invoke loop from JAZ (arXiv 2609.26891). Its memory
tiers and graduation lifecycle are ported from agentic-stack. The BDI vocabulary follows the classic
belief-desire-intention literature. See [NOTICE](NOTICE).

## Contributing

Issues and pull requests are welcome. Run `yarn test` and `yarn test:adversarial` before opening one; the
adversarial suite is strict by default and lists each open gap with its owner.

## License

Apache License 2.0. See [LICENSE](LICENSE).
