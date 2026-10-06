# Review: "Harness as a Language: A Minimalist Agent Framework With Maximal Expressivity" (JAZ)

arXiv 2609.26891v2, Li et al., MIT CSAIL, Sep 2026. Code: github.com/jaz-lang/jaz. Full text: `jaz-paper-arxiv-2609.26891.txt`.

## What the paper actually proposes

1. **One primitive: `invoke(**named_inputs)`.** The LLM writes the *body* of a function at call time, in the
   host language (Python REPL). Inputs are arbitrary named values: prompts, data, tools, other agents' histories.
   invoke makes no distinction between them. Formal semantics: one new syntax rule + one evaluation rule
   (`invoke σ → (λx. π(LM⟨σ⟩)) v`). Three design seams: the language, the serializer `⟨·⟩`, the parser `π`.
2. **Recursion is the default.** The generated code may call invoke again (sub-invokes). A closed agent loop
   is tail-recursive invoke; JAZ applies tail-call optimisation so it becomes an ordinary REPL loop.
3. **Everything the model sees is a variable.** Inputs *and* `__history__` (the REPL transcript) are REPL
   variables. This is the one property that distinguishes JAZ from CodeAct/RLM/smolagents, and the paper's
   ablations attribute the gains to it.
4. **Dynamic scoping.** `with scope(tool=...)` makes variables, hooks, and config available to an invoke and
   every recursive sub-invoke. Static scoping is explicitly rejected because invoke has no static body.
5. **Hooks are the only extension mechanism.** Span events on three operations: `Invoke`, `LLMQuery`,
   `REPLExec`, each with `Enter / Send / Complete / Exit` (+ `LLMQueryRetry`). Handlers emit *static,
   composable effects* (modify inputs, replace the call with a supplied output, modify output, abort),
   never arbitrary mutation. All handlers see the event at once; effects are composed order-independently;
   conflicting writes are refused. Hooks share a *blackboard*. Built-ins: observability (loggers, Langfuse,
   Jaeger), resumability (TrajectoryRecorder/Replay), resource control (BudgetPool, IterationLimit,
   RecursionLimit, BudgetForcing, ContextWindowWarning), validation (ReturnType, ValidateReturn, ValidateREPLCode).
6. **Config(llm, repl, protocol)**, local or scoped: the root invoke may run on a different model than
   sub-invokes (paper: GPT-5.4 root, GPT-5.4 nano solvers).

## Evidence

| Benchmark | JAZ invoke | Best specialised harness | Best prompt-only baseline |
|---|---|---|---|
| StuLife far-recall pass % (GPT-5.4 nano) | 69.9 @ $18 | Letta/MemGPT 61.8 @ $42 | CodeAct+subagents 32.0 @ $13 |
| AppWorld test-challenge TGC % (CSI) | 74.2 @ $21 | ACE 69.9 @ $31 | CodeAct+subagents 71.1 @ $22 |

Two patterns carried both results:
- **Tail-recursive delegation**: when context fills, `return invoke(instructions, guidance, prev_history=prev+__history__, state, summary, next_steps)`.
  Compaction, filtered-history, and memory systems are all special cases of what the agent can construct itself.
- **Meta-agent by construction**: the top-level invoke optimises the *inputs* (prompt, tools) of sub-invokes
  over a task sequence, batching adaptively and reading only the parts of sub-trajectories it needs.

## What it means for tecera

JAZ is the missing *execution primitive*. It is orthogonal to, not a replacement for, the BDI/event/evidence
layer. The revised shape:

- **`invoke` replaces the planned `runner/` package.** "One routed model turn" becomes "one invoke": an
  LLM-authored program, recursive by default, with scoped hooks and config. Routing seats (effort before
  model) are `ConfigOverride`s at invoke boundaries, which is exactly agent-stack's "route at boundaries".
- **Guardrails become hooks.** Every agent-stack guard maps onto a JAZ hook point and inherits the
  static-effect discipline (deterministic, composable, conflict-refusing, fail-closed):
  budget/iteration/recursion caps (built-in), protected paths + diff boundary (REPLExecEnter/Complete),
  tool capability allowlist (scope decides what exists; REPLExecEnter refuses the rest), approval gate
  (InvokeSend can *replace* the call with "blocked, awaiting approval"), foreign-provider review
  (InvokeComplete runs a review invoke under a different Config and can abort), environment verify gate
  (ValidateReturn generalised: done = external check exits 0), evidence ledger (TrajectoryRecorder
  generalised to an append-only store). Hooks share a blackboard, which is agent-stack's SQLite blackboard.
