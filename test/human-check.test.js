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

test('apiHeaders never sets a Cookie header (the cookie jar sends the clearance)', () => {
  const { apiHeaders } = require('../human-check.js');
  const get = apiHeaders('tok', false);
  assert.deepEqual(Object.keys(get).sort(), ['Accept', 'Authorization', 'Origin', 'Referer']);
  assert.equal(get.Authorization, 'OAuth tok');
  const post = apiHeaders('tok', true);
  assert.equal(post['Content-Type'], 'application/json');
  for (const headers of [get, post]) assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === 'cookie'));
});

test('recentlyPassed is true only within 60 s after a passed check', () => {
  const { recentlyPassed } = require('../human-check.js');
  assert.equal(recentlyPassed(0, 1000), false);
  assert.equal(recentlyPassed(1000, 31000), true);
  assert.equal(recentlyPassed(1000, 61000), true);
  assert.equal(recentlyPassed(1000, 61001), false);
  assert.equal(recentlyPassed(5000, 1000), false);
});

test('apiHeaders adds X-DataDome-ClientID only for a safe, non-empty value', () => {
  const { apiHeaders } = require('../human-check.js');
  const name = 'X-DataDome-ClientID';
  assert.equal(apiHeaders('tok', false, 'abc_DEF-123~')[name], 'abc_DEF-123~');
  assert.equal(apiHeaders('tok', true, 'v')[name], 'v');
  assert.equal(apiHeaders('tok', true, 'v')['Content-Type'], 'application/json');
  assert.equal(apiHeaders('tok', false, 'a'.repeat(1024))[name], 'a'.repeat(1024));
  for (const bad of [undefined, null, '', 'a'.repeat(1025), 'a\r\nX-Evil: 1', 'a\nb', 'a\rb', 42, {}]) {
    assert.equal(name in apiHeaders('tok', false, bad), false, JSON.stringify(bad));
  }
  // the old two-argument form is unchanged
  assert.deepEqual(Object.keys(apiHeaders('tok', false)).sort(), ['Accept', 'Authorization', 'Origin', 'Referer']);
});

test('datadomeFromHeader reads the datadome cookie from an x-set-cookie header', () => {
  const { datadomeFromHeader } = require('../human-check.js');
  const now = Math.floor(Date.now() / 1000);
  const a = datadomeFromHeader('datadome=VAL_1~x; Max-Age=3600; Domain=.soundcloud.com; Path=/; Secure; SameSite=Lax');
  assert.equal(a.value, 'VAL_1~x');
  assert.ok(a.expirationDate >= now + 3599 && a.expirationDate <= now + 3601);
  // no Max-Age: a year
  const b = datadomeFromHeader('datadome=ONLY; Path=/');
  assert.equal(b.value, 'ONLY');
  assert.ok(b.expirationDate > now + 300 * 24 * 3600);
  // among other cookies, joined by a comma
  assert.equal(datadomeFromHeader('other=1; Path=/, datadome=SECOND; Max-Age=60; Path=/').value, 'SECOND');
  for (const bad of [null, undefined, '', 'other=1; Path=/', 'datadome=; Max-Age=5', 42, 'datadome=' + 'a'.repeat(9000)]) {
    assert.equal(datadomeFromHeader(bad), null, String(bad).slice(0, 20));
  }
});

