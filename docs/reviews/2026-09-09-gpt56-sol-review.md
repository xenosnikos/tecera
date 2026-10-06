# Hostile architecture review of docs/PLAN.md — GPT-5.6 Sol via zen, 2026-09-09

(Codex was out of credits; gpt-6-astra not reachable by API key. Model used: gpt-5.6-sol, thinking=high.)

## Ranked findings
1. BLOCKER — Phase 1 executes model/tool work before enforcement exists. Move minimum enforcement into
   Phase 1 (capability tool broker, diff/protected-path checks, approval authz, immutable snapshots,
   foreign review, caps, fail-closed defaults). Delete runtime AUTO_APPROVE; tests inject a mock approver.
2. BLOCKER — The bus is transport, not a security boundary. Agent._receive only rejects cross-session
   traffic when BOTH session ids exist; approval:grant is spoofable and not session-scoped. Require
   authenticated principals at ingress; derive actor/session server-side; per-event schemas and ACLs; bind
   grants to {requestId, actionHash, session, actor, expiry}; immutable envelopes; one-use capability tokens.
3. BLOCKER — Worktrees do not replace fresh-process isolation. Each model/tool execution in a disposable
   worker subprocess/container: minimal env, restricted FS, network policy, process-group cancel, quotas.
   SDK tool calls return through the capability broker; never let a provider SDK execute tools internally.
4. MAJOR — goals→desires is fine; tasks→intentions collapses categories. Model AchievementGoal,
   PlanTemplate/Option, IntentionInstance separately with lifecycle states and reconsideration triggers.
5. MAJOR — "Stateless reasoner" too absolute. Define as "no authoritative hidden model state"; persist a
   structured episode record; treat RAG/bus content as untrusted observations promoted to beliefs by validation.
6. MAJOR — tecera.json overloaded/underspecified: needs schemaVersion, stable ids, ownership/auth bindings,
   base revision, runtime compat, secret *references*, trust zones, retry/idempotency, concurrency, retention,
   approval quorum/expiry, failure policy; separate immutable inputs from lockfile and runtime evidence;
   JSON Schema with unknown-field rejection; `tecera validate/migrate`; persist manifest hash per run.
7. MAJOR — Package boundaries: intent (fuzzy confidence) must not be the authz engine; policy must be
   deterministic/fail-closed; direction core-contracts ← bdi; policy → rule-kernel; runner → policy port;
   policy never imports runner; split evidence into ledger vs enterprise connectors.
8. MAJOR — Greenfield sample too weak. Phase 0: characterization tests for the fork, dependency rules,
   manifest schema, threat model, EEZE behaviour matrix. Phase 1 must prove interruption recovery, timeout
   child cleanup, no-op detection, mutation-after-review detection, approval spoof rejection, secret
   non-leakage, idempotent restart, re-gate demotion. One read-only real-task canary before Phase 3.
9. MAJOR — Scheduler lacks transactional/concurrency semantics: per-agent serialized mailboxes, atomic
   intention transitions, monotonic belief revisions, idempotency keys, leases, backpressure, cancellation,
   crash recovery; at-least-once + dedupe, never claim exactly-once; a failed PDA cycle is evidence + state
   transition, not a log line.
10. MAJOR — Multiplayer reduced to owner-only approval. Define a session authz state machine: membership vs
    presence, owner transfer, handoff as expiring lease with ack, per-channel/event/tool ACLs, quorum and
    separation of duty (requester cannot self-approve), revocation, redacted history, sequence-based
    reconnect, immutable audit log.

## What the plan gets right
Fork ownership + deferred migration; done-as-evidence with re-check demotion; route at boundaries, bounded
escalation, foreign review, deterministic gates; real credential verification in onboarding; reuse EEZE
snapshot/guard/parser logic.
