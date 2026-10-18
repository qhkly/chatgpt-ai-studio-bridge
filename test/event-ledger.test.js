import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEDGER_MAX_ENTRIES,
  LEDGER_TTL_MS,
  RELAY_MAX_RETENTION_MS,
  pruneLedger,
  withLedgerEntry,
} from '../src/event-ledger.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

test('tombstones outlive the longest relay retention, with a clock-skew margin', () => {
  // Relay: EVENT_RETENTION_SECONDS up to 7 days.
  assert.ok(LEDGER_TTL_MS > RELAY_MAX_RETENTION_MS);
  const ledger = {
    sixDays: { state: 'stopped', at: NOW - 6 * DAY },
    sevenDaysAndAHalf: { state: 'stopped', at: NOW - 7.5 * DAY },
    nineDays: { state: 'stopped', at: NOW - 9 * DAY },
  };
  assert.deepEqual(Object.keys(pruneLedger(ledger, NOW)).sort(), ['sevenDaysAndAHalf', 'sixDays']);
});

test('the count bound covers the relay maximum and keeps the newest entries', () => {
  // Relay: MAX_EVENTS_PER_CHANNEL up to 5000.
  assert.ok(LEDGER_MAX_ENTRIES >= 5000);
  const ledger = {};
  for (let i = 0; i < LEDGER_MAX_ENTRIES + 500; i++) {
    ledger['evt-' + i] = { state: 'delivered', at: NOW - (LEDGER_MAX_ENTRIES + 500 - i) };
  }
  const kept = pruneLedger(ledger, NOW);
  assert.equal(Object.keys(kept).length, LEDGER_MAX_ENTRIES);
  assert.ok(!('evt-0' in kept));
  assert.ok('evt-' + (LEDGER_MAX_ENTRIES + 499) in kept);
});

test('withLedgerEntry sets, refreshes and removes entries', () => {
  let ledger = withLedgerEntry({}, 'a', { state: 'inflight', tabId: 7 }, NOW);
  assert.deepEqual(ledger, { a: { state: 'inflight', tabId: 7, at: NOW } });
  ledger = withLedgerEntry(ledger, 'a', { state: 'stopped', detail: 'x' }, NOW + 1);
  assert.deepEqual(ledger, { a: { state: 'stopped', detail: 'x', at: NOW + 1 } });
  assert.deepEqual(withLedgerEntry(ledger, 'a', null, NOW + 2), {});
});

test('malformed ledgers do not throw', () => {
  assert.deepEqual(pruneLedger(undefined, NOW), {});
  assert.deepEqual(pruneLedger({ bad: null, worse: 'x' }, NOW), {});
});
