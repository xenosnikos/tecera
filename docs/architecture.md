# Architecture

Tecera is a BDI (belief, desire, intention) event cycle over an append-only ledger. Models are called
through seats; authority lives in deterministic gates and hooks.

## The three jobs

1. **Useful on day one.** No hand-written workflows. When no plan fits a goal, the planner seat writes one.
2. **Accountable.** Every action traces to an intention, a goal and an event. The log is the memory.
3. **Fast and cheap enough.** A frontier model plans, cheaper models work, reflexes decide the small things.

## The cycle

```
onEvent(e)      append e to the ledger; beliefs are re-projected from the log
                options = library.match(e, beliefs)             trigger + context conditions
                if none: plan = planner.write(e, beliefs, goal); validate; stage as candidate
                pick = reflex.choosePlan(options)               frontier decides when the reflex is unsure
                intentions.push(pick)
tick()          dispatch every ready step, concurrently, up to the per-agent cap
dispatch(step)  reflex.gate(step): allow | hold | block
                reflex.route(step): cheapest seat the plan allows for this step
                worker.run(step) or the host gate for gate.* steps
onStepDone(r)   facts become beliefs (untrusted); reflex.closeOut decides whether the step achieved its aim
                advance, retry, or drop the intention
```

A goal is `achieved` only when every verify step has passed in the environment and, for plans that deliver
a change, the commit and pull-request steps completed. The `goal.achieved` event carries a proof:
`{command, exitCode: 0, fingerprint, evidenceKey, verifiedAt}` and, under an acceptance contract, one
proof per criterion with its fidelity. One pure function (`provenAchievement`) decides whether a ledger
proves a goal; the Stop hook, the run's exit status and replay all call it, so a forged `goal.achieved`
event with no verification evidence behind it proves nothing. The Stop hook also holds a run while the
approvals table has an open request for it, and counts a pull request as delivered only with a consumed
human approval and the gate's own evidence. In the default single-user mode a run with no open approval is
still judged active from run events alone, which a process able to write the ledger can forge (see the
README's known limitations). In hardened mode the hook reads a run registry kept outside the ledger, which
only the supervisor writes: a registered run stays active until the supervisor records it terminal (see
"Hardened mode" below).

## Acceptance and capabilities

Before planning, a request becomes an **acceptance contract**: criteria, each with a check (a command
that must exit 0 on the final candidate, or a question for a human), what is out of scope, and what was
assumed. The planner seat drafts it from the host's reading of the repository: the API its tests use (call
shapes, what a returned handler is given and gives back), the exact values the tests assert, the interfaces
the code documents in comments, and its commands with the modules they import. Model output is screened (no
generic "tests pass" contracts, no criteria that import packages the repository lacks or need the network,
none that contradicts an asserted value, a tested call shape or a documented interface) and recorded as
`criteria.drafted`.
A free-text request holds until the requestor accepts the contract through a local approval bound to
its hash (`accept_criteria`, approver not the requester); a goal file that carries criteria is accepted
by the file.

A contract also states a **change-path envelope**: a list of repository paths, or narrow globs whose
first segment is a literal directory, each with the operations allowed on it (`create`, `modify`,
`delete`, relative to the base commit). The planner drafts one for every contract (existing files the work
must touch, new files the criteria imply, the command file when the request is about a command); a draft
without one, or with a path outside `repo.allowedChanges`, on a protected path or at odds with the repository,
is refused and redrafted. A goal file carries it as `envelope:`. It is part of the
contract hash, so it is signed off with the criteria and only an amendment can widen it. A plan may
declare a subset per writing step (`changes`) and is rejected if a step names a path or an operation
outside the accepted envelope. The envelope is enforced deterministically in three places: the worker's
write and delete tools refuse a path outside the step's subset; when a writing step returns, the host
computes what changed (untracked and ignored files, deletions, both sides of a rename) since the step
began and since the base, and fails the step if anything lies outside; and the verify and commit gates
refuse a final candidate with an unexpected path, whatever the reviewer's verdict. The review packet
lists the accepted criteria, the out-of-scope items, the envelope and the unexpected paths the host found.
`repo.allowedChanges` stays the outer boundary. A goal file's contract that states no envelope keeps the
hash it always had and is held to `repo.allowedChanges` alone, exactly as before; the gates record that as
envelope source `manifest`. A file a criterion's command runs is part of the check and a worker may not change
it, except a product file (a command the check runs) that the accepted envelope lists for `modify`; the
criterion's command text and the test files it runs stay protected. An amendment after acceptance (`criteria.amended`) makes the running plan stale and forces a
re-plan against the new hash.

