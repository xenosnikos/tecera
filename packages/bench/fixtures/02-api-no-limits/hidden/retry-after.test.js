import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
const header = (res, name) => Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

test('a refused request says when to retry', () => {
  const app = createApp({ now: () => 0, rateLimit: { limit: 1, windowMs: 1000 } });
  app({ ip: 'a', path: '/items' });
  const res = app({ ip: 'a', path: '/items' });
  assert.equal(res.status, 429);
  const s = Number(header(res, 'Retry-After'));
  assert.ok(Number.isInteger(s) && s >= 1 && s <= 1, `Retry-After ${header(res, 'Retry-After')}`);
});
