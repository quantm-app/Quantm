// Widevine support. On an Electron build that ships the Widevine module, hls.js plays SoundCloud's
// "ctr-encrypted-hls" (label) streams through the browser's standard EME API, the same license flow
// SoundCloud's own web player uses. Without the module nothing here changes: those tracks stay locked.

export const WIDEVINE_PROTOCOL = 'ctr-encrypted-hls';
export const WIDEVINE_LICENSE_URL = 'https://license.media-streaming.soundcloud.cloud/playback/widevine';
const PROBE_TIMEOUT_MS = 3000;
const RETRY_DELAYS_MS = [10000, 30000, 60000, 120000, 300000];

let ready = false;
let retrying = false;

export const drmReady = () => ready;
export function setDrmReady(value) { ready = !!value; }

/** Whether this browser can open a Widevine key session. Never throws; stores the answer for drmReady() */
export async function probeDrm(nav = globalThis.navigator) {
  let timer;
  try {
    if (!nav || typeof nav.requestMediaKeySystemAccess !== 'function') return (ready = false);
    const access = nav.requestMediaKeySystemAccess('com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
    }]);
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); });
    ready = (await Promise.race([Promise.resolve(access).then(() => true, () => false), timeout])) === true;
  } catch (error) {
    ready = false;
  } finally {
    clearTimeout(timer);
  }
  return ready;
}

/** On a first launch the Widevine module can finish downloading after the first probe. Re-probe on a back-off until it works, then stop.
 *  One chain at a time; never throws. Resolves to the final ready state. */
export async function retryDrmProbe(nav = globalThis.navigator, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), delays = RETRY_DELAYS_MS) {
  if (ready || retrying) return ready;
  retrying = true;
  try {
    for (const ms of delays) {
      await wait(ms);
      if (ready || await probeDrm(nav)) break;
    }
  } catch (error) {
    // a broken timer must not take the app down; the probe itself never throws
  } finally {
    retrying = false;
  }
  return ready;
}

/** The transcoding protocols Quantm can play right now */
export const canPlayProtocol = (protocol) => protocol === 'progressive' || protocol === 'hls' || (ready && protocol === WIDEVINE_PROTOCOL);

/** hls.js `licenseXhrSetup` for SoundCloud's license server: the stream's token rides on the url, the challenge goes up as raw bytes */
export function licenseXhrSetup(token) {
  return (xhr, url, keyContext, licenseChallenge) => {
    const target = new URL(url);
    target.searchParams.set('license_token', token);
    xhr.open('POST', target.toString(), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    return licenseChallenge;
  };
}
