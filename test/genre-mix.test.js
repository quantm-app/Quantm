import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings } = await import('../src/js/store.js');
const mixmemory = await import('../src/js/mixmemory.js');
const mixlearn = await import('../src/js/mixlearn.js');
const cues = await import('../src/js/cues.js');
startup.mock.restore();

const close = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const grid = (bpm = 90) => ({ bpm, period: 60 / bpm, offset: 0, downbeat: 0, confidence: 0.9 });

function fixture(t, { fromGenre = 'Hip-hop', toGenre = 'Hip-hop' } = {}) {
  const timers = new Map();
  let id = 0;
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal';
  settings.autoMix = true; settings.transitionStyle = 'auto';
  const p = new player.constructor();
  t.after(() => { p.fading = null; p.lock = null; p.tempoRelease = null; settings.transitionStyle = 'blend'; });
  cues._reset(); mixmemory.reset(); mixlearn.reset();
  const from = { id: 31, title: 'Outgoing', duration: 201000, genre: fromGenre };
  const to = { id: 32, title: 'Incoming', duration: 201000, genre: toGenre };
  p.queue = [from, to]; p.index = 0; p.active = 0; p.loadId = 2;
  const [outgoing, incoming] = p.decks;
  for (const deck of p.decks) {
    Object.assign(deck.audio, { readyState: 4, paused: false, seeking: false, duration: 201, playbackRate: 1, currentTime: 0,
      buffered: { length: 1, start: () => 0, end: () => 201 },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}, load() {} });
  }
  outgoing.track = from; incoming.track = to;
  const calls = [];
  p.normalizer = { ctx: { currentTime: 10 }, effect: false,
    addDeck: () => true, startDropCut(a, b, schedule) { calls.push(['schedule', schedule]); return true; }, clearDropCut() {}, clearEchoOut() {},
    setFade() {}, fadeDeck(...a) { calls.push(['fade', ...a]); }, holdBass(...a) { calls.push(['hold', ...a]); },
    swapBass(...a) { calls.push(['swap', ...a]); }, setActive() {}, startTrack() {}, holdFade() {}, setEqualizer() {},
    sweepLowpass(...a) { calls.push(['sweep', ...a]); }, holdLowpass(...a) { calls.push(['holdLowpass', ...a]); },
    clearLowpass(...a) { calls.push(['clearLowpass', ...a]); } };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  t.mock.method(p, 'startListening', () => {});
  t.mock.method(p, 'notify', () => {});
  t.mock.method(p.beats, 'grid', () => null);
  return { p, from, to, outgoing, incoming, calls, timers };
}

function prepare(p, from, to, incoming, extra = {}, bpm = 90) {
  mixmemory.learn(from.id, { grid: grid(bpm) });
  return p.prepared = { loadId: p.loadId, from: 0, auto: true, track: to, stream: { track: {} },
    preroll: { deck: incoming, track: to, done: true, grid: grid(bpm), startAt: 0, ...extra } };
}

test('Auto cuts hip-hop on the downbeat: a one-bar cut schedule that lands on the next song\'s downbeat', t => {
  const { p, from, to, incoming, outgoing, calls } = fixture(t);
  assert.equal(p.mixFamily(from), 'hiphop');
  const g = grid(90);
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('hiphop:slow', () => 0.5) };
  const prep = prepare(p, from, to, incoming);
  const selected = p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g);
  assert.equal(selected.style, 'dropcut');
  assert.equal(selected.genre, 'quickcut');
  assert.equal(selected.learn, 'quickcut');
  assert.equal(selected.reason, 'hip-hop: quick cut on the downbeat');
  close(selected.window.cut - selected.window.build, 4 * g.period, 1e-6);
  assert.equal(selected.window.cut % (4 * g.period) < 1e-6 || 4 * g.period - (selected.window.cut % (4 * g.period)) < 1e-6, true, 'on an outgoing bar line');
  assert.equal(selected.drop.time % (4 * g.period) < 1e-6 || 4 * g.period - (selected.drop.time % (4 * g.period)) < 1e-6, true, 'on an incoming downbeat');
  assert.equal(selected.quick.options.echo, false, 'no singing known: no echo tail');
  // launching it
  outgoing.audio.currentTime = selected.window.build - selected.window.lead;
  p.startCrossfade();
  const f = p.fading;
  assert.equal(f.style, 'dropcut');
  assert.equal(f.genre, 'quickcut');
  assert.equal(p.mixOutcome.choice.style, 'quickcut', 'thumbs and kept songs are tallied under quick cut');
  assert.match(p.mixLog.find(e => e.kind === 'plan').text, /^Planning a quick cut… "Incoming": hip-hop: quick cut on the downbeat/);
  incoming.audio.currentTime = f.dropcut.drop.time - (f.dropcut.window.cut - outgoing.audio.currentTime);
  f.armDeadline = performance.now() + 1e6;
  p.beginDropCut(f);
  assert.equal(f.dropScheduled, true);
  const schedule = calls.find(c => c[0] === 'schedule')[1];
  close(schedule.cut, schedule.drop - 0.04, 1e-6);
  close(schedule.drop - schedule.start, 4 * g.period, 1e-6);
  assert.equal(schedule.stages.length, 0, 'no loop roll');
  assert.equal(schedule.kill.style, 'none');
  assert.equal(p.autoMixStatus().mix.genre, 'quickcut');
  assert.match(p.mixLog.find(e => /^Quick cut into/.test(e.text)).text, /^Quick cut into "Incoming": hip-hop: quick cut on the downbeat/);
});

