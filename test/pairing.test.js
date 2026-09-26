import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeviceLabel,
  claimPairing,
  describePairingError,
  describeRemote,
  normalizePairingCode,
} from '../src/pairing.js';

const TOKEN = 'device-token-DO-NOT-LEAK';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const recordingFetch = (response) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
};

test('normalizePairingCode accepts spaced/dashed/full-width codes and rejects the rest', () => {
  assert.equal(normalizePairingCode('123456'), '123456');
  assert.equal(normalizePairingCode(' 123 456 '), '123456');
  assert.equal(normalizePairingCode('123-456'), '123456');
  assert.equal(normalizePairingCode('１２３４５６'), '123456');
  assert.equal(normalizePairingCode('12345'), null);
  assert.equal(normalizePairingCode('1234567'), null);
  assert.equal(normalizePairingCode('12a456'), null);
  assert.equal(normalizePairingCode(''), null);
  assert.equal(normalizePairingCode(undefined), null);
});

test('buildDeviceLabel produces a short browser · OS label', () => {
  assert.equal(buildDeviceLabel({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    userAgentData: { platform: 'macOS', brands: [{ brand: 'Google Chrome' }] },
  }), 'Chrome · macOS');
  assert.equal(buildDeviceLabel({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0',
  }), 'Edge · Windows');
  assert.equal(buildDeviceLabel({}), 'Chrome');
  assert.equal(buildDeviceLabel(null), 'Chrome');
});

test('claimPairing posts the normalized code and returns relay settings', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {
    deviceId: 'dev-1',
    deviceToken: TOKEN,
    relayUrl: 'https://notify.qhkly.com',
  }));

  const result = await claimPairing({
    code: '123 456',
    relayBase: 'https://notify.qhkly.com/',
    deviceLabel: 'Chrome · macOS',
    fetchImpl,
  });

  assert.deepEqual(result, {
    ok: true,
    settings: { enabled: true, url: 'https://notify.qhkly.com', token: TOKEN, deviceId: 'dev-1' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://notify.qhkly.com/v1/pairings/claim');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: '123456', deviceLabel: 'Chrome · macOS' });
});

test('claimPairing defaults to notify.qhkly.com and tolerates a missing deviceId', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {
    deviceToken: TOKEN,
    relayUrl: 'https://notify.qhkly.com',
  }));
  const result = await claimPairing({ code: '000111', deviceLabel: 'x', fetchImpl });
  assert.equal(calls[0].url, 'https://notify.qhkly.com/v1/pairings/claim');
  assert.equal(result.ok, true);
  assert.equal('deviceId' in result.settings, false);
});

test('claimPairing rejects a malformed code without any network call', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {}));
  assert.deepEqual(await claimPairing({ code: '12 34', fetchImpl }), { ok: false, reason: 'invalid-format' });
  assert.equal(calls.length, 0);
});

test('claimPairing maps expired, used and invalid codes to distinct reasons', async () => {
  const cases = [
    [jsonResponse(410, {}), 'code-expired'],
    [jsonResponse(400, { error: 'pairing_code_expired' }), 'code-expired'],
    [jsonResponse(409, {}), 'code-used'],
    [jsonResponse(404, { error: 'not_found' }), 'code-invalid'],
    [jsonResponse(400, null), 'code-invalid'],
    [jsonResponse(429, {}), 'rate-limited'],
    [jsonResponse(503, {}), 'server-error'],
    [{ ok: false, status: 500, json: async () => { throw new Error('html'); } }, 'server-error'],
  ];
  for (const [response, reason] of cases) {
    const { fetchImpl } = recordingFetch(response);
    assert.deepEqual(
      await claimPairing({ code: '123456', deviceLabel: 'x', fetchImpl }),
      { ok: false, reason },
      'status ' + response.status,
    );
  }
});

test('claimPairing reports network failures and malformed success bodies', async () => {
  let { fetchImpl } = recordingFetch(new TypeError('Failed to fetch'));
  assert.deepEqual(await claimPairing({ code: '123456', deviceLabel: 'x', fetchImpl }), { ok: false, reason: 'network' });

  for (const body of [
    {},
    { deviceToken: '', relayUrl: 'https://notify.qhkly.com' },
    { deviceToken: TOKEN },
    { deviceToken: TOKEN, relayUrl: 'ftp://nope' },
    { deviceToken: TOKEN, relayUrl: 'not a url' },
  ]) {
    ({ fetchImpl } = recordingFetch(jsonResponse(200, body)));
    const result = await claimPairing({ code: '123456', deviceLabel: 'x', fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'bad-response' });
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('every pairing failure has explicit Chinese copy', () => {
  assert.match(describePairingError('code-expired'), /过期/);
  assert.match(describePairingError('invalid-format'), /6 位/);
  assert.match(describePairingError('network'), /网络/);
  assert.equal(describePairingError('whatever'), describePairingError('internal-error'));
});

test('describeRemote offers pairing only without a local bridge or remote relay', () => {
  const snap = (local, remote) => ({ localBridge: { state: local }, remoteRelay: remote });

  assert.equal(describeRemote(snap('disconnected', { enabled: false, connected: false })).offerPairing, true);
  assert.equal(describeRemote(snap('connecting', { enabled: false, connected: false })).offerPairing, true);
  assert.equal(describeRemote(snap('connected', { enabled: false, connected: false })).offerPairing, false);

  const connected = describeRemote(snap('disconnected', { enabled: true, connected: true }));
  assert.equal(connected.offerPairing, false);
  assert.equal(connected.text, '远程已连接');
  assert.equal(describeRemote(snap('connected', { enabled: true, connected: false })).text, '远程连接中…');
});
