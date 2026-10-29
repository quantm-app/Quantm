import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import * as mixmemory from '../src/js/mixmemory.js';
import * as mixlearn from '../src/js/mixlearn.js';
import * as mixorder from '../src/js/mixorder.js';
import { ChromaAccumulator, estimateKey } from '../src/js/keys.js';
import { BeatWatcher, KeyListener, phraseMix, shortenForClash, CLASH_MIN_SECONDS } from '../src/js/automix.js';
import { planStyle } from '../src/js/dropcut.js';

installBrowser();
// the settings view builds its live rows with replaceChildren, which the shared DOM fake lacks
Element.prototype.replaceChildren ??= function (...nodes) {
  for (const child of this.childNodes.slice()) this.removeChild(child);
  this.append(...nodes);
};
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings } = await import('../src/js/store.js');
const cues = await import('../src/js/cues.js');
const { render: renderSettings } = await import('../src/js/views/settings.js');
const { h } = await import('../src/js/dom.js');
startup.mock.restore();

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---- synthetic spectra: partials of the given MIDI notes, the way the analyser reports them (dB) ----------
const SAMPLE_RATE = 44100, FFT = 8192;
function spectrum(notes, { gain = 1 } = {}) {
  const energy = new Float64Array(FFT / 2).fill(1e-12);
  for (const note of notes) {
    const frequency = 440 * 2 ** ((note - 69) / 12);
    for (let harmonic = 1; harmonic <= 5; harmonic++) {
      const bin = frequency * harmonic * FFT / SAMPLE_RATE;
      for (let i = Math.max(1, Math.floor(bin) - 2); i <= Math.min(energy.length - 1, Math.ceil(bin) + 2); i++) {
        energy[i] += gain * 0.01 / harmonic ** 2 * Math.exp(-(((i - bin) / 0.55) ** 2));
      }
    }
  }
  return Float32Array.from(energy, value => 10 * Math.log10(value));
}
const A_MINOR = [57, 59, 60, 62, 64, 65, 67, 57, 64];                 // A B C D E F G, and the tonic's fifth
const C_SHARP_MAJOR = [61, 63, 65, 66, 68, 70, 72, 61, 68];           // far round the wheel from A minor: 3B vs 8A
const SILENT = new Float32Array(FFT / 2).fill(-160);
const A_MINOR_DB = spectrum(A_MINOR);

/** What a finished listen would remember for a song in these notes (keys.js estimate plus its chroma) */
function heard(notes) {
  const acc = new ChromaAccumulator({ sampleRate: SAMPLE_RATE, fftSize: FFT });
  const frame = spectrum(notes);
  for (let i = 0; i < 60; i++) acc.add(frame);
  const chroma = acc.chroma();
  return { ...estimateKey(chroma), chroma: Array.from(chroma, v => Math.round(v * 10000) / 10000) };
}

// the Web Audio side, faked: a deck whose spectrum is whatever `playing` says
const fakeNorm = (playing = { db: A_MINOR_DB }) => ({
  calls: 0,
  playing,
  beatEnergy: () => ({ low: 0.3, high: 0.1, full: 0.2 }),
  spectrum() { this.calls++; return { db: this.playing.db, sampleRate: SAMPLE_RATE, fftSize: FFT }; }
});
const deckAudio = (extra = {}) => ({ paused: false, seeking: false, muted: false, currentTime: 0, duration: 120, ...extra });

// ---- chroma feeding -----------------------------------------------------------------------------------------

test('the key listener takes a spectrum a few times a second, only from the middle of a playing song, and finds the key after enough music', () => {
  const norm = fakeNorm(), audio = deckAudio(), listener = new KeyListener({ duration: 120 });
  let taken = 0, early = 'unset';
  for (let step = 0; step <= 5000; step++) {
    const t = step * 0.02;
    audio.currentTime = t;
    if (listener.sample(audio, norm)) taken++;
    if (step === 1250) early = listener.estimate(); // 25 s in: 15 s of music
  }
  assert.equal(early, null, 'under 30 s of music: not trusted yet');
  assert.equal(norm.calls, taken);
  assert.ok(taken <= (100 - 10) / 0.15 + 2, `about 6 per second, not every poll: ${taken}`);
  assert.ok(taken >= 500, 'but it keeps up');
  const found = listener.estimate();
  assert.equal(found.camelot, '8A');
  assert.equal(found.name, 'A minor');
  assert.equal(found.chroma.length, 12);
  // refined as the song plays: cached between frames
  assert.equal(listener.estimate(), found);
});