test('a quick cut keeps a short echo tail when the outgoing song is still singing at the cut', t => {
  const { p, from, to, incoming } = fixture(t);
  const g = grid(90);
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('hiphop:slow', () => 0.5) };
  const prep = prepare(p, from, to, incoming);
  const quiet = p.selectGenre(prep, cues.transitionFor(from.id, to.id), g);
  assert.equal(quiet.quick.options.echo, false);
  // the last minute was heard (singing through to the end)
  const outro = Array.from({ length: 31 }, () => '8').join('');
  t.mock.method(p, 'vocalsOf', () => ({ intro: '0'.repeat(30), outro, outroFrom: 140 }));
  const sung = p.selectGenre(prep, cues.transitionFor(from.id, to.id), g);
  assert.equal(sung.quick.options.echo, true);
  assert.equal(sung.reason, 'hip-hop: quick cut on the downbeat, short echo tail');
});

test('the quick cut waits for the next song, and falls back to the usual Auto choice when it cannot land', t => {
  const { p, from, to, incoming } = fixture(t);
  const g = grid(90);
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('hiphop:slow', () => 0.5) };
  const prep = prepare(p, from, to, incoming, { done: false });
  const early = p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g);
  assert.equal(early.style, 'blend', 'next song not ready: the usual Auto choice (a blend without a drop)');
  assert.equal(early.genre, undefined);
  prep.preroll.done = true;
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g).genre, 'quickcut');
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), null).genre, undefined, 'no outgoing beat to count bars on');
});

test('explicit styles, pair overrides, and custom mix points all win over genre transitions', t => {
  const { p, from, to, incoming } = fixture(t);
  const g = grid(90);
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('hiphop:slow', () => 0.5) };
  const prep = prepare(p, from, to, incoming);
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g).genre, 'quickcut');
  cues.setPair(from.id, to.id, { style: 'blend' });
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g).style, 'blend');
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g).genre, undefined);
  cues.setPair(from.id, to.id, { style: 'auto', in: 12 });
  assert.equal(p.selectGenre(prep, cues.transitionFor(from.id, to.id), g), null, 'a custom mix point wins');
  cues.setPair(from.id, to.id, null);
  settings.transitionStyle = 'blend';
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g).genre, undefined);
  settings.transitionStyle = 'dropcut';
  assert.equal(p.selectGenre(prep, cues.transitionFor(from.id, to.id), g), null, 'Drop cut is unchanged');
});

