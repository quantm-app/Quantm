import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import * as mixlearn from '../src/js/mixlearn.js';
import * as mixmemory from '../src/js/mixmemory.js';
import { dropAudio } from './helpers/drop-audio.js';
import { BeatLock } from '../src/js/automix.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings, saveSettings } = await import('../src/js/store.js');
const cues = await import('../src/js/cues.js');
startup.mock.restore();

function fixture(t) {
  let id = 0;
  const timers = new Map(), calls = [];
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal';
  settings.autoMix = true; settings.transitionStyle = 'auto';
  const p = new player.constructor();
  t.after(() => { p.fading = null; p.lock = null; p.tempoRelease = null; });
  cues._reset(); mixmemory.reset();
  const from = { id: 11, title: 'Outgoing', duration: 201000 };
  const to = { id: 12, title: 'Incoming', duration: 201000 };
  p.queue = [from, to]; p.index = 1; p.active = 1; p.loadId = 2;
  const [outgoing, incoming] = p.decks;
  for (const deck of p.decks) {
    Object.assign(deck.audio, { readyState: 4, paused: false, seeking: false, duration: 201, playbackRate: 1,
      buffered: { length: 1, start: () => 0, end: () => 201 },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}, load() {} });
  }
  outgoing.audio.currentTime = 99;
  incoming.audio.currentTime = 75;
  outgoing.track = from; incoming.track = to;
  const ctx = { currentTime: 10 };
  p.normalizer = { ctx, effect: false,
    startDropCut(a, b, schedule) { this.effect = true; calls.push(['schedule', schedule]); return true; },
    clearDropCut() { this.effect = false; calls.push(['clear']); },
    clearEchoOut() {},
    setFade(a, value) { calls.push(['fade', a, value]); },
    fadeDeck() { calls.push(['blend']); }, holdBass() {}, setActive() {}, startTrack() {},
    holdFade() {}, setEqualizer() {}
  };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  const grid = { bpm: 120, period: 0.5, offset: 0, confidence: 0.9 };
  const f = p.fading = { from, to, outgoing, incoming, seconds: 17, bass: false, progress: 0, startedAt: null,
    style: 'dropcut', dropcut: { drop: { time: 92, confidence: 0.8 }, window: { build: 100, cut: 116 },
      match: { gridOut: grid, gridIn: grid, ratio: 1 } },
    prep: { auto: true, stream: { track: {} }, track: to }, fromQueue: p.queue, fromIndex: 0 };
  const advance = now => {
    const seconds = now - ctx.currentTime;
    outgoing.audio.currentTime += seconds * outgoing.audio.playbackRate;
    incoming.audio.currentTime += seconds * incoming.audio.playbackRate;
    ctx.currentTime = now;
    timers.get(f.monitor)?.();
  };
  return { p, f, timers, calls, ctx, advance };
}

test('drop-cut controller pre-rolls, shows build/roll/cut/drop, and cleans the completed effect', t => {
  const { p, f, advance, timers, calls } = fixture(t);
  p.beginFade();
  assert.equal(f.dropScheduled, true);
  assert.equal(f.phase, 'build');
  advance(f.schedule.roll);
  assert.equal(f.phase, 'roll');
  advance(f.schedule.cut);
  assert.equal(f.phase, 'cut');
  advance(f.schedule.drop);
  assert.equal(f.phase, 'drop');
  advance(f.schedule.end);
  assert.equal(p.fading, null);
  assert.equal(p.normalizer.effect, false);
  assert.equal(timers.has(f.monitor), false);
  assert.equal(f.outgoing.audio.paused, true);
  const mute = calls.findIndex(c => c[0] === 'fade' && c[1] === f.outgoing.audio && c[2] === 0);
  assert.ok(mute >= 0 && mute < calls.findIndex(c => c[0] === 'clear'), 'mute outgoing before reconnecting its dry bypass');
});

test('the real pair planner starts a muted pre-roll and arms its drop on the outgoing phrase', t => {
  const { p, f, ctx, calls } = fixture(t);
  p.fading = null; p.index = 0; p.active = 0;
  settings.autoMix = true; settings.transitionStyle = 'blend';
  cues._reset(); mixmemory.reset();
  const grid = f.dropcut.match.gridOut;
  mixmemory.learn(f.from.id, { grid });
  mixmemory.learn(f.to.id, { grid, drop: f.dropcut.drop });
  cues.setPair(f.from.id, f.to.id, { style: 'dropcut', in: 92 });
  p.mixPlan = { loadId: p.loadId, grid, span: 16, choice: mixlearn.choose('mid', () => 0.5) };
  p.prepared = { ...f.prep, loadId: p.loadId, from: 0,
    preroll: { deck: f.incoming, track: f.to, done: true, grid, startAt: 73 } };
  f.outgoing.audio.currentTime = 175;
  f.incoming.audio.paused = true;
  p.normalizer.addDeck = () => true;
  t.mock.method(p, 'startListening', () => {});
  t.mock.method(p, 'notify', () => {});
  t.mock.method(p.beats, 'grid', () => null);
  p.startCrossfade();
  assert.equal(p.current, f.to);
  assert.equal(p.fading.style, 'dropcut');
  assert.equal(p.fading.bass, false, 'incoming bass is never killed');
  assert.ok(!p.fading.bassOpts, 'a drop cut gets no three-band blend shaping');
  assert.equal(f.incoming.audio.currentTime, 75, 'seek before the marker silently to reach its drop on time');
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(p.fading.dropScheduled, true);
  assert.equal(calls.find(c => c[0] === 'schedule')[1].drop, ctx.currentTime + 17);
  cues._reset();
});

for (const action of ['seek', 'cutFade']) {
  test(`${action} during a drop cut removes effects, cancels its clock and opens full incoming level`, t => {
    const { p, f, timers, calls } = fixture(t);
    p.beginFade();
    p[action](80);
    assert.equal(p.fading, null);
    assert.equal(p.normalizer.effect, false);
    assert.equal(timers.has(f.monitor), false);
    assert.ok(calls.some(c => c[0] === 'fade' && c[1] === f.incoming.audio && c[2] === 1));
    if (action === 'pause') assert.equal(p.audio.paused, true);
    if (action === 'seek') assert.equal(p.audio.currentTime, 80);
  });
}

