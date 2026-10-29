// Theme engine: every color in the UI comes from these CSS variables.
import { safeParse } from './store.js';

const THEME_KEY = 'quantm.theme';

/** Editable color slots, in the order the theme editor shows them */
export const THEME_FIELDS = [
  { key: 'accent', label: 'Accent', hint: 'Buttons, progress, highlights' },
  { key: 'accentText', label: 'Text on accent', hint: 'Labels on accent-colored buttons' },
  { key: 'bg', label: 'Background', hint: 'Main window background' },
  { key: 'surface', label: 'Surface', hint: 'Cards, menus, dialogs' },
  { key: 'bar', label: 'Top & player bars', hint: 'Navigation bar and player bar' },
  { key: 'text', label: 'Text', hint: 'Titles and body text' },
  { key: 'muted', label: 'Secondary text', hint: 'Artists, counts, timestamps' },
  { key: 'wave', label: 'Waveform', hint: 'Unplayed part of waveforms' },
  { key: 'wavePlayed', label: 'Waveform (played)', hint: 'Played part of waveforms' }
];

export const PRESETS = {
  'SoundCloud Dark': {
    accent: '#ff5500', accentText: '#ffffff', bg: '#121212', surface: '#1e1e1e', bar: '#181818',
    text: '#f2f2f2', muted: '#a0a0a0', wave: '#5c5c5c', wavePlayed: '#ff5500'
  },
  'SoundCloud Light': {
    accent: '#ff5500', accentText: '#ffffff', bg: '#f6f6f6', surface: '#ffffff', bar: '#ffffff',
    text: '#1a1a1a', muted: '#6b6b6b', wave: '#c4c4c4', wavePlayed: '#ff5500'
  },
  'Midnight': {
    accent: '#5b8cff', accentText: '#ffffff', bg: '#0d1117', surface: '#161b22', bar: '#10151c',
    text: '#e6edf3', muted: '#8b949e', wave: '#30363d', wavePlayed: '#5b8cff'
  },
  'Synthwave': {
    accent: '#ff2e97', accentText: '#ffffff', bg: '#140b24', surface: '#1f1235', bar: '#190e2d',
    text: '#f7e9ff', muted: '#a991c7', wave: '#3b2a5a', wavePlayed: '#2ee6ff'
  },
  'Forest': {
    accent: '#3ddc84', accentText: '#06210f', bg: '#0f1712', surface: '#17221b', bar: '#121c16',
    text: '#e4f1e8', muted: '#8aa594', wave: '#2c3d32', wavePlayed: '#3ddc84'
  },
  // official palettes (nordtheme.com, catppuccin.com) so Quantm matches the rest of the desktop
  'Nord': {
    accent: '#88c0d0', accentText: '#2e3440', bg: '#2e3440', surface: '#3b4252', bar: '#292e39',
    text: '#eceff4', muted: '#a3adbf', wave: '#616e88', wavePlayed: '#88c0d0'
  },
  'Nord Light': {
    accent: '#5e81ac', accentText: '#ffffff', bg: '#eceff4', surface: '#ffffff', bar: '#e5e9f0',
    text: '#2e3440', muted: '#4c566a', wave: '#aeb8c9', wavePlayed: '#5e81ac'
  },
  'Catppuccin Latte': {
    accent: '#8839ef', accentText: '#eff1f5', bg: '#eff1f5', surface: '#e6e9ef', bar: '#dce0e8',
    text: '#4c4f69', muted: '#6c6f85', wave: '#9ca0b0', wavePlayed: '#8839ef'
  },
  'Catppuccin Frappé': {
    accent: '#ca9ee6', accentText: '#232634', bg: '#303446', surface: '#414559', bar: '#292c3c',
    text: '#c6d0f5', muted: '#a5adce', wave: '#626880', wavePlayed: '#ca9ee6'
  },
  'Catppuccin Macchiato': {
    accent: '#c6a0f6', accentText: '#181926', bg: '#24273a', surface: '#363a4f', bar: '#1e2030',
    text: '#cad3f5', muted: '#a5adcb', wave: '#5b6078', wavePlayed: '#c6a0f6'
  },
  'Catppuccin Mocha': {
    accent: '#cba6f7', accentText: '#11111b', bg: '#1e1e2e', surface: '#313244', bar: '#181825',
    text: '#cdd6f4', muted: '#a6adc8', wave: '#585b70', wavePlayed: '#cba6f7'
  },
  'Y2K': {
    accent: '#2f6fe0', accentText: '#ffffff', bg: '#ece9d8', surface: '#ffffff', bar: '#245edb',
    text: '#000000', muted: '#4d4d4d', wave: '#a9c3ef', wavePlayed: '#2f6fe0'
  },
  'Glass': {
    accent: '#7c9cff', accentText: '#0b0f1e', bg: '#0b1020', surface: '#18203a', bar: '#121a30',
    text: '#eef2ff', muted: '#9aa6c8', wave: '#2e3a63', wavePlayed: '#7c9cff'
  },
  'Neon': {
    accent: '#00f0ff', accentText: '#001014', bg: '#07020f', surface: '#120821', bar: '#0c0418',
    text: '#f5e9ff', muted: '#9a7fbf', wave: '#2a1745', wavePlayed: '#ff2bd6'
  },
  'Pixel': {
    accent: '#ffcc00', accentText: '#1a1200', bg: '#1d1b2e', surface: '#2b2840', bar: '#151325',
    text: '#f4f1de', muted: '#a8a3c7', wave: '#3d3957', wavePlayed: '#ffcc00'
  },
  'Minimal': {
    accent: '#111111', accentText: '#ffffff', bg: '#ffffff', surface: '#f7f7f7', bar: '#ffffff',
    text: '#111111', muted: '#8a8a8a', wave: '#e2e2e2', wavePlayed: '#111111'
  },
  'Liquid Glass': {
    accent: '#0a84ff', accentText: '#ffffff', bg: '#e9eef6', surface: '#ffffff', bar: '#ffffff',
    text: '#0b0b0f', muted: '#5d6472', wave: '#c3cad6', wavePlayed: '#0a84ff'
  },
  'Liquid Glass Dark': {
    accent: '#0a84ff', accentText: '#ffffff', bg: '#0a0a0f', surface: '#1c1c22', bar: '#16161c',
    text: '#f5f5f7', muted: '#9a9aa5', wave: '#3a3a44', wavePlayed: '#0a84ff'
  },
  'Hextech': {
    accent: '#c8aa6e', accentText: '#010a13', bg: '#010a13', surface: '#0a1428', bar: '#091428',
    text: '#f0e6d2', muted: '#a09b8c', wave: '#1e2328', wavePlayed: '#0ac8b9'
  },
  'OLED': {
    accent: '#3d9bff', accentText: '#000000', bg: '#000000', surface: '#0a0a0a', bar: '#000000',
    text: '#f5f5f5', muted: '#8a8a8a', wave: '#262626', wavePlayed: '#3d9bff'
  },
  'E-ink': {
    accent: '#111111', accentText: '#f4f1ea', bg: '#f4f1ea', surface: '#ece8df', bar: '#f4f1ea',
    text: '#111111', muted: '#5a5a5a', wave: '#c9c4b8', wavePlayed: '#111111'
  },
  'Industrial': {
    accent: '#f2b705', accentText: '#111111', bg: '#1c1d1f', surface: '#2a2b2e', bar: '#222326',
    text: '#e6e6e3', muted: '#9a9b95', wave: '#3a3b3e', wavePlayed: '#f2b705'
  },
  'Frutiger Aero': {
    accent: '#08638b', accentText: '#ffffff', bg: '#e5f4fb', surface: '#f8fcff', bar: '#d9edf8',
    text: '#143348', muted: '#466173', wave: '#668b9e', wavePlayed: '#32732c'
  },
  'Terminal': {
    accent: '#75f59b', accentText: '#031008', bg: '#030906', surface: '#0a170e', bar: '#061009',
    text: '#c2ffd0', muted: '#8dc59b', wave: '#39774a', wavePlayed: '#75f59b'
  },
  'Windows 98': {
    accent: '#000080', accentText: '#ffffff', bg: '#c0c0c0', surface: '#dfdfdf', bar: '#c0c0c0',
    text: '#000000', muted: '#404040', wave: '#808080', wavePlayed: '#000080'
  },
  'Vinyl': {
    accent: '#f1ba7d', accentText: '#25160f', bg: '#1c1410', surface: '#30241c', bar: '#241b15',
    text: '#fff1da', muted: '#cbb59b', wave: '#806b57', wavePlayed: '#f1ba7d'
  },
  'Brutalist': {
    accent: '#b51d12', accentText: '#ffffff', bg: '#ffffff', surface: '#ffffff', bar: '#ffffff',
    text: '#000000', muted: '#4b4b4b', wave: '#777777', wavePlayed: '#b51d12'
  },
  'Pocket Quantm': {
    accent: '#405634', accentText: '#f5f5e9', bg: '#e5e0d5', surface: '#f5f3ea', bar: '#eae7de',
    text: '#292d27', muted: '#565c50', wave: '#949b89', wavePlayed: '#405634'
  },
  'Terminal Multiplexer': {
    accent: '#85efa1', accentText: '#061009', bg: '#060c08', surface: '#101e14', bar: '#0b150e',
    text: '#d4f7dc', muted: '#a1bda7', wave: '#497855', wavePlayed: '#efc478'
  },
  'Tokyo Night': {
    accent: '#7aa2f7', accentText: '#1a1b26', bg: '#1a1b26', surface: '#1f2233', bar: '#1c1e2d',
    text: '#c0caf5', muted: '#9aa5ce', wave: '#3b4261', wavePlayed: '#bb9af7'
  },
  'Tokyo Night Storm': {
    accent: '#7aa2f7', accentText: '#1f2335', bg: '#24283b', surface: '#2a2f45', bar: '#272b3e',
    text: '#c0caf5', muted: '#9aa5ce', wave: '#414868', wavePlayed: '#bb9af7'
  },
  'Tokyo Night Day': {
    accent: '#2a70d6', accentText: '#ffffff', bg: '#e1e2e7', surface: '#eff0f5', bar: '#e8e9ee',
    text: '#2a3a6b', muted: '#4c5a8a', wave: '#a8aecb', wavePlayed: '#9854f1'
  },
  'Rosé Pine': {
    accent: '#ebbcba', accentText: '#191724', bg: '#191724', surface: '#1f1d2e', bar: '#1c1a2a',
    text: '#e0def4', muted: '#908caa', wave: '#403d52', wavePlayed: '#c4a7e7'
  },
  'Rosé Pine Moon': {
    accent: '#ea9a97', accentText: '#232136', bg: '#232136', surface: '#2a273f', bar: '#252239',
    text: '#e0def4', muted: '#9893b0', wave: '#44415a', wavePlayed: '#c4a7e7'
  },
  'Rosé Pine Dawn': {
    accent: '#286983', accentText: '#fffaf3', bg: '#faf4ed', surface: '#fffaf3', bar: '#fcf7f0',
    text: '#4f4a6e', muted: '#6e6a86', wave: '#cecacd', wavePlayed: '#907aa9'
  },
  'Gruvbox Dark': {
    accent: '#fe8019', accentText: '#282828', bg: '#282828', surface: '#3c3836', bar: '#32302f',
    text: '#ebdbb2', muted: '#bdae93', wave: '#504945', wavePlayed: '#8ec07c'
  },
  'Gruvbox Light': {
    accent: '#af3a03', accentText: '#fbf1c7', bg: '#fbf1c7', surface: '#fffbec', bar: '#fcf5d6',
    text: '#3c3836', muted: '#6b5f56', wave: '#d5c4a1', wavePlayed: '#427b58'
  },
  'Sodium Underpass': {
    accent: '#ffc078', accentText: '#17191c', bg: '#17191c', surface: '#202428', bar: '#1b1e22',
    text: '#f0ebe3', muted: '#aaa399', wave: '#3a3e44', wavePlayed: '#8fd3c4'
  },
  'Sodium Blue Hour': {
    accent: '#a7b8ff', accentText: '#151c2b', bg: '#151c2b', surface: '#1d2638', bar: '#19212f',
    text: '#eee9e1', muted: '#a3adc2', wave: '#2e3a52', wavePlayed: '#f5c3a0'
  },
  'Sodium Last Tram': {
    accent: '#f4aec8', accentText: '#241b28', bg: '#241b28', surface: '#2e2335', bar: '#291e2e',
    text: '#f3ece6', muted: '#b3a5b4', wave: '#443549', wavePlayed: '#a8d8c8'
  },
  'Tiling': {
    accent: '#7ec8a4', accentText: '#0b1410', bg: '#11141a', surface: '#1a1f27', bar: '#161a21',
    text: '#d5dbe3', muted: '#8d97a5', wave: '#3b4452', wavePlayed: '#7ec8a4'
  },
  'Tiling Light': {
    accent: '#1a6e51', accentText: '#ffffff', bg: '#e9e6df', surface: '#f4f1ea', bar: '#dedad1',
    text: '#22252b', muted: '#5d636d', wave: '#b3b0a6', wavePlayed: '#1a6e51'
  },
  'Glitch': {
    accent: '#00e5ff', accentText: '#03070a', bg: '#07070b', surface: '#101018', bar: '#0b0b12',
    text: '#e9ecf2', muted: '#98a0b2', wave: '#3a3f55', wavePlayed: '#ff2e63'
  },
  'Vapor Mall': {
    accent: '#c01c72', accentText: '#ffffff', bg: '#f3e3ff', surface: '#fff6fb', bar: '#f9d3ea',
    text: '#3b2a63', muted: '#6f5d96', wave: '#b39cdb', wavePlayed: '#066a73'
  },
  'Felt': {
    accent: '#d38b48', accentText: '#1b1209', bg: '#1c231e', surface: '#263029', bar: '#1f2822',
    text: '#ece3cf', muted: '#a9ad9b', wave: '#4a5a4d', wavePlayed: '#d38b48'
  },
  'Felt Burgundy': {
    accent: '#cf8a4c', accentText: '#1d1007', bg: '#261519', surface: '#33201f', bar: '#2a191c',
    text: '#efe2cf', muted: '#b9a198', wave: '#5a3b3f', wavePlayed: '#cf8a4c'
  },
  'Blueprint': {
    accent: '#9fe0ff', accentText: '#06214d', bg: '#0b3d91', surface: '#0d4399', bar: '#09337d',
    text: '#ffffff', muted: '#bcd3f7', wave: '#6f9be0', wavePlayed: '#ffffff'
  },
  'Ink Wash': {
    accent: '#c4382a', accentText: '#fbf6ec', bg: '#f1ebdd', surface: '#f8f4e9', bar: '#ece5d3',
    text: '#23211e', muted: '#5f5a52', wave: '#8d8677', wavePlayed: '#23211e'
  },
  'Ink Wash Night': {
    accent: '#c9a14a', accentText: '#14110c', bg: '#121110', surface: '#1a1917', bar: '#0e0d0c',
    text: '#e8e0cc', muted: '#a39a84', wave: '#4a463c', wavePlayed: '#d6b45f'
  },
  'LED Board': {
    accent: '#ffb000', accentText: '#000000', bg: '#000000', surface: '#0c0903', bar: '#070502',
    text: '#ffc94d', muted: '#b8862b', wave: '#6b4a0a', wavePlayed: '#ffb000'
  },
  'LED Board Green': {
    accent: '#33ff66', accentText: '#000000', bg: '#000000', surface: '#020c04', bar: '#010802',
    text: '#8dffa8', muted: '#3fb862', wave: '#0f5a26', wavePlayed: '#33ff66'
  },
  'LED Board Red': {
    accent: '#ff3b30', accentText: '#000000', bg: '#000000', surface: '#0e0302', bar: '#090201',
    text: '#ff8a80', muted: '#c4524b', wave: '#5c1511', wavePlayed: '#ff3b30'
  },
  'Risograph': {
    accent: '#006bac', accentText: '#ffffff', bg: '#f1ead9', surface: '#f8f3e6', bar: '#ebe2cc',
    text: '#1b1630', muted: '#5a5670', wave: '#ec7fbc', wavePlayed: '#0078bf'
  },
  'Risograph Night': {
    accent: '#ff6ac0', accentText: '#1b1630', bg: '#17142b', surface: '#221e40', bar: '#1d1936',
    text: '#f1ead9', muted: '#b3add0', wave: '#7a4f9c', wavePlayed: '#ff6ac0'
  },
  'Chrome': {
    accent: '#5ee7ff', accentText: '#031418', bg: '#0c0e12', surface: '#171a20', bar: '#12151a',
    text: '#eef4f8', muted: '#9aa6b2', wave: '#3a4552', wavePlayed: '#5ee7ff'
  },
  'Rave Flyer': {
    accent: '#e6ff00', accentText: '#0a0a0a', bg: '#0a0a0a', surface: '#161616', bar: '#000000',
    text: '#f5f5ee', muted: '#b8b8aa', wave: '#4d4d40', wavePlayed: '#e6ff00'
  },
  'Sunrise': {
    accent: '#844448', accentText: '#fff8ed', bg: '#f6ead7', surface: '#fff6e8', bar: '#f6ead7',
    text: '#302b43', muted: '#62586a', wave: '#9d899c', wavePlayed: '#844448'
  },
  'Sunrise Night': {
    accent: '#efbc83', accentText: '#25203a', bg: '#141a2d', surface: '#23283e', bar: '#1b2135',
    text: '#fff0d9', muted: '#bcb2ca', wave: '#62637b', wavePlayed: '#efbc83'
  },
  'Contour': {
    accent: '#9be1c2', accentText: '#0b2926', bg: '#0c252b', surface: '#19343d', bar: '#102b32',
    text: '#e3f5ed', muted: '#a7c5bf', wave: '#507b7d', wavePlayed: '#9be1c2'
  },
  'Spectral Ledger': {
    accent: '#e4af64', accentText: '#24190b', bg: '#0c0e10', surface: '#191b1d', bar: '#121416',
    text: '#fff1d6', muted: '#bcb09b', wave: '#625b4f', wavePlayed: '#e4af64'
  },
  'Twin Deck': {
    accent: '#a9d4ef', accentText: '#101820', bg: '#111418', surface: '#20262d', bar: '#171b20',
    text: '#edf1f5', muted: '#b0bcc8', wave: '#596979', wavePlayed: '#a9d4ef'
  },
  'Cassette': {
    accent: '#f3a15e', accentText: '#2c1b0d', bg: '#303638', surface: '#3c4446', bar: '#252c2e',
    text: '#fff1d9', muted: '#d0c6b5', wave: '#89938f', wavePlayed: '#f3a15e'
  },
  'Cassette Night': {
    accent: '#ffae73', accentText: '#28190e', bg: '#11171b', surface: '#1d282e', bar: '#151e23',
    text: '#f7eddb', muted: '#b9c5c8', wave: '#677d86', wavePlayed: '#ffae73'
  },
  'Holo Card': {
    accent: '#96eff0', accentText: '#091e26', bg: '#0b101b', surface: '#141e30', bar: '#0e1625',
    text: '#f3f6ff', muted: '#b4c2da', wave: '#667994', wavePlayed: '#96eff0'
  },
  'Signal Route': {
    accent: '#8fd3d4', accentText: '#102438', bg: '#091522', surface: '#132a40', bar: '#0e2032',
    text: '#f5edd7', muted: '#b7c6cd', wave: '#728b9d', wavePlayed: '#8fd3d4'
  },
  'Sampler': {
    accent: '#b9cfb2', accentText: '#19211c', bg: '#131516', surface: '#262a2b', bar: '#1b1e20',
    text: '#f1ede2', muted: '#b5bcb8', wave: '#818c86', wavePlayed: '#b9cfb2'
  },
  'Patchbay': {
    accent: '#80dbe4', accentText: '#102326', bg: '#14181b', surface: '#272e33', bar: '#1c2227',
    text: '#f2eedf', muted: '#b7c1c5', wave: '#83949b', wavePlayed: '#80dbe4'
  },
  'Warehouse': {
    accent: '#d8ed42', accentText: '#101200', bg: '#000000', surface: '#222424', bar: '#111313',
    text: '#f5f5ef', muted: '#b6bbb5', wave: '#7f887b', wavePlayed: '#d8ed42'
  },
  // colors are replaced live from the playing song's artwork (appearance.js)
  'Album Match': {
    accent: '#ff5500', accentText: '#ffffff', bg: '#121212', surface: '#1e1e1e', bar: '#181818',
    text: '#f4f4f4', muted: '#a0a0a0', wave: '#5c5c5c', wavePlayed: '#ff5500'
  },
  'Listening Room': {
    accent: '#edbd91', accentText: '#25180f', bg: '#151210', surface: '#25201c', bar: '#1b1714',
    text: '#f6ede3', muted: '#c3b3a4', wave: '#706052', wavePlayed: '#edbd91'
  },
  'Mono': {
    accent: '#ffffff', accentText: '#000000', bg: '#000000', surface: '#111111', bar: '#0a0a0a',
    text: '#ffffff', muted: '#8a8a8a', wave: '#333333', wavePlayed: '#ffffff'
  }
};

