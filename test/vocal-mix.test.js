// Auto mix keeping two singers apart, looping the last clean bars and echoing out of a song that has no outro:
// the player's planning and the carrying out of the plan (vocals.js, endings.js, barloop.js, echoout.js).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import { singing, SAMPLE_RATE, FFT } from './helpers/vocal-spectra.js';
import * as mixmemory from '../src/js/mixmemory.js';
import * as mixlearn from '../src/js/mixlearn.js';
import { echoPlan } from '../src/js/endings.js';

installBrowser();
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings } = await import('../src/js/store.js');
const cues = await import('../src/js/cues.js');
startup.mock.restore();

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const grid = (bpm = 175, extra = {}) => ({ bpm, period: 60 / bpm, offset: 0.1, downbeat: 0.1 + 8 * 60 / bpm, confidence: 0.9, phrase: true, ...extra });
const DUR = 201;

// vocal summaries by 2 s slot: the last minute of a 201 s song starts at 140 s
const outroString = (until) => Array.from({ length: 31 }, (_, i) => (140 + 2 * i < until ? '8' : '0')).join('');
const outro = (until) => ({ intro: '0'.repeat(30), outro: outroString(until), outroFrom: 140 });
const singsFrom = (seconds) => ({ intro: '0'.repeat(seconds / 2) + '8'.repeat(15 - seconds / 2) + '0'.repeat(15), outro: '-'.repeat(32), outroFrom: 0 });

function fixture(t, { bpm = 175, downbeat = true, out = null, into = null, outroStart = null, canEcho = false, short = false, hls = false, inGrid = true } = {}) {
  let id = 0;
  const timers = new Map(), calls = [];
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal';
  settings.autoMix = true; settings.transitionStyle = 'blend';
  const p = new player.constructor();
  t.after(() => { p.fading?.looper?.stop(); p.fading = null; p.lock = null; p.tempoRelease = null; });
  cues._reset(); mixmemory.reset(); mixlearn.reset();
  // a learned preference for short blends makes the planned mix too short to ride when the drums stop early
  if (short) for (let i = 0; i < 12; i++) mixlearn.record({ bucket: 'faster', style: 'blend', base: { length: 1, dj: 1, stretch: 0.08 }, params: { length: 0.5, dj: 1, stretch: 0.08 } }, 'good');
  const from = { id: 31, title: 'Outgoing', duration: DUR * 1000 };
  const to = { id: 32, title: 'Incoming', duration: DUR * 1000 };
  p.queue = [from, to]; p.index = 0; p.active = 0; p.loadId = 2;
  const [outgoing, incoming] = p.decks;
  for (const deck of p.decks) {
    Object.assign(deck.audio, { readyState: 4, paused: false, seeking: false, duration: DUR, playbackRate: 1, currentTime: 0,
      buffered: { length: 1, start: () => 0, end: () => DUR },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}, load() {} });
  }
  outgoing.track = from; incoming.track = to;
  if (hls) outgoing.hls = {};
  const echoes = [];
  p.beats.norm = p.normalizer = { ctx: { currentTime: 10, sampleRate: SAMPLE_RATE }, canEcho,
    addDeck: () => true, startDropCut() { return true; }, clearDropCut() {},
    startEchoOut(a, b, schedule) { echoes.push({ a, b, schedule }); return !this.refuseEcho; }, clearEchoOut(audio) { calls.push(['clearEcho', audio]); },
    setFade() {}, fadeDeck(...a) { calls.push(['fade', ...a]); }, holdBass(...a) { calls.push(['hold', ...a]); },
    swapBass(...a) { calls.push(['swap', ...a]); }, setActive() {}, startTrack() {}, holdFade() {}, setEqualizer() {},
    beatEnergy: () => ({ low: 0.3, high: 0.1, full: 0.2 }),
    spectrum: () => null };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  t.mock.method(p, 'notify', () => {});
  const g = grid(bpm);
  mixmemory.learn(from.id, { grid: { ...g, downbeat: downbeat ? g.downbeat : undefined }, vocals: out || undefined, outroStart: outroStart ?? undefined });
  if (inGrid) mixmemory.learn(to.id, { grid: g, vocals: into || undefined });
  else mixmemory.learn(to.id, { vocals: into || undefined });
  return { p, from, to, outgoing, incoming, calls, timers, echoes, g };
}
const prepare = (p, to, incoming, gridIn, extra = {}) => p.prepared = { loadId: p.loadId, from: 0, auto: true, track: to, stream: { track: {} },
  preroll: { deck: incoming, track: to, done: true, grid: gridIn, startAt: 0, ...extra }, wrap: false };
