// Genre-specific Auto mix transitions. Auto used to pick between a smooth blend and a drop cut; it now also asks
// what a DJ would do with these two songs: hip-hop is cut on the downbeat, drum and bass or dubstep with two
// known drops gets a double drop, and slow quiet music is faded out through a low-pass filter. Everything here
// is pure planning (media seconds); the player carries it out with the machinery it already has (the drop cut
// schedule, the blend's fades and bass swap, a low-pass on the deck).
import { tempoFit } from './mixorder.js';

export const GENRE_LABELS = Object.freeze({ quickcut: 'Quick cut', doubledrop: 'Double drop', filterfade: 'Filter fade' });

/** Songs whose tags say they are mellow: a long filtered fade suits them whatever their tempo */
const MELLOW = /deep.?house|ambient|down.?tempo|chill(?:out|wave|step)?|lo-?fi|lounge|organic house|melodic house|dub techno|trip.?hop|atmospheric|ethereal|new age/i;

/** The mellow term a song's genre, tags or title mention ('deep house', 'ambient', ...), or null */
export function mellowHint(features) {
  const text = [features?.genre, ...(features?.tags || []), features?.title].filter(t => typeof t === 'string').join(' ');
  const found = MELLOW.exec(text)?.[0];
  return found ? found.toLowerCase().replace(/[-.]/g, ' ').replace(/\s+/g, ' ') : null;
}

export const QUICK_CUT_BEATS = 4;     // the cut's schedule is one bar long: silent pre-roll of the incoming bar, then the cut
export const QUICK_CUT_BREATH = 0.04; // seconds of gap between the outgoing's last sound and the downbeat (a tick, so it isn't a click)

/** What dropcut.js's rollSchedule takes for a quick cut: no build, no kill, an optional short echo tail */
export const quickCutOptions = ({ echo = false } = {}) => ({ breath: QUICK_CUT_BREATH, stutter: false, echo, kill: { style: 'none' }, minBeats: QUICK_CUT_BEATS });

export const DOUBLE_DROP_TEMPO = 0.04; // the two tempos may differ by this much (or by exactly half/double time plus this)
const SLOW_BPM = 112;                  // a dance track at or under this is slow enough for a filter fade, when it is also quiet
const QUIET = 0.4;                     // waveform energy (0..1) under which a song counts as quiet
const DROP_SURE = 0.65;                // a drop is confirmed from this confidence (as in dropcut.js)

const known = n => Number.isFinite(n) && n > 0;
const sure = drop => !!drop && Number.isFinite(drop.time) && drop.time >= 0 && drop.confidence >= DROP_SURE;

/**
 * Which genre transition suits this pair, or { style: null } for Auto's usual choice (drop cut for energetic
 * electronic pairs with a clear drop, else a smooth blend).
 *   familyOut, familyIn   mixorder.genreFamily: 'dance' | 'bass' | 'hiphop' | 'other' | 'unknown'
 *   bpmOut, bpmIn         tempos (null when unknown)
 *   energyOut, energyIn   waveform energy 0..1 (null when unknown)
 *   dropOut, dropIn       confirmed drops { time, confidence } (null when unknown)
 *   downbeatIn            where the incoming song's first bar starts (null when unknown)
 *   vocalsOut             the outgoing song is still singing at its end
 *   beatOut               the outgoing song has a steady beat (default: its tempo is known)
 *   mellow                a mellow term the outgoing song's tags mention (mellowHint)
 *   clash                 the two keys clash (a double drop would put both melodies on top of each other)
 * Returns { style: 'quickcut' | 'doubledrop' | 'filterfade' | null, variant, reason }.
 */
export function genreTransition({ familyOut, familyIn, bpmOut = null, bpmIn = null, energyOut = null, energyIn = null, dropOut = null,
  dropIn = null, downbeatIn = null, vocalsOut = false, beatOut = known(bpmOut), mellow = null, clash = false } = {}) {
  // hip-hop: a DJ doesn't blend it, they cut on the one. Both hip-hop, or hip-hop into anything with a known downbeat to land on.
  if (familyOut === 'hiphop' && (familyIn === 'hiphop' || Number.isFinite(downbeatIn))) {
    const variant = vocalsOut ? 'echo' : 'dry';
    return { style: 'quickcut', variant, reason: `hip-hop: quick cut on the downbeat${vocalsOut ? ', short echo tail' : ''}` };
  }
  // drum and bass or dubstep with both drops known and the tempos matching: the two drops play together
  if (familyOut === 'bass' && familyIn === 'bass' && sure(dropOut) && sure(dropIn) && !clash) {
    const fit = tempoFit(bpmOut, bpmIn, DOUBLE_DROP_TEMPO);
    if (fit?.ok) return { style: 'doubledrop', variant: Math.abs(fit.ratio - bpmOut / bpmIn) > 1e-9 ? 'half-time' : 'same-tempo', reason: 'double drop' };
  }
  // slow, quiet music (deep house, ambient, downtempo, or a song with no beat to count) fades out through a low-pass
  if (familyOut !== 'bass' && familyOut !== 'hiphop') {
    const quiet = x => known(x) && x < QUIET;
    const slowQuiet = familyOut === 'dance' && known(bpmOut) && bpmOut <= SLOW_BPM && quiet(energyOut) && (energyIn == null || energyIn < QUIET + 0.1);
    const beatless = familyOut === 'other' && !beatOut;
    if (mellow || slowQuiet || beatless) {
      const what = mellow || (slowQuiet ? 'slow and quiet' : 'no clear beat');
      return { style: 'filterfade', variant: mellow ? 'mellow' : slowQuiet ? 'quiet' : 'beatless', reason: `filter fade (${what})` };
    }
  }
  return { style: null, variant: null, reason: '' };
}

