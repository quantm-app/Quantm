import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, resizeObservers } from './helpers/browser.js';

installBrowser();
const { Emitter } = await import('../src/js/dom.js');
const { cueEvents, addCue, setMixIn, setMixOut, _reset } = await import('../src/js/cues.js');
const { bindServices, waveform, playButton, trackRow, downloadButton, offlineTrackList, likeButton, repostButton, modal } = await import('../src/js/ui.js');
const { offline } = await import('../src/js/offline.js');
const { isDownloadable } = await import('../src/js/api.js');
const player = Object.assign(new Emitter(), { current: null, playing: false });
const store = Object.assign(new Emitter(), { isLiked: () => false, isReposted: () => false });
bindServices(store, player, { waveform: async () => null, isDownloadable });
const tracks = [{ id: 1, title: 'Track', duration: 10000 }];
const count = emitter => Object.values(emitter.handlers).reduce((total, handlers) => total + handlers.length, 0);

test('download controls honor artist permission, update progress and release row / page subscriptions', async () => {
  const baseline = count(offline);
  const track = { ...tracks[0], downloadable: true };
  assert.equal(downloadButton(tracks[0]), null);
  assert.equal(downloadButton({ ...track, has_downloads_left: false }), null);
  const row = trackRow([track], 0);
  const labeled = downloadButton(track, { labeled: true });
  const host = document.createElement('div');
  host.append(row, labeled);
  document.body.append(host);
  const control = row.childNodes.at(-1).firstChild;
  assert.equal(control.title, 'Download for offline');
  assert.equal(count(offline), baseline + 4);
  offline.progress.set('1', { received: 42, total: 100 });
  offline.emit('progress', '1', offline.progressOf(1));
  assert.equal(control.title, 'Cancel download');
  assert.equal(control.firstChild.firstChild.textContent, '42%');
  assert.equal(labeled.firstChild.firstChild.textContent, 'Downloading 42%');
  offline.progress.set('1', { received: 200, total: 100 });
  offline.emit('progress', 1);
  assert.equal(control.firstChild.firstChild.textContent, '100%');
  offline.progress.set('1', { received: 42, total: 0 });
  offline.emit('progress', 1);
  assert.equal(labeled.firstChild.firstChild.textContent, 'Downloading …');
  offline.progress.delete('1');
  offline.entries.set('1', { track });
  offline.emit('change');
  assert.equal(control.title, 'Remove download');
  assert.equal(labeled.childNodes.at(-1).firstChild.textContent, 'Downloaded');
  const savedOnly = downloadButton(tracks[0]);
  host.append(savedOnly);
  assert.ok(savedOnly);
  offline.entries.delete('1');
  offline.emit('change');
  assert.equal(savedOnly.hidden, true);
  host.remove();
  await Promise.resolve();
  assert.equal(count(offline), baseline);
});

test('clicking a downloading control cancels that track', async () => {
  const original = offline.cancel;
  const host = document.createElement('div');
  let canceled;
  try {
    offline.cancel = async id => { canceled = id; };
    offline.progress.set('1', { received: 0, total: 0 });
    const control = downloadButton({ ...tracks[0], downloadable: true });
    host.append(control);
    document.body.append(host);
    control.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(canceled, 1);
  } finally {
    offline.cancel = original;
    offline.progress.delete('1');
    host.remove();
    await Promise.resolve();
  }
});

test('offline startup rows play their list without account or social subscriptions', () => {
  const baseline = count(store);
  const original = player.playList;
  const listTracks = [...tracks, { id: 2, title: 'Second track', duration: 2000 }];
  let played;
  try {
    player.playList = (...args) => { played = args; };
    const list = offlineTrackList(listTracks);
    list.childNodes[1].dispatchEvent({ type: 'click' });
    assert.deepEqual(played, [listTracks, 1, { label: 'Offline', href: '#/library/offline' }]);
    assert.equal(count(store), baseline);
    assert.equal(list.firstChild.childNodes.length, 3);
  } finally {
    player.playList = original;
  }
});

