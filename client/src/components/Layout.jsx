import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import Sidebar, { NAV_ITEMS } from './Sidebar';
import Header from './Header';
import { useApp } from '../context/AppContext';

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();
  const { server, refreshStatus, refreshAccount } = useApp();
  const title = NAV_ITEMS.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))?.label ?? 'MailVerify';

  return (
    <div className="min-h-screen">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="lg:pl-60">
        <Header title={title} onMenu={() => setMobileOpen(true)} />
        {server.reachable === false && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800 sm:px-6">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              Can’t reach the verifier server. Start it with <code className="rounded bg-red-100 px-1 font-mono text-xs">npm run dev</code> from the project root.
            </span>
            <button
              className="font-medium underline underline-offset-2 hover:no-underline"
              onClick={async () => (await refreshStatus()) && refreshAccount({ silent: true })}
            >
              Retry
            </button>
          </div>
        )}
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
