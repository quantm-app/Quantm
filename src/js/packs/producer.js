import { h, clear } from '../dom.js';
import { isLocked, openInSoundCloud, waveform } from '../ui.js';
import * as api from '../api.js';
import { motionAllowed } from '../audio-reactivity.js';
import { curveKey, curveValues, curvePath, curveProgress } from '../mix-curves.js';

// songs drawn after the current one in the Playlist lanes and the Channel Rack (matches the mini-waveform limit it had)
export const DRAWN_AFTER = 16;
const clamp = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export const gridTempo = grid => Number.isFinite(grid?.bpm) && grid.bpm > 0 ? grid.bpm :
  Number.isFinite(grid?.period) && grid.period > 0 ? 60 / grid.period : 0;
export const formatTempo = bpm => Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(3) : '---.---';
// Four beats per bar, four sixteenth-note steps per beat. Media time, not wall time:
// pausing, seeking, rate changes and a non-zero beat-grid origin stay in phase.
const ticksAt = (position, bpm, offset = 0) => Math.floor(
  ((Number.isFinite(position) ? position : 0) - (Number.isFinite(offset) ? offset : 0)) * bpm / 60 * 4 + 1e-7);
export function formatPosition(position, bpm, offset = 0) {
  if (!(Number.isFinite(bpm) && bpm > 0)) return '---:--:--';
  const ticks = Math.max(0, ticksAt(position, bpm, offset));
  return [Math.floor(ticks / 16) + 1, Math.floor(ticks / 4) % 4 + 1, ticks % 4 + 1]
    .map((value, i) => String(value).padStart(i ? 2 : 3, '0')).join(':');
}
export const stepIndex = (position, bpm, offset = 0) => Number.isFinite(bpm) && bpm > 0 ? ((ticksAt(position, bpm, offset) % 16) + 16) % 16 : -1;
// The lit step follows playback and the known tempo only. It is one discrete highlight, not
// an animation, so the motion setting must not gate it (CSS drops the glow instead).
export const playingStep = (playing, position, bpm, offset = 0) => playing ? stepIndex(position, bpm, offset) : -1;

// Live tempo detection wanders. Keep showing the held value until a different one (more than
// 1.5 BPM away) has stayed put for 2 s; a new track key or an unknown tempo resets at once.
const TEMPO_DELTA = 1.5, TEMPO_HOLD_MS = 2000;
export function stableTempo(state, bpm, now, key) {
  const next = Number.isFinite(bpm) && bpm > 0 ? bpm : 0;
  if (!state || state.key !== key || !state.shown || !next) return { key, shown: next, pending: next, since: now };
  if (Math.abs(next - state.shown) <= TEMPO_DELTA) return state.pending === state.shown ? state : { ...state, pending: state.shown, since: now };
  if (Math.abs(next - state.pending) > TEMPO_DELTA) return { ...state, pending: next, since: now };
  return now - state.since >= TEMPO_HOLD_MS ? { key, shown: next, pending: next, since: now } : state;
}

// Ruler labels sit every N bars, N a power of two, so neighbours stay at least `gap` px apart.
export const timelineWidth = bars => Math.max(640, Math.min(16000, bars * 12));
export function barStep(bars, width, gap = 56) {
  const per = width / Math.max(1, bars);
  let step = 1;
  while (per * step < gap && step < 4096) step *= 2;
  return step;
}
export const rulerBars = (bars, step) => Array.from({ length: Math.ceil(Math.max(1, bars) / step) }, (_, i) => 1 + i * step);

// Per-track peak summaries for the clip mini waveforms (small, cached, never fetched twice at once).
export function peaksOf(samples, count = 160) {
  if (!samples?.length) return null;
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor(i * samples.length / count), to = Math.max(from + 1, Math.floor((i + 1) * samples.length / count));
    let peak = 0;
    for (let j = from; j < to && j < samples.length; j++) peak = Math.max(peak, Number(samples[j]) || 0);
    return clamp(peak);
  });
}
const peakCache = new Map(), peakPending = new Map();
function peaksFor(track) {
  if (peakCache.has(track.id)) return Promise.resolve(peakCache.get(track.id));
  if (!peakPending.has(track.id)) {
    peakPending.set(track.id, Promise.resolve().then(() => api.waveform(track)).then(samples => {
      const peaks = peaksOf(samples);
      if (peaks) {
        if (peakCache.size >= 96) peakCache.delete(peakCache.keys().next().value);
        peakCache.set(track.id, peaks);
      }
      return peaks;
    }).catch(() => null).finally(() => peakPending.delete(track.id)));
  }
  return peakPending.get(track.id);
}
function drawPeaks(canvas, peaks) {
  const g = peaks && canvas.getContext?.('2d');
  if (!g) return;
  canvas.width = peaks.length * 2; canvas.height = 48;
  const mid = canvas.height / 2;
  g.fillStyle = '#fff';
  peaks.forEach((peak, i) => { const half = Math.max(1, peak * (mid - 1)); g.fillRect(i * 2, mid - half, 1, half * 2); });
}

