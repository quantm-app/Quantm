import { compatibility, camelot } from './keys.js';

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const positive = value => Number.isFinite(value) && value > 0;
const series = values => Array.isArray(values) || (ArrayBuffer.isView(values) && typeof values.length === 'number');
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
const confidence = item => Number.isFinite(item?.bpmConfidence) ? clamp(item.bpmConfidence) : 0;
const bpmTag = /^(?:\d+(?:\.\d+)?\s*-?\s*bpm|bpm\s*:?\s*\d+(?:\.\d+)?)$/i;

function textTempo(text) {
  if (typeof text !== 'string') return null;
  const match = /(?<![\w.+-])(?:(\d{2,3}(?:\.\d+)?)\s*-?\s*bpm\b|bpm\s*:?\s*(\d{2,3}(?:\.\d+)?)\b)/i.exec(text);
  const bpm = match ? Number(match[1] || match[2]) : 0;
  return bpm >= 60 && bpm <= 220 ? bpm : null;
}

function parseTags(text) {
  const tags = Array.from((typeof text === 'string' ? text : '').matchAll(/"([^"]*)"|(\S+)/g),
    match => normalize(match[1] ?? match[2])).filter(Boolean);
  return [...new Set(tags.filter((tag, i) => !bpmTag.test(tag) &&
    !bpmTag.test(`${tag} ${tags[i + 1] || ''}`) && !bpmTag.test(`${tags[i - 1] || ''} ${tag}`)))];
}

/** Read explicit BPM metadata, preferring the field, title, tags, then description. */
export function tempoFromText(track) {
  if (Number.isFinite(track?.bpm) && track.bpm >= 40 && track.bpm <= 250) {
    return { bpm: track.bpm, source: 'soundcloud' };
  }
  for (const [key, source] of [['title', 'title'], ['tag_list', 'tags'], ['description', 'description']]) {
    const bpm = textTempo(track?.[key]);
    if (bpm !== null) return { bpm, source };
  }
  return null;
}

/** Estimate a rough tempo from positive envelope changes and repeated beat intervals. */
export function tempoFromWaveform(samples, durationSec) {
  if (!series(samples) || samples.length < 32 || samples.length > 1000000 ||
      !positive(durationSec) || durationSec < 8 || samples.some(value => !Number.isFinite(value))) return null;
  const rate = samples.length / durationSec;
  if (rate < 4 || rate > 1000) return null;
  const flux = Float64Array.from(samples, (value, i) => i ? Math.max(0, value - samples[i - 1]) : 0);
  const mean = flux.reduce((sum, value) => sum + value, 0) / flux.length;
  const squares = new Float64Array(flux.length + 1);
  for (let i = 0; i < flux.length; i++) {
    flux[i] -= mean;
    squares[i + 1] = squares[i] + flux[i] ** 2;
  }
  if (squares[flux.length] < 1e-12) return null;
  const maxLag = Math.min(Math.ceil(rate * 16), Math.floor(flux.length / 3));
  const correlations = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < flux.length - lag; i++) sum += flux[i] * flux[i + lag];
    const scale = Math.sqrt(squares[flux.length - lag] * (squares[flux.length] - squares[lag]));
    correlations[lag] = scale ? sum / scale : 0;
  }
  let best = null;
  for (let bpm = 60; bpm <= 200; bpm += 0.25) {
    const period = rate * 60 / bpm;
    let sum = 0, count = 0;
    for (let beat = 1; beat <= 16 && period * beat < maxLag; beat++) {
      const lag = period * beat, i = Math.floor(lag), fraction = lag - i;
      sum += correlations[i] * (1 - fraction) + correlations[i + 1] * fraction;
      count++;
    }
    const strength = count >= 4 ? sum / count : 0;
    const score = strength * (bpm >= 85 && bpm <= 175 ? 1 : 0.94);
    if (!best || score > best.score) best = { bpm, strength, score };
  }
  const certainty = clamp(best.strength);
  return certainty >= 0.2 ? { bpm: best.bpm, confidence: certainty } : null;
}

