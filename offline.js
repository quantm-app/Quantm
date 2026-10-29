'use strict';

// Offline downloads: only tracks whose artist turned on SoundCloud's download button.
// The main process checks that with SoundCloud itself (never trusting the page), fetches the
// artist's file from SoundCloud's official download link, and keeps it in userData/offline:
//   <id>.<ext>   the audio file as the artist uploaded it
//   <id>.jpg     its artwork, so the offline library has covers without internet
//   index.json   the details of every download
// The page plays them through the quantm-offline:// scheme (quantm-offline://track/<id>).

const { app, net, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { Readable } = require('stream');

const SCHEME = 'quantm-offline';
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // originals can be big WAVs; 2 GB is plenty
const DOWNLOAD_HOSTS = /(^|\.)(sndcdn\.com|soundcloud\.com|soundcloud\.cloud)$/;

const EXT_BY_TYPE = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff'
};
const MIME_BY_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', aiff: 'audio/aiff' };

let index = null;           // { "<id>": entry }
const active = new Map();   // id -> AbortController for downloads in progress

const dir = () => path.join(app.getPath('userData'), 'offline');
const indexFile = () => path.join(dir(), 'index.json');

function load() {
  if (index) return index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
  } catch (e) {
    index = {};
  }
  // valid JSON that isn't an index (null, a list, a number) would make every later load() throw
  if (!index || typeof index !== 'object' || Array.isArray(index)) index = {};
  // forget entries whose file was deleted by hand
  for (const [id, entry] of Object.entries(index)) {
    if (!entry || !entry.file || !fs.existsSync(path.join(dir(), entry.file))) delete index[id];
  }
  return index;
}

function save() {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = indexFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, indexFile());
}

/** The details kept for a downloaded track (enough to show and play it offline) */
function slim(track) {
  const user = track.user || {};
  return {
    id: track.id,
    kind: 'track',
    title: track.title,
    duration: track.duration,
    full_duration: track.full_duration,
    genre: track.genre,
    permalink_url: track.permalink_url,
    artwork_url: track.artwork_url,
    waveform_url: track.waveform_url,
    downloadable: true,
    user: { id: user.id, username: user.username, avatar_url: user.avatar_url, permalink_url: user.permalink_url }
  };
}

function publicEntry(entry) {
  return Object.assign({}, entry, { track: Object.assign({}, entry.track, { offline: true }) });
}

function list() {
  const entries = Object.values(load()).sort((a, b) => b.downloadedAt - a.downloadedAt).map(publicEntry);
  return { entries, totalBytes: entries.reduce((sum, e) => sum + (e.size || 0), 0), downloading: [...active.keys()] };
}

function extensionFor(response) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const disposition = response.headers.get('content-disposition') || '';
  const named = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
  const fromName = named ? path.extname(decodeURIComponent(named[1])).slice(1).toLowerCase() : '';
  if (MIME_BY_EXT[fromName]) return fromName;
  const fromUrl = path.extname(new URL(response.url).pathname).slice(1).toLowerCase();
  return MIME_BY_EXT[fromUrl] ? fromUrl : 'mp3';
}

async function saveArtwork(track, id) {
  const url = track.artwork_url || (track.user && track.user.avatar_url);
  if (!url) return null;
  try {
    const big = url.replace(/-(large|t\d+x\d+|crop|original|badge|small|tiny|mini)\./, '-t500x500.');
    const parsed = new URL(big);
    if (parsed.protocol !== 'https:' || !/(^|\.)sndcdn\.com$/.test(parsed.hostname)) return null;
    const response = await net.fetch(parsed.toString(), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) return null;
    const file = id + '.jpg';
    fs.writeFileSync(path.join(dir(), file), Buffer.from(await response.arrayBuffer()));
    return file;
  } catch (e) {
    return null;
  }
}

/**
 * Download a track for offline play. `apiRequest` is main.js's authenticated SoundCloud proxy.
 * `notify(progress)` reports { id, received, total } and finally { id, done } or { id, error }.
 */
