import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrowser } from './helpers/browser.js';
import { strictParam } from './helpers/audio-param.js';
import * as mixlearn from '../src/js/mixlearn.js';
import * as mixmemory from '../src/js/mixmemory.js';
import * as lab from '../src/js/lab.js';
import { rollSchedule, futureWindow, highpassAt, dropPhase, DropCutEffect } from '../src/js/dropcut.js';

installBrowser();
const raw = JSON.parse(readFileSync(new URL('./fixtures/lab-recipes.json', import.meta.url), 'utf8'));
const recipeFile = () => structuredClone(raw);
const startup = mock.method(globalThis, 'setInterval', () => 0);
const { player } = await import('../src/js/player.js');
const { settings, saveSettings } = await import('../src/js/store.js');
const cues = await import('../src/js/cues.js');
startup.mock.restore();

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const byId = (data, id) => data.recipes.find(r => r.id === id);
const data = lab.normalizeRecipes(recipeFile());

test('every build has the Lab DJ styles', () => {
  assert.deepEqual(lab.transitionStyles(), ['auto', 'blend', 'dropcut', 'lab-blend', 'lab-dropcut', 'lab']);
  // Lab versions of Smooth blend and Drop cut play only their own recipe kinds; Lab DJ: Everything plays all
  assert.deepEqual([lab.labKinds('lab-blend'), lab.labKinds('lab-dropcut'), lab.labKinds('lab')], [['blend'], ['drop', 'cut'], null]);
  assert.deepEqual(['lab-blend', 'lab-dropcut', 'lab', 'blend', 'dropcut', 'auto'].map(lab.isLabStyle), [true, true, true, false, false, false]);
});

test('Lab DJ stays off by default and for anyone who saved another style', async () => {
  localStorage.setItem('quantm.settings', '{}');
  const fresh = await import('../src/js/store.js?lab-fresh');
  assert.equal(fresh.settings.transitionStyle, 'blend');
  assert.equal(lab.isLabStyle(fresh.settings.transitionStyle), false);
  for (const style of ['blend', 'auto', 'dropcut']) {
    localStorage.setItem('quantm.settings', JSON.stringify({ transitionStyle: style, transitionStyleChosen: true, volume: 0.4 }));
    const saved = await import('../src/js/store.js?lab-saved-' + style);
    assert.equal(saved.settings.transitionStyle, style, style + ' is kept');
    assert.equal(saved.settings.volume, 0.4);
  }
  // an older save that has 'auto' only as the old default still goes back to Smooth blend
  localStorage.setItem('quantm.settings', JSON.stringify({ transitionStyle: 'auto' }));
  assert.equal((await import('../src/js/store.js?lab-old-auto')).settings.transitionStyle, 'blend');
  // a style nobody offers is repaired; a Lab style that was picked is kept and saved
  localStorage.setItem('quantm.settings', JSON.stringify({ transitionStyle: 'nonsense', transitionStyleChosen: true }));
  assert.equal((await import('../src/js/store.js?lab-bad')).settings.transitionStyle, 'blend');
  localStorage.setItem('quantm.settings', JSON.stringify({ transitionStyle: 'lab', transitionStyleChosen: true }));
  const picked = await import('../src/js/store.js?lab-picked');
  assert.equal(picked.settings.transitionStyle, 'lab');
  picked.saveSettings({ transitionStyle: 'lab-blend' });
  assert.equal(JSON.parse(localStorage.getItem('quantm.settings')).transitionStyle, 'lab-blend');
  picked.saveSettings({ transitionStyle: 'wobble' });
  assert.equal(picked.settings.transitionStyle, 'blend');
  localStorage.setItem('quantm.settings', '{}');
});

test('the bundled recipes file is valid and holds only numbers and labels', () => {
  const text = readFileSync(new URL('../src/data/lab-recipes.json', import.meta.url), 'utf8');
  const bundled = JSON.parse(text);
  assert.deepEqual(Object.keys(bundled), ['version', 'recipes']);
  const loaded = lab.normalizeRecipes(bundled);
  assert.equal(loaded.recipes.length, bundled.recipes.length, 'every bundled recipe is usable');
  assert.ok(loaded.recipes.length > 50);
  const allowed = new Set(['id', 'family', 'tempo', 'kind', 'overlapBars', 'subCutBars', 'buildBars', 'lowCutHz', 'breathMs', 'killStyle',
    'highCut', 'echo', 'stutter', 'phraseAligned', 'steps', 'count']);
  for (const r of bundled.recipes) {
    for (const key of Object.keys(r)) assert.ok(allowed.has(key), 'unexpected field ' + key);
    assert.match(r.id, /^[a-z]+:[a-z]+:(drop|blend|cut):\d+$/);
  }
  assert.doesNotMatch(text, /https?:|examples|sources|title|uploader/i);
});

test('the recipes file is validated and every parameter clamped', () => {
  assert.equal(data.recipes.length, 6);
  assert.deepEqual(Object.keys(data), ['recipes'], 'only the recipes are kept');
  assert.equal(Object.hasOwn(data.recipes[0], 'examples'), false);
  const wild = recipeFile();
  wild.recipes = [{ id: 'x', family: 'bass', tempo: 'fast', kind: 'drop', overlapBars: 99, subCutBars: 99, buildBars: 40, killStyle: 'nonsense',
    lowCutHz: 2400, steps: [{ bar: -30, lowCutHz: 5 }, { bar: -1, lowCutHz: 9000 }, { bar: 'a' }, null], breathMs: -5, count: 0 },
  { id: 'y', family: 'jazz', tempo: 'warp', kind: 'blend', overlapBars: 1, subCutBars: 0, buildBars: 0, breathMs: 9999, lowCutHz: 1 },
  { id: 'z', kind: 'cut' }, { id: 'bad', kind: 'wobble' }, { kind: 'drop' }, 7];
  const [x, y, z, ...rest] = lab.normalizeRecipes(wild).recipes;
  assert.equal(rest.length, 0, 'unknown kinds and idless entries are dropped');
  assert.deepEqual([x.overlapBars, x.subCutBars, x.buildBars, x.killStyle, x.lowCutHz, x.breathMs, x.count], [32, 31, 8, 'step', 1500, 0, 1]);
  assert.deepEqual(x.steps, [{ bar: -8, lowCutHz: 40 }, { bar: -1, lowCutHz: 1500 }]);
  assert.deepEqual([y.family, y.tempo, y.overlapBars, y.subCutBars, y.buildBars, y.breathMs, y.lowCutHz], ['unknown', 'nobeat', 4, 1, 1, 400, 40]);
  assert.deepEqual([z.buildBars, z.lowCutHz, z.breathMs, z.overlapBars, z.subCutBars], [2, 200, 0, 16, 8], 'defaults: 2-bar build, 200 Hz, no measured breath (the Drop cut default plays)');
});

