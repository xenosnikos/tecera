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
event with no verification evidence behind it proves nothing.

## Acceptance and capabilities

Before planning, a request becomes an **acceptance contract**: criteria, each with a check (a command
that must exit 0 on the final candidate, or a question for a human), what is out of scope, and what was
assumed. The planner seat drafts it; model output is screened (no generic "tests pass" contracts, no
criteria that import packages the repository lacks or need the network) and recorded as `criteria.drafted`.
A free-text request holds until the requestor accepts the contract through a local approval bound to
its hash (`accept_criteria`, approver not the requester); a goal file that carries criteria is accepted
by the file. An amendment after acceptance (`criteria.amended`) makes the running plan stale and forces a
re-plan against the new hash.

The criteria name the **capabilities** they need. Connections declared in the manifest are probed for
real; what a plan needs is resolved through one ladder, `use → provision → mock → ask`:

- **use** the real connection when its probe passes;
- **provision** a local stand-in inside the manifest allowance (temporary directory, bare git remote,
  SQLite file, loopback HTTP stub; a count and a lifetime cap). Each `resource.provisioned` carries its
  locator and teardown and stays a pending debt until a human transfers or releases it;
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
  lockfiles, Tecera's own files).
- **Verify.** The goal's check and every command criterion run in a separate contained process with a
  scrubbed environment, on the same frozen candidate. A run that mutates the candidate, overflows its
  output or leaves descendants behind does not pass. A retried worker receives the failed criteria and the
  reviewer's findings as untrusted, redacted inputs.
- **Review.** Mandatory, by a different vendor than every writer, compared by provider and key
  fingerprint. The verdict must be exactly `{verdict, findings}`; `approve` requires empty findings.
- **Commit.** To `tecera/<goal>`, staged from host-read bytes so repository hooks and filters never run,
  bound to the reviewed content.
- **Pull request.** The only human approval. The grant is bound to the commit, to one approver who is not
  the requester, and to an expiry; it is consumed exactly once and only if its audit event exists. Tecera
  pushes and opens the PR, or writes a patch bundle. It never merges.
- **Budgets.** Usage is reserved before and settled after every model call and reported per step and per
  model. Exhaustion stops a run only when `budgets.enforce` is true. Loop-safety limits (depth, iterations,
  attempts, execution timeouts) always apply.

## The worker

A worker step is an invoke loop (ported from JAZ): the model writes a short program, the program runs in a
fresh restricted Node child process, and the loop continues until the program returns a value that
satisfies the step's output schema. The child has no network and no file access; tools exist only as
brokered calls that are re-authorized on every request. Hooks observe each span (invoke, model query,
execution, tool call) and announce effects (abort, suspend, restrict, reserve budget, append evidence);
they never mutate state directly.

## The ledger

SQLite, append-only, hash-chained for both events and evidence, with triggers that refuse updates, deletes
and conflicting inserts. Beliefs, the task board and memory are projections. Budget pools, leases with
fencing tokens, approvals and checkpoints live beside the log. `tecera why <event>` walks any action back
to its step, intention, goal and triggering event; an offline replay re-derives a goal's status from the
ledger alone.

## Memory and learning

Four tiers over the log: working, episodic, semantic (lessons) and procedural (the plan library). Lessons
and generated plans are staged mechanically and enter the library only when a human graduates them with a
rationale. Rejections and retractions are kept on record.

## Benchmarks

`packages/bench` holds ten scenarios (fixing a failing test, a vague request, a multi-step feature, a
missing database, a missing mail sender, a tempting test edit, a planted instruction with a canary
secret, an impossible task, interruption and amendment mid-run, and an audit from the ledger alone).
The runner drives the real CLI, scripted or with live models, and performs the declared human steps; the
scorer reads only the ledger and the final repository. The headline numbers are human touches per job
(autonomy), false achievements and landed violations, which must be zero (control), and the share of
actions traceable to a step, intention, goal and approval (compliance).

## Package dependencies

`contracts` ← { `ledger`, `loop`, `reflex`, `worker`, `policy`, `brain`, `providers`, `planner`, `gates` }
← `runtime` ← `tecera`, with `adversarial` and `bench` on top. Sibling packages talk through the ports
defined in `contracts`.