test('a slow mellow song is faded out through a low-pass, in a longer blend planned earlier than a normal one', t => {
  const { p, from, to, incoming, outgoing, calls } = fixture(t, { fromGenre: 'Deep House', toGenre: 'Deep House' });
  assert.equal(p.mixFamily(from), 'dance');
  const g = grid(120);
  mixmemory.learn(from.id, { grid: g });
  // 49.5 s left: a normal blend is not planned yet, a filter fade is
  p.audio.currentTime = 151.5; // 49.5 s left, and the 16-bar phrase line at 160 s is still ahead
  const plan = p.planMix(outgoing.audio, 201);
  assert.ok(plan.span > 24, `long blend, got ${plan.span}`);
  assert.ok(plan.span <= 36 + 1e-9);
  from.genre = 'House';
  p.mixPlan = null;
  p.mixFeatureCache.clear();
  assert.equal(p.planMix(outgoing.audio, 201).span, 0, 'an ordinary song at this tempo is not planned yet');
  from.genre = 'Deep House';
  p.mixFeatureCache.clear();
  p.mixPlan = plan;
  const prep = prepare(p, from, to, incoming, { grid: g }, 120);
  const selected = p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g);
  assert.deepEqual([selected.style, selected.genre, selected.filter], ['blend', 'filterfade', true]);
  assert.equal(selected.reason, 'filter fade (deep house)');
  outgoing.audio.currentTime = plan.at;
  p.startCrossfade();
  const f = p.fading;
  assert.equal(f.filter, true);
  assert.equal(f.genre, 'filterfade');
  assert.equal(p.mixOutcome.choice.style, 'filterfade');
  assert.match(p.mixLog.find(e => /Filter fade into/.test(e.text)).text, /Filter fade into "Incoming": filter fade \(deep house\)/);
  incoming.audio.dispatchEvent({ type: 'playing' });
  const sweep = calls.find(c => c[0] === 'sweep');
  assert.equal(sweep[1], outgoing.audio, 'the outgoing deck is low-passed');
  close(sweep[2], f.seconds, 1e-6);
  assert.equal(sweep[3], 0);
  assert.equal(p.autoMixStatus().mix.genre, 'filterfade');
  // pausing freezes it where it is; the end (or a skip) opens it again
  f.startedAt = 9;
  p.holdFade();
  assert.equal(calls.find(c => c[0] === 'holdLowpass')[1], outgoing.audio);
  p.cutFade();
  assert.equal(calls.some(c => c[0] === 'clearLowpass' && c[1] === outgoing.audio), true);
});

test('an ordinary blend never touches the low-pass', t => {
  const { p, from, to, incoming, outgoing, calls } = fixture(t, { fromGenre: 'Pop', toGenre: 'Pop' });
  const g = grid(100);
  mixmemory.learn(from.id, { grid: g });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, 201);
  const prep = prepare(p, from, to, incoming, { grid: g }, 100);
  p.mixPlan = plan;
  outgoing.audio.currentTime = plan.at ?? 201 - plan.span;
  const selected = p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g);
  assert.equal(selected.filter, undefined);
  p.startCrossfade();
  incoming.audio.dispatchEvent({ type: 'playing' });
  assert.equal(calls.some(c => /Lowpass/.test(c[0]) || c[0] === 'sweep'), false);
  p.cutFade();
  assert.equal(calls.some(c => c[0] === 'clearLowpass'), false);
});

function dropFixture(t, { dropOut = 120, dropIn = 40 } = {}) {
  const f = fixture(t, { fromGenre: 'Drum & Bass', toGenre: 'Drum and Bass' });
  const g = grid(174);
  mixmemory.learn(f.from.id, { grid: g, drop: { time: dropOut, confidence: 0.8 } });
  mixmemory.learn(f.to.id, { grid: g, drop: { time: dropIn, confidence: 0.8 } });
  const prep = f.p.prepared = { loadId: f.p.loadId, from: 0, auto: true, track: f.to, stream: { track: {} },
    preroll: { deck: f.incoming, track: f.to, done: true, grid: grid(174), drop: { time: dropIn, confidence: 0.8 }, dropGrid: grid(174), startAt: 0 } };
  return { ...f, g, prep };
}

