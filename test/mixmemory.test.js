import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, tempoOptions } from '../src/js/beats.js';
import { createListener, fromWaveform, get, learn, rememberDrop, count, reset, invalidate } from '../src/js/mixmemory.js';
import { installBrowser } from './helpers/browser.js';

installBrowser();

test('confirmed drop spacing keeps memory and later half-time analysis in the same octave', () => {
  reset();
  const grid = { bpm: 175, period: 60 / 175, offset: 0.1, downbeat: 52, confidence: 0.8 };
  rememberDrop('acid', { grid, drop: { time: 52, confidence: 1 } });
  learn('acid', { grid: { ...grid, bpm: 87.5, period: 120 / 175 }, heardFrom: 0, heardTo: 220 });
  close(get('acid').bpm, 175, 0.02);
  assert.equal(get('acid').drop.time, 52);
  const opts = tempoOptions({ genre: 'Drum & Bass' });
  learn('ray', { grid: { ...grid, bpm: 87.4, period: 60 / 87.4 } });
  close(get('ray', opts).bpm, 174.8, 0.02, 'existing half-time memory is corrected at read time');
  learn('ray', { grid: { ...grid, bpm: 87.4, period: 60 / 87.4 } }, opts);
  close(get('ray').bpm, 174.8, 0.02, 'next play persists the corrected octave');
  const summary = feed(createListener(opts), song({ bpm: 87.4, intro: 0, outro: 60, duration: 60 }).samples).summary(60);
  close(summary.grid.bpm, 174.8, 0.1);
});

test('playback envelopes learn a phrase drop and persistent memory retains it across partial plays', () => {
  reset();
  const samples = Array.from({ length: 6000 }, (_, i) => {
    const t = i / 100, thin = t >= 24 && t < 32;
    const pulse = Math.exp(-(((t - 0.1) % 0.5 + 0.5) % 0.5) / 0.04);
    return { t, v: (thin ? 0.02 : 1) * pulse + 0.0001, h: pulse * 0.3, f: pulse + 0.1 };
  });
  const summary = feed(createListener(), samples).summary(60);
  assert.ok(summary.drop, 'whole-play profile should find the bass return');
  close(summary.drop.time, 32.1, 0.15);
  assert.ok(summary.drop.confidence >= 0.7);
  learn('drop', summary);
  const remembered = get('drop');
  close(remembered.drop.time, summary.drop.time, 0.001);
  assert.ok(remembered.downbeat >= 0);
  learn('drop', { grid: null, heardFrom: 0, heardTo: 4 });
  assert.deepEqual(get('drop').drop, remembered.drop);
  const copy = get('drop');
  copy.drop.time = 1000;
  assert.deepEqual(get('drop').drop, remembered.drop);
});

function random(seed = 12345) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function song({ bpm = 128, offset = 0.217, duration = 88, intro = 12, outro = 72,
  start = 0, end = duration, seed = 12345, noiseOnly = false, silence = false } = {}) {
  const rand = random(seed), period = 60 / bpm, samples = [];
  const pulse = (t, phase, interval, decay) => t < phase ? 0 : Math.exp(-((t - phase) % interval) / decay);
  for (let t = start; t <= end; t += 0.004 + rand() * 0.012) {
    const beat = !noiseOnly && t >= intro && t < outro;
    const v = silence ? 0 : 0.008 * rand() + (beat ? pulse(t, offset, period, 0.045) : 0);
    const h = silence ? 0 : 0.008 * rand() + (beat ? 0.5 * pulse(t, offset + period, period * 2, 0.03) : 0);
    samples.push({ t, v, h, f: v + h + (silence ? 0 : 0.025 + 0.015 * rand()) });
  }
  return { samples, bpm, period, offset, duration };
}

function feed(listener, samples) {
  let start = 0;
  while (start < samples.length) {
    let end = start + 1;
    const until = samples[start].t + 0.25;
    while (end < samples.length && samples[end].t < until && samples[end].t >= samples[start].t) end++;
    listener.add(samples.slice(start, end));
    start = end;
  }
  return listener;
}

