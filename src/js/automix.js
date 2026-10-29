// Auto mix: DJ-style transitions between songs.
// While a song plays, Quantm listens to each deck's low end (the kick drum) and works out its
// tempo and where the beats fall (beats.js). The next song is pre-played silently for a few
// seconds so its beats are known too. During the mix the incoming song is sped up or slowed
// down slightly so its beats stay on top of the outgoing song's, and the two songs swap bass
// halfway through (normalizer.js), like a DJ does, handing the mids and highs over too. When a song's
// downbeat is known the mix starts and ends on its phrase lines and the incoming song enters on its own
// bar 1 (phraseMix, alignedStart). Songs without a clear beat get a normal crossfade with the bass swap.
// The same polling also maps where each song is sung (vocals.js) so two singers don't overlap, and a song whose
// beat stops before the end gets a loop of its last clean bars or an echo-out (endings.js, barloop.js, echoout.js).

import * as beats from './beats.js';
import { ChromaAccumulator, estimateKey } from './keys.js';

const POLL_MS = 10;
const KEEP_SECONDS = 40;          // how much of each deck's recent playing is kept for analysis
// below this the beat isn't trusted (ambient, spoken word, ...). Tuned on real songs: hip-hop's
// correct readings score from about 0.25, wrong readings stayed under 0.22
const MIN_CONFIDENCE = 0.25;
export const ANALYZE_SECONDS = 7; // how much of the next song is pre-played to find its beat
export const ANALYZE_MAX_SECONDS = 12; // ...or longer, up to this, when its intro has no drums
const LOCK_MS = 50;
const CATCH_UP_SECONDS = 2;       // the first seconds of a mix may correct harder (incoming is still quiet)
const DEAD_ZONE = 0.008;          // beats within 8 ms are together; leave the tempo alone
const RELEASE_SECONDS = 8;        // after the mix the incoming song eases back to its own tempo

const KEY_EVERY = 0.15;           // media seconds between spectra fed to key detection (a few times a second is plenty)
const KEY_EDGE = 10;              // the first and last seconds are intro noise, fades and outros: not the song's key
const KEY_MIN_SECONDS = 30;       // of music sampled before the key is trusted at all
const KEY_MIN_FRAMES = 100;       // ...and tonal frames kept (drum hits and silence are thrown away by the accumulator)
const KEY_MIDDLE = [0.2, 0.8];    // the steady middle of a song counts fully; the ends count less
const KEY_EDGE_WEIGHT = 0.6;

/**
 * Listens for a song's musical key while it plays. The beat watcher hands it the deck's spectrum a few
 * times a second (reusing the deck's analyser, no extra node); the spectra pile up as pitch-class energy
 * (keys.js) and estimate() reads the key off them. Nothing is sampled while paused, seeking, muted, in
 * the first or last seconds, during silence, or while the playback speed shifts the pitch.
 */
export class KeyListener {
  constructor({ duration = 0 } = {}) {
    this.duration = duration > 0 ? duration : 0;
    this.acc = null;
    this.last = -Infinity;
    this.span = 0;      // seconds of music sampled
    this.cached = null; // [frames, estimate]
  }

  /** Take one spectrum from `norm.spectrum(audio)` if it is time; returns whether one was taken */
  sample(audio, norm) {
    if (audio.paused || audio.seeking || audio.muted || typeof norm.spectrum !== 'function') return false;
    // a deck whose pitch follows its speed (Nightcore, Slowed, a custom speed with keep pitch off) plays the song in another
    // key: that spectrum must never be filed under the song's own key, so nothing is taken from it (what was heard before stays)
    if (audio.preservesPitch === false && Math.abs((audio.playbackRate || 1) - 1) > 0.005) return false;
    const t = audio.currentTime;
    if (t < this.last) this.last = -Infinity; // a seek back
    if (t - this.last < KEY_EVERY) return false;
    if (t < KEY_EDGE || (this.duration > 0 && t > this.duration - KEY_EDGE)) return false;
    const spectrum = norm.spectrum(audio);
    if (!spectrum) return false;
    try {
      this.acc ??= new ChromaAccumulator({ sampleRate: spectrum.sampleRate, fftSize: spectrum.fftSize });
    } catch { return false; }
    const place = this.duration > 0 ? t / this.duration : 0.5;
    const before = this.acc.frames;
    this.acc.add(spectrum.db, place >= KEY_MIDDLE[0] && place <= KEY_MIDDLE[1] ? 1 : KEY_EDGE_WEIGHT);
    // time only counts when the frame was tonal (not silence or a drum hit)
    if (this.acc.frames > before) this.span += this.last > -Infinity && t - this.last < 1 ? t - this.last : KEY_EVERY;
    this.last = t;
    return true;
  }

