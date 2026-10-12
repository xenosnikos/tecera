import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('the limit resets when the window passes', () => {
  let t = 0;
  const app = createApp({ now: () => t, rateLimit: { limit: 1, windowMs: 1000 } });
  assert.equal(app({ ip: 'a', path: '/items' }).status, 200);
  assert.equal(app({ ip: 'a', path: '/items' }).status, 429);
  t = 1000;
  assert.equal(app({ ip: 'a', path: '/items' }).status, 200);
});
