// The fade and EQ curves of the transition that is running, as numbers 0..1 over the whole transition. The Producer
// theme's Automation panel and the transition tab (transition-tab.js) both draw from here, so they cannot drift apart.
// `f` is player.fading (shapeIn / shapeOut, bass, bassOpts, schedule); `drop` says the transition is a drop cut.
import { eqLevels } from './normalizer.js';
import { highpassAt } from './dropcut.js';

export const CURVE_POINTS = 65;
export const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** The drop cut's cut/drop schedule, or null for a blend (a plain crossfade has none either) */
export const curveSchedule = (f, drop) => drop ? f?.schedule : null;

/** Changes whenever the curves would: draw them again only then */
export function curveKey(f, drop) {
  const schedule = curveSchedule(f, drop);
  return JSON.stringify([drop, f?.shapeIn, f?.shapeOut, f?.bassOpts, f?.bass,
    schedule && [schedule.start, schedule.end, schedule.cut, schedule.drop, schedule.kill]]);
}

/** { fadeOut, fadeIn, eqOut, eqIn }: CURVE_POINTS values each (fades as the volume 0..1, EQ as the mid / high-pass lane) */
export function curveValues(f, drop) {
  const schedule = curveSchedule(f, drop);
  const span = schedule ? schedule.end - schedule.start : 0;
  const lane = (incoming, eqLane) => {
    const shape = (incoming ? f?.shapeIn : f?.shapeOut) || {};
    const center = shape.center ?? 0.5;
    const amount = shape.dj === true ? 1 : unit(Number(shape.dj));
    const smooth = x => { x = unit(x); return x * x * (3 - 2 * x); };
    return Array.from({ length: CURVE_POINTS }, (_, n) => {
      const t = n / (CURVE_POINTS - 1);
      const phase = incoming ? t : 1 - t;
      const plain = Math.sin(phase * Math.PI / 2);
      const djPhase = incoming ? smooth(t / (shape.inEnd ?? center)) : 1 - smooth((t - center) / (1 - center));
      const scheduledTime = schedule ? schedule.start + t * span : 0;
      if (!eqLane) {
        const level = drop ? (schedule ? (incoming ? scheduledTime >= schedule.drop : scheduledTime < schedule.cut) : 0) :
          plain + (Math.sin(djPhase * Math.PI / 2) - plain) * amount;
        return Number(level);
      }
      return drop ? (schedule && !incoming ? Math.log2(Math.max(25, highpassAt(schedule, scheduledTime)) / 25) / 10 : 0) :
        1 + eqLevels(incoming, t, f?.bass ? f.bassOpts?.eq : 0, f?.bassOpts?.center ?? 0.5, f?.bass ? f.bassOpts?.midHold : null).mid / 26;
    });
  };
  return { fadeOut: lane(false, false), fadeIn: lane(true, false), eqOut: lane(false, true), eqIn: lane(true, true) };
}

/** SVG path data for one lane in a 600 x 100 box */
export const curvePath = values => values.map((value, n) =>
  `${n ? 'L' : 'M'}${(n / (values.length - 1) * 600).toFixed(1)},${(92 - unit(value) * 84).toFixed(1)}`).join(' ');

/** How far along the transition is (0..1): by the audio clock for a drop cut's schedule, else the fallback progress */
export function curveProgress(f, drop, contextTime, fallback) {
  const schedule = curveSchedule(f, drop);
  const span = schedule ? schedule.end - schedule.start : 0;
  return span > 0 && Number.isFinite(contextTime) ? unit((contextTime - schedule.start) / span) : unit(fallback);
}
