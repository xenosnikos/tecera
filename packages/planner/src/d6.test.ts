import { describe, expect, it } from 'vitest';
import { STEP_KINDS as CONTRACT_STEP_KINDS, validatePlanShape } from '@tecera/contracts';
import { DELIVERY_CHAIN } from '@tecera/policy';
import { openAIStrictSchemaProblems, anthropicSchemaProblems } from '@tecera/providers';
import { createPlanValidator } from './checks.js';
import { FakeBeliefs, FakeLLM, adopted, belief, goal, goodDoc, sampleManifest, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner, PlanRejected } from './llmPlanner.js';
import { parsePlanOutput } from './parse.js';
import { SAMPLE_FIX_FAILING_TEST_PLAN } from './scripted.js';
import { PLAN_DOCUMENT_JSON_SCHEMA, PLAN_WIRE_JSON_SCHEMA, STEP_KINDS } from './schema.js';

/**
 * Owner decision D6 (2026-10-05) in the planner: commits go to the work branch without approval; gate.pr is
 * the only approval point and the last step of every code-changing plan
 * (worker → gate.verify → gate.review → gate.verify → gate.commit → gate.pr). The planner's schema, wire
 * schema, prompt, checks and sample plan all carry it.
 */

const m = sampleManifest();
const permissions = samplePermissions();
const validator = createPlanValidator({ permissions });
const kindsOf = (schema: Record<string, unknown>): unknown =>
  ((((schema['properties'] as Record<string, Record<string, unknown>>)['steps']!['items'] as Record<string, unknown>)['properties'] as Record<string, Record<string, unknown>>)['kind'])!['enum'];

describe('D6 delivery chain in the planner', () => {
  it('the step kinds are exactly the contracts step kinds (gate.pr included) in the document and wire schemas', () => {
    expect([...STEP_KINDS].sort()).toEqual([...CONTRACT_STEP_KINDS].sort());
    expect(kindsOf(PLAN_DOCUMENT_JSON_SCHEMA)).toContain('gate.pr');
    expect(kindsOf(PLAN_WIRE_JSON_SCHEMA)).toEqual([...STEP_KINDS]);
    // Still inside both vendors' structured-output subsets (OpenRouter forwards the OpenAI-style json_schema).
    expect(openAIStrictSchemaProblems(PLAN_WIRE_JSON_SCHEMA)).toEqual([]);
    expect(anthropicSchemaProblems(PLAN_WIRE_JSON_SCHEMA)).toEqual([]);
  });

  it('the sample plan ends in the policy DELIVERY_CHAIN and passes the loop validator', () => {
    const chain: string[] = [];
    const byId = new Map(SAMPLE_FIX_FAILING_TEST_PLAN.steps.map((s) => [s.id, s]));
    let cur = SAMPLE_FIX_FAILING_TEST_PLAN.steps.find((s) => s.kind === 'gate.pr');
    while (cur) {
      chain.unshift(cur.kind);
      const up: string | undefined = cur.dependsOn[cur.dependsOn.length - 1];
      cur = up ? byId.get(up) : undefined;
    }
    expect(chain.slice(-DELIVERY_CHAIN.length)).toEqual([...DELIVERY_CHAIN]);
    expect(validatePlanShape(SAMPLE_FIX_FAILING_TEST_PLAN)).toEqual([]);
    expect(validator.validatePlan(SAMPLE_FIX_FAILING_TEST_PLAN, m, goal)).toEqual([]);
    expect(SAMPLE_FIX_FAILING_TEST_PLAN.permissions.approvals).toEqual(['open_pr']);
  });

  it('a plan document with gate.pr parses; one ending at the commit (pre-D6) is repaired once, then rejected', async () => {
    expect(parsePlanOutput(JSON.stringify(goodDoc())).ok).toBe(true);
    const old = goodDoc();
    old.steps = old.steps.filter((s) => s.kind !== 'gate.pr');
    old.permissions = { ...old.permissions, approvals: ['commit'] };
    const oldText = JSON.stringify(old);
    // repaired: the issues are fed back and the corrected plan is accepted
    const llm = new FakeLLM([oldText, JSON.stringify(goodDoc())]);
    const p = new LLMPlanner({ llm, manifest: m, permissions });
    const plan = await p.write(adopted, new FakeBeliefs([belief('baseline', { exitCode: 1 })]), goal);
    expect(plan.steps.at(-1)!.kind).toBe('gate.pr');
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/needs exactly one gate.pr \(found 0\)/);
    // still pre-D6 after the repair round → rejected, never returned
    const err = await new LLMPlanner({ llm: new FakeLLM([oldText, oldText]), manifest: m, permissions }).write(adopted, new FakeBeliefs([]), goal).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanRejected);
    expect((err as PlanRejected).issues.join('\n')).toMatch(/must end in gate.verify → gate.review → gate.verify → gate.commit → gate.pr/);
  });
});
