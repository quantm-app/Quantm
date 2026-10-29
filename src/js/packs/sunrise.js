import { h } from '../dom.js';
import { getTheme } from '../theme.js';
import { motionAllowed } from '../audio-reactivity.js';

/** A single small canvas; the sky itself is two inexpensive CSS gradients. */
export function mount(ctx) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sky = h('div.sunrise-sky');
  const nextSky = h('div.sunrise-sky.sunrise-sky-next');
  const canvas = h('canvas.sunrise-landscape', { width: 640, height: 360 });
  const paint = canvas.getContext('2d');
  ctx.root.classList.add('sunrise-layer');
  ctx.root.append(sky, nextSky, canvas);
  let alive = true;
  let night = getTheme().preset === 'Sunrise Night';
  let last = -Infinity;
  let drift = 0;
  let colors = [];
  let mixing = false;
  const homes = new Set();
  const visible = () => !document.hidden && !document.documentElement.hasAttribute('data-hidden');
  const motion = () => motionAllowed(ctx.settings, reduced) &&
    document.documentElement.dataset.themeMotion !== 'off' &&
    !(document.documentElement.dataset.themeMotion === 'auto' && reduced.matches);

  function draw(frame = {}) {
    if (!paint || !visible()) return;
    const bass = frame.bass || 0, mid = frame.mid || 0, treble = frame.treble || 0;
    const energy = Math.min(1, (frame.level || 0) * 2 + bass * 0.35);
    const w = canvas.width, height = canvas.height;
    paint.clearRect(0, 0, w, height);
    // Clip horizontal bands into the sun instead of painting opaque stripes over the sky.
    paint.save();
    paint.beginPath();
    const sunY = height * 0.41 - energy * 28;
    paint.arc(w * 0.73, sunY, 53, 0, Math.PI * 2);
    paint.clip();
    paint.fillStyle = colors[0];
    for (let y = sunY - 53; y <= sunY + 53; y += 8) paint.fillRect(0, y, w, 5.5);
    paint.restore();
    const bands = [bass, mid, treble];
    for (let layer = 0; layer < 3; layer++) {
      const base = height * (0.72 + layer * 0.09);
      const parallax = drift * (0.18 + layer * 0.2);
      paint.beginPath();
      paint.moveTo(0, height);
      for (let x = 0; x <= w; x += 8) {
        const u = x / w;
        const hill = Math.sin(u * 6.2 + layer * 1.9 + parallax) * 19 +
          Math.sin(u * 11.3 + layer * 0.8 + parallax * 0.6) * 9;
        paint.lineTo(x, base + hill - bands[layer] * (20 - layer * 3));
      }
      paint.lineTo(w, height);
      paint.closePath();
      paint.fillStyle = colors[layer + 1];
      paint.fill();
    }
  }

  function palette() {
    ctx.root.classList.toggle('sunrise-night', night);
    const style = getComputedStyle(ctx.root);
    colors = ['sun', 'hill-far', 'hill-mid', 'hill-near'].map(name =>
      style.getPropertyValue(`--sunrise-${name}`).trim());
    draw();
  }

  function sync() {
    ctx.root.classList.toggle('sunrise-still', !motion());
    last = -Infinity;
    if (visible() && (!motion() || !ctx.player.playing)) draw();
  }

  // Keep discovery intact, and give the decorative sky a quiet, text-free opening.
  ctx.views.override('home', async () => {
    const home = await import('../views/home.js');
    return { async render(container, ...args) {
      const content = h('div.sunrise-content');
      const shell = h('div.sunrise-home', h('div.sunrise-vista', { 'aria-hidden': 'true' }), content);
      if (!alive) return;
      homes.add(shell);
      container.append(shell);
      const cleanup = await home.render(content, ...args);
      if (!alive) { if (typeof cleanup === 'function') cleanup(); return; }
      return () => {
        if (typeof cleanup === 'function') cleanup();
        homes.delete(shell);
        shell.remove();
      };
    } };
  });

  ctx.on(document, 'themechange', event => {
    night = (event.detail || getTheme()).preset === 'Sunrise Night';
    palette();
    sync();
  });
  ctx.on(ctx.moments, 'transition', ({ phase }) => {
    if (phase === 'start') mixing = true;
    else if (phase === 'end' && mixing) {
      // Commit the destination sky so resetting --mix cannot snap back to dusk.
      night = !night;
      mixing = false;
      ctx.root.style.setProperty('--sunrise-progress', '0');
      palette();
    }
  });
  ctx.on(ctx.store, 'settings', sync);
  ctx.on(reduced, 'change', sync);
  ctx.on(document, 'visibilitychange', sync);
  ctx.on(document, 'appvisibility', sync);
  ctx.frame(frame => {
    if (!frame.playing || !motion() || frame.time - last < 1000 / 30) return;
    const dt = Number.isFinite(last) ? Math.min(0.1, (frame.time - last) / 1000) : 0;
    last = frame.time;
    drift += dt * 0.025;
    const mix = ctx.player.autoMixStatus?.().mix;
    if (mix) mixing = true;
    ctx.root.style.setProperty('--sunrise-progress', String(Math.max(0, Math.min(1, mix?.progress || 0))));
    draw(frame);
  });
  palette();
  sync();
  return () => {
    alive = false;
    homes.forEach(home => home.remove());
    homes.clear();
    sky.remove(); nextSky.remove(); canvas.remove();
    ctx.root.classList.remove('sunrise-layer', 'sunrise-night', 'sunrise-still');
    ctx.root.style.removeProperty('--sunrise-progress');
  };
}