test('a late or drifting pre-roll switches to a smooth blend and cancels the scheduled drop', t => {
  const { p, f, calls, advance, timers } = fixture(t);
  p.beginFade();
  const monitor = f.monitor;
  f.incoming.audio.currentTime -= 0.1;
  advance(f.schedule.drop - 0.5);
  assert.equal(f.style, 'blend');
  assert.equal(f.schedule, null);
  assert.equal(p.normalizer.effect, false);
  assert.equal(timers.has(monitor), false);
  assert.ok(calls.some(c => c[0] === 'blend'));
});

test('a stalled silent deck restores the outgoing song and retries the pair as a blend', t => {
  const { p, f, advance, timers } = fixture(t);
  p.beginFade();
  f.incoming.audio.readyState = 2;
  advance(10.1);
  assert.equal(p.fading, null);
  assert.equal(p.current, f.from);
  assert.equal(p.audio, f.outgoing.audio);
  assert.equal(p.audio.paused, false);
  assert.equal(p.normalizer.effect, false);
  assert.equal(timers.has(f.monitor), false);
  assert.equal(p.prepared.dropFailed, true);
  assert.equal(p.prepared.preroll, null);
});

test('thumbs-down ratings of drop cuts are recorded by style and tempo without changing blend parameters, and plain skips teach nothing', t => {
  const { p, f, ctx } = fixture(t);
  p.beginFade();
  ctx.currentTime = f.schedule.start;
  mixlearn.reset();
  for (const [i, during] of [true, false].entries()) {
    p.fading = during ? f : null;
    const choice = { ...mixlearn.choose('mid', () => 0.2), style: 'dropcut' };
    p.mixOutcome = { choice, trackId: p.current.id, mixEnd: during ? null : performance.now() };
    p.noteSkip();
    assert.equal(mixlearn.stats().transitions, i, 'an unrated skip is ignored');
    p.mixOutcome = { choice, trackId: p.current.id, mixEnd: during ? null : performance.now(), rateable: true };
    assert.equal(p.rateMix('bad'), true);
  }
  assert.equal(mixlearn.stats().buckets.mid.styles.dropcut.bad, 2);
  assert.equal(mixlearn.avoidsDropCut('mid'), true);
  assert.equal(mixlearn.avoidsDropCut('fast'), false);
  assert.deepEqual(mixlearn.choose('mid', () => 0.5).base, mixlearn.DEFAULTS);
  mixlearn.record({ ...mixlearn.choose('mid'), style: 'blend' }, 'good');
  assert.equal(mixlearn.stats().buckets.mid.styles.blend.good, 1);
});

function unheard(t, audio = dropAudio()) {
  const result = fixture(t), { p, f, timers, calls } = result;
  p.fading = null; p.index = 0; p.active = 0;
  settings.transitionStyle = 'dropcut';
  const grid = { ...f.dropcut.match.gridOut, downbeat: 0 };
  mixmemory.learn(f.from.id, { grid });
  p.mixPlan = { loadId: p.loadId, grid, span: 16, choice: mixlearn.choose('mid', () => 0.5) };
  const samples = Array.from({ length: 1800 }, (_, i) => i * 201 / 1800 >= 32 ? 0.9 : 0.05);
  p.waves.set(f.to.id, mixmemory.fromWaveform({ samples, width: 1800, height: 1 }, 201));
  const prep = p.prepared = { ...f.prep, loadId: p.loadId, from: 0 };
  p.normalizer.addDeck = () => true;
  t.mock.method(p, 'attach', (stream, play, start, deck, track) => {
    deck.track = track; deck.audio.currentTime = start; deck.audio.paused = false;
    calls.push(['attach', start]);
  });
  t.mock.method(p, 'startListening', () => {});
  t.mock.method(p, 'notify', () => {});
  f.outgoing.audio.currentTime = 150;
  p.preroll(prep);
  const pre = prep.preroll;
  p.beats.watched.set(f.incoming.audio, audio);
  f.incoming.audio.currentTime = pre.candidate.time + 12;
  timers.get(pre.timer)();
  return { ...result, prep, pre, grid };
}

test('an unheard waveform candidate is confirmed by the real watcher and launched before its drop', t => {
  const { p, f, prep, pre, grid, ctx, calls } = unheard(t);
  assert.equal(mixmemory.get(f.to.id).plays, 0, 'silent confirmation is cached without counting a play');
  assert.ok(mixmemory.get(f.to.id).drop.confidence >= 0.65);
  assert.equal(pre.done, true);
  assert.ok(pre.drop.confidence >= 0.7);
  assert.ok(Math.abs(pre.drop.time - 32) < 0.03);
  assert.ok(calls.find(c => c[0] === 'attach')[1] > 19, 'analysis seeks into the whole track, not just the intro');
  assert.ok(Math.abs(f.incoming.audio.currentTime - (pre.drop.time - 17.5)) < 0.02, 'buffering begins before the launch position');
  f.outgoing.audio.currentTime = 175;
  const selected = p.selectMixStyle(prep, cues.transitionFor(f.from.id, f.to.id), grid);
  assert.equal(selected.style, 'dropcut');
  p.startCrossfade();
  assert.ok(Math.abs(f.incoming.audio.currentTime - (pre.drop.time - 17)) < 0.02);
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(p.fading.dropScheduled, true);
  assert.equal(p.fading.schedule.drop, ctx.currentTime + 17);
  assert.equal(p.lock, null, 'BeatLock cannot nudge the silent pre-roll off its landing time');
});

test('a rejected waveform hint restarts ordinary intro analysis for the smooth blend', t => {
  const { p, prep, pre, calls } = unheard(t, dropAudio(32, { constant: true }));
  assert.equal(pre.done, true);
  assert.equal(prep.dropFailed, true);
  assert.notEqual(prep.preroll, pre);
  assert.equal(prep.preroll.candidate, null);
  assert.equal(prep.preroll.startAt, pre.startAt);
  assert.deepEqual(calls.filter(c => c[0] === 'attach').at(-1), ['attach', pre.startAt]);
  assert.equal(p.selectMixStyle(prep, {}, pre.grid).style, 'blend');
});

