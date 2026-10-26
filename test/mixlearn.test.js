import test, { describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, LIMITS, MIN_OUTCOMES, bucketFor, parseBucket, rebucket, describeBucket, avoidsDropCut, choose, record, stats, reset } from '../src/js/mixlearn.js';

const KEY = 'quantm.mixlearn';

// Small seeded PRNG (mulberry32) so runs are repeatable.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Minimal in-memory localStorage (the real descriptor is put back after these tests).
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let store;
function installStorage() {
  store = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  } });
}

let fresh = 0;
const freshModule = () => import('../src/js/mixlearn.js?x=' + (++fresh));
const inLimits = params => ['length', 'dj', 'stretch'].every(f => params[f] >= LIMITS[f][0] && params[f] <= LIMITS[f][1]);

// Hooks stay inside this block so other test files sharing the process keep their storage.
describe('Auto mix learning', () => {
beforeEach(() => {
  installStorage();
  reset();
});

after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

test('bucketFor sorts tempos at the edges and treats bad input as no beat', () => {
  for (const [bpm, bucket] of [[99.9, 'slow'], [100, 'mid'], [129.9, 'mid'], [130, 'fast'],
    [159.9, 'fast'], [160, 'faster'], [null, 'nobeat'], [undefined, 'nobeat'], [NaN, 'nobeat'],
    [-5, 'nobeat'], [Infinity, 'nobeat'], ['120', 'nobeat']]) {
    assert.equal(bucketFor(bpm), bucket, String(bpm));
  }
});

test('defaults and limits are frozen and agree with each other', () => {
  assert.deepEqual({ ...DEFAULTS }, { length: 1, dj: 1, stretch: 0.08 });
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(LIMITS));
  assert.ok(inLimits(DEFAULTS));
});

test('choose with nothing learned starts from the defaults and varies within range', () => {
  const random = seeded(1);
  let sawLow = false;
  let sawHigh = false;
  for (let i = 0; i < 500; i++) {
    const c = choose('mid', random);
    assert.equal(c.bucket, 'mid');
    assert.deepEqual(c.base, { ...DEFAULTS });
    assert.ok(inLimits(c.params));
    assert.ok(Math.abs(c.params.length - 1) <= 0.12 + 1e-9);
    assert.ok(c.params.dj <= 1 && c.params.dj >= 1 - 0.15 - 1e-9);
    assert.ok(c.params.stretch <= 0.08 && c.params.stretch >= 0.08 - 0.008 - 1e-9);
    if (c.params.length < 0.95) sawLow = true;
    if (c.params.length > 1.05) sawHigh = true;
  }
  assert.ok(sawLow && sawHigh, 'length should vary both ways');
  // The injected random really drives the result: extremes hit the edges of the variation.
  assert.equal(choose('mid', () => 0).params.length, 0.88);
  assert.equal(choose('mid', () => 0.999999).params.dj, 1);
  assert.equal(choose('mid', () => 0).params.stretch, 0.072);
  // An unknown bucket falls back to nobeat.
  assert.equal(choose('wat', seeded(2)).bucket, 'nobeat');
});

test('good outcomes move the learned values slowly toward what was tried', () => {
  const random = seeded(3);
  const first = choose('slow', () => 0); // shorter than learned
  record(first, 'good');
  const afterOne = choose('slow', () => 0.5).base;
  // One record moves length by at most 10% of the variation that was tried.
  assert.ok(Math.abs(afterOne.length - 1) <= 0.1 * 0.12 + 1e-9);
  assert.ok(afterOne.length < 1);

  let last = afterOne.length;
  for (let i = 0; i < 60; i++) {
    const c = choose('slow', random);
    // Always try something shorter than the learned value.
    c.params.length = Math.max(LIMITS.length[0], c.base.length - 0.1);
    record(c, 'good');
    const now = choose('slow', () => 0.5).base.length;
    assert.ok(now <= last + 1e-9, 'length only drifts shorter');
    assert.ok(last - now <= 0.01 + 1e-9, 'each step is small');
    last = now;
  }
  assert.ok(last < 0.9, `length should have come down gradually, got ${last}`);
  assert.ok(last >= LIMITS.length[0]);
});

test('bad outcomes move the learned values away from what was tried', () => {
  const base = choose('fast', () => 0.5).base;
  const tried = { bucket: 'fast', base, params: { length: 1.1, dj: 0.9, stretch: 0.075 } };
  record(tried, 'bad');
  const after = choose('fast', () => 0.5).base;
  assert.ok(after.length < 1, 'moved away from longer');
  assert.ok(after.dj > 0.9 && after.dj <= 1, 'dj pushed up and held at the limit');
  assert.ok(after.stretch <= 0.08);
  assert.ok(Math.abs(after.length - (1 - 0.1 * 0.1)) < 1e-9);

  // Many skips after short mixes push length up, never past the limit.
  for (let i = 0; i < 400; i++) {
    const c = choose('fast', seeded(i));
    c.params.length = Math.max(LIMITS.length[0], c.base.length - 0.12);
    record(c, 'bad');
  }
  const end = choose('fast', () => 0.5).base;
  assert.ok(end.length > 1.2, `length ${end.length} should have grown`);
  assert.ok(end.length <= LIMITS.length[1]);
});

test('learned values never leave the limits', () => {
  const random = seeded(4);
  for (let i = 0; i < 1500; i++) {
    const c = choose('faster', random);
    // Exaggerate: pretend wild values were tried.
    c.params = { length: c.base.length + (random() - 0.5) * 20, dj: random() * 10 - 5, stretch: random() };
    record(c, random() < 0.5 ? 'good' : 'bad');
    const { base, params } = choose('faster', random);
    assert.ok(inLimits(base));
    assert.ok(inLimits(params));
  }
  const learned = stats().buckets.faster;
  assert.ok(inLimits(learned));
});

test('buckets learn independently', () => {
  record(choose('slow', () => 0), 'good');
  const slow = choose('slow', () => 0.5).base;
  assert.notDeepEqual(slow, { ...DEFAULTS });
  for (const other of ['mid', 'fast', 'faster', 'nobeat']) {
    assert.deepEqual(choose(other, () => 0.5).base, { ...DEFAULTS });
  }
});

test('stats counts good and bad outcomes and only lists buckets with data', () => {
  assert.deepEqual(stats(), { transitions: 0, buckets: {}, genres: {} });
  record(choose('slow', seeded(5)), 'good');
  record(choose('slow', seeded(6)), 'good');
  record(choose('slow', seeded(7)), 'bad');
  record(choose('nobeat', seeded(8)), 'bad');
  const s = stats();
  assert.equal(s.transitions, 4);
  assert.deepEqual(Object.keys(s.buckets).sort(), ['nobeat', 'slow']);
  assert.equal(s.buckets.slow.good, 2);
  assert.equal(s.buckets.slow.bad, 1);
  assert.equal(s.buckets.nobeat.bad, 1);
  assert.equal(s.buckets.nobeat.good, 0);
  assert.deepEqual(Object.keys(s.buckets.slow).sort(), ['bad', 'dj', 'good', 'length', 'stretch']);
  // The returned stats are a copy.
  s.buckets.slow.good = 99;
  assert.equal(stats().buckets.slow.good, 2);
});

test('unknown outcomes and malformed choices are ignored', () => {
  const good = choose('mid', seeded(9));
  record(good, 'maybe');
  record(good, undefined);
  record(null, 'good');
  record({}, 'good');
  record({ bucket: 'nope', base: good.base, params: good.params }, 'good');
  record({ bucket: 'mid', base: good.base }, 'good');
  record({ bucket: 'mid', base: good.base, params: { length: NaN, dj: 1, stretch: 0.08 } }, 'bad');
  record({ bucket: 'mid', base: { length: 1 }, params: good.params }, 'good');
  assert.deepEqual(stats(), { transitions: 0, buckets: {}, genres: {} });
  assert.equal(store.size, 1); // only reset() saved anything
});

test('learning is saved with rounded numbers and survives a fresh module', async () => {
  for (let i = 0; i < 5; i++) record(choose('mid', seeded(10 + i)), i % 2 ? 'bad' : 'good');
  const saved = JSON.parse(store.get(KEY));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.buckets), ['mid']);
  for (const f of ['length', 'dj', 'stretch']) {
    assert.equal(saved.buckets.mid[f], Math.round(saved.buckets.mid[f] * 10000) / 10000);
  }
  const before = stats();

  const other = await freshModule();
  assert.deepEqual(other.stats(), before);
  assert.deepEqual(other.choose('mid', () => 0.5).base,
    { length: saved.buckets.mid.length, dj: saved.buckets.mid.dj, stretch: saved.buckets.mid.stretch });
  other.record(other.choose('mid', seeded(20)), 'good');
  assert.equal(other.stats().transitions, 6);
});

