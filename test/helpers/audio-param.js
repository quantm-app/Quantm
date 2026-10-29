// Makes a fake AudioParam enforce what Chromium's Web Audio enforces about automation, so a real overlap fails in tests
// instead of only in the live app. The fake keeps its own event shapes; this wraps its four scheduling methods.
//
// - setValueCurveAtTime(curve, t, d) throws NotSupportedError when any other event lies strictly between t and t + d (an event exactly at t is fine, per the spec) or another
//   curve overlaps it, and when the curve or duration is unusable.
// - any event that lands inside a running curve throws the same way (the curve owns the parameter until it ends).
// - an event scheduled in the past is moved up to the context's current time (Chromium does this, and it is how a
//   "now" hold can end up after a curve that was started with an earlier reading of the clock).
// - cancelScheduledValues(t) drops every event at or after t, and any curve still running at t.

const notSupported = (message) => Object.assign(new Error(message), { name: 'NotSupportedError' });

/**
 * @param param the fake param (its methods keep working as before)
 * @param clock () => the context's true current time, read when a method is called (not the value the code read earlier)
 */
export function strictParam(param, clock) {
  const timeline = [];                       // { t, end } (end > t for a curve)
  const insideCurve = (t) => timeline.find(e => e.end > e.t && t > e.t && t < e.end);
  const check = (t, what) => {
    const curve = insideCurve(t);
    if (curve) throw notSupported(`${what} at ${t} overlaps setValueCurveAtTime(${curve.t}, ${curve.end - curve.t})`);
  };
  const wrap = (name, schedule) => {
    if (!param[name]) return;
    const original = param[name].bind(param);
    param[name] = (...args) => { schedule(...args); return original(...args); };
  };
  // keep the fake's own recorded times honest too: a moved-up event is recorded where Chromium would put it
  for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
    if (!param[name]) continue;
    const original = param[name].bind(param);
    param[name] = (...args) => {
      const t = Math.max(args[1], clock());
      check(t, name);
      timeline.push({ t, end: t });
      return original(args[0], t, ...args.slice(2));
    };
  }
  wrap('setValueCurveAtTime', (curve, t, d) => {
    if (!(curve?.length >= 2) || !Number.isFinite(t) || !(d > 0)) throw notSupported('setValueCurveAtTime: unusable curve or duration');
    const end = t + d;
    const clash = timeline.find(e => (e.end > e.t ? e.t < end && t < e.end : e.t > t && e.t < end));
    if (clash) throw notSupported(`setValueCurveAtTime(..., ${t}, ${d}) overlaps an event at ${clash.t}`);
    timeline.push({ t, end });
  });
  wrap('cancelScheduledValues', (t) => {
    for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].t >= t || timeline[i].end > t) timeline.splice(i, 1);
  });
  param.timeline = timeline;
  return param;
}

/**
 * A context clock that moves on after every read, the way the audio thread does between two lines of JavaScript.
 * `ctx.time` is the true time (what an engine call sees); reading `ctx.currentTime` returns it, then ticks one quantum.
 */
export function tickingClock(ctx, start = 1, quantum = 128 / 48000) {
  ctx.time = start;
  Object.defineProperty(ctx, 'currentTime', { get() { const now = ctx.time; ctx.time += quantum; return now; }, configurable: true });
  return ctx;
}