  /** The key heard so far ({ key, camelot, name, confidence, chroma }), or null until enough music has been heard */
  estimate() {
    const acc = this.acc;
    if (!acc || acc.frames < KEY_MIN_FRAMES || this.span < KEY_MIN_SECONDS) return null;
    if (this.cached?.[0] === acc.frames) return this.cached[1];
    const chroma = acc.chroma();
    const found = estimateKey(chroma);
    const result = found && { ...found, chroma: Array.from(chroma, v => Math.round(v * 10000) / 10000) };
    this.cached = [acc.frames, result];
    return result;
  }
}

/** Records the low-end energy of the decks it watches, stamped with each deck's media time */
export class BeatWatcher {
  constructor(normalizer) {
    this.norm = normalizer;
    this.watched = new Map(); // <audio> → [{ t, v }]
    this.grids = new WeakMap();
    this.keys = new Map();  // <audio> → KeyListener: decks whose song's key is being learned
    this.vocals = new Map(); // <audio> → VocalRecorder: decks whose song's singing is being mapped (vocals.js)
    this.timer = null;
  }

  watch(audio) {
    if (!this.watched.has(audio)) this.watched.set(audio, []);
    if (!this.timer) this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  /** Learn the key of the song on this deck while it is watched (null stops) */
  listenForKey(audio, listener) {
    if (listener) this.keys.set(audio, listener);
    else this.keys.delete(audio);
  }

  /** Map the singing of the song on this deck while it is watched (null stops) */
  listenForVocals(audio, recorder) {
    if (recorder) this.vocals.set(audio, recorder);
    else this.vocals.delete(audio);
  }

  unwatch(audio) {
    this.watched.delete(audio);
    this.grids.delete(audio);
    this.keys.delete(audio);
    this.vocals.delete(audio);
    if (!this.watched.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  isWatching(audio) { return this.watched.has(audio); }

  poll() {
    for (const [audio, samples] of this.watched) {
      if (audio.paused || audio.seeking) continue;
      const energy = this.norm.beatEnergy(audio);
      if (!energy) continue;
      const t = audio.currentTime;
      // Never analyze across a seek or a stalled stream as if the gap were silence.
      if (samples.length && (t < samples.at(-1).t - 0.5 || t - samples.at(-1).t > 0.5)) {
        samples.length = 0;
        this.grids.delete(audio);
      }
      samples.push({ t, v: energy.low, h: energy.high, f: energy.full });
      this.keys.get(audio)?.sample(audio, this.norm);
      this.vocals.get(audio)?.sample(audio, this.norm);
      if (samples[0].t < t - KEEP_SECONDS - 5) {
        const keep = samples.findIndex(s => s.t >= t - KEEP_SECONDS);
        samples.splice(0, keep);
      }
    }
  }

  /** Seconds of media heard since watching started (or since the last seek back) */
  heard(audio) {
    const samples = this.watched.get(audio);
    return samples && samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0;
  }

  /** Average energy of the last `seconds` the deck played, ignoring quiet breaks (like the loudness meter's gate), or null */
  loudness(audio, seconds = 20) {
    const samples = this.watched.get(audio);
    if (!samples || samples.length < 100) return null;
    const end = samples[samples.length - 1].t;
    const values = samples.filter(s => s.t >= end - seconds && s.f > 1e-7).map(s => s.f);
    if (values.length < 100) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const loud = values.filter(v => v > mean * 0.1);
    return loud.reduce((a, b) => a + b, 0) / loud.length;
  }

  /** Readings newer than media time `after` (all of them after a seek back), for the song memory */
  since(audio, after) {
    const samples = this.watched.get(audio);
    if (!samples || !samples.length) return [];
    if (samples[samples.length - 1].t < after) return samples.slice();
    let i = samples.length;
    while (i > 0 && samples[i - 1].t > after) i--;
    return samples.slice(i);
  }

  /**
   * Beat grid from a recent contiguous drum region, in media time; null if there's no clear beat.
   * bpm: the song's tempo when its memory knows it, so only the beat's position is worked out.
   * skipLast: leave out the most recent seconds (an outro that lost its kick).
   */
  grid(audio, seconds = 20, bpm = null, skipLast = 0) {
    const samples = this.watched.get(audio);
    if (!samples || samples.length < 2) return null;
    const end = samples[samples.length - 1].t - skipLast;
    const key = `${seconds}/${bpm}/${skipLast}`;
    const cache = this.grids.get(audio);
    if (cache?.samples === samples && cache.key === key && end >= cache.end && end - cache.end < 0.75) return cache.grid;
    let best = null, bestScore = -Infinity;
    // A 20 s window may straddle a breakdown or a drumless tail. Find actual
    // contiguous beat regions rather than making the entire window pass or fail.
    for (const age of [0, 8, 16]) {
      for (const span of [...new Set([seconds, 12, 8])]) {
        const points = samples.filter(s => s.t >= end - age - span && s.t <= end - age);
        if (points.length < 2 || points.at(-1).t - points[0].t < Math.min(span - 0.1, 4)) continue;
        let start = 0;
        for (let i = 1; i < points.length; i++) if (points[i].t - points[i - 1].t > 0.25) start = i;
        const region = points.slice(start);
        const grid = beats.analyze(region, bpm ? { bpm } : {});
        const score = grid?.confidence - age * 0.004;
        if (grid?.confidence >= MIN_CONFIDENCE && score > bestScore) {
          best = { ...grid, from: region[0].t, to: region.at(-1).t };
          bestScore = score;
        }
        if (age === 0 && span === seconds && grid?.confidence >= 0.6) break;
      }
      if (best?.confidence >= 0.6 && age === 0) break;
    }
    this.grids.set(audio, { key, end, samples, grid: best });
    return best;
  }
}

/**
 * How two songs line up: the incoming song's playback-rate factor and its grid at the tempo used
 * (a half- or double-time match changes the beat length). null when they can't be beat-matched.
 */
export function matchTempo(gridOut, gridIn, maxStretch = 0.08) {
  if (!gridOut || !gridIn) return null;
  const match = beats.tempoRatio(gridOut.bpm, gridIn.bpm, maxStretch);
  if (!match) return null;
  const gridIn2 = Object.assign({}, gridIn, { bpm: match.bpmIn, period: 60 / match.bpmIn,
    offset: gridIn.downbeat ?? gridIn.offset });
  // both songs' bar 1 is known and the match keeps the beat length (no half/double-time): bars can line up too
  const bars = gridOut.phrase && gridIn.phrase && Number.isFinite(gridOut.downbeat) && Number.isFinite(gridIn.downbeat) &&
    Math.abs(gridIn2.period / gridIn.period - 1) < 0.02;
  return { ratio: match.ratio, gridOut, gridIn: gridIn2, ...(bars ? { bars: true } : {}) };
}

const wrap1 = (x) => x - Math.floor(x);

/**
 * Where the incoming song should start (at or after `from`) so it lands in phase with the outgoing song now:
 * on the same beat, and on the same beat of the bar when both songs' downbeats are known (match.bars),
 * so bar 1 meets bar 1 and the phrases line up.
 */
export function alignedStart(match, outgoingTime, from) {
  if (match.bars) {
    const barOut = 4 * match.gridOut.period, barIn = 4 * match.gridIn.period;
    const want = wrap1((outgoingTime - match.gridOut.downbeat) / barOut);
    const have = wrap1((from - match.gridIn.downbeat) / barIn);
    let shift = want - have;
    if (shift < 0) shift += 1;
    return from + (shift > 1 - 1e-6 ? 0 : shift) * barIn;
  }
  const want = beats.beatPhase(match.gridOut, outgoingTime);
  const have = beats.beatPhase(match.gridIn, from);
  let shift = want - have;
  if (shift < 0) shift += 1;
  return from + shift * match.gridIn.period;
}

export const MAX_MIX_SECONDS = 24;
/**
 * How many media seconds the mix should last at this tempo: the longest of 64, 32 or 16 beats that
 * fits in 24 s (`max`: a filter fade allows longer), times the learned length factor (kept to whole 8-beat phrases).
 */
export function mixSeconds(grid, rate = 1, factor = 1, max = MAX_MIX_SECONDS) {
  if (!grid) return Math.min(max, Math.max(4, 8 * factor)) * rate;
  const beat = grid.period / rate;
  const n = [64, 32, 16].find(beats => beats * beat <= max) || 16;
  const scaled = Math.max(8, Math.round(n * factor / 8) * 8);
  return Math.min(max, Math.max(4, scaled * beat)) * rate;
}

/** A memory entry's beat grid in the shape beats.js uses, or null when it isn't trusted. `phrase` marks a downbeat that was really heard (the first sustained drums), not just the first beat line. */
export function memoryGrid(entry) {
  if (!entry || !(entry.period > 0) || !Number.isFinite(entry.offset) || !(entry.confidence >= 0.25)) return null;
  return { bpm: entry.bpm || 60 / entry.period, period: entry.period, offset: entry.offset, confidence: entry.confidence,
    downbeat: entry.downbeat ?? entry.offset, ...(entry.downbeat != null ? { phrase: true } : {}) };
}

const PHRASE_BARS = [32, 16, 8, 4];  // whole-phrase mix lengths (4 only where 8 would not fit the longest mix)
const PHRASE_LINE = 8;               // mixes start on a multiple of this many bars from the song's downbeat
const MIN_PHRASE_CONFIDENCE = 0.35;  // a shakier beat can't carry bar lines across a whole song
export const PHRASE_LEAD = ANALYZE_SECONDS + 1; // media seconds of look-ahead the next song needs before the mix begins

/**
 * Phrase-perfect timing for an Auto mix out of a song whose grid has a known downbeat (grid.phrase):
 * the mix starts on a bar line that is a whole number of 8-bar phrases from the downbeat, lasts 8, 16 or
 * 32 bars (4 on very slow songs, starting on its own 4-bar lines) and ends as a phrase ends, like a DJ counting bars. Everything in media seconds.
 *   outroStart: where the drums leave the outgoing song (when known): the mix begins at the phrase there
 *   factor: the learned length factor (the nearest whole-phrase length to what it asks for is used)
 * Returns { at, span, bars } or null (no downbeat, mix would be too short, start too early or too soon): then the beat-aligned timing stands.
 */
export function phraseMix({ grid, dur, now = 0, rate = 1, outroStart = null, factor = 1, maxSeconds = MAX_MIX_SECONDS }) {
  if (!grid?.phrase || !(grid.period > 0) || !Number.isFinite(grid.downbeat) || !(grid.confidence >= MIN_PHRASE_CONFIDENCE) ||
      !(dur > 0)) return null;
  const bar = 4 * grid.period, line = PHRASE_LINE * bar, origin = grid.downbeat;
  const want = mixSeconds(grid, rate, factor, Math.max(maxSeconds, MAX_MIX_SECONDS)) / bar; // a lower ceiling (clashing keys) keeps the usual ask
  const fits = PHRASE_BARS.filter(bars => bars * bar <= maxSeconds * rate + 1e-6);
  const lengths = fits.filter(bars => bars >= 8).length ? fits.filter(bars => bars >= 8) : fits.slice(-1);
  if (!lengths.length) return null;
  const earliest = Math.max(now + PHRASE_LEAD * rate, dur * 0.75), slack = 0.3 * rate;
  let best = null;
  for (const bars of lengths) {
    const span = bars * bar, step = Math.min(PHRASE_LINE, bars) * bar; // a 4-bar mix counts its own bars
    const first = Math.ceil((earliest - origin) / step - 1e-9), last = Math.floor((dur - span + slack - origin) / step + 1e-9);
    for (let k = first; k <= last; k++) {
      const at = origin + k * step, end = at + span;
      // outro known: start where it starts (never well into its drumless part); else end where the song ends
      const place = outroStart != null ? Math.abs(at - outroStart) / bar + (at > outroStart + bar / 2 ? 1.5 * (at - outroStart) / bar : 0)
        : Math.max(0, dur - end) / bar;
      // keep the length near what was asked for; a 16-bar line is a stronger phrase than an 8-bar one
      const cost = place + 2 * Math.abs(Math.log2(bars / want)) - (k % 2 === 0 ? 0.25 : 0);
      if (!best || cost < best.cost) best = { cost, at, span, bars, tail: dur - end };
    }
  }
  // a song that doesn't end near a phrase of its own (more than a phrase or ~20 s of it would be skipped) keeps the beat-aligned timing
  if (!best || (outroStart == null ? best.tail > Math.min(PHRASE_LINE * bar, 20 * rate) : Math.abs(best.at - outroStart) > line)) return null;
  return { at: best.at, span: best.span, bars: best.bars };
}

export const CLASH_MIN_SECONDS = 8;  // shortest blend when the songs' keys clash and the phrase grid is not in use
const CLASH_MIN_BARS = 8;            // ...and when it is

/**
 * Songs in clashing keys sound worst while both play their melodies, so the blend gets half as long (the
 * bass/mid hand-over, set by the player, keeps the overlap thin). A DJ would shift the pitch, but the
 * playback rate here is what beat-locks the two songs; changing it would change the tempo, so the
 * key is never shifted.
 * `span` and `phrase` are the planned mix (media seconds; phraseMix's result or null); the rest is what
 * phraseMix was given. Returns { span, phrase } for the shorter plan (phrase null when the mix isn't on
 * the phrase grid), or null when it is already as short as it may be.
 */
export function shortenForClash({ span, phrase, grid, dur, now = 0, rate = 1, outroStart = null, factor = 1 }) {
  if (phrase && grid) {
    const bar = 4 * grid.period;
    const bars = Math.max(CLASH_MIN_BARS, phrase.bars / 2);
    if (bars >= phrase.bars) return null;
    // the same search with a lower ceiling: it keeps the phrase lines and the song's own ending
    const shorter = phraseMix({ grid, dur, now, rate, outroStart, factor, maxSeconds: bars * bar / rate + 1e-6 });
    return shorter && shorter.span < phrase.span ? { span: shorter.span, phrase: shorter } : null;
  }
  const floor = CLASH_MIN_SECONDS * rate;
  if (!(span > floor * 1.25)) return null;
  // whole bars when the beat is known, so the mix still ends on a bar
  const bar = grid?.period > 0 ? 4 * grid.period : 0;
  const half = bar ? Math.max(Math.ceil(floor / bar), Math.round(span / 2 / bar)) * bar : Math.max(floor, span / 2);
  return half < span - 1e-6 ? { span: half, phrase: null } : null;
}

/** Keeps the incoming song's beats on the outgoing song's by nudging its speed, like a DJ riding the pitch fader */
export class BeatLock {
  constructor(outgoing, incoming, match, baseRate, lock = true) {
    this.outgoing = outgoing;
    this.incoming = incoming;
    this.match = match;
    this.baseRate = baseRate;
    this.target = baseRate * match.ratio;
    this.startedAt = null;
    this.error = null;
    this.timer = lock ? setInterval(() => this.tick(), LOCK_MS) : null;
    if (lock) incoming.playbackRate = this.target;
  }

  tick() {
    const { outgoing, incoming, match } = this;
    if (incoming.paused || outgoing.paused || outgoing.ended || incoming.seeking) return;
    if (this.startedAt === null) this.startedAt = performance.now();
    const ahead = beats.phaseError(match.gridOut, outgoing.currentTime, match.gridIn, incoming.currentTime);
    if (!Number.isFinite(ahead)) return;
    const raw = ahead * match.gridOut.period / (outgoing.playbackRate || 1);
    // smoothed, so timer jitter in the readings doesn't make the tempo wobble
    this.error = this.error == null ? raw : this.error * 0.6 + raw * 0.4;
    const seconds = Math.abs(this.error) < DEAD_ZONE ? 0 : this.error;
    const catchingUp = (performance.now() - this.startedAt) / 1000 < CATCH_UP_SECONDS;
    const limit = catchingUp ? 0.1 : 0.03;
    // close the gap in under a second, never bending the tempo more than the limit
    const nudge = Math.max(-limit, Math.min(limit, -1.5 * seconds));
    const rate = this.target * (1 + nudge);
    if (Math.abs(rate - incoming.playbackRate) > 0.001) incoming.playbackRate = rate;
  }

  /** The speed setting changed: aim for the new rate (mid-mix or while easing back) */
  setBaseRate(rate) {
    this.baseRate = rate;
    this.target = rate * this.match.ratio;
    if (this.timer) return;
    clearInterval(this.glide);
    this.glide = null;
    this.incoming.playbackRate = rate;
    const done = this.onReleased;
    this.onReleased = null;
    done?.();
  }

  /** The mix is over: ease the song back to its own tempo */
  release(onDone = () => {}) {
    clearInterval(this.timer);
    clearInterval(this.glide);
    this.glide = null;
    this.timer = null;
    this.onReleased = onDone;
    const done = () => {
      const callback = this.onReleased;
      this.onReleased = null;
      callback?.();
    };
    const audio = this.incoming;
    const from = audio.playbackRate;
    const to = this.baseRate;
    if (Math.abs(from - to) < 0.001) { audio.playbackRate = to; done(); return; }
    const started = performance.now();
    const glide = setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / (RELEASE_SECONDS * 1000));
      audio.playbackRate = from + (to - from) * t;
      if (t >= 1) { clearInterval(glide); this.glide = null; done(); }
    }, 100);
    this.glide = glide;
  }

  /** Drop it now (a skip, or the song changed): the deck goes straight back to normal speed */
  stop(rate = this.baseRate) {
    clearInterval(this.timer);
    clearInterval(this.glide);
    this.glide = null;
    this.onReleased = null;
    this.timer = null;
    this.incoming.playbackRate = rate;
  }
}