test('a double drop lands the incoming drop on the outgoing drop, keeps both for 16 bars and swaps the bass after', t => {
  const { p, from, to, incoming, outgoing, g, prep, calls } = dropFixture(t);
  assert.equal(p.mixFamily(from), 'bass');
  const bar = 4 * g.period;
  p.audio.currentTime = 30;
  p.planDoubleDrop(outgoing.audio, 201);
  const plan = p.mixPlan;
  const dd = plan.doubleDrop;
  assert.ok(dd, p.mixLog.map(e => e.text).join('\n'));
  assert.equal(dd.trackId, to.id);
  close(dd.dropAt, 120, bar / 2 + 1e-6);
  close(dd.at, dd.dropAt - 4 * bar, 0.01); // the remembered grid is stored rounded
  assert.equal(dd.dropBars, 16);
  close(plan.span, 24 * bar, 0.01);
  assert.equal(plan.at, dd.at);
  assert.match(p.mixLog[0].text, /^Double drop into "Incoming": its drop at 0:40 will land on this song's drop at 2:00; both play for 16 bars/);
  assert.equal(prep.preroll.startAt, dd.startAt, 'the next song is wound back to the start of its build');
  close(incoming.audio.currentTime, dd.startAt, 1e-6);
  assert.equal(p.autoStartAt(to, 0), dd.startAt);
  p.planDoubleDrop(outgoing.audio, 201);
  assert.equal(p.mixPlan, plan, 'planned once');
  // the style choice and the launch
  const selected = p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), g);
  assert.deepEqual([selected.style, selected.genre, selected.doubleDrop], ['blend', 'doubledrop', true]);
  outgoing.audio.currentTime = dd.at + 0.1;
  p.startCrossfade();
  const f = p.fading;
  assert.equal(f.genre, 'doubledrop');
  close(f.seconds, plan.span, 1e-6);
  assert.deepEqual(f.shapeIn, { dj: 1, center: dd.center, inEnd: dd.inEnd });
  assert.deepEqual(f.bassOpts, { center: dd.center, corner: 90, eq: 0.5 });
  assert.equal(f.bass, true);
  assert.equal(p.mixOutcome.choice.style, 'doubledrop');
  // the drops meet: where the incoming song is when the outgoing song reaches its drop
  const ahead = dd.dropAt - outgoing.audio.currentTime;
  close(incoming.audio.currentTime + ahead * dd.ratio, 40, 0.06);
  assert.match(p.mixLog.find(e => /Double drop into/.test(e.text) && e.kind === 'mix').text, /^Double drop into "Incoming": double drop/);
  assert.ok(calls.some(c => c[0] === 'hold'));
});

test('a double drop is not planned without both confirmed drops, a bass pair, or room; and it lapses when its moment passes', t => {
  const { p, from, to, outgoing, prep } = dropFixture(t);
  // the next song's drop is only a candidate
  prep.preroll.candidate = { time: 40 };
  p.audio.currentTime = 30;
  p.planDoubleDrop(outgoing.audio, 201);
  assert.equal(p.mixPlan?.doubleDrop, undefined);
  delete prep.preroll.candidate;
  // a different genre pair
  to.genre = 'Pop';
  p.mixFeatureCache.clear();
  p.planDoubleDrop(outgoing.audio, 201);
  assert.equal(p.mixPlan?.doubleDrop, undefined);
  assert.equal(p.doubleDropTried, `${p.loadId}:${to.id}`, 'and not asked again for this pair');
  // an outgoing drop in the first half of the song: the song would be cut short
  to.genre = 'Drum and Bass';
  p.doubleDropTried = null;
  mixmemory.learn(from.id, { grid: grid(174), drop: { time: 60, confidence: 0.99 } });
  p.mixFeatureCache.clear();
  p.planDoubleDrop(outgoing.audio, 201);
  assert.equal(p.mixPlan?.doubleDrop, undefined);
  // the plan lapses once its moment has passed without the blend starting
  mixmemory.reset();
  mixmemory.learn(from.id, { grid: grid(174), drop: { time: 120, confidence: 0.8 } });
  mixmemory.learn(to.id, { grid: grid(174), drop: { time: 40, confidence: 0.8 } });
  p.mixFeatureCache.clear();
  p.doubleDropTried = null;
  p.planDoubleDrop(outgoing.audio, 201);
  const plan = p.mixPlan;
  assert.ok(plan?.doubleDrop);
  outgoing.audio.currentTime = plan.at + 5;
  p.planDoubleDrop(outgoing.audio, 201);
  assert.equal(p.mixPlan, null);
  assert.match(p.mixLog[0].text, /Double drop missed its moment/);
});

test('a double drop waits for the next song to be ready instead of starting without it', t => {
  const { p, from, to, incoming, outgoing, g, prep } = dropFixture(t);
  p.audio.currentTime = 30;
  p.planDoubleDrop(outgoing.audio, 201);
  const plan = p.mixPlan;
  prep.preroll.done = false;
  assert.equal(p.selectGenre(prep, cues.transitionFor(from.id, to.id), g), null);
  assert.ok(to && incoming && plan);
});
