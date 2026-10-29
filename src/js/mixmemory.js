import { analyze, detectDrop, orientGrid } from './beats.js';
import { mergeKey } from './keys.js';
import { normalizeVocals, mergeVocals } from './vocals.js';

const KEY = 'quantm.mixmemory';
const LIMIT = 3000;
const clamp = value => Math.max(0, Math.min(1, value));
const positive = value => Number.isFinite(value) && value > 0;
const time = value => Number.isFinite(value) && value >= 0;
const mod = (value, period) => ((value % period) + period) % period;
const round = (value, scale) => Math.round(value * scale) / scale;
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : 0;
};
const validGrid = grid => grid && positive(grid.period) && grid.period >= 0.1 &&
  grid.period <= 3 && time(grid.offset) && Number.isFinite(grid.confidence);

// Keep the beat nearest the common reference when changing a grid's tempo octave.
function normalize(grid, period, reference) {
  if (!validGrid(grid)) return null;
  for (const factor of [1, 0.5, 2]) {
    const p = grid.period * factor;
    if (Math.abs(p / period - 1) <= 0.01 + 1e-12) {
      const offset = grid.offset + Math.round((reference - grid.offset) / grid.period) * grid.period;
      return { ...grid, period: p, offset };
    }
  }
  return null;
}

function circular(grids, period, reference) {
  let x = 0, y = 0;
  for (const grid of grids) {
    const beat = grid.offset + Math.round((reference - grid.offset) / grid.period) * grid.period;
    const angle = mod(beat - reference, period) / period * Math.PI * 2;
    x += Math.cos(angle) * grid.weight;
    y += Math.sin(angle) * grid.weight;
  }
  return mod(reference + Math.atan2(y, x) / (Math.PI * 2) * period, period);
}

function fuseWindows(windows) {
  const candidates = windows.filter(window => window.grid?.confidence >= 0.25);
  if (!candidates.length) return null;
  let dominant = candidates[0].grid, support = -1;
  for (const candidate of candidates) {
    const score = candidates.reduce((sum, window) => sum +
      (normalize(window.grid, candidate.grid.period, window.center) ? window.grid.confidence : 0), 0);
    if (score > support) { dominant = candidate.grid; support = score; }
  }
  const grids = candidates.map(window => {
    const reference = dominant.offset + Math.round((window.center - dominant.offset) / dominant.period) * dominant.period;
    const grid = normalize(window.grid, dominant.period, reference);
    return grid && { ...grid, weight: grid.confidence, center: window.center };
  }).filter(Boolean);
  const weight = grids.reduce((sum, grid) => sum + grid.weight, 0);
  let period = grids.reduce((sum, grid) => sum + grid.period * grid.weight, 0) / weight;
  const reference = grids.reduce((sum, grid) => sum + grid.center * grid.weight, 0) / weight;
  // The weighted window periods seed the beat counts. Their phase drift over a
  // whole play refines the period beyond the precision of any short window.
  const anchor = grids[0].offset;
  const beats = grids.map(grid => ({ ...grid, index: Math.round((grid.offset - anchor) / period) }));
  const meanIndex = beats.reduce((sum, beat) => sum + beat.index * beat.weight, 0) / weight;
  const meanTime = beats.reduce((sum, beat) => sum + beat.offset * beat.weight, 0) / weight;
  let numerator = 0, denominator = 0;
  for (const beat of beats) {
    numerator += beat.weight * (beat.index - meanIndex) * (beat.offset - meanTime);
    denominator += beat.weight * (beat.index - meanIndex) ** 2;
  }
  const refined = numerator / denominator;
  if (grids.length >= 3 && denominator / weight > 100 && Math.abs(refined / period - 1) < 0.002) period = refined;
  return {
    bpm: 60 / period, period,
    offset: circular(grids.map(grid => ({ ...grid, period })), period, reference),
    confidence: grids.reduce((sum, grid) => sum + grid.confidence * grid.weight, 0) / weight *
      Math.min(1, grids.length / 3) * grids.length / candidates.length
  };
}

function analyzeWindow(points, opts) {
  const peak = points.reduce((value, point) => Math.max(value, point.v), 0);
  const active = new Set();
  for (const point of points) if (peak > 1e-8 && point.v >= peak * 0.2) active.add(Math.floor(point.t));
  // Two seconds of drums followed by silence can have deceptively high correlation.
  return active.size >= 4 ? analyze(points, opts) : null;
}

