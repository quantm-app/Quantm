import test from 'node:test';
import assert from 'node:assert/strict';
import { usableBlend, findCleanBar, loopPlanFor, echoPlan, chooseEnding } from '../src/js/endings.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const GRID = { period: 0.5, offset: 0, downbeat: 0, confidence: 0.9 }; // 120 BPM: 2 s bars
const clean = (n = 31) => '0'.repeat(n);
/** A last minute of a 200 s song (it starts at 140 s) with the given levels per 2 s slot */
const outro = (levels) => ({ intro: '0'.repeat(30), outro: levels.padEnd(32, '-'), outroFrom: 140 });

// ---- is there a blend to ride? --------------------------------------------------------------------------------------

test('a blend is usable unless the drums stop just before the end and too little of it has them', () => {
  const base = { dur: 200, rate: 1, gridOk: true };
  assert.equal(usableBlend({ ...base, span: 16, at: 184 }), true, 'no known ending: the normal blend');
  assert.equal(usableBlend({ ...base, span: 16, at: 184, outroStart: 190 }), true, 'a 10 s drumless outro is something to blend over');
  assert.equal(usableBlend({ ...base, span: 16, at: 184, outroStart: 200 }), true, 'the drums run to the end');
  // the drums stop 5 s before the end: a 16 s blend still has 11 s of beat; a 10 s one has 5
  assert.equal(usableBlend({ ...base, span: 16, at: 184, outroStart: 195 }), true);
  assert.equal(usableBlend({ ...base, span: 10, at: 190, outroStart: 195 }), false);
  // a plan under 8 s that cannot be all beat is not worth much either
  assert.equal(usableBlend({ ...base, span: 7, at: 193, outroStart: 195 }), false);
  assert.equal(usableBlend({ ...base, span: 7, at: 188, outroStart: 195 }), true, 'but one that ends while the drums still play is fine');
  // no beat to count bars on: the normal plan is all there is, and it is not this module's to judge
  assert.equal(usableBlend({ ...base, span: 16, at: 184, gridOk: false }), false);
  assert.equal(usableBlend({ ...base, span: 0, at: 184 }), false);
  // faster playback measures the 8 s in media seconds
  assert.equal(usableBlend({ ...base, rate: 1.25, span: 14, at: 187, outroStart: 195 }), false);
  assert.equal(usableBlend({ ...base, rate: 1.25, span: 25, at: 170, outroStart: 195 }), true);
});

// ---- the clean bar -----------------------------------------------------------------------------------------------------

test('the clean bar is the last bar or two of steady beat with nobody singing, on the bar lines', () => {
  const found = findCleanBar({ grid: GRID, dur: 200, now: 170, outroStart: 196, vocals: outro(clean()) });
  assert.deepEqual(found, { a: 192, b: 196, n: 2, bar: 2 });
  // the beat runs to the very end: the last bar line before it
  const toEnd = findCleanBar({ grid: GRID, dur: 200, now: 170, beatToEnd: true, vocals: outro(clean()) });
  assert.deepEqual(toEnd, { a: 194, b: 198, n: 2, bar: 2 });
  // singing in the final seconds: no loop (it would repeat the vocal or play it over the incoming song)
  assert.equal(findCleanBar({ grid: GRID, dur: 200, now: 170, outroStart: 196, vocals: outro('0'.repeat(28) + '66') }), null);
  // a single bar when only the last one is clean: singing at 192-194 (slot 26 counting 2 s slots from 140 s)
  const tight = findCleanBar({ grid: GRID, dur: 200, now: 170, outroStart: 196, vocals: outro('0'.repeat(26) + '7' + '0'.repeat(4)) });
  assert.deepEqual(tight, { a: 194, b: 196, n: 1, bar: 2 });
  // singing earlier than the loop does not matter
  assert.deepEqual(findCleanBar({ grid: GRID, dur: 200, now: 170, outroStart: 196, vocals: outro('0'.repeat(24) + '7' + '0'.repeat(6)) }), { a: 192, b: 196, n: 2, bar: 2 });
});

test('the clean bar needs everything it relies on: tempo, drums known, vocals known and clean, and room ahead', () => {
  const ok = { grid: GRID, dur: 200, now: 170, outroStart: 196, vocals: outro(clean()) };
  assert.ok(findCleanBar(ok));
  assert.equal(findCleanBar({ ...ok, grid: null }), null);
  assert.equal(findCleanBar({ ...ok, grid: { ...GRID, confidence: 0.1 } }), null);
  assert.equal(findCleanBar({ ...ok, outroStart: null }), null, 'nothing says the beat is there');
  assert.equal(findCleanBar({ ...ok, vocals: null }), null, 'vocals unknown');
  assert.equal(findCleanBar({ ...ok, vocals: outro('0'.repeat(10)) }), null, 'the end of the song was never heard');
  assert.equal(findCleanBar({ ...ok, now: 190 }), null, 'a blend needs a few seconds of lead');
  assert.equal(findCleanBar({ ...ok, dur: 0 }), null);
  // the bar lattice follows the song's own bar 1
  const shifted = findCleanBar({ ...ok, grid: { ...GRID, downbeat: 0.5 } });
  near((shifted.a - 0.5) % 2, 0);
  // faster playback keeps the lead in media seconds
  assert.equal(findCleanBar({ ...ok, now: 185, rate: 1.25 }), null);
  assert.ok(findCleanBar({ ...ok, now: 185 }));
});

// ---- the loop ------------------------------------------------------------------------------------------------------------

