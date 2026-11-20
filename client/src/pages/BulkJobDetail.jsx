import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Pause, Play, XCircle, Download, RotateCcw, Eye, FolderOpen, AlertTriangle, Loader2, FileText, Database, Copy,
} from 'lucide-react';
import { api, downloadFromApi, downloadPaths } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { batchDisplayStatus, formatBytes, formatDuration, isActiveJob, pad3 } from '../lib/bulkJobs';
import { formatDateTime, formatNumber } from '../lib/format';
import { JobStatusPill, BatchStatusPill, ProgressBar, toneFor } from '../components/bulk/StatusPill';
import StatusBadge from '../components/StatusBadge';
import Modal from '../components/Modal';
import EmptyState from '../components/EmptyState';

const POLL_MS = 2000;

export default function BulkJobDetail() {
  const { jobId } = useParams();
  const toast = useToast();
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // action in progress
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [viewBatch, setViewBatch] = useState(null);
  const ctrlRef = useRef(null);

  const refresh = useCallback(async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const r = await api.verificationJobProgress(jobId, ctrl.signal);
      setJob(r.job);
      setError(null);
      return r.job;
    } catch (err) {
      if (err.name !== 'AbortError') setError(err);
      return null;
    }
  }, [jobId]);

  // Poll while the job is active; stop at a terminal state and while the tab is hidden.
  useEffect(() => {
    let timer;
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      const j = await refresh();
      if (!stopped && (!j || isActiveJob(j.status))) timer = setTimeout(tick, j ? POLL_MS : POLL_MS * 3);
    };
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };
    tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrlRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, job && isActiveJob(job.status)]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action, fn, success) => {
    setBusy(action);
    try {
      const r = await fn();
      if (r?.job) setJob(r.job);
      if (success) toast.success(success);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };
  const download = (path) => downloadFromApi(path).catch((e) => toast.error(e.message));

  if (!job) {
    if (error) {
      return (
        <div className="card">
          <EmptyState
            icon={AlertTriangle}
            title={error.status === 404 ? 'Job not found' : 'Could not load this job'}
            description={error.message}
            action={<Link to="/bulk-jobs" className="btn-secondary"><ChevronLeft className="h-4 w-4" /> Back to jobs</Link>}
          />
        </div>
      );
    }
    return <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading job…</p>;
  }

  const a = job.actions;
  const current = job.batches.find((b) => b.batch_number === job.current_batch);
  const allResults = job.files.find((f) => f.kind === 'all_results');
  const summaryFile = job.files.find((f) => f.kind === 'summary');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Link to="/bulk-jobs" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ChevronLeft className="h-4 w-4" /> Bulk Verification Jobs</Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900">{job.job_name}</h1>
            <JobStatusPill status={job.status} />
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-500">
            <div className="flex items-center gap-1">
              <dt className="sr-only">Job ID</dt>
              <dd className="font-mono text-xs">{job.id}</dd>
              <button className="rounded p-0.5 hover:bg-slate-100" title="Copy job ID" aria-label="Copy job ID" onClick={() => navigator.clipboard?.writeText(job.id).then(() => toast.info('Job ID copied.'))}>
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <div><dt className="inline">Created </dt><dd className="inline text-slate-700">{formatDateTime(job.created_at)}</dd></div>
            <div><dt className="inline">Source </dt><dd className="inline text-slate-700">{job.source_filename}</dd></div>
            <div><dt className="inline">Destination </dt><dd className="inline text-slate-700">{job.job_folder?.path ?? job.destination_folder?.path}</dd></div>
            <div><dt className="inline">Provider </dt><dd className="inline text-slate-700">{job.configuration.provider_name} · {job.configuration.mode === 'live' ? 'Live' : 'Mock'}</dd></div>
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          {a.can_start && (
            <button className="btn-primary" disabled={!!busy} onClick={() => act('start', () => api.verificationJobAction(job.id, 'start'), 'Job started.')}>
              {busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start
            </button>
          )}
          {a.can_pause && (
            <button className="btn-secondary" disabled={!!busy} onClick={() => act('pause', () => api.verificationJobAction(job.id, 'pause'), 'Pause requested. The current batch finishes and is saved first.')}>
              {busy === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />} Pause
            </button>
          )}
          {a.can_resume && (
            <button className="btn-primary" disabled={!!busy} onClick={() => act('resume', () => api.verificationJobAction(job.id, 'resume'), 'Job resumed.')}>
              {busy === 'resume' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Resume
            </button>
          )}
          {a.can_cancel && (
            <button className="btn-secondary text-red-700 hover:text-red-800" disabled={!!busy} onClick={() => setConfirmCancel(true)}>
              <XCircle className="h-4 w-4" /> Cancel
            </button>
          )}
          {allResults && (
            <button className="btn-secondary" onClick={() => download(downloadPaths.job(job.id))}>
              <Download className="h-4 w-4" /> Download All
            </button>
          )}
        </div>
      </div>

      {job.status === 'paused' && (
        <Banner tone="amber" icon={Pause} title="Job Paused">Completed batches are saved. Resume to continue with batch {job.batches.find((b) => b.status === 'pending')?.batch_number ?? '—'}.</Banner>
      )}
      {job.status === 'pausing' && <Banner tone="amber" icon={Loader2} spin title="Pausing…">The current batch is finishing and being saved; the job pauses right after.</Banner>}
      {job.status === 'cancelling' && <Banner tone="slate" icon={Loader2} spin title="Cancelling…">The current batch finishes and is saved; remaining batches are cancelled.</Banner>}
      {job.error_message && ['failed', 'completed_with_errors'].includes(job.status) && (
        <Banner tone="red" icon={AlertTriangle} title={job.status === 'failed' ? 'Job stopped' : 'Some records could not be verified'}>
          {job.error_message} {a.can_resume && 'Resume the job or retry the failed batch to continue; completed records are kept.'}
        </Banner>
      )}
      {job.status === 'completed_with_errors' && !job.error_message && (
        <Banner tone="amber" icon={AlertTriangle} title="Completed with errors">
          {formatNumber(job.counts.failed)} record(s) could not be verified. Use Retry on the affected batch to verify only those records again.
        </Banner>
      )}
      {error && <Banner tone="red" icon={AlertTriangle} title="Connection problem">{error.message} Retrying…</Banner>}

      {/* Main progress */}
      <section className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">Overall progress</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{job.progress.percent}%</p>
            <p className="mt-1 text-sm text-slate-600">
              {formatNumber(job.progress.processed)} / {formatNumber(job.progress.total)} verified · {formatNumber(job.progress.remaining)} remaining
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
            <Metric label="Current batch" value={job.current_batch ? `${job.current_batch} of ${job.total_batches}` : '—'} />
            <Metric label="Completed batches" value={job.completed_batches} />
            <Metric label="Pending batches" value={job.pending_batches} />
            <Metric label="Failed batches" value={job.failed_batches} tone={job.failed_batches ? 'text-red-700' : ''} />
          </dl>
        </div>
        <div className="mt-4"><ProgressBar percent={job.progress.percent} tone={toneFor(job.status)} label="Overall progress" /></div>
        <p className="mt-3 text-xs text-slate-500">
          {formatNumber(job.total_imported)} imported · {formatNumber(job.total_eligible)} eligible · {formatNumber(job.total_duplicates)} duplicates · {formatNumber(job.total_empty + job.total_invalid_format)} without a valid email ·
          batch size {formatNumber(job.batch_size)}
        </p>
      </section>

      {/* Current batch */}
      {current && isActiveJob(job.status) && (
        <section className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900">Current Batch: {current.batch_number} of {job.total_batches}</h2>
            <BatchStatusPill status={batchDisplayStatus(current, job.status)} />
          </div>
          <div className="mt-3"><ProgressBar percent={current.total_emails ? (current.processed_count / current.total_emails) * 100 : 0} label="Current batch progress" /></div>
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4 lg:grid-cols-7">
            <Metric label="Total leads" value={current.total_emails} />
            <Metric label="Verified" value={current.processed_count} />
            {STATUS_ORDER.map((k) => <Metric key={k} label={STATUS_META[k].label} value={current[`${k}_count`]} tone={STATUS_META[k].text} />)}
          </dl>
          {current.stage && <p className="mt-3 text-xs text-slate-500">Provider stage: {current.stage}</p>}
        </section>
      )}

      {/* Result statistics */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {STATUS_ORDER.map((k) => {
          const Icon = STATUS_META[k].icon;
          return (
            <div key={k} className={`rounded-xl border px-4 py-3 ${STATUS_META[k].soft}`}>
              <p className={`flex items-center gap-1.5 text-xs font-medium ${STATUS_META[k].text}`}><Icon className="h-3.5 w-3.5" /> {STATUS_META[k].label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{formatNumber(job.counts[k])}</p>
            </div>
          );
        })}
        <div className="rounded-xl border border-red-200 bg-white px-4 py-3">
          <p className="text-xs font-medium text-red-700">Failed</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{formatNumber(job.counts.failed)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3" title="Already verified in the email registry: no credits used">
          <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600"><Database className="h-3.5 w-3.5" /> From registry</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{formatNumber(job.counts.reused)}</p>
        </div>
      </section>

      {/* Batch activity */}
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold text-slate-900">Batch activity</h2>
          {job.job_folder && (
            <Link to={`/files/${job.job_folder.id}`} className="btn-ghost py-1.5 text-sm"><FolderOpen className="h-4 w-4" /> Open destination folder</Link>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Batch</th>
                <th className="th text-right">Leads</th>
                <th className="th text-right">Verified</th>
                <th className="th text-right">Valid</th>
                <th className="th text-right">Invalid</th>
                <th className="th text-right">Disposable</th>
                <th className="th text-right">Catch-all</th>
                <th className="th text-right">Unknown</th>
                <th className="th">Status</th>
                <th className="th">Started</th>
                <th className="th">Completed</th>
                <th className="th">Output file</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {job.batches.map((b) => {
                const display = batchDisplayStatus(b, job.status);
                const done = b.status === 'completed';
                return (
                  <tr key={b.id} className={done ? 'bg-emerald-50/30' : b.status === 'failed' ? 'bg-red-50/40' : display === 'processing' || display === 'saving' ? 'bg-indigo-50/40' : ''}>
                    <td className="td font-mono text-xs font-semibold text-slate-900">{pad3(b.batch_number)}</td>
                    <td className="td text-right tabular-nums">{formatNumber(b.total_emails)}</td>
                    <td className="td text-right tabular-nums">
                      {formatNumber(b.processed_count)}
                      {b.failed_count > 0 && <span className="block text-xs text-red-600">{b.failed_count} failed</span>}
                    </td>
                    <td className="td text-right tabular-nums text-emerald-700">{formatNumber(b.valid_count)}</td>
                    <td className="td text-right tabular-nums text-red-700">{formatNumber(b.invalid_count)}</td>
                    <td className="td text-right tabular-nums">{formatNumber(b.disposable_count)}</td>
                    <td className="td text-right tabular-nums">{formatNumber(b.catchall_count)}</td>
                    <td className="td text-right tabular-nums">{formatNumber(b.unknown_count)}</td>
                    <td className="td">
                      <BatchStatusPill status={display} />
                      {b.error_message && <p className="mt-1 max-w-[220px] text-xs text-red-700" title={b.error_message}>{b.error_message}</p>}
                    </td>
                    <td className="td whitespace-nowrap text-xs text-slate-500">{b.started_at ? formatDateTime(b.started_at) : '—'}</td>
                    <td className="td whitespace-nowrap text-xs text-slate-500">
                      {b.completed_at ? formatDateTime(b.completed_at) : '—'}
                      {b.duration_ms != null && <span className="block">{formatDuration(b.duration_ms)}</span>}
                    </td>
                    <td className="td whitespace-nowrap text-xs">
                      {b.output_file ? (
                        <span className="flex items-center gap-1 text-slate-700"><FileText className="h-3.5 w-3.5 text-slate-400" />{b.output_file.file_name}<span className="text-slate-400">· {formatBytes(b.output_file.size_bytes)}</span></span>
                      ) : '—'}
                    </td>
                    <td className="td whitespace-nowrap text-right">
                      <div className="flex justify-end gap-1">
                        {b.output_file && (
                          <button className="btn-ghost px-2 py-1" title="Download CSV" aria-label={`Download batch ${b.batch_number}`} onClick={() => download(downloadPaths.batch(job.id, b.id))}>
                            <Download className="h-4 w-4" />
                          </button>
                        )}
                        {(b.verified_count > 0 || b.failed_count > 0) && (
                          <button className="btn-ghost px-2 py-1" title="View results" aria-label={`View results of batch ${b.batch_number}`} onClick={() => setViewBatch(b)}>
                            <Eye className="h-4 w-4" />
                          </button>
                        )}
                        {b.can_retry && (
                          <button
                            className="btn-ghost px-2 py-1 text-amber-700"
                            title={b.status === 'failed' ? 'Retry this batch' : 'Retry the failed records'}
                            aria-label={`Retry batch ${b.batch_number}`}
                            disabled={!!busy}
                            onClick={() => act(`retry-${b.id}`, () => api.retryVerificationBatch(job.id, b.id), `Batch ${b.batch_number} queued for retry.`)}
                          >
                            {busy === `retry-${b.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Final files */}
      {(allResults || summaryFile) && (
        <section className="card p-5">
          <h2 className="font-semibold text-slate-900">Job results</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {[allResults, summaryFile].filter(Boolean).map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" />{f.file_name}<span className="text-xs text-slate-400">{formatBytes(f.size_bytes)}{f.row_count != null && ` · ${formatNumber(f.row_count)} rows`}</span></span>
                <button className="btn-secondary py-1" onClick={() => download(downloadPaths.file(f.id))}><Download className="h-4 w-4" /> Download</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this job?"
        description="Completed batches and their saved files are kept. Batches that have not started are cancelled."
        footer={
          <>
            <button className="btn-secondary" onClick={() => setConfirmCancel(false)}>Keep running</button>
            <button
              className="btn bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                setConfirmCancel(false);
                act('cancel', () => api.verificationJobAction(job.id, 'cancel'), 'Cancel requested.');
              }}
            >
              Cancel job
            </button>
          </>
        }
      >
        {isActiveJob(job.status) && <p className="text-sm text-slate-600">The batch that is running now finishes and is saved first, because its verification is already paid for.</p>}
      </Modal>

      {viewBatch && <BatchResultsModal job={job} batch={viewBatch} onClose={() => setViewBatch(null)} />}
    </div>
  );
}

function BatchResultsModal({ job, batch, onClose }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ loading: true, results: [], meta: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setData((d) => ({ ...d, loading: true }));
    api.verificationBatch(job.id, batch.id, { page, limit: 50 }).then(
      (r) => !cancelled && setData({ loading: false, results: r.results, meta: r.meta, error: null }),
      (err) => !cancelled && setData({ loading: false, results: [], meta: null, error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [job.id, batch.id, page]);

  return (
    <Modal open onClose={onClose} size="lg" title={`Batch ${pad3(batch.batch_number)} results`} description={`${formatNumber(batch.total_emails)} leads`}>
      {data.error && <p className="text-sm text-red-700">{data.error}</p>}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead>
            <tr><th className="th">Row</th><th className="th">Email</th><th className="th">Result</th><th className="th">Notes</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.results.map((r) => (
              <tr key={r.row_number}>
                <td className="td tabular-nums text-slate-400">{r.row_number}</td>
                <td className="td font-medium text-slate-900">{r.email}</td>
                <td className="td">
                  {r.processing_status === 'completed' ? <StatusBadge status={r.verification_status} /> : <span className={r.processing_status === 'failed' ? 'text-red-700' : 'text-slate-500'}>{r.processing_status === 'failed' ? 'Failed' : 'Pending'}</span>}
                </td>
                <td className="td text-xs text-slate-500">
                  {[r.from_registry && 'From registry', r.suggested_correction && `Did you mean ${r.suggested_correction}?`, r.error_message].filter(Boolean).join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.loading && <p className="flex items-center gap-2 py-4 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
      </div>
      {data.meta && data.meta.last_page > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>Page {page} of {data.meta.last_page}</span>
          <div className="flex gap-1">
            <button className="btn-secondary px-2 py-1" disabled={page === 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
            <button className="btn-secondary px-2 py-1" disabled={page === data.meta.last_page} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Metric({ label, value, tone = '' }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`font-semibold tabular-nums text-slate-900 ${tone}`}>{typeof value === 'number' ? formatNumber(value) : value}</dd>
    </div>
  );
}

function Banner({ tone, icon: Icon, spin, title, children }) {
  const tones = { amber: 'border-amber-200 bg-amber-50 text-amber-900', red: 'border-red-200 bg-red-50 text-red-800', slate: 'border-slate-200 bg-slate-50 text-slate-800' };
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`} role="status">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${spin ? 'animate-spin' : ''}`} />
      <div><p className="font-semibold">{title}</p><p className="mt-0.5">{children}</p></div>
    </div>
  );
}