/** Collect one play in bounded raw windows and a per-second energy profile. */
export function createListener(opts = {}) {
  let raw = [], windows = [], segmentStart = null, nextEnd = null, last = null, analyzedTo = -Infinity;
  let heardFrom = Infinity, heardTo = -Infinity, first = null, revision = 0, cached = null;
  const profile = new Map();
  const dropProfile = new Map();

  function windowResult(points) {
    if (points.length < 2 || points.at(-1).t - points[0].t < 4) return;
    const start = points[0].t, end = points.at(-1).t;
    windows.push({ start, end, center: (start + end) / 2, grid: analyzeWindow(points, opts) });
    if (windows.length > 10000) windows.shift();
  }

  function finish() {
    // A short play or the tail after a seek can still teach us a grid.
    if (raw.length && analyzedTo < raw.at(-1).t - 0.05) windowResult(raw);
    raw = [];
  }

  return {
    /** Append media-time samples; seeks start independent analysis segments. */
    add(samples) {
      if (!Array.isArray(samples)) return;
      for (const sample of samples) {
        if (!sample || !time(sample.t) || sample.t > 86400 || !Number.isFinite(sample.v)) continue;
        const t = sample.t;
        if (last !== null && (t < last || t - last > 2)) {
          finish();
          segmentStart = null;
          analyzedTo = -Infinity;
        }
        if (segmentStart === null) { segmentStart = t; nextEnd = t + 20; }
        if (first === null) first = t;
        heardFrom = Math.min(heardFrom, t);
        heardTo = Math.max(heardTo, t);
        last = t;
        const point = { t, v: Math.max(0, Math.min(1e6, sample.v)),
          h: Number.isFinite(sample.h) ? Math.max(0, Math.min(1e6, sample.h)) : 0,
          f: Number.isFinite(sample.f) ? Math.max(0, Math.min(1e6, sample.f)) : 0 };
        raw.push(point);
        const tenth = Math.round(t * 10);
        const energy = dropProfile.get(tenth) || { n: 0, v: 0 };
        energy.v += (point.v - energy.v) / ++energy.n;
        if (dropProfile.size < 864000 || dropProfile.has(tenth)) dropProfile.set(tenth, energy);
        if (t >= nextEnd) {
          windowResult(raw);
          analyzedTo = t;
          nextEnd = t + 10;
          raw = raw.filter(point => point.t >= t - 10);
        }
        // Also bound pathological input with millions of equal timestamps.
        if (raw.length > 8192) raw = raw.filter((_, index) => index % 2 === 0);
        const second = Math.floor(t);
        let bin = profile.get(second);
        if (!bin && profile.size < 86400) {
          bin = { v: 0, f: 0, n: 0, from: t, to: t, mask: 0 };
          profile.set(second, bin);
        }
        if (bin) {
          bin.n++;
          bin.v += (point.v - bin.v) / bin.n;
          bin.f += (point.f - bin.f) / bin.n;
          bin.from = Math.min(bin.from, t);
          bin.to = Math.max(bin.to, t);
          bin.mask |= 1 << Math.min(9, Math.floor((t - second) * 10));
        }
        revision++;
      }
    },

    /** Summarize the grid and conservative structure; duration enables end detection. */
    summary(duration) {
      if (first === null) return null;
      if (!cached || cached.revision !== revision) {
        const all = windows.slice();
        if (raw.length > 1 && raw.at(-1).t - raw[0].t >= 4 &&
            analyzedTo < raw.at(-1).t - 0.05) {
          all.push({ start: raw[0].t, end: raw.at(-1).t,
            center: (raw[0].t + raw.at(-1).t) / 2, grid: analyzeWindow(raw, opts) });
        }
        cached = { revision, windows: all, grid: fuseWindows(all) };
      }
      const grid = cached.grid;
      const confident = cached.windows.filter(window => window.grid?.confidence >= 0.25 &&
        grid && normalize(window.grid, grid.period, window.center));
      const bins = [...profile].sort((a, b) => a[0] - b[0]);
      // Replaying two tiny fragments of a second must not fill a seek gap.
      const covered = bin => {
        if (!bin || bin.to - bin.from < 0.6) return false;
        let bits = bin.mask, slots = 0;
        while (bits) { bits &= bits - 1; slots++; }
        return slots >= 8;
      };
      const supported = second => confident.some(window => second >= window.start - 1 && second < window.end);
      const energies = bins.filter(([second, bin]) => covered(bin) && supported(second)).map(([, bin]) => bin.v);
      const middle = median(energies);
      const loud = median(energies.filter(value => value >= middle));
      // Four consecutive observed seconds above 50% of the median kick energy in
      // confident beat windows establish drums. Below 25% is an absent beat.
      // Ambiguous energy or missing seconds cannot establish an outro; require a
      // confident beat before it, four quiet seconds, and coverage through the end.
      const present = second => covered(profile.get(second)) && loud > 1e-8 &&
        profile.get(second).v >= loud * 0.5 && supported(second);
      const quiet = second => covered(profile.get(second)) && loud > 1e-8 &&
        profile.get(second).v < loud * 0.25;
      let drumsIn = null, outroStart = null, beatToEnd = false, firstBeat = null;
      for (const [second] of bins) {
        if ([0, 1, 2, 3].every(i => present(second + i))) { firstBeat = second; break; }
      }
      if (first <= 1 && firstBeat !== null) {
        // Do not infer the intro boundary through an unheard seek gap.
        let complete = true;
        for (let second = Math.ceil(first); second < firstBeat; second++) {
          if (!covered(profile.get(second))) { complete = false; break; }
        }
        if (complete) drumsIn = firstBeat <= 1 ? 0 : firstBeat;
      }
      if (positive(duration) && heardTo >= duration - 3 && firstBeat !== null) {
        // Ignore a final fractional second; a seek past the ending is not coverage.
        const end = Math.floor(Math.min(duration, heardTo + 0.05)) - 1;
        if ([0, 1, 2].every(i => present(end - i))) beatToEnd = true;
        else {
          let start = end + 1;
          while (start > 0 && quiet(start - 1)) start--;
          if (end - start + 1 >= 4 && start > firstBeat &&
              [1, 2, 3].every(i => present(start - i))) outroStart = start;
        }
      }
      // The first sustained drums anchor phrases. A partial play cannot establish that anchor.
      const downbeat = grid && drumsIn !== null ? grid.offset + Math.round((drumsIn - grid.offset) / grid.period) * grid.period : null;
      if (cached.dropAnchor !== downbeat || !('drop' in cached)) {
        cached.dropAnchor = downbeat;
        cached.drop = downbeat !== null ? detectDrop([...dropProfile].map(([key, bin]) => ({ t: key / 10, v: bin.v })), { ...grid, downbeat }) : null;
      }
      const drop = cached.drop;
      return { grid: grid && { ...grid, downbeat }, drop, drumsIn, outroStart, beatToEnd, heardFrom, heardTo };
    }
  };
}

