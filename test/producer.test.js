import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { Emitter, h } = await import('../src/js/dom.js');
const { mount, formatTempo, formatPosition, stepIndex, gridTempo, playingStep, stableTempo, barStep, rulerBars, timelineWidth, peaksOf, parseOutputMode, readOutputMode, writeOutputMode, spectrumSpans, spanLevel, timePeak, meterScale, levelStep, peakStep, spectrumCurve, outputFits } = await import('../src/js/packs/producer.js');
const { bindServices, waveform } = await import('../src/js/ui.js');
const find = (node, name) => node.className?.split(' ').includes(name) ? node :
  node.childNodes.map(child => find(child, name)).find(Boolean);

test('LCD tempo uses three decimal places and unknown markers', () => {
  assert.equal(formatTempo(174), '174.000');
  assert.equal(formatTempo(127.4567), '127.457');
  for (const value of [0, -1, NaN, Infinity, undefined]) assert.equal(formatTempo(value), '---.---');
  assert.equal(gridTempo({ period: 0.5 }), 120);
  assert.equal(gridTempo({ bpm: Infinity, period: 0.5 }), 120);
  assert.equal(gridTempo(null), 0);
});

test('bars:beats:steps and sixteenth-note indices use media position and beat-grid origin', () => {
  assert.equal(formatPosition(0, 120), '001:01:01');
  assert.equal(formatPosition(0.125, 120), '001:01:02');
  assert.equal(formatPosition(1.875, 120), '001:04:04');
  assert.equal(formatPosition(2, 120), '002:01:01');
  assert.equal(formatPosition(2.5, 120, 0.5), '002:01:01');
  assert.equal(formatPosition(-3, 120), '001:01:01');
  assert.equal(formatPosition(10, 0), '---:--:--');
  assert.equal(stepIndex(0, 174), 0);
  assert.equal(stepIndex(60 / 174 / 4 * 15, 174), 15);
  assert.equal(stepIndex(60 / 174 * 4, 174), 0);
  assert.equal(stepIndex(1.125, 120, 1), 1);
  assert.equal(stepIndex(100, 0), -1);
});

test('steps before the beat-grid downbeat wrap backwards instead of sticking at step 0', () => {
  assert.equal(stepIndex(1.375, 120, 1.5), 15);
  assert.equal(stepIndex(1.25, 120, 1.5), 14);
  assert.equal(stepIndex(0, 120, 1.5), 4);
  assert.equal(stepIndex(1.5, 120, 1.5), 0);
  assert.equal(stepIndex(-3, 120), 8);
  assert.equal(formatPosition(1.375, 120, 1.5), '001:01:01');
  assert.equal(formatPosition(0, 120, 1.5), '001:01:01');
});

