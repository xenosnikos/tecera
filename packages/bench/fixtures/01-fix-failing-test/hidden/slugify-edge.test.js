import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('one dash between words, however many separators', () => {
  assert.equal(slugify('x  y'), 'x-y');
  assert.equal(slugify('A_B c'), 'a-b-c');
  assert.equal(slugify('--a--'), 'a');
});
