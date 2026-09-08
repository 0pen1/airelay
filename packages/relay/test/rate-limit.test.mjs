// Unit tests for the sliding-window rate limiter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allow, resetLimiter, trackedKeys } from '../dist/rate-limit.js';

test('allows up to limit within window', () => {
  resetLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(allow('k', 5, 1000), true, `event ${i + 1} allowed`);
  }
  assert.equal(allow('k', 5, 1000), false, '6th event blocked');
});

test('independent keys are independent', () => {
  resetLimiter();
  for (let i = 0; i < 5; i++) allow('a', 5, 1000);
  assert.equal(allow('a', 5, 1000), false);
  assert.equal(allow('b', 5, 1000), true, 'different key unaffected');
});

test('window slides: old events expire', async () => {
  resetLimiter();
  // 150ms window, filled now; after 200ms the slot frees up.
  for (let i = 0; i < 3; i++) allow('w', 3, 150);
  assert.equal(allow('w', 3, 150), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(allow('w', 3, 150), true, 'window expired, allowed again');
});

test('trackedKeys counts distinct keys', () => {
  resetLimiter();
  allow('x', 10, 1000);
  allow('y', 10, 1000);
  assert.equal(trackedKeys(), 2);
});