const texts = (p) => p.mixLog.map(e => e.text);

// ---- two singers at once ---------------------------------------------------------------------------------------------

test('when both songs sing in the planned blend, the plan starts later on a phrase line so only one sings at a time, and logs it', t => {
  const control = fixture(t);
  control.p.audio.currentTime = 170;
  const normal = control.p.planMix(control.outgoing.audio, DUR);
  assert.equal(normal.bars, 16);
  assert.equal(normal.vocals, null, 'no vocal knowledge: nothing changes');
  // the outgoing song sings for ten seconds into the blend; the incoming one sings from its second second
  const { p, to, incoming, outgoing } = fixture(t, { out: outro(normal.at + 10), into: singsFrom(2) });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.bars, 8, 'a shorter phrase fits after the vocals');
  const bar = 4 * 60 / 175;
  near(plan.at, normal.at + 8 * bar, 1e-3); // the memory rounds the grid to a millisecond
  assert.ok(plan.at >= normal.at + 10 - 3 - 2, 'after the outgoing vocals');
  assert.ok(plan.span >= 8 * bar - 1e-3 && plan.span < normal.span, 'at least eight bars');
  assert.ok(plan.at + plan.span <= DUR - 0.3 + 1e-6);
  assert.ok(plan.vocals.shift > 10);
  assert.equal(plan.vocals.hold, undefined);
  assert.equal(texts(p).filter(x => /vocals: waited for the outgoing vocals to end/.test(x)).length, 1);
  assert.equal(p.planMix(outgoing.audio, DUR), plan, 'the plan stays put (and the line is not repeated)');
  assert.equal(texts(p).filter(x => /vocals:/.test(x)).length, 1);
  // the mix really starts on the shifted line
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = plan.at - 5;
  p.checkCrossfade();
  assert.equal(p.fading, null, 'not before the shifted line');
  p.audio.currentTime = plan.at + 0.05;
  p.checkCrossfade();
  assert.ok(p.fading);
  near(p.fading.seconds, plan.span, 1e-6);
  assert.equal(p.fading.bassOpts.midHold, undefined, 'no deeper hold needed when the timing moved');
});

test('when the blend cannot move without getting too short, the incoming mids are held down until the outgoing vocals end', t => {
  const control = fixture(t);
  control.p.audio.currentTime = 170;
  const normal = control.p.planMix(control.outgoing.audio, DUR);
  const { p, to, incoming, outgoing, calls } = fixture(t, { out: outro(DUR), into: singsFrom(2) });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.at, normal.at, 'the timing is kept');
  assert.equal(plan.span, normal.span);
  assert.equal(plan.vocals.hold.depth, -12);
  assert.ok(plan.vocals.hold.until > 0.3 && plan.vocals.hold.until <= 0.9);
  assert.ok(texts(p).some(x => /vocals: both songs sing here, holding the incoming mids down/.test(x)));
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = plan.at + 0.05;
  p.checkCrossfade();
  assert.deepEqual(p.fading.bassOpts.midHold, plan.vocals.hold);
  assert.ok(p.fading.bassOpts.eq >= 0);
  assert.match(p.mixLog[0].text, /incoming mids held down for the outgoing vocals/);
  p.beginFade();
  const swap = calls.filter(c => c[0] === 'swap');
  assert.equal(swap.length, 2);
  assert.ok(swap.every(c => c[6].midHold === plan.vocals.hold), 'the EQ move carries the hold');
});

