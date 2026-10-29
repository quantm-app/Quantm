import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
Object.getPrototypeOf(document.body).contains = () => false; // the fake DOM has no focus tracking
document.documentElement.dataset = { themeMotion: 'off' };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { Emitter, h } = await import('../src/js/dom.js');
const { mount } = await import('../src/js/packs/warehouse.js');
const find = (node, name) => node.className?.split(' ').includes(name) ? node : node.childNodes.map(child => find(child, name)).find(Boolean);

function setup(count, index) {
  const player = Object.assign(new Emitter(), {
    playing: false, current: null, index, duration: 0, audio: { currentTime: 0 },
    queue: Array.from({ length: count }, (_, i) => ({ id: i, title: `Song ${i}`, duration: 1000 })),
    autoMixStatus: () => ({}), jump(i) { this.jumped = i; }
  });
  player.current = player.queue[index] || null;
  let loader;
  const ctx = {
    player, store: new Emitter(), settings: {}, moments: new Emitter(),
    views: { override: (name, fn) => { loader = fn; } },
    on: (target, event, fn) => { target.on ? target.on(event, fn) : target.addEventListener(event, fn); }, frame() {}
  };
  const unmount = mount(ctx);
  return { player, loader: () => loader, unmount };
}

test('a huge queue only draws a window of rows around the current song, and follows it', async t => {
  const { player, loader, unmount } = setup(5000, 2500);
  t.after(unmount);
  const page = h('div');
  const dispose = (await loader()()).render(page);
  const list = find(page, 'wh-queue-list');
  const rows = () => list.childNodes.filter(node => node.className === 'wh-queue-row');
  assert.ok(rows().length <= 100, `drew ${rows().length} rows`);
  assert.equal(rows()[0].dataset.index, 2495);
  assert.match(list.childNodes.at(-1).childNodes[0].textContent, /MORE IN THE QUEUE/);
  rows()[7].dispatchEvent({ type: 'click' });
  assert.equal(player.jumped, 2502); // rows still map to their real queue position
  player.index = 10; // the song moves far out of the drawn window
  player.emit('track');
  assert.equal(rows()[0].dataset.index, 5);
  assert.equal(rows().length, 100);
  dispose();
});

test('a short queue draws every row, with no hint row', async t => {
  const { loader, unmount } = setup(12, 3);
  t.after(unmount);
  const page = h('div');
  (await loader()()).render(page);
  const list = find(page, 'wh-queue-list');
  assert.equal(list.childNodes.length, 12);
  assert.equal(list.childNodes[0].dataset.index, 0);
});
