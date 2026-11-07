import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FADE, BAR_CHOICES, barsToSeconds, secondsToBars, barChoices, snapToBar,
  normalizeDraft, layout, visibleWindow, moveOut, moveIn, PRESETS, presetFor,
  normalizeCurve, curvePoints, centerFromPointer
} from '../src/js/transition-model.js';

test('bar conversions use four beats and require a finite positive numeric bpm', () => {
  assert.equal(MAX_FADE, 60);
  assert.deepEqual(BAR_CHOICES, [4, 8, 16, 32]);
  assert.equal(barsToSeconds(8, 120), 16);
  assert.equal(secondsToBars(16, 120), 8);
  assert.equal(barsToSeconds(0, 120), 0);
  assert.equal(secondsToBars(0, 120), 0);
  assert.equal(secondsToBars(barsToSeconds(4.5, 137), 137), 4.5);
  for (const bpm of [undefined, null, 0, -120, NaN, Infinity, -Infinity, '120']) {
    assert.equal(barsToSeconds(4, bpm), null);
    assert.equal(secondsToBars(8, bpm), null);
    assert.deepEqual(barChoices(bpm), []);
    assert.equal(snapToBar(3.25, { bpm }), 3.25);
  }
});

test('bar choices omit long fades at low bpm and include the exact limit', () => {
  assert.deepEqual(barChoices(120), [
    { bars: 4, seconds: 8 }, { bars: 8, seconds: 16 }, { bars: 16, seconds: 32 }
  ]);
  assert.deepEqual(barChoices(60), [{ bars: 4, seconds: 16 }, { bars: 8, seconds: 32 }]);
  assert.deepEqual(barChoices(16), [{ bars: 4, seconds: 60 }]);
  assert.deepEqual(barChoices(15), []);
  assert.deepEqual(barChoices(120, 16), [{ bars: 4, seconds: 8 }, { bars: 8, seconds: 16 }]);
  assert.deepEqual(barChoices(120, 0), []);
  assert.deepEqual(barChoices(120, 64).at(-1), { bars: 32, seconds: 64 });
});

test('snapping uses a bar grid on both sides of a non-zero downbeat', () => {
  assert.equal(snapToBar(3.1, { bpm: 120 }), 4);
  assert.equal(snapToBar(3.1, { bpm: 120, downbeat: 0.5 }), 2.5);
  assert.equal(snapToBar(3.8, { bpm: 120, downbeat: 10.5 }), 4.5);
  assert.equal(snapToBar(8.1, { bpm: 120, downbeat: 10.5 }), 8.5);
  assert.equal(snapToBar(0, { bpm: 120, downbeat: 0.5 }), 0.5);
  assert.equal(snapToBar(0, { bpm: 120, downbeat: 1.5 }), 0);
  assert.equal(snapToBar(-5, { bpm: 120 }), 0);
  assert.equal(snapToBar(-5, {}), 0);
});

test('drafts resolve null points after limiting the fade to available lengths', () => {
  const ctx = { durationOut: 100, durationIn: 80 };
  assert.deepEqual(normalizeDraft({ out: null, in: null, fade: 8 }, ctx), { out: 92, in: 0, fade: 8 });
  assert.deepEqual(normalizeDraft({ out: null, in: 75, fade: 20 }, ctx), { out: 95, in: 75, fade: 5 });
  assert.deepEqual(normalizeDraft({ out: null, fade: 120 }, ctx), { out: 40, in: 0, fade: 60 });
  assert.deepEqual(normalizeDraft({ out: null, fade: 60 }, { durationOut: 5, durationIn: 80 }),
    { out: 0, in: 0, fade: 5 });
});

test('drafts clamp explicit points and fades without mutating input', () => {
  const ctx = { durationOut: 100, durationIn: 80 };
  const draft = Object.freeze({ out: 97, in: 79, fade: 8 });
  assert.deepEqual(normalizeDraft(draft, ctx), { out: 97, in: 79, fade: 1 });
  assert.deepEqual(normalizeDraft({ out: 110, in: 90, fade: 10 }, ctx), { out: 100, in: 80, fade: 0 });
  assert.deepEqual(normalizeDraft({ out: -5, in: -10, fade: -20 }, ctx), { out: 0, in: 0, fade: 0 });
  assert.deepEqual(normalizeDraft({ out: 95, in: 0, fade: 60 }, ctx), { out: 95, in: 0, fade: 5 });
});

