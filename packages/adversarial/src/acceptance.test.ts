import { cpSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ACCEPTANCE_INDEX, CASE_INDEX, DECISION_INDEX } from './index.js';
import { checkCommands, cli, dump, Flow, git, NPM_RE, stopHook } from './harness/e2e.js';
import { cleanupTemps, SAMPLE, tmp } from './harness/tmp.js';

/**
 * Phase 1 acceptance (docs/architecture.md "Verification", `yarn test:adversarial`): strict by default.
 *
 * - acceptance.no_gaps: no §6 case, no acceptance item and no owner-decision case may be a 'gap'. The only escape is
 *   TECERA_PHASE1_OPEN=1, which CI sets while Phase 1 is open and stops setting when it closes; with no env
 *   vars set this test FAILS while any gap remains. The test lists every open gap with its owner either way.
 *   (TECERA_ADV_STRICT=1 is separate: it runs every GAP assertion raw, see harness/gap.ts.)
 * - The SHIPPED sample runs as-is through the runtime's scripted end-to-end path: no verify-command patching.
 *   The repository sample and the copy `tecera init --sample` installs are two independent tests (one failing
 *   never hides the other). Every check command is proven npm-free BEFORE anything runs (this host's global
 *   npm is untrusted), so a sample that still says `npm test` is refused, never executed.
 */

afterAll(cleanupTemps);

const PHASE1_OPEN = process.env.TECERA_PHASE1_OPEN === '1';

/**
 * Prove the copy npm-free, commit it, drive it to its PR hold (D6: the commit to the work branch needs no
 * approval; nothing else holds), approve as a local human (D1), finish: one commit of the fix on the work
 * branch, one delivered PR request, goal.achieved with its proof (D4), main untouched (never merged).
 */
async function runAsIs(dir: string): Promise<void> {
  const npm = checkCommands(dir).filter((c) => NPM_RE.test(c.command));
  expect(npm, 'check commands that would run npm/npx (refused: never executed)').toEqual([]);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const mainBefore = git(dir, 'rev-parse', 'main').trim();
  const flow = new Flow(dir, tmp('tecera-adv-wt-'));
  const held = await flow.drive();
  expect(held.code, held.err + held.out + (await dump(dir))).toBe(4);
  expect((await flow.pending())?.trace.stepId).toBe('pr');
  const before = await flow.events();
  expect(before.filter((e) => e.kind === 'approval.requested').map((e) => e.trace.stepId), 'the PR is the only approval point').toEqual(['pr']);
  expect(before.filter((e) => e.kind === 'commit.recorded'), 'committed to the work branch before any approval').toHaveLength(1);
  expect((await stopHook(dir)).code, 'held without a proof: the Stop hook blocks').toBe(2);
  const done = await flow.finish();
  expect(done.code, done.err + done.out + (await dump(dir))).toBe(0);
  const evs = await flow.events();
  expect(evs.filter((e) => e.kind === 'commit.recorded')).toHaveLength(1);
  expect(evs.filter((e) => e.kind === 'pr.requested' || e.kind === 'pr.opened')).toHaveLength(1);
  const achieved = evs.filter((e) => e.kind === 'goal.achieved');
  expect(achieved).toHaveLength(1);
  expect(achieved[0]!.payload).toMatchObject({ proof: { command: 'node --test', exitCode: 0 } });
  expect(git(dir, 'diff', '--name-only', 'main', 'tecera/fix-failing-test').trim()).toBe('src/slugify.js');
  expect(git(dir, 'rev-parse', 'main').trim(), 'Tecera never merges').toBe(mainBefore);
  expect((await stopHook(dir)).code, 'with the proof recorded the Stop hook allows').toBe(0);
}

describe('acceptance (strict)', () => {
  it('acceptance.no_gaps: no CASE_INDEX, ACCEPTANCE_INDEX or DECISION_INDEX entry is a gap (only TECERA_PHASE1_OPEN=1 tolerates them, while Phase 1 is open)', () => {
    const gaps = [...CASE_INDEX, ...ACCEPTANCE_INDEX, ...DECISION_INDEX].filter((c) => c.status === 'gap');
    for (const g of gaps) console.log(`[adversarial acceptance] gap ${g.id}: ${(g.findings ?? []).join(' | ')}`);
    // every gap names its owner, so the report can route it
    for (const g of gaps) for (const f of g.findings ?? []) expect(f, g.id).toMatch(/owner:/);
    if (!PHASE1_OPEN) expect(gaps.map((g) => g.id), 'open gaps fail acceptance (TECERA_PHASE1_OPEN=1 tolerates them while Phase 1 is open)').toEqual([]);
  });

  it('acceptance.no_gaps [no legacy escape]: TECERA_ALLOW_GAPS no longer tolerates anything', () => {
    // the old escape hatch is gone: setting it must not change the verdict of the test above
    const root = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    const users = files.filter((f) => /process\.env\.TECERA_ALLOW_GAPS|env\[['"]TECERA_ALLOW_GAPS/.test(readFileSync(join(root, f), 'utf8')));
    expect(users, 'sources that still read TECERA_ALLOW_GAPS').toEqual([]);
  });

  it('acceptance.sample_as_is [repository sample]: samples/fix-failing-test exactly as it is in the repository runs through the scripted e2e path to one commit and one PR request', async () => {
    const dir = tmp('tecera-adv-asis-');
    cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/node_modules|ledger\.sqlite|[\\/]runs([\\/]|$)/.test(src) });
    // the copy is the sample (nothing rewritten); `tecera init` only adds the lock/adapters
    expect(checkCommands(dir).length).toBeGreaterThanOrEqual(2);
    expect((await cli(dir, ['init'])).code).toBe(0);
    await runAsIs(dir);
  }, 600_000);

  it('acceptance.sample_as_is [init --sample asset]: what `tecera init --sample` installs from the runtime package runs as-is to one commit and one PR request', async () => {
    const viaInit = tmp('tecera-adv-init-sample-');
    const init = await cli(viaInit, ['init', '--sample']);
    expect(init.code, init.err + init.out).toBe(0);
    expect(checkCommands(viaInit).length).toBeGreaterThanOrEqual(2);
    await runAsIs(viaInit);
  }, 600_000);
});