- **The business-case manifest is a `scope`.** `tecera.json` = the set of variables, tools, hooks, and
  config dynamically scoped over the whole recursive tree of a run.
- **"Stateless reasoner" is resolved, not asserted.** The reasoner is stateless *because* everything it
  needs is a variable it can pass by reference: `__history__`, beliefs, goals, evidence, prior episodes.
  Episode persistence = TrajectoryRecorder. Long-horizon = tail-recursive delegation with `prev_history`.
- **BDI around invoke, not instead of it.** An agent's `act()` calls `invoke(beliefs, goals, intention,
  policy, tools)`. `decide()` can itself be an invoke that returns an IntentionInstance. The event bus,
  schedulers, sessions, and multiplayer stay as the outer layer that wakes agents and routes humans.
- **Self-improvement is free.** `tecera optimize` is a meta-invoke over the solver invoke's inputs, which
  subsumes mosaic-cli's evaluate/optimize patch loop.

## What JAZ does not give us (and tecera must add)

1. **Sandboxing.** JAZ executes model-written code in-process. Enterprise use needs the REPL in an isolated
   worker/container with a capability broker; tools are the only bridge out. (Matches the Sep review's #3.)
2. **Done as an environmental fact.** ValidateReturn checks a value; tecera's verify gate checks the world
   (tests, rows, deliverables) and records evidence. Self-reported completion is never accepted.
3. **Nothing grades its own homework.** JAZ's meta-agent reads its own sub-agents' traces. Tecera adds a
   mandatory foreign-provider review hook and deterministic gates with tamper checks.
4. **Durability and idempotent restart.** TrajectoryReplay is per-run; tecera needs a ledger, leases,
   at-least-once + dedupe on the bus, and demotion on failed re-gate.
5. **Multi-agent across processes/humans.** JAZ is single-process recursion. The Mosaic bus/sessions give
   cross-session routing, approvals, presence, handoff.
6. **Language.** JAZ is Python. Tecera is TS: the REPL is a sandboxed JS environment (worker thread or
   child process with `vm`/isolated-vm semantics, tools injected as async capabilities over RPC).

## Risks to carry into the design

- Arbitrary code generation widens the attack surface versus fixed tool schemas; the hook/sandbox layer
  must be fail-closed by default and tested adversarially (prompt injection through `__history__` and
  through tool outputs that become variables).
- Recursion depth 70 in the paper's run: budgets and recursion limits must be scoped, not local, or a
  sub-tree escapes the cap.
- Serializer `⟨·⟩` is a security boundary too: it must redact secrets and never display raw large objects.
- Paper results are GPT-5.4 nano/5.4 on two benchmarks; treat gains as directional, not guaranteed for
  enterprise workflows.

## Addendum: what the reference implementation actually does (github.com/jaz-lang/jaz, Apache-2.0, `pip install jaz-lang`)

Read from source on 2026-10-02 (`src/jaz/`). These facts should drive the TypeScript port.

**Public API.** `invoke(ReturnType(T)?, *local_hooks_or_ConfigOverride, **inputs) -> T`; `ainvoke` async twin;
`scope(**vars)` context manager; `configure()`; `ConfigOverride(llm=, repl=, protocol=)` plus
`ConfigOverrideByDepth` (per-recursion-depth overrides, i.e. routing seats by depth are first-class);
`Config(llm: BaseLLM, repl: BaseREPL, protocol: BaseProtocol)` with a layered `ConfigStack`.
`Library` objects bind a tool module via a `__jaz_get__` payload protocol and render a tool catalog;
`Display(value, None)` hides an input from the prompt while keeping it bound.

**Execution-result taxonomy** (`repl/types.py`): `Continue(output, exception?)` (recoverable, loop again),
`Return(return_value)`, `Raise(exception)`. An invoke only terminates on `Return | Raise`. The REPL rejects a
finish that also printed output (`reject_finish_on_printed_output=True`) so the agent reviews before returning.

**Hook model** (`hooks/README.md`, `hooks/effects.py`, `hooks/dispatcher.py`): three spans (Invoke, LLMQuery,
REPLExec), four stages each: `Enter` (observe proposal; edit inputs / messages / code; abort) →
`Send` (observe committed input; *supply* a result and skip the work; abort) → `Complete` (observe raw
result; *modify* it; abort) → `Exit` (observe outcome union `Completed | Aborted | Failed`; always fires).
Events are frozen; hooks only return effects; all hooks see the event at once; effects are composed after
the loop with explicit rules (Abort supersedes supply/modify; multiple Aborts group; Continue outputs
concatenate; distinct Return values conflict → error; message adds sort by `(sort_key, content)` so order
is hook-independent). Effect classes: `Abort, SupplyExecResult, ModifyExecResult, SupplyInvokeResult,
ModifyInvokeResult, DisableRecursion, AddInputs, DropInputs, AddVariables, DropVariables, InsertCode,
DeleteCode, AddMessages, DropMessages, SupplyLLMResponse, ModifyLLMResponse, BlackboardWrite`.
Hooks propagate via contextvars to every nested invoke; **there is deliberately no generic
disable/clear**; per-behaviour opt-outs only. Hook `repr()` is recorded at InvokeEnter as the governance
record of the run. Liveness enforcement goes at `LLMQueryEnter` (fires once per turn unconditionally);
REPLExec events are conditional on parseable code.

**Sandbox: JAZ is fail-closed in-process, not a toy.** (`repl/permissions.py`, `repl/compiler.py`,
`repl/_secure_methods/*`, `repl/_exec_guards.py`)
- Builtins are an explicit allowlist (not a copy of `builtins`); `eval/exec/compile/__import__` are absent;
  exceptions derived from `Exception` only, so agent code cannot catch the REPL's `BaseException` sentinels.
- `allowed_imports` default `[]` (deny all), gitignore-style globs on the root module, enforced both
  statically (AST checker in `secure_compile`) and at runtime (wrapped `__import__`).
- `allowed_attributes` default `["*", "!__*"]` minus frame-bearing names (`f_back`, `gi_frame`, `tb_frame`,
  …) because a documented non-dunder escape walked frames to the real `eval`.
- `allowed_read_paths` / `allowed_write_paths` default deny; `open` is wrapped; `+` modes count as writes.
- Per-exec **timeout** (PEP 669 `sys.monitoring` LINE callback with a deadline stack, plus SIGALRM for
  blocking C calls) and **memory** growth guard; owner-tagged so a parent's deadline firing inside a child
  surfaces as a `Raise` in the child and is recognised by the parent. Spawned threads inherit deadlines.
- Explicitly documented limitation: the sandbox is strippable if the host hands the agent a
  `ConfigOverride` surface. Keep config out of the agent's reach.

**Protocol / serializer** (`protocol/code_only.py`, `protocol/prompts.py`): `parse()` must never raise (bad
output becomes a `SyntaxError` inside a recoverable `Continue`); default protocol treats the whole response as
code, prose goes in leading comments. Inputs render as one block per input `(name, type, abbreviated value)`;
per-input cap `max_invoke_input_length=50000`, REPL output cap `max_repl_output_length=50000`,
`truncation_prefix_ratio=0.5` (head/tail split, cut announced in-text). `__history__` entries keep the
*untruncated* `repl_output`. Scoped inputs render in the system prompt; per-invoke inputs in the user prompt.
No secret redaction exists in the serializer: that is ours to add.

**Built-in hooks worth porting first:** `BudgetPool` (shared cost/call budget across the tree), `IterationLimit`,
`RecursionLimit`, `ContextWindowWarning` (nudges tail-recursive delegation), `BudgetForcing`,
`ReturnType`/`ValidateReturn`/`ValidateREPLCode`, `TrajectoryRecorder`/`TrajectoryReplay`/`WorkflowReplay`,
`OTelTracing`. There is also an `rollout.py` and a `_library/swe.py` (bash/file tools for SWE tasks).

**Implications for the TypeScript kernel.**
1. Port the *shape* (spans × stages × typed effects × composition rules), not the Python mechanics
   (contextvars → `AsyncLocalStorage`; `sys.monitoring` has no JS equivalent).
2. The REPL boundary in TS cannot be in-process with equivalent guarantees. Options ranked: (a) a child
   process per invoke tree running a locked-down JS realm (`node --disallow-code-generation-from-strings`,
   no `require`/`import`, tools reachable only as RPC stubs, cgroup/ulimit for memory and CPU time); (b)
   `isolated-vm` (V8 isolate with memory/CPU limits, in-process, no Node APIs inside) with tools bridged via
   references; (c) a container per business case. Recommend (b) for the inner REPL because it gives the
   per-exec timeout/memory guards JAZ relies on, wrapped in (a) per invoke tree so a crash or escape is
   bounded by the OS, with (c) as the deployment unit.
3. Guardrails become hooks that emit `Abort` / `Supply*` / `Modify*` effects, inheriting composition and
   fail-closed semantics for free; the governance record is the hook `repr` list at InvokeEnter plus the
   trajectory.
4. Add what JAZ lacks: a redacting serializer (secret references never render), provenance tags on
   untrusted inputs (tool output, `__history__` of other agents) so prompt-injection tests have something to
   assert on, an environment verify gate at `InvokeComplete`, a foreign-review hook, and a durable ledger.
