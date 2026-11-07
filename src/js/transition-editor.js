// Visual editor for how one song hands over to the next (opened from the queue's transition rows).
// The geometry and curve rules live in transition-model.js; this file draws them and wires the controls.
import { h, clear, coverOf, duration as clock } from './dom.js';
import { getCues, getPair, setPair, setMixIn, setMixOut } from './cues.js';
import { formatCueTime, parseCueTime } from './cue-time.js';
import { modal, button } from './ui.js';
import { fadeLevel } from './normalizer.js';
import { camelot } from './keys.js';
import { keyRelation } from './mixorder.js';
import * as mixmemory from './mixmemory.js';
import {
  MAX_FADE, PRESETS, barChoices, barsToSeconds, layout, visibleWindow,
  moveOut, moveIn, presetFor, normalizeCurve, curvePoints, centerFromPointer
} from './transition-model.js';

const STAGE_ROW = 64;          // css px per song row
const STAGE_RULER = 20;
const STAGE_GAP = 6;
const STAGE_HEIGHT = STAGE_RULER + STAGE_ROW * 2 + STAGE_GAP;
const PREVIEW_LEAD = 4;        // seconds before the out point that Preview starts playing
const HANDLE_STEP = 0.05;
const REFRESH_MS = 2000;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

const KEY_WORDS = {
  same: 'Keys match',
  relative: 'Keys match (relative major and minor)',
  neighbor: 'Keys blend well',
  'energy-boost': 'Keys lift the energy',
  clash: 'Keys clash'
};

const seconds = (track) => {
  const ms = Number(track?.full_duration || track?.duration);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
};
const fixed = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
const setText = (el, text) => { el.textContent = text; };
const flag = (el, name, on) => {
  const rest = String(el.className || '').split(' ').filter(c => c && c !== name);
  el.className = (on ? [...rest, name] : rest).join(' ');
};
const pressed = (el, on) => el.setAttribute('aria-pressed', on ? 'true' : 'false');

/** What the app knows about a song: { bpm, key (Camelot), downbeat } with null for the unknown parts */
const gridBpm = (grid) => Number.isFinite(grid?.bpm) && grid.bpm > 0 ? grid.bpm :
  Number.isFinite(grid?.period) && grid.period > 0 ? 60 / grid.period : null;

function defaultInfo(player, track) {
  let bpm = null, key = null, downbeat = 0;
  try {
    // the playing song: the beat Auto mix has heard so far, like the Producer pack reads it
    if (player.current && String(player.current.id) === String(track.id)) {
      const s = player.autoMixStatus?.();
      bpm = gridBpm(s?.plan?.grid || s?.live || s?.structure?.grid);
    }
  } catch (e) { /* not heard yet */ }
  try {
    if (!bpm) bpm = gridBpm(mixmemory.get(track.id));
  } catch (e) { /* nothing remembered */ }
  try {
    if (!bpm) {
      player.mixFeatureCache?.delete?.(track.id); // the cached guess can predate the analysis
      const f = player.mixFeatures?.(track);
      bpm = f && f.bpm > 0 ? f.bpm : null;
    }
  } catch (e) { /* unknown tempo */ }
  try { key = player.keyOf?.(track) || null; } catch (e) { /* unknown key */ }
  try {
    const mem = mixmemory.get(track.id);
    if (Number.isFinite(mem?.downbeat)) downbeat = mem.downbeat;
  } catch (e) { /* no beat grid */ }
  return { bpm, key, downbeat };
}

/**
 * Open the transition editor for `from` into `to`.
 * services (tests / the player bar): { player, waveform(track) -> Promise<samples|null>, info(track) -> { bpm, key, downbeat } }
 */
