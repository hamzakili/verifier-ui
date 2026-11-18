import { Mail, FileSpreadsheet, Trash2 } from 'lucide-react';
import StatusBadge from './StatusBadge';
import StatusBreakdown from './StatusBreakdown';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import { PROVIDER_LABELS, entryProvider } from '../context/AppContext';

function ModeTag({ mode, provider }) {
  const short = provider === 'millionverifier' ? 'MV' : 'NB';
  return (
    <span
      title={`${PROVIDER_LABELS[provider]} · ${mode === 'live' ? 'Live' : 'Mock sandbox'}`}
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        mode === 'live' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
      }`}
    >
      {short} · {mode === 'live' ? 'Live' : 'Mock'}
    </span>
  );
}

export default function ActivityTable({ entries, onRemove, relative = true }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-100">
        <thead className="bg-slate-50/60">
          <tr>
            <th className="th">Item</th>
            <th className="th">Result</th>
            <th className="th text-right">Credits</th>
            <th className="th whitespace-nowrap">When</th>
            {onRemove && <th className="th w-10"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50/60">
              <td className="td">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      e.type === 'single' ? 'bg-indigo-50 text-indigo-600' : 'bg-sky-50 text-sky-600'
                    }`}
                  >
                    {e.type === 'single' ? <Mail className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="max-w-[260px] truncate font-medium text-slate-900" title={e.type === 'single' ? e.email : e.filename}>
                      {e.type === 'single' ? e.email : e.filename}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-slate-500">
                      {e.type === 'single' ? 'Single check' : `Bulk · ${formatNumber(e.total)} unique of ${formatNumber(e.totalRows)} rows`}
                      <ModeTag mode={e.mode} provider={entryProvider(e)} />
                    </p>
                  </div>
                </div>
              </td>
              <td className="td">
                {e.type === 'single' ? (
                  <StatusBadge status={e.result} />
                ) : (
                  <div className="w-40">
                    <StatusBreakdown counts={e.counts} height={8} showLegend={false} compact />
                    <p className="mt-1 text-xs text-slate-500">
                      {formatNumber(e.counts?.valid)} valid · {formatNumber((e.counts?.invalid || 0) + (e.counts?.disposable || 0))} blocked
                    </p>
                  </div>
                )}
              </td>
              <td className="td text-right font-medium tabular-nums text-slate-900">−{formatNumber(e.creditsUsed)}</td>
              <td className="td whitespace-nowrap text-slate-500" title={formatDateTime(e.createdAt)}>
                {relative ? formatRelative(e.createdAt) : formatDateTime(e.createdAt)}
              </td>
              {onRemove && (
                <td className="td">
                  <button
                    onClick={() => onRemove(e.id)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    aria-label="Remove entry"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
