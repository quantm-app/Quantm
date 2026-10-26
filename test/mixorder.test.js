import test from 'node:test';
import assert from 'node:assert/strict';
import { tempoFromText, tempoFromWaveform, energyShape, features, tempoFit, blendCost,
  orderForMixing, pickNext, describeBlend, genreFamily } from '../src/js/mixorder.js';

function random(seed = 12345) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function shuffle(values, rand) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function envelope(bpm, seed = 71) {
  const rand = random(seed);
  return Float32Array.from({ length: 1800 }, (_, i) => {
    const phase = (i / 10 * bpm / 60 + 0.17) % 1;
    return 0.08 + 0.85 * Math.exp(-phase / 0.14) + 0.02 * rand();
  });
}

function song(bpm, genre = '', tags = '') {
  return features({ id: bpm, bpm, genre, tag_list: tags });
}

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

function permutation(order, length, start = 0) {
  assert.equal(order.length, length);
  assert.deepEqual(order.slice().sort((a, b) => a - b), Array.from({ length }, (_, i) => i));
  if (length) assert.equal(order[0], start);
}

function transitions(items, order) {
  let cost = 0, jumps = 0, reversals = 0, direction = 0;
  for (let i = 1; i < order.length; i++) {
    const blend = blendCost(items[order[i - 1]], items[order[i]]);
    cost += blend.cost;
    if (blend.fit && !blend.fit.ok) jumps++;
    const nextDirection = Math.sign(items[order[i]].bpm - items[order[i - 1]].bpm);
    if (direction && nextDirection && direction !== nextDirection) reversals++;
    if (nextDirection) direction = nextDirection;
  }
  return { cost, jumps, reversals };
}

test('tempo text recognizes explicit title, tag, and description patterns', () => {
  for (const title of ['174 BPM', 'song 174bpm remix', '[174 BPM]', 'BPM: 174', '174-bpm',
    '@ 174 bpm', 'bpm174', 'BPM 174', 'artist - song (174 bpm)']) {
    assert.deepEqual(tempoFromText({ title }), { bpm: 174, source: 'title' }, title);
  }
  assert.deepEqual(tempoFromText({ title: '[128.5 BPM]' }), { bpm: 128.5, source: 'title' });
  for (const tag_list of ['trance 174bpm', 'bpm174 trance', '"174 bpm" "hard dance"',
    'trance 174 bpm', '"BPM: 174"']) {
    assert.deepEqual(tempoFromText({ tag_list }), { bpm: 174, source: 'tags' }, tag_list);
  }
  for (const description of ['Made at 128 BPM today', 'BPM: 128\nAlso 174bpm', '128-bpm demo']) {
    assert.deepEqual(tempoFromText({ description }), { bpm: 128, source: 'description' });
  }
  assert.deepEqual(tempoFromText({ title: '60bpm' }), { bpm: 60, source: 'title' });
  assert.deepEqual(tempoFromText({ title: '220bpm' }), { bpm: 220, source: 'title' });
});

test('tempo text rejects bare numbers, years, invalid values, and unrelated words', () => {
  for (const title of ['Track 1999', 'Mix 2024', 'Vol. 150', 'Track 01', '128', '300 bpm',
    '59 BPM', '221 bpm', '1999bpm', 'BPM: 2024', '128bpms', 'abc128bpm', '-128bpm', '1128bpm']) {
    assert.equal(tempoFromText({ title }), null, title);
  }
  assert.equal(tempoFromText({ description: '300 BPM followed by 128 BPM' }), null);
  for (const input of [null, undefined, {}, { bpm: '128' }, { bpm: NaN }, { bpm: Infinity }, { bpm: 0 }]) {
    assert.equal(tempoFromText(input), null);
  }
});

test('tempo text prioritizes SoundCloud, then title, tags, and description', () => {
  const track = { bpm: 130, title: '140 bpm', tag_list: '150bpm', description: '160 bpm' };
  assert.deepEqual(tempoFromText(track), { bpm: 130, source: 'soundcloud' });
  for (const bpm of [40, 50, 250]) {
    assert.deepEqual(tempoFromText({ ...track, bpm }), { bpm, source: 'soundcloud' });
  }
  assert.deepEqual(tempoFromText({ ...track, bpm: 251 }), { bpm: 140, source: 'title' });
  delete track.bpm;
  assert.deepEqual(tempoFromText(track), { bpm: 140, source: 'title' });
  delete track.title;
  assert.deepEqual(tempoFromText(track), { bpm: 150, source: 'tags' });
  delete track.tag_list;
  assert.deepEqual(tempoFromText(track), { bpm: 160, source: 'description' });
});

