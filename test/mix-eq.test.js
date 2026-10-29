import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import { strictParam, tickingClock } from './helpers/audio-param.js';
import { rollSchedule } from '../src/js/dropcut.js';

installBrowser();

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** A Web Audio context that records every parameter event, to read the curves a blend programs */
function context() {
  const nodes = [];
  const param = () => strictParam({ value: 1, events: [],
    cancelScheduledValues() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v, t, c) { this.events.push({ v, t, c, type: 'target' }); },
    setValueAtTime(v, at) { this.events.push({ v, at }); this.value = v; },
    setValueCurveAtTime(curve, at, seconds) { this.events.push({ curve, at, seconds }); } }, () => ctx.time ?? ctx.currentTime);
  const node = () => { const n = { outputs: [], gain: param(), frequency: param(), Q: param(), delayTime: param(), threshold: param(),
    knee: param(), ratio: param(), attack: param(), release: param(), fftSize: 0, getFloatTimeDomainData() {},
    connect(next) { this.outputs.push(next); return next; }, disconnect() {} }; nodes.push(n); return n; };
  const ctx = { nodes, currentTime: 1, sampleRate: 48000, destination: node(), createGain: node, createBiquadFilter: node, createDelay: node,
    createDynamicsCompressor: node, createAnalyser: node, createMediaElementSource: node, resume() {}, state: 'running' };
  return ctx;
}

async function setup(t) {
  const ctx = context();
  t.mock.method(globalThis, 'setInterval', () => 0);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = function () { return ctx; };
  t.after(() => { if (original) Object.defineProperty(globalThis, 'AudioContext', original); else delete globalThis.AudioContext; });
  const mod = await import('../src/js/normalizer.js?mix-eq');
  const a = {}, b = {}, norm = new mod.Normalizer(a);
  assert.equal(norm.init(), true);
  assert.equal(norm.addDeck(b), true);
  return { ...mod, ctx, norm, a, b, out: norm.decks.get(a), into: norm.decks.get(b) };
}

const at = (curve, t) => curve[Math.round(t * (curve.length - 1))];
const lastCurve = param => param.events.findLast(e => e.curve).curve;

test('the three bands of a blend: incoming highs come in early, mids hand over near the swap, no amount means flat', async t => {
  const { eqLevels } = await setup(t);
  // incoming: highs held down only for the first tenth, then in by 30%
  near(eqLevels(true, 0, 1).high, -14);
  near(eqLevels(true, 0.1, 1).high, -14);
  assert.ok(eqLevels(true, 0.2, 1).high > -10 && eqLevels(true, 0.2, 1).high < -4, 'half way in at 20%');
  near(eqLevels(true, 0.3, 1).high, 0);
  // outgoing: highs stay until about two thirds of the mix, then go
  near(eqLevels(false, 0.5, 1).high, 0);
  near(eqLevels(false, 0.65, 1).high, 0);
  assert.ok(eqLevels(false, 0.8, 1).high < -4);
  near(eqLevels(false, 1, 1).high, -14);
  // incoming mids stay down (around -9 dB) until near the swap; the outgoing mids only ease down after it
  near(eqLevels(true, 0.2, 1).mid, -9);
  near(eqLevels(true, 0.4, 1).mid, -9);
  near(eqLevels(true, 0.6, 1).mid, 0);
  near(eqLevels(false, 0.4, 1).mid, 0);
  near(eqLevels(false, 0.5, 1).mid, 0);
  assert.ok(eqLevels(false, 0.7, 1).mid < -2);
  near(eqLevels(false, 0.9, 1).mid, -9);
  // only one song's mids at full level at a time: even at the crossover the two together stay well below two full sets
  for (let i = 0; i <= 100; i++) {
    const x = i / 100, up = eqLevels(true, x, 1).mid, down = eqLevels(false, x, 1).mid;
    assert.ok(up <= 0 && down <= 0);
    assert.ok(up + down < -1.5, `both songs' mids high together at ${x}`);
  }
  assert.ok(eqLevels(true, 0.45, 1).mid < -4 && eqLevels(false, 0.45, 1).mid > -1, 'before the swap the outgoing song owns the mids');
  assert.ok(eqLevels(true, 0.7, 1).mid > -1 && eqLevels(false, 0.7, 1).mid < -2, 'after it the incoming song does');
  // the learned DJ-blend amount scales every move; 0 is a plain volume crossfade
  near(eqLevels(true, 0.2, 0.5).mid, -4.5);
  assert.deepEqual(eqLevels(true, 0.2, 0), { mid: 0, high: 0 });
  assert.deepEqual(eqLevels(false, 0.9, undefined), { mid: 0, high: 0 });
  assert.deepEqual(eqLevels(true, 0.2, true), eqLevels(true, 0.2, 1));
  // a handover centre (the double drop's) moves the mids with it
  assert.ok(eqLevels(true, 0.3, 1, 0.25).mid > eqLevels(true, 0.3, 1, 0.5).mid + 4);
});

