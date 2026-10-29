// Local metadata only. Playback resolves fresh streams through api.streamFor(id) (SoundCloud) or the track's source.
import { Emitter } from './dom.js';

export const KEY = 'quantm.localPlaylists';
export const events = new Emitter();
const validId = id => Number.isSafeInteger(id) && id > 0;
const text = (s, max) => typeof s === 'string' && s.length <= max;
const url = value => typeof value === 'string' && value.length <= 4096 && /^https:\/\//i.test(value) ? value : null;
const titleOf = title => text(title, 300) && title.trim() ? title.trim() : null;

const SOURCES = new Set(['audius', 'bandcamp']);
const MAX_ALTERNATES = 4;

// nested=true is for backup copies, which can't have backups of their own
function snapshot(track, nested = false) {
  if (!track || !validId(track.id) || !titleOf(track.title) ||
      !Number.isFinite(track.duration) || track.duration < 0 ||
      !track.user || !validId(track.user.id) || !text(track.user.username, 300) || !track.user.username.trim()) return null;
  const external = SOURCES.has(track.source) && typeof track.sourceId === 'string' && track.sourceId.length > 0 && text(track.sourceId, 200);
  const alternates = nested ? [] : cleanAlternates(track.alternates, track.id);
  return {
    // Audius / Bandcamp copies (see sources.js) say where they came from; SoundCloud ones carry nothing extra
    ...(external ? { source: track.source, sourceId: track.sourceId } : {}),
    // other places the same song can be played, tried in order when this copy won't load
    ...(alternates.length ? { alternates } : {}),
    id: track.id, title: track.title.trim(), duration: track.duration,
    permalink_url: url(track.permalink_url), artwork_url: url(track.artwork_url),
    user: { id: track.user.id, username: track.user.username, avatar_url: url(track.user.avatar_url) },
    downloadable: track.downloadable === true, has_downloads_left: track.has_downloads_left !== false,
    // Only protocol metadata is saved, never authorizations or expiring stream URLs.
    media: { transcodings: (Array.isArray(track.media?.transcodings) ? track.media.transcodings : [])
      .filter(t => t && text(t.format?.protocol, 100))
      .map(t => ({ format: { protocol: t.format.protocol } })) }
  };
}

function cleanAlternates(list, ownId) {
  if (!Array.isArray(list)) return [];
  const seen = new Set([ownId]);
  return list.slice(0, 20).map(t => snapshot(t, true)).filter(t => t && !seen.has(t.id) && seen.add(t.id)).slice(0, MAX_ALTERNATES);
}

function cleanTracks(tracks) {
  const seen = new Set();
  return tracks.map(t => snapshot(t)).filter(t => t && !seen.has(t.id) && seen.add(t.id));
}

function cleanPlaylist(p) {
  if (!p || !titleOf(p.title) || !Array.isArray(p.tracks)) return null;
  return {
    id: typeof p.id === 'string' && /^q[a-z0-9]{1,80}$/.test(p.id) ? p.id : null,
    title: p.title.trim(), description: text(p.description, 10000) ? p.description : '',
    createdAt: Number.isFinite(p.createdAt) && p.createdAt > 0 ? p.createdAt : Date.now(),
    updatedAt: Number.isFinite(p.updatedAt) && p.updatedAt > 0 ? p.updatedAt : Date.now(),
    tracks: cleanTracks(p.tracks)
  };
}

export function list() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data?.version !== 1 || !Array.isArray(data.playlists)) return [];
    const seen = new Set();
    return data.playlists.map(cleanPlaylist).filter(p => p?.id && !seen.has(p.id) && seen.add(p.id));
  } catch (error) { return []; }
}

export const get = id => list().find(p => p.id === id) || null;
function save(playlists) {
  try { localStorage.setItem(KEY, JSON.stringify({ version: 1, playlists })); }
  catch (error) { throw new Error('Could not save Quantm playlists on this PC. Storage may be full.'); }
  events.emit('change');
}
function newId(playlists) {
  let id;
  do { id = 'q' + crypto.randomUUID().replaceAll('-', ''); } while (playlists.some(p => p.id === id));
  return id;
}
export function create(title, tracks = []) {
  if (!titleOf(title) || !Array.isArray(tracks)) throw new Error('Enter a playlist title (up to 300 characters).');
  const playlists = list();
  const now = Date.now();
  const playlist = { id: newId(playlists), title: title.trim(), description: '', createdAt: now, updatedAt: now, tracks: cleanTracks(tracks) };
  playlists.push(playlist);
  save(playlists);
  return playlist;
}
function edit(id, change) {
  const playlists = list();
  const playlist = playlists.find(p => p.id === id);
  if (!playlist || !change(playlist)) return false;
  playlist.updatedAt = Date.now();
  save(playlists);
  return true;
}
export function rename(id, title) {
  if (!titleOf(title)) throw new Error('Enter a playlist title (up to 300 characters).');
  return edit(id, p => { p.title = title.trim(); return true; });
}
export function remove(id) {
  const playlists = list();
  if (!playlists.some(p => p.id === id)) return false;
  save(playlists.filter(p => p.id !== id));
  return true;
}
export const has = (id, trackId) => !!get(id)?.tracks.some(t => t.id === trackId);
export function addTrack(id, track) {
  const clean = snapshot(track);
  if (!clean) return false;
  return edit(id, p => {
    if (p.tracks.some(t => t.id === clean.id)) return false;
    p.tracks.push(clean);
    return true;
  });
}
export const removeTrack = (id, trackId) => edit(id, p => {
  const index = p.tracks.findIndex(t => t.id === trackId);
  if (index < 0) return false;
  p.tracks.splice(index, 1);
  return true;
});
export function moveTrack(id, from, to) {
  return edit(id, p => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= p.tracks.length || to >= p.tracks.length || from === to) return false;
    p.tracks.splice(to, 0, p.tracks.splice(from, 1)[0]);
    return true;
  });
}
// Returns the resulting membership, matching the check mark in the dialog.
export const toggleTrack = (id, track) => has(id, track.id) ? (removeTrack(id, track.id), false) : addTrack(id, track);
export const exportJSON = id => JSON.stringify({ version: 1, playlists: id ? list().filter(p => p.id === id) : list() }, null, 2);
export function importJSON(value) {
  let data;
  try { data = JSON.parse(value); } catch (error) { throw new Error('Invalid playlist JSON.'); }
  if (data?.version !== 1 || !Array.isArray(data.playlists)) throw new Error('Unsupported playlist file.');
  const playlists = list();
  const added = [];
  for (const raw of data.playlists) {
    const p = cleanPlaylist(raw);
    if (!p) continue;
    if (!p.id || playlists.some(existing => existing.id === p.id)) p.id = newId(playlists);
    playlists.push(p);
    added.push(p);
  }
  if (!added.length) throw new Error('No valid playlists found.');
  save(playlists);
  return added;
}
