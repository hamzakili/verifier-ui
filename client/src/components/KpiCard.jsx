export default function KpiCard({ label, value, sub, icon: Icon, accent = 'indigo', loading = false }) {
  const accents = {
    indigo: 'bg-indigo-50 text-indigo-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    red: 'bg-red-50 text-red-600',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {Icon && (
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accents[accent]}`}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
      </div>
      {loading ? (
        <div className="mt-2 h-8 w-28 animate-pulse rounded-md bg-slate-100" />
      ) : (
        <p className="mt-1 text-[28px] font-semibold leading-tight tracking-tight tabular-nums text-slate-900">{value}</p>
      )}
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
