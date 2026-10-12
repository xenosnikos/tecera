import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('the limit is configurable', () => {
  const app = createApp({ now: () => 0, rateLimit: { limit: 3, windowMs: 60000 } });
  for (let i = 0; i < 3; i++) assert.equal(app({ ip: 'a', path: '/health' }).status, 200);
  assert.equal(app({ ip: 'a', path: '/health' }).status, 429);
});
