// Auto mix's vocal sense: two singers at once is the most obvious sign of a bad automatic mix.
// While a song plays, the beat watcher hands the deck's spectrum (the same analyser key detection reads)
// to a VocalMeter, which turns it into a conservative 0..1 "someone is singing" score. A VocalTimeline
// keeps that score as a coarse picture of the first and last minute of the song (one value per 2 s), the
// part a blend cares about. mixmemory.js stores it compactly, and planVocalClash() uses it to keep the
// outgoing and incoming singers from overlapping.
//
// The score needs three things at once (any one missing and it stays near zero):
//   - a voice-sized share of the energy: 300 Hz to 3.5 kHz against the whole signal (60 Hz to 12 kHz)
//   - peaky, harmonic content in that band (singing is tonal; drums, hats and noise are flat)
//   - syllable-rate movement: sung and rapped lines make the band's level swing several times a second,
//     while pads, held synths and strings stay put
// It is a guess, not a recording studio: it favours missing a vocal over inventing one.

const SLOT = 2;                 // seconds per timeline slot
const WINDOW = 60;              // seconds kept at each end of the song
const INTRO_SLOTS = WINDOW / SLOT;
const OUTRO_SLOTS = WINDOW / SLOT + 2;
const SAMPLE_EVERY = 0.06;      // media seconds between spectra (about 16 a second: enough to see syllables)
const RING = 20;                // frames of band history the movement is measured over (about 1.2 s)
const WARMUP = 8;               // frames needed before a score is trusted
const MIN_FRAMES = 8;           // frames a slot needs before it counts as heard (about half a second)
export const VOCAL_LEVEL = 4;   // a slot at this level (0..9) or more has singing in it
const STRONG_LEVEL = 7;         // a single slot this strong is a phrase on its own
const CLEAN_LEVEL = 3;          // at or under this a slot is safe to loop: no vocals
const SILENCE_DB = -85;         // mean bin level under this is silence

const clamp = (x) => Math.min(1, Math.max(0, x));
const LO_HZ = 60, MID_LO_HZ = 300, MID_HI_HZ = 3500, HI_HZ = 12000;

/** Turns spectra into a vocal score. Reuses its buffers: nothing is allocated per frame. */
export class VocalMeter {
  constructor() {
    this.levels = new Float32Array(RING); // the band's level in dB, newest at head
    this.times = new Float64Array(RING);
    this.count = 0;
    this.head = 0;
    this.cfg = null;
    this.score = 0;
  }

  reset() { this.count = 0; this.head = 0; this.score = 0; }

  /** Whether enough history has built up for add() to mean something */
  get ready() { return this.count >= WARMUP; }

  /** Take one spectrum ({ db, sampleRate, fftSize }) heard at media time t; returns the smoothed score (0..1) */
  add(spectrum, t) {
    const db = spectrum?.db;
    if (!db || !(spectrum.fftSize > 0) || !(spectrum.sampleRate > 0)) return 0;
    let cfg = this.cfg;
    if (!cfg || cfg.rate !== spectrum.sampleRate || cfg.size !== spectrum.fftSize) {
      const hz = spectrum.sampleRate / spectrum.fftSize;
      cfg = this.cfg = { rate: spectrum.sampleRate, size: spectrum.fftSize, lo: Math.max(1, Math.round(LO_HZ / hz)),
        midLo: Math.round(MID_LO_HZ / hz), midHi: Math.round(MID_HI_HZ / hz),
        hi: Math.min(db.length - 1, Math.round(HI_HZ / hz)) };
    }
    let mid = 0, total = 0, logMid = 0, n = 0, bins = 0;
    // every other bin is plenty for band energies and flatness
    for (let i = cfg.lo; i <= cfg.hi; i += 2) {
      const level = db[i] > -120 ? db[i] : -120; // the analyser reports -Infinity for digital silence
      const power = Math.pow(10, level / 10);
      total += power;
      bins++;
      if (i >= cfg.midLo && i <= cfg.midHi) { mid += power; logMid += level; n++; }
    }
    if (!bins || !n || 10 * Math.log10(total / bins) < SILENCE_DB) { this.reset(); return 0; }
    // a gap in the readings (a seek, a stall) is not movement
    if (this.count && t - this.times[this.head] > 0.4) this.reset();
    const level = 10 * Math.log10(Math.max(mid, 1e-30) / n);
    this.head = (this.head + 1) % RING;
    this.levels[this.head] = level;
    this.times[this.head] = t;
    if (this.count < RING) this.count++;
    if (this.count < WARMUP) return 0;

    const linearShare = mid / total;
    const flatness = Math.pow(10, logMid / n / 10) / (mid / n); // geometric over arithmetic mean power: 1 = noise, near 0 = peaky
    // how fast the band's level swings, in dB per second, over the frames kept
    let travelled = 0, elapsed = 0;
    for (let k = 1; k < this.count; k++) {
      const newer = (this.head - k + 1 + RING) % RING, older = (newer - 1 + RING) % RING;
      const dt = this.times[newer] - this.times[older];
      if (dt <= 0 || dt > 0.4) continue;
      travelled += Math.abs(this.levels[newer] - this.levels[older]);
      elapsed += dt;
    }
    const movement = elapsed > 0 ? travelled / elapsed : 0;
    const raw = Math.cbrt(clamp((linearShare - 0.3) / 0.35) * clamp((0.45 - flatness) / 0.35) * clamp((movement - 8) / 22));
    this.score = this.score * 0.6 + raw * 0.4;
    return this.score;
  }
}