for (const bpm of [120, 140, 174]) {
  test(`waveform envelope at ${bpm} BPM gives a useful rough tempo`, () => {
    for (const seed of [71, 12345, 98765]) {
      const result = tempoFromWaveform(envelope(bpm, seed), 180);
      assert.ok(result, `missing estimate for ${bpm}, seed ${seed}`);
      assert.ok([0.5, 1, 2].some(factor => Math.abs(result.bpm - bpm * factor) <= 3),
        `${bpm} BPM read as ${result.bpm}`);
      assert.ok(result.confidence >= 0.2 && result.confidence <= 1);
      assert.ok(result.bpm >= 85 && result.bpm <= 175);
    }
  });
}

test('waveform rejects flat envelopes, noise, and invalid inputs', () => {
  assert.equal(tempoFromWaveform(new Float32Array(1800), 180), null);
  assert.equal(tempoFromWaveform(new Float32Array(1800).fill(0.7), 180), null);
  for (let seed = 1; seed <= 10; seed++) {
    assert.equal(tempoFromWaveform(Array.from({ length: 1800 }, random(seed)), 180), null);
  }
  for (const duration of [null, undefined, 0, -10, NaN, Infinity, '180']) {
    assert.equal(tempoFromWaveform(envelope(120), duration), null);
  }
  for (const samples of [null, [], {}, [0, 1], [NaN, Infinity]]) {
    assert.equal(tempoFromWaveform(samples, 180), null);
  }
  assert.equal(tempoFromWaveform(new Float32Array(1800).fill(NaN), 180), null);
});

test('energy shape uses the top-half median and means at the two edges', () => {
  assert.deepEqual(energyShape([0, 0.2, 0.4, 0.6, 0.8, 1]), { overall: 0.8, intro: 0, outro: 1 });
  close(energyShape([0, 0.1, 0.4, 0.8]).overall, 0.6);
  assert.deepEqual(energyShape([0.4]), { overall: 0.4, intro: 0.4, outro: 0.4 });
  const ramp = Array.from({ length: 100 }, (_, i) => i / 100);
  const shape = energyShape(ramp);
  close(shape.intro, 0.035);
  close(shape.outro, 0.955);
  close(shape.overall, 0.745);
  assert.deepEqual(energyShape(new Float32Array(100).fill(1)), { overall: 1, intro: 1, outro: 1 });
  for (const samples of [null, [], {}, [NaN], [Infinity]]) assert.equal(energyShape(samples), null);
});

test('features parses tags and follows the complete tempo priority', () => {
  const track = { id: 42, bpm: 128, title: '140 bpm', genre: '  HARD   Dance ',
    tag_list: 'Trance "Hard Dance" 150bpm bpm174 "174 bpm" 300bpm trance 160 bpm "bpm 180"',
    description: '160bpm', duration: 180000 };
  const waveform = envelope(120);
  const fromMemory = features(track, { memory: { bpm: 174, confidence: 0.95 }, waveform });
  assert.equal(fromMemory.id, 42);
  assert.equal(fromMemory.bpm, 174);
  assert.equal(fromMemory.bpmSource, 'memory');
  assert.equal(fromMemory.bpmConfidence, 0.95);
  assert.equal(fromMemory.genre, 'hard dance');
  assert.deepEqual(fromMemory.tags, ['trance', 'hard dance']);
  assert.deepEqual(fromMemory.energy, energyShape(waveform));
  assert.equal(features(track, { memory: { bpm: 130, confidence: 0.1 } }).bpmConfidence, 0.6);
  assert.equal(features(track, { memory: { bpm: 130, confidence: 2 } }).bpmConfidence, 1);
  assert.equal(features(track, { memory: { bpm: NaN, confidence: 1 } }).bpmSource, 'soundcloud');
  for (const [field, source, bpm] of [['bpm', 'soundcloud', 128], ['title', 'title', 140],
    ['tag_list', 'tags', 150], ['description', 'description', 160]]) {
    const result = features(track, { waveform });
    assert.equal(result.bpm, bpm);
    assert.equal(result.bpmSource, source);
    assert.equal(result.bpmConfidence, 0.7);
    delete track[field];
  }
  const estimated = features(track, { waveform });
  assert.equal(estimated.bpmSource, 'waveform');
  close(estimated.bpmConfidence, tempoFromWaveform(waveform, 180).confidence * 0.6);
  assert.deepEqual(features({ id: 9 }), { id: 9, bpm: null, bpmSource: null, bpmConfidence: 0,
    genre: '', tags: [], energy: null });
});

