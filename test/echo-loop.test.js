import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import { strictParam } from './helpers/audio-param.js';
import { BarLooper, bufferedCovers } from '../src/js/barloop.js';

installBrowser();

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---- a Web Audio context that remembers its wiring and every parameter event ------------------------------------------

function context({ delay = true } = {}) {
  const nodes = [];
  const param = () => strictParam({ value: 1, events: [],
    cancelScheduledValues() {}, exponentialRampToValueAtTime() {},
    linearRampToValueAtTime(v, at) { this.events.push({ ramp: v, at }); },
    setTargetAtTime() {},
    setValueAtTime(v, at) { this.events.push({ v, at }); this.value = v; },
    setValueCurveAtTime(curve, at, seconds) { this.events.push({ curve, at, seconds }); } }, () => ctx.currentTime);
  const node = (kind) => { const n = { kind, outputs: new Set(), gain: param(), frequency: param(), Q: param(), delayTime: param(), threshold: param(),
    knee: param(), ratio: param(), attack: param(), release: param(), fftSize: 0, frequencyBinCount: 4, getFloatTimeDomainData() {}, getFloatFrequencyData() { n.reads = (n.reads || 0) + 1; },
    connect(next) { this.outputs.add(next); return next; },
    disconnect(next) { if (next) this.outputs.delete(next); else this.outputs.clear(); } }; nodes.push(n); return n; };
  const ctx = { nodes, currentTime: 1, sampleRate: 48000, destination: node('destination'),
    createGain: () => node('gain'), createBiquadFilter: () => node('filter'),
    createDynamicsCompressor: () => node('compressor'), createAnalyser: () => node('analyser'),
    createMediaElementSource: () => node('source'), resume() {}, state: 'running', delays: 0 };
  if (delay) ctx.createDelay = () => { ctx.delays++; return node('delay'); };
  return ctx;
}

async function setup(t, options) {
  const ctx = context(options);
  t.mock.method(globalThis, 'setInterval', () => 0);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = function () { return ctx; };
  t.after(() => { if (original) Object.defineProperty(globalThis, 'AudioContext', original); else delete globalThis.AudioContext; });
  const mod = await import('../src/js/normalizer.js?echo-loop');
  const a = {}, b = {}, norm = new mod.Normalizer(a);
  assert.equal(norm.init(), true);
  assert.equal(norm.addDeck(b), true);
  return { ...mod, ctx, norm, a, b, out: norm.decks.get(a), into: norm.decks.get(b) };
}

const schedule = (extra = {}) => ({ start: 5, beat: 0.5, delay: 0.375, end: 5 + 0.5 + 4 + 0.4, ...extra });
const reaches = (from, to, seen = new Set()) => {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return [...from.outputs].some(next => reaches(next, to, seen));
};

// ---- the delay graph ------------------------------------------------------------------------------------------------------

test('an idle deck has no delay: the echo exists only while an echo-out runs', async t => {
  const { ctx, out, norm } = await setup(t);
  assert.equal(ctx.delays, 0, 'nothing is built until it is used');
  assert.equal(norm.canEcho, true);
  assert.ok(out.fade.outputs.has(out.bass), 'the deck feeds its bass shelf directly');
  assert.equal(out.echoOut, undefined);
});

test('an echo-out routes the outgoing deck through a tempo-synced, high-passed feedback delay and cuts the dry signal over one beat', async t => {
  const { ctx, norm, a, b, out, into } = await setup(t);
  assert.equal(norm.startEchoOut(a, b, schedule()), true);
  assert.equal(ctx.delays, 1);
  assert.ok(!out.fade.outputs.has(out.bass), 'the direct connection is replaced');
  assert.ok(reaches(out.fade, out.bass), 'but the audio still arrives, dry and wet');
  const delay = ctx.nodes.find(n => n.kind === 'delay');
  near(delay.delayTime.value, 0.375);
  // feedback: delay -> high-pass -> low-pass -> gain -> back into the delay
  const filters = ctx.nodes.filter(n => n.kind === 'filter' && n.frequency.value >= 250 && [...delay.outputs].some(o => o === n));
  assert.equal(filters.length, 1, 'the repeats go through a high-pass');
  assert.ok(filters[0].frequency.value >= 250 && filters[0].frequency.value <= 400, 'bass stays out of the echo');
  const loop = [...filters[0].outputs][0];
  assert.ok(reaches(loop, delay), 'the tail feeds itself');
  const feedback = [...loop.outputs][0];
  assert.ok(feedback.gain.value >= 0.5 && feedback.gain.value <= 0.6, `feedback ${feedback.gain.value}`);
  // the dry gain falls to nothing over one beat from the start; the send is open for that beat only
  const dry = [...ctx.nodes.find(n => n.kind === 'gain' && [...n.outputs].includes(out.bass) && n.gain.value === 1 && n.gain.events.some(e => e.ramp === 0 && e.at === 5.5)) ? [true] : []];
  assert.equal(dry.length, 1, 'a gain ramps to 0 exactly one beat after the start');
  const send = ctx.nodes.find(n => n.kind === 'gain' && [...n.outputs].includes(delay) && n.gain.events.some(e => e.at === 5));
  assert.ok(send.gain.events.some(e => e.ramp === 0 && e.at === 5.5), 'the send closes with the dry signal');
  // the incoming deck opens on the beat, with everything flat (its bass is in)
  assert.ok(into.fade.gain.events.some(e => e.v === 0 && e.at === 5));
  assert.ok(into.fade.gain.events.some(e => e.ramp === 1 && e.at > 5 && e.at < 5.1));
  assert.equal(into.bass.gain.value, 0);
  assert.equal(out.bass.gain.value, 0);
  assert.deepEqual([into.mid.gain.value, into.high.gain.value], [0, 0]);
  // a second one is refused while it runs
  assert.equal(norm.startEchoOut(a, b, schedule({ start: 7 })), false);
  assert.equal(ctx.delays, 1);
});

