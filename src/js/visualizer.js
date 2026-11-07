// Small audio visualizer for the player bar. Reads the analyser tapped after loudness
// normalization (normalizer.visual) and draws in the theme's accent colors, or in the
// colors / style / size the user picked in Settings -> Playback.
import { h } from './dom.js';
import { player } from './player.js';
import { store, settings, VISUALIZER_DEFAULTS } from './store.js';

export const VISUALIZER_STYLES = [
  { id: 'bars', label: 'Bars' },
  { id: 'mirror', label: 'Mirrored bars' },
  { id: 'wave', label: 'Wave' },
  { id: 'line', label: 'Line' },
  { id: 'circle', label: 'Circle' },
  { id: 'dots', label: 'Dots' }
];

export const VISUALIZER_COLORS = [
  { id: 'theme', label: 'Theme' },
  { id: 'accent', label: 'Accent' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'custom', label: 'Custom' }
];

export const VISUALIZER_POSITIONS = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Center' },
  { id: 'right', label: 'Right' }
];

export const VISUALIZER_LIMITS = {
  bars: [6, 64],
  width: [60, 280],
  height: [20, 56],
  sensitivity: [0.5, 2.5],
  smoothing: [0, 0.95]
};

const HEX = /^#[0-9a-f]{6}$/i;
const MIN_FRAME_MS = 1000 / 61; // draw at most ~60 times a second
const clamp = (value, [min, max], fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (list, value, fallback) => (list.some(o => o.id === value) ? value : fallback);

/** Settings with every value validated, so a bad stored value can never break drawing */
function readOptions() {
  const d = VISUALIZER_DEFAULTS;
  const position = oneOf(VISUALIZER_POSITIONS, settings.visualizerPosition, d.visualizerPosition);
  let height = Math.round(clamp(settings.visualizerHeight, VISUALIZER_LIMITS.height, d.visualizerHeight));
  if (position === 'center') height = Math.min(height, 40); // the center spot sits beside the 40px control row
  return {
    style: oneOf(VISUALIZER_STYLES, settings.visualizerStyle, d.visualizerStyle),
    color: oneOf(VISUALIZER_COLORS, settings.visualizerColor, d.visualizerColor),
    colorA: HEX.test(settings.visualizerColorA) ? settings.visualizerColorA : d.visualizerColorA,
    colorB: HEX.test(settings.visualizerColorB) ? settings.visualizerColorB : d.visualizerColorB,
    bars: Math.round(clamp(settings.visualizerBars, VISUALIZER_LIMITS.bars, d.visualizerBars)),
    width: Math.round(clamp(settings.visualizerWidth, VISUALIZER_LIMITS.width, d.visualizerWidth)),
    height,
    sensitivity: clamp(settings.visualizerSensitivity, VISUALIZER_LIMITS.sensitivity, d.visualizerSensitivity),
    smoothing: clamp(settings.visualizerSmoothing, VISUALIZER_LIMITS.smoothing, d.visualizerSmoothing),
    peaks: !!settings.visualizerPeaks,
    glow: !!settings.visualizerGlow,
    position
  };
}

export function createVisualizer() {
  const canvas = h('canvas.pb-visualizer', { title: 'Visualizer (change it in Settings → Playback)' });
  const ctx = canvas.getContext('2d');

  let opts = readOptions();
  let size = { w: 0, h: 0, dpr: 0 };
  let frame = null;
  let colors = readColors();
  let freq = null;
  let wave = null;
  let idle = 0; // fades the bars down after pausing
  let lastDraw = -Infinity;
  let vals = new Float32Array(64);
  let peaks = new Float32Array(64);
  let holds = new Uint8Array(64);

  function readColors() {
    const css = getComputedStyle(document.documentElement);
    return { a: css.getPropertyValue('--accent').trim() || '#ff5500', b: css.getPropertyValue('--wave-played').trim() || '#ff5500' };
  }

  /** Resize the canvas (devicePixelRatio aware) and tag it with its position */
  function layout() {
    opts = readOptions();
    const dpr = window.devicePixelRatio || 1;
    if (size.w !== opts.width || size.h !== opts.height || size.dpr !== dpr) {
      size = { w: opts.width, h: opts.height, dpr };
      canvas.width = Math.round(opts.width * dpr);
      canvas.height = Math.round(opts.height * dpr);
      canvas.style.width = opts.width + 'px';
      canvas.style.height = opts.height + 'px';
    }
    for (const pos of ['left', 'center', 'right']) canvas.classList.toggle('pos-' + pos, pos === opts.position);
  }

  /** Average the analyser into n bands with log-ish spacing so bass doesn't take over every bar */
  function bands(n) {
    const usable = Math.floor(freq.length * 0.72);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(Math.pow(i / n, 1.7) * usable);
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * usable));
      let sum = 0;
      for (let j = start; j < end; j++) sum += freq[j];
      vals[i] = Math.min(1, (sum / (end - start) / 255) * opts.sensitivity);
    }
  }

  function updatePeaks(n) {
    for (let i = 0; i < n; i++) {
      if (vals[i] >= peaks[i]) { peaks[i] = vals[i]; holds[i] = 22; }
      else if (holds[i] > 0) holds[i]--;
      else peaks[i] = Math.max(vals[i], peaks[i] - 0.016);
    }
  }

  const hue = (i, n, shift) => `hsl(${(i / n * 280 + shift) % 360} 85% 60%)`;

  const quiet = () => {
    const root = document.documentElement;
    return root.hasAttribute('data-perf') || root.hasAttribute('data-hidden') || root.hasAttribute('data-no-visualizer');
  };

  function draw(now = performance.now()) {
    frame = null;
    if (quiet()) return; // minimized, performance mode or a theme that replaces it: no drawing at all
    // 60 fps is plenty for bars; on 120-165 Hz screens every redraw also re-blurs glass themes behind it
    if (now - lastDraw < MIN_FRAME_MS) { frame = requestAnimationFrame(draw); return; }
    lastDraw = now;
    const analyser = player.normalizer && player.normalizer.visual;
    if (!settings.visualizer || !analyser || !canvas.isConnected) return;

    if (!freq || freq.length !== analyser.frequencyBinCount) {
      freq = new Uint8Array(analyser.frequencyBinCount);
      wave = new Uint8Array(analyser.fftSize);
    }
    if (Math.abs(analyser.smoothingTimeConstant - opts.smoothing) > 0.001) analyser.smoothingTimeConstant = opts.smoothing;

    const { w, h: ht, dpr } = size;
    const { style, color } = opts;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ht);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';

    const shift = (performance.now() / 1000) * 20; // rainbow drifts through the hues
    const rainbow = color === 'rainbow';
    const from = color === 'custom' ? opts.colorA : colors.a;
    const to = color === 'custom' ? opts.colorB : colors.b;

    // one fill for everything that isn't per-bar rainbow
    let fill;
    if (style === 'circle') {
      const r = Math.min(w, ht) / 2;
      fill = ctx.createRadialGradient(w / 2, ht / 2, r * 0.35, w / 2, ht / 2, r);
      fill.addColorStop(0, from);
      fill.addColorStop(1, color === 'accent' ? from : to);
    } else if (rainbow && (style === 'wave' || style === 'line')) {
      fill = ctx.createLinearGradient(0, 0, w, 0);
      for (let s = 0; s <= 6; s++) fill.addColorStop(s / 6, hue(s, 6, shift));
    } else {
      fill = ctx.createLinearGradient(0, ht, 0, 0);
      fill.addColorStop(0, from);
      fill.addColorStop(1, color === 'accent' ? from : to);
    }
    const glowColor = (i, n) => (rainbow ? hue(i, n, shift) : from);
    const paint = (i, n) => {
      const c = rainbow && style !== 'wave' && style !== 'line' ? hue(i, n, shift) : fill;
      ctx.fillStyle = c;
      ctx.strokeStyle = c;
      if (opts.glow) { ctx.shadowBlur = 8 * dpr; ctx.shadowColor = glowColor(i, n); }
    };
    paint(0, 1);

    const n = opts.bars;
    const usePeaks = opts.peaks && (style === 'bars' || style === 'mirror' || style === 'dots');
    if (peaks.length < n) { vals = new Float32Array(64); peaks = new Float32Array(64); holds = new Uint8Array(64); }

    if (style === 'wave') {
      analyser.getByteTimeDomainData(wave);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const step = wave.length / w;
      for (let x = 0; x < w; x++) {
        const v = (wave[Math.floor(x * step)] - 128) / 128 * opts.sensitivity;
        const y = ht / 2 + Math.max(-1, Math.min(1, v)) * (ht / 2 - 2) * (player.playing ? 1 : 0);
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    } else {
      analyser.getByteFrequencyData(freq);

      if (style === 'line') {
        const points = Math.max(16, Math.min(64, Math.round(w / 3)));
        bands(points);
        const px = (i) => (i * w) / (points - 1);
        const py = (i) => ht - Math.max(1, vals[i] * (ht - 3)) - 1;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(px(0), py(0));
        for (let i = 1; i < points; i++) {
          ctx.quadraticCurveTo(px(i - 1), py(i - 1), (px(i - 1) + px(i)) / 2, (py(i - 1) + py(i)) / 2);
        }
        ctx.lineTo(px(points - 1), py(points - 1));
        ctx.stroke();
        ctx.lineTo(w, ht);
        ctx.lineTo(0, ht);
        ctx.closePath();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (style === 'circle') {
        const half = Math.ceil(n / 2);
        bands(half); // mirrored left/right so the ring looks balanced
        const radius = Math.min(w, ht) / 2 - 1;
        const inner = radius * 0.38;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1.5, Math.min(3, (Math.PI * 2 * inner) / n * 0.6));
        for (let k = 0; k < n; k++) {
          const v = vals[Math.min(k, n - 1 - k)];
          const angle = (k / n) * Math.PI * 2 - Math.PI / 2;
          const len = Math.max(1.5, v * (radius - inner));
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          paint(k, n);
          ctx.beginPath();
          ctx.moveTo(w / 2 + cos * inner, ht / 2 + sin * inner);
          ctx.lineTo(w / 2 + cos * (inner + len), ht / 2 + sin * (inner + len));
          ctx.stroke();
        }
      } else {
        bands(n);
        if (usePeaks) updatePeaks(n);
        const gap = n > 40 ? 1 : 2;
        const barWidth = Math.max(1, (w - gap * (n - 1)) / n);

        if (style === 'dots') {
          const dotH = Math.max(2, Math.min(barWidth, 4));
          const rowGap = 1.5;
          const rows = Math.max(1, Math.floor((ht + rowGap) / (dotH + rowGap)));
          // unlit dots, one faint path
          ctx.shadowBlur = 0;
          ctx.fillStyle = colors.a;
          ctx.globalAlpha = 0.1;
          ctx.beginPath();
          for (let i = 0; i < n; i++) for (let r = 0; r < rows; r++) dot(i * (barWidth + gap), ht - (r + 1) * dotH - r * rowGap, barWidth, dotH);
          ctx.fill();
          ctx.globalAlpha = 1;
          for (let i = 0; i < n; i++) {
            const lit = Math.max(1, Math.round(vals[i] * rows));
            paint(i, n);
            ctx.beginPath();
            for (let r = 0; r < lit; r++) dot(i * (barWidth + gap), ht - (r + 1) * dotH - r * rowGap, barWidth, dotH);
            if (usePeaks) {
              const pr = Math.min(rows - 1, Math.round(peaks[i] * rows) - 1);
              if (pr >= lit) dot(i * (barWidth + gap), ht - (pr + 1) * dotH - pr * rowGap, barWidth, dotH);
            }
            ctx.fill();
          }
        } else {
          const mirror = style === 'mirror';
          for (let i = 0; i < n; i++) {
            const barHeight = Math.max(2, vals[i] * (mirror ? ht / 2 : ht));
            const x = i * (barWidth + gap);
            paint(i, n);
            ctx.beginPath();
            if (mirror) dot(x, ht / 2 - barHeight, barWidth, barHeight * 2);
            else dot(x, ht - barHeight, barWidth, barHeight);
            if (usePeaks) {
              const rise = peaks[i] * (mirror ? ht / 2 : ht);
              if (rise > barHeight + 1) {
                if (mirror) {
                  dot(x, Math.max(0, ht / 2 - rise - 3), barWidth, 2);
                  dot(x, Math.min(ht - 2, ht / 2 + rise + 1), barWidth, 2);
                } else {
                  dot(x, Math.max(0, ht - rise - 3), barWidth, 2);
                }
              }
            }
            ctx.fill();
          }
        }
      }
    }

    // keep animating while playing, and briefly after pausing so bars fall smoothly
    idle = player.playing ? 0 : idle + 1;
    if (idle < (opts.peaks ? 90 : 40)) frame = requestAnimationFrame(draw);
  }

  /** Adds a small rounded rect to the current path */
  function dot(x, y, w, hgt) {
    const r = Math.min(2, w / 2, hgt / 2);
    ctx.roundRect ? ctx.roundRect(x, y, w, hgt, r) : ctx.rect(x, y, w, hgt);
  }

  const start = () => {
    layout();
    const root = document.documentElement;
    canvas.classList.toggle('hidden', !settings.visualizer || root.hasAttribute('data-perf') || root.hasAttribute('data-no-visualizer'));
    if (quiet()) return;
    idle = 0;
    if (!frame) frame = requestAnimationFrame(draw);
  };

  player.on('state', start);
  player.on('track', start);
  store.on('settings', start);
  document.addEventListener('themechange', () => { colors = readColors(); start(); });
  // the accent can also follow the playing song's artwork (Settings → Appearance)
  document.addEventListener('accentchange', () => { colors = readColors(); start(); });
  document.addEventListener('appvisibility', start);
  // a theme can set <html data-no-visualizer> to replace this visualizer with its own; follow it both ways
  new MutationObserver(start).observe(document.documentElement, { attributes: true, attributeFilter: ['data-no-visualizer'] });
  start();
  return canvas;
}
