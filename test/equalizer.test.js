import test from 'node:test';
import assert from 'node:assert/strict';
import { EQ_BANDS, EQ_PRESETS, clampDb, presetFor, matchingPreset, normalizeEqualizer } from '../src/js/equalizer.js';

test('EQ clamps invalid and out of range values and repairs partial saved settings', () => {
  assert.deepEqual(EQ_BANDS, [60, 230, 910, 3600, 14000]);
  for (const [input, expected] of [[99, 12], [-99, -12], [Infinity, 0], [NaN, 0], ['2.5', 2.5]]) {
    assert.equal(clampDb(input), expected);
  }
  assert.deepEqual(normalizeEqualizer({ enabled: true, gains: [99, -99], preamp: -40 }),
    { enabled: true, preset: 'Custom', gains: [12, -12, 0, 0, 0], preamp: -12 });
  assert.deepEqual(normalizeEqualizer(null), { enabled: false, preset: 'Flat', preamp: 0, gains: [0, 0, 0, 0, 0] });
});

test('every preset round trips, copies its gains, and custom changes stay custom', () => {
  assert.equal(Object.keys(EQ_PRESETS).length, 10);
  for (const name of Object.keys(EQ_PRESETS)) {
    const preset = presetFor(name);
    assert.equal(matchingPreset(preset.gains, preset.preamp), name);
    preset.gains[0] = 12;
    assert.notDeepEqual(preset.gains, EQ_PRESETS[name]);
    assert.ok(EQ_PRESETS[name].every(v => v >= -12 && v <= 12));
  }
  assert.deepEqual(presetFor('unknown'), presetFor('Flat'));
  assert.deepEqual(presetFor('toString'), presetFor('Flat'));
  assert.equal(matchingPreset([0, 0]), 'Custom');
  assert.equal(matchingPreset([0, 0, 0, 0, 0], 1), 'Custom');
  assert.equal(normalizeEqualizer({ preset: 'Custom', gains: [0, 0, 0, 0, 0] }).preset, 'Custom');
});

test('EQ graph covers both decks before the limiter and bypasses preamp as well as bands', async t => {
  const { installBrowser } = await import('./helpers/browser.js');
  installBrowser();
  t.mock.method(globalThis, 'setInterval', () => 0);
  const param = () => ({ value: 1, targets: [],
    setTargetAtTime(value, time, constant) { this.targets.push({ value, time, constant }); },
    cancelScheduledValues() {}, setValueAtTime() {} });
  const node = () => ({ outputs: [], gain: param(), frequency: param(), Q: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    connect(next) { this.outputs.push(next); return next; } });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = class {
    currentTime = 42;
    sampleRate = 48000;
    destination = node();
    createGain = node;
    createBiquadFilter = node;
    createDynamicsCompressor = node;
    createAnalyser = node;
    createMediaElementSource = node;
  };
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete globalThis.AudioContext;
  });
  const { Normalizer } = await import('../src/js/normalizer.js');
  const audio = {};
  const normalizer = new Normalizer(audio);
  normalizer.setEqualizer({ enabled: true, preamp: -3, gains: [6, 3, 0, 1, 2] });
  assert.equal(normalizer.init(), true);
  const { eqFilters, gain, preamp, limiter, output, sleepGain } = normalizer;
  assert.deepEqual(eqFilters.map(f => f.type), ['lowshelf', 'peaking', 'peaking', 'peaking', 'highshelf']);
  assert.deepEqual(eqFilters.map(f => f.frequency.value), EQ_BANDS);
  assert.equal(gain.outputs[0], preamp);
  assert.equal(preamp.outputs[0], eqFilters[0]);
  assert.equal(eqFilters[4].outputs[0], limiter);
  assert.equal(limiter.outputs[0], output);
  assert.equal(output.outputs[0], sleepGain);
  assert.ok(preamp.gain.targets.at(-1).value < 1);
  const second = {};
  assert.equal(normalizer.addDeck(second), true);
  for (const deck of [normalizer.decks.get(audio), normalizer.decks.get(second)]) {
    // fade → Auto mix bass shelf → mid band → high shelf (all flat outside a mix) → the deck's loudness gain → low-pass → mix
    assert.equal(deck.fade.outputs[0], deck.bass);
    assert.equal(deck.bass.type, 'lowshelf');
    assert.equal(deck.bass.outputs[0], deck.mid);
    assert.equal(deck.mid.type, 'peaking');
    assert.equal(deck.mid.outputs[0], deck.high);
    assert.equal(deck.high.type, 'highshelf');
    assert.equal(deck.high.outputs[0], deck.level);
    assert.equal(deck.mid.gain.value, 0);
    assert.equal(deck.high.gain.value, 0);
    // ...then the filter fade's low-pass, wide open outside a filter fade
    assert.equal(deck.level.outputs[0], deck.lowpass);
    assert.equal(deck.lowpass.type, 'lowpass');
    assert.equal(deck.lowpass.outputs[0], gain);
  }
  normalizer.setEqualizer({ enabled: false, preamp: 12, gains: [12, 12, 12, 12, 12] });
  assert.equal(preamp.gain.targets.at(-1).value, 1);
  eqFilters.forEach(f => {
    assert.deepEqual(f.gain.targets.at(-1), { value: 0, time: 42, constant: 0.03 });
  });
  normalizer.setVolume(0.6, false);
  normalizer.fadeForSleep(8);
  assert.equal(sleepGain.gain.targets.at(-1).value, 0);
  normalizer.restoreSleepVolume();
  assert.equal(sleepGain.gain.targets.at(-1).value, 1);
  assert.equal(normalizer.volume, 0.6);
  assert.equal(output.gain.targets.at(-1).value, 0.36);
});
