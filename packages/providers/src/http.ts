/**
 * One JSON POST with bounded retries. Retries only 408/409/429/5xx, timeouts and network failures,
 * at most `maxRetries` times, with exponential backoff, full jitter in [0.5, 1) of the step, a cap,
 * and `retry-after` honoured up to the cap. The caller's AbortSignal aborts the in-flight request and
 * any backoff sleep immediately. Never throws: every outcome is an HttpResult. Messages produced here
 * never include request headers; callers still scrub them before they leave the provider.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * `uncertain` counts the attempts that may have been processed (and billed) without the caller learning
 * their usage: a timeout, a network failure or an abort after the request was dispatched, or a 2xx
 * response whose body could not be read or parsed. Providers charge each one at a conservative bound.
 */
export type HttpResult =
  | { kind: 'ok'; status: number; json: unknown; attempts: number; uncertain: number }
  | { kind: 'error'; status?: number; message: string; attempts: number; aborted: boolean; body?: unknown; uncertain: number };

export const DEFAULT_RETRY: RetryOptions = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 20_000, timeoutMs: 300_000 };

/** Sleep that resolves early (never rejects) when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function backoffDelay(attempt: number, o: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>, random: () => number, retryAfterMs?: number): number {
  const step = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
  const jittered = step * (0.5 + random() / 2);
  const d = retryAfterMs !== undefined ? Math.max(jittered, retryAfterMs) : jittered;
  return Math.max(0, Math.min(o.maxDelayMs, Math.round(d)));
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Best-effort provider error message from an error body: `{error:{message}}` or `{error:"..."}` or `{message}`. */
export function providerMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const e = b['error'];
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as Record<string, unknown>)['message'] === 'string') return (e as Record<string, string>)['message'];
  if (typeof b['message'] === 'string') return b['message'] as string;
  return undefined;
}

const RETRYABLE = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500;

/** JSON.stringify(body), then postPayload. Providers use postPayload with their scanned bytes instead. */
export async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: RetryOptions,
  signal?: AbortSignal,
): Promise<HttpResult> {
  return postPayload(fetchFn, url, headers, JSON.stringify(body), opts, signal);
}

/** POST an exact, already-serialized JSON payload (sent byte-for-byte as given, on every attempt). */
export async function postPayload(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  payload: string,
  opts: RetryOptions,
  signal?: AbortSignal,
): Promise<HttpResult> {
  if (typeof payload !== 'string') return { kind: 'error', message: 'request payload is not a string', attempts: 0, aborted: false, uncertain: 0 };
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  let attempts = 0;
  let uncertain = 0;
  let last: HttpResult = { kind: 'error', message: 'no attempt made', attempts: 0, aborted: false, uncertain: 0 };

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (signal?.aborted) return { kind: 'error', message: 'aborted', attempts, aborted: true, uncertain };
    attempts++;
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, opts.timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let delayHint: number | undefined;
    let retry = false;
    let status: number | undefined;
    try {
      const res = await fetchFn(url, { method: 'POST', headers, body: payload, signal: ctl.signal });
      status = res.status;
      const text = await res.text();
      let json: unknown;
      let parsed = true;
      try {
        json = text.length ? JSON.parse(text) : undefined;
      } catch {
        parsed = false;
      }
      if (res.ok) {
        if (!parsed || json === undefined) return { kind: 'error', status: res.status, message: `malformed JSON in provider response (HTTP ${res.status})`, attempts, aborted: false, uncertain: uncertain + 1 };
        return { kind: 'ok', status: res.status, json, attempts, uncertain };
      }
      const pm = parsed ? providerMessage(json) : undefined;
      last = {
        kind: 'error',
        status: res.status,
        message: `HTTP ${res.status}${pm ? `: ${pm}` : parsed ? '' : ' (non-JSON body)'}`,
        attempts,
        aborted: false,
        uncertain,
        ...(parsed && json !== undefined ? { body: json } : {}),
      };
      retry = RETRYABLE(res.status);
      if (retry) delayHint = retryAfter(res);
    } catch (err) {
      // The request was dispatched (or may have been): it may be processed and billed. A non-2xx status
      // whose body could not be read is not billed; anything else is uncertain.
      if (status === undefined || (status >= 200 && status < 300)) uncertain++;
      if (signal?.aborted) return { kind: 'error', message: 'aborted', attempts, aborted: true, uncertain };
      const name = err instanceof Error ? err.name : 'Error';
      last = { kind: 'error', message: timedOut ? `request timed out after ${opts.timeoutMs}ms` : `network error (${name})`, attempts, aborted: false, uncertain };
      retry = true;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (!retry || attempt === opts.maxRetries) break;
    await sleep(backoffDelay(attempt, opts, random, delayHint), signal);
  }
  if (last.kind === 'error' && last.attempts > 1) last = { ...last, message: `${last.message} (gave up after ${last.attempts} attempts)` };
  return { ...last, uncertain };
}