function svg(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  node.append(...children);
  return node;
}

function automation() {
  const paths = ['fade-out', 'fade-in', 'eq-out', 'eq-in'].map(name => svg('path', { class: `pr-curve pr-${name}` }));
  const cursor = svg('path', { class: 'pr-automation-cursor' });
  const graph = svg('svg', { class: 'pr-automation-graph', viewBox: '0 0 600 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, ...paths, cursor);
  const label = h('p.pr-automation-label');
  const legend = h('p.pr-caption');
  const node = h('section.pr-automation.pr-panel', { 'aria-label': 'Auto mix automation' },
    h('header.pr-titlebar', h('h2', 'Automation'), legend), h('div.pr-panel-body', graph, label));
  let key;
  return { node, update(player, status, moving) {
    const mix = player.autoMix ? status.mix : null;
    node.dataset.active = String(!!mix);
    const f = player.fading;
    const drop = mix?.style === 'dropcut';
    legend.textContent = drop ? 'Cut A / B + high-pass build (dashed)' : 'Crossfade A / B + mid EQ (dashed)';
    const shapeKey = curveKey(f, drop);
    if (key !== shapeKey) {
      key = shapeKey;
      const { fadeOut, fadeIn, eqOut, eqIn } = curveValues(f, drop);
      [fadeOut, fadeIn, eqOut, eqIn].forEach((values, index) => paths[index].setAttribute('d', curvePath(values)));
    }
    const progress = curveProgress(f, drop, player.normalizer?.ctx?.currentTime, mix?.progress);
    cursor.setAttribute('d', moving && mix ? `M${progress * 600},0 V100` : '');
    label.textContent = mix ? `${mix.from?.title || 'A'} > ${mix.to?.title || 'B'} / ${Math.round(progress * 100)}%${drop ? ` / ${mix.phase || 'build'}` : ''}` : 'No active transition / Auto mix writes these lanes';
  } };
}

// Output display (scope / spectrum) and its peak meters. Pure helpers first; they only read analyser bytes.
export const OUTPUT_MODE_KEY = 'quantm.producer.outputMode';
export const parseOutputMode = value => value === 'spectrum' ? 'spectrum' : 'scope';
export function readOutputMode(storage) {
  try { return parseOutputMode((storage || localStorage).getItem(OUTPUT_MODE_KEY)); } catch (e) { return 'scope'; }
}
export function writeOutputMode(mode, storage) {
  try { (storage || localStorage).setItem(OUTPUT_MODE_KEY, parseOutputMode(mode)); } catch (e) { /* storage can be blocked */ }
}
// Log-spaced bars from `low` to `high` Hz, as fractional analyser-bin ranges (bin 0 is DC, so start at 1).
export function spectrumSpans(count, sampleRate, fftSize, low = 30, high = 16000) {
  const binHz = sampleRate / fftSize;
  if (!(binHz > 0) || !(count > 0)) return [];
  const top = Math.min(high, sampleRate / 2), bins = fftSize / 2;
  const edge = i => Math.min(bins, Math.max(1, low * (top / low) ** (i / count) / binHz));
  return Array.from({ length: count }, (_, i) => ({ lo: edge(i), hi: edge(i + 1) }));
}
// 0..1 level of one bar: a span inside a single bin interpolates between its neighbours,
// a wider one takes the loudest bin it covers.
export function spanLevel(data, { lo, hi }) {
  const last = data.length - 1;
  if (last < 0) return 0;
  if (hi - lo <= 1) {
    const pos = Math.min(last, (lo + hi) / 2), i = Math.floor(pos), f = pos - i;
    return clamp(((data[i] || 0) * (1 - f) + (data[Math.min(last, i + 1)] || 0) * f) / 255);
  }
  let peak = 0;
  for (let i = Math.floor(lo); i < Math.min(data.length, Math.ceil(hi)); i++) peak = Math.max(peak, data[i] || 0);
  return clamp(peak / 255);
}
// Analyser bytes cover -100..-30 dB. Show -95..-18 dB with a gentle curve, so loud music
// (bytes near full) keeps headroom and the bars show shape instead of a solid block.
export const spectrumCurve = level => level > 0 ? clamp((70 * level - 5) / 77) ** 1.4 : 0;
export function timePeak(wave) {
  let peak = 0;
  for (let i = 0; i < wave.length; i++) peak = Math.max(peak, Math.abs(wave[i] - 128) / 128);
  return peak;
}
// Peak amplitude (0..1) on a -48..0 dB meter scale.
export const meterScale = peak => peak > 0 ? clamp(1 + 20 * Math.log10(peak) / 48) : 0;
// Bar level: rises at once, falls back at 2 per second.
export const levelStep = (prev, level, dt) => level >= prev ? level : Math.max(level, prev - 2 * Math.max(0, dt || 0));
// Peak tick: jumps to a new high, stays 0.6 s, then falls back at half the scale per second
// (time left over when the hold ends counts towards the fall).
export function peakStep(state, level, dt) {
  const v = clamp(level), d = Math.max(0, dt || 0);
  if (v >= state.peak) return { peak: v, hold: 0.6 };
  const wait = Math.min(Math.max(0, state.hold), d);
  return { peak: Math.max(v, state.peak - 0.5 * (d - wait)), hold: Math.max(0, state.hold) - wait };
}

const OUTPUT_W = 116, OUTPUT_H = 42, OUTPUT_BARS = 48, OUTPUT_GREEN = '#7fd35a';
function paintOutput(g, mode, sample, spans) {
  const w = OUTPUT_W, hgt = OUTPUT_H;
  g.clearRect(0, 0, w, hgt);
  g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.1)';
  g.beginPath();
  if (mode === 'scope') { g.moveTo(0, hgt / 2 + 0.5); g.lineTo(w, hgt / 2 + 0.5); }
  else {
    for (const y of [0.25, 0.5, 0.75]) { g.moveTo(0, Math.round(hgt * y) + 0.5); g.lineTo(w, Math.round(hgt * y) + 0.5); }
    for (const f of [100, 1000, 10000]) { const x = Math.round(Math.log(f / 30) / Math.log(16000 / 30) * w) + 0.5; g.moveTo(x, 0); g.lineTo(x, hgt); }
  }
  g.stroke();
  if (mode === 'scope') {
    const wave = sample?.wave;
    g.strokeStyle = OUTPUT_GREEN; g.lineWidth = 1.5; g.lineJoin = 'round'; g.globalAlpha = wave ? 1 : 0.55;
    g.beginPath();
    if (wave?.length > 2) {
      const n = wave.length;
      const at = i => [i / (n - 1) * w, hgt / 2 - Math.max(-1, Math.min(1, (wave[i] - 128) / 128 * 1.5)) * (hgt / 2 - 2)];
      g.moveTo(...at(0));
      for (let i = 1; i < n - 1; i++) {
        const [x, y] = at(i), [nx, ny] = at(i + 1);
        g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      g.lineTo(...at(n - 1));
    } else { g.moveTo(0, hgt / 2); g.lineTo(w, hgt / 2); }
    g.stroke(); g.globalAlpha = 1;
    return;
  }
  const step = w / OUTPUT_BARS;
  for (let i = 0; i < OUTPUT_BARS; i++) {
    const level = sample?.freq && spans[i] ? spectrumCurve(spanLevel(sample.freq, spans[i])) : 0;
    const height = Math.max(1, Math.round(level * (hgt - 2)));
    g.fillStyle = OUTPUT_GREEN; g.globalAlpha = level ? 1 : 0.45;
    g.fillRect(i * step + 0.5, hgt - height, Math.max(1, step - 1), height);
    if (level) { g.fillStyle = '#d8ffc8'; g.fillRect(i * step + 0.5, hgt - height, Math.max(1, step - 1), 1); }
  }
  g.globalAlpha = 1;
}

// The output panel sits in the top bar before the search field, which gives up width. It needs the
// search field to stay at least 220 px wide: hide it below that, and show it again only once there
// is room for both (the panel takes about 206 px, which keeps the check from flickering).
export const outputFits = (searchWidth, shown, panelWidth = 206) => searchWidth >= (shown ? 220 : 220 + panelWidth);

// The recessed output panel: a button-wrapped canvas (click switches scope / spectrum) and L / R peak meters.
// `out` is { mode(), toggle() } from the mount. draw(null) paints the idle frame and empties the meters.
function outputPanel(out) {
  const canvas = h('canvas.pr-output-canvas', { 'aria-hidden': 'true' });
  const tag = h('span.pr-output-mode', { 'aria-hidden': 'true' });
  // app.js toggles playback on a bubbling document Space keydown and calls preventDefault, which would
  // cancel this button's native click. Stopping Space here keeps native activation (Enter is not a shortcut).
  const button = h('button.pr-output-view', { type: 'button', onclick: () => out.toggle(),
    onkeydown: e => { if (e.code === 'Space' || e.key === ' ') e.stopPropagation(); } }, canvas, tag);
  const fills = [h('i.pr-peak-fill'), h('i.pr-peak-fill')], ticks = [h('b.pr-peak-tick'), h('b.pr-peak-tick')];
  const peaks = h('span.pr-peaks', { 'aria-hidden': 'true', title: 'L / R linked level (shared mono analyser)' },
    ['L', 'R'].map((name, i) => h('span.pr-peak', h('em', name), h('span.pr-peak-bar', fills[i], ticks[i]))));
  const node = h('div.pr-output', button, peaks);
  let dead = false, shownLevel = -1, shownPeak = -1, spans = [], spansKey = '';
  function setMode(mode) {
    const next = mode === 'scope' ? 'spectrum' : 'scope';
    const label = `Output display: ${mode}. Click to switch to ${next}.`;
    tag.textContent = mode.toUpperCase();
    button.setAttribute('aria-label', label); button.setAttribute('title', label);
  }
  setMode(out.mode());
  return { node, setMode, destroy() { dead = true; }, draw(sample) {
    if (dead) return;
    const level = sample ? Math.round(clamp(sample.level) * 100) : 0, peak = sample ? Math.round(clamp(sample.peak) * 100) : 0;
    if (level !== shownLevel) { shownLevel = level; fills.forEach(fill => { fill.style.width = `${level}%`; }); }
    if (peak !== shownPeak) {
      shownPeak = peak;
      ticks.forEach(tick => { tick.style.left = `${peak}%`; tick.style.opacity = peak ? '1' : '0'; });
    }
    const g = canvas.getContext?.('2d');
    if (!g) return;
    const dpr = window.devicePixelRatio || 1, width = Math.round(OUTPUT_W * dpr);
    if (canvas.width !== width) { canvas.width = width; canvas.height = Math.round(OUTPUT_H * dpr); }
    g.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    const mode = out.mode();
    if (mode === 'spectrum' && sample?.freq) {
      const key = `${sample.sampleRate}/${sample.fftSize}`;
      if (key !== spansKey) { spansKey = key; spans = spectrumSpans(OUTPUT_BARS, sample.sampleRate, sample.fftSize); }
    }
    try { paintOutput(g, mode, sample, spans); } catch (e) { /* a canvas failure must not break the page */ }
  } };
}

// ui.js frees a waveform's listeners and ResizeObserver only when it sees the node leave the
// document, which never happens for a detached page. Attaching and removing it once triggers that.
function release(node) {
  if (!node) return;
  try { document.body.append(node); node.remove(); } catch (e) { node.remove?.(); }
}

// DAW-style top strip: big position/tempo LCDs and the playing song's seekable waveform.
function toolbar() {
  const position = h('span.pr-big-lcd', { dataset: { ghost: '888:88:88' } }, '---:--:--');
  const tempo = h('span.pr-big-lcd', { dataset: { ghost: '888.888' } }, '---.---');
  const lcds = h('div.pr-toolbar-lcds', { 'aria-hidden': 'true' },
    h('div', h('span.pr-caption', 'BAR : BEAT : STEP'), position),
    h('div', h('span.pr-caption', 'TEMPO / BPM'), tempo));
  const slot = h('div.pr-toolbar-wave');
  const node = h('section.pr-toolbar', { 'aria-label': 'Now playing waveform' }, h('div.pr-toolbar-row', lcds, slot));
  let shown, current = null;
  // The waveform is rebuilt per track; the old one is released explicitly.
  function build(track) {
    shown = track?.id ?? null;
    clear(slot); release(current); current = null;
    let wave = null;
    if (track) { try { wave = waveform(track, { height: 56 }); } catch (e) { wave = null; } }
    current = wave;
    slot.append(h('span.pr-caption.pr-wave-title', track ? `NOW PLAYING / ${track.title || 'Untitled track'}` : 'NO TRACK PLAYING'),
      wave || h('div.pr-wave-empty', { 'aria-hidden': 'true' }, track ? 'Waveform unavailable' : 'Play a song to see its waveform here'));
  }
  return { node, destroy() { release(current); current = null; }, update(track, readout) {
    if (shown === undefined || (track?.id ?? null) !== shown) build(track);
    if (position.textContent !== readout.position) position.textContent = readout.position;
    if (tempo.textContent !== readout.tempo) tempo.textContent = readout.tempo;
  } };
}

function workstation(container, ctx, moving) {
  const { player } = ctx;
  const lanes = h('div.pr-lanes');
  const ruler = h('div.pr-ruler', { 'aria-hidden': 'true' });
  const playhead = h('div.pr-playhead', { 'aria-hidden': 'true' });
  const timeline = h('div.pr-timeline', ruler, lanes, playhead);
  const heads = h('div.pr-head-list');
  const rack = h('div.pr-rack-rows');
  const curves = automation();
  const bar = toolbar();
  const browseBody = h('div.pr-panel-body.pr-browse-body');
  const browse = h('section.pr-browse.pr-panel', { hidden: true, 'aria-label': 'Browse music' },
    h('header.pr-titlebar', h('h2', 'Browser'), h('span.pr-caption', 'BROWSE MUSIC')), browseBody);
  let alive = true, browseStarted = false, browseCleanup;
  const reveal = () => browse.scrollIntoView?.({ block: 'start', behavior: moving() ? 'smooth' : 'auto' });
  const browseButton = h('button.btn', { type: 'button', 'aria-expanded': 'false', onclick: async () => {
    browse.hidden = !browse.hidden;
    browseButton.textContent = browse.hidden ? 'Browse music' : 'Close Browse';
    browseButton.setAttribute('aria-expanded', String(!browse.hidden));
    const opened = performance.now();
    if (!browse.hidden) reveal();
    if (browse.hidden || browseStarted) return;
    browseStarted = true;
    try {
      const home = await import('../views/home.js');
      if (!alive) return;
      const cleanup = await home.render(browseBody);
      if (!alive) { if (typeof cleanup === 'function') cleanup(); }
      else {
        browseCleanup = cleanup;
        // Scroll again once content is in, unless the reader has had time to move on.
        if (!browse.hidden && performance.now() - opened < 2500) reveal();
      }
    } catch (error) {
      if (alive) { browseStarted = false; browseBody.textContent = 'Browse could not load. Search and Library are available.'; }
    }
  } }, 'Browse music');
  const node = h('div.pr-home', bar.node,
    h('header.pr-header', h('div', h('p.pr-caption', 'PRODUCER / QUEUE SESSION'), h('h1', 'Producer')),
      h('div.pr-actions', h('a.btn', { href: '#/settings/automix' }, 'Auto mix'), browseButton)),
    browse,
    h('section.pr-arrangement.pr-panel', { 'aria-label': 'Playlist arrangement' },
      h('header.pr-titlebar', h('h2', 'Playlist'), h('span.pr-caption', 'BARS / 4:4 / Queue durations mapped to session tempo; unknown tempo uses a 120 BPM ruler')),
      h('div.pr-timeline-scroll', h('div.pr-playlist',
        h('div.pr-heads', h('div.pr-heads-corner', { 'aria-hidden': 'true' }, 'TRACKS'), heads), timeline))),
    h('section.pr-rack.pr-panel', { 'aria-label': 'Up next channel rack' },
      h('header.pr-titlebar', h('h2', 'Channel Rack'), h('span.pr-caption', 'UP NEXT / 16 STEPS')), rack),
    curves.node);
  container.append(node);
  let jobs = [];
  const dropJobs = () => { jobs.forEach(job => { job.canvas = null; }); jobs = []; };
  // Only the current song and the next DRAWN_AFTER are drawn (16 step buttons a song makes about 8,000 buttons
  // for a queue of 500). Clip positions and the timeline's length still come from the whole queue (layout()).
  let drawn = new Map(), shownTracks = [], shownFrom = -1;
  let starts = [], lengths = [], total = 1, cachedTempo = -1, lastStep = -2, lastIndex = -2, knownDuration = 0, laidIndex = -2;
  const choose = (track, index) => isLocked(track) ? openInSoundCloud(track) : player.jump(index);
  function makeRow(track, index) {
    const name = track.title || 'Untitled track';
    const title = `${isLocked(track) ? 'Open in SoundCloud' : 'Play'}: ${name}`;
    const colour = index % 8;
    const canvas = h('canvas.pr-clip-wave', { 'aria-hidden': 'true' });
    const clip = h('button.pr-clip', { type: 'button', title, onclick: () => choose(track, index) }, h('span.pr-clip-name', name), canvas);
    const lane = h('div.pr-lane', { dataset: { colour } }, clip);
    const head = h('div.pr-head', { dataset: { colour }, 'aria-hidden': 'true' }, h('i.pr-head-swatch'),
      h('span.pr-head-text', h('b', `Track ${index + 1}`), h('span', name)));
    const job = { canvas }; jobs.push(job);
    peaksFor(track).then(peaks => { if (job.canvas) drawPeaks(job.canvas, peaks); job.canvas = null; });
    const steps = Array.from({ length: 16 }, (_, step) => h('button.pr-step', {
      type: 'button', disabled: true, tabindex: '-1', 'aria-hidden': 'true', title: `Step ${step + 1}: playback indicator`
    }));
    const nameButton = h('button.pr-channel-name', { type: 'button', title, onclick: () => choose(track, index) }, name);
    const row = h('div.pr-channel', h('i.pr-led', { 'aria-hidden': 'true' }),
      h('span.pr-knobs', { 'aria-hidden': 'true' }, h('i.pr-knob.pr-pan'), h('i.pr-knob')),
      h('span.pr-mixer-num', { 'aria-hidden': 'true' }, String(index + 1)),
      nameButton, h('div.pr-steps', { 'aria-hidden': 'true' }, steps));
    return { row, lane, head, nameButton, clip, steps };
  }
  function queue() {
    const list = player.queue || [];
    const from = Math.max(0, player.index);
    const sameSongs = list.length === shownTracks.length && list.every((track, i) => track === shownTracks[i]);
    // nothing to draw again: same songs, same window (the second event of a handoff, or a refresh that changed nothing)
    if (sameSongs && from === shownFrom) { layout(); return; }
    // The rows still in the window are kept (so a handoff makes one new row); a changed queue starts clean.
    const keep = sameSongs ? drawn : new Map();
    if (!sameSongs) dropJobs();
    // retained rows forget which step and song were lit; update() lights them again
    for (const rec of keep.values()) {
      rec.row.setAttribute('data-current', 'false'); rec.head.setAttribute('data-current', 'false');
      rec.nameButton.setAttribute('aria-current', 'false'); rec.clip.setAttribute('aria-current', 'false');
      for (const step of rec.steps) step.setAttribute('data-lit', 'false');
    }
    lastStep = -2; lastIndex = -2;
    const to = Math.min(list.length, from + 1 + DRAWN_AFTER);
    const next = new Map();
    clear(lanes); clear(heads); clear(rack);
    for (let index = from; index < to; index++) {
      const rec = keep.get(index) || makeRow(list[index], index);
      next.set(index, rec);
      lanes.append(rec.lane); heads.append(rec.head); rack.append(rec.row);
    }
    drawn = next; shownTracks = list.slice(); shownFrom = from;
    if (!list.length) {
      lanes.append(h('p.pr-empty', 'Your Playlist is empty. Browse music or choose tracks from Search or Library.'));
      rack.append(h('p.pr-empty', 'Queued songs appear here. Use the player Queue for reordering and removal.'));
    } else if (to < list.length) {
      const more = `${list.length - to} more in the queue, not drawn here`;
      lanes.append(h('p.pr-more', more)); rack.append(h('p.pr-more', more));
    }
    layout();
  }
  // Clip positions come from track metadata, but the current track prefers the real media duration.
  function layout() {
    const media = player.duration;
    knownDuration = Number.isFinite(media) && media > 0 ? media : 0; laidIndex = player.index;
    starts = []; lengths = []; total = 0; cachedTempo = -1;
    (player.queue || []).forEach((track, index) => {
      const seconds = index === player.index && knownDuration ? knownDuration : Math.max(1, Number(track.duration) / 1000 || 120);
      starts.push(total); lengths.push(seconds); total += seconds;
    });
    total = Math.max(1, total);
    drawn.forEach(({ clip }, i) => {
      clip.style.left = `${starts[i] / total * 100}%`;
      clip.style.width = `${lengths[i] / total * 100}%`;
    });
  }
  // readout: { bpm (held tempo, drives the ruler), tempo, position } shared with the transport LCD.
  function update(status, grid, motion, readout) {
    const media = player.duration;
    if (laidIndex !== player.index || (Number.isFinite(media) && media > 0 ? media : 0) !== knownDuration) layout();
    if (cachedTempo !== readout.bpm) {
      cachedTempo = readout.bpm;
      const bars = Math.max(1, Math.ceil(total * (readout.bpm || 120) / 240));
      const width = timelineWidth(bars), step = barStep(bars, width);
      timeline.style.width = `${width}px`;
      timeline.style.setProperty('--pr-bars', String(bars));
      timeline.style.setProperty('--pr-step', String(step));
      clear(ruler).append(...rulerBars(bars, step).map(n => h('span', { style: { left: `${(n - 1) / bars * 100}%` } }, String(n))));
    }
    const step = playingStep(player.playing, player.audio?.currentTime, gridTempo(grid), grid?.downbeat ?? grid?.offset);
    if (lastStep !== step || lastIndex !== player.index) {
      drawn.get(lastIndex)?.steps[lastStep]?.setAttribute('data-lit', 'false');
      for (const [i, on] of [[lastIndex, 'false'], [player.index, 'true']]) {
        drawn.get(i)?.row.setAttribute('data-current', on);
        drawn.get(i)?.head.setAttribute('data-current', on);
        drawn.get(i)?.nameButton.setAttribute('aria-current', on);
        drawn.get(i)?.clip.setAttribute('aria-current', on);
      }
      drawn.get(player.index)?.steps[step]?.setAttribute('data-lit', 'true');
      lastStep = step; lastIndex = player.index;
    }
    playhead.hidden = !motion || !player.current;
    if (motion) playhead.style.left = `${clamp(((starts[player.index] || 0) + Math.min(lengths[player.index] || 0, player.audio?.currentTime || 0)) / total) * 100}%`;
    bar.update(player.current, readout);
    curves.update(player, status, motion);
  }
  queue();
  return { queue, update, destroy() {
    if (!alive) return;
    alive = false; dropJobs(); if (typeof browseCleanup === 'function') browseCleanup();
    node.remove(); bar.destroy();
  } };
}

export function mount(ctx) {
  const { player } = ctx;
  const stages = new Set(), cleanups = [], decorations = [];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const html = document.documentElement;
  const moving = () => html.dataset.themeMotion !== 'off' && motionAllowed(ctx.settings, reduced);
  const visible = () => !document.hidden && !html.hasAttribute('data-hidden');
  let alive = true, snapshot = {}, sampledAt = -Infinity, sampledAudio, lastFrame = -Infinity, held = null;
  // Output display state: the mode (remembered), whether the last frame was live, and meter/peak values.
  let outputMode = readOutputMode(), live = false, idleKey = null, meterState = { level: 0, peak: 0, hold: 0 }, waveBuf, freqBuf;
  const paintIdle = () => { idleKey = outputMode; panel.draw(null); };
  const out = { mode: () => outputMode, toggle() {
    outputMode = outputMode === 'scope' ? 'spectrum' : 'scope';
    writeOutputMode(outputMode);
    panel.setMode(outputMode);
    idleKey = null; if (!live) paintIdle();
  } };
  // App chrome: one panel in the top bar, directly before the search field (every page, no Home stage needed).
  // Without a search field there is nowhere sensible to put it, so it is simply not added. Any stale copy
  // is removed first so it can never be there twice.
  const panel = outputPanel(out);
  document.querySelector('.topbar > .pr-output')?.remove();
  const search = document.querySelector('.topbar > .search');
  const placed = !!search;
  const shows = () => !panel.node.hidden;
  function fitOutput() {
    if (!alive || !placed) return;
    // Also hide if the bar overflows (wide fonts can still push its contents past the edge).
    const bar = search.parentNode;
    const overflowing = shows() && bar && bar.scrollWidth > bar.clientWidth + 1;
    const show = !overflowing && outputFits(search.getBoundingClientRect().width, shows());
    if (show === shows()) return;
    panel.node.hidden = !show;
    // Frames and the live flag are not tracked while hidden, so start from a clean state either way:
    // on show, repaint from the current playback and motion state (a paused player sends no more frames).
    live = false; meterState = { level: 0, peak: 0, hold: 0 }; idleKey = null;
    if (show && !(player.playing && moving() && player.normalizer?.visual)) paintIdle();
  }
  if (placed) {
    search.before(panel.node); decorations.push(panel.node);
    // Re-fit whenever the search field changes size (window, sidebar nav, side player). Deferred to a frame
    // so changing the panel inside the observer callback cannot trigger a resize loop.
    let fitFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!fitFrame) fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitOutput(); });
    });
    resizeObserver.observe(search);
    cleanups.push(() => { resizeObserver.disconnect(); if (fitFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fitFrame); });
  }
  // Reads the shared analyser (never changes it) and paints the panel; anything but live playback paints the idle frame once.
  function drawOutput(frame) {
    if (!placed || !shows()) return;
    const analyser = player.normalizer?.visual;
    if (!(frame.playing && player.playing && moving() && analyser)) {
      live = false; meterState = { level: 0, peak: 0, hold: 0 };
      if (idleKey !== outputMode) paintIdle();
      return;
    }
    const size = analyser.fftSize, dt = frame.dt || 1 / 30;
    if (!waveBuf || waveBuf.length !== size) waveBuf = new Uint8Array(size);
    analyser.getByteTimeDomainData(waveBuf);
    let freq = null;
    if (outputMode === 'spectrum') {
      if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) freqBuf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freqBuf); freq = freqBuf;
    }
    const raw = meterScale(timePeak(waveBuf));
    meterState = { level: levelStep(meterState.level, raw, dt), ...peakStep(meterState, raw, dt) };
    const sample = { wave: waveBuf, freq, level: meterState.level, peak: meterState.peak, sampleRate: analyser.context?.sampleRate || 44100, fftSize: size };
    live = true; idleKey = null;
    panel.draw(sample);
  }
  const listen = (target, event, fn) => cleanups.push(ctx.on(target, event, fn));
  const tempo = h('output.pr-tempo', { 'aria-label': 'Tempo in beats per minute' });
  const position = h('output.pr-position', { 'aria-label': 'Position in bars, beats and steps' });
  const lcd = h('div.pr-lcd', h('span.pr-caption', 'TEMPO'), tempo, h('span.pr-caption', 'BAR : BEAT : STEP'), position);
  // These are indicators, deliberately inert: never start recording or change playback mode.
  const record = h('button.pr-record', { type: 'button', disabled: true, tabindex: '-1',
    'aria-label': 'Record (decorative only)', title: 'Record (decorative only)' });
  const mode = h('span.pr-song-pattern', { 'aria-hidden': 'true' }, h('b', 'SONG'), h('span', 'PAT'));
  const transport = h('div.pr-transport-extra', record, mode, lcd);
  const controls = document.querySelector('.pb-controls');
  if (controls) { controls.append(transport); decorations.push(transport); }
  const volume = document.querySelector('.pb-volume');
  // The top-bar output display replaces the player-bar visualizer while Producer is active (the setting itself is untouched).
  html.setAttribute('data-no-visualizer', '');
  const meters = [h('i'), h('i')];
  const meter = h('span.pr-meter', { 'aria-hidden': 'true', title: 'L / R linked level (shared mono analyser)' }, meters);
  if (volume) { volume.append(meter); decorations.push(meter); }
  function sync(force = false) {
    if (!alive || !visible()) return;
    const now = performance.now();
    if (force || sampledAudio !== player.audio || now - sampledAt >= 250) {
      snapshot = player.autoMixStatus(); sampledAt = now; sampledAudio = player.audio;
    }
    // During a blend the active audio is the incoming deck, so use its grid.
    const grid = player.fading ? player.lock?.match?.gridIn || snapshot.live || snapshot.structure?.grid :
      snapshot.plan?.grid || snapshot.live || snapshot.structure?.grid;
    const bpm = gridTempo(grid);
    // Hold the shown tempo steady (before the speed multiplier); a new track or blend resets it.
    held = stableTempo(held, bpm, performance.now(), `${player.current?.id}|${player.fading ? 1 : 0}`);
    const readout = {
      bpm: held.shown,
      tempo: formatTempo(held.shown * (player.audio?.playbackRate || 1)),
      position: formatPosition(player.audio?.currentTime, bpm, grid?.downbeat ?? grid?.offset)
    };
    tempo.textContent = readout.tempo; position.textContent = readout.position;
    const motion = moving();
    stages.forEach(stage => stage.update(snapshot, grid, motion, readout));
    transport.dataset.playing = String(!!player.playing);
    volume?.style.setProperty('--pr-volume', String(player.muted ? 0 : clamp(player.volume)));
    if (!motion || !player.playing) meters.forEach(node => { node.style.height = '0%'; });
  }
  ctx.views.override('home', async () => ({ render(container) {
    if (!alive) return () => {};
    const stage = workstation(container, ctx, moving, out); stages.add(stage); sync(true);
    return () => { stages.delete(stage); stage.destroy(); };
  } }));
  listen(player, 'queue', () => { stages.forEach(stage => stage.queue()); sync(true); });
  for (const event of ['track', 'state', 'time', 'timeline', 'automix', 'transition', 'speed', 'volume']) listen(player, event, () => sync(event !== 'time'));
  listen(ctx.store, 'settings', () => sync(true));
  listen(reduced, 'change', () => sync());
  listen(document, 'visibilitychange', () => sync(true));
  listen(document, 'appvisibility', () => sync(true));
  const observer = new MutationObserver(() => sync());
  observer.observe(html, { attributes: true, attributeFilter: ['data-theme-motion', 'data-perf', 'data-hidden'] });
  cleanups.push(() => observer.disconnect());
  // Reuse the shell's single scheduler and existing analyser. Its signal is mono;
  // both stereo-style bars show the same real level rather than inventing a channel split.
  cleanups.push(ctx.frame(frame => {
    if (!alive || !visible()) return;
    // The scope runs at the shared loop's rate; it must never stop the readouts below.
    try { drawOutput(frame); } catch (error) { live = false; }
    if (frame.time - lastFrame < 50) return;
    lastFrame = frame.time;
    if (moving()) {
      const height = `${Math.round(clamp(frame.playing ? frame.level * 2 : 0) * 100)}%`;
      meters.forEach(node => { node.style.height = height; });
    }
    sync();
  }));
  sync(true);
  if (placed) { fitOutput(); if (shows()) paintIdle(); }
  return () => {
    if (!alive) return;
    alive = false; cleanups.reverse().forEach(off => off());
    stages.forEach(stage => stage.destroy()); stages.clear(); decorations.forEach(node => node.remove());
    panel.destroy(); waveBuf = freqBuf = null;
    volume?.style.removeProperty('--pr-volume');
    html.removeAttribute('data-no-visualizer');
  };
}