function close(actual, expected, tolerance) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`);
}

function phaseError(grid, source, t = 0) {
  const actualBeat = grid.offset + Math.round((t - grid.offset) / grid.period) * grid.period;
  const beats = (actualBeat - source.offset) / source.period;
  return Math.abs(beats - Math.round(beats)) * source.period;
}

function play(overrides = {}) {
  return { grid: { bpm: 120, period: 0.5, offset: 0.1, confidence: 0.8 },
    drumsIn: 12, outroStart: 72, beatToEnd: false, heardFrom: 0, heardTo: 88, ...overrides };
}

test('whole-play windows fuse a precise grid and identify sustained intro and outro boundaries', () => {
  for (const seed of [12345, 71, 98765]) {
    const source = song({ seed });
    const listener = feed(createListener(), source.samples);
    const summary = listener.summary(source.duration);
    assert.ok(summary.grid);
    close(summary.grid.bpm, source.bpm, 0.05);
    for (const t of [0, 40, 80]) assert.ok(phaseError(summary.grid, source, t) < 0.005,
      `seed ${seed}, time ${t}: phase error ${phaseError(summary.grid, source, t)}`);
    close(summary.drumsIn, 12, 1.5);
    close(summary.outroStart, 72, 1.5);
    assert.equal(summary.beatToEnd, false);
    close(summary.heardFrom, 0, 0.01);
    close(summary.heardTo, 88, 0.02);
    assert.deepEqual(listener.summary(88), summary);
    assert.equal(listener.summary().outroStart, null);
  }
});

test('fusion improves the grid of one 20 second window', () => {
  const source = song({ intro: 0, outro: 100, duration: 80, seed: 71 });
  const single = analyze(source.samples.filter(sample => sample.t < 20));
  const fused = feed(createListener(), source.samples).summary(80).grid;
  assert.ok(fused && single);
  assert.ok(Math.abs(fused.period - source.period) < Math.abs(single.period - source.period));
  assert.ok(phaseError(fused, source, 80) < phaseError(single, source, 80));
});

test('forward and backward seeks keep independent segments and do not invent unheard boundaries', () => {
  const source = song();
  const listener = createListener();
  feed(listener, source.samples.filter(sample => sample.t < 35));
  feed(listener, source.samples.filter(sample => sample.t >= 47 && sample.t < 67));
  feed(listener, source.samples.filter(sample => sample.t >= 30 && sample.t < 45));
  feed(listener, source.samples.filter(sample => sample.t >= 67));
  const summary = listener.summary(88);
  close(summary.grid.bpm, 128, 0.05);
  close(summary.drumsIn, 12, 1.5);
  close(summary.outroStart, 72, 1.5);
  const skippedIntro = createListener();
  feed(skippedIntro, source.samples.filter(sample => sample.t < 4));
  feed(skippedIntro, source.samples.filter(sample => sample.t >= 30));
  assert.equal(skippedIntro.summary(88).drumsIn, null);
  const skippedTail = createListener();
  feed(skippedTail, source.samples.filter(sample => sample.t < 72));
  feed(skippedTail, source.samples.filter(sample => sample.t >= 86));
  assert.equal(skippedTail.summary(88).outroStart, null);
});

test('partial plays leave unheard boundaries unknown and summaries can be followed by more samples', () => {
  const late = song({ start: 30 });
  assert.equal(feed(createListener(), late.samples).summary(88).drumsIn, null);
  const source = song();
  const listener = feed(createListener(), source.samples.filter(sample => sample.t < 60));
  assert.equal(listener.summary(88).outroStart, null);
  assert.equal(listener.summary(88).beatToEnd, false);
  feed(listener, source.samples.filter(sample => sample.t >= 60));
  close(listener.summary(88).outroStart, 72, 1.5);
  const laterThenStart = feed(createListener(), late.samples);
  feed(laterThenStart, source.samples.filter(sample => sample.t < 30));
  assert.equal(laterThenStart.summary(88).drumsIn, null);
});

test('drums from the start and beats lasting through the ending are explicit', () => {
  for (const duration of [23, 88]) {
    const source = song({ intro: 0, outro: 100, duration });
    const summary = feed(createListener(), source.samples).summary(duration);
    assert.equal(summary.drumsIn, 0);
    assert.equal(summary.outroStart, null);
    assert.equal(summary.beatToEnd, true);
  }
});

test('silence, pads, noise, very short plays, and missing data do not create a grid or structure', () => {
  assert.equal(createListener().summary(88), null);
  for (const options of [{ silence: true }, { noiseOnly: true }, { noiseOnly: true, seed: 71 },
    { noiseOnly: true, seed: 98765 }, { end: 2 }]) {
    const summary = feed(createListener(), song(options).samples).summary(88);
    assert.equal(summary.grid, null);
    assert.equal(summary.drumsIn, null);
    assert.equal(summary.outroStart, null);
    assert.equal(summary.beatToEnd, false);
  }
});

test('waveform estimates sustained loud and quiet stretches, rejecting short or excessive tails', () => {
  const envelope = (intro, end, duration) => ({ width: 1800, height: 100,
    samples: Array.from({ length: 1800 }, (_, i) => {
      const t = i * duration / 1800;
      return t >= intro && t < end ? 80 + (i % 3) : 12;
    }) });
  const result = fromWaveform(envelope(12, 72, 88), 88);
  close(result.drumsIn, 12, 0.1);
  close(result.outroStart, 72, 0.1);
  assert.equal(fromWaveform(envelope(0, 88, 88), 88).drumsIn, 0);
  assert.equal(fromWaveform(envelope(0, 88, 88), 88).outroStart, null);
  assert.equal(fromWaveform(envelope(0, 86, 88), 88).outroStart, null);
  assert.equal(fromWaveform(envelope(0, 20, 88), 88).outroStart, null);
  const bursts = { width: 10, height: 100, samples: [0, 90, 90, 0, 90, 90, 0, 90, 90, 0] };
  assert.equal(fromWaveform(bursts, 10).drumsIn, null);
});

test('store merges agreeing grids with confidence and play weights and circular phases', () => {
  reset();
  const before = Date.now();
  learn(123, play());
  const summary = play({ grid: { bpm: 60 / 0.501, period: 0.501, offset: 10.12, confidence: 0.6 },
    drumsIn: 13, outroStart: null });
  const returned = learn('123', summary);
  const entry = get(123);
  assert.deepEqual(entry, returned);
  close(entry.period, (0.5 * 0.8 + 0.501 * 0.6) / 1.4, 0.00001);
  close(entry.confidence, (0.8 * 0.8 + 0.6 * 0.6) / 1.4, 0.01);
  close(entry.drumsIn, 12.5, 0.01);
  assert.equal(entry.outroStart, 72);
  assert.equal(entry.plays, 2);
  assert.ok(entry.updated >= before && entry.updated <= Date.now());
  assert.equal(count(), 1);
  learn(123, summary);
  close(get(123).period, (entry.period * entry.confidence * 2 + 0.501 * 0.6) /
    (entry.confidence * 2 + 0.6), 0.00001);
  reset();
  learn('wrap', play({ grid: { period: 0.5, offset: 0.499, confidence: 0.8 } }));
  learn('wrap', play({ grid: { period: 0.5, offset: 0.001, confidence: 0.8 } }));
  assert.ok(Math.min(get('wrap').offset, Math.abs(0.5 - get('wrap').offset)) <= 0.001);
  const copy = get('wrap');
  copy.plays = 999;
  assert.equal(get('wrap').plays, 2);
  const rounded = learn('round', play({ grid: { period: 0.5, offset: 0.4999, confidence: 0.8 } }));
  assert.deepEqual(get('round'), rounded);
});

test('store normalizes half and double time and reduces confidence on tempo disagreements', () => {
  reset();
  learn('half', play());
  learn('half', play({ grid: { period: 1, offset: 0.1, confidence: 0.8 } }));
  assert.equal(get('half').period, 0.5);
  close(get('half').offset, 0.1, 0.001);
  learn('half', play({ grid: { period: 0.25, offset: 0.1, confidence: 0.8 } }));
  assert.equal(get('half').period, 0.5);
  learn('half', play({ grid: { period: 0.4, offset: 0.2, confidence: 0.6 } }));
  assert.equal(get('half').period, 0.5);
  close(get('half').confidence, 0.72, 0.001);
  learn('half', play({ grid: { period: 0.4, offset: 0.2, confidence: 0.95 } }));
  assert.equal(get('half').period, 0.4);
  close(get('half').confidence, 0.86, 0.01);
});

test('store retains unknown boundaries and replaces distant values only after a longer play', () => {
  reset();
  learn('structure', play({ heardTo: 80 }));
  learn('structure', play({ grid: null, drumsIn: 30, outroStart: 65, heardFrom: 30, heardTo: 80 }));
  assert.equal(get('structure').drumsIn, 12);
  assert.equal(get('structure').outroStart, 72);
  assert.equal(get('structure').period, 0.5);
  learn('structure', play({ drumsIn: 20, outroStart: 85, heardTo: 100 }));
  assert.equal(get('structure').drumsIn, 20);
  assert.equal(get('structure').outroStart, 85);
  learn('structure', play({ grid: null, drumsIn: null, outroStart: null, heardTo: 10 }));
  assert.equal(get('structure').drumsIn, 20);
  assert.equal(get('structure').outroStart, 85);
  learn('ending', play({ outroStart: null, beatToEnd: true }));
  assert.equal(get('ending').beatToEnd, true);
  learn('ending', play({ outroStart: null, beatToEnd: false, heardTo: 20 }));
  assert.equal(get('ending').beatToEnd, true);
  learn('ending', play({ heardTo: 100 }));
  assert.equal(get('ending').beatToEnd, false);
  reset();
  assert.equal(count(), 0);
  assert.equal(get('ending'), null);
});

test('storage persists compact entries, evicts the least recently updated, and resets', () => {
  reset();
  const entries = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [String(i), {
    bpm: 120, period: 0.5, offset: 0.1, confidence: 0.8, drumsIn: 12, outroStart: 72,
    beatToEnd: false, plays: 1, updated: i + 1, heard: 88
  }]));
  localStorage.setItem('quantm.mixmemory', JSON.stringify(entries));
  invalidate(); // written behind the module's back
  learn('new', play({ grid: { period: 0.46875321, offset: 10.217812, confidence: 0.87654 }, drumsIn: 12.123 }));
  assert.equal(count(), 3000);
  assert.equal(get(0), null);
  assert.ok(get(1));
  const entry = get('new');
  assert.equal(entry.period, 0.46875);
  assert.equal(entry.drumsIn, 12.1);
  assert.equal(entry.confidence, 0.88);
  close(entry.offset * 1000, Math.round(entry.offset * 1000), 1e-9);
  assert.ok(JSON.parse(localStorage.getItem('quantm.mixmemory')).new);
  reset();
  assert.equal(count(), 0);
});

test('invalid inputs, malformed storage, and storage access errors never throw', () => {
  reset();
  for (const input of [null, undefined, NaN, Infinity, -1, {}, [], 'bad']) {
    const listener = createListener();
    assert.doesNotThrow(() => listener.add(input));
    assert.equal(listener.summary(input), null);
    assert.deepEqual(fromWaveform(input, 88), { drumsIn: null, outroStart: null, dropCandidates: [] });
    assert.doesNotThrow(() => learn('bad', input));
  }
  const listener = createListener();
  listener.add([null, {}, { t: NaN, v: 1 }, { t: 0, v: Infinity }]);
  assert.equal(listener.summary(), null);
  listener.add([{ t: 1e300, v: 1 }]);
  assert.equal(listener.summary(), null);
  for (const waveform of [{ width: 1, height: 1, samples: [NaN, 1] },
    { width: 1, height: 1, samples: [0, 0] }, { width: 1, height: 1, samples: [-1, 1] }]) {
    assert.deepEqual(fromWaveform(waveform, 88), { drumsIn: null, outroStart: null, dropCandidates: [] });
  }
  for (const id of [null, undefined, {}, [], NaN, Infinity, -1, '']) {
    assert.equal(get(id), null);
    assert.equal(learn(id, play()), null);
  }
  for (const value of ['broken JSON', 'null', '[]', '{"bad":null}', '{"bad":4}', '{"bad":{}}']) {
    localStorage.setItem('quantm.mixmemory', value);
    invalidate();
    assert.equal(count(), 0);
    assert.equal(get('bad'), null);
  }
  learn('__proto__', play());
  assert.equal(get('__proto__').plays, 1);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const storage of [undefined, { getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota'); } }]) {
      globalThis.localStorage = storage;
      assert.doesNotThrow(() => { get('x'); learn('x', play()); count(); reset(); });
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    assert.doesNotThrow(() => { get('x'); learn('x', play()); count(); reset(); });
  } finally { Object.defineProperty(globalThis, 'localStorage', original); }
  reset();
});

test('adding 300 seconds in 250 ms chunks takes under 600 ms total', t => {
  const source = song({ duration: 300, outro: 284 });
  feed(createListener(), song({ duration: 30, outro: 100 }).samples);
  const listener = createListener();
  const start = performance.now();
  feed(listener, source.samples);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 600, `adding samples took ${elapsed.toFixed(2)} ms`);
  assert.ok(listener.summary(300).grid);
  t.diagnostic(`300 seconds added in ${elapsed.toFixed(2)} ms (${(elapsed / 1200).toFixed(3)} ms per chunk)`);
});

test('get serves repeated calls from memory, sees new writes, and callers cannot corrupt the cache', () => {
  reset();
  const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), {
    bpm: 120, period: 0.5, offset: 0.1, confidence: 0.8, drumsIn: 12, outroStart: 72,
    key: { tonic: 3, mode: 'minor', confidence: 0.7, chroma: Array(12).fill(0.5) },
    beatToEnd: false, plays: 1, updated: i + 1, heard: 88
  }]));
  localStorage.setItem('quantm.mixmemory', JSON.stringify(entries));
  invalidate();
  const real = localStorage.getItem.bind(localStorage);
  let reads = 0;
  const original = Object.getOwnPropertyDescriptor(localStorage, 'getItem');
  localStorage.getItem = key => { if (key === 'quantm.mixmemory') reads++; return real(key); };
  try {
    for (let i = 0; i < 100; i++) get(String(i + 1));
    assert.equal(reads, 1, 'storage is read once for 100 calls');
    count(); get('nope');
    assert.equal(reads, 1);
    // a write by this module shows up at once (and costs one more read)
    learn('fresh', play({ grid: { period: 0.5, offset: 0.1, confidence: 0.9 }, drumsIn: 9 }));
    assert.ok(get('fresh'));
    assert.equal(count(), 301);
    assert.equal(reads, 3, 'learn rereads storage before writing');
    reset();
    assert.equal(get('fresh'), null);
    assert.equal(count(), 0);
    // mutating what get returns never reaches the cache
    learn('song', play({ grid: { period: 0.5, offset: 0.1, confidence: 0.9 }, drumsIn: 9 }));
    const first = get('song');
    const before = JSON.stringify(first);
    first.bpm = 1; first.drop = { time: 1 }; first.plays = 99;
    if (first.key) first.key.tonic = 11;
    assert.equal(JSON.stringify(get('song')), before);
  } finally {
    if (original) Object.defineProperty(localStorage, 'getItem', original); else delete localStorage.getItem;
    reset();
  }
});

test('a writer rereads storage first, so a stale cache cannot delete another window\'s newer song', () => {
  reset();
  learn('mine', play({ grid: { period: 0.5, offset: 0.1, confidence: 0.9 } }));
  assert.ok(get('mine')); // this window now has the store cached
  // another window learns a song; the storage event has not been handled here yet
  const stored = JSON.parse(localStorage.getItem('quantm.mixmemory'));
  stored.theirs = { ...stored.mine, updated: Date.now() + 1 };
  localStorage.setItem('quantm.mixmemory', JSON.stringify(stored));
  learn('third', play({ grid: { period: 0.4, offset: 0.1, confidence: 0.9 } }));
  assert.ok(JSON.parse(localStorage.getItem('quantm.mixmemory')).theirs, 'the other window\'s entry survived');
  rememberDrop('mine', { grid: { period: 0.5, offset: 0.1, confidence: 0.9 }, drop: { time: 30, confidence: 1 } });
  assert.ok(JSON.parse(localStorage.getItem('quantm.mixmemory')).theirs);
  assert.ok(get('theirs') && get('third'));
  reset();
});