test('a missing, empty or invalid recipes file loads as nothing', () => {
  for (const bad of [null, undefined, '', 'text', 3, {}, { version: 2, recipes: [{ id: 'a', kind: 'drop' }] }, { version: 1 },
    { version: 1, recipes: [] }, { version: 1, recipes: [{ id: 'a', kind: 'nope' }] }, [] ]) {
    assert.equal(lab.normalizeRecipes(bad), null, JSON.stringify(bad));
    assert.equal(lab.setRecipes(bad), null);
    assert.equal(lab.recipes(), null);
  }
  assert.ok(lab.setRecipes(recipeFile()));
  assert.equal(lab.recipes().recipes.length, 6);
});

test('reload reads the main process file and survives a failing bridge', async () => {
  window.native.lab = { recipes: async () => recipeFile() };
  assert.equal((await lab.reload()).recipes.length, 6);
  window.native.lab = { recipes: async () => { throw new Error('gone'); } };
  assert.equal(await lab.reload(), null);
  assert.equal(lab.recipes(), null);
  window.native.lab = { recipes: async () => null };
  assert.equal(await lab.reload(), null);
  assert.ok(lab.loadedWhen() > 0);
});

test('recipes come from the same family and tempo, else the same tempo, else the same family, else any', () => {
  const pick = (family, tempo, extra = {}) => lab.pickRecipe(data, { family, tempo, random: () => 0.9, scores: {}, ...extra });
  assert.deepEqual([pick('bass', 'fast').recipe.id, pick('bass', 'fast').tier], ['bass:fast:drop:3', 'exact']);
  assert.deepEqual([pick('hiphop', 'mid').recipe.id, pick('hiphop', 'mid').tier], ['dance:mid:blend:1', 'tempo']);
  assert.deepEqual([pick('bass', 'slow').recipe.id, pick('bass', 'slow').tier], ['hiphop:slow:cut:1', 'tempo']);
  assert.deepEqual([pick('bass', 'faster').recipe.id, pick('bass', 'faster').tier], ['bass:fast:drop:3', 'family']);
  assert.deepEqual([pick('other', 'faster').recipe.id, pick('other', 'faster').tier], ['bass:fast:drop:3', 'any']);
  assert.equal(pick('bass', 'fast', { kinds: ['blend'] }).recipe.id, 'bass:fast:blend:1');
  assert.equal(pick('hiphop', 'slow', { kinds: ['blend'] }).recipe.id, 'dance:mid:blend:1', 'a blend recipe even from far away');
  assert.equal(lab.pickRecipe(data, { family: 'bass', tempo: 'fast', kinds: ['nothing'] }), null);
  assert.equal(lab.pickRecipe(null, { family: 'bass', tempo: 'fast' }), null);
  assert.deepEqual(lab.bucketOf(140, 'bass'), { family: 'bass', tempo: 'fast' });
  assert.deepEqual(lab.bucketOf(null, 'unknown'), { family: 'unknown', tempo: 'nobeat' });
  assert.deepEqual(lab.bucketOf(95, 'hiphop'), { family: 'hiphop', tempo: 'slow' });
});

test('the best recipe is picked most of the time, weighted by DJ count and your thumbs, and 20% explores', () => {
  const seq = values => { const calls = []; return { calls, random: () => { calls.push(1); return values[calls.length - 1] ?? 0.5; } }; };
  const where = { family: 'bass', tempo: 'fast' };
  // 14 uses beat 5 uses; with no thumbs both are worth half their count
  let r = seq([0.5]);
  assert.equal(lab.pickRecipe(data, { ...where, random: r.random, scores: {} }).recipe.id, 'bass:fast:drop:3');
  assert.equal(r.calls.length, 1, 'one coin flip decides whether to explore');
  // explore: weighted draw over 7 vs 2.5 (total 9.5)
  r = seq([0.1, 0.99]);
  const explored = lab.pickRecipe(data, { ...where, random: r.random, scores: {} });
  assert.deepEqual([explored.recipe.id, explored.explored], ['bass:fast:blend:1', true]);
  r = seq([0.1, 0.1]);
  const same = lab.pickRecipe(data, { ...where, random: r.random, scores: {} });
  assert.deepEqual([same.recipe.id, same.explored], ['bass:fast:drop:3', false]);
  // 10 thumbs down turn the popular recipe from 7 into about 1.2, so the other one is the best
  const down = { 'bass:fast:drop:3': { good: 0, bad: 10 } };
  assert.equal(lab.pickRecipe(data, { ...where, random: () => 0.9, scores: down }).recipe.id, 'bass:fast:blend:1');
  // thumbs up on the other one: 5 x 3/4 beats 14 x 1/5
  const mixed = { 'bass:fast:drop:3': { good: 0, bad: 3 }, 'bass:fast:blend:1': { good: 2, bad: 0 } };
  assert.equal(lab.pickRecipe(data, { ...where, random: () => 0.9, scores: mixed }).recipe.id, 'bass:fast:blend:1');
  // frequencies over many seeded draws: about 80% best + part of the 20% exploration
  let state = 12345;
  const seeded = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  let best = 0;
  for (let i = 0; i < 2000; i++) if (lab.pickRecipe(data, { ...where, random: seeded, scores: {} }).recipe.id === 'bass:fast:drop:3') best++;
  assert.ok(best / 2000 > 0.8 && best / 2000 < 0.97, `${best / 2000}`);
  // one candidate: nothing to explore, and random is not even asked
  const only = seq([0]);
  assert.equal(lab.pickRecipe(data, { family: 'hiphop', tempo: 'slow', random: only.random, scores: {} }).recipe.id, 'hiphop:slow:cut:1');
  assert.equal(only.calls.length, 0);
});

test('thumbs scores are kept per recipe and can be reset', () => {
  lab.resetScores();
  assert.deepEqual(lab.scoreOf('a'), { good: 0, bad: 0 });
  assert.equal(lab.recordScore('a', 'good'), true);
  lab.recordScore('a', 'good');
  lab.recordScore('a', 'bad');
  lab.recordScore('b', 'bad');
  assert.equal(lab.recordScore('a', 'meh'), false);
  assert.equal(lab.recordScore(null, 'good'), false);
  assert.deepEqual(lab.scoreOf('a'), { good: 2, bad: 1 });
  assert.deepEqual(lab.scoreOf('b'), { good: 0, bad: 1 });
  assert.ok(JSON.parse(localStorage.getItem('quantm.lab.scores')).a);
  assert.ok(lab.weight(byId(data, 'bass:fast:drop:3')) > 0);
  const rows = lab.topRecipes(data);
  assert.equal(rows[0].recipe.tempo, 'slow', 'slowest tempo first');
  assert.ok(rows.every(row => typeof row.good === 'number'));
  localStorage.setItem('quantm.lab.scores', '[1,2');
  assert.deepEqual(lab.scoreOf('a'), { good: 0, bad: 0 }, 'a corrupt score file counts as no scores');
  lab.resetScores();
  assert.deepEqual(lab.scoreOf('a'), { good: 0, bad: 0 });
});

