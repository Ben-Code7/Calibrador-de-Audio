import React, { useEffect, useRef, useState } from 'react';
import type { TelemetrySnapshot } from '../types/audio';

interface PhaseGoniometerProps {
  leftTimeRef: React.MutableRefObject<Float32Array | null>;
  rightTimeRef: React.MutableRefObject<Float32Array | null>;
  telemetry: TelemetrySnapshot;
  isSignalActive: boolean;
  frameVersion: number;
}

export const PhaseGoniometer: React.FC<PhaseGoniometerProps> = ({
  leftTimeRef,
  rightTimeRef,
  telemetry,
  isSignalActive,
  frameVersion,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 460, height: 340 });

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

    const cx = size.width / 2;
    const cy = size.height / 2;
    const radius = Math.min(size.width, size.height) * 0.39;

    // Polar rings & diagonal L/R/M/S axes
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    [0.33, 0.66, 1.0].forEach((r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Mid (vertical) & Side (horizontal)
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();

    // L & R 45-degree diagonals
    const diag = radius * Math.SQRT1_2;
    ctx.strokeStyle = '#162032';
    ctx.beginPath();
    ctx.moveTo(cx - diag, cy - diag);
    ctx.lineTo(cx + diag, cy + diag);
    ctx.moveTo(cx + diag, cy - diag);
    ctx.lineTo(cx - diag, cy + diag);
    ctx.stroke();

    // Axis labels
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('+M (Mono)', cx, cy - radius - 6);
    ctx.textBaseline = 'top';
    ctx.fillText('-M', cx, cy + radius + 6);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText('-S', cx - radius - 6, cy);
    ctx.textAlign = 'left';
    ctx.fillText('+S', cx + radius + 6, cy);

    ctx.fillStyle = '#94A3B8';
    ctx.textAlign = 'right';
    ctx.fillText('L', cx - diag - 6, cy - diag - 6);
    ctx.textAlign = 'left';
    ctx.fillText('R', cx + diag + 6, cy - diag - 6);

    const left = leftTimeRef.current;
    const right = rightTimeRef.current;

    if (left && right && isSignalActive) {
      const len = Math.min(left.length, right.length);
      // Auto-scale slightly if signal is quiet so vectorscope stays legible above noise floor
      let peak = 0.05;
      for (let i = 0; i < len; i += 2) {
        const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
        if (a > peak) peak = a;
      }
      const scale = Math.min(8, 0.85 / peak);

      ctx.strokeStyle = 'rgba(6, 182, 212, 0.55)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = 0; i < len; i += 2) {
        const l = left[i] * scale;
        const r = right[i] * scale;
        // Standard goniometer rotation: X = (L - R) / sqrt(2), Y = -(L + R) / sqrt(2)
        const gx = ((r - l) * Math.SQRT1_2) * radius;
        const gy = -((l + r) * Math.SQRT1_2) * radius;
        const px = cx + gx;
        const py = cy + gy;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }, [size, frameVersion, isSignalActive, leftTimeRef, rightTimeRef]);

  const corr = telemetry.phaseCorrelation;
  const corrPct = ((corr + 1) / 2) * 100;
  const corrStatus =
    corr >= 0.5
      ? { label: '● En Fase / Coherente', color: 'text-emerald-400' }
      : corr >= -0.15
      ? { label: '▲ Estéreo Amplio', color: 'text-amber-400' }
      : { label: '✖ Contrafase Crítica', color: 'text-rose-400' };

  const meterWidth = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-full p-4">
      <div ref={containerRef} className="lg:col-span-7 relative min-h-[280px] border border-slate-800/80 bg-[#090D16] rounded">
        <canvas ref={canvasRef} className="block w-full h-full" />
        {!isSignalActive && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-mono text-slate-500">Esperando señal estéreo...</span>
          </div>
        )}
      </div>

      <div className="lg:col-span-5 flex flex-col justify-between gap-4 border border-slate-800/80 bg-[#0B101B] p-4 rounded">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Correlación de Fase (L / R)</span>
            <span className={`text-xs font-mono font-medium ${corrStatus.color}`}>
              {corrStatus.label}
            </span>
          </div>

          <div className="mt-3 flex items-baseline justify-between font-mono tabular-nums">
            <span className="text-3xl font-semibold text-slate-100">
              {corr >= 0 ? `+${corr.toFixed(2)}` : corr.toFixed(2)}
            </span>
            <span className="text-xs text-slate-500">Rango -1.00 a +1.00</span>
          </div>

          {/* Phase Correlation Bar */}
          <div className="mt-3">
            <div className="relative h-3 bg-slate-900 border border-slate-800 rounded-sm overflow-hidden">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-600 z-10" />
              <div
                className={`absolute top-0 bottom-0 w-2 -ml-1 transition-transform duration-75 ${
                  corr >= 0.3 ? 'bg-cyan-400' : corr >= -0.15 ? 'bg-amber-400' : 'bg-rose-500'
                }`}
                style={{ left: `${corrPct}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] font-mono text-slate-500 tabular-nums">
              <span>-1.0 (Invertido)</span>
              <span>0.0 (90°)</span>
              <span>+1.0 (Mono)</span>
            </div>
          </div>
        </div>

        {/* L/R Channel RMS Balance */}
        <div className="border-t border-slate-800/80 pt-4 space-y-3">
          <div className="text-xs font-medium text-slate-400">Balance Estéreo por Canal</div>

          <div>
            <div className="flex justify-between text-xs font-mono tabular-nums mb-1">
              <span className="text-slate-300">Canal Izquierdo (L)</span>
              <span className="text-cyan-400">{telemetry.leftRmsDbfs.toFixed(1)} dBFS</span>
            </div>
            <div className="h-2 bg-slate-900 rounded-sm overflow-hidden border border-slate-800">
              <div
                className="h-full bg-cyan-500 transition-[width] duration-75"
                style={{ width: meterWidth(telemetry.leftRmsDbfs) }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-xs font-mono tabular-nums mb-1">
              <span className="text-slate-300">Canal Derecho (R)</span>
              <span className="text-cyan-400">{telemetry.rightRmsDbfs.toFixed(1)} dBFS</span>
            </div>
            <div className="h-2 bg-slate-900 rounded-sm overflow-hidden border border-slate-800">
              <div
                className="h-full bg-cyan-500 transition-[width] duration-75"
                style={{ width: meterWidth(telemetry.rightRmsDbfs) }}
              />
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between text-xs font-mono tabular-nums text-slate-400 border-t border-slate-800/60">
            <span>Diferencia L - R</span>
            <span className="text-slate-200">
              {(telemetry.leftRmsDbfs - telemetry.rightRmsDbfs >= 0 ? '+' : '')}
              {(telemetry.leftRmsDbfs - telemetry.rightRmsDbfs).toFixed(2)} dB
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