test('reset forgets everything and persists that', async () => {
  record(choose('slow', () => 0), 'good');
  record(choose('fast', () => 1), 'bad');
  reset();
  assert.deepEqual(stats(), { transitions: 0, buckets: {}, genres: {} });
  assert.deepEqual(choose('slow', () => 0.5).base, { ...DEFAULTS });
  assert.deepEqual(JSON.parse(store.get(KEY)), { version: 1, buckets: {}, genres: {} });
  const other = await freshModule();
  assert.deepEqual(other.stats(), { transitions: 0, buckets: {}, genres: {} });
});

test('corrupt or odd stored data falls back to defaults and gets repaired', async () => {
  store.set(KEY, '{not json');
  let m = await freshModule();
  assert.deepEqual(m.choose('mid', () => 0.5).base, { ...DEFAULTS });
  assert.deepEqual(m.stats(), { transitions: 0, buckets: {}, genres: {} });

  store.set(KEY, JSON.stringify({ version: 2, buckets: { mid: { length: 0.7 } } }));
  m = await freshModule();
  assert.deepEqual(m.choose('mid', () => 0.5).base, { ...DEFAULTS });

  store.set(KEY, JSON.stringify({ version: 1, buckets: {
    mid: { length: 99, dj: -4, stretch: 'x', good: 3, bad: -2, extra: 1 },
    fast: { length: 0.8, dj: 0.5, stretch: 0.05, good: 1.7, bad: 'z' },
    weird: { length: 0.8 }, slow: 'nope'
  } }));
  m = await freshModule();
  const s = m.stats();
  assert.deepEqual(s.buckets.mid, { length: 1.5, dj: 0, stretch: 0.08, good: 3, bad: 0 });
  assert.deepEqual(s.buckets.fast, { length: 0.8, dj: 0.5, stretch: 0.05, good: 1, bad: 0 });
  assert.equal(s.buckets.weird, undefined);
  assert.equal(s.buckets.slow, undefined);
  assert.deepEqual(m.choose('slow', () => 0.5).base, { ...DEFAULTS });

  store.set(KEY, 'null');
  m = await freshModule();
  assert.deepEqual(m.stats(), { transitions: 0, buckets: {}, genres: {} });
});

