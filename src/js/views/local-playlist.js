// Quantm playlists: all edits stay on this PC; SoundCloud is read only here.
import * as local from '../local-playlists.js';
import * as api from '../api.js';
import { h, clear, coverOf, duration } from '../dom.js';
import { icon } from '../icons.js';
import { player } from '../player.js';
import { button, iconButton, hero, staticTrackList, toast, confirmDialog, promptDialog, emptyState, isLocked } from '../ui.js';
import { isExternal } from '../sources.js';
import { openSpotifyImport } from './spotify-import.js';

const href = id => '#/qplaylist/' + id;
const badge = () => h('span.qplaylist-badge', 'On this PC');
const report = error => toast(error.message || 'Could not save playlist', 'error');

export function quantmTab(content) {
  const grid = h('div.card-grid');
  const input = h('input.hidden', { type: 'file', accept: '.json,application/json', 'aria-label': 'Import Quantm playlists' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const added = local.importJSON(await file.text());
      toast(`Imported ${added.length} ${added.length === 1 ? 'playlist' : 'playlists'}`);
    } catch (error) { report(error); }
    input.value = '';
  });
  content.append(h('div.library-section-head',
    h('div', h('h2.library-section-title', 'Quantm playlists'), h('p.muted', 'Saved on this PC. Not synced to SoundCloud.')),
    h('div.row', button('New playlist', async () => {
      const title = await promptDialog('New Quantm playlist', { label: 'Title', confirmLabel: 'Create' });
      if (!title) return;
      try { location.hash = href(local.create(title).id); } catch (error) { report(error); }
    }, 'btn-primary', 'plus'), button('Import from Spotify', openSpotifyImport, 'btn-outline', 'download'), button('Import', () => input.click(), 'btn-outline'))
  ), input, grid);
  const refresh = () => {
    clear(grid);
    const playlists = local.list();
    if (!playlists.length) grid.append(emptyState('Create a Quantm playlist or import a JSON file.', 'playlist'));
    playlists.forEach(p => {
      const image = coverOf(p.tracks[0]);
      grid.append(h('a.qplaylist-card', { href: href(p.id) },
        h('div.qplaylist-cover', image ? h('img', { src: image, alt: '', loading: 'lazy' }) : icon('playlist', 48)),
        h('div.qplaylist-card-title', p.title), badge(), h('div.muted.small', `${p.tracks.length} tracks`)));
    });
  };
  refresh();
  return local.events.on('change', refresh);
}

