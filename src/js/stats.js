// Listening stats: records what you listen to and turns it into totals, top lists, streaks and badges.
// Everything stays in localStorage ('quantm.stats') on this computer; nothing is ever sent anywhere.
//
// What is stored (compact, bounded):
//   days     'YYYY-MM-DD' (local date) -> { seconds, plays, tracks: {id: plays}, artists: {id: plays}, genres: {key: plays} }
//            Per-day maps let the week / month / year views show real top tracks, artists and genres for
//            that range. Days older than 400 days are pruned, and each day keeps at most 40 entries per map.
//   tracks   id -> { plays, seconds, title, artist, artistId, genre, artwork, lastPlayed }  (top 2000 by plays)
//            Audius / Bandcamp songs also keep { source, sourceId, duration } so an Audius one can be replayed
//   artists  id -> { name, avatar, plays, seconds }                                           (top 1000 by plays)
//   genres   lowercase name -> { name, plays, seconds }
//   plays / seconds  all-time totals, so "All time" keeps counting after old days are pruned
//   best     best streak ever (survives pruning), night (plays between midnight and 4 am), earned: {badgeId: ts}
// "All time" top lists come from the aggregates; the other ranges are summed from the per-day maps.
//
// A "play" counts once at least 30 seconds (or half of a shorter track) has really been listened to.
// Listening time is the real time that passes between player 'time' events while playing; gaps and
// jumps of more than 5 seconds (seeks, stalls) are ignored.
import { player } from './player.js';
import { toast } from './ui.js';

export const STATS_KEY = 'quantm.stats';
export const MAX_TRACKS = 2000;
export const MAX_ARTISTS = 1000;
export const KEEP_DAYS = 400;
export const DAY_ENTRIES = 40;
export const PLAY_SECONDS = 30;
const MAX_SOURCE_ID = 200;

