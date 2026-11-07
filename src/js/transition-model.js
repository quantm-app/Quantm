// Pure transition geometry and curve settings. All times are media seconds.
export const MAX_FADE = 60;
export const BAR_CHOICES = [4, 8, 16, 32];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const duration = (value) => Number.isFinite(value) && value > 0 ? value : Infinity;

export function barsToSeconds(bars, bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? bars * 4 * 60 / bpm : null;
}

export function secondsToBars(seconds, bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? seconds * bpm / (4 * 60) : null;
}

export function barChoices(bpm, maxFade = MAX_FADE) {
  if (barsToSeconds(1, bpm) === null) return [];
  return BAR_CHOICES.map(bars => ({ bars, seconds: barsToSeconds(bars, bpm) }))
    .filter(choice => choice.seconds <= maxFade);
}

export function snapToBar(time, { bpm, downbeat = 0 }) {
  const bar = barsToSeconds(1, bpm);
  if (bar === null) return Math.max(0, time);
  const origin = finite(downbeat);
  return Math.max(0, origin + Math.round((time - origin) / bar) * bar);
}

export function normalizeDraft(draft, { durationOut, durationIn }) {
  draft = draft || {};
  const endOut = duration(durationOut), endIn = duration(durationIn);
  const into = clamp(finite(draft.in), 0, endIn);
  let fade = clamp(finite(draft.fade), 0, MAX_FADE);
  fade = Math.min(fade, endOut, endIn - into);
  const out = clamp(finite(draft.out, Math.max(0, finite(durationOut) - fade)), 0, endOut);
  return { out, in: into, fade: Math.min(fade, endOut - out) };
}

export function layout(draft, { durationOut, durationIn }) {
  const { out, in: into, fade } = normalizeDraft(draft, { durationOut, durationIn });
  const offset = out - into;
  const shift = Math.max(0, -offset);
  // Unknown lengths extend just far enough to draw the transition.
  const fromStart = shift, toStart = offset + shift;
  const fromEnd = fromStart + finite(duration(durationOut), out + fade);
  const toEnd = toStart + finite(duration(durationIn), into + fade);
  const overlapStart = out + shift;
  const overlapEnd = Math.min(overlapStart + fade, fromEnd, toEnd);
  return { total: Math.max(fromEnd, toEnd), fromStart, fromEnd, toStart, toEnd, overlapStart, overlapEnd };
}

export function visibleWindow(layoutResult, { padding = 8 }) {
  const { total, overlapStart, overlapEnd } = layoutResult;
  const pad = Math.max(0, finite(padding));
  return { start: clamp(overlapStart - pad, 0, total), end: clamp(overlapEnd + pad, 0, total) };
}

export function moveOut(draft, deltaSeconds, ctx) {
  const { out } = normalizeDraft(draft, ctx);
  return normalizeDraft({ ...draft, out: snapToBar(out + finite(deltaSeconds), ctx) }, ctx);
}

export function moveIn(draft, deltaSeconds, ctx) {
  const { in: into } = normalizeDraft(draft, ctx);
  return normalizeDraft({ ...draft, in: snapToBar(into + finite(deltaSeconds), ctx) }, ctx);
}

export const PRESETS = [
  { id: 'auto', label: 'Auto', style: 'auto', curve: null },
  { id: 'smooth', label: 'Smooth', style: 'blend', curve: { dj: 0 } },
  { id: 'swap', label: 'DJ swap', style: 'blend', curve: { dj: 1, center: 0.5 } },
  { id: 'early', label: 'Early', style: 'blend', curve: { dj: 1, center: 0.3 } },
  { id: 'late', label: 'Late', style: 'blend', curve: { dj: 1, center: 0.7 } },
  { id: 'dropcut', label: 'Drop cut', style: 'dropcut', curve: null }
];

export function presetFor(style, curve) {
  if (curve == null) {
    if (!style) return 'default';
    return PRESETS.find(preset => preset.style === style && preset.curve === null)?.id || 'custom';
  }
  const shape = normalizeCurve(curve);
  return PRESETS.find(preset => preset.style === style && preset.curve && shape &&
    preset.curve.dj === shape.dj && (!shape.dj || Math.abs(preset.curve.center - shape.center) < 0.001))?.id || 'custom';
}

export function normalizeCurve(curve) {
  if (!curve || typeof curve !== 'object' || Array.isArray(curve)) return null;
  const amount = typeof curve.dj === 'boolean' ? Number(curve.dj) : curve.dj;
  if (!Number.isFinite(amount)) return null;
  const dj = clamp(amount, 0, 1);
  return dj ? { dj, center: centerFromPointer(curve.center) } : { dj };
}

export function curvePoints(curve, fadeIn, count = 33, fadeLevel) {
  const shape = normalizeCurve(curve);
  const size = Math.max(2, Math.floor(finite(count, 33)));
  return Array.from({ length: size }, (_, i) => {
    const t = i / (size - 1);
    return { t, level: fadeLevel(fadeIn, t, shape) };
  });
}

export function centerFromPointer(x) {
  return clamp(finite(x, 0.5), 0.15, 0.85);
}

/**
 * Make a running fade follow a pair's volume curve: both songs' levels use it, and when the bass swap is on
 * (`fading.bass`) its centre and EQ amount follow it too, so the bass hands over where the volume does.
 * Returns false (and changes nothing) when there is no usable curve.
 */
export function applyCurve(fading, curve) {
  const shape = normalizeCurve(curve);
  if (!fading || !shape) return false;
  fading.shapeIn = { ...shape };
  fading.shapeOut = { ...shape };
  if (fading.bass) {
    const { center: _old, ...rest } = fading.bassOpts || {};
    fading.bassOpts = { ...rest, ...(shape.dj ? { center: shape.center } : {}), eq: shape.dj };
  }
  return true;
}
