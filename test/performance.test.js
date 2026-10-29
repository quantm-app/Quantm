import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.js';

test('Performance mode follows a fullscreen game unless that is turned off, and always stays on when you chose it', async () => {
  installBrowser();
  const { performanceActive } = await import('../src/js/performance.js');
  assert.equal(performanceActive({ performanceMode: false }, false), false);
  // older saves have no performanceWhileGaming: it defaults to on
  assert.equal(performanceActive({ performanceMode: false }, true), true);
  assert.equal(performanceActive({ performanceMode: false, performanceWhileGaming: true }, true), true);
  assert.equal(performanceActive({ performanceMode: false, performanceWhileGaming: false }, true), false);
  assert.equal(performanceActive({ performanceMode: true, performanceWhileGaming: false }, false), true);
});
