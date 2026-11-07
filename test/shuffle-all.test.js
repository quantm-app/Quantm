import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const interval = mock.method(globalThis, 'setInterval', () => 0);
const api = await import('../src/js/api.js');
const { player } = await import('../src/js/player.js');
const { store } = await import('../src/js/store.js');
const ui = await import('../src/js/ui.js');
const userView = await import('../src/js/views/user.js');
interval.mock.restore();
mock.method(globalThis, 'setTimeout', () => 0); // toasts and the slow-load hint use timers
ui.bindServices(store, player, api);

const track = (id) => ({ id, kind: 'track', title: 'Track ' + id, duration: 100000, user: { id: 9, username: 'Artist' } });
const ids = (list) => list.map(t => t.id);
const settle = () => new Promise(resolve => setImmediate(resolve));
const walk = (node, fn) => { fn(node); node.childNodes.forEach(child => walk(child, fn)); };
const find = (root, match) => { const found = []; walk(root, n => { if (match(n)) found.push(n); }); return found; };
const click = (el) => el.dispatchEvent({ type: 'click', stopPropagation() {} });
const textOf = (node) => { let text = ''; walk(node, n => { if (typeof n.textContent === 'string') text += n.textContent; }); return text; };
const withClass = (root, name) => find(root, n => String(n.className || '').split(' ').includes(name));

// the test DOM has no children / querySelector, which the feed uses
const element = Object.getPrototypeOf(document.createElement('div'));
Object.defineProperty(element, 'children', { configurable: true, get() { return this.childNodes; } });
element.querySelector = function (selector) { return withClass(this, selector.slice(1))[0] || null; };

/** Answers api requests from a table of resource -> collection, an Error, or { resource, pages } */
function serve(t, table) {
  const calls = [];
  t.mock.method(window.native, 'api', async (request) => {
    calls.push(request);
    const entry = table[request.resource.split('?')[0]];
    if (entry instanceof Error) throw entry;
    if (!entry) return { ok: true, data: { collection: [] } };
    if (entry.pages) {
      const page = request.resource === entry.resource ? 0 : Number(request.resource.split('page=')[1]);
      return { ok: true, data: { collection: entry.pages[page], next_href: page + 1 < entry.pages.length ? `${entry.resource}?page=${page + 1}` : null } };
    }
    return { ok: true, data: Array.isArray(entry) ? { collection: entry } : entry };
  });
  return calls;
}
const paged = (resource, ...pages) => ({ resource, pages });

function restore(saved, context = { label: 'Likes', href: '#/library/likes' }, index = 1) {
  localStorage.setItem('quantm.session', JSON.stringify({ queue: saved, index, position: 0, context, savedAt: Date.now() }));
  return player.restoreSession();
}
const quiet = (t) => {
  t.mock.method(player, 'load', () => {});
  player.audio.play = () => Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  player.queue = [];
  player.index = -1;
  player.original = null;
  player.context = null;
  player.shuffle = false;
  player.loadingAll = null;
  player.restoredContext = null;
  store.me = { id: 7 };
});

test('loadEveryTrack pages at 200, dedupes, keeps only tracks and uses pick for reposts', async (t) => {
  const calls = serve(t, {
    'users/3/tracks': paged('users/3/tracks', [track(1), { kind: 'playlist', id: 50 }, track(2)], [track(2), track(3)])
  });
  const all = await api.loadEveryTrack(api.userTracks(3));
  assert.deepEqual(ids(all), [1, 2, 3]);
  assert.equal(calls[0].params.limit, 200);

  serve(t, { 'stream/users/3/reposts': [{ type: 'track-repost', track: track(4) }, { type: 'playlist-repost', playlist: { id: 1 } }, { type: 'track-repost', track: track(5) }, { type: 'track-repost', track: track(4) }] });
  assert.deepEqual(ids(await api.loadEveryTrack(api.userReposts(3), api.trackOfEntry)), [4, 5]);
});

test('loadAllFor maps the list hrefs and gives nothing for unknown ones', () => {
  const me = async () => ({ id: 7 });
  for (const href of [
    '#/library/likes', '#/library/history', '#/trending', '#/trending/hip-hop-and-rap', '#/search?q=house%20music&tab=tracks',
    '#/user/12/popular', '#/user/12/tracks', '#/user/12/reposts'
  ]) assert.equal(typeof api.loadAllFor(href, me), 'function', href);
  for (const href of [
    '#/feed', '#/home', '#/user/12', '#/user/12/likes', '#/trending/not-a-genre', '#/playlist/5', '#/search?q=x&tab=people',
    '#/search?q=%E0%A4%A&tab=tracks', '#/library/offline', '', null, undefined
  ]) assert.equal(api.loadAllFor(href, me), null, String(href));
});