test('removing a subtree releases waveform, row and button listeners without another player event', async () => {
  const baseline = { player: count(player), store: count(store), theme: document.listenerCount('themechange'), style: document.listenerCount('wavestylechange') };
  const cueBaseline = count(cueEvents);
  for (let i = 0; i < 3; i++) {
    const host = document.createElement('div');
    host.append(waveform(tracks[0]), playButton(() => tracks), trackRow(tracks, 0));
    document.body.append(host);
    assert.ok(count(player) > baseline.player);
    assert.ok(count(store) > baseline.store);
    assert.equal(count(cueEvents), cueBaseline + 1);
    assert.equal(document.listenerCount('themechange'), baseline.theme + 1);
    host.remove();
    await Promise.resolve();
    assert.equal(count(player), baseline.player);
    assert.equal(count(store), baseline.store);
    assert.equal(count(cueEvents), cueBaseline);
    assert.equal(document.listenerCount('themechange'), baseline.theme);
    assert.equal(document.listenerCount('wavestylechange'), baseline.style);
    assert.equal(resizeObservers.at(-1).disconnected, true);
  }
});

test('building detached components and moving connected components preserves subscriptions', async () => {
  const host = document.createElement('div');
  const target = document.createElement('div');
  const wave = waveform(tracks[0]);
  const before = count(player);
  await Promise.resolve();
  assert.equal(count(player), before);
  host.append(wave);
  document.body.append(host, target);
  target.append(wave);
  await Promise.resolve();
  assert.equal(count(player), before);
  assert.equal(resizeObservers.at(-1).disconnected, false);
  target.remove();
  host.remove();
  await Promise.resolve();
  assert.equal(count(player), before - 1);
  assert.equal(resizeObservers.at(-1).disconnected, true);
});

test('waveform markers update for their song and cue clicks seek to the exact media time', async () => {
  _reset();
  const wave = waveform(tracks[0]);
  document.body.append(wave);
  const markers = wave.childNodes[2];
  addCue(2, 2);
  assert.equal(markers.childNodes.length, 0);
  addCue(1, 1.25);
  setMixIn(1, 0);
  setMixOut(1, 9);
  assert.equal(markers.childNodes.length, 3);
  assert.equal(markers.childNodes[0].style.left, '12.5%');
  assert.equal(markers.childNodes[1].style.left, '0%');
  assert.equal(markers.childNodes[2].style.left, '90%');
  let sought;
  player.current = tracks[0];
  player.seek = t => { sought = t; };
  markers.childNodes[0].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(sought, 1.25);
  wave.remove();
  player.current = null;
  await Promise.resolve();
  _reset();
});

test('a like or repost that fails gives the count back', async () => {
  const item = { id: 5, kind: 'track', likes_count: 10, reposts_count: 3, user: { id: 9 } };
  store.me = { id: 1 };
  const like = likeButton(item, { withCount: true });
  const repost = repostButton(item, { withCount: true });
  store.toggleLike = async () => false; // the request failed: the store reports the heart is still off
  store.toggleRepost = async () => false;
  await like.dispatchEvent({ type: 'click', stopPropagation() {} });
  await repost.dispatchEvent({ type: 'click', stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.likes_count, 10);
  assert.equal(item.reposts_count, 3);
  store.toggleLike = async () => true; // it worked
  like.dispatchEvent({ type: 'click', stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.likes_count, 11);
});

test('Escape closes only the newest dialog', () => {
  const outer = modal('Outer', document.createElement('div'));
  const inner = modal('Inner', document.createElement('div'));
  const hidden = [];
  outer.classList.remove = () => hidden.push('outer');
  inner.classList.remove = () => hidden.push('inner');
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.deepEqual(hidden, ['inner']);
  hidden.length = 0;
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.deepEqual(hidden, ['outer']);
});

test('a waveform click on a song that is not playing seeks it only if it is still the song that loads', async () => {
  const audio = new Audio();
  const seeks = [];
  const saved = { audio: player.audio, seek: player.seek, playTrack: player.playTrack, duration: player.duration };
  Object.assign(player, { audio, duration: 100, seek: t => seeks.push(t), playTrack: async () => {} });
  const wave = waveform(tracks[0]);
  document.body.append(wave);
  const click = async () => {
    player.current = null;
    wave.dispatchEvent({ type: 'click', stopPropagation() {}, clientX: 0 });
    await Promise.resolve(); await Promise.resolve();
  };
  await click();
  player.current = { id: 999 }; // the user started another song before the first one's metadata arrived
  audio.dispatchEvent({ type: 'loadedmetadata' });
  assert.deepEqual(seeks, []);
  await click();
  player.current = tracks[0];
  audio.dispatchEvent({ type: 'loadedmetadata' });
  assert.equal(seeks.length, 1);
  wave.remove();
  Object.assign(player, saved);
  player.current = null;
});
