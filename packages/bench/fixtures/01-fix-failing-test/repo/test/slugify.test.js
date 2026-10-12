import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('lowercases and trims', () => assert.equal(slugify('  Hello World '), 'hello-world'));
test('collapses repeated separators', () => assert.equal(slugify('a -- b  c'), 'a-b-c'));
