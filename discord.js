'use strict';

// Discord Rich Presence over Discord's local IPC pipe (no dependencies, no login).
// Shows "Listening to Quantm" with the track, artist, artwork and a progress bar.

const net = require('net');
const path = require('path');
const os = require('os');

// Public id of the "Quantm" application on discord.com/developers (not a secret)
const CLIENT_ID = '1561269799105855583';

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;

let socket = null;
let ready = false;
let connecting = false;
let enabled = true;
let lastActivity = null;   // re-sent after (re)connecting
let retryTimer = null;
let disconnectTimer = null; // the delayed close after turning it off

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  return path.join(dir, `discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function send(op, data) {
  if (socket && !socket.destroyed) socket.write(encode(op, data));
}

function configured() {
  return /^\d{15,25}$/.test(CLIENT_ID);
}

/** Try the 10 possible Discord pipes until one answers */
function connect(i = 0) {
  if (!enabled || !configured() || socket || connecting) return;
  connecting = true;
  if (i > 9) { connecting = false; scheduleRetry(); return; }

  const attempt = net.createConnection(pipePath(i));
  attempt.once('error', () => {
    attempt.destroy();
    connecting = false;
    connect(i + 1);
  });
  attempt.once('connect', () => {
    connecting = false;
    socket = attempt;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readInt32LE(0);
        const length = buffer.readInt32LE(4);
        if (buffer.length < 8 + length) break;
        let message = null;
        try { message = JSON.parse(buffer.slice(8, 8 + length).toString()); } catch (e) { /* ignore */ }
        buffer = buffer.slice(8 + length);
        if (op === OP_FRAME && message && message.evt === 'READY') {
          ready = true;
          if (lastActivity !== undefined) setActivity(lastActivity);
        }
        if (op === OP_CLOSE) disconnect();
      }
    });
    socket.on('close', () => { disconnect(); scheduleRetry(); });
    socket.on('error', () => {});
    send(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID });
  });
}

function disconnect() {
  ready = false;
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
}

// Discord may not be running yet: check again every 30 seconds
function scheduleRetry() {
  if (retryTimer || !enabled) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 30000);
}

function setActivity(activity) {
  lastActivity = activity;
  if (!ready) { connect(); return; }
  send(OP_FRAME, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity: activity || undefined },
    nonce: String(Date.now()) + Math.random().toString(16).slice(2)
  });
}

const clip = (text, max = 128) => {
  const value = String(text || '').trim();
  if (value.length < 2) return (value + '  ').slice(0, 2); // Discord needs 2+ characters
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
};

const openedAt = Date.now();

/** While Quantm is open but not playing: "Playing Quantm", browsing or paused on a song */
function idleActivity(state) {
  const paused = !!(state && state.title);
  const activity = {
    type: 0, // "Playing Quantm"
    details: paused ? clip('Paused: ' + state.title) : 'Browsing',
    assets: { large_image: (paused && state.artwork) || 'quantm', large_text: 'Quantm' },
    timestamps: { start: openedAt }, // how long Quantm has been open
    buttons: [{ label: 'Get Quantm', url: 'https://github.com/quantm-app/Quantm' }],
    instance: false
  };
  if (paused) {
    activity.state = clip('by ' + (state.artist || 'Unknown artist'));
    activity.assets.small_image = 'quantm';
    activity.assets.small_text = 'Quantm';
  }
  return activity;
}

/**
 * Update from the renderer.
 * state: { title, artist, artwork, url, artistUrl, duration (s), position (s), playing, showIdle }
 * (title is empty when nothing is loaded). showIdle keeps a status up while nothing plays.
 */
function update(state) {
  if (!enabled) return;
  if (!state || !state.title || !state.playing) {
    // nothing playing (or paused): an idle status while Quantm is open, or none at all
    setActivity(state && state.showIdle ? idleActivity(state) : null);
    return;
  }
  const now = Date.now();
  const activity = {
    type: 2, // "Listening to"
    // the short status (member list, profile corner) shows the app name: 0 = "Quantm"
    status_display_type: 0,
    details: clip(state.title),
    state: clip('by ' + (state.artist || 'Unknown artist')),
    assets: {
      large_image: state.artwork || 'quantm',
      large_text: clip(state.title),
      small_image: 'quantm',
      small_text: 'Quantm'
    },
    instance: false
  };
  if (state.duration > 0) {
    activity.timestamps = {
      start: Math.round(now - state.position * 1000),
      end: Math.round(now + (state.duration - state.position) * 1000)
    };
  }
  const buttons = [];
  if (/^https:\/\//.test(state.url || '')) buttons.push({ label: 'Listen on SoundCloud', url: state.url });
  if (/^https:\/\//.test(state.artistUrl || '')) buttons.push({ label: 'View artist', url: state.artistUrl });
  if (buttons.length) activity.buttons = buttons;
  setActivity(activity);
}

function setEnabled(on) {
  enabled = !!on;
  if (!enabled) {
    if (ready) send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: String(Date.now()) });
    lastActivity = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(disconnect, 200);
  } else {
    // turned back on before the delayed close ran: keep the connection instead of killing it
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
    connect();
  }
}

function status() {
  return { configured: configured(), connected: ready, enabled };
}

module.exports = { update, setEnabled, status, connect };
