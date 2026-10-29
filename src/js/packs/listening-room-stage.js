import { h, clear, artwork, duration } from '../dom.js';
import { player } from '../player.js';
import { store, settings, safeParse } from '../store.js';
import * as api from '../api.js';
import { icon } from '../icons.js';
import { motionAllowed } from '../audio-reactivity.js';
import { button, iconButton, likeButton, addToPlaylistDialog, trackMenu, link, trackHref, userHref, toast, errorState, isLocked, openInSoundCloud, openLabel, lockedHint } from '../ui.js';

export function render(container) {
  container.classList.add('lr-stage');
  let alive = true;
  let trackId;
  let browseCleanup;
  let browseStarted = false;
  let imageVersion = 0;
  const off = [];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => motionAllowed(settings, reduced);
  const listen = (target, name, fn) => {
    if (target.on) off.push(target.on(name, fn));
    else { target.addEventListener(name, fn); off.push(() => target.removeEventListener(name, fn)); }
  };
  const image = h('div.lr-art-images');
  const bloom = h('span.lr-heart', { 'aria-hidden': 'true' }, icon('heartFilled', 100));
  const art = h('div.lr-art', image, bloom);
  const title = h('h1.lr-title');
  const artist = h('div.lr-artist');
  const actions = h('div.lr-actions');
  const empty = h('div.lr-empty');
  const elapsed = h('span', '0:00');
  const total = h('span', '0:00');
  const seek = h('input.lr-seek', {
    type: 'range', min: '0', max: '1', step: '1', value: '0', 'aria-label': 'Seek in current track',
    oninput: () => { player.seek(Number(seek.value)); syncTime(); },
    onkeydown: e => {
      if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        player.seekBy(['ArrowLeft', 'ArrowDown'].includes(e.key) ? -5 : 5);
        syncTime();
      }
    }
  });
  const play = iconButton('play', 'Play', () => player.toggle(), 'lr-play');
  const prev = iconButton('prev', 'Previous track', () => player.prev());
  const next = iconButton('next', 'Next track', () => player.next());
  const transport = h('div.lr-transport',
    h('div.lr-controls', prev, play, next),
    h('div.lr-timeline', seek, h('div.lr-times', elapsed, total))
  );
  const now = h('section.lr-now', { 'aria-label': 'Now playing' }, art, title, artist, actions, transport, empty);
  const queue = h('div.lr-queue-list');
  const browse = h('section.lr-browse', { hidden: true, 'aria-label': 'Browse Home' });
  const browseButton = button('Browse', () => showBrowse(), 'btn-outline');
  browseButton.setAttribute('aria-expanded', 'false');
  container.append(
    h('header.lr-header', h('div', h('p.lr-eyebrow', 'YOUR LISTENING ROOM'), h('p.muted', 'Settle in. Stay a while.')), browseButton),
    h('div.lr-stage-grid', now, h('aside.lr-queue', { 'aria-label': 'Queue' }, h('h2', 'Up next'), queue)), browse
  );
  async function showBrowse() {
    browse.hidden = !browse.hidden;
    browseButton.setAttribute('aria-expanded', String(!browse.hidden));
    browseButton.textContent = browse.hidden ? 'Browse' : 'Close Browse';
    if (browseStarted || browse.hidden) return;
    browseStarted = true;
    try {
      const home = await import('../views/home.js');
      if (!alive) return;
      const cleanup = await home.render(browse);
      if (!alive) { if (typeof cleanup === 'function') cleanup(); }
      else browseCleanup = cleanup;
    } catch (error) { if (alive) browse.append(errorState(error)); }
  }
  function syncTime() {
    const seconds = player.audio.currentTime || 0;
    const length = Math.max(0, player.duration || 0);
    seek.max = String(length || 1);
    seek.value = String(Math.min(seconds, length));
    seek.disabled = !length;
    seek.setAttribute('aria-valuetext', `${duration(seconds * 1000)} of ${duration(length * 1000)}`);
    elapsed.textContent = duration(seconds * 1000);
    total.textContent = duration(length * 1000);
  }
  function syncState() {
    const playing = player.playing;
    art.classList.toggle('lr-paused', !playing);
    clear(play).append(icon(playing ? 'pause' : 'play', 30));
    play.title = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
    for (const control of [prev, play, next]) control.disabled = !player.current;
    syncTime();
  }
  function syncMotion() {
    container.classList.toggle('lr-still', !motion());
    if (!motion()) {
      for (const animation of art.getAnimations({ subtree: true })) animation.cancel();
      while (image.children.length > 1) image.firstChild.remove();
    }
  }
  function syncTrack() {
    const track = player.current;
    if (trackId === (track?.id ?? null)) { syncState(); return; }
    trackId = track?.id ?? null;
    const version = ++imageVersion;
    clear(title); clear(artist); clear(actions); clear(empty);
    if (track) {
      const src = artwork(track.artwork_url || track.user?.avatar_url, 't500x500');
      const cover = src ? h('img', { src, alt: `Artwork for ${track.title}`, draggable: false }) : h('div.lr-art-placeholder', icon('logo', 96));
      const reveal = () => {
        if (!alive || version !== imageVersion) return;
        const old = [...image.children];
        image.append(cover);
        if (motion() && old.length) {
          const animation = cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: 'ease' });
          animation.onfinish = () => old.forEach(node => node.remove());
        } else old.forEach(node => node.remove());
      };
      if (src) { cover.addEventListener('load', reveal, { once: true }); cover.addEventListener('error', () => { if (!alive || version !== imageVersion) return; clear(image).append(h('div.lr-art-placeholder', icon('logo', 96))); }, { once: true }); }
      else reveal();
      title.append(link(trackHref(track), track.title));
      if (track.user) artist.append(link(userHref(track.user), track.user.username));
      actions.append(likeButton(track),
        iconButton('addToPlaylist', 'Add to playlist', () => addToPlaylistDialog(track)),
        iconButton('more', 'More track actions', e => trackMenu(track, e)));
    } else {
      clear(image).append(h('div.lr-art-placeholder', icon('logo', 96)));
      title.textContent = 'Make yourself at home';
      artist.textContent = 'Choose something to fill the room.';
      const session = safeParse(localStorage.getItem('quantm.session'));
      if (settings.resumeSession !== false && session.queue?.[session.index]) empty.append(button('Resume last session', () => {
        const ready = player.on('buffering', waiting => {
          if (!waiting) { ready(); if (alive) player.play(); }
        });
        off.push(ready);
        if (!player.restoreSession()) ready();
      }, 'btn-primary', 'play'));
      empty.append(button('Play Likes', async () => {
        try {
          const tracks = await api.myTrackLikes(store.me.id).next();
          if (!alive) return;
          if (!tracks.length) { toast('Your Likes are empty. Browse to find something you love.'); return; }
          player.playList(tracks, 0, { label: 'Likes', href: '#/library/likes' });
        } catch (error) { toast('Could not load your Likes. Please try again.', 'error'); }
      }, 'btn-outline', 'heart'), button('Browse music', () => { if (browse.hidden) showBrowse(); }, 'btn-outline'));
    }
    syncState();
    syncQueue();
  }
  function syncQueue() {
    clear(queue);
    if (!player.queue.length) { queue.append(h('p.muted', 'Your next songs will appear here.')); return; }
    // the current song and what comes after it; long queues (all your Likes) stay cheap to redraw
    const start = Math.max(0, player.index);
    player.queue.slice(start, start + 51).forEach((track, offset) => {
      const index = start + offset;
      // a label-protected song opens in SoundCloud instead (jumping to it would only skip it)
      const locked = isLocked(track);
      const row = h('button.lr-queue-row', {
        onclick: () => locked ? openInSoundCloud(track) : player.jump(index), 'aria-current': index === player.index ? 'true' : null,
        title: locked ? `${lockedHint(track)} (${track.title})` : null
      },
        h('span.lr-queue-number', locked ? icon('lock', 12) : String(index + 1)),
        h('span.lr-queue-meta', h('span', track.title), h('span.muted', locked ? openLabel(track) : track.user?.username || '')),
        h('span.muted', duration(track.duration)));
      row.classList.toggle('current', index === player.index);
      queue.append(row);
    });
  }
  listen(player, 'track', syncTrack);
  listen(player, 'queue', syncQueue);
  listen(player, 'state', syncState);
  listen(player, 'time', syncTime);
  listen(store, 'change', (key, id, liked) => {
    if (key !== 'likedTracks' || id !== player.current?.id || !liked || !motion()) return;
    bloom.getAnimations().forEach(a => a.cancel());
    bloom.animate([
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.65)' },
      { opacity: 0.65, offset: 0.35, transform: 'translate(-50%, -50%) scale(1)' },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.35)' }
    ], { duration: 1000, easing: 'ease-out' });
  });
  listen(store, 'settings', syncMotion);
  listen(document, 'appvisibility', syncMotion);
  listen(document, 'visibilitychange', syncMotion);
  listen(reduced, 'change', syncMotion);
  syncMotion(); syncTrack(); syncQueue();
  return () => {
    alive = false; ++imageVersion;
    off.forEach(fn => fn());
    art.getAnimations({ subtree: true }).forEach(a => a.cancel());
    if (typeof browseCleanup === 'function') browseCleanup();
  };
}
