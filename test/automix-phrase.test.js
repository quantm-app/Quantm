import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import * as mixmemory from '../src/js/mixmemory.js';
import * as mixlearn from '../src/js/mixlearn.js';
import { matchTempo, alignedStart, memoryGrid, phraseMix, PHRASE_LEAD } from '../src/js/automix.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings } = await import('../src/js/store.js');
const cues = await import('../src/js/cues.js');
startup.mock.restore();

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
// 128 BPM: a bar is 1.875 s, a phrase line (8 bars) 15 s; bar 1 of the drums at 3.85 s
const PERIOD = 60 / 128, BAR = 4 * PERIOD, LINE = 8 * BAR;
const grid = (bpm = 128, extra = {}) => ({ bpm, period: 60 / bpm, offset: 0.1, downbeat: 0.1 + 8 * 60 / bpm, confidence: 0.9, phrase: true, ...extra });
const onLine = (t, g = grid()) => { const n = (t - g.downbeat) / (8 * 4 * g.period); near(n, Math.round(n), 1e-6); };

// ---- phraseMix: the pure plan ---------------------------------------------------------------

test('with a known downbeat the mix starts on a phrase line, lasts whole bars and ends as a phrase ends', () => {
  const g = grid();
  const plan = phraseMix({ grid: g, dur: 201, now: 170, rate: 1 });
  assert.equal(plan.bars, 8);
  near(plan.span, 8 * BAR);
  onLine(plan.at);
  near(plan.at, g.downbeat + 12 * LINE);                  // 183.85
  assert.ok(plan.at + plan.span <= 201.3 && 201 - (plan.at + plan.span) < 3, 'ends with the song, within the last bar or two');
  assert.ok(plan.at >= 170 + PHRASE_LEAD, 'the next song gets its look-ahead');
});

test('a known outro starts the mix at the phrase where the drums leave', () => {
  const g = grid();
  const plan = phraseMix({ grid: g, dur: 201, now: 160, rate: 1, outroStart: 169 });
  onLine(plan.at);
  near(plan.at, g.downbeat + 11 * LINE);                  // 168.85: the line next to 169, not the later one
  assert.equal(plan.bars, 8);
  const late = phraseMix({ grid: g, dur: 201, now: 160, rate: 1, outroStart: 183 });
  near(late.at, g.downbeat + 12 * LINE);
});

test('the learned length picks 8, 16 or 32 whole bars that fit the longest mix', () => {
  const fast = grid(175);
  assert.equal(phraseMix({ grid: fast, dur: 240, now: 200, factor: 1 }).bars, 16, '16 bars is 22 s at 175 BPM');
  assert.equal(phraseMix({ grid: fast, dur: 240, now: 200, factor: 0.5 }).bars, 8);
  assert.equal(phraseMix({ grid: grid(120), dur: 240, now: 200, factor: 1 }).bars, 8, '16 bars would be 32 s at 120 BPM: too long');
  // a very slow song only fits 4 bars in the longest mix: that still counts as a phrase
  const slow = phraseMix({ grid: grid(60), dur: 240, now: 200 });
  assert.equal(slow.bars, 4);
  assert.ok(slow.span <= 24);
  // a faster playback speed measures the same bars in media seconds
  const rate = phraseMix({ grid: grid(128), dur: 240, now: 200, rate: 1.25 });
  near(rate.span, rate.bars * BAR);
  assert.ok(rate.span <= 24 * 1.25 + 1e-6);
});

test('it falls back to beat-aligned timing when bars are not known or the phrase does not fit', () => {
  assert.equal(phraseMix({ grid: grid(128, { phrase: false }), dur: 201, now: 170 }), null, 'no downbeat heard');
  assert.equal(phraseMix({ grid: null, dur: 201, now: 170 }), null);
  assert.equal(phraseMix({ grid: grid(128, { confidence: 0.3 }), dur: 201, now: 170 }), null, 'a shaky beat cannot carry bar lines');
  assert.equal(phraseMix({ grid: grid(128, { downbeat: NaN }), dur: 201, now: 170 }), null);
  // too short a song: no whole phrase fits in the last quarter
  assert.equal(phraseMix({ grid: grid(), dur: 40, now: 20 }), null);
  // too late: the next song could not be listened to before the mix would begin
  assert.equal(phraseMix({ grid: grid(), dur: 201, now: 190 }), null);
  // a song that ends far from any phrase of its own would lose most of a phrase
  const odd = grid(128, { downbeat: 0.1 + 8 * PERIOD + 7 * BAR });
  const plan = phraseMix({ grid: odd, dur: 201 + 5 * BAR, now: 170 });
  assert.ok(plan === null || 201 + 5 * BAR - (plan.at + plan.span) <= LINE);
});

