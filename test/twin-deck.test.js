import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { Emitter, h } = await import('../src/js/dom.js');
const { mount } = await import('../src/js/packs/twin-deck.js');
const find = (node, name) => node.className?.split(' ').includes(name) ? node :
  node.childNodes.map(child => find(child, name)).find(Boolean);

test('console follows both decks, settings, queue navigation, pause and beat markers; disposes all work', async t => {
  let interval;
  let cleared = false;
  const timers = mock.method(globalThis, 'setInterval', fn => { interval = fn; return 42; });
  const cancel = mock.method(globalThis, 'clearInterval', id => { assert.equal(id, 42); cleared = true; });
  let mutated;
  let disconnected = false;
  const NativeObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(fn) { mutated = fn; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  const clock = mock.method(performance, 'now', () => 0);
  t.after(() => {
    timers.mock.restore(); cancel.mock.restore(); clock.mock.restore();
    globalThis.MutationObserver = NativeObserver;
  });
  window.matchMedia = () => ({ matches: false });
  document.documentElement.dataset = { themeMotion: 'on', beat: 'a', automix: 'mixing' };
  const tracks = [1, 2, 3].map(id => ({ id, title: `Record ${id}`, user: { username: `Artist ${id}` }, duration: 240000 }));
  const grid = { bpm: 120, period: 0.5, offset: 0 };
  const store = new Emitter();
  let jumped;
  let calls = 0;
  const player = Object.assign(new Emitter(), {
    playing: true, autoMix: true, current: tracks[1], index: 1, queue: tracks,
    audio: { currentTime: 1, playbackRate: 1 },
    fading: { from: tracks[0], to: tracks[1] },
    lock: { match: { gridOut: grid, gridIn: grid } },
    autoMixStatus() { calls++; return { live: grid, mix: this.fading && { progress: 0.6 }, lock: { active: true, errorMs: 5 } }; },
    jump(index) { jumped = index; }
  });
  const page = h('div');
  let loader;
  const unmount = mount({ player, store, views: { override(name, value) { assert.equal(name, 'home'); loader = value; } } });
  t.after(unmount);
  const disposeView = (await loader()).render(page);
  const a = find(page, 'td-deck-a');
  const b = find(page, 'td-deck-b');
  const consoleNode = find(page, 'td-console');
  assert.equal(find(a, 'td-track-title').textContent, 'Record 1');
  assert.equal(find(b, 'td-track-title').textContent, 'Record 2');
  assert.equal(find(a, 'td-bpm').textContent, '120.0');
  assert.equal(consoleNode.dataset.mixing, 'true');
  assert.equal(find(page, 'td-lock-state').textContent, 'Locked');
  assert.equal(find(page, 'td-crossfader').attributes.get('aria-valuenow'), '60');
  document.documentElement.dataset.beat = 'b'; mutated();
  assert.equal(find(page, 'td-beats').dataset.step, '1');
  mutated(); // Repeated attributes cannot advance the four-step counter.
  assert.equal(find(page, 'td-beats').dataset.step, '1');
  document.documentElement.dataset.themeMotion = 'off';
  document.documentElement.dataset.beat = 'a'; mutated();
  assert.equal(find(page, 'td-beats').dataset.step, '1');
  const crate = find(page, 'td-crate');
  find(crate.childNodes[1], 'td-crate-track').dispatchEvent({ type: 'click' });
  assert.equal(jumped, 2);
  player.playing = false; player.emit('state');
  assert.equal(consoleNode.dataset.playing, 'false');
  player.autoMix = false; store.emit('settings');
  assert.equal(find(b, 'td-track-title').textContent, 'Auto mix off');
  assert.equal(find(b, 'td-bpm').textContent, '---.-');
  assert.equal(find(a, 'td-track-title').textContent, 'Record 2');
  assert.equal(consoleNode.dataset.auto, 'off');
  const before = calls;
  interval(); // Paused/off does not poll expensive status analysis.
  assert.equal(calls, before);
  unmount(); disposeView(); unmount();
  assert.equal(find(page, 'td-workstation'), undefined);
  assert.ok(cleared);
  assert.ok(disconnected);
  assert.ok(Object.values(player.handlers).every(list => list.length === 0));
  assert.ok(Object.values(store.handlers).every(list => list.length === 0));
});

test('a drop cut holds the crossfader on A, sweeps A\'s bass away, then snaps to B', async t => {
  const timers = mock.method(globalThis, 'setInterval', () => 7);
  const cancel = mock.method(globalThis, 'clearInterval', () => {});
  const NativeObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const clock = mock.method(performance, 'now', () => 0);
  t.after(() => { timers.mock.restore(); cancel.mock.restore(); clock.mock.restore(); globalThis.MutationObserver = NativeObserver; });
  window.matchMedia = () => ({ matches: false });
  document.documentElement.dataset = { themeMotion: 'on', beat: 'a', automix: 'mixing' };
  const tracks = [1, 2].map(id => ({ id, title: `Record ${id}`, user: { username: `Artist ${id}` }, duration: 240000 }));
  const grid = { bpm: 128, period: 60 / 128, offset: 0 };
  let mix = { style: 'dropcut', phase: 'build', progress: 0.3 };
  const player = Object.assign(new Emitter(), {
    playing: true, autoMix: true, current: tracks[0], index: 0, queue: tracks,
    audio: { currentTime: 1, playbackRate: 1 },
    normalizer: { ctx: { currentTime: 12 } },
    fading: { from: tracks[0], to: tracks[1], style: 'dropcut', schedule: { start: 10, cut: 18, drop: 18.1, kill: { style: 'sweep' } } },
    lock: null,
    autoMixStatus() { return { live: grid, mix }; }
  });
  const store = new Emitter();
  let loader;
  const unmount = mount({ player, store, views: { override(name, value) { loader = value; } } });
  t.after(unmount);
  const page = h('div');
  const dispose = (await loader()).render(page);
  t.after(dispose);
  const consoleNode = find(page, 'td-console');
  const a = find(page, 'td-deck-a');
  const b = find(page, 'td-deck-b');
  const sync = () => player.emit('automix');
  assert.equal(find(page, 'td-session-status').textContent, 'DROP CUT · BUILD');
  assert.equal(consoleNode.dataset.style, 'dropcut');
  assert.equal(find(page, 'td-lock-state').textContent, 'No lock needed');
  assert.equal(consoleNode.style['--td-xfade'], '0');
  assert.equal(find(page, 'td-crossfader').attributes.get('aria-valuenow'), '0');
  assert.equal(a.style['--td-eq-angle'], '-30deg'); // 2 s into an 8 s sweep
  assert.equal(b.style['--td-eq-angle'], '-120deg');
  mix = { style: 'dropcut', phase: 'drop', progress: 0.9 };
  clock.mock.mockImplementation(() => 1000); sync();
  assert.equal(find(page, 'td-session-status').textContent, 'DROP CUT · DROP');
  assert.equal(find(page, 'td-phase-error').textContent, 'Cuts on the drop');
  assert.equal(consoleNode.style['--td-xfade'], '1');
  assert.equal(a.style['--td-eq-angle'], '-120deg');
  assert.equal(b.style['--td-eq-angle'], '0deg');
  // a blend keeps the beat lock readout and the shared crossfader
  mix = { style: 'blend', progress: 0.4 };
  player.fading = { from: tracks[0], to: tracks[1], style: 'blend' };
  clock.mock.mockImplementation(() => 2000); sync();
  assert.equal(find(page, 'td-session-status').textContent, 'SMOOTH BLEND');
  assert.equal(find(page, 'td-phase-error').textContent, 'Finding the beat');
  assert.equal(consoleNode.style['--td-xfade'], '');
  assert.equal(a.style['--td-eq-angle'], '');
  assert.equal(find(page, 'td-crossfader').attributes.get('aria-valuenow'), '40');
  // Auto's genre transitions are named on the console
  let at = 3000;
  for (const [genre, style, label] of [['doubledrop', 'blend', 'DOUBLE DROP'], ['filterfade', 'blend', 'FILTER FADE'], ['quickcut', 'dropcut', 'QUICK CUT · BUILD']]) {
    mix = { style, genre, phase: 'build', progress: 0.4 };
    player.fading = { from: tracks[0], to: tracks[1], style, schedule: { start: 10, cut: 18, drop: 18.1, kill: { style: 'none' } } };
    clock.mock.mockImplementation(() => (at += 1000)); sync();
    assert.equal(find(page, 'td-session-status').textContent, label);
  }
});
