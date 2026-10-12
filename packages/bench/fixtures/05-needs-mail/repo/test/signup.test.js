import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signup } from '../src/signup.js';

test('an invalid email is refused', async () => {
  await assert.rejects(signup({ email: 'nope' }), /valid email/);
});
test('a user is registered', async () => {
  const r = await signup({ email: 'ada@example.com', name: 'Ada' });
  assert.equal(r.email, 'ada@example.com');
});
