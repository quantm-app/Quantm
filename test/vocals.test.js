import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import { singing, pad, drumLoop, voice, SILENCE, SAMPLE_RATE, FFT } from './helpers/vocal-spectra.js';
import { VocalMeter, VocalRecorder, VocalMap, normalizeVocals, mergeVocals, planVocalClash, VOCAL_LEVEL } from '../src/js/vocals.js';
import { BeatWatcher } from '../src/js/automix.js';

installBrowser();
const mixmemory = await import('../src/js/mixmemory.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const spec = db => ({ db, sampleRate: SAMPLE_RATE, fftSize: FFT });

/** Feed a frame source to a fresh meter at 16 frames a second; returns the scores after the warm-up */
function scores(frame, frames = 100) {
  const meter = new VocalMeter(), out = [];
  for (let i = 0; i < frames; i++) out.push(meter.add(spec(frame(i)), i * 0.06));
  return out.slice(30);
}
const mean = list => list.reduce((a, b) => a + b, 0) / list.length;

// ---- the score --------------------------------------------------------------------------------------------------

test('a voice-like swing in the vocal band scores high; a steady pad, drums, silence and a held note stay near zero', () => {
  const sung = scores(singing);
  assert.ok(Math.min(...sung) > 0.7, `singing ${Math.min(...sung)}`);
  assert.ok(sung.every(v => v >= 0 && v <= 1));
  const held = pad();
  assert.ok(Math.max(...scores(() => held)) < 0.1, 'a pad has the right band and peaks but does not move');
  const steadyVoice = voice(0.6);
  assert.ok(Math.max(...scores(() => steadyVoice)) < 0.1, 'a held vocal note is steady too');
  assert.ok(Math.max(...scores(drumLoop)) < 0.1, 'drums are loud and moving but flat, with little in the voice band');
  assert.equal(Math.max(...scores(() => SILENCE)), 0);
  // quieter singing still counts, and a slower swing (a long note) scores lower than syllables
  const soft = scores(n => voice(0.1 + 0.2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * n * 0.06)) ** 2));
  assert.ok(mean(soft) > 0.5);
});

test('the meter needs a warm-up, forgets across gaps, and reuses its buffers', () => {
  const meter = new VocalMeter();
  const buffer = meter.levels;
  let first = null;
  for (let i = 0; i < 40; i++) {
    const score = meter.add(spec(singing(i)), i * 0.06);
    if (i < 7) assert.equal(score, 0, `frame ${i} is still warming up`);
    if (score > 0 && first === null) first = i;
  }
  assert.ok(first >= 7 && meter.ready);
  assert.equal(meter.levels, buffer, 'the ring is fixed: nothing allocated per frame');
  // a seek or a stall is not movement: the history starts over
  meter.add(spec(singing(41)), 100);
  assert.equal(meter.ready, false);
  assert.equal(meter.add(null, 101), 0);
  assert.equal(meter.add({ db: new Float32Array(10), sampleRate: 0, fftSize: 0 }, 102), 0);
});

// ---- the timeline ---------------------------------------------------------------------------------------------------

const frames = (n) => Array.from({ length: n }, (_, i) => singing(i));
const SING = frames(40), PAD = pad(), DRUMS = Array.from({ length: 5 }, (_, i) => drumLoop(i * 7));
const fakeDeck = (what) => ({ audio: { paused: false, seeking: false, muted: false, currentTime: 0 }, norm: { calls: 0,
  spectrum(audio) { this.calls++; const f = what(audio.currentTime); return f && spec(f); } } });

/** Play [from, to) in 20 ms steps, as the beat watcher's 10 ms poll would, through a recorder */
function play(recorder, deck, from, to, step = 0.02) {
  for (let t = from; t < to; t += step) { deck.audio.currentTime = t; recorder.sample(deck.audio, deck.norm); }
}