test('readyState cannot arm an unbuffered drop seek, and completed buffering can enable it', t => {
  const { p, f, prep, grid } = unheard(t);
  f.outgoing.audio.currentTime = 175;
  f.incoming.audio.buffered = { length: 2, start: i => i ? 30 : 0, end: i => i ? 40 : 5 };
  assert.equal(f.incoming.audio.readyState, 4);
  const selected = p.selectMixStyle(prep, {}, grid);
  assert.equal(selected.style, 'dropcut', 'a plan may wait for buffering without committing its graph');
  assert.ok(f.incoming.audio.currentTime < 15, 'seek is staged while the outgoing song still plays');
  p.startCrossfade();
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(p.fading.dropScheduled, undefined);
  assert.equal(p.normalizer.effect, false);
  f.incoming.audio.buffered = { length: 1, start: () => 14, end: () => 40 };
  p.beginDropCut(p.fading);
  assert.equal(p.fading.dropScheduled, true);
  p.cutFade();
  p.active = 0; p.index = 0;
  assert.equal(p.selectMixStyle(prep, { in: 40 }, grid).style, 'blend', 'drop cannot precede a mix-in marker');
  assert.equal(p.selectMixStyle(prep, { out: 200 }, grid).style, 'blend', 'late mix-out markers cannot fit a build');
  prep.stream.snipped = true;
  assert.equal(p.selectMixStyle(prep, {}, grid).style, 'blend', 'preview times do not describe the full track');
});

test('drop timing and loop fractions follow the actual stretched outgoing rate and the audio clock', t => {
  const { p, f, ctx, advance } = fixture(t);
  f.outgoing.audio.playbackRate = 1.2;
  f.dropcut.match.ratio = 1.02;
  f.incoming.audio.playbackRate = 1.224;
  f.incoming.audio.currentTime = 92 - (116 - 99) * 1.02;
  p.beginFade();
  assert.equal(f.style, 'dropcut');
  assert.ok(Math.abs(f.schedule.drop - (ctx.currentTime + 17 / 1.2)) < 1e-9);
  for (const stage of f.schedule.stages) assert.equal(stage.delay, stage.fraction * 0.5 / 1.2);
  assert.equal(p.lock, null);
  advance(f.schedule.drop);
  assert.equal(f.landed, true);
  assert.ok(Math.abs(f.incoming.audio.currentTime - 92) < 1e-9);
  assert.equal(p.lock, null, 'phase locking is already released after landing');
  assert.equal(p.tempoRelease.timer, null, 'only the tempo release runs after landing');
  assert.equal(f.incoming.audio.playbackRate, 1.224);
  p.stopLock();
});

test('a previous tempo glide is stopped without changing the outgoing build rate', t => {
  const { p, f } = unheard(t);
  f.outgoing.audio.currentTime = 174.8;
  f.outgoing.audio.playbackRate = 1.2;
  let stopped = false;
  p.lock = { incoming: f.outgoing.audio, stop() { stopped = true; f.outgoing.audio.playbackRate = 1; } };
  p.startCrossfade();
  assert.equal(stopped, true);
  assert.equal(p.fading.style, 'dropcut');
  assert.equal(f.outgoing.audio.playbackRate, 1.2);
  assert.ok(Math.abs(f.incoming.audio.playbackRate - 1.2 * p.fading.dropcut.match.ratio) < 1e-9);
});

for (const action of ['style', 'pair style', 'cue', 'auto off', 'speed', 'native seek', 'native pause', 'previous']) {
  test(`${action} cancels an armed drop, resets speed, and does not learn a kept silent pre-roll`, t => {
    const { p, f, timers } = fixture(t);
    f.dropcut.match.ratio = 1.02;
    f.incoming.audio.currentTime = 92 - 17 * 1.02;
    f.incoming.audio.playbackRate = 1.02;
    p.beginFade();
    const monitor = f.monitor;
    p.mixOutcome = { choice: { ...mixlearn.choose('mid'), style: 'dropcut' }, trackId: f.to.id, timer: null };
    if (action === 'style') saveSettings({ transitionStyle: 'blend' });
    if (action === 'pair style') cues.setPair(f.from.id, f.to.id, { style: 'blend' });
    if (action === 'cue') cues.setMixIn(f.to.id, 30);
    if (action === 'auto off') saveSettings({ autoMix: false });
    if (action === 'speed') saveSettings({ speedMode: 'nightcore' });
    if (action === 'native seek') f.incoming.audio.dispatchEvent({ type: 'seeking' });
    if (action === 'native pause') { f.incoming.audio.paused = true; f.incoming.audio.dispatchEvent({ type: 'pause' }); }
    if (action === 'previous') p.prev();
    assert.equal(p.fading, null);
    assert.equal(p.normalizer.effect, false);
    assert.equal(timers.has(monitor), false);
    assert.equal(f.incoming.audio.playbackRate, action === 'speed' ? 1.25 : 1);
    assert.equal(p.mixOutcome, null);
  });
}

test('an abandoned silent attempt and an emergency blend never train Drop cut or blend parameters', t => {
  const { p, f, advance } = fixture(t);
  mixlearn.reset();
  const outcome = () => ({ choice: { ...mixlearn.choose('mid'), style: 'dropcut' }, trackId: f.to.id, timer: null });
  p.mixOutcome = outcome();
  p.noteSkip();
  assert.equal(mixlearn.stats().transitions, 0, 'the incoming song is still silent');
  p.beginFade();
  p.mixOutcome = outcome();
  f.incoming.audio.currentTime -= 0.1;
  advance(f.schedule.drop - 0.5);
  assert.equal(f.style, 'blend');
  assert.equal(p.mixOutcome, null);
  assert.equal(f.incoming.audio.playbackRate, 1);
  assert.equal(mixlearn.stats().transitions, 0);
});

test('a seek after a landed drop cannot be counted as twenty seconds of listening', t => {
  const { p, f, advance, timers } = fixture(t);
  mixlearn.reset();
  p.beginFade();
  p.mixOutcome = { choice: { ...mixlearn.choose('mid'), style: 'dropcut' }, trackId: f.to.id, timer: null };
  advance(f.schedule.drop);
  advance(f.schedule.end);
  const timer = p.mixOutcome.timer, callback = timers.get(timer);
  p.seek(150);
  callback();
  assert.equal(p.mixOutcome, null);
  assert.equal(timers.has(timer), false);
  assert.equal(mixlearn.stats().transitions, 0);
});

test('completed drop cuts learn good outcomes only after further playback', t => {
  const { p, f, advance, timers } = fixture(t);
  mixlearn.reset();
  p.beginFade();
  p.mixOutcome = { choice: { ...mixlearn.choose('mid'), style: 'dropcut' }, trackId: f.to.id, timer: null };
  advance(f.schedule.drop);
  advance(f.schedule.end);
  assert.equal(mixlearn.stats().transitions, 0);
  f.incoming.audio.currentTime += 20;
  timers.get(p.mixOutcome.timer)();
  assert.equal(mixlearn.stats().buckets.mid.styles.dropcut.good, 1);
});

