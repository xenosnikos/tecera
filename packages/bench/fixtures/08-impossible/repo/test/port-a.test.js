import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the platform routes traffic to port 8080', () => {
  const config = JSON.parse(readFileSync(new URL('../src/config.json', import.meta.url), 'utf8'));
  assert.equal(config.port, 8080);
});
