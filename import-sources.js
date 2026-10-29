'use strict';
// Main-process lookups for "Import from Spotify": a public Spotify playlist's song list, plus
// Audius and Bandcamp searches. The page can't do these itself (CSP and CORS), and none of them
// ever get the user's SoundCloud login. Requests to each site are spaced out so one import
// never sends more than about two per second.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT = 10000;
const MIN_GAP = 500;
const RESULTS = 8;
const MAX_QUERY = 200;
const sleepFor = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[ \s]+/g, ' ').trim().slice(0, max) : '';
const httpsUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch (error) { return null; }
};

/** The 22-character playlist id from a Spotify link, or null */
function parseSpotifyLink(link) {
  const value = typeof link === 'string' ? link.trim() : '';
  if (!value || value.length > 500) return null;
  const uri = value.match(/^spotify:playlist:([A-Za-z0-9]{10,40})$/);
  if (uri) return uri[1];
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : 'https://' + value); } catch (error) { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null;
  // /playlist/<id>, /intl-de/playlist/<id>, /embed/playlist/<id>
  const match = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?playlist\/([A-Za-z0-9]{10,40})\/?$/);
  return match ? match[1] : null;
}

/** Read the embed page's __NEXT_DATA__ into { name, tracks }. Throws readable errors. */
function parseEmbedPage(html) {
  const changed = new Error('Spotify changed how its playlist pages work, so Quantm can\'t read this one yet. Please try again after the next Quantm update.');
  const match = typeof html === 'string' && html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw changed;
  let data;
  try { data = JSON.parse(match[1]); } catch (error) { throw changed; }
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity || typeof entity !== 'object') {
    throw new Error('Spotify didn\'t share that playlist. It may be private or deleted. Make it public (or share a public one) and try again.');
  }
  if (!Array.isArray(entity.trackList)) throw changed;
  const tracks = entity.trackList.map(item => ({
    title: text(item?.title, 300),
    // Spotify separates artists with ",<nbsp>"
    artists: text(item?.subtitle, 500),
    durationMs: Number.isFinite(item?.duration) && item.duration > 0 ? Math.round(item.duration) : 0,
    spotifyUri: text(item?.uri, 100)
  })).filter(track => track.title);
  if (!tracks.length) throw new Error('That playlist has no songs in it.');
  return { name: text(entity.name, 300) || 'Spotify playlist', tracks };
}

function normalizeAudius(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.filter(t => t && t.id && t.title && t.user && t.is_streamable !== false && t.access?.stream !== false)
    .slice(0, RESULTS).map(t => ({
      id: String(t.id),
      title: text(t.title, 300),
      durationMs: Number.isFinite(t.duration) && t.duration > 0 ? Math.round(t.duration * 1000) : 0,
      artist: text(t.user.name, 300) || text(t.user.handle, 300),
      handle: text(t.user.handle, 100),
      userId: text(String(t.user.id ?? t.user.handle ?? ''), 100),
      artwork: httpsUrl(t.artwork?.['480x480'] || t.artwork?.['150x150']),
      permalink: typeof t.permalink === 'string' && t.permalink.startsWith('/') ? 'https://audius.co' + t.permalink : null
    }));
}

function normalizeBandcamp(body) {
  const list = Array.isArray(body?.auto?.results) ? body.auto.results : [];
  return list.filter(r => r && r.type === 't' && r.id != null && r.name && httpsUrl(r.item_url_path))
    .slice(0, RESULTS).map(r => ({
      id: String(r.id),
      title: text(r.name, 300),
      artist: text(r.band_name, 300),
      album: text(r.album_name, 300),
      url: httpsUrl(r.item_url_path),
      image: httpsUrl(r.img)
    }));
}

/** Runs tasks one at a time, at least `gap` ms apart */
function spacer(gap, sleep) {
  let last = 0;
  let chain = Promise.resolve();
  return (task) => {
    const run = chain.then(async () => {
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return task();
    });
    chain = run.catch(() => {});
    return run;
  };
}

/** `fetch` is Electron's net.fetch in the app and a fake in tests */
function createSources({ fetch, sleep = sleepFor, gap = MIN_GAP }) {
  const spotify = spacer(gap, sleep);
  const audius = spacer(gap, sleep);
  const bandcamp = spacer(gap, sleep);
  const get = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
  const query = (value) => {
    const q = text(value, MAX_QUERY);
    if (!q) throw new Error('Nothing to search for.');
    return q;
  };

  return {
    async spotifyPlaylist(link) {
      try {
        const id = parseSpotifyLink(link);
        if (!id) throw new Error('That doesn\'t look like a Spotify playlist link. In Spotify, choose Share, then Copy link to playlist.');
        let response;
        try {
          response = await spotify(() => get('https://open.spotify.com/embed/playlist/' + id, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en' } }));
        } catch (error) {
          throw new Error('Couldn\'t reach Spotify. Check your internet connection and try again.');
        }
        if (response.status === 404) throw new Error('Spotify couldn\'t find that playlist. Check the link, and make sure the playlist is public.');
        if (!response.ok) throw new Error('Spotify answered with an error (' + response.status + '). Try again in a little while.');
        return parseEmbedPage(await response.text());
      } catch (error) {
        return { error: error.message };
      }
    },

    async audiusSearch(value) {
      const q = query(value);
      return audius(async () => {
        const response = await get('https://api.audius.co/v1/tracks/search?query=' + encodeURIComponent(q) + '&app_name=Quantm');
        if (!response.ok) throw new Error('Audius answered ' + response.status);
        return normalizeAudius(await response.json());
      });
    },

    async bandcampSearch(value) {
      const q = query(value);
      return bandcamp(async () => {
        const response = await get('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
          body: JSON.stringify({ search_text: q, search_filter: 't', full_page: false })
        });
        if (!response.ok) throw new Error('Bandcamp answered ' + response.status);
        return normalizeBandcamp(await response.json());
      });
    }
  };
}

module.exports = { createSources, parseSpotifyLink, parseEmbedPage, normalizeAudius, normalizeBandcamp };
