// Bootstrap: theme, login, app shell, routes, keyboard shortcuts
import * as api from './api.js';
import { h, clear, debounce, artwork } from './dom.js';
import { settings } from './store.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { player } from './player.js';
import { offline } from './offline.js';
import { applyTheme } from './theme.js';
import { initAppearance } from './appearance.js';
import { initThemeRuntime } from './theme-runtime.js';
import { startAutoMixCss } from './automix-css.js';
import { initPerformance } from './performance.js';
import { initUpdates } from './updates.js';
import { initStats } from './stats.js';
import { route, startRouter } from './router.js';
import { mountPlayerBar } from './playerbar.js';
import { bindServices, iconButton, button, menu, toast, avatar, go, playlistHref, addCueHere, offlineTrackList } from './ui.js';
import { getCues, setMixIn, setMixOut } from './cues.js';
import { formatCueTime } from './cue-time.js';

bindServices(store, player, api);
applyTheme();

const views = {
  home: () => import('./views/home.js'),
  feed: () => import('./views/feed.js'),
  library: () => import('./views/library.js'),
  trending: () => import('./views/trending.js'),
  search: () => import('./views/search.js'),
  user: () => import('./views/user.js'),
  track: () => import('./views/track.js'),
  playlist: () => import('./views/playlist.js'),
  notifications: () => import('./views/notifications.js'),
  stats: () => import('./views/stats.js'),
  settings: () => import('./views/settings.js')
};

route('/home', views.home);
route('/feed', views.feed);
route('/library/:tab?', views.library);
route('/trending/:genre?', views.trending);
route('/search', views.search);
route('/user/:id/:tab?', views.user);
route('/track/:id/:tab?', views.track);
route('/playlist/:id', views.playlist);
route('/qplaylist/:id', () => import('./views/local-playlist.js'));
route('/station/:urn', views.playlist);
route('/notifications', views.notifications);
route('/stats', views.stats);
route('/settings/:tab?', views.settings);

const app = document.getElementById('app');

async function boot() {
  const { loggedIn } = await window.native.auth.status();
  if (!loggedIn) return showLogin();
  try {
    await store.init();
  } catch (error) {
    if (error.status === 401 || error.status === 403) return showLogin('Your SoundCloud login expired. Please sign in again.');
    // offline is not a logged-out state: keep the login and retry when the connection is back
    return showOffline();
  }
  await offline.init();
  mountShell();
}

async function showOffline() {
  clear(app);
  let retrying = false;
  const retry = async () => {
    if (retrying) return;
    retrying = true;
    try {
      await store.init();
      location.reload();
    } catch (error) {
      if (error.status === 401 || error.status === 403) location.reload();
      else toast('Still unable to reach SoundCloud', 'error');
    } finally {
      retrying = false;
    }
  };
  window.addEventListener('online', retry);
  const screen = h('div.login.offline-screen',
    h('div.login-drag'),
    h('div.login-card',
      h('div.login-logo', icon('logo', 64)),
      h('h1', "You're offline"),
      h('p.muted', "Quantm couldn't reach SoundCloud. It will reconnect on its own when your connection is back."),
      button('Try again', retry, 'btn-primary.btn-lg')
    )
  );
  app.append(screen);
  await offline.init();
  const tracks = offline.tracks();
  if (tracks.length) {
    const context = { label: 'Offline', href: '#/library/offline' };
    screen.append(h('section.offline-downloads',
      h('h2', 'Play your downloads'),
      h('div.offline-actions',
        button('Play', () => player.playList(tracks, 0, context), 'btn-primary', 'play'),
        button('Shuffle', () => player.shufflePlay(tracks, context), 'btn-outline', 'shuffle')
      ),
      offlineTrackList(tracks)
    ));
    mountPlayerBar(app, { offline: true });
    initPerformance();
    initStats();
  }
}

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------

