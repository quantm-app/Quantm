import { h, clear, duration } from '../dom.js';
import { icon } from '../icons.js';
import { motionAllowed } from '../audio-reactivity.js';

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const QUEUE_ROWS = 100; // a queue of thousands only draws this many rows, around the current song
const artist = track => track?.user?.username || track?.publisher_metadata?.artist || 'Unknown artist';

function home(container, ctx) {
  const { player } = ctx;
  const title = h('h1.wh-title');
  const by = h('p.wh-artist');
  const status = h('p.wh-status', { 'aria-live': 'off' });
  const elapsed = h('span.wh-time');
  const play = h('button.wh-play', { type: 'button', onclick: () => player.toggle() });
  const ring = h('span.wh-kick-ring', { 'aria-hidden': 'true' });
  const prev = h('button.btn', { type: 'button', 'aria-label': 'Previous track', onclick: () => player.prev() }, icon('prev', 22));
  const next = h('button.btn', { type: 'button', 'aria-label': 'Next track', onclick: () => player.next() }, icon('next', 22));
  const bars = Array.from({ length: 48 }, () => h('span.wh-bar'));
  const wall = h('div.wh-wall', { 'aria-hidden': 'true' }, bars);
  const queueList = h('div.wh-queue-list');
  const browse = h('div.wh-browse', { hidden: true });
  let alive = true;
  let browseCleanup;
  let browseStarted = false;
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
  const node = h('div.wh-home',
    h('header.wh-header', h('div', h('p.wh-kicker', 'WAREHOUSE / SOUND SYSTEM'), h('p', 'THE ROOM IS YOURS.')), browseButton),
    h('section.wh-stage', { 'aria-label': 'Live audio spectrum' }, wall, h('p.wh-spectrum-label', 'LIVE SPECTRUM / 48 BANDS')),
    h('section.wh-deck', { 'aria-label': 'Current track and transport' },
      h('div.wh-play-area', ring, play), h('div.wh-track', title, by, h('div.wh-transport', prev, next, elapsed), status)),
    h('section.wh-queue', { 'aria-label': 'Queue' }, h('h2', 'NEXT ON THE FLOOR'), queueList), browse);
  container.append(node);
  let lastPlay = '';
  let rows = [];
  let first = 0; // queue index of rows[0]
  let lastCurrent = -2;
  let lastPulse = -Infinity;
  let previousPulse = 0;
  let glow = 0;
  function queue() {
    const focused = queueList.contains(document.activeElement) ? document.activeElement.dataset.index : null;
    clear(queueList); rows = []; lastCurrent = -2;
    first = Math.max(0, Math.min(player.index - 5, player.queue.length - QUEUE_ROWS));
    player.queue.slice(first, first + QUEUE_ROWS).forEach((track, offset) => {
      const index = first + offset;
      const row = h('button.wh-queue-row', { type: 'button', dataset: { index }, onclick: () => player.jump(index) },
        h('span.wh-track-number', String(index + 1).padStart(2, '0')),
        h('span.wh-track-meta', h('strong', track.title || 'Untitled track'), h('span', artist(track))),
        h('span', duration(track.duration) || '--:--'));
      rows.push(row); queueList.append(row);
    });
    const hidden = player.queue.length - first - rows.length;
    if (hidden > 0) queueList.append(h('p.wh-empty', `+ ${hidden} MORE IN THE QUEUE`));
    if (!rows.length) queueList.append(h('p.wh-empty', 'LOAD A QUEUE. BRING THE ROOM TO LIFE.'));
    if (focused !== null) rows[Number(focused) - first]?.focus({ preventScroll: true });
  }
  function update(snapshot) {
    const track = player.current;
    title.textContent = track?.title || 'OPEN THE FLOOR';
    by.textContent = track ? artist(track) : 'Browse music to start the sound system.';
    const label = player.playing ? 'Pause' : 'Play';
    if (label !== lastPlay) { clear(play).append(icon(player.playing ? 'pause' : 'play', 42), h('span', label)); lastPlay = label; }
    [prev, play, next].forEach(button => { button.disabled = !track; });
    elapsed.textContent = `${duration((player.audio.currentTime || 0) * 1000)} / ${duration((player.duration || 0) * 1000)}`;
    status.textContent = snapshot.mix ? `AUTO MIX / ${Math.round(clamp(snapshot.mix.progress) * 100)}% / ${snapshot.mix.to?.title || 'INCOMING TRACK'}` : player.playing ? 'SOUND SYSTEM ACTIVE' : 'SOUND SYSTEM IDLE';
    // the song moved out of the drawn window of a long queue: draw the window around it
    if (player.queue.length > QUEUE_ROWS && player.index >= 0 && (player.index < first || player.index >= first + QUEUE_ROWS)) queue();
    if (lastCurrent !== player.index) {
      rows[lastCurrent - first]?.removeAttribute('aria-current');
      rows[player.index - first]?.setAttribute('aria-current', 'true'); lastCurrent = player.index;
    }
  }
  // Idle profile: a gentle low skyline, so a paused wall reads as a standby display, not an empty box.
  const idle = bars.map((_, index) => 0.07 + 0.09 * (0.5 + 0.5 * Math.sin(index * 0.55)) * (1 - index / (bars.length * 1.6)));
  const levels = new Float32Array(bars.length);
  let reference = 0.4;
  let idling = false;
  function still() {
    node.classList.add('wh-still');
    glow = 0; previousPulse = 0; reference = 0.4; levels.fill(0);
    ring.style.opacity = '0.28';
    if (idling) return;
    idling = true;
    bars.forEach((bar, index) => { bar.style.setProperty('--wh-idle', idle[index].toFixed(3)); bar.style.transform = `scaleY(${idle[index].toFixed(3)})`; });
  }
  function frame(frame, spectrum, sampleRate, fftSize) {
    if (!frame.playing) { still(); return; }
    idling = false;
    node.classList.remove('wh-still');
    // Accept only a new kick onset, spaced at least 350 ms apart (< 3 Hz).
    if (frame.pulse >= 0.72 && previousPulse < 0.72 && frame.time - lastPulse >= 350) {
      glow = 1; lastPulse = frame.time;
    }
    previousPulse = frame.pulse;
    glow *= Math.exp(-Math.max(0, frame.dt) * 7);
    // The ring is an empty border element; its interior never paints or flashes.
    ring.style.opacity = String(0.28 + glow * 0.2);
    const count = bars.length;
    const raw = new Float32Array(count);
    let peak = 0;
    if (spectrum) {
      const binHz = sampleRate / fftSize;
      for (let index = 0; index < count; index++) {
        // Log-spaced bands from 40 Hz to 14 kHz; bands narrower than one FFT bin interpolate between bins.
        const low = 40 * (14000 / 40) ** (index / count) / binHz;
        const high = 40 * (14000 / 40) ** ((index + 1) / count) / binHz;
        let value;
        if (high - low < 1) {
          const at = Math.min(spectrum.length - 1, Math.max(0, (low + high) / 2 - 0.5));
          const i = Math.floor(at);
          value = spectrum[i] + (spectrum[Math.min(spectrum.length - 1, i + 1)] - spectrum[i]) * (at - i);
        } else {
          const start = Math.min(spectrum.length - 1, Math.max(0, Math.floor(low)));
          const end = Math.min(spectrum.length, Math.max(start + 1, Math.ceil(high)));
          let sum = 0;
          for (let bin = start; bin < end; bin++) sum += spectrum[bin];
          value = sum / (end - start);
        }
        // Music rolls off toward the treble: tilt the high bands up so the whole wall moves.
        raw[index] = clamp(value / 255) * (1 + 1.6 * index / count);
        peak = Math.max(peak, raw[index]);
      }
    }
    // Auto gain: follow the loudest band slowly so quiet and loud tracks both fill the panel.
    reference = Math.max(peak, reference * Math.exp(-Math.max(0, frame.dt) * 0.3), 0.25);
    bars.forEach((bar, index) => {
      const target = clamp(raw[index] / reference * 0.96) ** 0.85;
      levels[index] += (target - levels[index]) * (target > levels[index] ? 0.6 : 0.22);
      bar.style.transform = `scaleY(${(0.05 + levels[index] * 0.95).toFixed(3)})`;
    });
  }
  queue(); still();
  return { queue, update, frame, still,
    destroy() { if (!alive) return; alive = false; if (typeof browseCleanup === 'function') browseCleanup(); node.remove(); }
  };
}