test('zero and unknown durations are unconstrained and junk times stay finite', () => {
  for (const value of [undefined, null, 0, -10, NaN, Infinity]) {
    const ctx = { durationOut: value, durationIn: value };
    assert.deepEqual(normalizeDraft({ out: 90, in: 120, fade: 100 }, ctx), { out: 90, in: 120, fade: 60 });
    assert.deepEqual(normalizeDraft({ out: null, in: null, fade: 10 }, ctx), { out: 0, in: 0, fade: 10 });
    assert.deepEqual(normalizeDraft({ out: NaN, in: Infinity, fade: 'bad' }, ctx), { out: 0, in: 0, fade: 0 });
    assert.deepEqual(normalizeDraft(null, ctx), { out: 0, in: 0, fade: 0 });
  }
  assert.deepEqual(normalizeDraft({ out: 90, in: 120, fade: 20 }, { durationOut: 0, durationIn: 125 }),
    { out: 90, in: 120, fade: 5 });
});

test('layout aligns media points and limits overlap at either song end', () => {
  const ctx = { durationOut: 100, durationIn: 80 };
  assert.deepEqual(layout({ out: 90, in: 10, fade: 8 }, ctx), {
    total: 160, fromStart: 0, fromEnd: 100, toStart: 80, toEnd: 160, overlapStart: 90, overlapEnd: 98
  });
  const a = layout({ out: 98, in: 10, fade: 8 }, ctx);
  assert.equal(a.overlapEnd, a.fromEnd);
  const b = layout({ out: 90, in: 79, fade: 8 }, ctx);
  assert.equal(b.overlapEnd, b.toEnd);
  const past = layout({ out: 120, in: 0, fade: 8 }, ctx);
  assert.equal(past.overlapStart, 100);
  assert.equal(past.overlapEnd, 100);
  assert.equal(layout({ out: null, in: null, fade: 8 }, ctx).overlapStart, 92);
});

test('layout shifts both waveforms when in exceeds out', () => {
  const draft = Object.freeze({ out: 10, in: 30, fade: 8 });
  const result = layout(draft, { durationOut: 100, durationIn: 80 });
  assert.deepEqual(result, {
    total: 120, fromStart: 20, fromEnd: 120, toStart: 0, toEnd: 80, overlapStart: 30, overlapEnd: 38
  });
  assert.equal(result.fromStart + draft.out, result.toStart + draft.in);
});

test('unknown lengths give layout finite drawing bounds covering the transition', () => {
  for (const ctx of [{}, { durationOut: 0, durationIn: 0 }]) {
    assert.deepEqual(layout({ out: 10, in: 30, fade: 8 }, ctx), {
      total: 38, fromStart: 20, fromEnd: 38, toStart: 0, toEnd: 38, overlapStart: 30, overlapEnd: 38
    });
    assert.deepEqual(layout({}, ctx), {
      total: 0, fromStart: 0, fromEnd: 0, toStart: 0, toEnd: 0, overlapStart: 0, overlapEnd: 0
    });
  }
});

test('visible window zooms into the overlap of a 17-minute mix and a 4-minute song', () => {
  const result = layout({ out: null, in: 16, fade: 12 }, { durationOut: 17 * 60, durationIn: 4 * 60 });
  assert.equal(result.total, 1232);
  assert.deepEqual(visibleWindow(result, {}), { start: 1000, end: 1028 });
  assert.deepEqual(visibleWindow(result, { padding: 2 }), { start: 1006, end: 1022 });
  assert.deepEqual(visibleWindow(result, { padding: 0 }), { start: 1008, end: 1020 });
});

test('visible window clamps padding at timeline boundaries and handles a cut', () => {
  assert.deepEqual(visibleWindow({ total: 10, overlapStart: 2, overlapEnd: 7 }, {}), { start: 0, end: 10 });
  assert.deepEqual(visibleWindow({ total: 20, overlapStart: 10, overlapEnd: 10 }, { padding: 2 }), { start: 8, end: 12 });
  assert.deepEqual(visibleWindow({ total: 0, overlapStart: 0, overlapEnd: 0 }, {}), { start: 0, end: 0 });
  assert.deepEqual(visibleWindow({ total: 20, overlapStart: 5, overlapEnd: 10 }, { padding: -2 }), { start: 5, end: 10 });
});