// ---- double drop ---------------------------------------------------------------------------------------------

export const DOUBLE_BUILD_BARS = 4;   // bars the incoming song fades in under the outgoing song's build, before the drops meet
export const DOUBLE_DROP_BARS = [16, 8]; // bars both drops play together (16 when the songs have the room, else 8)
export const DOUBLE_TAIL_BARS = 4;    // bars the outgoing song takes to leave after the bass has swapped

/**
 * Plan a double drop in the outgoing song's media seconds. The incoming song starts DOUBLE_BUILD_BARS before its
 * drop so that its drop lands exactly on the outgoing drop; the outgoing song's bass stays through the shared
 * bars, then swaps, and the outgoing song fades away over the tail.
 *   gridOut           the outgoing grid { period, downbeat?, offset } (bars are counted from its downbeat)
 *   dropOut, dropIn   confirmed drops { time }
 *   ratio             the incoming playback-rate factor of the tempo match (1 = same tempo)
 *   now, dur, rate    outgoing position and length, playback rate
 *   durIn             the incoming song's length (media seconds), when known
 *   lead              media seconds of look-ahead the next song needs before the mix begins
 * Returns { at, span, bars, dropAt, startAt, inEnd, center, buildBars, dropBars, tailBars, ratio } or null. `at` is
 * where the blend starts, `startAt` where the incoming song starts playing, `inEnd` and `center` fractions (0..1) of
 * the blend where the incoming song reaches full level and where the bass hands over.
 */
export function doubleDropPlan({ gridOut, dropOut, dropIn, ratio = 1, now = 0, dur, rate = 1, durIn = null, lead = 14 } = {}) {
  if (!(gridOut?.period > 0) || !sure({ ...dropOut, confidence: 1 }) || !sure({ ...dropIn, confidence: 1 }) ||
      ![dur, now, rate, ratio].every(Number.isFinite) || rate <= 0 || ratio <= 0) return null;
  const bar = 4 * gridOut.period, origin = gridOut.downbeat ?? gridOut.offset ?? 0;
  const dropAt = origin + Math.round((dropOut.time - origin) / bar) * bar; // a bar line of the outgoing grid
  const at = dropAt - DOUBLE_BUILD_BARS * bar;
  if (at < now + lead * rate) return null; // too late to prepare the next song, or the drop has passed
  // the incoming song starts a build earlier than its drop, in its own media time
  const startAt = dropIn.time - DOUBLE_BUILD_BARS * bar * ratio;
  if (startAt < 0.5) return null;
  for (const dropBars of DOUBLE_DROP_BARS) {
    const after = (dropBars + DOUBLE_TAIL_BARS) * bar;
    // both songs must still have the shared bars and the tail left (a little to spare)
    if (dropAt + after + 2 * rate > dur) continue;
    if (durIn != null && dropIn.time + after * ratio + 8 > durIn) continue;
    const bars = DOUBLE_BUILD_BARS + dropBars + DOUBLE_TAIL_BARS;
    return { at, span: bars * bar, bars, dropAt, startAt, ratio, buildBars: DOUBLE_BUILD_BARS, dropBars, tailBars: DOUBLE_TAIL_BARS,
      inEnd: DOUBLE_BUILD_BARS / bars, center: (DOUBLE_BUILD_BARS + dropBars) / bars };
  }
  return null;
}

// ---- filter fade ---------------------------------------------------------------------------------------------

export const FILTER_OPEN = 20000;    // Hz: a low-pass this high does nothing audible
export const FILTER_END = 300;       // Hz: where the outgoing song's sweep ends
export const FILTER_SWEEP = 0.9;     // fraction of the blend the sweep takes (the last tenth just sits closed while the song leaves)
export const FILTER_MAX_SECONDS = 36; // a filter fade is a long blend: it may run this long (a normal blend 24 s)

const smooth = t => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** The outgoing song's low-pass cutoff (Hz) at progress 0..1 of a filter fade: an exponential sweep from open down to FILTER_END */
export function lowpassHz(progress) {
  return FILTER_OPEN * Math.pow(FILTER_END / FILTER_OPEN, smooth(progress / FILTER_SWEEP));
}