test('repeated starts and abandoned playing/metadata callbacks cannot schedule a second mix or seek a reused deck', t => {
  const { p, f, prep } = unheard(t);
  f.outgoing.audio.currentTime = 175;
  const baseline = f.incoming.audio.listenerCount('playing');
  p.startCrossfade();
  const fading = p.fading;
  p.prepared = prep;
  p.startCrossfade();
  assert.equal(p.fading, fading);
  assert.equal(p.prepared, prep);
  p.cutFade();
  assert.equal(f.incoming.audio.listenerCount('playing'), baseline);
  p.attach.mock.restore();
  p.attach({ url: 'test:old', track: {} }, false, 80, f.outgoing, f.from);
  p.releaseDeck(f.outgoing);
  p.attach({ url: 'test:new', track: {} }, false, 0, f.outgoing, f.from);
  f.outgoing.audio.currentTime = 0;
  f.outgoing.audio.dispatchEvent({ type: 'loadedmetadata' });
  assert.equal(f.outgoing.audio.currentTime, 0, 'a cancelled candidate seek cannot jump the next stream');
});

test('Smooth blend keeps ordinary planning, fade shape and bass swap, without Drop cut work', t => {
  const { p, f, calls } = fixture(t);
  p.fading = null; p.index = 0; p.active = 0;
  settings.transitionStyle = 'blend';
  const grid = f.dropcut.match.gridOut;
  mixmemory.learn(f.from.id, { grid });
  t.mock.method(p, 'mixFeatures', () => { throw new Error('unused Drop cut feature analysis'); });
  f.outgoing.audio.currentTime = 150;
  assert.equal(p.planMix(f.outgoing.audio, 201).span, 0, 'blend plan is still chosen at its original look-ahead');
  p.mixPlan = { loadId: p.loadId, grid, span: 16, choice: mixlearn.choose('mid', () => 0.5) };
  p.prepared = { ...f.prep, loadId: p.loadId, from: 0,
    preroll: { deck: f.incoming, track: f.to, done: true, grid, startAt: 0 } };
  cues.setPair(f.from.id, f.to.id, { style: 'blend' });
  p.normalizer.addDeck = () => true;
  p.normalizer.swapBass = () => { calls.push(['bass']); };
  t.mock.method(p, 'startListening', () => {});
  t.mock.method(p, 'notify', () => {});
  t.mock.method(p.beats, 'grid', () => null);
  f.outgoing.audio.currentTime = 185;
  p.startCrossfade();
  assert.equal(p.fading.style, 'blend');
  assert.equal(p.fading.seconds, 16);
  assert.equal(p.fading.bass, true);
  assert.deepEqual(p.fading.shapeIn, { dj: 1 });
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(calls.filter(c => c[0] === 'blend').length, 2);
  assert.equal(calls.filter(c => c[0] === 'bass').length, 2);
  assert.equal(calls.some(c => c[0] === 'schedule'), false);
  assert.equal(p.fading.monitor, undefined, 'no Drop cut polling is installed');
});

test('preparation waits for the whole-track waveform before choosing an unheard analysis region', async t => {
  const { p, f } = fixture(t);
  p.fading = null; p.index = 0; p.active = 0;
  let deliver;
  t.mock.method(p, 'waveformOf', () => new Promise(resolve => { deliver = resolve; }));
  t.mock.method(p, 'streamOf', async () => f.prep.stream);
  let hint;
  t.mock.method(p, 'preroll', () => { hint = p.waves.get(f.to.id); });
  f.to.duration = 30000; f.to.full_duration = 201000;
  const pending = p.prepareNext();
  assert.equal(hint, undefined);
  deliver(Array.from({ length: 1800 }, (_, i) => i * 201 / 1800 >= 92 ? 0.9 : 0.05));
  await pending;
  assert.ok(Math.abs(hint.dropCandidates[0].time - 92) < 0.2, 'waveform time uses the full song duration');
});

test('early stream preparation does not change an ordinary blend intro before its plan exists', t => {
  const { p, f, calls } = fixture(t);
  p.fading = null; p.index = 0; p.active = 0;
  p.normalizer.addDeck = () => true;
  const prep = p.prepared = { ...f.prep, loadId: p.loadId, from: 0 };
  p.preroll(prep);
  assert.equal(prep.preroll, undefined);
  assert.equal(calls.some(c => c[0] === 'schedule'), false);
});

test('losing the buffered seek at launch waits, re-plans after the build passes, and arms when ready', t => {
  const { p, f, prep, grid, calls, ctx, timers } = unheard(t);
  f.outgoing.audio.currentTime = 175;
  prep.selected = p.selectMixStyle(prep, {}, grid);
  assert.equal(prep.selected.style, 'dropcut');
  f.incoming.audio.buffered = { length: 0 };
  p.startCrossfade();
  const pending = p.fading;
  const poll = timers.get(pending.armTimer);
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(pending.dropScheduled, undefined);
  assert.equal(calls.some(c => c[0] === 'schedule'), false);
  assert.ok(p.mixLog.some(l => l.text.startsWith('Planning a drop cut…')));
  assert.equal(p.mixLog.some(l => l.text.startsWith('Drop cut into')), false);
  f.outgoing.audio.currentTime = 186;
  ctx.currentTime += 11;
  f.incoming.audio.currentTime += 11;
  poll();
  assert.ok(pending.dropcut.window.build >= f.outgoing.audio.currentTime + 1.8);
  f.incoming.audio.buffered = { length: 1, start: () => 0, end: () => 201 };
  poll(); // aligns the incoming seek to the new cut
  poll(); // checks readiness again before committing
  assert.equal(pending.style, 'dropcut');
  assert.equal(pending.dropScheduled, true);
  assert.ok(pending.schedule.start >= ctx.currentTime + 0.3);
  assert.equal(timers.has(pending.armTimer), false);
  assert.ok(p.mixLog.some(l => l.text.startsWith('Drop cut into')));
});

test('a delayed monitor detects a stalled incoming stream even after the scheduled drop', t => {
  const { p, f, advance } = fixture(t);
  p.beginFade();
  f.incoming.audio.currentTime -= 1;
  advance(f.schedule.drop + 0.1);
  assert.equal(f.style, 'blend');
  assert.equal(f.landed, undefined);
  assert.equal(p.normalizer.effect, false);
});

