import { canPlayProtocol, WIDEVINE_PROTOCOL, WIDEVINE_LICENSE_URL } from './drm.js';

// SoundCloud api-v2 client. Requests are proxied by the main process (window.native.api),
// which adds the OAuth token and client_id.

export class ApiError extends Error {
  constructor(status, data) {
    super(`SoundCloud API error ${status}`);
    this.status = status;
    this.data = data;
  }
}

export async function request(method, resource, params, body, checked = false) {
  const response = await window.native.api({ method, resource, params, body });
  // SoundCloud's bot check blocked the request before it ran: let the user pass it, then try again
  if (!response.ok && !checked && response.data && response.data.error === 'human_check') {
    if (await humanCheck(response.data.url)) return request(method, resource, params, body, true);
  }
  if (!response.ok) throw new ApiError(response.status, response.data);
  return response.data;
}

// several blocked requests at once share one check window
let pendingCheck = null;
function humanCheck(url) {
  if (!pendingCheck) pendingCheck = Promise.resolve(window.native.humanCheck(url)).finally(() => { pendingCheck = null; });
  return pendingCheck;
}

export const get = (resource, params) => request('GET', resource, params);

/**
 * Cursor pagination over any api-v2 collection.
 *   const pager = new Pager('users/1/tracks', { limit: 20 }, item => item.track);
 *   const items = await pager.next();   // [] once pager.done
 */
export class Pager {
  constructor(resource, params = {}, map = (x) => x) {
    this.resource = resource;
    this.params = Object.assign({ limit: 24, linked_partitioning: 1 }, params);
    this.map = map;
    this.nextHref = null;
    this.started = false;
    this.done = false;
    this.loading = false;
  }

