import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import * as mixlearn from '../src/js/mixlearn.js';
import * as mixmemory from '../src/js/mixmemory.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings } = await import('../src/js/store.js');
const cues = await import('../src/js/cues.js');
startup.mock.restore();

// A player in the middle of an Auto mix transition from "Outgoing" into "Incoming".
function fixture(t, style = 'blend') {
  let id = 0;
  const timers = new Map();
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal';
  settings.autoMix = true; settings.transitionStyle = 'auto';
  const p = new player.constructor();
  t.after(() => { p.fading = null; p.lock = null; p.tempoRelease = null; });
  cues._reset(); mixmemory.reset(); mixlearn.reset();
  const from = { id: 11, title: 'Outgoing', duration: 201000, genre: 'Dubstep' };
  const to = { id: 12, title: 'Incoming', duration: 201000, genre: 'House' };
  p.queue = [from, to]; p.index = 1; p.active = 1; p.loadId = 2;
  const [outgoing, incoming] = p.decks;
  for (const deck of p.decks) {
    Object.assign(deck.audio, { readyState: 4, paused: false, seeking: false, duration: 201, playbackRate: 1,
      buffered: { length: 1, start: () => 0, end: () => 201 },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}, load() {} });
  }
  outgoing.audio.currentTime = 99;
  incoming.audio.currentTime = 75;
  outgoing.track = from; incoming.track = to;
  const ctx = { currentTime: 10 };
  p.normalizer = { ctx, startDropCut() { return true; }, clearDropCut() {}, setFade() {}, fadeDeck() {}, holdBass() {},
    setActive() {}, startTrack() {}, holdFade() {}, setEqualizer() {} };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  const grid = { bpm: 120, period: 0.5, offset: 0, confidence: 0.9 };
  const f = p.fading = { from, to, outgoing, incoming, seconds: 8, bass: false, progress: 0, startedAt: null, style,
    dropcut: style === 'dropcut' ? { drop: { time: 92, confidence: 0.8 }, window: { build: 100, cut: 116 }, match: { gridOut: grid, gridIn: grid, ratio: 1 } } : null,
    prep: { auto: true, stream: { track: {} }, track: to }, fromQueue: p.queue, fromIndex: 0 };
  const choice = { ...mixlearn.choose('bass:fast', () => 0.2), style };
  p.mixOutcome = { choice, trackId: to.id, mixEnd: null, timer: null };
  const events = [];
  p.on('mixrate', rating => events.push(rating));
  const advance = now => {
    const seconds = now - ctx.currentTime;
    outgoing.audio.currentTime += seconds;
    incoming.audio.currentTime += seconds;
    ctx.currentTime = now;
    timers.get(f.monitor)?.();
  };
  return { p, f, timers, events, advance, choice, from, to };
}

const logs = p => p.mixLog.map(entry => entry.text);

test('the rating window opens when the incoming blend takes over, not while it is only planned', t => {
  const { p, f, events, to } = fixture(t);
  assert.equal(p.mixRating, null, 'planned, not mixing yet');
  p.beginFade();
  assert.deepEqual(p.mixRating, { track: to, style: 'blend' });
  assert.deepEqual(events, [{ track: to, style: 'blend' }]);
  p.beginFade(); // pausing and resuming the fade does not announce it twice
  assert.equal(events.length, 1);
  assert.equal(f.style, 'blend');
});

test('thumbs up records a good outcome right away for the genre bucket and closes the window', t => {
  const { p, events, to } = fixture(t);
  p.beginFade();
  assert.equal(p.rateMix('good'), true);
  const learned = mixlearn.stats();
  assert.equal(learned.genres['bass:fast'].good, 1);
  assert.equal(learned.buckets.fast.good, 1);
  assert.equal(learned.transitions, 1);
  assert.equal(p.mixOutcome, null);
  assert.equal(p.mixRating, null);
  assert.deepEqual(events, [{ track: to, style: 'blend' }, null]);
  assert.equal(logs(p)[0], 'You rated the smooth blend into "Incoming": good (learning for bass music · 130-160 BPM)');
  assert.equal(p.mixLog[0].kind, 'good');
  assert.equal(p.rateMix('bad'), false, 'nothing left to rate');
  assert.equal(mixlearn.stats().transitions, 1);
});

test('thumbs down records a bad outcome and a plain skip right after does not count twice', t => {
  const { p, events } = fixture(t);
  p.beginFade();
  p.rateMix('bad');
  assert.equal(mixlearn.stats().genres['bass:fast'].bad, 1);
  assert.equal(logs(p)[0], 'You rated the smooth blend into "Incoming": bad (learning for bass music · 130-160 BPM)');
  p.noteSkip();
  assert.equal(mixlearn.stats().transitions, 1);
  assert.equal(events.at(-1), null);
});

