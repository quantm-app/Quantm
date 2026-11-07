import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import { startAutoMixCss, stopAutoMixCss } from '../src/js/automix-css.js';

installBrowser();
const { Emitter } = await import('../src/js/dom.js');

function fixture(t, style = 'risograph') {
  stopAutoMixCss();
  const frames = new Map();
  let id = 0;
  let now = 0;
  let calls = 0;
  const media = { matches: false };
  window.matchMedia = () => media;
  globalThis.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = key => frames.delete(key);
  const clock = mock.method(performance, 'now', () => now);
  // a theme that reads --beat and --mix (automix-css only feeds them to those)
  document.documentElement.dataset = { style };
  const status = { on: true, live: { bpm: 120, period: 0.5, offset: 0.1 } };
  const player = Object.assign(new Emitter(), {
    playing: true, autoMix: true, audio: { currentTime: 0.1, playbackRate: 1 }, fading: null,
    autoMixStatus() { calls++; return status; }
  });
  t.after(() => { stopAutoMixCss(); clock.mock.restore(); });
  return {
    player, status, media, frames, html: document.documentElement,
    calls: () => calls,
    frame(time, position = player.audio.currentTime) {
      now = time;
      player.audio.currentTime = position;
      const entry = frames.entries().next().value;
      assert.ok(entry, 'a frame is scheduled');
      frames.delete(entry[0]); entry[1](now);
    }
  };
}

test('on/off and pause/resume gate one loop, reset all hooks, and clean up', t => {
  const f = fixture(t);
  f.player.autoMix = false;
  startAutoMixCss(f.player);
  assert.equal(f.html.dataset.automix, 'off');
  assert.equal(f.calls(), 0);
  assert.equal(f.frames.size, 0);
  f.player.autoMix = true; f.player.emit('time');
  assert.equal(f.html.dataset.automix, 'on');
  assert.equal(f.frames.size, 1);
  f.player.emit('time'); f.player.emit('automix');
  assert.equal(f.frames.size, 1);
  assert.equal(f.calls(), 1);
  f.player.playing = false; f.player.emit('state');
  assert.equal(f.frames.size, 0);
  assert.equal(f.html.dataset.automix, 'off');
  for (const key of ['--beat', '--mix', '--bpm']) assert.equal(f.html.style[key], '0');
  assert.equal(f.html.dataset.swap, undefined);
  assert.equal(f.html.dataset.lock, 'none');
  f.player.playing = true; f.player.emit('state');
  assert.equal(f.frames.size, 1);
  f.player.autoMix = false; f.frame(16);
  assert.equal(f.frames.size, 0);
  assert.equal(f.html.dataset.automix, 'off');
  f.player.autoMix = true; f.player.emit('time');
  startAutoMixCss(f.player); // Startup is idempotent, including listeners.
  assert.equal(f.frames.size, 1);
  stopAutoMixCss(); stopAutoMixCss();
  assert.equal(f.frames.size, 0);
  f.player.emit('state');
  assert.equal(f.frames.size, 0);
});

test('cached grid drives sawtooth, beat parity and live BPM without per-frame status analysis', t => {
  const f = fixture(t);
  startAutoMixCss(f.player);
  f.frame(40, 0.225); // --beat is written at most every 33 ms
  assert.ok(Math.abs(Number(f.html.style['--beat']) - 0.25) < 1e-9);
  f.frame(80, 0.6);
  assert.equal(f.html.style['--beat'], '0');
  f.frame(120, 1.1);
  assert.equal(f.calls(), 1);
  f.player.audio.playbackRate = 1.1;
  f.frame(250, 1.225);
  assert.equal(f.calls(), 2);
  assert.equal(f.html.style['--bpm'], '132');
  f.frame(300, 0); // A seek before the grid origin still wraps into [0, 1).
  assert.ok(Math.abs(Number(f.html.style['--beat']) - 0.8) < 1e-9);
});

