import type { LLM, LLMRequest, LLMResponse } from '@tecera/contracts';

/**
 * Scripted LLM double. Answers from a queue of canned responses (LLMResponse or plain string, which
 * becomes a zero-cost 'stop'), records a deep copy of every request, and can check each request with
 * a global matcher or a per-item matcher. Like the real providers it never throws: a mismatch, a
 * throwing matcher or responder, an exhausted script or an aborted signal is a finishReason 'error'
 * response with `error` set. It does NOT sanitize: it is a test double, not a provider. It declares no
 * keyFingerprint unless given one, so foreignCheck treats it as not foreign by default.
 */

export type ScriptResponse = LLMResponse | string;
export type Matcher = (req: LLMRequest, index: number) => boolean | string;
export type ScriptItem = ScriptResponse | { match: Matcher; respond: ScriptResponse | ((req: LLMRequest) => ScriptResponse) } | ((req: LLMRequest) => ScriptResponse);

export interface ScriptedLLMOptions {
  id?: string;
  provider?: string;
  model?: string;
  /** Credential fingerprint to declare (foreignCheck fails closed without one). */
  keyFingerprint?: string;
  script?: ScriptItem[];
  match?: Matcher;
  /** Default usage for string responses. */
  usage?: LLMResponse['usage'];
}

function isLLMResponse(x: unknown): x is LLMResponse {
  return !!x && typeof x === 'object' && 'content' in x && 'finishReason' in x;
}

export class ScriptedLLM implements LLM {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly keyFingerprint?: string;
  readonly requests: LLMRequest[] = [];
  readonly #queue: ScriptItem[];
  readonly #match: Matcher | undefined;
  readonly #usage: LLMResponse['usage'];

  constructor(opts: ScriptedLLMOptions | ScriptItem[] = {}) {
    const o: ScriptedLLMOptions = Array.isArray(opts) ? { script: opts } : opts;
    this.provider = o.provider ?? 'scripted';
    this.model = o.model ?? 'scripted-model';
    this.id = o.id ?? `${this.provider}/${this.model}`;
    if (o.keyFingerprint !== undefined) this.keyFingerprint = o.keyFingerprint;
    this.#queue = [...(o.script ?? [])];
    this.#match = o.match;
    this.#usage = o.usage ?? { inputTokens: 0, outputTokens: 0, usd: 0 };
  }

  push(...items: ScriptItem[]): this {
    this.#queue.push(...items);
    return this;
  }

  get remaining(): number {
    return this.#queue.length;
  }

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const index = this.requests.length;
    const model = (req && typeof req.model === 'string' && req.model) || this.model;
    const err = (m: string): LLMResponse => ({ content: m, usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, model, finishReason: 'error', error: m, raw: { error: m } });
    try {
      this.requests.push(structuredClone(req));
    } catch {
      return err(`scripted: request ${index} is not cloneable`);
    }
    if (signal?.aborted) return err('scripted: aborted');
    if (this.#match) {
      let ok: boolean | string;
      try {
        ok = this.#match(req, index);
      } catch (e) {
        return err(`scripted: matcher threw at request ${index} (${e instanceof Error ? e.name : 'unknown'})`);
      }
      if (ok !== true) return err(`scripted: request ${index} rejected by matcher${typeof ok === 'string' ? `: ${ok}` : ''}`);
    }
    const item = this.#queue.shift();
    if (item === undefined) return err(`scripted: script exhausted at request ${index}`);
    let r: ScriptResponse;
    try {
      if (typeof item === 'function') r = item(req);
      else if (typeof item === 'object' && !isLLMResponse(item) && 'match' in item) {
        const ok = item.match(req, index);
        if (ok !== true) return err(`scripted: request ${index} rejected by item matcher${typeof ok === 'string' ? `: ${ok}` : ''}`);
        r = typeof item.respond === 'function' ? item.respond(req) : item.respond;
      } else r = item;
    } catch (e) {
      return err(`scripted: responder threw (${e instanceof Error ? e.name : 'unknown'})`);
    }
    return typeof r === 'string' ? { content: r, usage: { ...this.#usage }, model, finishReason: 'stop' } : structuredClone(r);
  }
}
