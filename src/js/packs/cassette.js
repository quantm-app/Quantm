import { h, clear, duration } from '../dom.js';
import { motionAllowed } from '../audio-reactivity.js';
import { button, likeButton, link, trackHref, userHref, errorState, isLocked, openInSoundCloud, openLabel } from '../ui.js';
import { createCassette, createMeter } from './cassette-deck.js';

export function mount(ctx) {
  const views = new Set();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => document.documentElement.dataset.themeMotion !== 'off' && motionAllowed(ctx.settings, reduced);
  const send = (method, ...args) => views.forEach(view => view[method]?.(...args));
  ctx.views.override('home', async () => ({ render(container) {
    const view = renderHome(container, ctx, motion);
    views.add(view);
    return () => { views.delete(view); view.destroy(); };
  } }));
  ctx.on(ctx.moments, 'trackchange', () => send('track'));
  ctx.on(ctx.moments, 'playstate', () => send('state'));
  ctx.on(ctx.moments, 'transition', event => send('transition', event));
  ctx.on(ctx.player, 'queue', () => send('queue'));
  ctx.on(ctx.player, 'time', () => send('time'));
  ctx.on(ctx.store, 'settings', () => send('motion'));
  ctx.on(reduced, 'change', () => send('motion'));
  ctx.on(document, 'visibilitychange', () => send('motion'));
  ctx.on(document, 'appvisibility', () => send('motion'));
  ctx.frame(frame => send('frame', frame));
  return () => { views.forEach(view => view.destroy()); views.clear(); };
}