test('turning off Auto mix retires an unfinished silent candidate and its polling', t => {
  const { p, f, timers } = fixture(t);
  p.fading = null; p.index = 0; p.active = 0;
  p.normalizer.addDeck = () => true;
  p.waves.set(f.to.id, { dropCandidates: [{ time: 92 }], drumsIn: 0 });
  const prep = p.prepared = { ...f.prep, loadId: p.loadId, from: 0 };
  p.preroll(prep);
  const pre = prep.preroll;
  assert.equal(pre.done, false);
  assert.equal(p.beats.isWatching(f.incoming.audio), true);
  saveSettings({ autoMix: false });
  assert.equal(p.prepared, null);
  assert.equal(pre.done, true);
  assert.equal(timers.has(pre.timer), false);
  assert.equal(p.beats.isWatching(f.incoming.audio), false);
  assert.equal(f.incoming.audio.paused, true);
});

test('next-song confirmation starts near the beginning, caches a distant drop, and stages it before a mix plan exists', async t => {
  const { p, f, timers, calls } = fixture(t);
  p.fading = null; p.active = 0; p.index = 0; p.mixPlan = null;
  settings.transitionStyle = 'dropcut';
  f.outgoing.audio.currentTime = 5;
  p.normalizer.addDeck = () => true;
  p.waves.set(f.to.id, { dropCandidates: [{ time: 92, uncertainty: 1 }] });
  t.mock.method(p, 'guessFromWaveform', async () => {});
  t.mock.method(p, 'streamOf', async () => f.prep.stream);
  t.mock.method(p, 'attach', (stream, play, start, deck, track) => {
    deck.track = track; deck.audio.currentTime = start; deck.audio.paused = false;
    calls.push(['attach', start]);
  });
  let pending;
  const prepare = p.prepareNext;
  t.mock.method(p, 'prepareNext', function () { pending = prepare.call(this); return pending; });
  p.checkCrossfade();
  assert.ok(pending, 'preparation starts with more than three minutes left');
  await pending;
  const pre = p.prepared.preroll;
  assert.equal(pre.candidate.time, 92);
  assert.equal(f.incoming.audio.currentTime, 80, 'seek directly to the candidate analysis region');
  assert.equal(p.mixPlan, null);
  const readings = dropAudio().map(s => ({ ...s, t: s.t + 60 }));
  p.beats.watched.set(f.incoming.audio, readings);
  f.incoming.audio.currentTime = 104;
  timers.get(pre.timer)();
  assert.equal(pre.done, true);
  assert.ok(Math.abs(mixmemory.get(f.to.id).drop.time - 92) < 0.03);
  assert.equal(mixmemory.get(f.to.id).plays, 0);
  assert.equal(p.mixPlan, null, 'confirmation does not depend on a transition plan');
  assert.ok(f.incoming.audio.currentTime > 60, 'stage the distant drop even without an outgoing grid');
  assert.match(p.mixLog.map(l => l.text).join('\n'), /Drop at 1:32 confirmed \(1.00\)/);
  p.dropPreroll(p.prepared);
  p.prepared = null;
  const prep = p.prepared = { ...f.prep, loadId: p.loadId, from: 0 };
  p.preroll(prep);
  assert.equal(prep.preroll.candidate, null, 'cached drops do not repeat audio confirmation');
  assert.ok(prep.preroll.drop);
});

test('rejected hints log the measured confidence and try the next ranked region', t => {
  const { p, f, prep, pre, timers } = unheard(t);
  p.dropPreroll(prep);
  mixmemory.reset();
  prep.dropFailed = false;
  p.waves.set(f.to.id, { dropCandidates: [{ time: 32 }, { time: 92 }] });
  p.preroll(prep);
  const attempt = prep.preroll;
  p.beats.watched.set(f.incoming.audio, dropAudio(32, { constant: true }));
  f.incoming.audio.currentTime = 44;
  // Use the installed poll callback; no elapsed transition time is needed.
  timers.get(attempt.timer)();
  assert.equal(prep.preroll.candidate.time, 92);
  assert.equal(prep.dropFailed, false);
  assert.match(p.mixLog.map(l => l.text).join('\n'), /Drop at 0:32 not confirmed \(0.00\): no steady beat/);
  assert.equal(mixmemory.get(f.to.id), null);
  assert.equal(pre.done, true);
});

for (const phase of ['build', 'roll', 'cut', 'drop']) {
  test(`pause during ${phase} restores a flat outgoing deck and play resumes it`, t => {
    const { p, f, advance, timers, calls } = fixture(t);
    p.beginFade();
    if (phase !== 'build') advance(f.schedule[phase]);
    const position = f.outgoing.audio.currentTime;
    p.pause();
    assert.equal(p.fading, null);
    assert.equal(p.current, f.from);
    assert.equal(p.audio, f.outgoing.audio);
    assert.equal(p.audio.paused, true);
    assert.equal(f.incoming.audio.paused, true);
    assert.equal(p.normalizer.effect, false);
    assert.equal(timers.has(f.monitor), false);
    assert.equal(p.lock, null);
    assert.equal(p.mixOutcome, null);
    assert.ok(calls.some(c => c[0] === 'fade' && c[1] === f.outgoing.audio && c[2] === 1));
    assert.equal(p.prepared.dropFailed, true);
    p.play();
    assert.equal(p.audio.paused, false);
    assert.equal(p.audio.currentTime, position);
    assert.equal(p.fading, null);
  });
}

test('a native pause event also restores and pauses the outgoing deck', t => {
  const { p, f } = fixture(t);
  p.beginFade();
  f.incoming.audio.paused = true;
  f.incoming.audio.dispatchEvent({ type: 'pause' });
  assert.equal(p.current, f.from);
  assert.equal(p.audio.paused, true);
  assert.equal(p.normalizer.effect, false);
  p.play();
  assert.equal(p.current, f.from);
  assert.equal(p.audio.paused, false);
});

test('an early confirmed drop fits a four-bar build; a late one has no intro-time limit', t => {
  const { p, f } = fixture(t);
  const match = f.dropcut.match;
  p.active = 0; p.index = 0; p.fading = null;
  const early = p.dropWindow(match.gridOut, { time: 9 }, match, {});
  assert.equal(early.cut - early.build, 8);
  assert.equal(early.lead, 1);
  const late = p.dropWindow(match.gridOut, { time: 150 }, match, {});
  assert.equal(late.cut - late.build, 16);
  assert.equal(late.lead, 1.5);
});

