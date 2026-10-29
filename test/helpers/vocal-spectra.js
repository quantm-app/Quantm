// Synthetic spectra for the vocal meter, in the form the analyser reports them (dB per FFT bin).
export const SAMPLE_RATE = 44100;
export const FFT = 8192;
const HZ = SAMPLE_RATE / FFT;
const BINS = FFT / 2;

/** deterministic pseudo-random in [0, 1) */
const noise = (i, seed) => { const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };

/** A spectrum from linear power per bin, with a quiet floor under it */
function toDb(power) {
  return Float32Array.from(power, p => 10 * Math.log10(p + 1e-12));
}

function addPartial(power, hz, level, width = 0.55) {
  const bin = hz / HZ;
  for (let i = Math.max(1, Math.floor(bin) - 3); i <= Math.min(BINS - 1, Math.ceil(bin) + 3); i++) {
    power[i] += level * Math.exp(-(((i - bin) / width) ** 2));
  }
}

const floor = (power, level, seed) => { for (let i = 0; i < power.length; i++) power[i] += level * (0.5 + noise(i, seed)); };

/**
 * A voice: harmonics of f0 shaped by two formants (so the 300 Hz to 3.5 kHz band dominates), scaled by
 * `gain` (the syllable envelope) over a steady bass and a quiet floor.
 */
export function voice(gain = 1, f0 = 190) {
  const power = new Float64Array(BINS);
  floor(power, 1e-9, 1);
  addPartial(power, 55, 3e-6);   // a bass note that does not move
  for (let h = 1; h * f0 < 5000; h++) {
    const hz = h * f0;
    const formant = Math.exp(-(((hz - 600) / 500) ** 2)) + 0.8 * Math.exp(-(((hz - 2400) / 800) ** 2));
    addPartial(power, hz, gain * 4e-5 * formant);
  }
  return toDb(power);
}

/** A held pad: the same kind of partials, steady */
export function pad() {
  return voice(0.55, 220);
}

/** A drum pattern frame: a kick at low frequency and/or broadband noise bursts (flat, not tonal) */
export function drums({ kick = 0, snare = 0, seed = 1 } = {}) {
  const power = new Float64Array(BINS);
  floor(power, 2e-8, seed); // the music bed: well above the meter's silence gate
  if (kick) addPartial(power, 60, kick * 1e-4, 1.2);
  if (snare) for (let i = Math.round(200 / HZ); i < Math.round(9000 / HZ); i++) power[i] += snare * 2e-8 * (0.4 + noise(i, seed + 7));
  return toDb(power);
}

export const SILENCE = new Float32Array(BINS).fill(-Infinity);

/** The `n`th frame (0.06 s apart) of a voice with a 5 Hz syllable swing */
export const singing = (n) => voice(0.15 + 0.85 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * n * 0.06)) ** 2);
/** The `n`th frame of a drum loop: kick on the beat, snare on the off-beat, 2 beats a second */
export const drumLoop = (n) => {
  const phase = (n * 0.06 * 2) % 1;
  return drums({ kick: phase < 0.12 ? 1 : 0, snare: phase > 0.5 && phase < 0.62 ? 1 : 0.05, seed: n % 5 });
};