test('a recipe turns into a build length, a kill plan and a breath', () => {
  const drop = byId(data, 'bass:fast:drop:3'), sweep = byId(data, 'bass:mid:drop:1'), cut = byId(data, 'hiphop:slow:cut:1');
  assert.deepEqual(lab.killPlan(drop), { style: 'step', hz: 200, steps: [{ bar: -2, hz: 90 }, { bar: -1, hz: 200 }] });
  assert.deepEqual(lab.killPlan(sweep), { style: 'sweep', hz: 300, steps: [] });
  assert.deepEqual(lab.killPlan({ ...drop, killStyle: 'none' }), { style: 'none', hz: null, steps: [] });
  // no steps: one bar at about 90 Hz, then one at the low cut; a one-bar build only gets the low cut
  const plain = lab.clampParams({ buildBars: 2, lowCutHz: 300 });
  assert.deepEqual(lab.killPlan(plain).steps, [{ bar: -2, hz: 90 }, { bar: -1, hz: 300 }]);
  assert.deepEqual(lab.killPlan(lab.clampParams({ buildBars: 1, lowCutHz: 300 })).steps, [{ bar: -1, hz: 300 }]);
  assert.deepEqual([lab.buildBeats(drop), lab.buildBeats(sweep), lab.buildBeats(cut)], [8, 16, 4]);
  assert.deepEqual(lab.scheduleOptions(drop), { breath: 0.05, stutter: true, echo: true, kill: lab.killPlan(drop), minBeats: 4 });
  assert.deepEqual(lab.scheduleOptions(cut), { breath: 0.08, stutter: false, echo: true, kill: { style: 'none' }, minBeats: 4 });
  assert.equal(lab.describe(drop), '2-bar build, step kill to 200 Hz, loop roll, echo, 50 ms breath');
  assert.equal(lab.describe(lab.clampParams({ ...drop, kind: 'drop', stutter: false, echo: false })), '2-bar build, step kill to 200 Hz, 50 ms breath');
  assert.equal(lab.describe(byId(data, 'bass:mid:blend:2')), '8-bar overlap, incoming sub cut for 4 bars, then the bass swap');
  assert.equal(lab.describe(cut), 'quick cut on a phrase boundary, 80 ms gap, echo tail');
  assert.equal(lab.logLine(data, drop), "Lab DJ: recipe bass:fast:drop:3 (from 14 DJ transitions): 2-bar build, step kill to 200 Hz, loop roll, echo, 50 ms breath");
  assert.match(lab.logLine(data, drop, 'tempo'), /\[no recipe for this genre: same tempo\]$/);
  assert.match(lab.logLine(data, { ...drop, count: 1 }), /from 1 DJ transition\)/);
});

test('blend recipes use whole bars of the outgoing grid, 4 to 32, and hand the bass over at the sub-cut point', () => {
  const grid = { bpm: 128, period: 60 / 128, confidence: 0.9 }; // a bar is 1.875 s
  const blend = byId(data, 'dance:mid:blend:1'); // 32 bars, sub cut for 16
  const full = lab.blendShape(blend, grid);
  assert.deepEqual([full.bars, full.center, full.subCutBars, full.corner], [32, 0.5, 16, 90]);
  close(full.span, 32 * 1.875);
  const room = lab.blendShape(blend, grid, 40);
  assert.deepEqual([room.bars, room.subCutBars], [20, 10], 'shortened in four-bar steps to fit the room, keeping the handover ratio');
  assert.equal(lab.blendShape(blend, grid, 7), null, 'not even four bars fit');
  assert.equal(lab.blendShape(blend, null), null);
  assert.equal(lab.blendShape({ ...blend, overlapBars: 8, subCutBars: 1 }, grid).center, 0.15, 'the handover never gets closer than 15% to the start');
  assert.equal(lab.blendShape({ ...blend, overlapBars: 8, subCutBars: 7 }, grid).center, 0.85);
});

test('a measured overlap is a floor: dance and bass blends play at least 8 bars, others 4, never beyond the longest mix', () => {
  const bar = 60 / 128 * 4, longest = 24; // 24 s is the longest ordinary mix: 12 bars at 128 BPM
  assert.equal(lab.blendFloorBars({ autoBars: 8, family: 'hiphop', bar, maxSeconds: longest }), 8, 'Auto mix would play 8 bars');
  assert.equal(lab.blendFloorBars({ autoBars: 2, family: 'hiphop', bar, maxSeconds: longest }), 4);
  assert.equal(lab.blendFloorBars({ autoBars: 4, family: 'dance', bar, maxSeconds: longest }), 8);
  assert.equal(lab.blendFloorBars({ autoBars: 4, family: 'bass', bar, maxSeconds: longest }), 8);
  assert.equal(lab.blendFloorBars({ autoBars: 16, family: 'bass', bar: 60 / 175 * 4, maxSeconds: longest }), 16);
  assert.equal(lab.blendFloorBars({ autoBars: 16, family: 'dance', bar, maxSeconds: longest }), 12, 'capped by the longest mix, in even bars');
  assert.equal(lab.blendFloorBars({ autoBars: 8, family: 'dance', bar: 60 / 60 * 4, maxSeconds: longest }), 6, 'a slow song: 6 bars is 24 s');
  assert.equal(lab.blendFloorBars({ autoBars: 8, family: 'dance', bar: 30, maxSeconds: longest }), 4, 'never under 4 bars');
  const grid = { bpm: 128, period: 60 / 128, confidence: 0.9 };
  const four = { ...byId(data, 'bass:mid:blend:2'), overlapBars: 4, subCutBars: 1 };
  const plain = lab.blendShape(four, grid);
  assert.deepEqual([plain.bars, plain.center, plain.subCutBars, plain.recipeBars], [4, 0.25, 1, 4], 'no floor: the recipe length');
  const floored = lab.blendShape(four, grid, undefined, 8);
  assert.deepEqual([floored.bars, floored.center, floored.subCutBars, floored.recipeBars], [8, 0.25, 2, 4], 'same proportion, longer');
  close(floored.span, 8 * 1.875);
  assert.equal(lab.blendShape({ ...four, overlapBars: 12, subCutBars: 6 }, grid, undefined, 8).bars, 12, 'a longer recipe is kept');
  assert.equal(lab.blendShape(four, grid, 13, 16).bars, 6, 'the room left in the song wins over the floor');
  assert.equal(lab.blendShape(four, grid, 10, 16).bars, 4);
  assert.equal(lab.blendShape(four, grid, 20, 16).bars, 8, 'in steps that keep it whole bars');
  assert.equal(lab.blendShape(four, grid, 5, 16), null);
  assert.equal(lab.playedNote(four, 16), ' (4-bar recipe, played over 16 bars)');
  assert.equal(lab.playedNote(four, 4), '', 'nothing to add when it plays as measured');
});

test('a recipe without a measured breath plays the regular Drop cut breath', () => {
  const none = lab.clampParams({ buildBars: 2 });
  assert.equal(none.breathMs, 0);
  assert.equal(lab.clampParams({ breathMs: 0 }).breathMs, 0);
  const options = lab.scheduleOptions({ ...none, kind: 'drop' });
  assert.equal('breath' in options, false, 'left out, so rollSchedule uses a quarter beat');
  const schedule = rollSchedule(10, 0.5, 16, 'roll', options);
  close(schedule.cut, schedule.drop - 0.125);
  assert.equal('breath' in lab.scheduleOptions({ ...none, kind: 'cut' }), false);
  const regular = rollSchedule(10, 0.5, 16, 'roll', { minBeats: 4 });
  close(regular.cut, schedule.cut);
  // a measured gap stays as measured
  assert.equal(lab.scheduleOptions({ ...none, kind: 'cut', breathMs: 80 }).breath, 0.08);
  assert.equal(lab.scheduleOptions({ ...none, kind: 'drop', breathMs: 30 }).breath, 0.03);
  // and the card says which one plays
  assert.equal(lab.describe({ ...none, kind: 'cut', echo: false }), 'quick cut on a phrase boundary, usual gap');
  assert.match(lab.describe({ ...none, kind: 'drop' }), /, usual breath$/);
  assert.match(lab.describe({ ...none, kind: 'drop', breathMs: 30 }), /, 30 ms breath$/);
});