test('clearing the echo-out restores the direct connection and disconnects every node of the effect', async t => {
  const { ctx, norm, a, b, out } = await setup(t);
  const before = ctx.nodes.length;
  norm.startEchoOut(a, b, schedule());
  const added = ctx.nodes.slice(before);
  assert.ok(added.length >= 8);
  norm.clearEchoOut({});            // some other element: nothing happens
  assert.ok(norm.echoOut);
  norm.clearEchoOut(b);             // either deck of the mix ends it
  assert.equal(norm.echoOut, null);
  assert.ok(out.fade.outputs.has(out.bass), 'dry again');
  assert.equal(out.fade.outputs.size, 1, 'and only the shelf');
  assert.ok(added.every(n => n.outputs.size === 0), 'the graph is taken apart');
  assert.equal(out.echoOut, null);
  norm.clearEchoOut(a);             // a second clear is harmless
  // and a new one can start
  assert.equal(norm.startEchoOut(a, b, schedule({ start: 9 })), true);
  norm.clearEchoOut(a);
});

test('an echo-out is refused when it cannot be built or timed: no delay node, past start, same deck, junk times, a drop cut running', async t => {
  const { norm, a, b } = await setup(t);
  assert.equal(norm.startEchoOut(a, a, schedule()), false);
  assert.equal(norm.startEchoOut(a, {}, schedule()), false);
  assert.equal(norm.startEchoOut(a, b, schedule({ start: 0.5 })), false, 'the start has passed');
  assert.equal(norm.startEchoOut(a, b, schedule({ beat: 0 })), false);
  assert.equal(norm.startEchoOut(a, b, schedule({ delay: NaN })), false);
  assert.equal(norm.startEchoOut(a, b, schedule({ end: 5 })), false, 'a tail shorter than the cut');
  assert.equal(norm.startEchoOut(a, b, null), false);
  assert.equal(norm.echoOut, undefined, 'nothing was left running');
  norm.dropcut = { outgoing: a, incoming: b };
  assert.equal(norm.startEchoOut(a, b, schedule()), false);
  norm.dropcut = null;
  const plain = await setup(t, { delay: false });
  assert.equal(plain.norm.canEcho, false);
  assert.equal(plain.norm.startEchoOut(plain.a, plain.b, schedule()), false);
  assert.ok(plain.out.fade.outputs.has(plain.out.bass), 'the deck is untouched');
});

test('a graph that fails half way is torn down and leaves the deck as it was', async t => {
  const { ctx, norm, a, b, out } = await setup(t);
  const real = ctx.createDelay;
  ctx.createDelay = () => { throw new Error('no delay'); };
  assert.equal(norm.startEchoOut(a, b, schedule()), false);
  ctx.createDelay = real;
  assert.ok(out.fade.outputs.has(out.bass));
  assert.equal(out.fade.outputs.size, 1);
  assert.equal(norm.echoOut, undefined);
});

test('the deck spectrum is read once per moment of the audio clock, however many listeners ask', async t => {
  const { ctx, norm, a, out } = await setup(t);
  norm.spectrum(a);
  norm.spectrum(a);
  assert.equal(out.full.reads, 1);
  ctx.currentTime += 0.01;
  norm.spectrum(a);
  assert.equal(out.full.reads, 2);
});

// ---- the incoming mids held down while the outgoing song still sings -------------------------------------------------

