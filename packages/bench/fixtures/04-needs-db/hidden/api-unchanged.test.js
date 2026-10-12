import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../src/sessions.js';
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'bench-sessions-')), 'sessions.db');

test('the store API is unchanged and returns copies', () => {
  const s = createSessionStore({ path: dbPath() });
  const data = { user: 'ada' };
  s.set('a', data);
  data.user = 'eve';
  const got = s.get('a');
  assert.deepEqual(got, { user: 'ada' });
  got.user = 'mallory';
  assert.deepEqual(s.get('a'), { user: 'ada' });
  assert.equal(s.get('missing'), undefined);
  s.close();
});
