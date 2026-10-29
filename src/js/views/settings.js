// Settings: theme editor, playback options, account, shortcuts and about.
// Theme edits apply live (CSS variables are global) and are saved with a short debounce.
import { h, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { store, settings, saveSettings, VISUALIZER_DEFAULTS } from '../store.js';
import { effectsMode } from '../audio-reactivity.js';
import { player } from '../player.js';
import { EQ_PRESETS, presetFor, normalizeEqualizer } from '../equalizer.js';
import { offline, formatBytes } from '../offline.js';
import { VISUALIZER_STYLES, VISUALIZER_COLORS, VISUALIZER_POSITIONS, VISUALIZER_LIMITS } from '../visualizer.js';
import * as theme from '../theme.js';
import { packFor } from '../theme-packs.js';
import * as mixmemory from '../mixmemory.js';
import * as mixlearn from '../mixlearn.js';
import * as mixpairs from '../mixpairs.js';
import { GENRE_LABELS } from '../transitions.js';
import * as look from '../appearance.js';
import { pageHeader, button, toast, avatar, confirmDialog, promptDialog, removeAllDownloads } from '../ui.js';
import { subscribeUpdates, performUpdate, updateStatusText } from '../updates.js';

const TABS = [
  { id: 'theme', label: 'Theme & colors', icon: 'palette' },
  { id: 'appearance', label: 'Appearance', icon: 'edit' },
  { id: 'playback', label: 'Playback', icon: 'play' },
  { id: 'automix', label: 'Auto mix', icon: 'headphones' },
  { id: 'performance', label: 'Performance', icon: 'trending' },
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'queue' },
  { id: 'about', label: 'About', icon: 'cloud' }
];

export async function render(page, params, query = {}) {
  const active = TABS.some(t => t.id === params.tab) ? params.tab : 'theme';
  const cleanups = [];

  const nav = h('nav.settings-nav', TABS.map(t =>
    h('a.settings-nav-link' + (t.id === active ? '.active' : ''), { href: '#/settings/' + t.id }, icon(t.icon, 18), h('span', t.label))
  ));

  const builders = { theme: themeTab, appearance: appearanceTab, playback: playbackTab, automix: autoMixTab, performance: performanceTab, account: accountTab, shortcuts: shortcutsTab, about: aboutTab };
  const content = h('div.settings-content' + (active === 'theme' ? '.wide' : ''), await builders[active](cleanups));

  page.append(
    pageHeader('Settings', { subtitle: 'Make Quantm yours' }),
    h('div.settings-layout', nav, content)
  );
  if (query.card === 'equalizer') requestAnimationFrame(() => {
    const eq = page.querySelector('#equalizer');
    if (eq?.isConnected) { eq.scrollIntoView({ block: 'start' }); eq.focus({ preventScroll: true }); }
  });
  return () => cleanups.forEach(fn => fn());
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Titled card section */
function card(title, description, ...children) {
  return h('section.settings-card',
    h('h2.settings-card-title', title),
    description ? h('p.settings-card-desc', description) : null,
    ...children
  );
}

/** Reusable toggle switch (styled checkbox). Returns the label element. */
function switchEl(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked, input) });
  return h('span.settings-switch', input, h('span.settings-switch-track', h('span.settings-switch-knob')));
}

/** A row with title + description on the left and a switch on the right */
function toggleRow(title, desc, checked, onChange) {
  return h('label.settings-row',
    h('span.settings-row-text', h('span.settings-row-title', title), h('span.settings-row-desc', desc)),
    switchEl(checked, onChange)
  );
}

// ---------------------------------------------------------------------------
// Theme tab
// ---------------------------------------------------------------------------

const clone = (t) => ({ preset: t.preset, colors: Object.assign({}, t.colors), radius: t.radius, style: t.style || '' });

