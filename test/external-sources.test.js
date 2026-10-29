// Songs from Audius and Bandcamp: ids, saving in Quantm playlists, streaming, backup copies, and the UI rules.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
startup.mock.restore();
const sources = await import('../src/js/sources.js');
const local = await import('../src/js/local-playlists.js');
const ui = await import('../src/js/ui.js');
const { Emitter } = await import('../src/js/dom.js');

const { audiusTrack, bandcampTrack, syntheticId, isExternal, isAudius, isBandcamp, isExternalId, sourceLabel } = sources;
const rawAudius = { id: 'qJM73am', title: 'One More Time', durationMs: 320000, artist: 'Daft Punk', handle: 'daftpunk', userId: 'u1', artwork: 'https://a.example/480.jpg', permalink: 'https://audius.co/daftpunk/one-more-time' };
const rawBandcamp = { id: '99', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', url: 'https://daftpunk.bandcamp.com/track/one-more-time', image: 'https://f4.bcbits.com/img/a.jpg' };
const soundcloud = { id: 123456, title: 'One More Time', duration: 320000, permalink_url: 'https://soundcloud.com/daftpunk/omt', user: { id: 77, username: 'Daft Punk' }, media: { transcodings: [] } };

test('synthetic ids are safe integers far above SoundCloud ids and differ per source and song', () => {
  const ids = [audiusTrack(rawAudius).id, bandcampTrack(rawBandcamp).id, audiusTrack({ ...rawAudius, id: 'other' }).id, syntheticId('bandcamp', 'qJM73am')];
  for (const id of ids) {
    assert.ok(Number.isSafeInteger(id) && id > 2 ** 52 && id < Number.MAX_SAFE_INTEGER);
    assert.ok(isExternalId(id) && !isExternalId(9999999999));
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(audiusTrack(rawAudius).id, audiusTrack(rawAudius).id, 'stable between imports');
  // Audius ids sit below the Bandcamp half, so a hash can never cross over
  assert.ok(syntheticId('audius', 'z') < 2 ** 52 + 2 ** 49 && syntheticId('bandcamp', 'z') >= 2 ** 52 + 2 ** 50);
  const lots = new Set(Array.from({ length: 5000 }, (_, i) => syntheticId('audius', 'track' + i)));
  assert.equal(lots.size, 5000);
});

test('Audius and Bandcamp songs are SoundCloud-shaped and labelled', () => {
  const a = audiusTrack(rawAudius);
  assert.deepEqual([a.source, a.sourceId, a.title, a.duration, a.permalink_url, a.artwork_url], ['audius', 'qJM73am', 'One More Time', 320000, rawAudius.permalink, rawAudius.artwork]);
  assert.equal(a.user.username, 'Daft Punk');
  assert.ok(isExternalId(a.user.id));
  assert.deepEqual(a.media, { transcodings: [] });
  const b = bandcampTrack(rawBandcamp, { durationMs: 321000 });
  assert.equal(b.duration, 321000, 'the Spotify length stands in');
  assert.deepEqual([isExternal(a), isAudius(a), isBandcamp(a), sourceLabel(a)], [true, true, false, 'Audius']);
  assert.deepEqual([isExternal(b), isBandcamp(b), sourceLabel(b)], [true, true, 'Bandcamp']);
  assert.deepEqual([isExternal(soundcloud), sourceLabel(soundcloud)], [false, 'SoundCloud']);
});

test('Quantm playlists keep source, sourceId and alternates, and still reject junk', () => {
  localStorage.clear();
  const alternates = [audiusTrack(rawAudius), bandcampTrack(rawBandcamp), { id: -4, title: 'junk' }, null, { ...soundcloud, id: 5 }, { ...soundcloud, id: 6 }, { ...soundcloud, id: 7 }];
  alternates[0].alternates = [soundcloud];
  const playlist = local.create('Import', [{ ...soundcloud, alternates }, audiusTrack(rawAudius), bandcampTrack(rawBandcamp), { ...audiusTrack(rawAudius), id: 3, sourceId: 12 }]);
  const [first, second, third] = local.get(playlist.id).tracks;
  assert.equal(first.source, undefined);
  assert.equal(first.alternates.length, 4, 'at most four, junk dropped');
  assert.deepEqual(first.alternates.map(a => a.source), ['audius', 'bandcamp', undefined, undefined]);
  assert.equal(first.alternates[0].alternates, undefined, 'backup copies do not nest');
  assert.deepEqual([second.source, second.sourceId], ['audius', 'qJM73am']);
  assert.deepEqual([third.source, third.sourceId], ['bandcamp', '99']);
  // a sourceId that is not a string is not trusted: that copy is kept as a plain track
  assert.equal(local.get(playlist.id).tracks[3].source, undefined);
  assert.equal(local.get(playlist.id).tracks.length, 4);
  // an unknown source or a missing sourceId is ignored rather than trusted
  const odd = local.create('Odd', [{ ...soundcloud, source: 'napster', sourceId: 'x' }, { ...soundcloud, id: 8, source: 'audius' }]);
  assert.deepEqual(local.get(odd.id).tracks.map(t => [t.source, t.sourceId]), [[undefined, undefined], [undefined, undefined]]);
  // saved data from before this feature still loads
  localStorage.setItem(local.KEY, JSON.stringify({ version: 1, playlists: [{ id: 'qold1', title: 'Old', tracks: [{ id: 1, title: 'T', duration: 1, user: { id: 2, username: 'U' } }] }] }));
  assert.equal(local.list()[0].tracks[0].title, 'T');
  localStorage.clear();
});

test('streamOf: Audius gives its stream url, Bandcamp refuses', async () => {
  const stream = await player.streamOf(audiusTrack(rawAudius));
  assert.equal(stream.url, 'https://api.audius.co/v1/tracks/qJM73am/stream?app_name=Quantm');
  assert.deepEqual([stream.protocol, stream.snipped], ['progressive', false]);
  await assert.rejects(() => player.streamOf(bandcampTrack(rawBandcamp)), { data: 'bandcamp' });
});

function fixture(t) {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'setInterval', () => 0); // the session timer must not keep Node alive
  const p = new player.constructor();
  const attached = [];
  p.normalizer = { init() {}, setActive() {}, startTrack() {}, setEqualizer() {}, clearDropCut() {}, clearEchoOut() {} };
  p.attach = (stream) => { attached.push(stream.url); };
  for (const method of ['updateMediaSession', 'saveSession', 'notify', 'cutFade', 'stopLock', 'dropPreroll']) p[method] = () => {};
  return { p, attached };
}

test('a song that will not load tries its backup copies in order, skipping Bandcamp, and says so', async (t) => {
  const { p, attached } = fixture(t);
  const song = { ...soundcloud, alternates: [bandcampTrack(rawBandcamp), { ...audiusTrack(rawAudius) }] };
  const asked = [];
  p.streamOf = async (track) => {
    asked.push(track.id);
    if (!isAudius(track)) throw Object.assign(new Error('gone'), { status: 404 });
    return { url: 'https://api.audius.co/v1/tracks/qJM73am/stream?app_name=Quantm', protocol: 'progressive', snipped: false, track };
  };
  p.queue = [song];
  p.index = 0;
  await p.load();
  assert.deepEqual(asked, [song.id, song.alternates[1].id], 'Bandcamp was never asked');
  assert.deepEqual(attached, ['https://api.audius.co/v1/tracks/qJM73am/stream?app_name=Quantm']);
  assert.equal(p.current.id, soundcloud.id, 'the queue entry keeps its identity');
  assert.deepEqual(p.copyOf, { track: song, index: 2, autoplay: true, startAt: 0 });
  assert.equal(p.loading, false);
  const toasts = document.getElementById('toasts').childNodes.map(n => n.childNodes[0].textContent);
  assert.ok(toasts.includes('Played the Audius copy of "One More Time" (the SoundCloud one is unavailable)'));
});

test('with no usable copy the normal error shows and nothing loops', async (t) => {
  const { p, attached } = fixture(t);
  const song = { ...soundcloud, alternates: [bandcampTrack(rawBandcamp)] };
  let asks = 0;
  p.streamOf = async () => { asks++; throw Object.assign(new Error('protected'), { data: 'protected' }); };
  p.queue = [song];
  p.index = 0;
  await p.load();
  assert.equal(asks, 1);
  assert.deepEqual(attached, []);
  assert.equal(p.nextCopy(song, 0), -1);
});

test('a copy that resolves but fails to play moves on to the next one, and a newer load wins', async (t) => {
  const { p, attached } = fixture(t);
  const song = { ...soundcloud, alternates: [audiusTrack(rawAudius)] };
  p.streamOf = async (track) => ({ url: 'https://stream.example/' + track.id, protocol: 'progressive', snipped: false, track });
  p.queue = [song];
  p.index = 0;
  await p.load();
  assert.equal(attached.length, 1);
  p.decks[p.active].track = song;
  p.onMediaError(p.decks[p.active]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attached.length, 2, 'the Audius copy took over');
  assert.equal(attached[1], 'https://stream.example/' + song.alternates[0].id);
  p.onMediaError(p.decks[p.active]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attached.length, 2, 'no copies left, so no loop');

  // a load that was replaced while looking for a copy attaches nothing
  const { p: q, attached: seen } = fixture(t);
  let release;
  q.streamOf = (track) => track.source ? new Promise(resolve => { release = () => resolve({ url: 'late', protocol: 'progressive', track }); }) : Promise.reject(new Error('gone'));
  q.queue = [song];
  q.index = 0;
  const first = q.load();
  await new Promise(resolve => setImmediate(resolve));
  q.loadId++;
  release();
  await first;
  assert.deepEqual(seen, []);
});

const toastTexts = () => document.getElementById('toasts').childNodes.map(n => n.childNodes[0].textContent);

test('an Audius stream that 404s with no copies left shows the error and skips on, like a failed load', async (t) => {
  const { p } = fixture(t);
  const timeouts = [];
  t.mock.method(globalThis, 'setTimeout', (fn) => { timeouts.push(fn); return 0; });
  const song = audiusTrack(rawAudius);
  const nexts = [];
  p.next = (auto) => { nexts.push(auto); };
  p.queue = [song, { ...soundcloud, id: 9 }];
  p.index = 0;
  await p.load(); // streamOf only returns the url: the 404 comes later, as a media error
  const deck = p.decks[p.active];
  const buffering = [];
  p.on('buffering', (on) => buffering.push(on));
  const errorToasts = toastTexts().filter(text => text.startsWith("Can't play")).length;
  deck.track = song;
  p.loading = false;
  p.onMediaError(deck);
  p.onMediaError(deck); // a second error event for the same load does nothing more
  assert.deepEqual(buffering, [false]);
  assert.equal(toastTexts().filter(text => text.startsWith("Can't play")).length - errorToasts, 1, 'one toast, not two');
  timeouts.at(-1)(); // the skip, after the toast's own timers
  assert.deepEqual(nexts, [true], 'moved on to the next song');
  // a load that was replaced in the meantime does not skip
  p.failedLoadId = null;
  p.onMediaError(deck);
  const skip = timeouts.at(-1);
  p.loadId++;
  skip();
  assert.deepEqual(nexts, [true]);
});

test('HLS recovery asks for the copy that is playing, not the deleted queue entry', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'setInterval', () => 0);
  const asked = [];
  window.native.api = async ({ resource }) => {
    asked.push(resource);
    const track = { id: 456, media: { transcodings: [{ url: 'hls/stream', format: { protocol: 'hls', mime_type: 'audio/mpeg' } }] } };
    return { ok: true, status: 200, data: resource.startsWith('tracks/') ? track : { url: 'https://cdn.example/fresh.m3u8' } };
  };
  const handlers = {};
  window.Hls = class {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
    on(name, fn) { handlers[name] = fn; }
    loadSource() {}
    attachMedia() {}
    destroy() {}
  };
  t.after(() => { delete window.Hls; });
  const p = new player.constructor();
  const primary = { ...soundcloud, id: 111, alternates: [{ ...soundcloud, id: 456 }] };
  const backup = primary.alternates[0];
  p.queue = [primary];
  p.index = 0;
  p.attach({ url: 'https://cdn.example/old.m3u8', protocol: 'hls' }, true, 0, p.deck, primary, backup);
  assert.equal(p.deck.copy, backup);
  assert.equal(p.playingCopy, backup);
  handlers.error('error', { fatal: true, type: 'network' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked[0], 'tracks/456', 'the backup upload, not 111');
  assert.equal(p.deck.copy, backup, 'the refreshed stream is still that copy');
  Object.assign(p.deck.audio, { pause() {}, removeAttribute() {}, load() {} });
  p.releaseDeck(p.deck);
  assert.equal(p.playingCopy, primary);
});