test('a mid hold keeps the incoming mids at -12 dB until the outgoing vocals are over, then lets them in; the outgoing song is untouched', async t => {
  const { eqLevels, norm, b, a, into, out } = await setup(t);
  const hold = { until: 0.7, depth: -12 };
  near(eqLevels(true, 0.3, 1, 0.5, hold).mid, -12);
  near(eqLevels(true, 0.55, 1, 0.5, hold).mid, -12); // the normal curve alone is near -2 by now
  assert.ok(eqLevels(true, 0.55, 1, 0.5).mid > -4);
  near(eqLevels(true, 0.7, 1, 0.5, hold).mid, 0, 1e-6);
  near(eqLevels(true, 0.95, 1, 0.5, hold).mid, 0);
  // deeper of the two wins at the start: the normal -9 dB dip is not deepened beyond the hold
  near(eqLevels(true, 0, 1, 0.5, hold).mid, -12);
  near(eqLevels(true, 0, 1, 0.5, { until: 0.7, depth: -6 }).mid, -9, 1e-6);
  // it works with no learned DJ amount at all, and never touches the highs or the outgoing mids
  near(eqLevels(true, 0.2, 0, 0.5, hold).mid, -12);
  assert.equal(eqLevels(true, 0.2, 0, 0.5, hold).high, 0);
  assert.deepEqual(eqLevels(false, 0.2, 1, 0.5, hold), eqLevels(false, 0.2, 1, 0.5));
  assert.deepEqual(eqLevels(true, 0.2, 1, 0.5, null), eqLevels(true, 0.2, 1, 0.5));
  // in a blend: the incoming mid curve carries it
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 1, midHold: hold });
  norm.swapBass(a, false, 20, 0, 0.2, { eq: 1, midHold: hold });
  const curve = into.mid.gain.events.findLast(e => e.curve).curve;
  near(curve[Math.round(0.4 * 95)], -12);
  assert.ok(curve[Math.round(0.9 * 95)] > -1);
  const outCurve = out.mid.gain.events.findLast(e => e.curve).curve;
  near(outCurve[Math.round(0.4 * 95)], 0);
  // holding or freezing mid-blend keeps the hold; flattening drops it
  norm.holdBass(b, true, 0.3, 0.2, { eq: 1, midHold: hold });
  near(into.mid.gain.events.at(-1).v, -12);
  norm.holdBass(b, true, null);
  near(into.mid.gain.events.at(-1).v, 0);
  // a hold alone (eq 0) still programs the curve
  norm.swapBass(b, true, 20, 0, 0.2, { eq: 0, midHold: hold });
  near(into.mid.gain.events.findLast(e => e.curve).curve[10], -12);
});

// ---- the loop: seeking back on the bar line ---------------------------------------------------------------------------

/** A media element whose clock the test drives; seeking takes `lag` ms before 'seeked' */
function fakeMedia({ time = 0, rate = 1 } = {}) {
  const listeners = new Map();
  const m = { currentTime: time, playbackRate: rate, paused: false, seeking: false, ended: false, seeks: [],
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); },
    emit(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    listenerCount(type) { return (listeners.get(type) || []).length; } };
  let position = time;
  Object.defineProperty(m, 'currentTime', { get: () => position, set(v) { position = v; m.seeks.push(v); m.seeking = true; } });
  m.advance = (dt) => { position += dt; }; // playing on is not a seek
  return m;
}

/** Runs a looper against a media clock in 5 ms steps. lag: ms between a seek and its 'seeked'. */
function drive(t, { a = 100, b = 104, loops = 3, lag = 40, start = 99.9, rate = 1, abortAt = null } = {}) {
  const audio = fakeMedia({ time: start, rate });
  let clock = 0, tick = null;
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return 7; });
  t.mock.method(globalThis, 'clearInterval', () => { tick = null; });
  const events = { aborted: null, done: 0 };
  const looper = new BarLooper(audio, { a, b, loops }, { now: () => clock, onAbort: why => { events.aborted = why; }, onDone: () => { events.done++; } });
  looper.start();
  const landed = [];
  let seekAt = null;
  for (let step = 0; step < 4000 && tick; step++) {
    clock += 5;
    if (seekAt === null) audio.advance(0.005 * rate); // the media plays on
    else if (clock - seekAt >= lag) { seekAt = null; audio.seeking = false; audio.emit('seeked'); }
    const seeks = audio.seeks.length;
    if (abortAt && clock === abortAt) audio.emit('seeking');
    tick?.();
    if (audio.seeks.length > seeks) { seekAt = clock; landed.push({ at: clock, target: audio.seeks.at(-1) }); }
  }
  return { audio, looper, events, landed, clock: () => clock };
}

