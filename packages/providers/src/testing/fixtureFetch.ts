import { readFileSync } from 'node:fs';
import type { FetchLike } from '../http.js';
import { ANTHROPIC_FIXTURES } from './fixtures/anthropic.js';
import { OPENAI_FIXTURES } from './fixtures/openai.js';
import { OPENROUTER_FIXTURES } from './fixtures/openrouter.js';

/**
 * Offline fetch double. Serves hand-written provider responses (the compiled-in tables in
 * ./fixtures/<provider>.ts, or `<dir>/<provider>.json` when a dir is given) in the order they were scripted (`'anthropic/ok'`, `'openai/429'`, or an inline FixtureSpec). Every
 * call is recorded with its parsed body and its exact body text; auth header VALUES are never recorded (replaced by
 * '<present>'). `{{AUTH}}` inside a fixture body is replaced by the request's auth header value, to
 * simulate a provider that echoes the credential back in an error. `delayMs` fixtures honour the
 * request's AbortSignal. Running past the script returns HTTP 418 (non-retryable).
 */

export interface FixtureSpec {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyText?: string;
  delayMs?: number;
}

export interface FixtureCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** The exact request body text as sent (when it was a string). */
  bodyText?: string;
  fixture: string;
}

const AUTH_HEADERS = new Set(['authorization', 'x-api-key']);

const BUILTIN: Readonly<Record<string, Readonly<Record<string, FixtureSpec>>>> = { anthropic: ANTHROPIC_FIXTURES, openai: OPENAI_FIXTURES, openrouter: OPENROUTER_FIXTURES };

/** Names of every bundled fixture, as `<provider>/<case>`. */
export function fixtureNames(): string[] {
  return Object.entries(BUILTIN).flatMap(([p, t]) => Object.keys(t).map((k) => `${p}/${k}`));
}

const cache = new Map<string, Record<string, FixtureSpec>>();

/** A copy of one fixture: bundled by default, or read from `<dir>/<provider>.json`. */
export function loadFixture(name: string, dir?: string): FixtureSpec {
  const slash = name.indexOf('/');
  if (slash <= 0) throw new Error(`FixtureFetch: fixture name must be "<provider>/<case>", got "${name}"`);
  const file = name.slice(0, slash);
  const key = name.slice(slash + 1);
  let table: Readonly<Record<string, FixtureSpec>> | undefined;
  if (dir === undefined) {
    table = BUILTIN[file];
    if (!table) throw new Error(`FixtureFetch: no bundled fixtures for "${file}"`);
  } else {
    const path = `${dir.replace(/\/+$/, '')}/${file}.json`;
    let t = cache.get(path);
    if (!t) {
      t = JSON.parse(readFileSync(path, 'utf8')) as Record<string, FixtureSpec>;
      cache.set(path, t);
    }
    table = t;
  }
  const spec = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  if (!spec) throw new Error(`FixtureFetch: no fixture "${key}" for ${file}`);
  return structuredClone(spec);
}

function headerRecord(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const entries: Array<[string, string]> = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? (h as Array<[string, string]>) : Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = v;
  return out;
}

export class FixtureFetch {
  readonly calls: FixtureCall[] = [];
  readonly #queue: Array<string | FixtureSpec>;
  readonly #dir: string | undefined;

  constructor(script: Array<string | FixtureSpec> = [], opts: { dir?: string } = {}) {
    this.#queue = [...script];
    this.#dir = opts.dir;
  }

  push(...items: Array<string | FixtureSpec>): this {
    this.#queue.push(...items);
    return this;
  }

  get remaining(): number {
    return this.#queue.length;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const headers = headerRecord(init.headers);
    const authValue = headers['x-api-key'] ?? headers['authorization'] ?? '';
    const recorded: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) recorded[k] = AUTH_HEADERS.has(k) ? '<present>' : v;
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const next = this.#queue.shift();
    const name = next === undefined ? '<exhausted>' : typeof next === 'string' ? next : '<inline>';
    this.calls.push({ url: String(input), method: init.method ?? 'GET', headers: recorded, body, ...(typeof init.body === 'string' ? { bodyText: init.body } : {}), fixture: name });
    const spec: FixtureSpec =
      next === undefined
        ? { status: 418, body: { error: { message: 'FixtureFetch script exhausted' } } }
        : typeof next === 'string'
          ? loadFixture(next, this.#dir)
          : next;
    if (spec.delayMs) await delay(spec.delayMs, init.signal ?? undefined);
    else if (init.signal?.aborted) throw abortError();
    let text = spec.bodyText ?? JSON.stringify(spec.body ?? null);
    if (text.includes('{{AUTH}}')) text = text.split('{{AUTH}}').join(authValue);
    return new Response(text, { status: spec.status, headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) } });
  };
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
