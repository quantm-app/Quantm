// Decides which search result is "the same song" as a Spotify track. Pure: no DOM, no network.
//   pick(wanted, { soundcloud, audius, bandcamp }) -> { chosen, alternates, status }
// SoundCloud copies always win over Audius, and Audius over Bandcamp, however well they score;
// the score only ranks copies from the same site. wanted: { title, artists: 'A, B', durationMs }.

// Words that mean "a different recording": a copy that has one the Spotify song doesn't is rejected
const VERSION_RE = /\b(remix|rmx|edit|bootleg|live|acoustic|sped up|speed up|slowed|nightcore|reverb|cover|instrumental|mashup|flip|vip|karaoke|8d)\b/g;
const CANONICAL = { rmx: 'remix', 'speed up': 'sped up' };

// Bracketed text that says nothing about which song it is
const BRACKET_NOISE = /^(?:official(?: (?:music|lyric|hd))?(?: (?:video|audio|visuali[sz]er))?|lyrics?|lyric video|audio|video|hd|hq|4k|explicit|clean|original(?: mix| version)?|album version|remaster(?:ed)?(?: \d{4})?|\d{4} remaster(?:ed)?|free download|out now|premiere|ncs release|monstercat release)$/;
const LOOSE_NOISE = /\b(?:official (?:music |lyric )?(?:video|audio|visuali[sz]er)|lyric video|lyrics video|free download|out now|original mix|original version|album version|(?:\d{4} )?remaster(?:ed)?(?: \d{4})?)\b/g;
const FEAT = /\b(?:feat|ft|featuring)\b\.?[^()[\]]*?(?=\s[-–—|]\s|[([]|$)/g;

const MATCH_SECONDS = 3;
const FAR_SECONDS = 10;
const PREVIEW_SECONDS = 35;

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Lowercase, no accents, no "(feat. …)" or "[Official Audio]" noise or punctuation. Version words stay. */
export function normalize(value) {
  let s = plain(value).replace(/&/g, ' and ');
  s = s.replace(/[([]([^()[\]]*)[)\]]/g, (whole, inner) => {
    const content = inner.trim();
    if (/^(?:feat|ft|featuring)\b/.test(content) || BRACKET_NOISE.test(content)) return ' ';
    return ' ' + content + ' ';
  });
  s = s.replace(FEAT, ' ').replace(LOOSE_NOISE, ' ');
  const cleaned = s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  // a title that is only noise words ("Audio") keeps its own letters
  return cleaned || plain(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (value) => normalize(value).split(' ').filter(Boolean);

/** The version words in a title: 'remix', 'live', 'sped up' ... */
export function versionWords(value) {
  const found = new Set();
  const s = normalize(value);
  for (const m of s.matchAll(VERSION_RE)) found.add(CANONICAL[m[1]] || m[1]);
  return found;
}

function dice(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return 2 * shared / (x.size + y.size);
}

const indexOfRun = (hay, run) => {
  if (!run.length) return -1;
  for (let i = 0; i + run.length <= hay.length; i++) {
    if (run.every((t, j) => hay[i + j] === t)) return i;
  }
  return -1;
};

/** Spotify joins artists with commas ("Tyler, The Creator" splits in two; one match is enough) */
const artistList = (artists) => (Array.isArray(artists) ? artists : String(artists || '').split(','))
  .map(a => tokens(a)).filter(t => t.length);

/** Titles on SoundCloud often read "Artist - Title": try each piece, and the title with the artist cut out */
function titleVariants(rawTitle, artistRuns) {
  const parts = String(rawTitle || '').split(/\s+[-–—|]\s+/);
  const raw = new Set([String(rawTitle || '')]);
  if (parts.length > 1) {
    parts.forEach(p => raw.add(p));
    raw.add(parts.slice(1).join(' '));
    raw.add(parts.slice(0, -1).join(' '));
  }
  const variants = [];
  for (const piece of raw) {
    const t = tokens(piece);
    if (!t.length) continue;
    variants.push(t);
    for (const run of artistRuns) {
      const at = indexOfRun(t, run);
      if (at >= 0 && t.length > run.length) variants.push([...t.slice(0, at), ...t.slice(at + run.length)]);
    }
  }
  return variants;
}

function artistMatches(artistRuns, candidateNames, candidateTitle) {
  const names = candidateNames.map(n => tokens(n)).filter(t => t.length);
  const titleTokens = tokens(candidateTitle);
  const squash = (t) => t.join('');
  const titleSquash = squash(titleTokens);
  return artistRuns.some(run => {
    if (indexOfRun(titleTokens, run) >= 0) return true;
    // "MrProbz" vs "Mr. Probz"
    if (squash(run).length >= 5 && titleSquash.includes(squash(run))) return true;
    return names.some(name => indexOfRun(name, run) >= 0 || (squash(name).length >= 4 && indexOfRun(run, name) >= 0) ||
      (squash(run).length >= 5 && squash(name).includes(squash(run))));
  });
}

const positive = (n) => Number.isFinite(n) && n > 0;

/**
 * What the matcher needs from a search result of any site: { title, names, durationMs|null, reject }.
 * SoundCloud: previews, label-protected and blocked copies are rejected here.
 */
export function describe(raw, source = 'soundcloud', wantedMs = 0) {
  const names = [raw?.artist, raw?.user?.username, raw?.user?.name, raw?.publisher_metadata?.artist].filter(n => typeof n === 'string' && n);
  const out = { title: String(raw?.title ?? ''), names, durationMs: null, reject: null };
  if (source === 'bandcamp') return out;
  if (source === 'audius') {
    const ms = raw?.durationMs ?? raw?.duration;
    out.durationMs = positive(ms) ? ms : null;
    return out;
  }
  const preview = positive(raw?.duration) ? raw.duration : null;
  out.durationMs = positive(raw?.full_duration) ? raw.full_duration : preview;
  const transcodings = Array.isArray(raw?.media?.transcodings) ? raw.media.transcodings : [];
  if (raw?.policy === 'SNIP' || raw?.policy === 'BLOCK' || raw?.streamable === false) out.reject = 'unavailable';
  else if (transcodings.length && transcodings.every(t => t?.snipped)) out.reject = 'preview';
  // the same rule api.isProtected() applies: no stream Quantm can play
  else if (transcodings.length && !transcodings.some(t => t?.format?.protocol === 'progressive' || t?.format?.protocol === 'hls')) out.reject = 'protected';
  // SoundCloud's own previews report a short `duration` next to the song's real `full_duration`
  else if (preview && positive(raw?.full_duration) && raw.full_duration > preview + 5000) out.reject = 'preview';
  else if (preview && preview <= PREVIEW_SECONDS * 1000 && wantedMs > (PREVIEW_SECONDS + 15) * 1000) out.reject = 'preview';
  return out;
}

/**
 * How well one result matches the wanted song: { score: 0..1, accepted, reason? }.
 * The score ranks results from the same site; `accepted` is the yes/no.
 */
export function score(wanted, candidate, source = candidate?.source || 'soundcloud') {
  const info = describe(candidate, source, wanted?.durationMs);
  if (info.reject) {
    // a label-protected or preview-only SoundCloud copy: is it otherwise the right song? (shown apart from "not found")
    const locked = source === 'soundcloud' && LOCKED.has(info.reject) && score(wanted, playableCopy(candidate), source).accepted;
    return { score: 0, accepted: false, reason: info.reject, locked };
  }
  const runs = artistList(wanted?.artists);
  const wantedTokens = tokens(wanted?.title);
  const titleSim = Math.max(0, ...titleVariants(info.title, runs).map(v => dice(wantedTokens, v)));
  const artist = artistMatches(runs, info.names, info.title);

  const have = versionWords(info.title);
  const want = versionWords(wanted?.title);
  const extra = [...have].filter(w => !want.has(w)).length;
  const lacking = [...want].filter(w => !have.has(w));
  const missing = lacking.length;

  let diff = null;
  let durationTerm = 0;
  if (info.durationMs && positive(wanted?.durationMs)) {
    diff = Math.abs(info.durationMs - wanted.durationMs) / 1000;
    // the closer the better, so of two matching copies the one with the same length ranks first
    durationTerm = diff <= MATCH_SECONDS ? 0.2 - 0.01 * diff : diff <= FAR_SECONDS ? 0.17 * (1 - (diff - MATCH_SECONDS) / (FAR_SECONDS - MATCH_SECONDS)) : -0.5;
  }

  const value = 0.55 * titleSim + (artist ? 0.25 : 0) + durationTerm - 0.35 * extra - 0.25 * missing;
  const sure = diff !== null && diff <= MATCH_SECONDS && titleSim >= 0.9;
  let reason = null;
  if (titleSim < 0.6) reason = 'title';
  else if (extra) reason = 'version';
  // the remix / live / sped up version was asked for; "Radio Edit" is the one label that uploads often drop
  else if (lacking.some(w => w !== 'edit')) reason = 'version';
  else if (diff !== null && diff > FAR_SECONDS) reason = 'duration';
  // someone else's upload of a same-named song needs the length to agree exactly
  else if (!artist && !sure) reason = 'artist';
  return { score: Math.min(1, Math.max(0, value)), accepted: !reason, reason };
}

const SITES = ['soundcloud', 'audius', 'bandcamp'];
const LOCKED = new Set(['protected', 'unavailable']);
const playableCopy = (track) => ({ ...track, policy: 'ALLOW', streamable: true, duration: track.full_duration || track.duration,
  media: { transcodings: [{ format: { protocol: 'progressive' }, snipped: false }] } });
const MAX_ALTERNATES = 4;

/** Strict priority: SoundCloud, then Audius, then Bandcamp. Other acceptable copies are backups. */
export function pick(wanted, found = {}) {
  const scored = SITES.map(source => (Array.isArray(found[source]) ? found[source] : [])
    .map(raw => ({ source, raw, ...score(wanted, raw, source) })));
  const ordered = scored.map(list => list.filter(entry => entry.accepted).sort((a, b) => b.score - a.score)).flat();
  const chosen = ordered[0] || null;
  return {
    chosen,
    alternates: ordered.slice(1, 1 + MAX_ALTERNATES),
    status: !chosen ? 'unmatched' : chosen.source === 'bandcamp' ? 'link-only' : 'matched',
    // nothing playable, but SoundCloud has the song locked (copy-protected or a preview)
    locked: !chosen && scored[0].some(entry => entry.locked)
  };
}

/** The search text for a Spotify song: first artist and title */
export function queryFor(wanted) {
  const first = String(wanted?.artists || '').split(',')[0].trim();
  return `${first} ${String(wanted?.title || '').replace(/\s*[([]\s*(?:feat|ft|featuring)\b[^)\]]*[)\]]/gi, '').trim()}`.trim();
}