test('a finished blend releases its phase timer and clears the lock after its tempo glide', t => {
  const { p, f, timers } = fixture(t);
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  f.style = 'blend';
  f.incoming.audio.playbackRate = 1.02;
  const lock = p.lock = new BeatLock(f.outgoing.audio, f.incoming.audio, { ...f.dropcut.match, ratio: 1.02 }, 1);
  const phaseTimer = lock.timer;
  p.finishFade(f);
  assert.equal(p.lock, null, 'phase lock releases as soon as the blend finishes');
  assert.equal(p.tempoRelease, lock);
  assert.equal(lock.timer, null);
  assert.equal(timers.has(phaseTimer), false);
  assert.ok(timers.has(lock.glide));
  now += 9000;
  timers.get(lock.glide)();
  assert.equal(p.lock, null);
  assert.equal(p.tempoRelease, null);
  assert.equal(lock.glide, null);
  assert.equal(f.incoming.audio.playbackRate, 1);
});

test('a speed change during the completed blend glide also clears the released lock', t => {
  const { p, f, timers } = fixture(t);
  f.style = 'blend';
  f.incoming.audio.playbackRate = 1.02;
  const lock = p.lock = new BeatLock(f.outgoing.audio, f.incoming.audio, f.dropcut.match, 1, false);
  p.finishFade(f);
  const glide = lock.glide;
  lock.setBaseRate(1.25);
  assert.equal(timers.has(glide), false);
  assert.equal(p.lock, null);
  assert.equal(p.tempoRelease, null);
  assert.equal(lock.glide, null);
  assert.equal(f.incoming.audio.playbackRate, 1.25);
});

for (const phase of ['pre-roll', 'build', 'roll', 'cut']) {
  test(`Next during ${phase} lands on the pending drop without moving the queue or fetching autoplay`, async t => {
    const { p, f, advance, timers, calls } = fixture(t);
    if (phase !== 'pre-roll') {
      p.beginFade();
      if (phase !== 'build') advance(f.schedule[phase]);
    }
    settings.autoplayRelated = true;
    t.mock.method(p, 'appendRelated', () => { throw new Error('must not fetch autoplay'); });
    t.mock.method(p, 'load', () => { throw new Error('must retain the incoming deck'); });
    const queue = p.queue, index = p.index;
    await p.next();
    assert.equal(p.current, f.to);
    assert.equal(p.queue, queue);
    assert.equal(p.index, index);
    assert.equal(p.audio, f.incoming.audio);
    assert.equal(p.audio.currentTime, f.dropcut.drop.time);
    assert.equal(p.audio.paused, false);
    assert.equal(p.audio.playbackRate, 1);
    assert.equal(p.fading, null);
    assert.equal(p.normalizer.effect, false);
    assert.equal(p.lock, null);
    assert.equal(p.mixOutcome, null);
    assert.equal(timers.has(f.monitor), false);
    assert.ok(calls.some(c => c[0] === 'fade' && c[1] === f.incoming.audio && c[2] === 1));
  });
}

test('a confirmed drop cuts between unrelated tempos using only a modest outgoing grid', t => {
  const { p, f, prep, grid } = unheard(t);
  const outgoing = { ...grid, bpm: 147.2, period: 60 / 147.2, confidence: 0.28 };
  prep.preroll.dropGrid = { ...grid, bpm: 175, period: 60 / 175, confidence: 0.8 };
  p.mixPlan.grid = outgoing;
  f.outgoing.audio.currentTime = 150;
  const selected = p.selectMixStyle(prep, {}, outgoing);
  assert.equal(selected.style, 'dropcut');
  assert.equal(selected.variant, 'roll');
  assert.equal(selected.match.ratio, 1, 'there is no tempo stretch to match an inaudible overlap');
  assert.equal(selected.match.gridOut.period, 60 / 147.2);
  assert.match(selected.reason, /loop roll/);
});

test('a weak outgoing grid uses the echo variant and lands a confirmed drop without rolls', t => {
  const { p, f, prep, advance, timers } = unheard(t);
  p.mixPlan.grid = null;
  f.outgoing.audio.currentTime = 190;
  const selected = p.selectMixStyle(prep, {}, null);
  assert.equal(selected.style, 'dropcut');
  assert.equal(selected.variant, 'echo');
  assert.match(selected.reason, /no loop roll/);
  prep.selected = selected;
  f.outgoing.audio.currentTime = selected.window.build - selected.window.lead;
  // Exercise the real launcher with no remembered or live outgoing beat.
  mixmemory.reset();
  t.mock.method(p.beats, 'grid', () => null);
  p.startCrossfade();
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  const fading = p.fading;
  assert.equal(fading.style, 'dropcut');
  assert.equal(fading.dropcut.variant, 'echo');
  assert.deepEqual(fading.schedule.stages, []);
  advance(fading.schedule.drop);
  timers.get(fading.monitor)();
  assert.equal(fading.landed, true);
  const remaining = fading.dropcut.drop.time - f.incoming.audio.currentTime;
  assert.ok(Math.abs(remaining) < 0.01);
});

test('confirmation arriving after a blend plan re-plans before launch with time to seek and build', t => {
  const { p, f, prep, pre, grid, timers } = unheard(t);
  p.dropPreroll(prep);
  mixmemory.reset();
  prep.dropFailed = false;
  p.preroll(prep);
  const late = prep.preroll;
  prep.selected = p.selectMixStyle(prep, {}, grid);
  assert.equal(prep.selected.style, 'blend');
  p.mixPlan.style = prep.selected.style;
  f.outgoing.audio.currentTime = 164;
  p.checkCrossfade();
  assert.equal(p.mixPlan.style, 'blend', 'still confirming the candidate');
  assert.equal(p.fading, null);
  p.beats.watched.set(f.incoming.audio, dropAudio());
  f.incoming.audio.currentTime = late.candidate.time + 12;
  timers.get(late.timer)();
  f.outgoing.audio.currentTime = 165;
  p.checkCrossfade();
  assert.equal(p.mixPlan.style, 'dropcut');
  assert.equal(prep.selected.variant, 'roll');
  assert.equal(p.fading, null, 'buffering and build lead are preserved');
  assert.match(p.mixLog.map(l => l.text).join('\n'), /Re-planned as a drop cut/);
  f.outgoing.audio.currentTime = prep.selected.window.build - prep.selected.window.lead;
  p.checkCrossfade();
  assert.equal(p.fading.style, 'dropcut');
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(p.fading.dropScheduled, true);
  assert.equal(pre.done, true);
  assert.equal(p.fading.dropcut.match.gridOut.period, grid.period);
});

