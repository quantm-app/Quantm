// Keeping Quantm light, especially while gaming:
// - while minimized: pause every animation and drawing loop, and drop image caches
// - Performance mode: no blur, animations, transitions or visualizer at all
//   (also on by itself while a game is fullscreen, unless that's turned off)
import { store, settings } from './store.js';

let trimTimer = null;
let gaming = false;

/** Performance mode is on when you turned it on, or while a game is fullscreen (performanceWhileGaming) */
export function performanceActive(s, isGaming) {
  return !!s.performanceMode || (isGaming && s.performanceWhileGaming !== false);
}

function applyPerformanceMode() {
  document.documentElement.toggleAttribute('data-perf', performanceActive(settings, gaming));
  document.dispatchEvent(new CustomEvent('appvisibility'));
}

function setHidden(hidden) {
  const root = document.documentElement;
  const pause = hidden && settings.pauseWhenHidden !== false;
  root.toggleAttribute('data-hidden', pause);
  document.dispatchEvent(new CustomEvent('appvisibility'));
  clearTimeout(trimTimer);
  // once it has stayed minimized for a moment, free decoded images and caches
  if (pause) trimTimer = setTimeout(() => window.native.trimMemory(), 2000);
}

export function initPerformance() {
  applyPerformanceMode();
  window.native.onVisibility(setHidden);
  window.native.onGaming?.(on => { gaming = !!on; applyPerformanceMode(); });
  store.on('settings', applyPerformanceMode);
}
