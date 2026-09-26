// Badge semantics, so "route registered" and "route marker injected" are
// never confused:
//
// - "ON" — the conversation route is registered with the background worker.
//   It does NOT claim the last message carried the route marker.
// - "!"  — a send-path problem: the route marker failed to reach the
//   composer (injection failure), or a completion could not be delivered.
//
// A registration refresh must not clear an unresolved injection failure, so
// the failure latch lives here and survives re-registrations until an
// injection succeeds again.
export const createBadgeState = () => {
  let injectFailed = false;

  return {
    onRouteRegistered: () => (injectFailed ? '!' : 'ON'),
    onInjectFailed: () => {
      injectFailed = true;
      return '!';
    },
    onInjectRecovered: () => {
      injectFailed = false;
      return 'ON';
    },
  };
};
