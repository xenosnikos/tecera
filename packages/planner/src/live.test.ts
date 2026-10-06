import { describe, expect, it } from 'vitest';
import type { LLMUsage, UsageMeter } from '@tecera/contracts';
import { createProvider, SecretStore } from '@tecera/providers';
import { createPlanValidator, validateCandidate, DEFAULT_TOOL_CATALOG } from './checks.js';
import { FakeBeliefs, adopted, belief, goal, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner, type PlannerUsage } from './llmPlanner.js';

/**
 * Live planning (D7, Codex "live planning with the actual wire schema"). Skipped unless
 * OPENROUTER_API_KEY is set (source /root/.config/tecera/live.env into the test process only; the value is
 * never printed and leaves process.env when it is resolved). The planner seat is Claude Sonnet through
 * OpenRouter with the planner's real wire schema, default maxTokens and the sample's effort; the plan it
 * writes for samples/fix-failing-test must pass the loop's validator and end in the D6 delivery chain.
 */

const MODEL = process.env['TECERA_LIVE_PLANNER_MODEL'] ?? 'anthropic/claude-sonnet-4.5';

describe.skipIf(!process.env['OPENROUTER_API_KEY'])('live planner via OpenRouter', () => {
  it('writes a plan for the sample goal that validates and ends worker → verify → review → verify → commit → pr', async () => {
    const store = new SecretStore();
    store.resolve('openrouter', 'env:OPENROUTER_API_KEY');
    expect(process.env['OPENROUTER_API_KEY']).toBeUndefined();
    const m = sampleManifest();
    const permissions = samplePermissions();
    const llm = createProvider({ provider: 'openrouter', model: MODEL, effort: m.seats.planner.effort ?? 'high' }, store, { maxRetries: 2 });
    expect(llm.provider).toBe('anthropic');
    const usage: PlannerUsage[] = [];
    const metered: LLMUsage[] = [];
    const meter: UsageMeter = { record: (u) => void metered.push(u) };
    const planner = new LLMPlanner({ llm, manifest: m, permissions, model: MODEL, redactor: store.redactor, onUsage: (u) => void usage.push(u) });
    const plan = await planner.write(adopted, new FakeBeliefs([belief('baseline', { exitCode: 1, failing: ['test/sum.test.js'] })]), goal, meter);

    expect(createPlanValidator({ permissions }).validatePlan(plan, m, goal)).toEqual([]);
    expect(validateCandidate(plan, { manifest: m, goal, permissions, toolCatalog: DEFAULT_TOOL_CATALOG })).toEqual([]);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const last = plan.steps.filter((s) => !plan.steps.some((x) => x.dependsOn.includes(s.id)));
    expect(last.map((s) => s.kind)).toEqual(['gate.pr']);
    const commit = byId.get(last[0]!.dependsOn.find((d) => byId.get(d)?.kind === 'gate.commit')!)!;
    expect(commit.kind).toBe('gate.commit');
    expect(plan.permissions.approvals).toContain('open_pr');
    expect(plan.steps.some((s) => s.kind === 'worker')).toBe(true);
    expect(plan).toMatchObject({ origin: 'generated', status: 'candidate', trigger: { kind: 'goal.adopted' } });

    // Data for the run report (no secrets): calls, tokens, cost, the chain.
    console.info(`live planner: calls=${usage.map((u) => u.purpose).join(',')} in=${usage.reduce((a, u) => a + u.usage.inputTokens, 0)} out=${usage.reduce((a, u) => a + u.usage.outputTokens, 0)} usd=${usage.reduce((a, u) => a + u.usage.usd, 0).toFixed(6)} steps=${plan.steps.map((s) => `${s.id}:${s.kind}`).join(' ')}`);
    // Every call was metered and reported with real usage and a positive cost.
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(metered).toHaveLength(usage.length);
    for (const u of usage) {
      expect(u.usage.inputTokens).toBeGreaterThan(0);
      expect(u.usage.outputTokens).toBeGreaterThan(0);
      expect(u.usage.usd).toBeGreaterThan(0);
      expect(u.unknown).toBeUndefined();
    }
  }, 300_000);
});