test('isTagPageUrl and shouldBlockTagPageRequest keep the tag page small and on soundcloud.com', () => {
  const h = require('../human-check.js');
  assert.equal(h.isTagPageUrl('https://soundcloud.com/'), true);
  for (const bad of ['https://soundcloud.com/discover', 'http://soundcloud.com/', 'https://soundcloud.com', 'https://evil.com/', 'https://geo.captcha-delivery.com/captcha/', '', undefined]) {
    assert.equal(h.isTagPageUrl(bad), false, String(bad));
  }
  assert.equal(h.shouldBlockTagPageRequest('https://a-v2.sndcdn.com/assets/app-1.js', 'script'), true);
  assert.equal(h.shouldBlockTagPageRequest('https://i1.sndcdn.com/artworks-1.jpg', 'image'), true);
  assert.equal(h.shouldBlockTagPageRequest('https://cf-media.sndcdn.com/x.mp3', 'media'), true);
  // never the tag, the captcha or the API
  assert.equal(h.shouldBlockTagPageRequest('https://dwt.soundcloud.com/tags.js', 'script'), false);
  assert.equal(h.shouldBlockTagPageRequest('https://geo.captcha-delivery.com/captcha/', 'subFrame'), false);
  assert.equal(h.shouldBlockTagPageRequest('https://geo.captcha-delivery.com/c.js', 'script'), false);
  assert.equal(h.shouldBlockTagPageRequest('https://api-v2.soundcloud.com/me', 'xhr'), false);
  assert.equal(h.shouldBlockTagPageRequest('https://evilsndcdn.com/a.js', 'script'), false);
  assert.equal(h.shouldBlockTagPageRequest('https://sndcdn.com.evil.com/a.js', 'script'), false);
  assert.equal(h.shouldBlockTagPageRequest('not a url', 'script'), false);
  // other kinds of request on sndcdn.com are left alone
  assert.equal(h.shouldBlockTagPageRequest('https://a-v2.sndcdn.com/x', 'xhr'), false);
});

test('tagHeaders sends no Origin, Referer, Cookie or client id', () => {
  const { tagHeaders } = require('../human-check.js');
  assert.deepEqual(tagHeaders('tok', false), { Authorization: 'OAuth tok', Accept: 'application/json' });
  assert.deepEqual(tagHeaders('tok', true), { Authorization: 'OAuth tok', Accept: 'application/json', 'Content-Type': 'application/json' });
});

test('isHumanCheckResult recognises the DataDome 403 only', () => {
  const { isHumanCheckResult } = require('../human-check.js');
  const body = JSON.stringify({ error: 'human_check', url: 'https://geo.captcha-delivery.com/captcha/?initialCid=x' });
  assert.equal(isHumanCheckResult(403, body), true);
  assert.equal(isHumanCheckResult(200, body), false);
  assert.equal(isHumanCheckResult(403, '{"error":"forbidden"}'), false);
  assert.equal(isHumanCheckResult(403, JSON.stringify({ url: 'https://evil.com/captcha' })), false);
  assert.equal(isHumanCheckResult(403, 'not json'), false);
  assert.equal(isHumanCheckResult(403, undefined), false);
});

test('responseFromPage gives a Response with status, headers, text() and json()', async () => {
  const { responseFromPage } = require('../human-check.js');
  const res = responseFromPage({ status: 201, contentType: 'application/json; charset=utf-8', text: '{"ok":true}' });
  assert.equal(res.status, 201);
  assert.equal(res.ok, true);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.clone().json(), { ok: true });
  assert.equal(await res.text(), '{"ok":true}');
  // a status without a body (204) and an error status
  const empty = responseFromPage({ status: 204, contentType: '', text: '' });
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  const blocked = responseFromPage({ status: 403, contentType: 'application/json', text: '{"error":"x"}' });
  assert.equal(blocked.ok, false);
  assert.equal(await blocked.text(), '{"error":"x"}');
});

