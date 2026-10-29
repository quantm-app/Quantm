import { h, clear, artwork, duration } from '../dom.js';
import { button, errorState, isLocked, openInSoundCloud } from '../ui.js';

const tempo = grid => grid?.bpm > 0 ? grid.bpm : grid?.period > 0 ? 60 / grid.period : 0;
const fixed = value => Number.isFinite(value) && value > 0 ? value.toFixed(1).padStart(5, '0') : '---.-';
// Drop cut stages as the player reports them (dropcut.js dropPhase)
const PHASES = { build: 'BUILD', roll: 'LOOP ROLL', echo: 'ECHO OUT', cut: 'CUT', drop: 'DROP' };
// genre transitions (transitions.js) that blend; a quick cut is a drop cut schedule
const GENRES = { doubledrop: 'DOUBLE DROP', filterfade: 'FILTER FADE' };
const clamp01 = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** How far the outgoing deck's bass is filtered away during a drop cut build (0 = full bass, 1 = none) */
function bassKill(player, phase) {
  if (phase === 'cut' || phase === 'drop') return 1;
  const schedule = player.fading?.schedule;
  const now = player.normalizer?.ctx?.currentTime;
  if (!schedule || schedule.kill?.style === 'none' || !Number.isFinite(now) || !(schedule.cut > schedule.start)) return 0;
  return clamp01((now - schedule.start) / (schedule.cut - schedule.start));
}

function deck(letter, role) {
  const cover = h('div.td-label', { 'aria-hidden': 'true' }, h('span', letter));
  const platter = h('div.td-platter', cover);
  const title = h('h2.td-track-title');
  const artist = h('p.td-track-artist');
  const bpm = h('output.td-bpm', { 'aria-label': `Deck ${letter} tempo` });
  const pitchValue = h('span.td-pitch-value', '0.0%');
  const pitch = h('div.td-pitch', { 'aria-hidden': 'true' },
    h('span.td-pitch-end', '+'), h('div.td-pitch-rail', h('i.td-pitch-handle')), h('span.td-pitch-end', '-'));
  const node = h(`section.td-deck.td-deck-${letter.toLowerCase()}`, { 'aria-label': `Deck ${letter}: ${role}` },
    h('header.td-deck-head', h('span.td-deck-letter', letter), h('span.td-deck-role', role), h('i.td-led', { 'aria-hidden': 'true' })),
    h('div.td-disc-area', h('div.td-platter-rim', platter), h('div.td-pitch-module', pitch, h('span.td-caption', 'PITCH'), pitchValue)),
    h('div.td-track-info', title, artist),
    h('footer.td-deck-foot', h('div', h('span.td-caption', 'TEMPO / BPM'), bpm),
      h('div.td-eq', h('span.td-caption', 'LOW EQ'), h('span.td-knob', { 'aria-hidden': 'true' }, h('i'))),
      h('span.td-deck-stamp', 'DIRECT\nDRIVE')));
  let shown;
  return { node, update(track, label, bpmValue, rate = 1) {
    const key = `${track?.id || ''}:${track?.artwork_url || ''}:${label}`;
    if (shown !== key) {
      shown = key;
      title.textContent = track?.title || label;
      artist.textContent = track?.user?.username || (track ? 'Unknown artist' : '');
      title.title = title.textContent;
      artist.title = artist.textContent;
      clear(cover).append(h('span', letter));
      const src = artwork(track?.artwork_url || track?.user?.avatar_url, 't300x300');
      if (src) {
        const image = h('img', { src, alt: '', draggable: false });
        image.addEventListener('error', () => image.remove(), { once: true });
        cover.append(image);
      }
    }
    bpm.textContent = fixed(bpmValue);
    bpm.setAttribute('aria-label', `Deck ${letter}: ${bpmValue > 0 ? `${bpmValue.toFixed(1)} beats per minute` : 'tempo unknown'}`);
    const pitchPercent = (rate - 1) * 100;
    pitchValue.textContent = `${pitchPercent > 0 ? '+' : ''}${pitchPercent.toFixed(1)}%`;
    node.style.setProperty('--td-pitch', String(Math.max(0, Math.min(1, 0.5 - pitchPercent / 32))));
    node.style.setProperty('--td-live-bpm', String(bpmValue || 0));
    node.dataset.tempo = bpmValue > 0 ? 'known' : 'unknown';
  } };
}

