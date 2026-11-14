import {
  computeBandLevels,
  freqToNote,
  getWeightingOffsetDb,
  ISO_OCTAVE_BANDS,
} from './acousticMath';
import type {
  AudioDeviceOption,
  CalibrationSettings,
  EqBandCorrection,
  InputSourceMode,
  SignalGeneratorState,
  SmoothingPreset,
  TelemetrySnapshot,
} from '../types/audio';

const SMOOTHING_MAP: Record<SmoothingPreset, number> = {
  fast: 0.35,
  medium: 0.72,
  slow: 0.88,
};

export interface FrameData {
  fftDb: Float32Array;
  peakHoldFftDb: Float32Array;
  timeDomain: Float32Array;
  leftTime: Float32Array;
  rightTime: Float32Array;
  telemetry: TelemetrySnapshot;
  sampleRate: number;
  fftSize: number;
  sweepCurrentHz: number;
  sweepProgress: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;

  // Mic chain
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;

  // Generator chain
  private genSource: AudioNode | null = null;
  private genGain: GainNode | null = null;
  private genPanner: StereoPannerNode | null = null;
  private genEqFilters: BiquadFilterNode[] = [];
  private genOutSplitter: ChannelSplitterNode | null = null;
  private genOutMerger: ChannelMergerNode | null = null;
  private genRightPolarity: GainNode | null = null;
  private speakerOutGain: GainNode | null = null;
  private loopbackTapGain: GainNode | null = null;

  // Noise buffers
  private pinkNoiseBuffer: AudioBuffer | null = null;
  private whiteNoiseBuffer: AudioBuffer | null = null;

  // Reusable analysis buffers
  private fftDbBuffer = new Float32Array(4096);
  private peakHoldBuffer = new Float32Array(4096).fill(-120);
  private timeDomainBuffer = new Float32Array(4096);
  private leftTimeBuffer = new Float32Array(2048);
  private rightTimeBuffer = new Float32Array(2048);

  // State
  private sourceMode: InputSourceMode = 'mic';
  private micActive = false;
  private clipCount = 0;
  private peakHoldDbfs = -120;
  private sweepStartTime = 0;
  private sweepActive = false;
  private sweepDuration = 10;
  private eqBands: EqBandCorrection[] = [];

  private settings: CalibrationSettings = {
    fftSize: 4096,
    weighting: 'Z',
    smoothingPreset: 'medium',
    splOffsetDb: 94.0,
    targetCurve: 'flat',
    toleranceDb: 3.0,
    rawMicProcessing: true,
    showPeakHold: true,
    showOctaveBars: true,
    rtaDisplayMode: 'both',
    timebaseMs: 5,
    triggerEnabled: true,
    eqPreviewEnabled: false,
  };

  private genState: SignalGeneratorState = {
    enabled: false,
    waveform: 'pink',
    frequencyHz: 1000,
    gainDbfs: -24,
    sweepDurationSec: 10,
    sweepActive: false,
    sweepCurrentHz: 20,
    sweepProgress: 0,
    stereoPan: 0,
    polarityInvertRight: false,
  };

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.setupGraph(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private setupGraph(ctx: AudioContext) {
    // Analysers
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this.settings.fftSize;
    this.analyser.smoothingTimeConstant = SMOOTHING_MAP[this.settings.smoothingPreset];
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = 0;

    this.splitter = ctx.createChannelSplitter(2);
    this.leftAnalyser = ctx.createAnalyser();
    this.rightAnalyser = ctx.createAnalyser();
    this.leftAnalyser.fftSize = 2048;
    this.rightAnalyser.fftSize = 2048;
    this.leftAnalyser.smoothingTimeConstant = 0.5;
    this.rightAnalyser.smoothingTimeConstant = 0.5;

    this.splitter.connect(this.leftAnalyser, 0);
    this.splitter.connect(this.rightAnalyser, 1);

    // Generator output bus
    this.genGain = ctx.createGain();
    this.genGain.gain.value = 0;

    // 10-band parametric EQ chain for generator preview
    this.genEqFilters = ISO_OCTAVE_BANDS.map((band) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = band.freq;
      filter.Q.value = 1.4;
      filter.gain.value = 0;
      return filter;
    });

    this.genPanner = ctx.createStereoPanner();
    this.genPanner.pan.value = 0;

    this.genOutSplitter = ctx.createChannelSplitter(2);
    this.genOutMerger = ctx.createChannelMerger(2);
    this.genRightPolarity = ctx.createGain();
    this.genRightPolarity.gain.value = 1;

    this.speakerOutGain = ctx.createGain();
    this.speakerOutGain.gain.value = 1;

    this.loopbackTapGain = ctx.createGain();
    this.loopbackTapGain.gain.value = 0; // active when sourceMode === 'loopback'

    // Wire generator chain: genGain -> EQ filters -> genPanner -> splitter -> (L, R*polarity) -> merger -> speaker & loopbackTap
    let chainHead: AudioNode = this.genGain;
    for (const filter of this.genEqFilters) {
      chainHead.connect(filter);
      chainHead = filter;
    }
    chainHead.connect(this.genPanner);
    this.genPanner.connect(this.genOutSplitter);
    this.genOutSplitter.connect(this.genOutMerger, 0, 0);
    this.genOutSplitter.connect(this.genRightPolarity, 1);
    this.genRightPolarity.connect(this.genOutMerger, 0, 1);

    this.genOutMerger.connect(this.speakerOutGain);
    this.speakerOutGain.connect(ctx.destination);

    this.genOutMerger.connect(this.loopbackTapGain);
    this.loopbackTapGain.connect(this.analyser);
    this.loopbackTapGain.connect(this.splitter);

    this.micGain = ctx.createGain();
    this.micGain.gain.value = 1;
    this.micGain.connect(this.analyser);
    this.micGain.connect(this.splitter);

    this.resizeBuffers();
    this.buildNoiseBuffers(ctx);
  }