test('the kind prior of a recipe (cut 0.6, blend 1.2, drop 1.3) offsets the analyzer labelling too many cuts', () => {
  assert.deepEqual({ ...lab.KIND_PRIOR }, { cut: 0.6, blend: 1.2, drop: 1.3 });
  const make = (kind, count, id = `${kind}:${count}`) => ({ id, family: 'dance', tempo: 'mid', kind, count });
  const cut = make('cut', 10), blend = make('blend', 7), drop = make('drop', 6);
  const scores = {};
  close(lab.weight(cut, scores), 10 * 0.6 * 0.5);
  close(lab.weight(blend, scores), 7 * 1.2 * 0.5);
  close(lab.weight(drop, scores), 6 * 1.3 * 0.5);
  close(lab.weight(drop, { [drop.id]: { good: 2, bad: 0 } }), 6 * 1.3 * 0.75, 'the thumbs factor still applies');
  const pool = { recipes: [cut, blend, drop] };
  const pick = (extra = {}) => lab.pickRecipe(pool, { family: 'dance', tempo: 'mid', random: () => 0.9, scores, ...extra }).recipe.kind;
  assert.equal(pick(), 'blend', 'by count alone the cut would have won');
  assert.equal(pick({ kinds: ['drop', 'cut'] }), 'drop', 'Lab drop cut: drop beats the more common cut');
  assert.equal(pick({ kinds: ['cut'] }), 'cut');
  // enough thumbs up still make a cut the favourite, and thumbs down still sink a blend
  assert.equal(pick({ scores: { [cut.id]: { good: 8, bad: 0 } } }), 'cut');
  assert.equal(pick({ scores: { [blend.id]: { good: 0, bad: 8 } } }), 'drop');
  // exploring still draws from every candidate in proportion to the weights
  const seq = [0.1, 0.99];
  const explored = lab.pickRecipe(pool, { family: 'dance', tempo: 'mid', scores, random: () => seq.shift() });
  assert.deepEqual([explored.recipe.kind, explored.explored], ['drop', true]);
  // over many seeded picks the three kinds show up roughly as 3 : 4.2 : 3.9 (explore 20%) with the blend first
  let state = 99;
  const seeded = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const tally = { cut: 0, blend: 0, drop: 0 };
  for (let i = 0; i < 3000; i++) tally[pick({ random: seeded })]++;
  assert.ok(tally.blend > tally.cut * 2 && tally.cut > 0 && tally.drop > 0, JSON.stringify(tally));
});

test('the same recipe makes a step kill on bar lines or a sweep up to its own low cut', () => {
  const beat = 0.5, bar = 2;
  const stepped = rollSchedule(10, beat, 8, 'roll', lab.scheduleOptions(byId(data, 'bass:fast:drop:3')));
  // a two-bar (8-beat) build: drop at 14, bars at 10 and 12
  close(stepped.drop, 14);
  assert.deepEqual(stepped.kill.steps, [{ at: 10, hz: 90 }, { at: 12, hz: 200 }]);
  assert.equal(highpassAt(stepped, 9), 0);
  assert.equal(highpassAt(stepped, 10), 90);
  assert.equal(highpassAt(stepped, 12 - 0.01), 90, 'a step holds until the next bar line');
  assert.equal(highpassAt(stepped, 12), 200);
  assert.equal(highpassAt(stepped, 13.9), 200);
  const swept = rollSchedule(10, beat, 16, 'roll', lab.scheduleOptions(byId(data, 'bass:mid:drop:1')));
  assert.deepEqual(swept.kill, { style: 'sweep', hz: 300 });
  assert.equal(highpassAt(swept, 10), 25);
  close(highpassAt(swept, swept.cut), 300);
  assert.ok(highpassAt(swept, 11) > 25 && highpassAt(swept, 11) < highpassAt(swept, 12), 'rises through the build');
  assert.ok(highpassAt(swept, swept.cut) < 2400, 'never the Drop cut sweep to 2400 Hz');
  assert.equal(highpassAt(rollSchedule(10, beat, 8, 'roll', { kill: { style: 'none' } }), 12), 25);
  // steps are counted back from the drop: bar -3 of a 2-bar build is clamped to the build's start
  const early = rollSchedule(10, beat, 8, 'roll', { minBeats: 4, kill: { style: 'step', steps: [{ bar: -3, hz: 70 }, { bar: -1, hz: 250 }] } });
  assert.deepEqual(early.kill.steps, [{ at: 10, hz: 70 }, { at: 12, hz: 250 }]);
  assert.ok(bar > 0);
});

test('breath, loop roll and echo follow the recipe; the Drop cut default is untouched', () => {
  const defaults = rollSchedule(10, 0.5, 16);
  close(defaults.cut, defaults.drop - 0.125);
  assert.equal(defaults.kill, undefined);
  assert.equal(defaults.echo, undefined);
  assert.equal(defaults.variant, 'roll');
  assert.equal(defaults.stages.length, 4);
  close(highpassAt(defaults, defaults.cut), 2400);
  const breath = rollSchedule(10, 0.5, 16, 'roll', { breath: 0.05 });
  close(breath.cut, breath.drop - 0.05);
  assert.equal(dropPhase(breath, breath.drop - 0.04), 'cut');
  assert.equal(breath.stages.at(-1).end, breath.cut, 'the last roll slice ends where the breath begins');
  const noRoll = rollSchedule(10, 0.5, 16, 'roll', { stutter: false, echo: false });
  assert.deepEqual([noRoll.stages.length, noRoll.variant, noRoll.echo], [0, 'echo', false]);
  assert.equal(rollSchedule(10, 0.5, 4, 'roll', { minBeats: 4 }).drop, 12, 'a one-bar build');
  assert.equal(rollSchedule(10, 0.5, 4), null, 'the Drop cut still needs two bars');
  assert.equal(rollSchedule(10, 0.5, 4, 'roll', { minBeats: 4, breath: 2 }), null, 'a breath longer than the build');
  assert.equal(rollSchedule(10, 0.5, 4, 'roll', { minBeats: 4, breath: -1 }), null);
});

test('builds of exactly the recipe bars fit on the outgoing phrase grid', () => {
  const grid = { bpm: 120, period: 0.5, offset: 0, downbeat: 0, confidence: 0.9 };
  const window = (buildBeats, now = 150) => futureWindow(grid, 201, { now, dropTime: 92, buildBeats });
  for (const bars of [1, 2, 3, 4, 8]) {
    const w = window(bars * 4);
    close(w.cut - w.build, bars * 2);
    close(w.cut % 16, 0); // a 32-beat phrase boundary at 120 BPM
  }
  assert.equal(window(8, 198), null, 'no room left for the build before the end');
  assert.equal(futureWindow(grid, 201, { now: 150, dropTime: 2.1, buildBeats: 4 }), null, 'the incoming song needs room before its drop');
});

