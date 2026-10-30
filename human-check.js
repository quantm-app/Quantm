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

module.exports = { isCaptchaUrl, redact, humanCheckUrl, clearanceFrom, clearanceFromCookie, apiHeaders, recentlyPassed, datadomeFromHeader };