test('a blend programs mid and high curves beside the untouched bass swap, on the same clock', async t => {
  const { norm, b, into, out, a } = await setup(t);
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1 });
  norm.swapBass(a, false, 20, 0, 0.2, { eq: 1 });
  const bassWith = lastCurve(into.bass.gain);
  const mid = lastCurve(into.mid.gain), high = lastCurve(into.high.gain);
  // a curve starts a hair after "now" and still ends on time (see CURVE_LEAD)
  near(into.mid.gain.events.at(-1).seconds, 19.99, 1e-9);
  near(into.mid.gain.events.at(-1).at + into.mid.gain.events.at(-1).seconds, 21, 1e-9);
  assert.equal(into.high.gain.events.at(-1).at, into.bass.gain.events.at(-1).at, 'the same start time as the fade and the bass');
  near(into.bass.gain.events.at(-1).at, 1.01, 1e-9);
  near(at(high, 0), -14); near(at(high, 0.3), 0, 0.2); near(at(high, 1), 0);
  near(at(mid, 0.2), -9); near(at(mid, 0.6), 0, 0.2);
  const outMid = lastCurve(out.mid.gain), outHigh = lastCurve(out.high.gain);
  near(at(outMid, 0.4), 0, 0.1); near(at(outMid, 1), -9);
  near(at(outHigh, 0.5), 0); near(at(outHigh, 1), -14);
  // the bass swap is exactly what it was without the new bands
  norm.swapBass(b, true, 20, 0, 0.2);
  assert.deepEqual(Array.from(lastCurve(into.bass.gain)), Array.from(bassWith));
  assert.ok(at(bassWith, 0.2) < -20 && at(bassWith, 0.9) > -1);
  assert.equal(into.bass.frequency.events.length, 0, 'the 220 Hz bass corner is untouched');
  // with no amount (an ordinary caller, a plain crossfade) the new bands stay flat and get no curve
  assert.equal(into.mid.gain.events.at(-1).curve, undefined);
  assert.equal(into.mid.gain.events.at(-1).v, 0);
  assert.equal(into.high.gain.events.at(-1).v, 0);
});

test('a blend resumed part way carries on from where it was; a handover centre shapes the mids', async t => {
  const { norm, b, into, eqLevels } = await setup(t);
  norm.swapBass(b, true, 10, 0.5, 0.2, { eq: 1 });
  const curve = lastCurve(into.mid.gain);
  near(curve[0], eqLevels(true, 0.5, 1).mid, 0.01);
  near(into.mid.gain.events.findLast(e => e.v !== undefined).v, eqLevels(true, 0.5, 1).mid, 0.01);
  near(at(curve, 1), 0);
  near(into.mid.gain.events.at(-1).seconds, 9.99, 1e-9);
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1, center: 0.25, corner: 90 });
  assert.ok(at(lastCurve(into.mid.gain), 0.3) > -4, 'the incoming mids are up soon after an early handover');
  assert.deepEqual(into.bass.frequency.events.at(-1), { v: 90, at: 1 });
});

test('pausing holds all three bands where they are; finishing, cutting or a skip puts them flat', async t => {
  const { norm, b, a, into, out } = await setup(t);
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1 });
  norm.swapBass(a, false, 20, 0, 0.2, { eq: 1 });
  // paused 30% in
  norm.holdBass(b, true, 0.3, 0.2, { eq: 1 });
  norm.holdBass(a, false, 0.3, 0.2, { eq: 1 });
  near(into.mid.gain.events.at(-1).v, -9);
  near(into.high.gain.events.at(-1).v, 0);
  near(out.mid.gain.events.at(-1).v, 0);
  near(out.high.gain.events.at(-1).v, 0);
  assert.equal(into.mid.gain.events.at(-1).curve, undefined, 'held, not still moving');
  // paused very early: the incoming highs are still down
  norm.holdBass(b, true, 0.05, 0.2, { eq: 1 });
  near(into.high.gain.events.at(-1).v, -14);
  // paused late: the outgoing song's highs and mids are mostly gone
  norm.holdBass(a, false, 0.95, 0.2, { eq: 1 });
  assert.ok(out.high.gain.events.at(-1).v < -11 && out.mid.gain.events.at(-1).v < -8);
  // finished, cut or skipped: every band of both decks is back to 0 dB
  norm.holdBass(a, false, null);
  norm.holdBass(b, true, null);
  for (const deck of [out, into]) {
    assert.equal(deck.bass.gain.events.at(-1).v, 0);
    assert.equal(deck.mid.gain.events.at(-1).v, 0);
    assert.equal(deck.high.gain.events.at(-1).v, 0);
  }
});