/**
 * The vocal score of the first and last minute of one song, a value per 2 s. `duration` places the last
 * minute; without it only the intro is kept.
 */
export class VocalTimeline {
  constructor({ duration = 0 } = {}) {
    this.duration = duration > 0 ? duration : 0;
    this.outroFrom = this.duration > 0 ? Math.floor(Math.max(0, this.duration - WINDOW) / SLOT) * SLOT : null;
    this.sums = { intro: new Float32Array(INTRO_SLOTS), outro: new Float32Array(OUTRO_SLOTS) };
    this.counts = { intro: new Uint16Array(INTRO_SLOTS), outro: new Uint16Array(OUTRO_SLOTS) };
    this.frames = 0;
  }

  /** The length became known after the timeline was made (the media's own duration arrives late) */
  setDuration(duration) {
    if (this.duration > 0 || !(duration > 0)) return;
    this.duration = duration;
    this.outroFrom = Math.floor(Math.max(0, duration - WINDOW) / SLOT) * SLOT;
  }

  /** Whether time t falls in a stretch worth recording */
  wants(t) {
    return t >= 0 && (t < WINDOW || (this.outroFrom != null && t >= this.outroFrom));
  }

  add(t, score) {
    if (!(t >= 0) || !Number.isFinite(score)) return;
    if (t < WINDOW) this.put('intro', Math.floor(t / SLOT), score);
    if (this.outroFrom != null && t >= this.outroFrom) this.put('outro', Math.floor((t - this.outroFrom) / SLOT), score);
  }

  put(part, slot, score) {
    if (slot < 0 || slot >= this.sums[part].length) return;
    this.sums[part][slot] += score;
    this.counts[part][slot]++;
    this.frames++;
  }

  /** What was heard, in the form mixmemory stores (see normalizeVocals), or null when nothing was */
  summary() {
    if (!this.frames) return null;
    const text = (part) => Array.from(this.sums[part], (sum, i) => {
      const n = this.counts[part][i];
      return n >= MIN_FRAMES ? String(Math.round(Math.min(1, sum / n) * 9)) : '-';
    }).join('');
    const intro = text('intro'), outro = this.outroFrom != null ? text('outro') : '-'.repeat(OUTRO_SLOTS);
    return normalizeVocals({ intro, outro, outroFrom: this.outroFrom ?? 0 });
  }
}

/**
 * Reads the deck's spectrum on the beat watcher's poll, scores it, and files the score where it belongs.
 * Like the key listener it samples nothing while paused, seeking or muted.
 */
export class VocalRecorder {
  constructor({ duration = 0 } = {}) {
    this.meter = new VocalMeter();
    this.timeline = new VocalTimeline({ duration });
    this.last = -Infinity;
  }

  /** The length became known (call with the media element's duration) */
  setDuration(duration) { this.timeline.setDuration(duration); }

  /** Take one spectrum from `norm.spectrum(audio)` if it is time; returns whether one was taken */
  sample(audio, norm) {
    if (audio.paused || audio.seeking || audio.muted || typeof norm.spectrum !== 'function') return false;
    const t = audio.currentTime;
    if (t < this.last) { this.last = -Infinity; this.meter.reset(); } // a seek back
    if (t - this.last < SAMPLE_EVERY) return false;
    if (!this.timeline.wants(t)) return false;
    const spectrum = norm.spectrum(audio);
    if (!spectrum) return false;
    if (t - this.last > 0.4) this.meter.reset();
    this.last = t;
    const score = this.meter.add(spectrum, t);
    if (this.meter.ready) this.timeline.add(t, score);
    return true;
  }

  summary() { return this.timeline.summary(); }
}

// ---- the stored form: { intro, outro, outroFrom, start, end } ------------------------------------------------

const SLOT_TEXT = /^[0-9-]*$/;
const parse = (text) => Array.from(text, ch => ch === '-' ? -1 : ch.charCodeAt(0) - 48);