/** Summarize the loud section and the first and last eight percent of an envelope. */
export function energyShape(samples) {
  if (!series(samples) || !samples.length || samples.some(value => !Number.isFinite(value))) return null;
  const values = Array.from(samples, value => clamp(value));
  const edge = Math.max(1, Math.ceil(values.length * 0.08));
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const loud = values.slice().sort((a, b) => a - b).slice(Math.floor(values.length / 2));
  const middle = Math.floor(loud.length / 2);
  const overall = loud.length % 2 ? loud[middle] : (loud[middle - 1] + loud[middle]) / 2;
  return { overall, intro: mean(values.slice(0, edge)), outro: mean(values.slice(-edge)) };
}

/** Build queue features; waveform is the normalized sample array and duration comes from the track. */
export function features(track, { memory = null, waveform = null } = {}) {
  let bpm = null, bpmSource = null, bpmConfidence = 0;
  if (positive(memory?.bpm) && memory.bpm >= 40 && memory.bpm <= 250) {
    bpm = memory.bpm;
    bpmSource = 'memory';
    bpmConfidence = Number.isFinite(memory.confidence) ? clamp(memory.confidence, 0.6, 1) : 0.6;
  } else {
    const text = tempoFromText(track);
    const estimate = text ? null : tempoFromWaveform(waveform, track?.duration / 1000);
    if (text || estimate) {
      bpm = (text || estimate).bpm;
      bpmSource = text ? text.source : 'waveform';
      bpmConfidence = text ? 0.7 : estimate.confidence * 0.6;
    }
  }
  const result = { id: track?.id, bpm, bpmSource, bpmConfidence, genre: normalize(track?.genre),
    tags: parseTags(track?.tag_list), energy: energyShape(waveform) };
  // where the beat starts and stops, once the song has been heard (mixmemory.js): what a blend has to work with
  const structure = memory && (Number.isFinite(memory.drumsIn) || memory.beatToEnd === true || Number.isFinite(memory.outroStart) || memory.drop)
    ? { drumsIn: Number.isFinite(memory.drumsIn) ? memory.drumsIn : null, beatToEnd: memory.beatToEnd === true,
        outroStart: Number.isFinite(memory.outroStart) ? memory.outroStart : null, drop: !!memory.drop,
        duration: positive(track?.duration) ? track.duration / 1000 : null }
    : null;
  if (structure) result.structure = structure;
  // the song's musical key, once it has been heard (keys.js): { tonic, mode, confidence }
  const key = memory?.key;
  if (Number.isInteger(key?.tonic) && key.tonic >= 0 && key.tonic < 12 && (key.mode === 'major' || key.mode === 'minor')) {
    result.key = { tonic: key.tonic, mode: key.mode, confidence: Number.isFinite(key.confidence) ? clamp(key.confidence) : 0 };
  }
  return result;
}

const KEY_MIN_CONFIDENCE = 0.15;  // below this a key reading is a guess: it neither helps nor hurts
const KEY_SURE = 0.35;            // both songs at least this sure: a clash is worth hiding in the mix

/**
 * How two songs' keys relate, from their features: { relation, score, clash, sure, confidence, from, to }.
 * relation is keys.js's 'same' | 'relative' | 'neighbor' | 'energy-boost' | 'clash', or 'unknown' when either
 * key is missing or too uncertain. `clash` only says the keys clash; `sure` says both readings are firm
 * enough to act on (shorter blend, drop cut).
 */
const relationCache = new Map(); // 24 x 24 possible pairs: Mix order asks for them thousands of times
const slot = key => key.tonic + (key.mode === 'minor' ? 12 : 0);
export function keyRelation(a, b) {
  const known = key => key && (key.confidence ?? 1) >= KEY_MIN_CONFIDENCE;
  if (!known(a?.key) || !known(b?.key)) return { relation: 'unknown', score: 0, clash: false, sure: false, confidence: 0, from: null, to: null };
  const id = slot(a.key) * 24 + slot(b.key);
  let found = relationCache.get(id);
  if (!found) relationCache.set(id, found = compatibility(a.key, b.key));
  const { relation, score } = found;
  const confidence = Math.min(a.key.confidence ?? 1, b.key.confidence ?? 1);
  return { relation, score, clash: relation === 'clash', sure: confidence >= KEY_SURE, confidence,
    from: camelot(a.key), to: camelot(b.key) };
}

