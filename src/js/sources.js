// Songs that don't come from SoundCloud (Audius, Bandcamp) are shaped like SoundCloud tracks, so
// lists, the player bar and queues work unchanged. Their ids are synthetic and can't collide with
// SoundCloud's (those are below 1e10): 2^52 plus a hash, Audius in the low half and Bandcamp in the high.

const BASE = 2 ** 52;
const HALF = 2 ** 50;
const HASH_BITS = 49;
const OFFSET = { audius: 0, bandcamp: HALF };
const LABELS = { audius: 'Audius', bandcamp: 'Bandcamp' };

// Two independent 32-bit FNV-1a hashes, joined into 49 bits
function hash(value) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return (b & (2 ** (HASH_BITS - 32) - 1)) * 2 ** 32 + a;
}

/** A positive safe integer for "audius:<id>" / "bandcamp:<id>" that SoundCloud never uses */
export const syntheticId = (source, key) => BASE + OFFSET[source] + hash(`${source}:${key}`);

/** True for ids made by syntheticId (works on numbers and numeric strings) */
export const isExternalId = (id) => Number(id) >= BASE;

export const isExternal = (track) => !!track && (track.source === 'audius' || track.source === 'bandcamp');
export const isAudius = (track) => track?.source === 'audius';
export const isBandcamp = (track) => track?.source === 'bandcamp';
export const sourceLabel = (track) => LABELS[track?.source] || 'SoundCloud';

export const audiusStreamUrl = (sourceId) => `https://api.audius.co/v1/tracks/${encodeURIComponent(sourceId)}/stream?app_name=Quantm`;

const shape = (source, sourceId, userKey, fields) => ({
  id: syntheticId(source, sourceId), source, sourceId,
  title: fields.title, duration: fields.duration, permalink_url: fields.permalink, artwork_url: fields.artwork,
  user: { id: syntheticId(source, 'user:' + userKey), username: fields.artist || LABELS[source], avatar_url: null },
  media: { transcodings: [] }
});

/** From main.js's audiusSearch result */
export function audiusTrack(raw) {
  return shape('audius', String(raw.id), raw.userId || raw.handle || raw.artist, {
    title: raw.title, duration: raw.durationMs || 0, permalink: raw.permalink, artwork: raw.artwork, artist: raw.artist
  });
}

/** From main.js's bandcampSearch result. Bandcamp gives no length, so the Spotify one can stand in. */
export function bandcampTrack(raw, { durationMs = 0 } = {}) {
  return shape('bandcamp', String(raw.id), raw.artist, {
    title: raw.title, duration: durationMs, permalink: raw.url, artwork: raw.image, artist: raw.artist
  });
}
