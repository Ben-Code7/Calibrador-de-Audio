import React from 'react';
import { Play, RotateCcw, Square, Volume2, VolumeX, Camera } from 'lucide-react';
import { formatFreqLabel } from '../audio/acousticMath';
import type {
  AudioDeviceOption,
  CalibrationSettings,
  InputSourceMode,
  SignalGeneratorState,
  SignalWaveform,
  TargetCurveType,
} from '../types/audio';

interface ControlSidebarProps {
  sourceMode: InputSourceMode;
  onSourceModeChange: (mode: InputSourceMode) => void;
  devices: AudioDeviceOption[];
  selectedDeviceId: string;
  onDeviceChange: (deviceId: string) => void;
  micActive: boolean;
  genState: SignalGeneratorState;
  onGenChange: (next: SignalGeneratorState) => void;
  onTriggerSweep: () => void;
  speakerMuted: boolean;
  onToggleSpeakerMuted: () => void;
  settings: CalibrationSettings;
  onSettingsChange: (next: CalibrationSettings) => void;
  onCaptureReference: () => void;
  onClearReference: () => void;
  hasReference: boolean;
  onResetPeaks: () => void;
}

const WAVEFORMS: Array<{ id: SignalWaveform; label: string }> = [
  { id: 'pink', label: 'Rosa' },
  { id: 'white', label: 'Blanco' },
  { id: 'sine', label: 'Seno' },
  { id: 'sweep', label: 'Barrido' },
  { id: 'square', label: 'Cuadrada' },
  { id: 'triangle', label: 'Triangular' },
];

const QUICK_FREQS = [60, 100, 440, 1000, 4000, 10000];