async function setup(t, { effects = 'on', reducedMotion = false, search = true, header: sharedHeader, searchWidth = 800 } = {}) {
  const previous = { query: document.querySelector, svg: document.createElementNS, media: window.matchMedia, observer: globalThis.MutationObserver,
    resize: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame };
  // The top bar: a fake header with a search field the output panel is inserted before.
  const header = sharedHeader || h('header.topbar');
  const searchField = h('form.search');
  let width = searchWidth, resizeCallback, frames = [];
  if (search && !sharedHeader) {
    header.append(h('div.topbar-left'), searchField, h('div.topbar-right'));
    searchField.before = node => { header.childNodes.splice(header.childNodes.indexOf(searchField), 0, node); node.parentNode = header; };
    searchField.getBoundingClientRect = () => ({ width, height: 0, left: 0 });
  }
  const headerSearch = sharedHeader ? sharedHeader.childNodes.find(node => node.className === 'search') : search ? searchField : null;
  if (sharedHeader && headerSearch) headerSearch.getBoundingClientRect = () => ({ width, height: 0, left: 0 });
  globalThis.ResizeObserver = class {
    constructor(fn) { resizeCallback ||= fn; }
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = fn => frames.push(fn);
  let observerCallback, disconnected = false;
  globalThis.MutationObserver = class {
    constructor(fn) { observerCallback = fn; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  document.createElementNS = () => {
    const node = h('svg');
    const set = node.setAttribute.bind(node);
    node.setAttribute = (key, value) => { set(key, value); if (key === 'class') node.className = value; };
    return node;
  };
  const media = new EventTarget(); media.matches = reducedMotion;
  window.matchMedia = () => media;
  document.documentElement.dataset = { themeMotion: effects };
  document.documentElement.removeAttribute ||= function (key) { this.attributes.delete(key); };
  document.hidden = false;
  const controls = h('div.pb-controls');
  const nativePlay = h('button.pb-play'); controls.append(nativePlay);
  const volume = h('div.pb-volume');
  volume.style.removeProperty = key => { delete volume.style[key]; };
  document.querySelector = selector => selector === '.pb-controls' ? controls : selector === '.pb-volume' ? volume :
    selector === '.topbar > .search' ? headerSearch :
    selector === '.topbar > .pr-output' ? header.childNodes.find(node => node.className === 'pr-output') || null : null;
  const tracks = [1, 2, 3].map(id => ({ id, title: `Song ${id}`, duration: 240000, user: { username: `Artist ${id}` } }));
  const grid = { bpm: 174, period: 60 / 174, offset: 0.5 };
  let status = { live: grid }, calls = 0, jumped = -1;
  const player = Object.assign(new Emitter(), {
    queue: tracks, index: 0, current: tracks[0], playing: true, autoMix: true,
    audio: { currentTime: 0.5, playbackRate: 1 }, volume: 0.7,
    autoMixStatus() { calls++; return status; }, jump(index) { jumped = index; }
  });
  const store = new Emitter(), settings = { themeEffects: effects };
  let frame, frameDisposed = false, loader;
  const unmount = mount({ player, store, settings,
    views: { override(name, value) { assert.equal(name, 'home'); loader = value; } },
    on(target, event, fn) {
      if (target.on) return target.on(event, fn);
      target.addEventListener(event, fn); return () => target.removeEventListener(event, fn);
    },
    frame(fn) { frame = fn; return () => { frameDisposed = true; }; }
  });
  const page = h('div');
  const dispose = (await loader()).render(page);
  t.after(() => {
    unmount(); dispose(); document.querySelector = previous.query; document.createElementNS = previous.svg;
    window.matchMedia = previous.media; globalThis.MutationObserver = previous.observer; document.hidden = false;
    globalThis.ResizeObserver = previous.resize; globalThis.requestAnimationFrame = previous.raf;
  });
  const remount = async () => { const again = h('div'); const off = (await loader()).render(again); return { page: again, dispose: off }; };
  const resize = width_ => { width = width_; resizeCallback(); frames.splice(0).forEach(fn => fn()); };
  return { player, store, settings, page, controls, volume, media, tracks, nativePlay, unmount, dispose, remount, header, resize,
    get output() { return header.childNodes.find(node => node.className === 'pr-output'); },
    frame: value => frame(value), mutate: () => observerCallback(), setStatus: value => { status = value; },
    get calls() { return calls; }, get jumped() { return jumped; }, get disconnected() { return disconnected; },
    get frameDisposed() { return frameDisposed; } };
}

test('mount draws queue lanes and rack, follows tempo/position, navigates, and cleans every resource', async t => {
  const s = await setup(t);
  const lcd = find(s.controls, 'pr-lcd');
  assert.equal(find(lcd, 'pr-tempo').textContent, '174.000');
  assert.equal(find(lcd, 'pr-position').textContent, '001:01:01');
  assert.equal(find(s.page, 'pr-lanes').childNodes.length, 3);
  const rack = find(s.page, 'pr-rack-rows');
  const steps = find(rack.childNodes[0], 'pr-steps').childNodes;
  assert.equal(steps.length, 16);
  assert.equal(steps[0].attributes.get('data-lit'), 'true');
  find(rack.childNodes[2], 'pr-channel-name').dispatchEvent({ type: 'click' });
  assert.equal(s.jumped, 2);
  find(s.page, 'pr-lanes').childNodes[1].firstChild.dispatchEvent({ type: 'click' });
  assert.equal(s.jumped, 1);
  s.player.audio.currentTime = 0.5 + 60 / 174 / 4 * 3;
  s.player.emit('time');
  assert.equal(find(lcd, 'pr-position').textContent, '001:01:04');
  assert.equal(steps[0].attributes.get('data-lit'), 'false');
  assert.equal(steps[3].attributes.get('data-lit'), 'true');
  s.player.audio.playbackRate = 0.5; s.player.emit('speed');
  assert.equal(find(lcd, 'pr-tempo').textContent, '87.000');
  assert.equal(find(lcd, 'pr-position').textContent, '001:01:04');
  s.frame({ time: 1000, playing: true, level: 0.2 });
  const meter = find(s.volume, 'pr-meter');
  assert.deepEqual(meter.childNodes.map(n => n.style.height), ['40%', '40%']);
  s.setStatus({}); s.player.emit('automix');
  assert.equal(find(lcd, 'pr-tempo').textContent, '---.---');
  assert.equal(find(lcd, 'pr-position').textContent, '---:--:--');
  assert.equal(steps[3].attributes.get('data-lit'), 'false');
  s.unmount(); s.dispose(); s.unmount();
  assert.equal(find(s.page, 'pr-home'), undefined);
  assert.equal(find(s.controls, 'pr-transport-extra'), undefined);
  assert.equal(s.controls.firstChild, s.nativePlay);
  assert.equal(find(s.volume, 'pr-meter'), undefined);
  assert.equal(s.volume.style['--pr-volume'], undefined);
  assert.ok(s.disconnected); assert.ok(s.frameDisposed);
  assert.ok(Object.values(s.player.handlers).every(list => !list.length));
  assert.ok(Object.values(s.store.handlers).every(list => !list.length));
  assert.equal(s.media.listenerCount?.('change') || 0, 0);
  assert.equal(document.listenerCount('visibilitychange'), 0);
  assert.equal(document.listenerCount('appvisibility'), 0);
});

for (const options of [{ effects: 'off' }, { effects: 'auto', reducedMotion: true }]) {
  test(`effects ${options.effects} / reduced ${!!options.reducedMotion} keeps meters static but the step still follows playback`, async t => {
    const s = await setup(t, options);
    const steps = find(find(s.page, 'pr-rack-rows').firstChild, 'pr-steps').childNodes;
    s.frame({ time: 1000, playing: true, level: 0.8 });
    assert.equal(steps[0].attributes.get('data-lit'), 'true');
    s.player.audio.currentTime = 0.5 + 60 / 174 / 4 * 2; s.player.emit('time');
    assert.equal(steps[0].attributes.get('data-lit'), 'false');
    assert.equal(steps[2].attributes.get('data-lit'), 'true');
    s.player.playing = false; s.player.emit('state');
    assert.equal(steps[2].attributes.get('data-lit'), 'false');
    s.player.playing = true; s.player.emit('state');
    assert.equal(steps[2].attributes.get('data-lit'), 'true');
    assert.equal(find(s.page, 'pr-playhead').hidden, true);
    assert.equal(find(s.volume, 'pr-meter').firstChild.style.height, '0%');
    s.player.audio.currentTime = 2; s.player.emit('time');
    assert.notEqual(find(s.controls, 'pr-position').textContent, '001:01:01');
  });
}

test('settings and reduced motion changes freeze live decorations; hidden frames skip status work', async t => {
  const s = await setup(t);
  s.frame({ time: 1000, playing: true, level: 0.5 });
  s.settings.themeEffects = 'off'; document.documentElement.dataset.themeMotion = 'off'; s.mutate();
  assert.equal(find(s.volume, 'pr-meter').firstChild.style.height, '0%');
  assert.equal(find(s.page, 'pr-playhead').hidden, true);
  s.settings.themeEffects = 'auto'; document.documentElement.dataset.themeMotion = 'auto';
  s.media.matches = true; s.media.dispatchEvent(new Event('change'));
  assert.equal(find(s.page, 'pr-playhead').hidden, true);
  s.media.matches = false; s.media.dispatchEvent(new Event('change'));
  assert.equal(find(s.page, 'pr-playhead').hidden, false);
  document.hidden = true; const before = s.calls;
  s.player.emit('time'); s.frame({ time: 2000, playing: true, level: 1 });
  assert.equal(s.calls, before);
  document.hidden = false; document.dispatchEvent({ type: 'visibilitychange' });
  assert.ok(s.calls > before);
  s.player.playing = false; s.player.emit('state');
  assert.equal(find(s.volume, 'pr-meter').firstChild.style.height, '0%');
});

test('Auto mix curves follow real transition progress and incoming beat grid', async t => {
  const s = await setup(t);
  s.player.fading = { from: s.tracks[0], to: s.tracks[1], shapeIn: { dj: 1 }, shapeOut: { dj: 1 } };
  s.player.lock = { match: { gridIn: { bpm: 120, period: 0.5, offset: 0 } } };
  s.setStatus({ mix: { from: s.tracks[0], to: s.tracks[1], progress: 0.6 } });
  s.player.emit('transition');
  assert.equal(find(s.page, 'pr-automation').dataset.active, 'true');
  assert.equal(find(s.page, 'pr-automation-cursor').attributes.get('d'), 'M360,0 V100');
  assert.ok(find(s.page, 'pr-eq-in').attributes.get('d').startsWith('M'));
  assert.equal(find(s.controls, 'pr-tempo').textContent, '120.000');
  s.player.autoMix = false; s.player.emit('automix');
  assert.equal(find(s.page, 'pr-automation').dataset.active, 'false');
  assert.equal(find(s.page, 'pr-automation-cursor').attributes.get('d'), '');
});

test('downbeat anchors bar numbering and a queue refresh replaces lanes without duplicating them', async t => {
  const s = await setup(t);
  s.setStatus({ live: { bpm: 120, period: 0.5, offset: 0, downbeat: 1.5 } });
  s.player.audio.currentTime = 2; s.player.emit('automix');
  assert.equal(find(s.controls, 'pr-position').textContent, '001:02:01');
  assert.equal(find(find(s.page, 'pr-rack-rows').firstChild, 'pr-steps').childNodes[4].attributes.get('data-lit'), 'true');
  s.player.queue = s.tracks.slice(0, 1); s.player.emit('queue');
  assert.equal(find(s.page, 'pr-lanes').childNodes.length, 1);
  assert.equal(find(s.page, 'pr-rack-rows').childNodes.length, 1);
  s.player.queue = []; s.player.current = null; s.player.index = -1; s.player.emit('queue');
  assert.ok(find(s.page, 'pr-empty'));
  assert.equal(find(s.page, 'pr-playhead').hidden, true);
});

test('drop cut automation uses the scheduled cut, drop, high-pass and audio-context clock', async t => {
  const s = await setup(t);
  s.player.fading = { from: s.tracks[0], to: s.tracks[1], schedule: {
    start: 10, cut: 18, drop: 19, end: 20, kill: { style: 'sweep', hz: 2400 }
  } };
  s.player.normalizer = { ctx: { currentTime: 15 } };
  s.setStatus({ mix: { from: s.tracks[0], to: s.tracks[1], style: 'dropcut', phase: 'build', progress: 0 } });
  s.player.emit('transition');
  assert.equal(find(s.page, 'pr-automation-cursor').attributes.get('d'), 'M300,0 V100');
  const eq = find(s.page, 'pr-eq-out').attributes.get('d');
  assert.ok(eq.startsWith('M0.0,92.0'));
  assert.notEqual(eq.split(' ').at(-1), 'L600.0,92.0');
  s.player.normalizer.ctx.currentTime = 19;
  s.player.emit('transition');
  assert.equal(find(s.page, 'pr-automation-cursor').attributes.get('d'), 'M540,0 V100');
});

test('ruler step picker keeps labels at least 56px apart with power-of-two bar steps', () => {
  assert.equal(barStep(16, 640), 2);
  assert.equal(barStep(60, 640), 8);
  assert.equal(barStep(522, timelineWidth(522)), 8);
  assert.equal(barStep(740, timelineWidth(740)), 8);
  assert.equal(barStep(5000, timelineWidth(5000)), 32);
  assert.equal(barStep(4, 640), 1);
  assert.equal(barStep(NaN, NaN), 1);
  for (const bars of [1, 7, 16, 100, 522, 740, 1500, 20000]) {
    const width = timelineWidth(bars), step = barStep(bars, width);
    assert.ok(Math.log2(step) % 1 === 0);
    assert.ok(step === 1 || width / bars * step >= 56);
    assert.ok(step === 1 || width / bars * (step / 2) < 56);
  }
  assert.deepEqual(rulerBars(20, 8), [1, 9, 17]);
  assert.deepEqual(rulerBars(0, 1), [1]);
});

test('the bar ruler labels every Nth bar at its own percentage and the lanes get a matching grid', async t => {
  const s = await setup(t);
  s.player.queue = [{ id: 7, title: 'Long mix', duration: 1020000 }]; s.player.index = 0; s.player.current = s.player.queue[0];
  s.player.emit('queue');
  const ruler = find(s.page, 'pr-ruler'), bars = Math.ceil(1020 * 174 / 240);
  assert.equal(bars, 740);
  const labels = ruler.childNodes.map(span => Number(span.firstChild.textContent));
  assert.deepEqual(labels.slice(0, 3), [1, 9, 17]);
  assert.equal(labels.length, Math.ceil(bars / 8));
  assert.ok(ruler.childNodes.every((span, i) => span.style.left === `${(labels[i] - 1) / bars * 100}%`));
  const timeline = find(s.page, 'pr-timeline');
  assert.equal(timeline.style['--pr-bars'], String(bars));
  assert.equal(timeline.style['--pr-step'], '8');
  assert.equal(timeline.style.width, `${timelineWidth(bars)}px`);
});

test('the shown tempo holds against jitter and only follows a lasting change', () => {
  let state = stableTempo(null, 174, 0, 'a');
  assert.equal(state.shown, 174);
  for (const [t, bpm] of [[100, 125], [300, 157], [700, 140], [1200, 131], [1900, 149], [2600, 125]]) {
    state = stableTempo(state, bpm, t, 'a');
    assert.equal(state.shown, 174);
  }
  state = stableTempo(state, 174.9, 2700, 'a');
  assert.equal(state.shown, 174);
  state = stableTempo(state, 140, 3000, 'a');
  state = stableTempo(state, 140.4, 4999, 'a');
  assert.equal(state.shown, 174);
  state = stableTempo(state, 140.4, 5000, 'a');
  assert.equal(state.shown, 140.4);
  assert.equal(stableTempo(state, 141, 6000, 'a'), state);
  assert.equal(stableTempo(state, 90, 6000, 'b').shown, 90);
  assert.equal(stableTempo(state, 0, 6000, 'a').shown, 0);
  assert.equal(stableTempo(stableTempo(state, 0, 6000, 'a'), 128, 6001, 'a').shown, 128);
});

test('the playing step ignores motion and only needs playback and a known tempo', () => {
  assert.equal(playingStep(true, 0, 174), 0);
  assert.equal(playingStep(true, 60 / 174 / 4 * 3, 174), 3);
  assert.equal(playingStep(false, 0, 174), -1);
  assert.equal(playingStep(true, 0, 0), -1);
});

test('the mount holds the LCD tempo steady until a change lasts, and resets on a new track', async t => {
  const s = await setup(t);
  const lcd = find(s.controls, 'pr-tempo');
  s.setStatus({ live: { bpm: 140, period: 60 / 140, offset: 0.5 } }); s.player.emit('automix');
  assert.equal(lcd.textContent, '174.000');
  s.player.current = s.tracks[1]; s.player.index = 1; s.player.emit('track');
  assert.equal(lcd.textContent, '140.000');
});

test('peaks summarise samples without throwing on empty input', () => {
  assert.equal(peaksOf(null), null);
  assert.equal(peaksOf([]), null);
  assert.deepEqual(peaksOf([0, 0.5, 1, 0.25, NaN, 2], 3), [0.5, 1, 1]);
  assert.equal(peaksOf(Array(1000).fill(0.4)).length, 160);
});

test('lanes get coloured clips with a name strip and canvas, plus a labelled track header each', async t => {
  const s = await setup(t);
  const lanes = find(s.page, 'pr-lanes').childNodes;
  assert.deepEqual(lanes.map(lane => lane.dataset.colour), [0, 1, 2]);
  const clip = lanes[1].firstChild;
  assert.equal(find(clip, 'pr-clip-name').firstChild.textContent, 'Song 2');
  assert.ok(find(clip, 'pr-clip-wave'));
  const heads = find(s.page, 'pr-head-list').childNodes;
  assert.equal(heads.length, 3);
  assert.equal(heads[1].attributes.get('aria-hidden'), 'true');
  assert.equal(find(heads[1], 'pr-head-text').firstChild.firstChild.textContent, 'Track 2');
  assert.equal(heads[0].attributes.get('data-current'), 'true');
  const row = find(s.page, 'pr-rack-rows').firstChild;
  for (const name of ['pr-led', 'pr-knobs', 'pr-mixer-num']) assert.equal(find(row, name).attributes.get('aria-hidden'), 'true');
  assert.equal(find(row, 'pr-knobs').childNodes.length, 2);
  assert.equal(row.childNodes[3].className, 'pr-channel-name');
  s.player.index = 2; s.player.current = s.tracks[2]; s.player.emit('track');
  assert.equal(heads[0].attributes.get('data-current'), 'false');
  assert.equal(heads[2].attributes.get('data-current'), 'true');
});

// ui.js waveform() with a fake player and api. It sets up its removal observer once, with the
// MutationObserver that exists at that moment, so a throwaway waveform makes that the working fake.
function bindFakeServices(t, onWaveform = () => {}) {
  const fakePlayer = new Emitter();
  Object.assign(fakePlayer, { current: null, duration: 0, audio: { currentTime: 0 }, seek() {} });
  bindServices({}, fakePlayer, { waveform: async track => { onWaveform(track); return null; } });
  t.after(() => bindServices(undefined, undefined, undefined));
  waveform({ id: 0, duration: 1000 }, { height: 1 });
  return fakePlayer;
}

test('the top toolbar shows the playing track waveform, rebuilds on a track change and shows a placeholder when idle', async t => {
  const waveformCalls = [];
  bindFakeServices(t, track => track.id && waveformCalls.push(track.id));
  const s = await setup(t);
  const toolbar = find(s.page, 'pr-toolbar');
  assert.equal(s.page.firstChild.firstChild, toolbar);
  const first = find(toolbar, 'waveform');
  assert.ok(first);
  assert.match(find(toolbar, 'pr-wave-title').firstChild.textContent, /Song 1/);
  s.player.emit('time'); s.player.emit('state');
  assert.equal(find(toolbar, 'waveform'), first);
  s.player.index = 1; s.player.current = s.tracks[1]; s.player.emit('track');
  assert.notEqual(find(toolbar, 'waveform'), first);
  assert.match(find(toolbar, 'pr-wave-title').firstChild.textContent, /Song 2/);
  assert.deepEqual(waveformCalls, [1, 2]);
  s.player.index = -1; s.player.current = null; s.player.emit('track');
  assert.equal(find(toolbar, 'waveform'), undefined);
  assert.ok(find(toolbar, 'pr-wave-empty'));
  assert.equal(find(toolbar, 'pr-wave-title').firstChild.textContent, 'NO TRACK PLAYING');
});

test('the toolbar shows the LCD position and tempo, with a placeholder when the waveform cannot be built', async t => {
  const s = await setup(t);
  const toolbar = find(s.page, 'pr-toolbar');
  assert.ok(find(toolbar, 'pr-wave-empty'));
  assert.deepEqual(find(toolbar, 'pr-toolbar-lcds').childNodes.map(box => box.childNodes[1].textContent), ['001:01:01', '174.000']);
  assert.ok(find(s.page, 'pr-lanes'));
});

test('the Browser panel sits above the Playlist, under the toolbar and header', async t => {
  const s = await setup(t);
  const classes = s.page.firstChild.childNodes.map(node => node.className.split(' ')[0]);
  assert.deepEqual(classes.slice(0, 4), ['pr-toolbar', 'pr-header', 'pr-browse', 'pr-arrangement']);
  assert.equal(find(find(s.page, 'pr-browse'), 'pr-titlebar').firstChild.firstChild.textContent, 'Browser');
});

test('a missing track duration uses the real media duration once the player reports it', async t => {
  const s = await setup(t);
  s.player.queue = [{ id: 9, title: 'No duration' }]; s.player.index = 0; s.player.current = s.player.queue[0];
  s.player.audio.currentTime = 60; s.player.emit('queue');
  s.player.duration = NaN; s.player.emit('timeline');
  assert.equal(find(s.page, 'pr-playhead').style.left, '50%');
  s.player.duration = 300; s.player.emit('timeline');
  assert.equal(find(s.page, 'pr-playhead').style.left, '20%');
  assert.equal(find(s.page, 'pr-clip').style.width, '100%');
});

for (const [name, options, behavior] of [['on', {}, 'smooth'], ['off', { effects: 'off' }, 'auto']]) {
  test(`Browse scrolls into view when it opens (effects ${name})`, async t => {
    const s = await setup(t, options);
    const browse = find(s.page, 'pr-browse');
    const calls = [];
    browse.hidden = true; browse.scrollIntoView = args => calls.push(args);
    const button = find(s.page, 'pr-actions').childNodes[1];
    button.dispatchEvent({ type: 'click' });
    assert.equal(browse.hidden, false);
    assert.deepEqual(calls, [{ block: 'start', behavior }]);
    button.dispatchEvent({ type: 'click' });
    assert.equal(browse.hidden, true);
    assert.equal(calls.length, 1);
  });
}

// Clip waveform replies arrive late: they must only draw into the current build's canvases.
async function withWaveforms(t, run) {
  const previous = { create: document.createElement, native: window.native };
  const drawn = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  document.createElement = (...args) => {
    const el = previous.create(...args);
    el.getContext = () => { if (el.className.includes('pr-clip-wave')) drawn.push(el); return { fillRect() {} }; };
    return el;
  };
  window.native = { json: async () => { await gate; return { samples: [1, 2, 3, 4], height: 4 }; } };
  t.after(() => { document.createElement = previous.create; window.native = previous.native; });
  const s = await setup(t);
  await run(s, drawn, async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); });
}

test('a queue refresh while waveform requests are pending only draws into the new canvases', async t => {
  await withWaveforms(t, async (s, drawn, settle) => {
    const queue = [{ id: 201, title: 'A', duration: 1000, waveform_url: 'a.png' }];
    s.player.queue = queue; s.player.current = queue[0]; s.player.index = 0; s.player.emit('queue');
    s.player.queue = [...queue]; s.player.emit('queue');
    await settle();
    const canvases = [];
    const visit = node => { if (node.className?.split(' ').includes('pr-clip-wave')) canvases.push(node); node.childNodes.forEach(visit); };
    visit(find(s.page, 'pr-lanes'));
    assert.equal(canvases.length, 1);
    assert.deepEqual(drawn, canvases);
  });
});

test('a destroyed stage ignores waveform replies that arrive afterwards', async t => {
  await withWaveforms(t, async (s, drawn, settle) => {
    const queue = [{ id: 202, title: 'B', duration: 1000, waveform_url: 'b.png' }];
    s.player.queue = queue; s.player.current = queue[0]; s.player.index = 0; s.player.emit('queue');
    s.dispose();
    await settle();
    assert.deepEqual(drawn, []);
  });
});

test('the toolbar releases the old waveform when it rebuilds and when the stage is destroyed', async t => {
  const fakePlayer = bindFakeServices(t);
  const times = () => fakePlayer.handlers.time.length;
  const base = times();
  const s = await setup(t);
  assert.equal(times(), base + 1);
  s.player.index = 1; s.player.current = s.tracks[1]; s.player.emit('track');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(times(), base + 1);
  s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(times(), base);
});

test('output mode parses to scope by default and survives throwing or missing storage', () => {
  assert.equal(parseOutputMode('spectrum'), 'spectrum');
  for (const value of ['scope', 'Spectrum', '', null, undefined, 3]) assert.equal(parseOutputMode(value), 'scope');
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readOutputMode(storage), 'scope');
  writeOutputMode('spectrum', storage);
  assert.equal(store.get('quantm.producer.outputMode'), 'spectrum');
  assert.equal(readOutputMode(storage), 'spectrum');
  writeOutputMode('bogus', storage);
  assert.equal(store.get('quantm.producer.outputMode'), 'scope');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readOutputMode(broken), 'scope');
  assert.doesNotThrow(() => writeOutputMode('spectrum', broken));
});