test('a no-beat plan refreshes from the current play before persistent memory is saved', t => {
  const { p, f } = fixture(t);
  p.fading = null; p.index = 0; p.active = 0;
  const audio = f.outgoing.audio;
  audio.currentTime = 164;
  t.mock.method(p.beats, 'grid', () => null);
  const first = p.planMix(audio, 201);
  assert.equal(first.grid, null);
  let fed = false;
  p.listening.set(audio, { listener: { summary: () => ({ grid: f.dropcut.match.gridOut }) } });
  t.mock.method(p, 'feedOne', () => { fed = true; });
  audio.currentTime = 167;
  const updated = p.planMix(audio, 201);
  assert.equal(fed, true);
  assert.equal(updated.grid.bpm, 120);
  assert.equal(updated.choice.bucket, 'mid');
  assert.equal(mixmemory.get(f.from.id), null, 'ongoing plays do not increment persistent memory');
});

test('late confirmation can shorten the build and use an outgoing beat after the preferred phrase', t => {
  const { p, f, prep, grid } = unheard(t);
  f.outgoing.audio.currentTime = 186;
  const selected = p.selectMixStyle(prep, {}, grid);
  assert.equal(selected.style, 'dropcut');
  assert.equal(selected.window.cut - selected.window.build, 16 * grid.period);
  assert.ok(selected.window.build > f.outgoing.audio.currentTime + selected.window.lead);
  assert.equal((selected.window.cut - grid.offset) % grid.period, 0);
  assert.ok(selected.window.cut < f.outgoing.audio.duration);
  f.outgoing.audio.currentTime = 198;
  assert.equal(p.selectMixStyle(prep, {}, grid).style, 'blend', 'a full build must still fit');
});

for (const variant of ['roll', 'echo']) {
  test(`pause and resume before a ${variant} build is armed clears effects and resumes the outgoing song`, t => {
    const { p, f, calls } = fixture(t);
    f.dropcut.variant = variant;
    p.pause();
    assert.equal(p.current, f.from);
    assert.equal(p.audio.paused, true);
    assert.equal(f.incoming.audio.paused, true);
    assert.equal(p.fading, null);
    assert.equal(p.normalizer.effect, false);
    assert.equal(p.mixOutcome, null);
    p.play();
    assert.equal(p.current, f.from);
    assert.equal(p.audio.paused, false);
    assert.equal(p.prepared.dropFailed, true);
    assert.equal(calls.some(c => c[0] === 'schedule'), false);
  });
}

test('pause during the echo build cancels its audio clock and resume keeps the outgoing position', t => {
  const { p, f, timers } = fixture(t);
  f.dropcut.variant = 'echo';
  p.beginFade();
  assert.equal(f.schedule.variant, 'echo');
  assert.equal(p.normalizer.effect, true);
  const position = f.outgoing.audio.currentTime;
  p.pause();
  assert.equal(timers.has(f.monitor), false);
  assert.equal(p.normalizer.effect, false);
  assert.equal(p.current, f.from);
  assert.equal(p.audio.paused, true);
  p.play();
  assert.equal(p.current, f.from);
  assert.equal(p.audio.currentTime, position);
  assert.equal(p.audio.paused, false);
});

test('a late playing event re-plans instead of committing a build behind the outgoing playhead', t => {
  const { p, f, prep, ctx, timers } = unheard(t);
  f.outgoing.audio.currentTime = 175;
  p.startCrossfade();
  const pending = p.fading;
  f.outgoing.audio.currentTime = 188;
  f.incoming.audio.currentTime += 13;
  ctx.currentTime += 13;
  f.incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(pending.dropScheduled, undefined, 're-seeking must finish before commit');
  timers.get(pending.armTimer)();
  assert.equal(pending.dropScheduled, true);
  assert.equal(pending.style, 'dropcut');
  assert.ok(pending.schedule.start >= ctx.currentTime + 0.3);
  assert.ok(pending.dropcut.window.build > f.outgoing.audio.currentTime);
  assert.equal(prep.dropFailed, undefined);
});

for (const waiting of ['seeking', 'readyState', 'paused']) {
  test(`arming waits for ${waiting}, checks again, and cancels its readiness poll`, t => {
    const { p, f, timers } = fixture(t);
    const audio = f.incoming.audio;
    const original = audio[waiting];
    audio[waiting] = waiting === 'readyState' ? 2 : true;
    if (waiting === 'paused') p.beginDropCut(f);
    else p.beginFade();
    const poll = f.armTimer;
    assert.equal(f.dropScheduled, undefined);
    assert.equal(p.normalizer.effect, false);
    audio[waiting] = original;
    timers.get(poll)();
    assert.equal(f.dropScheduled, true);
    assert.equal(timers.has(poll), false);
    assert.ok(f.schedule.start >= p.normalizer.ctx.currentTime + 0.3);
  });
}

test('a readiness deadline retires the poll and keeps the outgoing song if the silent deck stays stalled', t => {
  const { p, f, timers } = fixture(t);
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  f.incoming.audio.readyState = 2;
  p.beginFade();
  const poll = f.armTimer, callback = timers.get(poll);
  now = f.armDeadline + 1;
  callback();
  assert.equal(p.fading, null);
  assert.equal(p.current, f.from);
  assert.equal(timers.has(poll), false);
  assert.equal(p.normalizer.effect, false);
  callback();
  assert.equal(p.current, f.from, 'a queued poll cannot act on a retired transition');
  assert.ok(p.mixLog.some(l => /readiness deadline/.test(l.text)));
});

test('no future two-bar cut falls back without ever logging an armed drop', t => {
  const { p, f } = fixture(t);
  f.outgoing.audio.currentTime = 198;
  p.beginFade();
  assert.equal(f.style, 'blend');
  assert.equal(p.normalizer.effect, false);
  assert.equal(p.mixLog.some(l => l.text.startsWith('Drop cut into')), false);
});

