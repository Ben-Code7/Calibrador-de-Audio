import React, { useEffect, useRef, useState } from 'react';
import type { CalibrationSettings } from '../types/audio';

interface OscilloscopeCanvasProps {
  timeDomainRef: React.MutableRefObject<Float32Array | null>;
  sampleRate: number;
  settings: CalibrationSettings;
  isSignalActive: boolean;
  frameVersion: number;
}

export const OscilloscopeCanvas: React.FC<OscilloscopeCanvasProps> = ({
  timeDomainRef,
  sampleRate,
  settings,
  isSignalActive,
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
  const totalMs = settings.timebaseMs * 10; // 10 horizontal divisions

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#090D16';
    ctx.fillRect(0, 0, size.width, size.height);

    // 8 vertical amplitude divisions (-1.0 to +1.0)
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 8; i++) {
      const y = Math.round(padTop + (i / 8) * plotH) + 0.5;
      const amp = 1 - (i / 4);
      ctx.strokeStyle = i === 4 ? '#334155' : '#162032';
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      if (i % 2 === 0) {
        ctx.fillStyle = '#64748B';
        ctx.fillText(amp.toFixed(1), padLeft - 8, y);
      }
    }

    // 10 horizontal time divisions
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 10; i++) {
      const x = Math.round(padLeft + (i / 10) * plotW) + 0.5;
      ctx.strokeStyle = i === 5 ? '#1E293B' : '#111827';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();

      if (i % 2 === 0) {
        ctx.fillStyle = '#64748B';
        ctx.fillText(`${(i * settings.timebaseMs).toFixed(0)} ms`, x, padTop + plotH + 8);
      }
    }

    ctx.strokeStyle = '#1E293B';
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW, plotH);

    const samples = timeDomainRef.current;
    if (samples && isSignalActive) {
      const samplesNeeded = Math.min(samples.length, Math.floor((totalMs / 1000) * sampleRate));
      let triggerOffset = 0;

      // Rising-edge zero-crossing trigger in first half of buffer
      if (settings.triggerEnabled) {
        const searchLimit = Math.max(1, samples.length - samplesNeeded);
        for (let i = 1; i < searchLimit; i++) {
          if (samples[i - 1] < 0 && samples[i] >= 0) {
            triggerOffset = i;
            break;
          }
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(padLeft + 1, padTop + 1, plotW - 2, plotH - 2);
      ctx.clip();

      ctx.strokeStyle = '#06B6D4';
      ctx.lineWidth = 1.8;
      ctx.beginPath();

      const step = Math.max(1, Math.floor(samplesNeeded / plotW));
      for (let px = 0; px <= plotW; px++) {
        const idx = Math.min(
          samples.length - 1,
          triggerOffset + Math.floor((px / plotW) * samplesNeeded)
        );
        // If stepped downsampling, find min/max peak in slice to preserve transients
        let val = samples[idx];
        if (step > 2) {
          let maxAbs = val;
          for (let s = 0; s < step && idx + s < samples.length; s++) {
            if (Math.abs(samples[idx + s]) > Math.abs(maxAbs)) {
              maxAbs = samples[idx + s];
            }
          }
          val = maxAbs;
        }

        const clamped = Math.max(-1, Math.min(1, val));
        const y = padTop + ((1 - clamped) / 2) * plotH;
        if (px === 0) ctx.moveTo(padLeft + px, y);
        else ctx.lineTo(padLeft + px, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (
      hoverPos &&
      hoverPos.x >= padLeft &&
      hoverPos.x <= padLeft + plotW &&
      hoverPos.y >= padTop &&
      hoverPos.y <= padTop + plotH
    ) {
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hoverPos.x, padTop);
      ctx.lineTo(hoverPos.x, padTop + plotH);
      ctx.moveTo(padLeft, hoverPos.y);
      ctx.lineTo(padLeft + plotW, hoverPos.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [size, frameVersion, isSignalActive, settings.timebaseMs, settings.triggerEnabled, sampleRate, hoverPos, timeDomainRef, plotW, plotH, totalMs]);

  let cursorStats: { timeMs: string; amplitude: string; dbfs: string } | null = null;
  if (
    hoverPos &&
    hoverPos.x >= padLeft &&
    hoverPos.x <= padLeft + plotW &&
    hoverPos.y >= padTop &&
    hoverPos.y <= padTop + plotH
  ) {
    const tMs = ((hoverPos.x - padLeft) / plotW) * totalMs;
    const amp = 1 - ((hoverPos.y - padTop) / plotH) * 2;
    const db = 20 * Math.log10(Math.max(Math.abs(amp), 1e-4));
    cursorStats = {
      timeMs: `${tMs.toFixed(2)} ms`,
      amplitude: `${amp >= 0 ? '+' : ''}${amp.toFixed(3)}`,
      dbfs: `${db.toFixed(1)} dBFS`,
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

      <div className="pointer-events-none absolute top-3 right-6 flex items-center gap-4 text-[11px] font-mono text-slate-400">
        <span>Base: {settings.timebaseMs} ms/div</span>
        <span>Disparo: {settings.triggerEnabled ? 'Flanco Ascendente (0 V)' : 'Libre'}</span>
      </div>

      {cursorStats && (
        <div className="pointer-events-none absolute top-3 left-14 bg-[#07090E]/90 border border-slate-700/80 px-2.5 py-1.5 rounded text-[11px] font-mono tabular-nums text-slate-200 flex items-center gap-3">
          <span className="text-cyan-400 font-semibold">{cursorStats.timeMs}</span>
          <span>{cursorStats.amplitude}</span>
          <span className="text-slate-400">{cursorStats.dbfs}</span>
        </div>
      )}

      {!isSignalActive && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <p className="text-sm font-medium text-slate-300">Osciloscopio en espera de señal</p>
          <p className="mt-1 text-xs text-slate-500 max-w-md">
            Active el micrófono o inicie el generador en bucle interno para visualizar la forma de onda en el dominio del tiempo.
          </p>
        </div>
      )}
    </div>
  );
};