test('a recorder keeps the first and last minute: singing from 10 s to 30 s and from 140 s to 170 s of a 200 s song', () => {
  const deck = fakeDeck(t => (t >= 10 && t < 30) || (t >= 140 && t < 170) ? SING[Math.round(t / 0.06) % 40] : t > 170 ? DRUMS[Math.round(t / 0.06) % 5] : PAD);
  const recorder = new VocalRecorder({ duration: 200 });
  play(recorder, deck, 0, 60);
  assert.ok(deck.norm.calls <= 60 / 0.06 + 2 && deck.norm.calls >= 600, `well under every poll (50 a second), about 14 to 16: ${deck.norm.calls}`);
  const before = deck.norm.calls;
  play(recorder, deck, 60, 140);
  assert.equal(deck.norm.calls, before, 'the middle of the song is not even read');
  play(recorder, deck, 140, 200);
  const summary = recorder.summary();
  assert.equal(summary.intro.length, 30);
  assert.equal(summary.outroFrom, 140);
  assert.ok(summary.start >= 10 && summary.start <= 12, `starts at ${summary.start}`);
  assert.ok(summary.end >= 168 && summary.end <= 172, `ends at ${summary.end}`);
  const map = new VocalMap(summary);
  assert.ok(map.levelAt(20) >= VOCAL_LEVEL && map.levelAt(5) < 3, 'intro: silent, then singing');
  assert.ok(map.levelAt(150) >= VOCAL_LEVEL && map.levelAt(185) < 3, 'outro: singing, then not');
  assert.equal(map.levelAt(100), -1, 'the middle was never recorded');
  assert.equal(map.introStart(0) >= 10, true);
  assert.equal(map.outroEnd().end, summary.end);
  assert.ok(map.outroEnd().heardTo >= 198);
});

test('a recorder skips paused, seeking and muted decks, and a missing spectrum; a seek back starts a fresh reading', () => {
  const deck = fakeDeck(() => SING[0]);
  const recorder = new VocalRecorder({ duration: 200 });
  for (const extra of [{ paused: true }, { seeking: true }, { muted: true }]) {
    Object.assign(deck.audio, { paused: false, seeking: false, muted: false, currentTime: 5 }, extra);
    assert.equal(recorder.sample(deck.audio, deck.norm), false);
  }
  assert.equal(deck.norm.calls, 0);
  Object.assign(deck.audio, { paused: false, seeking: false, muted: false, currentTime: 5 });
  assert.equal(recorder.sample(deck.audio, {}), false, 'a normalizer without a spectrum');
  assert.equal(recorder.sample(deck.audio, { spectrum: () => null }), false);
  assert.equal(recorder.sample(deck.audio, deck.norm), true);
  assert.equal(recorder.sample(deck.audio, deck.norm), false, 'the same moment again is skipped');
  deck.audio.currentTime = 2;
  assert.equal(recorder.sample(deck.audio, deck.norm), true, 'a seek back resets the throttle');
  assert.equal(recorder.summary(), null, 'a few frames are not a reading');
  // a length that arrives late places the last minute
  const late = new VocalRecorder();
  assert.equal(late.timeline.wants(150), false);
  late.setDuration(200);
  assert.equal(late.timeline.wants(150), true);
  late.setDuration(500);
  assert.equal(late.timeline.duration, 200, 'the first length stands');
});

test('the beat watcher feeds the recorder from its own poll and stops with unwatch', t => {
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const deck = fakeDeck(() => SING[0]);
  deck.norm.beatEnergy = () => ({ low: 0.3, high: 0.1, full: 0.2 });
  deck.audio.duration = 200;
  const watcher = new BeatWatcher(deck.norm), recorder = new VocalRecorder({ duration: 200 });
  watcher.watch(deck.audio);
  watcher.listenForVocals(deck.audio, recorder);
  for (let time = 1; time <= 5; time += 0.02) { deck.audio.currentTime = time; watcher.poll(); }
  assert.ok(deck.norm.calls > 50);
  const calls = deck.norm.calls;
  watcher.unwatch(deck.audio);
  watcher.watch(deck.audio);
  deck.audio.currentTime = 9;
  watcher.poll();
  assert.equal(deck.norm.calls, calls, 'no longer read after unwatch');
  watcher.listenForVocals(deck.audio, recorder);
  watcher.listenForVocals(deck.audio, null);
  assert.equal(watcher.vocals.size, 0);
});

// ---- the stored form -------------------------------------------------------------------------------------------

const slots = (text) => text.padEnd(30, '-');
const intro = slots('00000044556000000000000000');

test('a summary is validated, padded, and its phrase edges are recomputed from the slots', () => {
  const v = normalizeVocals({ intro, outro: '0000000067890000', outroFrom: 141, start: 999, end: 1 });
  assert.equal(v.intro.length, 30);
  assert.equal(v.outro.length, 32);
  assert.equal(v.outroFrom, 142, 'on the 2 s slot lattice');
  assert.equal(v.start, 12, 'the first phrase starts at slot 6');
  assert.equal(v.end, 142 + 12 * 2, 'and the last ends after slot 11');
  // junk is dropped, not trusted
  for (const bad of [null, 'x', 5, {}, { intro: 'abc' }, { intro: '-'.repeat(30) }, { intro: '0'.repeat(31) }, { outro: 12 }]) assert.equal(normalizeVocals(bad), null, JSON.stringify(bad));
  assert.equal(normalizeVocals({ intro: '0044', outroFrom: -3 }).outroFrom, 0);
  // an isolated weak slot is not a phrase; an isolated strong one is
  assert.equal(normalizeVocals({ intro: slots('00500000') }).start, null);
  assert.equal(normalizeVocals({ intro: slots('00800000') }).start, 4);
  assert.equal(normalizeVocals({ intro: slots('0050500000') }).start, 4, 'a breath between two slots is one phrase');
});

