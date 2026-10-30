'use strict';

// Pure helpers for SoundCloud's human check (DataDome), kept apart from main.js so they can be tested

/** True for an https URL on captcha-delivery.com (or a subdomain); false for anything else, including junk */
function isCaptchaUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && /(^|\.)captcha-delivery\.com$/.test(url.hostname);
  } catch (e) {
    return false;
  }
}

/** The human-check page URL in a blocked response, or null (https captcha-delivery.com only) */
function humanCheckUrl(data) {
  const raw = data && typeof data === 'object' ? data.url : null;
  return isCaptchaUrl(raw) ? new URL(String(raw)).toString() : null;
}

/**
 * A log-safe version of free text from the captcha page: no datadome cookie values, no URL query
 * strings (absolute or relative), no long token-like runs, at most 200 characters
 */
function redact(text) {
  return String(text)
    .replace(/datadome=[^;\s]*/g, 'datadome=<redacted>')
    .replace(/\?\S*/g, '')
    .replace(/[A-Za-z0-9_~.-]{24,}/g, '<redacted>')
    .slice(0, 200);
}

/**
 * The check's answer -> cookie details. Takes the JSON body of /captcha/check ({"cookie": "datadome=..."})
 * or the cookie string itself: "datadome=VALUE; Max-Age=...; Domain=.soundcloud.com; ..."
 */
function clearanceFrom(text) {
  let header = typeof text === 'string' ? text.trim() : '';
  if (!/^datadome=/.test(header)) {
    let data;
    try { data = JSON.parse(header); } catch (e) { return null; }
    header = data && typeof data.cookie === 'string' ? data.cookie.trim() : '';
  }
  const match = /^datadome=([^;\s]+)/.exec(header);
  if (!match) return null;
  const maxAge = Number((/max-age=(\d+)/i.exec(header) || [])[1]) || 365 * 24 * 3600;
  return { value: match[1], expirationDate: Math.floor(Date.now() / 1000) + maxAge };
}

/**
 * A cookie from the session's 'changed' event -> clearance details, when it is a non-removed, non-empty
 * datadome cookie on a captcha-delivery.com domain; otherwise null. Uses the cookie's own expiry,
 * or a year for a session cookie.
 */
function clearanceFromCookie(cookie) {
  if (!cookie || typeof cookie !== 'object' || cookie.name !== 'datadome') return null;
  if (typeof cookie.value !== 'string' || !cookie.value || /[;\s]/.test(cookie.value)) return null;
  const domain = String(cookie.domain || '').replace(/^\./, '');
  if (!/(^|\.)captcha-delivery\.com$/.test(domain)) return null;
  const expirationDate = Number(cookie.expirationDate) > 0 ? Number(cookie.expirationDate) : Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  return { value: cookie.value, expirationDate };
}

/**
 * Headers for an api-v2 request. There is deliberately no Cookie header: SoundCloud's DataDome tag runs
 * in session-by-header mode for api-v2, so the session value goes in X-DataDome-ClientID instead, and
 * the refreshed value comes back in the x-set-cookie response header (see apiRequest in main.js).
 * The client id is only added when it is a non-empty string of at most 1024 characters without CR or LF.
 */
function apiHeaders(token, hasBody, clientId) {
  const headers = {
    Authorization: 'OAuth ' + token,
    Accept: 'application/json',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/'
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (typeof clientId === 'string' && clientId && clientId.length <= 1024 && !/[\r\n]/.test(clientId)) {
    headers['X-DataDome-ClientID'] = clientId;
  }
  return headers;
}

/**
 * The datadome cookie in an x-set-cookie response header ("datadome=VALUE; Max-Age=...; Domain=...", possibly
 * several cookies joined by commas) -> { value, expirationDate } like clearanceFrom, or null
 */
function datadomeFromHeader(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const parts = header.split(/,\s*(?=[A-Za-z0-9_.-]+=)/);
  for (const part of parts) {
    const clearance = clearanceFrom(part.trim());
    if (clearance) return clearance;
  }
  return null;
}

/** True when a human check was passed at `passedAt` (ms) and `now` is within `windowMs` of it */
function recentlyPassed(passedAt, now, windowMs = 60000) {
  return typeof passedAt === 'number' && passedAt > 0 && now >= passedAt && now - passedAt <= windowMs;
}

// ---------------------------------------------------------------------------
// The tag page (tag-page.js): a hidden soundcloud.com page running SoundCloud's own DataDome tag.
// Writes are sent from it with fetch(), so the tag adds the session header and shows the captcha itself.
// ---------------------------------------------------------------------------

const TAG_PAGE_URL = 'https://soundcloud.com/';

/** True only for the exact tag page URL: the page may never navigate anywhere else */
function isTagPageUrl(raw) {
  return raw === TAG_PAGE_URL;
}

const TAG_PAGE_BLOCKED_TYPES = new Set(['script', 'image', 'media', 'stylesheet', 'font']);

/**
 * True for requests the tag page doesn't need and should not make: scripts, images, media, styles and
 * fonts from *.sndcdn.com (SoundCloud's SPA bundles and artwork). Everything else, in particular
 * dwt.soundcloud.com (the tag), captcha-delivery.com and api-v2.soundcloud.com, is never blocked.
 */
function shouldBlockTagPageRequest(url, resourceType) {
  if (!TAG_PAGE_BLOCKED_TYPES.has(resourceType)) return false;
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' && /(^|\.)sndcdn\.com$/.test(parsed.hostname);
  } catch (e) {
    return false;
  }
}

