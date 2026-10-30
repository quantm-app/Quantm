'use strict';

const { app, BrowserWindow, ipcMain, net, session, shell, clipboard, safeStorage, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const discord = require('./discord');
const updates = require('./updater');
const offline = require('./offline');
const crashlog = require('./crashlog');
const importSources = require('./import-sources');
const { isCaptchaUrl, redact, humanCheckUrl, clearanceFrom, clearanceFromCookie, apiHeaders, recentlyPassed } = require('./human-check');

// downloaded tracks are served to the page as quantm-offline://...; must be set up before ready
offline.registerScheme();

const API = 'https://api-v2.soundcloud.com/';
const LOGIN_PARTITION = 'persist:soundcloud-login';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TITLEBAR_HEIGHT = 56;

// Development: QUANTM_PROFILE=<folder> runs a second copy with its own settings and login,
// next to the installed app (which keeps its single-instance lock on the normal profile)
if (process.env.QUANTM_PROFILE && !app.isPackaged) app.setPath('userData', path.resolve(process.env.QUANTM_PROFILE));

// local crash logs (crashlog.js); starts early so a crash during start-up is caught too
crashlog.start();

// SoundCloud rejects requests whose user agent mentions Electron
app.userAgentFallback = CHROME_UA;

// Keep the app light: skip Chromium features a music player never uses
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions');

// "Hardware acceleration" off (Settings → Performance) keeps Quantm off the graphics card
try {
  const startupPrefs = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window-prefs.json'), 'utf8'));
  if (startupPrefs.hardwareAcceleration === false) app.disableHardwareAcceleration();
} catch (e) { /* defaults */ }

// Windows shows the app id as the notification header when it has no cached name for it,
// so the Windows id is just "Quantm". Must match build.win.appId (the installer shortcut).
const APP_ID = process.platform === 'win32' ? 'Quantm' : 'app.quantm.desktop';
app.setAppUserModelId(APP_ID);

// Windows looks up the name and icon for notification headers in the registry under the
// app id. Without this entry it shows the raw id ("app.quantm.desktop").
function registerNotificationIdentity() {
  if (process.platform !== 'win32') return;
  // a QUANTM_PROFILE test copy must not repoint the real app's notification icon at its own folder
  if (process.env.QUANTM_PROFILE && !app.isPackaged) return;
  try {
    const iconPath = path.join(app.getPath('userData'), 'notification-icon.png');
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'build', 'icon.png'), iconPath);
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
    const { execFile } = require('child_process');
    execFile('reg', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Quantm', '/f'], () => {});
    execFile('reg', ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconPath, '/f'], () => {});
  } catch (e) { /* cosmetic only */ }
}

let mainWindow = null;
let loginWindow = null;
let auth = null; // { token, clientId }

// ---------------------------------------------------------------------------
// Auth storage
// ---------------------------------------------------------------------------

const authFile = () => path.join(app.getPath('userData'), 'auth.json');

function loadAuth() {
  try {
    const saved = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    let token = saved.token;
    if (saved.encrypted) {
      // the keychain is unavailable (or changed): the stored value is ciphertext, not a token
      if (!safeStorage.isEncryptionAvailable()) return null;
      token = safeStorage.decryptString(Buffer.from(saved.token, 'base64'));
    }
    if (token && saved.clientId) {
      return { token, clientId: saved.clientId };
    }
  } catch (e) { /* no saved login */ }
  return importLegacyConfig();
}

// Soundnode 7 kept the token in ~/.config/Soundnode/userConfig.json
function importLegacyConfig() {
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'Soundnode', 'userConfig.json'), 'utf8'));
    if (legacy.accessToken && legacy.clientId && !/^PASTE_/.test(legacy.accessToken) && !/^PASTE_/.test(legacy.clientId)) {
      const imported = { token: legacy.accessToken, clientId: legacy.clientId };
      saveAuth(imported);
      return imported;
    }
  } catch (e) { /* nothing to import */ }
  return null;
}

