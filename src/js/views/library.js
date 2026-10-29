// Library: everything you've saved (soundcloud.com/you/library)
import * as api from '../api.js';
import { quantmTab } from './local-playlist.js';
import { h, clear, onNearBottom } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { player } from '../player.js';
import { offline, formatBytes } from '../offline.js';
import {
  pageHeader, tabs, shelf, trackList, userList, playlistCard, spinner, emptyState, errorState,
  button, toast, promptDialog, staticTrackList, removeAllDownloads
} from '../ui.js';

const TABS = [
  { id: 'overview', label: 'Overview', href: '#/library' },
  { id: 'likes', label: 'Likes', href: '#/library/likes' },
  { id: 'quantm', label: 'Quantm', href: '#/library/quantm' },
  { id: 'playlists', label: 'Playlists', href: '#/library/playlists' },
  { id: 'albums', label: 'Albums', href: '#/library/albums' },
  { id: 'stations', label: 'Stations', href: '#/library/stations' },
  { id: 'following', label: 'Following', href: '#/library/following' },
  { id: 'history', label: 'History', href: '#/library/history' },
  { id: 'offline', label: 'Offline', href: '#/library/offline' }
];

const likesContext = { label: 'Likes', href: '#/library/likes' };
const historyContext = { label: 'Listening history', href: '#/library/history' };

// Raw library item types -> tab. Types look like playlist, playlist-like, album, album-like, system-playlist-like
const typeOf = (item) => String(item.type || '');
const isStation = (item) => typeOf(item).includes('system-playlist') || !!item.system_playlist;
const isAlbum = (item) => !isStation(item) && (typeOf(item).includes('album') || !!(item.playlist && item.playlist.is_album));
const isPlaylist = (item) => !isStation(item) && !isAlbum(item) && typeOf(item).includes('playlist');
const filters = { playlists: isPlaylist, albums: isAlbum, stations: isStation };

const libraryPager = () => new api.Pager('me/library/all', { limit: 50 }, item => item);
const playlistOf = (item) => item.playlist || item.system_playlist || null;

export async function render(page, params) {
  const active = TABS.some(t => t.id === params.tab) ? params.tab : 'overview';
  const content = h('div.library-content');
  page.append(
    pageHeader('Library', { subtitle: 'Your likes, playlists and listening history' }),
    tabs(TABS, active),
    content
  );

  if (active === 'quantm') return quantmTab(content);
  if (active === 'overview') return overview(content);
  if (active === 'likes') return likes(content);
  if (active === 'following') return following(content);
  if (active === 'history') return history(content);
  if (active === 'offline') return offlineTab(content);
  return libraryTab(content, active);
}

async function offlineTab(content) {
  await offline.init();
  const context = { label: 'Offline', href: '#/library/offline' };
  const refresh = () => {
    const tracks = offline.tracks();
    const play = button('Play', () => player.playList(offline.tracks(), 0, context), 'btn-primary', 'play');
    const shuffle = button('Shuffle', () => player.shufflePlay(offline.tracks(), context), 'btn-outline', 'shuffle');
    const remove = button('Remove all', removeAllDownloads, 'btn-outline');
    play.disabled = shuffle.disabled = remove.disabled = !tracks.length;
    clear(content).append(
      h('div.library-head',
        h('div.library-head-art', icon('download', 34)),
        h('div.library-head-text', h('h2.library-head-title', 'Offline'), h('div.muted', `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} · ${formatBytes(offline.totalBytes)}`)),
        h('div.library-head-actions', play, shuffle, button('Open folder', () => offline.openFolder(), 'btn-outline'), remove)
      ),
      staticTrackList(tracks, { context, empty: 'No downloads yet. Tracks whose artist allows downloads have a download button.' })
    );
  };
  refresh();
  return offline.on('change', refresh);
}

// ---------------------------------------------------------------------------
// Overview: a shelf per section
// ---------------------------------------------------------------------------