/** Is slot i the start of, or inside, a stretch of singing (a loud slot, or one with a vocal slot beside it)? */
const phraseAt = (levels, i) => levels[i] >= VOCAL_LEVEL &&
  (levels[i] >= STRONG_LEVEL || levels[i - 1] >= VOCAL_LEVEL || levels[i + 1] >= VOCAL_LEVEL ||
    levels[i - 2] >= VOCAL_LEVEL || levels[i + 2] >= VOCAL_LEVEL);

/** The first phrase's start time at or after `from` in one part of the song, or null. */
function firstPhrase(levels, origin, from) {
  for (let i = Math.max(0, Math.floor((from - origin) / SLOT)); i < levels.length; i++) {
    if (phraseAt(levels, i)) return Math.max(from, origin + i * SLOT);
  }
  return null;
}

function lastPhrase(levels, origin) {
  for (let i = levels.length - 1; i >= 0; i--) if (phraseAt(levels, i)) return origin + (i + 1) * SLOT;
  return null;
}

/** Validate and complete a stored vocal summary (junk becomes null); `start` and `end` are always recomputed from the slots */
export function normalizeVocals(value) {
  if (!value || typeof value !== 'object') return null;
  const intro = typeof value.intro === 'string' && value.intro.length <= INTRO_SLOTS && SLOT_TEXT.test(value.intro) ? value.intro : null;
  const outro = typeof value.outro === 'string' && value.outro.length <= OUTRO_SLOTS && SLOT_TEXT.test(value.outro) ? value.outro : null;
  if (!intro && !outro) return null;
  const outroFrom = Number.isFinite(value.outroFrom) && value.outroFrom >= 0 && value.outroFrom < 86400 ? Math.round(value.outroFrom / SLOT) * SLOT : 0;
  const pad = (text, size) => (text || '').padEnd(size, '-');
  const result = { intro: pad(intro, INTRO_SLOTS), outro: pad(outro, OUTRO_SLOTS), outroFrom };
  if (!/[0-9]/.test(result.intro + result.outro)) return null;
  const outroLevels = parse(result.outro);
  result.start = firstPhrase(parse(result.intro), 0, 0);
  result.end = /[0-9]/.test(result.outro) ? lastPhrase(outroLevels, outroFrom) : null;
  return result;
}

/**
 * Fold what one more play heard into what was remembered. A slot heard in both is averaged (`weight`
 * plays' worth of the old); a slot heard in one is kept. The last minute is only merged when both sit
 * at the same place in the song (a different copy of the song starts it elsewhere).
 */
export function mergeVocals(old, add, weight = 1) {
  const a = normalizeVocals(old), b = normalizeVocals(add);
  if (!a || !b) return b || a;
  const mix = (x, y) => {
    let out = '';
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const p = x[i] ?? '-', q = y[i] ?? '-';
      out += p === '-' ? q : q === '-' ? p : String(Math.round((Number(p) * weight + Number(q)) / (weight + 1)));
    }
    return out;
  };
  const sameOutro = a.outroFrom === b.outroFrom;
  const outroNew = /[0-9]/.test(b.outro);
  return normalizeVocals({ intro: mix(a.intro, b.intro),
    outro: sameOutro ? mix(a.outro, b.outro) : outroNew ? b.outro : a.outro,
    outroFrom: sameOutro || outroNew ? b.outroFrom : a.outroFrom });
}

/** Read access to a stored summary: levels (0..9, -1 unknown) by song time */
export class VocalMap {
  constructor(vocals) {
    const v = normalizeVocals(vocals);
    this.valid = !!v;
    this.intro = v ? parse(v.intro) : [];
    this.outro = v ? parse(v.outro) : [];
    this.outroFrom = v ? v.outroFrom : 0;
  }

  /** The level (0..9) at song time t, or -1 when that moment was never heard. The last minute wins where the two overlap. */
  levelAt(t) {
    if (!this.valid || !(t >= 0)) return -1;
    const o = Math.floor((t - this.outroFrom) / SLOT);
    if (t >= this.outroFrom && o < this.outro.length && this.outro[o] >= 0) return this.outro[o];
    const i = Math.floor(t / SLOT);
    return i < this.intro.length ? this.intro[i] : -1;
  }

  /** Where the last phrase in the last minute ends, and how far the last minute was heard (its last heard slot's end); end is null without vocals there */
  outroEnd() {
    if (!this.valid) return { end: null, heardTo: null };
    let heardTo = null;
    for (let i = this.outro.length - 1; i >= 0; i--) if (this.outro[i] >= 0) { heardTo = this.outroFrom + (i + 1) * SLOT; break; }
    return { end: heardTo == null ? null : lastPhrase(this.outro, this.outroFrom), heardTo };
  }

