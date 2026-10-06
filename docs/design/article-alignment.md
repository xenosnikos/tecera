# Alignment check: plan vs "Building Tecera, Part 1" (2026-10-02)

The article is stored at `docs/research/building-tecera-part-1.md`. This note records how the plan was
judged against it and what changed as a result. `docs/PLAN.md` (v3) is the outcome.

## Aligned before re-centering (components)
- JAZ as the worker runtime inside a step; hooks announce effects, never mutate.
- agentic-stack as the memory lifecycle and review gate (four tiers, nightly staging, human graduation
  with rationale, retraction on record).
- The log is the memory; beliefs are a projection of the event log (append-only, hash-chained ledger).
- Reflexes with confidence-based escalation, rule fallback, each a setting.
- BDI types with lifecycles; action → intention → goal → event traceability.
- Caution on generated procedures: staging and review before anything joins the plan library.

## Misaligned before re-centering (shape and order)
1. Article's control structure is the BDI event cycle; the earlier draft centered a secured `invoke`
   kernel and deferred the loop, bus and reflexes.
2. Article: plans are generated on day one; draft shipped a hand-written goal/loop/skill.
3. Three-tier model stack (planner / workers / reflexes) absent as structure; no `allowedModels` on plans.
4. No commitment policies (blind / single-minded / open-minded) or reconsider reflex.
5. Intentions as a concurrent set with a pluggable task list: absent.
6. BDI context filter (plan context conditions select beliefs for a worker): absent.
7. Vocabulary: article speaks `belief.added`, `goal.adopted`, `step.requested/completed/held`; draft spoke
   JAZ spans only.
8. Audience: article is for "everyone else, little or no setup"; the plan's v1 is a developer CLI.

## What v3 changed
- `@tecera/loop` is the kernel: `onEvent → match plans → planner writes one if none → choosePlan reflex →
  intentions.push`; `tick` runs every ready step concurrently; `dispatch` = gate reflex → route reflex →
  `step.requested` → worker invoke; `onStepDone` → `belief.added` → closeOut reflex → advance or drop.
- The first plan is written by the planner seat, validated by policy, run once, then staged as a candidate.
- Manifest `seats`: planner, workers[], reviewer, reflex; `Plan.allowedModels`; route picks cheapest allowed.
- `Intention.commitment` + reconsider reflex; `IntentionSet` is a set with a per-agent concurrency cap;
  `Board` port with ledger projection default and Jira/Kanban adapters later.
- `ContextFilter`: worker inputs = goal + step + beliefs matched by plan context + budgeted lessons +
  `__history__` handle.
- Event catalog in `contracts` with goal/intention/step/plan ids on every event; `tecera why <event>`.
- Six reflex seams in `@tecera/reflex` from day one with rule fallbacks; model adapters in Phase 2.
- Security, sandbox, gates and approvals retained, reframed as the gate reflex, plan permissions and
  host-run gate steps.
- Audience gap recorded as a product note; "finish setup by chatting" and hosted onboarding in Phase 3.

## Concept map (for reviewers of future posts)

| Article section | Plan element |
|---|---|
| Useful on day one | planner-generated plans; `init` detection; staged candidates |
| Accountable for a team | ledger events with trace ids; `why`; approvals bound to principals; Phase 3 sessions |
| Fast and cheap | reflex seams; routing at step boundaries; `allowedModels` |
| Memory (CoALA tiers) | `@tecera/brain`: working = beliefs + active intentions, episodic = log, semantic = graduated lessons, procedural = plan library |
| Context | `ContextFilter` + salience × relevance under `memory.contextBudgetTokens`; history by reference |
| Capabilities | `Plan.permissions`, `Plan.budget`, `Plan.allowedModels`; `permissions.json` authority |
| BDI lineage / commitment | `Intention.commitment`; reconsider reflex |
| Event-based looping | `@tecera/loop` on `LedgerBus`; `Bus` port; Mosaic bus adapter Phase 3 |
| Reflexes | `@tecera/reflex` six seams; `DecisionRecord` evidence |
| Put together | JAZ worker, agentic-stack memory, BDI control, generated plans fallback, decision-model reflexes |
