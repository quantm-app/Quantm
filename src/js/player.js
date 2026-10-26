// Playback engine: queue, HLS streaming, shuffle/repeat, media keys (navigator.mediaSession)
import * as api from './api.js';
import * as cues from './cues.js';
import { offline } from './offline.js';
import { Emitter, artwork } from './dom.js';
import { store, settings, saveSettings } from './store.js';
import { toast } from './ui.js';
import { Normalizer } from './normalizer.js';
import { BeatWatcher, BeatLock, ANALYZE_SECONDS, ANALYZE_MAX_SECONDS, MAX_MIX_SECONDS, matchTempo, alignedStart, mixSeconds, memoryGrid } from './automix.js';
import * as mixmemory from './mixmemory.js';
import * as mixlearn from './mixlearn.js';
import * as mixorder from './mixorder.js';
import { phaseError, inspectDrop, tempoOptions, orientGrid } from './beats.js';
import { planStyle, futureWindow, rollSchedule, dropPhase } from './dropcut.js';

const mmss = (t) => { const s = Math.max(0, Math.round(t || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const quote = (track) => '"' + ((track && track.title) || 'this song').slice(0, 60) + '"';

/** Uniformly random order (Fisher-Yates), returns a new array */
function randomOrder(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SESSION_KEY = 'quantm.session';
const PREPARE_LEAD = 8; // seconds before a crossfade starts that the next stream is looked up
const AUTO_LEAD = ANALYZE_SECONDS + 6;
const AUTO_LISTEN = 60;  // seconds before the end that Auto mix starts listening for the beat

const clampSpeed = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1;
};

class Player extends Emitter {
  constructor() {
    super();
    // two audio elements ("decks"): one plays, the other takes over during a crossfade
    this.decks = [this.makeDeck(), this.makeDeck()];
    this.active = 0;
    this.fading = null;     // { outgoing, incoming, ... } while two songs overlap
    this.prepared = null;   // the next song's stream, looked up ahead of a crossfade
    this.noCrossfade = false;

    // volume is applied in the Web Audio graph (after loudness normalization)
    this.volume = settings.volume;
    this.muted = settings.muted;
    this.normalizer = new Normalizer(this.decks[0].audio);
    this.normalizer.enabled = settings.normalize !== false;
    this.normalizer.setEqualizer(settings.eq);
    this.normalizer.setVolume(this.volume, this.muted);
    this.beats = new BeatWatcher(this.normalizer);
    this.lock = null;       // Auto mix: keeps the incoming song on the beat (automix.js)
    this.tempoRelease = null; // independent return to normal speed after phase locking ends
    this.mixPlan = null;    // Auto mix: { loadId, grid, span, choice } for the current song's ending
    this.listening = new Map(); // Auto mix song memory: <audio> → { trackId, listener, after, duration }
    this.waves = new Map();     // track id → structure guessed from SoundCloud's waveform (first plays)
    // Auto mix learning: the last transition, until it is rated or we know it was kept (the setter keeps the rating control in sync)
    this._mixOutcome = null;
    this._ratingShown = null;   // the outcome the thumbs control is showing for
    this.mixLog = [];           // Auto mix activity, newest first (Settings → Auto mix shows it live)
    this.mixAt = null;          // Auto mix: { loadId, at } media time the planned mix starts
    setInterval(() => this.feedMemory(), 1000);

    this.queue = [];        // tracks in play order
    this.index = -1;        // position in queue
    this.original = null;   // un-shuffled queue, when shuffle is on
    this.context = null;    // { label, href } where the queue came from
    this.shuffle = settings.shuffle;
    this.mixOrder = settings.mixOrder === true; // with shuffle on: order songs to blend (shuffleMode 'mix')
    this.mixFeatureCache = new Map(); // track id → mixorder features (tempo, genre, energy)
    this.queueRev = 0;                // bumped by every change you make to the queue; background reorders check it
    this.waveSamples = new Map();     // track id → SoundCloud waveform samples (or null), shared by the guesses below
    this.repeat = settings.repeat;
    this.loadId = 0;
    this.loading = false;

    this.decks.forEach(deck => this.bindDeck(deck));
    this.speedKey = '';
    this.syncSpeed();
    this.mixSettingsKey = `${settings.autoMix}|${settings.transitionStyle}`;
    store.on('settings', () => {
      const key = `${settings.autoMix}|${settings.transitionStyle}`;
      if (key !== this.mixSettingsKey && this.fading?.style === 'dropcut') {
        this.cutFade(); this.stopLock();
      }
      if (key !== this.mixSettingsKey && this.prepared) {
        this.dropPreroll(this.prepared);
        this.prepared = null;
      }
      this.mixSettingsKey = key;
      this.syncSpeed(); this.normalizer.setEqualizer(settings.eq);
    });
    cues.cueEvents.on('change', id => {
      const f = this.fading;
      if (f?.style === 'dropcut' && [f.from.id, f.to.id].some(trackId => String(trackId) === String(id))) this.cutFade();
    });

    this.setupMediaSession();

    // remember the session: on song / queue / pause changes, every few seconds while playing, and on close
    this.on('queue', () => this.saveSession());
    setInterval(() => { if (this.playing) this.saveSession(); }, 5000);
    window.addEventListener('beforeunload', () => { this.saveSession(); this.listening.forEach((v, audio) => this.stopListening(audio)); });
  }

  /** The deck playing the current song (during a crossfade, the incoming one) */
  get deck() { return this.decks[this.active]; }
  get audio() { return this.deck.audio; }
  get current() { return this.queue[this.index] || null; }
  get playing() { return !this.audio.paused; }
  get mixOutcome() { return this._mixOutcome; }
  set mixOutcome(outcome) { this._mixOutcome = outcome; this.syncMixRating(); }
  get duration() {
    const d = this.audio.duration;
    return isFinite(d) && d > 0 ? d : (this.current ? this.current.duration / 1000 : 0);
  }

  makeDeck() {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous'; // needed to route progressive streams through Web Audio
    return { audio, hls: null, track: null };
  }

  /** Wire a deck's media events. Only the active deck drives the UI; the fading one stays quiet. */
  bindDeck(deck) {
    const a = deck.audio;
    const live = (fn) => (...args) => { if (this.deck === deck) fn(...args); };
    a.addEventListener('timeupdate', live(() => {
      this.emit('time', a.currentTime, this.duration);
      this.checkCrossfade();
    }));
    a.addEventListener('durationchange', live(() => { this.emit('time', a.currentTime, this.duration); this.emit('timeline'); }));
    a.addEventListener('play', live(() => { this.emit('state'); this.updateMediaSession(); }));
    a.addEventListener('pause', live(() => { this.emit('state'); this.updateMediaSession(); this.saveSession(); }));
    a.addEventListener('pause', () => {
      if (this.fading?.style === 'dropcut' && !this.fading.aborting && (this.fading.incoming === deck || this.fading.outgoing === deck)) this.holdFade();
    });
    a.addEventListener('waiting', live(() => this.emit('buffering', true)));
    a.addEventListener('playing', live(() => this.emit('buffering', false)));
    a.addEventListener('ended', live(() => this.onEnded()));
    a.addEventListener('seeked', live(() => { this.saveSession(); this.emit('timeline'); }));
    a.addEventListener('seeking', () => {
      if (this.deck === deck && this.mixOutcome?.mixEnd != null) this.clearMixOutcome();
      if (this.fading?.dropScheduled && (this.fading.incoming === deck || this.fading.outgoing === deck)) {
        this.cutFade();
        this.stopLock();
      }
    });
    // a new source can reset the rate, so put it back once the media is known
    a.addEventListener('loadedmetadata', () => this.applySpeed(a));
  }

  // ---- speed: Normal / Nightcore / Slowed / Custom ----------------------------

  /** Rate and pitch behavior for the current Speed settings */
  get speedInfo() {
    switch (settings.speedMode) {
      case 'nightcore': return { rate: 1.25, keepPitch: false };
      case 'slowed': return { rate: 0.8, keepPitch: false };
      case 'custom': return { rate: clampSpeed(settings.playbackSpeed), keepPitch: settings.keepPitch !== false };
      default: return { rate: 1, keepPitch: true };
    }
  }

  get rate() { return this.speedInfo.rate; }

  /** Short text for the player bar button: "1×", "1.25×", "NC", "SL" */
  get speedLabel() {
    if (settings.speedMode === 'nightcore') return 'NC';
    if (settings.speedMode === 'slowed') return 'SL';
    return `${+this.rate.toFixed(2)}×`;
  }

  applySpeed(audio) {
    const { rate, keepPitch } = this.speedInfo;
    audio.preservesPitch = keepPitch;
    audio.defaultPlaybackRate = rate; // survives loading a new source
    audio.playbackRate = rate;
  }

  /** Apply the speed settings to both decks when they change */
  syncSpeed() {
    const { rate, keepPitch } = this.speedInfo;
    const key = `${settings.speedMode}|${rate}|${keepPitch}`;
    if (key === this.speedKey) return;
    if (this.fading?.style === 'dropcut') this.cutFade();
    this.speedKey = key;
    this.decks.forEach(deck => this.applySpeed(deck.audio));
    if (this.lock) this.lock.setBaseRate(rate); // a beat-matched song follows the new speed too
    if (this.tempoRelease) this.tempoRelease.setBaseRate(rate);
    this.emit('speed', rate);
  }

  setSpeedMode(mode) { saveSettings({ speedMode: mode }); }

  /** A numeric speed always means Custom mode */
  setSpeed(value) { saveSettings({ speedMode: 'custom', playbackSpeed: +clampSpeed(Math.round(value / 0.05) * 0.05).toFixed(2) }); }

  nudgeSpeed(delta) {
    this.setSpeed(this.rate + delta);
    toast(`Speed ${this.speedLabel}`);
  }

  /**
   * Play a list of tracks starting at index.
   * context: { label: 'Likes', href: '#/library/likes' } shown in the queue panel
   */
  playList(tracks, index = 0, context = null) {
    this.queueRev++;
    // something new entirely: says nothing about the last mix
    if (this.mixOutcome) { clearTimeout(this.mixOutcome.timer); this.mixOutcome = null; }
    const playable = tracks.filter(t => t && t.kind !== 'playlist');
    const start = playable.indexOf(tracks[index]);
    this.queue = playable.slice();
    this.index = Math.max(0, start);
    this.context = context;
    this.original = null;
    if (this.shuffle) this.applyShuffle();
    this.emit('queue');
    const started = this.load();
    if (this.shuffle) this.shuffleWholeCollection();
    return started;
  }

  /** Turn shuffle on and start a random track; the whole collection gets shuffled in */
  async shufflePlay(tracks, context = null) {
    let playable = tracks.filter(t => t && t.kind !== 'playlist');
    // load the whole list first, so the first song is random across all of it, not just the loaded page
    if (context && context.loadAll) {
      const slow = setTimeout(() => toast('Loading the whole list to shuffle…'), 700);
      try {
        const all = (await context.loadAll()).filter(t => t && t.kind !== 'playlist');
        if (all.length > playable.length) playable = all;
      } catch (e) { /* shuffle what's loaded */ } finally {
        clearTimeout(slow);
      }
    }
    if (!playable.length) return;
    if (!this.shuffle) {
      this.shuffle = true;
      saveSettings({ shuffle: true });
      this.emit('modes');
    }
    return this.playList(playable, Math.floor(Math.random() * playable.length), context);
  }

  /** Play a single track (keeps it as a one-item queue unless it's already queued) */
  playTrack(track, context) {
    const existing = this.queue.findIndex(t => t.id === track.id);
    if (existing > -1) return this.jump(existing);
    return this.playList([track], 0, context);
  }

  /** Same track: toggle pause. Otherwise play list from index */
  toggleOrPlay(tracks, index, context) {
    const track = tracks[index];
    if (this.current && track && this.current.id === track.id) return this.toggle();
    return this.playList(tracks, index, context);
  }

  playNext(track) {
    this.queueRev++;
    this.queue.splice(this.index + 1, 0, track);
    if (this.original) this.original.push(track);
    this.emit('queue');
    if (this.index === -1) { this.index = 0; this.load(); }
    toast(`"${track.title}" will play next`);
  }

  addToQueue(tracks) {
    this.queueRev++;
    tracks = [].concat(tracks);
    this.queue.push(...tracks);
    if (this.original) this.original.push(...tracks);
    this.emit('queue');
    if (this.index === -1) { this.index = 0; this.load(); }
    toast(tracks.length === 1 ? `Added "${tracks[0].title}" to the queue` : `Added ${tracks.length} tracks to the queue`);
  }

  removeFromQueue(position) {
    if (position === this.index) return;
    this.queueRev++;
    const [track] = this.queue.splice(position, 1);
    if (position < this.index) this.index--;
    // keep the un-shuffled copy in sync, or the track comes back when shuffle is turned off
    if (this.original) {
      const at = this.original.indexOf(track);
      if (at !== -1) this.original.splice(at, 1);
    }
    this.emit('queue');
  }

  moveInQueue(from, to) {
    this.queueRev++;
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, track);
    if (from === this.index) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.emit('queue');
  }

  clearQueue() {
    this.queueRev++;
    const current = this.current;
    this.queue = current ? [current] : [];
    this.index = current ? 0 : -1;
    this.original = null;
    this.emit('queue');
  }

  jump(position) {
    this.noteSkip();
    this.index = position;
    this.emit('queue');
    return this.load();
  }

  /** A downloaded file when there is one (works offline, artist's original quality), else the stream */
  async streamOf(track) {
    await offline.init();
    return offline.has(track.id) ? offline.streamFor(track.id) : api.streamFor(track);
  }

  /** Load the current queue entry. autoplay=false is used when restoring the last session */
  async load({ autoplay = true, startAt = 0 } = {}) {
    const track = this.current;
    if (!track) return;
    const loadId = ++this.loadId;
    this.cutFade();
    this.stopLock();
    if (this.mixOutcome && this.mixOutcome.trackId !== track.id) { clearTimeout(this.mixOutcome.timer); this.mixOutcome = null; }
    this.dropPreroll(this.prepared);
    this.decks.forEach(deck => { this.stopListening(deck.audio); this.beats.unwatch(deck.audio); });
    this.prepared = null;
    this.loading = true;
    this.normalizer.init();
    this.normalizer.setActive(this.audio);
    this.normalizer.startTrack(track.id);
    this.emit('track', track);
    this.emit('buffering', true);

    let stream;
    try {
      stream = await this.streamOf(track);
    } catch (error) {
      if (loadId !== this.loadId) return;
      this.loading = false;
      this.emit('buffering', false);
      toast(error && error.data === 'protected'
        ? `"${track.title}" is copy-protected and only plays in SoundCloud's own app. Use Open in SoundCloud on the track.`
        : `Can't play "${track.title}"`, 'error');
      // skip unplayable tracks, but stop if the whole queue is unplayable
      if (this.index < this.queue.length - 1) setTimeout(() => loadId === this.loadId && this.next(true), 800);
      return;
    }
    if (loadId !== this.loadId) return;

    Object.assign(track, stream.track);
    if (stream.snipped) toast('Only a 30 second preview is available for this track');
    this.attach(stream, autoplay, startAt);
    this.loading = false;
    if (!autoplay) this.emit('buffering', false);
    this.updateMediaSession();
    this.emit('track', track);
    if (autoplay) this.notify(track);
    this.saveSession();
  }

  attach(stream, autoplay = true, startAt = 0, deck = this.deck, track = this.current) {
    const sourceId = deck.sourceId = (deck.sourceId || 0) + 1;
    if (deck.metadataSeek) deck.audio.removeEventListener('loadedmetadata', deck.metadataSeek);
    deck.metadataSeek = null;
    if (deck.hls) {
      deck.hls.destroy();
      deck.hls = null;
    }
    const audio = deck.audio;
    deck.track = track;
    deck.snipped = !!stream.snipped;
    this.applySpeed(audio);
    if (startAt > 0) {
      deck.metadataSeek = () => {
        if (deck.sourceId !== sourceId || deck.track !== track) return;
        deck.metadataSeek = null;
        audio.currentTime = Math.min(startAt, Math.max(0, audio.duration - 1));
      };
      audio.addEventListener('loadedmetadata', deck.metadataSeek, { once: true });
    }

    if (stream.protocol === 'hls' && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ maxBufferLength: 30, enableWorker: true });
      deck.hls = hls;
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (deck.sourceId === sourceId && autoplay) audio.play().catch(() => {});
      });
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (deck.sourceId !== sourceId) return;
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          // signed urls expire: re-resolve and resume where we were
          api.streamFor(track).then((fresh) => {
            if (deck.sourceId !== sourceId || deck.track !== track) return;
            this.attach(fresh, this.deckInUse(deck) && !audio.paused, audio.currentTime, deck, track);
          }).catch(() => toast('Playback stopped: network error', 'error'));
        }
      });
      hls.loadSource(stream.url);
      hls.attachMedia(audio);
    } else {
      audio.src = stream.url;
      if (autoplay) audio.play().catch(() => {});
    }
  }

  /** Stop a deck and let go of its stream */
  releaseDeck(deck) {
    deck.sourceId = (deck.sourceId || 0) + 1;
    if (deck.metadataSeek) deck.audio.removeEventListener('loadedmetadata', deck.metadataSeek);
    deck.metadataSeek = null;
    this.normalizer.clearDropCut(deck.audio);
    if (deck.hls) {
      deck.hls.destroy();
      deck.hls = null;
    }
    deck.track = null;
    deck.audio.pause();
    deck.audio.removeAttribute('src');
    deck.audio.load();
  }

  // ---- crossfade -----------------------------------------------------------------

  crossfadeSeconds() {
    const n = Number(settings.crossfade);
    return Number.isFinite(n) ? Math.min(12, Math.max(0, n)) : 0;
  }

  /** How the current song hands over to the next: its mix points (cues.js), or plain crossfade */
  upcomingTransition() {
    const prep = this.prepared && this.prepared.loadId === this.loadId ? this.prepared : null;
    const next = (prep && prep.track) || this.queue[this.index + 1] || null;
    return cues.transitionFor(this.current.id, next ? next.id : null, this.crossfadeSeconds());
  }

  /** Runs as the song plays: look up the next stream a little early, then start the overlap */
  checkCrossfade() {
    const audio = this.audio;
    if (this.stopAtTrackEnd || this.fading || this.loading || this.noCrossfade || !this.current) return;
    if (this.repeat === 'one' || audio.paused || audio.seeking || !this.normalizer.ctx) return;
    const dur = audio.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const t = this.upcomingTransition();
    const auto = this.autoMix;
    const wantsDrop = auto && (t.style || settings.transitionStyle) !== 'blend';
    // Drop confirmation needs a region around the hint, before the outgoing build starts.
    if (this.prepared && !this.prepared.wrap && this.prepared.track && this.queue[this.index + 1] !== this.prepared.track) {
      this.dropPreroll(this.prepared);
      this.prepared = null;
    }
    if (wantsDrop && !this.prepared) this.prepareNext();
    if (wantsDrop && this.prepared?.stream && !this.prepared.preroll) this.preroll(this.prepared);
    const plan = auto && !t.custom ? this.planMix(audio, dur) : null;
    if (plan && !plan.span) return; // still listening
    const span = plan ? plan.span : t.fade * (audio.playbackRate || 1); // media seconds the fade covers
    // a mix-out point wins, unless you've skipped well past it (then the song plays on)
    let mixAt = t.out != null && t.out < dur - 0.25 && audio.currentTime <= t.out + 3 ? t.out : null;
    if (plan) {
      if (dur < span * 2) return;
      mixAt = dur - span;
      this.mixAt = { loadId: this.loadId, at: mixAt };
    } else if (mixAt === null) {
      if (!t.fade) {
        if (!t.custom) return; // crossfade off and no mix points
        mixAt = dur - 0.2; // a clean, gapless cut into the next song's mix-in point
      } else {
        if (!t.custom && dur < span * 2) return; // too short to crossfade
        mixAt = dur - span;
      }
    }
    const prep = this.prepared;
    if (auto && prep?.stream && !prep.preroll && mixAt - audio.currentTime <= AUTO_LEAD * (audio.playbackRate || 1)) this.preroll(prep);
    if (auto && prep?.stream && prep.preroll?.done) {
      const selected = this.selectMixStyle(prep, t, plan?.grid || this.outgoingGrid(audio, dur));
      if (selected.style === 'dropcut' && prep.selected?.style === 'blend') {
        this.logMix('plan', `Re-planned as a drop cut: ${selected.reason}`);
      }
      prep.selected = selected;
      if (selected.style === 'dropcut') mixAt = selected.window.build;
      if (plan) Object.assign(plan, { style: selected.style, reason: selected.reason });
    }
    this.mixAt = { loadId: this.loadId, at: mixAt };
    const until = mixAt - audio.currentTime;
    if (auto && t.custom && until < AUTO_LISTEN) this.beats.watch(audio); // custom mixes get beat-matched too
    if (until > (auto ? (wantsDrop ? AUTO_LISTEN : AUTO_LEAD) * (audio.playbackRate || 1) : PREPARE_LEAD)) return;
    // Auto mix was switched on or off after the look-ahead: look again the new way
    if (this.prepared && this.prepared.loadId === this.loadId && this.prepared.auto !== auto) {
      this.dropPreroll(this.prepared);
      this.prepared = null;
    }
    if (!this.prepared || this.prepared.loadId !== this.loadId) { this.prepareNext(); return; }
    if (until > (prep?.selected?.style === 'dropcut' ? prep.selected.window.lead : 0) || !this.prepared.stream) return;
    this.startCrossfade();
  }

  get autoMix() { return settings.autoMix === true && !!this.normalizer.ctx; }

  /** Add a line to the Auto mix activity log (kind: plan, listen, mix, memory, good, bad) */
  logMix(kind, text) {
    this.mixLog.unshift({ at: Date.now(), kind, text });
    if (this.mixLog.length > 40) this.mixLog.length = 40;
    this.emit('automix');
  }

  /** A snapshot of what Auto mix is doing right now, for the live monitor in Settings */
  autoMixStatus() {
    const status = { on: this.autoMix, enabled: settings.autoMix === true, track: this.current, playing: this.playing };
    if (!this.current) return status;
    const audio = this.audio;
    const rate = audio.playbackRate || 1;
    status.memory = mixmemory.get(this.current.id, tempoOptions(this.current));
    status.structure = this.structureOf(this.current.id);
    status.listening = this.listening.has(audio);
    if (this.beats.isWatching(audio)) {
      status.heard = this.beats.heard(audio);
      status.live = orientGrid(this.beats.grid(audio, 20, status.structure.grid?.bpm),
        tempoOptions(this.current, status.structure.grid?.bpm));
    }
    if (this.mixPlan && this.mixPlan.loadId === this.loadId) status.plan = this.mixPlan;
    if (this.mixAt && this.mixAt.loadId === this.loadId && !this.fading) status.mixIn = (this.mixAt.at - audio.currentTime) / rate;
    const pre = this.prepared && this.prepared.loadId === this.loadId && this.prepared.preroll;
    if (pre) status.preroll = { track: pre.track, done: pre.done, grid: pre.grid, startAt: pre.startAt, heard: pre.done ? null : this.beats.heard(pre.deck.audio) };
    const f = this.fading;
    if (f) {
      const progress = f.startedAt === null || !this.normalizer.ctx ? f.progress : Math.max(0, Math.min(1, f.progress + (this.normalizer.ctx.currentTime - f.startedAt) / f.seconds));
      status.mix = { from: f.from, to: f.to, seconds: f.seconds, progress, bass: f.bass, dj: f.shapeIn ? f.shapeIn.dj : 0,
        style: f.style || 'blend', reason: f.reason, phase: f.schedule ? dropPhase(f.schedule, this.normalizer.ctx.currentTime) : null };
    }
    const L = this.lock;
    if (L) {
      const ahead = phaseError(L.match.gridOut, L.outgoing.currentTime, L.match.gridIn, L.incoming.currentTime);
      status.lock = { active: !!L.timer, tempo: L.match.ratio - 1, nudge: L.incoming.playbackRate / (L.target || 1) - 1,
        errorMs: ahead * L.match.gridOut.period / (L.outgoing.playbackRate || 1) * 1000 };
    }
    const o = this.mixOutcome;
    if (o) status.outcome = { listened: o.position != null && this.current.id === o.trackId ? Math.max(0, audio.currentTime - o.position) : null, during: !o.mixEnd };
    status.shuffleMode = this.shuffleMode;
    const next = this.queue[this.index + 1];
    if (next && this.autoMix) {
      const a = this.mixFeatures(this.current);
      const b = this.mixFeatures(next);
      status.upNext = { track: next, bpm: b.bpm, source: b.bpmSource, reasons: mixorder.blendCost(a, b).reasons };
    }
    return status;
  }

  // ---- Auto mix song memory: every play teaches it the song's tempo, beat and structure ----

  /** Start learning the song on this deck (mixmemory.js) */
  startListening(audio, track) {
    this.stopListening(audio);
    const deck = this.decks.find(d => d.audio === audio);
    // a 30 s preview isn't the song: its times don't match the full track
    if (!this.autoMix || !track || !deck || deck.snipped) return;
    this.beats.watch(audio);
    const opts = tempoOptions(track, mixmemory.get(track.id, tempoOptions(track))?.bpm);
    this.listening.set(audio, { trackId: track.id, track, listener: mixmemory.createListener(opts), after: -Infinity, duration: (track.duration || 0) / 1000 });
    this.guessFromWaveform(track);
  }

  /** The song stopped on this deck: save what this play taught us */
  stopListening(audio) {
    const l = this.listening.get(audio);
    if (!l) return;
    this.listening.delete(audio);
    this.feedOne(audio, l);
    const duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : l.duration;
    try {
      const summary = l.listener.summary(duration);
      if (summary) {
        this.mixFeatureCache.delete(l.trackId);
        const entry = mixmemory.learn(l.trackId, summary, tempoOptions(l.track)) || mixmemory.get(l.trackId);
        if (entry && (summary.grid || summary.drumsIn != null || summary.outroStart != null)) {
          const parts = [entry.bpm ? entry.bpm.toFixed(1) + ' BPM' : 'no clear beat'];
          if (entry.drumsIn != null) parts.push(entry.drumsIn > 1 ? 'drums come in at ' + mmss(entry.drumsIn) : 'drums from the start');
          if (entry.outroStart != null) parts.push('outro from ' + mmss(entry.outroStart));
          this.logMix('memory', `Remembered ${quote(l.track)}: ${parts.join(', ')} (heard ${entry.plays} time${entry.plays === 1 ? '' : 's'})`);
        }
      }
    } catch (e) { /* memory is a bonus; never break playback */ }
  }

  /** Once a second: hand the new beat readings to each listening song */
  feedMemory() {
    if (!this.autoMix) return;
    if (this.current && !this.listening.has(this.audio) && !this.loading && this.deck.track === this.current) this.startListening(this.audio, this.current);
    this.listening.forEach((l, audio) => this.feedOne(audio, l));
  }

  feedOne(audio, l) {
    const fresh = this.beats.since(audio, l.after);
    if (!fresh.length) return;
    l.after = fresh[fresh.length - 1].t;
    try { l.listener.add(fresh); } catch (e) { /* ignore */ }
  }

  /** First plays: a rough intro / outro from SoundCloud's waveform until the song has been heard */
  guessFromWaveform(track) {
    if (!track || this.waves.get(track.id)) return Promise.resolve();
    this.waves.set(track.id, null);
    if (this.waves.size > 200) this.waves.delete(this.waves.keys().next().value);
    return this.waveformOf(track).then((samples) => {
      if (samples) this.waves.set(track.id, mixmemory.fromWaveform({ samples, width: samples.length, height: 1 }, (track.full_duration || track.duration || 0) / 1000));
    });
  }

  /** SoundCloud's waveform for a track (normalized samples), fetched once */
  waveformOf(track) {
    if (!track) return Promise.resolve(null);
    const known = this.waveSamples.get(track.id);
    if (known !== undefined) return Promise.resolve(known instanceof Promise ? known : known);
    const pending = api.waveform(track).catch(() => null).then((samples) => {
      this.waveSamples.set(track.id, samples || null);
      if (this.waveSamples.size > 3000) this.waveSamples.delete(this.waveSamples.keys().next().value);
      this.mixFeatureCache.delete(track.id);
      return samples || null;
    });
    this.waveSamples.set(track.id, pending);
    return pending;
  }

  // ---- Mix order: shuffle that orders songs so each one blends into the next (mixorder.js) ----

  /** off | shuffle | mix (Mix order needs Auto mix) */
  get shuffleMode() {
    if (!this.shuffle) return 'off';
    return this.mixOrder && settings.autoMix === true ? 'mix' : 'shuffle';
  }

  /** The shuffle button: off → shuffle → Mix order (when Auto mix is on) → off */
  cycleShuffle() {
    const mode = this.shuffleMode;
    if (mode === 'shuffle' && settings.autoMix === true) return this.setMixOrder(true);
    if (this.mixOrder) { this.mixOrder = false; saveSettings({ mixOrder: false }); }
    this.toggleShuffle();
  }

  setMixOrder(on) {
    this.mixOrder = !!on;
    saveSettings({ mixOrder: this.mixOrder });
    if (this.shuffle) {
      // reorder what's coming (random or blending), keeping what played and the song already lined up
      this.reorderUpcoming(true);
      this.logMix('plan', this.mixOrder ? 'Mix order on: the queue now flows song to song' : 'Mix order off: back to a random shuffle');
    }
    this.emit('modes');
  }

  /** Turn on Mix order and play these tracks from index, the rest ordered to blend ("Mix from here") */
  mixFrom(tracks, index = 0, context = null) {
    if (settings.autoMix !== true) return this.playList(tracks, index, context);
    this.mixOrder = true;
    this.shuffle = true;
    saveSettings({ mixOrder: true, shuffle: true });
    this.emit('modes');
    return this.playList(tracks, index, context);
  }

  /** What Mix order knows about a track: tempo (memory, title, tags or waveform), genre, energy */
  mixFeatures(track) {
    if (!track) return null;
    const cached = this.mixFeatureCache.get(track.id);
    if (cached) return cached;
    const mem = mixmemory.get(track.id, tempoOptions(track));
    const wave = this.waveSamples.get(track.id);
    const f = mixorder.features(track, {
      memory: mem && mem.bpm ? { bpm: mem.bpm, confidence: mem.confidence } : null,
      waveform: Array.isArray(wave) ? wave : null
    });
    this.mixFeatureCache.set(track.id, f);
    if (this.mixFeatureCache.size > 5000) this.mixFeatureCache.delete(this.mixFeatureCache.keys().next().value);
    return f;
  }

  /** Songs in shuffle order after `after`: random, or in Mix order each blending into the next */
  shuffled(rest, after = this.current) {
    if (this.shuffleMode !== 'mix' || rest.length < 2) return randomOrder(rest);
    const items = after ? [after, ...rest] : rest.slice();
    const order = mixorder.orderForMixing(items.map(t => this.mixFeatures(t)), { start: 0 });
    const out = order.map(i => items[i]);
    if (after) out.shift();
    this.warmFeatures(rest);
    return out;
  }

  /** A whole new pass through the queue (repeat all): starts where the last song left off */
  wrapOrder() {
    if (this.shuffleMode !== 'mix') return randomOrder(this.queue);
    const current = this.current;
    return [...this.shuffled(this.queue.filter((t, i) => i !== this.index), current), ...(current ? [current] : [])];
  }

  /**
   * Reorder the songs still to come (after the current one, and after the next one when it's
   * already lined up for a crossfade). random: a fresh random order when Mix order is off.
   */
  reorderUpcoming(random = false) {
    if (!this.shuffle || this.index < 0) return;
    if (this.shuffleMode !== 'mix' && !random) return;
    const lined = this.prepared && this.prepared.loadId === this.loadId && this.prepared.track ? 1 : 0;
    const keep = this.index + 1 + (this.fading ? 0 : lined);
    if (this.queue.length - keep < 2) return;
    const anchor = this.queue[keep - 1];
    this.queue = [...this.queue.slice(0, keep), ...this.shuffled(this.queue.slice(keep), anchor)];
    this.emit('queue');
  }

  /**
   * Songs whose tempo isn't known from memory, title or tags: fetch their waveforms (a few at a
   * time, up to 60 per call) for a rough tempo, then reorder what's coming with the new knowledge.
   */
  warmFeatures(tracks) {
    if (this.shuffleMode !== 'mix') return;
    const todo = tracks.filter(t => t && this.waveSamples.get(t.id) === undefined && !this.mixFeatures(t).bpm).slice(0, 60);
    if (!todo.length) return;
    this.warmQueue = (this.warmQueue || []).concat(todo);
    this.warmRev = this.queueRev;
    if (this.warming) return;
    this.warming = true;
    const work = async () => {
      let learned = 0;
      while (this.warmQueue.length) {
        const batch = this.warmQueue.splice(0, 4);
        const results = await Promise.all(batch.map(t => this.waveformOf(t)));
        learned += results.filter(Boolean).length;
      }
      this.warming = false;
      // only if you haven't changed the queue yourself meanwhile (moved a song, started another list)
      if (learned && this.shuffleMode === 'mix' && this.warmRev === this.queueRev) this.reorderUpcoming();
    };
    work().catch(() => { this.warming = false; });
  }

  /** How queue[i] blends into queue[i + 1], for the queue panel (Mix order only) */
  blendNote(i) {
    if (this.shuffleMode !== 'mix' || !this.queue[i] || !this.queue[i + 1]) return null;
    try {
      const a = this.mixFeatures(this.queue[i]);
      const b = this.mixFeatures(this.queue[i + 1]);
      const note = mixorder.describeBlend(a, b);
      // unknown tempo: neither a good nor a bad sign
      return a.bpm && b.bpm ? note : { ok: null, text: note.text };
    } catch (e) {
      return null;
    }
  }

  /** Smarter autoplay: of the related songs, the ones that blend best, chained like a set */
  async blendingRelated(related, count = 10) {
    // a rough tempo for related songs without one, but don't hold up playback for long
    const unknown = related.filter(t => !this.mixFeatures(t).bpm);
    await Promise.race([Promise.all(unknown.map(t => this.waveformOf(t))), new Promise(r => setTimeout(r, 2500))]);
    const pool = related.slice();
    const out = [];
    let last = this.current;
    while (out.length < count && pool.length) {
      const [best] = mixorder.pickNext(this.mixFeatures(last), pool.map(t => this.mixFeatures(t)), { count: 1 });
      const pick = pool.splice(best == null ? 0 : best, 1)[0];
      out.push(pick);
      last = pick;
    }
    if (out[0]) {
      const f = this.mixFeatures(out[0]);
      this.logMix('plan', `Autoplay picked ${out.length} related songs that blend, starting with "${(out[0].title || '').slice(0, 60)}"${f.bpm ? ` (${Math.round(f.bpm)} BPM)` : ''}`);
    }
    return out;
  }

  /** What Auto mix knows about a song's structure: its memory, else the waveform guess */
  structureOf(trackId) {
    const track = this.queue.find(t => t.id === trackId);
    const remembered = mixmemory.get(trackId);
    const mem = remembered && orientGrid(remembered, tempoOptions(track, remembered.bpm));
    const wave = this.waves.get(trackId);
    return {
      grid: memoryGrid(mem),
      drumsIn: mem && mem.drumsIn != null ? mem.drumsIn : wave ? wave.drumsIn : null,
      outroStart: mem && mem.beatToEnd ? null : mem && mem.outroStart != null ? mem.outroStart : wave ? wave.outroStart : null
    };
  }

  /**
   * Where the next song starts in an Auto mix: its own mix-in point if it has one; otherwise, when
   * its intro has no drums for a while, late enough that its drums arrive at the bass swap.
   */
  autoStartAt(track, cueIn) {
    if (cueIn > 0 || !this.mixPlan) return Math.max(0, cueIn || 0);
    const known = this.structureOf(track.id);
    if (!(known.drumsIn > 4)) return 0;
    const half = this.mixPlan.span / (this.audio.playbackRate || 1) / 2 * this.rate;
    let start = Math.max(0, known.drumsIn - half);
    const g = known.grid;
    if (g) start = Math.max(0, g.offset + Math.round((start - g.offset) / g.period) * g.period);
    // never so late that the song can't finish the mix and play on for a while after it
    const length = (track.duration || 0) / 1000;
    const room = length - half * 2 - 30;
    return room > 0 ? Math.min(start, room) : 0;
  }

  // ---- Auto mix learning: did the listener keep the song we mixed into? ----

  /** The listener skipped or went back. A plain skip says nothing about the mix (they may just not want that song): only a thumbs rating counts, so this just ends the listening window. */
  noteSkip() {
    this.clearMixOutcome();
  }

  /** The genre family (mixorder.js) of a track, for learning per genre */
  mixFamily(track) {
    return mixorder.genreFamily({ ...this.mixFeatures(track), title: track?.title });
  }

  /** The transition you can rate right now: { track, style } from when the incoming song takes over until the listening window ends, else null */
  get mixRating() {
    const o = this._mixOutcome;
    return o?.rateable && this.current?.id === o.trackId ? { track: this.current, style: o.choice.style } : null;
  }

  /** Tell the thumbs control when it should appear or disappear */
  syncMixRating() {
    const rating = this.mixRating;
    const shown = rating ? this._mixOutcome : null;
    if (shown === this._ratingShown) return;
    this._ratingShown = shown;
    this.emit('mixrate', rating);
  }

  /** The incoming song has taken over: let the listener rate this transition */
  openMixRating(track) {
    const o = this._mixOutcome;
    if (!o || o.trackId !== track.id) return;
    o.rateable = true;
    this.syncMixRating();
  }

  /** Thumbs up ('good') or down ('bad') for the transition in the listening window. Records it now and ends the window. Returns false when there is nothing to rate. */
  rateMix(outcome) {
    const rating = this.mixRating;
    if (!rating || (outcome !== 'good' && outcome !== 'bad')) return false;
    const { choice } = this._mixOutcome;
    this.clearMixOutcome();
    mixlearn.record(choice, outcome);
    this.logMix(outcome, `You rated the ${choice.style === 'dropcut' ? 'drop cut' : 'smooth blend'} into ${quote(rating.track)}: ${outcome} (learning for ${mixlearn.describeBucket(choice.bucket)})`);
    return true;
  }

  clearMixOutcome() {
    if (this.mixOutcome) clearTimeout(this.mixOutcome.timer);
    this.mixOutcome = null;
  }

  /**
   * Auto mix: how long the current song's ending mix lasts. Listens to the last minute of the song,
   * then settles on a length (16 or 32 beats) once the mix is near. { span: 0 } while still listening.
   */
  planMix(audio, dur) {
    const previous = this.mixPlan?.loadId === this.loadId ? this.mixPlan : null;
    if (previous?.grid) {
      const oriented = orientGrid(previous.grid, tempoOptions(this.current, this.structureOf(this.current.id).grid?.bpm));
      if (oriented.period === previous.grid.period) return previous;
    } else if (previous && audio.currentTime - previous.checkedAt < 2) return previous;
    const rate = audio.playbackRate || 1;
    const left = dur - audio.currentTime;
    if (left < AUTO_LISTEN * rate) this.beats.watch(audio);
    // decide just before the longest mix's look-ahead would have to begin
    if (left > (MAX_MIX_SECONDS + AUTO_LEAD + 1) * rate) return { span: 0 };
    const known = this.structureOf(this.current.id);
    const grid = this.outgoingGrid(audio, dur);
    // learned taste for this genre and tempo: a small variation is tried each time (mixlearn.js).
    // The family is the outgoing song's: its genre and tempo set the mood of the mix.
    const choice = previous && !grid ? previous.choice : mixlearn.choose(mixlearn.bucketFor(grid?.bpm, this.mixFamily(this.current)));
    let span = mixSeconds(grid, rate, choice.params.length);
    // a song whose outro is known: mix over the whole outro, in whole bars
    const outro = known.outroStart != null ? dur - known.outroStart : 0;
    if (outro >= 6 * rate && outro <= MAX_MIX_SECONDS * rate) {
      const bar = grid ? 4 * grid.period : 0;
      span = bar && Math.floor(outro / bar) * bar >= 6 * rate ? Math.floor(outro / bar) * bar : outro;
    }
    this.mixPlan = { loadId: this.loadId, grid, span, choice, checkedAt: audio.currentTime };
    const tempo = grid ? `${grid.bpm.toFixed(1)} BPM ${grid.to != null ? 'heard just now' : 'from memory or this play'}` : 'no clear beat';
    const beatsLong = grid ? Math.round(span / grid.period) : 0;
    if (!previous || grid) this.logMix('plan', `Planned the mix out of ${quote(this.current)}: ${tempo}, ${(span / rate).toFixed(1)} s${beatsLong ? ` (${beatsLong} beats)` : ''}${outro >= 6 * rate && outro <= MAX_MIX_SECONDS * rate ? ' over its outro' : ''}, trying ${Math.round(choice.params.length * 100)}% length`);
    return this.mixPlan;
  }

  /** Use a recent drum region, then the grid already learned in this play or memory. */
  outgoingGrid(audio, dur) {
    const known = this.structureOf(this.current.id).grid;
    const l = this.listening.get(audio);
    if (l) this.feedOne(audio, l);
    const learned = l?.listener.summary(dur)?.grid;
    const steady = known || memoryGrid(learned);
    const heard = this.beats.grid(audio, 20, steady?.bpm);
    const grid = orientGrid(heard || steady, tempoOptions(this.current, steady?.bpm));
    if (!grid) return null;
    const anchor = known?.downbeat ?? learned?.downbeat ?? grid.offset;
    return { ...grid, downbeat: grid.offset + Math.round((anchor - grid.offset) / grid.period) * grid.period };
  }

  /** Fit the roll before any confirmed drop, including a short first drop. */
  dropWindow(grid, drop, match, transition, variant = 'roll', audio = this.audio, track = this.current, margin = 0.3) {
    return futureWindow(grid, audio.duration, { now: audio.currentTime, rate: audio.playbackRate || 1,
      dropTime: drop.time, ratio: match.ratio, out: transition.out,
      outroStart: this.structureOf(track.id).outroStart, variant, margin });
  }

  selectMixStyle(prep, transition, gridOut) {
    if ((transition.style || settings.transitionStyle) === 'blend') return planStyle({ style: 'blend' });
    const entry = mixmemory.get(prep.track.id, tempoOptions(prep.track));
    const pre = prep.preroll;
    const gridIn = pre?.dropGrid || pre?.grid || memoryGrid(entry);
    const drop = pre?.drop || (!pre?.candidate ? entry?.drop : null);
    if (!drop) return planStyle({ drop: null });
    const selected = planStyle({ style: settings.transitionStyle, pair: transition, drop, gridOut,
      features: [this.current, prep.track].map(track => ({ ...this.mixFeatures(track), title: track.title })),
      rejected: mixlearn.avoidsDropCut(mixlearn.bucketFor(gridOut?.bpm, this.mixFamily(this.current))),
      ready: !prep.dropFailed && !!pre?.done && !prep.stream.snipped && pre.deck !== this.deck && pre.deck.track === prep.track });
    if (selected.style !== 'dropcut') return selected;
    // There is no audible overlap to tempo-match. Pre-roll at the outgoing rate
    // and position the incoming phrase downbeat at the outgoing cut instead.
    const timingGrid = selected.variant === 'roll' ? gridOut :
      { bpm: 120 / (this.audio.playbackRate || 1), period: 0.5 * (this.audio.playbackRate || 1), offset: 0, confidence: 0 };
    const match = { gridOut: timingGrid, gridIn: gridIn || timingGrid, ratio: 1 };
    const window = this.dropWindow(timingGrid, drop, match, transition, selected.variant);
    const rate = this.audio.playbackRate || 1, inRate = rate * match.ratio;
    const launch = window && Math.max(this.audio.currentTime, window.build - window.lead);
    const seconds = window && (window.cut - launch) / rate;
    // The audible drop respects mix-in markers; silent pre-roll may precede them.
    if (!window || window.build < this.audio.currentTime - 0.1 ||
        drop.time - seconds * inRate < 0 || drop.time < transition.in || window.cut <= this.audio.currentTime + 2 * rate) {
      return { style: 'blend', reason: 'Not enough room for the drop build: smooth blend' };
    }
    if (!this.dropBuffered(pre.deck.audio, drop.time - seconds * inRate, drop.time + match.gridIn.period * 2)) {
      const staged = drop.time - (window.cut - window.build + window.lead) * match.ratio;
      if (staged >= 0 && (pre.staged == null || Math.abs(pre.staged - staged) > 0.1)) {
        pre.staged = staged;
        pre.deck.audio.currentTime = staged;
      }
      // Buffering and seek completion are checked again before the graph is armed.
    }
    return { ...selected, window, match, transition };
  }

  /** readyState describes the current position only, not a distant seek target. */
  dropBuffered(audio, from, to) {
    const ranges = audio.buffered;
    for (let i = 0; i < (ranges?.length || 0); i++) {
      if (ranges.start(i) <= from + 0.02 && ranges.end(i) >= to) return true;
    }
    return false;
  }

  /** Auto mix: play the next song silently on the idle deck for a few seconds to learn its beat */
  preroll(prep) {
    const norm = this.normalizer;
    const deck = this.decks[1 - this.active];
    if (this.fading || this.audio.paused || !norm.addDeck(deck.audio)) return;
    const transition = cues.transitionFor(this.current.id, prep.track.id);
    const remembered = mixmemory.get(prep.track.id, tempoOptions(prep.track));
    const wantsDrop = !prep.dropFailed && !prep.stream.snipped && (transition.style || settings.transitionStyle) !== 'blend';
    const candidate = wantsDrop ? (remembered?.drop?.confidence >= 0.65 ? null :
      this.waves.get(prep.track.id)?.dropCandidates?.find(c => c.time >= transition.in && !(prep.rejectedDrops || []).includes(c.time))) : null;
    const drop = wantsDrop && remembered?.drop?.confidence >= 0.65 ? remembered.drop : null;
    // Early preparation is for drop candidates only. Ordinary intro analysis still waits for
    // the blend plan, so its drums-in start point and normalization stay unchanged.
    if (!candidate && !drop && !transition.custom && !this.mixPlan) return;
    const blendStart = this.autoStartAt(prep.track, transition.in || 0);
    const startAt = candidate ? Math.max(0, candidate.time - 12) : blendStart;
    const opts = tempoOptions(prep.track, remembered?.bpm);
    const knownBpm = opts.bpm || null;
    let lastProgress = Date.now(), lastPosition = startAt;
    this.releaseDeck(deck);
    norm.setFade(deck.audio, 0);
    norm.holdBass(deck.audio, true, 0);
    const pre = prep.preroll = { deck, track: prep.track, startAt: blendStart, candidate, drop, grid: null, done: false, timer: null };
    if (candidate) this.logMix('listen', `Checking drop at ${mmss(candidate.time)} in ${quote(prep.track)} ahead of the transition`);
    this.attach(prep.stream, true, startAt, deck, prep.track);
    this.beats.unwatch(deck.audio);
    this.beats.watch(deck.audio);
    pre.timer = setInterval(() => {
      // gone, or stuck (stalled stream, a song shorter than the listening time): give up on the beat
      if (this.audio.paused || deck.audio.currentTime > lastPosition + 0.05) {
        lastProgress = Date.now(); lastPosition = deck.audio.currentTime;
      }
      const stalled = !this.audio.paused && Date.now() - lastProgress > 20000;
      if (prep.preroll !== pre || deck.track !== pre.track) { this.endPreroll(pre); return; }
      if (stalled || deck.audio.ended) {
        if (candidate && prep.preroll === pre && deck.track === pre.track) {
          this.logMix('listen', `Drop at ${mmss(candidate.time)} not confirmed (0.00): analysis stream stalled or ended`);
          prep.dropFailed = true;
          this.dropPreroll(prep);
          this.preroll(prep);
        } else this.endPreroll(pre);
        return;
      }
      const heard = this.beats.heard(deck.audio);
      if (candidate) {
        if (deck.audio.currentTime < candidate.time + 12) return;
        const samples = this.beats.since(deck.audio, -Infinity).filter(s => s.t >= startAt && s.t <= candidate.time + 12);
        const confirmed = inspectDrop(samples, candidate, { ...remembered, ...opts, downbeat: remembered?.drop ? remembered.downbeat : null });
        if (confirmed.drop && confirmed.confidence >= 0.65) {
          pre.drop = confirmed.drop; pre.dropGrid = confirmed.grid;
          mixmemory.rememberDrop(pre.track.id, confirmed);
          this.mixFeatureCache.delete(pre.track.id);
          this.logMix('listen', `Drop at ${mmss(pre.drop.time)} confirmed (${confirmed.confidence.toFixed(2)}): ${confirmed.reason}`);
        } else {
          const reason = confirmed.drop ? 'bass contrast / beat confidence below 0.65' : confirmed.reason;
          this.logMix('listen', `Drop at ${mmss(candidate.time)} not confirmed (${confirmed.confidence.toFixed(2)}): ${reason}`);
          prep.rejectedDrops = [...(prep.rejectedDrops || []), candidate.time];
          // A rejected hint must use the ordinary intro analysis and start point for its blend.
          this.dropPreroll(prep);
          prep.dropFailed = !this.waves.get(prep.track.id)?.dropCandidates?.some(c =>
            c.time >= transition.in && !prep.rejectedDrops.includes(c.time));
          this.preroll(prep);
          return;
        }
        // The confirmed drop's local grid defines its beat spacing and octave.
        pre.grid = pre.dropGrid;
        this.endPreroll(pre);
        return;
      }
      if (heard < ANALYZE_SECONDS) return;
      pre.grid = orientGrid(this.beats.grid(deck.audio, 20, knownBpm), opts);
      // a drumless intro: keep listening a little longer for the beat to come in
      if (pre.grid || heard >= ANALYZE_MAX_SECONDS) this.endPreroll(pre);
    }, 250);
  }

  /** Stop listening to the pre-played song and wind it back to where it should start */
  endPreroll(pre) {
    if (pre.done) return;
    pre.done = true;
    clearInterval(pre.timer);
    pre.loudness = this.beats.loudness(pre.deck.audio);
    this.beats.unwatch(pre.deck.audio);
    if (pre.deck.track !== pre.track) return;
    this.logMix('listen', `Listened silently to the start of ${quote(pre.track)}: ${pre.grid ? pre.grid.bpm.toFixed(1) + ' BPM' : 'no beat yet'}${pre.startAt > 0 ? ', will start it at ' + mmss(pre.startAt) : ''}`);
    pre.deck.audio.pause();
    // Stage the seek early enough for HLS to fetch its pre-roll and drop. The final launch
    // position is recomputed on the outgoing clock, and must be inside one buffered range.
    const gridOut = this.mixPlan?.grid || this.structureOf(this.current.id).grid;
    const match = pre.drop && { ratio: 1 };
    const transition = cues.transitionFor(this.current.id, pre.track.id);
    const window = match && this.dropWindow(gridOut, pre.drop, match, transition);
    // Even without an outgoing grid yet, keep the distant drop in the HLS buffer.
    const staged = pre.drop ? Math.max(0, pre.drop.time - (window ?
      (window.cut - window.build + window.lead) * match.ratio : MAX_MIX_SECONDS * this.rate + 2)) : pre.startAt;
    pre.staged = staged;
    pre.deck.audio.currentTime = this.clampStart(pre.deck.audio, staged);
  }

  /** A start point inside the song (a saved mix-in point can be past the end of a 30 s preview) */
  clampStart(audio, t) {
    const d = audio.duration;
    return isFinite(d) && d > 0 ? Math.min(t, Math.max(0, d - 1)) : t;
  }

  /** Whether a deck is playing for the listener (or pre-playing for Auto mix) */
  deckInUse(deck) {
    const pre = this.prepared && this.prepared.preroll;
    return deck === this.deck || (!!this.fading && this.fading.incoming === deck) || (!!pre && pre.deck === deck && !pre.done);
  }

  /** A pre-played song that won't be used after all (skip, queue edit): free its deck */
  dropPreroll(prep) {
    const pre = prep && prep.preroll;
    if (!pre) return;
    prep.preroll = null;
    this.endPreroll(pre);
    const busy = pre.deck === this.deck || (this.fading && (pre.deck === this.fading.outgoing || pre.deck === this.fading.incoming));
    if (!busy && pre.deck.track === pre.track) this.releaseDeck(pre.deck);
  }

  /** Work out what next() would play, without moving there yet, and resolve its stream */
  async prepareNext() {
    const prep = { loadId: this.loadId, from: this.index, track: null, stream: null, failed: false, wrap: false, order: null, auto: this.autoMix, preroll: null };
    this.prepared = prep;
    try {
      if (this.index < this.queue.length - 1) {
        prep.track = this.queue[this.index + 1];
      } else if (this.repeat === 'all') {
        prep.wrap = true;
        prep.order = this.shuffle ? this.wrapOrder() : null;
        prep.track = (prep.order || this.queue)[0];
      } else if (settings.autoplayRelated && this.current) {
        const added = await this.appendRelated();
        if (prep.loadId !== this.loadId || this.index !== prep.from) return;
        prep.track = added ? this.queue[this.index + 1] : null;
      }
      if (!prep.track) { prep.failed = true; return; }
      const wave = prep.auto ? this.guessFromWaveform(prep.track) : null;
      const stream = await this.streamOf(prep.track);
      if (wave) {
        let timer;
        await Promise.race([wave, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        clearTimeout(timer);
      }
      if (this.prepared !== prep) return;
      prep.stream = stream;
      if (prep.auto) {
        this.preroll(prep);
        // A slow waveform must still start analysis when it arrives after stream resolution.
        wave?.then(() => {
          if (this.prepared === prep && !prep.preroll) this.preroll(prep);
        });
      }
    } catch (e) {
      prep.failed = true; // the normal end-of-song path will deal with it
    }
  }

  /** Bring the next song in on the idle deck while the current one fades out */
  startCrossfade() {
    const prep = this.prepared;
    if (this.fading || !prep?.stream) return;
    this.prepared = null;
    // the queue may have been edited since we looked ahead; if so, look again
    const valid = prep.wrap
      ? this.repeat === 'all' && this.index === this.queue.length - 1
      : this.queue[this.index + 1] === prep.track && this.index === prep.from;
    if (!valid) { this.dropPreroll(prep); return; }

    const norm = this.normalizer;
    const outgoing = this.deck;
    const incoming = this.decks[1 - this.active];
    if (!norm.addDeck(incoming.audio)) { this.noCrossfade = true; return; }
    const audio = outgoing.audio;
    const rate = audio.playbackRate || 1;
    const left = (audio.duration - audio.currentTime) / rate;
    // where the next song comes in and how long the overlap lasts (0 = a clean cut)
    const transition = cues.transitionFor(this.current.id, prep.track.id, this.crossfadeSeconds());
    const plan = prep.auto && !transition.custom && this.mixPlan && this.mixPlan.loadId === this.loadId ? this.mixPlan : null;
    const wantsDrop = prep.auto && (transition.style || settings.transitionStyle) !== 'blend';
    const plannedGrid = wantsDrop ? this.mixPlan?.grid || this.outgoingGrid(audio, audio.duration) : null;
    const liveGrid = prep.auto && plannedGrid ? this.beats.grid(audio, 20, plannedGrid.bpm) : null;
    const dropGrid = liveGrid?.confidence >= 0.25 && Math.abs(liveGrid.period / plannedGrid.period - 1) < 0.02 ?
      { ...liveGrid, downbeat: liveGrid.offset + Math.round(((plannedGrid.downbeat ?? plannedGrid.offset) - liveGrid.offset) / liveGrid.period) * liveGrid.period } : plannedGrid;
    const selected = prep.auto ? this.selectMixStyle(prep, transition, dropGrid) : { style: 'blend' };
    const dropcut = selected.style === 'dropcut';
    const fade = plan ? plan.span / rate : transition.fade;
    if (!dropcut && prep.selected?.style === 'dropcut') {
      const blendAt = transition.out != null && transition.out < audio.duration - 0.25 && audio.currentTime <= transition.out + 3 ?
        transition.out : audio.duration - (fade ? fade * rate : 0.2);
      if (blendAt > audio.currentTime) {
        // Readiness can change between planning and launch. Keep the original blend timing.
        prep.selected = selected;
        this.prepared = prep;
        return;
      }
    }
    const seconds = dropcut ? (selected.window.cut - audio.currentTime) / rate : fade ? Math.max(0.5, Math.min(fade, left)) : 0.1;
    // Auto mix: the next song is already loaded on the idle deck; line its beats up with this one's
    const pre = prep.preroll && prep.preroll.deck === incoming && incoming.track === prep.track ? prep.preroll : null;
    if (!dropcut && pre && (pre.candidate || pre.drop)) pre.startAt = plan ? this.autoStartAt(prep.track, transition.in || 0) : Math.max(0, transition.in || 0);
    const startAt = dropcut ? selected.drop.time - seconds * rate * selected.match.ratio :
      pre ? pre.startAt : plan ? this.autoStartAt(prep.track, transition.in || 0) : Math.max(0, transition.in || 0);
    let choice = plan ? plan.choice : dropcut ? mixlearn.choose(mixlearn.bucketFor(selected.match.gridOut.bpm, this.mixFamily(this.current))) : null;
    let match = null;
    if (pre) {
      this.endPreroll(pre);
      // the latest beat is the most exact, but outros often lose the kick and read at the wrong
      // tempo: when it disagrees with the tempo heard earlier (or remembered), trust that one
      const planned = this.mixPlan && this.mixPlan.loadId === this.loadId ? this.mixPlan.grid : null;
      const known = this.structureOf(this.current.id).grid;
      const fresh = this.beats.grid(audio, 20, (planned || known || {}).bpm || null);
      // nothing heard earlier or remembered: the stretch before the outro, rather than the outro itself
      const steady = planned || known || this.beats.grid(audio, 20, null, 12);
      const gridOut = fresh && (!steady || Math.abs(fresh.bpm / steady.bpm - 1) < 0.02) ? fresh : steady;
      // the next song's beat: heard while pre-playing, else from its memory
      const gridIn = pre.grid || this.structureOf(prep.track.id).grid;
      match = matchTempo(gridOut, gridIn, choice ? choice.params.stretch : 0.08);
      // the tempo only became clear now: file what this mix teaches under its real tempo range
      if (choice && mixlearn.parseBucket(choice.bucket)?.tempo === 'nobeat' && match) choice = Object.assign({}, choice, { bucket: mixlearn.rebucket(choice.bucket, match.gridOut.bpm) });
    }
    if (dropcut) match = selected.match;
    if (choice) choice = { ...choice, style: selected.style };

    const from = this.current, fromIndex = this.index, fromQueue = this.queue;
    // move to the next song exactly like next() would
    if (prep.wrap) {
      if (prep.order) this.queue = prep.order;
      this.index = 0;
    } else {
      this.index++;
    }
    const track = this.current;
    this.loadId++;
    if (!pre) this.releaseDeck(incoming);
    // Auto mix blends like a DJ and swaps the two songs' bass halfway through, over one bar (not for quick cuts)
    const bass = prep.auto && !dropcut && seconds >= 2;
    const grid = match ? match.gridOut : plan && plan.grid;
    const bar = grid ? 4 * grid.period / rate : 0;
    const bassWidth = bar ? Math.min(0.25, Math.max(0.06, bar / seconds)) : 0.2;
    const fading = this.fading = { from, to: track, outgoing, incoming, seconds, bass, bassWidth, shapeIn: null, shapeOut: null,
      progress: 0, startedAt: null, timer: null, fallback: null, style: selected.style, reason: selected.reason,
      dropcut: dropcut ? selected : null, prep, fromIndex, fromQueue };

    if (bass) fading.shapeIn = fading.shapeOut = { dj: choice ? choice.params.dj : 1 };
    // learning: was this transition kept? (decided after the mix, see finishFade / noteSkip)
    if (this.mixOutcome) clearTimeout(this.mixOutcome.timer);
    this.mixOutcome = choice ? { choice, trackId: track.id, mixEnd: null, timer: null } : null;
    // each deck has its own loudness level, so the outgoing song keeps its level to the end.
    // A song never heard before starts at the level measured against this one while pre-playing.
    const outLoudness = pre && pre.loudness ? this.beats.loudness(audio) : null;
    const louderDb = outLoudness ? 10 * Math.log10(pre.loudness / outLoudness) : null;
    norm.setActive(incoming.audio);
    norm.startTrack(track.id, louderDb);
    norm.setFade(incoming.audio, 0);
    norm.setFade(outgoing.audio, 1);
    norm.holdBass(incoming.audio, true, bass ? 0 : null, bassWidth);
    norm.holdBass(outgoing.audio, false, bass ? 0 : null, bassWidth);
    Object.assign(track, prep.stream.track);
    if (prep.stream.snipped) toast('Only a 30 second preview is available for this track');
    this.active = 1 - this.active;
    fading.onPlaying = () => { if (this.fading === fading) this.beginFade(); };
    incoming.audio.addEventListener('playing', fading.onPlaying, { once: true });
    // Keep the outgoing rate fixed through the build, including a previous mix's tempo glide.
    this.stopLock();
    if (dropcut) audio.playbackRate = rate;
    if (pre) {
      // start on the beat; BeatLock then keeps it there and matches the tempo
      incoming.audio.currentTime = this.clampStart(incoming.audio, !dropcut && match ? alignedStart(match, audio.currentTime, startAt) : startAt);
      if (match && !dropcut) this.lock = new BeatLock(audio, incoming.audio, match, this.rate);
      if (dropcut) incoming.audio.playbackRate = rate * match.ratio;
      incoming.audio.play().catch(() => {});
    } else {
      this.attach(prep.stream, true, startAt, incoming, track);
    }
    this.startListening(incoming.audio, track);
    this.logMix(dropcut ? 'plan' : 'mix', `${dropcut ? 'Planning a drop cut…' : 'Smooth blend into'} ${quote(track)}${selected.reason ? ': ' + selected.reason : ''}${match && !dropcut ? ', beats matched' : ''}${startAt > 0 ? ', from ' + mmss(startAt) : ''}`);
    // the fade starts once the new song is really playing, so no silence in the middle of it
    fading.fallback = setTimeout(() => {
      if (this.fading !== fading) return;
      if (fading.style === 'dropcut') this.beginDropCut(fading);
      else this.beginFade();
    }, dropcut ? 1000 : 3000);
    if (dropcut) this.waitForDropCut(fading);

    this.emit('queue');
    this.emit('track', track);
    this.emit('time', startAt, this.duration);
    this.updateMediaSession();
    this.notify(track);
    this.saveSession();
  }

  beginFade() {
    const f = this.fading;
    if (!f || f.startedAt !== null || this.audio.paused) return;
    if (f.style === 'dropcut') { this.beginDropCut(f); return; }
    clearTimeout(f.fallback);
    const norm = this.normalizer;
    const left = f.seconds * (1 - f.progress);
    if (!f.announced) { f.announced = true; this.emit('transition', { phase: 'start', from: f.from, to: f.to }); }
    f.startedAt = norm.ctx.currentTime;
    this.openMixRating(f.to);
    norm.fadeDeck(f.incoming.audio, true, left, f.progress, f.shapeIn);
    norm.fadeDeck(f.outgoing.audio, false, left, f.progress, f.shapeOut);
    if (f.bass) {
      norm.swapBass(f.incoming.audio, true, left, f.progress, f.bassWidth);
      norm.swapBass(f.outgoing.audio, false, left, f.progress, f.bassWidth);
    }
    clearTimeout(f.timer);
    f.timer = setTimeout(() => this.finishFade(f), left * 1000 + 100);
  }

  /** Retry seeks/buffering until the last possible two-bar build must start. */
  waitForDropCut(f) {
    if (f.armTimer || f.dropScheduled) return;
    const a = f.outgoing.audio, beat = f.dropcut.match.gridOut.period;
    const rate = a.playbackRate || 1;
    f.armDeadline = performance.now() + Math.max(0, (a.duration - a.currentTime - 8 * beat - Math.max(beat, 0.5 * rate)) / rate - 0.3) * 1000;
    f.armTimer = setInterval(() => this.beginDropCut(f), 50);
  }

  /** Media elements pre-roll silently; only the graph's clock opens the incoming drop. */
  beginDropCut(f) {
    if (this.fading !== f || f.dropScheduled || f.style !== 'dropcut') return;
    const norm = this.normalizer, ctx = norm.ctx, plan = f.dropcut;
    const a = f.outgoing.audio, b = f.incoming.audio;
    const rate = a.playbackRate || 1, beat = plan.match.gridOut.period / rate;
    this.waitForDropCut(f);
    if (performance.now() > f.armDeadline) {
      this.fallbackDropCut(f, 'Drop audio missed the readiness deadline');
      return;
    }
    if (plan.window.build < a.currentTime + 0.3 * rate) {
      const window = this.dropWindow(plan.match.gridOut, plan.drop, plan.match, plan.transition || {},
        plan.variant, a, f.from, 1.8) || this.dropWindow(plan.match.gridOut, plan.drop, plan.match, plan.transition || {},
        plan.variant, a, f.from, 0.3);
      if (!window) {
        this.fallbackDropCut(f, 'No future drop build fits');
        return;
      }
      plan.window = window;
    }
    const start = ctx.currentTime + (plan.window.build - a.currentTime) / rate;
    const length = (plan.window.cut - plan.window.build) / plan.match.gridOut.period;
    const schedule = rollSchedule(start, beat, length, plan.variant);
    const ready = !a.paused && !b.paused && !a.seeking && !b.seeking && a.readyState >= 3 && b.readyState >= 3;
    if (!schedule) {
      this.fallbackDropCut(f, 'No future drop build fits');
      return;
    }
    if (!ready) return;
    const baseRate = rate * plan.match.ratio;
    const error = (plan.drop.time - b.currentTime) / baseRate - (schedule.drop - ctx.currentTime);
    if (Math.abs(error) > (schedule.drop - ctx.currentTime) * 0.025) {
      // Re-plan/seek only the explicitly captured incoming deck, never this.audio.
      b.currentTime = plan.drop.time - (plan.window.cut - a.currentTime) * plan.match.ratio;
      return;
    }
    if (!this.dropBuffered(b, b.currentTime, plan.drop.time + plan.match.gridIn.period * 2)) return;
    // Both decks have finished seeking; commit only with an audio-clock margin.
    if (start < ctx.currentTime + 0.3) return;
    clearTimeout(f.fallback);
    clearInterval(f.armTimer);
    f.armTimer = null;
    f.schedule = schedule;
    f.seconds = schedule.end - start;
    f.startedAt = start;
    if (!norm.startDropCut(a, b, schedule)) {
      this.fallbackDropCut(f, 'Drop effects unavailable');
      return;
    }
    f.dropScheduled = true;
    f.announced = true;
    this.logMix('mix', `Drop cut into ${quote(f.to)}: ${plan.reason || f.reason || 'drop armed'}`);
    this.emit('transition', { phase: 'start', from: f.from, to: f.to, style: 'dropcut' });
    const tick = () => {
      if (this.fading !== f) return;
      const now = ctx.currentTime;
      const remaining = schedule.drop - now;
      if (remaining > 0) {
        const drift = (plan.drop.time - b.currentTime) / baseRate - remaining;
        const outDrift = (plan.window.cut - a.currentTime) / rate - remaining;
        if (a.paused || b.paused || a.seeking || b.seeking || a.readyState < 3 || b.readyState < 3 ||
            Math.abs(a.playbackRate - rate) > 0.0001 ||
            Math.abs(outDrift) > 0.04 || (remaining < beat * 2 && Math.abs(drift) > 0.025)) {
          this.fallbackDropCut(f, 'Stream or beat timing changed');
          return;
        }
        b.playbackRate = baseRate * (1 + Math.max(-0.025, Math.min(0.025, drift / Math.max(beat, remaining))));
      } else if (!f.landed) {
        const drift = (b.currentTime - plan.drop.time) / baseRate - (now - schedule.drop);
        if (b.paused || b.seeking || b.readyState < 3 || Math.abs(drift) > 0.04) {
          this.fallbackDropCut(f, 'Incoming stream missed the drop');
          return;
        }
        f.landed = true;
        this.openMixRating(f.to);
        b.playbackRate = baseRate;
        // Release from the actual matched rate without starting phase correction or resetting it.
        this.lock = new BeatLock(a, b, plan.match, this.rate, false);
        this.releaseLock();
      }
      const phase = dropPhase(schedule, now);
      if (phase !== f.phase) {
        f.phase = phase;
        this.logMix('mix', `Drop cut: ${phase}${phase === 'cut' ? ' · echo tail only' : ''}`);
      }
      if (now >= schedule.end) this.finishFade(f);
    };
    f.monitor = setInterval(tick, 20);
    tick();
  }

  fallbackDropCut(f, reason) {
    if (this.fading !== f) return;
    clearInterval(f.monitor);
    clearInterval(f.armTimer);
    f.armTimer = null;
    clearTimeout(f.fallback);
    if (f.onPlaying) f.incoming.audio.removeEventListener('playing', f.onPlaying);
    // This emergency blend didn't use the sampled blend parameters or complete a drop cut.
    this.clearMixOutcome();
    this.stopLock();
    this.applySpeed(f.incoming.audio);
    this.normalizer.clearDropCut(f.outgoing.audio);
    this.normalizer.setFade(f.incoming.audio, 0);
    this.normalizer.setFade(f.outgoing.audio, 1);
    if (f.incoming.audio.paused || f.incoming.audio.readyState < 3) {
      // Keep the playing deck when the silent pre-roll stalls. Retry this pair as a blend.
      this.fading = null;
      this.stopLock();
      this.stopListening(f.incoming.audio);
      this.releaseDeck(f.incoming);
      this.beats.unwatch(f.incoming.audio);
      this.queue = f.fromQueue;
      this.index = f.fromIndex;
      this.active = this.decks.indexOf(f.outgoing);
      this.loadId++;
      this.mixPlan = null;
      this.normalizer.setActive(f.outgoing.audio);
      this.normalizer.startTrack(f.from.id);
      if (this.mixOutcome) clearTimeout(this.mixOutcome.timer);
      this.mixOutcome = null;
      this.prepared = { ...f.prep, loadId: this.loadId, from: this.index, preroll: null, dropFailed: true };
      if (f.announced) this.emit('transition', { phase: 'end', from: f.from, to: f.to });
      this.logMix('mix', `${reason}: keeping the outgoing song, retrying a smooth blend`);
      this.emit('queue');
      this.emit('track', this.current);
      this.emit('time', this.audio.currentTime, this.duration);
      this.updateMediaSession();
      return;
    }
    f.style = 'blend';
    f.reason = `${reason}: smooth blend`;
    f.dropScheduled = false;
    f.schedule = null;
    f.startedAt = null;
    f.progress = 0;
    f.seconds = Math.max(0.25, Math.min(6, (f.outgoing.audio.duration - f.outgoing.audio.currentTime) / (f.outgoing.audio.playbackRate || 1)));
    this.logMix('mix', f.reason);
    this.beginFade();
  }

  /** Pausing mid-crossfade freezes the blend where it is */
  holdFade() {
    const f = this.fading;
    if (f?.style === 'dropcut') {
      // Delay feedback and scheduled gates cannot be rewound independently of the
      // shared AudioContext. Restore the outgoing song with a flat graph, then pause
      // it. Play resumes that song; the pair is retried as an ordinary blend.
      f.aborting = true;
      f.outgoing.audio.pause();
      f.incoming.audio.pause();
      this.fallbackDropCut(f, 'Drop cut paused; effects reset');
      this.audio.pause();
      return;
    }
    if (!f || f.startedAt === null) return;
    const norm = this.normalizer;
    f.progress = Math.min(1, f.progress + (norm.ctx.currentTime - f.startedAt) / f.seconds);
    f.startedAt = null;
    clearTimeout(f.timer);
    norm.holdFade(f.incoming.audio, true, f.progress, f.shapeIn);
    norm.holdFade(f.outgoing.audio, false, f.progress, f.shapeOut);
    if (f.bass) {
      norm.holdBass(f.incoming.audio, true, f.progress, f.bassWidth);
      norm.holdBass(f.outgoing.audio, false, f.progress, f.bassWidth);
    }
  }

  /** The fade is over: stop and detach the old deck */
  finishFade(f) {
    if (this.fading !== f) return;
    this.fading = null;
    if (f.announced) this.emit('transition', { phase: 'end', from: f.from, to: f.to });
    clearTimeout(f.timer);
    clearTimeout(f.fallback);
    clearInterval(f.monitor);
    clearInterval(f.armTimer);
    f.armTimer = null;
    if (f.onPlaying) f.incoming.audio.removeEventListener('playing', f.onPlaying);
    // Restoring the bypass must not expose dry outgoing audio while song memory is finalized.
    if (f.style === 'dropcut') this.normalizer.setFade(f.outgoing.audio, 0);
    this.normalizer.clearDropCut(f.outgoing.audio);
    this.stopListening(f.outgoing.audio);
    this.releaseDeck(f.outgoing);
    this.beats.unwatch(f.outgoing.audio);
    if (f.style === 'dropcut' && !f.landed) this.clearMixOutcome();
    const o = this.mixOutcome;
    if (o && o.trackId === f.to.id && !o.mixEnd) {
      o.mixEnd = performance.now();
      o.position = f.incoming.audio.currentTime;
      // the listener kept it once about 20 s more of the song has really played (checked every 10 s;
      // a pause or stall just waits, and it gives up after 5 minutes)
      let checks = 0;
      const check = () => {
        if (this.mixOutcome !== o) return;
        if (!this.current || this.current.id !== o.trackId) { this.mixOutcome = null; return; }
        if (this.audio.currentTime - o.position >= 20) {
          this.mixOutcome = null;
          mixlearn.record(o.choice, 'good');
          this.logMix('good', `You kept ${quote(this.current)} after a ${o.choice.style === 'dropcut' ? 'drop cut' : 'smooth blend'}: learning for ${mixlearn.describeBucket(o.choice.bucket)}`);
          return;
        }
        if (++checks > 30) { this.mixOutcome = null; return; }
        o.timer = setTimeout(check, 10000);
      };
      o.timer = setTimeout(check, 20000);
    }
    this.normalizer.setFade(f.outgoing.audio, 1);
    this.normalizer.setFade(f.incoming.audio, 1);
    this.normalizer.holdBass(f.outgoing.audio, false, null);
    this.normalizer.holdBass(f.incoming.audio, true, null);
    // the incoming song eases back to its own tempo
    if (this.lock?.incoming === f.incoming.audio) this.releaseLock();
  }

  /** Phase locking ends with the blend; its independent tempo glide can finish later. */
  releaseLock() {
    const lock = this.lock;
    if (!lock) return;
    this.lock = null;
    this.tempoRelease?.stop(this.rate);
    this.tempoRelease = lock;
    lock.release(() => { if (this.tempoRelease === lock) this.tempoRelease = null; });
  }

  /** Drop Auto mix's beat lock straight away (a skip or a new song) */
  stopLock() {
    this.lock?.stop(this.rate);
    this.tempoRelease?.stop(this.rate);
    this.lock = null;
    this.tempoRelease = null;
  }

  /** Manual skips cut cleanly: drop the fading deck now and bring the active one to full level */
  cutFade() {
    const f = this.fading;
    if (f) {
      this.finishFade(f);
      if (f.style === 'dropcut') { this.stopLock(); this.applySpeed(f.incoming.audio); }
    }
  }

  // ---- remember the session across restarts ----------------------------------

  /** Save what's playing, where, and the queue (slimmed down so it fits in storage) */
  saveSession() {
    if (!this.current) return;
    const slim = (t) => ({
      id: t.id, kind: 'track', title: t.title, duration: t.duration, full_duration: t.full_duration,
      artwork_url: t.artwork_url, permalink_url: t.permalink_url, waveform_url: t.waveform_url,
      station_urn: t.station_urn, genre: t.genre, playback_count: t.playback_count,
      likes_count: t.likes_count, reposts_count: t.reposts_count, comment_count: t.comment_count,
      user: t.user && { id: t.user.id, username: t.user.username, avatar_url: t.user.avatar_url, permalink_url: t.user.permalink_url }
    });
    // keep the queue around the current song, capped so storage never overflows
    const start = Math.max(0, this.index - 50);
    const queue = this.queue.slice(start, start + 500);
    const session = {
      queue: queue.map(slim),
      index: this.index - start,
      position: Math.floor(this.audio.currentTime || 0),
      context: this.context ? { label: this.context.label, href: this.context.href } : null,
      savedAt: Date.now()
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* storage full */ }
  }

  /** Put the last session back in the player bar, paused at the same spot */
  restoreSession() {
    if (settings.resumeSession === false || this.current) return false;
    let session;
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return false; }
    if (!session || !Array.isArray(session.queue) || !session.queue[session.index]) return false;
    this.queue = session.queue;
    this.index = session.index;
    this.context = session.context;
    this.original = null;
    this.emit('queue');
    this.load({ autoplay: false, startAt: session.position || 0 });
    return true;
  }

  toggle() {
    if (!this.current) return;
    if (this.audio.paused) this.play();
    else this.pause();
  }

  /** Both decks play / pause together while a crossfade is running */
  play() {
    if (!this.current) return;
    this.audio.play().catch(() => {});
    const pre = this.prepared && this.prepared.preroll;
    if (pre && !pre.done && pre.deck.track === pre.track) pre.deck.audio.play().catch(() => {});
    const f = this.fading;
    if (!f) return;
    if (!f.outgoing.audio.ended) f.outgoing.audio.play().catch(() => {});
    this.beginFade();
  }

  pause() {
    this.holdFade();
    this.audio.pause();
    if (this.fading) this.fading.outgoing.audio.pause();
    const pre = this.prepared && this.prepared.preroll;
    if (pre && !pre.done) pre.deck.audio.pause();
  }

  async next(auto = false) {
    const f = this.fading;
    if (!auto && f?.style === 'dropcut' && !f.landed) {
      // The target is already current during silent pre-roll. Next means land
      // this drop now, before queue navigation or related-track fetching.
      this.clearMixOutcome();
      f.aborting = true;
      this.cutFade();
      f.incoming.audio.currentTime = this.clampStart(f.incoming.audio, f.dropcut.drop.time);
      f.incoming.audio.play().catch(() => {});
      this.logMix('mix', 'Next during drop build: cut straight to the incoming drop');
      this.emit('time', this.audio.currentTime, this.duration);
      return;
    }
    if (!this.queue.length) return;
    if (!auto) this.noteSkip();
    if (this.index < this.queue.length - 1) {
      this.index++;
    } else if (this.repeat === 'all') {
      if (this.shuffle) this.queue = this.wrapOrder();
      this.index = 0;
    } else if (settings.autoplayRelated && this.current) {
      // like soundcloud.com: keep playing related tracks
      const added = await this.appendRelated();
      if (!added) return;
      this.index++;
    } else {
      return;
    }
    this.emit('queue');
    return this.load();
  }

  appendRelated() {
    const current = this.current;
    const queue = this.queue;
    const rev = this.queueRev;
    // the look-ahead and a press of Next can both ask: share one fetch
    const pending = this.relatedPending;
    if (pending && pending.current === current && pending.queue === queue) return pending.promise;
    let promise = null;
    promise = (async () => {
      try {
        const pager = api.relatedTracks(current.id);
        let related = (await pager.next()).filter(t => !queue.some(q => q.id === t.id));
        if (!related.length) return false;
        // with Auto mix on, keep the ones that blend best, in an order that flows
        related = this.autoMix ? await this.blendingRelated(related) : related.slice(0, 10);
        // something else started meanwhile (another list, a new queue): don't touch it
        if (this.queue !== queue || this.current !== current || this.queueRev !== rev) return false;
        related = related.filter(t => !this.queue.some(q => q.id === t.id));
        if (!related.length) return false;
        this.queue.push(...related);
        if (this.original) this.original.push(...related);
        return true;
      } catch (e) {
        return false;
      } finally {
        if (this.relatedPending && this.relatedPending.promise === promise) this.relatedPending = null;
      }
    })();
    this.relatedPending = { current, queue, promise };
    return promise;
  }

  prev() {
    if (this.audio.currentTime > 3 || this.index <= 0) {
      this.seek(0);
      return;
    }
    this.noteSkip();
    this.index--;
    this.emit('queue');
    return this.load();
  }

  onEnded() {
    if (this.stopAtTrackEnd) { this.emit('sleepend'); return; }
    if (this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      return;
    }
    this.next(true);
  }

  seek(seconds) {
    if (!this.current) return;
    this.clearMixOutcome();
    if (this.fading?.style === 'dropcut') { this.cutFade(); this.stopLock(); }
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.duration - 0.25));
  }

  seekBy(delta) { this.seek(this.audio.currentTime + delta); }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.muted && value > 0) this.muted = false;
    this.normalizer.setVolume(this.volume, this.muted);
    saveSettings({ volume: this.volume, muted: this.muted });
    this.emit('volume', this.volume, this.muted);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.normalizer.setVolume(this.volume, this.muted);
    saveSettings({ muted: this.muted });
    this.emit('volume', this.volume, this.muted);
  }

  setNormalize(on) {
    this.normalizer.setEnabled(on);
    saveSettings({ normalize: on });
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      this.applyShuffle();
      this.shuffleWholeCollection();
    }
    else if (this.original) {
      const current = this.current;
      this.queue = this.original;
      this.index = Math.max(0, this.queue.indexOf(current));
      this.original = null;
    }
    saveSettings({ shuffle: this.shuffle });
    this.emit('queue');
    this.emit('modes');
  }

  applyShuffle() {
    const current = this.current;
    this.original = this.queue.slice();
    const rest = this.shuffled(this.queue.filter((t, i) => i !== this.index), current);
    this.queue = current ? [current, ...rest] : rest;
    this.index = current ? 0 : -1;
  }

  /**
   * Lists like Likes load in pages. Load every remaining page of the list the queue
   * came from, then put the whole collection (minus the current song) in random order.
   */
  async shuffleWholeCollection() {
    const context = this.context;
    if (!context || !context.loadAll || this.loadingAll === context) return;
    this.loadingAll = context;
    let all;
    try {
      all = await context.loadAll();
    } catch (e) {
      return;
    } finally {
      this.loadingAll = null;
    }
    // the user may have started something else or turned shuffle off meanwhile
    if (this.context !== context || !this.shuffle) return;

    const current = this.current;
    const tracks = all.filter(t => t && t.kind !== 'playlist');
    if (tracks.length <= this.queue.length) return;
    const played = this.queue.slice(0, this.index);
    const rest = this.shuffled(tracks.filter(t => (!current || t.id !== current.id) && !played.some(p => p.id === t.id)), current);
    this.original = tracks;
    this.queue = [...played, ...(current ? [current] : []), ...rest];
    this.emit('queue');
    toast(`Shuffling all ${tracks.length} tracks`);
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    saveSettings({ repeat: this.repeat });
    this.emit('modes');
  }

  // ---- OS integration -------------------------------------------------------

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('seekto', (details) => this.seek(details.seekTime));
    ms.setActionHandler('seekbackward', () => this.seekBy(-10));
    ms.setActionHandler('seekforward', () => this.seekBy(10));
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const track = this.current;
    const cover = artwork(track.artwork_url || (track.user && track.user.avatar_url), 't500x500');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.user ? track.user.username : '',
      album: this.context ? this.context.label : 'SoundCloud',
      artwork: cover ? [{ src: cover, sizes: '500x500', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
  }

  notify(track) {
    if (!settings.notifications || document.hasFocus()) return;
    try {
      new Notification(track.title, {
        body: track.user ? track.user.username : '',
        icon: artwork(track.artwork_url || (track.user && track.user.avatar_url), 't300x300') || undefined,
        silent: true
      });
    } catch (e) { /* notifications unavailable */ }
  }
}

export const player = new Player();