test('throwing or missing storage never throws', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('full'); }
  } });
  let m = await freshModule();
  assert.deepEqual(m.choose('mid', () => 0.5).base, { ...DEFAULTS });
  assert.doesNotThrow(() => m.record(m.choose('mid', seeded(30)), 'good'));
  // Learning still works in memory for this session.
  assert.equal(m.stats().transitions, 1);
  assert.doesNotThrow(() => m.reset());
  assert.equal(m.stats().transitions, 0);

  delete globalThis.localStorage;
  m = await freshModule();
  assert.deepEqual(m.choose('slow', seeded(31)).base, { ...DEFAULTS });
  assert.doesNotThrow(() => m.record(m.choose('slow', seeded(32)), 'bad'));
  assert.equal(m.stats().buckets.slow.bad, 1);
  assert.doesNotThrow(() => m.reset());
});

test('bucketFor adds the genre family, and unknown or missing families stay tempo-only', () => {
  assert.equal(bucketFor(145, 'bass'), 'bass:fast');
  assert.equal(bucketFor(90, 'hiphop'), 'hiphop:slow');
  assert.equal(bucketFor(120, 'dance'), 'dance:mid');
  assert.equal(bucketFor(170, 'other'), 'other:faster');
  assert.equal(bucketFor(null, 'bass'), 'bass:nobeat');
  for (const family of ['unknown', undefined, null, 'polka', 7]) assert.equal(bucketFor(145, family), 'fast');
  assert.deepEqual(parseBucket('bass:fast'), { family: 'bass', tempo: 'fast' });
  assert.deepEqual(parseBucket('fast'), { family: null, tempo: 'fast' });
  for (const bad of ['polka:fast', 'bass:warp', 'a:b:c', '', null, 'unknown:fast']) assert.equal(parseBucket(bad), null, String(bad));
  assert.equal(rebucket('bass:nobeat', 150), 'bass:fast');
  assert.equal(rebucket('nobeat', 150), 'fast');
});

