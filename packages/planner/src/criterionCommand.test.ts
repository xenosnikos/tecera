import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManifest, type AchievementGoal, type Criterion, type Manifest } from '@tecera/contracts';
import { ContractRejected, commandAlwaysPasses, contractDraftIssues } from './contract.js';
import { FakeLLM, goal, samplePermissions } from './fixtures.testkit.js';
import { LLMPlanner } from './llmPlanner.js';
import { buildContractPrompt } from './prompt.js';
import { commandFocus, commandImports, commandRunsFiles, commandSandboxProblems, commandStatusProblems, commandUnknownPrograms, contractQualityIssues } from './quality.js';
import { testedApiOf } from './repoFacts.js';
import type { ScriptedContract } from './scripted.js';
import { readShell } from './shell.js';

/**
 * What a criterion command really runs and whose exit status it ends with. Two holes are closed here by
 * construction rather than by listing strings: a prefix (`timeout 5 …`) or an unknown program that the
 * per-script screens could not see through and that counted as a behavioural check, and a check whose exit
 * status the line around it replaces (`check || echo`, `check | tail`, `check; echo done`).
 */

const fixture = (scenario: string, rel: string) => new URL(`../../bench/fixtures/${scenario}/${rel}`, import.meta.url);
const file = (scenario: string, path: string) => ({ path, text: readFileSync(fixture(scenario, `repo/${path}`), 'utf8') });
const manifestOf = (id: string): Manifest => parseManifest(JSON.parse(readFileSync(fixture(id, 'repo/tecera.json'), 'utf8')));
const caught = (pr: Promise<unknown>) => pr.then(() => null, (e: unknown) => e);

const statement = 'add rate limiting';
const g: AchievementGoal = { ...goal, id: 'g-cmd', statement, criteria: undefined, contractHash: undefined } as AchievementGoal;
const k = (id: string, command: string): Criterion => ({ id, statement: id, check: { kind: 'command', command, timeoutSec: 60 } });
const draftOf = (command: string) => ({ contract: { goalId: g.id, statement, criteria: [k('limited', command), k('suite', 'node --test')], outOfScope: [], assumptions: [] }, needs: [] });
/** The quality issues of a draft whose one focused criterion is `command` (every file exists, nothing is installed). */
const quality = (command: string): string[] => contractQualityIssues(draftOf(command), { statement, goal: g, fileExists: () => true, dependencies: [] });
const draft = (command: string): string[] => contractDraftIssues(draftOf(command), { goal: g, statement });
const refusedBy = (command: string): string => [...draft(command), ...quality(command)].join('\n');

const inline = (body: string) => `node --input-type=module -e 'import assert from "node:assert/strict"; ${body}'`;
const REAL = inline('import { createApp } from "./src/app.js"; assert.equal(createApp()({ ip: "1.1.1.1", path: "/items" }).status, 429);');
const TEST = 'node --test test/app.test.js';

/** Prefixes the reader strips, each in a spelling a draft could carry. */
const PREFIXES = [
  'timeout 30',
  'timeout  -k 5   30s',
  '/usr/bin/timeout --signal=KILL --preserve-status 30',
  'timeout -s KILL 30',
  'env -u FOO',
  'env -i A=1 B=2',
  '/usr/bin/env',
  'A=1 B="x y" env C=3',
  'nice -n 5',
  'nice -5',
  'nice --adjustment=5',
  'time -p',
  'command',
  'exec',
  'stdbuf -o0',
  'stdbuf -o L -e L',
  'ionice -c 2 -n 7',
  'yarn exec',
  'npx',
  'npx --yes',
  'pnpm exec',
  'npm exec --',
  'timeout 30 env X=1 nice',
];