/** Whole-track amplitude hints. Drop candidates are never confirmed audio drops. */
export function fromWaveform(waveform, duration) {
  const result = { drumsIn: null, outroStart: null, dropCandidates: [] };
  const values = waveform?.samples;
  if (!positive(duration) || !positive(waveform?.width) || !positive(waveform?.height) ||
      !Array.isArray(values) || values.length < 2 || values.length > 1000000 ||
      !values.every(value => Number.isFinite(value) && value >= 0)) return result;
  const middle = median(values);
  const loud = median(values.filter(value => value >= middle));
  if (!(loud > 0)) return result;
  const threshold = loud * 0.7, step = duration / values.length;
  let start = 0;
  for (let i = 0; i <= values.length; i++) {
    if (i < values.length && values[i] >= threshold) continue;
    if ((i - start) * step >= 4) { result.drumsIn = start * step; break; }
    start = i + 1;
  }
  let tail = values.length;
  while (tail > 0 && values[tail - 1] < threshold) tail--;
  const length = (values.length - tail) * step;
  if (tail > 0 && length >= 4 && length <= 60) result.outroStart = tail * step;
  // A limited master rarely doubles in amplitude. Compare a smoothed breakdown with
  // this track's loud plateau and inter-percentile range, rather than absolute peaks.
  if (step <= 2) {
    // Standardize the peak envelope before measuring section noise. Raw bins have
    // very different densities across uploads; 450 bins retains multi-second breaks
    // without treating every kick's peak variation as the section's dynamics.
    const source = waveform.samples;
    const size = Math.min(450, source.length);
    const values = Array.from({ length: size }, (_, i) => {
      const a = Math.floor(i * source.length / size), b = Math.floor((i + 1) * source.length / size);
      let total = 0;
      for (let j = a; j < b; j++) total += source[j];
      return total / (b - a);
    });
    const step = duration / size;
    if (step > 2) return result;
    const sum = [0], squares = [0];
    for (const value of values) {
      sum.push(sum.at(-1) + value);
      squares.push(squares.at(-1) + value * value);
    }
    const mean = (a, b) => (sum[b] - sum[a]) / (b - a);
    const radius = Math.max(1, Math.round(0.3 / step));
    const smooth = values.map((_, i) => mean(Math.max(0, i - radius), Math.min(values.length, i + radius + 1)));
    const sorted = smooth.slice().sort((a, b) => a - b);
    const percentile = p => sorted[Math.floor((sorted.length - 1) * p)];
    const plateau = percentile(0.8), floor = percentile(0.2);
    const contrast = Math.max(plateau * 0.04, (plateau - floor) * 0.2);
    const sums = [0];
    for (const value of smooth) sums.push(sums.at(-1) + value);
    const avg = (a, b) => (sums[b] - sums[a]) / (b - a);
    const bins = seconds => Math.max(1, Math.ceil(seconds / step));
    const quiet = bins(4), sustain = bins(8), edge = bins(1);
    for (let i = quiet; i + sustain <= values.length; i++) {
      const before = avg(i - quiet, i), after = avg(i, i + sustain);
      const jump = avg(i, i + edge) - avg(i - edge, i);
      if (after < plateau * 0.88 || after - before < contrast ||
          jump < contrast * 0.65 || jump < (after - before) * 0.45 ||
          before > plateau - contrast ||
          [0, 1, 2, 3].some(n => avg(i + Math.floor(n * sustain / 4), i + Math.floor((n + 1) * sustain / 4)) < plateau * 0.8)) continue;
      // Undo the smoothing's half-window timing bias using the raw local edge.
      let edgeIndex = i, edgeScore = -Infinity;
      for (let j = Math.max(edge, i - radius); j <= Math.min(values.length - edge, i + radius); j++) {
        const strength = mean(j, j + edge) - mean(j - edge, j);
        if (strength > edgeScore) { edgeScore = strength; edgeIndex = j; }
      }
      if (edgeIndex < quiet || edgeIndex + sustain > values.length) continue;
      const rawBefore = mean(edgeIndex - quiet, edgeIndex), rawAfter = mean(edgeIndex, edgeIndex + sustain);
      const variance = (a, b, avg) => Math.max(0, (squares[b] - squares[a]) / (b - a) - avg * avg);
      const afterVariance = variance(edgeIndex, edgeIndex + sustain, rawAfter);
      const noise = Math.sqrt(variance(edgeIndex - quiet, edgeIndex, rawBefore) + afterVariance);
      // A real section change exceeds the ordinary peak-to-peak variation of each
      // section. This rejects dynamic guitar/vocal peaks that resemble tiny drops.
      if (rawAfter < plateau * 0.93 || rawAfter - rawBefore < noise * 1.5 ||
          Math.sqrt(afterVariance) > plateau * 0.045) continue;
      const time = edgeIndex * step;
      const score = clamp((after - before) / Math.max(contrast * 3, 1e-9)) * 0.6 +
        clamp(jump / Math.max(contrast * 2, 1e-9)) * 0.4;
      const candidate = { time, uncertainty: Math.max(step * 2, 1), score: round(score, 1000) };
      const previous = result.dropCandidates.at(-1);
      if (previous && time - previous.time < 8) {
        if (score > previous.score) result.dropCandidates[result.dropCandidates.length - 1] = candidate;
      } else result.dropCandidates.push(candidate);
    }
    // Prefer the first substantial return in the usual first-drop region. Later drops
    // remain available if real audio rejects the first hint; titles never create drops.
    result.dropCandidates.sort((a, b) => {
      const region = c => c.time >= 20 && c.time <= 120 ? 0 : 1;
      return region(a) - region(b) || a.time - b.time || b.score - a.score;
    });
    result.dropCandidates = result.dropCandidates.slice(0, 8);
  }
  return result;
}