function download(id) {
  const p = local.get(id);
  if (!p) return;
  const url = URL.createObjectURL(new Blob([local.exportJSON(id)], { type: 'application/json' }));
  const a = h('a', { href: url, download: p.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function render(page, params) {
  const id = params.id;
  const fresh = new Map();
  let alive = true;
  let dragging = null;
  let titleEditor = null;
  const context = { label: '', href: href(id) };
  // a song whose SoundCloud copy was removed still plays when it has a backup copy somewhere else
  const hasBackup = t => (t.alternates || []).some(a => !isLocked(a));
  const tracks = () => (local.get(id)?.tracks || []).map(t => !fresh.has(t.id) ? t
    : fresh.get(t.id) ? (t.alternates ? { ...fresh.get(t.id), alternates: t.alternates } : fresh.get(t.id))
    : hasBackup(t) ? t : { ...t, unavailable: true });
  // Bandcamp entries can only be opened on the site; protected SoundCloud ones only play in SoundCloud
  const playable = () => tracks().filter(t => !t.unavailable && (!isLocked(t) || hasBackup(t)));
  const play = (track = null, shuffle = false) => {
    const list = playable();
    if (!list.length) return toast('No available tracks to play');
    if (shuffle) return player.shufflePlay(list, context);
    const index = track ? list.findIndex(t => t.id === track.id) : 0;
    if (index < 0) return toast('This track is unavailable in Quantm');
    return player.toggleOrPlay(list, index, context);
  };
  const move = (from, to, focusId) => {
    try {
      if (local.moveTrack(id, from, to)) page.querySelector(`[data-id="${focusId}"] .qplaylist-handle`)?.focus();
    } catch (error) { report(error); }
  };
  const refresh = () => {
    if (!alive) return;
    const p = local.get(id);
    clear(page);
    if (!p) { page.append(emptyState('This Quantm playlist no longer exists.', 'playlist')); return; }
    context.label = p.title;
    const current = tracks();
    const title = h('span', p.title);
    titleEditor = h('input.input.qplaylist-title-input', { value: p.title, maxLength: 300, 'aria-label': 'Playlist title' });
    titleEditor.hidden = true;
    const saveTitle = () => {
      if (titleEditor.hidden) return;
      try { local.rename(id, titleEditor.value); } catch (error) { report(error); }
    };
    titleEditor.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
      if (e.key === 'Escape') { e.stopPropagation(); titleEditor.hidden = true; title.hidden = false; }
    });
    titleEditor.addEventListener('blur', saveTitle);
    const rename = button('Rename', () => {
      title.hidden = true;
      titleEditor.hidden = false;
      titleEditor.focus();
      titleEditor.select();
    }, 'btn-sm', 'edit');
    const header = hero({
      image: coverOf(current[0]), eyebrow: 'Quantm playlist', title: h('span', title, titleEditor),
      subtitle: badge(), meta: [h('span', `${current.length} tracks`), h('span', duration(current.reduce((sum, t) => sum + t.duration, 0)))],
      actions: [button('Play', () => play(), 'btn-primary', 'play'), button('Shuffle', () => play(null, true), 'btn-sm', 'shuffle'), rename,
        button('Export', () => download(id), 'btn-sm', 'download'), button('Delete', async () => {
          if (!await confirmDialog('Delete Quantm playlist', `Delete "${p.title}" from this PC?`, 'Delete', true)) return;
          try { local.remove(id); location.hash = '#/library/quantm'; } catch (error) { report(error); }
        }, 'btn-sm', 'trash')]
    });
    const list = staticTrackList(current, {
      number: true, context, onPlay: track => play(track),
      empty: 'Add tracks using Add to playlist on any track.',
      extraActions: track => [iconButton('trash', 'Remove from this playlist', () => {
        try { local.removeTrack(id, track.id); toast(`Removed from "${p.title}"`); } catch (error) { report(error); }
      })]
    });
    list.classList.add('qplaylist-list', 'playlist-editable');
    list.querySelectorAll('.track-row').forEach((row, index) => {
      const track = current[index];
      const handle = h('button.qplaylist-handle', {
        title: 'Drag to reorder; Alt+Up/Down to move', 'aria-label': `Reorder ${track.title}`, draggable: true,
        onclick: e => e.stopPropagation(),
        onkeydown: e => {
          if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          move(index, index + (e.key === 'ArrowUp' ? -1 : 1), track.id);
        },
        ondragstart: e => {
          dragging = track.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(track.id));
          row.classList.add('playlist-dragging');
        },
        ondragend: () => { dragging = null; row.classList.remove('playlist-dragging'); }
      }, icon('queue', 16));
      row.prepend(handle);
      row.querySelectorAll('a, img').forEach(el => { el.draggable = false; });
      row.addEventListener('dragover', e => {
        if (dragging === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('playlist-drop-before');
      });
      row.addEventListener('dragleave', () => row.classList.remove('playlist-drop-before'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('playlist-drop-before');
        const from = current.findIndex(t => t.id === dragging);
        dragging = null;
        move(from, index, track.id);
      });
    });
    page.append(header, p.description ? h('p.description', p.description) : null, list);
  };
  refresh();
  const off = local.events.on('change', refresh);
  // Bypass the track cache to detect deleted songs. Failed batches keep snapshots.
  // only SoundCloud songs can be looked up there: Audius and Bandcamp ones aren't on SoundCloud
  const ids = (local.get(id)?.tracks || []).filter(t => !isExternal(t)).map(t => t.id);
  (async () => {
    let failed = false;
    for (let i = 0; i < ids.length && alive; i += 50) {
      const batch = ids.slice(i, i + 50);
      try {
        const result = await api.get('tracks', { ids: batch.join(',') });
        if (!alive) return;
        const found = new Map(result.filter(t => t?.id && t.title).map(t => [t.id, t]));
        batch.forEach(trackId => fresh.set(trackId, found.get(trackId) || null));
      } catch (error) { failed = true; }
    }
    if (!alive) return;
    refresh();
    if (failed) toast('Could not refresh some tracks. Showing saved details.');
  })();
  return () => { alive = false; off(); };
}