test('tempo fit always returns the nearest normal, half, or double-time rate', () => {
  close(tempoFit(122, 124).ratio, 122 / 124);
  close(tempoFit(122, 124).stretch, 1 - 122 / 124);
  assert.deepEqual(tempoFit(87, 174), { ratio: 1, stretch: 0, ok: true });
  assert.deepEqual(tempoFit(174, 87), { ratio: 1, stretch: 0, ok: true });
  assert.deepEqual(tempoFit(108, 100), { ratio: 1.08, stretch: 0.08000000000000007, ok: true });
  assert.equal(tempoFit(122, 124, 0.01).ok, false);
  assert.equal(tempoFit(120, 150).ok, false);
  assert.equal(tempoFit(120, 150).ratio, 0.8);
  for (const bpm of [null, undefined, 0, -100, NaN, Infinity, '120']) {
    assert.equal(tempoFit(120, bpm), null);
    assert.equal(tempoFit(bpm, 120), null);
  }
});

test('blend costs prioritize tempo and expose readable reasons', () => {
  const current = song(122, 'trance');
  const same = blendCost(current, song(122, 'trance'));
  const closeTempo = blendCost(current, song(124));
  const half = blendCost(current, song(61));
  const unknown = blendCost(current, song(null));
  const far = blendCost(current, song(150));
  assert.ok(same.cost < closeTempo.cost && closeTempo.cost < half.cost &&
    half.cost < unknown.cost && unknown.cost < far.cost);
  assert.ok(same.reasons.includes('same tempo') && same.reasons.includes('same genre'));
  assert.ok(closeTempo.reasons.includes('122 → 124 BPM'));
  assert.ok(half.reasons.includes('half time'));
  assert.ok(far.reasons.includes('big tempo jump'));
  assert.ok(unknown.reasons.includes('tempo unknown'));
  assert.equal(unknown.fit, null);
  assert.ok(blendCost(song(null), song(null)).cost < unknown.cost);
  const tagged = blendCost(song(122, '', 'trance'), song(124, '', 'trance'));
  assert.ok(tagged.cost < closeTempo.cost && tagged.reasons.includes('shares tags'));
  const loud = { ...current, energy: { overall: 1, intro: 0.8, outro: 1 } };
  const quiet = { ...current, energy: { overall: 0.1, intro: 0.1, outro: 0 } };
  const drop = blendCost(loud, quiet);
  assert.ok(drop.cost > same.cost && drop.reasons.includes('energy drop'));
  assert.ok(blendCost(quiet, loud).reasons.includes('energy rise'));
  assert.ok(blendCost(current, song(150), { maxStretch: 0.25 }).cost < far.cost);
  assert.deepEqual(blendCost(current, song(150)), far);
  for (const result of [same, closeTempo, half, unknown, far, tagged, drop]) assert.ok(result.cost >= 0);
});

test('mix order is a repeatable permutation, with seed-dependent variety and no input mutation', () => {
  const items = shuffle(Array.from({ length: 61 }, (_, i) => song(120 + i / 2, 'trance')), random(32));
  for (const item of items) { Object.freeze(item.tags); Object.freeze(item); }
  Object.freeze(items);
  const order = orderForMixing(items, { start: 17, random: random(123) });
  permutation(order, items.length, 17);
  assert.deepEqual(orderForMixing(items, { start: 17, random: random(123) }), order);
  assert.notDeepEqual(orderForMixing(items, { start: 17, random: random(124) }), order);
});

