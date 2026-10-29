// Shared UI components. Every view builds its pages from these.
import { h, clear, compact, duration, timeAgo, artwork, coverOf, onNearBottom } from './dom.js';
import { icon } from './icons.js';
import * as localPlaylists from './local-playlists.js';
import { offline } from './offline.js';
import { isExternal, isExternalId, isBandcamp, sourceLabel } from './sources.js';
import { getCues, addCue, removeCue, renameCue, setMixIn, setMixOut, cueEvents, getPair, setPair, transitionFor } from './cues.js';
import { formatCueTime, parseCueTime } from './cue-time.js';
import { settings } from './store.js'; // only read when a menu opens, so the store <-> ui import cycle is safe

// Lazy imports avoid circular-import timing issues (store/player import ui.js)
let _store, _player, _api;
const store = () => _store;
const player = () => _player;
export function bindServices(s, p, a) { _store = s; _player = p; _api = a; }

// One observer releases external subscriptions for removed components, even while
// playback is paused. Weak keys do not retain elements; moves within the DOM survive.
const removalCleanups = new WeakMap();
let removalObserver;
function onRemoved(el, cleanup) {
  if (!removalObserver) {
    const visit = (node) => {
      if (node.isConnected) return;
      const callbacks = removalCleanups.get(node);
      if (callbacks) {
        removalCleanups.delete(node);
        callbacks.forEach(fn => fn());
      }
      node.childNodes.forEach(visit);
    };
    removalObserver = new MutationObserver(records => {
      records.forEach(record => record.removedNodes.forEach(visit));
    });
    removalObserver.observe(document, { childList: true, subtree: true });
  }
  const callbacks = removalCleanups.get(el) || [];
  callbacks.push(cleanup);
  removalCleanups.set(el, callbacks);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export const go = (hash) => { location.hash = hash; };
// Audius and Bandcamp songs have no SoundCloud page: null leaves a link without an address
export const userHref = (user) => isExternalId(user.id) ? null : '#/user/' + user.id;
export const trackHref = (track) => isExternal(track) || isExternalId(track.id) ? null : '#/track/' + track.id;
export const playlistHref = (playlist) =>
  playlist.kind === 'system-playlist' ? '#/station/' + encodeURIComponent(playlist.urn) : '#/playlist/' + playlist.id;

export function link(href, text, cls = '') {
  return h('a.link' + (cls ? '.' + cls : ''), { href, onclick: (e) => e.stopPropagation() }, text);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, type = 'info') {
  let host = document.getElementById('toasts');
  if (!host) host = document.body.appendChild(h('div#toasts'));
  host.id = 'toasts';
  const el = h('div.toast.toast-' + type, message);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export function iconButton(name, title, onclick, cls = '') {
  return h('button.icon-btn' + (cls ? '.' + cls : ''), { title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onclick(e); } }, icon(name));
}

export function button(label, onclick, cls = '', iconName = null) {
  return h('button.btn' + (cls ? '.' + cls : ''), { onclick: (e) => { e.stopPropagation(); onclick(e); } }, iconName ? icon(iconName, 18) : null, label ? h('span', label) : null);
}

/** Shared row / track-page control. The main process verifies artist permission. */
export function downloadButton(track, { labeled = false } = {}) {
  if (isExternal(track)) return null;
  if (!(_api?.isDownloadable?.(track) || offline.has(track.id))) return null;
  const btn = h('button.' + (labeled ? 'btn' : 'icon-btn') + '.download-btn', {
    onclick: (e) => { e.stopPropagation(); downloadAction(track); }
  });
  const render = () => {
    const saved = offline.has(track.id);
    const downloading = offline.isDownloading(track.id);
    const p = offline.progressOf(track.id);
    const percent = p?.total > 0 ? Math.max(0, Math.min(100, Math.floor(p.received / p.total * 100))) : null;
    const progressText = percent == null ? '…' : percent + '%';
    btn.hidden = !saved && !_api?.isDownloadable?.(track);
    btn.title = downloading ? 'Cancel download' : saved ? 'Remove download' : 'Download for offline';
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('downloaded', saved);
    clear(btn).append(downloading ? h('span.download-progress', progressText) : icon(saved ? 'checkCircle' : 'download', 18));
    if (labeled) {
      if (downloading) clear(btn);
      btn.append(h('span', downloading ? 'Downloading ' + progressText : saved ? 'Downloaded' : 'Download'));
    }
  };
  const offs = [offline.on('change', render), offline.on('progress', id => {
    if (String(id) === String(track.id)) render();
  })];
  onRemoved(btn, () => offs.forEach(off => off()));
  render();
  return btn;
}

async function downloadAction(track) {
  try {
    if (offline.isDownloading(track.id)) return await offline.cancel(track.id);
    if (offline.has(track.id)) {
      if (!await confirmDialog('Remove download?', track.title, 'Remove download', true)) return;
      await offline.remove(track.id);
      toast('Removed download');
    } else if (_api?.isDownloadable?.(track)) {
      const result = await offline.download(track);
      toast(result.ok ? `Downloaded ${track.title}` : result.error, result.ok ? 'info' : 'error');
    }
  } catch (error) {
    toast(error.message || 'Download failed', 'error');
  }
}

export async function removeAllDownloads() {
  if (!await confirmDialog('Remove all downloads?', 'Remove all saved tracks from this computer?', 'Remove all downloads', true)) return;
  try {
    await offline.removeAll();
    toast('Removed downloads');
  } catch (error) {
    toast(error.message || 'Could not remove downloads', 'error');
  }
}

/** Account-free list for startup without a connection. Click or keyboard plays a row. */
export function offlineTrackList(tracks) {
  const context = { label: 'Offline', href: '#/library/offline' };
  return h('div.track-list', tracks.map((track, index) => h('button.offline-track', {
    onclick: () => player().playList(tracks, index, context)
  },
  h('span.track-art', { style: { backgroundImage: coverOf(track, 't300x300') ? `url("${coverOf(track, 't300x300')}")` : '' } }),
  h('span.track-meta', h('span.track-title', track.title), h('span.muted', track.user?.username || '')),
  h('span.track-duration', duration(track.full_duration || track.duration))
  )));
}

/** Heart that stays in sync with the store everywhere it appears */
export function likeButton(item, { withCount = false, cls = '' } = {}) {
  if (isExternal(item)) return null; // likes are SoundCloud's
  const btn = h('button.icon-btn.like-btn' + (cls ? '.' + cls : ''), { title: 'Like' });
  const render = () => {
    const liked = store().isLiked(item);
    clear(btn).append(icon(liked ? 'heartFilled' : 'heart'));
    if (withCount && item.likes_count != null) btn.append(h('span.count', compact(item.likes_count)));
    btn.classList.toggle('active', liked);
    btn.title = liked ? 'Unlike' : 'Like';
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const was = store().isLiked(item);
    if (item.likes_count != null) item.likes_count += was ? -1 : 1;
    render();
    // the store puts the heart back and says so when the request fails: undo the count as well
    if (await store().toggleLike(item) === was && item.likes_count != null) { item.likes_count += was ? 1 : -1; render(); }
  });
  watchStore(btn, render);
  render();
  return btn;
}

