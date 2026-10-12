import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';

test('greets by name', () => assert.ok(greet('Ada').startsWith('Hello, Ada'), greet('Ada')));
