import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
// importing the view pulls in the player, whose session timer must not keep Node alive
const interval = mock.method(globalThis, 'setInterval', () => 0);
const { emptyStats, addPlay, getStats } = await import('../src/js/stats.js');
const { audiusTrack, bandcampTrack } = await import('../src/js/sources.js');
const { player } = await import('../src/js/player.js');
const view = await import('../src/js/views/stats.js');
interval.mock.restore();
mock.method(globalThis, 'setTimeout', () => 0); // toasts hide themselves on a timer

const sc = (id, title) => ({ id, title, user: { id: 500 + id, username: 'SC artist' }, artwork_url: `https://i1.sndcdn.com/${id}-large.jpg` });
const audius = audiusTrack({ id: 'AbC123', userId: 'u9', artist: 'Audius artist', title: 'Audius song', durationMs: 187000, artwork: 'https://audius.example/art.jpg', permalink: 'https://audius.co/x' });
const bandcamp = bandcampTrack({ id: 'bc1', artist: 'BC artist', title: 'Bandcamp song', url: 'https://x.bandcamp.com/track/y', image: 'https://bc.example/i.jpg' });

const walk = (node, fn) => { fn(node); node.childNodes.forEach(child => walk(child, fn)); };
const textOf = (node) => { let text = ''; walk(node, n => { if (n.textContent) text += n.textContent; }); return text; };
const find = (root, test) => { const found = []; walk(root, n => { if (test(n)) found.push(n); }); return found; };
const click = (el) => el.dispatchEvent({ type: 'click', stopPropagation() {} });
const settle = () => new Promise(resolve => setImmediate(resolve));
const toasts = () => (document.getElementById('toasts')?.childNodes || []).map(textOf);

/** Plays in the order given; earlier entries get more plays so they rank first */
async function open(tracks, available = tracks.filter(t => !t.source)) {
  const data = Object.assign(getStats(), emptyStats()); // the view reads the live stats object
  tracks.forEach((track, i) => { for (let n = 0; n < tracks.length - i; n++) addPlay(data, track, Date.now()); });
  const lookups = [];
  window.native.api = async ({ resource, params }) => {
    lookups.push({ resource, ids: String(params.ids).split(',').map(Number) });
    return { ok: true, data: available.filter(t => params.ids.split(',').includes(String(t.id))) };
  };
  const played = [];
  player.toggleOrPlay = (queue, index, context) => { played.push({ queue, index, context }); };
  const page = document.createElement('div');
  await view.render(page);
  return {
    played, lookups, page,
    rows: find(page, n => String(n.className).includes('stats-track')),
    playAll: find(page, n => String(n.className).includes('btn') && textOf(n) === 'Play all')[0]
  };
}

test.beforeEach(() => { localStorage.clear(); document.getElementById('toasts')?.childNodes.splice(0); });

test('Play all starts with an Audius first track and queues every playable track in order', async () => {
  const { played, lookups, playAll } = await open([audius, sc(11, 'One'), bandcamp, sc(12, 'Two')]);
  click(playAll);
  await settle();
  assert.equal(played.length, 1);
  assert.equal(played[0].index, 0);
  assert.deepEqual(played[0].queue.map(t => t.title), ['Audius song', 'One', 'Two']);
  // only SoundCloud ids are looked up
  assert.deepEqual(lookups, [{ resource: 'tracks', ids: [11, 12] }]);
  const first = played[0].queue[0];
  assert.equal(first.id, audius.id);
  assert.equal(first.source, 'audius');
  assert.equal(first.sourceId, 'AbC123');
  assert.equal(first.duration, 187000);
  assert.equal(first.artwork_url, 'https://audius.example/art.jpg');
  assert.equal(first.user.username, 'Audius artist');
  assert.deepEqual(toasts(), []);
});

test('Play all skips a Bandcamp first track and starts at the first playable one', async () => {
  const { played, playAll } = await open([bandcamp, sc(21, 'One'), audius]);
  click(playAll);
  await settle();
  assert.equal(played.length, 1);
  assert.equal(played[0].index, 0);
  assert.deepEqual(played[0].queue.map(t => t.title), ['One', 'Audius song']);
  assert.deepEqual(toasts(), []);
});

test('Play all with nothing playable says so and plays nothing', async () => {
  const { played, playAll, lookups } = await open([bandcamp]);
  click(playAll);
  await settle();
  assert.equal(played.length, 0);
  assert.equal(lookups.length, 0);
  assert.equal(toasts().length, 1);
});

test('an individual Audius row replays from its stored data, at its own place in the queue', async () => {
  const { played, rows } = await open([sc(31, 'One'), audius, sc(32, 'Two')]);
  assert.equal(rows.length, 3);
  click(rows[1]);
  await settle();
  assert.equal(played.length, 1);
  assert.deepEqual(played[0].queue.map(t => t.title), ['One', 'Audius song', 'Two']);
  assert.equal(played[0].index, 1);
  assert.equal(played[0].queue[1].sourceId, 'AbC123');
  assert.deepEqual(toasts(), []);
});

test('a Bandcamp row does not play and says why, while SoundCloud rows still do', async () => {
  const { played, rows } = await open([sc(41, 'One'), bandcamp, sc(42, 'Two')]);
  click(rows[1]);
  await settle();
  assert.equal(played.length, 0);
  assert.deepEqual(toasts(), ['Bandcamp songs only play on Bandcamp']);
  click(rows[2]);
  await settle();
  assert.equal(played.length, 1);
  assert.deepEqual(played[0].queue.map(t => t.title), ['One', 'Two']);
  assert.equal(played[0].index, 1);
});

test('an Audius entry stored without a sourceId (older data) is skipped, not a crash', async () => {
  const old = { ...audius };
  delete old.sourceId;
  const { played, playAll, rows } = await open([old, sc(51, 'One')]);
  click(rows[0]);
  await settle();
  assert.equal(played.length, 0);
  assert.deepEqual(toasts(), ["That track isn't available anymore"]);
  click(playAll);
  await settle();
  assert.deepEqual(played[0].queue.map(t => t.title), ['One']);
});

test('a SoundCloud track that is gone is skipped by Play all, and its row reports it', async () => {
  const { played, playAll, rows } = await open([sc(61, 'Gone'), sc(62, 'Here')], [sc(62, 'Here')]);
  click(rows[0]);
  await settle();
  assert.equal(played.length, 0);
  assert.deepEqual(toasts(), ["That track isn't available anymore"]);
  click(playAll);
  await settle();
  assert.deepEqual(played[0].queue.map(t => t.title), ['Here']);
  assert.equal(played[0].index, 0);
});