test('restoring Likes with shuffle on loads nothing at startup, then once on the first play, keeping the saved queue', async (t) => {
  const saved = [track(10), track(11), track(12)];
  const likes = [[10, 11, 12, 13, 14], [15]].map(page => page.map(id => ({ track: track(id) })));
  const calls = serve(t, { 'users/7/track_likes': paged('users/7/track_likes', ...likes) });
  quiet(t);
  player.shuffle = true;
  assert.equal(restore(saved), true);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(typeof player.context.loadAll, 'function');
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem('quantm.session')).context), ['label', 'href']);

  player.play();
  player.play(); // only the first play loads
  await settle();
  await settle();
  assert.equal(calls.filter(c => c.resource === 'users/7/track_likes').length, 1);
  assert.deepEqual(ids(player.queue.slice(0, 3)), [10, 11, 12]);
  assert.deepEqual(ids(player.queue).sort(), [10, 11, 12, 13, 14, 15]);
  assert.equal(player.index, 1);
  assert.deepEqual(ids(player.original).sort(), [10, 11, 12, 13, 14, 15]);
  assert.match(textOf(document.getElementById('toasts').childNodes.at(-1)), /Shuffling all 6 tracks/);
});

test('without the signed-in user known yet, Likes resolves it when it loads', async (t) => {
  store.me = null;
  const calls = serve(t, { me: { id: 7 }, 'users/7/track_likes': [{ track: track(1) }, { track: track(2) }] });
  quiet(t);
  player.shuffle = true;
  restore([track(1)], undefined, 0);
  player.play();
  await settle();
  await settle();
  assert.deepEqual(calls.map(c => c.resource), ['me', 'users/7/track_likes']);
  assert.deepEqual(ids(player.queue), [1, 2]);
});

test('hand-added songs stay in the queue and in original', async (t) => {
  serve(t, { 'users/7/track_likes': [1, 2, 3].map(id => ({ track: track(id) })) });
  quiet(t);
  player.shuffle = true;
  restore([track(1), track(99)], undefined, 0);
  player.play();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue.slice(0, 2)), [1, 99]);
  assert.deepEqual(ids(player.queue).sort((a, b) => a - b), [1, 2, 3, 99]);
  assert.deepEqual(ids(player.original).sort((a, b) => a - b), [1, 2, 3, 99]);
});

test('no change when the context changed or shuffle was turned off while it loaded', async (t) => {
  let release;
  t.mock.method(window.native, 'api', () => new Promise((resolve) => {
    release = () => resolve({ ok: true, data: { collection: [1, 2, 3].map(id => ({ track: track(id) })) } });
  }));
  quiet(t);

  player.shuffle = true;
  restore([track(1)], undefined, 0);
  player.play();
  await settle();
  player.context = { label: 'Other', href: '#/other' };
  release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue), [1]);
  assert.equal(player.original, null);

  player.shuffle = true;
  restore([track(1)], undefined, 0);
  player.play();
  await settle();
  player.shuffle = false;
  release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue), [1]);
  assert.equal(player.original, null);
});

test('a load failure leaves the restored queue alone', async (t) => {
  serve(t, { 'users/7/track_likes': new Error('offline') });
  quiet(t);
  player.shuffle = true;
  restore([track(1), track(2)], undefined, 0);
  const before = document.getElementById('toasts')?.childNodes.length || 0;
  player.play();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue), [1, 2]);
  assert.equal(player.original, null);
  assert.equal(player.loadingAll, null);
  assert.equal(document.getElementById('toasts')?.childNodes.length || 0, before);
});

test('an unknown href restores with no loadAll and plays as before', async (t) => {
  const calls = serve(t, {});
  quiet(t);
  player.shuffle = true;
  restore([track(1), track(2)], { label: 'Feed', href: '#/feed' }, 0);
  assert.equal(player.context.loadAll, undefined);
  assert.equal(player.restoredContext, null);
  player.play();
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(ids(player.queue), [1, 2]);
});

test('after a restore, turning shuffle on loads the whole list through the rebuilt loadAll', async (t) => {
  serve(t, { 'users/7/track_likes': [1, 2, 3, 4].map(id => ({ track: track(id) })) });
  quiet(t);
  restore([track(1), track(2)], undefined, 0);
  player.toggleShuffle();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue).sort(), [1, 2, 3, 4]);
  assert.equal(player.current.id, 1);
  assert.equal(player.restoredContext, null);
});

// ---- edits while the whole list loads ------------------------------------------

