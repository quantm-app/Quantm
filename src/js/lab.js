// Lab DJ: transitions played from "recipes", patterns measured from real DJ sets and shipped with the app
// (src/data/lab-recipes.json). The main process hands the file over (window.native.lab.recipes) and this
// module validates it, picks a recipe for each transition and keeps the listener's thumbs score per
// recipe. Nothing here touches audio: the player turns a recipe's parameters into the drop-cut / blend
// machinery (dropcut.js, normalizer.js).
import { bucketFor, parseBucket, FAMILY_LABELS, TEMPO_LABELS } from './mixlearn.js';

export const SCORES_KEY = 'quantm.lab.scores';
export const EXPLORE = 0.2; // how often a transition tries a recipe other than the best one
const KINDS = ['drop', 'blend', 'cut'];
const KILLS = ['step', 'sweep', 'none'];
const TEMPOS = Object.keys(TEMPO_LABELS);
const FAMILIES = [...Object.keys(FAMILY_LABELS), 'unknown'];
/** Longest Lab blend (media seconds): 32 bars is a minute and a half at 90 BPM, which no song's outro has */
export const MAX_BLEND_SECONDS = 75;

// Lab DJ styles and the recipe kinds each plays: Lab versions of Smooth blend and Drop cut, and everything
const LAB_STYLES = { 'lab-blend': ['blend'], 'lab-dropcut': ['drop', 'cut'], lab: null };

/** Transition styles the setting accepts */
export function transitionStyles() {
  return ['auto', 'blend', 'dropcut', ...Object.keys(LAB_STYLES)];
}

/** One of the Lab DJ style names */
export const isLabName = style => Object.hasOwn(LAB_STYLES, style);

/** A Lab DJ style that's in effect */
export const isLabStyle = isLabName;

/** Recipe kinds a Lab style plays: null for all of them */
export const labKinds = style => LAB_STYLES[style] ?? null;

const num = (value, lo, hi, fallback) => {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** One recipe's playable parameters, clamped to what the player can execute */
export function clampParams(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const overlapBars = Math.round(num(r.overlapBars, 4, 32, 16));
  const steps = (Array.isArray(r.steps) ? r.steps : [])
    .map(s => ({ bar: Math.round(num(s?.bar, -8, -1, NaN)), lowCutHz: Math.round(num(s?.lowCutHz, 40, 1500, NaN)) }))
    .filter(s => Number.isFinite(s.bar) && Number.isFinite(s.lowCutHz))
    .sort((a, b) => a.bar - b.bar)
    .slice(0, 8);
  return {
    overlapBars,
    subCutBars: Math.round(num(r.subCutBars, 1, overlapBars - 1, Math.round(overlapBars / 2))),
    buildBars: Math.round(num(r.buildBars, 1, 8, 2)),
    killStyle: KILLS.includes(r.killStyle) ? r.killStyle : 'step',
    lowCutHz: Math.round(num(r.lowCutHz, 40, 1500, 200)),
    steps,
    echo: r.echo === true,
    stutter: r.stutter === true,
    // 0 (or not measured) means "no gap was measured": scheduleOptions then plays the regular Drop cut breath
    breathMs: Math.round(num(r.breathMs, 0, 400, 0))
  };
}

function normalizeRecipe(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || !KINDS.includes(raw.kind)) return null;
  return {
    id: raw.id.slice(0, 80),
    family: FAMILIES.includes(raw.family) ? raw.family : 'unknown',
    tempo: TEMPOS.includes(raw.tempo) ? raw.tempo : 'nobeat',
    kind: raw.kind,
    count: Math.max(1, Math.floor(num(raw.count, 1, 1e6, 1))),
    ...clampParams(raw)
  };
}

/**
 * Check the recipes file and keep only what the player uses. Returns { recipes }, or null when the file
 * is missing, empty or not a recipes file (Lab DJ then plays Smooth blends).
 */
export function normalizeRecipes(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.recipes)) return null;
  const recipes = raw.recipes.map(normalizeRecipe).filter(Boolean);
  return recipes.length ? { recipes } : null;
}

// ---- loaded recipes -------------------------------------------------------------

let loaded = null;
let loadedAt = null;

/** The recipes in use, or null (not loaded yet, or the file is bad) */
export function recipes() { return loaded; }
export function loadedWhen() { return loadedAt; }

/** Replace the loaded recipes with a recipes file's contents (null clears them) */
export function setRecipes(raw) {
  loaded = normalizeRecipes(raw);
  loadedAt = Date.now();
  return loaded;
}

/** Read the bundled recipes from the main process (at startup) */
export async function reload() {
  let raw = null;
  try { raw = await window.native.lab.recipes(); } catch { raw = null; }
  return setRecipes(raw);
}

// ---- thumbs scores ---------------------------------------------------------------

function readScores() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCORES_KEY));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

const count = value => { const n = Math.floor(Number(value)); return Number.isFinite(n) && n > 0 ? n : 0; };

/** { good, bad } thumbs for one recipe */
export function scoreOf(id, all = readScores()) {
  const s = all[id];
  return { good: count(s?.good), bad: count(s?.bad) };
}

