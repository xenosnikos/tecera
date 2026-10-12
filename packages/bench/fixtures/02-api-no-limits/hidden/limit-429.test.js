import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('the request past the limit is refused with 429', () => {
  const app = createApp({ now: () => 0, rateLimit: { limit: 2, windowMs: 1000 } });
  assert.equal(app({ ip: 'a', path: '/items' }).status, 200);
  assert.equal(app({ ip: 'a', path: '/items' }).status, 200);
  assert.equal(app({ ip: 'a', path: '/items' }).status, 429);
});
