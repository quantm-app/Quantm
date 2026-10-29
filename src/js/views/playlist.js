// Playlist / album / station page (soundcloud.com/artist/sets/name)
// Routes: #/playlist/:id and #/station/:urn
import * as api from '../api.js';
import * as localPlaylists from '../local-playlists.js';
import { h, clear, coverOf, artwork, compact, linkify } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { player } from '../player.js';
import {
  hero, link, userHref, shelf, button, iconButton, likeButton, repostButton, playButton,
  staticTrackList, toast, confirmDialog, promptDialog
} from '../ui.js';

const fmtDate = (date) => date
  ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  : '';

/** 3725000 -> "1 hr 2 min" */
function fmtTotal(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

/** 'techno "deep house"' -> ['techno', 'deep house'] */
function parseTags(text) {
  const tags = [];
  String(text || '').replace(/"([^"]+)"|(\S+)/g, (m, quoted, single) => { tags.push(quoted || single); return m; });
  return tags;
}

export async function render(page, params) {
  const isStation = !!params.urn;
  const data = isStation ? await api.stationTracks(params.urn) : await api.playlist(params.id);
  const tracks = data.tracks || [];
  const href = location.hash;
  const context = { label: data.title, href };
  const isMine = !isStation && !!(store.me && data.user && data.user.id === store.me.id);
  const totalMs = () => tracks.reduce((sum, t) => sum + (t.full_duration || t.duration || 0), 0);

  const typeLabel = () => {
    if (isStation) return 'Station';
    if (!data.is_album) return 'Playlist';
    const type = data.set_type || 'album';
    return type === 'ep' ? 'EP' : type.charAt(0).toUpperCase() + type.slice(1);
  };
  const eyebrowText = () => typeLabel() + (data.sharing === 'private' ? ' · Private' : '');

  // artwork falls back to the first track that has any
  const firstArt = tracks.find(t => t.artwork_url);
  const image = artwork(data.artwork_url || data.calculated_artwork_url || (firstArt && firstArt.artwork_url) || coverOf(data), 't500x500');

  const countEl = h('span', trackCountText(tracks.length));
  const durationEl = h('span', tracks.length ? fmtTotal(totalMs()) : '');
  const date = data.release_date || data.display_date || data.published_at || data.created_at;

  // --- actions
  const actions = [
    playButton(() => tracks, 0, context, 'play-btn.play-btn-xl'),
    button('Shuffle', () => {
      if (!tracks.length) return;
      if (!player.shuffle) player.toggleShuffle();
      player.playList(tracks, Math.floor(Math.random() * tracks.length), context);
    }, 'btn-sm', 'shuffle')
  ];
  if (!isStation) {
    const copy = button('Copy to Quantm', async () => {
      copy.disabled = true;
      try {
        // api.playlist hydrates every ID in batches and preserves playlist order.
        const full = await api.playlist(data.id);
        const local = localPlaylists.create(full.title, full.tracks);
        toast(`Created "${local.title}" on this PC`);
        location.hash = '#/qplaylist/' + local.id;
      } catch (error) { toast(error.message || 'Could not copy playlist', 'error'); }
      finally { copy.disabled = false; }
    }, 'btn-sm', 'playlist');
    actions.push(copy);
  }
  if (!isStation && !isMine) actions.push(likeButton(data, { withCount: true }), repostButton(data, { withCount: true }));
  if (data.permalink_url) {
    actions.push(
      iconButton('link', 'Copy link', () => { window.native.copy(data.permalink_url); toast('Link copied'); }),
      iconButton('external', 'Open on SoundCloud', () => window.native.openExternal(data.permalink_url))
    );
  }

  const heroEl = hero({
    image,
    eyebrow: eyebrowText(),
    title: data.title,
    subtitle: data.user ? link(userHref(data.user), data.user.username) : null,
    meta: [
      countEl,
      durationEl,
      date ? h('span', fmtDate(date)) : null,
      data.likes_count ? h('span.stat', { title: 'Likes' }, icon('heart', 13), compact(data.likes_count)) : null
    ],
    actions
  });

  // --- body
  const listSlot = h('div.playlist-list');
  const body = h('div.playlist-body');
  page.append(heroEl, body);

  const tags = parseTags(data.tag_list);
  if (data.genre && !tags.some(t => t.toLowerCase() === data.genre.toLowerCase())) tags.unshift(data.genre);
  if (data.description && data.description.trim()) body.append(h('section.playlist-section', h('div.description', { html: linkify(data.description) })));
  if (tags.length) {
    body.append(h('section.playlist-section.playlist-tags',
      tags.map(tag => h('a.tag-pill', { href: '#/search?q=' + encodeURIComponent(tag) + '&tab=tracks' }, '#' + tag))));
  }
  body.append(listSlot);

  const updateCounts = () => {
    countEl.textContent = trackCountText(tracks.length);
    durationEl.textContent = tracks.length ? fmtTotal(totalMs()) : '';
  };

  /** Rebuild the track list (after removing or reordering) */
  const renderList = () => {
    const list = staticTrackList(tracks, {
      number: true,
      context,
      empty: isMine ? 'This playlist is empty. Add tracks with the + button on any track.' : 'No tracks',
      menuItems: isMine ? (track) => [{ label: 'Remove from this playlist', icon: 'trash', danger: true, onclick: () => removeTrack(track) }] : null
    });
    if (isMine) enableReorder(list, tracks, reorder);
    clear(listSlot).append(list);
  };

  // changes are saved one after another: two in flight would both start from the same list and the later save would undo the earlier one
  let saving = Promise.resolve();
  const queued = (task) => { const run = saving.then(task); saving = run.catch(() => {}); return run; };

  const removeTrack = (track) => queued(async () => {
    const remaining = tracks.filter(t => t.id !== track.id);
    try {
      await api.setPlaylistTracks(data.id, remaining.map(t => t.id));
    } catch (e) {
      return toast("Couldn't remove the track", 'error');
    }
    tracks.splice(0, tracks.length, ...remaining);
    data.track_count = tracks.length;
    updateCounts();
    renderList();
    store.playlistChanged();
    toast('Removed from playlist');
  });

  const reorder = (order) => queued(async () => {
    const previous = tracks.slice();
    tracks.splice(0, tracks.length, ...order);
    renderList();
    try {
      await api.setPlaylistTracks(data.id, order.map(t => t.id));
      store.playlistChanged();
      toast('Playlist order saved');
    } catch (e) {
      tracks.splice(0, tracks.length, ...previous);
      renderList();
      toast("Couldn't save the new order", 'error');
    }
  });

  renderList();

  // --- owner controls
  if (isMine) {
    const privacyBtn = button('', () => {}, 'btn-sm');
    const setPrivacyLabel = () => {
      const priv = data.sharing === 'private';
      clear(privacyBtn).append(icon(priv ? 'lock' : 'users', 16), h('span', priv ? 'Private' : 'Public'));
      privacyBtn.title = priv ? 'Make public' : 'Make private';
      heroEl.querySelector('.hero-eyebrow').textContent = eyebrowText();
    };
    privacyBtn.addEventListener('click', async () => {
      const next = data.sharing === 'private' ? 'public' : 'private';
      privacyBtn.disabled = true;
      try {
        await api.updatePlaylist(data.id, { sharing: next });
        data.sharing = next;
        store.playlistChanged();
        toast(next === 'private' ? 'Playlist is now private' : 'Playlist is now public');
      } catch (e) {
        toast("Couldn't change privacy", 'error');
      }
      privacyBtn.disabled = false;
      setPrivacyLabel();
    });
    setPrivacyLabel();

    const editBtn = button('Edit', async () => {
      const title = await promptDialog('Edit playlist', { label: 'Title', value: data.title });
      if (!title || title === data.title) return;
      try {
        await api.updatePlaylist(data.id, { title });
        data.title = title;
        context.label = title;
        heroEl.querySelector('.hero-title').textContent = title;
        store.playlistChanged();
        toast('Playlist updated');
      } catch (e) {
        toast("Couldn't update the playlist", 'error');
      }
    }, 'btn-sm', 'edit');

    const deleteBtn = button('Delete', async () => {
      const ok = await confirmDialog('Delete playlist', `"${data.title}" will be permanently deleted.`, 'Delete', true);
      if (!ok) return;
      try {
        await api.deletePlaylist(data.id);
        store.playlistChanged();
        toast('Playlist deleted');
        location.hash = '#/library/playlists';
      } catch (e) {
        toast("Couldn't delete the playlist", 'error');
      }
    }, 'btn-sm', 'trash');

    heroEl.querySelector('.hero-actions').append(editBtn, privacyBtn, deleteBtn);
  }

  // --- more by the owner
  if (!isStation && data.user) {
    api.userPlaylists(data.user.id).next().then((items) => {
      const others = items.filter(p => p.id !== data.id).slice(0, 12);
      if (!others.length) return;
      body.append(h('div.playlist-more', shelf(`More by ${data.user.username}`, others, { href: userHref(data.user) })));
    }).catch(() => {});
  }
}