test('spectrum bars are log-spaced from 30 Hz to 16 kHz as contiguous bin ranges', () => {
  const spans = spectrumSpans(48, 44100, 256);
  assert.equal(spans.length, 48);
  assert.equal(spans[0].lo, 1);
  assert.ok(Math.abs(spans.at(-1).hi * 44100 / 256 - 16000) < 1);
  spans.forEach((span, i) => {
    assert.ok(span.hi >= span.lo);
    if (i) assert.equal(span.lo, spans[i - 1].hi);
  });
  const fine = spectrumSpans(48, 48000, 2048);
  assert.ok(Math.abs(fine[0].lo * 48000 / 2048 - 30) < 0.5);
  const ratios = fine.map(span => span.hi / span.lo);
  assert.ok(Math.max(...ratios) - Math.min(...ratios) < 1e-9);
  assert.deepEqual(spectrumSpans(0, 44100, 256), []);
  assert.deepEqual(spectrumSpans(48, 0, 256), []);
});

test('bar levels interpolate inside one bin and take the loudest bin across several', () => {
  const data = new Uint8Array(128); data[10] = 255;
  assert.equal(spanLevel(data, { lo: 9.5, hi: 12 }), 1);
  assert.equal(spanLevel(data, { lo: 10, hi: 10.5 }), 0.75);
  assert.equal(spanLevel(data, { lo: 2, hi: 2.4 }), 0);
  assert.equal(spanLevel(new Uint8Array(0), { lo: 1, hi: 2 }), 0);
});

