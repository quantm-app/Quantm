import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCaptchaUrl, redact, humanCheckUrl, clearanceFrom, clearanceFromCookie } = require('../human-check.js');

test('clearanceFromCookie accepts only datadome cookies on captcha-delivery.com', () => {
  const got = clearanceFromCookie({ name: 'datadome', value: 'abc', domain: '.captcha-delivery.com', expirationDate: 1900000000 });
  assert.deepEqual(got, { value: 'abc', expirationDate: 1900000000 });
  const year = clearanceFromCookie({ name: 'datadome', value: 'abc', domain: 'geo.captcha-delivery.com' });
  assert.ok(Math.abs(year.expirationDate - (Math.floor(Date.now() / 1000) + 365 * 24 * 3600)) <= 2);
  assert.equal(clearanceFromCookie({ name: 'datadome', value: 'abc', domain: '.soundcloud.com' }), null);
  assert.equal(clearanceFromCookie({ name: 'datadome', value: 'abc', domain: 'evil-captcha-delivery.com' }), null);
  assert.equal(clearanceFromCookie({ name: 'other', value: 'abc', domain: '.captcha-delivery.com' }), null);
  assert.equal(clearanceFromCookie({ name: 'datadome', value: '', domain: '.captcha-delivery.com' }), null);
  assert.equal(clearanceFromCookie(null), null);
});

test('humanCheckUrl accepts only https captcha-delivery.com pages', () => {
  assert.equal(humanCheckUrl({ url: 'https://geo.captcha-delivery.com/captcha/?a=1' }), 'https://geo.captcha-delivery.com/captcha/?a=1');
  assert.equal(humanCheckUrl({ url: 'http://geo.captcha-delivery.com/captcha/' }), null);
  assert.equal(humanCheckUrl({ url: 'https://evil-captcha-delivery.com/captcha/' }), null);
  assert.equal(humanCheckUrl({ url: 'https://captcha-delivery.com.evil.com/' }), null);
  assert.equal(humanCheckUrl({}), null);
  assert.equal(humanCheckUrl(null), null);
  assert.equal(humanCheckUrl({ url: 'not a url' }), null);
});

test('clearanceFrom reads the cookie from the check answer (JSON body)', () => {
  const now = Math.floor(Date.now() / 1000);
  const got = clearanceFrom(JSON.stringify({ cookie: 'datadome=abc123; Max-Age=3600; Domain=.soundcloud.com; Path=/' }));
  assert.equal(got.value, 'abc123');
  assert.ok(got.expirationDate >= now + 3599 && got.expirationDate <= now + 3602);
});

test('clearanceFrom reads a raw cookie string (message mode)', () => {
  const got = clearanceFrom('datadome=xyz-_~789; Max-Age=60; Path=/');
  assert.equal(got.value, 'xyz-_~789');
  assert.ok(got.expirationDate - Math.floor(Date.now() / 1000) <= 61);
});

test('clearanceFrom defaults to a year without Max-Age', () => {
  const got = clearanceFrom('datadome=abc');
  const year = 365 * 24 * 3600;
  assert.ok(Math.abs(got.expirationDate - (Math.floor(Date.now() / 1000) + year)) <= 2);
});

test('clearanceFrom rejects garbage and other cookies', () => {
  assert.equal(clearanceFrom('not json'), null);
  assert.equal(clearanceFrom(''), null);
  assert.equal(clearanceFrom(undefined), null);
  assert.equal(clearanceFrom(null), null);
  assert.equal(clearanceFrom('{}'), null);
  assert.equal(clearanceFrom('[]'), null);
  assert.equal(clearanceFrom('null'), null);
  assert.equal(clearanceFrom(JSON.stringify({ cookie: 123 })), null);
  assert.equal(clearanceFrom(JSON.stringify({ cookie: 'session=abc; Max-Age=60' })), null);
  assert.equal(clearanceFrom('session=abc; Max-Age=60'), null);
  assert.equal(clearanceFrom('datadome=; Max-Age=60'), null);
  assert.equal(clearanceFrom(JSON.stringify({ cookie: 'datadome=; Max-Age=60' })), null);
});

test('isCaptchaUrl accepts only https captcha-delivery.com hosts', () => {
  assert.equal(isCaptchaUrl('https://geo.captcha-delivery.com/captcha/?a=1'), true);
  assert.equal(isCaptchaUrl('https://captcha-delivery.com/'), true);
  assert.equal(isCaptchaUrl('http://geo.captcha-delivery.com/'), false);
  assert.equal(isCaptchaUrl('https://evil-captcha-delivery.com/'), false);
  assert.equal(isCaptchaUrl('https://captcha-delivery.com.evil.com/'), false);
  assert.equal(isCaptchaUrl('https://soundcloud.com/'), false);
  assert.equal(isCaptchaUrl('about:blank'), false);
  assert.equal(isCaptchaUrl(''), false);
  assert.equal(isCaptchaUrl(undefined), false);
  assert.equal(isCaptchaUrl(null), false);
});

test('redact hides datadome cookie values', () => {
  const out = redact('set datadome=AbC123xyz~_-; Max-Age=60 and datadome=second value');
  assert.ok(!out.includes('AbC123xyz'));
  assert.ok(!out.includes('second'));
  assert.equal(out, 'set datadome=<redacted>; Max-Age=60 and datadome=<redacted> value');
});

test('redact drops query strings, including on relative URLs', () => {
  assert.equal(redact('GET /captcha/check?cid=secret&x=1 failed'), 'GET /captcha/check failed');
  assert.equal(redact('fetch https://example.com/interstitial/?initialCid=abc now'), 'fetch https://example.com/interstitial/ now');
  assert.equal(redact('a?b c?d'), 'a c');
});

test('redact hides long token-like runs', () => {
  const token = 'A'.repeat(24);
  assert.equal(redact('id ' + token + ' end'), 'id <redacted> end');
  assert.equal(redact('id ' + 'a1_b2~c3.d4-'.repeat(4) + ' end'), 'id <redacted> end');
  assert.equal(redact('id ' + 'A'.repeat(23) + ' end'), 'id ' + 'A'.repeat(23) + ' end');
});

test('redact leaves normal text alone and caps the length', () => {
  assert.equal(redact('Refused to load the script (CSP)'), 'Refused to load the script (CSP)');
  assert.equal(redact('x'.repeat(10) + ' y '.repeat(100)).length, 200);
  assert.equal(redact(undefined), 'undefined');
});