export function repostButton(item, { withCount = false } = {}) {
  if (isExternal(item)) return null;
  const btn = h('button.icon-btn.repost-btn', { title: 'Repost' });
  const render = () => {
    const on = store().isReposted(item);
    clear(btn).append(icon('repost'));
    if (withCount && item.reposts_count != null) btn.append(h('span.count', compact(item.reposts_count)));
    btn.classList.toggle('active', on);
    btn.title = on ? 'Remove repost' : 'Repost';
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (item.user && item.user.id === store().me.id) return toast("You can't repost your own track");
    const was = store().isReposted(item);
    if (item.reposts_count != null) item.reposts_count += was ? -1 : 1;
    render();
    if (await store().toggleRepost(item) === was && item.reposts_count != null) { item.reposts_count += was ? 1 : -1; render(); }
  });
  watchStore(btn, render);
  render();
  return btn;
}

export function followButton(user) {
  const btn = h('button.btn.follow-btn');
  const render = () => {
    const on = store().isFollowing(user.id);
    btn.textContent = on ? 'Following' : 'Follow';
    btn.classList.toggle('btn-primary', !on);
    btn.classList.toggle('btn-outline', on);
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); store().toggleFollow(user); });
  btn.addEventListener('mouseenter', () => { if (store().isFollowing(user.id)) btn.textContent = 'Unfollow'; });
  btn.addEventListener('mouseleave', render);
  if (store().me && user.id === store().me.id) return h('span');
  watchStore(btn, render);
  render();
  return btn;
}

/** Re-render el when store sets change; stops once el leaves the DOM */
function watchStore(el, render) {
  onRemoved(el, store().on('change', render));
}

/** Play/pause button bound to a list of tracks */
export function playButton(getTracks, index = 0, context = null, cls = 'play-btn') {
  const btn = h('button.' + cls, { title: 'Play' }, icon('play', 22));
  const isThis = () => {
    const tracks = getTracks();
    const p = player();
    return p.current && tracks[index] && p.current.id === tracks[index].id && (!context || !p.context || p.context.href === context.href);
  };
  const render = () => {
    const playing = isThis() && player().playing;
    clear(btn).append(icon(playing ? 'pause' : 'play', 22));
    btn.title = playing ? 'Pause' : 'Play';
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const tracks = await Promise.resolve(getTracks());
    if (isThis()) player().toggle();
    else if (tracks.length) player().playList(tracks, index, context);
  });
  const offs = [player().on('state', render), player().on('track', render)];
  onRemoved(btn, () => offs.forEach(off => off()));
  render();
  return btn;
}

// ---------------------------------------------------------------------------
// Waveform (canvas)
// ---------------------------------------------------------------------------

/**
 * Waveform for a track. When the track is playing it shows progress and is seekable;
 * clicking an idle waveform starts the track at that position.
 * onSeek(fraction) is called instead of playing when given.
 */