test('the loop repeats just often enough for an 8 bar blend, and gives up beyond four repeats', () => {
  const two = { a: 192, b: 196, n: 2, bar: 2 };
  // one bar of song is left after the loop (196 to 200): 2 x (3 + 1) + 1 = 9 bars
  const plan = loopPlanFor({ clean: two, dur: 200 });
  assert.equal(plan.at, 192);
  assert.equal(plan.loops, 3);
  assert.equal(plan.bars, 9);
  near(plan.span, 18);
  assert.equal(plan.b, 196);
  // a tail of five bars needs fewer repeats
  const roomy = loopPlanFor({ clean: { a: 180, b: 184, n: 2, bar: 2 }, dur: 196 });
  assert.equal(roomy.loops, 1);
  assert.equal(roomy.bars, 2 * 2 + 5);
  // one bar of loop and no song left after it would need eight repeats
  assert.equal(loopPlanFor({ clean: { a: 195, b: 197, n: 1, bar: 2 }, dur: 198 }), null);
  // at least one repeat even when the song has room enough
  assert.equal(loopPlanFor({ clean: { a: 100, b: 104, n: 2, bar: 2 }, dur: 140 }).loops, 1);
  assert.equal(loopPlanFor({ clean: two, dur: 200, minBars: 16 }), null, 'a 16 bar blend would need too many repeats');
  assert.equal(loopPlanFor({ clean: null, dur: 200 }), null);
  assert.equal(loopPlanFor({ clean: { a: 1, b: 300, n: 1, bar: 2 }, dur: 200 }), null);
});

// ---- the echo-out ---------------------------------------------------------------------------------------------------------

test('the echo-out sits on the last bar line that still leaves a beat of song, with a 3/4 beat echo (1/2 when slow)', () => {
  const plan = echoPlan({ grid: GRID, dur: 200, now: 170 });
  assert.equal(plan.at, 198);
  assert.equal(plan.delayBeats, 0.75);
  assert.equal(plan.tailBars, 2);
  assert.ok(plan.feedback >= 0.5 && plan.feedback <= 0.6);
  near(plan.span, 0.5 + 4);
  assert.ok(plan.at + plan.beat <= 200);
  const slow = echoPlan({ grid: { ...GRID, period: 1 }, dur: 200, now: 170 });
  assert.equal(slow.delayBeats, 0.5);
  assert.ok(slow.at % 4 === 0 && slow.at <= 200 - 1 - 0.15);
  // nothing to sync to, or too late to plan
  assert.equal(echoPlan({ grid: null, dur: 200, now: 170 }), null);
  assert.equal(echoPlan({ grid: { ...GRID, confidence: 0.1 }, dur: 200, now: 170 }), null);
  assert.equal(echoPlan({ grid: GRID, dur: 200, now: 195 }), null);
  // on the song's own bar lines
  const offset = echoPlan({ grid: { ...GRID, downbeat: 0.5 }, dur: 200, now: 170 });
  near((offset.at - 0.5) % 2, 0);
});

test('the echo-out is planned against where the sound stops, not the end of a silent tail', () => {
  // a 201 s song whose sound stops at 195.1 s: the echo used to sit at 200 s, in silence
  const tail = echoPlan({ grid: GRID, dur: 201, now: 170, outroStart: 195.1 });
  assert.equal(tail.at, 194);
  assert.ok(tail.at + tail.beat <= 195.1, 'a beat of real sound is left to throw');
  assert.equal(echoPlan({ grid: GRID, dur: 201, now: 170 }).at, 200, 'with no known ending the media end is used');
  // an outro start that is not before the end, or not known, changes nothing
  assert.equal(echoPlan({ grid: GRID, dur: 200, now: 170, outroStart: 200 }).at, 198);
  assert.equal(echoPlan({ grid: GRID, dur: 200, now: 170, outroStart: null }).at, 198);
  // too little time before the sound stops: no echo-out (the caller falls back)
  assert.equal(echoPlan({ grid: GRID, dur: 201, now: 188, outroStart: 195.1 }), null);
});

// ---- the order of preference ----------------------------------------------------------------------------------------------

test('normal blend first, then the loop, then the echo-out, then today\'s plan', () => {
  const loop = { n: 2 }, echo = { at: 198 };
  assert.deepEqual(chooseEnding({ usable: true, loop, loopOk: true, echo, echoOk: true }), { kind: 'blend' });
  const looped = chooseEnding({ usable: false, loop, loopOk: true, echo, echoOk: true });
  assert.equal(looped.kind, 'loop');
  assert.equal(looped.plan, loop);
  assert.equal(looped.reason, 'looped the last 2 bars to make room for the blend');
  assert.equal(chooseEnding({ usable: false, loop: { n: 1 }, loopOk: true }).reason, 'looped the last bar to make room for the blend');
  // the loop cannot be done here (HLS, not buffered): the echo-out
  const echoed = chooseEnding({ usable: false, loop, loopOk: false, echo, echoOk: true });
  assert.equal(echoed.kind, 'echo-out');
  assert.equal(echoed.plan, echo);
  assert.equal(echoed.reason, 'echo-out (song ends abruptly)');
  assert.equal(chooseEnding({ usable: false, loop: null, loopOk: false, echo, echoOk: true }).kind, 'echo-out', 'no clean bar');
  // neither: the plan the player had
  assert.deepEqual(chooseEnding({ usable: false, loop, loopOk: false, echo, echoOk: false }), { kind: 'fallback' });
  assert.deepEqual(chooseEnding({ usable: false }), { kind: 'fallback' });
  assert.deepEqual(chooseEnding({ usable: false, loop: null, loopOk: true, echo: null, echoOk: true }), { kind: 'fallback' });
});