test('a start is never more than a quarter of the song from the end', () => {
  for (const dur of [90, 120, 201, 305]) {
    const plan = phraseMix({ grid: grid(), dur, now: dur * 0.7 - 20 });
    if (plan) assert.ok(plan.at >= dur * 0.75 - 1e-6, `${dur}: ${plan.at}`);
  }
});

// ---- the incoming song: bar 1 meets bar 1 -----------------------------------------------------

test('known downbeats line the incoming song up on the bar as well as the beat', () => {
  const out = { bpm: 120, period: 0.5, offset: 10, downbeat: 10, confidence: 0.9, phrase: true };
  const into = { bpm: 120, period: 0.5, offset: 0.2, downbeat: 3, confidence: 0.9, phrase: true };
  const match = matchTempo(out, into);
  assert.equal(match.bars, true);
  // the outgoing song is 3.625 bars after its downbeat: the incoming enters 0.625 of a bar after its own bar line
  const start = alignedStart(match, 10 + 7.25, 3);
  near(start, 3 + 0.625 * 2);
  near(((start - 3) / 2) % 1, 0.625);
  // exactly on the outgoing bar line: it starts on its own bar line
  near(alignedStart(match, 10 + 4 * 2, 3 + 2 * 2), 3 + 2 * 2);
  // without bar information the old beat-only alignment is unchanged
  const beatOnly = matchTempo({ ...out, phrase: false }, { ...into, phrase: false });
  assert.equal(beatOnly.bars, undefined);
  near(alignedStart(beatOnly, 10 + 7.25, 3), 3.25);
  // a half/double-time match changes the beat length: only the beat is aligned
  const half = matchTempo({ ...out, bpm: 120, period: 0.5 }, { ...into, bpm: 60, period: 1 });
  assert.equal(half.bars, undefined);
});

test('a memory grid marks a heard downbeat, and only that', () => {
  const entry = { bpm: 128, period: PERIOD, offset: 0.1, confidence: 0.9, downbeat: 3.85 };
  assert.equal(memoryGrid(entry).phrase, true);
  assert.equal(memoryGrid({ ...entry, downbeat: null }).phrase, undefined);
  assert.equal(memoryGrid({ ...entry, downbeat: null }).downbeat, 0.1, 'the first beat line is only a stand-in');
});

// ---- the player ------------------------------------------------------------------------------

function fixture(t, { downbeat = true } = {}) {
  let id = 0;
  const timers = new Map(), calls = [];
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal';
  settings.autoMix = true; settings.transitionStyle = 'blend';
  const p = new player.constructor();
  t.after(() => { p.fading = null; p.lock = null; p.tempoRelease = null; });
  cues._reset(); mixmemory.reset(); mixlearn.reset();
  const from = { id: 31, title: 'Outgoing', duration: 201000 };
  const to = { id: 32, title: 'Incoming', duration: 201000 };
  p.queue = [from, to]; p.index = 0; p.active = 0; p.loadId = 2;
  const [outgoing, incoming] = p.decks;
  for (const deck of p.decks) {
    Object.assign(deck.audio, { readyState: 4, paused: false, seeking: false, duration: 201, playbackRate: 1, currentTime: 0,
      buffered: { length: 1, start: () => 0, end: () => 201 },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}, load() {} });
  }
  outgoing.track = from; incoming.track = to;
  p.normalizer = { ctx: { currentTime: 10 }, effect: false,
    addDeck: () => true, startDropCut() { return true; }, clearDropCut() {}, clearEchoOut() {},
    setFade() {}, fadeDeck() {}, holdBass(...a) { calls.push(['hold', ...a]); },
    swapBass(...a) { calls.push(['swap', ...a]); }, setActive() {}, startTrack() {}, holdFade() {}, setEqualizer() {} };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  t.mock.method(p, 'startListening', () => {});
  t.mock.method(p, 'notify', () => {});
  t.mock.method(p.beats, 'grid', () => null);
  const g = grid();
  mixmemory.learn(from.id, { grid: { ...g, downbeat: downbeat ? g.downbeat : undefined } });
  return { p, from, to, outgoing, incoming, calls, timers, g };
}