export function waveform(track, { height = 60, onPlay, comments = null } = {}) {
  const wrap = h('div.waveform', { style: { height: height + 'px' } });
  const canvas = h('canvas');
  const commentLayer = h('div.wave-comments');
  const markers = h('div.wave-markers');
  wrap.append(canvas, commentLayer, markers);
  let samples = null;
  let hover = -1;

  const trackSeconds = () => player().current?.id === track.id && player().duration ? player().duration : track.duration / 1000;
  const renderMarkers = () => {
    clear(markers);
    const seconds = trackSeconds();
    if (!seconds) return;
    const data = getCues(track.id);
    const marker = (t, label, kind) => {
      if (t == null || t > seconds) return;
      markers.append(h('button.wave-marker.' + kind, {
        style: { left: Math.min(100, t / seconds * 100) + '%' },
        title: `${label} · ${formatCueTime(t)}`,
        'aria-label': `${label} at ${formatCueTime(t)}`,
        onclick: (e) => { e.stopPropagation(); if (player().current?.id === track.id) player().seek(t); }
      }, label));
    };
    data.cues.forEach((cue, i) => marker(cue.t, String(i + 1), 'cue'));
    marker(data.mixIn, 'IN', 'mix-in');
    marker(data.mixOut, 'OUT', 'mix-out');
  };
  renderMarkers();
  const offCues = cueEvents.on('change', id => { if (String(id) === String(track.id)) { renderMarkers(); draw(); } });

  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = wrap.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * trackSeconds();
    if (!Number.isFinite(t)) return;
    const data = getCues(track.id);
    const nearest = data.cues.reduce((best, cue, i) => best < 0 || Math.abs(cue.t - t) < Math.abs(data.cues[best].t - t) ? i : best, -1);
    menu([
      { label: `Add cue point here · ${formatCueTime(t)}`, onclick: () => addCueHere(track.id, t) },
      { label: `Set mix-in here · ${formatCueTime(t)}`, onclick: () => setMixIn(track.id, t) },
      { label: `Set mix-out here · ${formatCueTime(t)}`, onclick: () => setMixOut(track.id, t) },
      nearest >= 0 && { label: `Remove nearest cue point · ${formatCueTime(data.cues[nearest].t)}`, onclick: () => removeCue(track.id, nearest) },
      data.mixIn != null && { label: `Clear mix-in · ${formatCueTime(data.mixIn)}`, onclick: () => setMixIn(track.id, null) },
      data.mixOut != null && { label: `Clear mix-out · ${formatCueTime(data.mixOut)}`, onclick: () => setMixOut(track.id, null) }
    ], e);
  });

  const draw = () => {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const styles = getComputedStyle(document.documentElement);
    const played = styles.getPropertyValue('--wave-played').trim();
    const unplayed = styles.getPropertyValue('--wave').trim();
    const p = player();
    const progress = p.current && p.current.id === track.id && p.duration ? p.audio.currentTime / p.duration : 0;

    // style and bar thickness come from Settings → Appearance
    const style = document.documentElement.dataset.wave || 'bars';
    const bar = Math.max(1, Number(styles.getPropertyValue('--wave-bar')) || 2);
    const gap = style === 'blocks' ? 2 : 1;
    const count = Math.floor(rect.width / (bar + gap));
    const data = samples || new Array(count).fill(0.15);
    const sampleAt = (i) => data[Math.floor((i / count) * data.length)] || 0;
    const colorAt = (fraction) => fraction < progress ? played : (hover > -1 && fraction < hover ? played : unplayed);

    if (style === 'line') {
      // smooth filled outline, split into played / unplayed halves
      const path = new Path2D();
      path.moveTo(0, height);
      for (let i = 0; i <= count; i++) path.lineTo((i / count) * rect.width, height - Math.max(1, sampleAt(i) * (height - 2)));
      path.lineTo(rect.width, height);
      path.closePath();
      const split = (hover > -1 ? Math.max(progress, hover) : progress) * rect.width;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, split, height); ctx.clip();
      ctx.fillStyle = played; ctx.fill(path);
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.rect(split, 0, rect.width - split, height); ctx.clip();
      ctx.fillStyle = unplayed; ctx.fill(path);
      ctx.restore();
      return;
    }

    const mid = style === 'mirror' ? height / 2 : height * 0.7;
    for (let i = 0; i < count; i++) {
      const sample = sampleAt(i);
      const x = i * (bar + gap);
      const fraction = i / count;
      ctx.fillStyle = colorAt(fraction);
      ctx.globalAlpha = fraction >= progress && hover > -1 && fraction < hover ? 0.6 : 1;
      if (style === 'mirror') {
        const half = Math.max(1, sample * (height / 2 - 1));
        ctx.fillRect(x, mid - half, bar, half * 2);
      } else if (style === 'blocks') {
        // stacked square blocks, like an LED meter
        const block = bar + 1;
        const blocks = Math.max(1, Math.round((sample * height) / block));
        for (let b = 0; b < blocks; b++) ctx.fillRect(x, height - (b + 1) * block, bar, block - 1);
      } else {
        const top = Math.max(1, sample * mid);
        ctx.fillRect(x, mid - top, bar, top);
        ctx.globalAlpha *= 0.35;
        ctx.fillRect(x, mid + 1, bar, Math.max(1, sample * (height - mid)));
      }
      ctx.globalAlpha = 1;
    }
  };

  wrap.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    hover = (e.clientX - r.left) / r.width;
    draw();
  });
  wrap.addEventListener('mouseleave', () => { hover = -1; draw(); });
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = wrap.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const p = player();
    if (p.current && p.current.id === track.id) {
      p.seek(fraction * p.duration);
    } else {
      const start = onPlay ? onPlay() : p.playTrack(track);
      Promise.resolve(start).then(() => {
        // only if this song is still the one loading (the user may have started another meanwhile)
        p.audio.addEventListener('loadedmetadata', () => { if (p.current && p.current.id === track.id) p.seek(fraction * p.duration); }, { once: true });
      });
    }
  });

  const renderComments = (list) => {
    clear(commentLayer);
    if (!list || !track.duration) return;
    list.filter(c => c.timestamp != null).slice(0, 200).forEach((comment) => {
      const left = Math.min(99, (comment.timestamp / track.duration) * 100);
      commentLayer.append(h('img.wave-comment', {
        src: artwork(comment.user.avatar_url, 'badge') || '',
        style: { left: left + '%' },
        title: `${comment.user.username}: ${comment.body}`
      }));
    });
  };
  if (comments) renderComments(comments);
  wrap.setComments = renderComments;

  _api.waveform(track).then((data) => { samples = data; draw(); }).catch(() => {});
  const observer = new ResizeObserver(draw);
  observer.observe(wrap);
  const onTime = () => {
    if (!wrap.isConnected) return;
    if (document.documentElement.hasAttribute('data-hidden')) return;
    if (player().current && player().current.id === track.id) draw();
  };
  const offTime = player().on('time', onTime);
  document.addEventListener('themechange', draw);
  document.addEventListener('wavestylechange', draw);
  onRemoved(wrap, () => {
    observer.disconnect();
    offCues();
    offTime();
    document.removeEventListener('themechange', draw);
    document.removeEventListener('wavestylechange', draw);
  });
  return wrap;
}

// ---------------------------------------------------------------------------
// Track rows / lists
// ---------------------------------------------------------------------------

export const LOCKED_HINT = "Copy-protected by the label: Quantm can't play this song. Use Open in SoundCloud to play it there.";
export const BANDCAMP_HINT = "Quantm can't play Bandcamp songs. Use Open on Bandcamp to listen there.";

/** Songs Quantm can't stream: label-protected ones (SoundCloud's own app plays them) and Bandcamp entries */
export function isLocked(track) {
  return isBandcamp(track) || !!(_api && _api.isProtected && _api.isProtected(track));
}

export const lockedHint = (track) => isBandcamp(track) ? BANDCAMP_HINT : LOCKED_HINT;
/** "Open on Bandcamp" / "Open in SoundCloud" */
export const openLabel = (track) => isBandcamp(track) ? 'Open on Bandcamp' : sourceLabel(track) === 'Audius' ? 'Open on Audius' : 'Open in SoundCloud';

/** Opens the song's own page, whichever site it is from */
export function openInSoundCloud(track) {
  if (track && track.permalink_url) window.native.openExternal(track.permalink_url);
}

/** A small "Audius" / "Bandcamp" tag for songs that aren't from SoundCloud, nothing for SoundCloud ones */
export function sourceBadge(track) {
  return isExternal(track) ? h('span.source-badge.source-' + track.source, { title: `This copy is from ${sourceLabel(track)}` }, sourceLabel(track)) : null;
}

const userLink = (user, cls) => isExternalId(user.id) ? h('span.' + cls.split(' ').join('.'), user.username) : link(userHref(user), user.username, cls);

/**
 * A row in a track list. tracks + index give it a play queue.
 * opts: { context, showArt, showWave, number, extraActions: (track) => [elements] }
 */