const word = source => new RegExp(`(?<![a-z0-9])(?:${source})(?![a-z0-9])`);
const FAMILY_TERMS = {
  bass: word("dubstep|riddim|brostep|drum ?(?:&|and|n|'n') ?bass|d(?:&|'n')b|dnb|jungle|breakbeats?|breaks|neurofunk|liquid funk|glitch hop|bass"),
  hiphop: word('hip ?-?hop|rap|trap|drill|boom ?bap|grime|phonk|cloud rap'),
  dance: word('house|techno|trance|psytrance|deephouse|techhouse|hardtechno|hardstyle|4x4|four on the floor|uk garage|speed garage|ukg|2-?step|disco')
};
const DANCE_GENERIC = word('edm|electro(?:nic|house)?|electronica|dance|club|rave');
const OTHER_TERMS = word("pop|rock|indie|folk|jazz|country|r&b|rnb|soul|blues|metal|punk|classical|ambient|acoustic|singer ?-?songwriter|reggae|dancehall|latin|k-?pop|gospel|funk|alternative|piano|lo-?fi");
// Song titles are chatty ("Bass Down Low", "House of Cards"): only the unmistakable terms count there.
const TITLE_TERMS = {
  bass: word("dubstep|riddim|drum ?(?:&|and|n|'n') ?bass|dnb"),
  hiphop: word('hip ?-?hop|trap|boom ?bap'),
  dance: word('techno|trance|house music|deep house|tech house|progressive house|4x4')
};
const FAMILY_ORDER = ['bass', 'hiphop', 'dance'];
const familyOf = (text, terms) => FAMILY_ORDER.find(family => terms[family].test(text)) || null;

/**
 * Coarse genre family for a track or its features: 'bass' (dubstep, riddim, drum and bass, jungle, breaks),
 * 'hiphop' (hip-hop, rap, trap), 'dance' (house, techno, trance, 4x4, general electronic), 'other' (pop,
 * rock and the like) or 'unknown' (nothing to go on). Reads the genre, then the tags, then the title
 * (clear terms only); a specific style anywhere beats the general "electronic" or "dance".
 */
export function genreFamily(source) {
  const genre = normalize(source?.genre);
  const tags = Array.isArray(source?.tags) ? source.tags.map(normalize) : parseTags(source?.tag_list);
  const texts = [genre, ...tags].filter(Boolean);
  for (const text of texts) {
    const family = familyOf(text, FAMILY_TERMS);
    if (family) return family;
  }
  if (texts.some(text => DANCE_GENERIC.test(text))) return 'dance';
  if (texts.some(text => OTHER_TERMS.test(text))) return 'other';
  const title = familyOf(normalize(source?.title), TITLE_TERMS);
  if (title) return title;
  return genre ? 'other' : 'unknown';
}

/** Return the closest playback ratio even when no half/double-time option fits. */
export function tempoFit(bpmA, bpmB, maxStretch = 0.08) {
  if (!positive(bpmA) || !positive(bpmB)) return null;
  let ratio = bpmA / bpmB;
  for (const factor of [2, 0.5]) {
    const candidate = bpmA / (bpmB * factor);
    if (Math.abs(candidate - 1) < Math.abs(ratio - 1)) ratio = candidate;
  }
  const stretch = Math.abs(ratio - 1);
  return { ratio, stretch, ok: stretch <= maxStretch + 1e-12 };
}

const halfTime = (a, b, fit) => fit && Math.abs(fit.ratio - a.bpm / b.bpm) > 1e-9;
const tempoLabel = (a, b) => `${Math.round(a.bpm)} → ${Math.round(b.bpm)} BPM`;

/**
 * Score how good the transition from a into b should sound (lower is better): how cleanly the beats match,
 * what each song gives a blend to work with (a beat to the end, drums from the start), and how your
 * transitions actually went (thumbs and kept songs, mixpairs.js history). Energy is not compared: a quiet
 * song after a loud one is fine when the mix itself sounds good.
 */