Every intention has its own work branch. The first intention of a goal in a run commits to
`<branchPrefix><goal>`; the n-th to `<branchPrefix><goal>.<n>` (a goal id never contains a dot, so the two
cannot collide). When an intention is replaced (an amendment, or a reconsideration that drops the plan), its
running steps are cancelled, its pending pull-request approval is denied on the approvals table, and before
any step of the new intention is dispatched the leased worktree is put on the new branch, created at the
base commit the run pinned when it started. Nothing of the old intention is carried over: not its commit,
not its uncommitted or ignored files, and not its evidence, because the new branch is part of every
candidate fingerprint of the new intention. The old branch keeps its commit for audit. The transition is
recorded before anything moves (old intention, new intention, base, branch, lease generation) and completed
idempotently, so a restart finishes it before any worker runs.

The criteria name the **capabilities** they need. Connections declared in the manifest are probed for
real; what a plan needs is resolved through one ladder, `use → provision → mock → ask`:

- **use** the real connection when its probe passes;
- **provision** a local stand-in inside the manifest allowance (temporary directory, bare git remote,
  SQLite file, loopback HTTP stub; a count and a lifetime cap). Each `resource.provisioned` carries its
  locator and teardown and stays a pending debt until a human transfers or releases it. The HTTP stub
  is reachable by workers through the broker but not by a criterion's check, which has no network;
- **mock** it behind the broker when the connection is `mockable`: the worker sees a stand-in with the
  real tool's interface, and everything it returns is provenance-tagged `simulated`;
- **ask** the requestor otherwise. Tecera never creates access in the requestor's own systems.

Every criterion proof records its **fidelity**, `real`, `provisioned` or `mocked`, capped by what the
ledger inventory recorded at verification time. A goal with any mocked criterion is `goal.provisional`:
the PR opens marked provisional, the run exits 10, and the Stop hook keeps blocking.

## Vocabulary

| Term | In the code |
|---|---|
| Belief | A fact with provenance, projected from `belief.added` / `belief.removed` events |
| Goal | `AchievementGoal`: a statement plus an environmental check (a command and a timeout) |
| Plan | Trigger, context conditions, steps with dependencies, allowed models per step, permissions, budget. Origin `generated` or `graduated`; status `candidate` until a human accepts it |
| Criterion | One acceptance criterion: a statement, a check (command or human), the capabilities it requires |
| Step | `worker`, `gate.verify`, `gate.review`, `gate.commit`, `gate.pr`, or `subgoal` |
| Intention | A committed plan instance with a commitment policy: `blind`, `single-minded` or `open-minded` |
| Reflex | One of six seams: triage, choosePlan, route, gate, reconsider, closeOut. Each is `rule`, `model` or `frontier`; none can be switched off |
| Seat | A configured model: `planner` (also the frontier), `workers[]`, `reviewer` |

## Authority model

- **Writes.** A worker may write inside `repo.allowedChanges` on its leased work branch without approval.
  Every write is fenced by the lease, logged, and refused on protected paths (tests, configuration, CI,
  lockfiles, Tecera's own files) and, under a change-path envelope, on every path the step did not declare.
  A worker can also delete one file at a time (`delete`): the same rules, and only a file whose content it
  has read.
- **Verify.** The goal's check and every command criterion run in a separate contained process with a
  scrubbed environment and no network, on the same frozen candidate. A host that cannot contain the
  check does not run it. A run that mutates the candidate, overflows its
  output or leaves descendants behind does not pass. A retried worker receives the failed criteria and the
  reviewer's findings as untrusted, redacted inputs.
- **Review.** Mandatory, by a different vendor than every writer, compared by provider and key
  fingerprint. The verdict must be exactly `{verdict, findings}`; `approve` requires empty findings.
- **Commit.** To the intention's work branch (`tecera/<goal>`, or `tecera/<goal>.<n>` for a re-planned
  intention), staged from host-read bytes so repository hooks and filters never run, bound to the reviewed
  content. The commit's parent is always the base commit: a worktree whose HEAD is anything else is refused.
- **Pull request.** The only human approval on the delivery path (a free-text request also holds once
  for sign-off of its acceptance contract, and a human criterion is asked at this hold). The grant is
  bound to the commit, to one approver who is not the requester, and to an expiry; it is consumed exactly
  once and only if its audit event exists. The approver is the local person running `tecera approve`,
  named with `--as` (default `$USER`); the identity is recorded, not authenticated. In hardened mode the
  command also requires the operator's uid and records it. Tecera pushes and opens the PR, or writes a
  patch bundle. It never merges.
