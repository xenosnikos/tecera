# Review: Jev (TypeSafe) as tecera's decision layer

Sources (read 2026-10-02): docs.typesafe.ai/primitives/choice, vercel.com/i/jev-agent-control,
madewithjev.com/jev-multi-agent, todatabeyond.substack.com "Jev Clearly Explained", patmcguinness
"Jev Makes Fast and Cheap Decisions", HF blog "18 Practical JEV Use Cases".

## What Jev is

A decision-first model (not generative): it evaluates a `state` against typed `questions` and returns
constrained answers with probability distributions. Three primitives:

- **Choice**: pick one of up to 255 named options (`criteria` per option) → `{choice, probabilities, confidence}`
- **Score**: position on a spectrum → number
- **Noul**: boolean → probability

Endpoint `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`; Python `typesafe_sdk`
(`client.system_one(state=..., questions={...})`); Vercel AI SDK `experimental_evaluate` with model id
`typesafe-ai/jev`; also reachable via OpenRouter. Multiple questions are evaluated independently in one
request ("the answer to risk category is not inserted into the context used by needs-approval").
Confidence is read off the distribution: a flat spread is low confidence, a single peak is high.

Measured by a third party: median 243 ms vs 1.5 s for GPT-5.6 Terra, ~82× cheaper, over 40 calls.
Vendor claims (193× faster, 444× cheaper; 20k decisions in 15.7 s for $0.41) are unverified by us.
It "doesn't generate prose or explain its reasoning"; and per its own docs, **"your application invokes
tools; Jev supplies judgments within a workflow that code runs."** Permissions stay in application code.

## Where it fits in tecera (and where it must not)

Jev is the **reflex layer**: cheap, fast, typed decisions at the control points of the recursive loop, so the
expensive generative model is called only when needed. Every use is advisory input to a deterministic
policy; Jev is never the authority, never sees secrets, and every decision is logged with its distribution.

| Decision point | Question type | Code policy around the answer |
|---|---|---|
| Route: which seat/effort for this invoke (agent-stack ROUTING: effort before model) | Choice over the manifest's seats | Peak < threshold → run the cheap seat once and verify, escalate once on fail (existing rule) |
| Tool-call risk gate at `ToolCall Send` | Choice {low, medium, high} + Noul "needs human approval" + Score destructiveness | Policy hooks still apply allow/deny lists first; Jev only decides between *allow* and *suspend for approval* inside the allowed set; irreversible classes always require approval regardless of confidence |
| Stuck detection / escalate to advisor or human | Noul "is this loop stalled" over recent history + evidence | Combined with the deterministic signals (same error twice, no-progress twice); consults still capped at 3 |
| Decompose vs act | Choice {act, delegate-subinvoke, decompose-DAG, ask-human} | Depth, fan-out and budget caps are enforced by hooks, not by Jev |
| Memory pruning / relevance | Score per candidate episode or lesson, replacing Jaccard overlap in context assembly | Always-on slots are never pruned; budget cap still enforced |
| Review triage | Noul "does this diff need frontier review" | Foreign-provider review is still mandatory before commit; Jev only picks the reviewer seat |
| Lesson candidate prefilter | Score "generalisable?" on staged candidates | Humans still graduate; Jev only orders the queue |

## Design rules

1. **Abstain → escalate.** Confidence below the configured threshold (docs suggest 0.3–0.5) or a flat
   distribution means "ask the next tier" (generative model, then human), never "pick the argmax".
2. **Deterministic fallback.** Every Jev question has a rule-based fallback so the runtime works offline and
   so we can A/B Jev against rules and against an LLM judge. ROUTING.md §8 applies: measure first, route
   second, delete gladly.
3. **No secrets, redacted state.** The `state` passed to Jev goes through the same redacting serializer as
   model prompts; tenant scoping applies.
4. **Evidence.** Every decision writes `{question, state digest, answer, probabilities, confidence, policy
   outcome}` to the ledger; the eval harness replays them to measure error rates and their cost (retries,
   approvals, incidents), which is the number that matters, not latency.

## Risks

- Vendor lock-in and availability: isolate behind a `DecisionProvider` port with the rule fallback.
- A fast wrong classifier is worse than a slow right one (the substack author's own caveat). Gate adoption
  on measured error rates per question type.
- Calibration drift across tenants/domains: per-question thresholds live in the manifest, not in code.
