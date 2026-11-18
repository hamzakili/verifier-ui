import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Loader2, Sparkles, Check, X, Clock, Coins, RotateCcw, Wand2, ShieldCheck, Database, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { isEmailSyntax } from '../lib/csv';
import { STATUS_META, FLAG_LABELS } from '../lib/status';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import { useApp, PROVIDER_LABELS } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';

const SAMPLES = [
  { email: 'valid@example.com', hint: 'valid' },
  { email: 'typo@gmial.com', hint: 'typo' },
  { email: 'temp@mailinator.com', hint: 'disposable' },
  { email: 'catchall@acme-corp.io', hint: 'catch-all' },
  { email: 'unknown@legacy-mail.net', hint: 'unknown' },
];

const META_FLAGS = ['free_email_host', 'role_account', 'has_dns', 'has_dns_mx', 'smtp_connectable'];

export default function SingleVerifier() {
  const { applyCredits, recordSingle, history, effectiveMode, refreshAccount, activeProviderName } = useApp();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const recentSingles = history.filter((h) => h.type === 'single').slice(0, 6);

  async function verify(target = email) {
    const value = target.trim();
    if (!value) {
      setError('Enter an email address to verify.');
      inputRef.current?.focus();
      return;
    }
    if (!isEmailSyntax(value)) {
      setError('That doesn’t look like a valid email address — no credits were spent.');
      return;
    }
    setError('');
    setEmail(value);
    setLoading(true);
    try {
      const r = await api.verifySingle(value);
      setResult(r);
      applyCredits(r.creditsUsed, r.creditsRemaining, r.provider);
      recordSingle(r);
    } catch (err) {
      const title =
        err.status === 429
          ? 'Rate limited'
          : err.status === 402
            ? 'Out of credits'
            : err.status === 503
              ? `${activeProviderName || 'Provider'} unavailable`
              : 'Verification failed';
      toast.error(err.message, { title });
      if (err.status === 402) refreshAccount({ silent: true });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
      <div className="space-y-6 xl:col-span-3">
        <section className="card p-5 sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Verify an email address</h2>
          <p className="mt-1 text-sm text-slate-500">
            Real-time check with typo detection. Each verification uses <span className="font-medium text-slate-700">1 credit</span>.
          </p>
          {activeProviderName && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">
              <ShieldCheck className="h-3.5 w-3.5 text-indigo-500" />
              Verifying with <span className="font-medium text-slate-800">{activeProviderName}</span>
              <span className="text-slate-400">·</span>
              {effectiveMode === 'live' ? 'Live' : 'Mock sandbox'}
            </p>
          )}

          <form
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
            noValidate
          >
            <label htmlFor="email" className="label">
              Email address
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  ref={inputRef}
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="name@company.com"
                  className={`input pl-10 ${error ? 'border-red-400 focus:border-red-500 focus:ring-red-500/10' : ''}`}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'email-error' : undefined}
                />
              </div>
              <button type="submit" className="btn-primary sm:w-36" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {loading ? 'Verifying…' : 'Verify Email'}
              </button>
            </div>
            {error && (
              <p id="email-error" className="mt-2 text-sm text-red-600">
                {error}
              </p>
            )}
          </form>

          <div className="mt-5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <Sparkles className="h-3.5 w-3.5" /> Try a sample
              {effectiveMode === 'live' && <span className="font-normal text-slate-400">(uses real credits in live mode)</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button
                  key={s.email}
                  type="button"
                  disabled={loading}
                  onClick={() => verify(s.email)}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-mono text-xs text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-50"
                >
                  {s.email}
                </button>
              ))}
            </div>
          </div>
        </section>

        {loading && !result && <ResultSkeleton />}
        {result && <ResultCard result={result} loading={loading} onReverify={verify} />}
      </div>

      <aside className="xl:col-span-2">
        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Recent single checks</h2>
          </div>
          {recentSingles.length ? (
            <ul className="divide-y divide-slate-100">
              {recentSingles.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => verify(h.email)}
                    disabled={loading}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-slate-50 disabled:opacity-60"
                    title="Re-verify"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] text-slate-800">{h.email}</p>
                      <p className="text-xs text-slate-500">{formatRelative(h.createdAt)}</p>
                    </div>
                    <StatusBadge status={h.result} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Mail} title="Nothing checked yet" description="Your latest single verifications will appear here." />
          )}
          {recentSingles.length > 0 && (
            <div className="border-t border-slate-100 px-5 py-3 text-right">
              <Link to="/history" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                Full history →
              </Link>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <section className="card animate-pulse space-y-4 p-6">
      <div className="h-6 w-32 rounded-full bg-slate-100" />
      <div className="h-4 w-64 rounded bg-slate-100" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-slate-100" />
        ))}
      </div>
    </section>
  );
}