export function trackRow(tracks, index, opts = {}) {
  const track = tracks[index];
  const p = player();
  const row = h('div.track-row', { dataset: { id: track.id } });
  const locked = isLocked(track);
  if (locked) {
    row.classList.add('protected');
    row.title = lockedHint(track);
  }
  const cover = h('div.track-art', { style: { backgroundImage: coverOf(track, 't300x300') ? `url("${coverOf(track, 't300x300')}")` : '' } },
    h('div.track-art-overlay', icon('play', 18)));

  const meta = h('div.track-meta',
    h('a.track-title', { href: trackHref(track), onclick: (e) => e.stopPropagation() },
      locked ? h('span.track-lock', icon(isBandcamp(track) ? 'external' : 'lock', 12)) : null, track.title),
    h('div.track-sub',
      track.user ? userLink(track.user, 'muted') : null,
      sourceBadge(track),
      opts.reason ? h('span.track-reason', opts.reason) : null
    )
  );

  const stats = h('div.track-stats',
    track.playback_count != null ? h('span.stat', { title: 'Plays' }, icon('play', 12), compact(track.playback_count)) : null,
    track.genre ? h('span.tag-pill', track.genre) : null
  );

  const actions = h('div.track-actions',
    locked && track.permalink_url
      ? iconButton('external', openLabel(track), (e) => { e.stopPropagation(); openInSoundCloud(track); }, 'track-open-sc')
      : null,
    downloadButton(track),
    likeButton(track),
    repostButton(track),
    iconButton('addToPlaylist', 'Add to playlist', () => addToPlaylistDialog(track)),
    iconButton('more', 'More', (e) => trackMenu(track, e, { ...opts, tracks, index, context: opts.context })),
    ...(opts.extraActions ? opts.extraActions(track) : [])
  );

  // native append() would print "null" for skipped cells, so filter them out
  row.append(...[
    opts.number ? h('div.track-num', String(index + 1)) : null,
    cover,
    h('div.track-main', meta, opts.showWave ? waveform(track, { height: 44, onPlay: () => p.playList(tracks, index, opts.context) }) : null),
    stats,
    h('div.track-duration', duration(track.full_duration || track.duration)),
    actions
  ].filter(Boolean));

  const play = () => {
    if (track.unavailable) return toast('This track is unavailable');
    return opts.onPlay ? opts.onPlay(track) : p.toggleOrPlay(tracks, index, opts.context);
  };
  if (track.unavailable) {
    row.classList.add('qplaylist-unavailable');
    row.querySelector('.track-sub').append(h('span.muted.small', 'Unavailable'));
  }
  row.addEventListener('dblclick', play);
  cover.addEventListener('click', (e) => { e.stopPropagation(); play(); });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(track, e, { ...opts, tracks, index, context: opts.context }); });

  const sync = () => {
    const isCurrent = p.current && p.current.id === track.id;
    row.classList.toggle('current', !!isCurrent);
    row.classList.toggle('playing', !!(isCurrent && p.playing));
    clear(cover.firstChild).append(icon(isCurrent && p.playing ? 'pause' : 'play', 18));
  };
  sync();
  const offs = [p.on('track', sync), p.on('state', sync)];
  onRemoved(row, () => offs.forEach(off => off()));
  return row;
}

/**
 * Infinite-scrolling track list fed by an api Pager.
 *   trackList(pager, { context, showWave, empty: 'No tracks' })
 * Returns the element; el.tracks holds loaded tracks.
 */
export function trackList(pager, opts = {}) {
  const list = h('div.track-list' + (opts.showWave ? '.with-wave' : ''));
  const tracks = [];
  list.tracks = tracks;
  const spinnerEl = spinner();
  list.append(spinnerEl);

  // the play context can load the whole collection, so shuffle covers all of it. Fetch it in big
  // pages without drawing every row (1,000 likes is ~5 requests instead of ~34); fall back to paging the list.
  let loading = null;
  let everything = null;
  const loadAll = async () => {
    if (pager.done) return tracks;
    if (everything) return everything;
    try {
      const fast = new _api.Pager(pager.resource, Object.assign({}, pager.params, { limit: 200 }), pager.map);
      fast.afterLoad = pager.afterLoad;
      const all = [];
      const seen = new Set();
      for (let pages = 0; !fast.done && pages < 100; pages++) {
        for (const t of await fast.next()) {
          if (t && t.kind === 'track' && !seen.has(t.id)) { seen.add(t.id); all.push(t); }
        }
      }
      everything = all;
      return all;
    } catch (e) {
      while (!pager.done) await loadMore();
      return tracks;
    }
  };
  opts = Object.assign({}, opts, { context: Object.assign({}, opts.context, { loadAll }) });
  list.loadAll = loadAll;
  list.context = opts.context;

  const loadMore = () => {
    // one page at a time, even when scrolling and loadAll overlap
    if (!loading) loading = loadPage().finally(() => { loading = null; });
    return loading;
  };

  const loadPage = async () => {
    if (pager.done) return;
    try {
      const items = await pager.next();
      const start = tracks.length;
      tracks.push(...items.filter(t => t && t.kind === 'track'));
      for (let i = start; i < tracks.length; i++) list.insertBefore(trackRow(tracks, i, opts), spinnerEl);
      if (!tracks.length && pager.done) list.insertBefore(emptyState(opts.empty || 'Nothing here yet'), spinnerEl);
    } catch (error) {
      list.insertBefore(errorState(error), spinnerEl);
      pager.done = true;
    }
    if (pager.done) spinnerEl.remove();
  };

  list.loadMore = loadMore;
  loadMore().then(() => {
    const scroller = document.getElementById('view');
    const off = onNearBottom(scroller, loadMore);
    const stop = () => { if (!list.isConnected) { off(); window.removeEventListener('hashchange', stop); } };
    window.addEventListener('hashchange', stop);
  });
  return list;
}

/** Static list for an array of tracks */
export function staticTrackList(tracks, opts = {}) {
  const list = h('div.track-list' + (opts.showWave ? '.with-wave' : ''));
  list.tracks = tracks;
  if (!tracks.length) list.append(emptyState(opts.empty || 'No tracks'));
  tracks.forEach((t, i) => list.append(trackRow(tracks, i, opts)));
  return list;
}

// ---------------------------------------------------------------------------
// Feed-style track card (big waveform, used in Feed and profiles)
// ---------------------------------------------------------------------------

/** item: a track, or a stream item { type, track|playlist, user, created_at } */
export function feedItem(tracks, index, opts = {}) {
  const item = opts.items ? opts.items[index] : null;
  const track = tracks[index];
  const p = player();
  const header = item && item.type && item.type.endsWith('repost') && item.user
    ? h('div.feed-header', icon('repost', 14), link(userHref(item.user), item.user.username), ' reposted', h('span.muted', ' · ' + timeAgo(item.created_at)))
    : item && item.created_at ? h('div.feed-header', link(userHref(track.user), track.user.username), ' posted a track', h('span.muted', ' · ' + timeAgo(item.created_at))) : null;

  const cover = h('div.feed-art', { style: { backgroundImage: coverOf(track) ? `url("${coverOf(track)}")` : '' } });
  const playBtn = playButton(() => tracks, index, opts.context, 'play-btn.play-btn-lg');
  const card = h('article.feed-card',
    header,
    h('div.feed-body',
      cover,
      h('div.feed-content',
        h('div.feed-top',
          playBtn,
          h('div.feed-titles',
            track.user ? link(userHref(track.user), track.user.username, 'muted') : null,
            h('a.feed-title', { href: trackHref(track) }, track.title)
          ),
          h('div.feed-right',
            h('span.muted.small', timeAgo(track.display_date || track.created_at)),
            track.genre ? h('span.tag-pill', '#' + track.genre) : null
          )
        ),
        waveform(track, { height: 64, onPlay: () => p.playList(tracks, index, opts.context) }),
        h('div.feed-actions',
          likeButton(track, { withCount: true }),
          repostButton(track, { withCount: true }),
          iconButton('addToPlaylist', 'Add to playlist', () => addToPlaylistDialog(track)),
          iconButton('link', 'Copy link', () => { window.native.copy(track.permalink_url); toast('Link copied'); }),
          iconButton('more', 'More', (e) => trackMenu(track, e, { ...opts, tracks, index })),
          h('div.spacer'),
          track.playback_count != null ? h('span.stat', icon('play', 12), compact(track.playback_count)) : null,
          track.comment_count != null ? h('a.stat', { href: trackHref(track) }, icon('comment', 12), compact(track.comment_count)) : null
        )
      )
    )
  );
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(track, e, { ...opts, tracks, index }); });
  return card;
}

