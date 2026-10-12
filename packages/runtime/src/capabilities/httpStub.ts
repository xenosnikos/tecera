/**
 * The loopback HTTP stub a `http-stub` resource runs: a node script written into the resource directory and
 * started detached, so it outlives the provisioning call and is stopped by the recorded teardown.
 *
 * - Listens on 127.0.0.1 only, on a port the kernel picks; writes it to `stub.port` once listening.
 * - Answers from `stub.json` (re-read per request, so a test or a step can change the responses):
 *   `{ routes: [{ method?, path, status?, headers?, body? }], fallback?: {...} }`; no route: 404.
 * - Records every request to `requests.jsonl` (mode 0600; method, path, query, headers, body up to 64 KiB).
 *   Credential-named headers and query parameters (authorization, cookie, anything naming a token, key,
 *   secret, password, session or signature) are recorded as withheld, never by value. Bodies are recorded as
 *   sent: they are what a criterion checks. The log is capped.
 * - Exits on SIGTERM and, at the latest, at the resource's expiry, so a stub nobody released cannot outlive
 *   its lifetime.
 */

export interface StubRoute {
  method?: string;
  path: string;
  status?: number;
  headers?: Record<string, string>;
  /** A string is sent as text/plain; anything else as JSON. */
  body?: unknown;
}

export interface HttpStubConfig {
  routes: StubRoute[];
  fallback?: Omit<StubRoute, 'path' | 'method'>;
}

/** One recorded request (a line of requests.jsonl). */
export interface StubRequest {
  at: number;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[]>;
  body: string;
  bodyTruncated: boolean;
}

export const STUB_SCRIPT = 'stub.cjs';
export const STUB_CONFIG = 'stub.json';
export const STUB_PORT = 'stub.port';
export const STUB_PID = 'stub.pid';
export const STUB_REQUESTS = 'requests.jsonl';

export const STUB_SOURCE = `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const expiresAt = Number(process.argv[3]);
const MAX_BODY = 65536;
const MAX_LOG = 4 * 1024 * 1024;
const WITHHELD = /auth|cookie|token|secret|passw|key|session|signature|sig$|credential/i;
function query(url) {
  if (![...url.searchParams.keys()].some((k) => WITHHELD.test(k))) return url.search;
  const parts = [];
  for (const [k, v] of url.searchParams) parts.push(encodeURIComponent(k) + '=' + (WITHHELD.test(k) ? '[withheld]' : encodeURIComponent(v)));
  return '?' + parts.join('&');
}
function config() {
  try { return JSON.parse(fs.readFileSync(path.join(dir, ${JSON.stringify(STUB_CONFIG)}), 'utf8')); } catch { return { routes: [] }; }
}
const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://stub.invalid');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = WITHHELD.test(k) ? '[withheld]' : v;
    const line = JSON.stringify({ at: Date.now(), method: req.method, path: url.pathname, query: query(url), headers, body: Buffer.concat(chunks).toString('utf8'), bodyTruncated: size > MAX_BODY }) + '\\n';
    try {
      const log = path.join(dir, ${JSON.stringify(STUB_REQUESTS)});
      if (!fs.existsSync(log) || fs.statSync(log).size < MAX_LOG) fs.appendFileSync(log, line, { mode: 0o600 });
    } catch {}
    const c = config();
    const route = (Array.isArray(c.routes) ? c.routes : []).find((r) => r && (!r.method || String(r.method).toUpperCase() === req.method) && r.path === url.pathname);
    const reply = route || c.fallback || { status: 404, body: { error: 'no stub route' } };
    const text = typeof reply.body === 'string';
    res.writeHead(reply.status || 200, { 'content-type': text ? 'text/plain' : 'application/json', ...(reply.headers || {}) });
    res.end(text ? reply.body : JSON.stringify(reply.body === undefined ? null : reply.body));
  });
});
server.listen(0, '127.0.0.1', () => {
  const tmp = path.join(dir, ${JSON.stringify(STUB_PORT)} + '.tmp');
  fs.writeFileSync(tmp, String(server.address().port));
  fs.renameSync(tmp, path.join(dir, ${JSON.stringify(STUB_PORT)}));
});
const left = Number.isFinite(expiresAt) ? expiresAt - Date.now() : 0;
setTimeout(() => process.exit(0), Math.max(0, Math.min(left, 2147483647)));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
