import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  UploadCloud, Loader2, Check, ChevronLeft, ChevronRight, FileSpreadsheet, X, Columns3, Layers, FolderOpen, Settings2, ClipboardCheck,
  Play, AlertTriangle, Database, Download,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp, PROVIDER_LABELS } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { ELIGIBILITY_META, readFileText } from '../lib/bulkJobs';
import { sampleCsv } from '../lib/csv';
import { formatNumber, uid } from '../lib/format';
import FolderPicker from '../components/bulk/FolderPicker';
import ProviderSelector from '../components/ProviderSelector';
import ModeToggle from '../components/ModeToggle';

const MAX_LEADS = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STEPS = [
  { id: 'import', label: 'Import Leads', icon: UploadCloud },
  { id: 'batches', label: 'Batch Configuration', icon: Layers },
  { id: 'folder', label: 'Destination Folder', icon: FolderOpen },
  { id: 'settings', label: 'Verification Settings', icon: Settings2 },
  { id: 'review', label: 'Review', icon: ClipboardCheck },
];

export default function NewBulkJob() {
  const navigate = useNavigate();
  const toast = useToast();
  const { providers, effectiveMode, server, account } = useApp();
  const [step, setStep] = useState(0);
  const [imp, setImp] = useState(null);
  const [batchSize, setBatchSize] = useState(500);
  const [folderId, setFolderId] = useState(null);
  const [folderInfo, setFolderInfo] = useState(null);
  const [jobName, setJobName] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const requestId = useRef(uid()); // one job per wizard, even on double-click / retry

  const eligible = imp?.summary?.eligible ?? 0;
  const plan = imp?.batch_plans?.[batchSize] ?? null;
  const provider = providers.active;
  const registryOn = Boolean(server.centralDb?.enabled && server.centralDb?.connected) && effectiveMode === 'live';

  const canNext = [
    Boolean(imp && imp.summary && eligible > 0),
    Boolean(plan),
    Boolean(folderId),
    Boolean(provider),
    true,
  ];

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const r = await api.createVerificationJob({
        import_id: imp.import_id,
        email_column: imp.email_column,
        batch_size: batchSize,
        destination_folder_id: folderId,
        job_name: jobName.trim() || undefined,
        verification: { provider, mode: effectiveMode },
        client_request_id: requestId.current,
      });
      toast.success(r.duplicate ? 'This job was already started.' : 'Bulk verification started. Batches are processed automatically.');
      navigate(`/bulk-jobs/${r.job.id}`);
    } catch (err) {
      setStartError(err.message);
      setStarting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/bulk-jobs" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ChevronLeft className="h-4 w-4" /> Bulk Verification Jobs
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">New Bulk Verification</h1>
        </div>
      </div>

      <ol className="flex items-center gap-2 overflow-x-auto pb-1 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={i > step && !canNext.slice(0, i).every(Boolean)}
              onClick={() => i < step && setStep(i)}
              className="flex items-center gap-2 disabled:cursor-default"
              aria-current={i === step ? 'step' : undefined}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  i < step ? 'bg-indigo-600 text-white' : i === step ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-600' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={i === step ? 'font-medium text-slate-900' : 'text-slate-500'}>{s.label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-slate-200 sm:w-8" />}
          </li>
        ))}
      </ol>

      {step === 0 && <ImportStep imp={imp} setImp={setImp} />}
      {step === 1 && imp && <BatchStep imp={imp} batchSize={batchSize} setBatchSize={setBatchSize} />}
      {step === 2 && (
        <section className="card p-5 sm:p-6">
          <StepTitle icon={FolderOpen} title="Destination folder" text="Each batch is saved here automatically as soon as it finishes, in its own job folder." />
          <FolderPicker
            value={folderId}
            onChange={async (id) => {
              setFolderId(id);
              try {
                setFolderInfo((await api.folder(id)).folder);
              } catch {
                setFolderInfo(null);
              }
            }}
          />
        </section>
      )}
      {step === 3 && (
        <section className="card space-y-6 p-5 sm:p-6">
          <StepTitle icon={Settings2} title="Verification settings" text="Uses your current verification provider and mode. They stay fixed for the whole job." />
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <p className="label">Verification provider</p>
              <ProviderSelector />
            </div>
            <div>
              <p className="label">API mode</p>
              <ModeToggle fullWidth />
              <p className="mt-2 text-xs text-slate-500">
                {effectiveMode === 'mock' ? 'Mock sandbox: simulated results, no credits used.' : 'Live: real verification, uses provider credits.'}
              </p>
            </div>
          </div>
          <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <p className="flex items-center gap-2">
              <Database className="h-4 w-4 text-slate-400" />
              {registryOn
                ? 'Email registry connected: addresses already verified are reused for free and new results are saved to it.'
                : effectiveMode === 'mock'
                  ? 'Mock mode never reads or writes the email registry.'
                  : 'Email registry not connected: every email is sent to the provider.'}
            </p>
            {effectiveMode === 'live' && typeof account.creditsRemaining === 'number' && (
              <p className={`mt-1 ${eligible > account.creditsRemaining ? 'text-amber-700' : ''}`}>
                Up to {formatNumber(eligible)} credits ({formatNumber(account.creditsRemaining)} available).
              </p>
            )}
          </div>
          <div>
            <label htmlFor="job-name" className="label">Job name <span className="font-normal text-slate-400">(optional)</span></label>
            <input
              id="job-name"
              className="input"
              maxLength={120}
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              placeholder={`Automatic, e.g. ${(imp?.source_filename || 'Leads').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '_')}_${new Date().toLocaleString('en-US', { month: 'long' })}_${new Date().getDate()}_${new Date().getFullYear()}`}
            />
          </div>
        </section>
      )}
      {step === 4 && imp && plan && (
        <section className="card p-5 sm:p-6">
          <StepTitle icon={ClipboardCheck} title="Review" text="Check the configuration, then start. Batches run one after another and are saved automatically." />
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="Job name" value={jobName.trim() || 'Generated automatically'} />
            <Row label="Imported file" value={imp.source_filename} />
            <Row label="Total leads" value={formatNumber(imp.summary.total_imported)} />
            <Row label="Unique leads (eligible)" value={formatNumber(eligible)} />
            <Row label="Batch size" value={formatNumber(plan.batch_size)} />
            <Row label="Number of batches" value={formatNumber(plan.total_batches)} />
            <Row label="Destination folder" value={folderInfo?.path || '—'} />
            <Row label="Verification" value={`${PROVIDER_LABELS[provider] || provider} · ${effectiveMode === 'live' ? 'Live API' : 'Mock sandbox'}`} />
            <Row label="Auto-save" value="Enabled: every batch is saved to the folder when it finishes" />
            <Row label="Auto-continue" value="Enabled: the next batch starts after the previous one is saved" />
          </dl>
          {startError && (
            <p className="mt-5 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {startError}
            </p>
          )}
        </section>
      )}

      <div className="flex items-center justify-between">
        <button className="btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || starting}>
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button className="btn-primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext[step]}>
            Continue <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <button className="btn-primary" onClick={start} disabled={starting || !canNext.every(Boolean)}>
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start Bulk Verification
          </button>
        )}
      </div>
    </div>
  );
}