export function blendCost(a, b, { maxStretch = 0.08, history = null } = {}) {
  const fit = tempoFit(a.bpm, b.bpm, maxStretch);
  const reasons = [];
  let cost = 0.4;
  // Tempo: 4 per relative stretch; excess adds 60 per unit plus a 0..3 ramp over 4%.
  // Unknown: 1.25..2.5 by confidence. An octave change adds 0.65.
  if (fit) {
    const excess = Math.max(0, fit.stretch - maxStretch);
    cost += 4 * fit.stretch + 60 * excess + 3 * clamp(excess / 0.04);
    reasons.push(fit.ok ? (fit.stretch < 0.005 ? 'same tempo' : tempoLabel(a, b)) : 'big tempo jump');
    if (halfTime(a, b, fit)) { cost += 0.65; reasons.push('half time'); }
  } else {
    cost += 1.25 * (1 + Math.max(confidence(a), confidence(b)));
    reasons.push('tempo unknown');
  }
  // Genre and tags subtract 0.25 and 0.15: the same sound blends more naturally.
  if (a.genre && a.genre === b.genre) { cost -= 0.25; reasons.push('same genre'); }
  if (a.tags?.some(tag => b.tags?.includes(tag))) { cost -= 0.15; reasons.push('shares tags'); }
  // Harmonic mixing: keys that agree (same, relative, a step round the wheel) blend cleanly; two steps is a
  // lift that still works; a clash is audible while both melodies play. Costs stay below tempo's: a
  // big tempo jump costs several points, a clash 0.3 (the stretch of a 7.5% tempo change). Unknown keys change nothing.
  const harmony = keyRelation(a, b);
  if (harmony.relation !== 'unknown') {
    // a shaky reading counts for less
    const weight = clamp(harmony.confidence / KEY_SURE);
    if (harmony.score >= 0.85) {
      cost -= (harmony.relation === 'same' ? 0.25 : 0.2) * weight;
      reasons.push('keys match');
    } else if (harmony.relation === 'energy-boost') {
      cost += 0.08 * weight;
      reasons.push('key lift');
    } else {
      cost += 0.3 * weight;
      reasons.push('key clash');
    }
  }
  // The songs' own structure, known once each has been heard. A beat that runs to the end of a and drums at
  // the very start of b give a long blend clean drums on both sides; a long beatless outro or intro doesn't.
  const sa = a.structure, sb = b.structure;
  if (sa?.beatToEnd) { cost -= 0.2; reasons.push('beat to the end'); }
  else if (sa && Number.isFinite(sa.outroStart) && positive(sa.duration) && sa.duration - sa.outroStart > 20) { cost += 0.15; reasons.push('long quiet outro'); }
  if (sb && Number.isFinite(sb.drumsIn)) {
    if (sb.drumsIn <= 1) { cost -= 0.2; reasons.push('drums from the start'); }
    else if (sb.drumsIn > 30) { cost += 0.2; reasons.push('slow intro'); }
  }
  if (sb?.drop) cost -= 0.05;
  // How your transitions went: this exact pair weighs most, then each song's record, then the two genres.
  // Ratios are smoothed so one rating nudges and a habit decides.
  if (history) {
    const lean = (entry, prior) => entry ? (entry.bad - entry.good) / (entry.good + entry.bad + prior) : 0;
    const pair = history.pair?.(a.id, b.id);
    if (pair && pair.good + pair.bad) {
      cost += 1.2 * lean(pair, 1);
      reasons.push(pair.good >= pair.bad ? 'you liked this mix' : 'this mix went badly before');
    }
    const songs = lean(history.track?.(a.id), 2) + lean(history.track?.(b.id), 2);
    cost += 0.3 * songs;
    if (songs < -0.5) reasons.push('both mix well');
    const fa = a.family || genreFamily(a), fb = b.family || genreFamily(b);
    if (fa !== 'unknown' && fb !== 'unknown') cost += 0.4 * lean(history.family?.(fa, fb), 4);
  }
  // not floored at 0: a pair you liked must still rank above one that's merely clean
  return { cost, reasons, fit };
}

// Circular octave buckets put half/double time neighbors beside ordinary tempo neighbors.
function tempoBucket(bpm) {
  return positive(bpm) ? Math.floor(((Math.log2(bpm / 85) % 1 + 1) % 1) * 64) : -1;
}

