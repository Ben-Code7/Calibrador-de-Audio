import React, { useEffect, useRef, useState } from 'react';
import {
  computeBandLevels,
  formatFreqLabel,
  freqToNote,
  getTargetCurveOffsetDb,
  ISO_THIRD_OCTAVE_FREQS,
} from '../audio/acousticMath';
import type { CalibrationSettings } from '../types/audio';

interface RtaCanvasProps {
  fftDbRef: React.MutableRefObject<Float32Array | null>;
  peakHoldFftRef: React.MutableRefObject<Float32Array | null>;
  referenceTrace: Float32Array | null;
  sampleRate: number;
  settings: CalibrationSettings;
  isSignalActive: boolean;
  generatorFreqHz: number;
  generatorEnabled: boolean;
  generatorWaveform: string;
  frameVersion: number;
}

const GRID_FREQS = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];
const LABELED_FREQS = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
const DB_MIN = -100;
const DB_MAX = 0;
const DB_LINES = [0, -12, -24, -36, -48, -60, -72, -84, -96];

function freqToX(freq: number, left: number, width: number): number {
  const minLog = Math.log10(20);
  const maxLog = Math.log10(20000);
  const norm = (Math.log10(Math.max(20, Math.min(20000, freq))) - minLog) / (maxLog - minLog);
  return left + norm * width;
}

function xToFreq(x: number, left: number, width: number): number {
  const minLog = Math.log10(20);
  const maxLog = Math.log10(20000);
  const norm = Math.max(0, Math.min(1, (x - left) / width));
  return Math.pow(10, minLog + norm * (maxLog - minLog));
}

function dbToY(db: number, top: number, height: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db));
  const norm = (DB_MAX - clamped) / (DB_MAX - DB_MIN);
  return top + norm * height;
}

function yToDb(y: number, top: number, height: number): number {
  const norm = Math.max(0, Math.min(1, (y - top) / height));
  return DB_MAX - norm * (DB_MAX - DB_MIN);
}

