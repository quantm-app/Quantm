'use strict';

// Last.fm credentials and requests remain in the main process.
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

function createLastfm({ directory, safeStorage, openExternal, request = fetch }) {
  const file = path.join(directory, 'lastfm.json');
  let config = null;
  let token = null;
  let pendingConfig = null;
  let flushing = false;
  let retryTimer = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (safeStorage.isEncryptionAvailable()) config = JSON.parse(safeStorage.decryptString(Buffer.from(saved.data, 'base64')));
  } catch (e) { /* not connected yet */ }

  function save() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.');
    const data = safeStorage.encryptString(JSON.stringify(config)).toString('base64');
    fs.writeFileSync(file, JSON.stringify({ data }), { mode: 0o600 });
  }
  async function call(method, fields = {}, signed = false, credentials = config) {
    const params = { method, api_key: credentials.key, ...fields };
    if (signed) {
      const input = Object.keys(params).sort().map(k => k + params[k]).join('') + credentials.secret;
      params.api_sig = createHash('md5').update(input, 'utf8').digest('hex');
    }
    params.format = 'json';
    const response = await request('https://ws.audioscrobbler.com/2.0/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || result.error) {
      const error = new Error(result.message || 'Last.fm request failed.');
      error.code = result.error;
      throw error;
    }
    return result;
  }
  async function flush() {
    if (flushing || !config?.session || !config.queue?.length) return;
    flushing = true;
    const active = config;
    try {
      while (config === active && active.queue.length) {
        const item = active.queue[0];
        try {
          await call('track.scrobble', { sk: active.session, ...item }, true, active);
          if (config !== active) break;
          active.queue.shift();
          save();
        } catch (e) {
          // Invalid metadata cannot succeed on retry; other errors are retried later.
          if (e.code === 6 && config === active) { active.queue.shift(); save(); continue; }
          break;
        }
      }
    } finally {
      flushing = false;
      if (config?.queue?.length && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; flush(); }, 60000);
    }
  }
  if (config?.queue?.length) flush();
  return {
    status: () => ({ connected: !!config?.session, username: config?.username || '' }),
    async begin(key, secret) {
      if (!/^[a-f\d]{32}$/i.test(key || '') || !/^[a-f\d]{32}$/i.test(secret || '')) throw new Error('Enter a valid Last.fm API key and shared secret.');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.');
      pendingConfig = { key, secret };
      try {
        const result = await call('auth.getToken', {}, false, pendingConfig);
        token = result.token;
        if (!token) throw new Error('Last.fm did not return an authorization token.');
        await openExternal('https://www.last.fm/api/auth/?' + new URLSearchParams({ api_key: key, token }));
      } catch (e) { pendingConfig = null; token = null; throw e; }
    },
    async finish() {
      if (!token || !pendingConfig) throw new Error('Start authorization first.');
      const result = await call('auth.getSession', { token }, true, pendingConfig);
      if (!result.session?.key) throw new Error('Last.fm did not return a session.');
      const previous = config;
      config = { ...pendingConfig, session: result.session.key, username: result.session.name, queue: [] };
      try { save(); } catch (e) { config = previous; throw e; }
      token = null; pendingConfig = null;
      return { connected: true, username: config.username };
    },
    disconnect() {
      config = null; token = null; pendingConfig = null;
      clearTimeout(retryTimer); retryTimer = null;
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    async submit(method, track) {
      if (!config?.session) return;
      if (!['track.updateNowPlaying', 'track.scrobble'].includes(method)) throw new Error('Invalid Last.fm request.');
      if (!track || typeof track.artist !== 'string' || typeof track.track !== 'string' || !track.artist.trim() || !track.track.trim() || track.artist.length > 500 || track.track.length > 500) return;
      const fields = { sk: config.session, artist: track.artist, track: track.track };
      if (Number.isFinite(track.duration) && track.duration > 0) fields.duration = Math.round(track.duration);
      if (method === 'track.scrobble') {
        if (!Number.isInteger(track.timestamp) || track.timestamp <= 0 || track.timestamp > Date.now() / 1000 + 60) return;
        fields.timestamp = track.timestamp;
      }
      if (method === 'track.scrobble') {
        delete fields.sk;
        config.queue ||= [];
        config.queue.push(fields);
        try { save(); } catch (e) { config.queue.pop(); throw e; }
        flush();
        return;
      }
      return call(method, fields, true);
    }
  };
}
module.exports = { createLastfm };