function renderHome(container, ctx, motion) {
  const { player } = ctx;
  let alive = true;
  let currentId;
  let outgoing;
  let incoming;
  let mixKey;
  let browseStarted = false;
  let browseCleanup;
  const left = createMeter('L');
  const right = createMeter('R');
  const bay = h('div.cassette-bay');
  const title = h('h2.cassette-title');
  const artist = h('p.cassette-artist');
  const actions = h('div.cassette-actions');
  const elapsed = h('span', '0:00');
  const total = h('span', '0:00');
  const status = h('span.cassette-status');
  const mixLabel = h('p.cassette-mix-label', { role: 'status' });
  const queue = h('div.cassette-jcards');
  const browse = h('section.cassette-browse', { hidden: true, 'aria-label': 'Browse Home' });
  const browseButton = button('Browse music', showBrowse, 'btn-outline');
  browseButton.setAttribute('aria-expanded', 'false');
  const home = h('div.cassette-home',
    h('header.cassette-intro', h('div', h('p.cassette-eyebrow', 'THE LISTENING COLLECTION'),
      h('h1', 'Made for a full listen.')), browseButton),
    h('div.cassette-home-grid', h('section.cassette-now', { 'aria-label': 'Now playing' },
      h('div.cassette-machine', h('div.cassette-machine-top', h('b', 'TAPE DECK / 01'), status), bay,
        h('div.cassette-console', h('div.cassette-meters', left.node, right.node),
          h('div.cassette-keys', { 'aria-hidden': 'true' },
            ...['●', '◀◀', '▶', '▶▶', '■', 'Ⅱ'].map((key, i) => h(`span.cassette-key${i === 0 ? '.cassette-key-record' : ''}`, key)))),
        h('p.cassette-control-note', h('span.cassette-transport-bar', 'Transport controls are in the player bar.'),
          h('span.cassette-transport-side', 'Transport controls are in the Now playing panel on the right.'))),
      h('div.cassette-caption', title, artist, h('div.cassette-time', elapsed, h('span', '/'), total), actions), mixLabel),
    h('aside.cassette-queue', { 'aria-label': 'Play queue' },
      h('div.cassette-queue-heading', h('h2', 'The next side'), h('span.cassette-eyebrow', 'J-CARD INDEX')), queue)), browse);
  container.append(home);

  async function showBrowse() {
    browse.hidden = !browse.hidden;
    browseButton.setAttribute('aria-expanded', String(!browse.hidden));
    browseButton.textContent = browse.hidden ? 'Browse music' : 'Close Browse';
    if (browseStarted || browse.hidden) return;
    browseStarted = true;
    try {
      const module = await import('../views/home.js');
      if (!alive) return;
      const cleanup = await module.render(browse);
      if (!alive) { if (typeof cleanup === 'function') cleanup(); }
      else browseCleanup = cleanup;
    } catch (error) {
      if (alive) { browseStarted = false; browse.append(errorState(error)); }
    }
  }

  const mixStatus = () => player.autoMixStatus?.() || {};
  function setSingle(track) {
    mixKey = null;
    incoming = null;
    outgoing = createCassette(track);
    clear(bay).append(outgoing.shell);
    bay.classList.remove('cassette-mixing');
    bay.style.setProperty('--cassette-mix', '1');
    mixLabel.textContent = '';
    updateReels(true);
  }
  function setMix(mix) {
    if (!mix?.from || !mix?.to) return;
    const key = `${mix.from.id}:${mix.to.id}`;
    if (key !== mixKey) {
      mixKey = key;
      outgoing = createCassette(mix.from, 'A');
      incoming = createCassette(mix.to, 'B');
      outgoing.shell.classList.add('cassette-outgoing');
      incoming.shell.classList.add('cassette-incoming');
      clear(bay).append(outgoing.shell, incoming.shell);
    }
    const progress = Math.max(0, Math.min(1, Number(mix.progress) || 0));
    bay.classList.toggle('cassette-mixing', motion());
    bay.style.setProperty('--cassette-mix', motion() ? progress.toFixed(5) : '1');
    const label = `Mixing into ${mix.to.title || 'the next track'}`;
    if (mixLabel.textContent !== label) mixLabel.textContent = label;
    updateReels(false, mix);
  }
  function deckFor(track) {
    return player.decks?.find(deck => deck.track?.id === track?.id);
  }
  function lengthFor(deck, track) {
    const length = deck?.audio.duration;
    return Number.isFinite(length) && length > 0 ? length : (track?.duration || 0) / 1000;
  }
  function updateReels(initial = false, mix = null) {
    if (!motion() && !initial) return;
    if (incoming) {
      if (!mix) return;
      const from = deckFor(mix?.from);
      const to = deckFor(mix?.to);
      outgoing?.update(from?.audio.currentTime || 0, lengthFor(from, mix.from), motion());
      incoming.update(to?.audio.currentTime ?? player.audio?.currentTime ?? 0,
        lengthFor(to, mix.to) || player.duration || 0, motion());
    } else outgoing?.update(player.audio?.currentTime || 0, player.duration || 0, motion());
  }
  function syncTime() {
    elapsed.textContent = duration((player.audio?.currentTime || 0) * 1000);
    total.textContent = duration((player.duration || 0) * 1000);
    const mix = mixStatus().mix;
    if (mix) setMix(mix);
    else if (incoming) setSingle(player.current);
    else updateReels();
  }
  function syncState() {
    status.textContent = player.current ? player.playing ? 'PLAY / STEREO' : 'PAUSED' : 'READY';
    home.classList.toggle('cassette-playing', !!player.playing);
    if (!player.playing) { left.reset(); right.reset(); }
  }
  function syncTrack() {
    const track = player.current;
    if (currentId !== (track?.id ?? null)) {
      currentId = track?.id ?? null;
      clear(title); clear(artist); clear(actions);
      if (track) {
        title.append(link(trackHref(track), track.title || 'Untitled'));
        if (track.user) artist.append(link(userHref(track.user), track.user.username));
        actions.append(likeButton(track));
      } else {
        title.textContent = 'A blank tape. A world of music.';
        artist.textContent = 'Browse your music, or choose a track from your library.';
      }
      const mix = mixStatus().mix;
      if (mix) setMix(mix);
      else setSingle(track);
    }
    syncState(); syncTime(); syncQueue();
  }
  function syncQueue() {
    clear(queue);
    if (!player.queue?.length) {
      queue.append(h('p.cassette-queue-empty', 'Your queue will be filed here. Pick an album, a playlist, or a favorite.'));
      return;
    }
    const start = Math.max(0, player.index);
    player.queue.slice(start, start + 32).forEach((track, offset) => {
      const index = start + offset;
      const locked = isLocked(track);
      queue.append(h('button.cassette-jcard', {
        type: 'button', 'aria-current': index === player.index ? 'true' : null,
        title: locked ? `${openLabel(track)}: ${track.title}` : `Play ${track.title}`,
        onclick: () => locked ? openInSoundCloud(track) : player.jump(index)
      }, h('span.cassette-jcard-spine', String(index + 1).padStart(2, '0')),
      h('span.cassette-jcard-meta', h('b', track.title || 'Untitled'),
        h('span', locked ? openLabel(track) : track.user?.username || 'Unknown artist')),
      h('span.cassette-jcard-duration', duration(track.duration))));
    });
    if (player.queue.length > start + 32) queue.append(h('p.cassette-queue-more', 'More tracks in the player queue.'));
  }
  function syncMotion() {
    home.classList.toggle('cassette-still', !motion());
    if (!motion()) { left.reset(); right.reset(); }
    const mix = mixStatus().mix;
    if (mix) setMix(mix);
  }
  syncTrack(); syncMotion();
  return {
    track: syncTrack, time: syncTime, state: syncState, queue: syncQueue, motion: syncMotion,
    transition(event) {
      if (event.phase === 'start') setMix({ ...event, progress: mixStatus().mix?.progress || 0 });
      else { setSingle(player.current); syncTrack(); }
    },
    frame(frame) {
      if (!motion() || !frame.playing) return;
      const dt = frame.dt || 1 / 30;
      left.step(frame.level * 2.3 + frame.bass * 0.48, dt);
      right.step(frame.level * 2.1 + frame.mid * 0.38 + frame.treble * 0.18, dt);
      const mix = mixStatus().mix;
      if (mix) setMix(mix);
      else updateReels();
    },
    destroy() {
      if (!alive) return;
      alive = false;
      if (typeof browseCleanup === 'function') browseCleanup();
      home.remove();
    }
  };
}