/**
 * Some presets also change shapes, fonts and textures, not just colors.
 * The style name becomes <html data-style="..."> and styles/themes/<name>.css does the rest.
 */
export const PRESET_STYLES = {
  'Y2K': 'y2k',
  'Glass': 'glass',
  'Neon': 'neon',
  'Pixel': 'pixel',
  'Minimal': 'minimal',
  'Liquid Glass': 'liquid',
  'Liquid Glass Dark': 'liquid',
  'Hextech': 'hextech',
  'OLED': 'oled',
  'E-ink': 'eink',
  'Industrial': 'industrial',
  'Frutiger Aero': 'frutiger-aero',
  'Terminal': 'terminal',
  'Windows 98': 'win98',
  'Vinyl': 'vinyl',
  'Brutalist': 'brutalist',
  'Listening Room': 'listening-room',
  'Pocket Quantm': 'pocket',
  'Terminal Multiplexer': 'tmux',
  'Tiling': 'tiling',
  'Tiling Light': 'tiling',
  'Glitch': 'glitch',
  'Vapor Mall': 'vapor-mall',
  'Felt': 'felt',
  'Felt Burgundy': 'felt',
  'Blueprint': 'blueprint',
  'Ink Wash': 'ink-wash',
  'Ink Wash Night': 'ink-wash',
  'LED Board': 'led-board',
  'LED Board Green': 'led-board',
  'LED Board Red': 'led-board',
  'Risograph': 'risograph',
  'Risograph Night': 'risograph',
  'Chrome': 'chrome',
  'Rave Flyer': 'rave-flyer',
  'Sunrise': 'sunrise',
  'Sunrise Night': 'sunrise',
  'Contour': 'contour',
  'Spectral Ledger': 'spectral-ledger',
  'Twin Deck': 'twin-deck',
  'Cassette': 'cassette',
  'Cassette Night': 'cassette',
  'Holo Card': 'holo-card',
  'Signal Route': 'signal-route',
  'Sampler': 'sampler',
  'Patchbay': 'patchbay',
  'Warehouse': 'warehouse',
  'Album Match': 'album'
};

