import type { EqBandCorrection, NoteInfo, TargetCurveType, WeightingCurve } from '../types/audio';

export const ISO_OCTAVE_BANDS = [
  { freq: 31.5, label: '31.5' },
  { freq: 63, label: '63' },
  { freq: 125, label: '125' },
  { freq: 250, label: '250' },
  { freq: 500, label: '500' },
  { freq: 1000, label: '1k' },
  { freq: 2000, label: '2k' },
  { freq: 4000, label: '4k' },
  { freq: 8000, label: '8k' },
  { freq: 16000, label: '16k' },
] as const;

export const ISO_THIRD_OCTAVE_FREQS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * IEC 61672-1 Frequency Weighting (A, C, Z) in dB relative to 1 kHz.
 */
export function getWeightingOffsetDb(freqHz: number, weighting: WeightingCurve): number {
  if (weighting === 'Z' || freqHz <= 0) return 0;

  const f2 = freqHz * freqHz;
  const f1Squared = 20.598997 * 20.598997;
  const f4Squared = 12194.217 * 12194.217;

  if (weighting === 'C') {
    const num = f4Squared * f2;
    const den = (f2 + f1Squared) * (f2 + f4Squared);
    const rc = num / Math.max(den, 1e-12);
    // Normalization constant at 1000 Hz = +0.06 dB
    return 20 * Math.log10(Math.max(rc, 1e-12)) + 0.06;
  }

  // A-weighting
  const f2Squared = 107.65265 * 107.65265;
  const f3Squared = 737.86223 * 737.86223;
  const num = f4Squared * f2 * f2;
  const den =
    (f2 + f1Squared) *
    Math.sqrt((f2 + f2Squared) * (f2 + f3Squared)) *
    (f2 + f4Squared);
  const ra = num / Math.max(den, 1e-12);
  // Normalization constant at 1000 Hz = +2.00 dB
  return 20 * Math.log10(Math.max(ra, 1e-12)) + 2.0;
}

/**
 * Reference target acoustic response curve offset in dB (relative to 1 kHz = 0 dB).
 */
export function getTargetCurveOffsetDb(freqHz: number, curve: TargetCurveType): number {
  if (curve === 'flat' || freqHz <= 0) return 0;

  if (curve === 'room') {
    // Typical calibrated studio/listening room curve: +3.5 dB shelf below 100 Hz, gentle -0.8 dB/oct above 1 kHz
    if (freqHz < 200) {
      const octBelow = Math.log2(200 / Math.max(freqHz, 20));
      return Math.min(3.5, octBelow * 1.15);
    }
    if (freqHz > 1000) {
      const octAbove = Math.log2(freqHz / 1000);
      return -0.75 * octAbove;
    }
    return 0;
  }

  // SMPTE ST 202 / X-Curve approximation (flat to 2 kHz, -3 dB/octave above 2 kHz)
  if (freqHz > 2000) {
    const octAbove = Math.log2(freqHz / 2000);
    return -3.0 * octAbove;
  }
  return 0;
}

export function freqToNote(freqHz: number): NoteInfo | null {
  if (!Number.isFinite(freqHz) || freqHz < 16 || freqHz > 20000) return null;
  const midiFloat = 69 + 12 * Math.log2(freqHz / 440);
  const midiRounded = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midiRounded) * 100);
  const noteIndex = ((midiRounded % 12) + 12) % 12;
  const octave = Math.floor(midiRounded / 12) - 1;
  const note = NOTE_NAMES[noteIndex];
  const sign = cents > 0 ? '+' : '';
  return {
    note,
    octave,
    cents,
    label: `${note}${octave} (${sign}${cents} ¢)`,
  };
}

export function formatFreqLabel(freqHz: number): string {
  if (freqHz >= 1000) {
    const khz = freqHz / 1000;
    return khz >= 10 ? `${khz.toFixed(1)} kHz` : `${khz.toFixed(2)} kHz`;
  }
  return `${freqHz.toFixed(freqHz < 100 ? 1 : 0)} Hz`;
}

/**
 * Computes energy-averaged band levels in dBFS from linear FFT magnitude data in dBFS.
 */
