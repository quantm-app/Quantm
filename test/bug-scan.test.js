import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings } = await import('../src/js/store.js');
startup.mock.restore();

function fixture(t) {
  const timers = new Map();
  let id = 0;
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal'; settings.autoMix = false;
  const p = new player.constructor();
  t.after(() => { p.fading = null; p.lock = null; p.tempoRelease = null; });
  const from = { id: 1, title: 'A', duration: 200000 }, to = { id: 2, title: 'B', duration: 200000 };
  p.queue = [from, to]; p.index = 0; p.active = 0; p.loadId = 2;
  for (const deck of p.decks) {
    Object.assign(deck.audio, { readyState: 4, paused: false, seeking: false, duration: 200, playbackRate: 1, currentTime: 0,
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, removeAttribute() {}, load() {} });
  }
  p.decks[0].track = from; p.decks[1].track = to;
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  t.mock.method(p, 'notify', () => {});
  return { p, from, to, timers };
}

test('two quick presses of Next at the end of the queue move on once, not twice', async t => {
  const { p, from } = fixture(t);
  p.queue = [from];
  p.index = 0;
  p.repeat = 'off';
  settings.autoplayRelated = true;
  t.after(() => { settings.autoplayRelated = false; });
  let fetches = 0;
  t.mock.method(p, 'appendRelated', async () => { fetches++; await Promise.resolve(); if (p.queue.length < 2) p.queue.push({ id: 9, title: 'Related' }, { id: 10, title: 'More' }); return true; });
  const loads = [];
  t.mock.method(p, 'load', () => { loads.push(p.index); });
  await Promise.all([p.next(), p.next()]);
  assert.equal(p.index, 1, 'one step, not two');
  assert.deepEqual(loads, [1]);
  assert.equal(fetches, 2, 'both asked');
  // a later press moves on again
  await p.next();
  assert.equal(p.index, 2);
});

test('seeking during a blend lets go of the beat lock instead of chasing a stale position', t => {
  const { p } = fixture(t);
  const stops = [];
  p.fading = { style: 'blend', outgoing: p.decks[0], incoming: p.decks[1] };
  p.lock = { stop: rate => stops.push(rate) };
  p.active = 1;
  p.seek(30);
  assert.equal(p.lock, null);
  assert.deepEqual(stops, [1]);
  assert.equal(p.audio.currentTime, 30);
  // no blend, no lock: a plain seek touches nothing
  p.fading = null;
  p.lock = { stop: () => stops.push('again') };
  p.seek(40);
  assert.ok(p.lock);
  assert.deepEqual(stops, [1]);
});

test('a drop cut that falls back finds the outgoing song again after the queue was edited during the pre-roll', t => {
  const { p, from, to } = fixture(t);
  const queue = p.queue;
  p.normalizer = { ctx: { currentTime: 1 }, effect: false, clearDropCut() {}, clearEchoOut() {}, setFade() {}, setActive() {}, startTrack() {}, holdBass() {} };
  const f = { from, to, outgoing: p.decks[0], incoming: p.decks[1], fromQueue: queue, fromIndex: 0, prep: { track: to }, announced: false };
  // the drop cut moved on to the next song, then something was added in front of the queue
  p.index = 1;
  p.active = 1;
  p.fading = f;
  p.decks[1].audio.paused = true;
  queue.unshift({ id: 7, title: 'Added first' });
  p.fallbackDropCut(f, 'test');
  assert.equal(p.current, from, 'the outgoing song is the current one again');
  assert.equal(p.index, 1);
});

test('the see-through offer swallows a failed window query instead of leaving an unhandled rejection', async t => {
  const { offerSeeThrough } = await import('../src/js/views/settings.js');
  window.native.windowMode = async () => { throw new Error('no window'); };
  await assert.doesNotReject(offerSeeThrough());
  window.native.windowMode = async () => ({ supported: false });
  await assert.doesNotReject(offerSeeThrough());
  t.after(() => { delete window.native.windowMode; });
});

test('closing the Performance tab cancels its first usage reading as well as the polling', async t => {
  const { render } = await import('../src/js/views/settings.js');
  const live = new Set();
  let id = 0;
  t.mock.method(globalThis, 'setTimeout', fn => { live.add(++id); return id; });
  t.mock.method(globalThis, 'setInterval', fn => { live.add(++id); return id; });
  t.mock.method(globalThis, 'clearTimeout', key => live.delete(key));
  t.mock.method(globalThis, 'clearInterval', key => live.delete(key));
  Object.assign(window.native, { performanceInfo: async () => ({ hardwareAcceleration: true }), metrics: async () => ({ cpu: 1, memoryMB: 2, processes: 3 }) });
  t.after(() => { delete window.native.performanceInfo; delete window.native.metrics; });
  const page = document.createElement('div');
  page.querySelector = () => null;
  let close;
  try { close = await render(page, { tab: 'performance' }); } catch (e) { t.skip(`the settings page needs more of a DOM than the fake one: ${e.message}`); return; }
  assert.equal(live.size, 2, 'the first reading and the polling are pending');
  close();
  assert.equal(live.size, 0, 'closing the view leaves nothing running');
});
