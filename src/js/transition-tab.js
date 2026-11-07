// The transition tab: a small tab that drops in under the top bar while two songs are mixing and shows the real fade
// curves (mix-curves.js, the same ones the Producer theme draws) with a moving position marker. It stays out of the
// way (no pointer events, no focus) and costs nothing while idle: only the player's 'transition' event is listened to.
// While a transition runs it also follows the settings and the performance / hidden flags, and one animation-frame
// loop (about 30 fps) moves the marker and the seconds text. The curve paths are drawn once per transition.
// The view is injected so the timing is testable without a DOM:
//   view = { mount(), setSong(from, to), setStyle(text), setCurves(outPath, inPath), setProgress(p, text),
//            reveal(slide), conceal(), unmount() }
import { h } from './dom.js';
import { settings, store } from './store.js';
import { effectsAllowed } from './audio-reactivity.js';
import { styleName } from './transitions.js';
import { curveValues, curvePath, curveProgress, curveSchedule } from './mix-curves.js';

export const SLIDE_MS = 260;     // how long the slide / fade out takes before the tab leaves the layout
export const HOLD_MS = 1500;     // a very short transition stays this long after it finishes
export const SHORT_SECONDS = 3;  // under this a transition counts as very short (a quick cut)
export const FRAME_MS = 33;      // marker updates: about 30 per second
const FINISHED = 0.97;           // a transition that ends before this far was skipped or cancelled

const defaultSlides = () => effectsAllowed(settings.themeEffects, !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

export function createTransitionTab(player, view, { slides = defaultSlides, frame = fn => requestAnimationFrame(fn), cancel = id => globalThis.cancelAnimationFrame?.(id) } = {}) {
  let phase = 'idle'; // idle | running | holding (a very short transition that has finished)
  let run = null;
  let mounted = false, shown = false, watching = false;
  let raf = 0, lastTs = -Infinity, holdTimer = null, leaveTimer = null, offSettings = null;

  const root = () => document.documentElement;
  const allowed = () => settings.transitionTab !== false && !root().hasAttribute('data-perf') && !root().hasAttribute('data-hidden');

  /** { p: progress 0..1, left: seconds left } of the running fade; paused or not started it holds where it is */
  function measure(f) {
    const drop = f.style === 'dropcut';
    const ctx = player.normalizer?.ctx?.currentTime;
    const fallback = f.startedAt == null || !Number.isFinite(ctx) ? f.progress : f.progress + (ctx - f.startedAt) / f.seconds;
    const p = curveProgress(f, drop, ctx, fallback);
    const schedule = curveSchedule(f, drop);
    // an armed drop cut counts down from now to its end on the audio clock, including the wait before its schedule starts
    if (schedule && Number.isFinite(ctx)) return { p, left: Math.max(0, schedule.end - ctx) };
    const length = schedule ? schedule.end - schedule.start : f.seconds;
    return { p, left: Math.max(0, (Number.isFinite(length) ? length : 0) * (1 - p)) };
  }
  const signature = f => [f.style, f.schedule, f.shapeIn, f.shapeOut, f.bassOpts, f.bass];
  const changed = f => !run.sig || signature(f).some((part, i) => part !== run.sig[i]);

  // the curve paths and the style name: once per transition (again only if the player swaps the plan, e.g. a drop cut falling back to a blend)
  function draw(f) {
    const values = curveValues(f, f?.style === 'dropcut');
    view.setCurves(curvePath(values.fadeOut), curvePath(values.fadeIn));
    view.setStyle(f ? styleName(f.style, f.lab?.recipe?.id, f.genre) : styleName('blend'));
    run.sig = f ? signature(f) : [];
    const schedule = f ? curveSchedule(f, f.style === 'dropcut') : null;
    run.length = f ? (schedule ? schedule.end - schedule.start : f.seconds) : 0;
  }
  function refresh(final) {
    const f = run.f;
    if (f && !final && changed(f)) draw(f);
    const m = final || (f ? measure(f) : run.last);
    run.last = m;
    view.setProgress(m.p, `${m.left.toFixed(1)}s`);
  }

  const tick = ts => {
    raf = 0;
    if (phase !== 'running' || !shown) return;
    const t = Number.isFinite(ts) ? ts : performance.now();
    if (t - lastTs >= FRAME_MS - 3) { lastTs = t; refresh(); }
    raf = frame(tick);
  };
  const loop = () => {
    if (raf || phase !== 'running' || !shown) return;
    lastTs = -Infinity;
    raf = frame(tick);
  };
  const stopLoop = () => { if (raf) cancel(raf); raf = 0; };

  function settle() {
    if (phase === 'idle' && !shown && !leaveTimer) unwatch();
  }
  function present() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
    shown = true;
    view.measure?.(); // the top bar or player position may have moved since the last time
    if (!mounted) { mounted = true; view.mount(); }
    if (!run.announced) { run.announced = true; view.setSong(run.from, run.to); }
    draw(run.f);
    refresh(phase === 'holding' ? { p: 1, left: 0 } : null);
    view.reveal(slides());
    loop();
  }
  function hide(now) {
    stopLoop();
    if (!shown) return;
    shown = false;
    view.conceal();
    clearTimeout(leaveTimer);
    const done = () => { leaveTimer = null; mounted = false; view.unmount(); settle(); };
    if (now || !slides()) done();
    else leaveTimer = setTimeout(done, SLIDE_MS);
  }
  function finish() {
    clearTimeout(holdTimer);
    holdTimer = null;
    phase = 'idle';
    run = null;
  }

  // settings / performance mode / minimized window: only listened to while a transition is on screen or leaving
  const sync = () => {
    const ok = allowed();
    if (phase === 'idle') {
      if (!ok && (mounted || leaveTimer)) { clearTimeout(leaveTimer); leaveTimer = null; mounted = false; shown = false; view.unmount(); settle(); }
      return;
    }
    if (ok) {
      if (!shown) present();
      else {
        // player position / theme changes move the top bar: measure again now and once the new layout is applied
        view.measure?.();
        queueMicrotask(() => { if (shown) view.measure?.(); });
      }
      return;
    }
    if (phase === 'holding') finish();
    hide(true);
    settle();
  };
  function watch() {
    if (watching) return;
    watching = true;
    document.addEventListener('appvisibility', sync);
    offSettings = store.on('settings', sync);
  }
  function unwatch() {
    if (!watching) return;
    watching = false;
    document.removeEventListener('appvisibility', sync);
    offSettings?.();
    offSettings = null;
  }

  const onStart = e => {
    clearTimeout(holdTimer);
    holdTimer = null;
    stopLoop();
    run = { f: player.fading || null, from: e.from, to: e.to, announced: false, sig: null, length: 0, last: { p: 0, left: 0 } };
    phase = 'running';
    watch();
    if (allowed()) present();
  };
  const onEnd = () => {
    if (phase !== 'running') return;
    stopLoop();
    const f = run.f;
    const m = f ? measure(f) : { p: 1, left: 0 };
    // a cancel (skip, another playlist) can land near the end: it only counts as finished if the player moved on to the next song
    const completed = m.p >= FINISHED && !!run.to && player.current?.id === run.to.id;
    if (shown && completed && run.length < SHORT_SECONDS) {
      // a quick cut is over before anyone can read it: keep it up for a moment
      phase = 'holding';
      refresh({ p: 1, left: 0 });
      holdTimer = setTimeout(() => { holdTimer = null; finish(); hide(false); settle(); }, HOLD_MS);
      return;
    }
    if (shown) refresh(completed ? { p: 1, left: 0 } : m);
    finish();
    hide(false);
    settle();
  };

  const off = player.on('transition', e => {
    if (e?.phase === 'start') onStart(e);
    else if (e?.phase === 'end') onEnd();
  });
  return {
    destroy() {
      off();
      stopLoop();
      unwatch();
      clearTimeout(holdTimer);
      clearTimeout(leaveTimer);
      holdTimer = leaveTimer = null;
      phase = 'idle'; run = null; shown = false;
      if (mounted) { mounted = false; view.unmount(); }
    },
  };
}