/** Presets that are flavors of one theme share a card in the gallery: family → { flavor: preset } */
export const PRESET_FAMILIES = {
  'SoundCloud': { 'Dark': 'SoundCloud Dark', 'Light': 'SoundCloud Light' },
  'Nord': { 'Dark': 'Nord', 'Light': 'Nord Light' },
  'Catppuccin': { 'Latte': 'Catppuccin Latte', 'Frappé': 'Catppuccin Frappé', 'Macchiato': 'Catppuccin Macchiato', 'Mocha': 'Catppuccin Mocha' },
  'Liquid Glass': { 'Light': 'Liquid Glass', 'Dark': 'Liquid Glass Dark' },
  'Tokyo Night': { 'Night': 'Tokyo Night', 'Storm': 'Tokyo Night Storm', 'Day': 'Tokyo Night Day' },
  'Rosé Pine': { 'Main': 'Rosé Pine', 'Moon': 'Rosé Pine Moon', 'Dawn': 'Rosé Pine Dawn' },
  'Gruvbox': { 'Dark': 'Gruvbox Dark', 'Light': 'Gruvbox Light' },
  'Sodium': { 'Underpass': 'Sodium Underpass', 'Blue Hour': 'Sodium Blue Hour', 'Last Tram': 'Sodium Last Tram' },
  'Tiling': { 'Dark': 'Tiling', 'Light': 'Tiling Light' },
  'Felt': { 'Moss': 'Felt', 'Burgundy': 'Felt Burgundy' },
  'Ink Wash': { 'Paper': 'Ink Wash', 'Night': 'Ink Wash Night' },
  'LED Board': { 'Amber': 'LED Board', 'Green': 'LED Board Green', 'Red': 'LED Board Red' },
  'Risograph': { 'Light': 'Risograph', 'Night': 'Risograph Night' },
  'Sunrise': { 'Dusk': 'Sunrise', 'Night': 'Sunrise Night' },
  'Cassette': { 'Original': 'Cassette', 'Night': 'Cassette Night' }
};