function idFor(trackId) {
  if (typeof trackId === 'number') return time(trackId) ? String(trackId) : null;
  return typeof trackId === 'string' && trackId.trim() && trackId.length <= 256 ? trackId : null;
}

// A remembered key is { tonic, mode, confidence, chroma }: the 12 pitch-class energies are kept so a later
// play can refine the key. Entries from before key detection have none.
function keyFor(value) {
  if (!value || !Number.isInteger(value.tonic) || value.tonic < 0 || value.tonic > 11 ||
      (value.mode !== 'major' && value.mode !== 'minor')) return null;
  const chroma = Array.isArray(value.chroma) && value.chroma.length === 12 && value.chroma.every(v => Number.isFinite(v) && v >= 0) ?
    value.chroma.map(v => round(v, 10000)) : null;
  return { tonic: value.tonic, mode: value.mode, confidence: Number.isFinite(value.confidence) ? round(clamp(value.confidence), 100) : 0, ...(chroma ? { chroma } : {}) };
}

// keys.js speaks { key: { tonic, mode }, confidence, chroma }: this converts a remembered key (or null) to that
export const keyEstimate = stored => stored && { key: { tonic: stored.tonic, mode: stored.mode }, confidence: stored.confidence, chroma: stored.chroma };

function entryFor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(Number.isFinite(value.plays) && value.plays >= 0)) return null;
  const grid = validGrid(value) ? value : null;
  const period = grid ? round(grid.period, 1e5) : null;
  const offset = grid ? round(mod(grid.offset, period), 1000) : null;
  return {
    bpm: grid ? round(60 / period, 1000) : null, period,
    offset: grid ? (offset >= period ? 0 : offset) : null,
    confidence: grid ? round(clamp(grid.confidence), 100) : 0,
    downbeat: grid && time(value.downbeat) ? value.downbeat : null,
    drop: time(value.drop?.time) && positive(value.drop?.confidence) ?
      { time: round(value.drop.time, 1000), confidence: round(clamp(value.drop.confidence), 100) } : null,
    drumsIn: time(value.drumsIn) ? round(value.drumsIn, 10) : null,
    outroStart: time(value.outroStart) ? round(value.outroStart, 10) : null,
    beatToEnd: value.beatToEnd === true,
    key: keyFor(value.key),
    // where the singing is in the first and last minute (vocals.js); entries from before it have none
    vocals: normalizeVocals(value.vocals),
    plays: positive(value.plays) ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value.plays)) : 0,
    updated: time(value.updated) ? value.updated : 0
  };
}

