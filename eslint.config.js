const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'src/vendor/**', '.claude/**', 'promo/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest' },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-unreachable': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'valid-typeof': 'error'
    }
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, Hls: 'readonly' } }
  },
  {
    files: ['main.js', 'preload.js', 'human-check.js', 'updater.js', 'offline.js', 'crashlog.js', 'import-sources.js', 'window-snap.js', 'discord.js', 'eslint.config.js', '.github/scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    files: ['check-preload.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } }
  },
  {
    files: ['test/**/*.js', 'test/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node, ...globals.browser } }
  }
];