/** One held request: resolves with the given likes when released */
function holdLikes(t, ...likeIds) {
  let release;
  const calls = [];
  t.mock.method(window.native, 'api', (request) => new Promise((resolve) => {
    calls.push(request);
    release = () => resolve({ ok: true, data: { collection: likeIds.map(id => ({ track: track(id) })) } });
  }));
  return { calls, release: () => release() };
}

test('turning shuffle off after the restore load keeps the playing song and leaves out removed ones', async (t) => {
  serve(t, { 'users/7/track_likes': [1, 2, 3, 4].map(id => ({ track: track(id) })) });
  quiet(t);
  player.shuffle = true;
  restore([track(1), track(2)], undefined, 1);
  const playing = player.current;
  player.play();
  await settle();
  await settle();
  assert.equal(player.current, playing);
  player.toggleShuffle();
  assert.equal(player.current.id, 2);
  assert.equal(player.current, playing);
  assert.deepEqual(ids(player.queue), [1, 2, 3, 4]);

  // a song removed while the list loads does not come back
  player.queue = [];
  player.index = -1;
  player.shuffle = true;
  restore([track(1), track(2), track(3)], undefined, 0);
  const gate = holdLikes(t, 1, 2, 3, 4);
  player.play();
  await settle();
  player.removeFromQueue(2);
  gate.release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue).sort(), [1, 2, 4]);
  assert.deepEqual(ids(player.original).sort(), [1, 2, 4]);
});

test('clearing the queue during the restore load cancels it', async (t) => {
  quiet(t);
  player.shuffle = true;
  restore([track(1), track(2), track(3)], undefined, 1);
  const gate = holdLikes(t, 1, 2, 3, 4, 5);
  player.play();
  await settle();
  player.clearQueue();
  gate.release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue), [2]);
  assert.equal(player.original, null);
});

test('songs added during the restore load stay, and the load joins the queue as it is now', async (t) => {
  quiet(t);
  player.shuffle = true;
  restore([track(1), track(2)], undefined, 0);
  const gate = holdLikes(t, 1, 2, 3);
  player.play();
  await settle();
  player.playNext(track(99));
  gate.release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue), [1, 99, 2, 3]);
  assert.deepEqual(ids(player.original).sort((a, b) => a - b), [1, 2, 3, 99]);
});

test('Play next during shuffle-on loading of the whole list keeps the added song', async (t) => {
  quiet(t);
  restore([track(1), track(2)], undefined, 0);
  const gate = holdLikes(t, 1, 2, 3, 4);
  player.toggleShuffle(); // starts shuffleWholeCollection
  await settle();
  player.playNext(track(99));
  gate.release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue).sort((a, b) => a - b), [1, 2, 3, 4, 99]);
  assert.equal(player.queue[1].id, 99);
});

test('Next or a jump after a paused restore also loads the whole list, once', async (t) => {
  const calls = serve(t, { 'users/7/track_likes': [1, 2, 3, 4].map(id => ({ track: track(id) })) });
  const load = t.mock.method(player, 'load', () => {});
  player.audio.play = () => Promise.resolve();
  player.shuffle = true;
  restore([track(1), track(2)], undefined, 0);
  await settle();
  assert.equal(calls.length, 0); // the restore's own load loads nothing
  load.mock.restore();
  t.mock.method(player, 'streamOf', async () => { throw new Error('no audio in tests'); });
  player.jump(1);
  player.jump(0);
  await settle();
  await settle();
  assert.equal(calls.filter(c => c.resource === 'users/7/track_likes').length, 1);
  assert.deepEqual(ids(player.queue.slice(0, 2)), [1, 2]);
  assert.equal(player.queue.length, 4);
});

test('moving or Play-next on a listed song during the whole-list load keeps its place', async (t) => {
  quiet(t);
  restore([track(1), track(2), track(3)], undefined, 0);
  const gate = holdLikes(t, 1, 2, 3, 4, 5);
  player.toggleShuffle();
  await settle();
  const third = player.queue[2];
  player.moveInQueue(2, 1); // the third song goes up to play right after the current one
  const order = ids(player.queue.slice(0, 3));
  assert.equal(order[1], third.id);
  gate.release();
  await settle();
  await settle();
  assert.deepEqual(ids(player.queue.slice(0, 3)), order);
  assert.deepEqual(ids(player.queue).sort(), [1, 2, 3, 4, 5]);
});

test('an untouched queue still gets the full reshuffle when the whole list arrives', async (t) => {
  quiet(t);
  restore([track(1), track(2)], undefined, 0);
  serve(t, { 'users/7/track_likes': [1, 2, 3, 4, 5].map(id => ({ track: track(id) })) });
  const shuffled = t.mock.method(player, 'shuffled', (list) => list.slice().reverse());
  player.toggleShuffle();
  await settle();
  await settle();
  assert.equal(player.current.id, 1);
  assert.deepEqual(ids(player.queue).sort(), [1, 2, 3, 4, 5]);
  assert.ok(shuffled.mock.callCount() >= 2); // applyShuffle, then the whole list
});