test('plays merge slot by slot, heard beats unheard, and a copy that ends elsewhere replaces the last minute', () => {
  const a = { intro: slots('0000'), outro: slots('9999'), outroFrom: 140 };
  const b = { intro: slots('--88'), outro: slots('1111'), outroFrom: 140 };
  const m = mergeVocals(a, b, 1);
  assert.equal(m.intro.slice(0, 4), '0044', 'heard in both: averaged; heard once: kept');
  assert.equal(m.outro.slice(0, 4), '5555');
  assert.equal(mergeVocals(a, b, 3).outro.slice(0, 4), '7777', 'earlier plays weigh more');
  assert.equal(mergeVocals(a, b, 3).intro.slice(0, 4), '0022');
  const moved = mergeVocals(a, { ...b, outroFrom: 100 }, 1);
  assert.equal(moved.outroFrom, 100);
  assert.equal(moved.outro.slice(0, 4), '1111');
  assert.equal(mergeVocals(a, { intro: slots('88'), outro: '', outroFrom: 100 }, 1).outro.slice(0, 4), '9999', 'a play that never reached the end keeps the old last minute');
  assert.equal(mergeVocals(null, null, 1), null);
  assert.deepEqual(mergeVocals(a, null, 1), normalizeVocals(a));
  assert.deepEqual(mergeVocals(null, b, 1), normalizeVocals(b));
});

test('mixmemory stores the vocal summary compactly, merges plays, and old entries still load', () => {
  mixmemory.reset();
  const grid = { period: 0.5, offset: 0.1, confidence: 0.8 };
  const first = { intro: slots('0044556'), outro: slots('99880000'), outroFrom: 140 };
  mixmemory.learn('song', { grid, vocals: first });
  const entry = mixmemory.get('song');
  assert.equal(entry.vocals.intro, normalizeVocals(first).intro);
  assert.equal(entry.vocals.end, 140 + 4 * 2);
  const stored = JSON.parse(localStorage.getItem('quantm.mixmemory')).song.vocals;
  assert.ok(JSON.stringify(stored).length < 200, 'a few dozen characters, not arrays of numbers');
  assert.equal(typeof stored.intro, 'string');
  // a play that heard no vocals leaves them; another refines them
  mixmemory.learn('song', { grid });
  assert.equal(mixmemory.get('song').vocals.intro, entry.vocals.intro);
  mixmemory.learn('song', { grid, vocals: { intro: slots('0000'), outro: slots('99880000'), outroFrom: 140 } });
  assert.equal(mixmemory.get('song').vocals.intro.slice(0, 4), '0033', 'averaged with the plays so far (two of them)');
  assert.equal(mixmemory.get('song').plays, 3);
  // a drop confirmed later keeps them
  mixmemory.rememberDrop('song', { grid: { ...grid, bpm: 120 }, drop: { time: 60, confidence: 1 } });
  assert.ok(mixmemory.get('song').vocals);
  // entries from before vocal mapping load with none, and learn fine
  localStorage.setItem('quantm.mixmemory', JSON.stringify({ old: { bpm: 120, period: 0.5, offset: 0.1, confidence: 0.8, plays: 2, updated: 5 } }));
  assert.equal(mixmemory.get('old').vocals, null);
  assert.equal(mixmemory.get('old').plays, 2);
  mixmemory.learn('old', { grid, vocals: first });
  assert.ok(mixmemory.get('old').vocals.start != null || mixmemory.get('old').vocals.end != null);
  // junk is ignored rather than trusted
  localStorage.setItem('quantm.mixmemory', JSON.stringify({ bad: { plays: 1, updated: 1, vocals: { intro: 'zzz', outro: 7 } } }));
  assert.equal(mixmemory.get('bad').vocals, null);
  mixmemory.reset();
});

// ---- reading it back ------------------------------------------------------------------------------------------------