test('meter helpers: time-domain peak, dB scale, falling level and peak hold', () => {
  assert.equal(timePeak(Uint8Array.from([128, 128, 128])), 0);
  assert.equal(timePeak(Uint8Array.from([128, 192, 100])), 0.5);
  assert.equal(meterScale(0), 0);
  assert.equal(meterScale(1), 1);
  assert.ok(Math.abs(meterScale(0.5) - (1 - 6.0206 / 48)) < 1e-4);
  assert.equal(meterScale(0.0001), 0);
  // Spectrum scaling: silence is empty, full-scale bytes keep headroom, and the curve only rises.
  assert.equal(spectrumCurve(0), 0);
  assert.ok(spectrumCurve(1) > 0.7 && spectrumCurve(1) < 0.85);
  assert.ok(spectrumCurve(0.8) > 0.4 && spectrumCurve(0.8) < 0.65);
  for (let v = 0.2; v <= 1; v += 0.05) assert.ok(spectrumCurve(v) > spectrumCurve(v - 0.05));
  assert.equal(levelStep(0.2, 0.9, 0.1), 0.9);
  assert.ok(Math.abs(levelStep(0.8, 0.2, 0.1) - 0.6) < 1e-9);
  assert.deepEqual(peakStep({ peak: 0.5, hold: 0 }, 0.9, 0.03), { peak: 0.9, hold: 0.6 });
  let state = peakStep({ peak: 0.9, hold: 0.6 }, 0.1, 0.3);
  assert.ok(Math.abs(state.hold - 0.3) < 1e-9 && state.peak === 0.9);
  state = peakStep(state, 0.1, 0.5);
  assert.ok(Math.abs(state.peak - 0.8) < 1e-9 && state.hold === 0);
  state = peakStep(state, 0.1, 1);
  assert.ok(Math.abs(state.peak - 0.3) < 1e-9);
  const leftover = peakStep({ peak: 0.9, hold: 0.05 }, 0.1, 0.2);
  assert.ok(Math.abs(leftover.peak - 0.825) < 1e-9 && leftover.hold === 0);
  assert.equal(peakStep({ peak: 0.2, hold: 0 }, 0, 10).peak, 0);
});