function renderConsole(container, ctx) {
  const { player, store } = ctx;
  const cleanups = [];
  const listen = (target, event, fn) => {
    if (target.on) cleanups.push(target.on(event, fn));
    else {
      target.addEventListener(event, fn);
      cleanups.push(() => target.removeEventListener(event, fn));
    }
  };
  let alive = true;
  let browseCleanup;
  let browseStarted = false;
  let snapshot = {};
  let sampledAt = -Infinity;
  let sampledAudio;
  let crateKey = '';
  let step = 0;
  const html = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canMove = () => html.dataset.themeMotion !== 'off' &&
    !(html.dataset.themeMotion !== 'on' && reduced.matches);
  const deckA = deck('A', 'ON AIR');
  const deckB = deck('B', 'INCOMING');
  const status = h('span.td-session-status');
  const lockText = h('strong.td-lock-state', 'Standby');
  const error = h('span.td-phase-error', 'No active mix');
  const beatCounter = h('div.td-beats', { 'aria-hidden': 'true', dataset: { step: '0' } },
    [1, 2, 3, 4].map(n => h('span', String(n))));
  const crossfader = h('div.td-crossfader', {
    role: 'meter', 'aria-label': 'Automatic crossfader: incoming deck level',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0'
  }, h('div.td-crossfader-rail', h('i.td-crossfader-handle')));
  const mixer = h('aside.td-mixer', { 'aria-label': 'Automatic mixer' },
    h('span.td-caption', 'PHASE ALIGNMENT'),
    h('div.td-phase-ring', { 'aria-hidden': 'true' }, h('div.td-phase-dial'), h('i.td-phase-pointer')),
    lockText, error, h('span.td-caption', '4 BEAT PHRASE'), beatCounter,
    h('div.td-crossfader-module', h('div.td-crossfader-labels', h('span', 'A'), h('span', 'CROSSFADE'), h('span', 'B')), crossfader),
    h('span.td-auto-note', 'AUTOMATIC / READ ONLY'));
  const crate = h('div.td-crate', { role: 'list', 'aria-label': 'Tracks in your queue' });
  const queueCount = h('span.td-caption');
  const browse = h('section.td-browse', { hidden: true, 'aria-label': 'Browse Home' });
  const browseButton = button('Browse music', () => showBrowse(), 'btn-outline');
  browseButton.setAttribute('aria-expanded', 'false');
  const consoleNode = h('section.td-console', { 'aria-label': 'Twin Deck mixing console' },
    h('header.td-console-head', h('span.td-caption', 'TWO CHANNEL / BEAT MATCHED'), status),
    h('div.td-decks', deckA.node, mixer, deckB.node),
    h('footer.td-console-foot', h('span', 'A / RED'),
      h('span', h('span.td-transport-bar', 'TRANSPORT IN THE PLAYER BAR'),
        h('span.td-transport-side', 'CONTROLS IN NOW PLAYING ON THE RIGHT')), h('span', 'B / BLUE')));
  container.classList.add('td-home');
  const workstation = h('div.td-workstation',
    h('header.td-page-head', h('div', h('p.td-eyebrow', 'THE HOME SESSION'), h('h1.td-heading', 'Twin Deck'),
      h('p.td-description', 'Two records. One continuous set.')),
    h('div.td-page-actions', h('a.btn', { href: '#/settings/automix' }, 'Auto mix settings'), browseButton)),
    consoleNode,
    h('section.td-crate-section', { 'aria-label': 'Queue crate' },
      h('header.td-crate-head', h('h2', 'Your crate'), queueCount), crate), browse);
  container.append(workstation);

  async function showBrowse() {
    browse.hidden = !browse.hidden;
    browseButton.textContent = browse.hidden ? 'Browse music' : 'Close Browse';
    browseButton.setAttribute('aria-expanded', String(!browse.hidden));
    if (browse.hidden || browseStarted) return;
    browseStarted = true;
    try {
      const home = await import('../views/home.js');
      if (!alive) return;
      const dispose = await home.render(browse);
      if (!alive) { if (typeof dispose === 'function') dispose(); }
      else browseCleanup = dispose;
    } catch (err) {
      if (alive) { browse.append(errorState(err)); browseStarted = false; }
    }
  }

  function syncCrate() {
    const queue = player.queue || [];
    const start = Math.max(0, player.index);
    const tracks = queue.slice(start, start + 40);
    const key = `${player.index}|${tracks.map(t => `${t.id}:${t.title}`).join('|')}`;
    if (key === crateKey) return;
    crateKey = key;
    clear(crate);
    queueCount.textContent = `${Math.max(0, queue.length - start)} IN QUEUE`;
    if (!tracks.length) {
      crate.append(h('p.td-empty', 'The crate is empty. Browse music or choose tracks from your library.'));
      return;
    }
    tracks.forEach((track, offset) => {
      const index = start + offset;
      const locked = isLocked(track);
      const art = h('span.td-crate-art', { 'aria-hidden': 'true' }, h('span', String(index + 1).padStart(2, '0')));
      const src = artwork(track.artwork_url || track.user?.avatar_url, 'large');
      if (src) {
        const image = h('img', { src, alt: '', loading: 'lazy' });
        image.addEventListener('error', () => image.remove(), { once: true });
        art.append(image);
      }
      crate.append(h('div.td-crate-slot', { role: 'listitem' },
        h('button.td-crate-track', {
          type: 'button', 'aria-current': index === player.index ? 'true' : null,
          onclick: () => locked ? openInSoundCloud(track) : player.jump(index),
          title: locked ? `Open ${track.title} in SoundCloud` : `Play ${track.title}`
        }, art, h('span.td-crate-title', track.title),
        h('span.td-crate-artist', locked ? 'Open in SoundCloud' : track.user?.username || 'Unknown artist'),
        h('span.td-crate-time', duration(track.duration)))));
    });
    if (queue.length - start > 40) crate.append(h('p.td-crate-more', 'More tracks in the player queue.'));
  }

  function sync(force = false) {
    if (!alive) return;
    const now = performance.now();
    if (force || sampledAudio !== player.audio || now - sampledAt >= 250) {
      snapshot = player.autoMixStatus();
      sampledAt = now;
      sampledAudio = player.audio;
    }
    const on = !!player.autoMix;
    const mix = on ? player.fading : null;
    const playing = !!player.playing;
    consoleNode.dataset.playing = String(playing);
    consoleNode.dataset.auto = on ? 'on' : 'off';
    consoleNode.dataset.mixing = String(!!mix);
    // a drop cut swaps decks on the drop instead of blending, and needs no beat lock
    const style = mix ? snapshot.mix?.style || mix.style || 'blend' : 'none';
    const dropCut = style === 'dropcut';
    const phase = dropCut ? snapshot.mix?.phase || 'build' : '';
    consoleNode.dataset.style = style;
    const genre = mix ? snapshot.mix?.genre || null : null;
    const mixLabel = dropCut ? `${genre === 'quickcut' ? 'QUICK CUT' : 'DROP CUT'} · ${PHASES[phase] || 'BUILD'}` : GENRES[genre] || 'SMOOTH BLEND';
    status.textContent = !on ? 'AUTO MIX OFF' : !playing ? 'PAUSED' : mix ? mixLabel : 'AUTO MIX ON';
    const next = on ? mix?.to || snapshot.upNext?.track || player.queue?.[player.index + 1] : null;
    const gridA = mix ? player.lock?.match?.gridOut || player.mixPlan?.grid :
      (snapshot.plan?.grid || snapshot.live || snapshot.structure?.grid);
    const gridB = mix ? player.lock?.match?.gridIn || snapshot.live || snapshot.structure?.grid : snapshot.preroll?.grid;
    const rateA = (mix?.outgoing?.audio || player.audio)?.playbackRate || 1;
    const rateB = mix?.incoming?.audio?.playbackRate || 1;
    deckA.update(mix?.from || player.current, 'Choose a record', tempo(gridA) * rateA, rateA);
    deckB.update(next, on ? 'Waiting for the next record' : 'Auto mix off',
      on ? (tempo(gridB) || (!mix && snapshot.upNext?.bpm) || 0) * rateB : 0, rateB);
    const locked = !!mix && snapshot.lock?.active && Number.isFinite(snapshot.lock.errorMs) && Math.abs(snapshot.lock.errorMs) < 12;
    consoleNode.dataset.locked = String(!!locked);
    lockText.textContent = !on ? 'Standby' : !mix ? 'Awaiting mix' : dropCut ? 'No lock needed' : locked ? 'Locked' : 'Drifting';
    const offset = mix && Number.isFinite(snapshot.lock?.errorMs) ?
      `${Math.abs(snapshot.lock.errorMs).toFixed(1)} ms offset` : mix ? 'Finding the beat' : 'No active mix';
    error.textContent = dropCut ? 'Cuts on the drop' : offset;
    consoleNode.style.setProperty('--td-phase-error', `${Math.max(-50, Math.min(50, snapshot.lock?.errorMs || 0))}deg`);
    // drop cut: the crossfader holds on A through the build and snaps to B at the cut; the low EQ on A
    // turns down with the bass sweep and B's comes up on the drop (empty values hand back to the CSS)
    const fader = dropCut ? (phase === 'cut' || phase === 'drop' ? 1 : 0) : null;
    consoleNode.style.setProperty('--td-xfade', fader === null ? '' : String(fader));
    deckA.node.style.setProperty('--td-eq-angle', dropCut ? `${Math.round(-120 * bassKill(player, phase))}deg` : '');
    deckB.node.style.setProperty('--td-eq-angle', dropCut ? (phase === 'drop' ? '0deg' : '-120deg') : '');
    const progress = mix && playing ? (fader ?? clamp01(snapshot.mix?.progress || 0)) : 0;
    crossfader.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    syncCrate();
  }

  // The shared CSS clock's alternating marker advances a four-position counter.
  // Only a small, low-contrast marker moves, so fast tempos never flash the whole console.
  let previousBeat = html.dataset.beat;
  const observer = new MutationObserver(() => {
    const beat = html.dataset.beat;
    if (beat !== previousBeat && html.dataset.automix !== 'off' && canMove()) {
      step = (step + 1) % 4;
      beatCounter.dataset.step = String(step);
    }
    previousBeat = beat;
  });
  observer.observe(html, { attributes: true, attributeFilter: ['data-beat'] });
  cleanups.push(() => observer.disconnect());
  for (const event of ['track', 'state', 'queue', 'automix', 'transition', 'speed']) listen(player, event, () => sync());
  listen(store, 'settings', () => sync(true));
  const timer = setInterval(() => { if (player.playing && player.autoMix) sync(); }, 250);
  cleanups.push(() => clearInterval(timer));
  sync(true);
  return () => {
    if (!alive) return;
    alive = false;
    cleanups.forEach(fn => fn());
    if (typeof browseCleanup === 'function') browseCleanup();
    container.classList.remove('td-home');
    workstation.remove();
  };
}

export function mount(ctx) {
  const mounted = new Set();
  ctx.views.override('home', async () => ({ render(container) {
    const dispose = renderConsole(container, ctx);
    const cleanup = () => { dispose(); mounted.delete(cleanup); };
    mounted.add(cleanup);
    return cleanup;
  } }));
  return () => mounted.forEach(cleanup => cleanup());
}
