import React, { useState } from 'react';
import { Check, Copy, Download, Sliders } from 'lucide-react';
import { buildEqualizerApoConfig } from '../audio/acousticMath';
import type { CalibrationSettings, EqBandCorrection } from '../types/audio';

interface EqCalibrationViewProps {
  bands: EqBandCorrection[];
  avgDeviationDb: number;
  referenceLevelDb: number;
  settings: CalibrationSettings;
  isSignalActive: boolean;
  onToggleEqPreview: () => void;
  onFreezeCalibration: () => void;
  hasFrozenEq: boolean;
  onClearFrozenEq: () => void;
}

export const EqCalibrationView: React.FC<EqCalibrationViewProps> = ({
  bands,
  avgDeviationDb,
  referenceLevelDb,
  settings,
  isSignalActive,
  onToggleEqPreview,
  onFreezeCalibration,
  hasFrozenEq,
  onClearFrozenEq,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = buildEqualizerApoConfig(bands, settings.targetCurve);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  const handleDownload = () => {
    const text = buildEqualizerApoConfig(bands, settings.targetCurve);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calibracion-eq-${settings.targetCurve}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // SVG deviation chart geometry
  const svgW = 820;
  const svgH = 200;
  const padL = 44;
  const padR = 20;
  const padT = 18;
  const padB = 28;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;
  const maxRange = 15; // +/- 15 dB

  const deltaToY = (d: number) => {
    const clamped = Math.max(-maxRange, Math.min(maxRange, d));
    return padT + ((maxRange - clamped) / (maxRange * 2)) * plotH;
  };

  const bandPoints = bands.map((b, i) => {
    const x = padL + (i / Math.max(1, bands.length - 1)) * plotW;
    const y = deltaToY(b.measuredDb > -95 ? b.deltaDb : 0);
    const yCorr = deltaToY(b.measuredDb > -95 ? b.deltaDb + b.suggestedGainDb : 0);
    return { x, y, yCorr, band: b };
  });

  const measuredPath = bandPoints
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const correctedPath = bandPoints
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.yCorr.toFixed(1)}`)
    .join(' ');

  const tolTop = deltaToY(settings.toleranceDb);
  const tolBottom = deltaToY(-settings.toleranceDb);

  const curveLabel =
    settings.targetCurve === 'flat'
      ? 'Plana (0 dB)'
      : settings.targetCurve === 'room'
      ? 'Sala Calibrada'
      : 'Cine (X-Curve)';

  return (
    <div className="flex flex-col h-full p-4 gap-4 overflow-y-auto">
      {/* Top Action & Summary Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex flex-wrap items-center gap-6 text-xs">
          <div>
            <span className="text-slate-400">Referencia Media (1 kHz): </span>
            <span className="font-mono tabular-nums text-slate-100 font-medium">
              {referenceLevelDb.toFixed(1)} dBFS
            </span>
          </div>
          <div>
            <span className="text-slate-400">Desviación Promedio: </span>
            <span className="font-mono tabular-nums text-cyan-400 font-medium">
              ±{avgDeviationDb.toFixed(2)} dB
            </span>
          </div>
          <div>
            <span className="text-slate-400">Objetivo: </span>
            <span className="font-mono text-slate-200">{curveLabel}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={hasFrozenEq ? onClearFrozenEq : onFreezeCalibration}
            disabled={!isSignalActive && !hasFrozenEq}
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              hasFrozenEq
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-slate-600'
            }`}
          >
            {hasFrozenEq ? 'Desbloquear Medición EQ' : 'Capturar Medición EQ'}
          </button>

          <button
            type="button"
            onClick={onToggleEqPreview}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              settings.eqPreviewEnabled
                ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            {settings.eqPreviewEnabled ? 'EQ Aplicado al Generador' : 'Probar EQ en Generador'}
          </button>

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-slate-900 border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copiado' : 'Copiar APO'}
          </button>

          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar .TXT
          </button>
        </div>
      </div>

      {/* Deviation SVG Graph */}
      <div className="border border-slate-800/80 bg-[#090D16] rounded p-3">
        <div className="flex items-center justify-between mb-2 text-xs">
          <span className="font-medium text-slate-300">
            Error de Respuesta por Octava (Δ dB respecto a curva objetivo)
          </span>
          <div className="flex items-center gap-4 font-mono text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-0.5 bg-cyan-400" /> Medido (Δ)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-0.5 border-t border-dashed border-amber-400" /> Proyección Post-EQ
            </span>
          </div>
        </div>

        <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-44 overflow-visible">
          {/* Tolerance corridor */}
          <rect
            x={padL}
            y={tolTop}
            width={plotW}
            height={Math.max(2, tolBottom - tolTop)}
            fill="rgba(16, 185, 129, 0.08)"
          />

          {/* Horizontal dB gridlines */}
          {[-12, -6, 0, 6, 12].map((db) => {
            const y = deltaToY(db);
            return (
              <g key={db}>
                <line
                  x1={padL}
                  y1={y}
                  x2={padL + plotW}
                  y2={y}
                  stroke={db === 0 ? '#334155' : '#162032'}
                  strokeWidth={1}
                />
                <text
                  x={padL - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-500 text-[10px] font-mono"
                >
                  {db > 0 ? `+${db}` : db}
                </text>
              </g>
            );
          })}

          {/* Vertical band markers */}
          {bandPoints.map((pt) => (
            <g key={pt.band.freqHz}>
              <line
                x1={pt.x}
                y1={padT}
                x2={pt.x}
                y2={padT + plotH}
                stroke="#111827"
                strokeWidth={1}
              />
              <text
                x={pt.x}
                y={padT + plotH + 16}
                textAnchor="middle"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {pt.band.label.replace(' Hz', '')}
              </text>
            </g>
          ))}

          {/* Projected Post-EQ curve */}
          <path
            d={correctedPath}
            fill="none"
            stroke="#F59E0B"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />

          {/* Measured Delta curve */}
          <path d={measuredPath} fill="none" stroke="#06B6D4" strokeWidth={2} />

          {bandPoints.map((pt) => (
            <circle
              key={pt.band.freqHz}
              cx={pt.x}
              cy={pt.y}
              r={3.5}
              fill={pt.band.withinTolerance ? '#10B981' : '#06B6D4'}
              stroke="#090D16"
              strokeWidth={1.5}
            />
          ))}
        </svg>
      </div>

      {/* Parametric EQ Correction Table */}
      <div className="border border-slate-800/80 bg-[#0B101B] rounded overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 font-medium">
              <th className="py-2.5 px-3">Banda</th>
              <th className="py-2.5 px-3 text-right">Medido</th>
              <th className="py-2.5 px-3 text-right">Objetivo</th>
              <th className="py-2.5 px-3 text-right">Desviación (Δ)</th>
              <th className="py-2.5 px-3 text-right">Ganancia EQ</th>
              <th className="py-2.5 px-3 text-right">Factor Q</th>
              <th className="py-2.5 px-3 text-right">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
            {bands.map((b) => {
              const noSignal = b.measuredDb <= -95;
              const deltaStr = noSignal ? '—' : `${b.deltaDb >= 0 ? '+' : ''}${b.deltaDb.toFixed(1)} dB`;
              const gainStr = noSignal
                ? '0.0 dB'
                : `${b.suggestedGainDb >= 0 ? '+' : ''}${b.suggestedGainDb.toFixed(1)} dB`;

              return (
                <tr key={b.freqHz} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-2 px-3 text-slate-200 font-medium">{b.label}</td>
                  <td className="py-2 px-3 text-right text-slate-300">
                    {noSignal ? '—' : `${b.measuredDb.toFixed(1)} dBFS`}
                  </td>
                  <td className="py-2 px-3 text-right text-slate-400">
                    {b.targetDb.toFixed(1)} dBFS
                  </td>
                  <td
                    className={`py-2 px-3 text-right ${
                      noSignal
                        ? 'text-slate-500'
                        : Math.abs(b.deltaDb) <= settings.toleranceDb
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {deltaStr}
                  </td>
                  <td className="py-2 px-3 text-right text-cyan-400 font-semibold">{gainStr}</td>
                  <td className="py-2 px-3 text-right text-slate-300">{b.qFactor.toFixed(2)}</td>
                  <td className="py-2 px-3 text-right font-sans">
                    {noSignal ? (
                      <span className="text-slate-500">○ Sin señal</span>
                    ) : b.withinTolerance ? (
                      <span className="text-emerald-400">● En rango</span>
                    ) : (
                      <span className="text-amber-400">▲ Corregir</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