test('tagFetchScript carries every value through JSON and returns status, content type and text', async () => {
  const vm = require('node:vm');
  const { tagFetchScript } = require('../human-check.js');
  const nasty = 'https://api-v2.soundcloud.com/users/1/track_likes/2?client_id=a"b\'c\\d\n</script>';
  let seen = null;
  const context = vm.createContext({
    AbortSignal,
    fetch: async (url, init) => {
      seen = { url, init };
      return { status: 403, headers: { get: (n) => (n === 'content-type' ? 'application/json' : null) }, text: async () => '{"error":"human_check"}' };
    }
  });
  const script = tagFetchScript({ url: nasty, method: 'PUT', headers: { Authorization: 'OAuth t"k', Accept: 'application/json' }, body: '{"a":"b\\"c"}', timeoutMs: 1234 });
  const result = await vm.runInContext(script, context);
  assert.deepEqual({ ...result }, { status: 403, contentType: 'application/json', text: '{"error":"human_check"}' });
  assert.equal(seen.url, nasty);
  assert.equal(seen.init.method, 'PUT');
  assert.equal(seen.init.credentials, 'include');
  assert.deepEqual(Object.keys(seen.init.headers).sort(), ['Accept', 'Authorization']);
  assert.equal(seen.init.headers.Authorization, 'OAuth t"k');
  assert.equal(seen.init.body, '{"a":"b\\"c"}');
  assert.ok(seen.init.signal);

  // no body: no body option; a failing fetch comes back as { error }
  let init = null;
  const none = vm.createContext({ AbortSignal, fetch: async (url, options) => { init = options; throw new Error('boom'); } });
  assert.deepEqual({ ...(await vm.runInContext(tagFetchScript({ url: 'https://x/', method: 'DELETE', headers: {}, body: null }), none)) }, { error: 'boom' });
  assert.equal('body' in init, false);
});

test('tag page listener and wait scripts resolve passed, blocked or timeout', async () => {
  const vm = require('node:vm');
  const { tagListenScript, tagWaitScript, TAG_READY_SCRIPT } = require('../human-check.js');
  const fresh = () => {
    const window = new EventTarget();
    return { window, context: vm.createContext({ window, Promise, setTimeout, clearTimeout }) };
  };
  const fire = (window, name) => window.dispatchEvent(new Event(name));

  // the tag passes BEFORE anyone waits (it can take only about 1.5 s): the outcome is not lost
  let t = fresh();
  assert.equal(vm.runInContext(tagListenScript(), t.context), true);
  fire(t.window, 'dd_response_displayed');
  fire(t.window, 'dd_response_passed');
  assert.equal(t.window.__quantmDD.shown, true);
  assert.equal(await vm.runInContext(tagWaitScript(5000), t.context), 'passed');

  // passed while waiting
  t = fresh();
  vm.runInContext(tagListenScript(), t.context);
  const waiting = vm.runInContext(tagWaitScript(5000), t.context);
  setTimeout(() => fire(t.window, 'dd_response_passed'), 5);
  assert.equal(await waiting, 'passed');

  for (const name of ['dd_blocked', 'dd_response_error']) {
    t = fresh();
    vm.runInContext(tagListenScript(), t.context);
    fire(t.window, name);
    assert.equal(await vm.runInContext(tagWaitScript(5000), t.context), 'blocked', name);
  }

  // the first outcome wins
  t = fresh();
  vm.runInContext(tagListenScript(), t.context);
  fire(t.window, 'dd_blocked');
  fire(t.window, 'dd_response_passed');
  assert.equal(await vm.runInContext(tagWaitScript(5000), t.context), 'blocked');

  // installing again drops the previous request's listeners: an old event can't settle the new request
  t = fresh();
  vm.runInContext(tagListenScript(), t.context);
  const first = t.window.__quantmDD;
  vm.runInContext(tagListenScript(), t.context);
  assert.notEqual(t.window.__quantmDD, first);
  fire(t.window, 'dd_response_passed');
  assert.equal(await Promise.race([first.passed, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20))]), 'still waiting');
  assert.equal(await vm.runInContext(tagWaitScript(5000), t.context), 'passed');

  // nothing happens: timeout; no listeners installed at all: blocked, not a hang
  t = fresh();
  vm.runInContext(tagListenScript(), t.context);
  assert.equal(await vm.runInContext(tagWaitScript(20), t.context), 'timeout');
  t = fresh();
  assert.equal(await vm.runInContext(tagWaitScript(20), t.context), 'blocked');

  // the readiness probe: false on a plain window, true when the tag's options object exists or fetch is wrapped
  const probe = (g) => vm.runInContext(TAG_READY_SCRIPT, vm.createContext(g));
  assert.equal(probe({ window: { fetch: function fetch() { return 1; } }, Function }), true);
  assert.equal(probe({ window: { dataDomeOptions: {} }, Function }), true);
  assert.equal(probe({ window: {}, Function }), false);
});
