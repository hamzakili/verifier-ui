import { useEffect, useMemo, useRef, useState } from 'react';
import {
  UploadCloud, FileSpreadsheet, Download, Loader2, Check, AlertTriangle, RefreshCw, Coins, Columns3,
  Search, ChevronLeft, ChevronRight, Play, X, FileDown, CircleCheck, Upload, Cog, ShieldCheck, Database,
} from 'lucide-react';
import { api } from '../lib/api';
import { useBulk } from '../context/BulkContext';
import { useApp, PROVIDER_LABELS } from '../context/AppContext';
import StatusBadge from '../components/StatusBadge';
import StatusBreakdown from '../components/StatusBreakdown';
import EmptyState from '../components/EmptyState';
import { STATUS_META, STATUS_ORDER } from '../lib/status';
import { downloadCsv, sampleCsv } from '../lib/csv';
import { formatNumber } from '../lib/format';

const STEPS = [
  { id: 'upload', label: 'Upload' },
  { id: 'configure', label: 'Review' },
  { id: 'running', label: 'Verify' },
  { id: 'results', label: 'Results' },
];

export default function BulkVerifier() {
  const { step } = useBulk();
  const idx = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="space-y-6">
      <ol className="flex items-center gap-2 overflow-x-auto pb-1 text-sm" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex shrink-0 items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                i < idx ? 'bg-indigo-600 text-white' : i === idx ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-600' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={i === idx ? 'font-medium text-slate-900' : 'text-slate-500'}>{s.label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-slate-200 sm:w-10" />}
          </li>
        ))}
      </ol>

      {step === 'upload' && <UploadStep />}
      {step === 'configure' && <ConfigureStep />}
      {step === 'running' && <RunningStep />}
      {step === 'results' && <ResultsStep />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: Upload                                                      */
/* ------------------------------------------------------------------ */

function UploadStep() {
  const { loadFile, parsing } = useBulk();
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const onFiles = (files) => {
    const f = files?.[0];
    if (f) loadFile(f);
  };

  return (
    <section className="card p-5 sm:p-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => !parsing && inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload CSV file"
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition ${
          drag ? 'border-indigo-500 bg-indigo-50/60' : 'border-slate-300 bg-slate-50/50 hover:border-indigo-400 hover:bg-indigo-50/30'
        }`}
      >
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200">
          {parsing ? <Loader2 className="h-7 w-7 animate-spin" /> : <UploadCloud className="h-7 w-7" />}
        </span>
        <p className="text-base font-semibold text-slate-900">{parsing ? 'Parsing your file…' : 'Drag & drop your CSV here'}</p>
        <p className="mt-1 text-sm text-slate-500">
          or <span className="font-medium text-indigo-600">browse files</span> · .csv up to 20 MB · parsed locally in your browser
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv,.txt"
          className="hidden"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3 sm:flex-row sm:items-center">
        <p className="text-sm text-slate-600">No list handy? Grab a sample file with valid, typo, disposable, catch-all and duplicate rows.</p>
        <button
          className="btn-secondary shrink-0 py-1.5"
          onClick={() => {
            const blob = new Blob([sampleCsv()], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'sample-contacts.csv';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download className="h-4 w-4" /> Sample CSV
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: Configure / preview                                         */
/* ------------------------------------------------------------------ */

function ConfigureStep() {
  const { file, parsed, column, setColumn, analysis, start, reset } = useBulk();
  const { account, effectiveMode, server, activeProviderName } = useApp();
  const uniqueCount = analysis?.uniqueEmails.length ?? 0;
  const dbOn = Boolean(server.centralDb?.enabled && server.centralDb?.connected);
  const [dbPreview, setDbPreview] = useState({ loading: false, data: null, error: null });

  // Ask the email registry how many of these emails are already verified (read-only, free).
  useEffect(() => {
    if (!dbOn || !uniqueCount) {
      setDbPreview({ loading: false, data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setDbPreview((p) => ({ ...p, loading: true }));
    const t = setTimeout(async () => {
      try {
        const data = await api.previewBulk(analysis.uniqueEmails);
        if (!cancelled) setDbPreview({ loading: false, data, error: null });
      } catch (err) {
        if (!cancelled) setDbPreview({ loading: false, data: null, error: err.message });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [dbOn, analysis, uniqueCount, effectiveMode]);

  const credits = dbPreview.data ? dbPreview.data.estimatedCredits : uniqueCount;
  const insufficient = typeof account.creditsRemaining === 'number' && credits > account.creditsRemaining;
  const tooMany = server.maxBulkEmails && uniqueCount > server.maxBulkEmails;
  const preview = parsed.rows.slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
            <FileSpreadsheet className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-slate-900">{file.name}</p>
            <p className="text-sm text-slate-500">
              {(file.size / 1024).toFixed(1)} KB · {formatNumber(parsed.rows.length)} rows · {parsed.fields.length} columns
              {parsed.headerless && ' · no header row detected'}
            </p>
          </div>
          <button className="btn-ghost self-start sm:self-center" onClick={reset}>
            <X className="h-4 w-4" /> Change file
          </button>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div>
            <label htmlFor="col" className="label flex items-center gap-1.5">
              <Columns3 className="h-4 w-4 text-slate-400" /> Email column
            </label>
            <select id="col" className="input" value={column || ''} onChange={(e) => setColumn(e.target.value || null)}>
              <option value="">Select a column…</option>
              {parsed.fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            {!column && <p className="mt-2 text-sm text-amber-700">Choose the column that contains email addresses.</p>}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2">
            <Stat label="Total rows" value={analysis?.totalRows ?? parsed.rows.length} />
            <Stat label="Valid syntax" value={analysis?.validSyntax} tone="emerald" />
            <Stat label="Duplicates" value={analysis?.duplicates} />
            <Stat label="Bad syntax / empty" value={analysis ? analysis.invalidSyntax + analysis.empty : null} tone="red" />
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">Preview</h2>
          <p className="text-xs text-slate-500">First {preview.length} rows · selected column highlighted</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50/60">
              <tr>
                {parsed.fields.map((f) => (
                  <th key={f} className={`th whitespace-nowrap ${f === column ? 'bg-indigo-50 text-indigo-700' : ''}`}>
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.map((r, i) => (
                <tr key={i}>
                  {parsed.fields.map((f) => (
                    <td key={f} className={`td max-w-[240px] truncate whitespace-nowrap ${f === column ? 'bg-indigo-50/40 font-mono text-[13px] text-slate-900' : ''}`}>
                      {r[f] || <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
          <Coins className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-500">Estimated credits required</p>
          <p className="text-xl font-semibold tabular-nums text-slate-900">
            {dbPreview.loading ? <Loader2 className="inline h-5 w-5 animate-spin text-slate-400" /> : formatNumber(credits)}{' '}
            <span className="text-sm font-normal text-slate-500">
              ({dbPreview.data ? '1 per email not yet in the registry' : '1 per unique email'} ·{' '}
              {account.creditsRemaining == null ? 'balance unavailable' : `${formatNumber(account.creditsRemaining)} available`}
              {effectiveMode === 'mock' ? ' in sandbox' : ''})
            </span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Will be verified with <span className="font-medium text-slate-700">{activeProviderName}</span> ·{' '}
            {effectiveMode === 'live' ? 'Live' : 'Mock sandbox'}
          </p>
          {dbPreview.data && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
              <Database className="h-3.5 w-3.5 text-emerald-600" />
              <span>
                <span className="font-medium text-emerald-700">{formatNumber(dbPreview.data.reusable)}</span> already in the email registry (free)
                {dbPreview.data.pendingElsewhere > 0 && (
                  <>
                    {' · '}
                    <span className="font-medium">{formatNumber(dbPreview.data.pendingElsewhere)}</span> being verified elsewhere
                  </>
                )}
                {dbPreview.data.invalid > 0 && (
                  <>
                    {' · '}
                    <span className="font-medium">{formatNumber(dbPreview.data.invalid)}</span> invalid format (skipped)
                  </>
                )}
                {' · '}
                <span className="font-medium">{formatNumber(dbPreview.data.toVerify)}</span> to verify
              </span>
            </p>
          )}
          {dbPreview.error && <p className="mt-1.5 text-xs text-amber-700">Email registry check failed: {dbPreview.error}</p>}
          {insufficient && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" /> Not enough credits for this list.
            </p>
          )}
          {tooMany && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" /> The server accepts up to {formatNumber(server.maxBulkEmails)} unique emails per job.
            </p>
          )}
        </div>
        <button className="btn-primary px-5 py-2.5" onClick={start} disabled={!column || uniqueCount === 0 || insufficient || tooMany}>
          <Play className="h-4 w-4" /> Verify {formatNumber(uniqueCount)} emails
        </button>
      </section>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === 'emerald' ? 'text-emerald-700' : tone === 'red' ? 'text-red-600' : 'text-slate-900';
  return (
    <div className="rounded-lg border border-slate-200 px-3.5 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value == null ? '—' : formatNumber(value)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: Running                                                     */
/* ------------------------------------------------------------------ */

const STAGES = [
  { id: 'uploading', label: 'Uploading', icon: Upload },
  { id: 'parsing', label: 'Parsing', icon: Cog },
  { id: 'verifying', label: 'Verifying', icon: ShieldCheck },
  { id: 'complete', label: 'Complete', icon: CircleCheck },
];

function overallProgress(job) {
  switch (job?.stage) {
    case 'uploading':
      return 6;
    case 'parsing':
      return 14;
    case 'queued':
      return 18;
    case 'verifying':
      return 20 + (job.percent || 0) * 0.78;
    case 'complete':
      return 100;
    default:
      return 2;
  }
}

function RunningStep() {
  const { job, file, reset, retryResults } = useBulk();
  const stage = job?.stage === 'queued' ? 'verifying' : job?.stage;
  const activeIdx = Math.max(0, STAGES.findIndex((s) => s.id === stage));
  const pct = overallProgress(job);
  const failed = !!job?.error;

  const stageLabel =
    job?.stage === 'verifying'
      ? `Verifying ${job.percent ?? 0}%`
      : job?.stage === 'queued'
        ? 'Queued for verification…'
        : job?.stage === 'complete'
          ? 'Fetching results…'
          : `${STAGES[activeIdx].label}…`;

  return (
    <section className="card p-5 sm:p-8">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{failed ? 'Verification interrupted' : stageLabel}</h2>
          <p className="text-sm text-slate-500">
            {file?.name} · {formatNumber(job?.total)} unique emails
            {job?.provider && ` · ${PROVIDER_LABELS[job.provider]}`}
            {job?.jobId && <span className="ml-1 font-mono text-xs text-slate-400">· job {job.jobId}</span>}
          </p>
        </div>
        {!failed && (
          <p className="text-2xl font-semibold tabular-nums text-indigo-600">{Math.round(pct)}%</p>
        )}
      </div>

      <div className="mt-6 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out ${failed ? 'bg-red-500' : 'bg-indigo-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <ol className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAGES.map((s, i) => {
          const done = i < activeIdx || job?.stage === 'complete';
          const active = i === activeIdx && !done;
          return (
            <li
              key={s.id}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${
                active ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : done ? 'border-slate-200 text-slate-700' : 'border-slate-200 text-slate-400'
              }`}
            >
              {done ? (
                <Check className="h-4 w-4 text-emerald-600" />
              ) : active && !failed ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <s.icon className="h-4 w-4" />
              )}
              <span className="font-medium">
                {s.id === 'verifying' && job?.stage === 'verifying' ? `Verifying ${job.percent ?? 0}%` : s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {job?.stage === 'verifying' && job.processed > 0 && (
        <div className="mt-6">
          <p className="mb-3 text-xs font-medium text-slate-500">
            Live tally · {formatNumber(job.processed)} of {formatNumber(job.total)} processed
          </p>
          <StatusBreakdown counts={job.counts} height={10} compact />
        </div>
      )}

      {job?.retrying && !failed && (
        <p className="mt-4 flex items-center gap-2 text-sm text-amber-700">
          <RefreshCw className="h-4 w-4 animate-spin" /> Connection issue — retrying…
        </p>
      )}

      {failed && (
        <div className="mt-6 flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-4 sm:flex-row sm:items-center">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
          <p className="flex-1 text-sm text-red-800">{job.error}</p>
          <div className="flex gap-2">
            {job.jobId && (
              <button className="btn-secondary py-1.5" onClick={retryResults}>
                <RefreshCw className="h-4 w-4" /> Retry
              </button>
            )}
            <button className="btn-ghost py-1.5" onClick={reset}>
              Start over
            </button>
          </div>
        </div>
      )}

      {!failed && (
        <p className="mt-6 text-xs text-slate-500">You can navigate away — the job keeps running and the sidebar shows progress.</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4: Results                                                     */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 50;

function ResultsStep() {
  const { results, file, column, parsed, reset } = useBulk();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return results.rows.filter((r) => (filter === 'all' || r.__result === filter) && (!q || r.__email.toLowerCase().includes(q)));
  }, [results, filter, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const base = (file?.name || 'emails').replace(/\.[^.]+$/, '');

  const exportRows = (rows) =>
    rows.map((r) => {
      const o = {};
      for (const f of parsed.fields) o[f] = r[f];
      o.verification_status = r.__result;
      o.suggested_correction = r.__suggestion;
      o.verification_flags = r.__flags.join('|');
      o.verification_note = r.__note;
      o.verification_source = r.__cached ? 'email_registry' : r.__email && !r.__note ? 'provider' : '';
      return o;
    });
  const columns = [...parsed.fields, 'verification_status', 'suggested_correction', 'verification_flags', 'verification_note', 'verification_source'];
  const validRows = results.rows.filter((r) => r.__result === 'valid');

  // Clean list: one row per unique valid email.
  const cleanRows = () => {
    const seen = new Set();
    return validRows.filter((r) => {
      const k = r.__email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white p-5 sm:flex-row sm:items-center sm:p-6">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/30">
            <CircleCheck className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900">Verification complete</h2>
            <p className="text-sm text-slate-600">
              {file?.name} · {PROVIDER_LABELS[results.provider] || 'NeverBounce'} · {results.mode === 'live' ? 'Live' : 'Mock sandbox'} · job{' '}
              <span className="font-mono text-xs">{results.jobId}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => downloadCsv(exportRows(results.rows), `${base}-verified.csv`, columns)}>
              <FileDown className="h-4 w-4" /> Download Full CSV
            </button>
            <button
              className="btn-primary"
              disabled={validRows.length === 0}
              onClick={() => downloadCsv(exportRows(cleanRows()), `${base}-valid-only.csv`, columns)}
            >
              <Download className="h-4 w-4" /> Download Clean List
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 divide-slate-100 border-b border-slate-100 sm:grid-cols-4 sm:divide-x">
          <SummaryStat label="Rows in file" value={formatNumber(results.rows.length)} />
          <SummaryStat
            label={results.reused ? `Unique emails · ${formatNumber(results.reused)} reused from registry` : 'Unique emails processed'}
            value={formatNumber(results.uniqueProcessed)}
          />
          <SummaryStat label="Credits used" value={formatNumber(results.creditsUsed)} accent />
          <SummaryStat label="Remaining balance" value={formatNumber(results.creditsRemaining)} />
        </div>

        <div className="p-5 sm:p-6">
          <p className="mb-3 text-xs font-medium text-slate-500">Breakdown of unique emails verified</p>
          <StatusBreakdown counts={results.uniqueCounts} height={14} />
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist">
            {['all', ...STATUS_ORDER].map((k) => {
              const n = k === 'all' ? results.rows.length : results.rowCounts[k];
              const active = filter === k;
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setFilter(k);
                    setPage(1);
                  }}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {k !== 'all' && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_META[k].color }} />}
                  {k === 'all' ? 'All' : STATUS_META[k].label}
                  <span className={`tabular-nums text-xs ${active ? 'text-slate-300' : 'text-slate-400'}`}>{formatNumber(n)}</span>
                </button>
              );
            })}
          </div>
          <div className="relative lg:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="input py-2 pl-9"
              placeholder="Search emails…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>

        {visible.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50/60">
                <tr>
                  <th className="th w-14">Row</th>
                  <th className="th">{column}</th>
                  <th className="th">Status</th>
                  <th className="th">Suggestion / note</th>
                  <th className="th">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => (
                  <tr key={r.__i} className="hover:bg-slate-50/60">
                    <td className="td tabular-nums text-slate-400">{r.__i + 1}</td>
                    <td className="td max-w-[280px] truncate font-mono text-[13px] text-slate-900">{r.__email || <span className="text-slate-300">empty</span>}</td>
                    <td className="td">
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={r.__result} />
                        {r.__cached && (
                          <span title="Reused from the email registry — no credit used" className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-semibold text-slate-500">
                            DB
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="td text-sm">
                      {r.__suggestion ? (
                        <span className="font-mono text-[13px] text-indigo-700">→ {r.__suggestion}</span>
                      ) : r.__note ? (
                        <span className="text-slate-500">{r.__note}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="td">
                      <div className="flex max-w-[260px] flex-wrap gap-1">
                        {r.__flags.slice(0, 4).map((f) => (
                          <span key={f} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                            {f}
                          </span>
                        ))}
                        {r.__flags.length > 4 && <span className="text-xs text-slate-400">+{r.__flags.length - 4}</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={Search} title="No matching rows" description="Try a different filter or search term." />
        )}

        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
            <span>
              {formatNumber((current - 1) * PAGE_SIZE + 1)}–{formatNumber(Math.min(current * PAGE_SIZE, filtered.length))} of {formatNumber(filtered.length)}
            </span>
            <div className="flex items-center gap-1">
              <button className="btn-ghost p-1.5" disabled={current === 1} onClick={() => setPage(current - 1)} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-2 tabular-nums">
                {current} / {pages}
              </span>
              <button className="btn-ghost p-1.5" disabled={current === pages} onClick={() => setPage(current + 1)} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="flex justify-center">
        <button className="btn-secondary" onClick={reset}>
          <UploadCloud className="h-4 w-4" /> Verify another file
        </button>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, accent }) {
  return (
    <div className="px-5 py-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${accent ? 'text-indigo-600' : 'text-slate-900'}`}>{value}</p>
    </div>
  );
}