function showLogin(message) {
  clear(app);
  const tokenInput = h('input.input', { placeholder: 'oauth_token cookie value' });
  const clientInput = h('input.input', { placeholder: 'client_id (optional, found automatically)' });
  const manual = h('div.login-manual.hidden',
    h('p.muted.small', 'Copy the "oauth_token" cookie from soundcloud.com (DevTools → Application → Cookies). The client_id is optional: leave it empty and Quantm finds one.'),
    tokenInput, clientInput,
    button('Save and continue', async () => {
      const ok = await window.native.auth.setManual(tokenInput.value, clientInput.value);
      if (ok) location.reload();
      else toast(clientInput.value.trim() ? 'Check both values and try again' : "Couldn't sign in with that token. Check it and try again", 'error');
    }, 'btn-primary')
  );

  app.append(h('div.login',
    h('div.login-drag'),
    h('div.login-card',
      h('div.login-logo', icon('logo', 64)),
      h('h1', 'Quantm'),
      h('p.muted', 'A desktop app for SoundCloud.'),
      message ? h('div.login-error', message) : null,
      button('Sign in with SoundCloud', async () => {
        const ok = await window.native.auth.login();
        if (ok) location.reload();
      }, 'btn-primary.btn-lg'),
      h('button.link-btn', { onclick: () => manual.classList.toggle('hidden') }, 'Enter a token manually'),
      manual
    )
  ));
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function mountShell() {
  clear(app);
  const nav = [
    { id: 'home', label: 'Home', href: '#/home', icon: 'home' },
    { id: 'feed', label: 'Feed', href: '#/feed', icon: 'feed' },
    { id: 'library', label: 'Library', href: '#/library', icon: 'library' },
    { id: 'stats', label: 'Stats', href: '#/stats', icon: 'chart' },
    { id: 'trending', label: 'Trending', href: '#/trending', icon: 'trending' }
  ];
  // icons only show when the navigation is a sidebar (Settings → Appearance)
  const navLinks = nav.map(n => h('a.nav-link', { href: n.href, dataset: { id: n.id } }, icon(n.icon, 18), h('span', n.label)));

  const searchInput = h('input.search-input', { type: 'search', placeholder: 'Search for artists, tracks, playlists, or paste a link', spellcheck: false });
  const suggestions = h('div.search-suggest');
  const search = h('form.search', { onsubmit: (e) => { e.preventDefault(); submitSearch(searchInput.value); } },
    icon('search', 18), searchInput, suggestions);

  const meAvatar = h('button.me-btn', { title: store.me.username, onclick: (e) => menu([
    { label: 'Profile', icon: 'user', onclick: () => go('#/user/' + store.me.id) },
    { label: 'Likes', icon: 'heart', onclick: () => go('#/library/likes') },
    { label: 'Playlists', icon: 'playlist', onclick: () => go('#/library/playlists') },
    { label: 'Following', icon: 'users', onclick: () => go('#/library/following') },
    'separator',
    { label: 'Theme & colors', icon: 'palette', onclick: () => go('#/settings/theme') },
    { label: 'Settings', icon: 'settings', onclick: () => go('#/settings') },
    'separator',
    { label: 'Sign out', icon: 'logout', danger: true, onclick: signOut }
  ], e) }, avatar(store.me, 32));

  const topbar = h('header.topbar',
    h('div.topbar-left',
      h('a.logo', { href: '#/home', title: 'Quantm' }, icon('logo', 28)),
      iconButton('back', 'Back', () => history.back(), 'nav-arrow'),
      iconButton('forward', 'Forward', () => history.forward(), 'nav-arrow'),
      h('nav.nav', navLinks)
    ),
    search,
    h('div.topbar-right',
      h('a.icon-btn', { href: '#/notifications', title: 'Notifications' }, icon('bell')),
      h('a.icon-btn', { href: '#/settings/theme', title: 'Theme & colors' }, icon('palette')),
      meAvatar
    )
  );

  const view = h('main#view');
  app.append(topbar, view);
  setupWindowMode(topbar);
  mountPlayerBar(app);
  initUpdates();
  initStats();
  initAppearance();
  initPerformance();
  player.restoreSession();
  initThemeRuntime();
  startAutoMixCss(player); // Auto mix beat / mix progress for themes (data-automix, --beat, --mix)
  setupDiscord();

  document.addEventListener('routechange', (e) => {
    const section = e.detail.path.split('/')[1];
    navLinks.forEach(a => a.classList.toggle('active', a.dataset.id === section));
    if (section !== 'search') searchInput.value = '';
  });

  // --- search suggestions -------------------------------------------------------
  let active = -1;
  const hideSuggest = () => { suggestions.classList.remove('show'); active = -1; };
  const showSuggest = debounce(async () => {
    const q = searchInput.value.trim();
    if (!q || /^https?:/.test(q)) return hideSuggest();
    try {
      const data = await api.searchSuggestions(q);
      clear(suggestions);
      active = -1;
      (data.collection || []).forEach((s) => {
        suggestions.append(h('button.suggest-item', { type: 'button', onmousedown: (e) => { e.preventDefault(); submitSearch(s.output || s.query); } },
          icon('search', 14), h('span', s.output || s.query)));
      });
      suggestions.classList.toggle('show', suggestions.children.length > 0 && document.activeElement === searchInput);
    } catch (e) { hideSuggest(); }
  }, 200);
  searchInput.addEventListener('input', showSuggest);
  searchInput.addEventListener('blur', () => setTimeout(hideSuggest, 100));
  searchInput.addEventListener('keydown', (e) => {
    const items = [...suggestions.querySelectorAll('.suggest-item')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) { active = -1; return; } // modulo by zero would leave active as NaN for good
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === active));
      if (items[active]) searchInput.value = items[active].textContent;
    } else if (e.key === 'Escape') {
      hideSuggest();
      searchInput.blur();
    }
  });

  async function submitSearch(value) {
    const q = value.trim();
    hideSuggest();
    searchInput.blur();
    if (!q) return;
    // pasted soundcloud.com link: open it directly
    if (/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.(com|app\.goo\.gl)\//.test(q)) {
      try {
        const item = await api.resolve(q);
        if (item.kind === 'track') return go('#/track/' + item.id);
        if (item.kind === 'user') return go('#/user/' + item.id);
        if (item.kind === 'playlist' || item.kind === 'system-playlist') return go(playlistHref(item));
      } catch (e) {
        return toast("Couldn't open that link", 'error');
      }
    }
    searchInput.value = q;
    go('#/search?q=' + encodeURIComponent(q));
  }

  setupShortcuts(searchInput);
  if (!location.hash) location.hash = '#/home';
  startRouter();
}