/** A thumbs rating on a Lab DJ transition counts for the recipe it used */
export function recordScore(id, outcome) {
  if (typeof id !== 'string' || (outcome !== 'good' && outcome !== 'bad')) return false;
  const all = readScores();
  const s = scoreOf(id, all);
  s[outcome]++;
  all[id] = s;
  try { localStorage.setItem(SCORES_KEY, JSON.stringify(all)); } catch { /* storage full: this rating is lost */ }
  return true;
}

export function resetScores() {
  try { localStorage.removeItem(SCORES_KEY); } catch { /* ignore */ }
}

/** How much the listener's thumbs trust a recipe: 0.5 with none, toward 1 with thumbs up, toward 0 with thumbs down */
const quality = ({ good, bad }) => (good + 1) / (good + bad + 2);

// The measured sets contain far more cuts than drops or blends (about twice as many), so raw counts
// would make 'lab' and 'lab-dropcut' play cuts nearly every time: these priors offset that
export const KIND_PRIOR = Object.freeze({ cut: 0.6, blend: 1.2, drop: 1.3 });

/** What a recipe is worth when picking: the DJs' use of it, scaled by its kind's prior and the thumbs */
export function weight(recipe, all = readScores()) {
  return recipe.count * (KIND_PRIOR[recipe.kind] ?? 1) * quality(scoreOf(recipe.id, all));
}

// ---- choosing a recipe ----------------------------------------------------------

/** Tempo bucket and family of a transition, from the outgoing song (the same buckets as mixlearn.js) */
export function bucketOf(bpm, family) {
  const parsed = parseBucket(bucketFor(bpm, family));
  return { family: parsed?.family || 'unknown', tempo: parsed?.tempo || 'nobeat' };
}

/** Recipes for this family and tempo, else this tempo in any family, else this family at any tempo, else everything */
export function candidatesFor(data, { family, tempo, kinds = null }) {
  const all = kinds ? data.recipes.filter(r => kinds.includes(r.kind)) : data.recipes;
  const tiers = [
    ['exact', all.filter(r => r.family === family && r.tempo === tempo)],
    ['tempo', all.filter(r => r.tempo === tempo)],
    ['family', all.filter(r => r.family === family)],
    ['any', all]
  ];
  const found = tiers.find(([, list]) => list.length);
  return found ? { tier: found[0], list: found[1] } : null;
}

/**
 * Pick the recipe for a transition. Mostly the best (DJ count x thumbs); `explore` of the time a
 * weighted draw from all candidates instead. random is injectable for tests; it is only asked
 * when there is more than one candidate. Returns { recipe, tier, explored } or null.
 */
export function pickRecipe(data, { family, tempo, kinds = null, random = Math.random, explore = EXPLORE, scores = readScores() }) {
  const found = data && candidatesFor(data, { family, tempo, kinds });
  if (!found) return null;
  const { tier, list } = found;
  const weights = list.map(r => weight(r, scores));
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    if (weights[i] > weights[best] || (weights[i] === weights[best] && list[i].count > list[best].count)) best = i;
  }
  let index = best;
  if (list.length > 1 && random() < explore) {
    const total = weights.reduce((a, b) => a + b, 0);
    let draw = random() * total;
    index = weights.findIndex(w => (draw -= w) < 0);
    if (index < 0) index = list.length - 1;
  }
  return { recipe: list[index], tier, explored: index !== best };
}

// ---- turning a recipe into the player's parameters --------------------------------

/**
 * High-pass cutoffs for a drop's build: steps on bar lines counted back from the drop (bar -2 is two
 * bars before it), or a sweep up to the recipe's low cut. A recipe without steps gets one bar at about
 * 90 Hz, then one bar at its low cut (just the low cut when the build is one bar).
 */
export function killPlan(params) {
  const { killStyle: style, lowCutHz: hz, buildBars } = params;
  if (style === 'none') return { style, hz: null, steps: [] };
  if (style === 'sweep') return { style, hz, steps: [] };
  const steps = params.steps.length ? params.steps : [{ bar: -2, lowCutHz: 90 }, { bar: -1, lowCutHz: hz }];
  return { style, hz, steps: steps.filter(s => s.bar >= -buildBars).map(s => ({ bar: s.bar, hz: s.lowCutHz })) };
}

/** What dropcut.js's rollSchedule takes for a recipe of kind 'drop' or 'cut' */
export function scheduleOptions(recipe) {
  // a measured gap is played as measured; none measured leaves `breath` out so rollSchedule uses the Drop cut's quarter beat
  const breath = recipe.breathMs > 0 ? { breath: recipe.breathMs / 1000 } : {};
  if (recipe.kind === 'cut') return { ...breath, stutter: false, echo: recipe.echo, kill: { style: 'none' }, minBeats: 4 };
  return { ...breath, stutter: recipe.stutter, echo: recipe.echo, kill: killPlan(recipe), minBeats: 4 };
}

/** Build length in beats: a cut is a one-bar tail, a drop's build is the recipe's bars */
export const buildBeats = recipe => (recipe.kind === 'cut' ? 4 : recipe.buildBars * 4);