export function computeBandLevels(
  fftDb: Float32Array,
  sampleRate: number,
  fftSize: number,
  weighting: WeightingCurve,
  centerFreqs: readonly number[],
  fractionOctave: number = 3
): number[] {
  const binHz = sampleRate / fftSize;
  const halfFactor = Math.pow(2, 1 / (2 * fractionOctave));
  const results: number[] = new Array(centerFreqs.length).fill(-100);

  for (let i = 0; i < centerFreqs.length; i++) {
    const fc = centerFreqs[i];
    const fLow = fc / halfFactor;
    const fHigh = fc * halfFactor;

    const startBin = Math.max(1, Math.floor(fLow / binHz));
    const endBin = Math.min(fftDb.length - 1, Math.ceil(fHigh / binHz));

    if (endBin < startBin) {
      const nearestBin = Math.min(fftDb.length - 1, Math.max(1, Math.round(fc / binHz)));
      const wOffset = getWeightingOffsetDb(nearestBin * binHz, weighting);
      results[i] = Math.max(-100, fftDb[nearestBin] + wOffset);
      continue;
    }

    let linearPowerSum = 0;
    let count = 0;
    for (let b = startBin; b <= endBin; b++) {
      const freq = b * binHz;
      const wOffset = getWeightingOffsetDb(freq, weighting);
      const db = fftDb[b] + wOffset;
      linearPowerSum += Math.pow(10, db / 10);
      count++;
    }

    const avgPower = linearPowerSum / Math.max(1, count);
    results[i] = Math.max(-100, 10 * Math.log10(Math.max(avgPower, 1e-12)));
  }

  return results;
}

/**
 * Computes EQ deviation and suggested parametric filters relative to midrange reference (500 Hz - 2 kHz).
 */
export function computeEqCorrections(
  measuredOctaveDb: number[],
  targetCurve: TargetCurveType,
  toleranceDb: number
): { bands: EqBandCorrection[]; avgDeviationDb: number; referenceLevelDb: number } {
  // Use 500 Hz, 1 kHz, 2 kHz (indices 4, 5, 6) as midrange calibration anchor
  const validMid = [measuredOctaveDb[4], measuredOctaveDb[5], measuredOctaveDb[6]].filter(
    (v) => Number.isFinite(v) && v > -95
  );
  const referenceLevelDb =
    validMid.length > 0
      ? validMid.reduce((acc, v) => acc + v, 0) / validMid.length
      : -40;

  let absDeviationSum = 0;
  let activeCount = 0;

  const bands: EqBandCorrection[] = ISO_OCTAVE_BANDS.map((band, idx) => {
    const measuredDb = measuredOctaveDb[idx] ?? -100;
    const targetOffset = getTargetCurveOffsetDb(band.freq, targetCurve);
    const targetDb = referenceLevelDb + targetOffset;
    const deltaDb = measuredDb > -95 ? measuredDb - targetDb : 0;

    if (measuredDb > -95) {
      absDeviationSum += Math.abs(deltaDb);
      activeCount++;
    }

    // Clamp corrective filter gain to safe acoustic range (-12 dB to +9 dB)
    const rawCorrection = -deltaDb;
    const suggestedGainDb =
      measuredDb <= -95
        ? 0
        : Math.max(-12, Math.min(9, Math.round(rawCorrection * 10) / 10));

    const absDelta = Math.abs(deltaDb);
    const qFactor = absDelta > 6 ? 2.4 : absDelta > 3 ? 1.6 : 1.2;

    return {
      freqHz: band.freq,
      label: `${band.label} Hz`,
      measuredDb,
      targetDb,
      deltaDb,
      suggestedGainDb,
      qFactor,
      withinTolerance: measuredDb <= -95 || absDelta <= toleranceDb,
    };
  });

  return {
    bands,
    avgDeviationDb: activeCount > 0 ? absDeviationSum / activeCount : 0,
    referenceLevelDb,
  };
}

export function buildEqualizerApoConfig(bands: EqBandCorrection[], targetCurve: TargetCurveType): string {
  const lines = [
    `# Perfil de Calibración Acústica (EqualizerAPO)`,
    `# Curva Objetivo: ${targetCurve.toUpperCase()}`,
    `# Generado: ${new Date().toISOString()}`,
    `Preamp: -${Math.max(0, ...bands.map((b) => Math.max(0, b.suggestedGainDb))).toFixed(1)} dB`,
    ``,
  ];

  bands.forEach((b, idx) => {
    const sign = b.suggestedGainDb >= 0 ? '+' : '';
    lines.push(
      `Filter ${idx + 1}: ON PK Fc ${b.freqHz} Hz Gain ${sign}${b.suggestedGainDb.toFixed(1)} dB Q ${b.qFactor.toFixed(2)}`
    );
  });

  return lines.join('\n');
}