test('a backup copy starts where the failed one was: the restored position, or how far it had played', async (t) => {
  const song = { ...soundcloud, alternates: [audiusTrack(rawAudius)] };
  const streamOf = async (track) => ({ url: 'https://stream.example/' + track.id, protocol: 'progressive', snipped: false, track });
  // the failure after load(): { autoplay, startAt } the backup was attached with
  async function failWith(load, state) {
    const { p } = fixture(t);
    const args = [];
    p.attach = (stream, autoplay, startAt) => args.push({ autoplay, startAt });
    p.streamOf = streamOf;
    p.queue = [song];
    p.index = 0;
    await p.load(load);
    const deck = p.decks[p.active];
    deck.track = song;
    Object.assign(deck.audio, state);
    p.onMediaError(deck);
    await new Promise(resolve => setImmediate(resolve));
    return args[1];
  }
  // restoring a session at 80 s: paused, and the primary's stream fails before it ever seeked
  assert.deepEqual(await failWith({ autoplay: false, startAt: 80 }, { currentTime: 0, paused: true }), { autoplay: false, startAt: 80 });
  // a copy that fails mid-song while playing carries on from where it got to
  assert.deepEqual(await failWith({}, { currentTime: 93.5, paused: false }), { autoplay: true, startAt: 93.5 });
  // paused by the listener first: the backup waits, paused, at the same spot
  assert.deepEqual(await failWith({}, { currentTime: 12, paused: true }), { autoplay: false, startAt: 12 });
});