/** Corner roundness each style preset looks best with (others keep the user's value) */
export const PRESET_RADIUS = { 'Terminal Multiplexer': 0, 'Pocket Quantm': 14, 'Listening Room': 18, 'Y2K': 3, 'Glass': 16, 'Neon': 4, 'Pixel': 0, 'Minimal': 6, 'Liquid Glass': 22, 'Liquid Glass Dark': 22, 'Hextech': 2, 'OLED': 8, 'E-ink': 0, 'Industrial': 2, 'Album Match': 14, 'Frutiger Aero': 20, 'Terminal': 0, 'Windows 98': 0, 'Vinyl': 3, 'Brutalist': 0, 'Tokyo Night': 8, 'Tokyo Night Storm': 8, 'Tokyo Night Day': 8, 'Rosé Pine': 10, 'Rosé Pine Moon': 10, 'Rosé Pine Dawn': 10, 'Gruvbox Dark': 4, 'Gruvbox Light': 4, 'Sodium Underpass': 8, 'Sodium Blue Hour': 8, 'Sodium Last Tram': 8, 'Tiling': 0, 'Tiling Light': 0, 'Glitch': 0, 'Vapor Mall': 12, 'Felt': 18, 'Felt Burgundy': 18, 'Blueprint': 0, 'Ink Wash': 2, 'Ink Wash Night': 2, 'LED Board': 2, 'LED Board Green': 2, 'LED Board Red': 2, 'Risograph': 2, 'Risograph Night': 2, 'Chrome': 14, 'Rave Flyer': 0, 'Sunrise': 14, 'Sunrise Night': 14, 'Contour': 8, 'Spectral Ledger': 6, 'Twin Deck': 6, 'Cassette': 6, 'Cassette Night': 6, 'Holo Card': 12, 'Signal Route': 14, 'Sampler': 8, 'Patchbay': 5, 'Warehouse': 2 };