function overview(content) {
  const spin = spinner();
  const shelves = h('div.library-shelves');
  content.append(shelves, spin);

  // each task resolves to a shelf element, or null when the section is empty
  const dedupe = (items) => items.filter((item, i) => items.findIndex(x => x.id === item.id) === i);

  const libraryTask = (async () => {
    // a few pages so each section has something to show
    const pager = libraryPager();
    let items = [];
    for (let i = 0; i < 3 && !pager.done; i++) {
      items = items.concat(await pager.next());
      const enough = Object.values(filters).every(fn => items.filter(fn).length >= 6);
      if (enough) break;
    }
    return items;
  })();
  const fromLibrary = (name, title, href) => libraryTask.then((items) => {
    const list = dedupe(items.filter(filters[name]).map(playlistOf).filter(Boolean)).slice(0, 20);
    return list.length ? shelf(title, list, { href }) : null;
  });

  const tasks = [
    api.myPlayHistory().next().then((tracks) => {
      const list = dedupe(tracks).slice(0, 20);
      return list.length ? shelf('Recently played', list, { href: '#/library/history', context: historyContext }) : null;
    }),
    api.myTrackLikes(store.me.id).next().then((tracks) => {
      const list = tracks.slice(0, 20);
      return list.length ? shelf('Likes', list, { href: '#/library/likes', context: likesContext }) : null;
    }),
    fromLibrary('playlists', 'Playlists', '#/library/playlists'),
    fromLibrary('albums', 'Albums', '#/library/albums'),
    fromLibrary('stations', 'Stations', '#/library/stations'),
    api.userFollowings(store.me.id).next().then((users) => {
      const list = users.slice(0, 20);
      return list.length ? shelf('Following', list, { href: '#/library/following' }) : null;
    })
  ];

  // keep the section order, but show each as soon as it's ready
  const slots = tasks.map(() => h('div'));
  shelves.append(...slots);
  let shown = 0;
  let errors = 0;
  Promise.all(tasks.map((task, i) => task.then((el) => {
    if (el) { slots[i].append(el); shown++; }
  }).catch(() => { errors++; }))).then(() => {
    spin.remove();
    if (!shown) content.append(errors ? errorState() : emptyState('Your library is empty. Like some tracks to get started.', 'library'));
  });
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

function likes(content) {
  const list = trackList(api.myTrackLikes(store.me.id), { context: likesContext, empty: 'You haven\'t liked any tracks yet' });
  const count = store.me && store.me.likes_count;

  const loaded = () => list.tracks.slice();
  // list.context can load every page, so the player plays / shuffles the whole collection
  const playAll = () => {
    const tracks = loaded();
    if (!tracks.length) return toast('Nothing to play yet');
    player.playList(tracks, 0, list.context);
  };
  const shuffleAll = () => {
    const tracks = loaded();
    if (!tracks.length) return toast('Nothing to play yet');
    player.shufflePlay(tracks, list.context);
  };

  content.append(
    h('div.library-head',
      h('div.library-head-art', icon('heartFilled', 34)),
      h('div.library-head-text',
        h('h2.library-head-title', 'Likes'),
        h('div.muted', count != null ? `${Number(count).toLocaleString()} liked` : 'Tracks you\'ve liked')
      ),
      h('div.library-head-actions',
        button('Play all', playAll, 'btn-primary', 'play'),
        button('Shuffle', shuffleAll, 'btn-outline', 'shuffle')
      )
    ),
    list
  );
}

// ---------------------------------------------------------------------------
// Following / History
// ---------------------------------------------------------------------------

function following(content) {
  content.append(userList(api.userFollowings(store.me.id), { empty: 'You aren\'t following anyone yet' }));
}

function history(content) {
  content.append(
    h('div.library-section-head', h('h2.library-section-title', icon('history', 20), 'Recently played')),
    trackList(api.myPlayHistory(), { context: historyContext, empty: 'Nothing played yet' })
  );
}

// ---------------------------------------------------------------------------
// Playlists / Albums / Stations: filtered view of me/library/all
// ---------------------------------------------------------------------------

const EMPTY = {
  playlists: 'You don\'t have any playlists yet',
  albums: 'No albums in your library yet',
  stations: 'No stations in your library yet'
};

function libraryTab(content, name) {
  const holder = h('div');
  let stop = null;

  const mount = () => {
    if (stop) stop();
    clear(holder);
    const grid = libraryGrid(filters[name], EMPTY[name]);
    holder.append(grid.el);
    stop = grid.stop;
  };

  if (name === 'playlists') {
    const create = async () => {
      const title = await promptDialog('New playlist', { label: 'Title', placeholder: 'My playlist', confirmLabel: 'Create' });
      if (!title) return;
      try {
        await api.createPlaylist(title);
        store.playlistChanged();
        toast(`Created "${title}"`);
        mount();
      } catch (error) {
        toast('Couldn\'t create the playlist', 'error');
      }
    };
    content.append(h('div.library-section-head',
      h('h2.library-section-title', icon('playlist', 20), 'Playlists'),
      button('New playlist', create, 'btn-primary.btn-sm', 'plus')
    ));
  }

  content.append(holder);
  mount();
  return () => { if (stop) stop(); };
}

/** Infinite grid of library playlists matching `keep`. Returns { el, stop } */
function libraryGrid(keep, emptyText) {
  const pager = libraryPager();
  const grid = h('div.card-grid');
  const spin = spinner();
  const el = h('div', grid, spin);
  const seen = new Set();
  let alive = true;

  // one page at a time: the pager answers an overlapping call with nothing at once, which would spin this loop
  let loading = null;
  const loadMore = () => (loading ||= loadPage().finally(() => { loading = null; }));
  const loadPage = async () => {
    // filtered batches can come back empty, so keep going until something shows up
    let added = 0;
    try {
      while (alive && !pager.done && added < 6) {
        const batch = await pager.next();
        for (const item of batch.filter(keep)) {
          const playlist = playlistOf(item);
          if (!playlist || seen.has(playlist.id || playlist.urn)) continue;
          seen.add(playlist.id || playlist.urn);
          grid.append(playlistCard(playlist));
          added++;
        }
      }
    } catch (error) {
      el.insertBefore(errorState(error), spin);
      pager.done = true;
    }
    if (pager.done) {
      spin.remove();
      if (!grid.children.length && !el.querySelector('.empty')) el.append(emptyState(emptyText, 'library'));
    }
  };

  loadMore();
  const off = onNearBottom(document.getElementById('view'), loadMore);
  return { el, stop: () => { alive = false; off(); } };
}