test('the first and last ten seconds, pauses, seeks, a muted deck and silence are never sampled', () => {
  const norm = fakeNorm(), audio = deckAudio(), listener = new KeyListener({ duration: 120 });
  for (const [t, extra] of [[3, {}], [9.9, {}], [111, {}], [60, { paused: true }], [60, { seeking: true }], [60, { muted: true }]]) {
    Object.assign(audio, { paused: false, seeking: false, muted: false, currentTime: t }, extra);
    assert.equal(listener.sample(audio, norm), false, `t=${t} ${JSON.stringify(extra)}`);
  }
  assert.equal(norm.calls, 0, 'the analyser is not even read');
  // a deck that is playing silence yields frames that count for nothing
  const quiet = fakeNorm({ db: SILENT }), silent = new KeyListener({ duration: 120 });
  Object.assign(audio, { paused: false, seeking: false, muted: false });
  for (let t = 10; t <= 100; t += 0.05) { audio.currentTime = t; silent.sample(audio, quiet); }
  assert.ok(quiet.calls > 400);
  assert.equal(silent.estimate(), null, 'no key from silence');
  // an unknown length only skips the intro
  const open = new KeyListener();
  audio.currentTime = 500;
  assert.equal(open.sample(audio, norm), true);
});

test('a normalizer without a spectrum, or a missing deck graph, is simply skipped', () => {
  const listener = new KeyListener({ duration: 120 }), audio = deckAudio({ currentTime: 40 });
  assert.equal(listener.sample(audio, {}), false);
  assert.equal(listener.sample(audio, { spectrum: () => null }), false);
  assert.equal(listener.estimate(), null);
});

test('the beat watcher feeds the key listener from its own poll and stops with unwatch', t => {
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const norm = fakeNorm(), watcher = new BeatWatcher(norm), audio = deckAudio(), listener = new KeyListener({ duration: 120 });
  watcher.watch(audio);
  watcher.listenForKey(audio, listener);
  for (let time = 10; time <= 60; time += 0.05) { audio.currentTime = time; watcher.poll(); }
  assert.equal(listener.estimate()?.camelot, '8A');
  const calls = norm.calls;
  watcher.unwatch(audio);
  watcher.watch(audio);
  audio.currentTime = 70;
  watcher.poll();
  assert.equal(norm.calls, calls, 'a deck that is no longer being listened to is not read');
  // a watcher whose normalizer has no spectrum() (older fakes) still polls
  const plain = new BeatWatcher({ beatEnergy: () => ({ low: 1, high: 0, full: 1 }) });
  plain.watch(audio);
  plain.listenForKey(audio, new KeyListener());
  audio.currentTime = 80;
  plain.poll();
  assert.equal(plain.heard(audio), 0);
});

// ---- the song memory ----------------------------------------------------------------------------------------