// ---------------------------------------------------------------------------
// Cards (playlists, albums, users, stations) and shelves
// ---------------------------------------------------------------------------

// Playlists without their own artwork use their first track's artwork, like soundcloud.com.
// Library listings don't include tracks, so this may need to fetch the playlist (cached).
const coverCache = new Map();

export function playlistCover(playlist, size = 't500x500') {
  const own = playlist.artwork_url || playlist.calculated_artwork_url;
  if (own) return Promise.resolve(artwork(own, size));
  const key = playlist.id || playlist.urn;
  if (!coverCache.has(key)) {
    coverCache.set(key, (async () => {
      let tracks = playlist.tracks || [];
      if (!tracks.some(t => t.artwork_url) && playlist.id) {
        const full = await _api.get('playlists/' + playlist.id);
        tracks = full.tracks || [];
      }
      let first = tracks.find(t => t.artwork_url);
      if (!first && tracks.length) {
        // stub tracks have no artwork: hydrate the first few
        first = (await _api.tracksByIds(tracks.slice(0, 5).map(t => t.id))).find(t => t.artwork_url);
      }
      return first ? first.artwork_url : (playlist.user && playlist.user.avatar_url) || null;
    })().catch(() => null));
  }
  return coverCache.get(key).then(url => artwork(url, size));
}

/** Set an element's background to the playlist cover once it's known */
export function applyPlaylistCover(el, playlist, size) {
  playlistCover(playlist, size).then((url) => {
    if (url) {
      el.style.backgroundImage = `url("${url}")`;
      el.classList.add('has-cover');
    }
  });
}

export function playlistCard(playlist) {
  const href = playlistHref(playlist);
  const play = h('button.card-play', { title: 'Play' }, icon('play', 20));
  play.addEventListener('click', async (e) => {
    e.stopPropagation();
    const full = playlist.kind === 'system-playlist' ? await _api.stationTracks(playlist.urn) : await _api.playlist(playlist.id);
    player().playList(full.tracks, 0, { label: full.title, href });
  });
  const subtitle = playlist.kind === 'system-playlist'
    ? (playlist.short_description || playlist.description || 'Station')
    : [playlist.is_album ? (playlist.set_type || 'Album') : 'Playlist', playlist.user && playlist.user.username].filter(Boolean).join(' · ');
  const art = h('div.card-art.playlist-art', icon('playlist', 40), play);
  applyPlaylistCover(art, playlist);
  return h('a.card', { href },
    art,
    h('div.card-title', playlist.short_title || playlist.title),
    h('div.card-sub', subtitle)
  );
}

export function trackCard(tracks, index, context) {
  const track = tracks[index];
  const cover = coverOf(track);
  const play = h('button.card-play', { title: 'Play' }, icon('play', 20));
  play.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); player().toggleOrPlay(tracks, index, context); });
  const card = h('a.card', { href: trackHref(track) },
    h('div.card-art', { style: { backgroundImage: cover ? `url("${cover}")` : '' } }, play),
    h('div.card-title', track.title),
    h('div.card-sub', track.user ? track.user.username : '')
  );
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(track, e, { tracks, index, context }); });
  return card;
}

export function userCard(user) {
  return h('a.card.user-card', { href: userHref(user) },
    h('div.card-art.round', { style: { backgroundImage: user.avatar_url ? `url("${artwork(user.avatar_url, 't300x300')}")` : '' } }),
    h('div.card-title', user.username, user.verified ? icon('verified', 14) : null),
    h('div.card-sub', compact(user.followers_count) + ' followers'),
    followButton(user)
  );
}

/** Pick the right card for any api item */
export function cardFor(item, siblings, index, context) {
  if (!item) return null;
  if (item.kind === 'user') return userCard(item);
  if (item.kind === 'track') return trackCard(siblings, index, context);
  if (item.kind === 'playlist' || item.kind === 'system-playlist') return playlistCard(item);
  return null;
}

/** Horizontal scrolling row of cards with a title */
export function shelf(title, items, { href, subtitle, context } = {}) {
  const tracks = items.filter(i => i && i.kind === 'track');
  const row = h('div.shelf-row');
  items.forEach((item) => {
    const card = item.kind === 'track' ? trackCard(tracks, tracks.indexOf(item), context) : cardFor(item);
    if (card) row.append(card);
  });
  const scroll = (dir) => row.scrollBy({ left: dir * row.clientWidth * 0.8, behavior: 'smooth' });
  return h('section.shelf',
    h('div.shelf-head',
      h('div', h('h2.shelf-title', href ? h('a', { href }, title) : title), subtitle ? h('div.muted.small', subtitle) : null),
      h('div.shelf-nav', iconButton('back', 'Scroll left', () => scroll(-1)), iconButton('forward', 'Scroll right', () => scroll(1)))
    ),
    row
  );
}

/** Grid of cards fed by a Pager (infinite scroll) */
export function cardGrid(pager, { empty = 'Nothing here yet', context } = {}) {
  const grid = h('div.card-grid');
  const wrap = h('div', grid);
  const items = [];
  const spinnerEl = spinner();
  wrap.append(spinnerEl);
  const loadMore = async () => {
    if (pager.done) return;
    try {
      const batch = await pager.next();
      items.push(...batch);
      const tracks = items.filter(i => i.kind === 'track');
      batch.forEach((item) => {
        const card = item.kind === 'track' ? trackCard(tracks, tracks.indexOf(item), context) : cardFor(item);
        if (card) grid.append(card);
      });
      if (!items.length && pager.done) wrap.insertBefore(emptyState(empty), spinnerEl);
    } catch (error) {
      wrap.insertBefore(errorState(error), spinnerEl);
      pager.done = true;
    }
    if (pager.done) spinnerEl.remove();
  };
  loadMore().then(() => {
    const off = onNearBottom(document.getElementById('view'), loadMore);
    const stop = () => { if (!wrap.isConnected) { off(); window.removeEventListener('hashchange', stop); } };
    window.addEventListener('hashchange', stop);
  });
  return wrap;
}