function ResultCard({ result, loading, onReverify }) {
  const meta = STATUS_META[result.result] || STATUS_META.unknown;
  const Icon = meta.icon;
  const flags = new Set(result.flags);
  const extraFlags = result.flags.filter((f) => !META_FLAGS.includes(f));
  // Providers report different flag sets; anything not reported is "not provided", not "No".
  const supported = new Set(result.availableFlags || META_FLAGS);
  const providerLabel = PROVIDER_LABELS[result.provider] || (result.cached ? 'Email registry' : 'NeverBounce');

  return (
    <section className={`card overflow-hidden transition-opacity ${loading ? 'opacity-60' : ''}`} aria-live="polite">
      <div className={`flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:p-6 ${meta.soft}`}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm" style={{ color: meta.color }}>
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={result.result} size="lg" />
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${result.mode === 'live' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
              {providerLabel} · {result.mode === 'live' ? 'Live' : 'Mock'}
            </span>
          </div>
          <p className="mt-1.5 truncate font-mono text-sm text-slate-900">{result.email}</p>
          <p className={`text-sm ${meta.text}`}>{meta.description}</p>
        </div>
        <div className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 sm:self-center">
          <Coins className="h-3.5 w-3.5 text-indigo-500" />
          Credits Used: <span className="tabular-nums">{result.creditsUsed}</span>
          <span className="text-slate-300">|</span>
          Remaining: <span className="tabular-nums">{formatNumber(result.creditsRemaining)}</span>
        </div>
      </div>

      {result.cached && (
        <div className="flex items-center gap-2.5 border-b border-slate-100 bg-slate-50 px-5 py-3 text-sm text-slate-600 sm:px-6">
          <Database className="h-4 w-4 shrink-0 text-emerald-600" />
          <p>
            Reused from the email registry
            {result.verifiedAt && <> · verified {formatDateTime(result.verifiedAt)}</>}
            {' · '}
            <span className="font-medium text-emerald-700">no credit used</span>
          </p>
        </div>
      )}

      {!result.cached && result.mode === 'live' && result.registry && (result.registry.lookup === 'unavailable' || result.registry.saved === false) && result.registry.reason !== 'mock_mode' && (
        <div className="flex items-center gap-2.5 border-b border-amber-100 bg-amber-50 px-5 py-3 text-sm text-amber-800 sm:px-6">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p>
            {result.registry.lookup === 'unavailable' ? 'The email registry could not be checked, so this was verified directly. ' : ''}
            {result.registry.saved ? '' : 'The result is not saved to the registry yet; the server will retry.'}
          </p>
        </div>
      )}

      {result.suggestedCorrection && (
        <div className="flex flex-col gap-3 border-b border-indigo-100 bg-indigo-50/60 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
          <Wand2 className="hidden h-5 w-5 shrink-0 text-indigo-600 sm:block" />
          <p className="flex-1 text-sm text-slate-700">
            Did you mean <span className="font-mono font-semibold text-indigo-700">{result.suggestedCorrection}</span>?
          </p>
          <button className="btn-primary py-1.5" onClick={() => onReverify(result.suggestedCorrection)} disabled={loading}>
            <RotateCcw className="h-4 w-4" /> Verify suggestion
          </button>
        </div>
      )}

      <div className="p-5 sm:p-6">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Details</h3>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {META_FLAGS.map((f) => (
            <FlagItem key={f} label={FLAG_LABELS[f]} on={flags.has(f)} supported={supported.has(f)} />
          ))}
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3.5 py-2.5">
            <dt className="flex items-center gap-2 text-sm text-slate-600">
              <Clock className="h-4 w-4 text-slate-400" /> Execution time
            </dt>
            <dd className="text-sm font-medium tabular-nums text-slate-900">
              {result.executionTime != null ? `${formatNumber(result.executionTime)} ms` : '—'}
            </dd>
          </div>
        </dl>

        {(result.addressInfo || extraFlags.length > 0) && (
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {result.addressInfo && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Address info</h4>
                <dl className="space-y-1 text-sm">
                  {[
                    ['Normalized', result.addressInfo.normalized_email],
                    ['Mailbox', result.addressInfo.addr],
                    ['Host', result.addressInfo.host || result.addressInfo.fqdn],
                    ['TLD', result.addressInfo.tld],
                  ]
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="w-24 shrink-0 text-slate-500">{k}</dt>
                        <dd className="truncate font-mono text-[13px] text-slate-800">{v}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            )}
            {extraFlags.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Other flags</h4>
                <div className="flex flex-wrap gap-1.5">
                  {extraFlags.map((f) => (
                    <span key={f} className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
                      {FLAG_LABELS[f] || f}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function FlagItem({ label, on, supported = true }) {
  if (!supported) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-slate-200 px-3.5 py-2.5">
        <dt className="text-sm text-slate-500">{label}</dt>
        <dd className="text-xs text-slate-400" title="This provider does not report this check">
          Not provided
        </dd>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3.5 py-2.5">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className={`inline-flex items-center gap-1 text-sm font-medium ${on ? 'text-emerald-700' : 'text-slate-400'}`}>
        {on ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
        {on ? 'Yes' : 'No'}
      </dd>
    </div>
  );
}
