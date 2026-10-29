// "Import from Spotify": find each song of a Spotify playlist on SoundCloud, Audius and Bandcamp.
// No DOM here and every lookup is passed in, so tests can run it with fakes.
import { pick, queryFor } from './song-match.js';
import { audiusTrack, bandcampTrack } from './sources.js';

// Spotify's public playlist page lists at most this many songs
export const SPOTIFY_LIMIT = 100;
// one song at a time, no faster than this (keeps every site under about 2 requests a second)
const SONG_GAP_MS = 500;
// a site that fails this many times in a row is skipped for the rest of the import
const GIVE_UP = 5;

const nowMs = () => Date.now();

/** A SoundCloud / Audius / Bandcamp result as a track the player and playlists understand */
function toTrack(entry, wanted) {
  if (entry.source === 'audius') return audiusTrack(entry.raw);
  if (entry.source === 'bandcamp') return bandcampTrack(entry.raw, { durationMs: wanted.durationMs });
  return entry.raw;
}

/**
 * songs: [{ title, artists, durationMs }] from Spotify, in order.
 * lookups: { soundcloud(query), audius(query), bandcamp(query) } each resolving to a list of results.
 * hooks: { onProgress({ done, total, song, counts }), cancelled(), wait(ms) }
 * Resolves to { items: [{ wanted, status, track|null }], counts, trouble, cancelled }.
 * Rejects only when SoundCloud can't be searched at all (that is the main source).
 */
export async function matchSongs(songs, lookups, { onProgress = () => {}, cancelled = () => false, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const counts = { soundcloud: 0, audius: 0, bandcamp: 0, unmatched: 0 };
  const trouble = { soundcloud: 0, audius: 0, bandcamp: 0 };
  const streak = { soundcloud: 0, audius: 0, bandcamp: 0 };
  const items = [];

  const search = async (site, query) => {
    if (streak[site] >= GIVE_UP) return [];
    try {
      const found = await lookups[site](query);
      streak[site] = 0;
      return Array.isArray(found) ? found : [];
    } catch (error) {
      trouble[site]++;
      streak[site]++;
      if (site === 'soundcloud' && (error?.status === 401 || streak.soundcloud >= GIVE_UP)) {
        throw new Error(error?.status === 401 ? 'Your SoundCloud login expired. Sign in again from Settings.' : 'Couldn\'t search SoundCloud. Check your internet connection and try again.');
      }
      return [];
    }
  };

  for (let i = 0; i < songs.length; i++) {
    if (cancelled()) return { items, counts, trouble, cancelled: true };
    const wanted = songs[i];
    onProgress({ done: i, total: songs.length, song: wanted, counts: { ...counts } });
    const started = nowMs();
    const query = queryFor(wanted);
    const found = { soundcloud: await search('soundcloud', query), audius: await search('audius', query), bandcamp: [] };
    let result = pick(wanted, found);
    // Bandcamp links are the last resort, so only ask when nothing playable matched
    if (!result.chosen) {
      found.bandcamp = await search('bandcamp', query);
      result = pick(wanted, found);
    }
    if (cancelled()) return { items, counts, trouble, cancelled: true };
    if (!result.chosen) {
      counts.unmatched++;
      items.push({ wanted, status: 'unmatched', locked: !!result.locked, track: null });
    } else {
      counts[result.chosen.source]++;
      const track = toTrack(result.chosen, wanted);
      const alternates = result.alternates.map(entry => toTrack(entry, wanted));
      items.push({ wanted, status: result.status, track: alternates.length ? { ...track, alternates } : track });
    }
    const spent = nowMs() - started;
    if (spent < SONG_GAP_MS && i < songs.length - 1) await wait(SONG_GAP_MS - spent);
  }
  onProgress({ done: songs.length, total: songs.length, song: null, counts: { ...counts } });
  return { items, counts, trouble, cancelled: false };
}

/** The playlist name: Spotify's own, plus "(from Spotify)" only when a Quantm playlist already has it */
export function playlistTitle(name, existingTitles) {
  const base = String(name || '').trim().slice(0, 280) || 'Spotify playlist';
  if (!existingTitles.includes(base)) return base;
  let title = `${base} (from Spotify)`;
  for (let n = 2; existingTitles.includes(title); n++) title = `${base} (from Spotify ${n})`;
  return title;
}
