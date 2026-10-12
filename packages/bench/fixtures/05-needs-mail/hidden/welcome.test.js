import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signup } from '../src/signup.js';

test('signing up sends one welcome email to the new user', async () => {
  const sent = [];
  await signup({ email: 'ada@example.com', name: 'Ada' }, { mailer: { send: async (m) => void sent.push(m) } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ada@example.com');
  assert.match(sent[0].subject, /welcome/i);
});
