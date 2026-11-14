import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, AlertTriangle } from 'lucide-react';
import { AudioEngine } from './audio/AudioEngine';
import {
  computeBandLevels,
  computeEqCorrections,
  formatFreqLabel,
  ISO_OCTAVE_BANDS,
} from './audio/acousticMath';
import { BottomTelemetryTray } from './components/BottomTelemetryTray';
import { ControlSidebar } from './components/ControlSidebar';
import { EqCalibrationView } from './components/EqCalibrationView';
import { OscilloscopeCanvas } from './components/OscilloscopeCanvas';
import { PhaseGoniometer } from './components/PhaseGoniometer';
import { RtaCanvas } from './components/RtaCanvas';
import type {
  AudioDeviceOption,
  BottomTrayMode,
  CalibrationSettings,
  EqBandCorrection,
  InputSourceMode,
  SignalGeneratorState,
  SmoothingPreset,
  TelemetrySnapshot,
  ViewMode,
  WeightingCurve,
} from './types/audio';

const INITIAL_TELEMETRY: TelemetrySnapshot = {
  rmsDbfs: -100,
  weightedRmsDbfs: -100,
  peakDbfs: -100,
  peakHoldDbfs: -100,
  estimatedSplDb: 0,
  crestFactorDb: 0,
  dominantFreqHz: 0,
  dominantNote: null,
  phaseCorrelation: 0,
  leftRmsDbfs: -100,
  rightRmsDbfs: -100,
  clipCount: 0,
  isClipping: false,
  sampleRate: 48000,
  noiseFloorDbfs: -100,
  avgDeviationDb: 0,
};

