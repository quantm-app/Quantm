import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const interval = mock.method(globalThis, 'setInterval', () => 0);
const { player: shared } = await import('../src/js/player.js');
interval.mock.restore();

const tracks = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'track', title: 'Song ' + i, duration: 200000, user: { id: 9, username: 'Artist' } }));
const tick = () => new Promise(resolve => queueMicrotask(resolve));

function setup(t, count = 5) {
  const timer = mock.method(globalThis, 'setInterval', () => 0);
  const p = new shared.constructor();
  timer.mock.restore();
  p.queue = tracks(count); p.index = 1; p.context = { label: 'Likes', href: '#/library/likes', loadAll() {} };
  p.audio.currentTime = 12.7;
  const writes = [];
  const set = localStorage.setItem;
  localStorage.setItem = (key, value) => { if (key === 'quantm.session') writes.push(value); return set(key, value); };
  t.after(() => { localStorage.setItem = set; localStorage.clear(); });
  return { p, writes };
}

test('several queue events and saves in one tick make one write', async t => {
  const { p, writes } = setup(t);
  p.emit('queue'); p.emit('queue'); p.emit('track', p.current); p.queueSave(); p.emit('queue');
  assert.equal(writes.length, 0, 'nothing is written inside the tick');
  await tick();
  assert.equal(writes.length, 1);
  p.emit('queue');
  await tick();
  assert.equal(writes.length, 2, 'a later tick saves again');
});

test('beforeunload saves at once, and a pending save then does not write again', async t => {
  const { p, writes } = setup(t);
  p.emit('queue');
  window.dispatchEvent({ type: 'beforeunload' });
  assert.ok(writes.length >= 1, 'saved synchronously');
  const after = writes.length;
  await tick();
  assert.equal(writes.length, after, 'the pending save was folded into the immediate one');
  assert.equal(JSON.parse(localStorage.getItem('quantm.session')).position, 12);
});

test('the saved text is the same shape as before, the queue text is reused while only the position moves, and rebuilt when the queue changes', t => {
  const { p } = setup(t, 80);
  p.index = 60;
  const slim = mock.method(p, 'sessionQueue');
  p.saveSession();
  const saved = JSON.parse(localStorage.getItem('quantm.session'));
  assert.deepEqual(Object.keys(saved), ['queue', 'index', 'position', 'context', 'savedAt']);
  assert.equal(saved.queue.length, 70, 'ten before the window start up to the end');
  assert.equal(saved.index, 50);
  assert.equal(saved.queue[saved.index].id, 61);
  assert.deepEqual(saved.context, { label: 'Likes', href: '#/library/likes' });
  p.audio.currentTime = 30.2;
  p.saveSession(); p.saveSession();
  assert.equal(slim.mock.callCount(), 1, 'queue text came from the cache');
  assert.equal(JSON.parse(localStorage.getItem('quantm.session')).position, 30, 'position is current');
  p.queue.splice(61, 1); p.emit('queue');
  p.saveSession();
  assert.equal(slim.mock.callCount(), 2, 'a queue event rebuilds it');
  assert.equal(JSON.parse(localStorage.getItem('quantm.session')).queue[51].id, 63);
  p.index = 61; p.saveSession();
  assert.equal(slim.mock.callCount(), 3, 'moving to another song rebuilds it');
});
