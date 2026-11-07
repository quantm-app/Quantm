import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { h } = await import('../src/js/dom.js');
const { createQueuePanel, UPCOMING } = await import('../src/js/queue-panel.js');

const tracks = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'track', title: 'Song ' + i, duration: 200000, user: { username: 'Artist' } }));
const tick = () => new Promise(resolve => queueMicrotask(resolve));
const walk = (node, fn) => { fn(node); node.childNodes.forEach(child => walk(child, fn)); };
const withClass = (root, name) => { const out = []; walk(root, n => { if (String(n.className || '').split(/[ .]/).includes(name)) out.push(n); }); return out; };
const text = node => { let s = ''; walk(node, n => { if (typeof n.textContent === 'string') s += n.textContent; }); return s; };

function setup(count = 6, index = 0) {
  const open = new Set(['open']);
  const panel = h('aside.queue-panel');
  panel.classList = { contains: name => open.has(name), toggle: (name, on) => { on ? open.add(name) : open.delete(name); }, add() {}, remove() {} };
  const calls = { jumped: [], removed: [], moved: [] };
  const player = {
    queue: tracks(count), index, context: { label: 'Likes', href: '#/library/likes' },
    crossfadeSeconds: () => 4, blendNote: () => null,
    jump: i => calls.jumped.push(i), removeFromQueue: i => calls.removed.push(i), moveInQueue: (a, b) => calls.moved.push([a, b]), clearQueue() {}
  };
  const queuePanel = createQueuePanel(panel, { player, close() {} });
  queuePanel.build();
  const list = () => withClass(panel, 'queue-list')[0];
  const rows = () => list().childNodes.filter(n => String(n.className).includes('queue-row'));
  const labels = () => list().childNodes.map((n, at) => [text(n), at]).filter(([t]) => t === 'Now playing' || t === 'Next up');
  return { panel, player, queuePanel, calls, list, rows, labels };
}

test('handoff with unchanged contents keeps the rows and handlers, and moves the Now playing / Next up labels', async () => {
  const s = setup(6, 0);
  const before = s.rows();
  assert.equal(s.queuePanel.stats.builds, 1);
  assert.equal(s.queuePanel.stats.rowsBuilt, 6);
  // a handoff emits queue and then track: the index moved, the contents did not
  s.player.index = 1;
  s.queuePanel.refresh(); s.queuePanel.refresh();
  await tick();
  assert.equal(s.queuePanel.stats.builds, 1, 'no rebuild');
  assert.equal(s.queuePanel.stats.rowsBuilt, 6, 'no new rows');
  assert.equal(s.queuePanel.stats.moves, 1, 'the second event found nothing left to do');
  assert.deepEqual(s.rows(), before, 'the same row nodes, in the same order');
  const [now, next] = s.labels();
  assert.equal(s.list().childNodes[now[1] + 1], before[1], 'Now playing sits above the new current row');
  assert.equal(s.list().childNodes[next[1] + 1], before[2], 'Next up sits above the one after it');
  // handlers still point at their own songs
  before[3].dispatchEvent({ type: 'dblclick' });
  assert.deepEqual(s.calls.jumped, [3]);
});

test('changed contents rebuild once, however many events arrive in the tick', async () => {
  const s = setup(6, 0);
  s.player.queue = [...s.player.queue, ...tracks(2).map(t => ({ ...t, id: t.id + 100 }))];
  s.queuePanel.refresh(); s.queuePanel.refresh(); s.queuePanel.rebuild();
  assert.equal(s.queuePanel.stats.builds, 1, 'drawn in a microtask');
  await tick();
  assert.equal(s.queuePanel.stats.builds, 2);
  assert.equal(s.rows().length, 8);
  // reorder in place (same length, same songs) is a change too
  const q = s.player.queue; [q[2], q[3]] = [q[3], q[2]];
  s.queuePanel.refresh(); await tick();
  assert.equal(s.queuePanel.stats.builds, 3);
  // a row whose shown text changed (a title filled in on load)
  q[1].title = 'Renamed';
  s.queuePanel.refresh(); await tick();
  assert.equal(s.queuePanel.stats.builds, 4);
  // a closed panel does nothing
  s.panel.classList.toggle('open', false);
  s.player.queue = [];
  s.queuePanel.refresh(); await tick();
  assert.equal(s.queuePanel.stats.builds, 4);
});

test('a 500-song queue draws a bounded window, Show more adds more, and rows keep working', async () => {
  const s = setup(500, 0);
  assert.equal(s.rows().length, 1 + UPCOMING);
  assert.equal(s.queuePanel.stats.rowsBuilt, 1 + UPCOMING);
  const more = withClass(s.panel, 'queue-more')[0];
  assert.match(text(more), /399 not shown/);
  more.dispatchEvent({ type: 'click' });
  assert.equal(s.rows().length, 1 + 2 * UPCOMING);
  // playing on slides the window: old rows leave, new ones are made only at the far end
  const built = s.queuePanel.stats.rowsBuilt;
  s.player.index = 10;
  s.queuePanel.refresh();
  assert.equal(s.queuePanel.stats.rowsBuilt, built + 10);
  assert.equal(s.queuePanel.stats.builds, 1);
  assert.equal(Number(s.rows()[0].dataset.index), 7, 'three songs of history');
  // drag-reorder and Remove act on the right song
  const row = s.rows().find(r => Number(r.dataset.index) === 12);
  row.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '15' } });
  assert.deepEqual(s.calls.moved, [[15, 12]]);
  const remove = withClass(row, 'queue-remove')[0];
  remove.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.deepEqual(s.calls.removed, [12]);
  assert.equal(withClass(s.rows().find(r => Number(r.dataset.index) === 10), 'queue-remove').length, 0, 'the current song has no Remove');
});

test('blend notes that change after analysis update the transition labels without rebuilding, writing only what changed', () => {
  const s = setup(4, 0);
  const buttons = () => s.list().childNodes.filter(n => String(n.className).includes('queue-transition'));
  const before = buttons();
  assert.equal(text(before[1]), 'Transition');
  let notes = { 1: { ok: true, text: 'same key' } };
  s.player.blendNote = i => notes[i] || null;
  s.queuePanel.refresh(); // same order, same index, only the blend information moved on
  assert.equal(s.queuePanel.stats.builds, 1);
  assert.equal(s.queuePanel.stats.rowsBuilt, 4);
  assert.deepEqual(buttons(), before, 'same button nodes');
  assert.equal(before[1].textContent, 'Transition · same key');
  assert.match(before[1].className, /blend-ok/);
  assert.equal(text(before[0]), 'Transition', 'untouched labels stay');
  // nothing changed: nothing is written
  let writes = 0;
  for (const b of before) Object.defineProperty(b, 'textContent', { configurable: true, get() { return 'x'; }, set() { writes++; } });
  s.queuePanel.refresh();
  assert.equal(writes, 0);
  notes = { 1: { ok: false, text: 'clash' } };
  s.queuePanel.refresh();
  assert.equal(writes, 1);
  assert.match(before[1].className, /blend-warn/);
});
