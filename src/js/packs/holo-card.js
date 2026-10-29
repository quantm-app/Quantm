import { h, clear, artwork, compact, duration } from '../dom.js';
import { motionAllowed } from '../audio-reactivity.js';
import { button, likeButton, link, trackHref, errorState, isLocked, openInSoundCloud, openLabel } from '../ui.js';

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const smoothstep = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
const count = value => Number.isFinite(value) && value >= 0 ? compact(value) : '—';

// A decorative classification of the public like count; never an invented track statistic.
export function rarityFor(likes) {
  const n = Math.max(0, Number(likes) || 0);
  return n >= 10000 ? { name: 'Ultra', glyph: '✦', level: 'ultra' }
    : n >= 1000 ? { name: 'Rare', glyph: '◇', level: 'rare' }
      : { name: 'Common', glyph: '○', level: 'common' };
}

export function tempoFor(status, track) {
  if (!track) return null;
  const current = status.track?.id === track.id;
  const candidates = current
    ? [status.live?.bpm, status.structure?.grid?.bpm, status.memory?.bpm, status.plan?.grid?.bpm]
    : status.upNext?.track?.id === track.id ? [status.upNext.bpm] : [];
  return candidates.find(bpm => Number.isFinite(bpm) && bpm > 0) || null;
}

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
  ctx.on(ctx.moments, 'like', () => send('stats'));
  ctx.on(ctx.player, 'queue', () => send('queue'));
  ctx.on(ctx.player, 'time', () => send('time'));
  ctx.on(ctx.store, 'settings', () => send('motion'));
  ctx.on(reduced, 'change', () => send('motion'));
  ctx.on(document, 'visibilitychange', () => send('motion'));
  ctx.on(document, 'appvisibility', () => send('motion'));
  ctx.frame(frame => send('frame', frame));
  return () => { views.forEach(view => view.destroy()); views.clear(); };
}