/** Page script: true once SoundCloud's DataDome tag has run (its options object exists, or window.fetch is wrapped) */
const TAG_READY_SCRIPT = '(function () { try { return (typeof window.dataDomeOptions === "object" && window.dataDomeOptions !== null) || ' +
  'typeof window.DataDome === "object" || (typeof window.fetch === "function" && !/native code/.test(Function.prototype.toString.call(window.fetch))); } catch (e) { return false; } })()';

/**
 * Page script, run BEFORE each request: installs listeners for the tag's events and stores the outcome
 * on window.__quantmDD. .passed is a promise that resolves 'passed' (dd_response_passed) or 'blocked'
 * (dd_blocked, dd_response_error), whichever comes first; the tag can pass within about 1.5 s of the 403.
 */
function tagListenScript() {
  return '(function () {\n' +
    '  var names = ["dd_response_passed", "dd_response_displayed", "dd_response_error", "dd_blocked"];\n' +
    '  var previous = window.__quantmDD;\n' +
    '  if (previous && typeof previous.cleanup === "function") previous.cleanup();\n' +
    '  var state = { shown: false };\n' +
    '  var settle;\n' +
    '  state.passed = new Promise(function (resolve) { settle = resolve; });\n' +
    '  var handlers = {\n' +
    '    dd_response_displayed: function () { state.shown = true; },\n' +
    '    dd_response_passed: function () { settle("passed"); },\n' +
    '    dd_response_error: function () { settle("blocked"); },\n' +
    '    dd_blocked: function () { settle("blocked"); }\n' +
    '  };\n' +
    '  state.cleanup = function () { names.forEach(function (n) { window.removeEventListener(n, handlers[n]); }); };\n' +
    '  names.forEach(function (n) { window.addEventListener(n, handlers[n]); });\n' +
    '  window.__quantmDD = state;\n' +
    '  return true;\n' +
    '})()';
}

/** Page script: resolves 'passed' / 'blocked' from the listeners above, or 'timeout' after `ms` */
function tagWaitScript(ms) {
  return '(function (ms) {\n' +
    '  var state = window.__quantmDD;\n' +
    '  if (!state || !state.passed) return Promise.resolve("blocked");\n' +
    '  var timer;\n' +
    '  var timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve("timeout"); }, ms); });\n' +
    '  return Promise.race([state.passed, timeout]).then(function (outcome) { clearTimeout(timer); return outcome; });\n' +
    '})(' + JSON.stringify(Number(ms) > 0 ? Number(ms) : 180000) + ')';
}

/**
 * Page script: one fetch() from the soundcloud.com page (the tag adds X-DataDome-ClientID and handles the
 * captcha). Every value goes in through JSON.stringify. Resolves { status, contentType, text }, or
 * { error } when the request itself failed.
 */
function tagFetchScript({ url, method, headers, body, timeoutMs }) {
  return '(async function () {\n' +
    '  try {\n' +
    '    var init = { method: ' + JSON.stringify(String(method)) + ', headers: ' + JSON.stringify(headers || {}) + ', credentials: "include", ' +
    'signal: AbortSignal.timeout(' + JSON.stringify(Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000) + ') };\n' +
    '    var body = ' + JSON.stringify(typeof body === 'string' ? body : null) + ';\n' +
    '    if (body !== null) init.body = body;\n' +
    '    var res = await fetch(' + JSON.stringify(String(url)) + ', init);\n' +
    '    var text = await res.text();\n' +
    '    return { status: res.status, contentType: (res.headers && res.headers.get("content-type")) || "", text: text };\n' +
    '  } catch (e) {\n' +
    '    return { error: String((e && e.message) || e).slice(0, 200) };\n' +
    '  }\n' +
    '})()';
}

/**
 * Headers for a request sent from the tag page. No Origin, Referer, Cookie or X-DataDome-ClientID: the
 * browser sets the first three and SoundCloud's tag adds the session header itself.
 */
function tagHeaders(token, hasBody) {
  const headers = { Authorization: 'OAuth ' + token, Accept: 'application/json' };
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

/** True for a 403 whose JSON body is a DataDome human check ({"url": "https://...captcha-delivery.com/..."}) */
function isHumanCheckResult(status, text) {
  if (status !== 403) return false;
  try { return humanCheckUrl(JSON.parse(text)) !== null; } catch (e) { return false; }
}

/** { status, contentType, text } from the tag page -> a Response, so apiRequest handles it like a fetch result */
function responseFromPage({ status, contentType, text }) {
  const body = typeof text === 'string' && text !== '' ? text : null;
  return new Response(body, { status, headers: contentType ? { 'content-type': String(contentType) } : {} });
}

module.exports = {
  isCaptchaUrl, redact, humanCheckUrl, clearanceFrom, clearanceFromCookie, apiHeaders, recentlyPassed, datadomeFromHeader,
  TAG_PAGE_URL, isTagPageUrl, shouldBlockTagPageRequest, TAG_READY_SCRIPT, tagListenScript, tagWaitScript, tagFetchScript,
  tagHeaders, isHumanCheckResult, responseFromPage
};
