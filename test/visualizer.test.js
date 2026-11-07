import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const timer = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
timer.mock.restore();
const { createVisualizer } = await import('../src/js/visualizer.js');

// Controllable stand-ins: a class-set canvas, a recording 2D context, a frame queue and a manual MutationObserver.
function rig() {
  const root = document.documentElement;
  const attributes = new Map();
  Object.assign(root, {
    hasAttribute: key => attributes.has(key),
    setAttribute: (key, value) => attributes.set(key, String(value)),
    removeAttribute: key => attributes.delete(key)
  });
  const draws = [], frames = [], observers = [];
  const classes = new Set();
  const previous = { create: document.createElement, raf: globalThis.requestAnimationFrame, observer: globalThis.MutationObserver,
    computed: globalThis.getComputedStyle, add: document.addEventListener };
  document.createElement = (...args) => {
    const el = previous.create(...args);
    el.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); } };
    el.getContext = () => new Proxy({}, {
      get: (target, key) => key in target ? target[key] : () => { if (key === 'clearRect') draws.push(key); return { addColorStop() {} }; },
      set: (target, key, value) => { target[key] = value; return true; }
    });
    return el;
  };
  globalThis.requestAnimationFrame = fn => frames.push(fn);
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ff5500' });
  globalThis.MutationObserver = class {
    constructor(fn) { observers.push(fn); }
    observe() {}
    disconnect() {}
  };
  const analyser = { frequencyBinCount: 32, fftSize: 64, smoothingTimeConstant: 0.8, getByteFrequencyData(a) { a.fill(180); }, getByteTimeDomainData(a) { a.fill(128); } };
  player.normalizer = { visual: analyser };
  const canvas = createVisualizer();
  document.body.appendChild(canvas);
  const flush = () => { let now = 1000; while (frames.length) frames.splice(0).forEach(fn => fn(now += 100)); };
  const restore = () => {
    document.createElement = previous.create; globalThis.requestAnimationFrame = previous.raf;
    globalThis.MutationObserver = previous.observer; globalThis.getComputedStyle = previous.computed;
    player.normalizer = undefined; canvas.remove();
  };
  // Like the browser: the attribute change reaches the visualizer's observer.
  const setAttr = (on) => { if (on) root.setAttribute('data-no-visualizer', ''); else root.removeAttribute('data-no-visualizer'); observers.forEach(fn => fn([])); };
  return { canvas, classes, draws, flush, restore, setAttr, observers };
}

test('data-no-visualizer hides the player-bar canvas and stops drawing; removing it restores both', t => {
  const r = rig();
  t.after(r.restore);
  assert.equal(r.observers.length, 1);
  r.flush();
  assert.ok(r.draws.length > 0);
  assert.equal(r.classes.has('hidden'), false);

  r.setAttr(true);
  assert.equal(r.classes.has('hidden'), true);
  r.draws.length = 0;
  r.flush();
  assert.equal(r.draws.length, 0);

  r.setAttr(false);
  assert.equal(r.classes.has('hidden'), false);
  r.flush();
  assert.ok(r.draws.length > 0);
});

test('the attribute does not touch the user\'s visualizer setting, and a user-disabled visualizer stays hidden after it is removed', async t => {
  const { settings } = await import('../src/js/store.js');
  const r = rig();
  t.after(r.restore);
  r.setAttr(true);
  assert.equal(settings.visualizer, true);
  settings.visualizer = false;
  t.after(() => { settings.visualizer = true; });
  r.setAttr(false);
  assert.equal(r.classes.has('hidden'), true);
});
