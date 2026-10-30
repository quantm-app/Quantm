'use strict';

// A hidden soundcloud.com page that runs SoundCloud's own DataDome tag. SoundCloud's bot protection trusts
// sessions where its tag runs on a soundcloud.com page, not an imitation of it, so Quantm sends writes
// (likes, reposts, playlist edits ...) from here: the tag adds the session header itself and, on a block,
// shows the captcha inside the page. When the user passes it, the same request is replayed once.
//
// Created lazily on the first write, then reused. If SoundCloud's tag never shows up, request() answers
// null and the caller falls back to sending from the main process, so nothing gets worse.

const {
  TAG_PAGE_URL, isTagPageUrl, shouldBlockTagPageRequest, TAG_READY_SCRIPT, tagListenScript, tagWaitScript,
  tagFetchScript, isHumanCheckResult
} = require('./human-check');

const READY_TIMEOUT = 15000; // how long to wait for the tag after the page has loaded
const CAPTCHA_TIMEOUT = 3 * 60 * 1000; // how long the user gets to pass the captcha
const RETRY_AFTER_FAILURE = 60 * 1000; // after a failed start, send directly for this long before trying again

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * deps: BrowserWindow (electron), getSession() (the check partition's session, user agent set),
 * partition (its name), getMainWindow(), log(message) (no secrets), apiTimeout (ms)
 */
function createTagPage({ BrowserWindow, getSession, partition, getMainWindow, log, apiTimeout = 30000 }) {
  let page = null; // { win, id, ready: Promise<'ok' | 'load' | 'tag' | 'gone'> }
  let unavailableUntil = 0;
  let queue = Promise.resolve();
  const blockedIds = new Set(); // webContents ids of tag pages, whose bundles and media are blocked
  let hookedSession = null;

  // Electron allows one onBeforeRequest listener per session. main.js registers none on the check
  // partition (the sign-in window's listener is on its own partition), so this is the only one: it
  // cancels bundles and media for the tag page only and lets every other request through.
  function hookRequests(ses) {
    if (hookedSession === ses) return;
    hookedSession = ses;
    ses.webRequest.onBeforeRequest({ urls: ['https://*.sndcdn.com/*'] }, (details, callback) => {
      callback({ cancel: blockedIds.has(details.webContentsId) && shouldBlockTagPageRequest(details.url, details.resourceType) });
    });
  }

  function destroyEntry(entry) {
    if (page === entry) page = null;
    blockedIds.delete(entry.id);
    try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch (e) { /* already gone */ }
  }

  function createPage() {
    const ses = getSession(); // also makes sure the partition's user agent is the Chrome one
    hookRequests(ses);
    const win = new BrowserWindow({
      show: false, width: 420, height: 640, title: 'SoundCloud check', autoHideMenuBar: true,
      webPreferences: {
        partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false // hidden, but its timers must keep running for the tag
      }
    });
    const wc = win.webContents;
    const entry = { win, id: wc.id, ready: null };
    blockedIds.add(entry.id);
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => {
      const to = typeof target === 'string' ? target : event && event.url;
      if (!isTagPageUrl(to)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    win.on('closed', () => {
      blockedIds.delete(entry.id);
      if (page === entry) page = null;
    });
    wc.on('render-process-gone', (event, details) => {
      log('tag page: render process gone (' + (details && details.reason) + ')');
      destroyEntry(entry);
    });

    entry.ready = (async () => {
      try {
        await win.loadURL(TAG_PAGE_URL);
      } catch (e) {
        log('tag page: load failed (' + String((e && e.code) || (e && e.message) || e).split(/[?#\s]/)[0].slice(0, 60) + ')');
        return win.isDestroyed() ? 'gone' : 'load';
      }
      const deadline = Date.now() + READY_TIMEOUT;
      while (Date.now() < deadline) {
        if (win.isDestroyed()) return 'gone';
        try {
          if (await wc.executeJavaScript(TAG_READY_SCRIPT)) return 'ok';
        } catch (e) { /* the page is still starting */ }
        await sleep(250);
      }
      return win.isDestroyed() ? 'gone' : 'tag';
    })();
    page = entry;
    return entry;
  }

  /** The ready page, or null when the tag page can't be used right now */
  async function ensurePage() {
    if (Date.now() < unavailableUntil) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = page && !page.win.isDestroyed() ? page : createPage();
      const state = await entry.ready;
      if (state === 'ok' && !entry.win.isDestroyed()) {
        if (!entry.announced) { entry.announced = true; log('tag page ready'); }
        return entry;
      }
      destroyEntry(entry);
      if (state === 'gone') continue; // crashed or closed while starting: start a fresh one
      if (state === 'tag') log('tag page: tag missing, using direct requests');
      else log('tag page: not available, using direct requests');
      unavailableUntil = Date.now() + RETRY_AFTER_FAILURE;
      return null;
    }
    log('tag page: not available, using direct requests');
    unavailableUntil = Date.now() + RETRY_AFTER_FAILURE;
    return null;
  }

  /** Show the page (it is displaying SoundCloud's captcha) over the main window and wait for the outcome */
  async function awaitCaptcha(entry) {
    const win = entry.win;
    const main = getMainWindow();
    try {
      if (main && !main.isDestroyed() && !main.isMinimized() && main.isVisible()) {
        const bounds = main.getBounds();
        const [width, height] = win.getSize();
        win.setPosition(Math.round(bounds.x + (bounds.width - width) / 2), Math.round(bounds.y + (bounds.height - height) / 2));
      } else {
        win.center();
      }
      win.show();
      win.focus();
    } catch (e) { /* shown wherever it is */ }

    let onClosed;
    const closed = new Promise((resolve) => {
      onClosed = () => resolve('closed');
      win.once('closed', onClosed);
    });
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(tagWaitScript(CAPTCHA_TIMEOUT)).catch(() => 'closed'),
        closed
      ]);
    } finally {
      try { win.removeListener('closed', onClosed); } catch (e) { /* destroyed */ }
      try { if (!win.isDestroyed()) win.hide(); } catch (e) { /* destroyed */ }
    }
  }

  async function run({ url, method, headers, body }) {
    const entry = await ensurePage();
    if (!entry) return null;
    const exec = (code) => entry.win.webContents.executeJavaScript(code);
    const send = async () => {
      const script = tagFetchScript({ url, method, headers, body, timeoutMs: apiTimeout });
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'timeout' }), apiTimeout + 5000); });
      try { return await Promise.race([exec(script), timeout]); } finally { clearTimeout(timer); }
    };

    try {
      await exec(tagListenScript()); // before the request: the tag can pass the captcha within about 1.5 s
      let result = await send();
      if (!result || result.error) return { error: (result && result.error) || 'no answer from the page' };

      if (isHumanCheckResult(result.status, result.text)) {
        log('tag page: captcha shown');
        const outcome = await awaitCaptcha(entry);
        if (outcome !== 'passed') {
          log('tag page: ' + outcome);
          destroyEntry(entry); // fresh page next time, without the leftover captcha
          return { humanCheckFailed: true };
        }
        log('tag page: passed');
        result = await send(); // the one replay: the blocked request was rejected, so it never ran
        if (!result || result.error) return { error: (result && result.error) || 'no answer from the page' };
        log('tag page: replay status ' + result.status);
      }
      if (isHumanCheckResult(result.status, result.text)) return { humanCheckFailed: true };
      return { status: result.status, contentType: result.contentType, text: result.text };
    } catch (e) {
      if (entry.win.isDestroyed()) destroyEntry(entry);
      return { error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  return {
    /**
     * Send a request from the tag page: { url, method, headers, body } with body a string or null.
     * Resolves null when the tag page isn't available (send it directly), otherwise
     * { status, contentType, text }, { humanCheckFailed: true } or { error }.
     * Requests run one at a time, so they never share the page's captcha.
     */
    request(options) {
      const next = queue.then(() => run(options));
      queue = next.catch(() => {});
      return next;
    },
    /** Close the page (main window closed, app quitting) */
    destroy() {
      if (page) destroyEntry(page);
    }
  };
}

module.exports = { createTagPage };
