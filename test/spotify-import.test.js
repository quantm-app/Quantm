import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSongs, playlistTitle } from '../src/js/spotify-import.js';

const song = (title, artists = 'Artist', durationMs = 200000) => ({ title, artists, durationMs });
const sc = (title, username = 'Artist', duration = 200000) => ({ id: title.length * 1000 + 7, kind: 'track', title, user: { id: 5, username }, duration, full_duration: duration, media: { transcodings: [] } });
const audius = (title, artist = 'Artist') => ({ id: 'a' + title, title, artist, durationMs: 200000, userId: 'u', permalink: 'https://audius.co/x' });
const bandcamp = (title, artist = 'Artist') => ({ id: '9' + title.length, title, artist, url: 'https://x.bandcamp.com/track/y' });
const hooks = { wait: async () => {} };

test('each song takes SoundCloud first, then Audius, then a Bandcamp link; Bandcamp is only asked when needed', async () => {
  const asked = [];
  const lookups = {
    soundcloud: async (q) => { asked.push(['soundcloud', q]); return q.includes('Alpha') ? [sc('Alpha')] : []; },
    audius: async (q) => { asked.push(['audius', q]); return q.includes('Alpha') || q.includes('Beta') ? [audius(q.includes('Alpha') ? 'Alpha' : 'Beta')] : []; },
    bandcamp: async (q) => { asked.push(['bandcamp', q]); return q.includes('Gamma') ? [bandcamp('Gamma')] : []; }
  };
  const result = await matchSongs([song('Alpha'), song('Beta'), song('Gamma'), song('Delta')], lookups, hooks);
  assert.deepEqual(result.items.map(i => i.status), ['matched', 'matched', 'link-only', 'unmatched']);
  assert.deepEqual(result.items.map(i => i.track?.source), [undefined, 'audius', 'bandcamp', undefined]);
  assert.deepEqual(result.counts, { soundcloud: 1, audius: 1, bandcamp: 1, unmatched: 1 });
  // the SoundCloud copy keeps the Audius one as a backup
  assert.equal(result.items[0].track.alternates[0].source, 'audius');
  assert.equal(result.items[2].track.duration, 200000, 'Bandcamp borrows the Spotify length');
  assert.deepEqual(asked.filter(([site]) => site === 'bandcamp').map(([, q]) => q), ['Artist Gamma', 'Artist Delta']);
  assert.equal(asked[0][1], 'Artist Alpha');
  assert.equal(result.cancelled, false);
});

test('cancelling stops before the next song and reports progress as it goes', async () => {
  let stop = false;
  const seen = [];
  const lookups = { soundcloud: async () => [], audius: async () => [], bandcamp: async () => [] };
  const result = await matchSongs([song('One'), song('Two'), song('Three')], lookups, {
    ...hooks,
    cancelled: () => stop,
    onProgress: ({ done, total }) => { seen.push([done, total]); if (done === 1) stop = true; }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(seen, [[0, 3], [1, 3]]);
});

test('a site that keeps failing is skipped; SoundCloud failing stops the import with a plain message', async () => {
  let audiusCalls = 0;
  const songs = Array.from({ length: 8 }, (_, i) => song('Song ' + i));
  const lookups = {
    soundcloud: async (q) => [sc(q.replace('Artist ', ''))],
    audius: async () => { audiusCalls++; throw new Error('down'); },
    bandcamp: async () => []
  };
  const result = await matchSongs(songs, lookups, hooks);
  assert.equal(audiusCalls, 5, 'gave up after five failures in a row');
  assert.equal(result.counts.soundcloud, 8);
  assert.equal(result.trouble.audius, 5);
  await assert.rejects(() => matchSongs(songs, { ...lookups, soundcloud: async () => { throw Object.assign(new Error('x'), { status: 401 }); } }, hooks), /login expired/);
  await assert.rejects(() => matchSongs(songs, { ...lookups, soundcloud: async () => { throw new Error('net'); } }, hooks), /Couldn't search SoundCloud/);
});

test('the playlist keeps its Spotify name unless a Quantm playlist already has it', () => {
  assert.equal(playlistTitle('Road Trip', ['Other']), 'Road Trip');
  assert.equal(playlistTitle('Road Trip', ['Road Trip']), 'Road Trip (from Spotify)');
  assert.equal(playlistTitle('  ', []), 'Spotify playlist');
  // importing the same playlist again never lands on a name that is already taken
  assert.equal(playlistTitle('Road Trip', ['Road Trip', 'Road Trip (from Spotify)']), 'Road Trip (from Spotify 2)');
  assert.equal(playlistTitle('Road Trip', ['Road Trip', 'Road Trip (from Spotify)', 'Road Trip (from Spotify 2)']), 'Road Trip (from Spotify 3)');
});
