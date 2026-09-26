import assert from 'node:assert/strict';
import test from 'node:test';

import { createBadgeState } from '../src/badge.js';

test('registration alone shows ON without claiming injection success', () => {
  const badge = createBadgeState();
  assert.equal(badge.onRouteRegistered(), 'ON');
});

test('an injection failure latches "!" and survives later re-registrations', () => {
  const badge = createBadgeState();

  assert.equal(badge.onInjectFailed(), '!');
  // Routine route re-registration must not mask the unresolved failure.
  assert.equal(badge.onRouteRegistered(), '!');
});

test('a successful injection recovers the badge to ON', () => {
  const badge = createBadgeState();

  badge.onInjectFailed();
  assert.equal(badge.onInjectRecovered(), 'ON');
  assert.equal(badge.onRouteRegistered(), 'ON');
});
