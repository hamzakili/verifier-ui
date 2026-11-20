import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Layers, CheckCircle2, Loader2, PauseCircle, XCircle, Search, Download, ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { api, downloadFromApi, downloadPaths } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { isActiveJob } from '../lib/bulkJobs';
import { formatDateTime, formatNumber } from '../lib/format';
import KpiCard from '../components/KpiCard';
import EmptyState from '../components/EmptyState';
import { JobStatusPill, ProgressBar, toneFor } from '../components/bulk/StatusPill';

const STATUS_FILTERS = [
  { id: '', label: 'All statuses' },
  { id: 'queued,processing,pausing,cancelling', label: 'Processing' },
  { id: 'completed,completed_with_errors', label: 'Completed' },
  { id: 'paused', label: 'Paused' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'draft', label: 'Draft' },
];
const SORTS = [
  { id: 'created_at:desc', label: 'Newest first' },
  { id: 'created_at:asc', label: 'Oldest first' },
  { id: 'job_name:asc', label: 'Name A–Z' },
  { id: 'progress:desc', label: 'Most progress' },
  { id: 'total_eligible:desc', label: 'Most leads' },
];

export default function BulkJobs() {
  const toast = useToast();
  const [filters, setFilters] = useState({ search: '', status: '', from: '', to: '', sort: 'created_at:desc', page: 1 });
  const [search, setSearch] = useState('');
  const [data, setData] = useState({ loading: true, jobs: [], meta: null, overview: null, error: null });

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.search === search ? f : { ...f, search, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (signal) => {
      const [sort, direction] = filters.sort.split(':');
      try {
        const r = await api.verificationJobs({ search: filters.search, status: filters.status, from: filters.from, to: filters.to, sort, direction, page: filters.page, limit: 20 }, signal);
        setData({ loading: false, jobs: r.jobs, meta: r.meta, overview: r.overview, error: null });
        return r;
      } catch (err) {
        if (err.name !== 'AbortError') setData((d) => ({ ...d, loading: false, error: err.message }));
        return null;
      }
    },
    [filters],
  );

  // Load on filter change; keep refreshing only while some job on screen is still running.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer;
    const tick = async () => {
      const r = await load(ctrl.signal);
      if (!ctrl.signal.aborted && r?.jobs.some((j) => isActiveJob(j.status))) timer = setTimeout(tick, 5000);
    };
    tick();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [load]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const o = data.overview;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Bulk Verification Jobs</h1>
          <p className="mt-1 text-sm text-slate-500">Import up to 1,000 leads and automatically verify, batch, and save your results.</p>
        </div>
        <Link to="/bulk-jobs/new" className="btn-primary self-start sm:self-auto">
          <Plus className="h-4 w-4" /> New Bulk Verification
        </Link>
      </div>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <KpiCard label="Total Jobs" value={formatNumber(o?.total ?? 0)} icon={Layers} loading={data.loading && !o} />
        <KpiCard label="Completed" value={formatNumber(o?.completed ?? 0)} icon={CheckCircle2} accent="emerald" loading={data.loading && !o} />
        <KpiCard label="Processing" value={formatNumber(o?.processing ?? 0)} icon={Loader2} loading={data.loading && !o} />
        <KpiCard label="Paused" value={formatNumber(o?.paused ?? 0)} icon={PauseCircle} accent="slate" loading={data.loading && !o} />
        <KpiCard label="Failed" value={formatNumber(o?.failed ?? 0)} icon={XCircle} accent="red" loading={data.loading && !o} />
      </section>

      <section className="card overflow-hidden">
        <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[1fr_auto_auto_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input py-2 pl-9" placeholder="Search job or file name…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search jobs" />
          </div>
          <select className="input py-2" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Filter by status">
            {STATUS_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <input type="date" className="input py-2" value={filters.from} onChange={(e) => set({ from: e.target.value })} aria-label="Created from" title="Created from" />
          <input type="date" className="input py-2" value={filters.to} onChange={(e) => set({ to: e.target.value })} aria-label="Created to" title="Created to" />
          <select className="input py-2" value={filters.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>

        {data.error && <p className="border-b border-red-100 bg-red-50 px-4 py-2.5 text-sm text-red-700">{data.error}</p>}

        {!data.loading && data.jobs.length === 0 ? (
          <EmptyState
            icon={Layers}
            title={o?.total ? 'No jobs match these filters' : 'No bulk verification jobs yet'}
            description={o?.total ? 'Try another search or status.' : 'Import a CSV of up to 1,000 leads; it is verified batch by batch and saved to the folder you choose.'}
            action={!o?.total && <Link to="/bulk-jobs/new" className="btn-primary"><Plus className="h-4 w-4" /> New Bulk Verification</Link>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Job name</th>
                  <th className="th">Source file</th>
                  <th className="th text-right">Total leads</th>
                  <th className="th w-44">Progress</th>
                  <th className="th">Batches</th>
                  <th className="th">Destination</th>
                  <th className="th">Status</th>
                  <th className="th">Created</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.loading && !data.jobs.length
                  ? Array.from({ length: 3 }, (_, i) => (
                      <tr key={i}><td className="td" colSpan={9}><div className="h-5 animate-pulse rounded bg-slate-100" /></td></tr>
                    ))
                  : data.jobs.map((j) => (
                      <tr key={j.id} className="hover:bg-slate-50/60">
                        <td className="td max-w-[220px]"><Link to={`/bulk-jobs/${j.id}`} className="block truncate font-medium text-indigo-700 hover:underline">{j.job_name}</Link></td>
                        <td className="td max-w-[180px] truncate" title={j.source_filename}>{j.source_filename}</td>
                        <td className="td text-right tabular-nums">{formatNumber(j.total_eligible)}</td>
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <ProgressBar percent={j.progress.percent} tone={toneFor(j.status)} size="sm" label={`${j.job_name} progress`} />
                            <span className="w-11 text-right text-xs tabular-nums text-slate-600">{Math.floor(j.progress.percent)}%</span>
                          </div>
                        </td>
                        <td className="td whitespace-nowrap tabular-nums">{j.completed_batches}/{j.total_batches}</td>
                        <td className="td max-w-[200px] truncate text-slate-600" title={j.destination_folder?.path}>{j.destination_folder?.folder_name ?? '—'}</td>
                        <td className="td"><JobStatusPill status={j.status} /></td>
                        <td className="td whitespace-nowrap text-slate-500">{formatDateTime(j.created_at)}</td>
                        <td className="td whitespace-nowrap text-right">
                          {j.files.some((f) => f.kind === 'all_results') && (
                            <button
                              className="btn-ghost px-2 py-1"
                              title="Download complete results"
                              aria-label={`Download results of ${j.job_name}`}
                              onClick={() => downloadFromApi(downloadPaths.job(j.id)).catch((e) => toast.error(e.message))}
                            >
                              <Download className="h-4 w-4" />
                            </button>
                          )}
                          <Link to={`/bulk-jobs/${j.id}`} className="btn-ghost px-2 py-1" aria-label={`Open ${j.job_name}`}><ArrowRight className="h-4 w-4" /></Link>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}

        {data.meta && data.meta.last_page > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
            <span>Page {data.meta.current_page} of {data.meta.last_page} · {formatNumber(data.meta.total)} jobs</span>
            <div className="flex gap-1">
              <button className="btn-secondary px-2 py-1" disabled={filters.page <= 1} onClick={() => set({ page: filters.page - 1 })} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
              <button className="btn-secondary px-2 py-1" disabled={filters.page >= data.meta.last_page} onClick={() => set({ page: filters.page + 1 })} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
