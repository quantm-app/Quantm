import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
// importing stats pulls in the player, whose session timer must not keep Node alive
const timer = mock.method(globalThis, 'setInterval', () => 0);
const stats = await import('../src/js/stats.js');
timer.mock.restore();
const {
  emptyStats, dayKey, addPlay, addListening, playThreshold, createTracker, rangeKeys, rangeTotals, series,
  topTracks, topArtists, topGenres, streaks, badgeList, newBadges, awardBadges, pruneStats, normalizeStats,
  formatListening, formatTime, loadStats, saveStats, MAX_TRACKS, MAX_ARTISTS, KEEP_DAYS, DAY_ENTRIES
} = stats;

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2025, 6, 15);
const track = (id, extra = {}) => ({
  id, title: 'Track ' + id, duration: 200000, genre: 'Rock', artwork_url: `https://i1.sndcdn.com/${id}-large.jpg`,
  user: { id: 100 + (id % 7), username: 'Artist ' + (id % 7), avatar_url: 'https://i1.sndcdn.com/a-large.jpg' }, ...extra
});
const play = (data, id, ts, extra) => addPlay(data, track(id, extra), ts);

test('dayKey uses the local calendar date', () => {
  assert.equal(dayKey(at(2025, 1, 5, 0, 1)), '2025-01-05');
  assert.equal(dayKey(at(2025, 12, 31, 23, 59)), '2025-12-31');
});

test('addPlay and addListening fill totals, per-day and aggregate maps', () => {
  const data = emptyStats();
  addListening(data, track(1), 90, NOW);
  play(data, 1, NOW);
  play(data, 1, NOW + 1000);
  play(data, 2, NOW + 2000, { genre: 'rock' });
  const day = data.days['2025-06-15'];
  assert.equal(data.plays, 3);
  assert.equal(data.seconds, 90);
  assert.equal(day.plays, 3);
  assert.equal(day.seconds, 90);
  assert.deepEqual(day.tracks, { 1: 2, 2: 1 });
  assert.equal(data.tracks[1].plays, 2);
  assert.equal(data.tracks[1].seconds, 90);
  assert.equal(data.tracks[1].artist, 'Artist 1');
  assert.equal(data.tracks[1].artwork, 'https://i1.sndcdn.com/1-large.jpg');
  // "Rock" and "rock" are the same genre
  assert.deepEqual(Object.keys(data.genres), ['rock']);
  assert.equal(data.genres.rock.plays, 3);
  assert.equal(data.genres.rock.name, 'Rock');
  assert.equal(data.artists[101].plays, 2);
  assert.equal(data.artists[102].plays, 1);
});

test('plays between midnight and 4 am count for night owl, others do not', () => {
  const data = emptyStats();
  play(data, 1, at(2025, 6, 15, 12));
  play(data, 1, at(2025, 6, 15, 4));
  assert.equal(data.night, 0);
  play(data, 1, at(2025, 6, 15, 3, 59));
  play(data, 1, at(2025, 6, 16, 0, 0));
  assert.equal(data.night, 2);
});

test('a play needs 30 seconds, or half of a shorter track', () => {
  assert.equal(playThreshold(200), 30);
  assert.equal(playThreshold(60), 30);
  assert.equal(playThreshold(40), 20);
  assert.equal(playThreshold(20), 10);
  assert.equal(playThreshold(0), 30);
});

function listen(tracker, from, to, { t0 = NOW, duration = 200, step = 1 } = {}) {
  for (let s = from; s <= to; s += step) tracker.time(s, duration, true, t0 + s * 1000);
}

test('tracker counts a play after 30 seconds of real listening and adds the time', () => {
  const data = emptyStats();
  const plays = [];
  const tracker = createTracker(data, { onPlay: (t) => plays.push(t.id) });
  tracker.track(track(1));
  listen(tracker, 0, 29);
  assert.equal(data.plays, 0);
  listen(tracker, 30, 40);
  assert.equal(data.plays, 1);
  assert.deepEqual(plays, [1]);
  assert.equal(data.seconds, 40);
  assert.equal(data.tracks[1].seconds, 40);
  // listening on does not count again
  listen(tracker, 41, 120);
  assert.equal(data.plays, 1);
});