function saveAuth(value) {
  auth = value;
  if (!value) {
    try { fs.unlinkSync(authFile()); } catch (e) { /* already gone */ }
    return;
  }
  const encrypted = safeStorage.isEncryptionAvailable();
  fs.mkdirSync(path.dirname(authFile()), { recursive: true });
  if (!encrypted) console.warn('OS keychain unavailable: the login is stored unencrypted, readable only by this user');
  fs.writeFileSync(authFile(), JSON.stringify({
    encrypted,
    token: encrypted ? safeStorage.encryptString(value.token).toString('base64') : value.token,
    clientId: value.clientId
  }), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// client_id discovery: soundcloud.com embeds it in its JS bundles and rotates it
// ---------------------------------------------------------------------------

const SCRAPE_TIMEOUT = 10000;
let scraping = null;

async function fetchText(url, options = {}) {
  const response = await net.fetch(url, Object.assign({ signal: AbortSignal.timeout(SCRAPE_TIMEOUT) }, options));
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function findClientId() {
  const html = await fetchText('https://soundcloud.com/', { headers: { 'User-Agent': CHROME_UA } });
  // the asset host has changed before (a-v2, a-v3...): accept any sndcdn script
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[a-z0-9-]+\.sndcdn\.com\/[^"]+\.js)"/g)].map(m => m[1]);
  // the id is usually in one of the last bundles: check those first, a few at a time
  const ordered = scripts.reverse();
  for (let i = 0; i < ordered.length; i += 4) {
    const found = await Promise.all(ordered.slice(i, i + 4).map(async (src) => {
      try {
        const match = (await fetchText(src)).match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
        return match ? match[1] : null;
      } catch (e) {
        return null;
      }
    }));
    const id = found.find(Boolean);
    if (id) return id;
  }
  throw new Error('Could not find a SoundCloud client_id');
}

/** Concurrent callers share one lookup, so a burst of 401s scrapes soundcloud.com once */
function scrapeClientId() {
  if (!scraping) scraping = findClientId().finally(() => { scraping = null; });
  return scraping;
}

// ---------------------------------------------------------------------------
// API proxy: requests go through the main process so the token never reaches
// the renderer and api-v2's CORS rules (soundcloud.com only) don't apply
// ---------------------------------------------------------------------------

const API_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const SAFE_METHODS = new Set(['GET']);
const API_TIMEOUT = 30000;

function buildUrl(resource, params, clientId) {
  const url = new URL(/^https:/.test(resource) ? resource : API + resource.replace(/^\//, ''));
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  url.searchParams.set('client_id', clientId);
  return url;
}

function validApiRequest(request) {
  if (!request || typeof request !== 'object') return false;
  const { method = 'GET', resource, params, body } = request;
  if (!API_METHODS.has(method)) return false;
  if (typeof resource !== 'string' || !resource || resource.length > 4096) return false;
  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) return false;
  if (body !== undefined && JSON.stringify(body).length > 256 * 1024) return false;
  return true;
}

// SoundCloud's bot protection (DataDome) sometimes answers a request with a "prove you're human"
// page instead of the result. Quantm shows that page to the user, who completes it themselves; the
// clearance cookie it sets is then sent with later requests, exactly like in a browser.
const CHECK_PARTITION = 'persist:soundcloud-check';
let checkWindow = null;

let checkPassedAt = 0; // when the last human check passed (ms), to tell whether a block right after it persists

/**
 * The one cookie jar for api-v2 requests: the check's partition. The clearance the check stores lands
 * here, requests send it from here, and the datadome cookie DataDome rotates in each protected response
 * (Set-Cookie) is stored back here, so the clearance never goes stale.
 */
function apiSession() {
  const apiSes = session.fromPartition(CHECK_PARTITION);
  if (apiSes.getUserAgent() !== CHROME_UA) apiSes.setUserAgent(CHROME_UA);
  return apiSes;
}

/** Drop datadome cookies a previous build left in the default session (best effort) */
async function clearStaleDatadome() {
  try {
    const stale = await session.defaultSession.cookies.get({ name: 'datadome' });
    for (const cookie of stale) {
      const host = String(cookie.domain || '').replace(/^\./, '');
      if (!host) continue;
      await session.defaultSession.cookies.remove((cookie.secure ? 'https://' : 'http://') + host + (cookie.path || '/'), 'datadome').catch(() => {});
    }
  } catch (e) { /* best effort */ }
}

/** URL without its query string or fragment, so logs never carry tokens */
function bare(url) {
  return String(url || '').split(/[?#]/)[0];
}

/** Steps of the check, without any cookie values, for diagnosing a check that doesn't finish */
function logCheck(message) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'human-check.log'), new Date().toISOString() + ' ' + message + '\n');
  } catch (e) { /* logging is best effort */ }
}

/** Show SoundCloud's human check; resolves true once the user has passed it (or closed it with a clearance stored) */
function openHumanCheck(url) {
  if (checkWindow) {
    checkWindow.focus();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const checkSession = session.fromPartition(CHECK_PARTITION);
    let done = false;
    let cleared = false; // a clearance (message or cookie candidate) was stored since this check opened
    const finish = (passed) => {
      if (done) return;
      done = true;
      checkSession.cookies.removeListener('changed', onCookie);
      if (checkWindow && !checkWindow.isDestroyed()) checkWindow.close();
      checkWindow = null;
      if (passed) checkPassedAt = Date.now();
      resolve(passed);
    };
    // A datadome cookie on captcha-delivery.com can also be an init or rotated value from an unsolved
    // challenge, so it is only a candidate: it is stored, but never finishes the check by itself.
    // Cookies the page already had at open time (or sets before it has navigated) are not even that.
    let navigated = false;
    const presentAtOpen = new Set();
    checkSession.cookies.get({ name: 'datadome' }).then((all) => all.forEach((c) => presentAtOpen.add(c.domain + '|' + c.value))).catch(() => {});
    const onCookie = (event, cookie, cause, removed) => {
      if (removed || cookie.name !== 'datadome') return;
      // Fallback without the postMessage: the captcha page may keep the clearance in its own domain
      const clearance = navigated && !presentAtOpen.has(cookie.domain + '|' + cookie.value) ? clearanceFromCookie(cookie) : null;
      if (clearance) {
        storeClearance(clearance, 'cookie').catch((e) => logCheck('could not store the clearance: ' + e.message));
      }
    };
    checkSession.cookies.on('changed', onCookie);
    checkWindow = new BrowserWindow({
      width: 460, height: 620, title: 'SoundCloud check', parent: mainWindow || undefined, modal: !!mainWindow,
      autoHideMenuBar: true, backgroundColor: '#ffffff',
      webPreferences: {
        partition: CHECK_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, 'check-preload.js')
      }
    });
    const wc = checkWindow.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // The window only ever shows captcha pages
    const guardNavigation = (event, target) => {
      const to = typeof target === 'string' ? target : event && event.url;
      if (isCaptchaUrl(to)) return;
      event.preventDefault();
      let host = '?';
      try { host = new URL(String(to)).hostname || '?'; } catch (e) { /* not a URL */ }
      logCheck('blocked navigation to ' + redact(host));
    };
    wc.on('will-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);
    // Closing the window yourself counts as passed only when a clearance was stored since it opened
    checkWindow.on('closed', () => {
      if (!done) logCheck('window closed by the user, ' + (cleared ? 'a clearance was stored: counting as passed' : 'no clearance was stored'));
      finish(cleared);
    });

    // On soundcloud.com the check runs inside SoundCloud's page and hands the clearance to it.
    // Here it is the whole window, so pick up its answer when the user passes and store the clearance
    // for soundcloud.com ourselves.
    let storedValue = null;
    const storeClearance = async (clearance, how) => {
      if (clearance.value !== storedValue) {
        logCheck(how === 'cookie' ? 'clearance candidate (cookie)' : 'check passed, clearance received (' + how + ')');
        await checkSession.cookies.set({
          url: 'https://soundcloud.com/', name: 'datadome', value: clearance.value, domain: '.soundcloud.com',
          path: '/', secure: true, sameSite: 'lax', expirationDate: clearance.expirationDate
        });
        storedValue = clearance.value;
      }
      cleared = true;
    };
    // Only an explicit success finishes the check on its own
    const succeed = async (clearance, how) => {
      await storeClearance(clearance, how);
      finish(true);
    };

    // Default: a tiny preload reads the captcha's postMessage answer. No debugger is attached because
    // DataDome's captcha detects it and refuses to show the puzzle.
    const onClearance = (event, cookie) => {
      if (event.sender !== wc || typeof cookie !== 'string' || cookie.length > 4096) return;
      // only from a captcha-delivery.com frame, not whatever else the window might hold
      if (!event.senderFrame || !isCaptchaUrl(event.senderFrame.url)) return;
      const clearance = clearanceFrom(cookie);
      if (clearance) succeed(clearance, 'message').catch((e) => logCheck('could not store the clearance: ' + e.message));
    };
    ipcMain.on('check:clearance', onClearance);
    checkWindow.on('closed', () => ipcMain.removeListener('check:clearance', onClearance));

    // For comparison only: QUANTM_CHECK_DEBUGGER=1 reads the /captcha/check response over the debugger
    const debuggerMode = process.env.QUANTM_CHECK_DEBUGGER === '1';
    if (debuggerMode) {
      const watched = new Set();
      const dbg = wc.debugger;
      try {
        dbg.attach('1.3');
        dbg.sendCommand('Network.enable').catch(() => {});
      } catch (e) {
        logCheck('could not watch the check: ' + e.message);
      }
      dbg.on('message', async (event, method, params) => {
        if (method === 'Network.responseReceived') {
          const responseUrl = params.response && params.response.url || '';
          if (/^https:\/\/[^/]*captcha-delivery\.com\//.test(responseUrl)) {
            logCheck('response ' + params.response.status + ' ' + bare(responseUrl) + ' ' + (params.response.mimeType || ''));
            if (/json|text\/plain/.test(params.response.mimeType || '')) watched.add(params.requestId);
          }
        } else if (method === 'Network.loadingFinished' && watched.has(params.requestId)) {
          watched.delete(params.requestId);
          try {
            const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            const clearance = clearanceFrom(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
            if (clearance) await succeed(clearance, 'debugger');
          } catch (e) {
            logCheck('could not read the check answer: ' + e.message);
          }
        }
      });
    }

    // Diagnostics without devtools: what the page complains about, where it goes, how it dies
    wc.on('console-message', (event, level, message, line, sourceId) => {
      // older Electron passes (event, level, message, line, sourceId); newer passes one details object
      let lvl = level, text = message, src = sourceId, ln = line;
      if (event && typeof event.level === 'string') ({ level: lvl, message: text, sourceId: src, lineNumber: ln } = event);
      if (lvl !== 2 && lvl !== 3 && lvl !== 'warning' && lvl !== 'error') return;
      const file = bare(src).split(/[/\\]/).pop();
      logCheck('page ' + (lvl === 2 || lvl === 'warning' ? 'warning' : 'error') + ' ' + redact(text) + ' (' + file + ':' + ln + ')');
    });
    wc.on('did-fail-load', (event, code, description, failedUrl) => logCheck('load failed ' + code + ' ' + description + ' ' + bare(failedUrl)));
    wc.on('did-navigate', (event, navUrl) => { navigated = true; logCheck('navigated ' + bare(navUrl)); });
    wc.on('did-navigate-in-page', (event, navUrl) => logCheck('navigated in page ' + bare(navUrl)));
    wc.on('render-process-gone', (event, details) => logCheck('render process gone: ' + (details && details.reason)));
    wc.on('preload-error', (event, preloadPath, error) => logCheck('preload error: ' + (error && error.message)));

    // Test hook (unpackaged only): screenshots of the check, since devtools can't be attached to it
    const shotDir = !app.isPackaged && process.env.QUANTM_CHECK_SHOT;
    if (shotDir) {
      // Armed at open (not on did-finish-load) so both modes capture the same way. capturePage can
      // return an empty image while the page hasn't painted (or the window counts as occluded), so
      // keep painting alive and retry until there are pixels; never write an empty file.
      wc.setBackgroundThrottling(false);
      const capture = async (seconds) => {
        for (let attempt = 1; attempt <= 6; attempt++) {
          try {
            if (wc.isDestroyed()) return;
            wc.invalidate();
            const image = await wc.capturePage();
            if (!image.isEmpty()) {
              fs.mkdirSync(shotDir, { recursive: true });
              fs.writeFileSync(path.join(shotDir, 'check-' + seconds + 's.png'), image.toPNG());
              logCheck('screenshot saved check-' + seconds + 's.png (attempt ' + attempt + ')');
              return;
            }
          } catch (e) {
            logCheck('could not capture the check: ' + e.message);
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        logCheck('screenshot empty check-' + seconds + 's.png');
      };
      [4, 10].forEach((seconds) => setTimeout(() => capture(seconds), seconds * 1000));
    }
    logCheck('check opened (' + (debuggerMode ? 'debugger' : 'message') + ' mode)');
    wc.loadURL(url);
  });
}

async function apiRequest({ method = 'GET', resource, params, body }, retried = false) {
  if (!auth) return { ok: false, status: 401, data: { error: 'not_logged_in' } };

  let url;
  try { url = buildUrl(resource, params, auth.clientId); } catch (e) { url = null; }
  if (!url || url.protocol !== 'https:' || url.hostname !== 'api-v2.soundcloud.com') {
    return { ok: false, status: 400, data: { error: 'blocked_host' } };
  }

  let response;
  try {
    // credentials 'include': cookies are sent from, and Set-Cookie is stored in, the check's partition
    response = await apiSession().fetch(url.toString(), {
      method,
      headers: apiHeaders(auth.token, body !== undefined),
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT)
    });
  } catch (error) {
    // transient connection resets happen; retry reads once. Writes are never retried blindly:
    // the first attempt may have reached SoundCloud (a duplicate comment or playlist).
    if (!retried && SAFE_METHODS.has(method)) return apiRequest({ method, resource, params, body }, true);
    return { ok: false, status: 0, data: { error: 'network', message: error.message, uncertain: !SAFE_METHODS.has(method) } };
  }

  // SoundCloud wants the user to prove they're human: the renderer shows the check and retries
  if (response.status === 403) {
    let blocked = null;
    try { blocked = JSON.parse(await response.clone().text()); } catch (e) { /* not the check page */ }
    const checkUrl = humanCheckUrl(blocked);
    if (checkUrl) {
      if (recentlyPassed(checkPassedAt, Date.now())) logCheck('still blocked after passing (status 403)');
      return { ok: false, status: 403, data: { error: 'human_check', url: checkUrl } };
    }
  }

  // a stale client_id gives 401/403 even with a valid token: refresh it once
  if ((response.status === 401 || response.status === 403) && !retried) {
    try {
      const clientId = await scrapeClientId();
      if (clientId !== auth.clientId) {
        saveAuth({ token: auth.token, clientId });
        return apiRequest({ method, resource, params, body }, true);
      }
    } catch (e) { /* fall through with the original error */ }
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: response.ok, status: response.status, data };
}

// ---------------------------------------------------------------------------
// In-app SoundCloud sign in: capture the oauth_token cookie and a client_id
// ---------------------------------------------------------------------------

function openLogin() {
  if (loginWindow) {
    loginWindow.focus();
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const loginSession = session.fromPartition(LOGIN_PARTITION);
    let token = null;
    let clientId = null;
    let done = false;

    loginWindow = new BrowserWindow({
      width: 480,
      height: 720,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      title: 'Sign in to SoundCloud',
      autoHideMenuBar: true,
      webPreferences: { partition: LOGIN_PARTITION, contextIsolation: true, nodeIntegration: false }
    });
    loginWindow.webContents.setUserAgent(CHROME_UA);

    // popups (Google / Apple / Facebook sign in) stay in the same session
    loginWindow.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: { partition: LOGIN_PARTITION }, autoHideMenuBar: true }
    }));

    const finish = async () => {
      if (done || !token) return;
      if (!clientId) {
        try { clientId = await scrapeClientId(); } catch (e) { return; }
      }
      done = true;
      saveAuth({ token, clientId });
      cleanup();
      if (loginWindow) loginWindow.close();
      resolve(true);
    };

    const onCookie = (event, cookie, cause, removed) => {
      if (!removed && cookie.name === 'oauth_token' && /soundcloud\.com$/.test(cookie.domain) && cookie.value) {
        token = cookie.value;
        finish();
      }
    };

    const onRequest = (details, callback) => {
      const match = details.url.match(/[?&]client_id=([a-zA-Z0-9]{32})/);
      if (match) clientId = match[1];
      callback({});
    };

    const cleanup = () => {
      loginSession.cookies.removeListener('changed', onCookie);
      loginSession.webRequest.onBeforeRequest(null);
    };

    loginSession.cookies.on('changed', onCookie);
    loginSession.webRequest.onBeforeRequest({ urls: ['https://api-v2.soundcloud.com/*'] }, onRequest);

    // already signed in from an earlier session?
    loginSession.cookies.get({ url: 'https://soundcloud.com', name: 'oauth_token' }).then((cookies) => {
      if (cookies[0] && cookies[0].value) {
        token = cookies[0].value;
        finish();
      }
    });

    loginWindow.on('closed', () => {
      loginWindow = null;
      cleanup();
      if (!done) resolve(false);
    });

    loginWindow.loadURL('https://soundcloud.com/signin');
  });
}