test('mix order has much lower blend cost, fewer big jumps, and less reversal than random sets', t => {
  const items = shuffle(Array.from({ length: 61 }, (_, i) => song(120 + i / 2, 'trance')), random(63));
  const start = items.findIndex(item => item.bpm === 120);
  const rand = random(52);
  const rest = items.map((_, i) => i).filter(i => i !== start);
  const baseline = { cost: 0, jumps: 0, reversals: 0 };
  for (let i = 0; i < 50; i++) {
    const result = transitions(items, [start, ...shuffle(rest, rand)]);
    for (const key of Object.keys(baseline)) baseline[key] += result[key] / 50;
  }
  for (const seed of [1, 71, 12345, 98765]) {
    const order = orderForMixing(items, { start, random: random(seed) });
    permutation(order, items.length, start);
    const result = transitions(items, order);
    assert.ok(result.cost < baseline.cost * 0.35, `${result.cost} vs random ${baseline.cost}`);
    assert.ok(result.jumps < baseline.jumps * 0.25, `${result.jumps} vs random ${baseline.jumps}`);
    assert.ok(result.reversals < baseline.reversals * 0.65);
    t.diagnostic(`seed ${seed}: cost ${result.cost.toFixed(2)}, big jumps ${result.jumps}; ` +
      `random means ${baseline.cost.toFixed(2)}, ${baseline.jumps.toFixed(2)}`);
  }
});

test('unknown tempos can bridge a costly jump near their genre and tag matches', () => {
  const items = [song(120, 'techno', 'warehouse'), song(174, 'dnb'),
    song(null, 'techno', 'warehouse'), song(null, 'techno', 'warehouse'), song(176, 'dnb')];
  for (const seed of [1, 71, 12345]) {
    const order = orderForMixing(items, { random: random(seed) });
    permutation(order, items.length);
    assert.ok(order.indexOf(2) < order.indexOf(1) && order.indexOf(3) < order.indexOf(1));
  }
  const unknown = Array.from({ length: 80 }, () => song(null, 'ambient'));
  permutation(orderForMixing(unknown, { start: 32, random: random(31) }), 80, 32);
});

test('tempo drift keeps octave transitions gradual instead of treating them as huge jumps', () => {
  const items = [song(86), song(174), song(88), song(178), song(90), song(182)];
  const order = orderForMixing(items, { random: random(42) });
  permutation(order, items.length);
  assert.ok(transitions(items, order).jumps === 0);
});

test('mix ordering handles empty, tiny, and invalid-start inputs', () => {
  assert.deepEqual(orderForMixing([], { random: random(1) }), []);
  assert.deepEqual(orderForMixing([song(120)], { random: random(1) }), [0]);
  assert.deepEqual(orderForMixing([song(120), song(null)], { start: 1, random: random(1) }), [1, 0]);
  for (const start of [-1, 2, 0.5, NaN]) {
    assert.deepEqual(orderForMixing([song(null), song(null)], { start, random: random(1) }), [0, 1]);
  }
});

test('2000 tracks order in under 300 ms with bounded candidate search', t => {
  const rand = random(331);
  const genres = ['trance', 'breakcore', 'techno', 'dnb'];
  const items = Array.from({ length: 2000 }, (_, i) => song(i % 11 ? 80 + rand() * 120 : null,
    genres[i % genres.length], `"${genres[i % genres.length]} mix" electronic`));
  orderForMixing(items.slice(0, 100), { random: random(1) });
  const start = performance.now();
  const order = orderForMixing(items, { start: 321, random: random(71) });
  const elapsed = performance.now() - start;
  permutation(order, items.length, 321);
  assert.ok(elapsed < 300, `ordering took ${elapsed.toFixed(2)} ms`);
  t.diagnostic(`2000 tracks ordered in ${elapsed.toFixed(2)} ms`);
});

test('pickNext returns best candidate indices and randomizes only near ties', () => {
  const current = song(122, 'trance');
  const candidates = [song(150), song(124), song(122, 'trance'), song(null)];
  assert.deepEqual(pickNext(current, candidates, { random: random(1) }), [2]);
  assert.deepEqual(pickNext(current, candidates, { count: 9, random: random(1) }), [2, 1, 3, 0]);
  assert.deepEqual(pickNext(current, [], { random: random(1) }), []);
  assert.deepEqual(pickNext(current, candidates, { count: 0, random: random(1) }), []);
  assert.deepEqual(pickNext(current, candidates, { count: -3, random: random(1) }), []);
  const ties = Array.from({ length: 8 }, () => song(122, 'trance'));
  const a = pickNext(current, ties, { count: 3, random: random(71) });
  assert.deepEqual(pickNext(current, ties, { count: 3, random: random(71) }), a);
  assert.notDeepEqual(pickNext(current, ties, { count: 3, random: random(12345) }), a);
  assert.equal(new Set(a).size, 3);
});