test('describeBucket names the genre and tempo', () => {
  assert.equal(describeBucket('bass:fast'), 'bass music · 130-160 BPM');
  assert.equal(describeBucket('hiphop:slow'), 'hip-hop · under 100 BPM');
  assert.equal(describeBucket('dance:nobeat'), 'dance music · no clear beat');
  assert.equal(describeBucket('mid'), '100-130 BPM');
  assert.equal(describeBucket('nobeat'), 'songs without a clear beat');
});

test('a genre bucket borrows the tempo values until it has enough outcomes', () => {
  // learn something at the tempo level from another genre
  for (let i = 0; i < 4; i++) record(choose('hiphop:fast', () => 0), 'good');
  const tempo = choose('fast', () => 0.5).base;
  assert.notDeepEqual(tempo, { ...DEFAULTS });
  // bass has no data of its own: it starts from the tempo-only values
  assert.deepEqual(choose('bass:fast', () => 0.5).base, tempo);
  assert.equal(choose('bass:fast', () => 0.5).bucket, 'bass:fast');
  // under MIN_OUTCOMES outcomes it still uses the tempo values, even as it learns
  for (let i = 0; i < MIN_OUTCOMES - 1; i++) {
    assert.deepEqual(choose('bass:fast', () => 0.5).base, choose('fast', () => 0.5).base, 'tempo values until enough data');
    record(choose('bass:fast', () => 1), 'good');
  }
  assert.equal(stats().genres['bass:fast'].good, MIN_OUTCOMES - 1);
  // with enough outcomes its own values take over
  record(choose('bass:fast', () => 1), 'good');
  const learned = stats().genres['bass:fast'];
  assert.equal(learned.good, MIN_OUTCOMES);
  const own = choose('bass:fast', () => 0.5).base;
  assert.deepEqual(own, { length: learned.length, dj: learned.dj, stretch: learned.stretch });
  // and keeps learning on its own: a bad outcome now moves bass but leaves hip-hop's own record alone
  const hiphop = stats().genres['hiphop:fast'];
  record(choose('bass:fast', () => 1), 'bad');
  assert.notDeepEqual(choose('bass:fast', () => 0.5).base, own);
  assert.deepEqual(stats().genres['hiphop:fast'], hiphop);
});

test('a genre bucket continues from the tempo values, with no jump when it takes over', () => {
  for (let i = 0; i < 6; i++) record(choose('fast', () => 0), 'good'); // tempo-only learning, shorter mixes
  const tempo = choose('fast', () => 0.5).base;
  assert.ok(tempo.length < 1);
  for (let i = 0; i < MIN_OUTCOMES; i++) record(choose('dance:fast', () => 0.5), 'good');
  const genre = choose('dance:fast', () => 0.5).base;
  assert.ok(Math.abs(genre.length - tempo.length) < 0.01, 'starts from what the tempo learned, not from the defaults');
});

test('every genre transition also teaches the tempo-only bucket, and stats count it once', () => {
  record(choose('bass:fast', seeded(40)), 'good');
  record(choose('hiphop:fast', seeded(41)), 'bad');
  record(choose('fast', seeded(42)), 'good');
  const s = stats();
  assert.equal(s.transitions, 3);
  assert.equal(s.buckets.fast.good + s.buckets.fast.bad, 3);
  assert.deepEqual(Object.keys(s.genres).sort(), ['bass:fast', 'hiphop:fast']);
  assert.equal(s.genres['bass:fast'].good, 1);
  assert.equal(s.genres['hiphop:fast'].bad, 1);
  s.genres['bass:fast'].good = 99; // a copy
  assert.equal(stats().genres['bass:fast'].good, 1);
});