test('mix progress follows the audio clock, swap is at halfway, lock requires small error', t => {
  const f = fixture(t);
  f.player.fading = { progress: 0.2, startedAt: 10, seconds: 10 };
  f.player.normalizer = { ctx: { currentTime: 10 } };
  f.status.mix = { progress: 0.2 };
  f.status.lock = { active: true, errorMs: -8 };
  startAutoMixCss(f.player);
  assert.equal(f.html.dataset.automix, 'mixing');
  assert.equal(f.html.style['--mix'], '0.2');
  assert.equal(f.html.dataset.swap, 'before');
  assert.equal(f.html.dataset.lock, 'locked');
  f.player.normalizer.ctx.currentTime = 13;
  f.frame(40);
  assert.equal(f.html.style['--mix'], '0.5');
  assert.equal(f.html.dataset.swap, 'after');
  f.status.lock = { active: true, errorMs: 30 };
  f.frame(250);
  assert.equal(f.html.dataset.lock, 'none');
  f.player.normalizer.ctx.currentTime = 30;
  f.frame(300);
  assert.equal(f.html.style['--mix'], '1');
  f.player.fading = null; f.frame(282);
  assert.equal(f.html.dataset.automix, 'on');
  assert.equal(f.html.style['--mix'], '0');
  assert.equal(f.html.dataset.swap, undefined);
  assert.equal(f.html.dataset.lock, 'none');
});

test('mixing uses incoming grid, stale plans are rejected, structure is the last fallback', t => {
  const f = fixture(t);
  f.player.mixPlan = { grid: { bpm: 100, period: 0.6, offset: 0 } };
  startAutoMixCss(f.player);
  assert.equal(f.html.style['--bpm'], '100');
  f.player.fading = { progress: 0 };
  f.player.lock = { match: { gridIn: { bpm: 150, period: 0.4, offset: 0.05 } } };
  f.player.audio = { currentTime: 0.15, playbackRate: 1 };
  f.frame(40);
  assert.equal(f.html.style['--bpm'], '150');
  assert.ok(Math.abs(Number(f.html.style['--beat']) - 0.25) < 1e-9);
  f.player.fading = null;
  f.player.mixPlan.loadId = 1; f.player.loadId = 2;
  f.status.live = null;
  f.status.structure = { grid: { bpm: 90, period: 2 / 3, offset: 0 } };
  f.frame(300);
  assert.equal(f.html.style['--bpm'], '90');
  f.status.structure.grid = { period: NaN, offset: 0 };
  f.frame(560);
  assert.equal(f.html.style['--bpm'], '0');
  assert.equal(f.html.style['--beat'], '0');
});

test('motion off freezes beat markers; auto respects reduced motion and on can override', t => {
  const f = fixture(t, 'ink-wash'); // the beat marker is only flipped for themes that read it
  startAutoMixCss(f.player);
  f.frame(16, 0.6);
  assert.equal(f.html.dataset.beat, 'b');
  f.html.dataset.themeMotion = 'off';
  f.frame(32, 1.1);
  assert.equal(f.html.dataset.beat, 'b');
  f.player.playing = false; f.player.emit('state');
  assert.equal(f.html.dataset.beat, 'b');
  f.player.playing = true; f.player.emit('state');
  f.html.dataset.themeMotion = 'auto'; f.media.matches = true;
  f.frame(48, 1.1);
  assert.equal(f.html.dataset.beat, 'b');
  f.html.dataset.themeMotion = 'on';
  f.frame(64, 1.1);
  assert.equal(f.html.dataset.beat, 'a');
});

test('beat parity flips only for themes whose CSS or pack reads data-beat', t => {
  const f = fixture(t, 'ink-wash');
  startAutoMixCss(f.player);
  f.frame(16, 0.225);
  assert.equal(f.html.dataset.beat, 'a');
  f.frame(32, 0.6);
  assert.equal(f.html.dataset.beat, 'b');
  f.frame(48, 1.1);
  assert.equal(f.html.dataset.beat, 'a');
  const g = fixture(t, 'dark-aero');
  startAutoMixCss(g.player);
  g.frame(16, 0.6);
  assert.equal(g.html.dataset.beat, 'a', 'a theme that ignores data-beat is never flipped');
});

