import { h, clear, duration } from '../dom.js';
import { icon } from '../icons.js';
import { motionAllowed } from '../audio-reactivity.js';

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const artist = track => track?.user?.username || track?.publisher_metadata?.artist || 'Unknown artist';

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  node.append(...children);
  return node;
}

function junction() {
  const marker = svg('circle', { class: 'sr-marker', cx: 230, cy: 110, r: 9 });
  const drawing = svg('svg', { class: 'sr-junction', viewBox: '0 0 500 220', 'aria-hidden': 'true' },
    svg('path', { class: 'sr-route sr-out', d: 'M24 34 H100 Q150 34 186 80 Q210 110 230 110 H476' }),
    svg('path', { class: 'sr-route sr-in', d: 'M24 186 H100 Q150 186 186 140 Q210 110 230 110 H476' }),
    svg('path', { class: 'sr-bass sr-bass-out', d: 'M24 50 H100 Q150 50 186 96 Q210 126 230 126 H476' }),
    svg('path', { class: 'sr-bass sr-bass-in', d: 'M24 170 H100 Q150 170 186 126 Q210 126 230 126 H476' }),
    svg('circle', { class: 'sr-joint', cx: 230, cy: 110, r: 14 }), marker);
  return { drawing, marker };
}

function home(container, ctx, motion) {
  const { player } = ctx;
  const title = h('h1.sr-title');
  const by = h('p.sr-artist');
  const position = h('p.sr-position');
  const time = h('span.sr-time');
  const play = h('button.sr-play', { type: 'button', onclick: () => player.toggle() });
  const seek = h('input.sr-seek', { type: 'range', min: 0, max: 1, step: 1,
    'aria-label': 'Seek in current track', oninput: () => player.seek(Number(seek.value)),
    // arrow keys jump 5 seconds, like the other themes' seek bars
    onkeydown: e => {
      if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      player.seekBy(['ArrowLeft', 'ArrowDown'].includes(e.key) ? -5 : 5);
    } });
  const line = junction();
  const mixFrom = h('span');
  const mixTo = h('span');
  const mixLabel = h('p.sr-mix-label', { 'aria-live': 'off' });
  const mixPanel = h('section.sr-interchange', { 'aria-label': 'Auto mix junction' },
    h('h2', 'Interchange'), h('div.sr-route-labels', mixFrom, mixTo), line.drawing, mixLabel);
  const map = h('div.sr-map');
  const count = h('span.sr-count');
  const browse = h('div.sr-browse', { hidden: true });
  let browseCleanup;
  let browseStarted = false;
  let alive = true;
  const browseButton = h('button.btn', { type: 'button', 'aria-expanded': 'false', onclick: async () => {
    browse.hidden = !browse.hidden;
    browseButton.setAttribute('aria-expanded', String(!browse.hidden));
    browseButton.textContent = browse.hidden ? 'Browse music' : 'Close Browse';
    if (browse.hidden || browseStarted) return;
    browseStarted = true;
    try {
      const module = await import('../views/home.js');
      if (!alive) return;
      const cleanup = await module.render(browse);
      if (!alive) { if (typeof cleanup === 'function') cleanup(); }
      else browseCleanup = cleanup;
    } catch (error) { if (alive) { browse.textContent = 'Browse could not load. Use Search or Library to choose music.'; browseStarted = false; } }
  } }, 'Browse music');
  const node = h('div.sr-home',
    h('header.sr-header', h('div', h('p.sr-kicker', 'SIGNAL ROUTE / LISTENING NETWORK'), h('p', 'Every track is a stop.')), browseButton),
    h('div.sr-layout', h('section.sr-now', { 'aria-label': 'Current track' },
      position, title, by, h('div.sr-transport',
        h('button.btn', { type: 'button', onclick: () => player.prev(), 'aria-label': 'Previous track' }, icon('prev', 20)),
        play, h('button.btn', { type: 'button', onclick: () => player.next(), 'aria-label': 'Next track' }, icon('next', 20))),
      seek, time, mixPanel),
    h('aside.sr-queue', { 'aria-label': 'Queue route' }, h('h2', 'Track stops ', count), map)), browse);
  container.append(node);
  let rows = [];
  let lastLabel = '';
  let lastCurrent = -2;
  function queue() {
    const focused = map.contains(document.activeElement) ? document.activeElement.dataset.index : null;
    clear(map);
    rows = []; lastCurrent = -2;
    count.textContent = String(player.queue.length).padStart(2, '0');
    player.queue.forEach((track, index) => {
      const stop = h('button.sr-stop', { type: 'button', dataset: { index },
        'aria-label': `Play stop ${index + 1}: ${track.title || 'Untitled track'}`, onclick: () => player.jump(index) },
      svg('svg', { class: 'sr-stop-line', viewBox: '0 0 64 80', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        svg('path', { d: index % 4 === 2 ? 'M32 0 V12 Q32 22 42 30 Q52 40 42 50 Q32 58 32 68 V80' : 'M32 0 V80' })),
      h('span.sr-stop-number', String(index + 1).padStart(2, '0')),
      h('span.sr-stop-meta', h('strong', track.title || 'Untitled track'), h('span', artist(track))),
      h('span.sr-stop-duration', duration(track.duration) || '--:--'));
      rows.push(stop);
      map.append(stop);
    });
    if (!rows.length) map.append(h('p.sr-empty', 'No stops yet. Browse music to start a route.'));
    if (focused !== null) rows[Number(focused)]?.focus({ preventScroll: true });
  }
  function update(status) {
    const track = player.current;
    title.textContent = track?.title || 'Choose your first stop';
    by.textContent = track ? artist(track) : 'Browse music to begin your listening route.';
    position.textContent = track ? `NOW AT STOP ${String(player.index + 1).padStart(2, '0')}` : 'NETWORK READY';
    const label = player.playing ? 'Pause' : 'Play';
    if (label !== lastLabel) { clear(play).append(icon(player.playing ? 'pause' : 'play', 28), label); lastLabel = label; }
    play.disabled = !track;
    node.querySelectorAll('.sr-transport .btn').forEach(button => { button.disabled = !track; });
    const length = player.duration || 0;
    seek.max = String(length || 1);
    seek.value = String(Math.min(player.audio.currentTime || 0, length));
    seek.disabled = !length;
    seek.setAttribute('aria-valuetext', `${duration((player.audio.currentTime || 0) * 1000)} of ${duration(length * 1000)}`);
    time.textContent = `${duration((player.audio.currentTime || 0) * 1000)} / ${duration(length * 1000)}`;
    if (lastCurrent !== player.index) {
      rows[lastCurrent]?.classList.remove('current');
      rows[lastCurrent]?.removeAttribute('aria-current');
      rows[player.index]?.classList.add('current');
      rows[player.index]?.setAttribute('aria-current', 'true');
      lastCurrent = player.index;
    }
    const mix = status.mix;
    const progress = clamp(mix?.progress);
    node.dataset.mixing = String(!!mix);
    node.dataset.swap = mix ? (progress >= 0.5 ? 'after' : 'before') : 'before';
    mixFrom.textContent = `A / ${mix?.from?.title || track?.title || 'No current track'}`;
    mixTo.textContent = `B / ${mix?.to?.title || status.upNext?.track?.title || player.queue[player.index + 1]?.title || 'End of route'}`;
    mixLabel.textContent = mix ? `Mix ${Math.round(progress * 100)}% · Bass: ${progress >= 0.5 ? 'incoming route' : 'outgoing route'}` : 'Single route · Waiting for the next interchange';
    line.marker.setAttribute('cx', String(230 + (motion() ? progress : 0) * 246));
  }
  queue();
  return { queue, update, destroy() { if (!alive) return; alive = false; if (typeof browseCleanup === 'function') browseCleanup(); node.remove(); } };
}

export function mount(ctx) {
  const stages = new Set();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => document.documentElement.dataset.themeMotion !== 'off' &&
    !(reduced.matches && document.documentElement.dataset.themeMotion !== 'on') && motionAllowed(ctx.settings, reduced);
  const mini = svg('svg', { class: 'sr-mini-route', viewBox: '0 0 1000 12', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('path', { d: 'M0 6 H1000' }));
  const dot = svg('circle', { cx: 0, cy: 6, r: 4 });
  for (let i = 1; i < 8; i++) mini.append(svg('circle', { cx: i * 125, cy: 6, r: 3 }));
  mini.append(dot);
  const attach = () => { if (!mini.isConnected) document.querySelector('.playerbar')?.append(mini); };
  const sync = () => {
    const status = ctx.player.autoMixStatus();
    stages.forEach(stage => stage.update(status));
    const length = ctx.player.duration || 0;
    dot.setAttribute('cx', String(length ? clamp(ctx.player.audio.currentTime / length) * 1000 : 0));
  };
  ctx.views.override('home', async () => ({ render(container) {
    const stage = home(container, ctx, motion);
    stages.add(stage); sync();
    return () => { stages.delete(stage); stage.destroy(); };
  } }));
  ctx.on(ctx.player, 'queue', () => { stages.forEach(stage => stage.queue()); sync(); });
  ctx.on(ctx.player, 'track', sync);
  ['state', 'time', 'transition'].forEach(event => ctx.on(ctx.player, event, sync));
  ctx.on(ctx.store, 'settings', sync);
  ctx.on(reduced, 'change', sync);
  ctx.on(document, 'routerendered', attach);
  let last = -Infinity;
  ctx.frame(({ time }) => { if (time - last >= 80) { last = time; sync(); } });
  attach();
  return () => { stages.forEach(stage => stage.destroy()); stages.clear(); mini.remove(); };
}
