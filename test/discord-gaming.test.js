import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const net = require('net');

// discord.js talks to Discord over a local pipe: swap net.createConnection for a fake socket
// and read the frames it would have written.
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const sockets = [];
  t.mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.frames = [];
    socket.write = (buffer) => {
      const length = buffer.readInt32LE(4);
      socket.frames.push({ op: buffer.readInt32LE(0), data: JSON.parse(buffer.slice(8, 8 + length).toString()) });
    };
    socket.destroy = () => { socket.destroyed = true; };
    sockets.push(socket);
    setImmediate(() => socket.emit('connect'));
    return socket;
  });
  const path = require.resolve('../discord.js');
  delete require.cache[path];
  const discord = require('../discord.js');

  const reply = (socket, op, data) => {
    const json = Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    socket.emit('data', Buffer.concat([header, json]));
  };
  // connect and answer READY (the mocked setImmediate is not faked, so wait for a real tick)
  const connect = async () => {
    discord.connect();
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[sockets.length - 1];
    reply(socket, 1, { evt: 'READY' });
    return socket;
  };
  // the SET_ACTIVITY frames written to a socket (the handshake is not one)
  const activities = (socket) => socket.frames.filter(f => f.data.cmd === 'SET_ACTIVITY').map(f => f.data.args.activity);
  return { discord, sockets, connect, reply, activities };
}

const song = { title: 'Song', artist: 'Artist', playing: true, duration: 200, position: 10, showIdle: true };
const paused = { title: 'Song', artist: 'Artist', playing: false, showIdle: true };
const idle = { showIdle: true };

test('gaming clears the activity and the last song comes back when it ends', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.update(song);
  assert.equal(activities(socket).at(-1).details, 'Song');

  discord.setGaming(true);
  assert.equal(activities(socket).at(-1), undefined, 'cleared');
  const sent = socket.frames.length;

  discord.setGaming(false);
  t.mock.timers.tick(60000);
  assert.equal(activities(socket).at(-1).details, 'Song', 'restored');
  assert.equal(activities(socket).at(-1).type, 2);
  assert.equal(socket.frames.length, sent + 1);
});

test('grace period: under 60 seconds after fullscreen ends it still hides, after that it restores', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.update(song);
  discord.setGaming(true);
  discord.setGaming(false);
  const hidden = socket.frames.length;

  t.mock.timers.tick(59000);
  assert.equal(socket.frames.length, hidden, 'nothing sent yet');
  assert.equal(discord.status().gaming, true);

  // alt-tab back into the game: the grace period starts over and nothing flickers
  discord.setGaming(true);
  t.mock.timers.tick(30000);
  discord.setGaming(false);
  t.mock.timers.tick(59000);
  assert.equal(socket.frames.length, hidden);

  t.mock.timers.tick(1000);
  assert.equal(discord.status().gaming, false);
  assert.equal(activities(socket).at(-1).details, 'Song');
});

test('a restored song keeps its original timestamps (they are absolute times)', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.update(song);
  const first = activities(socket).at(-1).timestamps;
  discord.setGaming(true);
  discord.setGaming(false);
  t.mock.timers.tick(60000);
  assert.deepEqual(activities(socket).at(-1).timestamps, first);
});

test('hide setting off: a song still shows while gaming but the idle status never does', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.setHideWhileGaming(false);
  discord.update(idle);
  assert.equal(activities(socket).at(-1).type, 0, 'idle shows before gaming');

  discord.setGaming(true);
  assert.equal(activities(socket).at(-1), undefined, 'idle taken down when gaming starts');

  const quiet = socket.frames.length;
  discord.update(idle);
  discord.update(paused);
  assert.equal(socket.frames.length, quiet, 'idle updates while gaming send nothing');

  discord.update(song);
  assert.equal(activities(socket).at(-1).type, 2, 'the song shows while gaming');

  discord.update(paused); // song stops: the idle status must not come back, the song is taken down
  assert.equal(activities(socket).at(-1), undefined);
  const count = socket.frames.length;
  discord.update(idle);
  discord.update(paused);
  assert.equal(socket.frames.length, count, 'idle is never sent while gaming');

  discord.setGaming(false);
  t.mock.timers.tick(60000);
  assert.equal(activities(socket).at(-1).type, 0, 'idle returns after gaming');
});

test('turning the hide setting on or off while gaming applies at once', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.setHideWhileGaming(false);
  discord.update(song);
  discord.setGaming(true);
  assert.equal(activities(socket).at(-1).type, 2);
  discord.setHideWhileGaming(true);
  assert.equal(activities(socket).at(-1), undefined);
  discord.setHideWhileGaming(false);
  assert.equal(activities(socket).at(-1).type, 2);
});

test('updates while gaming are stored, not sent, and the latest is restored', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.update(song);
  discord.setGaming(true);
  const hidden = socket.frames.length;

  discord.update(Object.assign({}, song, { title: 'Second' }));
  discord.update(Object.assign({}, song, { title: 'Third' }));
  assert.equal(socket.frames.length, hidden, 'nothing sent while gaming');

  discord.setGaming(false);
  t.mock.timers.tick(60000);
  assert.equal(activities(socket).at(-1).details, 'Third');
  assert.equal(socket.frames.length, hidden + 1);
});

test('connecting or reconnecting while gaming sends nothing, and the song returns afterwards', async (t) => {
  const { discord, connect, activities, sockets, reply } = setup(t);
  discord.update(song); // stored while not connected yet
  const first = { start: 1_000_000 - 10000, end: 1_000_000 + 190000 };
  discord.setGaming(true);
  const socket = await connect();
  assert.equal(activities(socket).length, 0, 'READY while gaming sends nothing');

  // Discord restarts: a new connection, still gaming
  socket.emit('close');
  t.mock.timers.tick(30000);
  await new Promise((resolve) => setImmediate(resolve));
  const second = sockets[sockets.length - 1];
  assert.notEqual(second, socket);
  reply(second, 1, { evt: 'READY' });
  assert.equal(activities(second).length, 0, 'reconnect while gaming sends nothing');

  discord.setGaming(false);
  t.mock.timers.tick(60000);
  assert.equal(activities(second).at(-1).details, 'Song');
  assert.deepEqual(activities(second).at(-1).timestamps, first, 'timestamps unchanged after a reconnect');
});

test('with the status turned off nothing is sent and gaming changes nothing', async (t) => {
  const { discord, connect, activities } = setup(t);
  const socket = await connect();
  discord.update(song);
  discord.setEnabled(false);
  const count = socket.frames.length;
  discord.update(song);
  discord.setGaming(true);
  discord.setGaming(false);
  t.mock.timers.tick(60000);
  assert.equal(socket.frames.length, count);
  assert.equal(activities(socket).at(-1), undefined);
  t.mock.timers.tick(1000); // let the delayed close run
});