test('mixmemory remembers a heard key compactly, refines it on later plays and still loads entries without one', () => {
  mixmemory.reset();
  const grid = { period: 0.5, offset: 0.1, confidence: 0.8 };
  mixmemory.learn('song', { grid, key: heard(A_MINOR) });
  const entry = mixmemory.get('song');
  assert.equal(entry.key.tonic, 9);
  assert.equal(entry.key.mode, 'minor');
  assert.equal(entry.key.chroma.length, 12);
  assert.ok(entry.key.confidence > 0.3);
  const stored = JSON.parse(localStorage.getItem('quantm.mixmemory')).song;
  assert.equal(stored.key.chroma.length, 12);
  assert.ok(stored.key.chroma.every(v => Number.isFinite(v) && String(v).length <= 8), 'rounded numbers');
  // a play that heard nothing keeps the key; one that heard it again keeps it and refines it
  mixmemory.learn('song', { grid });
  assert.equal(mixmemory.get('song').key.tonic, 9);
  mixmemory.learn('song', { grid, key: heard(A_MINOR) });
  assert.equal(mixmemory.get('song').key.camelot, undefined, 'only what keys.js needs is stored');
  assert.equal(mixmemory.get('song').key.mode, 'minor');
  assert.equal(mixmemory.get('song').plays, 3);
  // a drop confirmed later does not lose it
  mixmemory.rememberDrop('song', { grid: { ...grid, bpm: 120 }, drop: { time: 60, confidence: 1 } });
  assert.equal(mixmemory.get('song').key.tonic, 9);
  // entries written before key detection load, and learn fine
  localStorage.setItem('quantm.mixmemory', JSON.stringify({ old: { bpm: 120, period: 0.5, offset: 0.1, confidence: 0.8, plays: 2, updated: 5 } }));
  assert.equal(mixmemory.get('old').key, null);
  assert.equal(mixmemory.get('old').plays, 2);
  mixmemory.learn('old', { grid, key: heard(C_SHARP_MAJOR) });
  assert.equal(mixmemory.get('old').key.mode, 'major');
  // junk keys are ignored rather than trusted
  localStorage.setItem('quantm.mixmemory', JSON.stringify({ bad: { plays: 1, updated: 1, key: { tonic: 14, mode: 'dorian', chroma: [1] } } }));
  assert.equal(mixmemory.get('bad').key, null);
  assert.equal(mixmemory.keyEstimate(null), null);
  mixmemory.reset();
});

// ---- Mix order and Autoplay ---------------------------------------------------------------------------------

const withKey = (tonic, mode, confidence = 0.8, bpm = 124) => ({ id: `${tonic}${mode}`, bpm, bpmSource: 'memory', bpmConfidence: 0.9, key: { tonic, mode, confidence } });
const A_MIN = withKey(9, 'minor');

test('features carry the remembered key and ignore a malformed one', () => {
  const f = mixorder.features({ id: 1 }, { memory: { bpm: 124, confidence: 0.9, key: { tonic: 9, mode: 'minor', confidence: 0.7, chroma: [1] } } });
  assert.deepEqual(f.key, { tonic: 9, mode: 'minor', confidence: 0.7 });
  assert.equal(mixorder.features({ id: 1 }, { memory: { bpm: 124, key: { tonic: 12, mode: 'minor' } } }).key, undefined);
  assert.equal(mixorder.features({ id: 1 }, { memory: { bpm: 124, key: null } }).key, undefined);
  assert.equal(mixorder.features({ id: 1 }).key, undefined);
});

test('blendCost: matching keys beat unknown, unknown beats a key lift, a lift beats a clash', () => {
  const cost = b => mixorder.blendCost(A_MIN, b).cost;
  const unknown = { ...withKey(0, 'major'), key: undefined };
  const same = cost(withKey(9, 'minor')), relative = cost(withKey(0, 'major')), neighbor = cost(withKey(4, 'minor'));
  const lift = cost(withKey(11, 'minor')), clash = cost(withKey(1, 'major'));
  const none = cost(unknown);
  assert.ok(same <= relative + 1e-9 && relative <= neighbor + 1e-9, 'same is best');
  assert.ok(Math.max(same, relative, neighbor) < none, 'compatible keys earn a bonus');
  assert.ok(none < lift, 'an energy-boost key change costs a little');
  assert.ok(lift < clash, 'a clash costs clearly more');
  assert.ok(clash - none > 0.2 && lift - none < 0.15);
  // unknown on either side changes nothing, whatever the other key is
  assert.equal(mixorder.blendCost({ ...A_MIN, key: undefined }, withKey(1, 'major')).cost, none);
  assert.equal(mixorder.blendCost(A_MIN, withKey(1, 'major', 0.05)).cost, none, 'a guess is not a key');
  const reasons = b => mixorder.blendCost(A_MIN, b).reasons;
  assert.ok(reasons(withKey(4, 'minor')).includes('keys match'));
  assert.ok(reasons(withKey(1, 'major')).includes('key clash'));
  assert.ok(reasons(withKey(11, 'minor')).includes('key lift'));
  assert.ok(!reasons(unknown).some(r => /key/.test(r)));
  // a shaky reading counts for less than a sure one
  assert.ok(mixorder.blendCost(A_MIN, withKey(1, 'major', 0.2)).cost < clash);
});