/** Infinite list of users (followers, likers...) as rows */
export function userList(pager, { empty = 'No one here yet' } = {}) {
  const list = h('div.user-list');
  const spinnerEl = spinner();
  list.append(spinnerEl);
  let count = 0;
  const loadMore = async () => {
    if (pager.done) return;
    try {
      const users = await pager.next();
      users.forEach((user) => {
        count++;
        list.insertBefore(h('a.user-row', { href: userHref(user) },
          avatar(user, 48),
          h('div.user-row-meta',
            h('div.user-row-name', user.username, user.verified ? icon('verified', 14) : null),
            h('div.muted.small', [user.city, user.country_code].filter(Boolean).join(', ') || ' '),
            h('div.muted.small', icon('users', 12), ' ', compact(user.followers_count), '  ', icon('feed', 12), ' ', compact(user.track_count))
          ),
          followButton(user)
        ), spinnerEl);
      });
      if (!count && pager.done) list.insertBefore(emptyState(empty), spinnerEl);
    } catch (error) {
      list.insertBefore(errorState(error), spinnerEl);
      pager.done = true;
    }
    if (pager.done) spinnerEl.remove();
  };
  loadMore().then(() => {
    const off = onNearBottom(document.getElementById('view'), loadMore);
    const stop = () => { if (!list.isConnected) { off(); window.removeEventListener('hashchange', stop); } };
    window.addEventListener('hashchange', stop);
  });
  return list;
}

export function avatar(user, size = 40) {
  const src = user && user.avatar_url ? artwork(user.avatar_url, size > 100 ? 't500x500' : 't67x67') : '';
  return h('div.avatar', { style: { width: size + 'px', height: size + 'px', backgroundImage: src ? `url("${src}")` : '' } });
}

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

/** Standard page title block */
export function pageHeader(title, { subtitle, actions } = {}) {
  return h('header.page-header',
    h('div', h('h1.page-title', title), subtitle ? h('div.page-subtitle', subtitle) : null),
    actions ? h('div.page-actions', actions) : null
  );
}

/**
 * Tab bar. tabs: [{ id, label, href }] — the tab matching `active` is highlighted.
 * Uses hrefs so tabs are routable.
 */
export function tabs(list, active) {
  return h('nav.tabs', list.map(t => h('a.tab' + (t.id === active ? '.active' : ''), { href: t.href }, t.label)));
}

/** Big hero header for track / playlist / user pages, blurred artwork behind */
export function hero({ image, round = false, eyebrow, title, subtitle, meta, actions, banner }) {
  const bg = banner || image;
  const art = h('div.hero-art' + (round ? '.round' : ''), { style: { backgroundImage: image ? `url("${image}")` : '' } });
  if (image) {
    Object.assign(art, { tabIndex: 0, title: 'View full size' });
    art.setAttribute('role', 'button');
    art.classList.add('zoomable');
    art.addEventListener('click', () => showArtwork(image));
    art.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showArtwork(image); } });
  }
  return h('section.hero',
    h('div.hero-bg', { style: { backgroundImage: bg ? `url("${bg}")` : '' } }),
    h('div.hero-inner',
      art,
      h('div.hero-text',
        eyebrow ? h('div.hero-eyebrow', eyebrow) : null,
        h('h1.hero-title', title),
        subtitle ? h('div.hero-subtitle', subtitle) : null,
        meta ? h('div.hero-meta', meta) : null,
        actions ? h('div.hero-actions', actions) : null
      )
    )
  );
}

/** Artwork at its original upload size (falls back to the 500px version, which always exists) */
export function showArtwork(url) {
  const fallback = artwork(url, 't500x500');
  const candidates = [artwork(url, 'original'), artwork(url, 'original').replace(/\.jpg$/, '.png'), fallback];
  const img = h('img.artwork-full', { alt: 'Artwork', draggable: false });
  let attempt = 0;
  img.addEventListener('error', () => { if (++attempt < candidates.length) img.src = candidates[attempt]; });
  img.src = candidates[0];
  const close = () => {
    overlay.classList.remove('show');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), 200);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const overlay = h('div.artwork-overlay', { onclick: close, title: 'Click or press Esc to close' }, img);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
}

export function spinner() {
  return h('div.spinner-wrap', h('div.spinner'));
}

export function emptyState(text, iconName = 'cloud') {
  return h('div.empty', icon(iconName, 40), h('p', text));
}