function createCard(track, status) {
  const rarity = rarityFor(track?.likes_count);
  let knownTempo = tempoFor(status, track);
  const art = h('div.hc-art', h('div.hc-art-placeholder', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  // Only the player's ordinary artwork is used. The foil itself is entirely CSS.
  const src = artwork(track?.artwork_url || track?.user?.avatar_url, 't500x500');
  if (src) {
    const image = h('img', { src, alt: '', draggable: false });
    image.addEventListener('error', () => image.remove(), { once: true });
    art.append(image);
  }
  const glyph = h('span.hc-rarity-glyph', { 'aria-hidden': 'true' }, rarity.glyph);
  const rarityName = h('span', rarity.name);
  const rarityNode = h('span.hc-rarity', { title: 'Common: under 1,000 likes. Rare: 1,000–9,999. Ultra: 10,000 or more.' }, glyph, rarityName);
  const bpm = h('dd');
  const plays = h('dd');
  const likes = h('dd');
  const length = h('dd', track ? duration(track.duration) || '—' : '—');
  const node = h('article.hc-face', { dataset: { rarity: rarity.level } },
    h('header.hc-card-head', h('span', 'LISTENING EDITION'), rarityNode), art,
    h('div.hc-card-copy', h('h2.hc-title', track?.title || 'Your next discovery'),
      h('p.hc-artist', track?.user?.username || 'Choose a track. Find your frequency.'),
      h('dl.hc-stats', ...[['BPM', bpm], ['TIME', length], ['PLAYS', plays], ['LIKES', likes]].map(([label, value]) =>
        h('div', h('dt', label), value))),
      h('div.hc-card-foot', h('span', 'SOUND / IN FULL COLOR'), h('span', track ? `№ ${String(track.id).slice(-6)}` : '№ —'))));
  const refresh = nextStatus => {
    knownTempo = tempoFor(nextStatus, track) || knownTempo;
    bpm.textContent = knownTempo ? knownTempo.toFixed(1) : '—';
    bpm.title = knownTempo ? 'Tempo from Auto mix analysis or song memory' : 'Tempo not yet known';
    plays.textContent = track ? count(track.playback_count) : '—';
    likes.textContent = track ? count(track.likes_count) : '—';
    const next = rarityFor(track?.likes_count);
    node.dataset.rarity = next.level;
    glyph.textContent = next.glyph;
    rarityName.textContent = next.name;
  };
  refresh(status);
  return { node, track, refresh };
}

function renderHome(container, ctx, motion) {
  const { player } = ctx;
  let alive = true;
  let currentId;
  let front;
  let back;
  let mixKey = null;
  let flip = 0;
  let hue = 0;
  let lastStats = 0;
  let browseStarted = false;
  let browseCleanup;
  let tiltRaf = 0;
  let tiltTime = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const rotor = h('div.hc-rotor');
  const tilt = h('div.hc-tilt', rotor);
  const interactive = h('div.hc-interactive', tilt);
  const currentTitle = h('p.hc-current-title');
  const state = h('span.hc-playstate');
  const actions = h('div.hc-actions');
  const mixLabel = h('p.hc-mix-label', { role: 'status' });
  const queue = h('div.hc-queue-cards');
  const browse = h('section.hc-browse', { hidden: true, 'aria-label': 'Browse Home' });
  const browseButton = button('Browse music', showBrowse, 'btn-outline');
  browseButton.setAttribute('aria-expanded', 'false');
  const home = h('div.hc-home', h('header.hc-intro',
    h('div', h('p.hc-eyebrow', 'YOUR COLLECTION, IN A DIFFERENT LIGHT'), h('h1', 'A little more iridescent.')), browseButton),
  h('div.hc-home-grid', h('section.hc-now', { 'aria-label': 'Now playing' },
    h('div.hc-stage', interactive), h('div.hc-caption', state, currentTitle, actions), mixLabel,
    h('p.hc-help', 'Move over the art to catch the light. Playback controls stay in the player bar.')),
  h('aside.hc-queue', { 'aria-label': 'Play queue' }, h('div.hc-queue-head', h('h2', 'In the stack'), h('span.hc-eyebrow', 'UP NEXT')), queue)), browse);
  container.append(home);
  interactive.addEventListener('pointermove', move);
  interactive.addEventListener('pointerleave', leave);
  interactive.addEventListener('pointercancel', leave);

  function status() { return player.autoMixStatus?.() || {}; }
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
  function writePointer() {
    interactive.style.setProperty('--mx', pointer.x.toFixed(5));
    interactive.style.setProperty('--my', pointer.y.toFixed(5));
  }
  function easePointer(time) {
    tiltRaf = 0;
    if (!alive || !motion()) return;
    const dt = tiltTime ? Math.min(0.05, (time - tiltTime) / 1000) : 1 / 60;
    tiltTime = time;
    const ease = 1 - Math.exp(-dt * 13);
    pointer.x += (pointer.tx - pointer.x) * ease;
    pointer.y += (pointer.ty - pointer.y) * ease;
    const settled = Math.abs(pointer.tx - pointer.x) + Math.abs(pointer.ty - pointer.y) < 0.001;
    if (settled) { pointer.x = pointer.tx; pointer.y = pointer.ty; }
    writePointer();
    if (!settled) tiltRaf = requestAnimationFrame(easePointer);
    else tiltTime = 0;
  }
  function scheduleTilt() {
    if (!tiltRaf && motion()) tiltRaf = requestAnimationFrame(easePointer);
  }
  function move(event) {
    if (!motion() || event.pointerType === 'touch') return;
    const rect = interactive.getBoundingClientRect();
    pointer.tx = clamp((event.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
    pointer.ty = clamp((event.clientY - rect.top) / (rect.height || 1)) * 2 - 1;
    scheduleTilt();
  }
  function leave() { pointer.tx = 0; pointer.ty = 0; scheduleTilt(); }
  function setActiveFace() {
    const showBack = flip >= 90;
    for (const [card, active] of [[front, !showBack], [back, showBack]]) {
      if (!card) continue;
      card.node.inert = !active;
      card.node.setAttribute('aria-hidden', String(!active));
    }
  }
  function single(track, snapshot) {
    mixKey = null;
    back = null;
    front = createCard(track, snapshot);
    front.node.classList.add('hc-front');
    clear(rotor).append(front.node);
    flip = 0;
    rotor.style.setProperty('--hc-flip', '0deg');
    mixLabel.textContent = '';
    setActiveFace();
  }
  function updateMix(snapshot) {
    const mix = snapshot.mix;
    if (!mix?.from || !mix?.to) {
      if (mixKey) single(player.current, snapshot);
      return;
    }
    if (!motion()) {
      if (back || front?.track?.id !== mix.to.id) single(mix.to, snapshot);
      const label = `Mixing into ${mix.to.title || 'the next track'}`;
      if (mixLabel.textContent !== label) mixLabel.textContent = label;
      return;
    }
    const key = `${mix.from.id}:${mix.to.id}`;
    if (mixKey !== key) {
      mixKey = key;
      if (front?.track?.id !== mix.from.id) front = createCard(mix.from, snapshot);
      back = createCard(mix.to, snapshot);
      front.node.classList.add('hc-front');
      back.node.classList.add('hc-back');
      clear(rotor).append(front.node, back.node);
      mixLabel.textContent = `Mixing into ${mix.to.title || 'the next track'}`;
    }
    // Rotate through the bass-swap midpoint; progress is deck time, so pause freezes it.
    flip = 180 * smoothstep((clamp(mix.progress) - 0.32) / 0.36);
    rotor.style.setProperty('--hc-flip', `${flip.toFixed(3)}deg`);
    setActiveFace();
  }
  function syncState() {
    state.textContent = player.current ? player.playing ? 'NOW PLAYING' : 'PAUSED' : 'READY TO LISTEN';
  }
  function syncTrack() {
    const track = player.current;
    const snapshot = status();
    if (currentId !== (track?.id ?? null)) {
      currentId = track?.id ?? null;
      clear(currentTitle); clear(actions);
      if (track) {
        currentTitle.append(link(trackHref(track), track.title || 'Untitled'));
        actions.append(likeButton(track));
      } else currentTitle.textContent = 'Start a track to add some color.';
      if (snapshot.mix) updateMix(snapshot);
      else single(track, snapshot);
    }
    syncState(); syncQueue();
  }
  function syncStats(snapshot = status()) {
    front?.refresh(snapshot);
    back?.refresh(snapshot);
  }
  function syncQueue() {
    clear(queue);
    if (!player.queue?.length) {
      queue.append(h('p.hc-queue-empty', 'Your next tracks will appear here. Browse your library to build a stack.'));
      return;
    }
    const start = Math.max(0, player.index);
    player.queue.slice(start, start + 30).forEach((track, offset) => {
      const index = start + offset;
      const locked = isLocked(track);
      const rarity = rarityFor(track.likes_count);
      const row = h('button.hc-queue-card', {
        type: 'button', 'aria-current': index === player.index ? 'true' : null,
        title: locked ? `${openLabel(track)}: ${track.title}` : `Play ${track.title}`,
        onclick: () => locked ? openInSoundCloud(track) : player.jump(index)
      }, h('span.hc-queue-no', String(index + 1).padStart(2, '0')),
      h('span.hc-queue-meta', h('b', track.title || 'Untitled'), h('span', locked ? openLabel(track) : track.user?.username || 'Unknown artist')),
      h('span.hc-queue-end', h('span.hc-queue-glyph', { title: `${rarity.name} · based on like count` }, rarity.glyph), h('span', duration(track.duration))));
      row.style.setProperty('--fan', String((offset % 5 - 2) * 0.38));
      queue.append(row);
    });
    if (player.queue.length > start + 30) queue.append(h('p.hc-queue-more', 'More tracks in the player queue.'));
  }
  function syncMotion() {
    const allowed = motion();
    home.classList.toggle('hc-still', !allowed);
    if (!allowed) {
      cancelAnimationFrame(tiltRaf); tiltRaf = 0; tiltTime = 0;
      pointer.x = pointer.y = pointer.tx = pointer.ty = 0;
      hue = 0;
      writePointer();
      interactive.style.setProperty('--foil-hue', '0deg');
    }
    updateMix(status());
  }
  syncTrack(); syncMotion();
  return {
    track: syncTrack, state: syncState, queue: syncQueue, stats: syncStats, motion: syncMotion,
    time() { const snapshot = status(); updateMix(snapshot); syncStats(snapshot); },
    transition(event) {
      const snapshot = status();
      if (event.phase === 'start') updateMix({ ...snapshot, mix: snapshot.mix || { ...event, progress: 0 } });
      else single(player.current, snapshot);
    },
    frame(frame) {
      if (!frame.playing || !motion()) return;
      hue += ((frame.treble || 0) * 150 - hue) * (1 - Math.exp(-(frame.dt || 1 / 30) * 4));
      interactive.style.setProperty('--foil-hue', `${hue.toFixed(3)}deg`);
      const snapshot = status();
      updateMix(snapshot);
      if (frame.time - lastStats > 1000) { lastStats = frame.time; syncStats(snapshot); }
    },
    destroy() {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(tiltRaf);
      interactive.removeEventListener('pointermove', move);
      interactive.removeEventListener('pointerleave', leave);
      interactive.removeEventListener('pointercancel', leave);
      if (typeof browseCleanup === 'function') browseCleanup();
      home.remove();
    }
  };
}
