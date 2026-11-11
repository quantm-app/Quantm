import test, { beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setDrmReady } from '../src/js/drm.js';
import { installBrowser } from './helpers/browser.js';

installBrowser();
// The session timer is unrelated to queue behavior and must not keep Node alive.
const timer = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
timer.mock.restore();
const tracks = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: 'Track ' + (i + 1), duration: 100000 }));

describe('player queue', () => {
  beforeEach(() => {
    player.queue = tracks.slice();
    player.index = 2;
    player.original = null;
    player.shuffle = false;
    player.context = null;
    localStorage.clear();
  });

  test('clearQueue retains the current track at zero from every valid index', () => {
    for (let index = 0; index < tracks.length; index++) {
      player.queue = tracks.slice();
      player.index = index;
      player.original = tracks.slice();
      player.clearQueue();
      assert.deepEqual(player.queue, [tracks[index]]);
      assert.equal(player.current, tracks[index]);
      assert.equal(player.index, 0);
      assert.equal(player.original, null);
    }
    player.queue = [];
    player.index = -1;
    player.clearQueue();
    assert.deepEqual(player.queue, []);
    assert.equal(player.index, -1);
  });

  test('removing a queued track updates original and cannot resurrect it after shuffle', () => {
    player.shuffle = true;
    player.original = tracks.slice();
    player.queue = [tracks[4], tracks[0], tracks[2], tracks[3], tracks[1]];
    const current = player.current;
    player.removeFromQueue(1);
    assert.equal(player.index, 1);
    assert.equal(player.current, current);
    assert.ok(!player.original.includes(tracks[0]));
    player.toggleShuffle();
    assert.deepEqual(player.queue, tracks.slice(1));
    assert.equal(player.current, current);
    assert.equal(player.original, null);
  });

  test('removing the current track is a no-op; removing a later track preserves index', () => {
    player.original = tracks.slice();
    player.removeFromQueue(2);
    assert.deepEqual(player.queue, tracks);
    assert.deepEqual(player.original, tracks);
    player.removeFromQueue(4);
    assert.equal(player.index, 2);
    assert.equal(player.current, tracks[2]);
    assert.deepEqual(player.original, tracks.slice(0, 4));
  });

  test('every queue move keeps index on the same track', () => {
    for (let index = 0; index < tracks.length; index++) {
      for (let from = 0; from < tracks.length; from++) {
        for (let to = 0; to < tracks.length; to++) {
          player.queue = tracks.slice();
          player.index = index;
          player.moveInQueue(from, to);
          assert.equal(player.current, tracks[index], `index=${index}, from=${from}, to=${to}`);
          const expected = tracks.slice();
          expected.splice(to, 0, expected.splice(from, 1)[0]);
          assert.deepEqual(player.queue, expected);
        }
      }
    }
  });

  test('addToQueue and playNext keep original in sync when shuffle is disabled again', t => {
    // Toast expiry timers are UI-only; exercise the real queue methods and events.
    t.mock.method(globalThis, 'setTimeout', () => 0);
    player.shuffle = true;
    player.original = tracks.slice();
    const current = player.current;
    const extra = [6, 7, 8, 9].map(id => ({ id, title: 'Track ' + id }));
    player.addToQueue(extra[0]);
    player.addToQueue(extra.slice(1, 3));
    player.playNext(extra[3]);
    assert.equal(player.queue[player.index + 1], extra[3]);
    assert.deepEqual(player.original, [...tracks, ...extra]);
    assert.equal(player.current, current);
    player.toggleShuffle();
    assert.deepEqual(player.queue, [...tracks, ...extra]);
    assert.equal(player.current, current);
  });
});