// The parsed store, reused while the stored text is unchanged (Mix order looks up many songs at once)
let cachedRaw = null;
let cachedEntries = null;

function read() {
  try {
    const raw = globalThis.localStorage.getItem(KEY);
    if (raw !== null && raw === cachedRaw && cachedEntries) return Object.assign(Object.create(null), cachedEntries);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
    const entries = Object.entries(parsed).filter(([id, entry]) => idFor(id) && entryFor(entry));
    entries.sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    cachedEntries = Object.assign(Object.create(null), Object.fromEntries(entries.slice(0, LIMIT)));
    cachedRaw = raw;
    return Object.assign(Object.create(null), cachedEntries);
  } catch { return Object.create(null); }
}

function save(entries) {
  try { globalThis.localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* Storage can be disabled or full. */ }
}

/** Return a compact remembered entry, or null. */
export function get(trackId, opts = {}) {
  const id = idFor(trackId);
  const entry = id === null ? null : entryFor(read()[id]);
  return entry && validGrid(entry) ? orientGrid(entry, opts) : entry;
}

/** Cache silent analysis without counting it as a play or inventing intro/outro cues. */
export function rememberDrop(trackId, confirmation) {
  const id = idFor(trackId);
  if (id === null || !validGrid(confirmation?.grid) || !time(confirmation?.drop?.time) ||
      !(confirmation.drop.confidence >= 0.65)) return null;
  const entries = read(), old = entryFor(entries[id]);
  const entry = entryFor({ ...old, ...confirmation.grid, drop: confirmation.drop,
    plays: old?.plays || 0, updated: Date.now() });
  entries[id] = { ...entries[id], ...entry };
  const ids = Object.keys(entries).sort((a, b) => entries[b].updated - entries[a].updated);
  for (const key of ids.slice(LIMIT)) delete entries[key];
  save(entries);
  return entry;
}

