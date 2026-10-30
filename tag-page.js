'use strict';

// A hidden soundcloud.com page that runs SoundCloud's own DataDome tag. SoundCloud's bot protection trusts
// sessions where its tag runs on a soundcloud.com page, not an imitation of it, so Quantm sends writes
// (likes, reposts, playlist edits ...) from here: the tag adds the session header itself and, on a block,
// shows the captcha inside the page. When the user passes it, the same request is replayed once.
//
// Created lazily on the first write, then reused. If SoundCloud's tag never shows up, request() answers
// null and the caller falls back to sending from the main process, so nothing gets worse.

const {
  TAG_PAGE_URL, allowTagPageNavigation, shouldBlockTagPageRequest, TAG_READY_SCRIPT, tagListenScript, tagWaitScript,
  tagFetchScript, isHumanCheckResult
} = require('./human-check');

const STARTUP_TIMEOUT = 20000; // the whole start: loading the page and waiting for the tag
const READY_TIMEOUT = 15000; // how long to wait for the tag after the page has loaded
const CAPTCHA_TIMEOUT = 3 * 60 * 1000; // how long the user gets to pass the captcha
const SHOW_DELAY = 4000; // the check window only appears if the captcha hasn't passed on its own by then
const SCRIPT_TIMEOUT = 10000; // a small script run in the page (installing the listeners) must answer within this
const RETRY_AFTER_FAILURE = 60 * 1000; // after a failed start, send directly for this long before trying again

const CANCELLED = { cancelled: true }; // the tag page was shut down: nothing was sent, and nothing may be sent

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The promise's value, or a rejection after `ms` (the main process never waits on the page forever) */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * deps: BrowserWindow (electron), getSession() (the check partition's session, user agent set),
 * partition (its name), getMainWindow(), log(message) (no secrets), apiTimeout (ms), showDelay (ms, for tests)
 */
