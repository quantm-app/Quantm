import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, versionWords, score, pick, queryFor } from '../src/js/song-match.js';

const wanted = { title: 'Blinding Lights', artists: 'The Weeknd', durationMs: 200000 };
const sc = (title, username, duration = 200000, extra = {}) =>
  ({ id: Math.floor(Math.random() * 1e9), kind: 'track', title, user: { username }, duration, full_duration: duration,
    media: { transcodings: [{ snipped: false, format: { protocol: 'progressive' } }] }, ...extra });
const audius = (title, artist, durationMs = 200000) => ({ id: 'abc', title, artist, durationMs });
const bandcamp = (title, artist) => ({ id: '1', title, artist, album: '', url: 'https://x.bandcamp.com/track/y' });

test('normalize drops feat., bracket noise, accents and punctuation but keeps version words', () => {
  assert.equal(normalize('Señorita (feat. Camila Cabello)'), 'senorita');
  assert.equal(normalize('Song [Official Audio]'), 'song');
  assert.equal(normalize('Song (Original Mix)'), 'song');
  assert.equal(normalize('Song - Remastered 2011'), 'song');
  assert.equal(normalize("Don't Stop Me Now!"), 'don t stop me now');
  assert.equal(normalize('Song (Skrillex Remix)'), 'song skrillex remix');
  assert.equal(normalize('Song ft. Someone - Radio Edit'), 'song radio edit');
  assert.equal(normalize('Audio'), 'audio', 'a title that is only a noise word survives');
  assert.deepEqual([...versionWords('Song (Sped Up) [Live]')].sort(), ['live', 'sped up']);
  assert.deepEqual([...versionWords('Song (Original Mix)')], []);
});

test('SoundCloud beats an Audius copy that scores higher', () => {
  const found = {
    soundcloud: [sc('Blinding Lights', 'The Weeknd', 202000)],
    audius: [audius('Blinding Lights', 'The Weeknd', 200000)]
  };
  const best = pick(wanted, found);
  assert.equal(best.status, 'matched');
  assert.equal(best.chosen.source, 'soundcloud');
  assert.ok(score(wanted, found.audius[0], 'audius').score > score(wanted, found.soundcloud[0], 'soundcloud').score);
  assert.deepEqual(best.alternates.map(a => a.source), ['audius']);
});

test('a remix is rejected for the original, and accepted when Spotify lists that remix', () => {
  const remix = sc('Blinding Lights (Skrillex Remix)', 'The Weeknd');
  assert.equal(score(wanted, remix).accepted, false);
  assert.equal(score(wanted, sc('Blinding Lights - Sped Up', 'The Weeknd')).accepted, false);
  assert.equal(score(wanted, sc('Blinding Lights (Live)', 'The Weeknd')).accepted, false);
  const remixWanted = { title: 'Blinding Lights - Skrillex Remix', artists: 'The Weeknd', durationMs: 200000 };
  assert.equal(score(remixWanted, remix).accepted, true);
  assert.equal(score(remixWanted, sc('Blinding Lights', 'The Weeknd')).accepted, false, 'the original is not the remix');
});

test('a different length rejects, a close one is accepted', () => {
  assert.equal(score(wanted, sc('Blinding Lights', 'The Weeknd', 260000)).accepted, false);
  assert.equal(score(wanted, sc('Blinding Lights', 'The Weeknd', 208000)).accepted, true);
  const close = score(wanted, sc('Blinding Lights', 'The Weeknd', 201000));
  const farther = score(wanted, sc('Blinding Lights', 'The Weeknd', 208000));
  assert.ok(close.score > farther.score);
});

test('"Artist - Title" uploads by a label account match', () => {
  const upload = sc('The Weeknd - Blinding Lights', 'XO Records Archive', 200400);
  assert.equal(score(wanted, upload).accepted, true);
  assert.equal(score(wanted, sc('The Weeknd - Blinding Lights (Official Audio)', 'Label', 200000)).accepted, true);
  assert.equal(score(wanted, sc('Blinding Lights - The Weeknd', 'Label', 200000)).accepted, true);
  // someone else's song with the same name
  assert.equal(score(wanted, sc('Blinding Lights', 'Random Producer', 150000)).accepted, false);
});

test('feat. and brackets on either side do not hurt a match', () => {
  const song = { title: 'Señorita (feat. Camila Cabello)', artists: 'Shawn Mendes, Camila Cabello', durationMs: 190000 };
  assert.equal(score(song, sc('Shawn Mendes - Senorita', 'Shawn Mendes', 190000)).accepted, true);
  assert.equal(score(song, sc('Señorita [Official Video]', 'Camila Cabello', 191000)).accepted, true);
});