test('a drop-cut stall keeps songs a whole-list load added during the pre-roll', (t) => {
  const from = track(1);
  const to = track(2);
  const added = track(3);
  const queue = [from, to];
  player.queue = queue;
  player.index = 1; // the drop cut already moved on
  const [outgoing, incoming] = player.decks;
  incoming.audio.paused = true;
  const f = { from, to, outgoing, incoming, fromQueue: queue, fromIndex: 0, prep: { track: to }, announced: false };
  t.mock.method(player, 'applySpeed', () => {});
  t.mock.method(player, 'stopLock', () => {});
  t.mock.method(player, 'clearMixOutcome', () => {});
  t.mock.method(player, 'stopListening', () => {});
  t.mock.method(player, 'releaseDeck', () => {});
  t.mock.method(player.beats, 'unwatch', () => {});
  t.mock.method(player, 'updateMediaSession', () => {});
  t.mock.method(player, 'saveSession', () => {});
  player.normalizer = { clearDropCut() {}, setFade() {}, setActive() {}, startTrack() {} };
  player.active = 1;
  player.fading = f;
  player.queue = [...queue, added]; // a load finished: a new array with the extra song
  player.fallbackDropCut(f, 'test');
  assert.equal(player.current, from);
  assert.deepEqual(ids(player.queue), [1, 2, 3]);
});

// ---- artist profile ----------------------------------------------------------

async function openProfile(t, tab, extra = {}) {
  const calls = serve(t, {
    'users/5': { id: 5, kind: 'user', username: 'Artist', track_count: 30, followers_count: 1, followings_count: 1 },
    'users/5/toptracks': [track(1), track(2)],
    'users/5/tracks': paged('users/5/tracks', [track(1), track(3)], [track(4), track(5)]),
    ...extra
  });
  const view = document.createElement('div');
  view.id = 'view';
  const page = document.createElement('div');
  view.append(page);
  document.body.append(view);
  await userView.render(page, { id: '5', tab });
  return { page, calls };
}

test('profile Play with shuffle on draws from every upload; with shuffle off it is unchanged', async (t) => {
  const { page } = await openProfile(t, 'tracks');
  const shuffled = t.mock.method(player, 'shufflePlay', async () => {});
  const played = t.mock.method(player, 'playList', () => {});
  const playBtn = withClass(page, 'btn-primary')[0];

  player.shuffle = false;
  click(playBtn);
  await settle();
  assert.equal(shuffled.mock.callCount(), 0);
  assert.deepEqual(ids(played.mock.calls[0].arguments[0]), [1, 2]);
  assert.equal(played.mock.calls[0].arguments[2].loadAll, undefined);

  player.shuffle = true;
  click(playBtn);
  await settle();
  assert.equal(shuffled.mock.callCount(), 1);
  const context = shuffled.mock.calls[0].arguments[1];
  assert.equal(context.href, '#/user/5');
  assert.deepEqual(ids(await context.loadAll()), [1, 3, 4, 5]);
});

test('Tracks and Reposts tabs give their play context a loadAll that covers the whole feed', async (t) => {
  const repost = (id) => ({ type: 'track-repost', track: track(id) });
  const playlist = { type: 'playlist-repost', playlist: { id: 8, title: 'P', track_count: 1, user: {} } };
  const reposts = paged('stream/users/5/reposts', [repost(1), playlist], [repost(2)], [repost(1)], [repost(3)]);
  const { page, calls } = await openProfile(t, 'reposts', { 'stream/users/5/reposts': reposts });
  const played = t.mock.method(player, 'playList', () => {});
  click(withClass(page, 'play-btn')[0]);
  await settle();
  const context = played.mock.calls[0].arguments[2];
  assert.equal(context.href, '#/user/5/reposts');
  const cards = withClass(page, 'feed-card').length;
  assert.deepEqual(ids(await context.loadAll()), [1, 2, 3]);
  assert.equal(calls.some(c => c.resource === 'stream/users/5/reposts' && c.params?.limit === 200), true);
  assert.equal(withClass(page, 'feed-card').length, cards); // no rows drawn

  const uploads = await openProfile(t, 'tracks');
  played.mock.resetCalls();
  click(withClass(uploads.page, 'play-btn')[0]);
  await settle();
  assert.deepEqual(ids(await played.mock.calls[0].arguments[2].loadAll()), [1, 3, 4, 5]);
});
