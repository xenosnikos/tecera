import { describe, expect, it } from 'vitest';
import { makeRedactor } from '@tecera/contracts';
import { CappedStream, INTERRUPTED_MARKER, OUTPUT_WITHHELD, redactCapped, trailingTokenStart } from './capture.js';

/** Redaction happens BEFORE the cut, with lookahead (Codex sprint-2 sandbox finding 5). */

const SECRET = 'capture-REGISTERED-secret-0123456789abcdef';
const r = makeRedactor([SECRET]);
const ENCODINGS = {
  raw: SECRET,
  base64: Buffer.from(SECRET).toString('base64'),
  hex: Buffer.from(SECRET).toString('hex'),
  pct: [...Buffer.from(SECRET)].map((b) => '%' + b.toString(16).padStart(2, '0')).join(''),
};
const windows = (s: string, n: number): string[] => Array.from({ length: Math.max(0, s.length - n + 1) }, (_, i) => s.slice(i, i + n));
const leaks = (out: string): string[] => Object.values(ENCODINGS).flatMap((e) => windows(e, 8)).filter((w) => out.includes(w));

describe('redactCapped', () => {
  it('a naive raw cut leaves an encoded fragment the redactor cannot match (the bug this fixes)', () => {
    const text = 'a'.repeat(100) + ENCODINGS.base64;
    expect(leaks(r.redactText(text.slice(0, 120))).length).toBeGreaterThan(0);
  });

  for (const [name, enc] of Object.entries(ENCODINGS)) {
    it(`uncut source: a ${name} secret straddling maxChars is redacted, then cut`, () => {
      for (let off = 1; off < enc.length; off += 7) {
        const out = redactCapped(r, 'a'.repeat(1000 - off) + enc + 'b'.repeat(500), 1000, false);
        expect(out.truncated).toBe(true);
        expect(out.text.length).toBeLessThanOrEqual(1000);
        expect(leaks(out.text), `${name} @${off}`).toEqual([]);
      }
    });

    it(`cut source: a ${name} secret straddling maxChars with lookahead is redacted; the uncertain tail is dropped`, () => {
      for (let off = 1; off < enc.length; off += 7) {
        // Capture holds maxChars + lookahead; the source continued (cut), and another secret is cut at the very end.
        const text = 'a'.repeat(1000 - off) + enc + 'b'.repeat(300) + enc.slice(0, 20);
        const out = redactCapped(r, text, 1000, true, 400);
        expect(out.text.length).toBeLessThanOrEqual(1000);
        expect(leaks(out.text), `${name} @${off}`).toEqual([]);
      }
    });
  }

  it('cut source shorter than the lookahead keeps nothing; no safe point withholds the output', () => {
    expect(redactCapped(r, 'short text', 1000, true, 400)).toEqual({ text: '', truncated: true });
    // A long run of back-to-back secrets leaves no consistent cut point near the cap.
    const dense = ENCODINGS.hex.repeat(600);
    const out = redactCapped(r, dense, 30_000, true, 100);
    expect(leaks(out.text)).toEqual([]);
    expect(out.text === OUTPUT_WITHHELD || /^(\[REDACTED:secret:[0-9a-f]{8}\])*$/.test(out.text)).toBe(true);
  });
});

describe('CappedStream', () => {
  it('reports the first overflow once, keeps limit + lookahead, and renders redacted, bounded text', () => {
    const s = new CappedStream(100, 50);
    expect(s.push(Buffer.from('x'.repeat(90)))).toBe(false);
    expect(s.push(Buffer.from('y'.repeat(20)))).toBe(true);
    expect(s.push(Buffer.from('z'.repeat(500)))).toBe(false);
    expect(s.overflowed).toBe(true);
    expect(s.cut).toBe(true);
    expect(s.seen).toBe(610);
    const out = s.render(r);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(100);
  });

  it('a secret split across two chunks right at the cap is still redacted whole', () => {
    const s = new CappedStream(1000);
    const enc = ENCODINGS.base64;
    s.push(Buffer.from('a'.repeat(990) + enc.slice(0, 12)));
    s.push(Buffer.from(enc.slice(12) + 'b'.repeat(100)));
    const out = s.render(r);
    expect(leaks(out.text)).toEqual([]);
  });
});

describe('interrupted sources (sprint-3 finding 2): the producer was killed mid-secret', () => {
  it("Codex's probe: 980 ordinary chars + 30 base64-secret chars at a 1000-byte cap, the rest never arrives: no fragment", () => {
    const s = new CappedStream(1000);
    expect(s.push(Buffer.from('a'.repeat(980) + ENCODINGS.base64.slice(0, 30)))).toBe(true); // overflow -> the runner kills
    s.interrupt(); // the second chunk never arrives
    const out = s.render(r);
    expect(leaks(out.text)).toEqual([]);
    expect(out.truncated).toBe(true);
    // Before this fix (not interrupted): the same capture leaks.
    const naive = new CappedStream(1000);
    naive.push(Buffer.from('a'.repeat(980) + ENCODINGS.base64.slice(0, 30)));
    expect(leaks(naive.render(r).text).length).toBeGreaterThan(0);
  });

  for (const [name, enc] of Object.entries(ENCODINGS)) {
    it(`${name}: every interruption point inside the secret, under and over the cap, leaves no fragment`, () => {
      for (let k = 8; k < enc.length; k += 3) {
        for (const lead of ['line one\nline two\n' + 'x'.repeat(200) + ' token=', 'z'.repeat(990)]) {
          const text = lead + enc.slice(0, k);
          const out = redactCapped(r, text, 1000, { interrupted: true });
          expect(leaks(out.text), `${name} k=${k} lead=${lead.length}`).toEqual([]);
          expect(out.text.length).toBeLessThanOrEqual(1000);
        }
      }
    });
  }

  it('the suppressed region is only the trailing token: earlier complete lines survive, with a marker', () => {
    const text = 'PASS a\nPASS b\nprinting key: ' + ENCODINGS.hex.slice(0, 21);
    const out = redactCapped(r, text, 1000, { interrupted: true });
    expect(out.text).toBe('PASS a\nPASS b\nprinting key: ' + INTERRUPTED_MARKER);
    expect(out.suppressed).toBe(true);
    expect(trailingTokenStart('ab cd')).toBe(3);
    expect(trailingTokenStart('ab cd\n')).toBe(6);
  });

  it('an interrupted stream that ended on whitespace keeps everything (nothing uncertain)', () => {
    const out = redactCapped(r, 'all done\n', 1000, { interrupted: true });
    expect(out).toEqual({ text: 'all done\n', truncated: false });
  });

  it('a complete secret before the interruption is redacted; the partial one after it is suppressed', () => {
    const text = `first ${ENCODINGS.base64} then ${ENCODINGS.pct.slice(0, 40)}`;
    const out = redactCapped(r, text, 1000, { interrupted: true });
    expect(out.text).toMatch(/^first \[REDACTED:secret:[0-9a-f]{8}\] then /);
    expect(leaks(out.text)).toEqual([]);
  });

  it('interrupted + cut: both bounds apply', () => {
    const text = 'q'.repeat(3000) + ' ' + ENCODINGS.base64.slice(0, 25);
    const out = redactCapped(r, text, 1000, { cut: true, interrupted: true, lookahead: 400 });
    expect(out.text.length).toBeLessThanOrEqual(1000);
    expect(leaks(out.text)).toEqual([]);
  });
});
