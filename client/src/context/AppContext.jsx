import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setApiMode } from '../lib/api';
import { emptyCounts } from '../lib/status';
import { uid } from '../lib/format';
import { useToast } from './ToastContext';

const AppContext = createContext(null);

const HISTORY_KEY = 'mv:history';
const MODE_KEY = 'mv:mode';
const SESSION_KEY = 'mv:session-credits';
const MAX_HISTORY = 500;

export const PROVIDER_LABELS = { millionverifier: 'MillionVerifier', neverbounce: 'NeverBounce' };
const PROVIDER_ENV = { millionverifier: 'MILLIONVERIFIER_API_KEY', neverbounce: 'NEVERBOUNCE_API_KEY' };
/** History written before provider support was added came from NeverBounce. */
export const entryProvider = (e) => e.provider || 'neverbounce';

function readJson(storage, key, fallback) {
  try {
    const v = storage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — non-fatal */
  }
}

export function AppProvider({ children }) {
  const toast = useToast();

  const [preferredMode, setPreferredMode] = useState(() => {
    const m = readJson(localStorage, MODE_KEY, 'live');
    setApiMode(m);
    return m;
  });
  const [server, setServer] = useState({ loading: true, reachable: null, liveAvailable: false, mode: null, keyHint: null, provider: null });
  const [account, setAccount] = useState({ loading: true, creditsRemaining: null, error: null, fetchedAt: null, provider: null });
  // The backend is the source of truth for the active provider; this mirrors it.
  const [providers, setProviders] = useState({ loading: true, list: [], active: null, default: null, switching: null });
  const [history, setHistory] = useState(() => readJson(localStorage, HISTORY_KEY, []));
  const [sessionCredits, setSessionCredits] = useState(() => {
    const v = readJson(sessionStorage, SESSION_KEY, {});
    return typeof v === 'number' ? { neverbounce: v } : v; // migrate pre-provider format
  });

  const activeProviderRef = useRef(null);
  const accountSeq = useRef(0);

  useEffect(() => writeJson(localStorage, HISTORY_KEY, history), [history]);
  useEffect(() => writeJson(sessionStorage, SESSION_KEY, sessionCredits), [sessionCredits]);

  const loadProviders = useCallback(async () => {
    try {
      const p = await api.providers();
      activeProviderRef.current = p.active_provider;
      setProviders((s) => ({ ...s, loading: false, list: p.providers, active: p.active_provider, default: p.default_provider }));
      return p;
    } catch {
      setProviders((s) => ({ ...s, loading: false }));
      return null;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.status();
      setServer({ loading: false, reachable: true, ...s });
      return s;
    } catch {
      setServer((prev) => ({ ...prev, loading: false, reachable: false }));
      return null;
    }
  }, []);

  const refreshAccount = useCallback(
    async ({ silent = false } = {}) => {
      const seq = ++accountSeq.current;
      setAccount((a) => ({ ...a, loading: true }));
      try {
        const info = await api.account();
        if (seq !== accountSeq.current) return info; // a newer request (e.g. after a switch) wins
        setAccount({ loading: false, error: null, fetchedAt: new Date().toISOString(), ...info });
        return info;
      } catch (err) {
        if (seq !== accountSeq.current) return null;
        // Never keep showing a balance we could not confirm.
        setAccount((a) => ({ ...a, loading: false, error: err.message, creditsRemaining: null }));
        if (!silent) toast.error(err.message, { title: 'Could not load credit balance' });
        return null;
      }
    },
    [toast],
  );

  const refreshAll = useCallback(async () => {
    const [, s] = await Promise.all([loadProviders(), refreshStatus()]);
    if (s) refreshAccount({ silent: true });
    else setAccount((a) => ({ ...a, loading: false, error: 'Server unreachable', creditsRemaining: null }));
  }, [loadProviders, refreshStatus, refreshAccount]);

  // Initial load + whenever the preferred mode changes.
  useEffect(() => {
    setApiMode(preferredMode);
    writeJson(localStorage, MODE_KEY, preferredMode);
    refreshAll();
  }, [preferredMode, refreshAll]);

  // Re-sync with the backend when the tab regains focus (another tab may have switched provider).
  useEffect(() => {
    const onFocus = async () => {
      const before = activeProviderRef.current;
      const p = await loadProviders();
      if (p && before && p.active_provider !== before) {
        refreshStatus();
        refreshAccount({ silent: true });
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadProviders, refreshStatus, refreshAccount]);

  const switchProvider = useCallback(
    async (id) => {
      if (id === providers.active || providers.switching) return false;
      setProviders((s) => ({ ...s, switching: id }));
      try {
        const r = await api.switchProvider(id);
        activeProviderRef.current = r.active_provider;
        setProviders((s) => ({ ...s, switching: null, active: r.active_provider, list: r.providers || s.list }));
        // Clear the old provider's balance immediately so it is never shown under the new name.
        accountSeq.current++;
        setAccount({ loading: true, creditsRemaining: null, error: null, fetchedAt: null, provider: r.active_provider });
        await refreshStatus();
        await refreshAccount({ silent: true });
        toast.success(`Verifications now use ${PROVIDER_LABELS[r.active_provider]}.`, { title: 'Provider switched' });
        return true;
      } catch (err) {
        setProviders((s) => ({ ...s, switching: null }));
        toast.error(err.message, { title: `Could not switch to ${PROVIDER_LABELS[id] || id}` });
        loadProviders();
        return false;
      }
    },
    [providers.active, providers.switching, refreshStatus, refreshAccount, loadProviders, toast],
  );

  const activeProvider = providers.active || server.provider || null;

  const changeMode = useCallback(
    (m) => {
      if (m === 'live' && server.reachable && !server.liveAvailable) {
        toast.warning(`Add ${PROVIDER_ENV[activeProvider] || 'an API key'} to server/.env and restart the server to enable live mode.`, {
          title: 'No API key configured',
        });
        return;
      }
      setPreferredMode(m);
      const name = PROVIDER_LABELS[activeProvider] || 'provider';
      toast.info(m === 'live' ? `Using the live ${name} API.` : 'Using the mock sandbox. No real credits will be spent.', {
        title: m === 'live' ? 'Live mode' : 'Mock sandbox',
      });
    },
    [server, activeProvider, toast],
  );

  /** Apply a new remaining balance returned by a verify call (avoids an extra round-trip). */
  const applyCredits = useCallback((used, remaining, provider) => {
    const p = provider || activeProviderRef.current || 'unknown';
    if (used) setSessionCredits((s) => ({ ...s, [p]: (s[p] || 0) + used }));
    // Only update the displayed balance if it belongs to the provider currently shown.
    if (typeof remaining === 'number' && p === activeProviderRef.current) {
      setAccount((a) => ({ ...a, creditsRemaining: remaining, error: null, fetchedAt: new Date().toISOString() }));
    }
  }, []);

  const recordSingle = useCallback((r) => {
    const entry = {
      id: uid(),
      type: 'single',
      createdAt: r.checkedAt || new Date().toISOString(),
      mode: r.mode,
      provider: r.provider,
      email: r.email,
      result: r.result,
      suggestedCorrection: r.suggestedCorrection || '',
      flags: r.flags || [],
      creditsUsed: r.creditsUsed,
      counts: { ...emptyCounts(), [r.result]: 1 },
      total: 1,
    };
    setHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
    return entry;
  }, []);

  const recordBulk = useCallback((b) => {
    const entry = { id: uid(), type: 'bulk', createdAt: new Date().toISOString(), ...b };
    setHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
    return entry;
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);
  const removeHistoryEntry = useCallback((id) => setHistory((h) => h.filter((e) => e.id !== id)), []);

  const stats = useMemo(() => {
    const counts = emptyCounts();
    const creditsByProvider = {};
    let total = 0;
    for (const e of history) {
      const p = entryProvider(e);
      creditsByProvider[p] = (creditsByProvider[p] || 0) + (e.creditsUsed || 0);
      for (const k of Object.keys(counts)) counts[k] += e.counts?.[k] || 0;
    }
    for (const k of Object.keys(counts)) total += counts[k];
    // Credits are reported per provider — balances and usage are never combined.
    const creditsUsed = activeProvider ? creditsByProvider[activeProvider] || 0 : 0;
    return { counts, creditsUsed, creditsByProvider, total };
  }, [history, activeProvider]);

  const effectiveMode = server.mode || (server.liveAvailable ? preferredMode : 'mock');

  const value = {
    preferredMode,
    effectiveMode,
    changeMode,
    server,
    refreshStatus,
    account,
    refreshAccount,
    applyCredits,
    providers,
    activeProvider,
    activeProviderName: PROVIDER_LABELS[activeProvider] || '',
    switchProvider,
    sessionCreditsUsed: sessionCredits[activeProvider] || 0,
    sessionCreditsByProvider: sessionCredits,
    resetSessionCredits: () => setSessionCredits({}),
    history,
    recordSingle,
    recordBulk,
    clearHistory,
    removeHistoryEntry,
    stats,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