const prepare = (p, to, incoming, gridIn) => p.prepared = { loadId: p.loadId, from: 0, auto: true, track: to, stream: { track: {} },
  preroll: { deck: incoming, track: to, done: true, grid: gridIn, startAt: 0 }, wrap: false };

test('Auto mix plans the blend on the outgoing song\'s phrase and says so in the feed', t => {
  const { p, outgoing, g } = fixture(t);
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.bars, 8);
  near(plan.span, 8 * BAR);
  near(plan.at, g.downbeat + 12 * LINE, 1e-6);
  assert.match(p.mixLog[0].text, /15\.0 s \(32 beats\), on the phrase: 8 bars/);
  // the mix start is the bar line, not "span before the end"
  assert.notEqual(plan.at, 201 - plan.span);
  assert.equal(p.planMix(outgoing.audio, 201), plan, 'the plan stays put once made');
});

test('checkCrossfade starts the planned blend on the bar line', t => {
  const { p, to, incoming, outgoing, g } = fixture(t);
  p.audio.currentTime = 175;
  prepare(p, to, incoming, grid());
  p.checkCrossfade();
  near(p.mixAt.at, g.downbeat + 12 * LINE, 1e-6);
  assert.equal(p.fading, null, 'not yet: 8.85 s to go');
  p.audio.currentTime = g.downbeat + 12 * LINE + 0.05;
  p.checkCrossfade();
  assert.ok(p.fading, 'the mix begins on the bar line');
  near(p.fading.seconds, 8 * BAR);
  assert.equal(p.fading.bass, true);
  assert.ok(outgoing.audio.currentTime + p.fading.seconds < 201.3, 'and it ends before the song does');
});

test('without a remembered downbeat the old beat-aligned timing stands', t => {
  const { p, outgoing } = fixture(t, { downbeat: false });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.at, null);
  assert.equal(plan.bars, 0);
  near(plan.span, 32 * PERIOD);
  assert.doesNotMatch(p.mixLog[0].text, /phrase/);
  p.audio.currentTime = 170;
  p.checkCrossfade();
  near(p.mixAt.at, 201 - plan.span, 1e-6);
});

test('custom mix points and pair overrides win over automatic phrase timing', t => {
  const { p, from, to, incoming } = fixture(t);
  cues.setPair(from.id, to.id, { out: 150, in: 5 });
  p.audio.currentTime = 148;
  prepare(p, to, incoming, grid());
  p.checkCrossfade();
  assert.equal(p.mixAt.at, 150, 'its own mix-out point');
  assert.equal(p.mixPlan, null, 'no automatic plan was made');
});

test('the incoming song enters bar 1 at its phrase: its drums arrive as the mix swaps over', t => {
  const { p, from, to, outgoing } = fixture(t);
  const gIn = grid(128, { offset: 0.1, downbeat: 0.1 + 40 * PERIOD });             // drums at 18.85 s
  mixmemory.learn(to.id, { grid: { ...gIn, phrase: undefined }, drumsIn: 18.9 });
  p.audio.currentTime = 170;
  p.mixPlan = p.planMix(outgoing.audio, 201);
  const start = p.autoStartAt(to, 0);
  // half the 8-bar mix is 4 bars: the incoming starts 4 bars before its downbeat
  near(start, gIn.downbeat - 4 * BAR, 1e-6);
  near((gIn.downbeat - start) / BAR, 4, 1e-6);
  // a known cue-in still wins
  assert.equal(p.autoStartAt(to, 12), 12);
  // not enough song before the downbeat: fewer whole bars, never negative
  const early = grid(128, { offset: 0.1, downbeat: 0.1 + 6 * PERIOD });
  mixmemory.learn(from.id + 100, { grid: { ...early, phrase: undefined }, drumsIn: 5 });
  const third = { id: from.id + 100, title: 'Third', duration: 201000 };
  p.queue.push(third);
  const s2 = p.autoStartAt(third, 0);
  assert.ok(s2 >= 0);
  near(((early.downbeat - s2) / BAR) % 1, 0, 1e-6);
  // without a heard downbeat the intro start is only beat-aligned, as before
  mixmemory.learn(to.id + 1, { grid: { ...gIn, downbeat: undefined, phrase: undefined }, drumsIn: 18.9 });
  const plain = { id: to.id + 1, title: 'Plain', duration: 201000 };
  p.queue.push(plain);
  const s3 = p.autoStartAt(plain, 0);
  near(((s3 - 0.1) / PERIOD) % 1, 0, 1e-6);
  assert.ok(Math.abs(s3 - (18.9 - 7.5)) < PERIOD);
});

