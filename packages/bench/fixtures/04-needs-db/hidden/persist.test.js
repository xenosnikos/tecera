import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../src/sessions.js';
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'bench-sessions-')), 'sessions.db');

test('sessions survive a restart', () => {
  const path = dbPath();
  const a = createSessionStore({ path });
  a.set('s1', { user: 'ada', roles: ['admin'] });
  a.close();
  const b = createSessionStore({ path });
  assert.deepEqual(b.get('s1'), { user: 'ada', roles: ['admin'] });
  b.close();
});
