import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../src/sessions.js';
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'bench-sessions-')), 'sessions.db');

test('a deleted session stays deleted after a restart', () => {
  const path = dbPath();
  const a = createSessionStore({ path });
  a.set('s1', { user: 'ada' });
  a.set('s2', { user: 'bob' });
  a.delete('s1');
  a.close();
  const b = createSessionStore({ path });
  assert.equal(b.get('s1'), undefined);
  assert.deepEqual(b.get('s2'), { user: 'bob' });
  b.close();
});