test('moving points returns new normalized drafts, snapped when bpm is known', () => {
  const draft = Object.freeze({ out: 10, in: 4, fade: 8 });
  const ctx = { durationOut: 100, durationIn: 80 };
  const moved = moveOut(draft, 1.2, ctx);
  assert.notEqual(moved, draft);
  assert.deepEqual(moved, { out: 11.2, in: 4, fade: 8 });
  assert.deepEqual(moveIn(draft, 1.2, ctx), { out: 10, in: 5.2, fade: 8 });
  assert.deepEqual(moveOut(draft, 1.2, { ...ctx, bpm: 120, downbeat: 0.5 }), { out: 10.5, in: 4, fade: 8 });
  assert.deepEqual(moveIn(draft, 1.2, { ...ctx, bpm: 120, downbeat: 0.5 }), { out: 10, in: 4.5, fade: 8 });
  assert.deepEqual(moveOut(draft, 200, ctx), { out: 100, in: 4, fade: 0 });
  assert.deepEqual(moveIn(draft, 200, ctx), { out: 10, in: 80, fade: 0 });
  assert.deepEqual(moveOut(draft, -200, ctx), { out: 0, in: 4, fade: 8 });
  assert.deepEqual(moveIn(draft, -200, ctx), { out: 10, in: 0, fade: 8 });
});

test('moving resolves null points and preserves automatic out placement when moving in', () => {
  const ctx = { durationOut: 100, durationIn: 80 };
  assert.deepEqual(moveOut({ out: null, in: null, fade: 8 }, -2, ctx), { out: 90, in: 0, fade: 8 });
  assert.deepEqual(moveIn({ out: null, in: null, fade: 8 }, 78, ctx), { out: 98, in: 78, fade: 2 });
  assert.deepEqual(moveIn({ out: null, in: null, fade: 8 }, 5, {}), { out: 0, in: 5, fade: 8 });
});

test('presets have the specified order, labels, styles and curves', () => {
  assert.deepEqual(PRESETS, [
    { id: 'auto', label: 'Auto', style: 'auto', curve: null },
    { id: 'smooth', label: 'Smooth', style: 'blend', curve: { dj: 0 } },
    { id: 'swap', label: 'DJ swap', style: 'blend', curve: { dj: 1, center: 0.5 } },
    { id: 'early', label: 'Early', style: 'blend', curve: { dj: 1, center: 0.3 } },
    { id: 'late', label: 'Late', style: 'blend', curve: { dj: 1, center: 0.7 } },
    { id: 'dropcut', label: 'Drop cut', style: 'dropcut', curve: null }
  ]);
  for (const preset of PRESETS) assert.equal(presetFor(preset.style, preset.curve), preset.id);
});

test('preset matching distinguishes defaults, custom curves and nearby centers', () => {
  assert.equal(presetFor('', null), 'default');
  assert.equal(presetFor(undefined, undefined), 'default');
  assert.equal(presetFor('blend', { dj: 1 }), 'swap');
  assert.equal(presetFor('blend', { dj: 1, center: 0.30001 }), 'early');
  assert.equal(presetFor('blend', { dj: 1, center: 0.31 }), 'custom');
  assert.equal(presetFor('blend', { dj: 0, center: 0.7 }), 'smooth');
  assert.equal(presetFor('blend', { dj: 0.5, center: 0.5 }), 'custom');
  assert.equal(presetFor('auto', { dj: 1 }), 'custom');
  assert.equal(presetFor('', { dj: 0 }), 'custom');
  assert.equal(presetFor('blend', { dj: NaN }), 'custom');
  assert.equal(presetFor('unknown', null), 'custom');
});

test('curve normalization rejects junk and clamps valid settings without mutation', () => {
  for (const curve of [undefined, null, false, 0, 1, 'bad', [], {}, { center: 0.3 },
    { dj: NaN }, { dj: Infinity }, { dj: 'bad' }, { dj: null }, { dj: [] }, { dj: Symbol('bad') }]) {
    assert.equal(normalizeCurve(curve), null);
  }
  const curve = Object.freeze({ dj: 2, center: -2, extra: 'discard' });
  assert.deepEqual(normalizeCurve(curve), { dj: 1, center: 0.15 });
  assert.deepEqual(normalizeCurve({ dj: -1, center: 0.7 }), { dj: 0 });
  assert.deepEqual(normalizeCurve({ dj: 0.5, center: 5 }), { dj: 0.5, center: 0.85 });
  assert.deepEqual(normalizeCurve({ dj: true }), { dj: 1, center: 0.5 });
  assert.deepEqual(normalizeCurve({ dj: false }), { dj: 0 });
  for (const center of [undefined, null, NaN, Infinity, 'bad', {}, Symbol('bad')]) {
    assert.deepEqual(normalizeCurve({ dj: 1, center }), { dj: 1, center: 0.5 });
  }
  const shape = normalizeCurve(curve);
  assert.deepEqual(normalizeCurve(shape), shape);
});