// Personal themes kept out of the repository: js/local-themes.js (git-ignored) may define
// window.QUANTM_LOCAL_THEMES = { presets, styles, radius, families } before this module runs
const local = (typeof window !== 'undefined' && window.QUANTM_LOCAL_THEMES) || {};
Object.assign(PRESETS, local.presets || {});
Object.assign(PRESET_STYLES, local.styles || {});
Object.assign(PRESET_RADIUS, local.radius || {});
Object.assign(PRESET_FAMILIES, local.families || {});
/** Presets that only exist on this computer (dev builds); the gallery lists them on their own */
export const LOCAL_PRESETS = new Set(Object.keys(local.presets || {}));

export const DEFAULT_THEME = { preset: 'SoundCloud Dark', colors: Object.assign({}, PRESETS['SoundCloud Dark']), radius: 10 };

export function getTheme() {
  const saved = safeParse(localStorage.getItem(THEME_KEY));
  const base = PRESETS[saved.preset] || DEFAULT_THEME.colors;
  const preset = saved.preset || DEFAULT_THEME.preset;
  return {
    preset,
    colors: Object.assign({}, base, saved.colors || {}),
    radius: typeof saved.radius === 'number' ? saved.radius : DEFAULT_THEME.radius,
    style: typeof saved.style === 'string' ? saved.style : (PRESET_STYLES[preset] || '')
  };
}

