import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { PRESETS, PRESET_STYLES, PRESET_RADIUS, PRESET_FAMILIES, contrast, luminance } = await import('../src/js/theme.js');
const { packFor } = await import('../src/js/theme-packs.js');

const THEMES = {
  'DORFic': { style: 'dorfic', radius: 3, light: true },
  'Frutiger Aurora': { style: 'frutiger-aurora', radius: 18, light: false },
  'Dark Aero': { style: 'dark-aero', radius: 12, light: false }
};
// split a selector list on top-level commas only (not the ones inside :is(...) or :nth-child(...))
function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) { parts.push(list.slice(from, i)); from = i + 1; }
  }
  parts.push(list.slice(from));
  return parts;
}
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../src/index.html');
const css = style => read(`../src/styles/themes/${style}.css`);

test('DORFic, Frutiger Aurora and Dark Aero are registered presets with a style id and a corner radius', () => {
  for (const [name, { style, radius }] of Object.entries(THEMES)) {
    assert.ok(PRESETS[name], `${name} preset`);
    assert.equal(PRESET_STYLES[name], style);
    assert.equal(PRESET_RADIUS[name], radius);
    assert.equal(packFor(style), null, `${name} is CSS-only`);
    assert.ok(!Object.values(PRESET_FAMILIES).some(flavors => Object.values(flavors).includes(name)), `${name} has its own gallery card`);
  }
});

test('the new themes link their stylesheets from index.html', () => {
  for (const { style } of Object.values(THEMES)) {
    assert.ok(html.includes(`<link rel="stylesheet" href="styles/themes/${style}.css">`), style);
  }
});

test('the new themes keep body text, secondary text and accent labels at WCAG AA', () => {
  for (const [name, { light }] of Object.entries(THEMES)) {
    const c = PRESETS[name];
    assert.equal(luminance(c.bg) > 0.5, light, `${name} scheme`);
    for (const background of ['bg', 'surface', 'bar']) {
      for (const foreground of ['text', 'muted']) {
        assert.ok(contrast(c[foreground], c[background]) >= 4.5, `${name}: ${foreground} on ${background}`);
      }
    }
    assert.ok(contrast(c.accentText, c.accent) >= 4.5, `${name}: accent label`);
    assert.ok(contrast(c.wavePlayed, c.bg) >= 1.5 || contrast(c.wavePlayed, c.surface) >= 1.5, `${name}: played waveform is visible`);
  }
});

