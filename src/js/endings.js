// How an Auto mix gets out of a song that has no outro to blend over (its beat stops just before the end).
// A normal blend comes first; failing that a DJ would loop the last clean beat bars to make room, or throw an
// echo on the last phrase and bring the next song in under the tail. All pure planning: the player carries
// these out (barloop.js for the loop, echoout.js for the delay). Everything in media seconds.

import { VocalMap } from './vocals.js';

export const MIN_BLEND_BARS = 8;     // a blend over a loop should last at least this many bars
export const MAX_LOOPS = 4;          // times the bars are repeated at most
const MIN_BEAT_SECONDS = 8;          // seconds of a blend that should have the outgoing beat when the drums stop early
const OUTRO_USABLE = 6;              // seconds of drumless tail that count as an outro to blend over (as in the player)
const PLAN_LEAD = 8;                 // seconds ahead of now a blend must start (the next song needs its look-ahead)
const END_MARGIN = 0.5;              // seconds before the very end that a loop's last bar must finish by
const ECHO_BARS = 2;                 // bars the echo tail rings
const ECHO_FEEDBACK = 0.55;

const confidentGrid = (grid) => !!grid && grid.period > 0 && Number.isFinite(grid.offset) && grid.confidence >= 0.25;
const originOf = (grid) => grid.downbeat ?? grid.offset;

/**
 * Whether the planned blend has a beat to ride. False when there is no steady beat to count bars on, or when the
 * song's drums stop shortly before the end (a remembered outro under 6 s) and fewer than 8 s of the blend
 * (the whole blend, if it is shorter) would still have them: then it would mostly run against silence. A song
 * without a known ending is left to the normal blend, and so is a long outro (the blend runs over it).
 *   span, at   the planned blend (media seconds): its length and the outgoing time it starts
 *   gridOk     the outgoing song has a steady beat to count bars on
 */
export function usableBlend({ span, at, dur, rate = 1, outroStart = null, gridOk = true }) {
  if (!gridOk || !(span > 0)) return false;
  if (outroStart == null || !(outroStart < dur)) return true;
  const tail = dur - outroStart;
  if (tail >= OUTRO_USABLE * rate) return true;
  return Math.min(span, Math.max(0, outroStart - at)) >= Math.min(span, MIN_BEAT_SECONDS * rate) - 1e-6;
}

/**
 * The last clean stretch of beat to loop: a bar or two (on the bar lattice) before the drums stop where the
 * beat is steady and nobody sings, and the few seconds after it are clean too (they play once the loop ends).
 * Needs the song's drums to be known (`outroStart`, or `beatToEnd`) and its vocals (`vocals`, a stored summary).
 * Returns { a, b, n, bar } (media seconds: the loop plays from a to b, n bars long) or null.
 */
export function findCleanBar({ grid, dur, rate = 1, now = 0, outroStart = null, beatToEnd = false, vocals }) {
  if (!confidentGrid(grid) || !(dur > 0)) return null;
  const map = vocals instanceof VocalMap ? vocals : new VocalMap(vocals);
  if (!map.valid) return null;
  const drumsEnd = beatToEnd ? dur - END_MARGIN * rate : outroStart;
  if (!(drumsEnd > 0)) return null;
  const bar = 4 * grid.period, origin = originOf(grid);
  const last = Math.min(drumsEnd, dur - END_MARGIN * rate);
  const latest = origin + Math.floor((last - origin) / bar + 1e-9) * bar;
  // the last bars of beat: the latest bar line first, then up to two bars earlier; two bars of loop before one
  for (let back = 0; back <= 2; back++) {
    const b = latest - back * bar;
    for (const n of [2, 1]) {
      const a = b - n * bar;
      if (a < now + PLAN_LEAD * rate) continue;
      if (map.clean(a, Math.min(dur, b + OUTRO_USABLE * rate))) return { a, b, n, bar };
    }
  }
  return null;
}

/**
 * How many times to repeat the clean bars so the blend over them lasts at least `minBars` bars: the blend
 * starts where the loop starts, the loop repeats `loops` extra times, then the song plays on to its end.
 * Returns { at, b, n, loops, bar, bars, span } (`span`: the blend's length in media seconds, counting the repeats) or null
 * when it would take more than MAX_LOOPS repeats.
 */
export function loopPlanFor({ clean, dur, rate = 1, minBars = MIN_BLEND_BARS, maxLoops = MAX_LOOPS }) {
  if (!clean || !(clean.bar > 0) || !(dur > clean.b)) return null;
  const { a, b, n, bar } = clean;
  const tailBars = Math.max(0, Math.floor((dur - END_MARGIN * rate - b) / bar + 1e-9));
  const loops = Math.max(1, Math.ceil((minBars - tailBars) / n) - 1);
  if (loops > maxLoops) return null;
  const bars = n * (loops + 1) + tailBars;
  return { at: a, b, n, loops, bar, bars, span: bars * bar };
}

/**
 * An echo-out on the last phrase: on the last bar line that still leaves a beat of song, the dry signal is cut
 * over one beat and a tempo-synced echo (3/4 beat, 1/2 beat on slow songs) rings for a couple of bars while
 * the next song starts on the beat. `outroStart` is where the sound or drums stop when that is before the end of
 * the media (a silent or drumless tail): the echo must catch a beat that is really playing, so it sits before it.
 * Returns { at, span, beat, delayBeats, feedback, tailBars } or null.
 */
export function echoPlan({ grid, dur, rate = 1, now = 0, outroStart = null }) {
  if (!confidentGrid(grid) || !(dur > 0)) return null;
  const bar = 4 * grid.period, beat = grid.period, origin = originOf(grid);
  const end = outroStart != null && outroStart > 0 && outroStart < dur ? outroStart : dur;
  const at = origin + Math.floor((end - beat - 0.15 * rate - origin) / bar + 1e-9) * bar;
  if (!(at >= now + PLAN_LEAD * rate)) return null;
  return { at, span: beat + ECHO_BARS * bar, beat, delayBeats: 60 / grid.period >= 100 ? 0.75 : 0.5,
    feedback: ECHO_FEEDBACK, tailBars: ECHO_BARS };
}

/**
 * The order of preference for the end of a song: the normal blend (vocal clashes handled by the caller),
 * then a loop extension (a clean bar is there and the deck can really seek), then an echo-out (no clean bar,
 * the delay is available), then today's plan unchanged ('fallback').
 */
export function chooseEnding({ usable, loop = null, loopOk = false, echo = null, echoOk = false }) {
  if (usable) return { kind: 'blend' };
  if (loop && loopOk) {
    return { kind: 'loop', plan: loop, reason: `looped the last ${loop.n === 1 ? 'bar' : loop.n + ' bars'} to make room for the blend` };
  }
  if (echo && echoOk) return { kind: 'echo-out', plan: echo, reason: 'echo-out (song ends abruptly)' };
  return { kind: 'fallback' };
}