function context() {
  const nodes = [];
  const param = () => ({ value: 1, events: [],
    cancelScheduledValues(t) { this.events = this.events.filter(e => e.t < t); },
    setValueAtTime(v, t) { this.events.push({ type: 'set', v, t }); },
    setTargetAtTime(v, t) { this.events.push({ type: 'target', v, t }); },
    linearRampToValueAtTime(v, t) { this.events.push({ type: 'linear', v, t }); },
    exponentialRampToValueAtTime(v, t) { this.events.push({ type: 'exponential', v, t }); }
  });
  const node = () => { const result = { outputs: [], gain: param(), frequency: param(), Q: param(), delayTime: param(),
    connect(next) { this.outputs.push(next); return next; },
    disconnect(next) { this.outputs = next ? this.outputs.filter(n => n !== next) : []; }
  }; nodes.push(result); return result; };
  return { nodes, currentTime: 1, createGain: node, createBiquadFilter: node, createDelay: node };
}

test('the effect graph programs the recipe cutoffs, echo level and no loops when stutter is off', () => {
  const build = (id, start = 2) => {
    const ctx = context(), source = ctx.createGain(), destination = ctx.createGain();
    source.connect(destination);
    const schedule = rollSchedule(start, 0.5, lab.buildBeats(byId(data, id)), 'roll', lab.scheduleOptions(byId(data, id)));
    return { effect: new DropCutEffect(ctx, source, destination, schedule), schedule, ctx };
  };
  const step = build('bass:fast:drop:3');
  const sets = step.effect.highpass.frequency.events.filter(e => e.type === 'set');
  assert.deepEqual(sets.map(e => [e.v, e.t]), [[25, 2], [90, 2], [200, 4]]);
  assert.equal(step.effect.highpass.frequency.events.some(e => e.type === 'exponential'), false, 'a step kill never sweeps');
  const sweep = build('bass:mid:drop:1');
  assert.deepEqual(sweep.effect.highpass.frequency.events.at(-1), { type: 'exponential', v: 300, t: sweep.schedule.cut });
  assert.equal(sweep.schedule.stages.length, 0);
  const noEcho = build('hiphop:slow:cut:1'); // a cut with an echo tail
  assert.equal(noEcho.effect.highpass.frequency.events.some(e => e.type === 'exponential'), false);
  assert.equal(noEcho.effect.highpass.frequency.events.length, 1, 'a cut leaves the high-pass alone');
  const quiet = new DropCutEffect(context(), (() => { const c = context(); return c.createGain(); })(), null, { ...step.schedule, echo: false, kill: undefined });
  assert.ok(quiet);
});

// ---- the player ------------------------------------------------------------------------

function fixture(t) {
  const timers = new Map();
  let id = 0;
  t.mock.method(globalThis, 'setInterval', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => timers.delete(key));
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  settings.speedMode = 'normal';
  settings.autoMix = true; settings.transitionStyle = 'lab';
  lab.setRecipes(recipeFile());
  lab.resetScores();
  const p = new player.constructor();
  t.after(() => { p.fading = null; p.lock = null; p.tempoRelease = null; settings.transitionStyle = 'blend'; });
  cues._reset(); mixmemory.reset(); mixlearn.reset();
  const from = { id: 21, title: 'Outgoing', duration: 201000, genre: 'Dubstep' };
  const to = { id: 22, title: 'Incoming', duration: 201000 };
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
    swapBass(...a) { calls.push(['swap', ...a]); }, setActive() {}, startTrack() {}, holdFade() {}, setEqualizer() {} };
  t.mock.method(p, 'updateMediaSession', () => {});
  t.mock.method(p, 'saveSession', () => {});
  t.mock.method(p, 'startListening', () => {});
  t.mock.method(p, 'notify', () => {});
  t.mock.method(p.beats, 'grid', () => null);
  return { p, from, to, outgoing, incoming, calls, timers };
}

const grid = (bpm = 140) => ({ bpm, period: 60 / bpm, offset: 0, downbeat: 0, confidence: 0.9 });

function prepare(p, from, to, incoming, extra = {}) {
  mixmemory.learn(from.id, { grid: grid() });
  return p.prepared = { loadId: p.loadId, from: 0, auto: true, track: to, stream: { track: {} },
    preroll: { deck: incoming, track: to, done: true, grid: grid(140), startAt: 0, ...extra } };
}

test('the outgoing song picks the recipe: its genre family and tempo bucket, once per song', t => {
  const { p, from } = fixture(t);
  assert.equal(p.mixFamily(from), 'bass');
  p.audio.currentTime = 100;
  assert.equal(p.labPickFor(null), null, 'too early: the ending is more than 90 s away');
  assert.equal(p.dropWanted({}), false);
  p.audio.currentTime = 150;
  mixmemory.learn(from.id, { grid: grid(140) });
  const pick = p.labPickFor(null);
  assert.deepEqual([pick.family, pick.tempo, pick.loadId], ['bass', 'fast', p.loadId]);
  assert.ok(['bass:fast:drop:3', 'bass:fast:blend:1'].includes(pick.recipe.id));
  assert.equal(p.labPickFor(grid(140)), pick, 'the same pick all the way through the transition');
  assert.equal(p.dropWanted({}), pick.recipe.kind === 'drop');
  assert.equal(p.dropWanted({ style: 'dropcut' }), true, 'a pair override keeps its own style');
  assert.equal(p.dropWanted({ style: 'blend' }), false);
  p.loadId++;
  assert.notEqual(p.labPickFor(grid(100)), pick, 'a new song picks again');
  // once the tempo becomes known the pick is redone, but never mid-mix
  p.loadId++;
  p.audio.currentTime = 150;
  mixmemory.reset();
  const early = p.labPickFor(null);
  assert.equal(early.tempo, 'nobeat');
  assert.equal(p.labPickFor(grid(140)).tempo, 'fast');
  assert.notEqual(early, p.labPick);
});

