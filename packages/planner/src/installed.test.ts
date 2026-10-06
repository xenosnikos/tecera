import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Installed-package check, MANDATORY (never skipped): compile the current planner src/ afresh with the
 * repo's TypeScript compiler (through node; no npm/npx) into a temp dir under os.tmpdir(), lay it out the way
 * a consumer gets it (package.json plus the compiled dist only, no checkout src/), and drive it in a separate
 * node process with the REAL providers: the planner's wire schema is checked against both adapters'
 * default structured-output modes and a wire answer through the OpenAI adapter becomes a plan. A stale or
 * missing checkout dist of the planner cannot make this pass.
 */

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '..', '..');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

describe('installed planner package (fresh build)', () => {
  it('works without the checkout src/ and its wire schema passes both adapters', () => {
    const root = mkdtempSync(join(tmpdir(), 'tecera-planner-installed-'));
    const scope = join(root, 'node_modules', '@tecera');
    const dest = join(scope, 'planner');
    mkdirSync(dest, { recursive: true });
    expect(existsSync(tsc)).toBe(true);
    execFileSync(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.json'), '--outDir', join(dest, 'dist'), '--declarationMap', 'false'], { cwd: pkgDir, stdio: 'pipe', encoding: 'utf8' });
    expect(existsSync(join(dest, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(dest, 'dist', 'decode.js'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { files: string[]; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    // Integration dependencies are declared (sprint-3 finding): every @tecera import of the tests resolves through a declared entry.
    for (const d of ['@tecera/loop', '@tecera/ledger', '@tecera/reflex', '@tecera/providers']) expect(pkg.devDependencies[d]).toBe('workspace:*');
    cpSync(join(pkgDir, 'package.json'), join(dest, 'package.json'));
    for (const f of pkg.files) if (f !== 'dist' && existsSync(join(pkgDir, f))) cpSync(join(pkgDir, f), join(dest, f), { recursive: true });
    expect(existsSync(join(dest, 'src'))).toBe(false);
    for (const dep of ['contracts', 'policy', 'providers']) symlinkSync(join(repoRoot, 'packages', dep), join(scope, dep), 'dir');
    symlinkSync(join(repoRoot, 'node_modules', 'zod'), join(root, 'node_modules', 'zod'), 'dir');
    const probe = join(root, 'probe.mjs');
    writeFileSync(
      probe,
      `import { readFileSync } from 'node:fs';
import { parseManifest } from '@tecera/contracts';
import { parsePermissions } from '@tecera/policy';
import { LLMPlanner, PLAN_WIRE_JSON_SCHEMA, parsePlanOutput } from '@tecera/planner';
import { OpenAILLM, OpenRouterLLM, SecretHandle, FixtureFetch, openAIStrictSchemaProblems, anthropicSchemaProblems } from '@tecera/providers';
const sample = (rel) => JSON.parse(readFileSync(${JSON.stringify(join(repoRoot, 'samples', 'fix-failing-test'))} + '/' + rel, 'utf8'));
const manifest = parseManifest(sample('tecera.json'));
const permissions = parsePermissions(sample('.tecera/protocols/permissions.json'));
const wire = {
  steps: [
    { id: 'analyze', kind: 'worker', dependsOn: [], instruction: 'read the failing test', inputsJson: null, outputJson: null, tools: ['read', 'listFiles', 'runVerify'] },
    { id: 'edit', kind: 'worker', dependsOn: ['analyze'], instruction: 'fix src', inputsJson: '{"hint":"src"}', outputJson: null, tools: null },
    { id: 'verify', kind: 'gate.verify', dependsOn: ['edit'], instruction: null, inputsJson: null, outputJson: null, tools: null },
    { id: 'review', kind: 'gate.review', dependsOn: ['verify'], instruction: null, inputsJson: null, outputJson: null, tools: null },
    { id: 'verify2', kind: 'gate.verify', dependsOn: ['review'], instruction: null, inputsJson: null, outputJson: null, tools: null },
    { id: 'commit', kind: 'gate.commit', dependsOn: ['verify2'], instruction: null, inputsJson: null, outputJson: null, tools: null },
    { id: 'pr', kind: 'gate.pr', dependsOn: ['commit'], instruction: null, inputsJson: null, outputJson: null, tools: null },
  ],
  allowedModels: [{ step: 'analyze', seats: ['worker'] }, { step: 'edit', seats: ['worker'] }],
  permissions: { tools: ['read', 'listFiles', 'edit', 'runVerify'], write: ['src/**'], approvals: ['open_pr'] },
  budget: { usd: 1, tokens: 100000, wallClockSec: 900, maxDepth: null, maxIterations: null, maxAttempts: null, maxChangedFiles: null },
  goalKinds: ['fix-failing-test'],
  rationale: 'read, edit, gates',
  context: [],
};
const ff = new FixtureFetch([{ status: 200, body: { object: 'response', model: 'gpt-6', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(wire) }] }], usage: { input_tokens: 10, output_tokens: 5 } } }]);
const llm = new OpenAILLM({ auth: new SecretHandle('openai', 'env:O', 'openai', 'sk-proj-' + 'y'.repeat(40)), model: 'gpt-6', fetch: ff.fetch, maxRetries: 0 });
const goal = { id: 'fix-failing-test', statement: 'Make the failing test pass.', check: { command: 'node --test', timeoutSec: 300 }, commitment: 'single-minded', budget: { usd: 2, wallClockSec: 1200 }, status: 'open', evidence: [] };
const event = { id: 'e1', kind: 'goal.adopted', at: 1, actor: { kind: 'system', id: 'loop' }, runId: 'r1', trace: { goalId: goal.id }, payload: {} };
const beliefs = { get: () => undefined, all: () => [], match: () => false };
const plan = await new LLMPlanner({ llm, manifest, permissions, model: 'gpt-6' }).write(event, beliefs, goal, { record() {} });
const fr = new FixtureFetch([{ status: 200, body: { object: 'chat.completion', model: 'anthropic/claude-sonnet-4.5', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(wire), refusal: null } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }]);
const orLlm = new OpenRouterLLM({ auth: new SecretHandle('openrouter', 'env:R', 'openrouter', 'sk-or-v1-' + 'z'.repeat(64)), model: 'anthropic/claude-sonnet-4.5', fetch: fr.fetch, maxRetries: 0 });
const orPlan = await new LLMPlanner({ llm: orLlm, manifest, permissions, model: 'anthropic/claude-sonnet-4.5' }).write(event, beliefs, goal, { record() {} });
const rf = fr.calls[0].body.response_format;
console.log(JSON.stringify({
  openai: openAIStrictSchemaProblems(PLAN_WIRE_JSON_SCHEMA), anthropic: anthropicSchemaProblems(PLAN_WIRE_JSON_SCHEMA),
  planId: plan.id, editInputs: plan.steps[1].inputs, sentStrict: ff.calls[0].body.text.format.strict,
  sentSchemaIsWire: JSON.stringify(ff.calls[0].body.text.format.schema) === JSON.stringify(PLAN_WIRE_JSON_SCHEMA),
  docParses: parsePlanOutput(JSON.stringify(wire)).ok,
  lastKind: plan.steps[plan.steps.length - 1].kind,
  orPlanId: orPlan.id === plan.id, orUrl: fr.calls[0].url, orStrict: rf.json_schema.strict, orRequire: fr.calls[0].body.provider.require_parameters,
  orSchemaIsWire: JSON.stringify(rf.json_schema.schema) === JSON.stringify(PLAN_WIRE_JSON_SCHEMA),
}));
`,
    );
    const out = execFileSync(process.execPath, [probe], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    const r = JSON.parse(out.trim()) as {
      openai: string[];
      anthropic: string[];
      planId: string;
      editInputs: unknown;
      sentStrict: boolean;
      sentSchemaIsWire: boolean;
      docParses: boolean;
      lastKind: string;
      orPlanId: boolean;
      orUrl: string;
      orStrict: boolean;
      orRequire: boolean;
      orSchemaIsWire: boolean;
    };
    expect(r.openai).toEqual([]);
    expect(r.anthropic).toEqual([]);
    expect(r.planId).toMatch(/^p_[0-9a-f]{8}$/);
    expect(r.editInputs).toEqual({ hint: 'src' });
    expect(r.sentStrict).toBe(true);
    expect(r.sentSchemaIsWire).toBe(true);
    expect(r.docParses).toBe(true);
    expect(r.lastKind).toBe('gate.pr');
    // The same wire answer through the OpenRouter adapter (the sample's planner route): same plan, strict json_schema.
    expect(r.orPlanId).toBe(true);
    expect(r.orUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(r.orStrict).toBe(true);
    expect(r.orRequire).toBe(true);
    expect(r.orSchemaIsWire).toBe(true);
  }, 180_000);
});