- **Budgets.** Usage is reserved before and settled after every model call and reported per step and per
  model. Exhaustion stops a run only when `budgets.enforce` is true. Loop-safety limits (depth, iterations,
  attempts, execution timeouts) do not depend on that switch.

## The worker

A worker step that may edit files is always given `runVerify` as well (when the host wires it), so it can
run the tests before it returns. A worker step is an invoke loop (ported from JAZ): the model writes a short program, the program runs in a
fresh restricted Node child process, and the loop continues until the program returns a value that
satisfies the step's output schema. The program is given no network or file API, and the child process
may read only its own entry file; where the host provides them it also runs in its own network
namespace, in a memory- and task-limited cgroup and under an unprivileged uid, and a missing control is
recorded as `isolation.degraded`. Tools exist only as brokered calls that are re-authorized on every
request. Hooks observe each span (invoke, model query,
execution, tool call) and announce effects (abort, suspend, restrict, reserve budget, append evidence);
they never mutate state directly.

## The ledger

SQLite, append-only, hash-chained for both events and evidence, with triggers that refuse updates, deletes
and conflicting inserts. Beliefs, the task board and memory are projections. Budget pools, leases with
fencing tokens, approvals and checkpoints live beside the log. `tecera why <event>` walks any action back
to its step, intention, goal and triggering event; an offline replay re-derives a goal's status from the
ledger alone.

## Hardened mode

Opt-in, configured by a host file (`/etc/tecera/hardened.json`), never by the manifest. Two OS identities:
the operator, who owns Tecera's state, runs the supervisor and makes the human decisions, and the agent the
host assistant runs as. Per business case the state directory holds the ledger, a run registry and a
checkpoint of the ledger's head, all owned by the operator and readable but not writable by the agent;
Tecera refuses to start when the ownership or modes would let an agent write any of it. The supervisor
registers a run before dispatching anything and alone moves it to a terminal state; the Stop hook treats
every non-terminal entry as active whatever the ledger's events say. Every ledger write is checked against
the checkpoint and moves it, through a one-transition journal that recovers a crash at any step exactly,
so a truncated, restored or replaced ledger is detected. Every decision command checks the caller's real
uid against the operator's. docs/security.md (section 4) states what this guarantees and what it does not:
root, a compromised supervisor and anything that runs as the operator defeat it, and it does not identify
which person used the operator account.

## Memory and learning

Four tiers over the log: working, episodic, semantic (lessons) and procedural (the plan library). A
generated plan is staged as a candidate once its goal is achieved and enters the library only when a
human graduates it with a rationale. Lessons have the same lifecycle (stage, graduate, reject, retract,
all kept on record).

The runtime writes memory deterministically at the end of every run segment and on resume, without a model
call: one bounded, redacted episode per step completion, step failure and run outcome, and a candidate lesson
when a failed step of a goal is followed by a passing verification. Every entry names the ledger event it
came from and is written once per source, so a run projected again (after a reload or a resume) adds
nothing. Replay admits only what the live methods could have written: an `evidence.appended` entry must be a
valid episode; `lesson.staged` always creates a candidate, whatever state it claims; graduate, reject and
retract apply only to an existing lesson in the state the lifecycle allows, as the decision of the human who is
the event's actor, with a rationale; an id is never overwritten. Only a graduated lesson is recalled, and
lessons and episodes reach a worker as untrusted data.

## Benchmarks

`packages/bench` holds ten scenarios (fixing a failing test, a vague request, a multi-step feature, a
missing database, a missing mail sender, a tempting test edit, a planted instruction with a canary
secret, an impossible task, interruption and amendment mid-run, and an audit from the ledger alone).
The runner drives the real CLI, scripted or with live models, and performs the declared human steps; the
scorer works from the ledger and the delivered repository. It is meant to report human touches per job
(autonomy), false achievements and landed violations (control), and the share of actions traceable to a
step, intention, goal and approval (compliance). The scripted benchmark passes all ten scenarios' rules;
in the latest live run 3 of 5 scenarios passed their rules and 2 of 5 goals were achieved with a delivered
pull request, and no live run has falsely reported achievement or landed a violation.

## Package dependencies

`contracts` ← { `ledger`, `loop`, `reflex`, `worker`, `policy`, `brain`, `providers`, `planner`, `gates` }
← `runtime` ← `tecera`, with `adversarial` and `bench` on top. Sibling packages talk through the ports
defined in `contracts`.
