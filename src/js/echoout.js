// Echo-out: the DJ move for a song that ends abruptly or has no beat outro. The outgoing deck is fed through a
// tempo-synced feedback delay on a beat, its dry signal is cut over one beat, and the echo tail rings for a
// couple of bars while the next song comes in underneath. Like DropCutEffect this is a disposable graph: it is
// built when an echo-out starts and torn down when the mix ends, so an idle deck keeps its direct connection
// and spends no CPU. Times are AudioContext seconds.
//
//   source ─┬─ dry (1 → 0 over one beat) ───────────────────────────────┬─→ destination
//           └─ send (open for one beat) → delay ─┬─ wet ─────────────────┘
//                                         ↑      └─ high-pass → low-pass → feedback ┐
//                                         └─────────────────────────────────────────┘

const FEEDBACK = 0.55;
const HIGHPASS = 300;   // Hz: the repeats carry no bass, so they never mud up the incoming song's low end
const LOWPASS = 5500;   // Hz: and each repeat gets a little darker, like a tape echo
const SEND = 0.9;
const WET = 0.9;

/**
 * schedule: { start (the beat the dry signal starts to leave), beat (seconds), delay (seconds), end (when the
 * tail is gone), feedback? }
 */
export class EchoOutEffect {
  constructor(ctx, source, destination, schedule) {
    this.ctx = ctx;
    this.source = source;
    this.destination = destination;
    this.nodes = [];
    try {
      const node = (method, ...args) => { const n = ctx[method](...args); this.nodes.push(n); return n; };
      const gain = (value) => { const n = node('createGain'); n.gain.value = value; return n; };
      const { start, beat, end } = schedule;
      const cut = start + beat;
      this.input = gain(1);
      const dry = gain(1), send = gain(0), feedback = gain(schedule.feedback ?? FEEDBACK), wet = gain(WET);
      const delay = node('createDelay', 8);
      delay.delayTime.value = schedule.delay;
      const highpass = node('createBiquadFilter'), lowpass = node('createBiquadFilter');
      highpass.type = 'highpass';
      highpass.frequency.value = HIGHPASS;
      lowpass.type = 'lowpass';
      lowpass.frequency.value = LOWPASS;
      this.input.connect(dry).connect(destination);
      this.input.connect(send).connect(delay);
      delay.connect(highpass).connect(lowpass).connect(feedback).connect(delay);
      delay.connect(wet).connect(destination);
      // dry out over one beat, from the beat the incoming song enters on
      dry.gain.setValueAtTime(1, start);
      dry.gain.linearRampToValueAtTime(0, cut);
      // the send takes in that one beat, then closes so the tail is only what was thrown
      send.gain.setValueAtTime(0, start);
      send.gain.linearRampToValueAtTime(SEND, start + 0.01);
      send.gain.setValueAtTime(SEND, cut - 0.01);
      send.gain.linearRampToValueAtTime(0, cut);
      // the tail fades away with the audio clock, so it also ends when the UI thread's timer is late
      wet.gain.setValueAtTime(WET, end - 0.4);
      wet.gain.linearRampToValueAtTime(0, end);
      feedback.gain.setValueAtTime(schedule.feedback ?? FEEDBACK, end - 0.4);
      feedback.gain.linearRampToValueAtTime(0, end);
      source.disconnect(destination);
      this.rerouted = true;
      source.connect(this.input);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (this.rerouted) {
      try { this.source.disconnect(this.input); } catch { /* already disconnected */ }
      this.source.connect(this.destination);
      this.rerouted = false;
    }
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }
}