test('tracker ignores seeks, stalls and paused time', () => {
  const data = emptyStats();
  const tracker = createTracker(data);
  tracker.track(track(1));
  listen(tracker, 0, 10);
  assert.equal(data.seconds, 10);
  // seeking forward 100 s is not listening
  tracker.time(111, 200, true, NOW + 11000);
  assert.equal(data.seconds, 10);
  tracker.time(112, 200, true, NOW + 12000);
  assert.equal(data.seconds, 11);
  // a long gap between events (stalled or app asleep) is not listening
  tracker.time(113, 200, true, NOW + 12000 + 60000);
  assert.equal(data.seconds, 11);
  // playback position not moving (buffering) adds nothing
  tracker.time(113, 200, true, NOW + 13000 + 60000);
  assert.equal(data.seconds, 11);
  // paused
  tracker.state(false);
  tracker.time(114, 200, false, NOW + 80000);
  tracker.time(115, 200, false, NOW + 81000);
  assert.equal(data.seconds, 11);
  // resuming starts from a fresh baseline
  tracker.state(true);
  tracker.time(115, 200, true, NOW + 90000);
  tracker.time(116, 200, true, NOW + 91000);
  assert.equal(data.seconds, 12);
});

test('tracker handles short tracks, repeats and duplicate track events', () => {
  const data = emptyStats();
  const tracker = createTracker(data);
  const short = track(7, { duration: 20000 });
  tracker.track(short);
  tracker.track(short); // the player announces a track twice while loading
  listen(tracker, 0, 9, { duration: 20 });
  assert.equal(data.plays, 0);
  listen(tracker, 10, 12, { duration: 20 });
  assert.equal(data.plays, 1);
  // the track restarts (repeat one): a new listen can count again
  const t1 = NOW + 100000;
  for (let s = 0; s <= 12; s++) tracker.time(s, 20, true, t1 + s * 1000);
  assert.equal(data.plays, 2);
  // a different track starts from scratch
  tracker.track(track(8));
  listen(tracker, 0, 31, { t0: NOW + 200000 });
  assert.equal(data.plays, 3);
  assert.equal(data.tracks[8].plays, 1);
});

test('rangeKeys covers the last 7, 30 and 365 days, oldest first', () => {
  const week = rangeKeys('week', NOW);
  assert.equal(week.length, 7);
  assert.equal(week[0], '2025-06-09');
  assert.equal(week[6], '2025-06-15');
  assert.equal(rangeKeys('month', NOW)[0], '2025-05-17');
  assert.equal(rangeKeys('year', NOW).length, 365);
  assert.equal(rangeKeys('all', NOW), null);
});

function sample() {
  const data = emptyStats();
  addListening(data, track(1), 3600, at(2025, 6, 15));
  play(data, 1, at(2025, 6, 15));
  play(data, 1, at(2025, 6, 15, 13));
  addListening(data, track(2), 1800, at(2025, 6, 12));
  play(data, 2, at(2025, 6, 12), { genre: 'Jazz' });
  addListening(data, track(3), 7200, at(2025, 5, 20));
  play(data, 3, at(2025, 5, 20), { genre: 'Jazz' });
  play(data, 3, at(2025, 5, 20, 14), { genre: 'Jazz' });
  play(data, 3, at(2025, 5, 20, 15), { genre: 'Jazz' });
  addListening(data, track(4), 600, at(2024, 9, 1));
  play(data, 4, at(2024, 9, 1), { genre: 'Pop' });
  return data;
}

test('rangeTotals sums just the days in the range', () => {
  const data = sample();
  assert.deepEqual(rangeTotals(data, 'week', NOW), { seconds: 5400, plays: 3, activeDays: 2 });
  assert.deepEqual(rangeTotals(data, 'month', NOW), { seconds: 5400 + 7200, plays: 6, activeDays: 3 });
  assert.equal(rangeTotals(data, 'year', NOW).plays, 7);
  assert.deepEqual(rangeTotals(data, 'all', NOW), { seconds: 13200, plays: 7, activeDays: 4 });
});

