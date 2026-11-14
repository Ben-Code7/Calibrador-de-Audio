export type ViewMode = 'rta' | 'oscilloscope' | 'eq' | 'phase';

export type BottomTrayMode = 'history' | 'waterfall' | 'bands';

export type WeightingCurve = 'Z' | 'A' | 'C';

export type TargetCurveType = 'flat' | 'room' | 'cinema';

export type SignalWaveform = 'sine' | 'pink' | 'white' | 'sweep' | 'square' | 'triangle';

export type SmoothingPreset = 'fast' | 'medium' | 'slow';

export type InputSourceMode = 'mic' | 'loopback';

export interface SignalGeneratorState {
  enabled: boolean;
  waveform: SignalWaveform;
  frequencyHz: number;
  gainDbfs: number;
  sweepDurationSec: number;
  sweepActive: boolean;
  sweepCurrentHz: number;
  sweepProgress: number; // 0 to 1
  stereoPan: number; // -1 to 1
  polarityInvertRight: boolean;
}

export interface CalibrationSettings {
  fftSize: 2048 | 4096 | 8192 | 16384;
  weighting: WeightingCurve;
  smoothingPreset: SmoothingPreset;
  splOffsetDb: number; // e.g., +94.0 dB to map 0 dBFS to SPL
  targetCurve: TargetCurveType;
  toleranceDb: number;
  rawMicProcessing: boolean; // disables AEC, NS, AGC
  showPeakHold: boolean;
  showOctaveBars: boolean;
  rtaDisplayMode: 'curve' | 'bars' | 'both';
  timebaseMs: number; // oscilloscope ms/div
  triggerEnabled: boolean;
  eqPreviewEnabled: boolean;
}

export interface NoteInfo {
  note: string;
  octave: number;
  cents: number;
  label: string;
}

export interface EqBandCorrection {
  freqHz: number;
  label: string;
  measuredDb: number;
  targetDb: number;
  deltaDb: number;
  suggestedGainDb: number;
  qFactor: number;
  withinTolerance: boolean;
}

export interface TelemetrySnapshot {
  rmsDbfs: number;
  weightedRmsDbfs: number;
  peakDbfs: number;
  peakHoldDbfs: number;
  estimatedSplDb: number;
  crestFactorDb: number;
  dominantFreqHz: number;
  dominantNote: NoteInfo | null;
  phaseCorrelation: number; // -1.0 to +1.0
  leftRmsDbfs: number;
  rightRmsDbfs: number;
  clipCount: number;
  isClipping: boolean;
  sampleRate: number;
  noiseFloorDbfs: number;
  avgDeviationDb: number;
}

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}
