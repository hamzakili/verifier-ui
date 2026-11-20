import { NavLink } from 'react-router-dom';
import { LayoutDashboard, MailCheck, FileSpreadsheet, History, X, MailSearch, Database, Layers, FolderOpen } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useBulk } from '../context/BulkContext';
import ModeToggle from './ModeToggle';
import ProviderSelector from './ProviderSelector';

export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/single', label: 'Single Email Verifier', icon: MailCheck },
  { to: '/bulk', label: 'Bulk CSV Verifier', icon: FileSpreadsheet },
  { to: '/bulk-jobs', label: 'Bulk Verification Jobs', icon: Layers },
  { to: '/history', label: 'Verification History', icon: History },
  { to: '/files', label: 'Folders / Files', icon: FolderOpen },
  { to: '/registry', label: 'Email Registry', icon: Database },
];

/** Nav item for a path, matched by whole path segments ("/bulk" must not match "/bulk-jobs"). */
export const navItemFor = (pathname) =>
  NAV_ITEMS.find((n) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`)));

/** Shows whether the Email Registry API (Laravel) is reachable. */
function CentralDbStatus() {
  const { server } = useApp();
  const db = server.centralDb;
  if (!db) return null;
  let dot = 'bg-slate-300';
  let label = 'Not configured';
  let title = 'No email registry configured: every email goes straight to the provider.';
  if (db.enabled && db.connected && db.tableExists) {
    dot = 'bg-emerald-500';
    label = 'Connected';
    title = 'Emails are checked in the email registry before any provider call; new results are saved to it.';
  } else if (db.enabled && db.reachable) {
    dot = 'bg-red-500';
    label = 'Not authorized';
    title = 'The registry is running but rejected the server token (EMAIL_REGISTRY_API_TOKEN). Verification is paused.';
  } else if (db.enabled) {
    dot = 'bg-red-500';
    label = 'Unavailable';
    title =
      `The email registry is unreachable${db.error ? ` (${db.error})` : ''}. ` +
      (db.fallback === 'provider' ? 'Emails are verified without it until it is back.' : 'Verification is paused to avoid duplicate charges.');
  }
  return (
    <p className="flex items-center gap-2 text-xs text-slate-500" title={title}>
      <Database className="h-3.5 w-3.5 text-slate-400" />
      Email registry
      <span className="ml-auto flex items-center gap-1.5 font-medium text-slate-700">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </span>
    </p>
  );
}

function SidebarContent({ onNavigate }) {
  const { isRunning, job } = useBulk();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-slate-200 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <MailSearch className="h-[18px] w-[18px]" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">MailVerify</span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'}`} />
                <span className="truncate">{item.label}</span>
                {item.to === '/bulk' && isRunning && (
                  <span className="ml-auto rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                    {job?.percent ?? 0}%
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="space-y-4 border-t border-slate-200 p-4">
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">Verification provider</p>
          <ProviderSelector />
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">API mode</p>
          <ModeToggle fullWidth />
        </div>
        <CentralDbStatus />
      </div>
    </div>
  );
}

export default function Sidebar({ mobileOpen, onClose }) {
  return (
    <>
      {/* Desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-slate-200 bg-white lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 animate-fade-in bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose} />
          <aside className="absolute inset-y-0 left-0 w-60 animate-slide-in bg-white shadow-xl">
            <button onClick={onClose} className="absolute right-3 top-4 rounded-md p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <SidebarContent onNavigate={onClose} />
          </aside>
        </div>
      )}
    </>
  );
}
