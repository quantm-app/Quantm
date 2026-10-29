import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ChromaAccumulator, estimateKey, camelot, parseCamelot, keyName,
  compatibility, mergeKey } from '../src/js/keys.js';

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`);
}

function random(seed = 12345) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Sum sine-partial energies with a narrow FFT-window lobe, then convert to dB.
function spectrum(notes, { sampleRate = 44100, fftSize = 4096, harmonics = 5,
  gain = 1, noise = 0, seed = 12345 } = {}) {
  const rand = random(seed);
  const energy = Float64Array.from({ length: fftSize / 2 }, () =>
    1e-12 + noise * (0.5 + rand()));
  for (const note of notes) {
    const frequency = 440 * 2 ** ((note - 69) / 12);
    for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
      const bin = frequency * harmonic * fftSize / sampleRate;
      for (let i = Math.max(1, Math.floor(bin) - 2); i <= Math.min(energy.length - 1, Math.ceil(bin) + 2); i++) {
        energy[i] += gain * 0.01 / harmonic ** 2 * Math.exp(-(((i - bin) / 0.55) ** 2));
      }
    }
  }
  return Float32Array.from(energy, value => 10 * Math.log10(value));
}

function detect(notes, options = {}) {
  const accumulator = new ChromaAccumulator({ sampleRate: 44100, fftSize: 4096, ...options });
  const frame = spectrum(notes, options);
  for (let i = 0; i < 30; i++) accumulator.add(frame);
  return { accumulator, estimate: estimateKey(accumulator.chroma()) };
}

for (const [name, notes, key] of [
  ['C major', [60, 64, 67], { tonic: 0, mode: 'major' }],
  ['A minor', [57, 60, 64], { tonic: 9, mode: 'minor' }],
  ['G major', [55, 57, 59, 60, 62, 64, 66, 67], { tonic: 7, mode: 'major' }]
]) {
  test(`sine partials of ${name} yield the right key with useful confidence`, () => {
    const { accumulator, estimate } = detect(notes);
    assert.ok(estimate);
    assert.deepEqual(estimate.key, key, `${name}: ${JSON.stringify(estimate)}; ${[...accumulator.chroma()]}`);
    assert.equal(estimate.name, name);
    assert.equal(estimate.camelot, camelot(key));
    assert.ok(estimate.confidence > 0.35 && estimate.confidence <= 1,
      `${name} confidence: ${estimate.confidence}`);
    assert.equal(accumulator.frames, 30);
    const chroma = accumulator.chroma();
    assert.ok(chroma instanceof Float64Array);
    assert.equal(chroma.length, 12);
    close(chroma.reduce((sum, value) => sum + value, 0), 1);
  });
}

test('loud broadband percussion and noise mixed into tonal frames preserve the key', () => {
  for (const notes of [[60, 64, 67], [57, 60, 64]]) {
    const { accumulator, estimate } = detect(notes);
    const before = accumulator.chroma();
    for (let i = 0; i < 150; i++) {
      accumulator.add(spectrum([], { noise: 0.1, seed: i + 1 }));
      if (i % 5 === 0) accumulator.add(spectrum(notes, { noise: 0.00001, seed: i + 1 }));
    }
    assert.deepEqual(estimateKey(accumulator.chroma()).key, estimate.key);
    assert.ok(estimateKey(accumulator.chroma()).confidence > 0.35);
    assert.equal(accumulator.frames, 60);
    assert.ok(before.some(value => value > 0));
  }
});

test('silence, flat spectra, invalid frames and invalid chroma provide no key', () => {
  const accumulator = new ChromaAccumulator({ sampleRate: 44100, fftSize: 4096 });
  for (const value of [-Infinity, -120, -91, -25, NaN, Infinity]) {
    accumulator.add(new Float32Array(2048).fill(value));
  }
  accumulator.add(null);
  accumulator.add(new Float32Array(2));
  for (const weight of [0, -1, NaN, Infinity]) accumulator.add(spectrum([60]), weight);
  assert.equal(accumulator.frames, 0);
  assert.deepEqual([...accumulator.chroma()], new Array(12).fill(0));
  for (const chroma of [null, [], new Float64Array(12), new Array(12).fill(1),
    new Array(12).fill(1).with(0, 1.001), new Array(12).fill(NaN),
    new Array(12).fill(1).with(0, -1), new Array(12).fill(Infinity)]) {
    assert.equal(estimateKey(chroma), null);
  }
});

test('frames respect weights, return copies, and reset completely', () => {
  const options = { sampleRate: 44100, fftSize: 4096 };
  const first = spectrum([60], { harmonics: 1 });
  const second = spectrum([67], { harmonics: 1 });
  const a = new ChromaAccumulator(options), b = new ChromaAccumulator(options);
  a.add(first, 2);
  a.add(second);
  b.add(first);
  b.add(first);
  b.add(second);
  a.chroma().forEach((value, i) => close(value, b.chroma()[i]));
  const copy = a.chroma();
  copy.fill(0);
  assert.ok(a.chroma().some(value => value > 0));
  a.reset();
  assert.equal(a.frames, 0);
  assert.equal(estimateKey(a.chroma()), null);
  a.add(first);
  assert.equal(a.frames, 1);
  const louder = new ChromaAccumulator(options);
  louder.add(Float32Array.from(first, db => db + 20));
  a.chroma().forEach((value, i) => close(value, louder.chroma()[i], 1e-6));
});

test('a 10 dB difference contributes ten times the energy before frequency weighting', () => {
  const accumulator = new ChromaAccumulator({ sampleRate: 44100, fftSize: 4096, minHz: 400, maxHz: 600 });
  const frame = new Float32Array(2048).fill(-Infinity);
  frame[41] = -20;
  frame[49] = -30;
  accumulator.add(frame);
  const chroma = accumulator.chroma();
  // These bins split across A/A# and C/C# respectively; tilt is inverse frequency.
  close((chroma[9] + chroma[10]) / (chroma[0] + chroma[1]), 10 * 49 / 41);
});

test('profile correlations recognize all rotations and lower confidence for competing keys', () => {
  const profiles = {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
  };
  for (const [mode, profile] of Object.entries(profiles)) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const chroma = Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12]);
      const result = estimateKey(chroma);
      assert.deepEqual(result.key, { tonic, mode });
      assert.ok(result.confidence > 0.9);
      const competing = chroma.map((value, i) => (value + chroma[(i + 5) % 12]) / 2);
      assert.ok(estimateKey(competing).confidence < result.confidence);
    }
  }
});

test('sample rates, FFT sizes, frequency limits and soft assignment are respected', () => {
  for (const sampleRate of [44100, 48000]) {
    for (const fftSize of [4096, 8192]) {
      assert.deepEqual(detect([60, 64, 67], { sampleRate, fftSize }).estimate.key,
        { tonic: 0, mode: 'major' }, `${sampleRate} Hz, FFT ${fftSize}`);
    }
  }
  const accumulator = new ChromaAccumulator({ sampleRate: 44100, fftSize: 4096, minHz: 250, maxHz: 300 });
  const frame = new Float32Array(2048).fill(-Infinity);
  frame[24] = -20;
  frame[5] = 0;
  frame[100] = 0;
  accumulator.add(frame);
  const chroma = accumulator.chroma();
  assert.ok(chroma[11] > 0 && chroma[0] > chroma[11]);
  assert.equal(chroma.filter(value => value > 0).length, 2);
  const outside = new ChromaAccumulator({ sampleRate: 44100, fftSize: 4096, minHz: 23000, maxHz: 24000 });
  outside.add(frame);
  assert.equal(outside.frames, 0);
  for (const options of [{ sampleRate: 0, fftSize: 4096 }, { sampleRate: 44100, fftSize: 4000 },
    { sampleRate: 44100, fftSize: 4096, minHz: 0 }, { sampleRate: 44100, fftSize: 4096, maxHz: 60 }]) {
    assert.throws(() => new ChromaAccumulator(options), RangeError);
  }
});

test('Camelot parsing and formatting round trip all 24 keys', () => {
  for (const mode of ['major', 'minor']) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const key = { tonic, mode };
      assert.deepEqual(parseCamelot(camelot(key)), key);
      assert.ok(keyName(key).endsWith(mode));
    }
  }
  assert.deepEqual(parseCamelot(' 8a '), { tonic: 9, mode: 'minor' });
  assert.equal(camelot({ tonic: 0, mode: 'major' }), '8B');
  assert.equal(keyName(parseCamelot('8A')), 'A minor');
  for (const value of [null, 8, '', '0A', '13A', '08A', '8C', '8 A', '8Aextra']) {
    assert.equal(parseCamelot(value), null);
  }
  for (const key of [null, {}, { tonic: 12, mode: 'major' }, { tonic: 0, mode: 'dorian' }]) {
    assert.equal(camelot(key), null);
    assert.equal(keyName(key), null);
  }
});

test('Camelot compatibility follows the wheel including wrap-around', () => {
  for (const [a, b, relation, score] of [
    ['8A', '8A', 'same', 1], ['8A', '8B', 'relative', 0.9],
    ['8A', '9A', 'neighbor', 0.85], ['8A', '7A', 'neighbor', 0.85],
    ['8A', '10A', 'energy-boost', 0.6], ['8A', '6A', 'energy-boost', 0.6],
    ['12B', '1B', 'neighbor', 0.85], ['12B', '2B', 'energy-boost', 0.6]
  ]) {
    const result = compatibility(parseCamelot(a), parseCamelot(b));
    assert.equal(result.relation, relation);
    assert.equal(result.score, score);
    if (score >= 0.85) assert.equal(result.semitoneShift, 0);
    assert.equal(compatibility(parseCamelot(b), parseCamelot(a)).score, score);
  }
  const clash = compatibility(parseCamelot('8A'), parseCamelot('3B'));
  assert.equal(clash.relation, 'clash');
  assert.ok(clash.score >= 0.1 && clash.score <= 0.3);
  for (const keys of [[null, null], [parseCamelot('8A'), null], [null, parseCamelot('8A')]]) {
    assert.deepEqual(compatibility(...keys), { score: 0, relation: 'unknown', semitoneShift: null });
  }
});

test('pitch shifts apply to B, use the smallest movement, and yield a compatible key', () => {
  const a = { tonic: 9, mode: 'minor' };
  assert.equal(compatibility(a, { tonic: 10, mode: 'minor' }).semitoneShift, -1);
  assert.equal(compatibility(a, { tonic: 8, mode: 'minor' }).semitoneShift, 1);
  let unreachable = 0;
  for (const mode of ['major', 'minor']) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const b = { tonic, mode };
      const result = compatibility(a, b);
      const compatibleAt = shift => compatibility(a, { tonic: (tonic + shift + 12) % 12, mode }).score >= 0.85;
      if (result.semitoneShift === null) {
        unreachable++;
        assert.ok([-2, -1, 0, 1, 2].every(shift => !compatibleAt(shift)));
      } else {
        assert.ok(Math.abs(result.semitoneShift) <= 2);
        assert.ok(compatibleAt(result.semitoneShift));
        for (const shift of [-1, 0, 1]) {
          if (Math.abs(shift) < Math.abs(result.semitoneShift)) assert.ok(!compatibleAt(shift));
        }
      }
    }
  }
  assert.ok(unreachable > 0);
});

test('merge keeps the more confident label or averages and serializes chroma without mutations', () => {
  const { accumulator, estimate } = detect([60, 64, 67]);
  const low = { ...estimate, confidence: 0.2 };
  const high = { key: parseCamelot('8A'), confidence: 0.9 };
  assert.deepEqual(mergeKey(low, high).key, high.key);
  assert.deepEqual(mergeKey(high, low).key, high.key);
  assert.equal(mergeKey(null, null), null);
  assert.deepEqual(mergeKey(null, low).key, low.key);
  assert.deepEqual(mergeKey(low, null).key, low.key);
  const before = { ...estimate, chroma: accumulator.chroma() };
  const after = { ...estimate, chroma: [...accumulator.chroma()] };
  const savedBefore = [...before.chroma], savedAfter = [...after.chroma];
  const result = mergeKey(before, after);
  assert.deepEqual(result.key, estimate.key);
  assert.ok(Array.isArray(result.chroma));
  assert.equal(result.chroma.length, 12);
  result.chroma.forEach((value, i) => {
    close(value, savedBefore[i], 0.00005);
    close(value * 10000, Math.round(value * 10000));
  });
  assert.deepEqual([...before.chroma], savedBefore);
  assert.deepEqual(after.chroma, savedAfter);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(mergeKey(null, before).chroma, result.chroma);
  close(mergeKey(null, before).confidence, result.confidence);
  const different = { ...estimate, chroma: Float64Array.from(savedBefore, (value, i) => value + (i === 7 ? 0.1 : 0)) };
  const merged = mergeKey(before, different);
  merged.chroma.forEach((value, i) => close(value, (savedBefore[i] + different.chroma[i] / 1.1) / 2, 0.00005));
});

test('2000 additions of 4096-bin frames stay within the main-thread budget', t => {
  const accumulator = new ChromaAccumulator({ sampleRate: 44100, fftSize: 8192 });
  const frame = spectrum([60, 64, 67], { fftSize: 8192 });
  for (let i = 0; i < 100; i++) accumulator.add(frame);
  accumulator.reset();
  const start = performance.now();
  for (let i = 0; i < 2000; i++) accumulator.add(frame);
  const elapsed = performance.now() - start;
  assert.equal(accumulator.frames, 2000);
  assert.ok(elapsed < 1000, `2000 additions took ${elapsed.toFixed(1)} ms`);
  t.diagnostic(`2000 additions: ${elapsed.toFixed(1)} ms (${(elapsed / 2000).toFixed(3)} ms/frame)`);
});
