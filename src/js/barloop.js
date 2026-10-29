// Loop extension: repeat the last clean bars of a song by seeking its media element back on the bar line,
// so a blend has room to run (endings.js picks the bars). A media element cannot loop gaplessly, so each
// seek is issued a little early (the measured seek latency) and lands where the loop point would have been
// by the time sound resumes: the beat phase carries on and the beat lock sees no jump. If anything looks
// wrong (a slow or failed seek, a seek that isn't ours, the media stalling) the loop stops and tells the
// player, which finishes the mix without it.

const TICK_MS = 5;
const FIRST_LATENCY = 0.04;       // seconds of seek gap assumed before one has been measured
const MAX_LATENCY = 0.2;          // a seek slower than this makes the loop audibly gappy: give up
const MAX_PHASE_ERROR = 0.06;     // seconds the real gap may differ from the estimate before the beat is off
const SEEK_TIMEOUT = 0.5;         // seconds a seek may take to report back
const LATE = 0.3;                 // seconds past the loop point the poll may notice it and still seek

/** Whether the media element has [from, to] (seconds) buffered in one range, so a seek there is quick */
export function bufferedCovers(audio, from, to) {
  const ranges = audio.buffered;
  for (let i = 0; i < (ranges?.length || 0); i++) if (ranges.start(i) <= from + 0.02 && ranges.end(i) >= to) return true;
  return false;
}

export class BarLooper {
  /**
   * audio: the outgoing deck's media element. loop: { a, b, loops } (media seconds; plays a to b, loops extra times).
   * hooks: { onAbort(reason), onDone(), now() (ms clock, for tests) }
   */
  constructor(audio, loop, hooks = {}) {
    this.audio = audio;
    this.a = loop.a;
    this.b = loop.b;
    this.loops = loop.loops;
    this.onAbort = hooks.onAbort || (() => {});
    this.onDone = hooks.onDone || (() => {});
    this.now = hooks.now || (() => performance.now());
    this.passes = 0;       // seeks completed
    this.latency = FIRST_LATENCY;
    this.errors = [];      // measured gap minus estimate, per seek (for the log and tests)
    this.pending = null;
    this.finished = false;
    this.timer = null;
    this.onSeeking = () => { if (!this.pending && !this.finished) this.abort('the song was moved'); };
    this.onSeeked = () => this.seeked();
    this.onPause = () => {};
  }

  start() {
    if (this.timer || this.finished) return;
    this.audio.addEventListener('seeking', this.onSeeking);
    this.audio.addEventListener('seeked', this.onSeeked);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Stop watching without telling anyone (the mix ended, or the player already knows) */
  stop() {
    this.finished = true;
    clearInterval(this.timer);
    this.timer = null;
    this.pending = null;
    this.audio.removeEventListener?.('seeking', this.onSeeking);
    this.audio.removeEventListener?.('seeked', this.onSeeked);
  }

  abort(reason) {
    if (this.finished) return;
    this.stop();
    this.onAbort(reason);
  }

  tick() {
    const audio = this.audio;
    if (this.finished || audio.paused || audio.ended) return;
    const t = this.now();
    if (this.pending) {
      if ((t - this.pending.at) / 1000 > SEEK_TIMEOUT) this.abort('the seek did not finish');
      return;
    }
    if (audio.seeking) return; // the 'seeking' event judges it
    const rate = audio.playbackRate || 1;
    const c = audio.currentTime;
    if (c < this.b - this.latency * rate) return;
    if (c > this.b + LATE * rate) { this.abort('missed the loop point'); return; }
    // where the loop point will be when sound resumes: carry on from `a` by the part of the seek gap that passes
    const target = this.a + (c - this.b) + this.latency * rate;
    this.pending = { at: t, target, estimate: this.latency };
    try { audio.currentTime = target; } catch { this.abort('the seek failed'); }
  }

  seeked() {
    const pending = this.pending;
    if (!pending || this.finished) return;
    this.pending = null;
    const measured = (this.now() - pending.at) / 1000;
    const error = measured - pending.estimate;
    this.errors.push(error);
    if (measured > MAX_LATENCY) { this.abort(`seeking is slow here (${Math.round(measured * 1000)} ms)`); return; }
    if (Math.abs(error) > MAX_PHASE_ERROR) { this.abort(`the beat slipped by ${Math.round(error * 1000)} ms`); return; }
    this.latency = Math.min(0.15, Math.max(0.01, (this.latency + measured) / 2));
    this.passes++;
    if (this.passes >= this.loops) {
      this.stop();
      this.onDone();
    }
  }
}