test('tempo still matters most: a clash at the same tempo beats a matching key across a big tempo jump', () => {
  const clashSameTempo = mixorder.blendCost(A_MIN, withKey(1, 'major', 0.9, 124)).cost;
  const matchBigJump = mixorder.blendCost(A_MIN, withKey(9, 'minor', 0.9, 124 * 1.15)).cost;
  assert.ok(clashSameTempo < matchBigJump, `${clashSameTempo} vs ${matchBigJump}`);
  // and a clash costs no more than the stretch of a 7.5% tempo change
  const unknown = { ...withKey(1, 'major'), key: undefined };
  assert.ok(clashSameTempo - mixorder.blendCost(A_MIN, unknown).cost <= 0.3 + 1e-9);
});

test('Mix order and Autoplay pick harmonic neighbors', () => {
  const clash = { ...withKey(1, 'major'), id: 'clash' }, neighbor = { ...withKey(4, 'minor'), id: 'neighbor' }, other = { ...withKey(2, 'major'), id: 'other' };
  const order = mixorder.orderForMixing([A_MIN, clash, neighbor], { random: () => 0 });
  assert.deepEqual(order.slice(0, 2), [0, 2], 'the neighbor comes first');
  assert.equal(mixorder.pickNext(A_MIN, [clash, other, neighbor], { random: () => 0, count: 3 })[0], 2);
});

test('keyRelation reports the relation, the Camelot codes and whether it is firm enough to act on', () => {
  const r = mixorder.keyRelation(A_MIN, withKey(1, 'major', 0.8));
  assert.equal(r.relation, 'clash');
  assert.equal(r.clash, true);
  assert.equal(r.sure, true);
  assert.equal(r.from, '8A');
  assert.equal(r.to, '3B');
  assert.equal(mixorder.keyRelation(A_MIN, withKey(1, 'major', 0.25)).sure, false);
  assert.equal(mixorder.keyRelation(A_MIN, withKey(1, 'major', 0.25)).clash, true);
  assert.equal(mixorder.keyRelation(A_MIN, withKey(4, 'minor')).clash, false);
  assert.equal(mixorder.keyRelation(A_MIN, null).relation, 'unknown');
  assert.equal(mixorder.keyRelation(A_MIN, withKey(1, 'major', 0.05)).relation, 'unknown');
});

// ---- hiding a clash in the transition ----------------------------------------------------------------------

const grid = (bpm = 128, extra = {}) => ({ bpm, period: 60 / bpm, offset: 0.1, downbeat: 0.1 + 8 * 60 / bpm, confidence: 0.9, phrase: true, ...extra });

test('clashing keys halve a phrase blend, down to eight bars', () => {
  const g = grid(175), bar = 4 * g.period;
  const phrase = phraseMix({ grid: g, dur: 240, now: 200, factor: 1 });
  assert.equal(phrase.bars, 16);
  const shorter = shortenForClash({ span: phrase.span, phrase, grid: g, dur: 240, now: 200, factor: 1 });
  assert.equal(shorter.phrase.bars, 8);
  near(shorter.span, 8 * bar);
  assert.equal(shorter.phrase.span, shorter.span);
  assert.ok(240 - (shorter.phrase.at + shorter.span) < 8 * bar + 1, 'still ends with the song');
  // 8 bars is already the floor
  const eight = phraseMix({ grid: grid(128), dur: 201, now: 170 });
  assert.equal(eight.bars, 8);
  assert.equal(shortenForClash({ span: eight.span, phrase: eight, grid: grid(128), dur: 201, now: 170 }), null);
});