// A canvas context that records every call, and a fake analyser that must only ever be read.
function outputRig(t, { storage } = {}) {
  const previous = { create: document.createElement, storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  const calls = [];
  document.createElement = (...args) => {
    const el = previous.create(...args);
    el.getContext = () => new Proxy({}, {
      get: (target, key) => key in target ? target[key] : (..._a) => { if (el.className.includes('pr-output-canvas')) calls.push(key); },
      set: (target, key, value) => { target[key] = value; return true; }
    });
    return el;
  };
  if (storage) Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  else localStorage.clear();
  t.after(() => { document.createElement = previous.create; Object.defineProperty(globalThis, 'localStorage', previous.storage); });
  const reads = { time: 0, freq: 0 };
  const analyser = {
    get fftSize() { return 256; }, get frequencyBinCount() { return 128; }, context: { sampleRate: 44100 },
    getByteTimeDomainData(a) { reads.time++; a.forEach((_, i) => { a[i] = Math.round(128 + 100 * Math.sin(i / 6)); }); },
    getByteFrequencyData(a) { reads.freq++; a.forEach((_, i) => { a[i] = 255 - i; }); }
  };
  return { calls, reads, analyser };
}
const FRAME = { time: 1000, dt: 1 / 30, playing: true, level: 0.3 };

test('the output panel idles non-blank, then a live frame draws the scope and fills the meters', async t => {
  const rig = outputRig(t);
  const s = await setup(t);
  s.player.normalizer = { visual: rig.analyser };
  assert.ok(rig.calls.includes('clearRect') && rig.calls.includes('stroke'));
  assert.equal(find(s.header, 'pr-peak-fill').style.width, '0%');
  rig.calls.length = 0;
  s.frame(FRAME);
  assert.ok(rig.calls.includes('quadraticCurveTo'));
  assert.equal(rig.reads.time, 1); assert.equal(rig.reads.freq, 0);
  assert.notEqual(find(s.header, 'pr-peak-fill').style.width, '0%');
  assert.notEqual(find(s.header, 'pr-peak-tick').style.left, '0%');
  s.frame({ ...FRAME, time: 1010 });
  assert.equal(rig.reads.time, 2);
  const button = find(s.header, 'pr-output-view');
  assert.equal(button.attributes.get('type'), 'button');
  assert.equal(find(s.header, 'pr-output-canvas').attributes.get('aria-hidden'), 'true');
});

test('clicking the output toggles scope and spectrum, relabels the button and remembers the choice', async t => {
  const rig = outputRig(t);
  const s = await setup(t);
  s.player.normalizer = { visual: rig.analyser };
  const button = find(s.header, 'pr-output-view'), tag = find(s.header, 'pr-output-mode');
  assert.equal(tag.textContent, 'SCOPE');
  assert.match(button.attributes.get('aria-label'), /scope.*switch to spectrum/);
  button.dispatchEvent({ type: 'click' });
  assert.equal(tag.textContent, 'SPECTRUM');
  assert.match(button.attributes.get('aria-label'), /spectrum.*switch to scope/);
  assert.equal(localStorage.getItem('quantm.producer.outputMode'), 'spectrum');
  rig.calls.length = 0;
  s.frame(FRAME);
  assert.equal(rig.reads.freq, 1);
  assert.ok(rig.calls.includes('fillRect'));
  assert.ok(!rig.calls.includes('quadraticCurveTo'));
  button.dispatchEvent({ type: 'click' });
  assert.equal(tag.textContent, 'SCOPE');
  assert.equal(localStorage.getItem('quantm.producer.outputMode'), 'scope');
});

test('a stored mode is restored on mount, and throwing storage still lets the toggle work', async t => {
  outputRig(t);
  localStorage.setItem('quantm.producer.outputMode', 'spectrum');
  const restored = await setup(t);
  assert.equal(find(restored.header, 'pr-output-mode').textContent, 'SPECTRUM');
  outputRig(t, { storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  const s = await setup(t);
  assert.equal(find(s.header, 'pr-output-mode').textContent, 'SCOPE');
  assert.doesNotThrow(() => find(s.header, 'pr-output-view').dispatchEvent({ type: 'click' }));
  assert.equal(find(s.header, 'pr-output-mode').textContent, 'SPECTRUM');
});

for (const options of [{ effects: 'off' }, { effects: 'auto', reducedMotion: true }]) {
  test(`output stays on a static idle frame with meters empty (effects ${options.effects})`, async t => {
    const rig = outputRig(t);
    const s = await setup(t, options);
    s.player.normalizer = { visual: rig.analyser };
    assert.ok(rig.calls.includes('stroke'));
    rig.calls.length = 0;
    s.frame(FRAME);
    assert.equal(rig.reads.time, 0);
    assert.equal(find(s.header, 'pr-peak-fill').style.width, '0%');
  });
}

test('pausing or having no analyser repaints the idle frame instead of leaving the last live one', async t => {
  const rig = outputRig(t);
  const s = await setup(t);
  s.player.normalizer = { visual: rig.analyser };
  s.frame(FRAME);
  assert.notEqual(find(s.header, 'pr-peak-fill').style.width, '0%');
  rig.calls.length = 0;
  s.player.playing = false;
  s.frame({ ...FRAME, playing: false });
  assert.ok(rig.calls.includes('clearRect') && rig.calls.includes('stroke'));
  assert.equal(find(s.header, 'pr-peak-fill').style.width, '0%');
  rig.calls.length = 0;
  s.frame({ ...FRAME, playing: false, time: 1100 });
  assert.equal(rig.calls.length, 0);
  s.player.playing = true; s.player.normalizer = null;
  s.frame({ ...FRAME, time: 1200 });
  assert.equal(find(s.header, 'pr-peak-fill').style.width, '0%');
});

test('the output panel stops drawing and reading the analyser once the theme is unmounted', async t => {
  const rig = outputRig(t);
  const s = await setup(t);
  s.player.normalizer = { visual: rig.analyser };
  s.frame(FRAME);
  assert.ok(s.output);
  s.unmount();
  assert.equal(s.output, undefined);
  const before = rig.calls.length, reads = rig.reads.time;
  s.frame({ ...FRAME, time: 1100 });
  assert.equal(rig.calls.length, before);
  assert.equal(rig.reads.time, reads);
});

test('the output panel is app chrome: it keeps drawing with no Home stage on screen', async t => {
  const rig = outputRig(t);
  const s = await setup(t);
  s.player.normalizer = { visual: rig.analyser };
  s.dispose();
  assert.equal(find(s.page, 'pr-home'), undefined);
  rig.calls.length = 0;
  s.frame(FRAME);
  assert.equal(rig.reads.time, 1);
  assert.ok(rig.calls.includes('quadraticCurveTo'));
  assert.notEqual(find(s.header, 'pr-peak-fill').style.width, '0%');
  s.player.playing = false;
  rig.calls.length = 0;
  s.frame({ ...FRAME, playing: false, time: 1100 });
  assert.ok(rig.calls.includes('stroke'));
  assert.equal(find(s.header, 'pr-peak-fill').style.width, '0%');
  find(s.header, 'pr-output-view').dispatchEvent({ type: 'click' });
  assert.ok(rig.calls.includes('fillRect'));
});

test('the output panel is mounted in the top bar directly before the search field, once, and removed on unmount', async t => {
  outputRig(t);
  const s = await setup(t);
  const names = s.header.childNodes.map(node => node.className);
  assert.deepEqual(names, ['topbar-left', 'pr-output', 'search', 'topbar-right']);
  assert.ok(find(s.header, 'pr-output-view'));
  assert.equal(find(s.page, 'pr-output'), undefined);
  assert.equal(find(find(s.page, 'pr-toolbar'), 'pr-output'), undefined);
  // A second mount over the same top bar replaces the first panel instead of adding another.
  const again = await setup(t, { header: s.header });
  assert.deepEqual(s.header.childNodes.map(node => node.className), ['topbar-left', 'pr-output', 'search', 'topbar-right']);
  again.unmount();
  assert.deepEqual(s.header.childNodes.map(node => node.className), ['topbar-left', 'search', 'topbar-right']);
  s.unmount();
  assert.deepEqual(s.header.childNodes.map(node => node.className), ['topbar-left', 'search', 'topbar-right']);
});

test('without a search field in the top bar nothing is added and nothing throws', async t => {
  const rig = outputRig(t);
  const s = await setup(t, { search: false });
  s.player.normalizer = { visual: rig.analyser };
  assert.equal(s.header.childNodes.length, 0);
  assert.doesNotThrow(() => s.frame(FRAME));
  assert.equal(rig.reads.time, 0);
  assert.equal(rig.calls.length, 0);
});

test('the output panel hides when the search field would drop under 220px and comes back with room to spare', () => {
  assert.equal(outputFits(220, true), true);
  assert.equal(outputFits(219, true), false);
  assert.equal(outputFits(425, false), false);
  assert.equal(outputFits(426, false), true);
  assert.equal(outputFits(0, true), false);
});

test('the real search width hides and re-shows the panel with hysteresis, and a hidden panel is not drawn', async t => {
  const rig = outputRig(t);
  const s = await setup(t, { searchWidth: 500 });
  s.player.normalizer = { visual: rig.analyser };
  assert.equal(s.output.hidden, undefined);
  s.resize(219);
  assert.equal(s.output.hidden, true);
  rig.calls.length = 0;
  s.frame(FRAME);
  assert.equal(rig.reads.time, 0); assert.equal(rig.calls.length, 0);
  s.resize(300);
  assert.equal(s.output.hidden, true);
  s.resize(426);
  assert.equal(s.output.hidden, false);
  s.resize(230);
  assert.equal(s.output.hidden, false);
  s.frame({ ...FRAME, time: 1100 });
  assert.equal(rig.reads.time, 1);
  s.resize(100);
  assert.equal(s.output.hidden, true);
});

test('Space on the output button stays on the button so the global play shortcut does not eat its click', async t => {
  outputRig(t);
  const s = await setup(t);
  const button = find(s.header, 'pr-output-view');
  const press = init => {
    const event = { type: 'keydown', stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...init };
    button.dispatchEvent(event);
    return event;
  };
  for (const init of [{ code: 'Space', key: ' ' }, { key: ' ' }]) {
    const event = press(init);
    assert.equal(event.stopped, true);
    assert.equal(event.prevented, false);
  }
  for (const init of [{ code: 'Enter', key: 'Enter' }, { code: 'KeyC', key: 'c' }]) assert.equal(press(init).stopped, false);
});

test('showing the panel again repaints from the current state, so a paused player is not left with the old scope', async t => {
  const rig = outputRig(t);
  const s = await setup(t, { searchWidth: 500 });
  s.player.normalizer = { visual: rig.analyser };
  s.frame(FRAME);
  assert.notEqual(find(s.header, 'pr-peak-fill').style.width, '0%');
  s.resize(100);
  assert.equal(s.output.hidden, true);
  s.player.playing = false;
  rig.calls.length = 0;
  s.resize(600);
  assert.equal(s.output.hidden, false);
  assert.ok(rig.calls.includes('clearRect') && rig.calls.includes('stroke'));
  assert.equal(find(s.header, 'pr-peak-fill').style.width, '0%');
  assert.equal(find(s.header, 'pr-peak-tick').style.opacity, '0');
  // Still playing: the next live frame draws it, with no stale idle repaint in between.
  s.player.playing = true; s.frame({ ...FRAME, time: 1100 });
  s.resize(100); rig.calls.length = 0;
  s.resize(600);
  assert.equal(rig.calls.length, 0);
  s.frame({ ...FRAME, time: 1200 });
  assert.ok(rig.calls.includes('quadraticCurveTo'));
});

test('the panel also hides when the top bar itself overflows', async t => {
  outputRig(t);
  const s = await setup(t, { searchWidth: 500 });
  Object.assign(s.header, { scrollWidth: 1300, clientWidth: 1200 });
  s.resize(500);
  assert.equal(s.output.hidden, true);
  s.header.scrollWidth = 1200;
  s.resize(500);
  assert.equal(s.output.hidden, false);
});

test('Producer replaces the player-bar visualizer while mounted and gives it back on unmount', async t => {
  outputRig(t);
  const html = document.documentElement;
  assert.equal(html.hasAttribute('data-no-visualizer'), false);
  const s = await setup(t);
  assert.equal(html.hasAttribute('data-no-visualizer'), true);
  s.unmount();
  assert.equal(html.hasAttribute('data-no-visualizer'), false);
  s.unmount();
  assert.equal(html.hasAttribute('data-no-visualizer'), false);
});

const countNodes = (node, match = () => true) => (match(node) ? 1 : 0) + node.childNodes.reduce((sum, child) => sum + countNodes(child, match), 0);
const bigQueue = n => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, title: `Big ${i}`, duration: 180000 }));