test('nothing changes when either song\'s singing is unknown, the last minute was not heard to the end, or there is no clash', t => {
  const control = fixture(t);
  control.p.audio.currentTime = 170;
  const normal = control.p.planMix(control.outgoing.audio, DUR);
  const same = (plan) => { assert.equal(plan.at, normal.at); assert.equal(plan.span, normal.span); assert.equal(plan.vocals, null); };
  for (const options of [
    { out: outro(normal.at + 10) },                                          // the incoming song was never heard
    { into: singsFrom(2) },                                                  // the outgoing song's end was never heard
    { out: { ...outro(normal.at + 10), outro: '8'.repeat(10) }, into: singsFrom(2) }, // heard only to 160 s
    { out: outro(normal.at - 5), into: singsFrom(2) },                       // the outgoing vocals are over before the blend
    { out: outro(normal.at + 10), into: singsFrom(20) },                     // the incoming song waits 20 s to sing
    { out: outro(normal.at + 10), into: { intro: '0'.repeat(30), outro: '-'.repeat(32), outroFrom: 0 } } // no vocals in the intro
  ]) {
    const { p, outgoing } = fixture(t, options);
    p.audio.currentTime = 170;
    same(p.planMix(outgoing.audio, DUR));
    assert.ok(!texts(p).some(x => /vocals:/.test(x)));
  }
});

test('singing heard while pre-playing the next song re-checks the plan in place, keeping its timing and style', t => {
  const control = fixture(t);
  control.p.audio.currentTime = 170;
  const normal = control.p.planMix(control.outgoing.audio, DUR);
  const { p, to, incoming, outgoing } = fixture(t, { out: outro(normal.at + 10) });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.vocals, null, 'the incoming song is unknown');
  plan.style = 'blend';
  // the silent pre-play of its intro heard it singing straight away
  prepare(p, to, incoming, grid(175), { vocals: { summary: () => singsFrom(0) } });
  const again = p.planMix(outgoing.audio, DUR);
  assert.equal(again, plan, 'the same plan object, changed in place');
  assert.equal(again.style, 'blend');
  assert.equal(again.bars, 8);
  assert.ok(again.at > normal.at);
  assert.ok(again.vocals.shift > 0);
  assert.equal(texts(p).filter(x => /waited for the outgoing vocals/.test(x)).length, 1);
  // knowledge that changes back (the pre-play is dropped) restores the original timing
  p.prepared = null;
  const restored = p.planMix(outgoing.audio, DUR);
  assert.equal(restored.at, normal.at);
  assert.equal(restored.vocals, null);
});

test('a pair with its own mix points keeps them whatever the vocals say', t => {
  const { p, from, to, incoming } = fixture(t, { out: outro(DUR), into: singsFrom(2) });
  cues.setPair(from.id, to.id, { out: 150, in: 5 });
  p.audio.currentTime = 148;
  prepare(p, to, incoming, grid(175));
  p.checkCrossfade();
  assert.equal(p.mixAt.at, 150);
  assert.equal(p.mixPlan, null);
});

test('a song is listened to for its singing and remembers it: the first and last minute, in the song memory', t => {
  const { p, from, outgoing } = fixture(t);
  const sing = Array.from({ length: 40 }, (_, i) => singing(i));
  p.normalizer.spectrum = () => ({ db: sing[Math.round(outgoing.audio.currentTime / 0.06) % 40], sampleRate: SAMPLE_RATE, fftSize: FFT });
  t.mock.method(p.beats, 'grid', () => null);
  p.startListening(outgoing.audio, from);
  assert.ok(p.beats.vocals.has(outgoing.audio), 'the recorder rides on the beat watcher');
  assert.equal(mixmemory.get(from.id).vocals, null);
  const play = (a, b) => { for (let time = a; time < b; time += 0.04) { outgoing.audio.currentTime = time; p.beats.poll(); } };
  play(0, 40);
  assert.ok(p.vocalsOf(from).intro.includes('9'), 'known while the song is still playing');
  play(140, 200);
  p.stopListening(outgoing.audio);
  const stored = mixmemory.get(from.id).vocals;
  assert.equal(stored.start, 0 + stored.start);
  assert.ok(stored.start != null && stored.start <= 4, `sung from the start: ${stored.start}`);
  assert.ok(stored.end >= 196, `and to the end: ${stored.end}`);
  assert.equal(stored.outroFrom, 140);
});

// ---- songs with no outro: loop or echo ------------------------------------------------------------------------------

// 175 BPM without a known downbeat and a learned liking for short blends: the planned blend is 11 to 14 s, and the drums
// stop 5.9 s before the end, so under 8 s of it would have a beat
const ENDING = { downbeat: false, short: true, outroStart: DUR - 5.9, canEcho: true };