test('the saved session keeps all four backup copies (slimmed), including the one that is playing', (t) => {
  t.mock.method(globalThis, 'setInterval', () => 0);
  localStorage.clear();
  const copies = Array.from({ length: 6 }, (_, i) => ({ ...soundcloud, id: 1000 + i, title: 'T' + 'x'.repeat(400), permalink_url: 'https://soundcloud.com/' + 'y'.repeat(500),
    user: { id: 5, username: 'u'.repeat(300), avatar_url: 'big' }, media: { transcodings: [] }, waveform_url: 'w' }));
  const song = { ...soundcloud, alternates: copies.slice(0, 4) };
  const savedAlternates = () => JSON.parse(localStorage.getItem('quantm.session')).queue[0].alternates;
  const p = new player.constructor();
  p.queue = [song];
  p.index = 0;
  p.saveSession();
  let saved = savedAlternates();
  assert.deepEqual(saved.map(a => a.id), [1000, 1001, 1002, 1003], 'all four, not two');
  assert.equal(saved[0].title.length, 200, 'long text is capped');
  assert.equal(saved[0].permalink_url.length, 300);
  assert.equal(saved[0].user.username.length, 100);
  assert.equal(saved[0].media, undefined);
  assert.equal(saved[0].waveform_url, undefined);
  // more copies than that: the one that is playing survives the cut
  song.alternates = copies;
  p.copyOf = { track: song, index: 6, autoplay: true, startAt: 0 };
  p.saveSession();
  saved = savedAlternates();
  assert.equal(saved.length, 4);
  assert.equal(saved[0].id, 1005, 'the playing copy is kept, first in line');
  assert.deepEqual(saved.slice(1).map(a => a.id), [1000, 1001, 1002]);
  localStorage.clear();
});

