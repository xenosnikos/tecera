# Review: codejunkie99/agentic-stack ("the OG agent stack"), v0.19.1, Apache-2.0

"One brain, many harnesses." A portable `.agent/` folder (memory + skills + protocols + loops) that
mounts into Claude Code, Cursor, Codex, OpenClaw, Copilot CLI, Gemini, Hermes, Pi, or a DIY Python
conductor, and keeps its knowledge when you switch. By @Av1dlive, the same author as the 12-build tutorial
our local `Repos/agent-stack` scaffold implements. Read from source 2026-10-02.

## What it is, concretely

| Layer | Files | Mechanism |
|---|---|---|
| Memory (4 tiers) | `memory/personal/PREFERENCES.md`, `working/WORKSPACE.md` + `REVIEW_QUEUE.md`, `semantic/DECISIONS.md` + `LESSONS.md` (rendered from `lessons.jsonl`), `episodic/AGENT_LEARNINGS.jsonl` | Read in a fixed order; each tier has its own retention policy |
| Retrieval | `harness/context_budget.py`, `harness/salience.py` | Always-on slots (preferences, workspace, review queue, decisions, permissions) + query-aware lessons and top-k episodes scored `salience × relevance`; `salience = recency × pain × importance × min(recurrence,3)`; hard token budget (`MAX_CTX − 40k reserved`) |
| Learning loop | `memory/auto_dream.py` → `cluster.py` → `promote.py` → `validate.py` → `review_state.py` | Nightly cron **stages** candidate lessons mechanically (no reasoning, no network). A human/host agent **graduates** or **rejects** each with a required rationale; rejected candidates keep decision history so churn is visible; lessons can be retracted (append-only). "Rubber-stamped promotions are the exact failure mode this layer prevents." |
| Skills | `skills/_index.md`, `_manifest.jsonl`, `<skill>/SKILL.md` with frontmatter `triggers/tools/preconditions/constraints` | Progressive disclosure: manifest always loads, full SKILL.md only on trigger match; every skill has a self-rewrite hook; `on_failure` flags a skill that fails 3× in 14 days |
| Protocols | `protocols/permissions.md` (always / requires approval / never / approved domains), `tool_schemas/*.schema.json` (per-operation `blocked_targets`, `requires_approval`), `delegation.md` | `pre_tool_call.py` enforces permissions + schemas before every tool call; humans edit permissions, the agent never does; delegation contract = goal, constraints, return format, budget; recursive delegation hard-capped at depth 3 |
| Bounded loops (v0.19) | `loops/budget.json`, `constraints.json`, `harnesses.json`, `<loop>.json` | maker → deterministic verifier → independent checker; autonomy ladder L1 (report) / L2 / L3 (owned worktree); `deny_paths`, `max_changed_files`, `external_writes_require_approval`; attempts/runtime/output/token budgets; `stagnation_threshold`; resumable checkpoints. Explicit: "The supervisor bounds and audits child processes; it is not an operating-system sandbox." |
| Harness adapters | `adapters/<harness>/adapter.json` with file entries + `merge_policy` + `post_install` | One small shim per harness; `harness_manager` installs, audits (`doctor`), upgrades only skeleton-owned files, transfers memory between projects with SHA-256 bundles and secret blocking |
| Observability | `data_layer_export.py`, `data_flywheel_export.py`, provenance on every episodic entry (`skill, profile, run_id, commit_sha`) | Local-only dashboards; approved+redacted runs → trace records, eval cases, training JSONL |
| Conductor | `harness/conductor.py` (33 lines) | "Thin conductor loop. Reads files, calls the model, logs. No reasoning here." Rule 8 in AGENTS.md: "The harness is dumb on purpose. Reasoning lives in skills + the host agent." |

## What tecera takes from it

1. **The business case is a mountable folder, not a process.** `tecera.json` + `.tecera/` (memory, skills,
   protocols, loops, evidence) is what `tecera onboard` creates and what any harness can mount: Claude Code,
   Codex, OpenClaw, or tecera's own invoke runtime. That is the real "one command, any workflow" and the
   real multiplayer story (humans on different harnesses share one brain).
2. **Four memory tiers + human-gated graduation** replace the vague "knowledge/RAG" package. Episodic
   evidence is written by hooks (our ledger); lessons only enter semantic memory through review. This is
   also the only safe form of JAZ-style self-improvement: candidate prompts/tools are staged, evaluated,
   and promoted or rolled back, never auto-applied.
3. **Salience × relevance under a context budget** is the retrieval policy for building an invoke's inputs
   from memory (and the natural place to let a cheap decision model prune, see `jev-review.md`).
4. **Skills as progressively disclosed, trigger-matched prompt fragments** with preconditions and
   constraints, plus the self-rewrite-on-failure signal.
5. **Loop contracts** (`budget`, `constraints`, `harnesses`, per-loop JSON with autonomy level and approval
   points) are a ready schema for tecera's intention manifests; the maker/verifier/checker trio is the
   same cast as agent-stack writer/gate/reviewer.
6. **Adapter manifests** (`adapter.json` with merge policies, `doctor`, safe `upgrade`, memory `transfer`)
   are the model for `tecera onboard` and `tecera doctor`.

## What it lacks (that tecera must supply)

- No execution primitive: it assumes a host harness runs the loop. JAZ `invoke` fills that.
- No OS-level isolation (stated). The sandbox/broker layer fills that.
- Permission enforcement is keyword matching over markdown (`pre_tool_call.py` fires a "never" rule when
  ≥2 keywords of the rule appear in the call description). Fine as a prompt-level aid; not an authority.
  Tecera's policy hooks are deterministic and fail-closed; Jev can pre-score risk, code decides.
- Memory is flat files with Jaccard overlap; adequate for a single repo brain, not for tenant-scoped,
  provenance-tagged evidence. Keep the tiers, back them with the ledger, keep the file renderings as views.
- No event bus, sessions, or multi-agent routing. Mosaic fork fills that.