test('a skip with no rating teaches nothing, during the mix or after it', t => {
  for (const when of ['during', 'after']) {
    const { p, f, events } = fixture(t);
    p.beginFade();
    if (when === 'after') p.finishFade(f);
    assert.ok(p.mixRating);
    p.noteSkip();
    assert.equal(p.mixRating, null);
    assert.equal(p.mixOutcome, null);
    assert.equal(events.at(-1), null);
    assert.equal(mixlearn.stats().transitions, 0, when);
    assert.deepEqual(p.mixLog.filter(entry => entry.kind === 'bad' || entry.kind === 'good'), []);
  }
});

test('an unrated song kept through the window still counts as good, and the control goes away', t => {
  const { p, f, events, timers, to } = fixture(t);
  p.beginFade();
  p.finishFade(f);
  assert.ok(p.mixRating, 'still rateable after the blend ends, until the window closes');
  const check = timers.get(p.mixOutcome.timer);
  check(); // not 20 s of listening yet: waits and checks again
  assert.ok(p.mixRating);
  assert.equal(mixlearn.stats().transitions, 0);
  f.incoming.audio.currentTime += 20;
  timers.get(p.mixOutcome.timer)();
  assert.equal(mixlearn.stats().genres['bass:fast'].good, 1);
  assert.equal(p.mixRating, null);
  assert.deepEqual(events, [{ track: to, style: 'blend' }, null]);
  assert.match(logs(p)[0], /^You kept "Incoming" after a smooth blend: learning for bass music · 130-160 BPM$/);
});

test('rating after the blend finished but before the window ends works and stops the keep check', t => {
  const { p, f, timers } = fixture(t);
  p.beginFade();
  p.finishFade(f);
  const timer = p.mixOutcome.timer;
  p.rateMix('bad');
  assert.equal(timers.has(timer), false);
  f.incoming.audio.currentTime += 20;
  assert.equal(mixlearn.stats().transitions, 1, 'only the rating counted');
  assert.equal(mixlearn.stats().genres['bass:fast'].bad, 1);
});

test('only transitions Auto mix made can be rated', t => {
  const { p } = fixture(t);
  p.mixOutcome = null; // a manual crossfade or Auto mix off gives no learning choice
  p.beginFade();
  assert.equal(p.mixRating, null);
  assert.equal(p.rateMix('good'), false);
  assert.equal(mixlearn.stats().transitions, 0);
});

test('the window closes when something else is played or the listener seeks', t => {
  const a = fixture(t);
  a.p.beginFade(); a.p.finishFade(a.f);
  assert.ok(a.p.mixRating);
  a.f.incoming.audio.dispatchEvent({ type: 'seeking' });
  assert.equal(a.p.mixRating, null);
  assert.equal(a.events.at(-1), null);

  const b = fixture(t);
  b.p.beginFade();
  b.p.index = 0; // a different song is current: it cannot be rated as this transition
  assert.equal(b.p.mixRating, null);
  assert.equal(b.p.rateMix('good'), false);

  const c = fixture(t);
  c.p.beginFade();
  t.mock.method(c.p, 'load', async () => {});
  c.p.playList([{ id: 99, title: 'Elsewhere', duration: 1000 }], 0);
  assert.equal(c.p.mixOutcome, null);
  assert.equal(c.events.at(-1), null);
});

test('a drop cut can be rated once the drop lands, not during the build', t => {
  const { p, f, events, advance, to } = fixture(t, 'dropcut');
  p.beginFade();
  assert.equal(f.dropScheduled, true);
  assert.equal(p.mixRating, null, 'building: the incoming song is still silent');
  advance(f.schedule.cut);
  assert.equal(p.mixRating, null);
  advance(f.schedule.drop + 0.01);
  assert.equal(f.landed, true);
  assert.deepEqual(p.mixRating, { track: to, style: 'dropcut' });
  assert.equal(p.rateMix('bad'), true);
  assert.equal(mixlearn.stats().genres['bass:fast'].styles.dropcut.bad, 1);
  assert.equal(mixlearn.avoidsDropCut('fast'), true);
  assert.equal(logs(p)[0], 'You rated the drop cut into "Incoming": bad (learning for bass music · 130-160 BPM)');
  assert.equal(events.at(-1), null);
});

test('the outgoing song genre picks the bucket: mixFamily reads genre, tags and title', t => {
  const { p } = fixture(t);
  assert.equal(p.mixFamily({ id: 1, genre: 'Dubstep' }), 'bass');
  assert.equal(p.mixFamily({ id: 2, genre: 'Hip-hop & Rap' }), 'hiphop');
  assert.equal(p.mixFamily({ id: 3, tag_list: 'techno' }), 'dance');
  assert.equal(p.mixFamily({ id: 4, genre: 'Pop' }), 'other');
  assert.equal(p.mixFamily({ id: 5, title: 'Heavy Riddim' }), 'bass');
  assert.equal(p.mixFamily({ id: 6, title: 'Untitled' }), 'unknown');
  assert.equal(p.mixFamily(null), 'unknown');
});