test('a 500-song queue draws a bounded number of rack rows, lanes and step buttons, but the timeline spans every song', async t => {
  const s = await setup(t);
  const queue = bigQueue(500);
  const before = countNodes(s.page);
  s.player.queue = queue; s.player.index = 0; s.player.current = queue[0]; s.player.emit('queue');
  const steps = countNodes(s.page, n => n.className === 'pr-step');
  const nodes = countNodes(s.page);
  if (process.env.QUANTM_COUNT) console.log(`producer 500 songs: ${steps} step buttons, ${nodes} nodes (${before} before the queue)`);
  assert.ok(steps <= 17 * 16, `${steps} step buttons`);
  assert.equal(find(s.page, 'pr-rack-rows').childNodes.length, 18, 'current + 16 after + the "more" note');
  assert.equal(find(s.page, 'pr-lanes').childNodes.length, 18);
  assert.match(find(s.page, 'pr-more').childNodes[0].textContent, /483 more/);
  // clips still sit at their place in the whole queue: 500 songs of 180 s
  const clips = find(s.page, 'pr-lanes').childNodes.filter(n => n.className === 'pr-lane').map(n => n.firstChild);
  assert.equal(clips[1].style.left, `${180 / (500 * 180) * 100}%`);
  assert.equal(clips[1].style.width, `${180 / (500 * 180) * 100}%`);
  // unchanged contents are not drawn again
  const lane = find(s.page, 'pr-lanes').childNodes[0];
  s.player.queue = [...queue]; s.player.emit('queue'); s.player.emit('queue');
  assert.equal(find(s.page, 'pr-lanes').childNodes[0], lane, 'same nodes');
  // a handoff slides the window and keeps the rows that stay
  s.player.index = 1; s.player.current = queue[1]; s.player.emit('queue');
  const rows = find(s.page, 'pr-rack-rows').childNodes;
  assert.equal(rows.length, 18);
  assert.equal(find(rows[0], 'pr-mixer-num').firstChild.textContent, '2');
  assert.equal(find(s.page, 'pr-lanes').childNodes[0] !== lane, true, 'the first song left the window');
  s.player.audio.currentTime = 0.5; s.player.emit('time');
  assert.equal(rows[0].attributes.get('data-current'), 'true');
  // playing near the end shows the last songs and no "more" note
  s.player.index = 499; s.player.current = queue[499]; s.player.emit('queue');
  assert.equal(find(s.page, 'pr-rack-rows').childNodes.length, 1);
  assert.equal(find(s.page, 'pr-more'), undefined);
});