export function errorState(error) {
  const status = error && error.status;
  const text = status === 401 ? 'Your SoundCloud login expired. Sign in again from Settings.'
    : status === 429 ? 'SoundCloud is rate limiting requests. Try again in a little while.'
    : status === 404 ? 'This page doesn\'t exist or is private.'
    : 'Something went wrong loading this.';
  return h('div.empty.error', icon('cloud', 40), h('p', text));
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

/** items: [{ label, icon, onclick, danger }] or 'separator' */
export function menu(items, event) {
  closeMenus();
  const el = h('div.menu', items.filter(Boolean).map(item => item === 'separator'
    ? h('div.menu-sep')
    : h('button.menu-item' + (item.danger ? '.danger' : ''), { onclick: () => { closeMenus(); item.onclick(); } },
        item.icon ? icon(item.icon, 16) : h('span.icon'), h('span', item.label))));
  document.body.appendChild(el);
  const x = event.clientX || (event.target.getBoundingClientRect().left);
  const y = event.clientY || (event.target.getBoundingClientRect().bottom);
  const rect = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  setTimeout(() => {
    document.addEventListener('click', closeMenus, { once: true });
    document.addEventListener('contextmenu', closeMenus, { once: true });
  }, 0);
  return el;
}

export function closeMenus() {
  document.querySelectorAll('.menu').forEach(m => m.remove());
}

export function trackMenu(track, event, opts = {}) {
  const p = player();
  const external = isExternal(track);
  const locked = isBandcamp(track); // can't be played here, only opened
  menu([
    !external && (offline.has(track.id) || _api?.isDownloadable?.(track)) ? {
      label: offline.isDownloading(track.id) ? 'Cancel download' : offline.has(track.id) ? 'Remove download' : 'Download for offline',
      icon: offline.has(track.id) ? 'checkCircle' : 'download', onclick: () => downloadAction(track)
    } : null,
    !locked ? { label: 'Play next', icon: 'next', onclick: () => p.playNext(track) } : null,
    !locked ? { label: 'Add to queue', icon: 'queue', onclick: () => p.addToQueue(track) } : null,
    !locked && opts.tracks && settings.autoMix ? { label: 'Mix from here', icon: 'mixOrder', onclick: () => p.mixFrom(opts.tracks, opts.index, opts.context || null) } : null,
    !locked ? { label: 'Mix points…', onclick: () => mixPointsDialog(track) } : null,
    // the SoundCloud playlists need a SoundCloud song, so for the others this only offers Quantm playlists
    { label: external ? 'Add to Quantm playlist' : 'Add to playlist', icon: 'addToPlaylist', onclick: () => addToPlaylistDialog(track) },
    !external ? { label: 'Add to Quantm playlist', icon: 'playlist', onclick: () => addToPlaylistDialog(track) } : null,
    track.station_urn ? { label: 'Start station', icon: 'station', onclick: () => go('#/station/' + encodeURIComponent(track.station_urn)) } : null,
    !external ? 'separator' : null,
    !external ? { label: store().isLiked(track) ? 'Unlike' : 'Like', icon: 'heart', onclick: () => store().toggleLike(track) } : null,
    !external ? { label: store().isReposted(track) ? 'Remove repost' : 'Repost', icon: 'repost', onclick: () => store().toggleRepost(track) } : null,
    'separator',
    !external ? { label: 'Go to track', icon: 'feed', onclick: () => go(trackHref(track)) } : null,
    track.user && !isExternalId(track.user.id) ? { label: 'Go to artist', icon: 'user', onclick: () => go(userHref(track.user)) } : null,
    track.permalink_url ? { label: 'Copy link', icon: 'link', onclick: () => { window.native.copy(track.permalink_url); toast('Link copied'); } } : null,
    track.permalink_url ? { label: external ? openLabel(track) : 'Open on SoundCloud', icon: 'external', onclick: () => window.native.openExternal(track.permalink_url) } : null,
    ...(opts.menuItems ? ['separator', ...opts.menuItems(track)] : [])
  ], event);
}

// ---------------------------------------------------------------------------
// Modal dialogs
// ---------------------------------------------------------------------------

export function addCueHere(id, t) {
  const number = addCue(id, t);
  toast(number ? `Cue ${number} added at ${formatCueTime(t)}` : 'All 9 cue slots are used');
}

function cueTimeField(label, value, placeholder) {
  const input = h('input.input', { value: value == null ? '' : formatCueTime(value), placeholder, 'aria-label': label });
  return { input, row: h('label.cue-field', h('span.field-label', label), input) };
}

function readCueField(field, track) {
  const value = parseCueTime(field.input.value, track.duration);
  field.input.setCustomValidity(Number.isNaN(value) ? 'Enter m:ss or seconds within the song’s duration.' : '');
  if (Number.isNaN(value)) field.input.reportValidity();
  return value;
}

export function transitionDialog(from, to) {
  const pair = getPair(from.id, to.id);
  const defaults = transitionFor(from.id, to.id, player().crossfadeSeconds());
  const fade = defaults.custom || defaults.fade ? defaults.fade : 6;
  const out = cueTimeField(`Leave ${from.title} at`, pair?.out, getCues(from.id).mixOut == null ? 'end' : formatCueTime(getCues(from.id).mixOut));
  const into = cueTimeField(`Start ${to.title} at`, pair?.in, formatCueTime(getCues(to.id).mixIn || 0));
  const range = h('input', { type: 'range', min: 0, max: 20, step: 0.5, value: fade, 'aria-label': 'Fade' });
  const number = h('input.input.cue-fade-number', { type: 'number', min: 0, max: 20, step: 0.5, value: fade, 'aria-label': 'Fade seconds' });
  const style = h('select.input', { 'aria-label': 'Transition style' },
    [['', 'Use setting'], ['auto', 'Auto'], ['blend', 'Smooth blend'], ['dropcut', 'Drop cut']].map(([value, label]) =>
      h('option', { value, selected: (pair?.style || '') === value }, label)));
  range.addEventListener('input', () => { number.value = range.value; });
  number.addEventListener('input', () => { if (number.value !== '' && number.validity.valid) range.value = number.value; });
  const save = (songs) => {
    const leave = readCueField(out, from);
    if (Number.isNaN(leave)) return;
    const start = readCueField(into, to);
    if (Number.isNaN(start)) return;
    if (number.value === '' || !number.reportValidity()) return;
    if (songs) {
      setMixOut(from.id, leave == null ? getCues(from.id).mixOut : leave);
      setMixIn(to.id, start == null ? getCues(to.id).mixIn : start);
      setPair(from.id, to.id, null);
    } else setPair(from.id, to.id, { out: leave, in: start, fade: Number(number.value), style: style.value });
    dialog.close();
  };
  const dialog = modal(`Transition: ${from.title} → ${to.title}`, h('div.cue-editor',
    out.row, into.row,
    h('label.cue-field', h('span.field-label', 'Transition style'), style),
    h('label.cue-field', h('span.field-label', 'Fade'), h('span.cue-fade', range, number, 's')),
    h('p.muted.small', 'Blank times use the songs’ mix points. Saving as song mix points uses the default fade; the fade above is saved for this pair only.'),
    h('p.muted.small', 'Drop cut uses a confirmed drop at or after the start marker. Leave time starts its build; fade length applies to smooth blends.'),
    h('div.modal-actions',
      button('Cancel', () => dialog.close(), 'btn-ghost'),
      button('Reset', () => { setPair(from.id, to.id, null); dialog.close(); }, 'btn-ghost'),
      button('Save as the songs’ mix points', () => save(true), 'btn-outline'),
      button('Save for this pair', () => save(false), 'btn-primary')
    )
  ));
}

export function mixPointsDialog(track) {
  const data = getCues(track.id);
  const into = cueTimeField('Mix-in', data.mixIn, '0:00');
  const out = cueTimeField('Mix-out', data.mixOut, 'end');
  const list = h('div.cue-list');
  const render = () => {
    clear(list);
    const cues = getCues(track.id).cues;
    if (!cues.length) list.append(h('p.muted.small', 'No cue points. Press C while playing or right-click a waveform to add one.'));
    cues.forEach((cue, i) => {
      const name = h('input.input', { value: cue.label, placeholder: `Cue ${i + 1}`, maxLength: 40, 'aria-label': `Cue ${i + 1} label` });
      list.append(h('div.cue-list-row',
        button(`${i + 1} · ${formatCueTime(cue.t)}`, () => {
          if (player().current?.id === track.id) player().seek(cue.t);
          else toast('Play this song to jump to its cue points');
        }, 'btn-ghost'), name,
        button('Rename', () => renameCue(track.id, i, name.value), 'btn-ghost'),
        button('Delete', () => removeCue(track.id, i), 'btn-ghost')
      ));
    });
  };
  render();
  const off = cueEvents.on('change', id => { if (String(id) === String(track.id)) render(); });
  const dialog = modal(`Mix points: ${track.title}`, h('div.cue-editor',
    into.row, out.row, h('p.muted.small', 'Leave a mix point blank to clear it.'),
    h('h3', 'Cue points'), list,
    h('div.modal-actions',
      button('Cancel', () => dialog.close(), 'btn-ghost'),
      button('Save', () => {
        const start = readCueField(into, track);
        if (Number.isNaN(start)) return;
        const leave = readCueField(out, track);
        if (Number.isNaN(leave)) return;
        setMixIn(track.id, start);
        setMixOut(track.id, leave);
        dialog.close();
      }, 'btn-primary')
    )
  ), { onClose: off });
  onRemoved(dialog, off);
}

const openModals = []; // newest last: Escape closes only the top one
export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => {
    overlay.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    const at = openModals.indexOf(overlay);
    if (at !== -1) openModals.splice(at, 1);
    setTimeout(() => overlay.remove(), 200);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && openModals[openModals.length - 1] === overlay) close(); };
  const overlay = h('div.modal-overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h('div.modal' + (wide ? '.wide' : ''),
      h('div.modal-head', h('h2', title), iconButton('close', 'Close', close)),
      h('div.modal-body', body)
    )
  );
  document.body.appendChild(overlay);
  openModals.push(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('show'));
  overlay.close = close;
  return overlay;
}

