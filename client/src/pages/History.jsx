import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { History as HistoryIcon, Search, Download, Trash2 } from 'lucide-react';
import { useApp, entryProvider } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import ActivityTable from '../components/ActivityTable';
import EmptyState from '../components/EmptyState';
import { downloadCsv } from '../lib/csv';
import { formatNumber } from '../lib/format';
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
    </div>
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
