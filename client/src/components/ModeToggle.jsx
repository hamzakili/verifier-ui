import { FlaskConical, Zap } from 'lucide-react';
import { useApp } from '../context/AppContext';

/** Segmented control for Live API vs Mock Sandbox. */
export default function ModeToggle({ fullWidth = false }) {
  const { effectiveMode, changeMode, server, activeProviderName } = useApp();
  const opts = [
    { id: 'live', label: 'Live API', icon: Zap, disabled: server.reachable && !server.liveAvailable },
    { id: 'mock', label: 'Mock', icon: FlaskConical, disabled: false },
  ];
  return (
    <div className={`inline-flex rounded-lg bg-slate-100 p-1 ${fullWidth ? 'w-full' : ''}`} role="radiogroup" aria-label="API mode">
      {opts.map((o) => {
        const active = effectiveMode === o.id;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={active}
            onClick={() => !active && changeMode(o.id)}
            title={o.disabled ? `No API key configured on the server for ${activeProviderName}` : undefined}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            } ${o.disabled ? 'opacity-50' : ''}`}
          >
            <o.icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
