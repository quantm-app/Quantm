import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { compact, duration, timeAgo, artwork, coverOf, escapeHtml, linkify, sliderKey, Emitter } = await import('../src/js/dom.js');

test('compact formats counts at each magnitude and missing values', () => {
  for (const [input, expected] of [[null, ''], [undefined, ''], [0, '0'], [999, '999'], [1000, '1K'], [1500, '1.5K'], [125000, '125K'], [1000000, '1M'], [1500000, '1.5M'], [12000000, '12M'], [1000000000, '1B'], [1250000000, '1.3B'], [12000000000, '12B']]) {
    assert.equal(compact(input), expected);
  }
});

test('duration formats milliseconds, including hours and zero', () => {
  for (const [input, expected] of [[undefined, ''], [null, ''], [0, '0:00'], [999, '0:00'], [187999, '3:07'], [3600000, '1:00:00'], [3723000, '1:02:03']]) {
    assert.equal(duration(input), expected);
  }
});

test('timeAgo uses a fixed clock and singular/plural units', t => {
  const now = Date.UTC(2026, 9, 18);
  t.mock.method(Date, 'now', () => now);
  for (const [seconds, expected] of [[0, 'just now'], [59, 'just now'], [60, '1 minute ago'], [120, '2 minutes ago'], [3600, '1 hour ago'], [7200, '2 hours ago'], [86400, '1 day ago'], [259200, '3 days ago'], [604800, '1 week ago'], [2592000, '1 month ago'], [31536000, '1 year ago'], [63072000, '2 years ago']]) {
    assert.equal(timeAgo(new Date(now - seconds * 1000).toISOString()), expected);
  }
});

test('artwork and coverOf choose sizes and avatar fallbacks', () => {
  assert.equal(artwork(null), null);
  assert.equal(artwork('https://img/art-large.jpg'), 'https://img/art-t500x500.jpg');
  assert.equal(artwork('https://img/art-t500x500.jpg', 'badge'), 'https://img/art-badge.jpg');
  assert.equal(artwork('https://img/plain.jpg'), 'https://img/plain.jpg');
  assert.equal(coverOf({ user: { avatar_url: 'avatar-large.jpg' } }, 'small'), 'avatar-small.jpg');
  assert.equal(coverOf({ artwork_url: 'cover-large.jpg', user: { avatar_url: 'avatar-large.jpg' } }), 'cover-t500x500.jpg');
  assert.equal(coverOf(null), null);
});

test('text formatters escape HTML before creating links and line breaks', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(linkify('<b>Hi</b>\nhttps://example.com'), '&lt;b&gt;Hi&lt;/b&gt;<br><a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a>');
});

test('Emitter unsubscribe stops future deliveries', () => {
  const emitter = new Emitter();
  const seen = [];
  const off = emitter.on('change', value => seen.push(value));
  emitter.emit('change', 1);
  off();
  emitter.emit('change', 2);
  assert.deepEqual(seen, [1]);
});

test('sliderKey moves by arrows and pages, jumps with Home and End, stays in range and ignores other keys', () => {
  assert.equal(sliderKey('ArrowRight', 50, 0, 100, 5), 55);
  assert.equal(sliderKey('ArrowUp', 50, 0, 100, 5), 55);
  assert.equal(sliderKey('ArrowLeft', 50, 0, 100, 5), 45);
  assert.equal(sliderKey('ArrowDown', 50, 0, 100, 5), 45);
  assert.equal(sliderKey('PageUp', 50, 0, 100, 5, 30), 80);
  assert.equal(sliderKey('PageDown', 50, 0, 100, 5), 20);
  assert.equal(sliderKey('Home', 50, 0, 100, 5), 0);
  assert.equal(sliderKey('End', 50, 0, 100, 5), 100);
  assert.equal(sliderKey('ArrowLeft', 2, 0, 100, 5), 0);
  assert.equal(sliderKey('ArrowRight', 98, 0, 100, 5), 100);
  for (const key of ['a', ' ', 'Enter', 'Tab', 'constructor', 'toString']) assert.equal(sliderKey(key, 50, 0, 100, 5), null);
});