async function download(apiRequest, id, notify) {
  const key = String(id);
  if (!/^\d{1,15}$/.test(key)) throw new Error('Invalid track');
  if (load()[key]) return publicEntry(load()[key]);
  if (active.has(key)) throw new Error('Already downloading');

  const controller = new AbortController();
  active.set(key, controller);
  const tmp = path.join(dir(), key + '.part');
  try {
    // ask SoundCloud whether the artist allows downloads, rather than trusting the page
    const info = await apiRequest({ method: 'GET', resource: 'tracks/' + key });
    if (!info.ok || !info.data) throw new Error("Couldn't reach SoundCloud");
    if (!info.data.downloadable) throw new Error("The artist hasn't allowed downloads for this track");
    if (info.data.has_downloads_left === false) throw new Error('This track has reached its download limit');

    const link = await apiRequest({ method: 'GET', resource: `tracks/${key}/download` });
    if (!link.ok || !link.data || !link.data.redirectUri) throw new Error("SoundCloud didn't offer a download for this track");
    const source = new URL(link.data.redirectUri);
    if (source.protocol !== 'https:' || !DOWNLOAD_HOSTS.test(source.hostname)) throw new Error('Unexpected download location');

    const response = await net.fetch(source.toString(), { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Download failed (' + response.status + ')');
    const ext = extensionFor(response);
    const total = Number(response.headers.get('content-length')) || 0;
    if (total > MAX_BYTES) throw new Error('The file is too large');

    fs.mkdirSync(dir(), { recursive: true });
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let lastReport = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > MAX_BYTES) throw new Error('The file is too large');
        if (!out.write(chunk)) await once(out, 'drain');
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          notify({ id: Number(key), received, total });
        }
      }
    } finally {
      await new Promise(resolve => out.end(resolve));
    }

    const file = key + '.' + ext;
    fs.renameSync(tmp, path.join(dir(), file));
    const entry = {
      id: Number(key),
      file,
      ext,
      size: received,
      downloadedAt: Date.now(),
      artFile: await saveArtwork(info.data, key),
      track: slim(info.data)
    };
    load()[key] = entry;
    save();
    notify({ id: Number(key), done: true });
    return publicEntry(entry);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (e) { /* nothing written */ }
    const message = controller.signal.aborted ? 'Download cancelled' : String(error && error.message || error);
    notify({ id: Number(key), error: message });
    throw new Error(message);
  } finally {
    active.delete(key);
  }
}

function cancel(id) {
  const controller = active.get(String(id));
  if (controller) controller.abort();
}

function remove(id) {
  const key = String(id);
  const entry = load()[key];
  if (!entry) return false;
  for (const name of [entry.file, entry.artFile]) {
    if (name) try { fs.unlinkSync(path.join(dir(), name)); } catch (e) { /* already gone */ }
  }
  delete index[key];
  save();
  return true;
}

function removeAll() {
  Object.keys(load()).forEach(remove);
  return true;
}

/** Must run before app 'ready': lets the page stream these files and read them from Web Audio */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }]);
}

/** quantm-offline://track/<id> (audio, with seeking) and quantm-offline://art/<id> */
function handleScheme() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const key = url.pathname.replace(/^\/+/, '');
    const entry = /^\d+$/.test(key) ? load()[key] : null;
    const name = entry && (url.hostname === 'art' ? entry.artFile : url.hostname === 'track' ? entry.file : null);
    const file = name && path.join(dir(), name);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const type = url.hostname === 'art' ? 'image/jpeg' : (MIME_BY_EXT[entry.ext] || 'audio/mpeg');
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    // the audio element needs the length (to know the duration) and byte ranges (to seek)
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (match && (match[1] || match[2])) {
      let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Access-Control-Allow-Origin': '*' } });
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
    }
    headers['Content-Length'] = String(size);
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
  });
}

module.exports = { SCHEME, registerScheme, handleScheme, list, download, cancel, remove, removeAll, folder: dir };