// ---------------------------------------------------------------------------
// See-through window (Liquid Glass). The window is created transparent and Windows
// blurs whatever is behind it. Changing it needs a restart, so it's stored in a file.
// ---------------------------------------------------------------------------

const windowPrefsFile = () => path.join(app.getPath('userData'), 'window-prefs.json');

function loadWindowPrefs() {
  try { return JSON.parse(fs.readFileSync(windowPrefsFile(), 'utf8')); } catch (e) { return {}; }
}

function seeThroughSupported() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/** Windows: is a game (or any other app) fullscreen in front of Quantm? (SHQueryUserNotificationState) */
let fullscreenApi;
function otherAppFullscreen(win) {
  if (process.platform !== 'win32' || fullscreenApi === null) return false;
  try {
    const koffi = require('koffi');
    if (!fullscreenApi) {
      fullscreenApi = {
        state: koffi.load('shell32.dll').func('long __stdcall SHQueryUserNotificationState(_Out_ int *state)'),
        foreground: koffi.load('user32.dll').func('void * __stdcall GetForegroundWindow()')
      };
    }
    const state = [0];
    // 2 = QUNS_BUSY (a fullscreen app, borderless games too), 3 = QUNS_RUNNING_D3D_FULL_SCREEN (exclusive fullscreen)
    if (fullscreenApi.state(state) !== 0 || (state[0] !== 2 && state[0] !== 3)) return false;
    const front = fullscreenApi.foreground();
    return !front || koffi.address(front) !== koffi.address(koffi.decode(win.getNativeWindowHandle(), 'void *'));
  } catch (error) {
    fullscreenApi = null;
    console.error('Fullscreen detection unavailable', error);
    return false;
  }
}

