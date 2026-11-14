import React, { useEffect, useRef, useState } from 'react';
import { ISO_OCTAVE_BANDS } from '../audio/acousticMath';
import type { BottomTrayMode, CalibrationSettings } from '../types/audio';

interface SplPoint {
  rmsDbfs: number;
  peakDbfs: number;
  splDb: number;
}

interface BottomTelemetryTrayProps {
  mode: BottomTrayMode;
  onModeChange: (mode: BottomTrayMode) => void;
  splHistory: SplPoint[];
  octaveLevels: number[];
  fftDbRef: React.MutableRefObject<Float32Array | null>;
  sampleRate: number;
  settings: CalibrationSettings;
  isSignalActive: boolean;
  frameVersion: number;
}

// Calibrated Viridis/Lab Cyan-to-Amber RGB LUT for waterfall spectrogram
function dbToColor(db: number): [number, number, number] {
  const norm = Math.max(0, Math.min(1, (db + 100) / 100));
  if (norm < 0.25) {
    const t = norm / 0.25;
    return [Math.round(7 + t * 8), Math.round(9 + t * 28), Math.round(14 + t * 58)];
  }
  if (norm < 0.6) {
    const t = (norm - 0.25) / 0.35;
    return [Math.round(15 - t * 9), Math.round(37 + t * 145), Math.round(72 + t * 140)];
  }
  if (norm < 0.85) {
    const t = (norm - 0.6) / 0.25;
    return [Math.round(6 + t * 239), Math.round(182 - t * 24), Math.round(212 - t * 201)];
  }
  const t = (norm - 0.85) / 0.15;
  return [255, Math.round(158 + t * 92), Math.round(11 + t * 220)];
}