test('a song whose drums stop just before the end, with its last bars clean and the deck able to seek, loops them to make room', t => {
  const { p, to, incoming, outgoing, timers } = fixture(t, { ...ENDING, out: outro(100) });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.ending.kind, 'loop');
  const { at, b, n, loops, bar } = plan.ending.plan;
  const baseline = { seeked: outgoing.audio.listenerCount('seeked'), seeking: outgoing.audio.listenerCount('seeking') }; // the player's own
  assert.equal(plan.at, at);
  near(plan.span, plan.ending.plan.bars * bar, 1e-9);
  assert.ok(plan.span >= 8 * bar - 1e-3, 'a normal blend length');
  assert.ok(b <= DUR - 0.5 && b <= DUR - 5.9 + 1e-9, 'before the drums stop');
  near(b - at, n * bar, 1e-9);
  near(((at - 0.1) / bar) % 1 + (((at - 0.1) / bar) % 1 > 0.5 ? -1 : 0) + 0, 0, 1e-6); // on the bar lattice of its grid
  assert.ok(texts(p).some(x => /beat stops before the end of "Outgoing": a loop of its last bars will make room/.test(x)));
  assert.equal(p.planMix(outgoing.audio, DUR), plan);
  // the blend starts at the loop's first bar
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = at + 0.05;
  p.checkCrossfade();
  const f = p.fading;
  assert.ok(f?.looper, 'the loop is running');
  near(f.seconds, plan.span, 1e-9);
  assert.ok(f.bass, 'a normal blend with the bass swap');
  assert.match(p.mixLog[0].text, /looped the last 2 bars to make room for the blend/);
  assert.equal(outgoing.audio.listenerCount('seeked'), baseline.seeked + 1);
  // the outgoing deck is seeked back on the bar line, as many times as planned
  const seekTargets = [];
  for (let i = 0; i < loops; i++) {
    outgoing.audio.currentTime = b - 0.03; // just past the early trigger (the seek gap is assumed 40 ms)
    timers.get(f.looper.timer)();
    seekTargets.push(outgoing.audio.currentTime);
    outgoing.audio.dispatchEvent({ type: 'seeked' });
  }
  assert.ok(seekTargets.every(x => x >= at - 0.01 && x <= at + 0.1), `back at the loop start: ${seekTargets}`);
  assert.equal(f.looper.passes, loops);
  // the mix ends: the looper is gone and the deck's listeners with it
  p.finishFade(f);
  assert.equal(f.looper, null);
  assert.equal(outgoing.audio.listenerCount('seeked'), baseline.seeked);
  assert.equal(outgoing.audio.listenerCount('seeking'), baseline.seeking);
});

test('a loop that goes wrong, a seek by the listener, or a skip stops it and the mix finishes over what is really left', t => {
  const run = () => {
    const x = fixture(t, { ...ENDING, out: outro(100) });
    x.p.audio.currentTime = 170;
    const plan = x.p.planMix(x.outgoing.audio, DUR);
    prepare(x.p, x.to, x.incoming, grid(175));
    x.p.audio.currentTime = plan.at + 0.05;
    x.p.checkCrossfade();
    x.plan = plan;
    x.seeking = x.outgoing.audio.listenerCount('seeking') - 1; // the player's own, without the looper's
    return x;
  };
  // the song is moved under the loop
  const a = run();
  a.p.beginFade();
  const fadesBefore = a.calls.filter(c => c[0] === 'fade').length;
  const before = a.p.fading.seconds;
  a.outgoing.audio.currentTime = a.plan.ending.plan.b - 3;
  a.outgoing.audio.dispatchEvent({ type: 'seeking' });
  assert.equal(a.p.fading.looper, null);
  assert.match(a.p.mixLog[0].text, /Loop stopped \(the song was moved\): finishing with a normal blend/);
  assert.ok(a.p.fading.seconds < before, 'the blend is re-timed to the rest of the song');
  assert.ok(a.p.fading.startedAt !== null, 'and carries on');
  assert.ok(a.calls.filter(c => c[0] === 'fade').length > fadesBefore, 'the fades were programmed again from where they were');
  // before the blend's audio has started (still waiting for the incoming song to play), the length simply shrinks
  const b = run();
  const early = b.p.fading.seconds;
  b.outgoing.audio.currentTime = b.plan.ending.plan.at + 1;
  b.outgoing.audio.dispatchEvent({ type: 'seeking' });
  assert.equal(b.p.fading.looper, null);
  assert.ok(b.p.fading.seconds < early);
  // the listener seeks the playing (incoming) song
  const c = run();
  c.p.seek(30);
  assert.equal(c.p.fading.looper, null);
  assert.match(c.p.mixLog[0].text, /you moved the playhead/);
  assert.ok(c.p.fading, 'the mix itself carries on');
  // a skip ends the whole mix and the loop with it
  const d = run();
  const looper = d.p.fading.looper;
  d.p.cutFade();
  assert.equal(d.p.fading, null);
  assert.equal(looper.finished, true);
  assert.equal(d.outgoing.audio.listenerCount('seeking'), d.seeking);
  // a slow seek stops it through the player too
  const e = run();
  e.p.fading.looper.abort('seeking is slow here (300 ms)');
  assert.equal(e.p.fading.looper, null);
  assert.match(e.p.mixLog[0].text, /seeking is slow here/);
});

