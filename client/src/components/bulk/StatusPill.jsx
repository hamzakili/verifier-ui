import { Loader2 } from 'lucide-react';
import { JOB_STATUS_META, BATCH_STATUS_META } from '../../lib/bulkJobs';

export function JobStatusPill({ status }) {
  return <Pill meta={JOB_STATUS_META[status] || { label: status, badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' }} />;
}

export function BatchStatusPill({ status }) {
  return <Pill meta={BATCH_STATUS_META[status] || { label: status, badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' }} />;
}

function Pill({ meta }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}>
      {meta.spinning && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {meta.label}
    </span>
  );
}

export function ProgressBar({ percent, tone = 'indigo', size = 'md', label }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const tones = { indigo: 'bg-indigo-600', emerald: 'bg-emerald-500', red: 'bg-red-500', amber: 'bg-amber-500', slate: 'bg-slate-400' };
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-slate-100 ${size === 'sm' ? 'h-1.5' : 'h-2.5'}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-label={label}
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${tones[tone] || tones.indigo}`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** Progress bar colour for a job status. */
export const toneFor = (status) =>
  status === 'completed' ? 'emerald' : status === 'failed' ? 'red' : ['paused', 'pausing', 'completed_with_errors'].includes(status) ? 'amber' : status === 'cancelled' ? 'slate' : 'indigo';