test('pointer mapping uses the curve center clamp', () => {
  assert.equal(centerFromPointer(0), 0.15);
  assert.equal(centerFromPointer(1), 0.85);
  assert.equal(centerFromPointer(-2), 0.15);
  assert.equal(centerFromPointer(3), 0.85);
  assert.equal(centerFromPointer(0.3), 0.3);
  assert.equal(centerFromPointer(NaN), 0.5);
});

test('curve samples call the injected engine function with fadeIn, t, shape', () => {
  for (const fadeIn of [false, true]) {
    const calls = [];
    const fadeLevel = (incoming, t, shape) => {
      calls.push({ incoming, t, shape });
      return (incoming ? t : 1 - t) * shape.dj;
    };
    const points = curvePoints({ dj: 0.5, center: 2 }, fadeIn, 5, fadeLevel);
    assert.deepEqual(points.map(point => point.t), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(points.map(point => point.level), fadeIn ? [0, 0.125, 0.25, 0.375, 0.5] : [0.5, 0.375, 0.25, 0.125, 0]);
    assert.equal(calls.length, 5);
    calls.forEach((call, i) => assert.deepEqual(call, { incoming: fadeIn, t: i / 4, shape: { dj: 0.5, center: 0.85 } }));
  }
});

test('curve sampling defaults to 33 points and passes null for invalid curves', () => {
  const fadeLevel = (fadeIn, t, shape) => {
    assert.equal(shape, null);
    return fadeIn ? Math.sin(t * Math.PI / 2) : Math.cos(t * Math.PI / 2);
  };
  const points = curvePoints(null, true, undefined, fadeLevel);
  assert.equal(points.length, 33);
  assert.deepEqual(points[0], { t: 0, level: 0 });
  assert.deepEqual(points.at(-1), { t: 1, level: 1 });
  assert.equal(points[16].level, Math.sin(Math.PI / 4));
  for (const count of [0, 1, -1]) {
    assert.deepEqual(curvePoints('bad', true, count, fadeLevel), [{ t: 0, level: 0 }, { t: 1, level: 1 }]);
  }
});

test('applyCurve makes both songs use the pair curve, with or without the bass swap', async () => {
  const { applyCurve } = await import('../src/js/transition-model.js');
  const plain = () => ({ bass: false, shapeIn: null, shapeOut: null, bassOpts: undefined });
  const off = plain();
  assert.equal(applyCurve(off, { dj: 1, center: 0.3 }), true);
  assert.deepEqual(off.shapeIn, { dj: 1, center: 0.3 });
  assert.deepEqual(off.shapeOut, { dj: 1, center: 0.3 });
  assert.equal(off.bassOpts, undefined, 'no bass swap, nothing to keep in step');

  const on = { bass: true, shapeIn: { dj: 0.4 }, shapeOut: { dj: 0.4 }, bassOpts: { center: 0.5, corner: 90, eq: 0.4 } };
  applyCurve(on, { dj: 1, center: 0.7 });
  assert.deepEqual(on.shapeIn, { dj: 1, center: 0.7 });
  assert.deepEqual(on.bassOpts, { center: 0.7, corner: 90, eq: 1 });

  const smooth = { bass: true, shapeIn: { dj: 1 }, shapeOut: { dj: 1 }, bassOpts: { center: 0.3, eq: 1 } };
  applyCurve(smooth, { dj: 0 });
  assert.deepEqual(smooth.shapeOut, { dj: 0 });
  assert.deepEqual(smooth.bassOpts, { eq: 0 }, 'a smooth curve has no handover point, so the centre returns to the default');

  const keep = { bass: true, shapeIn: { dj: 1 }, shapeOut: { dj: 1 }, bassOpts: { center: 0.4, eq: 1 } };
  for (const junk of [null, undefined, 'x', { dj: 'a' }]) assert.equal(applyCurve(keep, junk), false);
  assert.deepEqual(keep, { bass: true, shapeIn: { dj: 1 }, shapeOut: { dj: 1 }, bassOpts: { center: 0.4, eq: 1 } });
});
