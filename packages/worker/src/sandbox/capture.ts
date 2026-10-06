import type { Redactor } from '@tecera/contracts';

/**
 * Redaction-safe output caps (Codex sprint-2 sandbox finding 5). A cap that cuts raw output BEFORE the
 * redactor sees it can leave a fragment of a secret (or of its base64/hex/percent encoding) that no
 * needle matches. The rules here:
 *
 *  - Capture keeps up to `limit + lookahead` bytes, so a secret that straddles the cap is still seen whole
 *    by the redactor (secrets whose longest encoded form exceeds `lookahead` are out of scope).
 *  - The kept text is cut AFTER redaction. When the source itself was cut (more arrived than was kept),
 *    the last `lookahead` characters are uncertain: the kept prefix ends at least that far before the end,
 *    and only at a point where redacting the prefix alone agrees with redacting the whole capture (so no
 *    secret straddles the cut). If no such point is found, the output is withheld.
 *  - Interrupted sources (Codex sprint-3 sandbox finding 2): when the producer was killed or stopped (output
 *    cap, timeout, cancel, stragglers killed, pipes that never closed), the received bytes may END inside a
 *    secret whose remainder never arrived, even though nothing was discarded. A partial encoding matches no
 *    needle, so the redactor cannot see it. The trailing token (the maximal run of non-whitespace characters
 *    touching the end of what was received; every encoded form the redactor knows is whitespace-free) is
 *    therefore uncertain (only its last `lookahead` characters, the documented secret-length scope) and is
 *    suppressed, and the kept prefix again ends only at a redaction-consistent point. A short marker says the tail was suppressed when it fits under the cap.
 */

export const REDACT_LOOKAHEAD_CHARS = 8192;
const STEP = 256;
const MAX_STEPS = 48;
export const OUTPUT_WITHHELD = '[output withheld: no redaction-safe cut point]';
export const INTERRUPTED_MARKER = '[output interrupted: trailing fragment suppressed]';

/** Start index of the trailing token of `text` (maximal run of non-whitespace chars at its end). */
export function trailingTokenStart(text: string): number {
  let i = text.length;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

export interface RedactCappedOptions {
  /** The source was cut at its end: more arrived than was kept (its last `lookahead` chars are uncertain). */
  cut?: boolean;
  /** The producer was interrupted (killed/stopped): its trailing token may be a partial secret encoding. */
  interrupted?: boolean;
  lookahead?: number;
}

/**
 * Redact `text`, then bound it to `maxChars`. `cut`: the source was cut at its end (its tail is uncertain);
 * or pass options `{cut, interrupted, lookahead}`.
 */
export function redactCapped(
  redactor: Redactor,
  text: string,
  maxChars: number,
  cut: boolean | RedactCappedOptions,
  lookaheadArg = REDACT_LOOKAHEAD_CHARS,
): { text: string; truncated: boolean; suppressed?: boolean } {
  const o: RedactCappedOptions = typeof cut === 'object' && cut !== null ? cut : { cut: cut === true };
  const lookahead = o.lookahead ?? lookaheadArg;
  const full = redactor.redactText(text);
  if (!o.cut && !o.interrupted) {
    if (full.length <= maxChars) return { text: full, truncated: false };
    return { text: full.slice(0, Math.max(0, maxChars)), truncated: true };
  }
  // Raw-coordinate bound past which nothing is certain.
  let bound = text.length;
  if (o.cut) {
    if (text.length <= lookahead) return { text: '', truncated: true };
    bound = text.length - lookahead;
  }
  let suppressed = false;
  if (o.interrupted) {
    // A partial secret at the end is whitespace-free and shorter than the lookahead (the documented scope).
    const t = Math.max(trailingTokenStart(text), text.length - lookahead);
    if (t < bound) {
      bound = t;
      suppressed = t < text.length;
    }
  }
  let c = Math.min(maxChars, bound);
  for (let i = 0; i < MAX_STEPS && c >= 0; i++, c -= STEP) {
    const prefix = redactor.redactText(text.slice(0, c));
    if (full.startsWith(prefix)) {
      const truncated = o.cut === true || c < text.length;
      const body = prefix.slice(0, Math.max(0, maxChars));
      if (suppressed && body.length + INTERRUPTED_MARKER.length <= maxChars) return { text: body + INTERRUPTED_MARKER, truncated, suppressed };
      return { text: body, truncated, ...(suppressed ? { suppressed } : {}) };
    }
  }
  if (c < 0) return { text: '', truncated: true, ...(suppressed ? { suppressed } : {}) };
  return { text: OUTPUT_WITHHELD, truncated: true, ...(suppressed ? { suppressed } : {}) };
}

/** A byte-capped stream buffer that keeps `limit + lookahead` bytes and reports when `limit` is exceeded. */
export class CappedStream {
  private parts: Buffer[] = [];
  private stored = 0;
  private interrupted = false;
  /** Total bytes offered. */
  seen = 0;
  constructor(
    readonly limit: number,
    private readonly lookahead = REDACT_LOOKAHEAD_CHARS,
  ) {}
  /** Append; returns true the first time the stream goes over `limit`. */
  push(c: Buffer): boolean {
    const wasOver = this.seen > this.limit;
    this.seen += c.length;
    const room = this.limit + this.lookahead - this.stored;
    if (room > 0) {
      const take = c.length > room ? c.subarray(0, room) : c;
      this.parts.push(take);
      this.stored += take.length;
    }
    return !wasOver && this.seen > this.limit;
  }
  get overflowed(): boolean {
    return this.seen > this.limit;
  }
  /** More arrived than was kept. */
  get cut(): boolean {
    return this.seen > this.stored;
  }
  /** The producer was killed or stopped: whatever it was writing may have been cut off mid-token. */
  interrupt(): void {
    this.interrupted = true;
  }
  /** Redacted text bounded to `limit` characters. */
  render(redactor: Redactor): { text: string; truncated: boolean; suppressed?: boolean } {
    const raw = Buffer.concat(this.parts).toString('utf8');
    const r = redactCapped(redactor, raw, this.limit, { cut: this.cut, interrupted: this.interrupted, lookahead: this.lookahead });
    return { text: r.text, truncated: r.truncated || this.overflowed, ...(r.suppressed ? { suppressed: true } : {}) };
  }
}
