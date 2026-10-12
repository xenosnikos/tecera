import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the dev proxy expects port 3000', () => {
  const config = JSON.parse(readFileSync(new URL('../src/config.json', import.meta.url), 'utf8'));
  assert.equal(config.port, 3000);
});
