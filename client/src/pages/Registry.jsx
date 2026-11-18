import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Search, Loader2, AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, ListChecks } from 'lucide-react';
import { api } from '../lib/api';
import { useApp, PROVIDER_LABELS } from '../context/AppContext';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';
import { formatDateTime, formatNumber } from '../lib/format';

const PAGE_SIZE = 25;
const STATUS_OPTIONS = ['completed', 'pending', 'failed'];
const RESULT_OPTIONS = ['valid', 'invalid', 'risky', 'unverifiable', 'unknown'];
const PROVIDER_OPTIONS = ['millionverifier', 'neverbounce', 'other'];
const SORT_OPTIONS = [
  { value: 'created_at:desc', label: 'Newest first' },
  { value: 'created_at:asc', label: 'Oldest first' },
  { value: 'verified_at:desc', label: 'Recently verified' },
  { value: 'updated_at:desc', label: 'Recently updated' },
];
const STATUS_STYLE = {
  completed: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  failed: 'bg-red-50 text-red-700',
};

export default function Registry() {
  const { server } = useApp();
  const db = server.centralDb;
  if (db && !db.enabled) {
    return (
      <section className="card">
        <EmptyState
          icon={Database}
          title="Email registry not configured"
          description="Set EMAIL_REGISTRY_API_URL and EMAIL_REGISTRY_API_TOKEN in server/.env and restart the server."
        />
      </section>
    );
  }
  return (
    <div className="space-y-6">
      <Stats />
      <Records />
      <BatchLookup />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Stats() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, data: await api.registryStats(), error: null });
    } catch (err) {
      setState({ loading: false, data: null, error: err.message });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const s = state.data?.stats;
  const q = state.data?.saveQueue;
  return (
    <section>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MiniStat label="Records" value={s?.total} loading={state.loading} />
        <MiniStat label="Completed" value={s?.by_status?.completed} loading={state.loading} />
        <MiniStat label="Valid" value={s?.by_result?.valid} loading={state.loading} />
        <MiniStat label="Pending / failed" value={s ? (s.by_status?.pending || 0) + (s.by_status?.failed || 0) : null} loading={state.loading} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        {state.error ? (
          <span className="flex items-center gap-1.5 text-red-600">
            <AlertTriangle className="h-3.5 w-3.5" /> {state.error}
          </span>
        ) : (
          <span>
            {s?.last_updated_at ? `Last updated ${formatDateTime(s.last_updated_at)}` : 'Shared registry of verification results'}
            {q && (q.queued > 0 || q.failed > 0) && (
              <>
                {' · '}
                {formatNumber(q.queued)} result(s) waiting to be saved{q.failed ? `, ${formatNumber(q.failed)} could not be saved` : ''}
              </>
            )}
          </span>
        )}
        <button className="btn-ghost px-2 py-1 text-xs" onClick={load} disabled={state.loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${state.loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Records() {
  const [filters, setFilters] = useState({ search: '', status: '', result: '', provider: '', domain: '', sort: 'created_at:desc' });
  const [debounced, setDebounced] = useState(filters);
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, records: [], meta: null, error: null });
  const ctrl = useRef(null);

  // Debounce typing in the text fields.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);
  useEffect(() => setPage(1), [debounced]);

  const load = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true, error: null }));
    const [sort, direction] = debounced.sort.split(':');
    try {
      const r = await api.registryRecords(
        { page, limit: PAGE_SIZE, search: debounced.search.trim(), status: debounced.status, result: debounced.result, provider: debounced.provider, domain: debounced.domain.trim(), sort, direction },
        c.signal,
      );
      setState({ loading: false, records: r.records, meta: r.meta, error: null });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [debounced, page]);

  useEffect(() => {
    load();
    return () => ctrl.current?.abort();
  }, [load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const meta = state.meta;
  const filtered = Object.entries(debounced).some(([k, v]) => k !== 'sort' && v);

  return (
    <section className="card overflow-hidden">
      <div className="space-y-3 border-b border-slate-100 p-4">
        <div className="flex flex-col gap-2 md:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input py-2 pl-9" placeholder="Search email address…" value={filters.search} onChange={set('search')} aria-label="Search email address" />
          </div>
          <input className="input py-2 md:w-48" placeholder="Domain, e.g. gmail.com" value={filters.domain} onChange={set('domain')} aria-label="Filter by domain" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select label="Status" value={filters.status} onChange={set('status')} options={STATUS_OPTIONS} />
          <Select label="Result" value={filters.result} onChange={set('result')} options={RESULT_OPTIONS} />
          <Select label="Provider" value={filters.provider} onChange={set('provider')} options={PROVIDER_OPTIONS} format={(p) => PROVIDER_LABELS[p] || 'Other'} />
          <select className="input py-2" value={filters.sort} onChange={set('sort')} aria-label="Sort">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.error ? (
        <div className="flex items-center gap-2 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{state.error}</span>
          <button className="btn-secondary py-1 text-xs" onClick={load}>
            Retry
          </button>
        </div>
      ) : !state.loading && state.records.length === 0 ? (
        <EmptyState
          icon={filtered ? Search : Database}
          title={filtered ? 'No matching records' : 'The registry is empty'}
          description={filtered ? 'Try another search term or filter.' : 'Verified emails are saved here automatically.'}
        />
      ) : (
        <div className={`overflow-x-auto transition-opacity ${state.loading ? 'opacity-60' : ''}`}>
          <RecordTable records={state.records} />
        </div>
      )}

      {meta && meta.total > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
          <span className="tabular-nums">
            {formatNumber(meta.from)}–{formatNumber(meta.to)} of {formatNumber(meta.total)}
          </span>
          <div className="flex items-center gap-1">
            {state.loading && <Loader2 className="mr-1 h-4 w-4 animate-spin text-slate-400" />}
            <button className="btn-secondary px-2 py-1.5" onClick={() => setPage((p) => p - 1)} disabled={page <= 1 || state.loading} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2 tabular-nums">
              {meta.current_page} / {meta.last_page}
            </span>
            <button className="btn-secondary px-2 py-1.5" onClick={() => setPage((p) => p + 1)} disabled={page >= meta.last_page || state.loading} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function RecordTable({ records, compact = false }) {
  return (
    <table className="min-w-full divide-y divide-slate-100">
      <thead className="bg-slate-50/60">
        <tr>
          <th className="th">Email</th>
          <th className="th">Result</th>
          <th className="th">Status</th>
          {!compact && <th className="th">Provider</th>}
          <th className="th">Verified</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {records.map((r) => (
          <tr key={r.id} className="hover:bg-slate-50/60">
            <td className="td max-w-[300px] truncate font-mono text-[13px] text-slate-900" title={r.email}>
              {r.email}
            </td>
            <td className="td">
              {r.result ? (
                <div className="flex items-center gap-1.5">
                  <StatusBadge status={r.app_result} />
                  {r.result !== r.app_result && <span className="text-[11px] text-slate-400">{r.result}</span>}
                </div>
              ) : (
                <span className="text-slate-300">—</span>
              )}
            </td>
            <td className="td">
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[r.status] || 'bg-slate-100 text-slate-600'}`}>{r.status}</span>
              {r.usable && (
                <span title="Reused instead of paying for a new verification" className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-semibold text-slate-500">
                  REUSABLE
                </span>
              )}
            </td>
            {!compact && <td className="td whitespace-nowrap">{PROVIDER_LABELS[r.provider] || (r.provider ? 'Other' : '—')}</td>}
            <td className="td whitespace-nowrap text-slate-500">{r.verified_at ? formatDateTime(r.verified_at) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */

function BatchLookup() {
  const [text, setText] = useState('');
  const [state, setState] = useState({ loading: false, data: null, error: null });
  const emails = useMemo(
    () => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))],
    [text],
  );

  const run = async (e) => {
    e.preventDefault();
    if (!emails.length) return;
    setState({ loading: true, data: null, error: null });
    try {
      setState({ loading: false, data: await api.registryLookup(emails), error: null });
    } catch (err) {
      setState({ loading: false, data: null, error: err.message });
    }
  };

  const d = state.data;
  return (
    <section className="card overflow-hidden">
      <form onSubmit={run} className="space-y-3 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Batch lookup</h2>
          <p className="text-xs text-slate-500">Check which addresses already have a stored result. Read-only — nothing is verified or charged.</p>
        </div>
        <textarea
          className="input min-h-[96px] font-mono text-[13px]"
          placeholder={'user1@gmail.com\nuser2@yahoo.com'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Email addresses to look up"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">{formatNumber(emails.length)} unique address(es) · up to 5,000</span>
          <button className="btn-primary py-2" disabled={!emails.length || emails.length > 5000 || state.loading}>
            {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />} Look up
          </button>
        </div>
        {state.error && (
          <p className="flex items-center gap-1.5 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4" /> {state.error}
          </p>
        )}
      </form>

      {d && (
        <div className="border-t border-slate-100">
          <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
            <Cell label="Found" value={d.summary.found} />
            <Cell label="Reusable" value={d.summary.usable} />
            <Cell label="Not in registry" value={d.summary.missing} />
            <Cell label="Invalid" value={d.summary.invalid} />
          </div>
          {d.found.length > 0 && (
            <div className="overflow-x-auto">
              <RecordTable records={d.found} compact />
            </div>
          )}
          {(d.missing.length > 0 || d.invalid.length > 0) && (
            <div className="space-y-2 border-t border-slate-100 p-4 text-xs text-slate-600">
              {d.missing.length > 0 && (
                <p>
                  <span className="font-medium text-slate-700">Not in registry (would be verified):</span> <span className="font-mono">{d.missing.slice(0, 50).join(', ')}</span>
                  {d.missing.length > 50 && ` … +${formatNumber(d.missing.length - 50)} more`}
                </p>
              )}
              {d.invalid.length > 0 && (
                <p>
                  <span className="font-medium text-slate-700">Invalid format:</span> <span className="font-mono">{d.invalid.slice(0, 50).join(', ')}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Select({ label, value, onChange, options, format = (v) => v }) {
  return (
    <select className="input py-2" value={value} onChange={onChange} aria-label={label}>
      <option value="">All {label.toLowerCase()}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {format(o)}
        </option>
      ))}
    </select>
  );
}

function MiniStat({ label, value, loading }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      {loading && value == null ? (
        <div className="mt-1 h-7 w-16 animate-pulse rounded bg-slate-100" />
      ) : (
        <p className="text-xl font-semibold tabular-nums text-slate-900">{formatNumber(value)}</p>
      )}
    </div>
  );
}

function Cell({ label, value }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-slate-900">{formatNumber(value)}</p>
    </div>
  );
}
