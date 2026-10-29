// Drop cuts use media times for planning and AudioContext times for every audible edge.
// The outgoing roll needs only modest tempo/phase confidence. The incoming
// phrase has already passed the stricter beat and bass-return confirmation.
export const confident = grid => grid?.confidence >= 0.25 && grid.period > 0 && Number.isFinite(grid.offset);
const stamp = time => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;

/** Only the incoming drop must be confirmed. The outgoing grid enables the optional roll. */
export function planStyle({ style = 'auto', pair, drop, gridOut, match, features = [], rejected = false, ready = true, clash = false }) {
  const wanted = ['auto', 'blend', 'dropcut'].includes(pair?.style) ? pair.style : style;
  const blend = reason => ({ style: 'blend', reason: `${reason}: smooth blend` });
  if (wanted === 'blend') return blend('Smooth blend selected');
  if (!drop || !Number.isFinite(drop.time) || drop.time < 0 || !(drop.confidence >= 0.65)) return blend('No clear drop');
  if (!ready) return blend('Drop audio not ready in time');
  if (wanted !== 'dropcut') {
    if (rejected) return blend('Recent drop cuts skipped at this tempo');
    // keys that clash are best not blended at all: a drop cut hides it, so Auto takes one whenever the pair
    // has a confirmed drop and the song is ready, whatever the genre or energy
    const suitable = clash || features.length === 2 && features.every(f => {
      const tags = [f?.genre, f?.title, ...(f?.tags || [])].join(' ');
      return /electro|dance|house|techno|trance|dubstep|ridd?im|riddm|trap|festival|big.?room|bass|dnb|drum.*bass|hyperpop|hardstyle|edm|club|rave/i.test(tags) &&
        (!f.energy || f.energy.overall >= 0.45);
    });
    if (!suitable) return blend('Energy or genre favors a blend');
  }
  const variant = confident(gridOut || match?.gridOut) ? 'roll' : 'echo';
  return { style: 'dropcut', variant, reason: `${clash && wanted !== 'dropcut' ? 'Keys clash, so a drop cut. ' : ''}Drop at ${stamp(drop.time)}, confidence ${drop.confidence.toFixed(2)}; ${variant === 'roll' ? 'loop roll + high-pass + echo' : 'high-pass + echo (weak outgoing grid, no loop roll)'}`, drop };
}

/** End on a phrase; a mix-out remains the build's start. Prefer the remembered outro. */
export function buildWindow(grid, duration, { out = null, outroStart = null } = {}) {
  if (!confident(grid) || !Number.isFinite(duration)) return null;
  const origin = grid.downbeat ?? grid.offset;
  const phrase = grid.period * 32;
  if (out != null) {
    if (!(out >= 0)) return null;
    const cut = origin + Math.ceil((out + 16 * grid.period - origin) / phrase - 1e-8) * phrase;
    return cut <= duration - grid.period && cut - out <= 32 * grid.period + 0.01 ? { build: out, cut } : null;
  }
  const cut = origin + Math.floor((duration - grid.period - origin) / phrase) * phrase;
  const bars = outroStart != null && cut - outroStart >= 16 * grid.period && cut - outroStart < 32 * grid.period ? 4 : 8;
  const build = cut - bars * 4 * grid.period;
  return build >= 0 ? { build, cut } : null;
}

/** Prefer eight bars on the planned phrase, then later phrases/bars or four/two bars. */
export function futureWindow(grid, duration, { now = 0, rate = 1, dropTime, ratio = 1,
  out = null, outroStart = null, variant = 'roll', margin = 0.3, buildBeats = null } = {}) {
  if (!(grid?.period > 0) || ![duration, now, rate, dropTime, ratio].every(Number.isFinite) || rate <= 0 || ratio <= 0) return null;
  const beat = grid.period, origin = grid.downbeat ?? grid.offset;
  const end = duration - Math.max(beat, 0.5 * rate);
  const preferred = variant === 'echo' ? { build: out ?? end - 16 * beat, cut: end } :
    buildWindow(grid, end + beat, { out, outroStart });
  const firstCut = preferred?.cut ?? origin + Math.floor((end - origin) / (32 * beat)) * 32 * beat;
  const preferredLength = preferred ? preferred.cut - preferred.build : 32 * beat;
  // the quick cut asks for a build of exactly this many beats; otherwise prefer eight bars, then four or two
  const lengths = buildBeats ? [buildBeats * beat] : [...new Set([preferredLength, ...[32, 16, 8].map(n => n * beat)])]
    .filter(length => length >= 8 * beat - 1e-8 && length <= Math.min(32 * beat, preferredLength) + 1e-8);
  for (const length of lengths) {
    const room = dropTime / ratio - length;
    if (room < 0.15 * rate) continue;
    const earliest = Math.max(now + margin * rate, out ?? 0) + length;
    const snap = stride => origin + Math.ceil((Math.max(firstCut, earliest) - origin) / stride - 1e-8) * stride;
    for (const cut of [firstCut, snap(32 * beat), snap(4 * beat)]) {
      const build = out != null && preferred?.cut === cut && preferred.cut - out === length ? out : cut - length;
      if (cut > end + 1e-8 || build < now + margin * rate - 1e-8 || build < (out ?? 0)) continue;
      return { build, cut, lead: Math.min(1.5 * rate, room) };
    }
  }
  return null;
}

/**
 * Accelerating 1, 1/2, 1/4 and 1/8 beat slices, then a 1/4-beat breath.
 * options (the quick cut; none = the Drop cut): breath (seconds of silence before the drop),
 * stutter: false (no loop roll), echo: false (no echo), minBeats (shortest build, default 8),
 * kill: { style: 'none' } for no high-pass sweep (the default sweeps to 2400 Hz).
 */
