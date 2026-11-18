import { Check, Loader2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useBulk } from '../context/BulkContext';

const ORDER = ['millionverifier', 'neverbounce'];

/**
 * Lets the user pick the verification provider. The selection lives on the
 * backend (POST /api/providers/switch); this only mirrors it.
 */
export default function ProviderSelector() {
  const { providers, switchProvider } = useApp();
  const { isRunning } = useBulk();

  if (providers.loading && !providers.list.length) {
    return (
      <div className="space-y-1.5">
        <div className="h-11 animate-pulse rounded-lg bg-slate-100" />
        <div className="h-11 animate-pulse rounded-lg bg-slate-100" />
      </div>
    );
  }
  if (!providers.list.length) {
    return <p className="text-xs text-slate-400">Providers unavailable — server offline.</p>;
  }

  const list = [...providers.list].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  return (
    <div>
      <div className="space-y-1.5" role="radiogroup" aria-label="Verification provider">
        {list.map((p) => {
          const active = p.id === providers.active;
          const switching = providers.switching === p.id;
          const disabled = !!providers.switching || isRunning || (!p.available && !active);
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={active}
              disabled={disabled && !active}
              onClick={() => !active && switchProvider(p.id)}
              title={
                !p.available
                  ? `${p.name} has no API key configured on the server`
                  : isRunning && !active
                    ? 'Wait for the running bulk job to finish before switching'
                    : undefined
              }
              className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                active
                  ? 'border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-white'
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  active ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white'
                }`}
              >
                {switching ? <Loader2 className="h-3 w-3 animate-spin text-indigo-600" /> : active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[13px] font-medium ${active ? 'text-indigo-900' : 'text-slate-800'}`}>{p.name}</span>
                <span className="block text-[11px] text-slate-500">
                  {p.is_default ? 'Default' : 'Alternative'}
                  {!p.available && ' · not configured'}
                </span>
              </span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.available ? 'bg-emerald-500' : 'bg-slate-300'}`}
                aria-label={p.available ? 'Configured' : 'Not configured'}
              />
            </button>
          );
        })}
      </div>
      {isRunning && <p className="mt-1.5 text-[11px] text-slate-400">Locked while a bulk job is running.</p>}
    </div>
  );
}