/** Counts every write to <html> (attributes, dataset and custom properties) while a 10 s fade runs at 60 fps. */
function fade(t, style, seconds = 10) {
  const f = fixture(t, style);
  const log = {};
  const data = f.html.dataset;
  f.html.dataset = new Proxy(data, {
    set(o, k, v) { if (o[k] !== v) log['data-' + k] = (log['data-' + k] || 0) + 1; o[k] = v; return true; },
    deleteProperty(o, k) { if (k in o) log['data-' + k] = (log['data-' + k] || 0) + 1; delete o[k]; return true; }
  });
  const props = {}, realStyle = f.html.style;
  f.html.style = { setProperty(k, v) { log[k] = (log[k] || 0) + 1; props[k] = v; } };
  t.after(() => { f.html.style = realStyle; });
  f.player.fading = { progress: 0, startedAt: 0, seconds };
  f.player.normalizer = { ctx: { currentTime: 0 } };
  f.status.mix = { progress: 0, style: 'blend' };
  f.status.live = { bpm: 128, period: 60 / 128, offset: 0.1 };
  startAutoMixCss(f.player);
  for (const key of Object.keys(log)) delete log[key];
  for (let time = 0; time <= seconds * 1000; time += 1000 / 60) {
    f.player.normalizer.ctx.currentTime = time / 1000;
    f.frame(time, time / 1000);
  }
  return { log, props, total: Object.values(log).reduce((a, b) => a + b, 0), f };
}

test('a theme that does not read --mix gets no --mix or beat writes during a fade', t => {
  const { log, total } = fade(t, 'dark-aero');
  assert.equal(log['--mix'], undefined);
  assert.equal(log['--beat'], undefined);
  assert.equal(log['data-beat'], undefined);
  assert.ok(total <= 2, `only the swap flip is written (${total}): ${JSON.stringify(log)}`);
});

test('a theme that reads --mix gets it during a fade, at most about 30 times a second, ending at the true value', t => {
  const { log, props } = fade(t, 'tiling');
  assert.ok(log['--mix'] > 100 && log['--mix'] <= 10 * 31, `${log['--mix']} writes in 10 s`);
  assert.equal(log['--beat'], undefined, 'tiling does not read --beat');
  assert.ok(Number(props['--mix']) > 0.97, 'the last write is within a frame or two of the end');
});

test('switching to a theme that ignores --mix mid-fade leaves it at 0, and reset leaves everything clean', t => {
  const f = fixture(t, 'tiling');
  f.player.fading = { progress: 0.4 };
  f.status.mix = { progress: 0.4 };
  startAutoMixCss(f.player);
  assert.equal(f.html.style['--mix'], '0.4');
  f.html.dataset.style = 'dark-aero';
  f.frame(100);
  assert.equal(f.html.style['--mix'], '0');
  f.html.dataset.style = 'tiling';
  f.frame(200);
  assert.equal(f.html.style['--mix'], '0.4', 'switching back resumes at once');
  f.player.playing = false; f.player.emit('state');
  for (const key of ['--mix', '--beat', '--bpm']) assert.equal(f.html.style[key], '0');
  assert.equal(f.html.dataset.swap, undefined);
});

test('the style lists match the CSS: every theme that reads --mix, --beat or data-beat is in its list', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { BEAT_STYLES, MIX_STYLES, BEAT_MARK_STYLES } = await import('../src/js/automix-css.js');
  const root = new URL('../src/styles/', import.meta.url);
  const files = [];
  const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : e.name.endsWith('.css') && files.push(new URL(e.name, dir)); };
  walk(root);
  const reads = { mix: new Set(), beat: new Set(), mark: new Set() };
  const unscoped = [];
  for (const file of files) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const styles = [...selector.matchAll(/\[data-(?:base-)?style="([^"]+)"\]/g)].map(m => m[1]);
      const hit = (kind, pattern) => {
        if (!pattern.test(kind === 'mark' ? selector : body)) return;
        if (!styles.length) unscoped.push(`${file.pathname.split('/').pop()}: ${selector.trim().slice(0, 60)}`);
        styles.forEach(s => reads[kind].add(s));
      };
      hit('mix', /var\(--mix/); hit('beat', /var\(--beat/); hit('mark', /\[data-beat/);
    }
  }
  assert.deepEqual(unscoped, [], 'every rule that reads these must be scoped to a theme');
  const missing = (found, list) => [...found].filter(s => !list.has(s));
  assert.deepEqual(missing(reads.mix, MIX_STYLES), [], 'var(--mix) readers missing from MIX_STYLES');
  assert.deepEqual(missing(reads.beat, BEAT_STYLES), [], 'var(--beat) readers missing from BEAT_STYLES');
  assert.deepEqual(missing(reads.mark, BEAT_MARK_STYLES), [], 'data-beat readers missing from BEAT_MARK_STYLES');
});