export function rollSchedule(start, beat, beats = 32, variant = 'roll', options = {}) {
  const { breath = beat / 4, minBeats = 8, kill = null } = options;
  if (![start, beat, beats, breath].every(Number.isFinite) || start < 0 || beat <= 0 || breath < 0 || beats < minBeats - 1e-8 || beats > 32 + 1e-8) return null;
  beats = Math.max(minBeats, Math.min(32, beats));
  if (breath >= beats * beat) return null;
  const drop = start + beats * beat;
  const cut = drop - breath;
  const rollBeats = beats >= 24 ? 16 : beats >= 16 ? 8 : 4;
  // without a loop roll the dry song plays to the cut, like the echo variant
  if (options.stutter === false) variant = 'echo';
  const stages = (variant === 'echo' ? [] : [1, 0.5, 0.25, 0.125]).map((fraction, i) => {
    const at = drop - (rollBeats - i * rollBeats / 4) * beat;
    const end = i === 3 ? cut : at + rollBeats / 4 * beat;
    const repeats = [];
    for (let t = at; t < end - 1e-8; t += fraction * beat) repeats.push(t);
    return { fraction, at, end, capture: at - fraction * beat, delay: fraction * beat, repeats };
  });
  const schedule = { start, beat, drop, cut, roll: stages[0]?.at ?? drop - 4 * beat, stages, end: drop + beat * 2, variant };
  if (options.echo === false) schedule.echo = false;
  if (kill?.style === 'none') schedule.kill = { style: 'none' };
  return schedule;
}

export function dropPhase(schedule, now) {
  return now >= schedule.drop ? 'drop' : now >= schedule.cut ? 'cut' : now >= schedule.roll ? (schedule.variant === 'echo' ? 'echo' : 'roll') : 'build';
}

/** Disposable graph. Bypassed decks keep their original direct connection and allocate no effects. */
export class DropCutEffect {
  constructor(ctx, source, destination, schedule) {
    this.ctx = ctx;
    this.source = source;
    this.destination = destination;
    this.nodes = [];
    try {
      const node = method => { const n = method === 'createDelay' ? ctx.createDelay(8) : ctx[method](); this.nodes.push(n); return n; };
      const gain = value => { const n = node('createGain'); n.gain.value = value; return n; };
      const gate = (param, at, end, value = 1) => {
        param.setValueAtTime(0, at);
        param.linearRampToValueAtTime(value, at + 0.002);
        param.setValueAtTime(value, end - 0.002);
        param.linearRampToValueAtTime(0, end);
      };
      this.input = gain(1);
      const dry = gain(1);
      const highpass = this.highpass = node('createBiquadFilter');
      highpass.type = 'highpass';
      highpass.Q.value = 1.2;
      highpass.frequency.value = 0;
      highpass.frequency.setValueAtTime(25, schedule.start);
      if (schedule.kill?.style !== 'none') highpass.frequency.exponentialRampToValueAtTime(2400, schedule.cut);
      this.input.connect(dry).connect(highpass).connect(destination);
      const dryEnd = schedule.variant === 'echo' ? schedule.cut : schedule.roll;
      dry.gain.setValueAtTime(1, dryEnd - 0.002);
      dry.gain.linearRampToValueAtTime(0, dryEnd);
      const echo = node('createDelay');
      echo.delayTime.value = schedule.beat * 0.375;
      const feedback = gain(0.4), echoFilter = node('createBiquadFilter'), wet = gain(0);
      // Audio-clock shutdown also works when the UI thread's completion timer is delayed.
      feedback.gain.setValueAtTime(0.4, schedule.roll);
      feedback.gain.setValueAtTime(0, schedule.end);
      echoFilter.type = 'highpass';
      echoFilter.frequency.value = 700;
      echo.connect(echoFilter).connect(feedback).connect(echo);
      echo.connect(wet).connect(highpass);
      const echoLevel = schedule.echo === false ? 0 : 1; // a cut without an echo
      gate(wet.gain, schedule.roll, schedule.end, 0.3 * echoLevel);
      if (schedule.variant === 'echo') {
        const send = gain(0);
        this.input.connect(send).connect(echo);
        gate(send.gain, schedule.roll, schedule.cut, 0.6 * echoLevel);
      }
      for (const stage of schedule.stages) {
        const capture = gain(0), delay = node('createDelay'), loop = gain(0), output = gain(0);
        delay.delayTime.value = stage.delay;
        this.input.connect(capture).connect(delay);
        // Capture precisely one slice, then close the input and recirculate that slice.
        capture.gain.setValueAtTime(1, stage.capture);
        capture.gain.setValueAtTime(0, stage.at);
        delay.connect(loop).connect(delay);
        loop.gain.setValueAtTime(1, stage.at);
        loop.gain.setValueAtTime(0, stage.end);
        delay.connect(output).connect(highpass);
        output.connect(echo);
        // A tiny envelope on each repeat avoids clicks when a slice isn't zero-crossing aligned.
        for (const at of stage.repeats) gate(output.gain, at, Math.min(stage.end, at + stage.delay), 0.85);
      }
      source.disconnect(destination);
      this.rerouted = true;
      source.connect(this.input);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (this.rerouted) {
      // connect() may have failed after removing the bypass.
      try { this.source.disconnect(this.input); } catch { /* already disconnected */ }
      this.source.connect(this.destination);
      this.rerouted = false;
    }
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }
}
