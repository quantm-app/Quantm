// Auto mix taste learning. Each transition tries a small random variation of the
// learned mix settings; keeping the new song nudges the settings toward it,
// skipping nudges them away. Learned per tempo bucket and, on top of that, per genre
// family + tempo; kept in localStorage.
//
// A genre bucket is keyed 'bass:fast' (family:tempo); a tempo-only bucket is just 'fast'.
// The tempo-only buckets keep learning from every transition and stay the fallback: a genre
// bucket with fewer than MIN_OUTCOMES outcomes starts from the tempo-only values.
const KEY = 'quantm.mixlearn';
const RATE = 0.1;
const FIELDS = ['length', 'dj', 'stretch'];
const BUCKETS = ['slow', 'mid', 'fast', 'faster', 'nobeat'];
const STYLES = ['blend', 'dropcut'];
// How far a try may stray from the learned value (either direction).
const VARIATION = Object.freeze({ length: 0.12, dj: 0.15, stretch: 0.008 });

export const DEFAULTS = Object.freeze({ length: 1, dj: 1, stretch: 0.08 });
export const LIMITS = Object.freeze({ length: [0.5, 1.5], dj: [0, 1], stretch: [0.02, 0.08] });
/** Outcomes a genre bucket needs before its own values replace the tempo-only ones. */
export const MIN_OUTCOMES = 5;
/** Genre families with their display names ('unknown' has none: it learns tempo-only). */
export const FAMILY_LABELS = Object.freeze({ dance: 'dance music', bass: 'bass music', hiphop: 'hip-hop', other: 'other genres' });
export const TEMPO_LABELS = Object.freeze({ slow: 'under 100 BPM', mid: '100-130 BPM', fast: '130-160 BPM', faster: '160+ BPM', nobeat: 'songs without a clear beat' });

// { buckets: { [tempo]: entry }, genres: { ['family:tempo']: entry } }, loaded on first use.
// entry = { length, dj, stretch, good, bad, styles? }
let data = null;

function clamp(field, value) {
  const [lo, hi] = LIMITS[field];
  return Math.max(lo, Math.min(hi, value));
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function count(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fresh() {
  return { ...DEFAULTS, good: 0, bad: 0 };
}

function empty() {
  return { buckets: {}, genres: {} };
}

/** Split a bucket key into { family, tempo }; family is null for tempo-only keys. Null for anything else. */
export function parseBucket(key) {
  if (typeof key !== 'string') return null;
  const [first, second, ...extra] = key.split(':');
  if (extra.length) return null;
  const family = second === undefined ? null : first;
  const tempo = second === undefined ? first : second;
  if (!BUCKETS.includes(tempo)) return null;
  if (family !== null && !Object.hasOwn(FAMILY_LABELS, family)) return null;
  return { family, tempo };
}

// Clean up one stored bucket: clamp the numbers, fall back to defaults.
function sanitize(raw) {
  const entry = fresh();
  if (!raw || typeof raw !== 'object') return entry;
  for (const field of FIELDS) {
    const n = typeof raw[field] === 'number' ? raw[field] : NaN;
    entry[field] = Number.isFinite(n) ? round(clamp(field, n)) : DEFAULTS[field];
  }
  entry.good = count(raw.good);
  entry.bad = count(raw.bad);
  if (raw.styles && typeof raw.styles === 'object') {
    entry.styles = {};
    for (const style of STYLES) entry.styles[style] = {
      good: count(raw.styles[style]?.good), bad: count(raw.styles[style]?.bad)
    };
  }
  return entry;
}

function load() {
  if (data) return data;
  data = empty();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && saved.version === 1) {
      // Saves from before genres only have `buckets` (tempo-only): they load as-is and become the fallback.
      const buckets = saved.buckets;
      if (buckets && typeof buckets === 'object') {
        for (const bucket of BUCKETS) {
          if (Object.hasOwn(buckets, bucket)) data.buckets[bucket] = sanitize(buckets[bucket]);
        }
      }
      const genres = saved.genres;
      if (genres && typeof genres === 'object') {
        for (const key of Object.keys(genres)) {
          if (parseBucket(key)?.family) data.genres[key] = sanitize(genres[key]);
        }
      }
    }
  } catch { /* corrupt or unavailable storage: start from defaults */ }
  return data;
}

function save() {
  try {
    // Still version 1: older builds read `buckets` and ignore `genres`, so nothing is lost either way.
    localStorage.setItem(KEY, JSON.stringify({ version: 1, ...load() }));
  } catch { /* storage full or blocked: keep what we have in memory */ }
}

const outcomes = entry => (entry ? entry.good + entry.bad : 0);

// The entry whose values a bucket starts from: its own once it has enough outcomes, else the tempo-only one.
function learnedFor({ family, tempo }, key, get = entry => entry) {
  const own = family ? get(load().genres[key]) : null;
  return own && outcomes(own) >= MIN_OUTCOMES ? own : get(load().buckets[tempo]);
}

