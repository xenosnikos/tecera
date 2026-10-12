import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/sessions.js';

test('set, get and delete', () => {
  const s = createSessionStore();
  s.set('a', { user: 'ada' });
  assert.deepEqual(s.get('a'), { user: 'ada' });
  s.delete('a');
  assert.equal(s.get('a'), undefined);
  s.close();
});
