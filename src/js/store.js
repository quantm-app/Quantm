// App-wide state: the logged in user, what they like / repost / follow, and settings.
import * as api from './api.js';
import { normalizeEqualizer } from './equalizer.js';
import { Emitter } from './dom.js';
import { toast } from './ui.js';
import { isExternal } from './sources.js';

class Store extends Emitter {
  constructor() {
    super();
    this.me = null;
    this.likedTracks = new Set();
    this.likedPlaylists = new Set();
    this.repostedTracks = new Set();
    this.repostedPlaylists = new Set();
    this.following = new Set();
    this.myPlaylists = null; // cached for the add-to-playlist dialog
  }

  async init() {
    this.me = await api.me();
    this.emit('me', this.me);
    // these can load in the background
    const load = (fn, key) => fn().then(ids => { this[key] = new Set(ids); this.emit('change', key); }).catch(() => {});
    load(api.likedTrackIds, 'likedTracks');
    load(api.likedPlaylistIds, 'likedPlaylists');
    load(api.repostedTrackIds, 'repostedTracks');
    load(api.repostedPlaylistIds, 'repostedPlaylists');
    load(() => api.followingIds(this.me.id), 'following');
  }

  isLiked(item) {
    return item.kind === 'playlist' || item.kind === 'system-playlist'
      ? this.likedPlaylists.has(item.id)
      : this.likedTracks.has(item.id);
  }

  isReposted(item) {
    return item.kind === 'playlist' ? this.repostedPlaylists.has(item.id) : this.repostedTracks.has(item.id);
  }

  isFollowing(userId) {
    return this.following.has(userId);
  }

  /** Optimistically flip a Set entry, call the API, roll back on failure */
  async toggle(setName, id, call, messages) {
    const set = this[setName];
    const on = !set.has(id);
    on ? set.add(id) : set.delete(id);
    this.emit('change', setName, id, on);
    try {
      await call(on);
      if (messages) toast(on ? messages[0] : messages[1]);
    } catch (error) {
      on ? set.delete(id) : set.add(id);
      this.emit('change', setName, id, !on);
      toast(error.status === 429 ? 'SoundCloud is rate limiting you. Try again later.' : 'That didn\'t work. Please try again.', 'error');
    }
    return set.has(id);
  }

  toggleLike(item) {
    if (isExternal(item)) return false; // Audius and Bandcamp songs aren't on SoundCloud
    if (item.kind === 'playlist') {
      return this.toggle('likedPlaylists', item.id, on => api.likePlaylist(this.me.id, item.id, on), ['Added to your liked playlists', 'Removed from your liked playlists']);
    }
    return this.toggle('likedTracks', item.id, on => api.likeTrack(this.me.id, item.id, on), ['Added to your Likes', 'Removed from your Likes']);
  }

  toggleRepost(item) {
    if (isExternal(item)) return false;
    if (item.kind === 'playlist') {
      return this.toggle('repostedPlaylists', item.id, on => api.repostPlaylist(item.id, on), ['Reposted to your profile', 'Repost removed']);
    }
    return this.toggle('repostedTracks', item.id, on => api.repostTrack(item.id, on), ['Reposted to your profile', 'Repost removed']);
  }

  toggleFollow(user) {
    return this.toggle('following', user.id, on => api.follow(user.id, on), [`Following ${user.username}`, `Unfollowed ${user.username}`]);
  }

  /** The user's own playlists, cached */
  async getMyPlaylists(force = false) {
    if (!this.myPlaylists || force) {
      const pager = api.myPlaylists(this.me.id);
      let all = [];
      while (!pager.done) all = all.concat(await pager.next());
      this.myPlaylists = all.filter(p => p.user && p.user.id === this.me.id);
    }
    return this.myPlaylists;
  }

  playlistChanged() {
    this.myPlaylists = null;
    this.emit('playlists');
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// Persistent settings (localStorage)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'quantm.settings';

// everything the "Reset visualizer" button restores
export const VISUALIZER_DEFAULTS = {
  visualizer: true,
  visualizerStyle: 'bars', // bars | mirror | wave | line | circle | dots
  visualizerColor: 'theme', // theme | accent | rainbow | custom
  visualizerColorA: '#ff5500',
  visualizerColorB: '#8a2be2',
  visualizerBars: 18, // 6-64
  visualizerWidth: 120, // 60-280 px
  visualizerHeight: 34, // 20-56 px
  visualizerSensitivity: 1, // 0.5-2.5
  visualizerSmoothing: 0.78, // 0-0.95
  visualizerPeaks: false,
  visualizerGlow: false,
  visualizerPosition: 'right' // left | center | right
};

const defaults = {
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off', // off | all | one
  notifications: true,
  autoplayRelated: true,
  normalize: true,
  eq: { enabled: false, preset: 'Flat', preamp: 0, gains: [0, 0, 0, 0, 0] },
  resumeSession: true,
  discordStatus: true,
  discordIdle: true,        // keep a "Playing Quantm" status while nothing plays
  themeEffects: 'auto',     // auto (follow the system's reduce-motion setting) | on | off
  performanceMode: false,   // no blur, animations or visualizer
  performanceWhileGaming: true, // Performance mode on by itself while a game is fullscreen
  pauseWhenHidden: true,    // stop visuals and free memory while minimized
  speedMode: 'normal',      // normal | nightcore | slowed | custom
  playbackSpeed: 1,         // 0.5-2, used by custom
  keepPitch: true,          // custom speed keeps the original pitch
  crossfade: 0,             // seconds (0-12), 0 = off
  autoMix: false,           // DJ-style transitions: beat-matched, bass swap (automix.js)
  transitionStyle: 'blend', // Auto mix: blend / auto / dropcut; pair overrides win
  mixOrder: false,          // shuffle orders songs so each blends into the next (needs autoMix; mixorder.js)
  ...VISUALIZER_DEFAULTS
};

const savedSettings = safeParse(localStorage.getItem(SETTINGS_KEY));
export const settings = Object.assign({}, defaults, savedSettings);

settings.eq = normalizeEqualizer(settings.eq);
settings.transitionStyle = ['auto', 'blend', 'dropcut'].includes(settings.transitionStyle) ? settings.transitionStyle : defaults.transitionStyle;
// 1.2.2-dev.3 saved 'auto' as the default; smooth blend is the default now unless 'auto' was picked on purpose
if (savedSettings?.transitionStyle === 'auto' && !savedSettings.transitionStyleChosen) settings.transitionStyle = 'blend';

export function saveSettings(patch) {
  if ('transitionStyle' in patch && !['auto', 'blend', 'dropcut'].includes(patch.transitionStyle)) patch = { ...patch, transitionStyle: defaults.transitionStyle };
  if (patch.eq) patch = { ...patch, eq: normalizeEqualizer(patch.eq) };
  Object.assign(settings, patch);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  store.emit('settings', settings);
}

export function safeParse(text) {
  try { return JSON.parse(text) || {}; } catch (e) { return {}; }
}