test('the mix EQ is separate from the listener 5-band equalizer, in both directions', async t => {
  const { norm, b, a } = await setup(t);
  norm.setEqualizer({ enabled: true, preamp: -2, gains: [5, 1, -3, 2, 4] });
  const before = norm.eqFilters.map(f => f.gain.events.length);
  const preamp = norm.preamp.gain.events.length;
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1 });
  norm.swapBass(a, false, 20, 0, 0.2, { eq: 1 });
  norm.holdBass(b, true, 0.4, 0.2, { eq: 1 });
  norm.holdBass(b, true, null);
  assert.deepEqual(norm.eqFilters.map(f => f.gain.events.length), before, 'a blend never writes to the equalizer');
  assert.equal(norm.preamp.gain.events.length, preamp);
  // and the equalizer never touches a deck's mix bands
  const deck = norm.decks.get(b);
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1 });
  const mixEvents = [deck.mid.gain.events.length, deck.high.gain.events.length, deck.bass.gain.events.length];
  norm.setEqualizer({ enabled: false, preamp: 0, gains: [0, 0, 0, 0, 0] });
  assert.deepEqual([deck.mid.gain.events.length, deck.high.gain.events.length, deck.bass.gain.events.length], mixEvents);
  // the mix bands are their own filters, in each deck's chain ahead of the equalizer
  assert.equal(deck.mid.type, 'peaking');
  assert.equal(deck.high.type, 'highshelf');
  assert.ok(!norm.eqFilters.includes(deck.mid) && !norm.eqFilters.includes(deck.high));
  assert.equal(deck.mid.outputs[0], deck.high);
  assert.equal(deck.high.outputs[0], deck.level);
});

test('a drop cut starts with every band flat and gets no blend shaping', async t => {
  const { norm, a, b, out, into } = await setup(t);
  assert.equal(norm.startDropCut(a, b, rollSchedule(2, 0.5)), true);
  for (const deck of [out, into]) {
    assert.equal(deck.mid.gain.events.at(-1).v, 0);
    assert.equal(deck.high.gain.events.at(-1).v, 0);
    assert.ok(!deck.mid.gain.events.some(e => e.curve) && !deck.high.gain.events.some(e => e.curve));
  }
});

// ---- Chromium refuses a value curve that overlaps another event of the same parameter ---------------------------------

test('the fake parameter throws like Chromium for an overlapping curve, and cancelling clears the way', () => {
  const clock = { time: 10 };
  const param = strictParam({ events: [], cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {}, setTargetAtTime() {}, setValueCurveAtTime() {} }, () => clock.time);
  const curve = new Float32Array([0, 1]);
  param.setValueAtTime(-9, 10.003);
  assert.throws(() => param.setValueCurveAtTime(curve, 10, 22), { name: 'NotSupportedError' });
  param.cancelScheduledValues(10);
  param.setValueCurveAtTime(curve, 10, 22);
  assert.throws(() => param.setValueAtTime(0, 15), { name: 'NotSupportedError' }, 'an event inside a running curve');
  assert.throws(() => param.setValueCurveAtTime(curve, 20, 5), { name: 'NotSupportedError' }, 'two curves overlapping');
  param.setValueAtTime(0, 32);
  param.cancelScheduledValues(12);
  param.setValueAtTime(0, 15);
  param.setValueCurveAtTime(curve, 20, 5);
  // events in the past are moved up to the clock, which is how a "now" hold lands after an earlier reading
  clock.time = 40;
  const fresh = strictParam({ events: [], cancelScheduledValues() {}, setValueAtTime(v, t) { this.events.push(t); } }, () => clock.time);
  fresh.setValueAtTime(1, 39);
  assert.deepEqual(fresh.events, [40]);
});

test('a hold scheduled a moment after "now" never overlaps the blend curves that follow it', async t => {
  const { norm, ctx, a, b, out, into } = await setup(t);
  tickingClock(ctx, 174.3706666666667);
  // the incoming song's mid is held at -9 dB, three milliseconds ahead of the clock the swap reads
  for (const band of [into.mid, into.high, into.bass]) band.gain.setValueAtTime(-9, ctx.time + 0.003);
  norm.swapBass(b, true, 22.07, 0, 0.2, { eq: 1, midHold: { until: 0.6, depth: -9 } });
  norm.swapBass(a, false, 22.07, 0, 0.2, { eq: 1 });
  for (const param of [into.mid.gain, into.high.gain, into.bass.gain, out.mid.gain, out.high.gain, out.bass.gain]) {
    assert.ok(param.events.some(e => e.curve), 'the curve was scheduled, not thrown away');
  }
  // the same through the whole life of a mix: start, hold (pause), resume, finish
  norm.holdBass(b, true, 0.3, 0.2, { eq: 1 });
  norm.swapBass(b, true, 15, 0.3, 0.2, { eq: 1 });
  norm.holdBass(b, true, null);
  norm.fadeDeck(b, true, 22, 0.3);
  norm.holdFade(b, true, 0.5);
  norm.fadeDeck(b, true, 11, 0.5);
  norm.sweepLowpass(a, 10, 0.2);
  norm.holdLowpass(a, 0.4);
  norm.sweepLowpass(a, 6, 0.4);
});

test('a curve still ends when the blend was due to end, however late it is started', async t => {
  const { norm, ctx, b, into } = await setup(t);
  const before = ctx.currentTime;
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1 });
  const e = into.mid.gain.events.at(-1);
  near(e.at + e.seconds, before + 20, 1e-9);
  // a very short blend keeps a positive duration
  norm.swapBass(b, true, 0.02, 0, 0.2, { eq: 1 });
  assert.ok(into.mid.gain.events.at(-1).seconds > 0);
});