/** Windows build number (19045 = Windows 10 22H2, 22000+ = Windows 11, 22621+ = 11 22H2) */
function windowsBuild() {
  return process.platform === 'win32' ? parseInt(os.release().split('.')[2], 10) || 0 : 0;
}

// Windows 11 22H2+ draws acrylic / mica itself (DWM system backdrop); the classic blur-behind
// shows a black window there for some people, so 'auto' uses acrylic on 11 and classic on 10.
const BLUR_METHODS = ['auto', 'acrylic', 'mica', 'classic'];
const nativeBackdrop = () => windowsBuild() >= 22621;

function resolveBlurMethod() {
  const chosen = BLUR_METHODS.includes(loadWindowPrefs().blurMethod) ? loadWindowPrefs().blurMethod : 'auto';
  if (chosen === 'auto') return nativeBackdrop() ? 'acrylic' : 'classic';
  if ((chosen === 'acrylic' || chosen === 'mica') && !nativeBackdrop()) return 'classic';
  return chosen;
}

/** Windows "Transparency effects" setting; when it's off every blur is drawn as a solid color */
function transparencyEffectsOn() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
    require('child_process').execFile('reg', ['query', key, '/v', 'EnableTransparency'], { windowsHide: true, timeout: 3000 },
      (error, stdout) => resolve(error ? true : !/EnableTransparency\s+REG_DWORD\s+0x0\b/.test(stdout)));
  });
}