test('drop cut history is kept per genre and a genre follows its own record once it has enough', () => {
  const cut = (bucket, outcome) => record({ ...choose(bucket, () => 0.5), style: 'dropcut' }, outcome);
  for (let i = 0; i < 3; i++) cut('dance:fast', 'good');
  for (let i = 0; i < 4; i++) cut('hiphop:fast', 'bad');
  assert.equal(avoidsDropCut('fast'), true, 'tempo bucket: 4 bad vs 3 good');
  // hip-hop has 4 outcomes (< 5) and dance 3: both still follow the tempo bucket
  assert.equal(avoidsDropCut('hiphop:fast'), true);
  assert.equal(avoidsDropCut('dance:fast'), true);
  for (let i = 0; i < 4; i++) cut('dance:fast', 'good'); // dance has 7 good now
  assert.equal(avoidsDropCut('dance:fast'), false, 'its own record wins once it has enough');
  assert.equal(avoidsDropCut('bass:slow'), false);
  assert.equal(avoidsDropCut('bogus'), false);
});

test('old saved data (tempo buckets only) loads untouched and becomes the genre fallback', async () => {
  const old = { length: 0.8, dj: 0.7, stretch: 0.05, good: 6, bad: 2, styles: { blend: { good: 5, bad: 1 }, dropcut: { good: 1, bad: 1 } } };
  store.set(KEY, JSON.stringify({ version: 1, buckets: { fast: old, mid: { length: 1.2, dj: 1, stretch: 0.08, good: 1, bad: 0 } } }));
  const m = await freshModule();
  const s = m.stats();
  assert.equal(s.transitions, 9);
  assert.deepEqual(s.genres, {});
  assert.deepEqual(s.buckets.fast, old);
  // every genre starts from the old values for its tempo
  for (const family of ['dance', 'bass', 'hiphop', 'other']) {
    assert.deepEqual(m.choose(`${family}:fast`, () => 0.5).base, { length: 0.8, dj: 0.7, stretch: 0.05 });
  }
  assert.deepEqual(m.choose('bass:slow', () => 0.5).base, { ...DEFAULTS });
  // learning a genre mix keeps the old tempo data and adds to it
  m.record(m.choose('bass:fast', seeded(50)), 'good');
  const saved = JSON.parse(store.get(KEY));
  assert.equal(saved.version, 1);
  assert.equal(saved.buckets.fast.good, 7);
  assert.equal(saved.buckets.mid.length, 1.2);
  assert.equal(saved.genres['bass:fast'].good, 1);
  // a fresh module reads the new format back
  assert.deepEqual((await freshModule()).stats(), m.stats());
});

test('odd saved genre data is repaired or dropped', async () => {
  store.set(KEY, JSON.stringify({ version: 1, buckets: { fast: { length: 0.9, good: 2 } }, genres: {
    'bass:fast': { length: 99, dj: -1, stretch: 'x', good: 3, bad: -2 },
    'polka:fast': { good: 4 }, 'bass:warp': { good: 4 }, fast: { good: 4 }, 'hiphop:mid': 'nope'
  } }));
  const s = (await freshModule()).stats();
  assert.deepEqual(s.genres['bass:fast'], { length: 1.5, dj: 0, stretch: 0.08, good: 3, bad: 0 });
  assert.equal(s.buckets.fast.good, 2);
  assert.ok(!('hiphop:mid' in s.genres) || s.genres['hiphop:mid'].good === 0);
  store.set(KEY, JSON.stringify({ version: 1, buckets: {}, genres: 'nope' }));
  assert.deepEqual((await freshModule()).stats(), { transitions: 0, buckets: {}, genres: {} });
});

test('reset clears genre buckets too and persists that', async () => {
  record(choose('bass:fast', () => 0), 'good');
  record(choose('hiphop:slow', () => 1), 'bad');
  reset();
  assert.deepEqual(stats(), { transitions: 0, buckets: {}, genres: {} });
  assert.deepEqual(choose('bass:fast', () => 0.5).base, { ...DEFAULTS });
  assert.deepEqual(JSON.parse(store.get(KEY)), { version: 1, buckets: {}, genres: {} });
  assert.deepEqual((await freshModule()).stats(), { transitions: 0, buckets: {}, genres: {} });
});
});