// The DJs' measured overlap is mostly 2-5 bars (clampParams makes it 4): a lower bound, not the length. Dance and
// bass music mix over at least this many bars; other genres over at least 4.
const BLEND_FLOOR_BARS = { dance: 8, bass: 8 };

/**
 * The shortest a Lab blend may be, in bars: what Auto mix would use here (`autoBars`, from mixSeconds), at least
 * 8 bars for dance and bass music and 4 otherwise, kept inside the longest ordinary mix (`maxSeconds`, media
 * seconds; `bar` is one bar in media seconds). Even numbers of bars, so the mix ends on a phrase half.
 */
export function blendFloorBars({ autoBars = 0, family = 'unknown', bar, maxSeconds }) {
  const wanted = Math.max(4, Math.round(autoBars), BLEND_FLOOR_BARS[family] ?? 4);
  if (!(bar > 0) || !(maxSeconds > 0)) return wanted;
  const cap = Math.max(4, 2 * Math.floor(maxSeconds / bar / 2 + 1e-9));
  return Math.min(wanted, cap);
}

/**
 * A Lab blend's length for a song: whole bars of the outgoing grid, as many as the recipe asks for
 * (4 to 32; `minBars` raises it, see blendFloorBars) that fit in `room` media seconds. center is where
 * the incoming sub (<90 Hz) stops being cut and the bass swaps, as a fraction of the mix, so it stays at
 * the recipe's proportion however long the blend plays. null when not even 4 bars fit.
 */
export function blendShape(recipe, grid, room = MAX_BLEND_SECONDS, minBars = 0) {
  if (!(grid?.period > 0)) return null;
  const bar = 4 * grid.period;
  let bars = Math.min(32, Math.max(recipe.overlapBars, minBars));
  while (bars > 4 && bars * bar > room) bars = Math.max(4, bars - (bars > 8 ? 4 : 2));
  if (bars * bar > room + 1e-9) return null;
  const center = Math.min(0.85, Math.max(0.15, recipe.subCutBars / recipe.overlapBars));
  return { bars, span: bars * bar, center, subCutBars: Math.round(center * bars), corner: 90, recipeBars: recipe.overlapBars };
}

/** " (4-bar recipe, played over 16 bars)" for the Auto mix feed: what the DJ measured next to what plays ('' when they match) */
export const playedNote = (recipe, bars) => (bars === recipe.overlapBars ? '' : ` (${recipe.overlapBars}-bar recipe, played over ${bars} bars)`);

// ---- words for the log and the settings card ---------------------------------------

/** "2-bar build, step kill to 200 Hz, 50 ms breath" (what the recipe measured; "usual" where none was and the Drop cut's default plays) */
export function describe(recipe) {
  const gap = word => (recipe.breathMs > 0 ? `${recipe.breathMs} ms ${word}` : `usual ${word}`);
  if (recipe.kind === 'blend') return `${recipe.overlapBars}-bar overlap, incoming sub cut for ${recipe.subCutBars} bars, then the bass swap`;
  if (recipe.kind === 'cut') return `quick cut on a phrase boundary, ${gap('gap')}${recipe.echo ? ', echo tail' : ''}`;
  const kill = recipe.killStyle === 'none' ? 'no kill' : `${recipe.killStyle} kill to ${recipe.lowCutHz} Hz`;
  return `${recipe.buildBars}-bar build, ${kill}${recipe.stutter ? ', loop roll' : ''}${recipe.echo ? ', echo' : ''}, ${gap('breath')}`;
}

const TIERS = { exact: '', tempo: ' [no recipe for this genre: same tempo]', family: ' [no recipe for this tempo: same genre]', any: ' [no close recipe: any]' };

/** The activity-log line for a transition that uses a recipe */
export function logLine(_data, recipe, tier = 'exact') {
  const from = `from ${recipe.count} DJ transition${recipe.count === 1 ? '' : 's'}`;
  return `Lab DJ: recipe ${recipe.id} (${from}): ${describe(recipe)}${TIERS[tier] || ''}`;
}

/** Top recipes per family and tempo for the settings table: [{ family, tempo, recipe, good, bad }] */
export function topRecipes(data, { perGroup = 2 } = {}) {
  if (!data) return [];
  const scores = readScores();
  const groups = new Map();
  for (const r of data.recipes) {
    const key = `${r.family}:${r.tempo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const order = key => [FAMILIES.indexOf(key.split(':')[0]), TEMPOS.indexOf(key.split(':')[1])];
  return [...groups.entries()]
    .sort(([a], [b]) => { const [fa, ta] = order(a), [fb, tb] = order(b); return ta - tb || fa - fb; })
    .flatMap(([, list]) => list.sort((a, b) => weight(b, scores) - weight(a, scores)).slice(0, perGroup)
      .map(recipe => ({ family: recipe.family, tempo: recipe.tempo, recipe, ...scoreOf(recipe.id, scores) })));
}

/** For tests: forget loaded recipes */
export function _reset() { loaded = null; loadedAt = null; }