test('series gives one bar per day for week and month, per month for year and all', () => {
  const data = sample();
  const week = series(data, 'week', NOW);
  assert.equal(week.length, 7);
  assert.deepEqual(week.map(b => b.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(week[6].seconds, 3600);
  assert.equal(week[3].seconds, 1800);
  assert.equal(series(data, 'month', NOW).length, 30);
  const year = series(data, 'year', NOW);
  assert.equal(year.length, 12);
  assert.equal(year[11].key, '2025-06');
  assert.equal(year[11].seconds, 5400);
  assert.equal(year[10].seconds, 7200);
  const all = series(data, 'all', NOW);
  assert.equal(all[0].key, '2024-09');
  assert.equal(all.at(-1).key, '2025-06');
  assert.equal(all.reduce((sum, b) => sum + b.seconds, 0), 13200);
  assert.deepEqual(series(emptyStats(), 'all', NOW).map(b => b.key), ['2025-06']);
});

test('top tracks, artists and genres use the range, or all-time totals', () => {
  const data = sample();
  const week = topTracks(data, 'week', 5, NOW);
  assert.deepEqual(week.map(t => [t.id, t.plays]), [['1', 2], ['2', 1]]);
  assert.equal(week[0].title, 'Track 1');
  const month = topTracks(data, 'month', 5, NOW);
  assert.deepEqual(month.map(t => t.id), ['3', '1', '2']);
  assert.equal(topTracks(data, 'all', 2, NOW).length, 2);
  assert.equal(topTracks(data, 'all', 10, NOW)[0].id, '3');

  const artists = topArtists(data, 'week', 5, NOW);
  assert.deepEqual(artists.map(a => [a.name, a.plays]), [['Artist 1', 2], ['Artist 2', 1]]);
  assert.equal(topArtists(data, 'all', 1, NOW)[0].name, 'Artist 3');

  const genres = topGenres(data, 'month', 5, NOW);
  assert.deepEqual(genres.map(g => [g.name, g.plays]), [['Jazz', 4], ['Rock', 2]]);
  assert.ok(Math.abs(genres[0].share - 4 / 6) < 1e-9);
  assert.deepEqual(topGenres(data, 'all', 5, NOW).map(g => g.name), ['Jazz', 'Rock', 'Pop']);
  assert.deepEqual(topGenres(emptyStats(), 'all', 5, NOW), []);
});

test('streaks count consecutive days, stay alive until the end of the next day, and remember the best', () => {
  const data = emptyStats();
  for (const d of [8, 9, 10, 11]) play(data, 1, at(2025, 6, d));
  for (const d of [13, 14, 15]) play(data, 1, at(2025, 6, d));
  assert.deepEqual(streaks(data, at(2025, 6, 15)), { current: 3, best: 4 });
  // no play yet today: yesterday's run is still alive
  assert.deepEqual(streaks(data, at(2025, 6, 16, 9)), { current: 3, best: 4 });
  // a whole day missed: current resets, best stays
  assert.deepEqual(streaks(data, at(2025, 6, 17)), { current: 0, best: 4 });
  assert.deepEqual(streaks(emptyStats(), NOW), { current: 0, best: 0 });
  // best survives pruned days
  const old = emptyStats();
  old.best = 12;
  assert.equal(streaks(old, NOW).best, 12);
  // listening without a counted play is not a streak day
  const secondsOnly = emptyStats();
  addListening(secondsOnly, track(1), 10, NOW);
  assert.equal(streaks(secondsOnly, NOW).current, 0);
});

test('streaks are not thrown off by daylight saving changes', () => {
  const data = emptyStats();
  for (const d of [8, 9, 10]) play(data, 1, at(2025, 3, d, 0, 30)); // US clocks change on Mar 9
  assert.equal(streaks(data, at(2025, 3, 10)).current, 3);
});

test('badges are earned at their milestones', () => {
  const data = emptyStats();
  assert.equal(badgeList(data, NOW).filter(b => b.earned).length, 0);
  play(data, 1, at(2025, 6, 15));
  assert.deepEqual(newBadges(data, NOW), ['first-play']);
  for (let i = 0; i < 9; i++) play(data, 1, at(2025, 6, 15, 13));
  const ids = newBadges(data, NOW);
  assert.ok(ids.includes('plays-10') && ids.includes('heavy-rotation'));
  assert.ok(!ids.includes('plays-100'));
});

test('badges cover hours, artists, genres, night owl, marathons and streaks', () => {
  const data = emptyStats();
  const has = (id) => badgeList(data, NOW).find(b => b.id === id).earned;
  addListening(data, track(1), 3599, NOW);
  assert.equal(has('hours-1'), false);
  addListening(data, track(1), 1, NOW);
  assert.equal(has('hours-1'), true);
  assert.equal(has('hours-10'), false);
  assert.equal(has('marathon'), false);
  addListening(data, track(1), 3 * 3600, NOW);
  assert.equal(has('marathon'), true);
  data.seconds = 100 * 3600;
  assert.equal(has('hours-100'), true);

  for (let id = 1; id <= 24; id++) play(data, id * 7, NOW, { user: { id: 1000 + id, username: 'A' + id } });
  assert.equal(has('artists-25'), false);
  play(data, 999, NOW, { user: { id: 5000, username: 'Z' } });
  assert.equal(has('artists-25'), true);

  assert.equal(has('genre-hopper'), false);
  ['Pop', 'Jazz', 'House', 'Folk'].forEach((genre, i) => play(data, 2000 + i, NOW, { genre }));
  assert.equal(has('genre-hopper'), true); // Rock + 4 more

  assert.equal(has('night-owl'), false);
  play(data, 1, at(2025, 6, 15, 2));
  assert.equal(has('night-owl'), true);

  assert.equal(has('streak-7'), false);
  for (let d = 1; d <= 7; d++) play(data, 1, at(2025, 6, d));
  assert.equal(has('streak-7'), true);
  assert.equal(has('streak-30'), false);
});

test('awardBadges records the date once and returns only fresh badges', () => {
  const data = emptyStats();
  play(data, 1, NOW);
  const fresh = awardBadges(data, NOW);
  assert.deepEqual(fresh.map(b => b.id), ['first-play']);
  assert.equal(data.earned['first-play'], NOW);
  assert.deepEqual(awardBadges(data, NOW + 1000), []);
  const first = badgeList(data, NOW + 5000).find(b => b.id === 'first-play');
  assert.equal(first.date, NOW);
  assert.ok(first.icon && first.name && first.description);
  // once earned it stays earned, even if the plays were pruned away
  data.plays = 0;
  assert.equal(badgeList(data, NOW).find(b => b.id === 'first-play').earned, true);
  // best streak is remembered when awarding
  const run = emptyStats();
  for (let d = 1; d <= 5; d++) play(run, 1, at(2025, 6, d));
  awardBadges(run, at(2025, 6, 5));
  assert.equal(run.best, 5);
});

test('every badge has an id, name, description and icon', () => {
  const list = badgeList(emptyStats(), NOW);
  assert.ok(list.length >= 12);
  assert.equal(new Set(list.map(b => b.id)).size, list.length);
  for (const b of list) assert.ok(b.id && b.name && b.description && b.icon, b.id);
});

test('pruneStats drops old days and keeps every collection bounded', () => {
  const data = emptyStats();
  play(data, 1, NOW);
  play(data, 1, NOW - (KEEP_DAYS - 1) * 86400000);
  play(data, 1, NOW - (KEEP_DAYS + 5) * 86400000);
  pruneStats(data, NOW);
  assert.equal(Object.keys(data.days).length, 2);
  assert.ok(data.days[dayKey(NOW)]);

  const big = emptyStats();
  for (let i = 0; i < MAX_TRACKS + 50; i++) {
    big.tracks[i] = { plays: i < 10 ? 5 : 1, seconds: i, title: 'T' + i, artist: '', artistId: null, genre: '', artwork: '', lastPlayed: 0 };
  }
  for (let i = 0; i < MAX_ARTISTS + 50; i++) big.artists[i] = { name: 'A' + i, plays: 1, seconds: i };
  const today = {};
  for (let i = 0; i < 100; i++) today[i] = i + 1;
  big.days[dayKey(NOW)] = { seconds: 0, plays: 0, tracks: today, artists: {}, genres: {} };
  pruneStats(big, NOW);
  assert.equal(Object.keys(big.tracks).length, MAX_TRACKS);
  assert.equal(Object.keys(big.artists).length, MAX_ARTISTS);
  for (let i = 0; i < 10; i++) assert.ok(big.tracks[i], 'most played tracks are kept');
  const day = big.days[dayKey(NOW)];
  assert.equal(Object.keys(day.tracks).length, DAY_ENTRIES);
  assert.ok(day.tracks[99], 'the most played entries of a day are kept');
});

test('normalizeStats repairs missing or damaged data', () => {
  for (const bad of [null, undefined, 5, 'x', [], { days: 4, tracks: [] }]) {
    const data = normalizeStats(bad);
    assert.deepEqual(Object.keys(data.days), []);
    assert.equal(data.plays, 0);
  }
  const data = normalizeStats({ plays: 'lots', seconds: 5, days: { '2025-06-15': { seconds: 5 } } });
  assert.equal(data.plays, 0);
  assert.equal(data.seconds, 5);
  assert.deepEqual(data.days['2025-06-15'], { seconds: 5, plays: 0, tracks: {}, artists: {}, genres: {} });
});

test('stats save to localStorage compactly and load back', () => {
  localStorage.clear();
  const data = emptyStats();
  addListening(data, track(1), 0.123456789, NOW);
  play(data, 1, NOW);
  assert.equal(saveStats(data, NOW), true);
  const raw = localStorage.getItem('quantm.stats');
  assert.ok(!/0\.1234/.test(raw), 'fractions are rounded');
  const loaded = loadStats(NOW);
  assert.equal(loaded.plays, 1);
  assert.equal(loaded.tracks[1].title, 'Track 1');
  assert.equal(loaded.days['2025-06-15'].seconds, 0.1);
  localStorage.setItem('quantm.stats', '{not json');
  assert.equal(loadStats(NOW).plays, 0);
});

test('formatListening and formatTime pick readable units', () => {
  assert.deepEqual(formatListening(0), { value: '0', unit: 'min' });
  assert.deepEqual(formatListening(1800), { value: '30', unit: 'min' });
  assert.deepEqual(formatListening(3600), { value: '1', unit: 'hour' });
  assert.deepEqual(formatListening(4500), { value: '1.3', unit: 'hours' });
  assert.deepEqual(formatListening(7200), { value: '2', unit: 'hours' });
  assert.deepEqual(formatListening(100.4 * 3600), { value: '100', unit: 'hours' });
  assert.equal(formatTime(5400), '1.5 hours');
  assert.equal(formatTime(120), '2 min');
});

test('Audius and Bandcamp plays keep what is needed to replay them, bounded and validated', () => {
  const data = emptyStats();
  const audius = track(4503599627370501, { source: 'audius', sourceId: 'AbC123', duration: 187000.4 });
  addPlay(data, audius, NOW);
  addPlay(data, audius, NOW + 1000);
  addPlay(data, track(4503599627370502, { source: 'bandcamp', sourceId: 'bc1' }), NOW);
  const entry = data.tracks[4503599627370501];
  assert.equal(entry.plays, 2);
  assert.equal(entry.source, 'audius');
  assert.equal(entry.sourceId, 'AbC123');
  assert.equal(entry.duration, 187000);
  assert.equal(entry.title, 'Track 4503599627370501');
  assert.equal(data.tracks[4503599627370502].source, 'bandcamp');
  assert.equal(topTracks(data, 'all', 5, NOW)[0].sourceId, 'AbC123');

  // SoundCloud tracks stay as they were; junk or oversized source data is not kept
  addPlay(data, track(1), NOW);
  assert.ok(!('source' in data.tracks[1]) && !('sourceId' in data.tracks[1]));
  addPlay(data, track(2, { source: 'audius', sourceId: 'x'.repeat(500), duration: 5 }), NOW);
  addPlay(data, track(3, { source: 'audius', sourceId: { a: 1 }, duration: 5 }), NOW);
  addPlay(data, track(4, { source: 'napster', sourceId: 'n1' }), NOW);
  addPlay(data, track(5, { source: 'audius', sourceId: 'ok5', duration: -3 }), NOW);
  for (const id of [2, 3, 4]) assert.ok(!('sourceId' in data.tracks[id]), String(id));
  assert.equal(data.tracks[5].duration, 0);

  // a song stored before these fields existed gets them on its next play
  const before = emptyStats();
  addPlay(before, track(9), NOW);
  addPlay(before, track(9, { source: 'audius', sourceId: 'late9', duration: 100 }), NOW);
  assert.equal(before.tracks[9].sourceId, 'late9');
  assert.equal(before.tracks[9].plays, 2);
});