  /**
   * When the first phrase at or after song time `from` starts, looking through the first `through` seconds
   * of the first minute: a number, or null when there is none before the first stretch that was never heard
   * (nothing is claimed about what was not heard).
   */
  introStart(from = 0, through = 40) {
    if (!this.valid) return null;
    const last = Math.min(this.intro.length, Math.ceil((from + through) / SLOT));
    for (let i = Math.max(0, Math.floor(from / SLOT)); i < last; i++) {
      if (this.intro[i] < 0) return null;
      if (phraseAt(this.intro, i)) return Math.max(from, i * SLOT);
    }
    return null;
  }

  /** Whether song times [from, to] are all heard and without singing (safe to loop) */
  clean(from, to) {
    if (!this.valid) return false;
    for (let t = from; t < to + SLOT / 2; t += SLOT / 2) {
      const level = this.levelAt(Math.min(t, to));
      if (level < 0 || level > CLEAN_LEVEL) return false;
    }
    return true;
  }
}

// ---- planning ---------------------------------------------------------------------------------------------

export const VOCAL_OVERLAP_OK = 3;   // seconds both may sing before the blend is moved
export const VOCAL_GAP = 2;          // seconds of overlap still tolerated after a shift (a breath, an ad-lib)
export const VOCAL_HOLD_DB = -12;    // how far the incoming mids are held down when the timing cannot move
const MIN_BARS = 8;
const MIN_SECONDS = 8;
const MAX_HOLD = 0.9;

/**
 * Keep two singers from overlapping in a planned blend. Everything in media seconds.
 *   at, span     the planned blend (`at`: outgoing time it starts; `span` its length)
 *   outEnd       when the outgoing song's last vocal phrase ends (null: none or unknown: nothing happens)
 *   inOnset      seconds from the incoming song's start point to its first vocal phrase (null: none or unknown)
 *   dur, rate    the outgoing song's length and playback rate
 *   grid, phrase the beat grid (for bar lines) and phraseMix's result when the blend is on the phrase grid: { bars }
 * Returns null when nothing is needed; otherwise either
 *   { at, span, bars, shift }       start the blend later on a bar (phrase) line, so the outgoing vocals are over
 *                                   before the incoming ones begin (at least 8 bars / 8 s remain), or
 *   { hold: { until, depth } }      keep the timing and hold the incoming mids down (dB `depth`) until `until`
 *                                   (0..1 of the blend), when moving the blend would leave too short a one.
 */
export function planVocalClash({ at, span, bars = 0, grid = null, phrase = false, dur, rate = 1, outEnd, inOnset }) {
  if (![at, span, dur, outEnd, inOnset].every(Number.isFinite) || !(span > 0) || !(rate > 0)) return null;
  const overlap = Math.min(outEnd, at + span) - (at + inOnset);
  if (overlap <= VOCAL_OVERLAP_OK * rate) return null;
  const minAt = outEnd - inOnset - VOCAL_GAP * rate;
  const hold = () => ({ hold: { until: Math.min(MAX_HOLD, Math.max(0.3, (Math.min(outEnd, at + span) - at) / span)), depth: VOCAL_HOLD_DB } });
  // singing right up to the end: the blend cannot get out of the way
  if (minAt >= dur - MIN_SECONDS * rate) return hold();
  const bar = grid?.period > 0 ? 4 * grid.period : 0;
  const origin = grid ? (grid.downbeat ?? grid.offset) : 0;
  const slack = 0.3 * rate;
  const minSpan = phrase && bar ? MIN_BARS * bar : MIN_SECONDS * rate;
  // phrase blends stay on their phrase lines (a bar count of their own), the others on bar lines (or seconds)
  const step = phrase && bar ? Math.min(8, bars || 8) * bar : bar || rate;
  const lengths = phrase && bar ? [...new Set([bars || MIN_BARS, 16, 8].filter(n => n <= (bars || 32) && n >= MIN_BARS))].sort((x, y) => y - x).map(n => n * bar) : null;
  const tailLimit = phrase && bar ? Math.min(MIN_BARS * bar, 20 * rate) : Math.max(bar, 2 * rate) + slack;
  for (let k = Math.ceil((minAt - origin) / step - 1e-9); origin + k * step <= dur - minSpan - slack; k++) {
    const start = origin + k * step;
    if (start < minAt - 1e-6) continue;
    const room = dur - slack - start;
    // a phrase blend picks the longest whole phrase that fits; the others end with the song, in whole bars
    const options = lengths || [bar ? Math.floor(Math.min(span, room) / bar + 1e-9) * bar : Math.min(span, room)];
    for (const length of options) {
      if (length < minSpan - 1e-6 || length > room + 1e-6 || length > span + 1e-6) continue;
      if (dur - (start + length) > tailLimit + 1e-6) continue;
      return { at: start, span: length, bars: phrase && bar ? Math.round(length / bar) : 0, shift: start - at };
    }
  }
  return hold();
}