  private resizeBuffers() {
    if (!this.analyser) return;
    const binCount = this.analyser.frequencyBinCount;
    if (this.fftDbBuffer.length !== binCount) {
      this.fftDbBuffer = new Float32Array(binCount);
      this.peakHoldBuffer = new Float32Array(binCount).fill(-120);
      this.timeDomainBuffer = new Float32Array(this.analyser.fftSize);
    }
  }

  private buildNoiseBuffers(ctx: AudioContext) {
    const length = ctx.sampleRate * 4; // 4-second seamless buffer

    // White Noise
    const white = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = white.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.5;
      }
    }
    this.whiteNoiseBuffer = white;

    // Paul Kellet's refined Pink Noise (-3 dB/oct)
    const pink = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = pink.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        const sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
        data[i] = Math.max(-0.98, Math.min(0.98, sample));
      }
    }
    this.pinkNoiseBuffer = pink;
  }

  public async getInputDevices(): Promise<AudioDeviceOption[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `Entrada de Audio ${idx + 1}`,
      }));
  }

  public async startMicrophone(deviceId?: string): Promise<void> {
    const ctx = this.ensureContext();
    await this.stopMicrophone();

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: !this.settings.rawMicProcessing,
        noiseSuppression: !this.settings.rawMicProcessing,
        autoGainControl: !this.settings.rawMicProcessing,
        channelCount: { ideal: 2 },
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    if (this.micGain) {
      this.micSource.connect(this.micGain);
    }
    this.micActive = true;
    this.setSourceMode('mic');
  }

  public async stopMicrophone(): Promise<void> {
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this.micActive = false;
  }

  public isMicrophoneActive(): boolean {
    return this.micActive;
  }

  public setSourceMode(mode: InputSourceMode) {
    this.sourceMode = mode;
    if (!this.ctx || !this.micGain || !this.loopbackTapGain) return;
    const now = this.ctx.currentTime;
    this.micGain.gain.setTargetAtTime(mode === 'mic' ? 1 : 0, now, 0.015);
    this.loopbackTapGain.gain.setTargetAtTime(mode === 'loopback' ? 1 : 0, now, 0.015);
    this.resetPeakHold();
  }

  public getSourceMode(): InputSourceMode {
    return this.sourceMode;
  }

  public updateSettings(next: CalibrationSettings) {
    const fftChanged = next.fftSize !== this.settings.fftSize;
    const eqChanged = next.eqPreviewEnabled !== this.settings.eqPreviewEnabled;
    this.settings = next;

    if (this.analyser) {
      if (fftChanged) {
        this.analyser.fftSize = next.fftSize;
        this.resizeBuffers();
      }
      this.analyser.smoothingTimeConstant = SMOOTHING_MAP[next.smoothingPreset];
    }

    if (eqChanged) {
      this.applyEqFilters();
    }
  }

  public updateEqBands(bands: EqBandCorrection[]) {
    this.eqBands = bands;
    if (this.settings.eqPreviewEnabled) {
      this.applyEqFilters();
    }
  }

  private applyEqFilters() {
    if (!this.ctx || this.genEqFilters.length === 0) return;
    const now = this.ctx.currentTime;
    this.genEqFilters.forEach((filter, idx) => {
      const band = this.eqBands[idx];
      const targetGain = this.settings.eqPreviewEnabled && band ? band.suggestedGainDb : 0;
      const targetQ = band ? band.qFactor : 1.4;
      filter.gain.setTargetAtTime(targetGain, now, 0.03);
      filter.Q.setTargetAtTime(targetQ, now, 0.03);
    });
  }

  public setSpeakerMuted(muted: boolean) {
    if (!this.ctx || !this.speakerOutGain) return;
    this.speakerOutGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  public updateGenerator(next: SignalGeneratorState) {
    const prev = this.genState;
    this.genState = next;

    if (!next.enabled) {
      this.stopGeneratorNode();
      this.sweepActive = false;
      return;
    }

    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    const needsRebuild =
      !prev.enabled ||
      !this.genSource ||
      prev.waveform !== next.waveform ||
      (next.waveform === 'sweep' && next.sweepActive && !this.sweepActive);

    if (needsRebuild) {
      this.stopGeneratorNode();
      this.startGeneratorNode(ctx, next);
    } else if (this.genSource instanceof OscillatorNode && next.waveform !== 'sweep') {
      this.genSource.frequency.setTargetAtTime(
        Math.max(20, Math.min(20000, next.frequencyHz)),
        now,
        0.015
      );
    }

    if (this.genGain) {
      const linearGain = Math.pow(10, next.gainDbfs / 20);
      this.genGain.gain.setTargetAtTime(linearGain, now, 0.02);
    }

    if (this.genPanner) {
      this.genPanner.pan.setTargetAtTime(next.stereoPan, now, 0.015);
    }

    if (this.genRightPolarity) {
      this.genRightPolarity.gain.setTargetAtTime(
        next.polarityInvertRight ? -1 : 1,
        now,
        0.01
      );
    }
  }

  private startGeneratorNode(ctx: AudioContext, state: SignalGeneratorState) {
    if (!this.genGain) return;
    const now = ctx.currentTime;

    if (state.waveform === 'pink' || state.waveform === 'white') {
      const buf = state.waveform === 'pink' ? this.pinkNoiseBuffer : this.whiteNoiseBuffer;
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.genGain);
      src.start(now);
      this.genSource = src;
      this.sweepActive = false;
      return;
    }

    const osc = ctx.createOscillator();
    if (state.waveform === 'sweep') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(20, now);
      this.sweepDuration = Math.max(2, state.sweepDurationSec);
      osc.frequency.exponentialRampToValueAtTime(20000, now + this.sweepDuration);
      this.sweepStartTime = now;
      this.sweepActive = true;
    } else {
      osc.type = state.waveform;
      osc.frequency.setValueAtTime(
        Math.max(20, Math.min(20000, state.frequencyHz)),
        now
      );
      this.sweepActive = false;
    }

    osc.connect(this.genGain);
    osc.start(now);
    this.genSource = osc;
  }

  private stopGeneratorNode() {
    if (this.genGain && this.ctx) {
      this.genGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
    }
    if (this.genSource) {
      try {
        if ('stop' in this.genSource && typeof (this.genSource as OscillatorNode).stop === 'function') {
          (this.genSource as OscillatorNode).stop();
        }
        this.genSource.disconnect();
      } catch {
        // Node may already be stopped
      }
      this.genSource = null;
    }
  }

  public triggerSweepRestart() {
    if (!this.genState.enabled || this.genState.waveform !== 'sweep') return;
    const ctx = this.ensureContext();
    this.stopGeneratorNode();
    this.startGeneratorNode(ctx, { ...this.genState, sweepActive: true });
    if (this.genGain) {
      const linearGain = Math.pow(10, this.genState.gainDbfs / 20);
      this.genGain.gain.setTargetAtTime(linearGain, ctx.currentTime, 0.02);
    }
  }

  public resetPeakHold() {
    this.peakHoldBuffer.fill(-120);
    this.peakHoldDbfs = -120;
    this.clipCount = 0;
  }

  public readFrame(): FrameData | null {
    if (!this.ctx || !this.analyser || !this.leftAnalyser || !this.rightAnalyser) {
      return null;
    }

    this.resizeBuffers();
    this.analyser.getFloatFrequencyData(this.fftDbBuffer);
    this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    this.leftAnalyser.getFloatTimeDomainData(this.leftTimeBuffer);
    this.rightAnalyser.getFloatTimeDomainData(this.rightTimeBuffer);

    const sampleRate = this.ctx.sampleRate;
    const fftSize = this.analyser.fftSize;
    const binHz = sampleRate / fftSize;

    // Update Peak Hold & find dominant frequency + noise floor
    let maxBinIdx = 1;
    let maxBinDb = -120;
    const minValidBin = Math.max(1, Math.floor(20 / binHz));
    const maxValidBin = Math.min(this.fftDbBuffer.length - 2, Math.ceil(20000 / binHz));

    const sortedBins: number[] = [];
    for (let i = minValidBin; i <= maxValidBin; i++) {
      const raw = Number.isFinite(this.fftDbBuffer[i]) ? this.fftDbBuffer[i] : -120;
      const weighted = Math.max(-120, raw + getWeightingOffsetDb(i * binHz, this.settings.weighting));
      this.fftDbBuffer[i] = weighted;

      if (weighted > this.peakHoldBuffer[i]) {
        this.peakHoldBuffer[i] = weighted;
      } else {
        // Gentle decay when peakHold is active? Actually keep hold or very slow 0.02dB/frame decay if desired; true calibration Peak Hold stays locked until Reset.
      }

      if (weighted > maxBinDb) {
        maxBinDb = weighted;
        maxBinIdx = i;
      }
      if (i % 4 === 0) sortedBins.push(weighted);
    }

    sortedBins.sort((a, b) => a - b);
    const noiseFloorDbfs = sortedBins.length > 0 ? sortedBins[Math.floor(sortedBins.length * 0.15)] : -100;

    // Parabolic interpolation for sub-bin dominant frequency accuracy
    let dominantFreqHz = maxBinIdx * binHz;
    if (maxBinDb > -78 && maxBinIdx > 1 && maxBinIdx < this.fftDbBuffer.length - 1) {
      const alpha = this.fftDbBuffer[maxBinIdx - 1];
      const beta = this.fftDbBuffer[maxBinIdx];
      const gamma = this.fftDbBuffer[maxBinIdx + 1];
      const denom = alpha - 2 * beta + gamma;
      if (Math.abs(denom) > 1e-6) {
        const p = 0.5 * ((alpha - gamma) / denom);
        dominantFreqHz = (maxBinIdx + Math.max(-0.5, Math.min(0.5, p))) * binHz;
      }
    } else if (maxBinDb <= -78) {
      dominantFreqHz = 0;
    }

    // Time domain RMS, Peak, Clipping
    let sumSq = 0;
    let peakAmp = 0;
    for (let i = 0; i < this.timeDomainBuffer.length; i++) {
      const s = this.timeDomainBuffer[i];
      sumSq += s * s;
      const abs = Math.abs(s);
      if (abs > peakAmp) peakAmp = abs;
    }
    const rms = Math.sqrt(sumSq / this.timeDomainBuffer.length);
    const rmsDbfs = Math.max(-100, 20 * Math.log10(Math.max(rms, 1e-5)));
    const peakDbfs = Math.max(-100, 20 * Math.log10(Math.max(peakAmp, 1e-5)));
    const isClipping = peakAmp >= 0.99;
    if (isClipping) {
      this.clipCount += 1;
    }
    if (peakDbfs > this.peakHoldDbfs) {
      this.peakHoldDbfs = peakDbfs;
    }

    // Weighted RMS delta from FFT power ratio (accurate for broadband pink/white noise & tones)
    let weightedRmsDbfs = rmsDbfs;
    if (this.settings.weighting !== 'Z') {
      let weightedPower = 0;
      let unweightedPower = 0;
      for (let i = minValidBin; i <= maxValidBin; i++) {
        const freq = i * binHz;
        const wDb = this.fftDbBuffer[i];
        const wOffset = getWeightingOffsetDb(freq, this.settings.weighting);
        const rawDb = wDb - wOffset;
        weightedPower += Math.pow(10, wDb / 10);
        unweightedPower += Math.pow(10, rawDb / 10);
      }
      const deltaDb =
        unweightedPower > 1e-12
          ? 10 * Math.log10(Math.max(weightedPower, 1e-12) / unweightedPower)
          : 0;
      weightedRmsDbfs = Math.max(-100, Math.min(0, rmsDbfs + deltaDb));
    }

    // Stereo L/R RMS and Pearson Phase Correlation
    let sumL = 0, sumR = 0, sumLR = 0;
    for (let i = 0; i < this.leftTimeBuffer.length; i++) {
      const l = this.leftTimeBuffer[i];
      const r = this.rightTimeBuffer[i];
      sumL += l * l;
      sumR += r * r;
      sumLR += l * r;
    }
    const leftRms = Math.sqrt(sumL / this.leftTimeBuffer.length);
    const rightRms = Math.sqrt(sumR / this.rightTimeBuffer.length);
    const leftRmsDbfs = Math.max(-100, 20 * Math.log10(Math.max(leftRms, 1e-5)));
    const rightRmsDbfs = Math.max(-100, 20 * Math.log10(Math.max(rightRms, 1e-5)));
    const corrDenom = Math.sqrt(sumL * sumR);
    const phaseCorrelation = corrDenom > 1e-8 ? Math.max(-1, Math.min(1, sumLR / corrDenom)) : 0;

    // Sweep progress tracking
    let sweepProgress = 0;
    let sweepCurrentHz = this.genState.frequencyHz;
    if (this.sweepActive && this.genState.enabled && this.genState.waveform === 'sweep') {
      const elapsed = this.ctx.currentTime - this.sweepStartTime;
      const cycleElapsed = elapsed % this.sweepDuration;
      sweepProgress = Math.min(1, Math.max(0, cycleElapsed / this.sweepDuration));
      sweepCurrentHz = 20 * Math.pow(1000, sweepProgress);
      if (elapsed >= this.sweepDuration) {
        // Loop sweep cleanly
        this.sweepStartTime = this.ctx.currentTime;
        if (this.genSource instanceof OscillatorNode) {
          this.genSource.frequency.cancelScheduledValues(this.ctx.currentTime);
          this.genSource.frequency.setValueAtTime(20, this.ctx.currentTime);
          this.genSource.frequency.exponentialRampToValueAtTime(
            20000,
            this.ctx.currentTime + this.sweepDuration
          );
        }
      }
    }

    // Octave deviation
    const octaveLevels = computeBandLevels(
      this.fftDbBuffer,
      sampleRate,
      fftSize,
      this.settings.weighting,
      ISO_OCTAVE_BANDS.map((b) => b.freq),
      1
    );
    const validMid = [octaveLevels[4], octaveLevels[5], octaveLevels[6]].filter((v) => v > -95);
    const midRef = validMid.length ? validMid.reduce((a, b) => a + b, 0) / validMid.length : -40;
    const validOct = octaveLevels.filter((v) => v > -95);
    const avgDeviationDb =
      validOct.length > 0
        ? validOct.reduce((acc, v) => acc + Math.abs(v - midRef), 0) / validOct.length
        : 0;

    const estimatedSplDb = Math.max(0, weightedRmsDbfs + this.settings.splOffsetDb);
    const crestFactorDb = Math.max(0, peakDbfs - rmsDbfs);

    return {
      fftDb: this.fftDbBuffer,
      peakHoldFftDb: this.peakHoldBuffer,
      timeDomain: this.timeDomainBuffer,
      leftTime: this.leftTimeBuffer,
      rightTime: this.rightTimeBuffer,
      sampleRate,
      fftSize,
      sweepCurrentHz,
      sweepProgress,
      telemetry: {
        rmsDbfs,
        weightedRmsDbfs,
        peakDbfs,
        peakHoldDbfs: this.peakHoldDbfs,
        estimatedSplDb,
        crestFactorDb,
        dominantFreqHz,
        dominantNote: dominantFreqHz > 0 ? freqToNote(dominantFreqHz) : null,
        phaseCorrelation,
        leftRmsDbfs,
        rightRmsDbfs,
        clipCount: this.clipCount,
        isClipping,
        sampleRate,
        noiseFloorDbfs,
        avgDeviationDb,
      },
    };
  }

  public dispose() {
    void this.stopMicrophone();
    this.stopGeneratorNode();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
