// Player bar (bottom, top, or a docked side panel) + queue panel
import { h, clear, duration, coverOf, compact, linkify, sliderKey } from './dom.js';
import { icon } from './icons.js';
import { player } from './player.js';
import { createVisualizer } from './visualizer.js';
import { store, settings, saveSettings } from './store.js';
import { getSleepTimer, formatRemaining } from './sleep.js';
import { iconButton, likeButton, repostButton, avatar, addToPlaylistDialog, trackMenu, link, userHref, trackHref, sourceBadge, emptyState, menu, transitionDialog, toast } from './ui.js';
import { isExternal, isExternalId } from './sources.js';
import { getCues, cueEvents, transitionFor } from './cues.js';
import { formatCueTime } from './cue-time.js';
import { createMixRate } from './mixrate.js';

export function mountPlayerBar(root, { offline = false } = {}) {
  // the placeholder icon only shows in the side panel, when the track has no cover
  const art = h('a.pb-art', { href: '#' }, h('span.pb-art-ph', icon('album', 72)));
  const title = h('a.pb-title', { href: '#' });
  const artist = h('div.pb-artist');
  const likeSlot = h('div.pb-like');

  const playBtn = h('button.pb-play', { title: 'Play (Space)', onclick: () => player.toggle() }, icon('play', 22));
  const shuffleBtn = iconButton('shuffle', 'Shuffle', () => player.cycleShuffle(), 'pb-mode');
  const repeatBtn = iconButton('repeat', 'Repeat', () => player.cycleRepeat(), 'pb-mode');

  const current = h('span.pb-time', '0:00');
  const total = h('span.pb-time', '0:00');
  const fill = h('div.pb-fill');
  const buffer = h('div.pb-buffer');
  const knob = h('div.pb-knob');
  const hoverTime = h('div.pb-hovertime');
  const ticks = h('div.pb-cue-ticks');
  const progress = h('div.pb-progress', { role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0' },
    h('div.pb-track', buffer, fill, ticks, knob), hoverTime);
  const progressRow = h('div.pb-progress-row', current, progress, total);
  const renderTicks = () => {
    clear(ticks);
    const track = player.current;
    const seconds = player.duration || track?.duration / 1000;
    if (!track || !seconds) return;
    const data = getCues(track.id);
    const tick = (t, kind) => {
      if (t != null && t <= seconds) ticks.append(h('span.pb-cue-tick.' + kind, { style: { left: t / seconds * 100 + '%' } }));
    };
    data.cues.forEach(cue => tick(cue.t, 'cue'));
    tick(data.mixIn, 'mix-in');
    tick(data.mixOut, 'mix-out');
  };
  player.on('track', renderTicks);
  player.audio.addEventListener('loadedmetadata', renderTicks);
  cueEvents.on('change', id => { if (String(id) === String(player.current?.id)) renderTicks(); });
  renderTicks();

  const addBtn = iconButton('addToPlaylist', 'Add to playlist', () => addToPlaylistDialog(player.current), 'pb-add');
  const moreBtn = iconButton('more', 'More', (e) => player.current && trackMenu(player.current, e));
  addBtn.hidden = moreBtn.hidden = offline;
  const queueBtn = iconButton('queue', 'Queue', () => toggleQueue(), 'pb-queue-btn');
  const speedBtn = h('button.pb-speed', { title: 'Playback speed', 'aria-label': 'Playback speed', onclick: (e) => { e.stopPropagation(); speedMenu(e); } });
  const eqBtn = h('button.pb-speed.pb-eq', { title: 'Equalizer', 'aria-label': 'Equalizer', onclick: (e) => {
    e.stopPropagation();
    menu([
      { label: settings.eq.enabled ? 'Turn equalizer off' : 'Turn equalizer on', icon: 'equalizer', onclick: () => {
        saveSettings({ eq: { ...settings.eq, enabled: !settings.eq.enabled } });
        location.hash = '#/settings/playback?card=equalizer';
      } },
      { label: 'Equalizer settings', icon: 'settings', onclick: () => { location.hash = '#/settings/playback?card=equalizer'; } }
    ], e);
  } }, 'EQ');
  const syncEq = () => { eqBtn.classList.toggle('active', settings.eq.enabled); eqBtn.setAttribute('aria-pressed', String(settings.eq.enabled)); };
  store.on('settings', syncEq);
  syncEq();
  const sleep = getSleepTimer(player, toast);
  const sleepLabel = h('span.pb-sleep-label');
  const sleepBtn = h('button.icon-btn.pb-sleep', { title: 'Sleep timer', 'aria-label': 'Sleep timer', onclick: (e) => {
    e.stopPropagation();
    menu([
      ...[15, 30, 45, 60, 90].map(minutes => ({ label: `${minutes} minutes`, onclick: () => sleep.start(minutes) })),
      player.current ? { label: 'End of this track', onclick: () => sleep.startEndOfTrack() } : null,
      'separator',
      { label: 'Cancel timer', onclick: () => sleep.cancel() }
    ], e);
  } }, icon('moon', 18), sleepLabel);
  const syncSleep = () => {
    sleepBtn.classList.toggle('active', !!sleep.mode);
    sleepLabel.textContent = sleep.mode === 'time' ? formatRemaining(sleep.remaining) : sleep.mode === 'track' ? '•' : '';
    sleepBtn.title = sleep.mode === 'track' ? 'Sleep timer: end of this track' : sleep.mode ? `Sleep timer: ${formatRemaining(sleep.remaining)} remaining` : 'Sleep timer';
    sleepBtn.setAttribute('aria-label', sleepBtn.title);
  };
  sleep.on('change', syncSleep);
  syncSleep();
  const volIcon = iconButton('volume', 'Mute (M)', () => player.toggleMute());
  const volFill = h('div.pb-fill');
  const volume = h('div.pb-volume', { role: 'slider', tabindex: '0', 'aria-label': 'Volume', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '100' }, h('div.pb-track', volFill));

  const visualizer = createVisualizer();
  const pbText = h('div.pb-text', title, artist);
  // thumbs up / down for the Auto mix transition that just happened (mixrate.js); hidden outside that window
  const mixRateEl = h('div.pb-mixrate', { hidden: true, role: 'group', 'aria-label': 'Rate this transition' },
    h('span.pb-mixrate-label', 'Rate the mix'),
    iconButton('thumbsUp', 'Good transition', () => mixRate.rate('good'), 'pb-mixrate-btn'),
    iconButton('thumbsDown', 'Bad transition', () => mixRate.rate('bad'), 'pb-mixrate-btn'));
  const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-perf');
  const mixRate = createMixRate(player, {
    mount: () => { mixRateEl.hidden = false; },
    reveal: () => mixRateEl.classList.add('show'),
    conceal: () => {
      // a click on a thumb removes it from the layout: keep keyboard focus on the page
      if (mixRateEl.contains(document.activeElement)) title.focus({ preventScroll: true });
      mixRateEl.classList.remove('show');
    },
    unmount: () => { mixRateEl.hidden = true; }
  }, { reducedMotion: reduceMotion });
  const pbLeft = h('div.pb-left', art, pbText, likeSlot, addBtn, mixRateEl);
  const controls = h('div.pb-controls',
    shuffleBtn,
    iconButton('prev', 'Previous (Ctrl+←)', () => player.prev(), 'pb-skip'),
    playBtn,
    iconButton('next', 'Next (Ctrl+→)', () => player.next(), 'pb-skip'),
    repeatBtn
  );
  const pbCenter = h('div.pb-center', controls, progressRow);
  const pbRight = h('div.pb-right', moreBtn, speedBtn, eqBtn, sleepBtn, queueBtn, volIcon, volume);
  const bar = h('footer.playerbar.idle', pbLeft, pbCenter, pbRight);

  // --- side layout ------------------------------------------------------------
  // The "Side" player position moves these very same control elements (same listeners, same
  // state) into a docked panel, so every theme's .pb-* styling still applies. Under
  // SIDE_MIN_WIDTH the normal bar stays (in every theme, including ones with their own layout).
  // CSS keys off html[data-side-player], which is only set while the panel is shown.
  const SIDE_MIN_WIDTH = 980;
  const repostSlot = h('div.side-repost');
  const slots = {
    art: h('div.side-art'), info: h('div.side-info'), actions: h('div.side-actions'),
    progress: h('div.side-progress'), controls: h('div.side-controls'),
    volume: h('div.side-volume'), buttons: h('div.side-buttons'), viz: h('div.side-viz')
  };
  const mixTempo = h('span.side-mix-tempo');
  const mixNext = h('span.side-mix-next');
  const mixRow = h('div.side-automix', { hidden: true }, icon('mixOrder', 14), h('span.side-mix-name', 'Auto mix'), mixTempo, mixNext);
  const detailsInfo = h('div.side-info-block');
  const detailsNext = h('div.side-next');
  const side = h('aside.playerbar.side.idle', { 'aria-label': 'Now playing', hidden: true },
    h('div.side-main',
      slots.art, slots.info, slots.actions, slots.progress, slots.controls,
      h('div.side-tools', slots.volume, slots.buttons), slots.viz, mixRow
    ),
    h('div.side-details', detailsInfo, detailsNext)
  );
  root.append(bar, side);

  let docked = false; // are the controls living in the side panel right now?
  const sideWanted = () => {
    const html = document.documentElement;
    return html.dataset.player === 'side' && window.innerWidth >= SIDE_MIN_WIDTH;
  };
  const dockSide = () => {
    slots.art.append(art);
    slots.info.append(pbText);
    slots.actions.append(likeSlot, repostSlot, addBtn, moreBtn);
    slots.progress.append(progressRow);
    slots.controls.append(controls);
    slots.volume.append(volIcon, volume);
    slots.buttons.append(speedBtn, eqBtn, sleepBtn, queueBtn);
    mixRow.append(mixRateEl); // in the Auto mix strip, after the tempo and countdown
  };
  const dockBar = () => {
    pbLeft.append(art, pbText, likeSlot, addBtn, mixRateEl);
    pbCenter.prepend(controls, progressRow);
    pbRight.prepend(moreBtn, speedBtn, eqBtn, sleepBtn, queueBtn, volIcon, volume);
  };
  // the panel starts right under the top bar, wherever the theme puts its bottom edge
  // (Liquid floats the bar with margins, Tiling adds a gap and borders)
  const measureTop = () => {
    const topbar = document.querySelector('.topbar');
    if (docked && topbar) document.documentElement.style.setProperty('--side-top', Math.ceil(topbar.getBoundingClientRect().bottom) + 'px');
  };
  const syncDock = () => {
    const want = sideWanted();
    if (want === docked) { measureTop(); return; }
    // moving or hiding a focused control would drop keyboard focus: put it back afterwards
    const focused = document.activeElement;
    const keepFocus = focused && focused !== document.body && [art, pbText, likeSlot, repostSlot, addBtn, moreBtn, controls, progressRow, volIcon, volume, speedBtn, eqBtn, sleepBtn, queueBtn, mixRateEl].some(el => el.contains(focused));
    docked = want;
    side.hidden = !docked;
    document.documentElement.toggleAttribute('data-side-player', docked);
    if (!docked) document.documentElement.style.removeProperty('--side-top');
    if (docked) dockSide(); else dockBar();
    measureTop();
    placeVisualizer();
    renderArt();
    renderRepost();
    renderSide();
    syncAutoMix();
    if (keepFocus) focused.focus({ preventScroll: true });
  };
  // the setting, theme and theme layouts live on <html>; the width check follows window size and zoom
  new MutationObserver(syncDock).observe(document.documentElement, { attributes: true, attributeFilter: ['data-player', 'data-layout', 'data-style'] });
  window.addEventListener('resize', syncDock);
  document.addEventListener('themechange', () => { measureTop(); requestAnimationFrame(measureTop); });

  // the visualizer can live on the left, in the center beside the controls, or on the right
  // (in the side panel it sits under the controls)
  const placeVisualizer = () => {
    const spot = settings.visualizerPosition;
    if (docked) { if (visualizer.parentElement !== slots.viz) slots.viz.append(visualizer); return; }
    if (spot === 'left') { if (visualizer.parentElement !== pbLeft) pbLeft.insertBefore(visualizer, likeSlot); }
    else if (spot === 'center') { if (visualizer.parentElement !== pbCenter) pbCenter.append(visualizer); }
    else if (visualizer.parentElement !== pbRight) pbRight.insertBefore(visualizer, moreBtn);
  };
  placeVisualizer();
  store.on('settings', placeVisualizer);

  // --- progress / seeking -----------------------------------------------------
  let dragging = false;
  const fractionAt = (e, el) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const setProgress = (fraction) => {
    fill.style.width = fraction * 100 + '%';
    knob.style.left = fraction * 100 + '%';
  };
  progress.addEventListener('mousedown', (e) => {
    if (!player.current) return;
    dragging = true;
    progress.classList.add('dragging');
    const move = (ev) => {
      const f = fractionAt(ev, progress);
      setProgress(f);
      current.textContent = duration(f * player.duration * 1000);
    };
    const up = (ev) => {
      dragging = false;
      progress.classList.remove('dragging');
      player.seek(fractionAt(ev, progress) * player.duration);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    move(e);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  progress.addEventListener('mousemove', (e) => {
    const f = fractionAt(e, progress);
    hoverTime.textContent = duration(f * player.duration * 1000);
    hoverTime.style.left = f * 100 + '%';
  });

  // keyboard: arrows move 5 seconds, Page keys 30, Home / End jump to the ends (the global arrow shortcuts skip a focused slider)
  progress.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !player.current || !player.duration) return;
    const next = sliderKey(e.key, player.audio.currentTime, 0, player.duration, 5, 30);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    player.seek(next);
  });
  // screen readers read the position as a time; refreshed once per second, not on every tick
  let seekAria = '';
  const renderSeekAria = (time, dur) => {
    const key = Math.floor(time) + '/' + Math.floor(dur || 0);
    if (key === seekAria) return;
    seekAria = key;
    progress.setAttribute('aria-valuemax', String(Math.floor(dur || 0)));
    progress.setAttribute('aria-valuenow', String(Math.floor(time)));
    progress.setAttribute('aria-valuetext', `${duration(time * 1000)} of ${duration((dur || 0) * 1000)}`);
  };

  player.on('time', (time, dur) => {
    if (dragging) return;
    current.textContent = duration(time * 1000);
    total.textContent = duration(dur * 1000);
    setProgress(dur ? time / dur : 0);
    renderSeekAria(time, dur);
    const a = player.audio;
    if (a.buffered.length && dur) buffer.style.width = (a.buffered.end(a.buffered.length - 1) / dur) * 100 + '%';
  });

  // --- playback speed -----------------------------------------------------------
  const renderSpeed = () => {
    speedBtn.textContent = player.speedLabel;
    speedBtn.classList.toggle('active', settings.speedMode !== undefined && settings.speedMode !== 'normal');
    speedBtn.title = `Playback speed: ${+player.rate.toFixed(2)}×`;
  };
  const speedMenu = (e) => {
    const mode = settings.speedMode || 'normal';
    const rate = player.rate;
    const custom = (value) => ({ label: `${value}×`, icon: mode === 'custom' && rate === value ? 'check' : null, onclick: () => player.setSpeed(value) });
    menu([
      { label: 'Normal', icon: mode === 'normal' ? 'check' : null, onclick: () => player.setSpeedMode('normal') },
      { label: 'Nightcore', icon: mode === 'nightcore' ? 'check' : null, onclick: () => player.setSpeedMode('nightcore') },
      { label: 'Slowed', icon: mode === 'slowed' ? 'check' : null, onclick: () => player.setSpeedMode('slowed') },
      'separator',
      custom(0.75), custom(1.25), custom(1.5)
    ], e);
  };
  player.on('speed', renderSpeed);
  renderSpeed();

  // --- volume -------------------------------------------------------------------
  const renderVolume = () => {
    const v = player.muted ? 0 : player.volume;
    volFill.style.width = v * 100 + '%';
    volume.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    volume.setAttribute('aria-valuetext', Math.round(v * 100) + '%');
    clear(volIcon).append(icon(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume'));
  };
  volume.addEventListener('mousedown', (e) => {
    const move = (ev) => player.setVolume(fractionAt(ev, volume));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    move(e);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  volume.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = sliderKey(e.key, player.muted ? 0 : player.volume, 0, 1, 0.05, 0.1);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    player.setVolume(Math.round(next * 100) / 100);
  });
  volume.addEventListener('wheel', (e) => { e.preventDefault(); player.setVolume(player.volume - Math.sign(e.deltaY) * 0.05); }, { passive: false });
  player.on('volume', renderVolume);
  renderVolume();

  // --- track / state ------------------------------------------------------------
  let shown = null; // the track the bar / side panel currently describe
  let likeBase = null; // the track's like count without your own like
  // the repost button only exists while the panel is shown: the bar has none, and a button
  // built while its slot is detached or hidden would keep its store subscription
  const renderRepost = () => {
    clear(repostSlot);
    if (docked && shown && !offline) repostSlot.append(repostButton(shown));
  };
  // the side panel shows the artwork large, so it asks for a bigger size
  const renderArt = () => {
    const cover = shown && coverOf(shown, docked ? 't500x500' : 't300x300');
    art.style.backgroundImage = cover ? `url("${cover}")` : '';
    art.classList.toggle('no-cover', !cover);
  };
  player.on('track', (track) => {
    shown = track;
    bar.classList.remove('idle');
    side.classList.remove('idle');
    renderArt();
    // Audius / Bandcamp songs have no SoundCloud page to link to
    for (const el of [art, title]) {
      if (trackHref(track)) el.setAttribute('href', trackHref(track));
      else el.removeAttribute('href');
    }
    art.title = track.title;
    art.setAttribute('aria-label', track.title);
    title.textContent = track.title;
    title.title = track.title;
    // the small avatar only shows in the side panel
    const sourceUser = track.user && !isExternalId(track.user.id);
    clear(artist).append(
      sourceUser ? h('a.side-avatar', { href: userHref(track.user), tabindex: -1, 'aria-hidden': 'true' }, avatar(track.user, 20)) : null,
      sourceUser ? link(userHref(track.user), track.user.username) : (track.user ? track.user.username : ''),
      sourceBadge(track)
    );
    clear(likeSlot);
    if (!offline && !isExternal(track)) likeSlot.append(likeButton(track));
    likeBase = track.likes_count != null ? track.likes_count - (store.isLiked(track) ? 1 : 0) : null;
    renderRepost();
    total.textContent = duration(track.duration);
    document.title = `${track.title} · ${track.user ? track.user.username : ''} — Quantm`;
    renderSide();
    syncAutoMix();
  });
  const renderState = () => {
    clear(playBtn).append(icon(player.playing ? 'pause' : 'play', 22));
    playBtn.title = player.playing ? 'Pause (Space)' : 'Play (Space)';
    syncAutoMix();
  };
  player.on('state', renderState);
  player.on('buffering', (on) => [bar, side].forEach(el => el.classList.toggle('buffering', on)));

  // --- side panel details ---------------------------------------------------------
  /** 'techno "deep house"' -> ['techno', 'deep house'] */
  const parseTags = (text) => {
    const tags = [];
    String(text || '').replace(/"([^"]+)"|(\S+)/g, (m, quoted, single) => { tags.push(quoted || single); return m; });
    return tags;
  };

  let likesStat = null;
  // the count follows the store's liked state, so liking the song on its own page updates it too
  const likeCount = () => likeBase + (store.isLiked(shown) ? 1 : 0);
  const renderLikes = () => {
    if (likesStat && shown && likeBase !== null) likesStat.lastChild.textContent = compact(likeCount());
  };
  store.on('change', renderLikes);

  // plays, likes, genre and tags, and the first few lines of the description
  function renderInfo() {
    clear(detailsInfo);
    likesStat = null;
    const track = shown;
    if (!track) return;
    const plays = track.playback_count != null ? h('span.stat', { title: 'Plays' }, icon('play', 12), compact(track.playback_count)) : null;
    if (likeBase !== null) likesStat = h('span.stat', { title: 'Likes' }, icon('heart', 12), compact(likeCount()));
    if (plays || likesStat) detailsInfo.append(h('div.side-stats', plays, likesStat));

    const tags = parseTags(track.tag_list);
    if (track.genre && !tags.some(t => t.toLowerCase() === track.genre.toLowerCase())) tags.unshift(track.genre);
    if (tags.length) {
      detailsInfo.append(h('div.side-tags', tags.slice(0, 10).map(tag =>
        h('a.tag-pill', { href: '#/search?q=' + encodeURIComponent(tag) + '&tab=tracks' }, '#' + tag))));
    }

    const about = track.description && track.description.trim();
    if (about) {
      const text = h('div.description.side-description.clamped', { html: linkify(about) });
      const toggle = h('button.side-more', { hidden: true, onclick: () => {
        const clamped = text.classList.toggle('clamped');
        toggle.textContent = clamped ? 'Show more' : 'Show less';
      } }, 'Show more');
      detailsInfo.append(h('div.side-about', text, toggle));
      // only offer "Show more" when the 4-line clamp really cuts text off (measured once laid out)
      requestAnimationFrame(() => {
        if (text.classList.contains('clamped') && text.scrollHeight > text.clientHeight + 1) toggle.hidden = false;
      });
    }
  }

  // the next three songs in the queue; click one to jump to it
  function renderNext() {
    clear(detailsNext);
    const first = player.index + 1;
    const rows = player.queue.slice(first, first + 3);
    if (!rows.length) return;
    detailsNext.append(
      h('h3.side-label', 'Up next'),
      ...rows.map((track, i) => {
        const cover = coverOf(track, 't67x67');
        return h('button.side-next-row', { title: `Play ${track.title}`, onclick: () => player.jump(first + i) },
          h('div.side-next-art', { style: { backgroundImage: cover ? `url("${cover}")` : '' } }),
          h('div.side-next-meta', h('div.side-next-title', track.title), h('div.muted.small', track.user ? track.user.username : '')));
      })
    );
  }

  // nothing is built while the panel is not shown
  function renderSide() {
    if (!docked) return;
    renderInfo();
    renderNext();
  }
  player.on('queue', () => { if (docked) renderNext(); });

  // tempo and the countdown to the next mix; a timer runs only while the panel is shown and playing
  let mixTimer = null;
  const showMix = () => docked && settings.autoMix === true && !!player.current;
  function renderAutoMix() {
    const status = player.autoMixStatus();
    const bpm = status.live?.bpm || status.structure?.grid?.bpm || status.upNext?.bpm;
    mixTempo.textContent = bpm ? `${Math.round(bpm)} BPM` : '';
    mixNext.textContent = status.mix ? 'mixing…'
      : status.mixIn > 0 ? `next mix in ${duration(status.mixIn * 1000)}` : '';
  }
  function syncAutoMix() {
    mixRow.hidden = !showMix();
    const run = showMix() && player.playing;
    if (!mixRow.hidden) renderAutoMix();
    if (run && !mixTimer) mixTimer = setInterval(renderAutoMix, 500);
    else if (!run && mixTimer) { clearInterval(mixTimer); mixTimer = null; }
  }
  store.on('settings', syncAutoMix);
  const renderModes = () => {
    // shuffle has three states: off, shuffle, and mix order (songs that blend)
    const shuffleMode = player.shuffleMode;
    shuffleBtn.classList.toggle('active', shuffleMode !== 'off');
    shuffleBtn.classList.toggle('mix', shuffleMode === 'mix');
    clear(shuffleBtn).append(icon(shuffleMode === 'mix' ? 'mixOrder' : 'shuffle'));
    shuffleBtn.title = { off: 'Shuffle: off', shuffle: 'Shuffle: on', mix: 'Shuffle: mix order (songs that blend)' }[shuffleMode];
    shuffleBtn.setAttribute('aria-label', shuffleBtn.title);
    shuffleBtn.setAttribute('aria-pressed', String(shuffleMode !== 'off'));
    repeatBtn.classList.toggle('active', player.repeat !== 'off');
    clear(repeatBtn).append(icon(player.repeat === 'one' ? 'repeatOne' : 'repeat'));
    repeatBtn.title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[player.repeat];
  };
  player.on('modes', renderModes);
  store.on('settings', renderModes); // turning Auto mix off drops mix order
  renderModes();

  // --- queue panel --------------------------------------------------------------
  const panel = h('aside.queue-panel');
  root.append(panel);

  function toggleQueue(force) {
    const open = force !== undefined ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    queueBtn.classList.toggle('active', open);
    if (open) renderQueue();
  }

  function renderQueue() {
    if (!panel.classList.contains('open')) return;
    clear(panel);
    panel.append(h('div.queue-head',
      h('h2', 'Queue'),
      h('div.queue-head-actions',
        h('button.btn.btn-ghost.btn-sm', { onclick: () => player.clearQueue() }, 'Clear'),
        iconButton('close', 'Close', () => toggleQueue(false))
      )
    ));
    if (!player.queue.length) {
      panel.append(emptyState('Your queue is empty. Play something!', 'queue'));
      return;
    }
    if (player.context) panel.append(h('div.queue-context.muted.small', 'Playing from ', h('a', { href: player.context.href }, player.context.label)));

    const list = h('div.queue-list');
    player.queue.forEach((track, i) => {
      if (i < player.index - 3) return; // keep a little history visible
      const row = h('div.queue-row' + (i === player.index ? '.current' : '') + (i < player.index ? '.past' : ''),
        { draggable: true, dataset: { index: i }, tabindex: '0', role: 'button', 'aria-label': `Play ${track.title}` },
        h('div.queue-art', { style: { backgroundImage: coverOf(track, 't67x67') ? `url("${coverOf(track, 't67x67')}")` : '' } }),
        h('div.queue-meta', h('div.queue-title', track.title), h('div.muted.small', track.user ? track.user.username : '')),
        h('span.muted.small', duration(track.duration)),
        i !== player.index ? iconButton('close', 'Remove', () => player.removeFromQueue(i), 'queue-remove') : null
      );
      row.addEventListener('dblclick', () => player.jump(i));
      // Enter / Space on the row itself (not on its Remove button) plays it, like a double-click
      row.addEventListener('keydown', (e) => {
        if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation(); // Space would also pause through the global shortcut
        player.jump(i);
      });
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-quantm-queue', String(i)); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        // only a row dragged from this list counts (a file dropped from outside carries no index)
        const raw = e.dataTransfer.getData('application/x-quantm-queue');
        const from = raw === '' ? NaN : Number(raw);
        if (!isNaN(from) && from !== i) player.moveInQueue(from, i);
      });
      if (i === player.index) list.append(h('div.queue-label', 'Now playing'));
      if (i === player.index + 1) list.append(h('div.queue-label', 'Next up'));
      list.append(row);
      const next = player.queue[i + 1];
      if (next) {
        const transition = transitionFor(track.id, next.id, player.crossfadeSeconds());
        // in mix order, say how this song blends into the next
        const blend = player.blendNote(i);
        const label = (transition.custom
          ? `↘ ${transition.out == null ? 'end' : formatCueTime(transition.out)} → ${formatCueTime(transition.in)} · ${transition.fade}s`
          : 'Transition') + (blend ? ` · ${blend.text}` : '');
        list.append(h('button.queue-transition' + (transition.custom ? '.custom' : '') + (blend && blend.ok === true ? '.blend-ok' : blend && blend.ok === false ? '.blend-warn' : ''), {
          title: `Edit transition: ${track.title} → ${next.title}`,
          onclick: () => transitionDialog(track, next)
        }, label));
      }
    });
    panel.append(list);
    const currentRow = list.querySelector('.current');
    if (currentRow) currentRow.scrollIntoView({ block: 'nearest' });
  }

  player.on('queue', renderQueue);
  player.on('track', renderQueue);
  cueEvents.on('change', renderQueue);
  store.on('settings', renderQueue);

  syncDock(); // in case the appearance was applied before the bar was built
  return { toggleQueue };
}