export const RtaCanvas: React.FC<RtaCanvasProps> = ({
  fftDbRef,
  peakHoldFftRef,
  referenceTrace,
  sampleRate,
  settings,
  isSignalActive,
  generatorFreqHz,
  generatorEnabled,
  generatorWaveform,
  frameVersion,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 400 });
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padLeft = 48;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 30;
  const plotW = Math.max(100, size.width - padLeft - padRight);
  const plotH = Math.max(100, size.height - padTop - padBottom);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear obsidian background
    ctx.fillStyle = '#090D16';
    ctx.fillRect(0, 0, size.width, size.height);

    // Draw grid lines
    ctx.lineWidth = 1;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    for (const db of DB_LINES) {
      const y = Math.round(dbToY(db, padTop, plotH)) + 0.5;
      ctx.strokeStyle = db === 0 ? '#334155' : '#162032';
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'right';
      ctx.fillText(`${db}`, padLeft - 8, y);
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const freq of GRID_FREQS) {
      const x = Math.round(freqToX(freq, padLeft, plotW)) + 0.5;
      ctx.strokeStyle = LABELED_FREQS.has(freq) ? '#1E293B' : '#111827';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();

      if (LABELED_FREQS.has(freq)) {
        ctx.fillStyle = '#64748B';
        const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
        ctx.fillText(label, x, padTop + plotH + 8);
      }
    }

    // Plot border
    ctx.strokeStyle = '#1E293B';
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW, plotH);

    // Target curve tolerance band around -24 dBFS reference (or midrange anchor if active)
    const fft = fftDbRef.current;
    const binHz = sampleRate / settings.fftSize;

    // Determine midrange anchor for target curve
    let targetAnchorDb = -30;
    if (fft && isSignalActive) {
      const b500 = Math.round(500 / binHz);
      const b2000 = Math.round(2000 / binHz);
      let sum = 0;
      let cnt = 0;
      for (let i = Math.max(1, b500); i <= Math.min(fft.length - 1, b2000); i++) {
        if (fft[i] > -95) {
          sum += fft[i];
          cnt++;
        }
      }
      if (cnt > 0) targetAnchorDb = sum / cnt;
    }

    if (settings.targetCurve !== 'flat' || isSignalActive) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(padLeft, padTop, plotW, plotH);
      ctx.clip();

      // Tolerance band fill
      ctx.fillStyle = 'rgba(148, 163, 184, 0.05)';
      ctx.beginPath();
      for (let px = 0; px <= plotW; px += 6) {
        const f = xToFreq(padLeft + px, padLeft, plotW);
        const targetDb = targetAnchorDb + getTargetCurveOffsetDb(f, settings.targetCurve) + settings.toleranceDb;
        const y = dbToY(targetDb, padTop, plotH);
        if (px === 0) ctx.moveTo(padLeft + px, y);
        else ctx.lineTo(padLeft + px, y);
      }
      for (let px = plotW; px >= 0; px -= 6) {
        const f = xToFreq(padLeft + px, padLeft, plotW);
        const targetDb = targetAnchorDb + getTargetCurveOffsetDb(f, settings.targetCurve) - settings.toleranceDb;
        const y = dbToY(targetDb, padTop, plotH);
        ctx.lineTo(padLeft + px, y);
      }
      ctx.closePath();
      ctx.fill();

      // Target curve center line
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let px = 0; px <= plotW; px += 6) {
        const f = xToFreq(padLeft + px, padLeft, plotW);
        const targetDb = targetAnchorDb + getTargetCurveOffsetDb(f, settings.targetCurve);
        const y = dbToY(targetDb, padTop, plotH);
        if (px === 0) ctx.moveTo(padLeft + px, y);
        else ctx.lineTo(padLeft + px, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Generator frequency marker if sine/square/triangle/sweep is active
    if (generatorEnabled && generatorWaveform !== 'pink' && generatorWaveform !== 'white') {
      const gx = freqToX(generatorFreqHz, padLeft, plotW);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(gx, padTop);
      ctx.lineTo(gx, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft + 1, padTop + 1, plotW - 2, plotH - 2);
    ctx.clip();

    // Draw Reference Snapshot trace if captured
    if (referenceTrace && referenceTrace.length > 0) {
      const refBinHz = sampleRate / (referenceTrace.length * 2);
      ctx.strokeStyle = '#10B981';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      let started = false;
      for (let px = 0; px <= plotW; px += 2) {
        const f = xToFreq(padLeft + px, padLeft, plotW);
        const binFloat = f / refBinHz;
        const b0 = Math.max(1, Math.min(referenceTrace.length - 2, Math.floor(binFloat)));
        const frac = binFloat - b0;
        const val = referenceTrace[b0] * (1 - frac) + referenceTrace[b0 + 1] * frac;
        const y = dbToY(val, padTop, plotH);
        if (!started) {
          ctx.moveTo(padLeft + px, y);
          started = true;
        } else {
          ctx.lineTo(padLeft + px, y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (fft && isSignalActive) {
      // 1/3 Octave Bars
      if (settings.rtaDisplayMode === 'bars' || settings.rtaDisplayMode === 'both') {
        const bandLevels = computeBandLevels(
          fft,
          sampleRate,
          settings.fftSize,
          settings.weighting,
          ISO_THIRD_OCTAVE_FREQS,
          3
        );
        const factor = Math.pow(2, 1 / 6);
        for (let i = 0; i < ISO_THIRD_OCTAVE_FREQS.length; i++) {
          const fc = ISO_THIRD_OCTAVE_FREQS[i];
          const x1 = freqToX(fc / factor, padLeft, plotW);
          const x2 = freqToX(fc * factor, padLeft, plotW);
          const barW = Math.max(2, x2 - x1 - 2);
          const yTop = dbToY(bandLevels[i], padTop, plotH);
          const barH = Math.max(0, padTop + plotH - yTop);

          ctx.fillStyle =
            settings.rtaDisplayMode === 'bars'
              ? 'rgba(6, 182, 212, 0.55)'
              : 'rgba(6, 182, 212, 0.16)';
          ctx.fillRect(x1 + 1, yTop, barW, barH);

          if (settings.rtaDisplayMode === 'bars') {
            ctx.fillStyle = '#22D3EE';
            ctx.fillRect(x1 + 1, yTop, barW, 2);
          }
        }
      }

      // Peak-Hold Trace
      const peakFft = peakHoldFftRef.current;
      if (settings.showPeakHold && peakFft && peakFft.length === fft.length) {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.78)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        let started = false;
        for (let px = 0; px <= plotW; px += 2) {
          const f = xToFreq(padLeft + px, padLeft, plotW);
          const binFloat = f / binHz;
          const b0 = Math.max(1, Math.min(peakFft.length - 2, Math.floor(binFloat)));
          const b1 = Math.min(peakFft.length - 1, b0 + 1);
          const frac = binFloat - b0;
          const val = peakFft[b0] * (1 - frac) + peakFft[b1] * frac;
          const y = dbToY(val, padTop, plotH);
          if (!started) {
            ctx.moveTo(padLeft + px, y);
            started = true;
          } else {
            ctx.lineTo(padLeft + px, y);
          }
        }
        ctx.stroke();
      }

      // Live FFT Curve
      if (settings.rtaDisplayMode === 'curve' || settings.rtaDisplayMode === 'both') {
        const points: Array<{ x: number; y: number }> = [];
        for (let px = 0; px <= plotW; px += 2) {
          const f = xToFreq(padLeft + px, padLeft, plotW);
          const binFloat = f / binHz;
          const b0 = Math.max(1, Math.min(fft.length - 2, Math.floor(binFloat)));
          const b1 = Math.min(fft.length - 1, b0 + 1);
          const frac = binFloat - b0;
          const val = fft[b0] * (1 - frac) + fft[b1] * frac;
          points.push({ x: padLeft + px, y: dbToY(val, padTop, plotH) });
        }

        if (points.length > 1) {
          // Fill under curve
          const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
          grad.addColorStop(0, 'rgba(6, 182, 212, 0.28)');
          grad.addColorStop(1, 'rgba(6, 182, 212, 0.01)');

          ctx.beginPath();
          ctx.moveTo(points[0].x, padTop + plotH);
          for (const pt of points) ctx.lineTo(pt.x, pt.y);
          ctx.lineTo(points[points.length - 1].x, padTop + plotH);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();

          // Stroke curve
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
          }
          ctx.strokeStyle = '#06B6D4';
          ctx.lineWidth = 1.75;
          ctx.stroke();
        }
      }
    }

    // Hover crosshair reticle
    if (hoverPos && hoverPos.x >= padLeft && hoverPos.x <= padLeft + plotW && hoverPos.y >= padTop && hoverPos.y <= padTop + plotH) {
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.32)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hoverPos.x, padTop);
      ctx.lineTo(hoverPos.x, padTop + plotH);
      ctx.moveTo(padLeft, hoverPos.y);
      ctx.lineTo(padLeft + plotW, hoverPos.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }, [
    size,
    frameVersion,
    isSignalActive,
    settings,
    referenceTrace,
    sampleRate,
    generatorFreqHz,
    generatorEnabled,
    generatorWaveform,
    hoverPos,
    fftDbRef,
    peakHoldFftRef,
    plotW,
    plotH,
  ]);

  // Compute live crosshair telemetry
  let hoverInfo: { freqLabel: string; noteLabel: string; dbLabel: string; splLabel: string } | null = null;
  if (
    hoverPos &&
    hoverPos.x >= padLeft &&
    hoverPos.x <= padLeft + plotW &&
    hoverPos.y >= padTop &&
    hoverPos.y <= padTop + plotH
  ) {
    const f = xToFreq(hoverPos.x, padLeft, plotW);
    const cursorDb = yToDb(hoverPos.y, padTop, plotH);
    // Also read actual measured FFT value at hovered frequency if active
    let measuredDb = cursorDb;
    const fft = fftDbRef.current;
    if (fft && isSignalActive) {
      const binHz = sampleRate / settings.fftSize;
      const bin = Math.max(1, Math.min(fft.length - 1, Math.round(f / binHz)));
      measuredDb = fft[bin];
    }
    const note = freqToNote(f);
    hoverInfo = {
      freqLabel: formatFreqLabel(f),
      noteLabel: note ? note.label : '—',
      dbLabel: `${measuredDb.toFixed(1)} dBFS`,
      splLabel: `${Math.max(0, measuredDb + settings.splOffsetDb).toFixed(1)} dB SPL`,
    };
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[300px] select-none">
      <canvas
        ref={canvasRef}
        className="block w-full h-full cursor-crosshair"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
        onMouseLeave={() => setHoverPos(null)}
      />

      {/* Top-right Legend */}
      <div className="pointer-events-none absolute top-3 right-6 flex items-center gap-4 text-[11px] font-mono text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-cyan-400" />
          Espectro ({settings.weighting})
        </span>
        {settings.showPeakHold && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 bg-amber-400" />
            Pico Máx
          </span>
        )}
        {referenceTrace && (
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className="inline-block w-3 h-0.5 border-t border-dashed border-emerald-400" />
            Referencia
          </span>
        )}
      </div>

      {/* Crosshair HUD */}
      {hoverInfo && (
        <div className="pointer-events-none absolute top-3 left-14 bg-[#07090E]/90 border border-slate-700/80 px-2.5 py-1.5 rounded text-[11px] font-mono tabular-nums text-slate-200 flex items-center gap-3">
          <span className="text-cyan-400 font-semibold">{hoverInfo.freqLabel}</span>
          <span className="text-slate-400">{hoverInfo.noteLabel}</span>
          <span>{hoverInfo.dbLabel}</span>
          <span className="text-slate-400">{hoverInfo.splLabel}</span>
        </div>
      )}

      {/* Idle State Guidance */}
      {!isSignalActive && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <p className="text-sm font-medium text-slate-300">
            Sin flujo de audio activo en el analizador
          </p>
          <p className="mt-1 text-xs text-slate-500 max-w-md">
            Presione <span className="text-cyan-400">Activar Micrófono</span> para medir su sala o active el <span className="text-amber-400">Generador en Bucle Interno</span> para calibrar sin hardware externo.
          </p>
        </div>
      )}
    </div>
  );
};