test('a vocal map answers by song time, never claims what was not heard, and finds clean stretches', () => {
  const map = new VocalMap({ intro: slots('000000445500000000'), outro: slots('00006677800000'), outroFrom: 100 });
  assert.equal(map.levelAt(-1), -1);
  assert.equal(map.levelAt(13), 4);
  assert.equal(map.levelAt(80), -1);
  assert.equal(map.levelAt(108), 6);
  assert.equal(map.introStart(0), 12);
  assert.equal(map.introStart(13), 13, 'already singing at the start point');
  assert.equal(map.introStart(20), null, 'none after that, up to a stretch that was never heard');
  assert.equal(new VocalMap({ intro: slots('00'), outro: '', outroFrom: 0 }).introStart(0), null, 'unheard after slot 1: nothing claimed');
  assert.deepEqual(map.outroEnd(), { end: 100 + 2 * 9, heardTo: 100 + 2 * 14 });
  assert.equal(map.clean(0, 10), true);
  assert.equal(map.clean(10, 16), false, 'singing in there');
  assert.equal(map.clean(100, 107), true);
  assert.equal(map.clean(100, 112), false);
  assert.equal(map.clean(60, 70), false, 'unheard is not clean');
  assert.equal(new VocalMap(null).valid, false);
  assert.equal(new VocalMap(null).clean(0, 1), false);
  assert.deepEqual(new VocalMap(null).outroEnd(), { end: null, heardTo: null });
  assert.equal(new VocalMap(null).introStart(), null);
});

// ---- keeping two singers apart ----------------------------------------------------------------------------------------

const GRID = { period: 0.5, offset: 0, downbeat: 0, confidence: 0.9 }; // 120 BPM: 2 s bars, 16 s per 8 bars
const phraseCase = { grid: GRID, phrase: true, bars: 16, at: 192, span: 32, dur: 240 };

test('both singing in the planned blend: the blend starts on a later phrase line, at least 8 bars, and still ends with the song', () => {
  const plan = planVocalClash({ ...phraseCase, outEnd: 206, inOnset: 3 });
  assert.equal(plan.at, 208, 'the first phrase line after the outgoing vocals');
  assert.equal(plan.bars, 8);
  assert.equal(plan.span, 16);
  assert.equal(plan.shift, 16);
  assert.ok(plan.at + plan.span <= 240 - 0.3);
  assert.ok(240 - (plan.at + plan.span) <= 16, 'ends within a phrase of the song end');
  assert.equal(plan.hold, undefined);
});

test('a blend that would not stay long enough keeps its timing and holds the incoming mids down instead', () => {
  // outgoing sings until 212: the next phrase line leaves under 8 bars
  const held = planVocalClash({ ...phraseCase, outEnd: 212, inOnset: 1 });
  assert.equal(held.at, undefined);
  assert.equal(held.hold.depth, -12);
  near(held.hold.until, (212 - 192) / 32);
  // singing to the very end of the song: held for most of the blend
  const toEnd = planVocalClash({ ...phraseCase, outEnd: 239, inOnset: 3 });
  assert.equal(toEnd.hold.until, 0.9);
});

test('no clash, no change: little overlap, the incoming song waiting, or anything unknown', () => {
  assert.equal(planVocalClash({ ...phraseCase, outEnd: 200, inOnset: 10 }), null, 'the outgoing vocals are over before the incoming ones');
  assert.equal(planVocalClash({ ...phraseCase, outEnd: 194, inOnset: 0 }), null, 'a 2 s overlap is a breath, not a clash');
  assert.equal(planVocalClash({ ...phraseCase, outEnd: null, inOnset: 3 }), null);
  assert.equal(planVocalClash({ ...phraseCase, outEnd: 206, inOnset: null }), null);
  assert.equal(planVocalClash({ ...phraseCase, outEnd: NaN, inOnset: 3 }), null);
  assert.equal(planVocalClash({ ...phraseCase, outEnd: 206, inOnset: 3, span: 0 }), null);
});

test('without phrase timing the blend moves to a bar line and ends with the song in whole bars (8 s at least)', () => {
  const plan = planVocalClash({ grid: GRID, phrase: false, at: 216, span: 24, dur: 240, outEnd: 225, inOnset: 2 });
  assert.equal(plan.at, 222);
  assert.equal(plan.bars, 0);
  near(plan.span % 2, 0);
  assert.ok(plan.span >= 8 && plan.at + plan.span <= 239.7);
  // not enough song left for a usable blend: hold instead
  assert.ok(planVocalClash({ grid: GRID, phrase: false, at: 216, span: 24, dur: 240, outEnd: 236, inOnset: 2 }).hold);
  // no grid at all: seconds
  const bare = planVocalClash({ grid: null, phrase: false, at: 216, span: 24, dur: 240, outEnd: 222, inOnset: 2 });
  assert.ok(bare.at >= 218 && bare.span >= 8, JSON.stringify(bare));
  // faster playback measures the margins in media seconds
  assert.equal(planVocalClash({ grid: GRID, phrase: false, at: 216, span: 24, dur: 240, outEnd: 222, inOnset: 2, rate: 1.25 }) !== null, true);
});