export const BottomTelemetryTray: React.FC<BottomTelemetryTrayProps> = ({
  mode,
  onModeChange,
  splHistory,
  octaveLevels,
  fftDbRef,
  sampleRate,
  settings,
  isSignalActive,
  frameVersion,
}) => {
  const wfContainerRef = useRef<HTMLDivElement>(null);
  const wfCanvasRef = useRef<HTMLCanvasElement>(null);
  const [wfSize, setWfSize] = useState({ width: 800, height: 140 });

  useEffect(() => {
    const el = wfContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setWfSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  // Append scrolling waterfall row per frame when waterfall tab is active
  useEffect(() => {
    if (mode !== 'waterfall' || !isSignalActive) return;
    const canvas = wfCanvasRef.current;
    const fft = fftDbRef.current;
    if (!canvas || !fft) return;

    if (canvas.width !== wfSize.width || canvas.height !== wfSize.height) {
      canvas.width = wfSize.width;
      canvas.height = wfSize.height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    if (w < 10 || h < 10) return;

    // Shift existing image down by 2px
    ctx.drawImage(canvas, 0, 0, w, h - 2, 0, 2, w, h - 2);

    const rowData = ctx.createImageData(w, 2);
    const binHz = sampleRate / settings.fftSize;
    const minLog = Math.log10(20);
    const maxLog = Math.log10(20000);

    for (let x = 0; x < w; x++) {
      const freq = Math.pow(10, minLog + (x / w) * (maxLog - minLog));
      const bin = Math.max(1, Math.min(fft.length - 1, Math.round(freq / binHz)));
      const [r, g, b] = dbToColor(fft[bin]);
      for (let row = 0; row < 2; row++) {
        const idx = (row * w + x) * 4;
        rowData.data[idx] = r;
        rowData.data[idx + 1] = g;
        rowData.data[idx + 2] = b;
        rowData.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(rowData, 0, 0);
  }, [mode, frameVersion, isSignalActive, wfSize, sampleRate, settings.fftSize, fftDbRef]);

  // History stats
  const validPts = splHistory.filter((p) => p.rmsDbfs > -99);
  const leqSpl =
    validPts.length > 0
      ? validPts.reduce((acc, p) => acc + p.splDb, 0) / validPts.length
      : 0;
  const maxSpl = validPts.length > 0 ? Math.max(...validPts.map((p) => p.splDb)) : 0;
  const minSpl = validPts.length > 0 ? Math.min(...validPts.map((p) => p.splDb)) : 0;

  // History SVG path
  const histW = 860;
  const histH = 112;
  const splToY = (db: number) => {
    const clamped = Math.max(-90, Math.min(0, db));
    return 8 + ((0 - clamped) / 90) * (histH - 22);
  };

  const rmsPath = splHistory
    .map((pt, i) => {
      const x = (i / Math.max(1, splHistory.length - 1)) * histW;
      const y = splToY(pt.rmsDbfs);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  const peakPath = splHistory
    .map((pt, i) => {
      const x = (i / Math.max(1, splHistory.length - 1)) * histW;
      const y = splToY(pt.peakDbfs);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <section className="border-t border-slate-800/90 bg-[#0A0E17] px-4 py-3 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-0.5 bg-slate-900/90 border border-slate-800 rounded">
          <button
            type="button"
            onClick={() => onModeChange('history')}
            className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'history'
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Historial SPL (60s)
          </button>
          <button
            type="button"
            onClick={() => onModeChange('waterfall')}
            className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'waterfall'
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Espectrograma (Waterfall)
          </button>
          <button
            type="button"
            onClick={() => onModeChange('bands')}
            className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'bands'
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Bandas ISO (10 Octavas)
          </button>
        </div>

        {mode === 'history' && (
          <div className="flex items-center gap-5 text-xs font-mono tabular-nums text-slate-400">
            <span>
              Leq: <strong className="text-slate-200">{leqSpl.toFixed(1)} dB</strong>
            </span>
            <span>
              Máx: <strong className="text-amber-400">{maxSpl.toFixed(1)} dB</strong>
            </span>
            <span>
              Mín: <strong className="text-slate-300">{minSpl.toFixed(1)} dB</strong>
            </span>
          </div>
        )}

        {mode === 'waterfall' && (
          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
            <span>-100 dB</span>
            <div className="w-24 h-2 rounded-sm bg-gradient-to-r from-[#07090E] via-[#06B6D4] to-[#F59E0B] border border-slate-800" />
            <span>0 dB</span>
          </div>
        )}
      </div>

      {mode === 'history' && (
        <div className="h-[118px] w-full border border-slate-800/80 bg-[#07090E] rounded overflow-hidden relative">
          <svg
            viewBox={`0 0 ${histW} ${histH}`}
            preserveAspectRatio="none"
            className="w-full h-full block"
          >
            {[-12, -30, -48, -66].map((db) => (
              <line
                key={db}
                x1={0}
                y1={splToY(db)}
                x2={histW}
                y2={splToY(db)}
                stroke="#162032"
                strokeWidth={1}
              />
            ))}
            {splHistory.length > 1 && (
              <>
                <path d={peakPath} fill="none" stroke="rgba(245,158,11,0.45)" strokeWidth={1.2} />
                <path d={rmsPath} fill="none" stroke="#06B6D4" strokeWidth={1.8} />
              </>
            )}
          </svg>
          <div className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-3 text-[10px] font-mono text-slate-400">
            <span className="text-cyan-400">― RMS</span>
            <span className="text-amber-400">― Pico</span>
          </div>
        </div>
      )}

      {mode === 'waterfall' && (
        <div
          ref={wfContainerRef}
          className="h-[118px] w-full border border-slate-800/80 bg-[#07090E] rounded overflow-hidden relative"
        >
          <canvas ref={wfCanvasRef} className="w-full h-full block" />
          <div className="pointer-events-none absolute bottom-1 inset-x-3 flex justify-between text-[10px] font-mono text-slate-400/90">
            <span>20 Hz</span>
            <span>100 Hz</span>
            <span>500 Hz</span>
            <span>1 kHz</span>
            <span>5 kHz</span>
            <span>20 kHz</span>
          </div>
        </div>
      )}

      {mode === 'bands' && (
        <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 h-[118px]">
          {ISO_OCTAVE_BANDS.map((b, idx) => {
            const val = octaveLevels[idx] ?? -100;
            const pct = Math.max(0, Math.min(100, ((val + 90) / 90) * 100));
            return (
              <div
                key={b.freq}
                className="flex flex-col justify-between border border-slate-800/80 bg-[#07090E] rounded p-2"
              >
                <div className="text-[11px] font-mono text-slate-400 text-center">
                  {b.label} Hz
                </div>
                <div className="flex-1 my-1.5 w-2.5 mx-auto bg-slate-900 rounded-sm overflow-hidden flex items-end">
                  <div
                    className="w-full bg-cyan-500 transition-[height] duration-75"
                    style={{ height: `${pct}%` }}
                  />
                </div>
                <div className="text-[11px] font-mono tabular-nums text-slate-200 text-center">
                  {val <= -95 ? '—' : `${val.toFixed(0)}`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
