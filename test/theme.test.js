import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { installBrowser } from './helpers/browser.js';

installBrowser();
const { hexToRgb, luminance, contrast, importTheme, exportTheme, DEFAULT_THEME, PRESETS, PRESET_STYLES, PRESET_RADIUS, THEME_FIELDS } = await import('../src/js/theme.js');

test('hexToRgb supports full and short hex colors', () => {
  assert.deepEqual(hexToRgb('#ff5500'), [255, 85, 0]);
  assert.deepEqual(hexToRgb('#aBc'), [170, 187, 204]);
  assert.deepEqual(hexToRgb('123456'), [18, 52, 86]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
});

test('luminance and contrast have known reference values', () => {
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(luminance('#ff0000'), 0.2126);
  assert.ok(Math.abs(luminance('#808080') - 0.2158605) < 0.000001);
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#ff5500', '#ff5500'), 1);
  assert.equal(contrast('#123456', '#abcdef'), contrast('#abcdef', '#123456'));
});

test('theme import/export preserves custom colors, radius and supported style', () => {
  const theme = { preset: 'Custom', colors: { ...DEFAULT_THEME.colors, accent: '#123abc' }, radius: 0, style: 'glass' };
  assert.deepEqual(importTheme(exportTheme(theme)), theme);
  assert.deepEqual(importTheme(exportTheme(importTheme(exportTheme(theme)))), theme);
});

test('theme import rejects invalid input and defaults invalid slots', () => {
  assert.throws(() => importTheme('not json'), SyntaxError);
  assert.throws(() => importTheme('{}'), /Not a Quantm theme/);
  assert.throws(() => importTheme('{"colors":null}'), /Not a Quantm theme/);
  assert.throws(() => importTheme('null'), /Not a Quantm theme/);
  const imported = importTheme(JSON.stringify({ colors: { accent: 'red', text: '#abcdef', unknown: '#123456' }, style: 'unknown' }));
  assert.equal(imported.colors.accent, DEFAULT_THEME.colors.accent);
  assert.equal(imported.colors.text, '#abcdef');
  assert.equal(imported.radius, DEFAULT_THEME.radius);
  assert.equal(imported.style, '');
  assert.equal(imported.colors.unknown, undefined);
  assert.equal(imported.preset, 'Custom');
});

test('every preset defines all nine editable colors as full hex values', () => {
  assert.equal(THEME_FIELDS.length, 9);
  for (const [name, colors] of Object.entries(PRESETS)) {
    for (const { key } of THEME_FIELDS) {
      assert.match(colors[key] || '', /^#[0-9a-f]{6}$/i, `${name}: ${key}`);
    }
  }
});

test('every style preset has a stylesheet and an index stylesheet link', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(([link]) => link);
  for (const [name, style] of Object.entries(PRESET_STYLES)) {
    assert.ok(PRESETS[name], `${name} is a registered preset`);
    assert.ok(existsSync(new URL(`../src/styles/themes/${style}.css`, import.meta.url)), style);
    assert.ok(links.some(link => /rel="stylesheet"/.test(link) && link.includes(`href="styles/themes/${style}.css"`)), `${style} stylesheet link`);
  }
});

const makeovers = {
  'Frutiger Aero': 'frutiger-aero', 'Terminal': 'terminal', 'Windows 98': 'win98',
  'Vinyl': 'vinyl', 'Brutalist': 'brutalist'
};

test('new makeovers have readable text and accent labels on their palette surfaces', () => {
  for (const [name, style] of Object.entries(makeovers)) {
    assert.equal(PRESET_STYLES[name], style);
    assert.ok(Number.isFinite(PRESET_RADIUS[name]), `${name} radius`);
    const c = PRESETS[name];
    for (const background of ['bg', 'surface', 'bar']) {
      for (const foreground of ['text', 'muted']) {
        assert.ok(contrast(c[foreground], c[background]) >= 4.5, `${name}: ${foreground} on ${background}`);
      }
    }
    assert.ok(contrast(c.accentText, c.accent) >= 4.5, `${name}: accent label`);
  }
});