export function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, JSON.stringify(theme));
  applyTheme(theme);
}

/** Write the theme into CSS variables on <html> and recolor the window controls */
export function applyTheme(theme = getTheme()) {
  const root = document.documentElement.style;
  const c = theme.colors;
  root.setProperty('--accent', c.accent);
  root.setProperty('--accent-text', c.accentText);
  root.setProperty('--bg', c.bg);
  root.setProperty('--surface', c.surface);
  root.setProperty('--bar', c.bar);
  root.setProperty('--text', c.text);
  root.setProperty('--muted', c.muted);
  root.setProperty('--wave', c.wave);
  root.setProperty('--wave-played', c.wavePlayed);
  root.setProperty('--radius', theme.radius + 'px');
  document.documentElement.dataset.scheme = luminance(c.bg) > 0.5 ? 'light' : 'dark';
  const style = typeof theme.style === 'string' ? theme.style : (PRESET_STYLES[theme.preset] || '');
  if (style) document.documentElement.dataset.style = style;
  else delete document.documentElement.dataset.style;

  // window buttons need to stay readable on the bar, whatever the text color is
  if (window.native) window.native.setTitleBar(c.bar, luminance(c.bar) > 0.5 ? '#000000' : '#ffffff');
  document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

/** Relative luminance 0..1 of a #rrggbb color */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function hexToRgb(hex) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value.padEnd(6, '0');
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) || 0);
}

/** Theme as a shareable JSON string */
export function exportTheme(theme = getTheme()) {
  return JSON.stringify({ name: theme.preset, colors: theme.colors, radius: theme.radius, style: theme.style || '' }, null, 2);
}

/** Parse a shared theme; throws if it isn't valid */
export function importTheme(text) {
  const data = JSON.parse(text);
  if (!data || !data.colors || typeof data.colors !== 'object') throw new Error('Not a Quantm theme');
  const colors = Object.assign({}, DEFAULT_THEME.colors);
  THEME_FIELDS.forEach(({ key }) => {
    if (/^#[0-9a-f]{6}$/i.test(data.colors[key] || '')) colors[key] = data.colors[key];
  });
  const style = Object.values(PRESET_STYLES).includes(data.style) ? data.style : '';
  return { preset: 'Custom', colors, radius: typeof data.radius === 'number' ? data.radius : DEFAULT_THEME.radius, style };
}