export const ControlSidebar: React.FC<ControlSidebarProps> = ({
  sourceMode,
  onSourceModeChange,
  devices,
  selectedDeviceId,
  onDeviceChange,
  micActive,
  genState,
  onGenChange,
  onTriggerSweep,
  speakerMuted,
  onToggleSpeakerMuted,
  settings,
  onSettingsChange,
  onCaptureReference,
  onClearReference,
  hasReference,
  onResetPeaks,
}) => {
  // Logarithmic mapping for 20 Hz .. 20,000 Hz slider (0..1000)
  const freqToSlider = (hz: number) => {
    const min = Math.log10(20);
    const max = Math.log10(20000);
    return Math.round(((Math.log10(Math.max(20, Math.min(20000, hz))) - min) / (max - min)) * 1000);
  };
  const sliderToFreq = (val: number) => {
    const min = Math.log10(20);
    const max = Math.log10(20000);
    return Math.round(Math.pow(10, min + (val / 1000) * (max - min)));
  };

  const isToneWaveform =
    genState.waveform === 'sine' ||
    genState.waveform === 'square' ||
    genState.waveform === 'triangle';

  return (
    <aside className="w-full lg:w-[330px] xl:w-[352px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/90 bg-[#0A0E17] flex flex-col divide-y divide-slate-800/80 overflow-y-auto">
      {/* Section 1: Input Source & Device */}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-slate-300">
            Fuente de Medición
          </h2>
          <span className="text-[11px] font-mono text-slate-400">
            {sourceMode === 'mic'
              ? micActive
                ? '● Micrófono'
                : '○ Mic Inactivo'
              : '● Bucle Interno'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900 border border-slate-800 rounded">
          <button
            type="button"
            onClick={() => onSourceModeChange('mic')}
            className={`py-1.5 px-2 text-xs font-medium rounded-sm transition-colors whitespace-nowrap cursor-pointer ${
              sourceMode === 'mic'
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Micrófono en Vivo
          </button>
          <button
            type="button"
            onClick={() => onSourceModeChange('loopback')}
            className={`py-1.5 px-2 text-xs font-medium rounded-sm transition-colors whitespace-nowrap cursor-pointer ${
              sourceMode === 'loopback'
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Bucle Interno
          </button>
        </div>

        {sourceMode === 'mic' && (
          <div className="space-y-2.5">
            <div>
              <label
                htmlFor="audio-input-device"
                className="block text-[11px] text-slate-400 mb-1"
              >
                Dispositivo de Entrada
              </label>
              <select
                id="audio-input-device"
                value={selectedDeviceId}
                onChange={(e) => onDeviceChange(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                {devices.length === 0 ? (
                  <option value="">Micrófono Predeterminado</option>
                ) : (
                  devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <label className="flex items-center justify-between gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <span>Modo Medición Bruta (Sin AEC/AGC)</span>
              <input
                type="checkbox"
                checked={settings.rawMicProcessing}
                onChange={(e) =>
                  onSettingsChange({ ...settings, rawMicProcessing: e.target.checked })
                }
                className="accent-cyan-500 w-3.5 h-3.5 cursor-pointer"
              />
            </label>
          </div>
        )}
      </div>

      {/* Section 2: Reference Signal Generator */}
      <div className="p-4 space-y-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-slate-300">
            Generador de Referencia
          </h2>
          <button
            type="button"
            onClick={onToggleSpeakerMuted}
            title={speakerMuted ? 'Activar salida por altavoces' : 'Silenciar altavoces'}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border transition-colors cursor-pointer whitespace-nowrap ${
              speakerMuted
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {speakerMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            {speakerMuted ? 'Silenciado' : 'Salida Audio'}
          </button>
        </div>

        <button
          type="button"
          onClick={() =>
            onGenChange({
              ...genState,
              enabled: !genState.enabled,
              sweepActive: genState.waveform === 'sweep' ? !genState.enabled : false,
            })
          }
          className={`w-full py-2 px-4 rounded text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
            genState.enabled
              ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
              : 'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700'
          }`}
        >
          {genState.enabled ? (
            <>
              <Square className="w-3.5 h-3.5 fill-current" />
              Detener Generador
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-current" />
              Iniciar Señal de Prueba
            </>
          )}
        </button>

        {/* Waveform Selector */}
        <div className="grid grid-cols-3 gap-1">
          {WAVEFORMS.map((wf) => (
            <button
              key={wf.id}
              type="button"
              onClick={() =>
                onGenChange({
                  ...genState,
                  waveform: wf.id,
                  sweepActive: wf.id === 'sweep' && genState.enabled,
                })
              }
              className={`py-1.5 px-2 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
                genState.waveform === wf.id
                  ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {wf.label}
            </button>
          ))}
        </div>

        {/* Frequency Control (for tones) */}
        {isToneWaveform && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Frecuencia</span>
              <span className="font-mono tabular-nums text-cyan-400 font-medium">
                {formatFreqLabel(genState.frequencyHz)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1000}
              value={freqToSlider(genState.frequencyHz)}
              onChange={(e) =>
                onGenChange({
                  ...genState,
                  frequencyHz: sliderToFreq(Number(e.target.value)),
                })
              }
              className="w-full cal-slider"
              aria-label="Frecuencia del generador"
            />
            <div className="grid grid-cols-6 gap-1">
              {QUICK_FREQS.map((fq) => (
                <button
                  key={fq}
                  type="button"
                  onClick={() => onGenChange({ ...genState, frequencyHz: fq })}
                  className={`py-1 text-[11px] font-mono rounded border transition-colors cursor-pointer ${
                    genState.frequencyHz === fq
                      ? 'bg-slate-800 border-cyan-500/60 text-cyan-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {fq >= 1000 ? `${fq / 1000}k` : fq}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sweep Controls */}
        {genState.waveform === 'sweep' && (
          <div className="space-y-2 pt-1 border border-slate-800/80 bg-slate-900/50 rounded p-2.5">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className="text-slate-400">Barrido Log (20–20k)</span>
              <span className="text-amber-400">
                {genState.enabled ? formatFreqLabel(genState.sweepCurrentHz) : `${genState.sweepDurationSec} s`}
              </span>
            </div>
            <div className="h-1.5 bg-slate-800 rounded-sm overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-[width] duration-75"
                style={{ width: `${Math.round(genState.sweepProgress * 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-1">
                {[5, 10, 20].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => onGenChange({ ...genState, sweepDurationSec: sec })}
                    className={`px-2 py-0.5 text-[11px] font-mono rounded border cursor-pointer ${
                      genState.sweepDurationSec === sec
                        ? 'bg-slate-800 border-cyan-500/50 text-cyan-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400'
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={onTriggerSweep}
                disabled={!genState.enabled}
                className="px-2 py-0.5 text-[11px] font-medium rounded border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
              >
                Reiniciar
              </button>
            </div>
          </div>
        )}

        {/* Output Level */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Nivel de Salida</span>
            <span className="font-mono tabular-nums text-slate-200">
              {genState.gainDbfs.toFixed(1)} dBFS
            </span>
          </div>
          <input
            type="range"
            min={-60}
            max={0}
            step={0.5}
            value={genState.gainDbfs}
            onChange={(e) =>
              onGenChange({ ...genState, gainDbfs: Number(e.target.value) })
            }
            className="w-full cal-slider"
            aria-label="Nivel de salida en dBFS"
          />
        </div>

        {/* Stereo Pan & Polarity Test */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div>
            <div className="flex justify-between text-[11px] text-slate-400 mb-1">
              <span>Balance L/R</span>
              <span className="font-mono tabular-nums text-slate-300">
                {genState.stereoPan === 0
                  ? 'Centro'
                  : genState.stereoPan < 0
                  ? `L ${Math.abs(Math.round(genState.stereoPan * 100))}%`
                  : `R ${Math.round(genState.stereoPan * 100)}%`}
              </span>
            </div>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.1}
              value={genState.stereoPan}
              onChange={(e) =>
                onGenChange({ ...genState, stereoPan: Number(e.target.value) })
              }
              className="w-full cal-slider"
              aria-label="Balance estéreo"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() =>
                onGenChange({
                  ...genState,
                  polarityInvertRight: !genState.polarityInvertRight,
                })
              }
              className={`w-full py-1.5 px-2 text-[11px] font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
                genState.polarityInvertRight
                  ? 'bg-rose-500/15 border-rose-500/50 text-rose-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {genState.polarityInvertRight ? 'Polaridad R: -180°' : 'Polaridad R: 0°'}
            </button>
          </div>
        </div>
      </div>

      {/* Section 3: Acoustic Calibration & Reference Traces */}
      <div className="p-4 space-y-3.5">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">
          Calibración y Trazas
        </h2>

        {/* SPL Offset Calibration */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Compensación SPL (0 dBFS)</span>
            <span className="font-mono tabular-nums text-cyan-400">
              +{settings.splOffsetDb.toFixed(1)} dB
            </span>
          </div>
          <input
            type="range"
            min={50}
            max={130}
            step={0.5}
            value={settings.splOffsetDb}
            onChange={(e) =>
              onSettingsChange({ ...settings, splOffsetDb: Number(e.target.value) })
            }
            className="w-full cal-slider"
            aria-label="Compensación SPL en decibelios"
          />
        </div>

        {/* Target Curve & Tolerance */}
        <div className="space-y-1.5">
          <span className="block text-[11px] text-slate-400">Curva Objetivo de Sala</span>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                { id: 'flat', label: 'Plana' },
                { id: 'room', label: 'Sala' },
                { id: 'cinema', label: 'Cine X' },
              ] as Array<{ id: TargetCurveType; label: string }>
            ).map((tc) => (
              <button
                key={tc.id}
                type="button"
                onClick={() => onSettingsChange({ ...settings, targetCurve: tc.id })}
                className={`py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
                  settings.targetCurve === tc.id
                    ? 'bg-slate-800 border-cyan-500/60 text-cyan-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {tc.label}
              </button>
            ))}
          </div>
        </div>

        {/* FFT & Display toggles */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label
              htmlFor="fft-size-select"
              className="block text-[11px] text-slate-400 mb-1"
            >
              Resolución FFT
            </label>
            <select
              id="fft-size-select"
              value={settings.fftSize}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  fftSize: Number(e.target.value) as CalibrationSettings['fftSize'],
                })
              }
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value={2048}>2048 pts</option>
              <option value={4096}>4096 pts</option>
              <option value={8192}>8192 pts</option>
              <option value={16384}>16384 pts</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="rta-display-select"
              className="block text-[11px] text-slate-400 mb-1"
            >
              Visualización RTA
            </label>
            <select
              id="rta-display-select"
              value={settings.rtaDisplayMode}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  rtaDisplayMode: e.target.value as CalibrationSettings['rtaDisplayMode'],
                })
              }
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="both">Curva + 1/3 Oct</option>
              <option value="curve">Solo Curva FFT</option>
              <option value="bars">Barras 1/3 Oct</option>
            </select>
          </div>
        </div>

        {/* Snapshot & Reset Actions */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            onClick={hasReference ? onClearReference : onCaptureReference}
            className={`inline-flex items-center justify-center gap-1.5 py-2 px-2.5 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
              hasReference
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-slate-600'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            {hasReference ? 'Limpiar Traza' : 'Capturar Traza'}
          </button>

          <button
            type="button"
            onClick={onResetPeaks}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-2.5 text-xs font-medium rounded bg-slate-900 border border-slate-700 text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reiniciar Picos
          </button>
        </div>
      </div>
    </aside>
  );
};
