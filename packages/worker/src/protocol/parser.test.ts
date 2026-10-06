import { describe, expect, it } from 'vitest';
import { parseProgram } from './parser.js';

describe('parseProgram', () => {
  it('extracts one fenced js body, a bare fence, or raw text', () => {
    expect(parseProgram('Here you go:\n```js\nconst a = 1;\nreturn a;\n```\nthanks')).toEqual({ ok: true, code: 'const a = 1;\nreturn a;' });
    expect(parseProgram('```javascript\nreturn 2;\n```')).toEqual({ ok: true, code: 'return 2;' });
    expect(parseProgram('```\nreturn 3;\n```')).toEqual({ ok: true, code: 'return 3;' });
    expect(parseProgram('return 4;')).toEqual({ ok: true, code: 'return 4;' });
    expect(parseProgram('```js\nreturn 5;')).toEqual({ ok: true, code: 'return 5;' });
    expect(parseProgram('```json\n{"a":1}\n```\n```js\nreturn 6;\n```')).toEqual({ ok: true, code: 'return 6;' });
  });

  it('allows forbidden words inside ordinary strings and comments where harmless', () => {
    expect(parseProgram('// we never use require here\nconst f = await readFile("src/process-list.ts");\nreturn {ok: true};').ok).toBe(true);
    expect(parseProgram('const processed = 1; const imported = 2; return processed + imported;').ok).toBe(true);
  });

  const rejects: Array<[string, string, RegExp]> = [
    ['two js blocks', '```js\nreturn 1\n```\n```js\nreturn 2\n```', /exactly one/],
    ['no js block', '```python\nprint(1)\n```', /no js code block/],
    ['empty', '```js\n\n```', /empty/],
    ['import statement', 'import fs from "fs";\nreturn 1;', /import/],
    ['dynamic import', 'const m = await import("fs"); return 1;', /import/],
    ['require', 'const fs = require("fs"); return 1;', /require/],
    ['with', 'with (obj) { x = 1 }', /with/],
    ['eval', 'return eval("1+1");', /eval/],
    ['Function', 'return Function("return this")();', /Function/],
    ['new Function', 'return new Function("return 1")();', /Function/],
    ['__proto__', 'const o = {}; o.__proto__ = null; return 1;', /__proto__/],
    ['__proto__ in string', 'const o = {}; o["__pro" + "to__"]; o["__proto__"] = 1; return 1;', /__proto__/],
    ['constructor.constructor', 'return readFile.constructor.constructor("return 1")();', /constructor/],
    ['computed constructor', 'const c = readFile["constructor"]; return 1;', /constructor/],
    ['escaped computed constructor', 'const c = readFile["\\x63onstructor"]; return 1;', /constructor/],
    ['process', 'return process.env;', /process/],
    ['globalThis', 'return globalThis.fetch;', /globalThis/],
    ['Reflect.construct', 'return Reflect.construct(Object, []);', /Reflect/],
    ['reassign history', '__history__ = null; return 1;', /reserved/],
    ['redeclare depth', 'let __depth__ = 0; return 1;', /reserved/],
    ['template escape', 'const x = `${globalThis}`; return 1;', /globalThis/],
    ['syntax error', 'return (1 + ;', /syntax/],
    ['oversize', `return "${'a'.repeat(70 * 1024)}";`, /exceeds/],
  ];
  for (const [name, src, why] of rejects) {
    it(`rejects ${name}`, () => {
      const r = parseProgram(src);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    });
  }

  it('never throws on hostile input', () => {
    for (const x of [undefined, null, 42, {}, [], '```', '`'.repeat(1000), '/*', '"', '`${', '\u0000return 1', 'x'.repeat(1_000_000)]) {
      expect(() => parseProgram(x)).not.toThrow();
      expect(parseProgram(x).ok === false || parseProgram(x).ok === true).toBe(true);
    }
  });
});

describe('parseProgram: escape.eval lexer edge cases', () => {
  const rejects: Array<[string, string, RegExp]> = [
    ['escaped identifier \\u0061', String.raw`return eval('1');`, /eval/],
    ['escaped identifier \\u{..}', String.raw`return \u{65}val('1');`, /eval/],
    ['escaped Function', String.raw`return Function('return 1')();`, /Function/],
    ['escaped process', String.raw`return process.env;`, /process/],
    ['quote inside a regex hides code from a regex-blind lexer', 'const r = /"/; return eval(1); //"', /eval/],
    ['regex after if (...) hides a quote', 'let s = ""; if (s) /"/.test(s); return eval(1); //"', /eval/],
    ['division that looks like a regex', 'const a = 4, b = 2; const c = a / b; eval(1); const d = c / 2;', /eval/],
    ['comment marker inside a regex class', 'const r = /[//]/; return eval(1);', /eval/],
    ['escaped identifier in a template expression', 'const x = `${glob\\u0061lThis}`; return 1;', /globalThis/],
  ];
  for (const [name, src, why] of rejects) {
    it(`rejects ${name}`, () => {
      const r = parseProgram(src);
      expect(r.ok, src).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    });
  }

  it('still accepts ordinary regexes, divisions and escapes inside strings', () => {
    for (const src of ['const m = "a1b2".match(/\\d+/g); return m;', 'const x = 10 / 2 / 5; return x;', 'return "caf\\u00e9";', 'const r = /["\']/; return r.test("x");', 'if (true) { return /\\//.test("a/b"); }']) {
      expect(parseProgram(src), src).toMatchObject({ ok: true });
    }
  });

  it('stays linear on long identifier-heavy programs', () => {
    const src = `let ${'a'.repeat(60_000)} = 1; return 1;`;
    const t = Date.now();
    parseProgram(src);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('prompts teach the contract dialect', () => {
  it('the worked example is a valid program and the prompt names the host functions and view handles', async () => {
    const { EXAMPLE_PROGRAM, workerSystemPrompt, STANDARD_STUBS } = await import('./prompts.js');
    expect(parseProgram(EXAMPLE_PROGRAM)).toMatchObject({ ok: true });
    const p = workerSystemPrompt({ stubs: Object.values(STANDARD_STUBS), outputSchema: { type: 'object' }, canInvoke: true });
    expect(p).toContain('await readFile(path)');
    expect(p).toContain('readFile.call(path)');
    expect(p).toContain('narrow: {tools?, limits?, depth?}');
    expect(p).toContain('len()');
    expect(p).toContain(EXAMPLE_PROGRAM);
  });
});
