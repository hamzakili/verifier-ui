import { useState } from 'react';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { formatNumber, formatPercent } from '../lib/format';

/**
 * Horizontal stacked bar of verification statuses with a legend and hover tooltip.
 * Segments are separated by a 2px surface gap; each segment carries an aria-label
 * and the legend repeats counts/percentages so identity never relies on color alone.
 */
export default function StatusBreakdown({ counts, height = 14, showLegend = true, compact = false }) {
  const [hover, setHover] = useState(null);
  const total = STATUS_ORDER.reduce((s, k) => s + (counts?.[k] || 0), 0);
  const segments = STATUS_ORDER.filter((k) => counts?.[k] > 0);

  if (!total) {
    return (
      <div>
        <div className="w-full rounded-full bg-slate-100" style={{ height }} />
        {!compact && <p className="mt-3 text-sm text-slate-500">No verifications yet.</p>}
      </div>
    );
  }

  return (
    <div>
      <div className="relative">
        <div className="flex w-full gap-[2px] overflow-hidden rounded-full bg-white" style={{ height }} role="img" aria-label="Status distribution">
          {segments.map((k) => {
            const pct = (counts[k] / total) * 100;
            return (
              <div
                key={k}
                className="h-full cursor-default transition-opacity first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${pct}%`,
                  minWidth: 3,
                  backgroundColor: STATUS_META[k].color,
                  opacity: hover && hover !== k ? 0.35 : 1,
                }}
                onMouseEnter={() => setHover(k)}
                onMouseLeave={() => setHover(null)}
                aria-label={`${STATUS_META[k].label}: ${counts[k]} (${formatPercent(counts[k], total)})`}
              />
            );
          })}
        </div>
        {hover && !compact && (
          <div className="pointer-events-none absolute -top-11 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
            <span className="font-medium">{STATUS_META[hover].label}</span>
            <span className="text-slate-300"> · {formatNumber(counts[hover])} · {formatPercent(counts[hover], total)}</span>
          </div>
        )}
      </div>

      {showLegend && (
        <ul className={`mt-4 grid gap-2 ${compact ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'}`}>
          {STATUS_ORDER.map((k) => {
            const n = counts?.[k] || 0;
            return (
              <li
                key={k}
                onMouseEnter={() => setHover(k)}
                onMouseLeave={() => setHover(null)}
                className={`rounded-lg border px-3 py-2 transition-colors ${hover === k ? 'border-slate-300 bg-slate-50' : 'border-slate-200'}`}
              >
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_META[k].color }} />
                  {STATUS_META[k].label}
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-lg font-semibold tabular-nums text-slate-900">{formatNumber(n)}</span>
                  <span className="text-xs tabular-nums text-slate-500">{formatPercent(n, total)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
