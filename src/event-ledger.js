// Durable per-event delivery ledger (chrome.storage.local, kept across
// worker restarts, extension reloads/updates and browser restarts).
//
// An entry is the only thing that stops a relay replay of an unACKed event
// from being sent again, so it must outlive every copy the relay can still
// replay. The bounds below come from the deployed relay
// (webcode-ai-studio/deploy/notify-relay/src/channel.js):
//   - EVENT_RETENTION_SECONDS: unACKed events are replayed for 1 day by
//     default, configurable up to 7 days; older ones are never replayed.
//   - MAX_EVENTS_PER_CHANNEL: 500 by default, configurable up to 5000; past
//     that the oldest events are dropped (ACKed or not).
// The older chatgpt-ai-studio-relay (24h / 100 events) fits inside both.
// The local bridge (127.0.0.1:17373) is a live broadcast with no backlog.
//
// So an entry may only go once it is older than the longest possible relay
// retention (plus a clock-skew margin between browser and relay), or once
// 5000 newer events have been recorded, by which point the relay's own cap
// has dropped it. Both bounds keep the ledger finite (~5000 small entries,
// well under the storage.local quota).
//
// Not covered: a relay reconfigured beyond those maximums, or a channel
// carrying more events than this extension records between an event and its
// replay. Either needs this file updated with the relay.
const DAY_MS = 24 * 60 * 60 * 1000;
export const RELAY_MAX_RETENTION_MS = 7 * DAY_MS;
export const LEDGER_TTL_MS = RELAY_MAX_RETENTION_MS + DAY_MS;
export const LEDGER_MAX_ENTRIES = 5000;

export const pruneLedger = (ledger, now = Date.now()) => {
  const entries = Object.entries(ledger ?? {})
    .filter(([, entry]) => entry && typeof entry === 'object' &&
      now - Number(entry.at || 0) <= LEDGER_TTL_MS)
    .sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
    .slice(0, LEDGER_MAX_ENTRIES);
  return Object.fromEntries(entries);
};

// Ledger states:
//   inflight  - handed to a tab; outcome not reported yet
//   delivered - the page proved the message was sent (ACKed)
//   stopped   - an attempt began but could not be confirmed; never retried,
//               never ACKed
export const withLedgerEntry = (ledger, key, entry, now = Date.now()) => {
  const next = { ...(ledger ?? {}) };
  if (entry) next[key] = { ...entry, at: now };
  else delete next[key];
  return pruneLedger(next, now);
};
