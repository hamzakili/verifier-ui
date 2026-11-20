/**
 * Display helpers for Bulk Verification Jobs. Plain functions/data (no React) so they can be
 * unit-tested with `node --test`.
 */

export const JOB_STATUS_META = {
  draft: { label: 'Draft', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
  queued: { label: 'Queued', badge: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  processing: { label: 'Processing', badge: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20', spinning: true },
  pausing: { label: 'Pausing…', badge: 'bg-amber-50 text-amber-800 ring-amber-600/25', spinning: true },
  paused: { label: 'Paused', badge: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
  completed: { label: 'Completed', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  completed_with_errors: { label: 'Completed with errors', badge: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
  failed: { label: 'Failed', badge: 'bg-red-50 text-red-700 ring-red-600/20' },
  cancelling: { label: 'Cancelling…', badge: 'bg-slate-100 text-slate-700 ring-slate-500/20', spinning: true },
  cancelled: { label: 'Cancelled', badge: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
};

export const BATCH_STATUS_META = {
  pending: { label: 'Pending', badge: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  queued: { label: 'Queued', badge: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  processing: { label: 'Processing', badge: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20', spinning: true },
  saving: { label: 'Saving results', badge: 'bg-violet-50 text-violet-700 ring-violet-600/20', spinning: true },
  retrying: { label: 'Retrying', badge: 'bg-amber-50 text-amber-800 ring-amber-600/25', spinning: true },
  completed: { label: 'Completed', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  failed: { label: 'Failed', badge: 'bg-red-50 text-red-700 ring-red-600/20' },
  cancelled: { label: 'Cancelled', badge: 'bg-slate-100 text-slate-500 ring-slate-500/20' },
  paused: { label: 'Paused', badge: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
};

/** Statuses in which the server is still working on the job (the job page keeps polling). */
export const ACTIVE_JOB_STATUSES = ['queued', 'processing', 'pausing', 'cancelling'];
export const isActiveJob = (status) => ACTIVE_JOB_STATUSES.includes(status);

export const ELIGIBILITY_META = {
  eligible: { label: 'Valid format', className: 'text-emerald-700' },
  duplicate: { label: 'Duplicate', className: 'text-amber-700' },
  empty: { label: 'Empty', className: 'text-slate-500' },
  invalid_format: { label: 'Invalid format', className: 'text-red-700' },
};

/** What the batch table shows for a batch, e.g. "Pending" becomes "Paused" while the job is paused. */
export function batchDisplayStatus(batch, jobStatus) {
  if (batch.status === 'pending' && jobStatus === 'paused') return 'paused';
  if (batch.status === 'pending' && jobStatus === 'queued') return 'queued';
  return batch.status;
}

/** Flat folder list (with parent ids) -> sorted tree [{ ...folder, children: [] }]. */
export function buildFolderTree(folders) {
  const byId = new Map(folders.map((f) => [f.id, { ...f, children: [] }]));
  const roots = [];
  for (const f of byId.values()) {
    const parent = f.parent_folder_id ? byId.get(f.parent_folder_id) : null;
    (parent ? parent.children : roots).push(f);
  }
  const sort = (list) => {
    list.sort((a, b) => a.folder_name.localeCompare(b.folder_name, undefined, { sensitivity: 'base' }));
    list.forEach((f) => sort(f.children));
    return list;
  };
  return sort(roots);
}

/** Folders matching a search, plus their ancestors so the tree stays navigable. */
export function filterFolderTree(folders, search) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return buildFolderTree(folders);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const keep = new Set();
  for (const f of folders) {
    if (!f.folder_name.toLowerCase().includes(q)) continue;
    for (let cur = f; cur && !keep.has(cur.id); cur = cur.parent_folder_id ? byId.get(cur.parent_folder_id) : null) keep.add(cur.id);
  }
  return buildFolderTree(folders.filter((f) => keep.has(f.id)));
}

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const pad3 = (n) => String(n).padStart(3, '0');

/** Read a File as text (UTF-8). */
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsText(file);
  });
}
