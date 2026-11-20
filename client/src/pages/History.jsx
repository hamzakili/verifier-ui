import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { History as HistoryIcon, Search, Download, Trash2, Layers } from 'lucide-react';
import { useApp, entryProvider } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import ActivityTable from '../components/ActivityTable';
import EmptyState from '../components/EmptyState';
import { JobStatusPill } from '../components/bulk/StatusPill';
import { api, downloadFromApi, downloadPaths } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import { formatDateTime, formatNumber } from '../lib/format';
import { STATUS_ORDER } from '../lib/status';

const TYPE_TABS = [
  { id: 'all', label: 'All' },
  { id: 'single', label: 'Single' },
  { id: 'bulk', label: 'Bulk' },
];

export default function History() {
  const { history, clearHistory, removeHistoryEntry, stats } = useApp();
  const toast = useToast();
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter(
      (h) => (type === 'all' || h.type === type) && (!q || (h.email || h.filename || '').toLowerCase().includes(q)),
    );
  }, [history, type, query]);

  const exportHistory = () => {
    const rows = filtered.map((h) => ({
      timestamp: h.createdAt,
      type: h.type,
      provider: entryProvider(h),
      mode: h.mode,
      target: h.type === 'single' ? h.email : h.filename,
      result: h.type === 'single' ? h.result : '',
      suggested_correction: h.suggestedCorrection || '',
      unique_emails: h.total,
      ...Object.fromEntries(STATUS_ORDER.map((k) => [k, h.counts?.[k] || 0])),
      credits_used: h.creditsUsed,
    }));
    downloadCsv(rows, `verification-history-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MiniStat label="Entries" value={history.length} />
        <MiniStat label="Single checks" value={history.filter((h) => h.type === 'single').length} />
        <MiniStat label="Bulk jobs" value={history.filter((h) => h.type === 'bulk').length} />
        <MiniStat label="Credits used" value={stats.creditsUsed} />
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-1">
            {TYPE_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setType(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  type === t.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input py-2 pl-9" placeholder="Search email or file…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary py-2" onClick={exportHistory} disabled={!filtered.length}>
                <Download className="h-4 w-4" /> Export
              </button>
              {confirming ? (
                <div className="flex gap-1">
                  <button
                    className="btn py-2 bg-red-600 text-white hover:bg-red-700"
                    onClick={() => {
                      clearHistory();
                      setConfirming(false);
                      toast.success('Verification history cleared.');
                    }}
                  >
                    Confirm
                  </button>
                  <button className="btn-ghost py-2" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn-ghost py-2 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setConfirming(true)} disabled={!history.length}>
                  <Trash2 className="h-4 w-4" /> Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {filtered.length ? (
          <ActivityTable entries={filtered} onRemove={removeHistoryEntry} relative={false} />
        ) : history.length ? (
          <EmptyState icon={Search} title="No matching entries" description="Try another filter or search term." />
        ) : (
          <EmptyState
            icon={HistoryIcon}
            title="No history yet"
            description="Single checks and bulk jobs are logged here (stored locally in this browser)."
            action={
              <Link to="/single" className="btn-primary">
                Verify an email
              </Link>
            }
          />
        )}
      </section>
      <p className="text-center text-xs text-slate-400">History is stored in this browser’s local storage (up to 500 entries).</p>

      <BulkJobHistory />
    </div>
  );
}

/** Finished bulk verification jobs (stored on the server, so they survive browser resets). */
function BulkJobHistory() {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, jobs: [], total: 0, error: null });
  useEffect(() => {
    let cancelled = false;
    api.verificationJobs({ status: 'completed,completed_with_errors,cancelled,failed', limit: 10 }).then(
      (r) => !cancelled && setState({ loading: false, jobs: r.jobs, total: r.meta.total, error: null }),
      (err) => !cancelled && setState({ loading: false, jobs: [], total: 0, error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Layers className="h-4 w-4 text-indigo-600" /> Bulk verification jobs</h2>
        <Link to="/bulk-jobs" className="text-sm font-medium text-indigo-700 hover:underline">View all{state.total > state.jobs.length ? ` (${formatNumber(state.total)})` : ''}</Link>
      </div>
      {state.error ? (
        <p className="px-4 py-3 text-sm text-red-700">{state.error}</p>
      ) : !state.loading && !state.jobs.length ? (
        <EmptyState icon={Layers} title="No finished bulk jobs yet" description="Jobs you run from Bulk Verification Jobs appear here when they finish." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Job name</th>
                <th className="th text-right">Total leads</th>
                <th className="th">Results</th>
                <th className="th">Completed</th>
                <th className="th">Destination</th>
                <th className="th">Status</th>
                <th className="th text-right">Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.jobs.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50/60">
                  <td className="td"><Link to={`/bulk-jobs/${j.id}`} className="font-medium text-indigo-700 hover:underline">{j.job_name}</Link></td>
                  <td className="td text-right tabular-nums">{formatNumber(j.total_eligible)}</td>
                  <td className="td whitespace-nowrap text-xs">
                    <span className="text-emerald-700">{formatNumber(j.counts.valid)} valid</span> · <span className="text-red-700">{formatNumber(j.counts.invalid)} invalid</span> ·{' '}
                    <span className="text-slate-600">{formatNumber(j.counts.disposable + j.counts.catchall + j.counts.unknown)} other</span>
                  </td>
                  <td className="td whitespace-nowrap text-slate-500">{j.completed_at ? formatDateTime(j.completed_at) : '—'}</td>
                  <td className="td max-w-[200px] truncate text-slate-600" title={j.destination_folder?.path}>{j.destination_folder?.folder_name ?? '—'}</td>
                  <td className="td"><JobStatusPill status={j.status} /></td>
                  <td className="td text-right">
                    {j.files.some((f) => f.kind === 'all_results') ? (
                      <button className="btn-ghost px-2 py-1" aria-label={`Download results of ${j.job_name}`} onClick={() => downloadFromApi(downloadPaths.job(j.id)).catch((e) => toast.error(e.message))}>
                        <Download className="h-4 w-4" />
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums text-slate-900">{formatNumber(value)}</p>
    </div>
  );
}