function candidateIndex(items) {
  const remaining = new Set(items.map((_, i) => i));
  const buckets = Array.from({ length: 64 }, () => new Set());
  const genres = new Map(), tags = new Map(), unknown = new Set();
  const memberships = items.map((item, i) => {
    const bucket = tempoBucket(item.bpm);
    const groups = [bucket < 0 ? unknown : buckets[bucket]];
    for (const [map, keys] of [[genres, item.genre ? [item.genre] : []], [tags, item.tags || []]]) {
      for (const key of keys) {
        if (!map.has(key)) map.set(key, new Set());
        groups.push(map.get(key));
      }
    }
    for (const group of groups) group.add(i);
    return groups;
  });
  return {
    remove(i) { remaining.delete(i); for (const group of memberships[i]) group.delete(i); },
    candidates(item, exclude = -1) {
      if (remaining.size <= 40) return [...remaining].filter(i => i !== exclude);
      const pool = new Set();
      const take = (group, count) => {
        if (!group) return;
        let added = 0;
        for (const i of group) {
          if (i === exclude) continue;
          pool.add(i);
          if (++added >= count) break;
        }
      };
      const bucket = tempoBucket(item.bpm);
      if (bucket >= 0) {
        for (let distance = 0; distance <= 32 && pool.size < 18; distance++) {
          take(buckets[(bucket + distance) % 64], 3);
          if (distance) take(buckets[(bucket - distance + 64) % 64], 3);
        }
      }
      take(genres.get(item.genre), 4);
      for (const tag of (item.tags || []).slice(0, 3)) take(tags.get(tag), 2);
      take(unknown, 4);
      take(remaining, 4);
      return [...pool];
    }
  };
}

function stepScore(a, b, direction, maxStretch, drift, history) {
  const { cost, fit } = blendCost(a, b, { maxStretch, history });
  const delta = fit ? 1 / fit.ratio - 1 : 0;
  const nextDirection = Math.abs(delta) > 0.001 ? Math.sign(delta) : direction;
  return { score: cost + 14 * Math.max(0, Math.abs(delta) - drift) +
    (direction && nextDirection !== direction ? 0.22 : 0), direction: nextDirection };
}

function chooseNear(scored, random) {
  const top = scored.slice(0, 3).filter(item => item.score - scored[0].score < 0.6);
  const weights = top.map(item => Math.exp(-(item.score - top[0].score) / 0.12));
  let draw = clamp(random(), 0, 1 - Number.EPSILON) * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < top.length; i++) {
    draw -= weights[i];
    if (draw < 0) return top[i];
  }
  return top[0];
}

/** Order indices from the playing track with bounded candidates and a three-wide lookahead. */
export function orderForMixing(items, { start = 0, random = Math.random, maxStretch = 0.08, drift = 0.02, history = null } = {}) {
  if (!items.length) return [];
  start = Number.isInteger(start) && start >= 0 && start < items.length ? start : 0;
  const index = candidateIndex(items), order = [start];
  let current = start, direction = 0;
  index.remove(start);
  while (order.length < items.length) {
    const scored = index.candidates(items[current]).map(i => ({ i,
      ...stepScore(items[current], items[i], direction, maxStretch, drift, history) }));
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    const beam = scored.slice(0, 3);
    for (const candidate of beam) {
      let after = Infinity;
      for (const i of index.candidates(items[candidate.i], candidate.i)) {
        after = Math.min(after, stepScore(items[candidate.i], items[i], candidate.direction, maxStretch, drift, history).score);
      }
      if (Number.isFinite(after)) candidate.score += 0.35 * after;
    }
    beam.sort((a, b) => a.score - b.score || a.i - b.i);
    const chosen = chooseNear(beam, random);
    current = chosen.i;
    direction = chosen.direction;
    index.remove(current);
    order.push(current);
  }
  return order;
}

/** Rank autoplay candidates by how good the transition should sound, gently randomizing scores within 0.04 of one another. */
export function pickNext(current, candidates, { random = Math.random, maxStretch = 0.08, count = 1, history = null } = {}) {
  const ranked = candidates.map((item, i) => ({ i,
    score: blendCost(current, item, { maxStretch, history }).cost + clamp(random()) * 0.04 }));
  ranked.sort((a, b) => a.score - b.score || a.i - b.i);
  return ranked.slice(0, Math.max(0, Math.floor(count))).map(item => item.i);
}

/** Describe tempo compatibility for a compact queue label. */
export function describeBlend(a, b, { maxStretch = 0.08 } = {}) {
  const fit = tempoFit(a.bpm, b.bpm, maxStretch);
  if (!fit) return { ok: true, text: 'tempo unknown' };
  if (!fit.ok) return { ok: false, text: 'big tempo jump' };
  return { ok: true, text: tempoLabel(a, b) + (halfTime(a, b, fit) ? ' (half time)' : '') };
}
