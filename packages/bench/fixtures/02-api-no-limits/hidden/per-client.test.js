import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('each client ip has its own limit', () => {
  const app = createApp({ now: () => 0, rateLimit: { limit: 1, windowMs: 1000 } });
  assert.equal(app({ ip: 'a', path: '/items' }).status, 200);
  assert.equal(app({ ip: 'a', path: '/items' }).status, 429);
  assert.equal(app({ ip: 'b', path: '/items' }).status, 200);
});
