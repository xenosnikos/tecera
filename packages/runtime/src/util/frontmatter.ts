import type { Json, JsonObject } from '@tecera/contracts';

/**
 * Front matter for `.tecera/**.md` files: a `---` fenced block of `key: value` lines (comments with
 * ` #`), scalar values, and one-line flow maps / sequences (`{ usd: 2 }`, `[a, b]`). Not general YAML on
 * purpose: anything else is a parse error, never a guess.
 */

export class FrontMatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontMatterError';
  }
}

export function splitFrontMatter(text: string): { data: JsonObject; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw new FrontMatterError('missing front matter (expected a leading ---)');
  const end = lines.indexOf('---', 1);
  const endIdx = end === -1 ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : end;
  if (endIdx === -1) throw new FrontMatterError('unterminated front matter');
  const data: JsonObject = {};
  for (let i = 1; i < endIdx; i++) {
    const raw = stripComment(lines[i]!);
    if (!raw.trim()) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw.trim());
    if (!m) throw new FrontMatterError(`line ${i + 1}: expected "key: value"`);
    if (m[1]! in data) throw new FrontMatterError(`line ${i + 1}: duplicate key ${m[1]}`);
    data[m[1]!] = parseValue(m[2]!.trim(), i + 1);
  }
  return { data, body: lines.slice(endIdx + 1).join('\n').trim() };
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function splitTop(s: string, line: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (depth < 0) throw new FrontMatterError(`line ${line}: unbalanced brackets`);
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (depth !== 0 || quote) throw new FrontMatterError(`line ${line}: unbalanced brackets or quotes`);
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

export function parseValue(v: string, line = 0): Json {
  if (v === '') return null;
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) throw new FrontMatterError(`line ${line}: unterminated map`);
    const obj: JsonObject = {};
    for (const part of splitTop(v.slice(1, -1), line)) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*|"[^"]*")\s*:\s*(.*)$/.exec(part);
      if (!m) throw new FrontMatterError(`line ${line}: bad map entry "${part}"`);
      obj[m[1]!.replace(/^"|"$/g, '')] = parseValue(m[2]!.trim(), line);
    }
    return obj;
  }
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new FrontMatterError(`line ${line}: unterminated list`);
    return splitTop(v.slice(1, -1), line).map((x) => parseValue(x, line));
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
