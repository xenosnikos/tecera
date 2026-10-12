import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signup } from '../src/signup.js';

test('an invalid email sends nothing and is refused', async () => {
  const sent = [];
  await assert.rejects(signup({ email: 'nope' }, { mailer: { send: async (m) => void sent.push(m) } }));
  assert.equal(sent.length, 0);
});