function StepTitle({ icon: Icon, title, text }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><Icon className="h-[18px] w-[18px]" /></span>
      <div>
        <h2 className="font-semibold text-slate-900">{title}</h2>
        <p className="text-sm text-slate-500">{text}</p>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex flex-col border-b border-slate-100 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ Step 1 */

function ImportStep({ imp, setImp }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [columnBusy, setColumnBusy] = useState(false);
  const input = useRef(null);
  const PER_PAGE = 25;

  const onFile = async (file) => {
    if (!file) return;
    setError(null);
    const name = file.name.toLowerCase();
    if (/\.(xlsx|xls|xlsm|ods|numbers)$/.test(name)) return setError('Excel files are not supported. Save the sheet as CSV (File → Save As → CSV) and upload that.');
    if (!/\.(csv|txt)$/.test(name)) return setError('Unsupported file type. Upload a .csv file.');
    if (file.size === 0) return setError('The file is empty.');
    if (file.size > MAX_FILE_BYTES) return setError('The file is larger than 10 MB.');
    setBusy(true);
    try {
      const text = await readFileText(file);
      const r = await api.bulkImport(file.name, text); // validated and limited server-side
      setImp(r.import);
      setFilter('all');
      setPage(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeColumn = async (col) => {
    if (!col) return;
    setColumnBusy(true);
    setError(null);
    try {
      setImp((await api.setImportColumn(imp.import_id, col)).import);
      setPage(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setColumnBusy(false);
    }
  };

  const rows = useMemo(() => (imp?.preview || []).filter((r) => filter === 'all' || r.eligibility === filter), [imp, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const shown = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const extraCols = imp ? imp.columns.filter((c) => c !== imp.email_column) : [];

  if (!imp) {
    return (
      <section className="card p-5 sm:p-6">
        <StepTitle icon={UploadCloud} title="Import leads" text={`Upload a CSV with up to ${formatNumber(MAX_LEADS)} leads. Every column is kept in the results.`} />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onFile(e.dataTransfer.files?.[0]);
          }}
          onClick={() => !busy && input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Upload CSV file"
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition ${
            drag ? 'border-indigo-500 bg-indigo-50/60' : 'border-slate-300 bg-slate-50/50 hover:border-indigo-400 hover:bg-indigo-50/30'
          }`}
        >
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200">
            {busy ? <Loader2 className="h-7 w-7 animate-spin" /> : <UploadCloud className="h-7 w-7" />}
          </span>
          <p className="text-base font-semibold text-slate-900">{busy ? 'Importing and validating…' : 'Drag & drop your CSV here'}</p>
          <p className="mt-1 text-sm text-slate-500">or <span className="font-medium text-indigo-600">browse files</span> · .csv · up to 10 MB</p>
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
            Maximum {formatNumber(MAX_LEADS)} leads per import
          </p>
          <input ref={input} type="file" accept=".csv,text/csv,.txt" className="hidden" onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = '';
          }} />
        </div>
        {error && <p className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
        <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3 sm:flex-row sm:items-center">
          <p className="text-sm text-slate-600">No list handy? Use the sample file (valid, typo, disposable, catch-all and duplicate rows).</p>
          <button
            className="btn-secondary shrink-0 py-1.5"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([sampleCsv()], { type: 'text/csv' }));
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

  const s = imp.summary;
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600"><FileSpreadsheet className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-slate-900">{imp.source_filename}</p>
          <p className="text-sm text-slate-500">{formatNumber(imp.total_rows)} rows · {imp.columns.length} columns{imp.headerless && ' · no header row detected'}</p>
        </div>
        <button className="btn-ghost self-start sm:self-center" onClick={() => setImp(null)}><X className="h-4 w-4" /> Change file</button>
      </div>

      <div className="mt-5 max-w-sm">
        <label htmlFor="email-col" className="label flex items-center gap-1.5"><Columns3 className="h-4 w-4 text-slate-400" /> Email column</label>
        <select id="email-col" className="input" value={imp.email_column || ''} disabled={columnBusy} onChange={(e) => changeColumn(e.target.value)}>
          <option value="">Select a column…</option>
          {imp.columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {imp.email_column_required && <p className="mt-2 text-sm text-amber-700">We couldn't find the email column automatically. Choose it here.</p>}
      </div>
      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}

      {s && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Imported" value={s.total_imported} />
            <Stat label="Unique" value={s.unique_emails} />
            <Stat label="Duplicates" value={s.duplicates} tone={s.duplicates ? 'amber' : undefined} />
            <Stat label="Empty email" value={s.empty} tone={s.empty ? 'slate' : undefined} />
            <Stat label="Invalid format" value={s.invalid_format} tone={s.invalid_format ? 'red' : undefined} />
            <Stat label="Eligible for verification" value={s.eligible} tone="indigo" />
          </div>
          {s.duplicates > 0 && (
            <p className="mt-3 text-sm text-slate-600">
              {formatNumber(s.duplicates)} duplicate {s.duplicates === 1 ? 'row is' : 'rows are'} verified only once; each keeps its own columns and gets its original's result in the complete results file.
            </p>
          )}
          {s.eligible === 0 && <p className="mt-3 text-sm font-medium text-red-700">No row has a valid email address, so there is nothing to verify.</p>}
        </>
      )}

      <div className="mt-6 flex flex-wrap gap-1">
        {['all', 'eligible', 'duplicate', 'empty', 'invalid_format'].map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f);
              setPage(1);
            }}
            disabled={!s && f !== 'all'}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${filter === f ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {f === 'all' ? 'All rows' : ELIGIBILITY_META[f].label}
          </button>
        ))}
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th w-14">Row</th>
              {imp.email_column && <th className="th">Email</th>}
              {s && <th className="th">Format</th>}
              {s && <th className="th">Duplicate</th>}
              {extraCols.map((c) => <th key={c} className="th whitespace-nowrap normal-case">{c}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r) => (
              <tr key={r.row_number}>
                <td className="td tabular-nums text-slate-400">{r.row_number}</td>
                {imp.email_column && <td className="td whitespace-nowrap font-medium text-slate-900">{r.email || <span className="text-slate-400">—</span>}</td>}
                {s && (
                  <td className={`td whitespace-nowrap ${ELIGIBILITY_META[r.eligibility === 'duplicate' ? 'eligible' : r.eligibility].className}`}>
                    {r.eligibility === 'empty' ? 'Empty' : r.eligibility === 'invalid_format' ? 'Invalid' : 'Valid'}
                  </td>
                )}
                {s && <td className="td whitespace-nowrap">{r.eligibility === 'duplicate' ? <span className="text-amber-700">Duplicate of row {r.duplicate_of_row}</span> : <span className="text-slate-400">—</span>}</td>}
                {extraCols.map((c) => <td key={c} className="td max-w-[220px] truncate" title={r.data[c]}>{r.data[c]}</td>)}
              </tr>
            ))}
            {!shown.length && (
              <tr><td className="td py-8 text-center text-slate-500" colSpan={4 + extraCols.length}>No rows in this view.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>Page {page} of {pages} · {formatNumber(rows.length)} rows</span>
          <div className="flex gap-1">
            <button className="btn-secondary px-2 py-1" disabled={page === 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
            <button className="btn-secondary px-2 py-1" disabled={page === pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }) {
  const tones = { indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800', amber: 'border-amber-200 bg-amber-50 text-amber-800', red: 'border-red-200 bg-red-50 text-red-700', slate: 'border-slate-200 bg-slate-50 text-slate-700' };
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tones[tone] || 'border-slate-200 bg-white text-slate-900'}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">{formatNumber(value)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ Step 2 */

function BatchStep({ imp, batchSize, setBatchSize }) {
  const eligible = imp.summary.eligible;
  const plan = imp.batch_plans[batchSize];
  return (
    <section className="card p-5 sm:p-6">
      <StepTitle icon={Layers} title="Batch configuration" text="Leads are verified one batch at a time. Each finished batch is saved before the next one starts." />
      <fieldset>
        <legend className="label">Emails per batch</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {imp.batch_sizes.map((size) => {
            const active = size === batchSize;
            const p = imp.batch_plans[size];
            return (
              <label
                key={size}
                className={`cursor-pointer rounded-xl border px-4 py-3 transition ${active ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/20' : 'border-slate-200 hover:border-slate-300'}`}
              >
                <input type="radio" name="batch-size" className="sr-only" value={size} checked={active} onChange={() => setBatchSize(size)} />
                <span className="block text-lg font-semibold tabular-nums text-slate-900">{formatNumber(size)}</span>
                <span className="text-xs text-slate-500">{p.total_batches} batch{p.total_batches === 1 ? '' : 'es'}{size === 500 ? ' · default' : ''}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Total eligible leads" value={eligible} />
        <Stat label="Batch size" value={plan.batch_size} tone="indigo" />
        <Stat label="Total batches" value={plan.total_batches} />
      </div>
      {plan.batch_size < batchSize && (
        <p className="mt-3 text-sm text-slate-600">There are only {formatNumber(eligible)} eligible leads, so they are verified in a single batch of {formatNumber(plan.batch_size)}.</p>
      )}
      <ul className="mt-5 flex flex-wrap gap-2" aria-label="Batches">
        {plan.batches.map((n, i) => (
          <li key={i} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm">
            <span className="text-slate-500">Batch {i + 1}:</span> <span className="font-medium tabular-nums text-slate-900">{formatNumber(n)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
