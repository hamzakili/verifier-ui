import { Link } from 'react-router-dom';
import { Wallet, Coins, ShieldCheck, ShieldBan, MailCheck, Upload, ArrowRight, Activity, Loader2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useBulk } from '../context/BulkContext';
import KpiCard from '../components/KpiCard';
import StatusBreakdown from '../components/StatusBreakdown';
import ActivityTable from '../components/ActivityTable';
import EmptyState from '../components/EmptyState';
import { formatNumber, formatPercent } from '../lib/format';

export default function Dashboard() {
  const { account, stats, sessionCreditsUsed, history, effectiveMode, activeProviderName } = useApp();
  const { isRunning, job, file } = useBulk();

  const blocked = stats.counts.invalid + stats.counts.disposable;

  return (
    <div className="space-y-6">
      {isRunning && (
        <Link to="/bulk" className="card flex items-center gap-4 border-indigo-200 bg-indigo-50/50 p-4 transition hover:bg-indigo-50">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-indigo-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-900">Bulk job running · {file?.name}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-100">
              <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${job?.percent ?? 0}%` }} />
            </div>
          </div>
          <span className="text-sm font-semibold tabular-nums text-indigo-700">{job?.percent ?? 0}%</span>
        </Link>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Remaining credits"
          value={formatNumber(account.creditsRemaining)}
          sub={
            account.error && account.creditsRemaining == null
              ? `${activeProviderName} balance unavailable`
              : effectiveMode === 'live'
                ? `${activeProviderName} account balance`
                : `${activeProviderName} mock sandbox balance`
          }
          icon={Wallet}
          loading={account.loading && account.creditsRemaining == null}
        />
        <KpiCard
          label="Total credits used"
          value={formatNumber(stats.creditsUsed)}
          sub={`${activeProviderName} · ${formatNumber(sessionCreditsUsed)} this session · all-time in this browser`}
          icon={Coins}
          accent="slate"
        />
        <KpiCard
          label="Deliverability rate"
          value={formatPercent(stats.counts.valid, stats.total)}
          sub={`${formatNumber(stats.counts.valid)} valid of ${formatNumber(stats.total)} verified`}
          icon={ShieldCheck}
          accent="emerald"
        />
        <KpiCard
          label="Invalid / disposable blocked"
          value={formatNumber(blocked)}
          sub={`${formatNumber(stats.counts.invalid)} invalid · ${formatNumber(stats.counts.disposable)} disposable`}
          icon={ShieldBan}
          accent="red"
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-5 flex items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Verification status breakdown</h2>
              <p className="text-xs text-slate-500">All single and bulk checks recorded in this browser</p>
            </div>
            <span className="text-sm tabular-nums text-slate-500">{formatNumber(stats.total)} emails</span>
          </div>
          <StatusBreakdown counts={stats.counts} height={16} />
        </div>

        <div className="grid grid-cols-1 gap-4">
          <QuickAction
            to="/single"
            icon={MailCheck}
            title="Verify a single email"
            body="Check one address in real time with typo suggestions."
          />
          <QuickAction
            to="/bulk"
            icon={Upload}
            title="Upload a CSV file"
            body="Clean a whole list and export the valid contacts."
          />
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Recent activity</h2>
            <p className="text-xs text-slate-500">Latest single checks and bulk jobs</p>
          </div>
          {history.length > 0 && (
            <Link to="/history" className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>
        {history.length ? (
          <ActivityTable entries={history.slice(0, 8)} />
        ) : (
          <EmptyState
            icon={Activity}
            title="No verifications yet"
            description="Run a single check or upload a CSV and your activity will show up here."
            action={
              <Link to="/single" className="btn-primary">
                <MailCheck className="h-4 w-4" /> Verify your first email
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}

function QuickAction({ to, icon: Icon, title, body }) {
  return (
    <Link
      to={to}
      className="card group flex items-start gap-4 p-5 transition hover:border-indigo-300 hover:shadow-md hover:shadow-indigo-500/5"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-sm font-semibold text-slate-900">
          {title}
          <ArrowRight className="h-4 w-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-indigo-600" />
        </p>
        <p className="mt-0.5 text-sm text-slate-500">{body}</p>
      </div>
    </Link>
  );
}
