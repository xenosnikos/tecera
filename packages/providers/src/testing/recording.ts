import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLM, LLMRequest, LLMResponse } from '@tecera/contracts';
import { sanitizeDecodedJson, scanBudget, scanDecoded } from '../decode.js';
import type { Redactor } from '../redact.js';

/**
 * Wraps an LLM and writes one JSON transcript per call (`<seq>-<seatId>.json` under `dir`) holding
 * the request, the response and the latency. Redaction runs on the DECODED transcript (every string
 * and key, via the shared contracts redactor) before serialization, so a secret containing JSON
 * metacharacters cannot survive as its escaped form; then any string whose DECODED views (escape sequences,
 * entities, base64/hex/percent encodings) still carry a secret is withheld. The serialized bytes are then
 * scanned once more, raw and decoded;
 * on any hit, or if redaction fails, nothing is written and onError is told why (without the value).
 * A failed write never fails the call. The response is passed through unchanged (real providers
 * sanitize their own output). `provider`, `model` and `keyFingerprint` are forwarded so foreignCheck
 * sees through the wrapper.
 */

export interface RecordingOptions {
  dir: string;
  /** A SecretStore (anything with a `redactor`) or a contracts Redactor. */
  redact: Redactor | { redactor: Redactor };
  now?: () => number;
  onError?: (message: string) => void;
}

function asRedactor(r: RecordingOptions['redact']): Redactor {
  if (r && typeof (r as Redactor).redactJson === 'function' && typeof (r as Redactor).containsSecret === 'function') return r as Redactor;
  const inner = (r as { redactor?: Redactor })?.redactor;
  if (inner && typeof inner.redactJson === 'function' && typeof inner.containsSecret === 'function') return inner;
  throw new TypeError('RecordingLLM needs a SecretStore or a Redactor');
}

export class RecordingLLM implements LLM {
  readonly id: string;
  readonly provider: string;
  readonly #inner: LLM;
  readonly #o: RecordingOptions;
  readonly #redactor: Redactor;
  #seq = 0;

  constructor(inner: LLM, opts: RecordingOptions) {
    this.#inner = inner;
    this.#o = opts;
    this.id = inner.id;
    this.provider = inner.provider;
    this.#redactor = asRedactor(opts.redact);
  }

  get model(): string | undefined {
    return this.#inner.model;
  }

  get keyFingerprint(): string | undefined {
    return this.#inner.keyFingerprint;
  }

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const now = this.#o.now ?? Date.now;
    const seq = ++this.#seq;
    const t0 = now();
    const res = await this.#inner.complete(req, signal);
    const t1 = now();
    try {
      const check = (t: string) => this.#redactor.containsSecret(t);
      const redacted = this.#redactor.redactJson({ seq, llm: { id: this.id, provider: this.provider }, startedAt: t0, latencyMs: t1 - t0, request: req, response: res });
      const doc = sanitizeDecodedJson(redacted, check, scanBudget(0));
      const text = JSON.stringify(doc, null, 2);
      const hit = this.#redactor.containsSecret(text) ?? scanDecoded(text, check, scanBudget(text.length));
      if (hit !== null) {
        this.#o.onError?.(`recording withheld: transcript still contains a secret (${hit})`);
        return res;
      }
      mkdirSync(this.#o.dir, { recursive: true });
      const redactedSeat = (doc as { request?: { seatId?: unknown } } | null)?.request?.seatId;
      const safeSeat = String(typeof redactedSeat === 'string' ? redactedSeat : 'seat').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
      writeFileSync(join(this.#o.dir, `${String(seq).padStart(4, '0')}-${safeSeat}.json`), text + '\n', { mode: 0o600 });
    } catch (e) {
      try {
        this.#o.onError?.(`recording failed (${e instanceof Error ? e.name : 'unknown'})`);
      } catch {
        /* ignore */
      }
    }
    return res;
  }
}