export function transitionDialog(from, to, services = {}) {
  const player = services.player;
  const loadWaveform = services.waveform || ((track) => player.waveformOf(track));
  const infoOf = services.info || ((track) => defaultInfo(player, track));

  const original = getPair(from.id, to.id);
  const pair = original;
  const durationOut = seconds(from), durationIn = seconds(to);
  const baseFade = Math.min(MAX_FADE, player.crossfadeSeconds() || 6);
  // What the user set for this pair (null = not set: the songs own mix points and the usual fade apply).
  // `state` holds the resolved numbers used for drawing; only `explicit` is ever saved.
  const explicit = { out: pair?.out ?? null, in: pair?.in ?? null, fade: pair?.fade ?? null };
  const state = {
    out: 0, in: 0, fade: baseFade,
    style: pair?.style || '',
    curve: pair?.curve ? normalizeCurve(pair.curve) : null
  };
  const dims = { durationOut, durationIn };
  // The player schedules the fade over `fade * rate` media seconds (player.js startCrossfade), so the outgoing
  // song's speed matters. Only the playing song has a speed we can read; any other plays at 1x.
  const outRate = () => {
    const rate = player.current && String(player.current.id) === String(from.id) ? Number(player.audio?.playbackRate) : 1;
    return rate > 0 && Number.isFinite(rate) ? rate : 1;
  };
  // The fade is limited by what both songs have left first; an automatic leave point then sits that far from the end.
  // Auto mix plans its own timing unless the pair or the songs set a leave point, start point or fade
  let auto = { on: false, plan: null };
  const fit = () => {
    const rate = outRate();
    const into = Math.min(Math.max(0, explicit.in ?? getCues(to.id).mixIn ?? 0), durationIn ?? Infinity);
    let fade = Math.min(MAX_FADE, Math.max(0, explicit.fade ?? baseFade));
    if (durationIn) fade = Math.min(fade, durationIn - into);
    if (durationOut) fade = Math.min(fade, durationOut / rate);
    const set = explicit.out ?? getCues(from.id).mixOut;
    let out;
    if (set != null) {
      out = Math.min(Math.max(0, set), durationOut ?? Infinity);
      if (durationOut) fade = Math.min(fade, (durationOut - out) / rate);
    } else out = durationOut ? Math.max(0, durationOut - fade * rate) : 0;
    const planned = player.autoMix && state.style !== 'dropcut' && explicit.out == null && explicit.in == null && explicit.fade == null &&
      getCues(from.id).mixOut == null && getCues(to.id).mixIn == null;
    auto = { on: !!planned, plan: null };
    if (planned) {
      // the plan's span is media seconds of the outgoing song; the fade lasts span / rate (player.js startCrossfade)
      const plan = player.mixPlan;
      const live = plan && plan.loadId === player.loadId && String(plan.nextId) === String(to.id) &&
        player.current && String(player.current.id) === String(from.id) && plan.span > 0;
      if (live) {
        auto.plan = plan;
        fade = plan.span / rate; // Auto mix may plan longer than the 60 s a person can set
        out = Math.max(0, plan.at ?? (durationOut ? durationOut - plan.span : out));
      }
    }
    Object.assign(state, { out, in: into, fade });
  };
  fit();

  let closed = false, saved = false, previewed = false;
  let infoA = { bpm: null, key: null, downbeat: 0 }, infoB = { bpm: null, key: null, downbeat: 0 };
  let samplesA = null, samplesB = null;
  let colors = null;
  const offs = [];
  const readInfo = () => { infoA = { ...infoA, ...infoOf(from) }; infoB = { ...infoB, ...infoOf(to) }; };
  readInfo();

  // Snapping uses each song's own beat grid; holding Alt turns it off for that move.
  const ctxFor = (info, snap) => ({ bpm: snap ? info.bpm : null, downbeat: info.downbeat, durationOut, durationIn });
  const stepOf = (info) => barsToSeconds(1, info.bpm) || 1;

  // ---- header -----------------------------------------------------------------------
  const header = (track, info) => {
    const meta = {
      bpm: h('span.te-bpm'), key: h('span.te-key'), length: h('span.te-length')
    };
    const art = coverOf(track, 't120x120');
    const el = h('div.te-song',
      art ? h('img.te-art', { src: art, alt: '', loading: 'lazy' }) : h('div.te-art.te-art-empty'),
      h('div.te-titles', h('div.te-title', track.title || 'Untitled'), h('div.te-artist.muted', track.user?.username || '')),
      h('div.te-meta', meta.bpm, meta.key, meta.length));
    const render = () => {
      // what is not known yet is left out rather than shown as a question mark
      const bpm = info().bpm ? `${Math.round(info().bpm)} bpm` : '';
      const key = info().key ? camelot(info().key) || '' : '';
      const length = seconds(track);
      setText(meta.bpm, bpm); meta.bpm.hidden = !bpm;
      setText(meta.key, key); meta.key.hidden = !key;
      setText(meta.length, length ? clock(length * 1000) : ''); meta.length.hidden = !length;
    };
    return { el, render };
  };
  const headA = header(from, () => infoA);
  const headB = header(to, () => infoB);
  const relation = h('div.te-relation.muted.small', { role: 'status' });
  const renderRelation = () => {
    setText(relation, '');
    if (!infoA.key || !infoB.key) return;
    const found = keyRelation({ key: infoA.key }, { key: infoB.key });
    const word = KEY_WORDS[found.relation];
    if (word) setText(relation, found.clash ? `${word}: ${found.from} into ${found.to}` : `${word} (${found.from} into ${found.to})`);
  };

  // ---- stage ------------------------------------------------------------------------
  const canvas = h('canvas.te-canvas');
  const dragA = h('div.te-drag.te-drag-a', { tabIndex: 0, role: 'slider', dataset: { role: 'drag-out' } });
  const dragB = h('div.te-drag.te-drag-b', { tabIndex: 0, role: 'slider', dataset: { role: 'drag-in' } });
  const handle = h('div.te-handle', { tabIndex: 0, role: 'slider', dataset: { role: 'swap-handle' }, 'aria-valuemin': '15', 'aria-valuemax': '85' });
  const stage = h('div.te-stage', { style: { height: STAGE_HEIGHT + 'px' } }, canvas, dragA, dragB, handle);

  const windowOf = () => {
    // state.fade is real seconds; the outgoing song covers fade * rate of its own time, and the model's
    // layout would clamp the overlap to 60, so it only places the songs and the overlap is set here
    const span = state.fade * outRate();
    const lay = layout({ out: state.out, in: state.in, fade: 0 }, dims);
    lay.overlapEnd = Math.min(lay.overlapStart + span, lay.fromEnd, lay.toEnd);
    const win = visibleWindow(lay, { padding: Math.max(8, span * 0.75) });
    if (!(win.end - win.start > 0.01)) win.end = win.start + 1;
    return { lay, win, span: win.end - win.start };
  };

  const readColors = () => {
    const styles = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    const get = (name, fallback) => (styles?.getPropertyValue(name) || '').trim() || fallback;
    colors = {
      accent: get('--accent', '#ff5500'), text: get('--text', '#f2f2f2'), muted: get('--muted', '#a0a0a0'),
      wave: get('--wave', '#5c5c5c'), bar: get('--bar', '#181818'), surface: get('--surface', '#1e1e1e')
    };
  };

  const curveShape = () => state.style === 'blend' ? normalizeCurve(state.curve) : null;
  const centerNow = () => { const shape = curveShape(); return shape?.dj ? shape.center : 0.5; };

  const positionControls = () => {
    const { lay, win, span } = windowOf();
    const pct = (s) => ((s - win.start) / span * 100) + '%';
    const rowA = STAGE_RULER, rowB = STAGE_RULER + STAGE_ROW + STAGE_GAP;
    Object.assign(dragA.style, { left: '0%', width: '100%', top: rowA + 'px', height: STAGE_ROW + 'px' });
    Object.assign(dragB.style, { left: '0%', width: '100%', top: rowB + 'px', height: STAGE_ROW + 'px' });
    const mid = lay.overlapStart + (lay.overlapEnd - lay.overlapStart) * centerNow();
    Object.assign(handle.style, { left: pct(mid), top: (STAGE_RULER + (STAGE_HEIGHT - STAGE_RULER) / 2) + 'px' });
    handle.hidden = state.style === 'dropcut' || !curveShape(); // nothing to drag until a curve is set
    handle.setAttribute('aria-valuenow', String(Math.round(centerNow() * 100)));
    handle.setAttribute('aria-valuetext', `Swap point ${Math.round(centerNow() * 100)} percent through the overlap`);
    handle.setAttribute('aria-label', 'Swap point: where the volume hands over. Left and right arrows move it.');
    const bar = infoA.bpm ? 'a bar' : '1 second';
    dragA.setAttribute('aria-label', `Leave ${from.title || 'first song'} at ${formatCueTime(state.out)}. Left and right arrows slide the song by ${bar}.`);
    dragB.setAttribute('aria-label', `Start ${to.title || 'second song'} at ${formatCueTime(state.in)}. Left and right arrows slide the song by ${infoB.bpm ? 'a bar' : '1 second'}.`);
    dragA.setAttribute('aria-valuetext', formatCueTime(state.out));
    dragB.setAttribute('aria-valuetext', formatCueTime(state.in));
  };

  const draw = () => {
    if (closed) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    if (!colors) readColors();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(STAGE_HEIGHT * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = STAGE_HEIGHT + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, STAGE_HEIGHT);
    const W = rect.width;
    const { lay, win, span } = windowOf();
    const X = (s) => (s - win.start) / span * W;
    const rowTop = [STAGE_RULER, STAGE_RULER + STAGE_ROW + STAGE_GAP];

    // overlap panel behind both songs
    const px0 = X(lay.overlapStart), px1 = X(lay.overlapEnd);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(px0, STAGE_RULER - 2, Math.max(1, px1 - px0), STAGE_HEIGHT - STAGE_RULER + 2);
    ctx.globalAlpha = 1;

    // ruler
    drawRuler(ctx, lay, win, W, X);

    // the two songs: the part that plays is bright, the rest is dimmed
    const song = (index, samples, start, end, playFrom, playTo, color, length) => {
      const top = rowTop[index];
      const x0 = Math.max(0, X(start)), x1 = Math.min(W, X(end));
      const middle = top + STAGE_ROW / 2;
      ctx.fillStyle = colors.wave;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x0, top, Math.max(0, x1 - x0), STAGE_ROW);
      for (let x = Math.floor(x0); x < x1; x += 3) {
        const s = win.start + (x + 1.5) / W * span;
        let amp = 0.15;
        if (samples && samples.length && length) {
          const at = Math.floor((s - start) / length * samples.length);
          amp = Math.max(0.04, Math.min(1, samples[Math.min(samples.length - 1, Math.max(0, at))] || 0));
        }
        const playing = s >= playFrom && s <= playTo;
        ctx.globalAlpha = playing ? 0.95 : 0.28;
        ctx.fillStyle = playing ? color : colors.wave;
        const half = Math.max(1, amp * (STAGE_ROW / 2 - 3));
        ctx.fillRect(x, middle - half, 2, half * 2);
      }
      ctx.globalAlpha = 1;
    };
    song(0, samplesA, lay.fromStart, lay.fromEnd, lay.fromStart, lay.overlapEnd, colors.accent, durationOut);
    song(1, samplesB, lay.toStart, lay.toEnd, lay.overlapStart, lay.toEnd, colors.text, durationIn);

    // overlap borders on top of the waveforms
    ctx.fillStyle = colors.accent;
    ctx.fillRect(Math.round(px0), STAGE_RULER - 2, 1, STAGE_HEIGHT - STAGE_RULER + 2);
    ctx.fillRect(Math.round(px1) - 1, STAGE_RULER - 2, 1, STAGE_HEIGHT - STAGE_RULER + 2);

    // volume curves over the overlap (none for a drop cut: it ignores them)
    if (state.style !== 'dropcut' && px1 - px0 > 2 && !curveShape()) {
      // no curve set for this pair: Auto mix chooses the shape, so no exact levels are drawn
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px0, STAGE_HEIGHT / 2 + 10);
      ctx.lineTo(px1, STAGE_HEIGHT / 2 + 10);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.text;
      ctx.textAlign = 'center';
      ctx.font = '11px sans-serif';
      ctx.fillText('Auto mix picks the curve', (px0 + px1) / 2, STAGE_HEIGHT / 2 - 2, Math.max(10, px1 - px0 - 8));
      ctx.restore();
    } else if (state.style !== 'dropcut' && px1 - px0 > 2) {
      const shape = curveShape();
      const area = { top: STAGE_RULER + 4, bottom: STAGE_HEIGHT - 4 };
      const line = (fadeIn, color) => {
        ctx.beginPath();
        curvePoints(shape, fadeIn, 33, fadeLevel).forEach(({ t, level }, i) => {
          const x = px0 + t * (px1 - px0), y = area.bottom - level * (area.bottom - area.top);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      };
      line(false, colors.accent);
      line(true, colors.text);
    }
  };

  const drawRuler = (ctx, lay, win, W, X) => {
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.muted;
    ctx.globalAlpha = 0.9;
    const barLen = barsToSeconds(1, infoA.bpm);
    const label = (x, text) => { if (x > 2 && x < W - 18) ctx.fillText(text, x + 3, STAGE_RULER / 2 - 1); };
    if (barLen) {
      // bars counted from the start of the overlap
      let every = 1;
      while (barLen * every / (win.end - win.start) * W < 34) every *= 2;
      const first = Math.ceil((win.start - lay.overlapStart) / barLen), last = Math.floor((win.end - lay.overlapStart) / barLen);
      for (let k = first; k <= last; k++) {
        const x = Math.round(X(lay.overlapStart + k * barLen));
        ctx.fillRect(x, STAGE_RULER - (k % every ? 4 : 8), 1, k % every ? 4 : 8);
        if (!(k % every)) label(x, k === 0 ? 'bar 0' : String(k));
      }
    } else {
      const step = RULER_STEPS.find(s => s / (win.end - win.start) * W >= 46) || RULER_STEPS[RULER_STEPS.length - 1];
      for (let s = Math.ceil(win.start / step) * step; s <= win.end; s += step) {
        const x = Math.round(X(s));
        ctx.fillRect(x, STAGE_RULER - 8, 1, 8);
        const media = s - lay.fromStart;
        if (media >= 0) label(x, formatCueTime(media));
      }
    }
    ctx.globalAlpha = 1;
  };

  // ---- dragging ---------------------------------------------------------------------
  const guardKeys = (e) => {
    // Space and arrows belong to these controls; the app's global shortcuts must not see them (Escape and Enter pass through)
    if (e.key === ' ' || e.code === 'Space' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
  };

  const attachDrag = (el, kind) => {
    const info = () => kind === 'out' ? infoA : infoB;
    const move = kind === 'out' ? moveOut : moveIn;
    let drag = null;
    const end = (e) => {
      if (!drag) return;
      if (e && drag.id != null) { try { el.releasePointerCapture?.(drag.id); } catch (err) { /* already released */ } }
      drag = null;
      flag(el, 'dragging', false);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      const rect = stage.getBoundingClientRect();
      const { span } = windowOf();
      drag = { id: e.pointerId, x: e.clientX, start: { ...state }, perPixel: rect.width ? span / rect.width : 0 };
      try { el.setPointerCapture?.(e.pointerId); } catch (err) { /* not capturable */ }
      flag(el, 'dragging', true);
      el.focus?.();
      e.preventDefault?.();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // the waveform follows the pointer, so the point it covers moves the other way
      const delta = -(e.clientX - drag.x) * drag.perPixel;
      explicit[kind] = move(drag.start, delta, ctxFor(info(), !e.altKey))[kind];
      changed();
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', () => end(null));
    el.addEventListener('keydown', (e) => {
      guardKeys(e);
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault?.();
      const step = stepOf(info()) * (e.key === 'ArrowRight' ? 1 : -1);
      explicit[kind] = move(state, step, ctxFor(info(), true))[kind];
      changed();
    });
  };
  attachDrag(dragA, 'out');
  attachDrag(dragB, 'in');

  let handleDrag = null;
  const setCenter = (center) => {
    state.style = 'blend';
    state.curve = { dj: 1, center: Math.round(centerFromPointer(center) * 100) / 100 };
    changed();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    handleDrag = { id: e.pointerId };
    try { handle.setPointerCapture?.(e.pointerId); } catch (err) { /* not capturable */ }
    flag(handle, 'dragging', true);
    handle.focus?.();
    e.preventDefault?.();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handleDrag || e.pointerId !== handleDrag.id) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    const { lay, win, span } = windowOf();
    const at = win.start + (e.clientX - rect.left) / rect.width * span;
    const length = lay.overlapEnd - lay.overlapStart;
    if (length > 0) setCenter((at - lay.overlapStart) / length);
  });
  const endHandle = (e) => {
    if (!handleDrag) return;
    if (e) { try { handle.releasePointerCapture?.(handleDrag.id); } catch (err) { /* already released */ } }
    handleDrag = null;
    flag(handle, 'dragging', false);
  };
  handle.addEventListener('pointerup', endHandle);
  handle.addEventListener('pointercancel', endHandle);
  handle.addEventListener('lostpointercapture', () => endHandle(null));
  handle.addEventListener('keydown', (e) => {
    guardKeys(e);
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault?.();
    setCenter(centerNow() + (e.key === 'ArrowRight' ? HANDLE_STEP : -HANDLE_STEP));
  });

  // ---- length -----------------------------------------------------------------------
  const chips = h('div.te-chips');
  const slider = h('input', { type: 'range', min: 0, max: MAX_FADE, step: 0.5, 'aria-label': 'Fade seconds', dataset: { role: 'fade-slider' } });
  const sliderText = h('span.te-fade-text');
  const autoNote = h('p.muted.small', { dataset: { role: 'auto-note' } });
  const renderChips = () => {
    clear(chips);
    barChoices(infoA.bpm).forEach(({ bars, seconds: length }) => {
      const chip = h('button.chip.te-chip', {
        dataset: { role: 'bars-chip', bars: String(bars) },
        title: `${bars} bars`,
        onclick: () => { explicit.fade = length; changed(); }
      }, `${bars} bars · ${fixed(length)}s`);
      pressed(chip, Math.abs(state.fade - length) < 0.05);
      flag(chip, 'active', Math.abs(state.fade - length) < 0.05);
      chips.append(chip);
    });
  };
  slider.value = String(state.fade);
  slider.addEventListener('input', () => { explicit.fade = Number(slider.value); changed(); });

  // ---- presets ----------------------------------------------------------------------
  const presetButtons = new Map();
  const choose = (id) => {
    if (id === 'default') { state.style = ''; state.curve = null; }
    else {
      const preset = PRESETS.find(p => p.id === id);
      if (!preset) return;
      state.style = preset.style;
      state.curve = preset.curve ? { ...preset.curve } : null;
    }
    changed();
  };
  const presetRow = h('div.te-presets', { role: 'group', 'aria-label': 'Transition style' },
    [{ id: 'default', label: 'Use setting' }, ...PRESETS, { id: 'custom', label: 'Custom' }].map(({ id, label }) => {
      const btn = h('button.chip.te-preset', {
        dataset: { role: 'preset', preset: id },
        onclick: () => choose(id),
        disabled: id === 'custom' ? true : undefined
      }, label);
      presetButtons.set(id, btn);
      return btn;
    }));
  const currentPreset = () => presetFor(state.style, curveShape());
  const dropNote = h('p.muted.small', 'Drop cut uses a confirmed drop at or after the start marker. Leave time starts its build; fade length applies to smooth blends.');

  // ---- exact times ------------------------------------------------------------------
  const timeField = (label, track) => {
    const input = h('input.input', { placeholder: '0:00', 'aria-label': label });
    return { input, track, row: h('label.cue-field', h('span.field-label', label), input) };
  };
  const outField = timeField(`Leave ${from.title} at`, from);
  const inField = timeField(`Start ${to.title} at`, to);
  const readField = (field) => {
    const value = parseCueTime(field.input.value ?? '', field.track.duration);
    field.input.setCustomValidity?.(Number.isNaN(value) ? 'Enter m:ss or seconds within the song’s duration.' : '');
    if (Number.isNaN(value)) field.input.reportValidity?.();
    return value;
  };
  const fieldInput = (field, key) => () => {
    const value = parseCueTime(field.input.value ?? '', field.track.duration);
    if (Number.isNaN(value)) return;
    explicit[key] = value; // blank goes back to the songs own mix point
    changed();
  };
  outField.input.addEventListener('input', fieldInput(outField, 'out'));
  inField.input.addEventListener('input', fieldInput(inField, 'in'));
  const exact = h('details.te-exact', h('summary', 'Exact times'), h('div.te-exact-fields', outField.row, inField.row));

  // ---- preview ----------------------------------------------------------------------
  const previewHint = h('span.muted.small.te-preview-hint');
  const previewBtn = h('button.btn.btn-outline', { dataset: { role: 'preview' }, onclick: () => preview() }, h('span', 'Preview'));
  const previewReady = () => {
    const now = player.current, next = player.queue?.[player.index + 1];
    return !player.fading && !!now && !!next && String(now.id) === String(from.id) && String(next.id) === String(to.id);
  };
  const renderPreview = () => {
    const ready = previewReady();
    previewBtn.disabled = !ready;
    setText(previewHint, ready ? 'Plays the end of the first song into this one with the settings above.' :
      player.fading ? 'Wait for the current transition to finish to preview' : 'Play the first song with this one next to preview');
  };
  const pairValue = () => ({ out: explicit.out, in: explicit.in, fade: explicit.fade == null ? null : state.fade,
    style: state.style, curve: state.style === 'blend' ? state.curve : null });
  // a pair that sets nothing is no pair at all
  const writePair = () => {
    const v = pairValue();
    setPair(from.id, to.id, v.out == null && v.in == null && v.fade == null && !v.style && !v.curve ? null : v);
  };
  function preview() {
    if (closed || !previewReady()) { renderPreview(); return; }
    if (!validTimes()) return;
    writePair();
    previewed = true;
    player.seek(Math.max(0, state.out - PREVIEW_LEAD * outRate()));
    if (player.playing === false) player.play?.();
  }

  // ---- state -> screen ----------------------------------------------------------------
  function changed() {
    fit();
    render();
  }
  function render() {
    if (closed) return;
    setText(sliderText, auto.on ? (auto.plan ? `Auto · ${fixed(state.fade)}s` : 'Auto') : `${fixed(state.fade)}s`);
    autoNote.hidden = !auto.on;
    setText(autoNote, auto.plan ? 'Auto mix picks the timing, and has planned this blend.' :
      'Auto mix picks the timing. The picture is an estimate until it plans this blend.');
    slider.value = String(state.fade);
    renderChips();
    const active = currentPreset();
    presetButtons.forEach((btn, id) => { pressed(btn, id === active); flag(btn, 'active', id === active); });
    dropNote.hidden = state.style !== 'dropcut';
    // keep what the user is typing; everything else follows the draft
    // a blank box means not set for this pair; its placeholder shows the time in use
    outField.input.setAttribute('placeholder', formatCueTime(state.out));
    inField.input.setAttribute('placeholder', formatCueTime(state.in));
    if (outField.input !== document.activeElement) outField.input.value = explicit.out == null ? '' : formatCueTime(explicit.out);
    if (inField.input !== document.activeElement) inField.input.value = explicit.in == null ? '' : formatCueTime(explicit.in);
    positionControls();
    draw();
  }

  const validTimes = () => {
    for (const field of [outField, inField]) {
      if (Number.isNaN(readField(field))) return false;
    }
    return true;
  };

  // ---- actions ------------------------------------------------------------------------
  const save = (asSongs) => {
    const leave = readField(outField);
    if (Number.isNaN(leave)) return;
    const start = readField(inField);
    if (Number.isNaN(start)) return;
    explicit.out = leave;
    explicit.in = start;
    fit();
    saved = true;
    if (asSongs) {
      // a blank box leaves that songs mix point as it is
      setMixOut(from.id, leave ?? getCues(from.id).mixOut);
      setMixIn(to.id, start ?? getCues(to.id).mixIn);
      setPair(from.id, to.id, null);
    } else writePair();
    dialog.close();
  };

  const onClose = () => {
    if (closed) return;
    closed = true;
    offs.forEach(off => off());
    observer?.disconnect();
    // a preview wrote the draft into the pair: put back what was there when the dialog opened
    if (!saved && previewed) setPair(from.id, to.id, original);
  };

  const body = h('div.cue-editor.te-editor',
    headA.el,
    h('div.te-stage-wrap', stage),
    h('div.te-length',
      h('span.field-label', 'Length'),
      autoNote,
      h('div.te-length-row', chips, h('span.cue-fade.te-slider', slider, sliderText))),
    headB.el,
    relation,
    h('div.te-presets-wrap', h('span.field-label', 'Style'), presetRow),
    exact,
    h('p.muted.small', 'Saving as song mix points uses the default fade; the fade above is saved for this pair only.'),
    dropNote,
    h('div.te-preview', previewBtn, previewHint),
    h('div.modal-actions',
      button('Cancel', () => dialog.close(), 'btn-ghost'),
      button('Reset', () => { saved = true; setPair(from.id, to.id, null); dialog.close(); }, 'btn-ghost'),
      button('Save as the songs’ mix points', () => save(true), 'btn-outline'),
      button('Save for this pair', () => save(false), 'btn-primary')
    ));
  // Enter in the time boxes saves for this pair, like the other dialogs' fields
  [outField, inField].forEach(field => field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(false); }));

  const dialog = modal(`Transition: ${from.title} → ${to.title}`, body, { wide: true, onClose });
  // Space on any control (buttons, chips, the range) must not reach the app play shortcut.
  // No preventDefault, so it still activates the control and still types in text boxes.
  dialog.addEventListener('keydown', (e) => { if (e.key === ' ' || e.code === 'Space') e.stopPropagation(); });
  const box = dialog.childNodes?.[0];
  if (box) flag(box, 'te-modal', true);

  // ---- live updates -------------------------------------------------------------------
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => draw());
    observer.observe(stage);
  }
  const onTheme = () => { colors = null; draw(); };
  document.addEventListener('themechange', onTheme);
  offs.push(() => document.removeEventListener('themechange', onTheme));
  if (player.on) {
    offs.push(player.on('track', () => { if (!closed) renderPreview(); }));
    offs.push(player.on('queue', () => { if (!closed) renderPreview(); }));
    offs.push(player.on('transition', () => { if (!closed) renderPreview(); }));
  }

  // What Auto mix has heard and planned arrives while the dialog is open; look again every couple of seconds.
  // The draft (`explicit`) is never touched, and a box being typed in keeps its text.
  const rerender = () => { if (closed) return; readInfo(); headA.render(); headB.render(); renderRelation(); fit(); render(); };
  const timer = setInterval(rerender, REFRESH_MS);
  timer.unref?.();
  offs.push(() => clearInterval(timer));
  headA.render(); headB.render(); renderRelation(); renderPreview();
  render();
  // Waveforms arrive later; until then (or without one) the stage shows a flat placeholder and stays editable.
  const load = (track, set) => {
    let promise;
    try { promise = Promise.resolve(loadWaveform(track)); } catch (e) { promise = Promise.resolve(null); }
    promise.catch(() => null).then((samples) => {
      if (closed) return;
      set(Array.isArray(samples) && samples.length ? samples : null);
      rerender();
    });
  };
  load(from, (s) => { samplesA = s; });
  load(to, (s) => { samplesB = s; });
  return dialog;
}
