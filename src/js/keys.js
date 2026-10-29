const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WHEEL = {
  major: [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1],
  minor: [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
};
const PROFILES = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
};
const clamp = value => Math.max(0, Math.min(1, value));
const mod12 = value => (value % 12 + 12) % 12;

function validKey(key) {
  return key && Number.isInteger(key.tonic) && key.tonic >= 0 && key.tonic < 12 &&
    (key.mode === 'major' || key.mode === 'minor');
}

function normalize(chroma) {
  if (!chroma || chroma.length !== 12) return null;
  let total = 0;
  for (const value of chroma) {
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return Float64Array.from(chroma, value => value / total);
}

function centered(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / 12;
  const result = Float64Array.from(values, value => value - mean);
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? result.map(value => value / norm) : result;
}

// Center profiles once: each later Pearson correlation is just a dot product.
const TEMPLATES = Object.entries(PROFILES).flatMap(([mode, profile]) => {
  const values = centered(profile);
  return Array.from({ length: 12 }, (_, tonic) => ({
    key: { tonic, mode },
    values: Float64Array.from({ length: 12 }, (_, pitch) => values[mod12(pitch - tonic)])
  }));
});

export class ChromaAccumulator {
  constructor({ sampleRate, fftSize, minHz = 65, maxHz = 2100 }) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(fftSize) ||
        fftSize < 2 || fftSize > 32768 || (fftSize & (fftSize - 1)) !== 0 ||
        !Number.isFinite(minHz) || !Number.isFinite(maxHz) || minHz <= 0 || maxHz < minHz) {
      throw new RangeError('Invalid spectrum configuration');
    }
    const binHz = sampleRate / fftSize;
    this._first = Math.max(1, Math.ceil(minHz / binHz));
    const last = Math.min(fftSize / 2 - 1, Math.floor(maxHz / binHz));
    const count = Math.max(0, last - this._first + 1);
    this._pitch = new Uint8Array(count);
    this._fraction = new Float64Array(count);
    this._tilt = new Float64Array(count);
    this._db = new Float64Array(count);
    this._sorted = new Float64Array(count);
    this._frame = new Float64Array(12);
    this._sum = new Float64Array(12);
    this._frames = 0;
    for (let i = 0; i < count; i++) {
      const note = 69 + 12 * Math.log2((this._first + i) * binHz / 440);
      const lower = Math.floor(note);
      this._pitch[i] = mod12(lower);
      const fraction = note - lower;
      // Sharpen the soft split so FFT detuning leaks less into adjacent notes.
      this._fraction[i] = fraction ** 2 / (fraction ** 2 + (1 - fraction) ** 2);
      // Favor fundamentals over their upper partials without discarding treble.
      this._tilt[i] = 440 / ((this._first + i) * binHz);
    }
  }

  get frames() {
    return this._frames;
  }

  add(dbSpectrum, weight = 1) {
    const count = this._db.length;
    if (!count || !dbSpectrum || dbSpectrum.length < this._first + count ||
        !Number.isFinite(weight) || weight <= 0) return;
    let peak = -160, dbSum = 0, energySum = 0;
    for (let i = 0; i < count; i++) {
      const value = dbSpectrum[this._first + i];
      const db = Number.isFinite(value) ? Math.max(-160, Math.min(100, value)) : -160;
      this._db[i] = db;
      this._sorted[i] = db;
      peak = Math.max(peak, db);
      dbSum += db;
      energySum += 10 ** (db / 10);
    }
    if (peak < -90) return;
    // Broadband percussion has a high geometric/arithmetic energy ratio.
    const flatness = 10 ** (dbSum / count / 10) / (energySum / count);
    if (flatness >= 0.35) return;
    this._sorted.sort();
    const middle = Math.floor(count / 2);
    const median = count % 2 ? this._sorted[middle] :
      (this._sorted[middle - 1] + this._sorted[middle]) / 2;
    const floor = 10 ** (median / 10);
    this._frame.fill(0);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const energy = Math.max(0, 10 ** (this._db[i] / 10) - floor) * this._tilt[i];
      const pitch = this._pitch[i], fraction = this._fraction[i];
      this._frame[pitch] += energy * (1 - fraction);
      this._frame[(pitch + 1) % 12] += energy * fraction;
      total += energy;
    }
    if (!(total > 0)) return;
    // Normalize frames so a loud drum hit cannot outweigh a quiet tonal passage.
    const scale = weight * (1 - flatness / 0.35) / total;
    for (let pitch = 0; pitch < 12; pitch++) this._sum[pitch] += this._frame[pitch] * scale;
    this._frames++;
  }

  chroma() {
    return normalize(this._sum) || new Float64Array(12);
  }

  reset() {
    this._sum.fill(0);
    this._frames = 0;
  }
}