test('without phrase timing a clash halves the blend to whole bars, never under about eight seconds', () => {
  const g = grid(128, { phrase: false }), bar = 4 * g.period;
  const half = shortenForClash({ span: 32 * g.period, phrase: null, grid: g, dur: 201, now: 170 });
  assert.equal(half.phrase, null);
  near(half.span / bar, Math.round(half.span / bar), 1e-9);
  assert.ok(half.span < 32 * g.period && half.span >= CLASH_MIN_SECONDS);
  const floored = shortenForClash({ span: 12, phrase: null, grid: g, dur: 201, now: 170 });
  assert.ok(floored === null || floored.span >= CLASH_MIN_SECONDS);
  assert.equal(shortenForClash({ span: 8, phrase: null, grid: null, dur: 201, now: 170 }), null, 'already short');
  near(shortenForClash({ span: 20, phrase: null, grid: null, dur: 201, now: 170 }).span, 10);
  // faster playback measures the floor in media seconds
  near(shortenForClash({ span: 40, phrase: null, grid: null, dur: 201, now: 170, rate: 1.25 }).span, 20);
});

test('Auto takes a drop cut for a clashing pair that has a confirmed drop, whatever the genre', () => {
  const drop = { time: 60, confidence: 0.9 }, plain = [{ genre: 'folk' }, { genre: 'folk' }];
  assert.equal(planStyle({ style: 'auto', drop, features: plain }).style, 'blend');
  const plan = planStyle({ style: 'auto', drop, features: plain, clash: true });
  assert.equal(plan.style, 'dropcut');
  assert.match(plan.reason, /Keys clash/);
  // it still needs a confirmed drop and a ready song; Smooth blend stays a blend; a learned dislike still wins
  assert.equal(planStyle({ style: 'auto', drop: null, features: plain, clash: true }).style, 'blend');
  assert.equal(planStyle({ style: 'auto', drop, features: plain, clash: true, ready: false }).style, 'blend');
  assert.equal(planStyle({ style: 'blend', drop, features: plain, clash: true }).style, 'blend');
  assert.equal(planStyle({ style: 'auto', drop, features: plain, clash: true, rejected: true }).style, 'blend');
  assert.doesNotMatch(planStyle({ style: 'dropcut', drop, clash: true }).reason, /Keys clash/);
});

// ---- the player ----------------------------------------------------------------------------------------------

function fixture(t, { downbeat = true, bpm = 128, outKey = A_MINOR, inKey = C_SHARP_MAJOR } = {}) {
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
  p.beats.norm = p.normalizer = { ctx: { currentTime: 10, sampleRate: SAMPLE_RATE }, effect: false,
    addDeck: () => true, startDropCut() { return true; }, clearDropCut() {}, clearEchoOut() {},
    setFade() {}, fadeDeck() {}, holdBass(...a) { calls.push(['hold', ...a]); },
    swapBass(...a) { calls.push(['swap', ...a]); }, setActive() {}, startTrack() {}, holdFade() {}, setEqualizer() {},
    beatEnergy: () => ({ low: 0.3, high: 0.1, full: 0.2 }),
    spectrum: () => ({ db: A_MINOR_DB, sampleRate: SAMPLE_RATE, fftSize: FFT }) };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  t.mock.method(p, 'notify', () => {});
  const g = grid(bpm);
  mixmemory.learn(from.id, { grid: { ...g, downbeat: downbeat ? g.downbeat : undefined }, key: outKey ? heard(outKey) : undefined });
  mixmemory.learn(to.id, { grid: g, key: inKey ? heard(inKey) : undefined });
  return { p, from, to, outgoing, incoming, calls, timers, g };
}
const prepare = (p, to, incoming, gridIn, extra = {}) => p.prepared = { loadId: p.loadId, from: 0, auto: true, track: to, stream: { track: {} },
  preroll: { deck: incoming, track: to, done: true, grid: gridIn, startAt: 0, ...extra }, wrap: false };