test('the incoming song is bar-aligned with the outgoing one when both downbeats are known', t => {
  const { p, to, incoming, outgoing, g } = fixture(t);
  const gIn = grid(128, { offset: 0.1, downbeat: 0.1 + 40 * PERIOD });
  mixmemory.learn(to.id, { grid: { ...gIn, phrase: undefined }, drumsIn: 18.9 });
  p.audio.currentTime = 170;
  p.mixPlan = p.planMix(outgoing.audio, 201);
  // the heard grid of the pre-played song has no bar information of its own
  const heard = { bpm: 128, period: PERIOD, offset: 0.1 + 3 * PERIOD + 0.004, confidence: 0.8 };
  prepare(p, to, incoming, heard);
  const startAt = p.autoStartAt(to, 0);
  p.prepared.preroll.startAt = startAt;
  p.beats.grid.mock.mockImplementation(() => ({ bpm: 128, period: PERIOD, offset: g.downbeat + 5 * LINE + 0.002, confidence: 0.9 }));
  outgoing.audio.currentTime = g.downbeat + 12 * LINE + 0.1;
  p.startCrossfade();
  assert.ok(p.fading);
  // the incoming song's time is on its own bar line when the outgoing song is on its bar line (plus the 0.1 s elapsed)
  const bars = (incoming.audio.currentTime - gIn.downbeat) / BAR;
  near(bars - Math.round(bars), 0.1 / BAR, 0.01);
  assert.match(p.mixLog.find(e => /Smooth blend into/.test(e.text)).text, /beats matched to the bar/);
});

test('the blend passes the learned DJ-blend amount to the mid and high EQ, and pausing, cutting and finishing flatten it', t => {
  const { p, to, incoming, outgoing, g, calls } = fixture(t);
  p.audio.currentTime = 170;
  p.mixPlan = p.planMix(outgoing.audio, 201);
  p.mixPlan.choice = { ...p.mixPlan.choice, params: { ...p.mixPlan.choice.params, dj: 0.6 } };
  prepare(p, to, incoming, grid());
  outgoing.audio.currentTime = g.downbeat + 12 * LINE;
  p.startCrossfade();
  const f = p.fading;
  assert.deepEqual(f.bassOpts, { eq: 0.6 });
  assert.deepEqual(f.shapeIn, { dj: 0.6 });
  assert.deepEqual(calls.filter(c => c[0] === 'hold').map(c => c.at(-1)), [{ eq: 0.6 }, { eq: 0.6 }], 'both decks start the blend at its first moment');
  incoming.audio.dispatchEvent({ type: 'playing' });
  assert.deepEqual(calls.filter(c => c[0] === 'swap').map(c => c.at(-1)), [{ eq: 0.6 }, { eq: 0.6 }]);
  // paused half way: both decks hold their EQ at that progress
  p.normalizer.ctx.currentTime += f.seconds / 2;
  p.holdFade();
  const held = calls.filter(c => c[0] === 'hold').slice(-2);
  // the call is ['hold', audio, fadeIn, progress, width, opts]
  assert.ok(f.progress > 0.45 && f.progress < 0.55);
  assert.deepEqual(held.map(c => c[3]), [f.progress, f.progress]);
  assert.deepEqual(held.map(c => c.at(-1)), [{ eq: 0.6 }, { eq: 0.6 }]);
  // skipped mid-mix: both decks go back to flat
  p.cutFade();
  assert.equal(p.fading, null);
  const flat = calls.filter(c => c[0] === 'hold').slice(-2);
  assert.deepEqual(flat.map(c => c[3]), [null, null]);
});

test('a blend of plain volume (no learned DJ amount) keeps the mid and high bands out of it', t => {
  const { p, to, incoming, outgoing, g } = fixture(t);
  p.audio.currentTime = 170;
  p.mixPlan = p.planMix(outgoing.audio, 201);
  p.mixPlan.choice = { ...p.mixPlan.choice, params: { ...p.mixPlan.choice.params, dj: 0 } };
  prepare(p, to, incoming, grid());
  outgoing.audio.currentTime = g.downbeat + 12 * LINE;
  p.startCrossfade();
  assert.deepEqual(p.fading.bassOpts, { eq: 0 });
});
