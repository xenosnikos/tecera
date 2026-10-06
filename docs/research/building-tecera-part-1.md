# Building Tecera, Part 1: The Paradigms Behind an Agentic Framework

Oct 2, 2026 · @Nick Xenos (concept article; stored here as the reference the plan is judged against).

## Where this starts

I've spent the past year trying to turn an agent framework called Mosaic into a commercial product. I didn't write the original. Peleg Robinowitz, my colleague and mentor at Dofinity, did, and most of what I know about how agents should think I learned by working inside his design.

Tecera is where that year has led me. It keeps Mosaic's core, adds an event bus, and plugs in today's model stack: one big model that plans and hands out goals, smaller and cheaper models that do the work, and fast decision models that route between them. This series is me building it in the open, starting with the ideas it stands on.

Most agent frameworks today start with the model and work outward. You get a loop, a list of tools and a context window, and everything else is prompt craft. It stops working when an agent has to run for days, work with other agents, or explain why it did something. Mosaic starts from the other end. It treats an agent as something with beliefs about the world, goals it wants, and intentions it has committed to. A good design and a sellable product are two different things, and a year of trying taught me what needs to change.

## The real problem: useful on day one

How can AI be useful right away, for a lot of people, with little or no setup? Not for engineers who enjoy wiring things together. For everyone else.

Setup is the bottleneck. OpenClaw 2.0 (Aug 30, 2026) spent its biggest release on simpler onboarding, a browser front door, and multiplayer sessions: setup starts from whatever AI access is already on your computer, optional configuration can be finished by talking to the agent, shared sessions let a teammate step into or take over work in progress. agentic-stack ships an onboarding wizard where every question has a skippable default. Anthropic's 2026 State of AI Agents: 46% named integration with existing systems as the main challenge, 42% data access and quality. LangChain's State of Agent Engineering (1,300+ practitioners): 57% have agents in production; top barrier quality (32%); many struggle to manage context at scale. Vercel Ship 2026: scoped credentials and agent identity.