test('with no clean bar, an HLS deck, or an unbuffered region the song gets an echo-out instead; with no effects, today\'s plan', t => {
  const base = fixture(t, { ...ENDING });
  base.p.audio.currentTime = 170;
  const echo = base.p.planMix(base.outgoing.audio, DUR);
  assert.equal(echo.ending.kind, 'echo-out', 'last bars unknown: no loop');
  // the echo sits where the drums are still playing (before the remembered ending), not on the last bar of the media
  const expected = echoPlan({ grid: echo.grid, dur: DUR, now: 170, outroStart: ENDING.outroStart });
  assert.equal(echo.at, expected.at);
  assert.ok(echo.at + echo.grid.period <= ENDING.outroStart);
  near(echo.span, expected.span, 1e-9);
  assert.ok(texts(base.p).some(x => /echo-out \(song ends abruptly\)/.test(x)));
  // a vocal in the last bars and an HLS deck, or an unbuffered one, also end up here
  const vocal = fixture(t, { ...ENDING, out: outro(DUR) });
  vocal.p.audio.currentTime = 170;
  assert.equal(vocal.p.planMix(vocal.outgoing.audio, DUR).ending.kind, 'echo-out');
  const hls = fixture(t, { ...ENDING, out: outro(100), hls: true });
  hls.p.audio.currentTime = 170;
  assert.equal(hls.p.planMix(hls.outgoing.audio, DUR).ending.kind, 'echo-out');
  const slow = fixture(t, { ...ENDING, out: outro(100) });
  slow.outgoing.audio.buffered = { length: 1, start: () => 0, end: () => 150 };
  slow.p.audio.currentTime = 170;
  assert.equal(slow.p.planMix(slow.outgoing.audio, DUR).ending.kind, 'echo-out');
  // no delay node (the Web Audio graph has no effects): the plan the player had, unchanged
  const bare = fixture(t, { ...ENDING, canEcho: false, out: outro(100), hls: true });
  bare.p.audio.currentTime = 170;
  const plain = bare.p.planMix(bare.outgoing.audio, DUR);
  assert.equal(plain.ending.kind, 'fallback');
  assert.equal(plain.at, null);
  near(plain.span, plain.base.span);
  assert.ok(!texts(bare.p).some(x => /echo-out|loop of its last/.test(x)));
});

test('an ordinary song (beat to the end, a long outro, or no beat to count) is planned exactly as before', t => {
  for (const options of [{}, { outroStart: 150 }, { downbeat: false }, { downbeat: false, short: true }]) {
    const { p, outgoing } = fixture(t, { ...options, canEcho: true, out: outro(100), into: singsFrom(20) });
    p.audio.currentTime = 170;
    const plan = p.planMix(outgoing.audio, DUR);
    assert.ok(['blend', 'fallback'].includes(plan.ending.kind), JSON.stringify(options));
    assert.equal(plan.vocals, null);
  }
});

