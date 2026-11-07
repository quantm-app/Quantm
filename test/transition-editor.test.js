import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
let draws = 0;
const ctx = new Proxy({}, { get: (t, k) => k in t ? t[k] : () => {}, set: (t, k, v) => { t[k] = v; return true; } });
Object.assign(Element.prototype, {
  getBoundingClientRect() { return { width: 800, height: 150, left: 0, top: 0 }; },
  getContext() { draws++; return ctx; }
});
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const observers = [];
globalThis.ResizeObserver = class {
  disconnected = false;
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
};
const { transitionDialog } = await import('../src/js/transition-editor.js');
const cues = await import('../src/js/cues.js');

const from = { id: 1, title: 'First', duration: 240000, user: { username: 'A' } };
const to = { id: 2, title: 'Second', duration: 200000, user: { username: 'B' } };
const other = { id: 3, title: 'Third', duration: 200000 };

function fakePlayer(current = from, next = to) {
  const handlers = {};
  const p = {
    current, queue: [current, next], index: 0, seeks: [],
    crossfadeSeconds: () => 0,
    on(name, fn) { (handlers[name] ||= []).push(fn); return () => { handlers[name] = handlers[name].filter(f => f !== fn); }; },
    emit(name) { (handlers[name] || []).forEach(fn => fn()); },
    seek(t) { p.seeks.push(t); },
    listeners: () => Object.values(handlers).flat().length
  };
  return p;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (type, props = {}) => ({ type, button: 0, pointerId: 1, stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {}, ...props });
const walk = (node, fn) => {
  if (fn(node)) return node;
  for (const child of node.childNodes || []) { const found = walk(child, fn); if (found) return found; }
  return null;
};
const role = (root, name) => walk(root, n => n.dataset?.role === name);
const preset = (root, id) => walk(root, n => n.dataset?.preset === id);
const text = (node) => (node.textContent ?? '') + (node.childNodes || []).map(text).join('');
const byText = (root, label) => walk(root, n => n.className?.includes?.('btn') && text(n) === label);
const click = (node) => node.dispatchEvent(event('click'));
const pressed = (node) => node.attributes.get('aria-pressed');
const open = (opts = {}) => {
  const player = opts.player || fakePlayer();
  const dialog = transitionDialog(from, to, {
    player, waveform: opts.waveform || (() => Promise.resolve([0.2, 0.9, 0.5, 0.7])),
    info: () => opts.info || { bpm: 140, key: null, downbeat: 0 }
  });
  return { dialog, player };
};

test('preview is enabled only when the first song is playing with the second queued next, and follows track changes', async () => {
  cues._reset();
  let { dialog, player } = open();
  assert.equal(role(dialog, 'preview').disabled, false);
  player.current = other; player.queue = [other, to];
  player.emit('track');
  assert.equal(role(dialog, 'preview').disabled, true);
  assert.match(text(dialog), /Play the first song with this one next to preview/);
  dialog.close();

  ({ dialog, player } = open({ player: fakePlayer(from, other) }));
  assert.equal(role(dialog, 'preview').disabled, true);
  dialog.close();
  ({ dialog } = open({ player: fakePlayer(other, to) }));
  assert.equal(role(dialog, 'preview').disabled, true);
  dialog.close();
  await flush();
});

test('preview applies the draft and seeks four seconds before the out point; cancel restores the original pair', async () => {
  cues._reset();
  cues.setPair(1, 2, { out: 120, in: 8, fade: 10, style: 'blend', curve: { dj: 1, center: 0.7 } });
  const before = cues.getPair(1, 2);
  let { dialog, player } = open();
  click(preset(dialog, 'early'));
  click(role(dialog, 'preview'));
  assert.deepEqual(player.seeks, [116]);
  assert.deepEqual(cues.getPair(1, 2).curve, { dj: 1, center: 0.3 }, 'the real pair now holds the draft');
  click(byText(dialog, 'Cancel'));
  assert.deepEqual(cues.getPair(1, 2), before);

  // no pair at first: cancel removes the preview pair, and the seek never goes below zero
  cues._reset();
  cues.setMixOut(1, 2);
  ({ dialog, player } = open());
  click(preset(dialog, 'smooth'));
  click(role(dialog, 'preview'));
  assert.deepEqual(player.seeks, [0]);
  assert.ok(cues.getPair(1, 2));
  dialog.close();
  assert.equal(cues.getPair(1, 2), null);

  // a track change during preview leaves the dialog open and only disables the button
  cues._reset();
  ({ dialog, player } = open());
  click(role(dialog, 'preview'));
  player.current = to; player.queue = [to, other];
  player.emit('track');
  assert.equal(role(dialog, 'preview').disabled, true);
  dialog.close();
  await flush();
});

test('saving stores the curve and style; presets reflect the draft and arrows move the swap handle', async () => {
  cues._reset();
  const { dialog } = open();
  await flush();
  assert.equal(pressed(preset(dialog, 'default')), 'true');
  const handle = role(dialog, 'swap-handle');
  handle.dispatchEvent(event('keydown', { key: 'ArrowRight' }));
  assert.equal(pressed(preset(dialog, 'custom')), 'true');
  assert.equal(pressed(preset(dialog, 'default')), 'false');
  assert.equal(handle.attributes.get('aria-valuenow'), '55');
  click(byText(dialog, 'Save for this pair'));
  const pair = cues.getPair(1, 2);
  assert.equal(pair.style, 'blend');
  assert.deepEqual(pair.curve, { dj: 1, center: 0.55 });
  assert.equal(pair.fade, null, 'the fade was not touched, so it is not stored');
  assert.equal(pair.out, null);
  assert.equal(pair.in, null);
  await flush();
});

test('choosing a preset sets its style, and Drop cut hides the swap handle and shows the drop note', async () => {
  cues._reset();
  const { dialog } = open();
  const handle = role(dialog, 'swap-handle');
  const note = () => walk(dialog, n => text(n).startsWith('Drop cut uses a confirmed drop') && n.className?.includes?.('small'));
  assert.equal(handle.hidden, true, 'no pair curve, nothing to drag');
  click(preset(dialog, 'swap'));
  assert.equal(pressed(preset(dialog, 'swap')), 'true');
  assert.equal(handle.hidden, false);
  click(preset(dialog, 'dropcut'));
  assert.equal(handle.hidden, true);
  assert.equal(pressed(preset(dialog, 'dropcut')), 'true');
  assert.equal(note().hidden, false);
  click(preset(dialog, 'smooth'));
  assert.equal(handle.hidden, false);
  assert.equal(note().hidden, true);
  click(byText(dialog, 'Save for this pair'));
  assert.deepEqual(cues.getPair(1, 2).curve, { dj: 0 });
  await flush();
});

test('bar chips highlight only a matching length, and are absent without a tempo', async () => {
  cues._reset();
  cues.setPair(1, 2, { out: 100, in: 0, fade: 6 });
  let { dialog } = open();
  const chips = () => { const found = []; walk(dialog, n => { if (n.dataset?.role === 'bars-chip') found.push(n); }); return found; };
  assert.equal(chips().length, 4);
  click(chips()[1]); // 8 bars at 140 bpm = 13.7 s
  assert.equal(pressed(chips()[1]), 'true');
  const slider = role(dialog, 'fade-slider');
  slider.value = '13';
  slider.dispatchEvent(event('input'));
  assert.ok(chips().every(chip => pressed(chip) === 'false'));
  dialog.close();
  ({ dialog } = open({ info: { bpm: null, key: null, downbeat: 0 } }));
  assert.equal(walk(dialog, n => n.dataset?.role === 'bars-chip'), null);
  assert.doesNotMatch(text(dialog), /bpm/, 'an unknown tempo shows nothing');
  assert.doesNotMatch(text(dialog), /NaN/);
  dialog.close();
  await flush();
});

test('Space on a drag area or the handle stays out of the app shortcuts, and arrows slide by a bar', async () => {
  cues._reset();
  const { dialog } = open();
  for (const name of ['drag-out', 'drag-in', 'swap-handle']) {
    const space = event('keydown', { key: ' ', code: 'Space' });
    role(dialog, name).dispatchEvent(space);
    assert.equal(space.stopped, true, name);
  }
  const escape = event('keydown', { key: 'Escape' });
  role(dialog, 'drag-out').dispatchEvent(escape);
  assert.equal(escape.stopped, false, 'Escape still reaches the modal');
  role(dialog, 'drag-in').dispatchEvent(event('keydown', { key: 'ArrowLeft' }));
  role(dialog, 'drag-in').dispatchEvent(event('keydown', { key: 'ArrowLeft' }));
  click(byText(dialog, 'Save for this pair'));
  assert.equal(cues.getPair(1, 2).in, 0, 'in cannot go before the start of the song');
  await flush();
});

test('dragging a waveform moves its point, and holding Alt skips the bar snap', async () => {
  cues._reset();
  const { dialog } = open();
  const drag = role(dialog, 'drag-in');
  drag.dispatchEvent(event('pointerdown', { clientX: 400 }));
  drag.dispatchEvent(event('pointermove', { clientX: 330, altKey: true }));
  drag.dispatchEvent(event('pointerup', { clientX: 330 }));
  click(byText(dialog, 'Save for this pair'));
  const moved = cues.getPair(1, 2).in;
  assert.ok(moved > 0, `moved right-to-left drags the song later, got ${moved}`);
  assert.ok(Math.abs(moved / 2 - Math.round(moved / 2)) > 0.01, `unsnapped, got ${moved}`);
  await flush();
});

test('a closed dialog never draws, even when the waveform, resize or theme events arrive late', async () => {
  cues._reset();
  let finish;
  const { dialog, player } = open({ waveform: () => new Promise(resolve => { finish = resolve; }) });
  const observer = observers.at(-1);
  const during = draws;
  assert.ok(during > 0, 'drew the placeholder while loading');
  assert.ok(player.listeners() > 0);
  dialog.close();
  assert.equal(observer.disconnected, true);
  assert.equal(player.listeners(), 0);
  finish([0.5, 0.6]);
  await flush();
  observer.callback();
  document.dispatchEvent({ type: 'themechange' });
  assert.equal(draws, during);
});

const field = (dialog, label) => walk(dialog, n => n.attributes?.get?.('aria-label') === label);

test('an automatic leave point moves earlier as the fade grows; an explicit one limits the fade', async () => {
  cues._reset();
  let { dialog } = open();
  const slider = role(dialog, 'fade-slider');
  slider.value = '30';
  slider.dispatchEvent(event('input'));
  assert.equal(slider.value, '30');
  assert.equal(field(dialog, 'Leave First at').attributes.get('placeholder'), '3:30');
  dialog.close();
  cues.setPair(1, 2, { out: 235, in: 0, fade: null });
  ({ dialog } = open());
  const limited = role(dialog, 'fade-slider');
  limited.value = '30';
  limited.dispatchEvent(event('input'));
  assert.equal(limited.value, '5');
  dialog.close();
  await flush();
});

test('a blank time box saves as no override, and only dragging or typing makes a point explicit', async () => {
  cues._reset();
  cues.setPair(1, 2, { out: 100, in: 8, fade: 10 });
  let { dialog } = open();
  const leave = field(dialog, 'Leave First at'), start = field(dialog, 'Start Second at');
  assert.equal(leave.value, '1:40');
  leave.value = '';
  leave.dispatchEvent(event('input'));
  start.value = '';
  start.dispatchEvent(event('input'));
  click(byText(dialog, 'Save for this pair'));
  assert.deepEqual(cues.getPair(1, 2), { out: null, in: null, fade: 10 });
  ({ dialog } = open());
  const typed = field(dialog, 'Leave First at');
  typed.value = '2:00';
  typed.dispatchEvent(event('input'));
  click(byText(dialog, 'Save for this pair'));
  assert.deepEqual(cues.getPair(1, 2), { out: 120, in: null, fade: 10 });
  await flush();
});

test('preview is off while a transition is running, and starts paused playback', async () => {
  cues._reset();
  const player = fakePlayer();
  player.playing = false;
  player.play = () => { player.playing = true; };
  player.fading = { from: other, to: from };
  let { dialog } = open({ player });
  assert.equal(role(dialog, 'preview').disabled, true);
  assert.match(text(dialog), /Wait for the current transition to finish/);
  player.fading = null;
  player.emit('transition');
  assert.equal(role(dialog, 'preview').disabled, false);
  click(preset(dialog, 'smooth'));
  click(role(dialog, 'preview'));
  assert.equal(player.playing, true);
  dialog.close();
  await flush();
});

test('only a pair curve is plotted: Use setting and Auto draw the label, presets draw real curves', async () => {
  cues._reset();
  const labels = [];
  const lines = [];
  const spy = new Proxy(ctx, { get: (t, k) => k === 'fillText' ? (...a) => labels.push(a[0]) : k === 'lineTo' ? (...a) => lines.push(a) : t[k] });
  const original = Element.prototype.getContext;
  Element.prototype.getContext = function () { draws++; return spy; };
  const { dialog } = open();
  assert.ok(labels.includes('Auto mix picks the curve'));
  click(preset(dialog, 'auto'));
  labels.length = 0; lines.length = 0;
  click(preset(dialog, 'default'));
  assert.ok(labels.includes('Auto mix picks the curve'));
  labels.length = 0; lines.length = 0;
  click(preset(dialog, 'smooth'));
  assert.ok(!labels.includes('Auto mix picks the curve'));
  assert.ok(lines.length >= 64, 'both curves drawn');
  dialog.close();
  Element.prototype.getContext = original;
  await flush();
});

test('Space is stopped at the dialog root without being cancelled, so buttons still activate', async () => {
  cues._reset();
  const { dialog } = open();
  let prevented = false;
  const space = event('keydown', { key: ' ', code: 'Space', preventDefault() { prevented = true; } });
  dialog.dispatchEvent(space);
  assert.equal(space.stopped, true);
  assert.equal(prevented, false);
  const letter = event('keydown', { key: 'a' });
  dialog.dispatchEvent(letter);
  assert.equal(letter.stopped, false);
  dialog.close();
  await flush();
});

test('style-only changes store no times or fade, so Auto keeps planning', async () => {
  cues._reset();
  const { dialog } = open();
  click(preset(dialog, 'auto'));
  click(byText(dialog, 'Save for this pair'));
  assert.deepEqual(cues.getPair(1, 2), { out: null, in: null, fade: null, style: 'auto' });
  assert.equal(cues.transitionFor(1, 2, 0).custom, false);
  await flush();
});

test('the fade is limited by the incoming song first, and the automatic leave point follows', async () => {
  cues._reset();
  cues.setMixIn(2, 195);
  const { dialog, player } = open();
  const slider = role(dialog, 'fade-slider');
  slider.value = '30';
  slider.dispatchEvent(event('input'));
  assert.equal(slider.value, '5');
  assert.equal(field(dialog, 'Leave First at').attributes.get('placeholder'), '3:55');
  click(preset(dialog, 'smooth'));
  click(role(dialog, 'preview'));
  assert.deepEqual(cues.getPair(1, 2).fade, 5);
  assert.deepEqual(player.seeks, [231]);
  dialog.close();
  await flush();
});

test('the automatic leave point and the preview lead use the outgoing song speed', async () => {
  cues._reset();
  const player = fakePlayer();
  player.audio = { playbackRate: 2 };
  const { dialog } = open({ player });
  const slider = role(dialog, 'fade-slider');
  slider.value = '30';
  slider.dispatchEvent(event('input'));
  assert.equal(field(dialog, 'Leave First at').attributes.get('placeholder'), '3:00');
  click(preset(dialog, 'smooth'));
  click(role(dialog, 'preview'));
  assert.deepEqual(player.seeks, [172]);
  dialog.close();
  // a song that is not the one playing counts as 1x
  const idle = fakePlayer(other, to);
  idle.audio = { playbackRate: 2 };
  const second = transitionDialog(from, to, { player: idle, waveform: () => Promise.resolve(null), info: () => ({ bpm: null, key: null, downbeat: 0 }) });
  const s2 = role(second, 'fade-slider');
  s2.value = '30';
  s2.dispatchEvent(event('input'));
  assert.equal(field(second, 'Leave First at').attributes.get('placeholder'), '3:30');
  second.close();
  await flush();
});

test('the song chips show m:ss, not fractions', async () => {
  cues._reset();
  const long = { id: 5, title: 'Long', duration: 192940, user: { username: 'A' } };
  const dialog = transitionDialog(long, to, { player: fakePlayer(long, to), waveform: () => Promise.resolve(null), info: () => ({ bpm: null, key: null, downbeat: 0 }) });
  const chip = walk(dialog, n => n.className?.includes?.('te-length') && n.className.includes('te-length') && n.hidden === false && text(n) === '3:12');
  assert.ok(chip, 'shows 3:12');
  assert.doesNotMatch(text(dialog), /3:12\./);
  dialog.close();
  await flush();
});

test('a real key object shows as its Camelot code and BPM can come from the live grid', async () => {
  cues._reset();
  const { camelot } = await import('../src/js/keys.js');
  const key = { tonic: 3, mode: 'minor', confidence: 0.8 };
  const player = fakePlayer();
  player.keyOf = (t) => t.id === 1 ? key : null;
  player.autoMixStatus = () => ({ live: { period: 60 / 126.4 } });
  player.mixFeatures = () => ({ bpm: null });
  const dialog = transitionDialog(from, to, { player, waveform: () => Promise.resolve(null) });
  assert.match(text(dialog), new RegExp(camelot(key)));
  assert.match(text(dialog), /126 bpm/);
  assert.doesNotMatch(text(dialog), /\?/);
  dialog.close();
  await flush();
});

test('info refreshes while open when the analysis arrives, without touching the draft, and the timer stops on close', async () => {
  cues._reset();
  const timers = new Set();
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  let tick;
  globalThis.setInterval = (fn) => { tick = fn; timers.add(fn); return { unref() {}, fn }; };
  globalThis.clearInterval = (t) => timers.delete(t.fn);
  try {
    const player = fakePlayer();
    let heard = null;
    player.autoMixStatus = () => heard ? { live: heard } : {};
    player.mixFeatures = () => ({ bpm: null });
    const dialog = transitionDialog(from, to, { player, waveform: () => Promise.resolve(null) });
    assert.doesNotMatch(text(dialog), /bpm/);
    click(preset(dialog, 'swap'));
    const leave = field(dialog, 'Leave First at');
    leave.value = '2:00';
    leave.dispatchEvent(event('input'));
    heard = { bpm: 128 };
    tick();
    assert.match(text(dialog), /128 bpm/);
    click(byText(dialog, 'Save for this pair'));
    assert.deepEqual(cues.getPair(1, 2), { out: 120, in: null, fade: null, style: 'blend', curve: { dj: 1, center: 0.5 } });
    assert.equal(timers.size, 0, 'timer cleared on close');
  } finally {
    globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
  }
  await flush();
});

test('with Auto mix on and nothing set, the length reads Auto, uses the real plan, and goes back to numbers once touched', async () => {
  cues._reset();
  const player = fakePlayer();
  player.autoMix = true;
  player.loadId = 4;
  let dialog = transitionDialog(from, to, { player, waveform: () => Promise.resolve(null), info: () => ({ bpm: 120, key: null, downbeat: 0 }) });
  const note = () => role(dialog, 'auto-note');
  const readout = () => walk(dialog, n => n.className?.includes?.('te-fade-text'));
  assert.equal(text(readout()), 'Auto');
  assert.equal(note().hidden, false);
  assert.match(text(note()), /estimate/);
  dialog.close();

  player.mixPlan = { loadId: 4, nextId: 2, span: 9.2, at: 200 };
  player.audio = { playbackRate: 1 };
  dialog = transitionDialog(from, to, { player, waveform: () => Promise.resolve(null), info: () => ({ bpm: 120, key: null, downbeat: 0 }) });
  assert.equal(text(readout()), 'Auto · 9.2s');
  assert.doesNotMatch(text(note()), /estimate/);
  assert.equal(field(dialog, 'Leave First at').attributes.get('placeholder'), '3:20');
  role(dialog, 'fade-slider').value = '12';
  role(dialog, 'fade-slider').dispatchEvent(event('input'));
  assert.equal(text(readout()), '12s');
  assert.equal(note().hidden, true);
  dialog.close();

  player.autoMix = false;
  dialog = transitionDialog(from, to, { player, waveform: () => Promise.resolve(null), info: () => ({ bpm: 120, key: null, downbeat: 0 }) });
  assert.equal(text(readout()), '6s');
  assert.equal(note().hidden, true);
  dialog.close();
  await flush();
});

// width of the overlap panel, the first rectangle drawn, for a plan on a 800 px wide stage
function panelWidth(setup) {
  const rects = [];
  const spy = new Proxy(ctx, { get: (t, k) => k === 'fillRect' ? (...a) => rects.push(a) : t[k] });
  const original = Element.prototype.getContext;
  Element.prototype.getContext = function () { draws++; return spy; };
  try {
    const player = fakePlayer();
    player.autoMix = true;
    player.loadId = 1;
    setup(player);
    const dialog = transitionDialog(from, to, { player, waveform: () => Promise.resolve(null), info: () => ({ bpm: 120, key: null, downbeat: 0 }) });
    const readout = walk(dialog, n => n.className?.includes?.('te-fade-text'));
    const out = { width: rects[0][2], readout: text(readout) };
    dialog.close();
    return out;
  } finally {
    Element.prototype.getContext = original;
  }
}

test('a plan at 2x speed is drawn over its media time while the readout stays in seconds', () => {
  cues._reset();
  const got = panelWidth((player) => {
    player.audio = { playbackRate: 2 };
    player.mixPlan = { loadId: 1, nextId: 2, span: 12, at: 228 };
  });
  assert.equal(got.readout, 'Auto · 6s');
  // 12 media seconds with 9 s of padding each side
  assert.ok(Math.abs(got.width - 12 / 30 * 800) < 0.01, `got ${got.width}`);
});

test('an automatic plan longer than 60 seconds is not cut off', () => {
  cues._reset();
  const got = panelWidth((player) => {
    player.audio = { playbackRate: 1 };
    player.mixPlan = { loadId: 1, nextId: 2, span: 64, at: 100 };
  });
  assert.equal(got.readout, 'Auto · 64s');
  assert.ok(Math.abs(got.width - 64 / 160 * 800) < 0.01, `got ${got.width}`);
});