describe('player Widevine streams', () => {
  const made = [];
  class FakeHls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network', KEY_SYSTEM_ERROR: 'key' };
    handlers = {};
    constructor(options) { this.options = options; made.push(this); }
    on(name, fn) { this.handlers[name] = fn; }
    loadSource() {}
    attachMedia() {}
    destroy() { this.destroyed = true; }
  }
  const labelTrack = (id) => ({ id, title: 'Label Song ' + id, duration: 100000 });
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  let before;
  beforeEach(() => {
    made.length = 0;
    before = window.Hls;
    window.Hls = FakeHls;
    setDrmReady(true);
    player.queue = [labelTrack(31), labelTrack(32)];
    player.index = 0;
    player.prepared = null;
    player.fading = null;
    player.loading = false;
    player.loadId++;
    for (const deck of player.decks) {
      deck.hls = null;
      deck.track = null;
      for (const name of ['pause', 'load', 'removeAttribute']) deck.audio[name] ??= () => {};
    }
  });
  const cleanup = () => { window.Hls = before; setDrmReady(false); player.decks.forEach(d => { d.hls = null; }); };
  const mockApi = (t) => t.mock.method(window.native, 'api', async ({ resource }) => {
    const id = /^tracks\/(\d+)$/.exec(resource)?.[1];
    return id
      ? { ok: true, data: { id: Number(id), track_authorization: 'a', media: { transcodings: [{ url: 'https://api/ctr', format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4' } }] } } }
      : { ok: true, data: { url: 'https://cdn/x.m3u8', licenseAuthToken: 'tok' } };
  });
  const streamOf = async (track) => (await import('../src/js/api.js')).streamFor(track);

  test('a drm stream builds Hls with EME; a refused license is retried twice, then the player is left idle (last song: no skip)', async (t) => {
    mockApi(t);
    const track = player.queue[1];
    player.index = 1;
    const buffering = [];
    player.on('buffering', (value) => buffering.push(value));
    const next = t.mock.method(player, 'next', () => {});
    try {
      const deck = player.deck;
      player.loading = true;
      const stream = await streamOf(track);
      player.attach(stream, false, 0, deck, track, track);
      assert.equal(made[0].options.emeEnabled, true);
      assert.equal(made[0].options.drmSystems['com.widevine.alpha'].licenseUrl, stream.drm.licenseUrl);
      assert.equal(typeof made[0].options.licenseXhrSetup, 'function');
      assert.equal(deck.drm, true);
      const fail = () => made.at(-1).handlers.error('error', { fatal: true, type: 'key' });
      for (let attempt = 1; attempt <= 2; attempt++) {
        fail();
        await settle();
        assert.equal(made.length, 1 + attempt, 'retry ' + attempt + ' re-attaches');
      }
      fail();
      await settle();
      assert.equal(made.length, 3, 'no third retry');
      assert.equal(made.at(-1).destroyed, true, 'the failed Hls is released');
      assert.equal(deck.hls, null);
      assert.equal(player.loading, false);
      assert.equal(buffering.at(-1), false, 'buffering is cleared');
      await new Promise(resolve => setTimeout(resolve, 900));
      assert.equal(next.mock.callCount(), 0, 'last song: nothing to skip to');
    } finally { cleanup(); }
  });

  test('a terminal license failure skips to the next song when there is one', async (t) => {
    mockApi(t);
    const next = t.mock.method(player, 'next', () => {});
    try {
      const track = player.queue[0];
      const stream = await streamOf(track);
      player.attach(stream, false, 0, player.deck, track, track, 2);
      made[0].handlers.error('error', { fatal: true, type: 'key' });
      assert.equal(made[0].destroyed, true);
      await new Promise(resolve => setTimeout(resolve, 900));
      assert.equal(next.mock.callCount(), 1);
    } finally { cleanup(); }
  });

  test('a refresh that comes back after the listener picked another song does not re-attach the old one', async (t) => {
    mockApi(t);
    try {
      const track = player.queue[0];
      const deck = player.deck;
      player.attach(await streamOf(track), false, 0, deck, track, track);
      made[0].handlers.error('error', { fatal: true, type: 'key' });
      player.index = 1; // the listener jumped to the next song while the refresh was in flight
      await settle();
      assert.equal(made.length, 1, 'no re-attach for the old song');
    } finally { cleanup(); }
  });

  test('a pre-rolled drm deck that runs out of retries is dropped from the prepared transition', async (t) => {
    mockApi(t);
    try {
      const current = player.queue[0];
      const next = player.queue[1];
      const deck = player.decks[1 - player.active];
      const prep = { loadId: player.loadId, from: 0, track: next, stream: null, failed: false, wrap: false, order: null, auto: true, preroll: null };
      player.prepared = prep;
      prep.stream = await streamOf(next);
      player.attach(prep.stream, false, 0, deck, next, next, 2);
      prep.preroll = { deck, track: next, done: false, timer: null };
      assert.equal(player.current, current);
      made[0].handlers.error('error', { fatal: true, type: 'key' });
      assert.equal(prep.preroll, null);
      assert.equal(prep.stream, null, 'startCrossfade will not use the dead deck');
      assert.equal(prep.failed, true);
      assert.equal(deck.track, null, 'the pre-roll deck is released');
    } finally { cleanup(); }
  });
});
