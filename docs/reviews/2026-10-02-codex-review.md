# Codex (default model) architecture consultation on the invoke thesis — 2026-10-02

Prompt: docs/PLAN.md + docs/reviews/2026-09-09-gpt56-sol-review.md + docs/research/jaz-review.md + forked
kernel + EEZE/Builderlync harness sources. Read-only. Summary of the report (full text in session log):

## Verdict
Adopt recursive `invoke`; reject "all safety and persistence emerge from hooks and prompting". The defensible
architecture is **a small execution language inside a trusted supervisor**. Overreaches in jaz-review.md:
self-improvement is expressible, not reliably safe; passing history preserves information, not trustworthy
beliefs or crash recovery; scope visibility is not capability enforcement; "awaiting approval" must be a
durable suspended state, never a successful return. Reconcile Sol's blockers: mandatory host-installed hooks,
broker, budgets, isolation, verification and ledger precede any executable model output (missing hooks
prevent startup); the bus merely notifies (authenticate ingress, derive identity/session server-side);
logical recursion belongs to the supervisor, generated code runs in disposable restricted processes.
ROUTING.md requires native writer harnesses until evals justify replacement, so JAZ-style writing starts
experimental.

## Kernel API (TypeScript)
`invoke<T>(inputs, {output: SchemaRef<T>, config?, hooks?}) → Promise<Outcome<T>>` where
`Outcome = returned | suspended(request) | aborted | failed`, each with a `RunRef`. `returned` never means the
business goal is complete. `scope(spec, body)` with precedence explicit inputs → nearest scope → ancestors;
reserved bindings (`__history__`) cannot be overwritten; history is a read-only provenance-bearing handle.
Children may narrow capabilities/budgets/sandbox profiles, never widen or remove mandatory hooks.
Spans: JAZ's Invoke/LLMQuery/REPLExec plus broker-owned ToolCall, Verify, Review, Commit; each
Enter/Send/Complete/Exit (+Retry). Effects: PatchInput, ReplaceOutput, PatchOutput, Abort, Suspend,
RestrictCapabilities, ReserveBudget, Require(Verify|Review), AppendEvidence, BlackboardCAS. Composition:
restrictions intersect, reservations charge atomically, evidence keys unique, conflicting replacements /
overlapping patches / failed CAS abort the transaction, Abort dominates, hook exceptions fail closed,
effective inputs revalidated at Send. Blackboard transactional, tenant/run namespaced, host-only keys.
Boundary: disposable child processes inside restricted containers (minimal env, no credentials, no network,
read-only runtime, quotas, process-tree cancel). isolated-vm is defense-in-depth only. Each REPL execution
starts fresh; explicit checkpoint values survive, closures do not. Tools and sub-invokes cross typed,
size-bounded RPC as opaque handles; broker reauthorizes every request.
Seams: `ScopeSerializer.serialize` (plain validated data, never call getters/toJSON, redact, bound
depth/bytes, handles for large values, authenticated provenance labels) and `ProgramParser.parse` (one
bounded function body, AST-validated, no imports; parsing is not sandboxing). Provider verdict parsing is
separate (EEZE `_approved`).

## Guardrail → hook table
Caps → ReserveBudget at Send (no reservation, no execution). Protected paths → RestrictCapabilities/Abort at
ToolCall Send + Commit Enter. Diff boundary → Require/Abort at Commit Enter. Tool allowlist → every ToolCall
Send. Approval → Suspend at ToolCall Send, grants bind {requestId, actionHash, session, requester, approver,
expiry}, one-use, separation of duty. Foreign review → Require(Review) at Commit Enter. Env verification →
Require(Verify) at Commit Enter + re-gate. Ledger → AppendEvidence before dispatch and state transition;
storage failure blocks completion. Port EEZE `_snapshot/_approved/_review_and_commit`; note guards.py defaults
absent allowed_changes to ["**"] and `_guard_changes` omits ignored files that `_snapshot` includes.

## Packages
contracts · invoke · policy · sandbox · ledger · runtime (Mosaic transport/schedulers/sessions + goal
lifecycle: AchievementGoal, PlanOption, IntentionInstance) · cli. Delete: standalone runner, fuzzy intent as
authz, mandatory orchestration presets, AUTO_APPROVE, "manifest is merely a scope". Fork gaps: BDIAgent string
sets; BaseScheduler needs serialized mailboxes and durable failure transitions; IMessageBus EXACTLY_ONCE is not a
guarantee.

## Phase 0/1
Phase 0: threat model, strict manifest schema, fork characterization tests, effect-algebra tests, EEZE
behaviour matrix, sandbox/broker spike, reuse plan_waves checks; no onboarding generator, no RAG.
Phase 1: one tenant, one intention, one recursive child, one source-edit capability, one approval, two
provider identities, SQLite ledger. Flow: authenticated wake → child analyses explicit history → broker stages
edit → freeze candidate → external verify → foreign review → final verify → digest-bound completion. Kill
writers before freezing; run tests in separate restricted processes. Mandatory adversarial cases listed.

## Top risks
Generated-code escape; recursive cost/latency explosion; history poisoning and leakage; irreproducible
recovery and external side effects; self-improvement regressions with weak transfer evidence (JAZ results are
two benchmarks, not production reliability).
