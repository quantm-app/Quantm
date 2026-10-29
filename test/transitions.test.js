import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';
import { genreTransition, mellowHint, doubleDropPlan, quickCutOptions, lowpassHz, FILTER_END, FILTER_OPEN } from '../src/js/transitions.js';
import { rollSchedule } from '../src/js/dropcut.js';
import * as mixlearn from '../src/js/mixlearn.js';

installBrowser();

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const drop = (time, confidence = 0.8) => ({ time, confidence });

test('hip-hop is cut on the downbeat: both hip-hop, or out of hip-hop into a song with a known downbeat', () => {
  const both = genreTransition({ familyOut: 'hiphop', familyIn: 'hiphop' });
  assert.deepEqual([both.style, both.variant], ['quickcut', 'dry']);
  assert.equal(both.reason, 'hip-hop: quick cut on the downbeat');
  assert.equal(genreTransition({ familyOut: 'hiphop', familyIn: 'dance', downbeatIn: 1.2 }).style, 'quickcut');
  assert.equal(genreTransition({ familyOut: 'hiphop', familyIn: 'dance' }).style, null, 'no downbeat to land on: the usual choice');
  assert.equal(genreTransition({ familyOut: 'dance', familyIn: 'hiphop', downbeatIn: 0 }).style, null, 'only out of hip-hop');
  const sung = genreTransition({ familyOut: 'hiphop', familyIn: 'hiphop', vocalsOut: true });
  assert.deepEqual([sung.style, sung.variant], ['quickcut', 'echo']);
  assert.match(sung.reason, /short echo tail/);
});

test('bass music gets a double drop only when both drops are confirmed, the tempos match and the keys do not clash', () => {
  const base = { familyOut: 'bass', familyIn: 'bass', bpmOut: 174, bpmIn: 174, dropOut: drop(120), dropIn: drop(30) };
  const dd = genreTransition(base);
  assert.deepEqual([dd.style, dd.variant, dd.reason], ['doubledrop', 'same-tempo', 'double drop']);
  assert.equal(genreTransition({ ...base, bpmIn: 177 }).style, 'doubledrop', 'a 1.7% stretch is fine');
  assert.equal(genreTransition({ ...base, bpmOut: 174, bpmIn: 87 }).variant, 'half-time', 'exact half time matches too');
  assert.equal(genreTransition({ ...base, bpmIn: 140 }).style, null, 'dubstep tempo against drum and bass does not');
  assert.equal(genreTransition({ ...base, bpmIn: 190 }).style, null);
  assert.equal(genreTransition({ ...base, dropIn: drop(30, 0.4) }).style, null, 'an unconfirmed drop is not enough');
  assert.equal(genreTransition({ ...base, dropOut: null }).style, null);
  assert.equal(genreTransition({ ...base, clash: true }).style, null);
  assert.equal(genreTransition({ ...base, familyIn: 'dance' }).style, null);
});

test('slow quiet music, mellow tags and beatless songs fade out through a filter; loud or fast dance music does not', () => {
  const deep = genreTransition({ familyOut: 'dance', familyIn: 'dance', bpmOut: 118, mellow: 'deep house' });
  assert.deepEqual([deep.style, deep.variant, deep.reason], ['filterfade', 'mellow', 'filter fade (deep house)']);
  const quiet = genreTransition({ familyOut: 'dance', familyIn: 'dance', bpmOut: 105, bpmIn: 108, energyOut: 0.25, energyIn: 0.3 });
  assert.deepEqual([quiet.style, quiet.variant], ['filterfade', 'quiet']);
  assert.equal(genreTransition({ familyOut: 'dance', familyIn: 'dance', bpmOut: 105, energyOut: 0.7 }).style, null, 'loud');
  assert.equal(genreTransition({ familyOut: 'dance', familyIn: 'dance', bpmOut: 126, energyOut: 0.2 }).style, null, 'not slow');
  assert.equal(genreTransition({ familyOut: 'dance', familyIn: 'dance', bpmOut: 105 }).style, null, 'energy unknown is not quiet');
  const free = genreTransition({ familyOut: 'other', familyIn: 'other', bpmOut: null });
  assert.deepEqual([free.style, free.variant], ['filterfade', 'beatless']);
  assert.equal(genreTransition({ familyOut: 'other', familyIn: 'other', bpmOut: 100 }).style, null, 'a pop song with a beat keeps the usual blend');
  assert.equal(genreTransition({ familyOut: 'other', familyIn: 'other', bpmOut: 100, beatOut: false }).style, 'filterfade');
  // hip-hop and bass music never get the filter, even with a mellow tag
  assert.equal(genreTransition({ familyOut: 'bass', familyIn: 'dance', mellow: 'chill' }).style, null);
  assert.equal(genreTransition({ familyOut: 'hiphop', familyIn: 'dance', mellow: 'lo fi' }).style, null);
  assert.equal(genreTransition({}).style, null);
});

