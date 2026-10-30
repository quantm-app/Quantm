'use strict';

// Preload of the human-check window. The check runs as the top-level page, so its parent.postMessage()
// result lands on the window itself; read it here instead of attaching the devtools debugger, which
// DataDome's captcha detects ("use of developer or inspection tools") and answers with a bare RETRY.
// Nothing is exposed to the page.
const { ipcRenderer } = require('electron');

window.addEventListener('message', (event) => {
  try {
    // synthetic events (dispatchEvent from page script) are untrusted; only real postMessage deliveries count
    if (!event.isTrusted) return;
    if (!/^https:\/\/([^/]+\.)?captcha-delivery\.com$/.test(event.origin)) return;
    let data = event.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return; }
    }
    const cookie = data && typeof data === 'object' ? data.cookie : null;
    if (typeof cookie === 'string' && cookie.startsWith('datadome=')) ipcRenderer.send('check:clearance', cookie);
  } catch (e) { /* never let the page's messages break the check */ }
});
