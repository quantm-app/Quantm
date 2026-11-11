import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeDrm, retryDrmProbe, drmReady, setDrmReady, canPlayProtocol, licenseXhrSetup, WIDEVINE_PROTOCOL, WIDEVINE_LICENSE_URL } from '../src/js/drm.js';

beforeEach(() => setDrmReady(false));

test('probeDrm asks for Widevine and stores the answer', async () => {
  const asked = [];
  const nav = { requestMediaKeySystemAccess: async (...args) => { asked.push(args); return {}; } };
  assert.equal(await probeDrm(nav), true);
  assert.equal(drmReady(), true);
  assert.equal(asked[0][0], 'com.widevine.alpha');
  assert.deepEqual(asked[0][1][0].initDataTypes, ['cenc']);
  assert.equal(asked[0][1][0].audioCapabilities[0].contentType, 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(await probeDrm({ requestMediaKeySystemAccess: async () => { throw new Error('no'); } }), false);
  assert.equal(drmReady(), false);
});

test('probeDrm is false for a rejection, a synchronous throw and a missing API, and never throws', async () => {
  assert.equal(await probeDrm({ requestMediaKeySystemAccess: () => Promise.reject(new Error('unsupported')) }), false);
  assert.equal(await probeDrm({ requestMediaKeySystemAccess: () => { throw new Error('boom'); } }), false);
  assert.equal(await probeDrm({}), false);
  assert.equal(await probeDrm(null), false);
  assert.equal(drmReady(), false);
});

test('probeDrm gives up on a hung probe after 3 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = probeDrm({ requestMediaKeySystemAccess: () => new Promise(() => {}) });
  t.mock.timers.tick(3000);
  assert.equal(await pending, false);
  assert.equal(drmReady(), false);
});

test('canPlayProtocol only allows the Widevine protocol once drm is ready', () => {
  assert.equal(WIDEVINE_PROTOCOL, 'ctr-encrypted-hls');
  for (const protocol of ['progressive', 'hls']) assert.equal(canPlayProtocol(protocol), true);
  assert.equal(canPlayProtocol('ctr-encrypted-hls'), false);
  assert.equal(canPlayProtocol('cbc-encrypted-hls'), false);
  assert.equal(canPlayProtocol(undefined), false);
  setDrmReady(true);
  assert.equal(canPlayProtocol('ctr-encrypted-hls'), true);
  assert.equal(canPlayProtocol('cbc-encrypted-hls'), false);
});

test('licenseXhrSetup posts the raw challenge with the token on the url', () => {
  const calls = [];
  const xhr = { open: (...args) => calls.push(['open', ...args]), setRequestHeader: (...args) => calls.push(['header', ...args]) };
  const challenge = new Uint8Array([1, 2, 3]);
  const result = licenseXhrSetup('a b&c=d')(xhr, WIDEVINE_LICENSE_URL, {}, challenge);
  assert.equal(result, challenge);
  const [, method, url, async] = calls.find(c => c[0] === 'open');
  assert.equal(method, 'POST');
  assert.equal(async, true);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, WIDEVINE_LICENSE_URL);
  assert.equal(parsed.searchParams.get('license_token'), 'a b&c=d');
  assert.ok(!url.includes('a b&c'), 'token is url-encoded');
  assert.deepEqual(calls.find(c => c[0] === 'header'), ['header', 'Content-Type', 'application/octet-stream']);
});

const failing = () => ({ requestMediaKeySystemAccess: () => Promise.reject(new Error('module not installed yet')) });
function fakeTimer() {
  const waits = [];
  return { waits, wait: async (ms) => { waits.push(ms); } };
}

test('retryDrmProbe does nothing when drm is already ready', async () => {
  setDrmReady(true);
  const timer = fakeTimer();
  let probes = 0;
  const nav = { requestMediaKeySystemAccess: async () => { probes++; return {}; } };
  assert.equal(await retryDrmProbe(nav, timer.wait), true);
  assert.equal(probes, 0);
  assert.deepEqual(timer.waits, []);
});

test('retryDrmProbe stops after the probe that succeeds', async () => {
  const timer = fakeTimer();
  let probes = 0;
  const nav = { requestMediaKeySystemAccess: async () => { if (++probes < 3) throw new Error('not yet'); return {}; } };
  assert.equal(await retryDrmProbe(nav, timer.wait), true);
  assert.equal(probes, 3);
  assert.deepEqual(timer.waits, [10000, 30000, 60000]);
  assert.equal(drmReady(), true);
});

test('retryDrmProbe gives up after five retries on the 10, 30, 60, 120 and 300 second schedule', async () => {
  const timer = fakeTimer();
  let probes = 0;
  const nav = { requestMediaKeySystemAccess: async () => { probes++; throw new Error('no'); } };
  assert.equal(await retryDrmProbe(nav, timer.wait), false);
  assert.equal(probes, 5);
  assert.deepEqual(timer.waits, [10000, 30000, 60000, 120000, 300000]);
  assert.equal(drmReady(), false);
});

test('retryDrmProbe accepts its own delay list', async () => {
  const timer = fakeTimer();
  assert.equal(await retryDrmProbe(failing(), timer.wait, [1, 2]), false);
  assert.deepEqual(timer.waits, [1, 2]);
});

test('a second retryDrmProbe call while one is pending does not start another chain', async () => {
  const waits = [];
  const releases = [];
  const wait = (ms) => new Promise((resolve) => { waits.push(ms); releases.push(resolve); });
  const first = retryDrmProbe(failing(), wait, [1, 2]);
  assert.equal(await retryDrmProbe(failing(), wait, [1, 2]), false);
  assert.deepEqual(waits, [1]);
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  releases[1]();
  assert.equal(await first, false);
  assert.deepEqual(waits, [1, 2]);
  const timer = fakeTimer();
  await retryDrmProbe(failing(), timer.wait, [1]);
  assert.deepEqual(timer.waits, [1], 'a new chain can start once the last one ended');
});

test('retryDrmProbe never throws, whatever the navigator or timer does', async () => {
  const timer = fakeTimer();
  assert.equal(await retryDrmProbe({ requestMediaKeySystemAccess: () => { throw new Error('boom'); } }, timer.wait, [1]), false);
  assert.equal(await retryDrmProbe(failing(), timer.wait, [1]), false);
  assert.equal(await retryDrmProbe(null, timer.wait, [1]), false);
  assert.equal(await retryDrmProbe(failing(), () => { throw new Error('timer broke'); }, [1]), false);
  assert.equal(await retryDrmProbe(failing(), () => Promise.reject(new Error('timer broke')), [1]), false);
});