Three labs shipped easier-to-adopt flavors of OpenClaw/Hermes within two months: OpenAI Dots (Sept 29), Meta Muse (Sept 8; #1 on the App Store free chart ten days after launch), OpenClaw 2.0 (Aug 30), Grok Bot (Aug 11 beta). Each removes setup by owning everything: model, computer, connections. For a business it's somebody else's plumbing, and it doesn't touch the second half: once installed, somebody still has to teach the agent how your business works (workflows, tools, prompts). That's setup moved later. This is where JAZ matters: dynamism should be built in; today's models can write their own workflow on the spot, so the framework's job is to let them.

Multiplayer has the same two halves: getting people into a session (onboarding) and knowing who asked for what and what the agent committed to on whose behalf (technical).

**Tecera has three jobs.** Be useful on day one without hand-written plans (the agent builds its own). Stay accountable while it does, for a whole team at once (Mosaic's design and an event bus). Be fast and cheap enough to use all day (not every decision goes to the biggest model).

## The paradigms

Two schools: structure in the loop (trust the model) vs. the agent's state of mind written down outside the model and reasoned over. The first school: ReAct (one tool per step) → CodeAct (code in a REPL; tools become functions) → recursive language models (code calls other agents) → JAZ, Harness as a Language: one building block, `invoke`, a function whose body the model writes fresh each call; everything the model sees, including its own history, is a variable it can hand to another agent. With prompting alone JAZ beat Letta on StuLife far recall (69.9% vs 61.8%) at under half the cost. agentic-stack has the opposite instinct: memory, skills and rules in a portable `.agent/` folder; the loop is replaceable.

| Paradigm | Who controls the flow | Where state lives | Where it breaks |
|---|---|---|---|
| ReAct tool loop | Model, one tool call per step | Message history | Context fills; nothing persists |
| Code mode (CodeAct) | Model, through code in a REPL | REPL variables plus messages | History is still only text the model reads |
| Recursive invoke (RLM, JAZ) | Model, through code that spawns sub-agents | Everything is a variable, history included | No explicit commitments; hard to audit why |
| Portable brain (agentic-stack) | Whatever harness is plugged in | Files: four memory layers, skills, permissions | No deliberation: nothing decides what to pursue |
| BDI (PRS, AgentSpeak, Jason) | Interpreter, driven by events and plans | Belief base, goals, intention stacks | Plans are hand-written; brittle to novelty |

The bet: the last row fixes the third row's weakness and the third row returns the favor. BDI gives commitments you can inspect; a flexible model loop gives plans nobody had to write in advance.

## Memory

Four problems (CoALA vocabulary): working, episodic, semantic, procedural. agentic-stack: `working/`, `episodic/`, `semantic/`, `personal/` with retention rules; nightly job groups logs into candidate lessons; each accepted or rejected with a written reason; retractions stay on record. "Memory you can't correct turns into superstition." JAZ: whole history as a variable searched with code; beat Letta's search tool on an exact-phrase recall. Both right on different clocks: raw searchable history within one long task; curated reviewed lessons across tasks, agents and months.

| Memory type | agentic-stack | JAZ | BDI equivalent |
|---|---|---|---|
| Working | `working/` | REPL variables | Current beliefs plus active intentions |
| Episodic | `episodic/` logs | `__history__`, by reference | The event log |
| Semantic | Reviewed lessons | Not separated | Belief base |
| Procedural | Skills with self-rewrite hooks | Skills passed as inputs | Plan library |

CoALA warns that letting an agent rewrite how it does things is the riskiest learning; a plan library with rules around it is that caution.

## Context

Context is the scarce resource: find the smallest set of high-signal tokens. Load only what you need (skill index, full SKILL.md on trigger; lessons by relevance). Hand off by pointing, not retelling (JAZ passes history as a variable; summarizing is a special case). Retelling loses things (CodeAct baseline lost its instructions after dozens of handoffs). BDI adds a principled filter: an intention commits to one plan for one goal; each plan states the conditions it depends on; only the facts those conditions mention matter to it. That is the rule for what a worker needs to see.

## Capabilities

A capability is three things: something the agent can do, a rule about when it's allowed to, and a budget. agentic-stack: typed tool definitions, `permissions.md` checked before every call, delegation contract, skill flagged for rewrite after three failures in 14 days. JAZ: capabilities are inputs; `scope` makes a tool available to every sub-agent; limits are hooks (cost budget, depth cap, return check). The JAZ hook design is worth borrowing as is: hooks announce what they want changed, every hook sees the same event, conflicts are refused. In BDI terms a capability is a plan: trigger, context condition, steps. Tecera adds one field: which models are allowed to run it. The frontier model hands out goals; a fast routing reflex picks the cheapest allowed model per step.

## Where Mosaic comes from: the BDI lineage

BDI (Belief, Desire, Intention): a theory of how an agent with limited time decides what to do while the world changes. Kitchen picture: a line cook believes (tickets, walk-in), wants every table fed, and has intentions (dishes already fired). Rao and Georgeff: an agent that rethinks at every step spends all its time deciding; one that never rethinks finishes plans that no longer make sense; intentions are the middle path. LLM agents face exactly this. Three levels of commitment: blind (ignores conflicts), single-minded (drops when facts change), open-minded (also drops when goals change). Tunable settings.

Lineage: PRS (1986), Bratman (1987), Cohen and Levesque (1990), Rao and Georgeff interpreter loop with event queue, OASIS air traffic with 70–80 agents (1995), AgentSpeak(L) plans as trigger/context/body (1996), Jason (2007), CoALA (2023), NatBDI (2024), Planless Agents: BDI plan generation with LLMs (2025), Agency and Generation (2026). Practical BDI simplifications: beliefs are plain facts; plans say trigger, context, body; each intention is a stack of plans; many stacks run side by side. The 1995 result: replacing FORTRAN pilot rules with plans cut tactic-change turnaround from two months to under a day. Classic weakness: someone has to write the plans. The last three rows notice an LLM can do that on the fly.

## Event-based looping

The BDI interpreter was an event loop from day one: three data structures plus an event queue; every cycle reads the queue. AgentSpeak: every plan names its triggering event; the cycle picks an event, finds applicable plans, picks one, runs one step of one intention. External events start a new intention; internal events (sub-goals) stack a plan onto the intention that raised them.

Three reasons to move the cycle onto a bus: model calls are slow (new events line up while a worker runs; the commitment setting decides whether they interrupt); agents need to share (one agent's result becomes another's fact); the log is the memory (rebuild beliefs by replaying; every decision has a record).

| BDI concept | On the bus | Handled by |
|---|---|---|
| Belief update | `belief.added`/`belief.removed`; belief base is a projection of the log | Any agent or sensor |
| Goal | `goal.adopted` | User, orchestrator or a running plan |
| Plan library | Handlers subscribed by trigger, filtered by context | A registry; the frontier model when nothing matches |
| Deliberation | Options consumed, commitment policy applied | A reflex first; the frontier model when unsure |
| Intention | Durable plan stacks running side by side (the task list) | Orchestrator |
| Execution | `step.requested` → `step.completed`/`step.failed` | Smaller worker models |
| Plan failure | `step.failed` triggers a contingency or drops the goal | Orchestrator |

Departure from the classic cycle: the task list is a set of intentions, not a queue. Steps inside one intention run in order; separate intentions and independent steps run concurrently (Hermes Kanban needed a per-agent concurrency cap, v2026.6.5). Where the list lives is pluggable (Jira, Hermes Kanban, OpenClaw Workboard); dependencies decide order, everything else runs concurrently.

```python
async def on_event(event):
    beliefs.apply(event)                         # the log is the source of truth
    options = plans.match(event, beliefs)        # trigger + context condition
    if not options:                              # nothing fits: write a new plan
        options = [await frontier.write_plan(event, beliefs)]
    pick = await reflex.choose(options, beliefs) # fast decision model
    if pick.confidence < THRESHOLD:              # unsure: let the big model decide
        pick = await frontier.deliberate(options, intentions)
    intentions.push(pick.plan, parent=event.intention)

async def tick():
    for step in intentions.ready_steps():        # every step with nothing blocking it
        asyncio.create_task(dispatch(step))      # side by side, not a queue

async def dispatch(step):
    if await reflex.gate(step) != "allow":       # allow, ask a human, or block
        return await bus.publish("step.held", step)
    step.model = await reflex.route(step)        # cheapest model allowed
    await bus.publish("step.requested", step)

async def on_step_done(result):
    await bus.publish("belief.added", result.facts)
    intentions.advance_or_drop(result)           # done, failed or impossible
```

## Reflexes: where decision models fit

JAZ is a framework; Jev is a model. Jev (TypeSafe, early access Sept 15): hand it state and a typed question, get a choice, score or yes/no with a probability, in a fraction of a second. OpenAI Decisions API (Sept 29, on Luna, 150 ms vs 1.6 s); AWS Strands Decider 2B (Oct 1, local). AgentSpeak has had reflex slots for thirty years: selection functions for event, plan, intention. A decision model is a better selection function. Latency was the second production barrier (20%) in LangChain's survey.

| Reflex point | Question | Answer |
|---|---|---|
| Triage a new event | Does this matter, and to which intention? | Choice |
| Pick a plan | Which applicable plan fits best? | Choice with confidence |
| Route the model | Which model should run this step? | Choice |
| Gate an action | Allow, ask a human, or block? | Choice |
| Reconsider | Should this new event interrupt what's running? | Yes/no |
| Close out | Did the step achieve its goal? | Yes/no |

Defaults, not laws: each reflex is a setting (rule, frontier, or off). Confidence ties it together: confident → act; shaky → escalate to the frontier. Commitment policy is applied by the reconsider reflex. Caution: a constrained answer can still be wrong; anything with real consequences goes through a plan, a permission and a record in the log.

## What happens when you put them together

| Source | Solves | Leaves open | Role in the combined design |
|---|---|---|---|
| JAZ | Expressive execution: code, recursive sub-agents, state by reference | Commitments, coordination, audit | The worker runtime inside a single step |
| agentic-stack | Persistence: layered memory, reviewed lessons, skills, permissions | Deliberation | The memory lifecycle and its review gate |
| CoALA | Shared vocabulary | Implementation | The naming |
| Context engineering guide | Context as a budget | Which facts matter to which task | Budget rules per worker |
| BDI | Deliberation: beliefs, goals, commitments, event-driven cycle | Hand-written plans | The control structure |
| LLM plan generation for BDI | Removes the hand-written plan bottleneck | Reliability of generated plans | The fallback when no plan matches |
| Decision models | Fast cheap choices from a fixed set with confidence | Open-ended answers; valid can be wrong | The reflexes |

Three results: generated plans with a safety net (frontier writes a plan when none fits; if it works it is staged and reviewed before joining the library); commitments you can audit (every action → intention → goal → event); speed and cost shaped by structure (big model plans, small models work, decision model reflexes; JAZ: GPT-5.4 directing GPT-5.4 nano workers reached 74.2% on AppWorld vs 69.9% for ACE, cheaper). Tension acknowledged: JAZ argues fewer restrictions win; Tecera adds structure on purpose. Hypothesis: structure belongs where a person or another agent needs to inspect or coordinate (commitments, permissions, shared memory); freedom belongs where one model works alone inside a step; reflexes guard the border.

## Next in the series
1. Beliefs and memory: event log as source of truth, belief projections, the review gate for lessons.
2. Plans and capabilities: plan library, generated plans, permissions and budgets.
3. The loop: event bus, concurrent intentions, commitment policies, when a new event should interrupt.
4. Orchestrator, workers and reflexes: routing steps to models with a decision model; what the frontier should never delegate.
5. Evaluation: long-horizon recall and self-improvement against StuLife and AppWorld.

(Sources list omitted here; see the published article.)
