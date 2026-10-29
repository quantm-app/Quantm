import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

test('mixpairs remembers each pair, each song and each genre pair, ignores junk, and resets', async () => {
  installBrowser();
  const pairs = await import('../src/js/mixpairs.js');
  pairs.record({ fromId: 1, toId: 2, fromFamily: 'dance', toFamily: 'bass' }, 'good');
  pairs.record({ fromId: 1, toId: 2, fromFamily: 'dance', toFamily: 'bass' }, 'bad');
  pairs.record({ fromId: 2, toId: 3 }, 'good');
  for (const junk of [[{ fromId: 1, toId: 1 }, 'good'], [{ fromId: 0, toId: 2 }, 'good'], [{ fromId: 1, toId: 2 }, 'meh']]) pairs.record(...junk);
  assert.deepEqual(pairs.pair(1, 2), { good: 1, bad: 1 });
  assert.equal(pairs.pair(2, 1), null);
  assert.deepEqual(pairs.track(2), { good: 2, bad: 1 });
  assert.deepEqual(pairs.family('dance', 'bass'), { good: 1, bad: 1 });
  const history = pairs.history();
  assert.deepEqual(history.pair(2, 3), { good: 1, bad: 0 });
  localStorage.setItem('quantm.mixpairs', '{broken');
  assert.equal(pairs.pair(1, 2), null);
  pairs.record({ fromId: 5, toId: 6 }, 'good');
  assert.deepEqual(pairs.pair(5, 6), { good: 1, bad: 0 });
  pairs.reset();
  assert.equal(pairs.track(5), null);
});

const store = value => localStorage.setItem('quantm.mixpairs', typeof value === 'string' ? value : JSON.stringify(value));

test('mixpairs survives malformed stored maps and keeps learning', async () => {
  installBrowser();
  const pairs = await import('../src/js/mixpairs.js');
  const transition = { fromId: 1, toId: 2, fromFamily: 'dance', toFamily: 'bass' };
  for (const bad of [5, 'x', null, [], [1, 2], true]) {
    // the maps themselves are junk
    store({ version: 1, pairs: bad, tracks: bad, families: bad });
    assert.equal(pairs.pair(1, 2), null);
    assert.equal(pairs.history().track(1), null);
    assert.doesNotThrow(() => pairs.record(transition, 'good'));
    assert.deepEqual(pairs.pair(1, 2), { good: 1, bad: 0 });
    assert.deepEqual(pairs.family('dance', 'bass'), { good: 1, bad: 0 });
    assert.deepEqual(pairs.track(2), { good: 1, bad: 0 });
    pairs.reset();
  }
});

test('mixpairs drops junk entries and resets junk counts', async () => {
  installBrowser();
  const pairs = await import('../src/js/mixpairs.js');
  store({
    version: 1,
    pairs: { '1>2': 5, '2>3': 'x', '3>4': null, '4>5': [1, 2], '5>6': { good: -3, bad: 2.5 }, '6>7': { good: '4', bad: null, at: 'now' }, '7>8': { good: 2, bad: 1, at: 99 } },
    tracks: { 1: 7, 2: { good: 1.5, bad: -1 } },
    families: { 'a>b': true }
  });
  for (const key of ['1>2', '2>3', '3>4', '4>5']) {
    const [from, to] = key.split('>').map(Number);
    assert.equal(pairs.pair(from, to), null, key);
  }
  assert.deepEqual(pairs.pair(5, 6), { good: 0, bad: 0 });
  assert.deepEqual(pairs.pair(6, 7), { good: 0, bad: 0 });
  assert.deepEqual(pairs.pair(7, 8), { good: 2, bad: 1 });
  assert.equal(pairs.track(1), null);
  assert.deepEqual(pairs.track(2), { good: 0, bad: 0 });
  assert.equal(pairs.family('a', 'b'), null);

  // recording on top of the bad entries never throws and starts those counts from zero
  assert.doesNotThrow(() => {
    pairs.record({ fromId: 1, toId: 2, fromFamily: 'a', toFamily: 'b' }, 'good');
    pairs.record({ fromId: 5, toId: 6 }, 'bad');
    pairs.record({ fromId: 2, toId: 3 }, 'good');
    pairs.record({ fromId: 7, toId: 8 }, 'good');
  });
  assert.deepEqual(pairs.pair(1, 2), { good: 1, bad: 0 });
  assert.deepEqual(pairs.pair(5, 6), { good: 0, bad: 1 });
  assert.deepEqual(pairs.pair(7, 8), { good: 3, bad: 1 });
  assert.deepEqual(pairs.track(1), { good: 1, bad: 0 });
  assert.deepEqual(pairs.track(2), { good: 2, bad: 0 });
  assert.deepEqual(pairs.family('a', 'b'), { good: 1, bad: 0 });

  // what got written back is clean too
  const saved = JSON.parse(localStorage.getItem('quantm.mixpairs'));
  for (const map of [saved.pairs, saved.tracks, saved.families]) {
    for (const entry of Object.values(map)) {
      assert.ok(Number.isInteger(entry.good) && entry.good >= 0 && Number.isInteger(entry.bad) && entry.bad >= 0);
    }
  }
});

test('mixpairs treats odd stored keys and top-level shapes as plain data', async () => {
  installBrowser();
  const pairs = await import('../src/js/mixpairs.js');
  for (const raw of ['null', '[]', '7', '"x"', '{"version":2,"pairs":{"1>2":{"good":9,"bad":9}}}', '{"version":1}']) {
    store(raw);
    assert.equal(pairs.pair(1, 2), null, raw);
    assert.doesNotThrow(() => pairs.record({ fromId: 1, toId: 2 }, 'good'), raw);
    assert.deepEqual(pairs.pair(1, 2), { good: 1, bad: 0 }, raw);
  }
  store('{"version":1,"pairs":{"__proto__":{"good":3,"bad":0},"constructor":{"good":1}}}');
  assert.doesNotThrow(() => pairs.record({ fromId: 1, toId: 2 }, 'bad'));
  assert.deepEqual(pairs.pair(1, 2), { good: 0, bad: 1 });
  assert.equal(({}).good, undefined);
});