test('the player keeps the song\'s key from what it hears while it plays, and remembers it when the song ends', t => {
  const { p, from, outgoing } = fixture(t, { outKey: null, inKey: null });
  t.mock.method(p.beats, 'grid', () => null);
  assert.equal(mixmemory.get(from.id).key, null);
  p.startListening(outgoing.audio, from);
  assert.ok(p.beats.isWatching(outgoing.audio));
  assert.ok(p.beats.keys.has(outgoing.audio), 'the key listener is attached to the deck');
  assert.equal(p.keyOf(from), null, 'nothing yet');
  for (let time = 0; time <= 100; time += 0.05) { outgoing.audio.currentTime = time; p.beats.poll(); }
  assert.equal(p.keyHeard(from).camelot, '8A', 'known while the song is still playing');
  assert.equal(p.keyOf(from).tonic, 9);
  assert.equal(p.autoMixStatus().key.camelot, '8A');
  p.stopListening(outgoing.audio);
  const stored = mixmemory.get(from.id);
  assert.equal(stored.key.tonic, 9);
  assert.equal(stored.key.mode, 'minor');
  assert.match(p.mixLog[0].text, /key A minor \(8A\)/);
  assert.equal(p.mixFeatures(from).key.mode, 'minor', 'and Mix order sees it');
});

test('a song that played in silence, or only briefly, leaves no key behind', t => {
  const { p, from, outgoing } = fixture(t, { outKey: null, inKey: null });
  p.normalizer.spectrum = () => ({ db: SILENT, sampleRate: SAMPLE_RATE, fftSize: FFT });
  p.startListening(outgoing.audio, from);
  for (let time = 0; time <= 100; time += 0.05) { outgoing.audio.currentTime = time; p.beats.poll(); }
  p.stopListening(outgoing.audio);
  assert.equal(mixmemory.get(from.id).key, null);
  p.normalizer.spectrum = () => ({ db: A_MINOR_DB, sampleRate: SAMPLE_RATE, fftSize: FFT });
  p.startListening(outgoing.audio, from);
  for (let time = 0; time <= 20; time += 0.05) { outgoing.audio.currentTime = time; p.beats.poll(); }
  p.stopListening(outgoing.audio);
  assert.equal(mixmemory.get(from.id).key, null, 'ten seconds of music is not enough');
});

test('a clash shortens the planned phrase blend, says so in the feed, and tightens the bass and mid hand-over', t => {
  // a pair whose keys agree, as the baseline (the memory is shared, so it plays out before the clashing pair is set up)
  const calm = fixture(t, { bpm: 175, inKey: A_MINOR });
  calm.p.audio.currentTime = 170;
  const normal = calm.p.planMix(calm.outgoing.audio, 201);
  assert.equal(normal.bars, 16);
  assert.equal(normal.clash, null);
  assert.ok(!calm.p.mixLog.some(e => /clash/i.test(e.text)));
  calm.p.audio.currentTime = normal.at + 0.05;
  prepare(calm.p, calm.to, calm.incoming, grid(175));
  calm.p.checkCrossfade();
  assert.ok(calm.p.fading, 'the matching pair mixes');
  const calmHandOver = calm.p.fading.bassWidth * calm.p.fading.seconds;
  assert.equal(calm.p.fading.bassOpts.eq, calm.p.mixPlan.choice.params.dj, 'the learned DJ-blend amount, unchanged');

  const { p, to, incoming, outgoing, calls } = fixture(t, { bpm: 175 });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.bars, 8, 'half of 16 bars');
  assert.ok(plan.span < normal.span);
  assert.deepEqual(plan.clash, { from: '8A', to: '3B', shortened: true });
  assert.ok(p.mixLog.some(e => /Keys clash \(8A → 3B\): shorter blend/.test(e.text)), p.mixLog.map(e => e.text).join(' | '));
  assert.equal(p.planMix(outgoing.audio, 201), plan, 'the plan stays put');
  assert.equal(p.mixLog.filter(e => /clash/i.test(e.text)).length, 1, 'said once');
  // the mix itself: shorter fade, quicker bass swap and the full mid/high move
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = plan.at + 0.05;
  p.checkCrossfade();
  assert.ok(p.fading, 'it begins on the bar line');
  near(p.fading.seconds, plan.span);
  assert.equal(p.fading.bassOpts.eq, 1);
  assert.ok(p.fading.bassWidth * p.fading.seconds < calmHandOver, 'the hand-over takes less time');
  assert.ok(calls.some(c => c[0] === 'hold' && c.includes(p.fading.bassWidth)));
  assert.match(p.mixLog[0].text, /keys clash \(8A → 3B\): tighter bass and mid hand-over/);
});

