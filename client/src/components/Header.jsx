import { Menu, RefreshCw, Coins, WifiOff } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { formatNumber } from '../lib/format';

function ApiStatus() {
  const { server, effectiveMode, activeProviderName } = useApp();
  if (server.loading) {
    return <span className="h-7 w-28 animate-pulse rounded-full bg-slate-100" />;
  }
  if (!server.reachable) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
        <WifiOff className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Server offline</span>
      </span>
    );
  }
  const live = effectiveMode === 'live';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
        live ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-amber-50 text-amber-800 ring-amber-600/25'
      }`}
      title={
        live
          ? `Connected to the live ${activeProviderName} API`
          : `Mock sandbox (${activeProviderName}) — simulated responses, no real credits spent`
      }
    >
      <span className="relative flex h-2 w-2">
        {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      </span>
      <span className="hidden sm:inline">
        {activeProviderName} · {live ? 'Live' : 'Mock Sandbox'}
      </span>
      <span className="sm:hidden">{live ? 'Live' : 'Mock'}</span>
    </span>
  );
}

function CreditPill() {
  const { account, refreshAccount, sessionCreditsUsed, activeProviderName } = useApp();
  return (
    <div
      className="flex items-center rounded-full border border-slate-200 bg-white py-1 pl-3 pr-1 shadow-sm"
      title={account.error ? `${activeProviderName} balance unavailable: ${account.error}` : `${activeProviderName} credit balance`}
    >
      <Coins className="mr-2 h-4 w-4 text-indigo-500" />
      <div className="flex items-baseline gap-1.5 text-sm">
        {account.creditsRemaining === null || account.creditsRemaining === undefined ? (
          account.error && !account.loading ? (
            <span className="text-xs font-medium text-red-600">Balance unavailable</span>
          ) : (
            <span className="text-slate-400">…</span>
          )
        ) : (
          <span className="font-semibold tabular-nums text-slate-900">{formatNumber(account.creditsRemaining)}</span>
        )}
        {!(account.error && account.creditsRemaining == null) && (
          <span className="hidden text-xs text-slate-500 md:inline">{activeProviderName} credits</span>
        )}
      </div>
      <span className="mx-2.5 hidden h-4 w-px bg-slate-200 sm:block" />
      <span className="hidden text-xs text-slate-500 sm:inline" title="Credits used in this browser session">
        <span className="font-medium tabular-nums text-slate-700">{formatNumber(sessionCreditsUsed)}</span> used this session
      </span>
      <button
        onClick={() => refreshAccount()}
        disabled={account.loading}
        className="ml-1.5 rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
        aria-label="Refresh credit balance"
        title="Refresh credit balance"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${account.loading ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );
}

export default function Header({ title, onMenu }) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-6">
      <button onClick={onMenu} className="-ml-1 rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 sm:text-lg">{title}</h1>
      <div className="flex items-center gap-2 sm:gap-3">
        <ApiStatus />
        <CreditPill />
      </div>
    </header>
  );
}