/** Keep Discord's "Listening to Quantm" status in sync with the player */
function setupDiscord() {
  const push = () => {
    if (settings.discordStatus === false) return;
    const t = player.current;
    const rate = player.rate || 1;
    const showIdle = settings.discordIdle !== false;
    window.native.discord.update(t ? {
      title: t.title,
      artist: t.user ? t.user.username : '',
      artwork: artwork(t.artwork_url || (t.user && t.user.avatar_url), 't500x500'),
      url: t.permalink_url,
      artistUrl: t.user && t.user.permalink_url,
      // the status counts real time, so scale media time by the playback speed
      duration: player.duration / rate,
      position: player.audio.currentTime / rate,
      playing: player.playing,
      showIdle
    } : { showIdle });
  };
  window.native.discord.setEnabled(settings.discordStatus !== false);
  player.on('state', push);
  player.on('track', push);
  player.on('timeline', push); // seeks and duration changes on the active deck
  player.on('speed', push);
  store.on('settings', (s) => {
    window.native.discord.setEnabled(s.discordStatus !== false);
    push();
  });
  push(); // the idle status shows as soon as Quantm opens
}

/** See-through windows have no native title bar buttons, so draw our own */
async function setupWindowMode(topbar) {
  const mode = await window.native.windowMode();
  const root = document.documentElement;
  if (mode.seeThrough) root.setAttribute('data-see-through', '');
  if (!mode.customControls) return;
  root.setAttribute('data-frameless', '');
  const maxBtn = h('button.win-btn', { title: 'Maximize', onclick: () => window.native.windowControl('maximize') });
  const setMax = (maximized) => { clear(maxBtn).append(icon(maximized ? 'winRestore' : 'winMax', 16)); maxBtn.title = maximized ? 'Restore' : 'Maximize'; };
  setMax(mode.maximized);
  window.native.onMaximized(setMax);
  topbar.append(h('div.win-controls',
    h('button.win-btn', { title: 'Minimize', onclick: () => window.native.windowControl('minimize') }, icon('winMin', 16)),
    maxBtn,
    h('button.win-btn.win-close', { title: 'Close', onclick: () => window.native.windowControl('close') }, icon('close', 16))
  ));
  topbar.addEventListener('dblclick', (e) => { if (e.target === topbar) window.native.windowControl('maximize'); });
}

async function signOut() {
  player.pause();
  await window.native.auth.logout();
  location.hash = '';
  location.reload();
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function setupShortcuts(searchInput) {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'f' || ctrl && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (typing) return;

    if (!ctrl && !e.altKey && player.current && /^[cio1-9]$/i.test(e.key)) {
      e.preventDefault();
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const t = player.audio.currentTime;
      if (key === 'c') addCueHere(player.current.id, t);
      else if (key === 'i' || key === 'o') {
        if (key === 'i') setMixIn(player.current.id, t);
        else setMixOut(player.current.id, t);
        toast(`Mix-${key === 'i' ? 'in' : 'out'} set at ${formatCueTime(t)}`);
      } else {
        const cue = getCues(player.current.id).cues[Number(key) - 1];
        if (cue) player.seek(cue.t);
      }
      return;
    }

    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.altKey && e.key === 'ArrowLeft') history.back();
    else if (e.altKey && e.key === 'ArrowRight') history.forward();
    else if (ctrl && e.key === '[') { e.preventDefault(); history.back(); }
    else if (ctrl && e.key === ']') { e.preventDefault(); history.forward(); }
    else if (ctrl && e.key === 'ArrowRight') { e.preventDefault(); player.next(); }
    else if (ctrl && e.key === 'ArrowLeft') { e.preventDefault(); player.prev(); }
    else if (e.key === 'ArrowRight') player.seekBy(10);
    else if (e.key === 'ArrowLeft') player.seekBy(-10);
    else if (e.key === 'ArrowUp' && ctrl) { e.preventDefault(); player.setVolume(player.volume + 0.05); }
    else if (e.key === 'ArrowDown' && ctrl) { e.preventDefault(); player.setVolume(player.volume - 0.05); }
    else if (e.key.toLowerCase() === 'm') player.toggleMute();
    else if (e.key.toLowerCase() === 'l' && player.current) store.toggleLike(player.current);
    else if (e.key.toLowerCase() === 's') player.cycleShuffle();
    else if (e.key.toLowerCase() === 'r') player.cycleRepeat();
    else if (e.key === '>') player.nudgeSpeed(0.05);
    else if (e.key === '<') player.nudgeSpeed(-0.05);
  });
  // mouse back/forward buttons
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) history.back();
    if (e.button === 4) history.forward();
  });
  // macOS: trackpad swipes and side-button tools (e.g. Sensible Side Buttons) arrive as swipes
  if (window.native.onNavigate) window.native.onNavigate((direction) => (direction === 'back' ? history.back() : history.forward()));
}

boot();
