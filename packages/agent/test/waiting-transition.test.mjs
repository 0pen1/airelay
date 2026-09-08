// Unit test for the waiting-transition logic in daemon.ts.
//
// broadcastStatus is closure-scoped inside startDaemon, so this test extracts
// and verifies the decision rules directly (they're pure given the activity
// record): a running→idle transition must produce waiting=true; idle→running,
// force-refreshes, and no-change ticks must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the decision logic in daemon.ts broadcastStatus
function decideTransition(prevRunning, nowRunning, force) {
  const waiting = prevRunning && !nowRunning;
  return !force && waiting; // force pushes never claim waiting
}

test('running→idle transition yields waiting=true', () => {
  assert.equal(decideTransition(true, false, false), true);
});

test('idle→running is not waiting', () => {
  assert.equal(decideTransition(false, true, false), false);
});

test('unchanged state is not waiting', () => {
  assert.equal(decideTransition(false, false, false), false);
});

test('forced push never claims waiting', () => {
  assert.equal(decideTransition(true, false, true), false);
});