export function confirmDialog(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    const dialog = modal(title, h('div',
      h('p.muted', message),
      h('div.modal-actions',
        button('Cancel', () => dialog.close(), 'btn-ghost'),
        button(confirmLabel, () => { answered = true; resolve(true); dialog.close(); }, danger ? 'btn-danger' : 'btn-primary')
      )
    ), { onClose: () => { if (!answered) resolve(false); } });
  });
}

export function promptDialog(title, { label = '', value = '', placeholder = '', confirmLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input.input', { value, placeholder });
    const submit = () => { answered = true; resolve(input.value.trim()); dialog.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const dialog = modal(title, h('div',
      label ? h('label.field-label', label) : null,
      input,
      h('div.modal-actions', button('Cancel', () => dialog.close(), 'btn-ghost'), button(confirmLabel, submit, 'btn-primary'))
    ), { onClose: () => { if (!answered) resolve(null); } });
    setTimeout(() => input.focus(), 50);
  });
}

/**
 * Add a track to one of your playlists, or create a new one.
 * Toggling a playlist that already has the track removes it.
 */
export async function addToPlaylistDialog(track) {
  if (!track) return;
  const external = isExternal(track);
  const localList = h('div.atp-list');
  const renderLocal = () => {
    clear(localList);
    localPlaylists.list().forEach(pl => {
      const has = pl.tracks.some(t => t.id === track.id);
      localList.append(h('button.atp-row' + (has ? '.added' : ''), {
        onclick: () => {
          try {
            const added = localPlaylists.toggleTrack(pl.id, track);
            toast(added ? `Added to "${pl.title}"` : `Removed from "${pl.title}"`);
          } catch (error) { toast(error.message, 'error'); }
        }
      }, icon('playlist', 18), h('div.atp-row-meta', h('div.strong', pl.title), h('div.muted.small', `${pl.tracks.length} tracks`)),
      h('span.atp-state', icon(has ? 'check' : 'plus', 18))));
    });
  };
  renderLocal();
  const offLocal = localPlaylists.events.on('change', renderLocal);
  const newLocal = button('New Quantm playlist', async () => {
    const title = await promptDialog('New Quantm playlist', { label: 'Title', confirmLabel: 'Create & add' });
    if (!title) return;
    try {
      const pl = localPlaylists.create(title, [track]);
      toast(`Added to "${pl.title}"`);
    } catch (error) { toast(error.message, 'error'); }
  }, 'btn-outline', 'plus');
  const listEl = h('div.atp-list', spinner());
  const filter = h('input.input', { placeholder: 'Find a playlist' });
  const titleInput = h('input.input', { placeholder: 'New playlist title' });
  const privateBox = h('input', { type: 'checkbox' });

  const createBtn = button('Create & add', async () => {
    const title = titleInput.value.trim();
    if (!title) return titleInput.focus();
    createBtn.disabled = true;
    try {
      await _api.createPlaylist(title, [track.id], privateBox.checked ? 'private' : 'public');
      store().playlistChanged();
      toast(`Created "${title}" and added the track`);
      dialog.close();
    } catch (e) {
      toast("Couldn't create the playlist", 'error');
      createBtn.disabled = false;
    }
  }, 'btn-primary');

  const dialog = modal('Add to playlist', h('div.atp',
    h('div.atp-track', h('div.atp-art', { style: { backgroundImage: coverOf(track, 't67x67') ? `url("${coverOf(track, 't67x67')}")` : '' } }),
      h('div', h('div.strong', track.title), h('div.muted.small', track.user ? track.user.username : ''))),
    h('h3', 'Quantm playlists (on this PC)'),
    localList, newLocal,
    // Audius and Bandcamp songs can't go into SoundCloud playlists
    external ? null : h('h3', 'SoundCloud playlists'),
    external ? null : filter,
    external ? null : listEl,
    external ? null : h('div.atp-create',
      h('div.field-label', 'Create a new playlist'),
      h('div.atp-create-row', titleInput, createBtn),
      h('label.checkbox', privateBox, ' Make it private')
    )
  ));

  onRemoved(dialog, offLocal);
  if (external) return;

  let playlists;
  try {
    playlists = await store().getMyPlaylists();
  } catch (e) {
    clear(listEl).append(errorState(e));
    return;
  }

  const coverEl = (pl) => {
    const el = h('div.atp-art.playlist-art', icon('playlist', 18));
    applyPlaylistCover(el, pl, 't67x67');
    return el;
  };
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    clear(listEl);
    const shown = playlists.filter(pl => !q || pl.title.toLowerCase().includes(q));
    if (!shown.length) listEl.append(h('div.muted.small.atp-empty', playlists.length ? 'No playlists match' : 'You have no playlists yet. Create one below.'));
    shown.forEach((pl) => {
      const has = (pl.tracks || []).some(t => t.id === track.id);
      const row = h('button.atp-row' + (has ? '.added' : ''),
        coverEl(pl),
        h('div.atp-row-meta', h('div.strong', pl.title), h('div.muted.small', `${pl.track_count} tracks${pl.sharing === 'private' ? ' · Private' : ''}`)),
        h('span.atp-state', icon(has ? 'check' : 'plus', 18))
      );
      row.addEventListener('click', async () => {
        row.disabled = true;
        try {
          const full = await _api.get('playlists/' + pl.id);
          const ids = (full.tracks || []).map(t => t.id);
          const already = ids.includes(track.id);
          const next = already ? ids.filter(id => id !== track.id) : ids.concat(track.id);
          const updated = await _api.setPlaylistTracks(pl.id, next);
          pl.tracks = next.map(id => ({ id }));
          pl.track_count = updated && updated.track_count != null ? updated.track_count : next.length;
          toast(already ? `Removed from "${pl.title}"` : `Added to "${pl.title}"`);
          store().emit('playlists');
        } catch (e) {
          toast(e && e.data && e.data.error === 'human_check'
            ? "SoundCloud's human check wasn't completed, so the playlist didn't change"
            : "Couldn't update the playlist", 'error');
        }
        row.disabled = false;
        render();
      });
      listEl.append(row);
    });
  };
  filter.addEventListener('input', render);
  render();
  setTimeout(() => filter.focus(), 50);
}
