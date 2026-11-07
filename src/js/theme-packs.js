// Pack ids are style ids, so custom presets can reuse a pack. A pack's `base` names the makeover
// stylesheet it builds on: html[data-base-style] is set to it while the pack is active.
export const PACKS = {
  'pocket': { layout: 'device', load: () => import('./packs/pocket.js') },
  'tmux': { layout: 'panes', base: 'terminal', load: () => import('./packs/tmux.js') },
  'listening-room': { layout: 'stage', load: () => import('./packs/listening-room.js') },
  'warehouse': { layout: 'warehouse', load: () => import('./packs/warehouse.js') },
  'patchbay': { layout: 'patchbay', load: () => import('./packs/patchbay.js') },
  'sampler': { layout: 'sampler', load: () => import('./packs/sampler.js') },
  'signal-route': { layout: 'signal-route', load: () => import('./packs/signal-route.js') },
  'holo-card': { load: () => import('./packs/holo-card.js') },
  'cassette': { load: () => import('./packs/cassette.js') },
  'twin-deck': { layout: 'twin-deck', load: () => import('./packs/twin-deck.js') },
  'producer': { layout: 'producer', load: () => import('./packs/producer.js') },
  'spectral-ledger': { load: () => import('./packs/spectral-ledger.js') },
  'contour': { load: () => import('./packs/contour.js') },
  'sunrise': { load: () => import('./packs/sunrise.js') },
  ...((typeof window !== 'undefined' && window.QUANTM_LOCAL_THEMES?.packs) || {})
};

export const packFor = styleId => Object.hasOwn(PACKS, styleId) ? PACKS[styleId] : null;
export const listPacks = () => Object.keys(PACKS);