export function camelot(key) {
  return validKey(key) ? `${WHEEL[key.mode][key.tonic]}${key.mode === 'minor' ? 'A' : 'B'}` : null;
}

export function parseCamelot(value) {
  if (typeof value !== 'string') return null;
  const match = /^(1[0-2]|[1-9])([AB])$/i.exec(value.trim());
  if (!match) return null;
  const mode = match[2].toUpperCase() === 'A' ? 'minor' : 'major';
  return { tonic: WHEEL[mode].indexOf(Number(match[1])), mode };
}

export function keyName(key) {
  return validKey(key) ? `${NOTES[key.tonic]} ${key.mode}` : null;
}

export function estimateKey(chroma) {
  const normalized = normalize(chroma);
  if (!normalized) return null;
  // Tiny deviations from flat noise are not useful evidence of a key.
  const variance = normalized.reduce((sum, value) => sum + (value - 1 / 12) ** 2, 0);
  if (variance < 1e-6) return null;
  const values = centered(normalized);
  const candidates = TEMPLATES.map(template => ({
    key: template.key,
    correlation: template.values.reduce((sum, value, i) => sum + value * values[i], 0)
  })).sort((a, b) => b.correlation - a.correlation);
  const best = candidates[0];
  const relativeTonic = mod12(best.key.tonic + (best.key.mode === 'major' ? 9 : 3));
  const second = candidates.find(candidate => candidate !== best &&
    !(candidate.key.mode !== best.key.mode && candidate.key.tonic === relativeTonic));
  const margin = best.correlation - second.correlation;
  // Relative major/minor ambiguity should not erase otherwise strong evidence.
  const confidence = clamp(best.correlation) * (0.2 + 0.8 * clamp(margin / 0.2));
  const key = { ...best.key };
  return { key, camelot: camelot(key), name: keyName(key), confidence };
}

function relation(a, b) {
  const difference = Math.abs(WHEEL[a.mode][a.tonic] - WHEEL[b.mode][b.tonic]);
  const distance = Math.min(difference, 12 - difference);
  if (a.mode === b.mode) {
    if (distance === 0) return { score: 1, relation: 'same' };
    if (distance === 1) return { score: 0.85, relation: 'neighbor' };
    if (distance === 2) return { score: 0.6, relation: 'energy-boost' };
  } else if (distance === 0) return { score: 0.9, relation: 'relative' };
  return { score: Math.max(0.1, 0.3 - distance * 0.04), relation: 'clash' };
}

export function compatibility(keyA, keyB) {
  if (!validKey(keyA) || !validKey(keyB)) {
    return { score: 0, relation: 'unknown', semitoneShift: null };
  }
  const result = relation(keyA, keyB);
  if (result.score >= 0.85) return { ...result, semitoneShift: 0 };
  // Shift B; prefer the least movement, then the strongest resulting relation.
  for (const amount of [1, 2]) {
    const choices = [-amount, amount].map(shift => ({
      shift, ...relation(keyA, { tonic: mod12(keyB.tonic + shift), mode: keyB.mode })
    })).filter(choice => choice.score >= 0.85).sort((a, b) => b.score - a.score);
    if (choices.length) return { ...result, semitoneShift: choices[0].shift };
  }
  return { ...result, semitoneShift: null };
}

export function mergeKey(previous, next) {
  const estimates = [previous, next].filter(estimate => validKey(estimate?.key));
  if (!estimates.length) return null;
  const confidence = estimate => Number.isFinite(estimate.confidence) ? clamp(estimate.confidence) : 0;
  let chosen = estimates.reduce((a, b) => confidence(b) > confidence(a) ? b : a);
  let chroma = normalize(chosen.chroma);
  if (estimates.length === 2) {
    const before = normalize(previous.chroma), after = normalize(next.chroma);
    if (before && after) {
      chroma = before.map((value, i) => (value + after[i]) / 2);
      chosen = estimateKey(chroma) || chosen;
    }
  }
  const key = { ...chosen.key };
  const result = { key, camelot: camelot(key), name: keyName(key), confidence: confidence(chosen) };
  // Old label-only estimates remain usable; persist spectral evidence when present.
  if (chroma) result.chroma = Array.from(chroma, value => Math.round(value * 10000) / 10000);
  return result;
}