test('an echo-out starts on the next beat line: dry cut over one beat, a 3/4 beat echo with a short tail, the next song in with its bass', t => {
  const { p, to, incoming, outgoing, calls, echoes, g, timers } = fixture(t, ENDING);
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.ending.kind, 'echo-out');
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = plan.at + 0.05;
  p.checkCrossfade();
  const f = p.fading;
  assert.equal(f.variant, 'echo-out');
  assert.equal(f.bass, false, 'the next song comes in with its bass: no bass swap');
  assert.equal(f.style, 'blend');
  assert.match(p.mixLog[0].text, /echo-out \(song ends abruptly\)/);
  assert.equal(echoes.length, 0, 'the graph starts when the next song is playing');
  p.beginFade();
  assert.equal(echoes.length, 1);
  const { a, b, schedule } = echoes[0];
  assert.equal(a, outgoing.audio);
  assert.equal(b, incoming.audio);
  const beat = 60 / g.bpm;
  near(schedule.beat, beat, 1e-4);
  near(schedule.delay, 0.75 * beat, 1e-4);
  assert.ok(schedule.start > 10 + 0.1 && schedule.start <= 10 + 0.15 + beat + 1e-9, `on the next beat: ${schedule.start - 10} s ahead`);
  near(schedule.end - schedule.start, beat + 2 * 4 * beat + 0.4, 1e-3);
  assert.ok(schedule.feedback >= 0.5 && schedule.feedback <= 0.6);
  assert.equal(f.echoScheduled, true);
  assert.ok(p.mixLog.some(e => /Echo-out: 3\/4-beat echo, 2 bar tail/.test(e.text)));
  assert.ok(!calls.some(c => c[0] === 'swap' || c[0] === 'fade'), 'the graph owns the fades');
  p.beginFade();
  assert.equal(echoes.length, 1, 'only once');
  // the timer ends it and takes the graph away
  const finish = [...timers.values()].at(-1);
  finish();
  assert.equal(p.fading, null);
  assert.ok(calls.some(c => c[0] === 'clearEcho' && c[1] === outgoing.audio));
});

test('pausing, seeking or a speed change during an echo-out ends it cleanly: the next song carries on', t => {
  const run = () => {
    const x = fixture(t, ENDING);
    x.p.audio.currentTime = 170;
    const plan = x.p.planMix(x.outgoing.audio, DUR);
    prepare(x.p, x.to, x.incoming, grid(175));
    x.p.audio.currentTime = plan.at + 0.05;
    x.p.checkCrossfade();
    x.p.beginFade();
    assert.equal(x.p.fading.echoScheduled, true);
    return x;
  };
  const a = run();
  a.p.pause();
  assert.equal(a.p.fading, null);
  assert.ok(a.calls.some(c => c[0] === 'clearEcho'));
  assert.equal(a.p.audio.paused, true);
  const b = run();
  b.p.seek(40);
  assert.equal(b.p.fading, null);
  assert.ok(b.calls.some(c => c[0] === 'clearEcho'));
  const c = run();
  c.p.syncSpeed();
  settings.speedMode = 'nightcore';
  c.p.syncSpeed();
  settings.speedMode = 'normal';
  assert.equal(c.p.fading, null);
  const d = run();
  d.incoming.audio.dispatchEvent({ type: 'seeking' });
  assert.equal(d.p.fading, null);
  // a skip (load) ends it too
  const e = run();
  e.p.cutFade();
  assert.equal(e.p.fading, null);
  assert.ok(e.calls.filter(x => x[0] === 'clearEcho').length >= 1);
});

test('an echo-out that the graph cannot build, or a next song that is not beat-matched, becomes a plain blend', t => {
  const refused = fixture(t, ENDING);
  refused.p.normalizer.refuseEcho = true;
  refused.p.audio.currentTime = 170;
  const plan = refused.p.planMix(refused.outgoing.audio, DUR);
  prepare(refused.p, refused.to, refused.incoming, grid(175));
  refused.p.audio.currentTime = plan.at + 0.05;
  refused.p.checkCrossfade();
  refused.p.beginFade();
  assert.equal(refused.p.fading.variant, null);
  assert.ok(refused.p.mixLog.some(e => /Echo-out unavailable/.test(e.text)));
  assert.ok(refused.calls.some(c => c[0] === 'fade'), 'the ordinary fade runs');
  // no grid for the next song at all: the plan is not carried out
  const loose = fixture(t, { ...ENDING, inGrid: false });
  loose.p.audio.currentTime = 170;
  const plan2 = loose.p.planMix(loose.outgoing.audio, DUR);
  assert.equal(plan2.ending.kind, 'echo-out');
  prepare(loose.p, loose.to, loose.incoming, null);
  loose.p.audio.currentTime = plan2.at + 0.05;
  loose.p.checkCrossfade();
  assert.ok(loose.p.fading);
  assert.equal(loose.p.fading.variant, null);
  assert.ok(loose.p.mixLog.some(e => /Echo-out skipped \(the next song is not beat-matched\)/.test(e.text)));
  assert.equal(loose.echoes.length, 0);
});