test('a clash halves a beat-aligned blend when the downbeat is unknown, and a shaky key is left alone', t => {
  const calm = fixture(t, { downbeat: false, inKey: null });
  calm.p.audio.currentTime = 170;
  const normal = calm.p.planMix(calm.outgoing.audio, 201);
  const { p, outgoing } = fixture(t, { downbeat: false });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.at, null);
  assert.ok(plan.span < normal.span && plan.span >= CLASH_MIN_SECONDS);
  assert.equal(plan.clash.shortened, true);
  // a clash between a firm key and a shaky one is left alone
  const shaky = fixture(t, { downbeat: false, inKey: null });
  mixmemory.learn(shaky.to.id, { grid: grid(), key: { ...heard(C_SHARP_MAJOR), confidence: 0.1 } });
  shaky.p.audio.currentTime = 170;
  assert.equal(shaky.p.planMix(shaky.outgoing.audio, 201).span, normal.span);
});

test('matching keys and a pair with custom mix points are left alone', t => {
  const { p, to, outgoing } = fixture(t, { bpm: 175, inKey: A_MINOR });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.bars, 16);
  assert.equal(plan.clash, null);
  assert.equal(p.keyRelationTo(to).relation, 'same');
  // a clash with a pair-specific mix: the user's own points win
  const custom = fixture(t, { bpm: 175 });
  cues.setPair(custom.from.id, custom.to.id, { out: 150, in: 5 });
  custom.p.audio.currentTime = 148;
  prepare(custom.p, custom.to, custom.incoming, grid(175));
  custom.p.checkCrossfade();
  assert.equal(custom.p.mixAt.at, 150);
  assert.equal(custom.p.mixPlan, null);
});

test('in the Auto style a clashing pair with a confirmed drop gets a drop cut', t => {
  for (const [clashing, expected] of [[true, 'dropcut'], [false, 'blend']]) {
    const { p, to, incoming, g } = fixture(t, { inKey: clashing ? C_SHARP_MAJOR : A_MINOR });
    settings.transitionStyle = 'auto';
    prepare(p, to, incoming, g, { drop: { time: 60, confidence: 0.9 } });
    t.mock.method(p, 'planDrop', (prep, transition, gridOut, drop, gridIn, selected) => selected);
    const selected = p.selectMixStyle(p.prepared, { fade: 8 }, g);
    assert.equal(selected.style, expected, clashing ? 'keys clash' : 'keys match');
    if (clashing) assert.match(selected.reason, /Keys clash/);
    settings.transitionStyle = 'blend';
  }
});

test('unknown keys leave every plan as it was', t => {
  const { p, outgoing, to } = fixture(t, { bpm: 175, outKey: null, inKey: null });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.bars, 16);
  assert.equal(plan.clash, null);
  assert.equal(p.keyRelationTo(to), null);
  assert.equal(p.autoMixStatus().key, undefined);
});

// ---- Settings -----------------------------------------------------------------------------------------------

const text = node => node == null ? '' : typeof node === 'string' ? node : (node.childNodes?.length ? node.childNodes.map(text).join('') : node.textContent ?? '');

