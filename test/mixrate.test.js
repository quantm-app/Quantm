import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { Emitter } = await import('../src/js/dom.js');
const { createMixRate, FADE_MS } = await import('../src/js/mixrate.js');

// A player stand-in that says when the transition can be rated, and a view that logs what happened to the control.
function setup({ reduced = false } = {}) {
  const player = new Emitter();
  player.mixRating = null;
  player.rated = [];
  player.rateMix = outcome => { player.rated.push(outcome); return true; };
  const frames = [];
  const log = [];
  const view = { mount: () => log.push('mount'), reveal: () => log.push('reveal'), conceal: () => log.push('conceal'), unmount: () => log.push('unmount') };
  const control = createMixRate(player, view, { reducedMotion: () => reduced, frame: fn => frames.push(fn) });
  const set = rating => { player.mixRating = rating; player.emit('mixrate', rating); };
  return { player, control, log, frames, set };
}
const RATING = { track: { id: 1 }, style: 'blend' };

test('the control is mounted at once and faded in on the next frame while there is something to rate', t => {
  const { log, frames, set } = setup();
  assert.deepEqual(log, []);
  set(RATING);
  assert.deepEqual(log, ['mount']);
  frames.shift()();
  assert.deepEqual(log, ['mount', 'reveal']);
});

test('it fades out when the window ends and leaves the layout after the fade', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { log, frames, set } = setup();
  set(RATING); frames.shift()();
  set(null);
  assert.deepEqual(log, ['mount', 'reveal', 'conceal']);
  t.mock.timers.tick(FADE_MS - 1);
  assert.equal(log.includes('unmount'), false, 'still fading');
  t.mock.timers.tick(1);
  assert.deepEqual(log, ['mount', 'reveal', 'conceal', 'unmount']);
});

test('a new window during the fade-out keeps the control instead of removing it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { log, frames, set } = setup();
  set(RATING); frames.shift()();
  set(null);
  set(RATING);
  frames.shift()();
  t.mock.timers.tick(FADE_MS * 2);
  assert.deepEqual(log, ['mount', 'reveal', 'conceal', 'reveal']);
});

test('ending the window before the first frame never reveals it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { log, frames, set } = setup();
  set(RATING);
  set(null);
  frames.forEach(fn => fn());
  t.mock.timers.tick(FADE_MS);
  assert.deepEqual(log, ['mount', 'conceal', 'unmount']);
});

test('reduced motion shows and hides immediately, without frames or timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { log, frames, set } = setup({ reduced: true });
  set(RATING);
  assert.deepEqual(log, ['mount', 'reveal']);
  set(null);
  assert.deepEqual(log, ['mount', 'reveal', 'conceal', 'unmount']);
  assert.equal(frames.length, 0);
});

test('hiding with nothing shown does nothing, and a window already open when it is built is shown', t => {
  const a = setup();
  a.set(null);
  assert.deepEqual(a.log, []);

  const player = new Emitter();
  player.mixRating = RATING;
  const log = [];
  createMixRate(player, { mount: () => log.push('mount'), reveal: () => log.push('reveal'), conceal() {}, unmount() {} }, { frame: fn => fn() });
  assert.deepEqual(log, ['mount', 'reveal']);
});

test('destroying the control mid fade-out takes it out of the layout, and a queued frame no longer reveals it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fading = setup();
  fading.set(RATING); fading.frames.shift()();
  fading.set(null);
  fading.control.destroy();
  assert.deepEqual(fading.log, ['mount', 'reveal', 'conceal', 'unmount']);
  t.mock.timers.tick(FADE_MS * 2);
  assert.deepEqual(fading.log, ['mount', 'reveal', 'conceal', 'unmount'], 'the cancelled timer does not unmount twice');
  const early = setup();
  early.set(RATING);
  early.control.destroy();
  early.frames.shift()();
  assert.deepEqual(early.log, ['mount']);
});

test('thumbs go straight to the player, and destroy stops listening', t => {
  const { player, control, log, set } = setup();
  control.rate('good');
  control.rate('bad');
  assert.deepEqual(player.rated, ['good', 'bad']);
  control.destroy();
  set(RATING);
  assert.deepEqual(log, []);
});
