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
 * Headers for an api-v2 request. There is deliberately no Cookie header: the datadome clearance (and
 * the cookie DataDome rotates on every protected response) lives in one cookie jar, which the request
 * sends and updates itself (see apiRequest in main.js).
 */
function apiHeaders(token, hasBody) {
  return Object.assign({
    Authorization: 'OAuth ' + token,
    Accept: 'application/json',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/'
  }, hasBody ? { 'Content-Type': 'application/json' } : {});
}

/** True when a human check was passed at `passedAt` (ms) and `now` is within `windowMs` of it */
function recentlyPassed(passedAt, now, windowMs = 60000) {
  return typeof passedAt === 'number' && passedAt > 0 && now >= passedAt && now - passedAt <= windowMs;
}

// Headers the browser sets itself; a page fetch must not pass them (some would throw)
const PAGE_FORBIDDEN_HEADERS = new Set(['origin', 'referer', 'cookie', 'host', 'user-agent', 'content-length']);

/**
 * The script that sends one api-v2 request from inside a soundcloud.com page (see pageFetch in main.js).
 * Every value goes in through JSON.stringify, and the headers the browser owns are dropped. The script
 * resolves to { status, headers: { 'content-type' }, text }.
 */
function pageFetchScript(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const kept = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!PAGE_FORBIDDEN_HEADERS.has(name.toLowerCase())) kept[name] = String(value);
  }
  const init = { method: String(method).toUpperCase(), headers: kept, credentials: 'include', mode: 'cors' };
  if (body !== undefined && body !== null) init.body = String(body);
  return '(async () => {\n' +
    '  const init = ' + JSON.stringify(init) + ';\n' +
    '  init.signal = AbortSignal.timeout(' + JSON.stringify(Math.max(1, Number(timeoutMs) || 30000)) + ');\n' +
    '  const response = await fetch(' + JSON.stringify(String(url)) + ', init);\n' +
    '  const text = await response.text();\n' +
    "  return { status: response.status, headers: { 'content-type': response.headers.get('content-type') || '' }, text };\n" +
    '})()';
}

/** The page fetch's plain result -> the part of a fetch Response that apiRequest uses */
function pageResponse(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.status)) throw new Error('bad page response');
  const headers = {};
  for (const [name, value] of Object.entries(raw.headers || {})) headers[name.toLowerCase()] = String(value);
  const text = typeof raw.text === 'string' ? raw.text : '';
  const response = {
    status: raw.status,
    ok: raw.status >= 200 && raw.status < 300,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()) ? headers[String(name).toLowerCase()] : null) },
    text: async () => text,
    json: async () => JSON.parse(text),
    clone: () => response
  };
  return response;
}

module.exports = { isCaptchaUrl, redact, humanCheckUrl, clearanceFrom, clearanceFromCookie, apiHeaders, recentlyPassed, pageFetchScript, pageResponse };