describe('a prefix does not hide what a criterion runs (finding A)', () => {
  it('the reported commands are refused: nested shell, call shape, no-ops', () => {
    // 1. the nested shell behind `timeout` is read: background job, sleep, curl, kill.
    const server = `timeout 20 bash -c 'node src/app.js & pid=$!; sleep 1; curl -fsS -o /dev/null -w "%{http_code}" "http://$(hostname):3000/items" | grep -q 429; rc=$?; kill $pid; exit $rc'`;
    expect(commandSandboxProblems(server)).toEqual(['backgrounds a command (&)', 'uses sleep', 'runs curl', 'uses kill']);
    expect(quality(server).join('\n')).toMatch(/criterion limited backgrounds a command \(&\), uses sleep, runs curl, uses kill/);

    // 2. the inline script behind a prefix is read: the invented call shape is refused as without the prefix.
    const testedApi = testedApiOf([file('05-needs-mail', 'test/signup.test.js')], [file('05-needs-mail', 'src/signup.js')]);
    const signup = inline('import { signup } from "./src/signup.js"; const r = await signup("u@e.com"); assert.ok(r.emailSent);');
    const shape = (command: string) => contractQualityIssues(draftOf(command), { statement, goal: g, fileExists: () => true, dependencies: [], testedApi }).join('\n');
    expect(shape(signup)).toMatch(/argument 1 is a string, the existing code takes an object/);
    for (const prefix of ['timeout 30', 'env -u FOO', 'yarn', ...PREFIXES]) expect(shape(`${prefix} ${signup}`), prefix).toMatch(/argument 1 is a string, the existing code takes an object/);

    // 3, 4. commands that run nothing of the repository never count as the focused criterion.
    for (const c of ['node --version', 'timeout 5 true', 'git status', 'xargs true', 'stdbuf -o0 echo hi', 'timeout 5 echo ok', 'timeout 5 grep -q foo src/a.js', `timeout 5 node -e 'console.log(1)'`, `nice -n 5 node -e "console.log(1)"`, `yarn node -e 'console.log(1)'`]) {
      expect(commandFocus(c), c).not.toBe('focused');
      expect(quality(c).join('\n'), c).toMatch(/criterion limited (runs nothing that can fail on the behaviour|only searches the repository text)/);
      expect(quality(c).join('\n'), c).toMatch(/only generic criteria/);
    }
    expect(commandAlwaysPasses('timeout 5 true')).toBe(true);
    // The missing-module check runs behind a prefix too.
    expect(commandImports(`timeout 5 node -e 'import("./src/nope.js")'`).modules).toEqual(['src/nope.js']);
  });

  it('every known prefix is read through by every per-script screen', () => {
    for (const p of PREFIXES) {
      // inert script
      expect(commandFocus(`${p} node -e 'console.log(1)'`), p).toBe('inert');
      // no-op and text search
      expect(commandFocus(`${p} true`), p).toBe('inert');
      expect(commandFocus(`${p} grep -q 429 src/app.js`), p).toBe('inspect');
      expect(commandFocus(`${p} node --version`), p).toBe('inert');
      // nested shell: sandbox problems and a masked exit status
      expect(commandSandboxProblems(`${p} bash -c 'node src/app.js & sleep 1; kill %1'`), p).toEqual(['backgrounds a command (&)', 'uses sleep', 'uses kill']);
      expect(commandSandboxProblems(`${p} curl -fsS http://example.com`), p).toEqual(['runs curl']);
      expect(commandStatusProblems(`${p} sh -c '${TEST} || true'`), p).toEqual(['falls back with ||']);
      // imports and files
      expect(commandImports(`${p} ${inline('import { x } from "./src/nope.js"; assert.ok(x);')}`).modules, p).toEqual(['src/nope.js']);
      expect(commandRunsFiles(`${p} node test/new.js`), p).toEqual(['test/new.js']);
      // and an honest check stays one
      expect(commandFocus(`${p} ${REAL}`), p).toBe('focused');
      expect(commandFocus(`${p} ${TEST}`), p).toBe('focused');
      expect(quality(`${p} ${REAL}`), p).toEqual([]);
    }
    // A prefix that is itself job control is still named.
    expect(commandSandboxProblems(`nohup ${TEST}`)).toEqual(['uses nohup']);
    expect(commandSandboxProblems(`setsid bash -c '${TEST}'`)).toEqual(['uses setsid']);
    expect(commandSandboxProblems('timeout 70 sleep 61; node --test test/app.test.js')).toEqual(['uses sleep']);
  });

  it('a program the host does not know is never a behavioural check, alone or as a prefix', () => {
    const unknown: Array<[string, string]> = [
      ['foo --check', 'foo'],
      ['sudo node --test test/app.test.js', 'sudo'],
      [`chronic ${REAL}`, 'chronic'],
      ['doas -u nobody npm test', 'doas'],
      ['$NODE test/app.test.js', '$NODE'],
      ['"$(which node)" --test test/app.test.js', '$(which node)'],
      ['builtin true', 'builtin'],
      ['tsc --noEmit', 'tsc'],
      ['npx cowsay ok', 'cowsay'],
      ['./node_modules/.bin/cowsay ok', 'cowsay'],
      ['node /dev/null', 'node'],
      ['bash /dev/null', 'bash'],
      ['node --test /dev/null', 'node'],
      ['node "$FILE"', 'node'],
      ['python3 -m http.server', 'python3'],
      ['make -f /dev/null all', 'make'],
      ['find . -name "*.js" -exec true {} +', 'find'],
      ['timeout 5', 'timeout'],
    ];
    for (const [c, prog] of unknown) {
      expect(commandUnknownPrograms(c), c).toEqual([prog]);
      expect(commandFocus(c), c).toBe('inert');
      const issues = quality(c).join('\n');
      expect(issues, c).toMatch(/criterion limited runs \S+ in a form the host does not know as a check; run the behaviour with an inline node assertion/);
      expect(issues, c).toMatch(/only generic criteria/);
    }
    // An unknown program beside an honest check is refused too: what follows it is screened by nothing.
    expect(quality(`chronic sh -c 'sleep 61' && ${TEST}`).join('\n')).toMatch(/runs chronic in a form the host does not know/);
  });

  it('asking a program for its version or help, listing, or a dry run is not a check', () => {
    for (const c of [
      'node --version',
      'node -v',
      '/usr/local/bin/node   --help',
      'python3 -V',
      'npm --version',
      'npm -v',
      'npm --version test',
      'npm test --help',
      'npm run',
      'npm run nothing --if-present',
      'jest --version',
      'npx vitest --help',
      'npx jest --listTests',
      'pytest --collect-only',
      'pytest --version',
      'cargo test --no-run',
      'make -n test',
      'make --dry-run test',
      'node --test --help',
      'bash --version',
      'command -v node',
      'which node',
      'git log -1',
      'git diff --quiet',
      'env',
      'timeout 5 env FOO=1 /bin/true',
    ]) {
      expect(commandFocus(c), c).not.toBe('focused');
      expect(commandFocus(c), c).not.toBe('generic');
      expect(quality(c).join('\n'), c).toMatch(/only generic criteria/);
    }
  });

  it('honest checks stay accepted, behind a prefix or not', () => {
    for (const c of [
      'node --test test/x.test.js',
      REAL,
      `timeout 30 ${REAL}`,
      'env NODE_ENV=test node --test test/app.test.js',
      '/usr/bin/env node --test test/app.test.js',
      'NODE_ENV=test node --test test/app.test.js',
      'cd pkg && node --test test/a.test.js',
      '(cd pkg && node --test test/a.test.js)',
      'npx vitest run src/a.test.ts',
      './node_modules/.bin/vitest run src/a.test.ts',
      'yarn vitest run src/a.test.ts',
      './scripts/check.sh',
      'bash scripts/check.sh',
      'node bin/report.js --format csv',
      'python3 -m pytest tests/test_a.py',
      'python3 manage.py test app',
      'go test ./pkg/limit',
      'cargo test parse_csv',
      'pytest -k limit',
      'npm test -- test/a.test.js',
      'npm run test:unit',
      'make lint',
      'npx vitest run -t "rate limit$"',
      `node -e "const a = require('./src/a'); if (a.join(['x', 'y'], 'a|b;c && d') !== 'xa|b;c && dy') process.exit(1)"`,
    ]) {
      expect(commandFocus(c), c).toBe('focused');
      expect(commandUnknownPrograms(c), c).toEqual([]);
      expect(commandStatusProblems(c), c).toEqual([]);
      expect(commandAlwaysPasses(c), c).toBe(false);
      expect(refusedBy(c), c).toBe('');
    }
    // The whole suite stays generic and carries no per-criterion issue.
    for (const c of ['node --test', 'npm test', 'cd pkg && node --test', 'npm --prefix api test', 'yarn workspace api test', 'pnpm --filter api test', 'timeout 600 npm test']) {
      expect(commandFocus(c), c).toBe('generic');
      expect(commandUnknownPrograms(c), c).toEqual([]);
      expect(commandStatusProblems(c), c).toEqual([]);
      expect(commandAlwaysPasses(c), c).toBe(false);
    }
  });
});