const INITIAL_SETTINGS: CalibrationSettings = {
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

const INITIAL_GENERATOR: SignalGeneratorState = {
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

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new AudioEngine();
  }

  const [viewMode, setViewMode] = useState<ViewMode>('rta');
  const [trayMode, setTrayMode] = useState<BottomTrayMode>('history');
  const [sourceMode, setSourceMode] = useState<InputSourceMode>('mic');
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  const [settings, setSettings] = useState<CalibrationSettings>(INITIAL_SETTINGS);
  const [genState, setGenState] = useState<SignalGeneratorState>(INITIAL_GENERATOR);
  const [speakerMuted, setSpeakerMuted] = useState(false);

  // Real-time canvas data refs
  const fftDbRef = useRef<Float32Array | null>(null);
  const peakHoldFftRef = useRef<Float32Array | null>(null);
  const timeDomainRef = useRef<Float32Array | null>(null);
  const leftTimeRef = useRef<Float32Array | null>(null);
  const rightTimeRef = useRef<Float32Array | null>(null);

  const [frameVersion, setFrameVersion] = useState(0);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(INITIAL_TELEMETRY);
  const [octaveLevels, setOctaveLevels] = useState<number[]>(() =>
    new Array(ISO_OCTAVE_BANDS.length).fill(-100)
  );
  const [splHistory, setSplHistory] = useState<
    Array<{ rmsDbfs: number; peakDbfs: number; splDb: number }>
  >(() => Array.from({ length: 120 }, () => ({ rmsDbfs: -100, peakDbfs: -100, splDb: 0 })));

  const [referenceTrace, setReferenceTrace] = useState<Float32Array | null>(null);
  const [frozenOctaveDb, setFrozenOctaveDb] = useState<number[] | null>(null);

  const isSignalActive =
    (sourceMode === 'mic' && micActive) || (sourceMode === 'loopback' && genState.enabled);

  // Sync settings to engine
  useEffect(() => {
    engineRef.current?.updateSettings(settings);
  }, [settings]);

  // Sync generator state to engine
  useEffect(() => {
    engineRef.current?.updateGenerator(genState);
  }, [genState]);

  // Compute live or frozen EQ corrections
  const activeOctaveDb = frozenOctaveDb ?? octaveLevels;
  const eqAnalysis = useMemo(
    () => computeEqCorrections(activeOctaveDb, settings.targetCurve, settings.toleranceDb),
    [activeOctaveDb, settings.targetCurve, settings.toleranceDb]
  );

  // Keep engine's BiquadFilterNode chain updated with computed EQ bands
  const prevEqRef = useRef<EqBandCorrection[]>([]);
  useEffect(() => {
    // Only push updates to engine when frozen or when eqPreviewEnabled is toggled
    const bandsChanged =
      prevEqRef.current.length !== eqAnalysis.bands.length ||
      eqAnalysis.bands.some((b, i) => prevEqRef.current[i]?.suggestedGainDb !== b.suggestedGainDb);
    if (bandsChanged) {
      prevEqRef.current = eqAnalysis.bands;
      engineRef.current?.updateEqBands(eqAnalysis.bands);
    }
  }, [eqAnalysis.bands]);

  // Dispose audio context on unmount
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!engineRef.current) return;
    try {
      const list = await engineRef.current.getInputDevices();
      setDevices(list);
      if (list.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(list[0].deviceId);
      }
    } catch {
      // Ignore enumeration errors before permission
    }
  }, [selectedDeviceId]);

  const handleToggleMicrophone = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setMicError(null);

    if (micActive) {
      await engine.stopMicrophone();
      setMicActive(false);
      return;
    }

    try {
      await engine.startMicrophone(selectedDeviceId || undefined);
      setMicActive(true);
      setSourceMode('mic');
      await refreshDevices();
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Permiso de micrófono denegado. Habilite el acceso en su navegador o utilice el Generador en Bucle Interno.'
          : 'No se pudo inicializar la entrada de micrófono. Verifique que haya un dispositivo conectado.';
      setMicError(msg);
      setMicActive(false);
    }
  };

  const handleDeviceChange = async (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    if (micActive && engineRef.current) {
      try {
        await engineRef.current.startMicrophone(deviceId || undefined);
        setMicError(null);
      } catch {
        setMicError('Error al cambiar de dispositivo de audio.');
      }
    }
  };

  const handleSourceModeChange = (mode: InputSourceMode) => {
    setSourceMode(mode);
    engineRef.current?.setSourceMode(mode);
  };

  const handleGenChange = (next: SignalGeneratorState) => {
    setGenState(next);
    // If user starts generator while mic is inactive, route loopback automatically for instant measurement
    if (next.enabled && !micActive && sourceMode !== 'loopback') {
      setSourceMode('loopback');
      engineRef.current?.setSourceMode('loopback');
    }
  };

  const handleToggleSpeakerMuted = () => {
    const next = !speakerMuted;
    setSpeakerMuted(next);
    engineRef.current?.setSpeakerMuted(next);
  };

  const handleCaptureReference = () => {
    if (fftDbRef.current) {
      setReferenceTrace(new Float32Array(fftDbRef.current));
    }
  };

  const handleResetPeaks = () => {
    engineRef.current?.resetPeakHold();
  };

  // Main 60fps Audio Analysis Loop
  useEffect(() => {
    if (!isSignalActive) return;

    let rafId = 0;
    let lastTelemetryTime = 0;
    let lastHistoryTime = 0;

    const tick = (now: number) => {
      const engine = engineRef.current;
      if (engine) {
        const frame = engine.readFrame();
        if (frame) {
          fftDbRef.current = frame.fftDb;
          peakHoldFftRef.current = frame.peakHoldFftDb;
          timeDomainRef.current = frame.timeDomain;
          leftTimeRef.current = frame.leftTime;
          rightTimeRef.current = frame.rightTime;

          setFrameVersion((v) => (v + 1) % 100000);

          if (now - lastTelemetryTime >= 50) {
            lastTelemetryTime = now;
            setTelemetry(frame.telemetry);

            const bands = computeBandLevels(
              frame.fftDb,
              frame.sampleRate,
              frame.fftSize,
              settings.weighting,
              ISO_OCTAVE_BANDS.map((b) => b.freq),
              1
            );
            setOctaveLevels(bands);

            if (genState.enabled && genState.waveform === 'sweep') {
              setGenState((prev) =>
                prev.enabled && prev.waveform === 'sweep'
                  ? {
                      ...prev,
                      sweepCurrentHz: frame.sweepCurrentHz,
                      sweepProgress: frame.sweepProgress,
                    }
                  : prev
              );
            }
          }

          if (now - lastHistoryTime >= 250) {
            lastHistoryTime = now;
            setSplHistory((prev) => [
              ...prev.slice(1),
              {
                rmsDbfs: frame.telemetry.weightedRmsDbfs,
                peakDbfs: frame.telemetry.peakDbfs,
                splDb: frame.telemetry.estimatedSplDb,
              },
            ]);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isSignalActive, settings.weighting, genState.enabled, genState.waveform]);

  const statusText = isSignalActive
    ? sourceMode === 'mic'
      ? `● Captura Activa · ${(telemetry.sampleRate / 1000).toFixed(1)} kHz`
      : `● Bucle Interno · ${(telemetry.sampleRate / 1000).toFixed(1)} kHz`
    : '○ En Espera';

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col">
      {/* Top Bar: Strict 3-Zone Contract */}
      <header className="flex items-center justify-between gap-8 px-5 py-3 border-b border-slate-800/90 bg-[#090D16] shrink-0">
        {/* Zone 1: Brand Wordmark */}
        <span className="text-base font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
          Calibrador Acústico
        </span>

        {/* Zone 2: Single-line View Mode Nav Links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium">
          {(
            [
              { id: 'rta', label: 'Analizador RTA' },
              { id: 'oscilloscope', label: 'Osciloscopio' },
              { id: 'eq', label: 'Calibración EQ' },
              { id: 'phase', label: 'Medidor Fase' },
            ] as Array<{ id: ViewMode; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setViewMode(tab.id)}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === tab.id
                  ? 'border-cyan-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Zone 3: 1 Primary CTA */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleToggleMicrophone}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              micActive
                ? 'bg-rose-500/15 border border-rose-500/50 text-rose-300 hover:bg-rose-500/25'
                : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
            }`}
          >
            {micActive ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            {micActive ? 'Detener Micrófono' : 'Activar Micrófono'}
          </button>
        </div>
      </header>

      {/* Mobile Navigation Strip (below header on small screens) */}
      <div className="flex md:hidden items-center gap-2 px-4 py-2 border-b border-slate-800/80 bg-[#090D16] overflow-x-auto">
        {(
          [
            { id: 'rta', label: 'Analizador RTA' },
            { id: 'oscilloscope', label: 'Osciloscopio' },
            { id: 'eq', label: 'Calibración EQ' },
            { id: 'phase', label: 'Medidor Fase' },
          ] as Array<{ id: ViewMode; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setViewMode(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
              viewMode === tab.id
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Workspace Telemetry & Calibration Ribbon */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-2 border-b border-slate-800/80 bg-[#0B101B] text-xs shrink-0">
        <div className="flex items-center gap-4">
          <span
            className={`font-mono font-medium whitespace-nowrap ${
              isSignalActive ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            {statusText}
          </span>
          <span className="text-slate-600 hidden sm:inline" aria-hidden="true">
            |
          </span>
          <span className="font-mono text-slate-400 tabular-nums hidden sm:inline">
            Piso Ruido: {isSignalActive ? `${telemetry.noiseFloorDbfs.toFixed(1)} dBFS` : '—'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Acoustic Weighting Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Ponderación:</span>
            <div className="flex items-center p-0.5 bg-slate-900 border border-slate-800 rounded">
              {(['Z', 'A', 'C'] as WeightingCurve[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setSettings({ ...settings, weighting: w })}
                  className={`px-2 py-0.5 text-[11px] font-mono rounded-sm transition-colors cursor-pointer ${
                    settings.weighting === w
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  dB{w}
                </button>
              ))}
            </div>
          </div>

          {/* Smoothing / Response Time */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Respuesta:</span>
            <div className="flex items-center p-0.5 bg-slate-900 border border-slate-800 rounded">
              {(
                [
                  { id: 'fast', label: 'Rápida' },
                  { id: 'medium', label: 'Media' },
                  { id: 'slow', label: 'Lenta' },
                ] as Array<{ id: SmoothingPreset; label: string }>
              ).map((sm) => (
                <button
                  key={sm.id}
                  type="button"
                  onClick={() => setSettings({ ...settings, smoothingPreset: sm.id })}
                  className={`px-2 py-0.5 text-[11px] rounded-sm transition-colors cursor-pointer ${
                    settings.smoothingPreset === sm.id
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {sm.label}
                </button>
              ))}
            </div>
          </div>

          {/* Contextual Controls for RTA or Oscilloscope */}
          {viewMode === 'rta' && (
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.showPeakHold}
                onChange={(e) =>
                  setSettings({ ...settings, showPeakHold: e.target.checked })
                }
                className="accent-amber-400 w-3.5 h-3.5 cursor-pointer"
              />
              <span>Traza Pico</span>
            </label>
          )}

          {viewMode === 'oscilloscope' && (
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Base:</span>
              <select
                value={settings.timebaseMs}
                onChange={(e) =>
                  setSettings({ ...settings, timebaseMs: Number(e.target.value) })
                }
                className="bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[11px] font-mono text-slate-200"
              >
                <option value={1}>1 ms/div</option>
                <option value={2}>2 ms/div</option>
                <option value={5}>5 ms/div</option>
                <option value={10}>10 ms/div</option>
                <option value={20}>20 ms/div</option>
              </select>
              <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={settings.triggerEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, triggerEnabled: e.target.checked })
                  }
                  className="accent-cyan-500 w-3.5 h-3.5 cursor-pointer"
                />
                <span>Disparo 0V</span>
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Inline Mic Error Alert */}
      {micError && (
        <div className="px-5 py-2.5 bg-rose-950/60 border-b border-rose-800/70 flex items-center justify-between gap-4 text-xs text-rose-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{micError}</span>
          </div>
          <button
            type="button"
            onClick={() => setMicError(null)}
            className="text-rose-300 hover:text-white underline shrink-0 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Main Split Console */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        <ControlSidebar
          sourceMode={sourceMode}
          onSourceModeChange={handleSourceModeChange}
          devices={devices}
          selectedDeviceId={selectedDeviceId}
          onDeviceChange={handleDeviceChange}
          micActive={micActive}
          genState={genState}
          onGenChange={handleGenChange}
          onTriggerSweep={() => engineRef.current?.triggerSweepRestart()}
          speakerMuted={speakerMuted}
          onToggleSpeakerMuted={handleToggleSpeakerMuted}
          settings={settings}
          onSettingsChange={setSettings}
          onCaptureReference={handleCaptureReference}
          onClearReference={() => setReferenceTrace(null)}
          hasReference={referenceTrace !== null}
          onResetPeaks={handleResetPeaks}
        />

        {/* Main Viewport & Telemetry Column */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* 4-Column KPI Telemetry Strip */}
          <section className="grid grid-cols-2 xl:grid-cols-4 border-b border-slate-800/90 bg-[#090D16] divide-x divide-y xl:divide-y-0 divide-slate-800/80 shrink-0">
            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-slate-400">
                Nivel RMS ({settings.weighting})
              </div>
              <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold text-slate-100">
                  {isSignalActive ? telemetry.weightedRmsDbfs.toFixed(1) : '—'}
                </span>
                <span className="text-xs text-slate-400">dBFS</span>
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-cyan-400">
                {isSignalActive
                  ? `${telemetry.estimatedSplDb.toFixed(1)} dB${settings.weighting} SPL`
                  : 'SPL en espera'}
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-400">
                  Pico Máximo (Peak Hold)
                </span>
                {telemetry.clipCount > 0 && (
                  <span className="text-[11px] font-mono text-rose-400">
                    ✖ Clip ({telemetry.clipCount})
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums">
                <span
                  className={`text-2xl font-semibold ${
                    telemetry.isClipping || telemetry.peakHoldDbfs >= -0.2
                      ? 'text-rose-400'
                      : 'text-amber-400'
                  }`}
                >
                  {isSignalActive ? telemetry.peakHoldDbfs.toFixed(1) : '—'}
                </span>
                <span className="text-xs text-slate-400">dBFS</span>
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                Instantáneo: {isSignalActive ? `${telemetry.peakDbfs.toFixed(1)} dBFS` : '—'}
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-slate-400">
                Frecuencia Dominante
              </div>
              <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold text-slate-100">
                  {isSignalActive && telemetry.dominantFreqHz > 0
                    ? formatFreqLabel(telemetry.dominantFreqHz).replace(/ (Hz|kHz)$/, '')
                    : '—'}
                </span>
                <span className="text-xs text-slate-400">
                  {isSignalActive && telemetry.dominantFreqHz >= 1000 ? 'kHz' : 'Hz'}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400 truncate">
                {isSignalActive && telemetry.dominantNote
                  ? telemetry.dominantNote.label
                  : 'Sin tono detectado'}
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-slate-400">
                Dinámica y Desviación
              </div>
              <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-2xl font-semibold text-slate-100">
                  {isSignalActive ? telemetry.crestFactorDb.toFixed(1) : '—'}
                </span>
                <span className="text-xs text-slate-400">dB Cresta</span>
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                Desviación Octava: {isSignalActive ? `±${eqAnalysis.avgDeviationDb.toFixed(2)} dB` : '—'}
              </div>
            </div>
          </section>

          {/* Primary Canvas / Instrument Stage */}
          <div className="flex-1 min-h-[320px] bg-[#07090E] relative">
            {viewMode === 'rta' && (
              <RtaCanvas
                fftDbRef={fftDbRef}
                peakHoldFftRef={peakHoldFftRef}
                referenceTrace={referenceTrace}
                sampleRate={telemetry.sampleRate}
                settings={settings}
                isSignalActive={isSignalActive}
                generatorFreqHz={
                  genState.waveform === 'sweep' ? genState.sweepCurrentHz : genState.frequencyHz
                }
                generatorEnabled={genState.enabled}
                generatorWaveform={genState.waveform}
                frameVersion={frameVersion}
              />
            )}

            {viewMode === 'oscilloscope' && (
              <OscilloscopeCanvas
                timeDomainRef={timeDomainRef}
                sampleRate={telemetry.sampleRate}
                settings={settings}
                isSignalActive={isSignalActive}
                frameVersion={frameVersion}
              />
            )}

            {viewMode === 'eq' && (
              <EqCalibrationView
                bands={eqAnalysis.bands}
                avgDeviationDb={eqAnalysis.avgDeviationDb}
                referenceLevelDb={eqAnalysis.referenceLevelDb}
                settings={settings}
                isSignalActive={isSignalActive}
                onToggleEqPreview={() =>
                  setSettings({ ...settings, eqPreviewEnabled: !settings.eqPreviewEnabled })
                }
                onFreezeCalibration={() => setFrozenOctaveDb([...octaveLevels])}
                hasFrozenEq={frozenOctaveDb !== null}
                onClearFrozenEq={() => setFrozenOctaveDb(null)}
              />
            )}

            {viewMode === 'phase' && (
              <PhaseGoniometer
                leftTimeRef={leftTimeRef}
                rightTimeRef={rightTimeRef}
                telemetry={telemetry}
                isSignalActive={isSignalActive}
                frameVersion={frameVersion}
              />
            )}
          </div>

          {/* Bottom Time-Series & Band Tray */}
          <BottomTelemetryTray
            mode={trayMode}
            onModeChange={setTrayMode}
            splHistory={splHistory}
            octaveLevels={octaveLevels}
            fftDbRef={fftDbRef}
            sampleRate={telemetry.sampleRate}
            settings={settings}
            isSignalActive={isSignalActive}
            frameVersion={frameVersion}
          />
        </main>
      </div>
    </div>
  );
}