test('Auto mix\'s live status reports the ending and the vocal handling of the plan', t => {
  const { p, to, incoming, outgoing } = fixture(t, { ...ENDING, out: outro(100) });
  p.audio.currentTime = 170;
  p.planMix(outgoing.audio, DUR);
  const status = p.autoMixStatus();
  assert.equal(status.plan.ending.kind, 'loop');
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = status.plan.at + 0.05;
  p.checkCrossfade();
  const mix = p.autoMixStatus().mix;
  assert.equal(mix.looping, true);
  assert.equal(mix.variant, null);
});

test('a rejected echo-out or loop goes back to the plain blend\'s own start time, not the later special one', t => {
  const { p, to, incoming, outgoing } = fixture(t, { ...ENDING, inGrid: false });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.ending.kind, 'echo-out');
  const fallbackAt = plan.base.at ?? DUR - plan.base.span;
  assert.ok(fallbackAt < plan.at - 3, 'the special ending is much later than the plain blend');
  // the next song has no beat to match: found out before the plain blend must start, and the blend keeps its length
  prepare(p, to, incoming, null);
  p.audio.currentTime = fallbackAt - 4;
  p.checkCrossfade();
  assert.equal(p.fading, null);
  assert.equal(plan.ending.kind, 'fallback');
  assert.equal(plan.span, plan.base.span);
  assert.ok(texts(p).some(x => /Echo-out skipped \(the next song is not beat-matched\): normal blend/.test(x)));
  p.audio.currentTime = fallbackAt + 0.05;
  p.checkCrossfade();
  assert.ok(p.fading, 'the plain blend starts at its own time');
  assert.ok(p.fading.seconds > 8, `not squeezed into the end of the song: ${p.fading.seconds}`);
  near(p.fading.seconds, plan.base.span, 0.1); // (the blend is clipped to what is left of the song)
});

test('an echo-out that can be done keeps its own time, and the next song is prepared early enough for the plain blend too', t => {
  const { p, to, incoming, outgoing } = fixture(t, { ...ENDING, canEcho: true });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  assert.equal(plan.ending.kind, 'echo-out');
  const fallbackAt = plan.base.at ?? DUR - plan.base.span;
  // nothing prepared yet: the look-ahead starts from the plain blend's time, which comes first
  p.prepared = { loadId: p.loadId, from: 0, auto: true, track: to, stream: { track: {} }, preroll: null, wrap: false };
  let started = 0;
  t.mock.method(p, 'preroll', () => { started++; });
  p.audio.currentTime = fallbackAt - 10;
  p.checkCrossfade();
  assert.equal(started, 1, 'the next song is listened to for the earlier of the two start times');
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = fallbackAt + 0.05;
  p.checkCrossfade();
  assert.equal(p.fading, null, 'the echo-out waits for its own time');
  assert.equal(plan.ending.kind, 'echo-out');
  p.audio.currentTime = plan.at + 0.05;
  p.checkCrossfade();
  assert.ok(p.fading);
});

test('changing the speed during a loop re-times the rest of the blend at the new speed', t => {
  const { p, to, incoming, outgoing, g } = fixture(t, { ...ENDING, out: outro(100) });
  p.audio.currentTime = 170;
  const plan = p.planMix(outgoing.audio, DUR);
  prepare(p, to, incoming, grid(175));
  p.audio.currentTime = plan.at + 0.05;
  p.checkCrossfade();
  const f = p.fading;
  assert.ok(f?.looper);
  p.beginFade();
  outgoing.audio.currentTime = plan.ending.plan.at + 1;
  const left = DUR - outgoing.audio.currentTime;
  assert.ok(g);
  settings.speedMode = 'custom'; settings.playbackSpeed = 2; settings.keepPitch = true;
  t.after(() => { settings.speedMode = 'normal'; });
  p.syncSpeed();
  assert.equal(f.looper, null, 'the loop is stopped');
  assert.equal(outgoing.audio.playbackRate, 2);
  near(f.seconds, left / 2, 1e-6, 'the fade covers what is left at 2x, not at 1x');
});