test('the Auto mix view shows the playing song\'s key and how the next song\'s key relates', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  const track = { id: 1, title: 'Now playing' }, next = { id: 2, title: 'Coming up' };
  const status = { on: true, enabled: true, track, playing: true, listening: true, structure: { grid: null }, memory: null,
    key: { name: 'A minor', camelot: '8A', confidence: 0.82, heard: { name: 'A minor' } },
    upNext: { track: next, bpm: 124, source: 'memory', reasons: ['same tempo', 'key clash'], key: { relation: 'clash', from: '8A', to: '3B' } } };
  t.mock.method(player, 'autoMixStatus', () => status);
  const page = h('div');
  const dispose = await renderSettings(page, { tab: 'automix' });
  let shown = text(page);
  assert.match(shown, /KeyA minor \(8A\)\s+·\s+82% sure/);
  assert.match(shown, /Up nextComing up.*keys clash \(8A → 3B\)/);
  assert.doesNotMatch(shown, /key clash/, 'the key shows once, in plain words');
  dispose();
  // from memory, matching, then not known yet
  status.key = { name: 'A minor', camelot: '8A', confidence: 0.6, heard: null };
  status.upNext = { ...status.upNext, key: { relation: 'neighbor', from: '8A', to: '9A' } };
  const again = h('div');
  (await renderSettings(again, { tab: 'automix' }))();
  shown = text(again);
  assert.match(shown, /A minor \(8A\).*from memory/);
  assert.match(shown, /neighboring key \(8A → 9A\)/);
  delete status.key;
  const unknown = h('div');
  (await renderSettings(unknown, { tab: 'automix' }))();
  assert.match(text(unknown), /listening for the key/);
});

test('replacing the next song drops the old song\'s plan: a clash\'s short blend does not outlive the clashing song', t => {
  const { p, to, outgoing } = fixture(t, { bpm: 175 });
  p.audio.currentTime = 170;
  const clashing = p.planMix(outgoing.audio, 201);
  assert.equal(clashing.nextId, to.id);
  assert.equal(clashing.clash.shortened, true);
  assert.equal(p.planMix(outgoing.audio, 201), clashing, 'the same song keeps its plan');
  // a song in a matching key takes its place in the queue
  const friend = { id: 33, title: 'Friend', duration: 201000 };
  mixmemory.learn(friend.id, { grid: grid(175), key: heard(A_MINOR) });
  p.queue[1] = friend;
  const plan = p.planMix(outgoing.audio, 201);
  assert.notEqual(plan, clashing);
  assert.equal(plan.nextId, friend.id);
  assert.equal(plan.clash, null);
  assert.ok(plan.span > clashing.span * 1.5, `the full blend is back: ${plan.span} vs ${clashing.span}`);
  // and back again
  p.queue[1] = to;
  const again = p.planMix(outgoing.audio, 201);
  assert.equal(again.clash.shortened, true);
  // a clash that appears for the same song (its key becomes known) also plans again
  mixmemory.learn(friend.id, { key: heard(C_SHARP_MAJOR) });
  p.queue[1] = friend;
  const learned = p.planMix(outgoing.audio, 201);
  assert.equal(learned.nextId, friend.id);
});

test('a deck whose pitch follows its speed teaches the key listener nothing, and what was heard at normal pitch stays', () => {
  const norm = fakeNorm(), audio = deckAudio({ preservesPitch: true }), listener = new KeyListener({ duration: 600 });
  const play = (from, to) => { for (let t = from; t < to; t += 0.05) { audio.currentTime = t; listener.sample(audio, norm); } };
  play(20, 80);
  const before = listener.acc.frames, span = listener.span;
  assert.ok(before > 100);
  // Nightcore / Slowed / a custom speed with keep pitch off: the key sounds shifted
  Object.assign(audio, { preservesPitch: false, playbackRate: 1.25 });
  norm.calls = 0;
  play(80, 200);
  assert.equal(norm.calls, 0, 'the analyser is not read at all');
  assert.equal(listener.acc.frames, before);
  assert.equal(listener.span, span);
  audio.playbackRate = 0.8;
  play(200, 230);
  assert.equal(listener.acc.frames, before);
  // the same speed with the pitch kept is the song's own key again
  Object.assign(audio, { preservesPitch: true, playbackRate: 1.25 });
  play(230, 260);
  assert.ok(listener.acc.frames > before);
  // a rate of exactly 1 with pitch not kept changes nothing either
  const normal = new KeyListener({ duration: 600 });
  Object.assign(audio, { preservesPitch: false, playbackRate: 1 });
  audio.currentTime = 40;
  assert.equal(normal.sample(audio, norm), true);
});