test('preview and copy-protected SoundCloud copies are skipped', () => {
  const preview = sc('Blinding Lights', 'The Weeknd', 30000, { full_duration: 200000, policy: 'SNIP' });
  const snipped = sc('Blinding Lights', 'The Weeknd', 200000, { media: { transcodings: [{ snipped: true, format: { protocol: 'progressive' } }] } });
  const shortOnly = sc('Blinding Lights', 'The Weeknd', 30000, { full_duration: 30000 });
  const locked = sc('Blinding Lights', 'The Weeknd', 200000, { media: { transcodings: [{ snipped: false, format: { protocol: 'ctr-encrypted-hls' } }] } });
  for (const bad of [preview, snipped, shortOnly, locked]) assert.equal(score(wanted, bad).accepted, false);
  const good = sc('Blinding Lights (Official Audio)', 'The Weeknd', 200000);
  const best = pick(wanted, { soundcloud: [preview, snipped, locked, good] });
  assert.equal(best.chosen.raw, good);
  assert.equal(best.alternates.length, 0);
});

test('Bandcamp alone is a link-only match, and the right song is still required', () => {
  const only = pick(wanted, { soundcloud: [], audius: [], bandcamp: [bandcamp('Blinding Lights', 'The Weeknd'), bandcamp('Other Song', 'The Weeknd')] });
  assert.equal(only.status, 'link-only');
  assert.equal(only.chosen.source, 'bandcamp');
  assert.equal(only.alternates.length, 0);
  assert.equal(pick(wanted, { bandcamp: [bandcamp('Blinding Lights', 'Nobody Known')] }).status, 'unmatched');
});

test('Audius is used when SoundCloud has nothing acceptable, and nothing found is unmatched', () => {
  const via = pick(wanted, { soundcloud: [sc('Blinding Lights (Remix)', 'x')], audius: [audius('Blinding Lights', 'The Weeknd')], bandcamp: [bandcamp('Blinding Lights', 'The Weeknd')] });
  assert.equal(via.chosen.source, 'audius');
  assert.equal(via.status, 'matched');
  assert.deepEqual(via.alternates.map(a => a.source), ['bandcamp']);
  assert.deepEqual(pick(wanted, {}), { chosen: null, alternates: [], status: 'unmatched', locked: false });
  assert.equal(pick(wanted, { soundcloud: [sc('Totally Different', 'Someone')] }).status, 'unmatched');
});

test('alternates keep priority order (SoundCloud, Audius, Bandcamp) and stop at four', () => {
  const found = {
    soundcloud: Array.from({ length: 3 }, (_, i) => sc('Blinding Lights', 'The Weeknd', 200000 + i * 500)),
    audius: [audius('Blinding Lights', 'The Weeknd'), audius('Blinding Lights', 'The Weeknd', 201000)],
    bandcamp: [bandcamp('Blinding Lights', 'The Weeknd')]
  };
  const best = pick(wanted, found);
  assert.equal(best.alternates.length, 4);
  assert.deepEqual(best.alternates.map(a => a.source), ['soundcloud', 'soundcloud', 'audius', 'audius']);
});

test('queryFor searches the first artist and the title without feat.', () => {
  assert.equal(queryFor({ title: 'Señorita (feat. Camila Cabello)', artists: 'Shawn Mendes, Camila Cabello' }), 'Shawn Mendes Señorita');
});

test('a copy-protected or preview-only SoundCloud upload of the right song is reported as locked, not as missing', async () => {
  const { pick } = await import('../src/js/song-match.js');
  const wanted = { title: 'Dance Dance Dance!', artists: "Barry Can't Swim", durationMs: 218000 };
  const protectedCopy = { kind: 'track', id: 1, title: 'Dance Dance Dance!', duration: 218000, full_duration: 218000, policy: 'MONETIZE',
    user: { id: 9, username: "Barry Can't Swim" }, media: { transcodings: [{ format: { protocol: 'ctr-encrypted-hls' }, snipped: false }] } };
  const preview = { ...protectedCopy, id: 2, duration: 30000, policy: 'SNIP', media: { transcodings: [{ format: { protocol: 'progressive' }, snipped: true }] } };
  const other = { ...protectedCopy, id: 3, title: 'Something Else Entirely', media: { transcodings: [{ format: { protocol: 'ctr-encrypted-hls' }, snipped: false }] } };
  assert.deepEqual([pick(wanted, { soundcloud: [protectedCopy] }).locked, pick(wanted, { soundcloud: [preview] }).locked], [true, true]);
  assert.equal(pick(wanted, { soundcloud: [other] }).locked, false);
  assert.equal(pick(wanted, { soundcloud: [] }).status, 'unmatched');
});