/** Merge one play into persistent memory, tolerating unavailable storage. */
export function learn(trackId, summary, opts = {}) {
  const id = idFor(trackId);
  if (id === null || !summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const entries = read(), previous = entryFor(entries[id]);
  const old = previous && validGrid(previous) ? orientGrid(previous, opts) : previous;
  const incoming = validGrid(summary.grid) ? orientGrid(summary.grid, opts) : null;
  let grid = old && validGrid(old) ? old : null;
  if (!grid) grid = incoming;
  else if (incoming) {
    const next = normalize(incoming, grid.period, grid.offset);
    if (next) {
      const a = Math.max(0.01, grid.confidence) * Math.max(1, old.plays);
      const b = Math.max(0.01, clamp(next.confidence));
      const period = (grid.period * a + next.period * b) / (a + b);
      grid = { period, offset: circular([{ ...grid, weight: a }, { ...next, weight: b }], period, grid.offset),
        confidence: (grid.confidence * a + clamp(next.confidence) * b) / (a + b) };
    } else {
      grid = { ...(incoming.confidence > grid.confidence ? incoming : grid) };
      grid.confidence = clamp(grid.confidence) * 0.9;
    }
  }
  const heard = time(summary.heardFrom) && time(summary.heardTo) ?
    Math.max(0, summary.heardTo - summary.heardFrom) : 0;
  // The private heard span lets a later, more complete play replace a boundary.
  const previousHeard = time(entries[id]?.heard) ? entries[id].heard : 0;
  const boundary = key => {
    const before = old?.[key], after = summary[key];
    if (!time(after)) return before ?? null;
    if (!time(before)) return after;
    if (Math.abs(after - before) <= 2) return (before * Math.max(1, old.plays) + after) / (Math.max(1, old.plays) + 1);
    return heard > previousHeard ? after : before;
  };
  // a full play that heard beats to the very end overrules an outro remembered before
  const outroStart = summary.beatToEnd === true && heard >= previousHeard ? null : boundary('outroStart');
  let beatToEnd = old?.beatToEnd ?? false;
  if (summary.beatToEnd === true && heard >= previousHeard) beatToEnd = true;
  if (time(summary.outroStart) && (!time(old?.outroStart) ||
      Math.abs(summary.outroStart - old.outroStart) <= 2 || heard > previousHeard)) beatToEnd = false;
  const drop = time(summary.drop?.time) && positive(summary.drop?.confidence) &&
    (!old?.drop || summary.drop.confidence >= old.drop.confidence) ? summary.drop : old?.drop;
  // summary.key is keys.js's estimate with its chroma; it refines what earlier plays found
  const merged = summary.key ? mergeKey(keyEstimate(old?.key), summary.key) : null;
  const key = merged ? { ...merged.key, confidence: merged.confidence, chroma: merged.chroma } : old?.key;
  // a play's vocal timeline refines what earlier plays heard (the old counts for the plays so far, capped)
  const vocals = summary.vocals ? mergeVocals(old?.vocals, summary.vocals, Math.min(3, Math.max(1, old?.plays || 0))) : old?.vocals;
  const entry = entryFor({ ...grid, downbeat: old?.downbeat ?? summary.grid?.downbeat, drop,
    drumsIn: boundary('drumsIn'), outroStart, beatToEnd, key, vocals,
    plays: (old?.plays || 0) + 1, updated: Date.now() });
  entries[id] = { ...entry, heard: round(Math.max(heard, previousHeard), 10) };
  const ids = Object.keys(entries).sort((a, b) => entries[b].updated - entries[a].updated);
  for (const key of ids.slice(LIMIT)) delete entries[key];
  save(entries);
  return entry;
}

/** Count remembered songs. */
export function count() { return Object.keys(read()).length; }

/** Forget all remembered songs. */
export function reset() { save(Object.create(null)); }