/** Tempo bucket for a transition: 'slow' (< 100 BPM), 'mid' (100–<130), 'fast' (130–<160), 'faster' (>= 160), 'nobeat' (bpm null/invalid). With a genre family ('dance', 'bass', 'hiphop', 'other') the key becomes 'bass:fast'; 'unknown' or no family gives the tempo-only key. */
export function bucketFor(bpm, family = null) {
  let tempo = 'faster';
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) tempo = 'nobeat';
  else if (bpm < 100) tempo = 'slow';
  else if (bpm < 130) tempo = 'mid';
  else if (bpm < 160) tempo = 'fast';
  return typeof family === 'string' && Object.hasOwn(FAMILY_LABELS, family) ? `${family}:${tempo}` : tempo;
}

/** The same transition filed under a different tempo (the beat only became clear later), keeping its genre. */
export function rebucket(key, bpm) {
  return bucketFor(bpm, parseBucket(key)?.family);
}

/** Readable name for a bucket key: "bass music · 130-160 BPM", or just the tempo for tempo-only keys. */
export function describeBucket(key) {
  const parsed = parseBucket(key);
  if (!parsed) return TEMPO_LABELS.nobeat;
  const tempo = parsed.family && parsed.tempo === 'nobeat' ? 'no clear beat' : TEMPO_LABELS[parsed.tempo];
  return parsed.family ? `${FAMILY_LABELS[parsed.family]} · ${tempo}` : tempo;
}

/** Parameters for the next transition in this bucket: the learned values plus a small random variation (length ±0.12, dj ±0.15, stretch ±0.008, uniform), clamped to LIMITS. A genre bucket with fewer than MIN_OUTCOMES outcomes starts from its tempo bucket's values. Returns { bucket, base: {...learned}, params: {...tried} }. random is injectable for tests (defaults to Math.random). */
export function choose(bucket, random = Math.random) {
  let parsed = parseBucket(bucket);
  if (!parsed) { bucket = 'nobeat'; parsed = { family: null, tempo: 'nobeat' }; }
  const learned = learnedFor(parsed, bucket) || DEFAULTS;
  const base = {};
  const params = {};
  for (const field of FIELDS) {
    base[field] = learned[field];
    params[field] = round(clamp(field, learned[field] + (random() * 2 - 1) * VARIATION[field]));
  }
  return { bucket, base, params };
}

/** Learn from how a transition went. outcome: 'good' (the new song kept playing, or you rated it up) or 'bad' (you rated it down). Moves the bucket's learned values by rate 0.1: good → base + 0.1·(params − base); bad → base − 0.1·(params − base). A genre bucket learns from the base it was tried from (so it starts at the tempo values) and the tempo-only bucket learns every transition too. Clamp to LIMITS, count it, save. Ignores unknown outcomes / malformed choices. */
export function record(choice, outcome) {
  if (outcome !== 'good' && outcome !== 'bad') return;
  const parsed = parseBucket(choice?.bucket);
  if (!parsed) return;
  const { base, params } = choice;
  for (const field of FIELDS) {
    if (!Number.isFinite(base?.[field]) || !Number.isFinite(params?.[field])) return;
  }
  const { buckets, genres } = load();
  const sign = outcome === 'good' ? 1 : -1;
  // Step by the variation that was tried, applied to what is learned now.
  const step = field => choice.style === 'dropcut' ? 0 : sign * RATE * (params[field] - base[field]);
  const tempoEntry = buckets[parsed.tempo] || (buckets[parsed.tempo] = fresh());
  const genreEntry = parsed.family ? genres[choice.bucket] || (genres[choice.bucket] = fresh()) : null;
  for (const entry of [tempoEntry, genreEntry]) {
    if (!entry) continue;
    if (STYLES.includes(choice.style)) {
      entry.styles ||= { blend: { good: 0, bad: 0 }, dropcut: { good: 0, bad: 0 } };
      entry.styles[choice.style][outcome]++;
    }
    entry[outcome] += 1;
  }
  for (const field of FIELDS) {
    tempoEntry[field] = round(clamp(field, tempoEntry[field] + step(field)));
    if (genreEntry) genreEntry[field] = round(clamp(field, base[field] + step(field)));
  }
  save();
}

/** A skipped drop cut makes Auto prefer blends in this bucket (the genre's own record once it has enough outcomes, else the tempo's). Explicit choices still work. */
export function avoidsDropCut(bucket) {
  const parsed = parseBucket(bucket);
  if (!parsed) return false;
  const dropcut = learnedFor(parsed, bucket, entry => entry?.styles?.dropcut);
  return !!dropcut && dropcut.bad > dropcut.good;
}

/** What has been learned, for the settings screen: { transitions (total recorded), buckets: { [tempo]: { length, dj, stretch, good, bad } }, genres: { ['family:tempo']: same } } (only buckets with data). */
export function stats() {
  const out = { transitions: 0, buckets: {}, genres: {} };
  const { buckets, genres } = load();
  for (const [bucket, entry] of Object.entries(buckets)) {
    if (outcomes(entry) === 0) continue;
    out.buckets[bucket] = { ...entry };
    out.transitions += outcomes(entry);
  }
  for (const [key, entry] of Object.entries(genres)) {
    if (outcomes(entry) > 0) out.genres[key] = { ...entry };
  }
  return out;
}

/** Forget everything learned. */
export function reset() {
  data = empty();
  save();
}