  async next() {
    if (this.done || this.loading) return [];
    this.loading = true;
    try {
      const data = this.started ? await get(this.nextHref) : await get(this.resource, this.params);
      this.started = true;
      this.nextHref = data.next_href || null;
      this.done = !this.nextHref;
      const items = (data.collection || []).map(this.map).filter(Boolean);
      return this.afterLoad ? await this.afterLoad(items) : items;
    } finally {
      this.loading = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Hydration: playlists and some feeds only include ids for most tracks
// ---------------------------------------------------------------------------

const trackCache = new Map();
const TRACK_CACHE_LIMIT = 2000;

export function cacheTrack(track) {
  if (track && track.id && track.title) {
    trackCache.delete(track.id);
    trackCache.set(track.id, track);
    if (trackCache.size > TRACK_CACHE_LIMIT) trackCache.delete(trackCache.keys().next().value);
  }
  return track;
}

export async function tracksByIds(ids) {
  // Hold this request's results separately: a large playlist can exceed the cache.
  const found = new Map();
  for (const id of ids) {
    const track = trackCache.get(id);
    if (track) found.set(id, cacheTrack(track));
  }
  const missing = [...new Set(ids.filter(id => !found.has(id)))];
  for (let i = 0; i < missing.length; i += 50) {
    const tracks = await get('tracks', { ids: missing.slice(i, i + 50).join(',') });
    tracks.forEach(track => {
      cacheTrack(track);
      if (track && track.id && track.title) found.set(track.id, track);
    });
  }
  return ids.map(id => found.get(id)).filter(Boolean);
}

/** Replace stub tracks ({ id, kind }) with full objects, keeping order */
export async function hydrateTracks(tracks) {
  const full = await tracksByIds((tracks || []).map(t => t.id));
  return full;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const me = () => get('me');

// Home / discovery
export const mixedSelections = () => get('mixed-selections', { limit: 12 });
export const systemPlaylist = (urn) => get('system-playlists/' + encodeURIComponent(urn));
export const trending = () => new Pager('charts', { kind: 'trending', genre: 'soundcloud:genres:all-music', limit: 50 }, i => cacheTrack(i.track));
export const popularByGenre = (genre) => new Pager('search/tracks', { q: '*', 'filter.genre_or_tag': genre.toLowerCase(), sort: 'popular', limit: 30 }, cacheTrack);

/** SoundCloud mixes paid "promoted" posts into feeds; Quantm never shows them */
export function isPromoted(item) {
  return !!item && (/promoted/.test(item.type || '') || !!item.promoted);
}

// Feed: items are { type: track | track-repost | playlist | playlist-repost, track?, playlist?, user, created_at }
export const stream = () => new Pager('stream', { limit: 20 }, (item) => {
  if (isPromoted(item)) return null;
  if (item.track) cacheTrack(item.track);
  return (item.track || item.playlist) ? item : null;
});
export const activities = () => new Pager('activities', { limit: 20 });

// Users
export const user = (id) => get('users/' + id);
export const userTracks = (id) => new Pager(`users/${id}/tracks`, { limit: 20 }, cacheTrack);
export const userTopTracks = (id) => new Pager(`users/${id}/toptracks`, { limit: 10 }, cacheTrack);
export const userAlbums = (id) => new Pager(`users/${id}/albums`, { limit: 20 });
export const userPlaylists = (id) => new Pager(`users/${id}/playlists_without_albums`, { limit: 20 });
export const userReposts = (id) => new Pager(`stream/users/${id}/reposts`, { limit: 20 }, (item) => {
  if (isPromoted(item)) return null;
  if (item.track) cacheTrack(item.track);
  return (item.track || item.playlist) ? item : null;
});
// items: { kind: like, track? playlist? created_at }
export const userLikes = (id) => new Pager(`users/${id}/likes`, { limit: 24 }, (item) => {
  if (item.track) cacheTrack(item.track);
  return item.track || item.playlist || null;
});
export const userFollowers = (id) => new Pager(`users/${id}/followers`, { limit: 30 });
export const userFollowings = (id) => new Pager(`users/${id}/followings`, { limit: 30 });

// Tracks
export const track = async (id) => cacheTrack(await get('tracks/' + id));
export const relatedTracks = (id) => new Pager(`tracks/${id}/related`, { limit: 20 }, cacheTrack);
export const trackComments = (id) => new Pager(`tracks/${id}/comments`, { threaded: 0, sort: 'newest', limit: 30 });
export const trackInPlaylists = (id) => new Pager(`tracks/${id}/playlists_without_albums`, { limit: 10 });
export const trackLikers = (id) => new Pager(`tracks/${id}/likers`, { limit: 30 });
export const trackReposters = (id) => new Pager(`tracks/${id}/reposters`, { limit: 30 });
export const postComment = (id, body, timestampMs) =>
  request('POST', `tracks/${id}/comments`, null, { comment: { body, timestamp: Math.max(0, Math.round(timestampMs || 0)) } });
export const deleteComment = (trackId, commentId) => request('DELETE', `tracks/${trackId}/comments/${commentId}`);

/** Load waveform samples (array of 0..1) for a track */
export async function waveform(track) {
  if (!track || !track.waveform_url) return null;
  const url = track.waveform_url.replace(/\.png$/, '.json');
  const data = await window.native.json(url);
  if (!data || !data.samples) return null;
  const max = data.height || Math.max(...data.samples) || 1;
  return data.samples.map(s => s / max);
}

// Playlists and albums (tracks are hydrated)
export async function playlist(id) {
  const data = await get('playlists/' + id, { representation: 'full' });
  data.tracks = await hydrateTracks(data.tracks);
  return data;
}
export async function stationTracks(stationUrn) {
  const data = await systemPlaylist(stationUrn);
  data.tracks = await hydrateTracks(data.tracks || []);
  return data;
}

// Library (logged in user)
export const myTrackLikes = (meId) => new Pager(`users/${meId}/track_likes`, { limit: 30 }, i => cacheTrack(i.track));
// items: { type: playlist | playlist-like | album | album-like | system-playlist-like ..., playlist?, system_playlist? }
export const myLibrary = () => new Pager('me/library/all', { limit: 30 }, i => i.playlist || i.system_playlist || null);
export const myPlayHistory = () => new Pager('me/play-history/tracks', { limit: 30 }, i => cacheTrack(i.track));
export const myRecentContexts = () => new Pager('me/play-history/contexts', { limit: 20 });
export const myPlaylists = (meId) => new Pager(`users/${meId}/playlists`, { limit: 50 });

async function allIds(resource) {
  let ids = [];
  let next = resource;
  let params = { limit: 200, linked_partitioning: 1 };
  while (next) {
    const data = await get(next, params);
    ids = ids.concat(data.collection || []);
    next = data.next_href;
    params = undefined;
  }
  return ids;
}
export const likedTrackIds = () => allIds('me/track_likes/ids');
export const likedPlaylistIds = () => allIds('me/playlist_likes/ids');
export const repostedTrackIds = () => allIds('me/track_reposts/ids');
export const repostedPlaylistIds = () => allIds('me/playlist_reposts/ids');
export const followingIds = (meId) => allIds(`users/${meId}/followings/ids`);

// Actions
export const likeTrack = (meId, id, on) => request(on ? 'PUT' : 'DELETE', `users/${meId}/track_likes/${id}`);
export const likePlaylist = (meId, id, on) => request(on ? 'PUT' : 'DELETE', `users/${meId}/playlist_likes/${id}`);
export const repostTrack = (id, on) => request(on ? 'PUT' : 'DELETE', `me/track_reposts/${id}`);
export const repostPlaylist = (id, on) => request(on ? 'PUT' : 'DELETE', `me/playlist_reposts/${id}`);
export const follow = (id, on) => request(on ? 'POST' : 'DELETE', `me/followings/${id}`);

export const createPlaylist = (title, trackIds = [], sharing = 'public') =>
  request('POST', 'playlists', null, { playlist: { title, sharing, tracks: trackIds } });
export const updatePlaylist = (id, fields) => request('PUT', 'playlists/' + id, null, { playlist: fields });
export const setPlaylistTracks = (id, trackIds) => updatePlaylist(id, { tracks: trackIds });
export const deletePlaylist = (id) => request('DELETE', 'playlists/' + id);

// Search. kind: '' (everything) | tracks | users | albums | playlists_without_albums
export const search = (q, kind = '') => new Pager(kind ? 'search/' + kind : 'search', { q, limit: 20 }, (item) => {
  if (item.kind === 'track') cacheTrack(item);
  return item;
});
export const GENRES = [
  'Alternative Rock', 'Ambient', 'Classical', 'Country', 'Dance & EDM', 'Dancehall', 'Deep House', 'Disco',
  'Drum & Bass', 'Dubstep', 'Electronic', 'Folk & Singer-Songwriter', 'Hip-hop & Rap', 'House', 'Indie',
  'Jazz & Blues', 'Latin', 'Metal', 'Piano', 'Pop', 'R&B & Soul', 'Reggae', 'Reggaeton', 'Rock',
  'Soundtrack', 'Techno', 'Trance', 'Trap', 'Triphop', 'World'
];
/** "Hip-hop & Rap" -> "hip-hop-and-rap" */
export const genreSlug = (title) => title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Every track of a list: re-page it at 200 a page (no rows drawn), dedupe, keep only tracks.
 * `pick` turns a pager item into its track (reposts are { track } items). Stops after 100 pages.
 * Throws if a page fails, so callers can fall back to what they have.
 */
export async function loadEveryTrack(pager, pick = (item) => item) {
  const fast = new Pager(pager.resource, Object.assign({}, pager.params, { limit: 200 }), pager.map);
  fast.afterLoad = pager.afterLoad;
  const all = [];
  const seen = new Set();
  for (let pages = 0; !fast.done && pages < 100; pages++) {
    for (const item of await fast.next()) {
      const t = item && pick(item);
      if (t && t.kind === 'track' && !seen.has(t.id)) { seen.add(t.id); all.push(t); }
    }
  }
  return all;
}

/** A repost-style item is a track or { track }; playlists have neither */
export const trackOfEntry = (entry) => entry.kind === 'track' ? entry : entry.track;

/**
 * Rebuild "load the whole list" for a saved play context from its href, or null when the list isn't
 * one that can be reloaded. getMe() gives the signed-in user (only Likes needs it).
 */
export function loadAllFor(href, getMe) {
  if (typeof href !== 'string') return null;
  if (href === '#/library/likes') return async () => loadEveryTrack(myTrackLikes((await getMe()).id));
  if (href === '#/library/history') return () => loadEveryTrack(myPlayHistory());
  if (href === '#/trending') return () => loadEveryTrack(trending());
  let m = /^#\/trending\/([a-z0-9-]+)$/.exec(href);
  if (m) {
    const genre = GENRES.find(g => genreSlug(g) === m[1]);
    return genre ? () => loadEveryTrack(popularByGenre(genre)) : null;
  }
  m = /^#\/search\?q=([^&]*)&tab=tracks$/.exec(href);
  if (m) {
    let q;
    try { q = decodeURIComponent(m[1]); } catch (e) { return null; }
    return q ? () => loadEveryTrack(search(q, 'tracks')) : null;
  }
  m = /^#\/user\/(\d+)\/(popular|tracks|reposts)$/.exec(href);
  if (m) {
    const id = m[1];
    if (m[2] === 'popular') return () => loadEveryTrack(userTopTracks(id));
    if (m[2] === 'tracks') return () => loadEveryTrack(userTracks(id), trackOfEntry);
    return () => loadEveryTrack(userReposts(id), trackOfEntry);
  }
  return null;
}
export const searchSuggestions = (q) => get('search/queries', { q, limit: 8 });
export const resolve = (url) => get('resolve', { url });

// ---------------------------------------------------------------------------
// Playback: SoundCloud serves HLS (AAC preferred, MP3 fallback)
// ---------------------------------------------------------------------------

// Some label tracks only come as DRM-encrypted HLS. ctr-encrypted-hls (Widevine) plays when this Electron
// has the Widevine module (drm.js probes it at start-up); cbc-encrypted-hls (FairPlay) never does.
// Without the module those tracks stay "protected", exactly as before.
const playable = (t) => canPlayProtocol(t.format && t.format.protocol);

/** The artist turned on SoundCloud's download button and downloads are left */
export function isDownloadable(track) {
  return !!(track && track.downloadable && track.has_downloads_left !== false);
}

/** true when SoundCloud only offers copy-protected streams for this track */
export function isProtected(track) {
  const all = (track && track.media && track.media.transcodings) || [];
  return all.length > 0 && !all.some(playable);
}

function rank(transcoding) {
  const { protocol, mime_type: mime } = transcoding.format;
  if (protocol === 'progressive') return 0;
  if (/mp4|aac/.test(mime)) return 1;
  return 2;
}

/** Resolve a playable url. Returns { url, protocol, snipped, track, drm? } (drm: the license url and token for a Widevine stream) */
export async function streamFor(trackOrId) {
  const id = typeof trackOrId === 'object' ? trackOrId.id : trackOrId;
  // always refetch: track_authorization expires
  const fresh = await get('tracks/' + id);
  cacheTrack(fresh);
  if (isProtected(fresh)) throw new ApiError(403, 'protected');
  const all = ((fresh.media && fresh.media.transcodings) || []).filter(playable);
  const full = all.filter(t => !t.snipped);
  // plain streams always go before the Widevine one
  const wide = (t) => t.format.protocol === WIDEVINE_PROTOCOL;
  const candidates = (full.length ? full : all).slice().sort((a, b) => (wide(a) - wide(b)) || (rank(a) - rank(b)));
  if (!candidates.length) throw new ApiError(403, 'This track is not available for streaming');

  let lastError;
  for (const transcoding of candidates) {
    try {
      const data = await get(transcoding.url, { track_authorization: fresh.track_authorization });
      const protocol = transcoding.format.protocol;
      const stream = { url: data.url, protocol, snipped: !!transcoding.snipped, track: fresh };
      if (protocol === WIDEVINE_PROTOCOL) {
        if (typeof data.licenseAuthToken !== 'string' || !data.licenseAuthToken) throw new ApiError(403, 'no license');
        stream.drm = { licenseUrl: WIDEVINE_LICENSE_URL, token: data.licenseAuthToken };
      }
      return stream;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Helpers for links
// ---------------------------------------------------------------------------

/** "soundcloud:tracks:123" or 123 -> 123 */
export function idOf(value) {
  if (typeof value === 'number') return value;
  const match = String(value).match(/(\d+)$/);
  return match ? Number(match[1]) : value;
}