test('the mellow hint reads the genre, tags and title', () => {
  assert.equal(mellowHint({ genre: 'deep house' }), 'deep house');
  assert.equal(mellowHint({ genre: 'house', tags: ['chill', 'ambient'] }), 'chill');
  assert.equal(mellowHint({ title: 'Lo-Fi Sunday' }), 'lo fi');
  assert.equal(mellowHint({ genre: 'dubstep', tags: ['riddim'], title: 'Wub' }), null);
  assert.equal(mellowHint(null), null);
});

test('a double drop starts the incoming build four bars before the shared drop and keeps both songs for the shared bars', () => {
  const grid = { period: 60 / 174, downbeat: 0.1, offset: 0.1, confidence: 0.9 }, bar = 4 * grid.period;
  const dropOut = drop(0.1 + 70 * bar + 0.05), dropIn = drop(40);
  const plan = doubleDropPlan({ gridOut: grid, dropOut, dropIn, ratio: 1, now: 20, dur: 240, durIn: 220 });
  assert.equal(plan.dropBars, 16);
  assert.equal(plan.bars, 24);
  close(plan.dropAt, 0.1 + 70 * bar, 1e-9);
  close(plan.at, plan.dropAt - 4 * bar);
  close(plan.span, 24 * bar);
  close(plan.startAt, 40 - 4 * bar);
  close(plan.inEnd, 4 / 24);
  close(plan.center, 20 / 24);
  // a tempo match stretches the incoming song's media time
  close(doubleDropPlan({ gridOut: grid, dropOut, dropIn, ratio: 1.02, now: 20, dur: 240 }).startAt, 40 - 4 * bar * 1.02);
  // too little room after the drop: eight shared bars; none at all: no plan
  const room = bars => doubleDropPlan({ gridOut: grid, dropOut: { time: 0.1 + 70 * bar }, dropIn, now: 20, dur: 0.1 + 70 * bar + bars * bar });
  assert.equal(room(30).dropBars, 16);
  assert.equal(room(20.4).dropBars, 8);
  assert.equal(room(10), null);
  assert.equal(doubleDropPlan({ gridOut: grid, dropOut, dropIn, now: 20, dur: 240, durIn: 45 }), null, 'the incoming song would run out');
  // the build must still be ahead by the preparation lead; the incoming build must fit before its drop
  assert.equal(doubleDropPlan({ gridOut: grid, dropOut, dropIn, now: dropOut.time - 5 * bar - 1, dur: 240 }), null);
  assert.equal(doubleDropPlan({ gridOut: grid, dropOut, dropIn: drop(3), now: 20, dur: 240 }), null);
  assert.equal(doubleDropPlan({ gridOut: null, dropOut, dropIn, now: 20, dur: 240 }), null);
});

test('the filter sweep goes from open to 300 Hz, smoothly, and rests there for the last tenth', () => {
  close(lowpassHz(0), FILTER_OPEN);
  close(lowpassHz(0.9), FILTER_END, 1e-6);
  close(lowpassHz(1), FILTER_END, 1e-6);
  let last = Infinity;
  for (let i = 0; i <= 90; i++) { const hz = lowpassHz(i / 100); assert.ok(hz <= last + 1e-9); last = hz; }
  assert.ok(lowpassHz(0.45) > FILTER_END && lowpassHz(0.45) < FILTER_OPEN);
});

test('the quick cut is a one-bar cut schedule with no build and no kill; the echo tail is optional', () => {
  const dry = rollSchedule(10, 0.5, 4, 'echo', quickCutOptions());
  close(dry.drop - dry.start, 2);
  close(dry.cut, dry.drop - 0.04);
  assert.equal(dry.stages.length, 0);
  assert.equal(dry.echo, false);
  assert.equal(dry.kill.style, 'none');
  assert.equal(rollSchedule(10, 0.5, 4, 'echo', quickCutOptions({ echo: true })).echo, undefined);
});

test('genre styles are tallied apart and never move the blend settings', () => {
  mixlearn.reset();
  const choice = mixlearn.choose('hiphop:mid', () => 1);
  for (const style of ['quickcut', 'doubledrop', 'filterfade']) mixlearn.record({ ...choice, style }, 'good');
  const g = mixlearn.stats().genres['hiphop:mid'];
  assert.equal(g.length, 1, 'the blend length is untouched');
  assert.deepEqual([g.styles.quickcut.good, g.styles.doubledrop.good, g.styles.filterfade.good, g.styles.blend.good], [1, 1, 1, 0]);
  mixlearn.record({ ...choice, style: 'blend' }, 'good');
  assert.ok(mixlearn.stats().genres['hiphop:mid'].length > 1, 'a blend still learns');
  mixlearn.reset();
});
