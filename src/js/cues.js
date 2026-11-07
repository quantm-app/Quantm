// Per-song markers, kept on this computer:
//  - cue points: up to 9 bookmarks to jump to (keys 1-9)
//  - mix-in / mix-out: where a song comes in when mixed into, and where it starts handing over
//  - pair transitions: an override for one specific "A into B" mix
// Times are media seconds (positions in the song, independent of playback speed).

import { Emitter } from './dom.js';
import { MAX_FADE, normalizeCurve } from './transition-model.js';

const KEY = 'quantm.cues';
const MAX_CUES = 9;
const MAX_TRACKS = 3000;

/** cueEvents.on('change', (id) => ...) whenever a song's markers change */
export const cueEvents = new Emitter();

let data = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { tracks: saved.tracks || {}, pairs: saved.pairs || {} };
  } catch (e) {
    return { tracks: {}, pairs: {} };
  }
}

function persist(id) {
  // keep storage bounded: drop the oldest-touched songs first
  const ids = Object.keys(data.tracks);
  if (ids.length > MAX_TRACKS) {
    ids.sort((a, b) => (data.tracks[a].at || 0) - (data.tracks[b].at || 0))
      .slice(0, ids.length - MAX_TRACKS).forEach(old => delete data.tracks[old]);
  }
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage full or unavailable */ }
  cueEvents.emit('change', id);
}

const time = (t) => {
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

function entry(id) {
  const key = String(id);
  if (!data.tracks[key]) data.tracks[key] = { cues: [], mixIn: null, mixOut: null };
  data.tracks[key].at = Date.now();
  return data.tracks[key];
}

/** Clean up an entry that no longer holds anything */
function tidy(id) {
  const e = data.tracks[String(id)];
  if (e && !e.cues.length && e.mixIn == null && e.mixOut == null) delete data.tracks[String(id)];
}

/** { cues: [{ t, label }], mixIn, mixOut } for a song (empty when nothing is set) */
export function getCues(id) {
  const e = data.tracks[String(id)];
  return e ? { cues: e.cues.slice(), mixIn: e.mixIn, mixOut: e.mixOut } : { cues: [], mixIn: null, mixOut: null };
}

/** Add a cue point (kept sorted by time). Returns its number (1-9), or 0 when full */
export function addCue(id, t, label = '') {
  const at = time(t);
  if (at === null) return 0;
  const e = entry(id);
  if (e.cues.length >= MAX_CUES) return 0;
  if (e.cues.some(c => Math.abs(c.t - at) < 0.5)) return e.cues.findIndex(c => Math.abs(c.t - at) < 0.5) + 1;
  e.cues.push({ t: at, label: String(label || '').slice(0, 40) });
  e.cues.sort((a, b) => a.t - b.t);
  persist(id);
  return e.cues.findIndex(c => c.t === at) + 1;
}

export function removeCue(id, index) {
  const e = data.tracks[String(id)];
  if (!e || !e.cues[index]) return;
  e.cues.splice(index, 1);
  tidy(id);
  persist(id);
}

export function renameCue(id, index, label) {
  const e = data.tracks[String(id)];
  if (!e || !e.cues[index]) return;
  e.cues[index].label = String(label || '').slice(0, 40);
  persist(id);
}

/** Where the song comes in when another song mixes into it (null = from the start) */
export function setMixIn(id, t) {
  const e = entry(id);
  e.mixIn = t == null ? null : time(t);
  tidy(id);
  persist(id);
}

/** Where the song starts handing over to the next one (null = near the end, like crossfade) */
export function setMixOut(id, t) {
  const e = entry(id);
  e.mixOut = t == null ? null : time(t);
  tidy(id);
  persist(id);
}

const pairKey = (a, b) => `${a}>${b}`;

/** Override for one specific transition: { out, in, fade, style?, curve? } (any may be null = use the default) */
export function getPair(fromId, toId) {
  const p = data.pairs[pairKey(fromId, toId)];
  return p ? Object.assign({}, p) : null;
}

export function setPair(fromId, toId, value) {
  const key = pairKey(fromId, toId);
  if (!value) delete data.pairs[key];
  else {
    const fade = value.fade == null ? NaN : Number(value.fade);
    data.pairs[key] = {
      out: value.out == null ? null : time(value.out),
      in: value.in == null ? null : time(value.in),
      fade: Number.isFinite(fade) ? Math.min(MAX_FADE, Math.max(0, fade)) : null
    };
    if (['auto', 'blend', 'dropcut'].includes(value.style)) data.pairs[key].style = value.style;
    const curve = normalizeCurve(value.curve);
    if (curve) data.pairs[key].curve = curve;
  }
  persist(fromId);
}

/**
 * How to go from song `from` into song `to`.
 *   out:  media time in `from` where the mix starts (null = the usual crossfade near the end)
 *   in:   media time in `to` where it starts playing
 *   fade: seconds the overlap lasts (0 = a clean cut)
 *   curve: the pair's volume curve ({ dj, center }), when it has one
 *   custom: true when any mix point applies (then it mixes even with crossfade turned off)
 */
export function transitionFor(fromId, toId, crossfadeSeconds = 0, defaultFade = 6) {
  const a = getCues(fromId);
  const b = toId == null ? { mixIn: null } : getCues(toId);
  const pair = toId == null ? null : getPair(fromId, toId);
  const out = pair && pair.out != null ? pair.out : a.mixOut;
  const into = pair && pair.in != null ? pair.in : b.mixIn;
  const custom = out != null || into != null || pair?.fade != null;
  let fade = pair && pair.fade != null ? pair.fade : crossfadeSeconds;
  if (custom && !(pair && pair.fade != null) && !crossfadeSeconds) fade = defaultFade;
  return { out: out == null ? null : out, in: into == null ? 0 : into, fade, custom,
    ...(pair?.style ? { style: pair.style } : {}), ...(pair?.curve ? { curve: pair.curve } : {}) };
}

/** For tests: forget everything held in memory and storage */
export function _reset() {
  data = { tracks: {}, pairs: {} };
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}
