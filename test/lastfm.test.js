import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrobbler } from '../src/js/lastfm.js';

const song = { id: 1, title: 'A song', user: { username: 'An artist' }, duration: 100000 };
function setup() {
  const now = [], scrobbles = [];
  const tracker = createScrobbler({ nowPlaying: value => now.push(value), scrobble: value => scrobbles.push(value) });
  tracker.track(song); tracker.track(song);
  return { tracker, now, scrobbles };
}

test('scrobbles once after half the track is heard, excluding pauses and seeks', () => {
  const { tracker, now, scrobbles } = setup();
  tracker.state(true, 100, 1000000);
  for (let i = 0; i <= 25; i++) tracker.time(i, 100, true, 1000000 + i * 1000);
  tracker.state(false, 100);
  tracker.time(25, 100, false, 1100000);
  tracker.state(true, 100, 1100000);
  tracker.time(70, 100, true, 1100000); // seek does not count
  for (let i = 1; i <= 25; i++) tracker.time(70 + i, 100, true, 1100000 + i * 1000);
  assert.equal(now.length, 1);
  assert.equal(scrobbles.length, 1);
  assert.deepEqual(scrobbles[0], { artist: 'An artist', track: 'A song', duration: 100, timestamp: 1000 });
  tracker.time(96, 100, true, 1126000);
  assert.equal(scrobbles.length, 1);
});

test('ignores short tracks and treats a return to the beginning as a new listen', () => {
  const { tracker, scrobbles } = setup();
  for (let i = 0; i <= 60; i++) tracker.time(i, 30, true, i * 1000);
  assert.equal(scrobbles.length, 0);
  tracker.time(1, 100, true, 61000);
  for (let i = 2; i <= 52; i++) tracker.time(i, 100, true, (60 + i) * 1000);
  assert.equal(scrobbles.length, 1);
});
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { createLastfm } = createRequire(import.meta.url)('../lastfm.js');

test('authorizes, signs submissions and keeps session credentials out of status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quantm-lastfm-'));
  const calls = [], opened = [];
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  const request = async (url, options) => {
    const params = Object.fromEntries(new URLSearchParams(options.body));
    calls.push(params);
    const result = params.method === 'auth.getToken' ? { token: 'token' } : params.method === 'auth.getSession' ? { session: { name: 'listener', key: 'session-key' } } : {};
    return { ok: true, json: async () => result };
  };
  try {
    const service = createLastfm({ directory, safeStorage, request, openExternal: async url => opened.push(url) });
    await service.begin('a'.repeat(32), 'b'.repeat(32));
    assert.match(opened[0], /^https:\/\/www\.last\.fm\/api\/auth\//);
    assert.deepEqual(await service.finish(), { connected: true, username: 'listener' });
    assert.deepEqual(service.status(), { connected: true, username: 'listener' });
    await service.submit('track.updateNowPlaying', { artist: 'Artist', track: 'Song', duration: 120 });
    const params = calls.at(-1), signature = params.api_sig;
    delete params.api_sig; delete params.format;
    assert.equal(signature, createHash('md5').update(Object.keys(params).sort().map(k => k + params[k]).join('') + 'b'.repeat(32)).digest('hex'));
    assert.equal(params.sk, 'session-key');
    assert.ok(!readFileSync(join(directory, 'lastfm.json'), 'utf8').includes('session-key'));
    service.disconnect();
    assert.equal(service.status().connected, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('retains a scrobble when Last.fm is unreachable and clears it on disconnect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quantm-lastfm-'));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  const request = async (url, options) => {
    const params = new URLSearchParams(options.body);
    if (params.get('method') === 'track.scrobble') throw new Error('offline');
    return { ok: true, json: async () => params.get('method') === 'auth.getToken' ? { token: 'token' } : { session: { name: 'listener', key: 'session' } } };
  };
  try {
    const service = createLastfm({ directory, safeStorage, request, openExternal: async () => {} });
    await service.begin('a'.repeat(32), 'b'.repeat(32));
    await service.finish();
    await service.submit('track.scrobble', { artist: 'Artist', track: 'Song', duration: 100, timestamp: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    const stored = JSON.parse(readFileSync(join(directory, 'lastfm.json'), 'utf8'));
    assert.equal(JSON.parse(Buffer.from(stored.data, 'base64').toString()).queue.length, 1);
    service.disconnect();
    assert.equal(service.status().connected, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