describe("a criterion's exit status is the check's own (finding B)", () => {
  /** The reported commands: each exits 0 with the check replaced by `false`. */
  const REPORTED = [
    `${TEST} || echo "rate limit tests failed"`,
    `${REAL} && echo PASS || echo FAIL`,
    `${TEST} | tail -5`,
    `${TEST}; echo done`,
    `${TEST} || /bin/true`,
    `${TEST} || (exit 0)`,
    `${TEST} || test 1`,
    `${TEST} | tee out.log`,
  ];
  /** The same class in other spellings: another operator, quoting, spacing, paths, prefixes, nesting. */
  const VARIANTS = [
    `${TEST} ||true`,
    `${TEST} || :`,
    `${TEST}||echo no`,
    `${TEST} 2>&1|tee /tmp/log`,
    `${TEST} |& cat`,
    `${TEST} | cat`,
    `${TEST} | head -n 20`,
    `${TEST} | sort | uniq | wc -l`,
    `${TEST} ;  echo "done"`,
    `${TEST}; :`,
    `${TEST}; printf '%s\\n' "a | b; c || d"`,
    `(${TEST}; true)`,
    `{ ${TEST}; :; }`,
    `sh -c '${TEST}; echo ok'`,
    `bash -c "${TEST} || true"`,
    `bash -lc '${TEST} | tail -1'`,
    `eval '${TEST}; true'`,
    `/usr/bin/timeout 60 ${TEST} || env true`,
    `env CI=1 ${TEST} | /usr/bin/tail -n 3`,
    `timeout 60 sh -c 'nice ${TEST} || command echo failed'`,
    `${TEST} && echo PASS || { echo FAIL; }`,
    `${REAL} || echo "assertion failed"`,
    `${REAL}; echo "exit: $?"`,
    `${TEST}; exit 0`,
    `${TEST} || exit 0`,
    `${TEST} &`,
    `${TEST} > /dev/null 2>&1 || [ ok ]`,
    `echo "$(${TEST})"`,
    'X=`node --test test/app.test.js`; echo $X',
    `: $(${TEST})`,
  ];
  /** Lines that can fail, but not as the check does: refused in a draft, left to a requestor who writes one. */
  const NOT_THE_CHECKS: Array<[string, RegExp]> = [
    ['! node bin/cli.js --bad-flag', /negates with !/],
    [`if ${TEST}; then echo ok; fi`, /uses shell control flow/],
    [`for f in test/*.test.js; do node --test "$f"; done`, /uses shell control flow/],
    [`while ! ${TEST}; do exit 1; done`, /uses shell control flow/],
    [`${TEST} | grep -q pass`, /drops the exit status of node \(before \| or ;\)/],
    ['node --test test/a.test.js; node --test test/b.test.js', /drops the exit status of node \(before \| or ;\)/],
    [`set -e; ${TEST}; echo ok`, /drops the exit status of node/],
    [`trap "exit 0" EXIT; ${TEST}`, /sets a trap/],
    [`set +e; ${TEST}`, /turns errexit off/],
    [`${TEST}; exit $?`, /calls exit/],
    [`${TEST} && exit 0`, /calls exit/],
    [`${TEST} > >(tee log)`, /has shell syntax the host cannot read/],
    ['check() { node --test; }; check', /has shell syntax the host cannot read/],
    [`case x in x) ${TEST};; esac`, /has shell syntax the host cannot read/],
    [`${TEST} "unclosed`, /has shell syntax the host cannot read/],
    [`[ "$(node bin/cli.js 1 2)" = 3 ] && ${TEST}`, /drops the exit status of node \(inside \$\(…\)\)/],
  ];
  /** Honest, but in a form the host cannot judge before the shell runs: refused in a draft as an unknown operand. */
  const UNJUDGED = ['node --test $(ls test/*.test.js)', 'node "$TEST_FILE"', 'cd test && node ../bin/cli.js'];
  /** Honest lines: the status is the check's. */
  const HONEST = [
    'node --test test/x.test.js',
    'npm test',
    'cd pkg && node --test',
    'cd pkg; node --test test/a.test.js',
    'export NODE_ENV=test; node --test test/app.test.js',
    'mkdir -p tmp && rm -rf tmp/out && node --test test/app.test.js',
    REAL,
    `node -e "const a = require('./src/a'); if (a.f('x || y; z | w & v') !== 1) process.exit(1)"`,
    `${TEST} 2>&1`,
    `${TEST} >/dev/null 2>&1`,
    `${TEST} &> out.txt`,
    `${TEST};`,
    `${TEST} && echo ok`,
    `${TEST} # the rate limit suite`,
    'cat data/in.csv | node bin/csv.js',
    `timeout 60 ${TEST}`,
    `sh -c '${TEST}'`,
    `(cd pkg && node --test test/a.test.js)`,
    `{ ${TEST}; }`,
    'node --test test/a.test.js && node --test test/b.test.js',
    'command -v node && node --test test/a.test.js',
    'node --test test/*.test.js',
  ];

  it('the reported commands and their variants cannot fail: refused whoever wrote them, with what to write instead', () => {
    for (const c of [...REPORTED, ...VARIANTS]) {
      expect(commandAlwaysPasses(c), c).toBe(true);
      const issues = draft(c);
      expect(issues.join('\n'), c).toMatch(/criterion limited: command exits 0 whatever the repository holds; it checks nothing \(the exit status must be the check's own/);
      expect(commandStatusProblems(c).length + commandSandboxProblems(c).length, c).toBeGreaterThan(0);
    }
  });

  it('a drafted criterion whose status is not the check\'s is refused, and the diagnostic says what to write', () => {
    for (const c of [...REPORTED, ...VARIANTS.filter((x) => !x.endsWith('&'))]) {
      const issues = quality(c);
      const line = issues.find((x) => x.includes("its exit status must be the check's own"));
      expect(line, c).toMatch(/^criterion limited .+: its exit status must be the check's own\. Write one check \(an inline node assertion, or node --test <file>\), setup joined with && only: no \|, \|\|, ;, !, exit or trap$/);
      // The diagnostic survives the planner's bound on a diagnostic line whole.
      expect(line!.length, c).toBeLessThan(300);
    }
    // A background job is named by the sandbox screen.
    expect(quality(`${TEST} &`).join('\n')).toMatch(/criterion limited backgrounds a command \(&\)/);
    for (const [c, why] of NOT_THE_CHECKS) {
      expect(commandStatusProblems(c).join(', '), c).toMatch(why);
      expect(quality(c).join('\n'), c).toMatch(/its exit status must be the check's own\. Write one check/);
    }
  });

  it('each masking shape is named for what it is', () => {
    expect(commandStatusProblems(`${TEST} || echo failed`)).toEqual(['falls back with ||']);
    expect(commandStatusProblems(`${REAL} && echo PASS || echo FAIL`)).toEqual(['falls back with ||']);
    expect(commandStatusProblems(`${TEST} | tail -5`)).toEqual(['drops the exit status of node (before | or ;)']);
    expect(commandStatusProblems(`${TEST}; echo done`)).toEqual(['drops the exit status of node (before | or ;)']);
    expect(commandStatusProblems(`${TEST} || (exit 0)`)).toEqual(['falls back with ||', 'calls exit']);
    expect(commandStatusProblems(`echo $(${TEST})`)).toEqual(['drops the exit status of node (inside $(…))']);
    expect(commandStatusProblems(`./check.sh | tee log`)).toEqual(['drops the exit status of check.sh (before | or ;)']);
    expect(commandStatusProblems(`npm test 2>&1 | tail -20`)).toEqual(['drops the exit status of npm (before | or ;)']);
  });

  it('honest commands keep their status and stay accepted', () => {
    for (const c of HONEST) {
      expect(commandStatusProblems(c), c).toEqual([]);
      expect(commandAlwaysPasses(c), c).toBe(false);
      expect(draft(c), c).toEqual([]);
      expect(quality(c).filter((x) => /exit status|does not know/.test(x)), c).toEqual([]);
    }
    for (const c of UNJUDGED) expect(quality(c).join('\n'), c).toMatch(/runs node in a form the host does not know as a check/);
    // Operators inside quotes are data, in either quote style and escaped.
    expect(readShell(`node -e 'a || b; c | d & e' "x && y" z\\;w`).segments.map((x) => x.words)).toEqual([['node', '-e', 'a || b; c | d & e', 'x && y', 'z;w']]);
    expect(readShell(`node -e "say(\\"a | b\\")" 'it'"'"'s'`).segments.map((x) => x.words)).toEqual([['node', '-e', 'say("a | b")', "it's"]]);
    expect(readShell(`${TEST} 2>&1 >/dev/null <in.txt &>all.log`).segments.map((x) => x.words)).toEqual([['node', '--test', 'test/app.test.js']]);
  });

  it('a requestor may still write a line that can fail in its own way; only one that cannot fail is refused', () => {
    for (const c of [`${TEST} | grep -q "fail 0"`, '! grep -rq TODO src', `set -e; ${TEST}; echo ok`, `sh -ec '${TEST}; echo ok'`, `if ${TEST}; then echo ok; else exit 1; fi`, 'test -f dist/index.js', 'wc -l < data/in.csv', 'cat data/in.csv']) {
      expect(commandAlwaysPasses(c), c).toBe(false);
      expect(draft(c), c).toEqual([]);
    }
    // Under errexit an earlier check does reach the status; without it the trailing echo decides.
    expect(commandAlwaysPasses(`set -e; ${TEST}; echo ok`)).toBe(false);
    expect(commandAlwaysPasses(`set -e; set +e; ${TEST}; echo ok`)).toBe(true);
    expect(commandAlwaysPasses(`sh -c '${TEST}; echo ok'`)).toBe(true);
    // An agreed criterion is exempt from the drafted-criterion screen, as from the other per-criterion checks.
    const agreed = k('agreed', `${TEST} | grep -q "fail 0"`);
    const withAgreed = { contract: { goalId: g.id, statement, criteria: [agreed, k('limited', REAL), k('suite', 'node --test')], outOfScope: [], assumptions: [] }, needs: [] };
    expect(contractQualityIssues(withAgreed, { statement, goal: { ...g, criteria: [agreed], contractHash: 'h' } })).toEqual([]);
    expect(contractQualityIssues(withAgreed, { statement, goal: g }).join('\n')).toMatch(/criterion agreed drops the exit status of node/);
  });

  it('the planner refuses such a draft end to end and accepts the repaired one', async () => {
    const m2 = manifestOf('02-api-no-limits');
    const permissions = samplePermissions();
    const wire = (command: string) =>
      JSON.stringify({
        criteria: [
          { id: 'limited', statement: 'A client over the limit gets 429', kind: 'command', command, timeoutSec: 60, prompt: null, requires: [], tags: [] },
          { id: 'suite', statement: 'Existing tests pass', kind: 'command', command: 'node --test', timeoutSec: 60, prompt: null, requires: [], tags: [] },
        ],
        outOfScope: [],
        assumptions: [],
        envelope: [{ path: 'src/app.js', ops: ['modify'] }],
        needs: [],
      });
    const has = (p: string) => ['src/app.js', 'test/app.test.js', 'package.json'].includes(p);
    const planner = (answers: string[]) => new LLMPlanner({ llm: new FakeLLM(answers), manifest: m2, permissions, nonce: () => 'n', repoFiles: has });
    const bad: Array<[string, RegExp]> = [
      [`${TEST} || echo "rate limit tests failed"`, /exits 0 whatever the repository holds/],
      [`${REAL} && echo PASS || echo FAIL`, /exits 0 whatever the repository holds/],
      [`${TEST} | tail -5`, /exits 0 whatever the repository holds/],
      [`${TEST}; echo done`, /exits 0 whatever the repository holds/],
      [`${TEST} | grep -q pass`, /its exit status must be the check's own\. Write one check/],
      [`! ${TEST}`, /its exit status must be the check's own\. Write one check/],
      ['node --version', /runs nothing that can fail on the behaviour/],
      ['timeout 5 true', /exits 0 whatever the repository holds/],
      ['git status', /only searches the repository text/],
      [`timeout 5 node -e 'console.log(1)'`, /runs nothing that can fail on the behaviour/],
      [`chronic ${TEST}`, /runs chronic in a form the host does not know as a check/],
      [`timeout 20 bash -c 'node src/app.js & pid=$!; sleep 1; curl -fsS "http://$(hostname):3000/items" | grep -q 429; rc=$?; kill $pid; exit $rc'`, /backgrounds a command \(&\), uses sleep, runs curl, uses kill/],
    ];
    for (const [command, why] of bad) {
      const err = (await caught(planner([wire(command), wire(command)]).draftContract(statement, g, []))) as ContractRejected;
      expect(err, command).toBeInstanceOf(ContractRejected);
      expect(err.issues.join('\n'), command).toMatch(why);
      const d = await planner([wire(command), wire(REAL)]).draftContract(statement, g, []);
      expect(d.contract.criteria.map((x) => x.id), command).toEqual(['limited', 'suite']);
    }
    for (const command of [REAL, TEST, `timeout 30 ${REAL}`, `cd . && ${TEST}`]) {
      const d = await planner([wire(command)]).draftContract(statement, g, []);
      expect(d.contract.criteria[0]!.check, command).toEqual({ kind: 'command', command, timeoutSec: 60 });
    }
  });

  it('the drafting prompt states the rule the screen enforces', () => {
    const system = buildContractPrompt({ statement, goal: g, manifest: manifestOf('02-api-no-limits'), nonce: 'n' })[0]!.content as string;
    expect(system).toMatch(/The command is that one check, at most after setup steps joined with `&&`: never `\|`, `\|\|`, `;`, `!`, `exit`, `trap`, `if` or `\$\(…\)` around it/);
  });
});

describe('the bench fixtures and samples keep their criteria', () => {
  it('every scripted contract command is an honest check under the stricter screens', () => {
    const ids = readdirSync(new URL('../../bench/fixtures/', import.meta.url)).filter((id) => /^\d\d-/.test(id));
    let seen = 0;
    for (const id of ids) {
      let contracts: ScriptedContract[];
      try {
        contracts = JSON.parse(readFileSync(fixture(id, 'scripted/contract.json'), 'utf8')) as ScriptedContract[];
      } catch {
        continue;
      }
      for (const c of contracts)
        for (const x of c.criteria) {
          if (x.check.kind !== 'command') continue;
          seen++;
          const cmd = x.check.command;
          expect(commandStatusProblems(cmd), `${id} ${x.id}`).toEqual([]);
          expect(commandUnknownPrograms(cmd), `${id} ${x.id}`).toEqual([]);
          expect(commandAlwaysPasses(cmd), `${id} ${x.id}`).toBe(false);
          expect(commandSandboxProblems(cmd), `${id} ${x.id}`).toEqual([]);
          expect(commandFocus(cmd), `${id} ${x.id}`).toBe(cmd === 'node --test' ? 'generic' : 'focused');
        }
    }
    expect(seen).toBeGreaterThan(10);
    // samples/fix-failing-test verifies with the bare suite.
    expect(commandFocus('node --test')).toBe('generic');
    expect(commandStatusProblems('node --test')).toEqual([]);
  });
});

describe('neighbouring screens read the same structure', () => {
  it('shell control words and brace groups do not turn a text search into a behavioural check', () => {
    for (const c of ['if grep -q 429 src/app.js; then exit 0; else exit 1; fi', '{ grep -q "Retry-After" src/app.js; }', 'while ! grep -q 429 src/app.js; do exit 1; done', '( grep -q 429 src/app.js )', 'until grep -q 429 src/app.js; do false; done']) {
      expect(commandFocus(c), c).not.toBe('focused');
      expect(quality(c).join('\n'), c).toMatch(/only generic criteria/);
    }
    expect(commandFocus('{ grep -q "Retry-After" src/app.js; }')).toBe('inspect');
  });

  it('an inline script that only reads a source file is a text search, not a run', () => {
    for (const c of [
      `node -e 'const s = require("fs").readFileSync("./src/app.js", "utf8"); if (!s.includes("429")) process.exit(1)'`,
      inline('import { readFileSync } from "node:fs"; assert.match(readFileSync("src/app.js", "utf8"), /429/);'),
      `python3 -c "import sys; sys.exit(0 if '429' in open('./src/app.py').read() else 1)"`,
    ])
      expect(commandFocus(c), c).toBe('inert');
    // Importing, requiring or spawning the code still reaches it.
    for (const c of [
      `node -e 'const r = require("./src/a"); if (r.x !== 1) process.exit(1)'`,
      inline('const { f } = await import("./src/a.js"); assert.equal(f(), 1);'),
      inline('import { spawnSync } from "node:child_process"; const r = spawnSync(process.execPath, ["bin/report.js", "--format", "csv"], { encoding: "utf8" }); assert.equal(r.status, 0);'),
      `python3 -c "import subprocess; assert subprocess.run(['python3', 'tools/check.py']).returncode == 0"`,
    ])
      expect(commandFocus(c), c).toBe('focused');
  });

  it('a long wait is seen as an expression, a named constant, another name for the timer, or a wrapped sleep', () => {
    for (const body of [
      'await new Promise(r => setTimeout(r, 61 * 1000));',
      'await new Promise(r => setTimeout(r, 61e3));',
      'const WINDOW = 61000; await new Promise(r => setTimeout(r, WINDOW));',
      'const WINDOW_MS = 60 * 1000; await new Promise((r) => setTimeout(r, WINDOW_MS + 1000));',
      'import { setTimeout as sleep } from "node:timers/promises"; await sleep(61000);',
      'const { setTimeout: pause } = require("node:timers/promises"); await pause(2 * 1000);',
    ])
      expect(commandSandboxProblems(inline(`import { createApp } from "./src/app.js"; ${body} assert.ok(createApp());`)), body).toEqual(['waits on a timer']);
    for (const body of ['await new Promise(r => setTimeout(r, 5));', 'await new Promise(r => setTimeout(r, 10 * 9));', 'const ms = options.ms; await new Promise(r => setTimeout(r, ms));', 'setTimeout(() => assert.equal(f(1, 2), 3), 0);'])
      expect(commandSandboxProblems(inline(`import { createApp } from "./src/app.js"; ${body} assert.ok(createApp());`)), body).toEqual([]);
    expect(commandSandboxProblems('timeout 70 sleep 61; node --test test/app.test.js')).toEqual(['uses sleep']);
    expect(commandSandboxProblems('env sleep 61 && node --test test/app.test.js')).toEqual(['uses sleep']);
  });
});
