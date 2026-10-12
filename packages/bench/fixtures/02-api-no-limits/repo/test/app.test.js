import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const app = createApp();

test('health answers 200', () => assert.equal(app({ ip: 'a', path: '/health' }).status, 200));
test('items are listed', () => assert.deepEqual(app({ ip: 'a', path: '/items' }).body, { items: ['apple', 'pear'] }));
test('unknown routes are 404', () => assert.equal(app({ ip: 'a', path: '/nope' }).status, 404));
