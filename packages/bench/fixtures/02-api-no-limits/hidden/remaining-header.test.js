import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
const header = (res, name) => Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

test('responses say how many requests remain', () => {
  const app = createApp({ now: () => 0, rateLimit: { limit: 2, windowMs: 1000 } });
  assert.equal(header(app({ ip: 'a', path: '/items' }), 'X-RateLimit-Remaining'), '1');
  assert.equal(header(app({ ip: 'a', path: '/items' }), 'X-RateLimit-Remaining'), '0');
});