/** Windows 11: frameless windows lose the rounded corners unless we ask DWM for them */
function applyRoundedCorners(win) {
  if (windowsBuild() < 22000) return;
  try {
    const koffi = require('koffi');
    const dwmapi = koffi.load('dwmapi.dll');
    const setAttribute = dwmapi.func('long __stdcall DwmSetWindowAttribute(void *hwnd, uint32 attr, int *value, uint32 size)');
    const hwnd = koffi.decode(win.getNativeWindowHandle(), 'void *');
    // 33 = DWMWA_WINDOW_CORNER_PREFERENCE, 2 = DWMWCP_ROUND
    setAttribute(hwnd, 33, [2], 4);
  } catch (error) {
    console.error('Rounded corners unavailable', error);
  }
}

/** Windows 10/11: ask the compositor to blur behind the window (SetWindowCompositionAttribute) */
function applyBlurBehind(win) {
  if (process.platform !== 'win32') return false;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const AccentPolicy = koffi.struct('ACCENT_POLICY', { AccentState: 'int', AccentFlags: 'int', GradientColor: 'uint32', AnimationId: 'int' });
    // registered by name for the signature below
    koffi.struct('WINDOWCOMPOSITIONATTRIBDATA', { Attrib: 'int', pvData: 'void *', cbData: 'size_t' });
    const setAttribute = user32.func('bool __stdcall SetWindowCompositionAttribute(void *hwnd, WINDOWCOMPOSITIONATTRIBDATA *data)');
    const hwnd = koffi.decode(win.getNativeWindowHandle(), 'void *');
    const policy = Buffer.alloc(koffi.sizeof(AccentPolicy));
    // 3 = ACCENT_ENABLE_BLURBEHIND (smooth when dragging, unlike acrylic on Windows 10)
    koffi.encode(policy, AccentPolicy, { AccentState: 3, AccentFlags: 2, GradientColor: 0x10000000, AnimationId: 0 });
    return setAttribute(hwnd, { Attrib: 19, pvData: policy, cbData: policy.length });
  } catch (error) {
    console.error('Blur-behind unavailable', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Saved bounds from a monitor that's gone (or a bigger screen) would open the window off-screen:
 * keep it on a connected display, or fall back to centered defaults */
function onScreen(state) {
  const fallback = { width: 1280, height: 820, maximized: !!state.maximized };
  try {
    const areas = screen.getAllDisplays().map(d => d.workArea);
    const fits = (a) => Number.isFinite(state.x) && Number.isFinite(state.y)
      && state.x + 120 <= a.x + a.width && state.x + Math.min(state.width, a.width) - 120 >= a.x
      && state.y >= a.y - 10 && state.y + 40 <= a.y + a.height;
    const area = areas.find(fits);
    if (!area) {
      const main = screen.getPrimaryDisplay().workArea;
      return Object.assign(fallback, { width: Math.min(fallback.width, main.width), height: Math.min(fallback.height, main.height) });
    }
    return Object.assign({}, state, { width: Math.min(state.width, area.width), height: Math.min(state.height, area.height) });
  } catch (e) {
    return fallback;
  }
}

function createMainWindow() {
  let state = { width: 1280, height: 820 };
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))); } catch (e) { /* defaults */ }
  state = onScreen(state);

  const seeThrough = seeThroughSupported() && !!loadWindowPrefs().seeThrough;
  const blurMethod = seeThrough && process.platform === 'win32' ? resolveBlurMethod() : null;
  const chrome = seeThrough
    // transparent windows can't use the native title bar buttons: the page draws its own
    ? (process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 20 }, vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
      : (blurMethod === 'classic'
        ? { frame: false, transparent: true, backgroundColor: '#00000000' }
        // native backdrop: DWM draws acrylic/mica behind the transparent page
        : { frame: false, backgroundColor: '#00000000', backgroundMaterial: blurMethod }))
    : {
      backgroundColor: '#121212',
      titleBarStyle: 'hidden',
      titleBarOverlay: process.platform === 'darwin' ? true : { color: '#00000000', symbolColor: '#ffffff', height: TITLEBAR_HEIGHT },
      trafficLightPosition: { x: 16, y: 20 }
    };

  mainWindow = new BrowserWindow(Object.assign({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Quantm',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  }, chrome));
  mainWindow.seeThrough = seeThrough;
  mainWindow.blurMethod = blurMethod;
  crashlog.watchWindow(mainWindow);
  // fully transparent windows get no Aero Snap from Windows: snap them ourselves
  if (blurMethod === 'classic') require('./window-snap').enableSnapping(mainWindow, screen);

  if (state.maximized) mainWindow.maximize();
  let shown = false;
  const showWindow = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    if (blurMethod === 'classic') applyBlurBehind(mainWindow);
    if (seeThrough) applyRoundedCorners(mainWindow);
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', showWindow);
  // never stay invisible: if the first paint is slow or never comes (graphics trouble), show anyway
  setTimeout(showWindow, 4000);
  const sendMaximized = () => mainWindow && mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
  // macOS swipe gestures (also what side-button tools send) go back and forward
  mainWindow.on('swipe', (event, direction) => {
    if (direction === 'left' || direction === 'right') mainWindow.webContents.send('nav:history', direction === 'left' ? 'back' : 'forward');
  });
  mainWindow.on('maximize', sendMaximized);
  const sendVisibility = (hidden) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('window:visibility', hidden);
  mainWindow.on('minimize', () => sendVisibility(true));
  mainWindow.on('hide', () => sendVisibility(true));
  mainWindow.on('restore', () => sendVisibility(false));
  mainWindow.on('show', () => sendVisibility(false));
  // Performance mode can follow games: tell the page while another app is fullscreen (checked every 3 s)
  let gaming = false;
  const gamingTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(gamingTimer); return; }
    const now = otherAppFullscreen(mainWindow);
    if (now !== gaming) { gaming = now; mainWindow.webContents.send('window:gaming', gaming); }
  }, 3000);
  mainWindow.webContents.on('did-finish-load', () => { if (gaming) mainWindow.webContents.send('window:gaming', true); });
  mainWindow.on('unmaximize', sendMaximized);
  // Windows 11 drops the acrylic/mica backdrop when the window is maximized or restored, leaving it
  // black (an Electron bug fixed in later versions): put the backdrop back after each change
  if (blurMethod && blurMethod !== 'classic' && mainWindow.setBackgroundMaterial) {
    const apply = () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      mainWindow.setBackgroundMaterial('none');
      mainWindow.setBackgroundMaterial(blurMethod);
    };
    // once right away and once after Windows' maximize / restore-from-taskbar animation has finished
    const reapplyBackdrop = () => { setTimeout(apply, 60); setTimeout(apply, 450); };
    ['maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen'].forEach(name => mainWindow.on(name, reapplyBackdrop));
    // coming back from the taskbar also focuses the window; one quick re-apply covers that path too
    mainWindow.on('focus', () => setTimeout(apply, 60));
  }

  const saveState = () => {
    if (!mainWindow || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify(Object.assign(bounds, { maximized: mainWindow.isMaximized() })));
  };
  mainWindow.on('close', saveState);

  // links open in the user's browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// Settings safety net (see src/js/persist.js): the page mirrors its quantm.* keys into this file as