test('with no recipes file Lab DJ plays the Smooth blend and says so', t => {
  const { p, from, to, incoming } = fixture(t);
  lab.setRecipes(null);
  p.audio.currentTime = 150;
  const prep = prepare(p, from, to, incoming);
  const selected = p.selectMixStyle(prep, {}, grid());
  assert.equal(selected.style, 'blend');
  assert.match(selected.reason, /^Lab DJ: no recipes loaded/);
  assert.equal(selected.lab, undefined);
  assert.equal(p.dropWanted({}), false);
  // a recipe file with nothing for this song still plays a blend
  lab.setRecipes({ ...recipeFile(), recipes: [raw.recipes[5]] });
  p.loadId++;
  prep.preroll.done = false;
  const notReady = p.selectMixStyle(prep, {}, grid());
  assert.equal(notReady.style, 'blend', 'a cut cannot land on a next song that is not ready');
  assert.match(notReady.reason, /^Lab DJ: next song not ready \(recipe .*cut/);
  // a pair override still wins over Lab DJ
  cues.setPair(from.id, to.id, { style: 'blend' });
  assert.equal(p.selectMixStyle(prep, cues.transitionFor(from.id, to.id), grid()).style, 'blend');
});

test('a Lab blend sizes the mix in bars, holds the incoming sub until the recipe handover and logs the recipe', t => {
  const { p, from, to, incoming, outgoing, calls } = fixture(t);
  lab.setRecipes({ ...recipeFile(), recipes: raw.recipes.filter(r => r.id === 'dance:mid:blend:1') });
  from.genre = 'House';
  const g = grid(128);
  mixmemory.learn(from.id, { grid: g });
  p.audio.currentTime = 125; // 76 s left: Lab plans earlier than the normal 38 s
  const plan = p.planMix(outgoing.audio, 201);
  assert.ok(plan.span > 0);
  assert.equal(plan.lab.recipe.id, 'dance:mid:blend:1');
  assert.equal(plan.lab.bars, 32);
  close(plan.span, 32 * 4 * g.period);
  assert.equal(plan.choice.params.dj, 1);
  assert.match(p.mixLog[0].text, /Lab DJ recipe dance:mid:blend:1/);
  // start the transition
  const prep = prepare(p, from, to, incoming, { grid: g });
  outgoing.audio.currentTime = 201 - plan.span;
  p.mixPlan = plan;
  p.startCrossfade();
  const f = p.fading;
  assert.equal(f.style, 'blend');
  assert.equal(f.lab.recipe.id, 'dance:mid:blend:1');
  close(f.seconds, plan.span);
  assert.deepEqual(f.bassOpts, { center: 0.5, corner: 90, eq: 1 }, 'the Lab blend also hands the mids and highs over with its own centre');
  assert.deepEqual(f.shapeIn, { dj: 1, center: 0.5 });
  assert.equal(f.bass, true);
  assert.deepEqual(calls.find(c => c[0] === 'hold')?.slice(-1)[0], { center: 0.5, corner: 90, eq: 1 });
  const line = p.mixLog.find(e => /^Lab DJ: recipe dance:mid:blend:1 \(from 9 DJ transitions\)/.test(e.text));
  assert.ok(line, p.mixLog.map(e => e.text).join('\n'));
  assert.match(line.text, /32-bar overlap, incoming sub cut for 16 bars, then the bass swap, into "Incoming"/);
  incoming.audio.dispatchEvent({ type: 'playing' });
  const swap = calls.find(c => c[0] === 'swap');
  assert.deepEqual(swap.slice(-1)[0], { center: 0.5, corner: 90, eq: 1 });
  assert.ok(prep);
});

test('a Lab blend starts on a phrase line, plays at least the Auto mix length and keeps the recipe handover proportion', t => {
  const { p, from, to, incoming, outgoing, calls } = fixture(t);
  // the DJs measured a 4-bar overlap with the incoming sub cut for the first bar: a quarter of the blend
  const short = { id: 'dance:mid:blend:9', family: 'dance', tempo: 'mid', kind: 'blend', overlapBars: 4, subCutBars: 1, count: 6 };
  lab.setRecipes({ ...recipeFile(), recipes: [short] });
  from.genre = 'House';
  const period = 60 / 128, bar = 4 * period;
  const g = { bpm: 128, period, offset: 0.1, downbeat: 0.1 + 8 * period, confidence: 0.9 };
  mixmemory.learn(from.id, { grid: g });
  p.audio.currentTime = 125;
  const plan = p.planMix(outgoing.audio, 201);
  // Auto mix plays 32 beats (8 bars) at 128 BPM, and dance music at least 8: the blend is 8 bars, not 4
  assert.equal(plan.lab.recipe.id, short.id);
  assert.deepEqual([plan.lab.bars, plan.lab.recipeBars, plan.lab.subCutBars, plan.lab.center], [8, 4, 2, 0.25]);
  close(plan.span, 8 * bar);
  // it begins on a phrase line (8 bars from the downbeat), not "span before the end", and ends with the song
  assert.notEqual(plan.at, null);
  const lines = (plan.at - g.downbeat) / (8 * bar);
  close(lines, Math.round(lines));
  assert.ok(plan.at + plan.span <= 201.3 && 201 - (plan.at + plan.span) < 4 * bar, `${plan.at}`);
  assert.notEqual(plan.at, 201 - plan.span);
  assert.equal(plan.bars, 8);
  assert.match(p.mixLog[0].text, /, on the phrase: 8 bars, Lab DJ recipe dance:mid:blend:9 \(4-bar recipe, played over 8 bars\)$/);
  assert.equal(p.planMix(outgoing.audio, 201), plan, 'the plan stays put once made');
  // checkCrossfade waits for the line
  prepare(p, from, to, incoming, { grid: g });
  p.checkCrossfade();
  close(p.mixAt.at, plan.at);
  assert.equal(p.fading, null);
  // and the transition plays the longer blend, holding the incoming sub until a quarter of it (the recipe's proportion)
  outgoing.audio.currentTime = plan.at;
  p.mixPlan = plan;
  p.startCrossfade();
  const f = p.fading;
  close(f.seconds, 8 * bar);
  assert.deepEqual(f.bassOpts, { center: 0.25, corner: 90, eq: 1 });
  assert.deepEqual(f.shapeIn, { dj: 1, center: 0.25 });
  const line = p.mixLog.find(e => /^Lab DJ: recipe dance:mid:blend:9/.test(e.text));
  assert.match(line.text, /4-bar overlap, incoming sub cut for 1 bars, then the bass swap \(4-bar recipe, played over 8 bars\), into "Incoming"/);
  assert.ok(calls.find(c => c[0] === 'hold'));
});

test('a Lab blend without a known downbeat still starts on a bar line; a fast song plays the longer Auto length; a recipe over the floor is kept', t => {
  const { p, from, outgoing } = fixture(t);
  const blend = { id: 'bass:faster:blend:9', family: 'bass', tempo: 'faster', kind: 'blend', overlapBars: 4, subCutBars: 2, count: 4 };
  lab.setRecipes({ ...recipeFile(), recipes: [blend, { ...blend, id: 'x', family: 'hiphop', overlapBars: 12, subCutBars: 6, count: 1 }] });
  from.genre = 'Dubstep';
  const period = 60 / 175, bar = 4 * period;
  // a grid with no downbeat heard: bars are counted from the first beat
  mixmemory.learn(from.id, { grid: { bpm: 175, period, offset: 0.2, confidence: 0.9 } });
  p.audio.currentTime = 125;
  const plan = p.planMix(outgoing.audio, 201);
  assert.equal(plan.lab.recipe.id, blend.id);
  // 16-72 beats at 175 BPM: Auto mix plays 14-18 bars here, so the 4-bar recipe does too (never fewer than 8 for bass music)
  assert.ok(plan.lab.bars >= 14 && plan.lab.bars <= 18 && plan.lab.bars % 2 === 0, `${plan.lab.bars}`);
  assert.equal(plan.lab.subCutBars, plan.lab.bars / 2, 'half way, as the recipe has it');
  assert.equal(plan.lab.center, 0.5);
  const n = (plan.at - plan.grid.downbeat) / (4 * plan.grid.period); // the remembered grid, as the player counts it
  close(n, Math.round(n));
  assert.ok(plan.at + plan.span <= 201.3 && 201 - (plan.at + plan.span) < bar + 0.3, 'no phrase to wait for: it ends within a bar of the song');
  assert.match(p.mixLog[0].text, /, on a bar line, Lab DJ recipe bass:faster:blend:9 \(4-bar recipe, played over \d+ bars\)$/);
  // a recipe that already measured more than the floor keeps its own length
  const long = { ...blend, id: 'long', overlapBars: 24, subCutBars: 12 };
  lab.setRecipes({ ...recipeFile(), recipes: [long] });
  p.loadId++; p.mixPlan = null; p.labPick = null;
  mixmemory.learn(from.id, { grid: { bpm: 175, period, offset: 0.2, confidence: 0.9 } });
  assert.equal(p.planMix(outgoing.audio, 201).lab.bars, 24);
});

test('changing the Lab style replans: a Lab blend plan is not reused by another style, nor the reverse', t => {
  const { p, from, outgoing } = fixture(t);
  lab.setRecipes({ ...recipeFile(), recipes: raw.recipes.filter(r => r.id === 'dance:mid:blend:1' || r.id === 'bass:fast:drop:3') });
  from.genre = 'House';
  mixmemory.learn(from.id, { grid: grid(128) });
  p.audio.currentTime = 125;
  settings.transitionStyle = 'lab-dropcut';
  const dropPlan = p.planMix(outgoing.audio, 201);
  assert.ok(dropPlan.span > 0);
  assert.equal(dropPlan.lab, null, 'a drop cut recipe plans an ordinary blend to fall back on');
  assert.equal(p.planMix(outgoing.audio, 201), dropPlan, 'the same style keeps its plan');
  settings.transitionStyle = 'lab-blend';
  const blendPlan = p.planMix(outgoing.audio, 201);
  assert.notEqual(blendPlan, dropPlan);
  assert.equal(blendPlan.lab.recipe.id, 'dance:mid:blend:1', 'the Lab blend shape is planned now');
  assert.equal(blendPlan.setting, 'lab-blend');
  settings.transitionStyle = 'lab-dropcut';
  assert.equal(p.planMix(outgoing.audio, 201).lab, null, 'and back again');
});

test('a Lab drop uses the recipe build length, step kill, breath and loop roll, and needs a confirmed drop', t => {
  const { p, from, to, incoming } = fixture(t);
  lab.setRecipes({ ...recipeFile(), recipes: raw.recipes.filter(r => r.kind !== 'blend' && r.id !== 'bass:mid:drop:1' && r.id !== 'hiphop:slow:cut:1') });
  const g = grid(140);
  mixmemory.learn(from.id, { grid: g });
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('fast', () => 0.5) };
  const prep = prepare(p, from, to, incoming, { drop: { time: 60, confidence: 0.8 }, dropGrid: g });
  const selected = p.selectMixStyle(prep, {}, g);
  assert.equal(selected.style, 'dropcut');
  assert.equal(selected.lab.recipe.id, 'bass:fast:drop:3');
  assert.equal(selected.variant, 'roll');
  close(selected.window.cut - selected.window.build, 2 * 4 * g.period, 'two bars');
  assert.match(selected.reason, /^Lab DJ: recipe bass:fast:drop:3 \(from 14 DJ transitions/);
  // no confirmed drop: a blend recipe (none here, so the Smooth blend) with the reason
  const none = prepare(p, from, to, incoming, { drop: null });
  const fallback = p.selectMixStyle(none, {}, g);
  assert.equal(fallback.style, 'blend');
  assert.match(fallback.reason, /No clear drop/);
  // with a blend recipe available the transition blends with it, fitted to the planned mix
  lab.setRecipes(recipeFile());
  p.labPick = null;
  from.genre = 'Dubstep';
  p.labPick = { loadId: p.loadId, style: 'lab', family: 'bass', tempo: 'fast', recipe: byId(lab.recipes(), 'bass:fast:drop:3'), tier: 'exact', data: lab.recipes() };
  const instead = p.selectMixStyle(none, {}, g);
  assert.equal(instead.style, 'blend');
  assert.equal(instead.lab.recipe.id, 'bass:fast:blend:1');
  assert.match(instead.reason, /bass:fast:drop:3 can't play here: No clear drop/);
  assert.equal(instead.lab.bars, 4, 'fitted to the 8-second planned mix: four whole bars at 140 BPM');
  assert.equal(instead.lab.span, 8);
});

test('a Lab drop is armed on the audio clock with the recipe schedule, and Next cuts to the drop', t => {
  const { p, from, to, incoming, outgoing, calls } = fixture(t);
  lab.setRecipes({ ...recipeFile(), recipes: [raw.recipes[0]] });
  const g = grid(140);
  mixmemory.learn(from.id, { grid: g });
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('fast', () => 0.5) };
  const prep = prepare(p, from, to, incoming, { drop: { time: 60, confidence: 0.8 }, dropGrid: g });
  // the transition launches 1.5 s before the build begins
  const planned = p.selectMixStyle(prep, {}, g);
  outgoing.audio.currentTime = planned.window.build - planned.window.lead;
  p.startCrossfade();
  const f = p.fading;
  assert.equal(f.style, 'dropcut');
  assert.equal(f.lab.recipe.id, 'bass:fast:drop:3');
  assert.equal(f.dropcut.lab.buildBeats, 8);
  assert.match(p.mixLog.find(e => e.kind === 'plan').text, /Lab DJ: recipe bass:fast:drop:3.*2-bar build, step kill to 200 Hz.*50 ms breath, into "Incoming"/);
  assert.equal(f.prep, prep);
  assert.ok(f.incoming.audio.currentTime > 50 && f.incoming.audio.currentTime < 60, 'silent pre-roll just before the drop');
  incoming.audio.currentTime = f.dropcut.drop.time - (f.dropcut.window.cut - outgoing.audio.currentTime);
  f.armDeadline = performance.now() + 1e6;
  p.beginDropCut(f);
  assert.equal(f.dropScheduled, true);
  const schedule = calls.find(c => c[0] === 'schedule')[1];
  close(schedule.cut, schedule.drop - 0.05);
  close(schedule.drop - schedule.start, 8 * 60 / 140, 'a two-bar build');
  assert.deepEqual(schedule.kill.steps.map(s => s.hz), [90, 200]);
  assert.equal(schedule.stages.length, 4);
  assert.equal(schedule.variant, 'roll');
  // Next during the build lands the drop straight away, as in a Drop cut
  p.fading = f; f.landed = false;
  p.next();
  assert.equal(p.mixLog[0].text, 'Next during drop build: cut straight to the incoming drop');
});

test('a Lab cut lands on a downbeat of the next song with a short echo tail', t => {
  const { p, from, to, incoming, outgoing } = fixture(t);
  lab.setRecipes({ ...recipeFile(), recipes: [raw.recipes[5]] });
  from.genre = 'Hip hop';
  const g = grid(90);
  mixmemory.learn(from.id, { grid: g });
  outgoing.audio.currentTime = 150;
  p.audio.currentTime = 150;
  p.mixPlan = { loadId: p.loadId, grid: g, span: 8, choice: mixlearn.choose('slow', () => 0.5) };
  p.labPick = null;
  const prep = prepare(p, from, to, incoming, { grid: grid(90) });
  const selected = p.selectMixStyle(prep, {}, g);
  assert.equal(selected.style, 'dropcut');
  assert.equal(selected.variant, 'echo');
  assert.equal(selected.lab.recipe.kind, 'cut');
  const bar = 4 * (60 / 90);
  close(selected.drop.time / bar, Math.round(selected.drop.time / bar), 'a downbeat of the next song');
  assert.ok(selected.drop.time >= bar + 4, 'room for the silent pre-roll');
  close(selected.window.cut - selected.window.build, bar, 'a one-bar tail');
  assert.equal(selected.lab.options.stutter, false);
  assert.equal(selected.lab.options.echo, true);
  assert.equal(selected.lab.options.breath, 0.08);
  // armed once the outgoing song reaches the launch point: an echo tail with no loop roll, landing 80 ms after it stops
  outgoing.audio.currentTime = selected.window.build - selected.window.lead;
  p.startCrossfade();
  const f = p.fading;
  assert.equal(f.style, 'dropcut');
  assert.ok(f.incoming.audio.currentTime >= 0 && f.incoming.audio.currentTime < f.dropcut.drop.time, 'the silent pre-roll starts inside the song');
  f.armDeadline = performance.now() + 1e6;
  p.beginDropCut(f);
  assert.equal(f.dropScheduled, true);
  assert.equal(f.schedule.stages.length, 0);
  close(f.schedule.cut, f.schedule.drop - 0.08);
  close(f.schedule.drop - f.schedule.start, bar);
  assert.equal(f.schedule.kill.style, 'none');
});

test('thumbs on a Lab transition score its recipe and leave the Drop cut / blend learning alone', t => {
  const { p } = fixture(t);
  mixlearn.reset();
  p.queue = [{ id: 21, title: 'Outgoing' }, { id: 22, title: 'Incoming' }];
  p.index = 1;
  const choice = { ...mixlearn.choose('fast', () => 0.5), style: 'dropcut', lab: { recipeId: 'bass:fast:drop:3' } };
  p.mixOutcome = { choice, trackId: 22, mixEnd: performance.now(), rateable: true };
  assert.equal(p.rateMix('bad'), true);
  p.mixOutcome = { choice, trackId: 22, mixEnd: performance.now(), rateable: true };
  assert.equal(p.rateMix('good'), true);
  p.mixOutcome = { choice, trackId: 22, mixEnd: performance.now(), rateable: true };
  assert.equal(p.rateMix('good'), true);
  assert.deepEqual(lab.scoreOf('bass:fast:drop:3'), { good: 2, bad: 1 });
  assert.equal(mixlearn.stats().transitions, 0);
  assert.match(p.mixLog[0].text, /You rated Lab DJ recipe bass:fast:drop:3 into "Incoming": good/);
  // an ordinary blend still trains mixlearn
  p.mixOutcome = { choice: { ...mixlearn.choose('fast', () => 0.5), style: 'blend' }, trackId: 22, mixEnd: performance.now(), rateable: true };
  p.rateMix('good');
  assert.equal(mixlearn.stats().transitions, 1);
  assert.equal(lab.scoreOf('bass:fast:drop:3').good, 2);
  // and the recipe scores steer the next pick
  for (let i = 0; i < 30; i++) lab.recordScore('bass:fast:drop:3', 'bad');
  assert.equal(lab.pickRecipe(lab.recipes(), { family: 'bass', tempo: 'fast', random: () => 0.9 }).recipe.id, 'bass:fast:blend:1');
});

test('saving lab as the transition style works', () => {
  saveSettings({ transitionStyle: 'lab' });
  assert.equal(settings.transitionStyle, 'lab');
  saveSettings({ transitionStyle: 'blend' });
});

test('a Lab blend moves the bass handover and the shelf corner; ordinary blends leave both alone', async t => {
  const nodes = [];
  const param = () => strictParam({ value: 1, events: [],
    cancelScheduledValues() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setValueAtTime(v, at) { this.events.push({ v, at }); }, setValueCurveAtTime(curve, at, seconds) { this.events.push({ curve, at, seconds }); } }, () => ctx.currentTime);
  const node = () => { const n = { outputs: [], gain: param(), frequency: param(), Q: param(), delayTime: param(), threshold: param(), knee: param(),
    ratio: param(), attack: param(), release: param(), fftSize: 0, getFloatTimeDomainData() {},
    connect(next) { this.outputs.push(next); return next; }, disconnect() {} }; nodes.push(n); return n; };
  const ctx = { currentTime: 1, sampleRate: 48000, destination: node(), createGain: node, createBiquadFilter: node, createDelay: node,
    createDynamicsCompressor: node, createAnalyser: node, createMediaElementSource: node, resume() {}, state: 'running' };
  t.mock.method(globalThis, 'setInterval', () => 0);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = function () { return ctx; };
  t.after(() => { if (original) Object.defineProperty(globalThis, 'AudioContext', original); else delete globalThis.AudioContext; });
  const { Normalizer } = await import('../src/js/normalizer.js?lab-bass');
  const a = {}, b = {}, norm = new Normalizer(a);
  assert.equal(norm.init(), true);
  assert.equal(norm.addDeck(b), true);
  const incoming = norm.decks.get(b).bass;
  const level = (curve, t) => curve[Math.round(t * (curve.length - 1))];
  norm.swapBass(b, true, 20, 0, 0.2);
  const plain = incoming.gain.events.at(-1).curve;
  assert.equal(incoming.frequency.events.length, 0, 'the 220 Hz shelf is not touched');
  norm.swapBass(b, true, 20, 0, 0.2, { center: 0.25, corner: 90 });
  const early = incoming.gain.events.at(-1).curve;
  assert.deepEqual(incoming.frequency.events.at(-1), { v: 90, at: 1 });
  // the incoming bass is still out well before the handover and full soon after it
  assert.ok(level(plain, 0.25) < -20 && level(early, 0.25) > -14 && level(early, 0.1) < -24);
  assert.ok(level(plain, 0.5) < -10 && level(plain, 0.5) > -16, 'the plain swap is half way at the middle');
  norm.holdBass(b, true, null);
  assert.deepEqual(incoming.frequency.events.at(-1), { v: 220, at: 1 }, 'the full bass comes back with the normal corner');
  assert.equal(incoming.gain.events.at(-1).v, 0);
});

test('Lab DJ is off unless a Lab style is chosen, even when recipes exist', t => {
  const { p } = fixture(t);
  settings.transitionStyle = 'blend';
  assert.equal(p.labActive(), false);
  assert.equal(p.dropWanted({}), false);
  assert.ok(lab.recipes());
  settings.transitionStyle = 'auto';
  assert.equal(p.labActive(), false);
  settings.transitionStyle = 'lab';
  assert.equal(p.labActive(), true);
});