function createTagPage({ BrowserWindow, getSession, partition, getMainWindow, log, apiTimeout = 30000, showDelay = SHOW_DELAY }) {
  let page = null; // { win, id, ready: Promise<'ok' | 'load' | 'tag' | 'gone'> }
  let unavailableUntil = 0;
  let queue = Promise.resolve();
  // Every destroy() starts a new generation. Work that began in an older one (queued, starting up, or between
  // steps) stops at its next check: it never creates a window or sends a request after the page was destroyed.
  let generation = 0;
  let permanent = false; // set when the app quits: the page is never used again
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
    const entry = { win, id: wc.id, ready: null, closed: null };
    entry.closed = new Promise((resolve) => win.once('closed', () => resolve('gone'))); // however it closes, a start never waits on it
    blockedIds.add(entry.id);
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Only the main frame is held to the homepage. will-redirect also fires for subframes, and the
    // captcha iframe has to follow its own redirects.
    const guard = (event, target, isInPlace, isMainFrame) => {
      const to = typeof target === 'string' ? target : event && event.url;
      const main = event && typeof event.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
      if (!allowTagPageNavigation(to, main)) event.preventDefault();
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
        if (win.isDestroyed()) return 'gone';
        log('tag page: load failed (' + String((e && e.code) || (e && e.message) || e).split(/[?#\s]/)[0].slice(0, 60) + ')');
        return 'load';
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

  /** The ready page, null when it can't be used right now (nothing was sent: send directly), or CANCELLED */
  async function ensurePage(gen) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (gen !== generation) return CANCELLED;
      if (Date.now() < unavailableUntil) return null;
      let entry;
      try {
        entry = page && !page.win.isDestroyed() ? page : createPage();
      } catch (e) {
        log('tag page: could not create the page (' + String((e && e.message) || e).slice(0, 80) + ')');
        unavailableUntil = Date.now() + RETRY_AFTER_FAILURE;
        return null;
      }
      // one deadline around the whole start (load and tag probe): the page may hang
      let timer;
      const state = await Promise.race([entry.ready, entry.closed, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), STARTUP_TIMEOUT); })]);
      clearTimeout(timer);
      if (gen !== generation) { destroyEntry(entry); return CANCELLED; }
      if (state === 'ok' && !entry.win.isDestroyed()) {
        if (!entry.announced) { entry.announced = true; log('tag page ready'); }
        return entry;
      }
      destroyEntry(entry);
      if (state === 'gone') continue; // crashed or closed while starting: start a fresh one
      if (state === 'tag') log('tag page: tag missing, using direct requests');
      else if (state === 'timeout') log('tag page: start timed out, using direct requests');
      else log('tag page: not available, using direct requests');
      unavailableUntil = Date.now() + RETRY_AFTER_FAILURE;
      return null;
    }
    log('tag page: not available, using direct requests');
    unavailableUntil = Date.now() + RETRY_AFTER_FAILURE;
    return null;
  }

  /** Show the page (it is displaying SoundCloud's captcha) over the main window */
  function showOverMain(win) {
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
  }

  /**
   * Wait for the captcha's outcome ('passed', 'error', 'timeout' or 'closed'). The window stays hidden for
   * the first `showDelay` ms, because the tag usually passes by itself within about 1.5 s; only a captcha
   * that is still open after that is shown to the user. The wait is one 3 minute wait, not extended by the delay.
   */
  async function awaitCaptcha(entry, gen) {
    const win = entry.win;
    let onClosed;
    const closed = new Promise((resolve) => {
      onClosed = () => resolve('closed');
      win.once('closed', onClosed);
    });
    let shown = false;
    let timer;
    try {
      // the page enforces the 3 minutes itself; this main-process deadline only covers a page that hangs
      const settled = Promise.race([
        withDeadline(win.webContents.executeJavaScript(tagWaitScript(CAPTCHA_TIMEOUT)), CAPTCHA_TIMEOUT + SCRIPT_TIMEOUT).catch(() => 'timeout'),
        closed
      ]);
      const early = await Promise.race([settled, new Promise((resolve) => { timer = setTimeout(() => resolve(null), showDelay); })]);
      if (early !== null) {
        if (early === 'passed') log('tag page: passed without showing');
        return { outcome: early, shown };
      }
      if (gen !== generation || win.isDestroyed()) return { outcome: 'closed', shown };
      showOverMain(win);
      shown = true;
      log('tag page: captcha shown');
      return { outcome: await settled, shown };
    } finally {
      clearTimeout(timer);
      try { win.removeListener('closed', onClosed); } catch (e) { /* destroyed */ }
      try { if (shown && !win.isDestroyed()) win.hide(); } catch (e) { /* destroyed */ }
    }
  }

  async function run({ url, method, headers, body }, gen) {
    const entry = await ensurePage(gen);
    if (entry === CANCELLED) return CANCELLED;
    if (!entry) return null;
    const exec = (code) => entry.win.webContents.executeJavaScript(code);
    // each fetch has a main-process deadline too: if the page hangs, the outcome is "uncertain"
    const send = async () => {
      const script = tagFetchScript({ url, method, headers, body, timeoutMs: apiTimeout });
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'timeout' }), apiTimeout + 5000); });
      try { return await Promise.race([exec(script), timeout]); } finally { clearTimeout(timer); }
    };
    let maybeSent = false; // a request may have reached SoundCloud and run

    try {
      await withDeadline(exec(tagListenScript()), SCRIPT_TIMEOUT); // before the request: the tag can pass the captcha within about 1.5 s
      if (gen !== generation) return CANCELLED;
      maybeSent = true;
      let result = await send();
      if (!result || result.error) return { error: (result && result.error) || 'no answer from the page' };

      if (isHumanCheckResult(result.status, result.text)) {
        maybeSent = false; // the blocked request was rejected: it never ran
        if (gen !== generation) return CANCELLED;
        const { outcome, shown } = await awaitCaptcha(entry, gen);
        if (gen !== generation) return CANCELLED;
        if (outcome !== 'passed') {
          log('tag page: ' + outcome);
          destroyEntry(entry); // fresh page next time, without the leftover captcha
          return { humanCheckFailed: true };
        }
        if (shown) log('tag page: passed');
        maybeSent = true;
        result = await send(); // the one replay
        if (!result || result.error) return { error: (result && result.error) || 'no answer from the page' };
        log('tag page: replay status ' + result.status);
      }
      if (isHumanCheckResult(result.status, result.text)) return { humanCheckFailed: true };
      return { status: result.status, contentType: result.contentType, text: result.text };
    } catch (e) {
      if (!maybeSent) {
        // nothing was sent: the page was shut down (stop), or it is broken (send directly)
        destroyEntry(entry);
        return gen !== generation ? CANCELLED : null;
      }
      if (entry.win.isDestroyed()) destroyEntry(entry);
      return { error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  return {
    /**
     * Send a request from the tag page: { url, method, headers, body } with body a string or null.
     * Resolves null when the tag page isn't available (send it directly), otherwise
     * { status, contentType, text }, { humanCheckFailed: true } or { error } (the request may have been sent),
     * or { cancelled: true } when the page was shut down first (nothing was sent: do not send it any other way).
     * Requests run one at a time, so they never share the page's captcha.
     */
    request(options) {
      // after quitting, or with no main window, the page is not started again
      if (permanent || !getMainWindow()) return Promise.resolve(CANCELLED);
      const gen = generation;
      const next = queue.then(() => run(options, gen));
      queue = next.catch(() => {});
      return next;
    },
    /** Close the page and cancel queued and in-flight work. `final`: the app is quitting, never use it again */
    destroy(final) {
      if (final) permanent = true;
      generation++;
      if (page) destroyEntry(page);
    }
  };
}

module.exports = { createTagPage };
