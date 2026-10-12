import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill } from '../src/split.js';

test('no cent is lost', () => assert.equal(splitBill(1000, 3).reduce((a, b) => a + b, 0), 1000));
test('earlier people pay the extra cent', () => assert.deepEqual(splitBill(1000, 3), [334, 333, 333]));