// they change, written synchronously, so a forced close can't undo a change the way it can in localStorage.
const prefsFile = () => path.join(app.getPath('userData'), 'settings-backup.json');
let prefsBackup = null;

function loadPrefsBackup() {
  if (prefsBackup) return prefsBackup;
  try {
    const data = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    prefsBackup = data && data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys) ? data.keys : {};
  } catch (e) {
    prefsBackup = {};
  }
  return prefsBackup;
}

function savePrefsBackup(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
  const keys = loadPrefsBackup();
  for (const [key, value] of Object.entries(entries)) {
    if (!/^quantm\.[\w.-]{1,80}$/.test(key)) continue;
    if (value === null) delete keys[key];
    else if (typeof value === 'string' && value.length <= 2 * 1024 * 1024) keys[key] = value;
  }
  const text = JSON.stringify({ version: 1, savedAt: Date.now(), keys });
  if (text.length > 8 * 1024 * 1024) return false;
  const file = prefsFile();
  try {
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
    return true;
  } catch (e) {
    return false;
  }
}

/** Only Quantm's own page (file://, in the main window) may use the bridge */
function fromApp(event) {
  const frame = event.senderFrame;
  return !!(mainWindow && event.sender === mainWindow.webContents && frame && frame === mainWindow.webContents.mainFrame && frame.url.startsWith('file://'));
}