/** "#abc" / "ABCDEF" / "#aabbcc" -> "#aabbcc", or null if invalid. short=false only accepts 6 digits */
function normalizeHex(value, short = true) {
  let v = String(value).trim().replace(/^#/, '');
  if (short && /^[0-9a-f]{3}$/i.test(v)) v = v.split('').map(c => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : null;
}

function hslToHex(hue, sat, light) {
  hue = ((hue % 360) + 360) % 360;
  sat = Math.max(0, Math.min(100, sat)) / 100;
  light = Math.max(0, Math.min(100, light)) / 100;
  const k = (n) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

const rand = (min, max) => min + Math.random() * (max - min);

/** A pleasant random palette: accent from a random hue, bg derived from it, contrast checked */
function randomColors() {
  const hue = Math.floor(rand(0, 360));
  const dark = Math.random() < 0.65;
  const bgHue = hue + rand(-15, 15);
  const accent = hslToHex(hue, rand(65, 90), dark ? rand(55, 66) : rand(44, 54));
  const bgSat = rand(12, 36);

  const colors = dark ? {
    bg: hslToHex(bgHue, bgSat, rand(6, 10)),
    surface: hslToHex(bgHue, bgSat, rand(12, 16)),
    bar: hslToHex(bgHue, bgSat, rand(9, 12)),
    text: hslToHex(bgHue, rand(10, 30), rand(92, 96)),
    muted: hslToHex(bgHue, rand(8, 18), rand(62, 70)),
    wave: hslToHex(bgHue, bgSat, rand(22, 30))
  } : {
    bg: hslToHex(bgHue, bgSat, rand(94, 97)),
    surface: hslToHex(bgHue, bgSat, 100),
    bar: hslToHex(bgHue, bgSat, rand(98, 100)),
    text: hslToHex(bgHue, rand(15, 30), rand(8, 14)),
    muted: hslToHex(bgHue, rand(6, 14), rand(34, 42)),
    wave: hslToHex(bgHue, bgSat, rand(76, 82))
  };

  // accent text: whichever of white / near-black reads better on the accent
  colors.accent = accent;
  colors.accentText = theme.contrast('#ffffff', accent) >= theme.contrast('#0a0a0a', accent) ? '#ffffff' : '#0a0a0a';
  colors.wavePlayed = Math.random() < 0.7 ? accent : hslToHex(hue + 150, rand(70, 90), dark ? 62 : 48);

  // nudge text colors until they're comfortably readable on the background
  const nudge = (key, target) => {
    let light = dark ? 70 : 38;
    for (let i = 0; i < 20 && theme.contrast(colors[key], colors.bg) < target; i++) {
      light += dark ? 3 : -3;
      colors[key] = hslToHex(bgHue, 12, light);
    }
  };
  nudge('text', 7);
  nudge('muted', 4.5);
  return colors;
}

/** Fake waveform bar heights (percent), fixed so cards look consistent */
const WAVE = [40, 70, 55, 90, 65, 35, 80, 60, 95, 50, 75, 45, 85, 55, 30, 65, 40, 70];

function waveBars(played = 7) {
  return h('span.settings-wave', WAVE.map((height, i) =>
    h('span' + (i < played ? '.on' : ''), { style: { height: height + '%' } })
  ));
}

/** Inline custom properties for a preset mock (colors scoped to the mock only) */
function mockVars(c) {
  return `--m-bg:${c.bg};--m-surface:${c.surface};--m-bar:${c.bar};--m-text:${c.text};--m-muted:${c.muted};` +
    `--m-accent:${c.accent};--m-accent-text:${c.accentText};--m-wave:${c.wave};--m-wp:${c.wavePlayed}`;
}

/** Mini UI mock drawn in a preset's colors */
function presetMock(colors) {
  return h('div.settings-mock', { style: mockVars(colors) },
    h('div.settings-mock-bar', h('span.settings-mock-dot'), h('span.settings-mock-line')),
    h('div.settings-mock-body',
      h('div.settings-mock-card',
        h('span.settings-mock-play'),
        h('div.settings-mock-lines', h('span.settings-mock-text'), h('span.settings-mock-muted')),
        waveBars()
      )
    )
  );
}

async function themeTab(cleanups) {
  let draft = clone(theme.getTheme());
  const rows = {};         // key -> { color, text, warn }
  const presetCards = {};  // preset name -> element
  const familyCards = [];  // refresh functions of the cards that hold several flavors

  const persist = debounce(() => theme.saveTheme(clone(draft)), 300);
  // apply to the whole app right away, save shortly after
  const live = () => { theme.applyTheme(draft); persist(); };
  // used by discrete actions (presets, random, import, reset)
  const commit = (next) => { draft = clone(next); theme.saveTheme(clone(draft)); syncAll(); };

  // --- contrast warnings -------------------------------------------------------
  const CHECKS = [
    { key: 'text', against: 'bg', min: 4.5, what: 'the background' },
    { key: 'muted', against: 'bg', min: 3, what: 'the background' },
    { key: 'accentText', against: 'accent', min: 3, what: 'the accent' }
  ];
  const updateWarnings = () => {
    for (const { key, against, min, what } of CHECKS) {
      const ratio = theme.contrast(draft.colors[key], draft.colors[against]);
      const warn = rows[key].warn;
      warn.textContent = ratio < min ? `Low contrast against ${what} (${ratio.toFixed(1)}:1, aim for ${min}:1)` : '';
      warn.classList.toggle('show', ratio < min);
    }
  };

  const updatePresetMarks = () => {
    for (const [name, el] of Object.entries(presetCards)) el.classList.toggle('active', draft.preset === name);
    familyCards.forEach(refresh => refresh());
  };

  // --- color rows --------------------------------------------------------------
  const setColor = (key, hex, source) => {
    draft.colors[key] = hex;
    draft.preset = 'Custom';
    const row = rows[key];
    if (source !== 'color') row.color.value = hex;
    if (source !== 'text') row.text.value = hex;
    row.text.classList.remove('invalid');
    updateWarnings();
    updatePresetMarks();
    live();
  };

  const colorRow = ({ key, label, hint }) => {
    const color = h('input.settings-color', { type: 'color', value: draft.colors[key], title: label,
      oninput: () => setColor(key, color.value, 'color') });
    const text = h('input.input.settings-hex', { value: draft.colors[key], maxLength: 7, spellcheck: false, 'aria-label': label + ' hex value',
      oninput: () => {
        const hex = normalizeHex(text.value, false);
        text.classList.toggle('invalid', !hex);
        if (hex) setColor(key, hex, 'text');
      },
      onchange: () => {
        const hex = normalizeHex(text.value);
        if (hex) setColor(key, hex);
        else text.value = draft.colors[key];
        text.classList.remove('invalid');
      } });
    const warn = h('div.settings-warn');
    rows[key] = { color, text, warn };
    return h('div.settings-color-row',
      color,
      h('div.settings-color-info', h('div.settings-row-title', label), h('div.settings-row-desc', hint), warn),
      text
    );
  };

  // --- radius ------------------------------------------------------------------
  const radius = rangeControl({ min: 0, max: 30, value: draft.radius, unit: 'px', label: 'Corner roundness' }, (v) => {
    draft.radius = v;
    live();
  });

  // --- sync every control with `draft` after a bulk change -----------------------
  function syncAll() {
    for (const { key } of theme.THEME_FIELDS) {
      rows[key].color.value = draft.colors[key];
      rows[key].text.value = draft.colors[key];
      rows[key].text.classList.remove('invalid');
    }
    radius.setValue(draft.radius);
    updateWarnings();
    updatePresetMarks();
  }

  // --- preset gallery ----------------------------------------------------------
  const usePreset = (name) => {
    const colors = theme.PRESETS[name];
    if (theme.PRESET_STYLES[name] === 'liquid') offerSeeThrough();
    commit({ preset: name, colors: Object.assign({}, colors), radius: name in theme.PRESET_RADIUS ? theme.PRESET_RADIUS[name] : draft.radius, style: theme.PRESET_STYLES[name] || '' });
  };

  const presetCard = (name) => {
    const el = h('div.settings-preset',
      h('button.settings-preset-pick', { type: 'button', title: 'Use ' + name, onclick: () => usePreset(name) },
        presetMock(theme.PRESETS[name]),
        h('span.settings-preset-name', h('span', name), icon('check', 14))
      )
    );
    presetCards[name] = el;
    return el;
  };

  // one card for a theme with several flavors: the swatches underneath pick the flavor
  const familyCard = (family, flavors) => {
    const entries = Object.entries(flavors).filter(([, name]) => theme.PRESETS[name]);
    let shown = entries[0][1];
    const mock = h('div');
    const label = h('span');
    const pick = h('button.settings-preset-pick', { type: 'button', onclick: () => usePreset(shown) },
      mock, h('span.settings-preset-name', label, icon('check', 14)));
    const swatches = entries.map(([flavor, name]) => h('button.settings-flavor', {
      type: 'button', title: flavor, 'aria-label': `${family} ${flavor}`,
      style: `--f-bg:${theme.PRESETS[name].bg};--f-accent:${theme.PRESETS[name].accent}`,
      onclick: () => usePreset(name)
    }));
    const el = h('div.settings-preset.settings-preset-family', pick, h('div.settings-flavors', { role: 'group', 'aria-label': family + ' flavors' }, swatches));
    familyCards.push(() => {
      const current = entries.find(([, name]) => name === draft.preset);
      if (current) shown = current[1];
      const flavor = entries.find(([, name]) => name === shown)[0];
      mock.replaceChildren(presetMock(theme.PRESETS[shown]));
      label.textContent = `${family} ${flavor}`;
      pick.title = `Use ${family} ${flavor}`;
      el.classList.toggle('active', !!current);
      swatches.forEach((swatch, i) => swatch.setAttribute('aria-pressed', String(entries[i][1] === draft.preset)));
    });
    return el;
  };

  // Colors (palette only), Makeovers (also shapes, fonts and textures), Theme packs (also change the layout)
  const inFamily = new Map();
  for (const [family, flavors] of Object.entries(theme.PRESET_FAMILIES)) {
    for (const name of Object.values(flavors)) if (theme.PRESETS[name]) inFamily.set(name, family);
  }
  const groups = { colors: [], makeovers: [], packs: [], local: [] };
  const placed = new Set();
  for (const name of Object.keys(theme.PRESETS)) {
    const style = theme.PRESET_STYLES[name] || '';
    const group = theme.LOCAL_PRESETS.has(name) ? groups.local
      : !style ? groups.colors : packFor(style) ? groups.packs : groups.makeovers;
    const family = inFamily.get(name);
    if (!family) group.push(presetCard(name));
    else if (!placed.has(family)) { placed.add(family); group.push(familyCard(family, theme.PRESET_FAMILIES[family])); }
  }
  const section = (title, desc, cards) => cards.length ? h('div.settings-preset-group',
    h('div.settings-preset-group-head', h('span.settings-row-title', title), h('span.settings-row-desc', desc)),
    h('div.settings-presets', cards)
  ) : null;
  const gallery = h('div',
    section('Colors', 'Just the palette', groups.colors),
    section('Makeovers', 'Also change shapes, fonts and textures', groups.makeovers),
    section('Theme packs', 'Rearrange the whole app', groups.packs),
    section('Dev themes', 'Only on this computer, never published', groups.local)
  );

  // --- actions -----------------------------------------------------------------
  const randomize = () => commit({ preset: 'Custom', colors: randomColors(), radius: draft.radius, style: '' });

  const exportIt = async () => {
    try {
      await window.native.copy(theme.exportTheme(draft));
      toast('Theme copied to clipboard');
    } catch (e) {
      toast("Couldn't copy the theme", 'error');
    }
  };

  const importIt = async () => {
    const text = await promptDialog('Import theme', { label: 'Paste theme JSON', placeholder: '{ "colors": { ... } }', confirmLabel: 'Import' });
    if (!text) return;
    try {
      commit(theme.importTheme(text));
      toast('Theme imported');
    } catch (e) {
      toast("That isn't a valid Quantm theme", 'error');
    }
  };

  const reset = () => {
    commit(theme.DEFAULT_THEME);
    toast('Theme reset to default');
  };

  const editor = h('div.settings-theme-main',
    card('Presets', 'Pick a starting point, then fine-tune it below.', gallery),
    card('Custom colors', 'Changes apply instantly across the whole app.',
      h('div.settings-colors', theme.THEME_FIELDS.map(colorRow)),
      h('div.settings-radius',
        h('div.settings-row-text', h('span.settings-row-title', 'Corner roundness'), h('span.settings-row-desc', 'Cards, inputs and artwork')),
        radius
      )
    ),
    card('Tools', null,
      h('div.settings-actions',
        button('Random theme', randomize, 'btn-outline', 'repeat'),
        button('Export to clipboard', exportIt, 'btn-outline', 'upload'),
        button('Import…', importIt, 'btn-outline', 'download'),
        h('div.spacer'),
        button('Reset to default', reset, 'btn-ghost', 'history')
      )
    )
  );

  syncAll();
  return h('div.settings-theme', editor, previewPanel());
}

/** Live preview built from the real app classes (they follow the global variables) */
function previewPanel() {
  return h('aside.settings-preview',
    h('div.sidebar-title', h('span', 'Live preview')),
    h('div.settings-preview-box',
      h('div.settings-pv-row',
        h('div.track-art', icon('album', 22)),
        h('div.settings-pv-meta',
          h('div.track-title', 'Midnight Drive'),
          h('div.track-sub', h('span', 'Nova Bloom'), h('span', '· 3:42'))
        ),
        h('span.tag-pill', 'Electronic')
      ),
      h('div.settings-pv-wave', waveBars(9)),
      h('div.settings-pv-actions',
        h('button.play-btn', { type: 'button', 'aria-label': 'Play' }, icon('play', 22)),
        h('button.btn.btn-primary.btn-sm', { type: 'button' }, 'Follow'),
        h('button.btn.btn-outline.btn-sm', { type: 'button' }, 'Share'),
        h('button.icon-btn.active', { type: 'button', 'aria-label': 'Liked' }, icon('heartFilled')),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Repost' }, icon('repost'))
      ),
      h('div.settings-pv-text',
        h('div', 'Primary text looks like this.'),
        h('div.muted', 'Secondary text looks like this.'),
        h('a.settings-pv-link', { href: '#/settings/theme' }, 'Accent link')
      ),
      h('div.settings-pv-bar',
        h('button.pb-play', { type: 'button', 'aria-label': 'Pause' }, icon('pause', 20)),
        h('span.pb-time', '1:12'),
        h('div.pb-progress', h('div.pb-track', h('div.pb-fill', { style: { width: '38%' } }))),
        h('span.pb-time', '3:42')
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Appearance tab: layout, background, artwork colors, fonts, waveform, schedule
// ---------------------------------------------------------------------------

/** Row with a set of chips; the clicked chip becomes active */
function chipRow(title, desc, options, value, onPick) {
  const chips = h('div.chips');
  options.forEach((option) => {
    const chip = h('button.chip' + (option.id === value ? '.active' : ''), {
      onclick: (e) => {
        e.preventDefault();
        chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        onPick(option.id);
      }
    }, option.label);
    chips.append(chip);
  });
  return h('div.settings-row.settings-row-wrap',
    h('span.settings-row-text', h('span.settings-row-title', title), desc ? h('span.settings-row-desc', desc) : null),
    chips
  );
}

/**
 * Slider plus a number box you can type into. Both stay in sync; typed values are
 * clamped to the range and rounded to the step when you press Enter or leave the box.
 * Returns { row, wrap, setValue } via the row element (row.setValue(v) updates both).
 */
function rangeControl({ min, max, step = 1, value, unit = '', label }, onInput) {
  const decimals = (String(step).split('.')[1] || '').length;
  const tidy = (v) => {
    const clamped = Math.min(max, Math.max(min, v));
    return Number((Math.round((clamped - min) / step) * step + min).toFixed(decimals));
  };
  const slider = h('input.settings-range', { type: 'range', min, max, step, value, 'aria-label': label });
  const number = h('input.input.settings-number', { type: 'number', min, max, step, value, 'aria-label': label + ' value' });
  const wrap = h('div.settings-range-wrap', slider, h('span.settings-number-wrap', number, unit ? h('span.settings-unit', unit) : null));

  const apply = (v, fromSlider) => {
    if (!fromSlider) slider.value = v;
    if (document.activeElement !== number) number.value = v;
    onInput(v);
  };
  slider.addEventListener('input', () => { number.value = slider.value; apply(Number(slider.value), true); });
  // apply while typing when the value is already valid, tidy up on Enter / blur
  number.addEventListener('input', () => {
    const v = Number(number.value);
    if (number.value !== '' && Number.isFinite(v) && v >= min && v <= max) { slider.value = v; onInput(v); }
  });
  const commit = () => {
    const v = Number(number.value);
    const next = number.value === '' || !Number.isFinite(v) ? Number(slider.value) : tidy(v);
    number.value = next;
    slider.value = next;
    onInput(next);
  };
  number.addEventListener('change', commit);
  number.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); number.blur(); } });

  wrap.setValue = (v) => { slider.value = v; if (document.activeElement !== number) number.value = v; };
  return wrap;
}

/** Row with a title / description and a slider + number box */
function sliderRow(title, desc, options, onInput) {
  const wrap = rangeControl(Object.assign({ label: title }, options), onInput);
  const row = h('div.settings-row',
    h('span.settings-row-text', h('span.settings-row-title', title), desc ? h('span.settings-row-desc', desc) : null),
    wrap
  );
  row.setValue = wrap.setValue;
  return row;
}

function selectRow(title, desc, options, value, onChange) {
  const select = h('select.input.settings-select', { onchange: () => onChange(select.value) },
    options.map(o => h('option', { value: o.id, selected: o.id === value }, o.label)));
  return h('div.settings-row',
    h('span.settings-row-text', h('span.settings-row-title', title), desc ? h('span.settings-row-desc', desc) : null),
    select
  );
}

/** Picking Liquid Glass with an opaque window: offer the real see-through effect once */
export async function offerSeeThrough() {
  try {
    const mode = await window.native.windowMode();
    if (!mode.supported || mode.seeThrough || localStorage.getItem('quantm.offeredSeeThrough')) return;
    localStorage.setItem('quantm.offeredSeeThrough', '1');
    const ok = await confirmDialog('Make the window see-through?', 'Liquid Glass looks best when your desktop shows through it. Quantm will restart to turn this on. You can change it later in Settings → Appearance → Window.', 'Restart & turn on');
    if (ok) window.native.setSeeThrough(true);
  } catch { /* an offer only: the theme is already applied, so a failed window query is not worth an error */ }
}

/** See-through window: needs a restart because a window can't become transparent later */
function windowCard(mode) {
  if (!mode.supported) return null;
  return card('Window', 'Let your desktop and other windows show through Liquid Glass themes, blurred like real glass. Quantm restarts to apply this.',
    toggleRow('See-through window', mode.seeThrough ? 'On. Pick a Liquid Glass theme to see the effect.' : 'Off', mode.seeThrough, async (on, input) => {
      const ok = await confirmDialog(on ? 'Make the window see-through?' : 'Turn off see-through?', 'Quantm will restart to apply this. Music stops for a moment.', 'Restart now');
      if (!ok) { input.checked = !on; return; }
      window.native.setSeeThrough(on);
    }),
    blurRow(mode),
    mode.platform === 'win32' && mode.transparencyEffects === false
      ? h('p.settings-warning', 'Windows "Transparency effects" is off, so the glass shows as a solid color. Turn it on in Windows Settings → Personalization → Colors. On laptops, Energy Saver can turn it off too.')
      : null
  );
}

/** Windows: which blur the see-through window uses (Windows 11 has its own acrylic and mica) */
function blurRow(mode) {
  if (mode.platform !== 'win32') return null;
  const win11 = mode.nativeBackdrop;
  const options = [
    { id: 'auto', label: win11 ? 'Automatic (Acrylic)' : 'Automatic (Classic blur)' },
    { id: 'acrylic', label: win11 ? 'Acrylic' : 'Acrylic (Windows 11 only)' },
    { id: 'mica', label: win11 ? 'Mica (tinted, no blur)' : 'Mica (Windows 11 only)' },
    { id: 'classic', label: 'Classic blur' }
  ];
  const names = { acrylic: 'Acrylic', mica: 'Mica', classic: 'Classic blur' };
  const desc = mode.seeThrough && mode.blurInUse
    ? `Using ${names[mode.blurInUse]}. If the window looks wrong or lags while dragging, try another style.`
    : 'Used when the see-through window is on.';
  return selectRow('Blur style', desc, options, mode.blurMethod, async (value) => {
    if (mode.seeThrough) {
      const ok = await confirmDialog('Change the blur style?', 'Quantm will restart to apply this. Music stops for a moment.', 'Restart now');
      if (!ok) return;
    }
    await window.native.setBlurMethod(value);
    if (!mode.seeThrough) toast('Saved. It applies when the see-through window is on.');
  });
}

async function appearanceTab() {
  const a = look.getAppearance();
  const save = (patch) => {
    try { return look.saveAppearance(patch); } catch (e) { toast(e.message, 'error'); }
  };
  const saveSoon = debounce(save, 150);

  // --- background picture picker ---
  const preview = h('div.settings-bg-preview', { style: { backgroundImage: a.bgImage ? `url("${a.bgImage}")` : '' } },
    a.bgImage ? null : h('span.muted.small', 'No picture chosen'));
  const bgModes = [{ id: 'none', label: 'None' }, { id: 'artwork', label: 'Song artwork' }, { id: 'image', label: 'My picture' }];
  const markMode = (mode) => bgRow.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', bgModes[i].id === mode));
  const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' },
    onchange: async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const dataUrl = await look.imageFileToDataUrl(file);
        save({ bgImage: dataUrl, background: 'image' });
        preview.style.backgroundImage = `url("${dataUrl}")`;
        preview.textContent = '';
        markMode('image');
        toast('Background updated');
      } catch (e) { toast(e.message, 'error'); }
      fileInput.value = '';
    } });
  const bgRow = chipRow('Background', 'Show a picture behind the app', bgModes, a.background, (mode) => {
    if (mode === 'image' && !look.getAppearance().bgImage) {
      markMode(look.getAppearance().background);
      return fileInput.click();
    }
    save({ background: mode });
  });

  const presetNames = Object.keys(theme.PRESETS).map(name => ({ id: name, label: name }));
  const schedule = a.schedule;
  const setSchedule = (patch) => save({ schedule: Object.assign({}, look.getAppearance().schedule, patch) });
  const timeInput = (key) => h('input.input.settings-time', { type: 'time', value: schedule[key], onchange: (e) => setSchedule({ [key]: e.target.value }) });

  return h('div',
    card('Theme effects', null,
      chipRow('Motion and lighting', "Music-reactive lighting and animation in themes that have them. Auto follows Windows' animation setting; Performance mode always turns them off.",
        [{ id: 'auto', label: 'Auto' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }],
        effectsMode(settings.themeEffects), (v) => saveSettings({ themeEffects: v }))
    ),
    card('Layout', 'Arrange Quantm the way you like it.',
      chipRow('Navigation', 'Links in the top bar, or in a sidebar on the left', [{ id: 'top', label: 'Top bar' }, { id: 'sidebar', label: 'Sidebar' }], a.nav, (v) => save({ nav: v })),
      chipRow('Player position', 'Where the playback controls sit. Side docks a full player panel on the right (windows under 980px wide use the bottom bar)', [{ id: 'bottom', label: 'Bottom' }, { id: 'top', label: 'Top' }, { id: 'side', label: 'Side' }], a.playerPosition, (v) => save({ playerPosition: v })),
      chipRow('Density', 'Compact fits more on screen', [{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }], a.density, (v) => save({ density: v })),
      toggleRow('Show play counts', 'On track rows and feed cards', a.showPlays, (on) => save({ showPlays: on })),
      toggleRow('Show genre tags', 'On track rows and feed cards', a.showGenres, (on) => save({ showGenres: on }))
    ),
    card('Background', "Use the playing song's artwork or your own picture as the app background.",
      bgRow,
      h('div.settings-row',
        h('span.settings-row-text', h('span.settings-row-title', 'Your picture'), h('span.settings-row-desc', 'JPG, PNG or WebP. Large images are resized.')),
        h('div.settings-bg-actions', preview,
          button('Choose…', () => fileInput.click(), 'btn-sm', 'upload'),
          button('Remove', () => {
            const current = look.getAppearance().background;
            save({ bgImage: '', background: current === 'image' ? 'none' : current });
            if (current === 'image') markMode('none');
            preview.style.backgroundImage = '';
            preview.textContent = 'No picture chosen';
          }, 'btn-ghost.btn-sm'),
          fileInput)
      ),
      sliderRow('Dim', 'How much the theme color covers the picture', { min: 0, max: 95, value: a.bgDim, unit: '%' }, (v) => saveSoon({ bgDim: v })),
      sliderRow('Blur', 'Soften the picture', { min: 0, max: 60, value: a.bgBlur, unit: 'px' }, (v) => saveSoon({ bgBlur: v }))
    ),
    card('Colors', null,
      toggleRow('Match the playing song', "The accent color changes to fit each track's artwork", a.artworkColors, (on) => {
        save({ artworkColors: on });
        if (on) look.refreshArtworkAccent();
      })
    ),
    card('Text', null,
      selectRow('Font', 'Used everywhere in the app', look.FONTS, a.font, (v) => save({ font: v })),
      sliderRow('Zoom', 'Make everything bigger or smaller', { min: 70, max: 150, step: 5, value: a.zoom, unit: '%' }, (v) => saveSoon({ zoom: v }))
    ),
    card('Waveforms', null,
      chipRow('Style', 'How track waveforms are drawn', look.WAVE_STYLES, a.waveStyle, (v) => save({ waveStyle: v })),
      sliderRow('Bar thickness', null, { min: 1, max: 6, value: a.waveThickness, unit: 'px' }, (v) => saveSoon({ waveThickness: v }))
    ),
    windowCard(await window.native.windowMode()),
    card('Theme schedule', 'Switch between two themes automatically, like a light theme by day and a dark one at night.',
      toggleRow('Switch themes automatically', "Uses your computer's clock", schedule.enabled, (on) => setSchedule({ enabled: on })),
      selectRow('Day theme', null, presetNames, schedule.day, (v) => setSchedule({ day: v })),
      selectRow('Night theme', null, presetNames, schedule.night, (v) => setSchedule({ night: v })),
      h('div.settings-row',
        h('span.settings-row-text', h('span.settings-row-title', 'Day starts / night starts')),
        h('div.settings-times', timeInput('dayStart'), h('span.muted', 'to'), timeInput('nightStart'))
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Performance tab: live usage plus the switches that make Quantm lighter
// ---------------------------------------------------------------------------

async function performanceTab(cleanups) {
  const info = await window.native.performanceInfo();
  const usage = h('div.settings-usage', h('span.muted', 'Measuring…'));

  // CPU is measured between two samples, so poll every 2 seconds
  const refresh = async () => {
    const m = await window.native.metrics();
    usage.replaceChildren(
      h('div.settings-usage-item', h('div.settings-usage-value', m.cpu + '%'), h('div.muted.small', 'CPU')),
      h('div.settings-usage-item', h('div.settings-usage-value', m.memoryMB + ' MB'), h('div.muted.small', 'Memory')),
      h('div.settings-usage-item', h('div.settings-usage-value', String(m.processes)), h('div.muted.small', 'Processes'))
    );
  };
  window.native.metrics();
  const first = setTimeout(refresh, 800);
  const timer = setInterval(refresh, 2000);
  cleanups.push(() => { clearTimeout(first); clearInterval(timer); });

  return h('div',
    card('Resource usage', 'Everything Quantm is using right now, across all of its processes.', usage),
    card('Lighter on resources', 'Handy while gaming. Music keeps playing either way.',
      toggleRow('Performance mode', 'Turn off blur, animations and the visualizer. Glass themes become solid so text stays readable.', !!settings.performanceMode,
        (on) => saveSettings({ performanceMode: on })),
      toggleRow('Performance mode while gaming', 'Turn it on by itself while a game (or any other app) is fullscreen, and off again afterwards.', settings.performanceWhileGaming !== false,
        (on) => saveSettings({ performanceWhileGaming: on })),
      toggleRow('Pause visuals when minimized', 'Stop animations and drawing, and free cached images, while Quantm is minimized.', settings.pauseWhenHidden !== false,
        (on) => saveSettings({ pauseWhenHidden: on })),
      toggleRow('Hardware acceleration', 'Use the graphics card for drawing. Turning it off leaves your GPU to your games, but Quantm uses more memory (around 200 MB more). Quantm restarts to apply this.', info.hardwareAcceleration,
        async (on, input) => {
          const ok = await confirmDialog(on ? 'Turn hardware acceleration on?' : 'Turn hardware acceleration off?', 'Quantm will restart to apply this. Music stops for a moment.', 'Restart now');
          if (!ok) { input.checked = !on; return; }
          window.native.setHardwareAcceleration(on);
        })
    )
  );
}

// ---------------------------------------------------------------------------
// Playback tab
// ---------------------------------------------------------------------------

/** What Auto mix has learned so far, with a way to forget it (mixmemory.js, mixlearn.js) */
function autoMixLearning() {
  const status = h('span.settings-row-desc');
  const show = () => {
    const songs = mixmemory.count();
    const mixes = mixlearn.stats().transitions;
    status.textContent = songs || mixes
      ? `Remembers ${songs} song${songs === 1 ? '' : 's'} and has learned from ${mixes} mix${mixes === 1 ? '' : 'es'}. It gets better the more you listen; rate a mix with the thumbs in the player and it learns from that too.`
      : 'Learns as you listen: each song it plays is remembered, and the thumbs up or down on a mix teach it what you like.';
  };
  show();
  const reset = button('Reset what it learned', async () => {
    const ok = await confirmDialog('Reset Auto mix?', 'It forgets every song it remembers and what it learned from your ratings. Your own mix points (I and O) stay.', 'Reset');
    if (!ok) return;
    mixmemory.reset();
    mixlearn.reset();
    mixpairs.reset();
    show();
    toast('Auto mix starts learning again');
  }, 'btn-outline');
  return h('div.settings-row', h('span.settings-row-text', h('span.settings-row-title', 'Auto mix learning'), status), reset);
}

// ---------------------------------------------------------------------------
// Auto mix tab: what it's doing right now and what it has learned, live
// ---------------------------------------------------------------------------

/** Name of the style a mix or plan uses, for the live rows */
const styleName = (style, genre) => GENRE_LABELS[genre] || (style === 'dropcut' ? 'Drop cut' : 'Smooth blend');

/** How the next song's key relates to the playing one's, for the up-next line (the codes are Camelot wheel keys) */
const KEY_RELATIONS = {
  same: k => `same key (${k.from})`,
  relative: k => `relative key (${k.from} → ${k.to})`,
  neighbor: k => `neighboring key (${k.from} → ${k.to})`,
  'energy-boost': k => `key lifts (${k.from} → ${k.to})`,
  clash: k => `keys clash (${k.from} → ${k.to})`
};

const AUTOMIX_RANGES = [
  ['slow', 'Under 100 BPM'], ['mid', '100-130 BPM'], ['fast', '130-160 BPM'], ['faster', '160+ BPM'], ['nobeat', 'No clear beat']
];
const clock = (t) => { const s = Math.max(0, Math.round(t || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const pct = (x, digits = 0) => (x * 100).toFixed(digits) + '%';

async function autoMixTab(cleanups) {
  const now = h('div.automix-rows');
  const learned = h('div');
  const feed = h('ol.automix-feed');
  let feedKey = '';

  const row = (label, value, tone) => h('div.automix-row' + (tone ? '.' + tone : ''), h('span.automix-label', label), h('span.automix-value', value));

  const renderNow = () => {
    const s = player.autoMixStatus();
    const rows = [];
    if (!s.enabled) rows.push(row('Status', 'Auto mix is off. Turn it on above to start mixing and learning.'));
    else if (!s.track) rows.push(row('Status', 'Waiting for something to play.'));
    else {
      rows.push(row('Playing', (s.track.title || '') + (s.listening ? '  ·  learning this song' : '')));
      const grid = s.live || s.structure.grid;
      const source = s.live ? (s.memory && s.memory.bpm ? 'heard now, tempo from memory' : 'heard now') : s.structure.grid ? 'from memory' : '';
      rows.push(row('Tempo', grid ? `${grid.bpm.toFixed(1)} BPM (${source}, confidence ${pct(grid.confidence)})`
        : s.heard ? `listening for the beat (${s.heard.toFixed(0)} s heard)` : 'listens near the end of the song'));
      if (s.key) rows.push(row('Key', `${s.key.name} (${s.key.camelot})  ·  ${pct(s.key.confidence)} sure` + (s.key.heard ? '' : ', from memory')));
      else if (s.listening) rows.push(row('Key', 'listening for the key'));
      const m = s.memory;
      const parts = [];
      if (m) parts.push(`heard ${m.plays} time${m.plays === 1 ? '' : 's'}`);
      if (s.structure.drumsIn != null) parts.push(s.structure.drumsIn > 1 ? 'drums at ' + clock(s.structure.drumsIn) : 'drums from the start');
      if (s.structure.outroStart != null) parts.push('outro from ' + clock(s.structure.outroStart));
      if (m && m.beatToEnd) parts.push('beat runs to the end');
      if (m?.drop) parts.push(`drop at ${clock(m.drop.time)}, confidence ${pct(m.drop.confidence)}`);
      rows.push(row('Memory', parts.length ? parts.join('  ·  ') + (m ? '' : '  (guessed from the waveform)') : 'first time hearing this song'));
      if (s.plan && !s.mix) {
        if (s.plan.reason) rows.push(row('Transition style', `${styleName(s.plan.style, s.plan.genre)} · ${s.plan.reason}`));
        const p = s.plan.choice ? s.plan.choice.params : null;
        const when = s.mixIn != null ? (s.mixIn > 0 ? 'in ' + clock(s.mixIn) : 'starting now') : 'near the end';
        rows.push(row('Next mix', `${when}  ·  ${(s.plan.span / (player.audio.playbackRate || 1)).toFixed(1)} s` +
          (p ? `  ·  trying ${pct(p.length)} length, ${pct(p.dj)} DJ blend, up to ${pct(p.stretch, 1)} tempo stretch` : '')));
        // the song's beat stops before its end, or two singers would overlap: what the plan does about it
        if (s.plan.ending?.kind === 'loop') rows.push(row('Ending', `loops its last ${s.plan.ending.plan.n === 1 ? 'bar' : s.plan.ending.plan.n + ' bars'} to make room for the blend`));
        else if (s.plan.ending?.kind === 'echo-out') rows.push(row('Ending', 'echo-out: the song ends abruptly, so an echo carries it out'));
        if (s.plan.vocals?.shift != null) rows.push(row('Vocals', `the blend starts ${(s.plan.vocals.shift / (player.audio.playbackRate || 1)).toFixed(1)} s later, so the two singers don't overlap`));
        else if (s.plan.vocals?.hold) rows.push(row('Vocals', 'the incoming mids are held back until the outgoing singer is done'));
      } else if (!s.mix) rows.push(row('Next mix', 'planned about 40 s before the end'));
      if (s.upNext && !s.mix) {
        const u = s.upNext;
        const sources = { memory: 'from memory', soundcloud: 'from SoundCloud', title: 'from its title', tags: 'from its tags', description: 'from its description', waveform: 'rough, from its waveform' };
        rows.push(row('Up next', u.track.title + (u.bpm ? `  ·  ${Math.round(u.bpm)} BPM (${sources[u.source] || 'guessed'})` : '  ·  tempo unknown') +
          (u.reasons && u.reasons.length ? '  ·  ' + u.reasons.filter(r => !/^key/.test(r)).slice(0, 3).join(', ') : '') +
          (KEY_RELATIONS[u.key?.relation] ? '  ·  ' + KEY_RELATIONS[u.key.relation](u.key) : '') +
          (s.shuffleMode === 'mix' ? '  ·  picked by Mix order' : '')));
      }
      if (s.preroll) {
        const p = s.preroll;
        rows.push(row('Next song', `${p.track.title}: ` + (p.done ? (p.grid ? `found ${p.grid.bpm.toFixed(1)} BPM` : 'no beat in its intro') : `listening silently (${(p.heard || 0).toFixed(1)} s)`) +
          (p.startAt > 0 ? `, starts at ${clock(p.startAt)}` : '')));
      }
      if (s.mix) {
        rows.push(row('Transition style', `${styleName(s.mix.style, s.mix.genre)}${s.mix.phase ? ' · ' + s.mix.phase : ''}${s.mix.reason ? ' · ' + s.mix.reason : ''}`));
        const bar = h('span.automix-bar', h('span', { style: { width: pct(s.mix.progress) } }));
        rows.push(row('Mixing', h('span', `${s.mix.from.title} → ${s.mix.to.title}  ·  ${pct(s.mix.progress)} of ${s.mix.seconds.toFixed(1)} s` +
          (s.mix.bass ? (s.mix.progress < 0.5 ? '  ·  bass swaps at 50%' : '  ·  bass swapped') : ''), bar)));
      }
      if (s.lock) {
        const ms = Math.abs(s.lock.errorMs);
        const tone = !s.lock.active ? '' : ms < 12 ? 'good' : ms < 30 ? 'warn' : 'bad';
        rows.push(row('Beat lock', s.lock.active
          ? `${ms.toFixed(0)} ms apart  ·  next song ${pct(Math.abs(s.lock.tempo), 1)} ${s.lock.tempo >= 0 ? 'faster' : 'slower'}` +
            (Math.abs(s.lock.nudge) > 0.001 ? `, nudging ${pct(s.lock.nudge, 1)}` : '')
          : 'mix done, easing back to its own tempo', tone));
      }
      if (s.outcome) rows.push(row('Verdict', s.outcome.during ? 'mixing: rate it with the thumbs in the player (skipping alone teaches nothing)'
        : `waiting to see if you keep it or rate it: ${Math.min(20, s.outcome.listened || 0).toFixed(0)} of 20 s listened`));
    }
    now.replaceChildren(...rows);
  };

  const renderLearned = () => {
    const stats = mixlearn.stats();
    const songs = mixmemory.count();
    const head = h('p.settings-row-desc', `Remembers ${songs} song${songs === 1 ? '' : 's'}  ·  learned from ${stats.transitions} mix${stats.transitions === 1 ? '' : 'es'}`);
    // genre + tempo rows first, then the any-genre tempo rows they borrow from until they have enough mixes
    const rows = [];
    for (const [id, label] of AUTOMIX_RANGES) {
      for (const family of Object.keys(mixlearn.FAMILY_LABELS)) {
        const b = stats.genres[`${family}:${id}`];
        if (b) rows.push({ b, genre: mixlearn.FAMILY_LABELS[family], label, young: b.good + b.bad < mixlearn.MIN_OUTCOMES });
      }
    }
    for (const [id, label] of AUTOMIX_RANGES) if (stats.buckets[id]) rows.push({ b: stats.buckets[id], genre: 'Any genre', label });
    const table = rows.length ? h('table.automix-table',
      h('thead', h('tr', ['Genre', 'Tempo', 'Mix length', 'DJ blend', 'Tempo stretch', 'Good', 'Bad', 'Drop cuts good / bad'].map(t => h('th', t)))),
      h('tbody', rows.map(({ b, genre, label, young }) =>
        h('tr', h('td', young ? { title: `Still borrowing from the Any genre values until it has ${mixlearn.MIN_OUTCOMES} mixes` } : null, genre + (young ? ' (new)' : '')),
          h('td', label), h('td', pct(b.length)), h('td', pct(b.dj)), h('td', 'up to ' + pct(b.stretch, 1)), h('td', String(b.good)), h('td', String(b.bad)),
          h('td', `${b.styles?.dropcut?.good || 0} / ${b.styles?.dropcut?.bad || 0}`))))
    ) : h('p.muted.small', 'Nothing yet. Every mix you keep or rate shows up here. It starts at 100% length, full DJ blend and up to 8% stretch, and moves slowly.');
    learned.replaceChildren(head, table);
  };

  const renderFeed = () => {
    const key = player.mixLog.length + ':' + (player.mixLog[0] ? player.mixLog[0].at : 0);
    if (key === feedKey) return;
    feedKey = key;
    feed.replaceChildren(...(player.mixLog.length ? player.mixLog.map(e =>
      h('li.automix-event.' + e.kind, h('time', new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })), h('span', e.text)))
      : [h('li.muted.small', 'Activity shows up here as songs play and mix.')]));
  };

  const render = () => { renderNow(); renderLearned(); renderFeed(); };
  render();
  const timer = setInterval(render, 500);
  cleanups.push(() => clearInterval(timer));

  return h('div',
    card('Auto mix', 'DJ-style transitions that learn from every song and every rating. Updates live while you listen.',
      toggleRow('Auto mix', 'Beat-matched mixes between songs. Also in Playback → Crossfade.', settings.autoMix === true, (on) => saveSettings({ autoMix: on })),
      selectRow('Transition style', 'Smooth blend mixes over the end of each song. Drop cut skips to the next song’s drop. Auto picks what suits the music: a quick cut for hip-hop, a double drop for drum and bass or dubstep, a slow filter fade for deep house and ambient, and a drop cut for energetic electronic pairs with a clear drop.',
        [{ id: 'blend', label: 'Smooth blend (default)' }, { id: 'auto', label: 'Auto' }, { id: 'dropcut', label: 'Drop cut' }],
        settings.transitionStyle || 'blend', value => saveSettings({ transitionStyle: value, transitionStyleChosen: true })),
      now),
    card('What it has learned', 'Slowly, per genre and tempo range: what it tries next starts from these. A genre starts from the any-genre values for its tempo.', learned, autoMixLearning()),
    card('Activity', null, feed)
  );
}

async function playbackTab(cleanups) {
  await offline.init();
  const downloadsSummary = h('p.muted');
  const removeDownloads = button('Remove all downloads', removeAllDownloads, 'btn-outline');
  const refreshDownloads = () => {
    const count = offline.tracks().length;
    downloadsSummary.textContent = `${count} ${count === 1 ? 'track' : 'tracks'} · ${formatBytes(offline.totalBytes)}`;
    removeDownloads.disabled = !count;
  };
  refreshDownloads();
  cleanups.push(offline.on('change', refreshDownloads));
  const pct = () => Math.round(settings.volume * 100);
  const volume = rangeControl({ min: 0, max: 100, value: pct(), unit: '%', label: 'Default volume' }, (v) => player.setVolume(v / 100));

  // keep the control honest if volume changes from the player bar or keyboard
  cleanups.push(store.on('settings', () => volume.setValue(pct())));

  const onNotifications = async (on, input) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        input.checked = false;
        saveSettings({ notifications: false });
        toast('Notifications are blocked for Quantm in system settings', 'error');
        return;
      }
    }
    saveSettings({ notifications: on });
  };

  return h('div',
    card('Playback', null,
      toggleRow('Autoplay related tracks', 'Keep the music going with similar tracks when the queue ends.', settings.autoplayRelated,
        (on) => saveSettings({ autoplayRelated: on })),
      toggleRow('Desktop notifications', 'Show a notification when a new track starts playing.', settings.notifications, onNotifications),
      toggleRow('Discord status', 'Show "Listening to Quantm" with the current song on your Discord profile. Needs the Discord desktop app.', settings.discordStatus !== false,
        (on) => saveSettings({ discordStatus: on })),
      toggleRow('Discord status while not playing', 'Keep "Playing Quantm" on your profile while Quantm is open: Browsing, or Paused with the song.', settings.discordIdle !== false,
        (on) => saveSettings({ discordIdle: on })),
      toggleRow('Resume where you left off', 'Reopen the last song, queue and position (paused) when Quantm starts.', settings.resumeSession !== false,
        (on) => saveSettings({ resumeSession: on })),
      toggleRow('Normalize volume', 'Even out loud and quiet tracks so every song plays at a similar level.', settings.normalize !== false,
        (on) => player.setNormalize(on))
    ),
    card('Downloads', null, downloadsSummary,
      h('div.settings-actions', button('Open downloads folder', () => offline.openFolder(), 'btn-outline'), removeDownloads),
      h('p.muted.small', "Only tracks whose artist allows downloads can be downloaded. Files are kept in the artist's original format.")
    ),
    equalizerCard(cleanups),
    speedCard(cleanups),
    card('Crossfade', 'Blend the end of each song into the start of the next. Skipping always cuts cleanly.',
      sliderRow('Crossfade', '0 turns it off. Songs shorter than twice this length play normally.',
        { min: 0, max: 12, step: 0.5, value: Math.min(12, Math.max(0, Number(settings.crossfade) || 0)), unit: 's' },
        (v) => saveSettings({ crossfade: v })),
      toggleRow('Auto mix', 'Mix songs into each other like a DJ: the beats line up, the tempo follows and the bass swaps halfway. Picks its own length; songs without a clear beat get a normal blend.',
        settings.autoMix === true, (on) => saveSettings({ autoMix: on })),
      autoMixLearning(),
      h('p.muted.small', 'Custom transitions: press I and O while a song plays to set where it mixes in and out, or edit a transition from the queue. They work even with crossfade off, and Auto mix beat-matches them too.')
    ),
    visualizerCard(),
    card('Volume', 'The level Quantm plays at. You can also change it from the player bar.',
      h('div.settings-radius',
        h('div.settings-row-text', h('span.settings-row-title', 'Default volume'), h('span.settings-row-desc', 'Applies right now and next time you open the app')),
        volume
      )
    )
  );
}

function equalizerCard(cleanups) {
  const current = () => normalizeEqualizer(settings.eq);
  const save = (patch) => saveSettings({ eq: { ...current(), ...patch } });
  const toggle = toggleRow('Enable equalizer', 'Applies to both decks, including crossfades.', current().enabled,
    enabled => save({ enabled }));
  const preset = h('select.input.settings-select', { 'aria-label': 'Equalizer preset', onchange: () => {
    if (preset.value !== 'Custom') save(presetFor(preset.value));
    else save({ preset: 'Custom' });
  } }, [...Object.keys(EQ_PRESETS), 'Custom'].map(name => h('option', { value: name }, name)));
  const bands = ['60 Hz', '230 Hz', '910 Hz', '3.6 kHz', '14 kHz'].map((label, i) => {
    const control = rangeControl({ min: -12, max: 12, step: 0.5, value: current().gains[i], unit: 'dB', label }, value => {
      const gains = current().gains.slice();
      gains[i] = value;
      save({ gains, preset: 'Custom' });
    });
    return h('div.eq-band', h('span.settings-row-title', label), control);
  });
  const preamp = sliderRow('Preamp', 'Reduce this if boosts sound too compressed.',
    { min: -12, max: 12, step: 0.5, value: current().preamp, unit: 'dB' }, preamp => save({ preamp, preset: 'Custom' }));
  const sync = () => {
    const eq = current();
    toggle.querySelector('input').checked = eq.enabled;
    preset.value = eq.preset;
    bands.forEach((band, i) => band.querySelector('.settings-range-wrap').setValue(eq.gains[i]));
    preamp.setValue(eq.preamp);
  };
  cleanups.push(store.on('settings', sync));
  sync();
  const section = card('Equalizer', 'Shape your sound with five bands and a preamp. Each control ranges from -12 to +12 dB.',
    toggle, h('div.settings-row', h('span.settings-row-title', 'Preset'), preset),
    h('div.eq-bands', bands), preamp,
    h('div.settings-actions', button('Reset', () => save(presetFor('Flat')), 'btn-outline')));
  section.id = 'equalizer';
  section.tabIndex = -1;
  return section;
}

const SPEED_MODES = [
  { id: 'normal', label: 'Normal' },
  { id: 'nightcore', label: 'Nightcore' },
  { id: 'slowed', label: 'Slowed' },
  { id: 'custom', label: 'Custom' }
];

/** Playback speed: presets that change pitch with speed, or your own speed (pitch optional) */
function speedCard(cleanups) {
  const mode = () => (SPEED_MODES.some(m => m.id === settings.speedMode) ? settings.speedMode : 'normal');
  const customSpeed = () => Math.min(2, Math.max(0.5, Number(settings.playbackSpeed) || 1));

  const modeRow = chipRow('Mode', 'Nightcore plays at 1.25× with a higher pitch, Slowed at 0.8× with a lower pitch', SPEED_MODES, mode(), (v) => player.setSpeedMode(v));
  const speed = sliderRow('Speed', 'Custom mode only', { min: 0.5, max: 2, step: 0.05, value: customSpeed(), unit: '×' },
    (v) => saveSettings({ playbackSpeed: v }));
  const pitch = toggleRow('Keep original pitch', 'Custom mode only. Off makes faster songs higher and slower songs lower.', settings.keepPitch !== false,
    (on) => saveSettings({ keepPitch: on }));

  // stay in step with changes made from the player bar or the keyboard
  const sync = () => {
    const current = mode();
    modeRow.querySelectorAll('.chip').forEach((chip, i) => chip.classList.toggle('active', SPEED_MODES[i].id === current));
    speed.setValue(customSpeed());
    pitch.querySelector('input').checked = settings.keepPitch !== false;
    for (const row of [speed, pitch]) {
      row.classList.toggle('disabled', current !== 'custom');
      row.querySelectorAll('input').forEach((input) => { input.disabled = current !== 'custom'; });
    }
  };
  sync();
  cleanups.push(store.on('settings', sync));

  return card('Speed', "Play songs faster or slower. Time and progress still show the song's own length.", modeRow, speed, pitch);
}

/** The player bar visualizer: every option applies live and is saved immediately */
function visualizerCard() {
  const set = (patch) => saveSettings(patch);
  const d = VISUALIZER_DEFAULTS;
  const val = (key) => (settings[key] === undefined ? d[key] : settings[key]);
  const limit = (key) => ({ min: VISUALIZER_LIMITS[key][0], max: VISUALIZER_LIMITS[key][1] });

  const picker = (key, label) => {
    const input = h('input.settings-color', { type: 'color', value: val(key), title: label, 'aria-label': label,
      oninput: () => set({ [key]: input.value }) });
    return h('label.settings-viz-color', input, h('span.muted.small', label));
  };
  const colorsRow = h('div.settings-row.settings-viz-colors' + (val('visualizerColor') === 'custom' ? '' : '.hidden'),
    h('span.settings-row-text', h('span.settings-row-title', 'Custom colors'), h('span.settings-row-desc', 'A gradient from the bottom to the top of the visualizer')),
    h('div.settings-viz-pickers', picker('visualizerColorA', 'Bottom'), picker('visualizerColorB', 'Top'))
  );

  const el = card('Visualizer', 'A small animated spectrum in the player bar. Every change applies right away.',
    toggleRow('Show visualizer', 'Animate the player bar along with the music.', settings.visualizer !== false,
      (on) => set({ visualizer: on })),
    chipRow('Style', 'How the visualizer is drawn', VISUALIZER_STYLES, val('visualizerStyle'), (v) => set({ visualizerStyle: v })),
    chipRow('Color', 'Theme colors, your accent, a moving rainbow, or your own pair', VISUALIZER_COLORS, val('visualizerColor'), (v) => {
      colorsRow.classList.toggle('hidden', v !== 'custom');
      set({ visualizerColor: v });
    }),
    colorsRow,
    sliderRow('Bars', 'How many columns (bars, mirrored, dots and circle)', { ...limit('bars'), value: val('visualizerBars') }, (v) => set({ visualizerBars: v })),
    sliderRow('Width', null, { ...limit('width'), step: 2, value: val('visualizerWidth'), unit: 'px' }, (v) => set({ visualizerWidth: v })),
    sliderRow('Height', 'The player bar is 76px tall', { ...limit('height'), value: val('visualizerHeight'), unit: 'px' }, (v) => set({ visualizerHeight: v })),
    sliderRow('Sensitivity', 'How strongly it reacts to the music', { min: 50, max: 250, step: 5, value: Math.round(val('visualizerSensitivity') * 100), unit: '%' }, (v) => set({ visualizerSensitivity: v / 100 })),
    sliderRow('Smoothness', 'Higher is slower and smoother, lower is snappier', { min: 0, max: 95, step: 1, value: Math.round(val('visualizerSmoothing') * 100), unit: '%' }, (v) => set({ visualizerSmoothing: v / 100 })),
    toggleRow('Falling peaks', "Small caps that hold at each bar's high point, then drop (bars, mirrored, dots).", !!val('visualizerPeaks'), (on) => set({ visualizerPeaks: on })),
    toggleRow('Glow', 'A soft glow around the visualizer.', !!val('visualizerGlow'), (on) => set({ visualizerGlow: on })),
    chipRow('Position', 'Where it sits in the player bar', VISUALIZER_POSITIONS, val('visualizerPosition'), (v) => set({ visualizerPosition: v })),
    h('div.settings-actions',
      button('Reset visualizer', () => {
        saveSettings(Object.assign({}, VISUALIZER_DEFAULTS));
        el.replaceWith(visualizerCard());
        toast('Visualizer reset to default');
      }, 'btn-outline', 'history')
    )
  );
  return el;
}

// ---------------------------------------------------------------------------
// Account tab
// ---------------------------------------------------------------------------

async function accountTab() {
  const me = store.me;
  const plan = me && me.consumer_subscription && me.consumer_subscription.product && me.consumer_subscription.product.name;

  const signOut = async () => {
    if (!await confirmDialog('Sign out?', 'You will need to sign in with SoundCloud again to use Quantm.', 'Sign out', true)) return;
    player.pause();
    await window.native.auth.logout();
    location.hash = '';
    location.reload();
  };

  const resignIn = async () => {
    try {
      const ok = await window.native.auth.login();
      if (ok) location.reload();
    } catch (e) {
      toast("Couldn't sign in. Please try again.", 'error');
    }
  };

  return h('div',
    card('Account', null,
      me ? h('div.settings-account',
        avatar(me, 72),
        h('div.settings-account-info',
          h('div.settings-account-name', me.username),
          me.full_name && me.full_name !== me.username ? h('div.muted', me.full_name) : null,
          h('div.settings-account-meta',
            plan ? h('span.tag-pill', plan) : null,
            h('a.link', { href: '#/user/' + me.id }, 'View profile')
          )
        )
      ) : h('p.muted', 'You are not signed in.'),
      h('div.settings-actions',
        button('Sign out', signOut, 'btn-outline', 'logout'),
        button('Re-sign in', resignIn, 'btn-ghost', 'user')
      )
    ),
    card('Your login', null,
      h('div.settings-note', icon('lock', 20),
        h('p', 'Your SoundCloud token is stored encrypted on this computer only. It is never sent anywhere except to SoundCloud when you use the app. Signing out removes it.')
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Shortcuts tab
// ---------------------------------------------------------------------------

const SHORTCUTS = [
  { title: 'Playback', items: [
    ['Play / pause', [['Space']]],
    ['Next track', [['Ctrl', '→']]],
    ['Previous track', [['Ctrl', '←']]],
    ['Seek forward 10 seconds', [['→']]],
    ['Seek back 10 seconds', [['←']]],
    ['Volume up', [['Ctrl', '↑']]],
    ['Volume down', [['Ctrl', '↓']]],
    ['Mute / unmute', [['M']]],
    ['Like current track', [['L']]],
    ['Toggle shuffle', [['S']]],
    ['Cycle repeat mode', [['R']]],
    ['Add cue point', [['C']]],
    ['Jump to cue point', [['1–9']]],
    ['Set mix-in', [['I']]],
    ['Set mix-out', [['O']]],
    ['Playback faster', [['Shift', '>']], 'by 0.05×'],
    ['Playback slower', [['Shift', '<']], 'by 0.05×']
  ] },
  { title: 'Navigation', items: [
    ['Search', [['Ctrl', 'F'], ['Ctrl', 'K']]],
    ['Go back', [['Alt', '←']], 'or the mouse back button'],
    ['Go forward', [['Alt', '→']], 'or the mouse forward button']
  ] }
];

async function shortcutsTab() {
  const keys = (combos) => h('span.settings-keys', combos.map((combo, i) => [
    i ? h('span.settings-keys-or', 'or') : null,
    h('span.settings-combo', combo.map((k, j) => [j ? h('span.settings-plus', '+') : null, h('kbd', k)]))
  ]));

  return h('div',
    SHORTCUTS.map(group => card(group.title, null,
      h('div.settings-shortcuts', group.items.map(([label, combos, extra]) =>
        h('div.settings-shortcut',
          h('span.settings-shortcut-label', label, extra ? h('span.muted.small', ' · ' + extra) : null),
          keys(combos)
        )
      ))
    )),
    h('p.muted.small.settings-foot', 'Shortcuts are paused while you are typing in a text field.')
  );
}

// ---------------------------------------------------------------------------
// About tab
// ---------------------------------------------------------------------------

async function aboutTab(cleanups) {
  let version = '';
  try {
    const info = await window.native.info();
    version = info && info.version ? 'Version ' + info.version : '';
  } catch (e) { /* version is optional */ }

  return h('div',
    card('About', null,
      h('div.settings-about',
        h('div.settings-about-logo', icon('cloud', 44)),
        h('div',
          h('div.settings-about-name', 'Quantm'),
          h('div.muted', version || 'A desktop app for SoundCloud')
        )
      ),
      h('p.settings-about-text', 'Quantm is free, open source (GPL-3.0) and has no ads. A successor to Soundnode.'),
      h('div.settings-actions',
        button('Support Quantm', () => window.native.openExternal('https://ko-fi.com/quantmapp'), 'btn-primary', 'heart'),
        button('View on GitHub', () => window.native.openExternal('https://github.com/quantm-app/Quantm'), 'btn-outline', 'external'),
        button('Open crash logs', () => window.native.openCrashLogs(), 'btn-outline')
      ),
      h('p.muted.small.settings-foot', 'Quantm is free and always will be. Tips on Ko-fi help pay for code signing and new features.'),
      h('p.muted.small.settings-foot', 'Crash logs stay on this computer. If Quantm crashes, you can attach crash.log to a GitHub issue.')
    ),
    updatesCard(cleanups),
    card('Credits', null,
      h('ul.settings-credits',
        h('li', 'Original Soundnode by Michael Lancaster and contributors.'),
        h('li', 'Audio streaming powered by hls.js.')
      ),
      h('p.muted.small.settings-foot', 'Not affiliated with SoundCloud.')
    )
  );
}

function updatesCard(cleanups) {
  const current = h('p.muted.small');
  const status = h('p.update-status', { role: 'status' }, 'Reading update status…');
  const progress = h('progress.update-progress', { max: 100, value: 0, 'aria-label': 'Update download progress', hidden: true });
  const check = button('Check for updates', () => run('check'), 'btn-outline');
  const restart = button('Restart to update', () => run('install'), 'btn-primary');
  const download = button('Download', () => run('download'), 'btn-primary');
  const actions = h('div.settings-actions', check, restart, download);
  const automatic = toggleRow('Download updates automatically', 'Install downloaded updates when you close Quantm.', true,
    on => run('setAuto', on));
  const checkbox = automatic.querySelector('input');
  const notice = h('p.muted.small.settings-foot', "This version of Quantm can't update itself. Download the new version from GitHub.");
  const notes = h('div.update-notes');
  const details = h('details.update-details', h('summary', "What's new"), notes);
  let state = null;
  let busy = false;
  const sync = (next) => {
    state = next;
    const off = state.mode === 'off';
    current.hidden = off;
    current.textContent = state.current ? 'Current version: ' + state.current : '';
    status.textContent = updateStatusText(state);
    status.classList.toggle('muted', off);
    progress.hidden = off || state.status !== 'downloading';
    progress.value = Math.max(0, Math.min(100, state.percent || 0));
    actions.hidden = off;
    check.disabled = busy || state.status === 'checking' || state.status === 'downloading';
    restart.hidden = state.status !== 'ready';
    restart.disabled = busy;
    download.hidden = state.status !== 'available' || !(state.mode === 'notify' || (state.mode === 'auto' && !state.auto));
    download.disabled = busy;
    automatic.hidden = state.mode !== 'auto';
    checkbox.checked = !!state.auto;
    checkbox.disabled = busy;
    notice.hidden = state.mode !== 'notify';
    details.hidden = off || !state.notes;
    notes.textContent = state.notes || '';
  };
  async function run(action, value) {
    busy = true;
    if (state) sync(state);
    await performUpdate(action, value);
    busy = false;
    if (state) sync(state);
  }
  const section = card('Updates', null, current, status, progress, actions, automatic, notice, details);
  section.classList.add('settings-updates');
  actions.hidden = automatic.hidden = notice.hidden = details.hidden = true;
  cleanups.push(subscribeUpdates(sync));
  return section;
}