test('the last future two-bar cut still arms when the preferred seek lead no longer fits', t => {
  const { p, f, timers } = fixture(t);
  f.outgoing.audio.currentTime = 194.6;
  p.beginFade();
  assert.equal(f.style, 'dropcut');
  assert.equal(f.dropcut.window.cut, 200);
  assert.equal(f.dropcut.window.build, 196);
  timers.get(f.armTimer)();
  assert.equal(f.dropScheduled, true);
  assert.ok(f.schedule.start >= p.normalizer.ctx.currentTime + 0.3);
});

test('pause preserves the outgoing 199.61 s position independently of the silent incoming 110.7 s position', t => {
  const { p, f, timers } = fixture(t);
  f.outgoing.audio.duration = 226;
  f.outgoing.audio.currentTime = 199.61;
  f.incoming.audio.currentTime = 110.7;
  f.dropcut.window = { build: 200.61, cut: 216.61 };
  f.dropcut.drop.time = 127.7;
  let positionWrites = 0, position = 199.61;
  Object.defineProperty(f.outgoing.audio, 'currentTime', { configurable: true,
    get: () => position, set: value => { positionWrites++; position = value; } });
  const timeEvents = [];
  p.on('time', value => timeEvents.push(value));
  p.beginFade();
  const monitor = timers.get(f.monitor), onPlaying = f.onPlaying;
  assert.equal(p.audio.currentTime, 110.7, 'during the build the active deck is the silent incoming song');
  p.pause();
  monitor();
  onPlaying?.();
  f.incoming.audio.dispatchEvent({ type: 'loadedmetadata' });
  assert.equal(p.audio, f.outgoing.audio);
  assert.equal(p.audio.currentTime, 199.61);
  assert.equal(positionWrites, 0, 'pause cleanup never seeks the outgoing song');
  assert.equal(p.audio.paused, true);
  assert.equal(timeEvents.at(-1), 199.61, 'the UI receives the restored deck position together with its track');
  p.play();
  assert.equal(p.audio.currentTime, 199.61);
});

test('an obsolete metadata callback cannot restore a seek on a reused deck of the same track', t => {
  const { p, f } = fixture(t);
  p.fading = null;
  p.attach({ url: 'test:old' }, false, 20, f.outgoing, f.from);
  const oldSeek = f.outgoing.metadataSeek;
  p.releaseDeck(f.outgoing);
  p.attach({ url: 'test:new' }, false, 0, f.outgoing, f.from);
  f.outgoing.audio.currentTime = 199.61;
  oldSeek();
  assert.equal(f.outgoing.audio.currentTime, 199.61);
});

test('a delayed HLS recovery uses the paused position and cannot restore a seek after source reuse', async t => {
  const { p, f } = fixture(t);
  p.fading = null;
  const instances = [];
  class Hls {
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' };
    static ErrorTypes = { NETWORK_ERROR: 'network' };
    static isSupported = () => true;
    handlers = new Map();
    constructor() { instances.push(this); }
    on(event, callback) { this.handlers.set(event, callback); }
    loadSource() {} attachMedia() {} destroy() {}
  }
  const previous = window.Hls;
  window.Hls = Hls;
  t.after(() => { if (previous) window.Hls = previous; else delete window.Hls; });
  let resolve;
  const fresh = { ...f.to, media: { transcodings: [{ url: 'test:resolve', format: { protocol: 'hls' } }] } };
  t.mock.method(window.native, 'api', ({ resource }) => resource.startsWith('tracks/') ?
    Promise.resolve({ ok: true, data: fresh }) : new Promise(done => { resolve = done; }));
  const stream = { protocol: 'hls', url: 'test:hls' };
  p.attach(stream, true, 0, f.incoming, f.to);
  f.incoming.audio.currentTime = 100;
  instances[0].handlers.get('error')(null, { fatal: true, type: 'network' });
  f.incoming.audio.currentTime = 110.7;
  f.incoming.audio.pause();
  await new Promise(setImmediate);
  resolve({ ok: true, data: { url: stream.url } });
  await new Promise(setImmediate);
  f.incoming.audio.currentTime = 0;
  f.incoming.audio.dispatchEvent({ type: 'loadedmetadata' });
  instances[1].handlers.get('manifest')();
  assert.equal(f.incoming.audio.currentTime, 110.7);
  assert.equal(f.incoming.audio.paused, true);
  instances[1].handlers.get('error')(null, { fatal: true, type: 'network' });
  await new Promise(setImmediate);
  p.releaseDeck(f.incoming);
  p.attach({ url: 'test:replacement' }, false, 0, f.incoming, f.to);
  f.incoming.audio.currentTime = 199.61;
  resolve({ ok: true, data: { url: stream.url } });
  await new Promise(setImmediate);
  f.incoming.audio.dispatchEvent({ type: 'loadedmetadata' });
  instances[1].handlers.get('manifest')();
  assert.equal(f.incoming.audio.currentTime, 199.61);
  assert.equal(f.incoming.audio.paused, true);
});

for (const genre of [undefined, 'Drum & Bass']) {
  test(`fresh outgoing half-time readings respect memory${genre ? ' and genre' : ' over service metadata'}`, t => {
    const { p, f } = fixture(t);
    p.fading = null; p.active = 0; p.index = 0;
    Object.assign(f.from, { title: 'Ray Keith - Renegade', bpm: 87.3, genre });
    const grid = { bpm: 174.7, period: 60 / 174.7, offset: 0.1, downbeat: 32, confidence: 0.9 };
    mixmemory.learn(f.from.id, { grid });
    const half = { ...grid, bpm: 87.35, period: 60 / 87.35, from: 160, to: 180 };
    t.mock.method(p.beats, 'grid', () => half);
    f.outgoing.audio.currentTime = 175;
    const plan = p.planMix(f.outgoing.audio, 201);
    assert.ok(Math.abs(plan.grid.bpm - 174.7) < 0.01);
    assert.equal(plan.grid.to, 180, 'the plan still describes the fresh reading');
    assert.ok(p.mixLog.some(l => /174.7 BPM heard just now/.test(l.text)));
    const w = p.dropWindow(plan.grid, { time: 92 }, { ratio: 1 }, {});
    assert.ok(Math.abs((w.cut - w.build) - 32 * 60 / 174.7) < 1e-6, '32 beats take eleven seconds');
    p.mixPlan = { ...plan, grid: half };
    assert.ok(p.planMix(f.outgoing.audio, 201).grid.bpm > 174, 'cached half-time plans are repaired too');
  });
}