function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('Blocked IPC from ' + (event.senderFrame ? event.senderFrame.url : 'unknown'));
    return listener(event, ...args);
  });
}

/** sndcdn.com over https only (artwork, waveforms) */
function sndcdnUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /(^|\.)sndcdn\.com$/.test(url.hostname) ? url : null;
  } catch (e) {
    return null;
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// read synchronously by persist.js before the app's modules look at their settings
ipcMain.on('prefs:load', (event) => { event.returnValue = fromApp(event) ? loadPrefsBackup() : {}; });
handle('prefs:save', (event, entries) => savePrefsBackup(entries));

handle('auth:status', () => ({ loggedIn: !!auth }));
handle('auth:login', () => openLogin());
handle('auth:logout', async () => {
  saveAuth(null);
  await session.fromPartition(LOGIN_PARTITION).clearStorageData();
  return true;
});
// manual sign-in: the token is required; the client_id is optional because Quantm can find a public one itself
handle('auth:setManual', async (event, { token, clientId } = {}) => {
  if (typeof token !== 'string' || !token.trim() || token.length > 512 || /\s/.test(token.trim())) return false;
  let id = typeof clientId === 'string' ? clientId.trim() : '';
  if (id && !/^[a-zA-Z0-9]{32}$/.test(id)) return false;
  if (!id) {
    try { id = await scrapeClientId(); } catch (e) { return false; }
    if (!/^[a-zA-Z0-9]{32}$/.test(id || '')) return false;
  }
  saveAuth({ token: token.trim(), clientId: id });
  return true;
});

handle('api:request', (event, request) => {
  if (!validApiRequest(request)) return { ok: false, status: 400, data: { error: 'bad_request' } };
  return apiRequest(request);
});
handle('api:humanCheck', (event, url) => {
  const checkUrl = humanCheckUrl({ url });
  return checkUrl ? openHumanCheck(checkUrl) : false;
});

// waveform data lives on wave.sndcdn.com, which has no CORS headers
handle('net:json', async (event, url) => {
  const parsed = sndcdnUrl(url);
  if (!parsed) return null;
  try {
    const response = await net.fetch(parsed.toString(), { signal: AbortSignal.timeout(API_TIMEOUT) });
    return response.ok ? response.json() : null;
  } catch (e) {
    return null;
  }
});

// artwork as a data URL, so the page can read its pixels (sndcdn images have no CORS headers)
handle('net:image', async (event, url) => {
  const parsed = sndcdnUrl(url);
  if (!parsed) return null;
  try {
    const response = await net.fetch(parsed.toString(), { signal: AbortSignal.timeout(API_TIMEOUT) });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch (e) {
    return null;
  }
});

handle('window:zoom', (event, factor) => {
  const value = Number(factor);
  if (mainWindow && value >= 0.5 && value <= 2) mainWindow.webContents.setZoomFactor(value);
});

handle('window:mode', async () => ({
  seeThrough: !!(mainWindow && mainWindow.seeThrough),
  supported: seeThroughSupported(),
  customControls: !!(mainWindow && mainWindow.seeThrough && process.platform !== 'darwin'),
  maximized: !!(mainWindow && mainWindow.isMaximized()),
  platform: process.platform,
  blurMethod: BLUR_METHODS.includes(loadWindowPrefs().blurMethod) ? loadWindowPrefs().blurMethod : 'auto',
  blurInUse: (mainWindow && mainWindow.blurMethod) || null,
  nativeBackdrop: nativeBackdrop(),
  windowsBuild: windowsBuild(),
  transparencyEffects: await transparencyEffectsOn()
}));

handle('window:setBlurMethod', async (event, method) => {
  if (!BLUR_METHODS.includes(method)) return false;
  const prefs = loadWindowPrefs();
  prefs.blurMethod = method;
  fs.writeFileSync(windowPrefsFile(), JSON.stringify(prefs));
  if (!(mainWindow && mainWindow.seeThrough)) return true;
  // the window has to be recreated with the new material
  await session.defaultSession.flushStorageData();
  app.relaunch();
  app.quit();
  return true;
});

// saving the choice restarts the app, since a window can't become transparent later
handle('window:setSeeThrough', async (event, on) => {
  const prefs = loadWindowPrefs();
  prefs.seeThrough = !!on;
  fs.writeFileSync(windowPrefsFile(), JSON.stringify(prefs));
  // write theme/settings (localStorage) to disk first, then quit normally
  await session.defaultSession.flushStorageData();
  app.relaunch();
  app.quit();
});

handle('app:setHardwareAcceleration', async (event, on) => {
  const prefs = loadWindowPrefs();
  prefs.hardwareAcceleration = !!on;
  fs.writeFileSync(windowPrefsFile(), JSON.stringify(prefs));
  await session.defaultSession.flushStorageData();
  app.relaunch();
  app.quit();
});

handle('app:performanceInfo', () => ({
  hardwareAcceleration: loadWindowPrefs().hardwareAcceleration !== false
}));

handle('window:control', (event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
});

// Discord "Listening to Quantm" status
handle('discord:update', (event, state) => discord.update(state));
handle('discord:setEnabled', (event, on) => discord.setEnabled(on));
handle('discord:status', () => discord.status());

handle('window:titlebar', (event, { color, symbolColor } = {}) => {
  const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  if (!hex.test(color || '') || !hex.test(symbolColor || '')) return;
  if (mainWindow && !mainWindow.seeThrough && process.platform !== 'darwin' && mainWindow.setTitleBarOverlay) {
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  }
});

// Import from Spotify: a public playlist's songs, and Audius / Bandcamp searches (never given the SoundCloud login)
// Node's fetch, not net.fetch: Bandcamp answers Chromium's network stack with an HTML page instead of results
const sources = importSources.createSources({ fetch: (url, options) => fetch(url, options) });
handle('sources:spotifyPlaylist', (event, link) => sources.spotifyPlaylist(link));
handle('sources:audiusSearch', (event, query) => sources.audiusSearch(query));
handle('sources:bandcampSearch', (event, query) => sources.bandcampSearch(query));

handle('shell:open', (event, url) => {
  if (typeof url === 'string' && url.length < 4096 && /^https:\/\//.test(url)) shell.openExternal(url);
});

handle('clipboard:write', (event, text) => clipboard.writeText(String(text).slice(0, 100000)));

// Offline downloads (offline.js): only tracks whose artist allows downloads
const sendOffline = (progress) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('offline:progress', progress);
handle('offline:list', () => offline.list());
handle('offline:download', async (event, id) => {
  try {
    return { ok: true, entry: await offline.download(apiRequest, id, sendOffline) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
handle('offline:cancel', (event, id) => offline.cancel(id));
handle('offline:remove', (event, id) => offline.remove(id));
handle('offline:removeAll', () => offline.removeAll());
handle('offline:openFolder', () => {
  fs.mkdirSync(offline.folder(), { recursive: true });
  return shell.openPath(offline.folder());
});

// Updates (updater.js)
handle('update:status', () => updates.getState());
handle('update:check', () => updates.check());
handle('update:download', () => updates.download());
handle('update:install', () => updates.install());
handle('update:setAuto', (event, on) => updates.setAuto(!!on));

handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
handle('app:openCrashLogs', () => shell.openPath(crashlog.folder()));

// resource usage of all Quantm processes (Settings → Performance shows it)
handle('app:metrics', () => {
  const metrics = app.getAppMetrics();
  return {
    processes: metrics.length,
    cpu: Math.round(metrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0) * 10) / 10,
    memoryMB: Math.round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024),
    byType: metrics.map(m => ({ type: m.type, cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10, mb: Math.round(m.memory.workingSetSize / 1024) }))
  };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      // opening Quantm again always brings the window back, even if it was hidden or off-screen
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      const fixed = onScreen(Object.assign(mainWindow.getBounds(), { maximized: mainWindow.isMaximized() }));
      if (!fixed.maximized && (fixed.x === undefined || fixed.width !== mainWindow.getBounds().width)) {
        mainWindow.setBounds({ width: fixed.width, height: fixed.height });
        mainWindow.center();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    crashlog.sessionStarted();
    registerNotificationIdentity();
    auth = loadAuth();
    clearStaleDatadome();
    offline.handleScheme();
    createMainWindow();
    updates.init({
      notify: (state) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('update:status', state),
      getPref: (key) => loadWindowPrefs()[key],
      setPref: (key, value) => {
        const prefs = loadWindowPrefs();
        prefs[key] = value;
        fs.writeFileSync(windowPrefsFile(), JSON.stringify(prefs));
      }
    });
  });

  // make sure the latest theme and settings are on disk however the app closes
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed) return;
    event.preventDefault();
    flushed = true;
    session.defaultSession.flushStorageData();
    setTimeout(() => app.quit(), 50);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
  });
}