export function mount(ctx) {
  const stages = new Set();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => document.documentElement.dataset.themeMotion !== 'off' &&
    !(reduced.matches && document.documentElement.dataset.themeMotion !== 'on') && motionAllowed(ctx.settings, reduced);
  const sync = () => { const status = ctx.player.autoMixStatus(); stages.forEach(stage => stage.update(status)); };
  const still = () => { if (!motion() || !ctx.player.playing) stages.forEach(stage => stage.still()); };
  ctx.views.override('home', async () => ({ render(container) {
    const stage = home(container, ctx); stages.add(stage); sync(); still();
    return () => { stages.delete(stage); stage.destroy(); };
  } }));
  ctx.on(ctx.player, 'queue', () => { stages.forEach(stage => stage.queue()); sync(); });
  ctx.on(ctx.player, 'track', sync);
  ['state', 'time', 'transition'].forEach(event => ctx.on(ctx.player, event, () => { sync(); still(); }));
  ctx.on(ctx.store, 'settings', still);
  ctx.on(reduced, 'change', still);
  ctx.on(document, 'visibilitychange', still);
  ctx.on(document, 'appvisibility', still);
  let spectrum;
  let last = -Infinity;
  ctx.frame(frame => {
    if (motion() && stages.size) {
      const analyser = ctx.player.normalizer.visual;
      if (analyser && frame.playing) {
        if (!spectrum || spectrum.length !== analyser.frequencyBinCount) spectrum = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(spectrum);
      }
      stages.forEach(stage => stage.frame(frame, analyser && frame.playing ? spectrum : null, analyser?.context.sampleRate || 48000, analyser?.fftSize || 2048));
    } else stages.forEach(stage => stage.still());
    if (frame.time - last >= 100) { last = frame.time; sync(); }
  });
  return () => { spectrum = null; stages.forEach(stage => stage.destroy()); stages.clear(); };
}
