import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSources, parseSpotifyLink, parseEmbedPage, normalizeAudius, normalizeBandcamp } = require('../import-sources.js');

const ID = '37i9dQZF1DXcBWIGoYBM5M';
const page = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body) });

test('spotify links: web, regional, share-tracking and uri forms; everything else is refused', () => {
  assert.equal(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}`), ID);
  assert.equal(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}?si=abc123`), ID);
  assert.equal(parseSpotifyLink(`open.spotify.com/intl-de/playlist/${ID}`), ID);
  assert.equal(parseSpotifyLink(`  spotify:playlist:${ID} `), ID);
  assert.equal(parseSpotifyLink(`https://open.spotify.com/album/${ID}`), null);
  assert.equal(parseSpotifyLink(`https://evil.example/playlist/${ID}`), null);
  assert.equal(parseSpotifyLink(`http://open.spotify.com/playlist/${ID}`), null);
  assert.equal(parseSpotifyLink('hello'), null);
  assert.equal(parseSpotifyLink(null), null);
});

test('the embed page becomes a name and a song list, with readable errors', () => {
  const entity = { name: 'Road Trip', trackList: [
    { uri: 'spotify:track:1', title: 'Song A', subtitle: 'Artist One, Artist Two', duration: 201000 },
    { uri: 'spotify:track:2', title: '', subtitle: 'Nobody', duration: 1 },
    { uri: 'spotify:track:3', title: 'Song C', subtitle: 'Artist Three', duration: 'bad' }
  ] };
  assert.deepEqual(parseEmbedPage(page(entity)), { name: 'Road Trip', tracks: [
    { title: 'Song A', artists: 'Artist One, Artist Two', durationMs: 201000, spotifyUri: 'spotify:track:1' },
    { title: 'Song C', artists: 'Artist Three', durationMs: 0, spotifyUri: 'spotify:track:3' }
  ] });
  assert.throws(() => parseEmbedPage('<html>nothing</html>'), /changed how its playlist pages/);
  assert.throws(() => parseEmbedPage(page(undefined)), /private or deleted/);
  assert.throws(() => parseEmbedPage(page({ name: 'x' })), /changed how its playlist pages/);
  assert.throws(() => parseEmbedPage(page({ name: 'x', trackList: [] })), /no songs/);
});

test('spotifyPlaylist reports problems as { error } and never throws', async () => {
  const calls = [];
  const sources = createSources({ gap: 0, fetch: async (url, options) => {
    calls.push([url, options]);
    return url.includes('missing') ? reply('', 404) : reply(page({ name: 'P', trackList: [{ title: 'T', subtitle: 'A', duration: 1000, uri: 'spotify:track:9' }] }));
  } });
  const ok = await sources.spotifyPlaylist(`https://open.spotify.com/playlist/${ID}`);
  assert.equal(ok.name, 'P');
  assert.equal(calls[0][0], `https://open.spotify.com/embed/playlist/${ID}`);
  assert.match(calls[0][1].headers['User-Agent'], /Mozilla/);
  assert.ok(calls[0][1].signal, 'has a timeout');
  assert.match((await sources.spotifyPlaylist('nope')).error, /look like a Spotify playlist link/);
  assert.match((await sources.spotifyPlaylist('https://open.spotify.com/playlist/missing0000000000000')).error, /find that playlist/);
  const offline = createSources({ gap: 0, fetch: async () => { throw new Error('ENOTFOUND'); } });
  assert.match((await offline.spotifyPlaylist(`spotify:playlist:${ID}`)).error, /reach Spotify/);
});

test('audius results are trimmed to playable songs with an https artwork and page', () => {
  const body = { data: [
    { id: 'qJM73am', title: 'Song', duration: 200, user: { name: 'Artist', handle: 'artist', id: 'u1' }, artwork: { '150x150': 'https://a/150.jpg', '480x480': 'https://a/480.jpg' }, permalink: '/artist/song-1', is_streamable: true },
    { id: 'x', title: 'Gated', duration: 100, user: { name: 'B' }, is_streamable: true, access: { stream: false } },
    { id: 'y', title: 'Off', duration: 100, user: { name: 'B' }, is_streamable: false },
    { title: 'No id', user: {} }
  ].concat(Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, title: 'T' + i, duration: 10, user: { name: 'N' } }))) };
  const list = normalizeAudius(body);
  assert.equal(list.length, 8);
  assert.deepEqual(list[0], { id: 'qJM73am', title: 'Song', durationMs: 200000, artist: 'Artist', handle: 'artist', userId: 'u1', artwork: 'https://a/480.jpg', permalink: 'https://audius.co/artist/song-1' });
  assert.ok(!list.some(t => t.id === 'x' || t.id === 'y'));
  assert.deepEqual(normalizeAudius(null), []);
});

test('bandcamp results keep tracks only', () => {
  const list = normalizeBandcamp({ auto: { results: [
    { type: 't', id: 5, name: 'Song', band_name: 'Band', album_name: 'Album', item_url_path: 'https://band.bandcamp.com/track/song', img: 'https://f4.bcbits.com/img/a.jpg' },
    { type: 'a', id: 6, name: 'An album', item_url_path: 'https://band.bandcamp.com/album/x' },
    { type: 't', id: 7, name: 'Relative', item_url_path: '/track/relative' }
  ] } });
  assert.deepEqual(list, [{ id: '5', title: 'Song', artist: 'Band', album: 'Album', url: 'https://band.bandcamp.com/track/song', image: 'https://f4.bcbits.com/img/a.jpg' }]);
});

test('searches go to the right sites, never carry a login, and are spaced per site', async () => {
  const calls = [];
  const waits = [];
  const sources = createSources({
    sleep: async ms => { waits.push(ms); },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return url.includes('audius') ? reply(JSON.stringify({ data: [] })) : reply(JSON.stringify({ auto: { results: [] } }));
    }
  });
  await Promise.all([sources.audiusSearch('daft punk one more time'), sources.audiusSearch('second'), sources.bandcampSearch('a b')]);
  assert.equal(calls[0].url, 'https://api.audius.co/v1/tracks/search?query=daft%20punk%20one%20more%20time&app_name=Quantm');
  const bc = calls.find(c => c.url.includes('bandcamp'));
  assert.equal(bc.options.method, 'POST');
  assert.deepEqual(JSON.parse(bc.options.body), { search_text: 'a b', search_filter: 't', full_page: false });
  for (const c of calls) {
    const headers = Object.keys(c.options.headers || {}).map(k => k.toLowerCase());
    assert.ok(!headers.includes('authorization') && !headers.includes('cookie'));
  }
  assert.equal(waits.length, 1, 'only the second Audius request had to wait');
  assert.ok(waits[0] > 0 && waits[0] <= 500);
  await assert.rejects(() => sources.audiusSearch('   '), /Nothing to search for/);
});