test('the looper seeks back exactly one loop length on the bar line, early by the seek gap, and stops after the planned repeats', t => {
  const { audio, looper, events, landed } = drive(t);
  assert.equal(landed.length, 3);
  assert.equal(events.done, 1);
  assert.equal(events.aborted, null);
  assert.equal(looper.passes, 3);
  assert.equal(audio.listenerCount('seeking'), 0, 'listeners are removed when it is done');
  assert.equal(audio.listenerCount('seeked'), 0);
  // each seek lands where the loop point would have been when sound resumes: a plus the seek gap beyond the point
  for (const { target } of landed) assert.ok(target >= 100 - 0.001 && target <= 100.12, `landed at ${target}`);
  // the first seek happened early (before the media reached 104): the estimated 40 ms gap
  assert.ok(landed[0].at < 100 * 1000, 'timing is on the fake clock');
});

test('the seek position keeps the beat phase: target = a + (position - b) + the measured gap, for any playback rate', t => {
  for (const rate of [1, 1.25, 0.8]) {
    const { landed, audio } = drive(t, { rate, lag: 40 });
    assert.equal(landed.length, 3);
    // when sound resumes (lag later) the media should be a + (time since the loop point would have been reached)
    const first = audio.seeks[0];
    assert.ok(first >= 100 - 1e-9, `rate ${rate}: ${first}`);
    assert.ok(first <= 100 + 0.12 * rate, `rate ${rate}: ${first}`);
    // the loop is 4 s: the seek points back by exactly b - a plus what the media advanced meanwhile
    near((104 - first) % 4, 4 - (first - 100), 1e-6);
  }
  // the gap estimate follows what is measured (a slower deck seeks earlier next time)
  const slow = drive(t, { lag: 90 });
  assert.equal(slow.landed.length, 3);
  assert.ok(slow.looper.latency > 0.06, `learned ${slow.looper.latency}`);
  assert.ok(slow.audio.seeks.every(x => x >= 100 - 0.01 && x <= 100.12), `still landing on the loop start: ${slow.audio.seeks}`);
  assert.ok(slow.landed[1].at - slow.landed[0].at < 4000 + 90, 'and issued earlier, so the repeat is not longer than the loop');
});

test('a seek that is too slow, off by too much, or never finishes stops the loop and says why', t => {
  assert.match(drive(t, { lag: 260 }).events.aborted, /slow/);
  const off = drive(t, { lag: 120 });
  assert.match(off.events.aborted, /slipped/);
  assert.equal(off.events.done, 0);
  assert.equal(off.audio.listenerCount('seeked'), 0);
  // a seek that never reports back
  const audio = fakeMedia({ time: 103.99 });
  let clock = 0, tick;
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => { tick = null; });
  let aborted = null;
  new BarLooper(audio, { a: 100, b: 104, loops: 2 }, { now: () => clock, onAbort: why => { aborted = why; } }).start();
  tick();                       // issues the seek
  assert.equal(audio.seeks.length, 1);
  clock += 700;
  tick();
  assert.match(aborted, /did not finish/);
  assert.equal(tick, null);
});

test('a seek that is not the looper\'s own (the song was moved), a missed loop point, a pause and a stop', t => {
  assert.match(drive(t, { abortAt: 300 }).events.aborted, /moved/);
  // the poll noticed far too late (a stalled page): no seek into the wrong phase
  const late = drive(t, { start: 104.5 });
  assert.match(late.events.aborted, /missed/);
  assert.equal(late.audio.seeks.length, 0);
  // paused: nothing happens until it plays again
  const audio = fakeMedia({ time: 103.99 });
  audio.paused = true;
  let tick;
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => { tick = null; });
  const looper = new BarLooper(audio, { a: 100, b: 104, loops: 2 }, { now: () => 0 });
  looper.start();
  looper.start(); // a second start is ignored
  tick();
  assert.equal(audio.seeks.length, 0);
  audio.paused = false;
  looper.stop();
  assert.equal(tick, null, 'stop clears the timer');
  assert.equal(audio.listenerCount('seeking'), 0);
  looper.tick();
  assert.equal(audio.seeks.length, 0, 'a stopped looper never seeks');
  // an abort after stop is silent
  let called = 0;
  const quiet = new BarLooper(audio, { a: 100, b: 104, loops: 2 }, { onAbort: () => { called++; } });
  quiet.stop();
  quiet.abort('late');
  assert.equal(called, 0);
});

test('bufferedCovers needs the whole region in one buffered range', () => {
  const media = (...ranges) => ({ buffered: { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] } });
  assert.equal(bufferedCovers(media([0, 200]), 190, 200), true);
  assert.equal(bufferedCovers(media([0, 100], [150, 200]), 90, 160), false);
  assert.equal(bufferedCovers(media([0, 100], [150, 200]), 150, 199), true);
  assert.equal(bufferedCovers(media([0, 195]), 190, 200), false);
  assert.equal(bufferedCovers({}, 0, 1), false);
  assert.equal(bufferedCovers({ buffered: { length: 0 } }, 0, 1), false);
});
