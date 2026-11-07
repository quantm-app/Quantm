import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { Emitter, h } = await import('../src/js/dom.js');
const { settings, store } = await import('../src/js/store.js');
const { createTransitionTab, createTabView, SLIDE_MS, HOLD_MS } = await import('../src/js/transition-tab.js');
const { curveValues, curvePath, curveKey, curveProgress } = await import('../src/js/mix-curves.js');
const { eqLevels } = await import('../src/js/normalizer.js');
const { highpassAt } = await import('../src/js/dropcut.js');

const A = { id: 1, title: 'Song A' };
const B = { id: 2, title: 'Song B' };
const root = document.documentElement;
root.removeAttribute ||= function (key) { this.attributes.delete(key); };

function setup(t, { slides = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  settings.transitionTab = true;
  root.attributes.clear();
  const player = new Emitter();
  player.normalizer = { ctx: { currentTime: 100 } };
  const log = [];
  let pending = null, scheduled = 0;
  const s = { player, log, slides, get scheduled() { return scheduled; }, get pending() { return pending; } };
  const view = {
    mount: () => log.push('mount'),
    setSong: (from, to) => { s.song = [from.title, to.title]; log.push('song'); },
    setStyle: text => { s.style = text; },
    setCurves: (out, incoming) => { s.out = out; s.in = incoming; s.draws = (s.draws || 0) + 1; },
    setProgress: (p, text) => { s.p = p; s.text = text; },
    measure: () => { s.measured = (s.measured || 0) + 1; },
    reveal: slide => log.push(slide ? 'reveal' : 'reveal-now'),
    conceal: () => log.push('conceal'),
    unmount: () => log.push('unmount'),
  };
  const tab = createTransitionTab(player, view, {
    slides: () => s.slides,
    frame: fn => { pending = fn; scheduled++; return scheduled; },
    cancel: () => { pending = null; },
  });
  s.tab = tab;
  s.step = ts => { const fn = pending; pending = null; fn(ts); };
  s.fade = (extra = {}) => ({ from: A, to: B, seconds: 10, progress: 0, startedAt: 100, style: 'blend', shapeIn: { dj: 1 }, shapeOut: { dj: 1 }, bass: true, bassOpts: { eq: 1 }, ...extra });
  s.start = f => { player.fading = f; player.emit('transition', { phase: 'start', from: f.from, to: f.to }); };
  s.end = (current = undefined) => { const f = player.fading; player.fading = null; player.current = current === undefined ? f.to : current; player.emit('transition', { phase: 'end', from: f.from, to: f.to }); };
  t.after(() => { tab.destroy(); t.mock.timers.reset(); settings.transitionTab = true; root.attributes.clear(); });
  return s;
}
const flag = (name, on) => { if (on) root.attributes.set(name, ''); else root.attributes.delete(name); document.dispatchEvent({ type: 'appvisibility' }); };

test('the tab shows on transition start with the titles and style, follows the fade and leaves when it ends', t => {
  const s = setup(t);
  assert.equal(s.scheduled, 0, 'no frames while idle');
  assert.equal(document.listenerCount('appvisibility'), 0);
  s.start(s.fade({ genre: 'filterfade' }));
  assert.deepEqual(s.log, ['mount', 'song', 'reveal']);
  assert.deepEqual(s.song, ['Song A', 'Song B']);
  assert.equal(s.style, 'Filter fade');
  assert.ok(s.out.startsWith('M') && s.in.startsWith('M'));
  assert.equal(document.listenerCount('appvisibility'), 1);
  s.player.normalizer.ctx.currentTime = 105;
  s.step(0);
  assert.equal(s.p, 0.5);
  assert.equal(s.text, '5.0s');
  s.player.normalizer.ctx.currentTime = 110.2;
  s.end();
  assert.equal(s.p, 1);
  assert.equal(s.pending, null, 'the loop stops at the end');
  assert.equal(s.log.at(-1), 'conceal');
  t.mock.timers.tick(SLIDE_MS);
  assert.equal(s.log.at(-1), 'unmount');
  assert.equal(document.listenerCount('appvisibility'), 0, 'nothing is listened to again until the next transition');
  assert.equal(s.scheduled, 2, 'one frame to start the loop, one more after the single update');
});

test('the marker updates at most about 30 times a second', t => {
  const s = setup(t);
  s.start(s.fade());
  let writes = 0;
  const seen = new Set();
  for (let ts = 0; ts < 1000; ts += 16.7) {
    s.player.normalizer.ctx.currentTime = 100 + ts / 1000;
    s.step(ts);
    if (!seen.has(s.p)) { seen.add(s.p); writes++; }
  }
  assert.ok(writes <= 32 && writes >= 25, `${writes} updates in a second`);
  assert.equal(s.draws, 1, 'the curves are drawn once');
});

test('a very short transition stays up for a moment after it finishes', t => {
  const s = setup(t);
  s.start(s.fade({ seconds: 1.2, genre: 'quickcut' }));
  s.player.normalizer.ctx.currentTime = 101.4;
  s.end();
  assert.deepEqual(s.log, ['mount', 'song', 'reveal']);
  assert.equal(s.p, 1);
  assert.equal(s.pending, null);
  t.mock.timers.tick(HOLD_MS - 1);
  assert.equal(s.log.includes('conceal'), false);
  t.mock.timers.tick(1);
  assert.equal(s.log.at(-1), 'conceal');
  t.mock.timers.tick(SLIDE_MS);
  assert.equal(s.log.at(-1), 'unmount');
  assert.equal(document.listenerCount('appvisibility'), 0);
});

test('skipping or cancelling mid-fade hides it right away, even a short one', t => {
  const s = setup(t);
  s.start(s.fade());
  s.player.normalizer.ctx.currentTime = 102;
  s.end();
  assert.equal(s.log.at(-1), 'conceal');
  t.mock.timers.tick(SLIDE_MS);
  assert.equal(s.log.at(-1), 'unmount');
});

test('skipping a very short transition does not hold it either', t => {
  const s = setup(t);
  s.start(s.fade({ seconds: 1.2 }));
  s.player.normalizer.ctx.currentTime = 100.3;
  s.end();
  assert.equal(s.log.at(-1), 'conceal');
});

test('a new transition while the last one is held replaces it', t => {
  const s = setup(t);
  s.start(s.fade({ seconds: 1 }));
  s.player.normalizer.ctx.currentTime = 101.2;
  s.end();
  s.player.normalizer.ctx.currentTime = 120;
  s.start(s.fade({ from: B, to: { id: 3, title: 'Song C' }, startedAt: 120 }));
  assert.deepEqual(s.song, ['Song B', 'Song C']);
  t.mock.timers.tick(HOLD_MS + SLIDE_MS);
  assert.equal(s.log.includes('conceal'), false, 'the old hold timer is gone');
  assert.ok(s.pending);
});

test('pausing mid-fade holds the position', t => {
  const s = setup(t);
  s.start(s.fade({ progress: 0.4, startedAt: null }));
  s.player.normalizer.ctx.currentTime = 130;
  s.step(0);
  assert.equal(s.p, 0.4);
  assert.equal(s.text, '6.0s');
  s.player.normalizer.ctx.currentTime = 140;
  s.step(100);
  assert.equal(s.p, 0.4);
});

test('performance mode, a hidden window and the setting off keep it away, and follow changes mid-transition', t => {
  const s = setup(t);
  flag('data-perf', true);
  s.start(s.fade());
  assert.deepEqual(s.log, []);
  assert.equal(s.pending, null);
  flag('data-perf', false);
  assert.deepEqual(s.log, ['mount', 'song', 'reveal'], 'turning performance mode off mid-transition shows it');
  assert.ok(s.pending);
  flag('data-hidden', true);
  assert.deepEqual(s.log.slice(-2), ['conceal', 'unmount'], 'minimizing hides it at once');
  assert.equal(s.pending, null);
  flag('data-hidden', false);
  assert.equal(s.log.at(-1), 'reveal');
  s.end();
});

test('with the setting off a transition never shows', t => {
  const s = setup(t);
  settings.transitionTab = false;
  s.start(s.fade());
  assert.deepEqual(s.log, []);
  assert.equal(s.scheduled, 0);
});

test('turning the setting off mid-transition hides it right away', t => {
  const s = setup(t);
  s.start(s.fade());
  settings.transitionTab = false;
  store.emit('settings', settings);
  assert.deepEqual(s.log.slice(-2), ['conceal', 'unmount']);
  assert.equal(s.pending, null);
  settings.transitionTab = true;
  store.emit('settings', settings);
  assert.equal(s.log.at(-1), 'reveal');
});

test('with reduced motion it appears and leaves without sliding, and the marker still moves', t => {
  const s = setup(t, { slides: false });
  s.start(s.fade());
  assert.equal(s.log.at(-1), 'reveal-now');
  s.player.normalizer.ctx.currentTime = 104;
  s.step(0);
  assert.equal(s.p, 0.4);
  s.player.normalizer.ctx.currentTime = 111;
  s.end();
  assert.deepEqual(s.log.slice(-2), ['conceal', 'unmount'], 'gone at once, no slide timer');
});

test('a plain crossfade (Auto mix off, no shape) draws equal-power curves', t => {
  const s = setup(t);
  s.start(s.fade({ shapeIn: null, shapeOut: null, bass: false, bassOpts: undefined, style: 'blend' }));
  assert.equal(s.style, 'Smooth blend');
  assert.ok(s.out.startsWith('M0.0,8.0 '), 'the outgoing song starts at full level');
  assert.ok(s.in.startsWith('M0.0,92.0 '), 'the incoming song starts silent');
  assert.ok(s.out.includes('L300.0,32.6') && s.in.includes('L300.0,32.6'), 'equal power at the middle');
  assert.ok(s.out.endsWith('L600.0,92.0') && s.in.endsWith('L600.0,8.0'));
});

test('a drop cut draws its schedule and follows the audio clock', t => {
  const s = setup(t);
  const schedule = { start: 10, cut: 18, drop: 19, end: 20, kill: { style: 'sweep', hz: 2400 } };
  const f = s.fade({ style: 'dropcut', schedule, seconds: undefined, startedAt: null, progress: 0, shapeIn: null, shapeOut: null, bass: false });
  s.player.normalizer.ctx.currentTime = 15;
  s.start(f);
  assert.equal(s.style, 'Drop cut');
  assert.equal(s.p, 0.5);
  assert.equal(s.text, '5.0s');
  const values = curveValues(f, true);
  assert.equal(s.out, curvePath(values.fadeOut));
  assert.equal(s.in, curvePath(values.fadeIn));
  // the outgoing song is on until the cut at 18 (80% of the schedule), the incoming starts at the drop at 19 (90%)
  assert.ok(s.out.includes('L478.1,8.0') && s.out.includes('L487.5,92.0'));
  assert.ok(s.in.includes('L534.4,92.0') && s.in.includes('L543.8,8.0'));
  s.player.normalizer.ctx.currentTime = 19;
  s.step(0);
  assert.equal(s.p, 0.9);
});

test('the style names are the existing ones', t => {
  const s = setup(t);
  const names = [];
  for (const extra of [{ genre: 'quickcut' }, { genre: 'doubledrop' }, { genre: null, style: 'blend' }]) {
    s.start(s.fade(extra));
    names.push(s.style);
    s.end();
  }
  assert.deepEqual(names, ['Quick cut', 'Double drop', 'Smooth blend']);
});

// What Producer's Automation panel drew before the curves moved into mix-curves.js
function drawnBefore(f, drop) {
  const clamp = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const schedule = drop ? f?.schedule : null;
  const span = schedule ? schedule.end - schedule.start : 0;
  return [0, 1, 2, 3].map(index => {
    const incoming = index % 2 === 1;
    const shape = (incoming ? f?.shapeIn : f?.shapeOut) || {};
    const center = shape.center ?? 0.5;
    const amount = shape.dj === true ? 1 : clamp(Number(shape.dj));
    const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
    return Array.from({ length: 65 }, (_, n) => {
      const t = n / 64;
      const phase = incoming ? t : 1 - t;
      const plain = Math.sin(phase * Math.PI / 2);
      const djPhase = incoming ? smooth(t / (shape.inEnd ?? center)) : 1 - smooth((t - center) / (1 - center));
      const scheduledTime = schedule ? schedule.start + t * span : 0;
      const level = drop ? (schedule ? (incoming ? scheduledTime >= schedule.drop : scheduledTime < schedule.cut) : 0) :
        plain + (Math.sin(djPhase * Math.PI / 2) - plain) * amount;
      const eq = drop ? (schedule && !incoming ? Math.log2(Math.max(25, highpassAt(schedule, scheduledTime)) / 25) / 10 : 0) :
        1 + eqLevels(incoming, t, f?.bass ? f.bassOpts?.eq : 0, f?.bassOpts?.center ?? 0.5, f?.bass ? f.bassOpts?.midHold : null).mid / 26;
      const value = index < 2 ? Number(level) : eq;
      return `${n ? 'L' : 'M'}${(t * 600).toFixed(1)},${(92 - clamp(value) * 84).toFixed(1)}`;
    }).join(' ');
  });
}

test('the shared curve helper returns what Producer drew before', () => {
  const schedule = { start: 10, cut: 18, drop: 19, end: 20, kill: { style: 'sweep', hz: 2400 } };
  const cases = [
    [undefined, false],
    [{}, false],
    [{ shapeIn: { dj: 1 }, shapeOut: { dj: 1 }, bass: true, bassOpts: { eq: 1 } }, false],
    [{ shapeIn: { dj: 0.6, center: 0.3 }, shapeOut: { dj: 0.6, center: 0.3 }, bass: true, bassOpts: { eq: 0.6, center: 0.3, midHold: 0.5 } }, false],
    [{ shapeIn: { dj: true, center: 0.6, inEnd: 0.9 }, shapeOut: { dj: true, center: 0.6 }, bass: true, bassOpts: { eq: 0.5, center: 0.6 } }, false],
    [{ shapeIn: null, shapeOut: null, bass: false }, false],
    [{ schedule }, true],
    [{}, true],
  ];
  for (const [f, drop] of cases) {
    const values = curveValues(f, drop);
    const drawn = [values.fadeOut, values.fadeIn, values.eqOut, values.eqIn].map(curvePath);
    assert.deepEqual(drawn, drawnBefore(f, drop), JSON.stringify([f, drop]));
  }
  assert.notEqual(curveKey({ schedule }, true), curveKey({ schedule: { ...schedule, cut: 17 } }, true));
  assert.equal(curveProgress({ schedule }, true, 15, 0.1), 0.5);
  assert.equal(curveProgress({}, false, 15, 0.1), 0.1);
  assert.equal(curveProgress({ schedule }, true, undefined, 0.2), 0.2);
});

test('the real view has an aria-hidden graph, one polite status line and takes no pointer or focus', () => {
  const previous = document.createElementNS;
  document.createElementNS = () => {
    const node = h('svg');
    const set = node.setAttribute.bind(node);
    node.setAttribute = (key, value) => { set(key, value); if (key === 'class') node.className = value; };
    return node;
  };
  try {
    const view = createTabView();
    const all = node => [node, ...node.childNodes.flatMap(all)];
    const nodes = all(view.el);
    assert.equal(nodes.find(n => n.className === 'tt-graph').attributes.get('aria-hidden'), 'true');
    const status = nodes.filter(n => n.attributes?.get('role') === 'status');
    assert.equal(status.length, 1);
    assert.equal(status[0].className, 'tt-song');
    assert.equal(nodes.some(n => n.attributes?.has('tabindex')), false);
    view.mount();
    view.setSong({ title: 'One' }, { title: 'Two' });
    view.setStyle('Drop cut');
    view.setProgress(0.25, '3.0s');
    view.setProgress(0.25, '3.0s');
    assert.equal(nodes.find(n => n.className === 'tt-from').textContent, 'One');
    assert.equal(nodes.find(n => n.className === 'tt-marker').attributes.get('d'), 'M150.0,0 V100');
    assert.equal(nodes.find(n => n.className === 'tt-left').textContent, '3.0s');
    view.reveal(true);
    assert.equal(view.el.dataset.slide, 'on');
    view.unmount();
    assert.equal(view.el.hidden, true);
  } finally {
    document.createElementNS = previous;
  }
});

test('a cancel near the end (the player did not move on to the next song) leaves right away', t => {
  const s = setup(t);
  s.start(s.fade({ seconds: 1.2 }));
  s.player.normalizer.ctx.currentTime = 101.18; // 98%
  s.end({ id: 99, title: 'Another playlist' });
  assert.equal(s.log.at(-1), 'conceal', 'no 1.5 s hold');
});

test('an armed drop cut counts down to its end, and the marker waits at 0 until the schedule starts', t => {
  const s = setup(t);
  const schedule = { start: 12, cut: 20, drop: 21, end: 22, kill: { style: 'none' } };
  s.player.normalizer.ctx.currentTime = 10;
  s.start(s.fade({ style: 'dropcut', schedule, seconds: undefined, startedAt: null, shapeIn: null, shapeOut: null, bass: false }));
  assert.equal(s.p, 0);
  assert.equal(s.text, '12.0s');
  s.player.normalizer.ctx.currentTime = 17;
  s.step(0);
  assert.equal(s.p, 0.5);
  assert.equal(s.text, '5.0s');
});

test('the top bar is measured again when it shows and when settings change while it is up', async t => {
  const s = setup(t);
  s.start(s.fade());
  assert.equal(s.measured, 1);
  store.emit('settings', settings);
  assert.equal(s.measured, 2);
  await Promise.resolve();
  assert.equal(s.measured, 3, 'and once more after the new layout is applied');
});

test('null shapes with a paused blend (progress 0.4, 6 s) draw and hold without throwing', t => {
  const s = setup(t);
  const f = { from: A, to: B, shapeIn: null, shapeOut: null, progress: 0.4, startedAt: null, seconds: 6, style: 'blend' };
  assert.doesNotThrow(() => { curveKey(f, false); curveValues(f, false); });
  s.start(f);
  assert.ok(s.out.startsWith('M0.0,8.0 ') && s.in.startsWith('M0.0,92.0 '));
  assert.ok(!/NaN|undefined/.test(s.out + s.in));
  assert.equal(s.p, 0.4);
  assert.equal(s.text, '3.6s');
  s.step(0);
  s.end();
});