const DAY_MS = 86400000;
const RANGE_DAYS = { week: 7, month: 30, year: 365 };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Local date as 'YYYY-MM-DD' */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days since the epoch for a day key (calendar math only, so daylight saving can't skew it) */
function dayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function keyOfIndex(index) {
  const d = new Date(index * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export function emptyStats() {
  return { v: 1, since: 0, plays: 0, seconds: 0, best: 0, night: 0, earned: {}, days: {}, tracks: {}, artists: {}, genres: {} };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Make sure parsed JSON has every part of the shape, whatever was stored */
export function normalizeStats(raw) {
  const data = emptyStats();
  if (!isObject(raw)) return data;
  for (const key of ['since', 'plays', 'seconds', 'best', 'night']) {
    if (typeof raw[key] === 'number' && isFinite(raw[key]) && raw[key] >= 0) data[key] = raw[key];
  }
  for (const key of ['earned', 'days', 'tracks', 'artists', 'genres']) {
    if (isObject(raw[key])) data[key] = raw[key];
  }
  for (const day of Object.values(data.days)) {
    if (!isObject(day)) continue;
    for (const key of ['tracks', 'artists', 'genres']) if (!isObject(day[key])) day[key] = {};
    day.seconds = Number(day.seconds) || 0;
    day.plays = Number(day.plays) || 0;
  }
  return data;
}

function topKeys(map, limit, score) {
  return Object.keys(map).sort((a, b) => score(map[b]) - score(map[a])).slice(0, limit);
}

function keepTop(map, limit, score) {
  if (Object.keys(map).length <= limit) return;
  const keep = new Set(topKeys(map, limit, score));
  for (const key of Object.keys(map)) if (!keep.has(key)) delete map[key];
}

/** Drop old days and keep every collection within its size limit. Mutates and returns data. */
export function pruneStats(data, now = Date.now()) {
  const cutoff = dayIndex(dayKey(now)) - KEEP_DAYS;
  for (const key of Object.keys(data.days)) {
    if (dayIndex(key) < cutoff) { delete data.days[key]; continue; }
    const day = data.days[key];
    keepTop(day.tracks, DAY_ENTRIES, (n) => n);
    keepTop(day.artists, DAY_ENTRIES, (n) => n);
    keepTop(day.genres, DAY_ENTRIES, (n) => n);
  }
  const byUse = (t) => t.plays * 1e6 + (t.seconds || 0) + (t.lastPlayed || 0) / 1e13;
  keepTop(data.tracks, MAX_TRACKS, byUse);
  keepTop(data.artists, MAX_ARTISTS, (a) => a.plays * 1e6 + (a.seconds || 0));
  return data;
}

// ---------------------------------------------------------------------------
// Recording (pure: these only change the data they are given)
// ---------------------------------------------------------------------------

const genreOf = (track) => String((track && track.genre) || '').trim();
const artistIdOf = (track) => {
  const user = track && track.user;
  return user ? String(user.id || user.username || '') : '';
};

function dayEntry(data, ts) {
  const key = dayKey(ts);
  return data.days[key] || (data.days[key] = { seconds: 0, plays: 0, tracks: {}, artists: {}, genres: {} });
}

/** What a stored Audius / Bandcamp song needs to be played again: { source, sourceId, duration } or null for SoundCloud */
function externalFields(track) {
  const source = track.source;
  if (source !== 'audius' && source !== 'bandcamp') return null;
  const sourceId = typeof track.sourceId === 'string' || typeof track.sourceId === 'number' ? String(track.sourceId) : '';
  if (!sourceId || sourceId.length > MAX_SOURCE_ID) return null;
  const duration = Number(track.duration);
  return { source, sourceId, duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0 };
}

function trackEntry(data, track, ts) {
  const id = String(track.id);
  if (!data.tracks[id]) {
    const user = track.user || {};
    data.tracks[id] = {
      plays: 0,
      seconds: 0,
      title: String(track.title || 'Untitled'),
      artist: String(user.username || ''),
      artistId: user.id || null,
      genre: genreOf(track),
      artwork: track.artwork_url || user.avatar_url || '',
      lastPlayed: ts
    };
  }
  const entry = data.tracks[id];
  // also fills in songs that were stored before these fields existed
  if (!entry.sourceId) {
    const external = externalFields(track);
    if (external) Object.assign(entry, external);
  }
  return entry;
}

function artistEntry(data, track) {
  const id = artistIdOf(track);
  if (!id) return null;
  const user = track.user || {};
  const entry = data.artists[id] || (data.artists[id] = { name: String(user.username || ''), avatar: '', plays: 0, seconds: 0 });
  if (user.username) entry.name = String(user.username);
  if (user.avatar_url) entry.avatar = user.avatar_url;
  return entry;
}

function genreEntry(data, track) {
  const name = genreOf(track);
  if (!name) return null;
  const key = name.toLowerCase();
  return data.genres[key] || (data.genres[key] = { name, plays: 0, seconds: 0 });
}

/** Add real listening time (seconds) for a track at time ts */
export function addListening(data, track, seconds, ts = Date.now()) {
  if (!track || track.id === undefined || track.id === null || !(seconds > 0)) return;
  if (!data.since) data.since = ts;
  const day = dayEntry(data, ts);
  day.seconds += seconds;
  data.seconds += seconds;
  trackEntry(data, track, ts).seconds += seconds;
  const artist = artistEntry(data, track);
  if (artist) artist.seconds += seconds;
  const genre = genreEntry(data, track);
  if (genre) genre.seconds += seconds;
}

/** Count one play of a track at time ts */
export function addPlay(data, track, ts = Date.now()) {
  if (!track || track.id === undefined || track.id === null) return;
  if (!data.since) data.since = ts;
  const id = String(track.id);
  const day = dayEntry(data, ts);
  day.plays += 1;
  data.plays += 1;
  day.tracks[id] = (day.tracks[id] || 0) + 1;
  const entry = trackEntry(data, track, ts);
  entry.plays += 1;
  entry.lastPlayed = ts;
  const artist = artistEntry(data, track);
  if (artist) {
    artist.plays += 1;
    day.artists[artistIdOf(track)] = (day.artists[artistIdOf(track)] || 0) + 1;
  }
  const genre = genreEntry(data, track);
  if (genre) {
    genre.plays += 1;
    const key = genre.name.toLowerCase();
    day.genres[key] = (day.genres[key] || 0) + 1;
  }
  if (new Date(ts).getHours() < 4) data.night += 1;
}

/** Seconds of a track that must be heard before it counts as a play */
export function playThreshold(durationSeconds) {
  return durationSeconds > 0 && durationSeconds < PLAY_SECONDS * 2 ? durationSeconds / 2 : PLAY_SECONDS;
}

/**
 * Turns player events into recorded plays and listening time.
 *   track(track)                      the current track changed (can fire twice per track; that's fine)
 *   time(currentTime, duration, playing, nowMs)   a playback position update
 *   state(playing)                    play / pause
 * onChange() runs after anything was recorded; onPlay(track, ts) after a play was counted.
 */
export function createTracker(data, { onChange, onPlay } = {}) {
  let current = null;
  let listened = 0;
  let counted = false;
  let lastWall = null;
  let lastMedia = null;

  const restart = () => { listened = 0; counted = false; lastWall = null; };

  return {
    track(track) {
      if (!track) { current = null; lastWall = lastMedia = null; return; }
      if (!current || current.id !== track.id) {
        current = track;
        restart();
        lastMedia = null;
      } else {
        current = track;
      }
    },

    time(currentTime, duration, playing, nowMs = Date.now()) {
      if (!current) return;
      if (!playing) { lastWall = null; lastMedia = currentTime; return; }
      // a jump back to the start is a new listen (repeat one, or scrubbing back to the beginning)
      if (lastMedia !== null && currentTime < 3 && lastMedia - currentTime > 5) restart();
      if (lastWall !== null && lastMedia !== null) {
        const wall = (nowMs - lastWall) / 1000;
        const media = currentTime - lastMedia;
        if (wall > 0 && wall <= 5 && media > 0 && media <= 5) {
          addListening(data, current, wall, nowMs);
          listened += wall;
          const total = duration > 0 ? duration : (current.duration || 0) / 1000;
          if (!counted && listened >= playThreshold(total)) {
            counted = true;
            addPlay(data, current, nowMs);
            if (onPlay) onPlay(current, nowMs);
          }
          if (onChange) onChange();
        }
      }
      lastWall = nowMs;
      lastMedia = currentTime;
    },

    state(playing) {
      lastWall = null;
      if (!playing) lastMedia = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Ranges, totals and top lists
// ---------------------------------------------------------------------------

export const RANGES = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All time' }
];

/** Day keys covered by a range, oldest first. week = last 7 days, month = last 30, year = last 365. null for 'all'. */
export function rangeKeys(range, now = Date.now()) {
  const n = RANGE_DAYS[range];
  if (!n) return null;
  const today = dayIndex(dayKey(now));
  const keys = [];
  for (let i = today - n + 1; i <= today; i++) keys.push(keyOfIndex(i));
  return keys;
}

/** { seconds, plays, activeDays } for a range */
export function rangeTotals(data, range, now = Date.now()) {
  const keys = rangeKeys(range, now);
  if (!keys) {
    return { seconds: data.seconds, plays: data.plays, activeDays: Object.values(data.days).filter(d => d.plays > 0 || d.seconds > 0).length };
  }
  let seconds = 0;
  let plays = 0;
  let activeDays = 0;
  for (const key of keys) {
    const day = data.days[key];
    if (!day) continue;
    seconds += day.seconds;
    plays += day.plays;
    if (day.plays > 0 || day.seconds > 0) activeDays++;
  }
  return { seconds, plays, activeDays };
}

/**
 * Bars for the listening chart: [{ key, label, seconds, plays }].
 * week and month are one bar per day, year is the last 12 months, all is one bar per month
 * from the first recorded day (days are kept for 400 days, so that is at most about 14 months).
 */
export function series(data, range, now = Date.now()) {
  if (range === 'week' || range === 'month') {
    return rangeKeys(range, now).map((key) => {
      const day = data.days[key];
      const [y, m, d] = key.split('-').map(Number);
      return {
        key,
        label: range === 'week' ? WEEKDAYS[new Date(y, m - 1, d).getDay()] : String(d),
        seconds: day ? day.seconds : 0,
        plays: day ? day.plays : 0
      };
    });
  }
  const here = new Date(now);
  const nowMonth = here.getFullYear() * 12 + here.getMonth();
  let first = nowMonth - 11;
  if (range === 'all') {
    const keys = Object.keys(data.days).sort();
    if (keys.length) {
      const [y, m] = keys[0].split('-').map(Number);
      first = Math.min(nowMonth, y * 12 + (m - 1));
    } else {
      first = nowMonth;
    }
  }
  const buckets = [];
  for (let i = first; i <= nowMonth; i++) {
    const y = Math.floor(i / 12);
    const m = i % 12;
    buckets.push({ key: `${y}-${pad(m + 1)}`, label: MONTHS[m], seconds: 0, plays: 0 });
  }
  const byKey = new Map(buckets.map(b => [b.key, b]));
  for (const [key, day] of Object.entries(data.days)) {
    const bucket = byKey.get(key.slice(0, 7));
    if (bucket) { bucket.seconds += day.seconds; bucket.plays += day.plays; }
  }
  return buckets;
}

/** Sum a per-day map ('tracks' | 'artists' | 'genres') over a range: { id: plays } */
function rangeCounts(data, range, now, field) {
  const counts = {};
  for (const key of rangeKeys(range, now)) {
    const day = data.days[key];
    if (!day) continue;
    for (const [id, n] of Object.entries(day[field])) counts[id] = (counts[id] || 0) + n;
  }
  return counts;
}

/** Most played tracks: [{ id, plays, seconds, title, artist, artistId, genre, artwork, lastPlayed }] */
export function topTracks(data, range = 'all', n = 10, now = Date.now()) {
  const counts = range === 'all' ? null : rangeCounts(data, range, now, 'tracks');
  return Object.entries(data.tracks)
    .map(([id, t]) => ({ id, ...t, plays: counts ? (counts[id] || 0) : t.plays }))
    .filter(t => t.plays > 0)
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || String(a.title).localeCompare(String(b.title)))
    .slice(0, n);
}

/** Most played artists: [{ id, name, avatar, plays, seconds }] */
export function topArtists(data, range = 'all', n = 10, now = Date.now()) {
  const counts = range === 'all' ? null : rangeCounts(data, range, now, 'artists');
  return Object.entries(data.artists)
    .map(([id, a]) => ({ id, ...a, plays: counts ? (counts[id] || 0) : a.plays }))
    .filter(a => a.plays > 0)
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || String(a.name).localeCompare(String(b.name)))
    .slice(0, n);
}

/** Most played genres: [{ name, plays, share }] where share is 0..1 of the listed plays */
export function topGenres(data, range = 'all', n = 10, now = Date.now()) {
  const counts = range === 'all' ? null : rangeCounts(data, range, now, 'genres');
  const list = Object.entries(data.genres)
    .map(([key, g]) => ({ name: g.name, plays: counts ? (counts[key] || 0) : g.plays, seconds: g.seconds }))
    .filter(g => g.plays > 0)
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || a.name.localeCompare(b.name));
  const total = list.reduce((sum, g) => sum + g.plays, 0);
  return list.slice(0, n).map(g => ({ name: g.name, plays: g.plays, share: total ? g.plays / total : 0 }));
}

/**
 * Current and best streak of consecutive days with at least one play.
 * A streak stays alive until the end of the day after your last listening day.
 */
export function streaks(data, now = Date.now()) {
  const indexes = Object.keys(data.days).filter(k => data.days[k].plays > 0).map(dayIndex).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let previous = null;
  for (const i of indexes) {
    run = previous !== null && i === previous + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = i;
  }
  const today = dayIndex(dayKey(now));
  const current = indexes.length && previous >= today - 1 ? run : 0;
  return { current, best: Math.max(best, current, data.best || 0) };
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const hours = (n) => n * 3600;
const mostPlayed = (data) => Object.values(data.tracks).reduce((max, t) => Math.max(max, t.plays), 0);
const played = (map) => Object.values(map).filter(e => e.plays > 0).length;
const longestDay = (data) => Object.values(data.days).reduce((max, d) => Math.max(max, d.seconds), 0);

const BADGES = [
  { id: 'first-play', name: 'First play', description: 'Listen to your first track in Quantm', icon: 'play', test: (d) => d.plays >= 1 },
  { id: 'plays-10', name: 'Warming up', description: 'Play 10 tracks', icon: 'headphones', test: (d) => d.plays >= 10 },
  { id: 'plays-100', name: 'In the groove', description: 'Play 100 tracks', icon: 'headphones', test: (d) => d.plays >= 100 },
  { id: 'plays-1000', name: 'Thousand club', description: 'Play 1,000 tracks', icon: 'trophy', test: (d) => d.plays >= 1000 },
  { id: 'hours-1', name: 'First hour', description: 'Listen for 1 hour in total', icon: 'clock', test: (d) => d.seconds >= hours(1) },
  { id: 'hours-10', name: 'Ten hours', description: 'Listen for 10 hours in total', icon: 'clock', test: (d) => d.seconds >= hours(10) },
  { id: 'hours-100', name: 'Century of sound', description: 'Listen for 100 hours in total', icon: 'clock', test: (d) => d.seconds >= hours(100) },
  { id: 'streak-7', name: 'Week streak', description: 'Listen 7 days in a row', icon: 'flame', test: (d, s) => s.best >= 7 },
  { id: 'streak-30', name: 'Month streak', description: 'Listen 30 days in a row', icon: 'flame', test: (d, s) => s.best >= 30 },
  { id: 'artists-25', name: 'Explorer', description: 'Listen to 25 different artists', icon: 'users', test: (d) => played(d.artists) >= 25 },
  { id: 'night-owl', name: 'Night owl', description: 'Play a track between midnight and 4 am', icon: 'moon', test: (d) => d.night >= 1 },
  { id: 'genre-hopper', name: 'Genre hopper', description: 'Play tracks from 5 different genres', icon: 'compass', test: (d) => played(d.genres) >= 5 },
  { id: 'heavy-rotation', name: 'Heavy rotation', description: 'Play the same track 10 times', icon: 'repeat', test: (d) => mostPlayed(d) >= 10 },
  { id: 'marathon', name: 'Marathon', description: 'Listen for 3 hours in a single day', icon: 'star', test: (d) => longestDay(d) >= hours(3) }
];

/** Every badge: { id, name, description, icon, earned, date } (date is a timestamp, or null) */
export function badgeList(data, now = Date.now()) {
  const s = streaks(data, now);
  return BADGES.map(({ id, name, description, icon, test }) => {
    const date = data.earned[id] || null;
    return { id, name, description, icon, earned: !!date || test(data, s), date };
  });
}

/** Ids of badges whose goal is reached but which aren't recorded as earned yet */
export function newBadges(data, now = Date.now()) {
  return badgeList(data, now).filter(b => b.earned && !b.date).map(b => b.id);
}

/** Record freshly earned badges with today's date. Returns the badges that were just earned. */
export function awardBadges(data, ts = Date.now()) {
  const s = streaks(data, ts);
  data.best = Math.max(data.best || 0, s.best);
  const fresh = newBadges(data, ts);
  for (const id of fresh) data.earned[id] = ts;
  return badgeList(data, ts).filter(b => fresh.includes(b.id));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 4500 -> { value: '1.3', unit: 'hours' }; under an hour it counts minutes */
export function formatListening(seconds) {
  const s = Math.max(0, seconds || 0);
  if (s < 3600) return { value: String(Math.round(s / 60)), unit: 'min' };
  const h = s / 3600;
  const value = h >= 100 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, '');
  return { value, unit: value === '1' ? 'hour' : 'hours' };
}

/** 4500 -> '1.3 hours', 1800 -> '30 min' */
export function formatTime(seconds) {
  const { value, unit } = formatListening(seconds);
  return `${value} ${unit}`;
}

// ---------------------------------------------------------------------------
// Storage and live recording
// ---------------------------------------------------------------------------

// whole numbers stay as they are, fractions are rounded so the saved JSON stays small
const round = (key, value) => (typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 10) / 10 : value);

export function loadStats(now = Date.now()) {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STATS_KEY)); } catch (e) { raw = null; }
  return pruneStats(normalizeStats(raw), now);
}

export function saveStats(data, now = Date.now()) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(pruneStats(data, now), round));
    return true;
  } catch (e) {
    return false;
  }
}

let live = null;
let started = false;

/** The live stats (loaded on first use) */
export function getStats() {
  if (!live) live = loadStats();
  return live;
}

/** Start recording. Call once after the app shell mounts. */
export function initStats() {
  if (started) return;
  started = true;
  const data = getStats();
  let dirty = false;

  const flush = () => {
    const fresh = awardBadges(data);
    fresh.forEach(b => toast(`Badge unlocked: ${b.name}`));
    if (dirty || fresh.length) { saveStats(data); dirty = false; }
  };

  const tracker = createTracker(data, {
    onChange: () => { dirty = true; },
    onPlay: () => flush()
  });
  tracker.track(player.current);
  player.on('track', (track) => tracker.track(track));
  player.on('time', (currentTime, duration) => tracker.time(currentTime, duration, player.playing, Date.now()));
  player.on('state', () => {
    tracker.state(player.playing);
    if (!player.playing) flush();
  });
  setInterval(() => { if (dirty) flush(); }, 15000);
  window.addEventListener('beforeunload', () => { if (dirty) saveStats(data); });
}
