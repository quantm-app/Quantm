// How Auto mix transitions actually went, for choosing songs that mix well (mixorder.js blendCost).
// Three views of the same outcomes (a thumbs rating, or keeping the new song): this exact pair of songs,
// each song on its own (some songs mix well with anything), and the pair of genre families.
const KEY = 'quantm.mixpairs';
const LIMITS = { pairs: 3000, tracks: 3000 };
const OUTCOMES = ['good', 'bad'];
const validId = id => Number.isSafeInteger(id) && id > 0;
const count = value => Number.isInteger(value) && value >= 0 ? value : 0;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

// Stored data can be hand-edited, from an older build or half-written, so every map is rebuilt from
// scratch: junk entries are dropped, junk counts become 0, and nothing downstream has to check again.
// (No prototype, so a stored key like "__proto__" is just a key.)
function cleanMap(raw) {
  const map = Object.create(null);
  if (!isObject(raw)) return map;
  for (const [key, entry] of Object.entries(raw)) {
    if (isObject(entry)) map[key] = { good: count(entry.good), bad: count(entry.bad), at: stamp(entry.at) };
  }
  return map;
}

function read() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data?.version === 1) return { pairs: cleanMap(data.pairs), tracks: cleanMap(data.tracks), families: cleanMap(data.families) };
  } catch {}
  return { pairs: cleanMap(), tracks: cleanMap(), families: cleanMap() };
}

function save(data) {
  // forget the oldest entries first so the store stays small
  for (const [name, limit] of Object.entries(LIMITS)) {
    const keys = Object.keys(data[name]);
    if (keys.length > limit) keys.sort((a, b) => (data[name][a].at || 0) - (data[name][b].at || 0))
      .slice(0, keys.length - limit).forEach(key => delete data[name][key]);
  }
  try { localStorage.setItem(KEY, JSON.stringify({ version: 1, ...data })); } catch {}
}

const tally = (entry) => entry ? { good: count(entry.good), bad: count(entry.bad) } : null;
const bump = (map, key, outcome) => {
  const entry = map[key] || (map[key] = { good: 0, bad: 0, at: 0 });
  entry[outcome] = count(entry[outcome]) + 1;
  entry.at = Date.now();
};

/** Remember how the transition from one song into the next went. outcome: 'good' | 'bad' */
export function record({ fromId, toId, fromFamily, toFamily }, outcome) {
  if (!OUTCOMES.includes(outcome) || !validId(fromId) || !validId(toId) || fromId === toId) return;
  const data = read();
  bump(data.pairs, `${fromId}>${toId}`, outcome);
  bump(data.tracks, String(fromId), outcome);
  bump(data.tracks, String(toId), outcome);
  if (fromFamily && toFamily) bump(data.families, `${fromFamily}>${toFamily}`, outcome);
  save(data);
}

/** { good, bad } for one exact transition, a song in any transition, or a pair of genre families; null when never seen */
export const pair = (fromId, toId) => tally(read().pairs[`${fromId}>${toId}`]);
export const track = id => tally(read().tracks[String(id)]);
export const family = (from, to) => tally(read().families[`${from}>${to}`]);

/** The lookups blendCost takes, read once so ordering a long queue doesn't parse storage per pair */
export function history() {
  const data = read();
  return {
    pair: (fromId, toId) => tally(data.pairs[`${fromId}>${toId}`]),
    track: id => tally(data.tracks[String(id)]),
    family: (from, to) => tally(data.families[`${from}>${to}`])
  };
}

export function reset() { save({ pairs: {}, tracks: {}, families: {} }); }
