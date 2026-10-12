import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';

test('greets exactly, with an exclamation mark', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
test('refuses an empty name', () => assert.throws(() => greet('')));