test('every rule in the new stylesheets is scoped to its own style id', () => {
  for (const { style } of Object.values(THEMES)) {
    const source = css(style).replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("[^"]*"\)/g, 'url()');
    const scope = `html[data-style="${style}"]`;
    // every selector that opens a block (after a brace or at the start) must start with the scope
    const selectors = [...source.matchAll(/(^|[{}])\s*([^{};@]+)\{/g)].map(m => m[2].trim())
      .filter(sel => !/^(from|to|[0-9]+%)/.test(sel));
    assert.ok(selectors.length > 40, `${style}: has real rules`);
    for (const sel of selectors) {
      for (const part of splitSelectors(sel)) {
        assert.ok(part.trim().startsWith(scope), `${style}: unscoped selector "${part.trim()}"`);
      }
    }
  }
});

test('the new stylesheets cover the whole app through the shared selectors', () => {
  const must = ['.topbar', '.nav-link', '.card', '.track-row', '.playerbar', '.pb-fill', '.menu', '.modal', '.settings-card', '.input', '.toast', '::-webkit-scrollbar-thumb', '.btn', '.queue-panel'];
  for (const { style } of Object.values(THEMES)) {
    const source = css(style);
    for (const selector of must) assert.ok(source.includes(selector), `${style}: ${selector}`);
  }
});

test('the new stylesheets respect motion settings and performance mode', () => {
  for (const { style } of Object.values(THEMES)) {
    const source = css(style);
    const scope = `html[data-style="${style}"]`;
    assert.ok(source.includes(`${scope}[data-theme-motion="off"] *`), `${style}: motion off`);
    assert.ok(source.includes(`${scope}[data-perf] *`), `${style}: performance mode`);
    assert.ok(source.includes(`${scope}[data-hidden] *`), `${style}: hidden window`);
    assert.match(source, /@media \(prefers-reduced-motion: reduce\)[\s\S]*:not\(\[data-theme-motion="on"\]\)/, `${style}: reduced motion`);
    assert.ok(source.includes(`${scope}[data-perf] * { backdrop-filter: none !important;`), `${style}: no backdrop blur in performance mode`);
  }
});

test('Frutiger Aurora animates its sky only through gated keyframes', () => {
  const source = css('frutiger-aurora');
  assert.match(source, /@keyframes fa-drift-a/);
  assert.match(source, /@keyframes fa-drift-b/);
  assert.ok(source.includes('html[data-style="frutiger-aurora"][data-perf] body::after { display: none; }'));
  assert.ok(!/@keyframes/.test(css('dorfic')) && !/@keyframes/.test(css('dark-aero')), 'the other two are static');
});

test('the new stylesheets use glass blur, inline art only, and no outside images, fonts or product names', () => {
  for (const { style } of Object.values(THEMES)) {
    const source = css(style);
    const rest = source.replace(/url\("data:image[/]svg[+]xml,[^"]*"\)/g, 'url()');
    assert.ok(!/https?:|@import|@font-face/i.test(rest) && !/url\([^)]/.test(rest), `${style}: no external resources`);
    assert.ok(!/(microsoft|windows|apple|aqua|vista|aero glass|frutiger-aero\.css|spotify|soundcloud|nvidia|samsung|sony|google)/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), `${style}: no product names in rules`);
  }
  assert.ok(css('frutiger-aurora').includes('backdrop-filter: var(--glass-blur)'));
  assert.ok(css('dark-aero').includes('backdrop-filter: var(--smoke-blur)'));
  assert.ok(css('dorfic').includes('data:image/svg+xml'), 'DORFic draws its hex lattice as inline SVG');
});

test('DORFic uses its darker orange wherever the core stylesheets paint the accent as text', () => {
  const source = css('dorfic');
  const darkOrange = source.match(/--dorf-orange-text:\s*(#[0-9a-f]{6})/i)[1];
  for (const surface of ['#ffffff', PRESETS['DORFic'].bg, '#fff3e6']) {
    assert.ok(contrast(darkOrange, surface) >= 4.5, `dark orange on ${surface}`);
  }
  assert.ok(contrast(PRESETS['DORFic'].accent, '#ffffff') < 3, 'the bright accent is for fills, not text');
  const files = ['app.css', 'views/settings.css', 'views/stats.css', 'views/audio-tools.css', 'views/library.css', 'views/search.css', 'views/track.css', 'views/trending.css', 'views/user.css'];
  const exempt = new Set(['.logo', '.logo:hover']);
  const missing = [];
  for (const file of files) {
    const core = read(`../src/styles/${file}`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of core.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[;\s])color:\s*var\(--accent\)/.test(body)) continue;
      for (const part of splitSelectors(selectors).map(sel => sel.trim())) {
        if (!part || part.startsWith('@') || exempt.has(part)) continue;
        if (!source.includes(part)) missing.push(`${file}: ${part}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('Frutiger Aurora keeps backdrop blur off cards and rows and on the fixed bars', () => {
  const source = css('frutiger-aurora');
  const scope = 'html[data-style="frutiger-aurora"]';
  const cardRule = source.split('\n').find(line => line.startsWith(`${scope} :is(.card, .feed-card`)) || '';
  assert.ok(cardRule, 'panel rule found');
  const block = source.slice(source.indexOf(cardRule), source.indexOf('}', source.indexOf(cardRule)));
  assert.ok(block.includes('backdrop-filter: none'), 'cards, lists and settings panels do not blur');
  assert.ok(!/(\.track-row|\.queue-row)[^{]*\{[^}]*backdrop-filter: var/.test(source), 'rows do not blur');
  assert.ok(source.includes(`${scope} .topbar,`) && /\.playerbar,[^}]*backdrop-filter: var\(--glass-blur\)/.test(source), 'bars blur');
  assert.ok(contrast(PRESETS['Frutiger Aurora'].muted, '#2a7c78') >= 3, 'secondary text stays legible on a bright curtain');
});

test('Dark Aero keeps backdrop blur off cards, rows and lists and on the bars, menus, modals and toasts', () => {
  const source = css('dark-aero').replace(/\/\*[\s\S]*?\*\//g, '');
  const scope = 'html[data-style="dark-aero"]';
  const cardAt = source.indexOf(`${scope} :is(.card, .feed-card`);
  assert.ok(cardAt >= 0, 'panel rule found');
  const block = source.slice(cardAt, source.indexOf('}', cardAt));
  assert.ok(block.includes('backdrop-filter: none'), 'cards, lists and settings panels do not blur');
  assert.ok(!block.includes('--smoke-blur'));
  assert.ok(!/(\.track-row|\.queue-row)[^{]*\{[^}]*backdrop-filter: var/.test(source), 'rows do not blur');
  // every remaining blur belongs to a fixed bar, menu, modal or toast
  const blurred = [...source.matchAll(/([^{}]+)\{([^{}]*backdrop-filter:\s*(?:var\(--smoke-blur\)|blur\([^)]*\))[^{}]*)\}/g)].map(m => m[1].trim());
  assert.ok(blurred.length >= 4, 'bars and overlays still blur');
  for (const selector of blurred) assert.ok(!/\.(card|feed-card|settings-card|track-list|user-card|hero|track-row)\b/.test(selector), `no blur on ${selector}`);
  // a more opaque smoke fill stands in for the blur, and the text on it stays readable
  const fill = Number(source.match(/--smoke-fill:\s*color-mix\(in srgb, var\(--surface\) (\d+)%/)[1]);
  assert.ok(fill >= 85, 'card fill is at least 85% opaque');
  const c = PRESETS['Dark Aero'];
  assert.ok(contrast(c.text, c.surface) >= 4.5 && contrast(c.muted, c.surface) >= 4.5);
});