// ---- the real tab -------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  node.append(...children);
  return node;
}

export function createTabView() {
  const outCurve = svg('path', { class: 'tt-curve tt-out' });
  const inCurve = svg('path', { class: 'tt-curve tt-in' });
  const marker = svg('path', { class: 'tt-marker' });
  const graph = svg('svg', { class: 'tt-graph', viewBox: '0 0 600 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' }, outCurve, inCurve, marker);
  const fromEl = h('span.tt-from');
  const toEl = h('span.tt-to');
  // announced once when the transition starts (the text is set once); not on every update
  const song = h('p.tt-song', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    fromEl, h('span.tt-arrow', { 'aria-hidden': 'true' }, '→'), h('span.tt-sr', ' to '), toEl);
  const styleEl = h('span.tt-style');
  const leftEl = h('span.tt-left', { 'aria-hidden': 'true' });
  const el = h('div.transition-tab', { hidden: true }, song, graph, h('div.tt-foot', styleEl, leftEl));
  let markerD = '', leftText = '';

  // the top bar's real bottom edge (and the player bar under it when that is on top)
  const measureTop = () => {
    const bottom = node => node?.getBoundingClientRect?.().bottom;
    let top = bottom(document.querySelector?.('.topbar'));
    if (document.documentElement.getAttribute?.('data-player') === 'top') {
      const bar = bottom(document.querySelector?.('footer.playerbar:not(.side)'));
      if (Number.isFinite(bar) && bar > (top || 0)) top = bar;
    }
    if (Number.isFinite(top) && top > 0) el.style.setProperty('--tt-top', `${Math.round(top)}px`);
  };
  return {
    el,
    measure: measureTop,
    mount() {
      if (!el.parentNode) document.body.appendChild(el);
      el.hidden = false;
      measureTop();
      window.addEventListener('resize', measureTop);
    },
    setSong(from, to) {
      fromEl.textContent = from?.title || 'Song A';
      toEl.textContent = to?.title || 'Song B';
    },
    setStyle(text) { styleEl.textContent = text; },
    setCurves(out, incoming) { outCurve.setAttribute('d', out); inCurve.setAttribute('d', incoming); },
    setProgress(p, text) {
      const d = `M${(p * 600).toFixed(1)},0 V100`;
      if (d !== markerD) { markerD = d; marker.setAttribute('d', d); }
      if (text !== leftText) { leftText = text; leftEl.textContent = text; }
    },
    reveal(slide) {
      el.dataset.slide = slide ? 'on' : 'off';
      void el.offsetWidth; // settle the start position so the slide runs
      el.classList.add('show');
    },
    conceal() { el.classList.remove('show'); },
    unmount() {
      window.removeEventListener('resize', measureTop);
      el.hidden = true;
    },
  };
}

/** Mount the tab once at app startup */
export function initTransitionTab(player) {
  return createTransitionTab(player, createTabView());
}