test('describeBlend gives whole BPM labels, half time, jumps, and neutral unknowns', () => {
  assert.deepEqual(describeBlend(song(122), song(124)), { ok: true, text: '122 → 124 BPM' });
  assert.deepEqual(describeBlend(song(122.2), song(123.8)), { ok: true, text: '122 → 124 BPM' });
  assert.deepEqual(describeBlend(song(87), song(174)), { ok: true, text: '87 → 174 BPM (half time)' });
  assert.deepEqual(describeBlend(song(174), song(87)), { ok: true, text: '174 → 87 BPM (half time)' });
  assert.deepEqual(describeBlend(song(122), song(150)), { ok: false, text: 'big tempo jump' });
  assert.deepEqual(describeBlend(song(122), song(150), { maxStretch: 0.25 }),
    { ok: true, text: '122 → 150 BPM' });
  assert.deepEqual(describeBlend(song(null), song(150)), { ok: true, text: 'tempo unknown' });
});

test('genreFamily sorts genres, tags and titles into coarse families', () => {
  const cases = [
    [{ genre: 'Dubstep' }, 'bass'], [{ genre: 'Drum & Bass' }, 'bass'], [{ genre: 'drum and bass' }, 'bass'],
    [{ genre: 'Electronic', tag_list: 'riddim bass' }, 'bass'], [{ tag_list: '"future bass" jungle' }, 'bass'],
    [{ genre: 'Hip-hop & Rap' }, 'hiphop'], [{ genre: 'Trap' }, 'hiphop'], [{ tag_list: 'boom bap rap' }, 'hiphop'],
    [{ genre: 'House' }, 'dance'], [{ genre: 'Techno' }, 'dance'], [{ tag_list: 'psytrance goa' }, 'dance'],
    [{ genre: 'Dance & EDM' }, 'dance'], [{ genre: 'Electronic' }, 'dance'], [{ genre: 'Electronic', tag_list: 'deep house' }, 'dance'],
    [{ genre: 'Pop' }, 'other'], [{ genre: 'Rock', tag_list: 'indie' }, 'other'], [{ genre: 'Dancehall' }, 'other'],
    [{ genre: 'Garage Rock' }, 'other'], [{ tag_list: 'acoustic folk' }, 'other'],
    [{ genre: 'Something Unusual' }, 'other'],
    [{}, 'unknown'], [null, 'unknown'], [{ genre: '', tag_list: 'remix cover' }, 'unknown']
  ];
  for (const [input, family] of cases) assert.equal(genreFamily(input), family, JSON.stringify(input));
  // a specific style beats the general "electronic", and the genre field is read before the tags
  assert.equal(genreFamily({ genre: 'Hip-hop', tag_list: 'house' }), 'hiphop');
  assert.equal(genreFamily({ genre: 'Dance', tag_list: 'dubstep' }), 'bass');
  // titles only count with unmistakable terms, and only when nothing else is known
  assert.equal(genreFamily({ title: 'Heavy Dubstep Drop' }), 'bass');
  assert.equal(genreFamily({ title: 'Bass Down Low' }), 'unknown');
  assert.equal(genreFamily({ title: 'House of Cards' }), 'unknown');
  assert.equal(genreFamily({ genre: 'Pop', title: 'Trap Queen' }), 'other');
});

test('genreFamily reads queue features as well as raw tracks', () => {
  const track = { id: 1, genre: 'Techno', tag_list: 'dark "hard techno"' };
  assert.equal(genreFamily(features(track)), 'dance');
  assert.equal(genreFamily(features({ id: 2, genre: '', tag_list: 'dnb' })), 'bass');
  assert.equal(genreFamily({ ...features({ id: 3 }), title: 'Dubstep mix' }), 'bass');
});