test('Bandcamp entries are locked and say Open on Bandcamp; SoundCloud keeps its wording', () => {
  ui.bindServices(Object.assign(new Emitter(), { isLiked: () => false, isReposted: () => false }), player, { isProtected: () => false });
  const bc = bandcampTrack(rawBandcamp);
  const au = audiusTrack(rawAudius);
  assert.equal(ui.isLocked(bc), true);
  assert.equal(ui.isLocked(au), false);
  assert.equal(ui.isLocked(soundcloud), false);
  assert.equal(ui.openLabel(bc), 'Open on Bandcamp');
  assert.equal(ui.openLabel(soundcloud), 'Open in SoundCloud');
  assert.match(ui.lockedHint(bc), /Open on Bandcamp/);
  assert.match(ui.lockedHint(soundcloud), /Open in SoundCloud/);
  const opened = [];
  window.native.openExternal = (url) => opened.push(url);
  ui.openInSoundCloud(bc);
  ui.openInSoundCloud(au);
  assert.deepEqual(opened, [rawBandcamp.url, rawAudius.permalink]);
});

test('SoundCloud-only controls and links are hidden for Audius and Bandcamp songs', () => {
  const au = audiusTrack(rawAudius);
  assert.equal(ui.likeButton(au), null);
  assert.equal(ui.repostButton(au), null);
  assert.equal(ui.downloadButton(au), null);
  assert.equal(ui.trackHref(au), null);
  assert.equal(ui.userHref(au.user), null);
  assert.equal(ui.trackHref(soundcloud), '#/track/123456');
  assert.equal(ui.userHref(soundcloud.user), '#/user/77');
  assert.ok(ui.sourceBadge(au));
  assert.equal(ui.sourceBadge(soundcloud), null);
});