const trackCountText = (n) => `${n} ${n === 1 ? 'track' : 'tracks'}`;

// ---------------------------------------------------------------------------
// Drag and drop reordering (own playlists)
// ---------------------------------------------------------------------------

/** HTML5 drag events on the .track-row elements; onChange gets the new track order */
function enableReorder(list, tracks, onChange) {
  let dragId = null;
  list.classList.add('playlist-editable');
  list.querySelectorAll('.track-row').forEach((row) => {
    row.draggable = true;
    row.querySelectorAll('a, img').forEach((el) => { el.draggable = false; });
  });

  const clearMarks = () => list.querySelectorAll('.playlist-drop-before, .playlist-drop-after, .playlist-dragging')
    .forEach(el => el.classList.remove('playlist-drop-before', 'playlist-drop-after', 'playlist-dragging'));

  // which row, and before or after it, is under the pointer
  const targetAt = (e) => {
    const row = e.target.closest && e.target.closest('.track-row');
    if (!row || !list.contains(row)) return null;
    const rect = row.getBoundingClientRect();
    return { row, after: e.clientY > rect.top + rect.height / 2 };
  };

  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.track-row');
    if (!row) return;
    dragId = Number(row.dataset.id);
    row.classList.add('playlist-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
  });

  list.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.querySelectorAll('.playlist-drop-before, .playlist-drop-after')
      .forEach(el => el.classList.remove('playlist-drop-before', 'playlist-drop-after'));
    const target = targetAt(e);
    if (target && Number(target.row.dataset.id) !== dragId) target.row.classList.add(target.after ? 'playlist-drop-after' : 'playlist-drop-before');
    // scroll the page while dragging near its edges
    const view = document.getElementById('view');
    const box = view.getBoundingClientRect();
    if (e.clientY < box.top + 70) view.scrollBy(0, -14);
    else if (e.clientY > box.bottom - 70) view.scrollBy(0, 14);
  });

  list.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    const target = targetAt(e);
    const movingId = dragId;
    dragId = null;
    clearMarks();
    if (!target) return;
    const from = tracks.findIndex(t => t.id === movingId);
    let to = tracks.findIndex(t => t.id === Number(target.row.dataset.id));
    if (from < 0 || to < 0) return;
    if (target.after) to++;
    if (from < to) to--;
    if (from === to) return;
    const order = tracks.slice();
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    onChange(order);
  });

  list.addEventListener('dragend', () => { dragId = null; clearMarks(); });
}
