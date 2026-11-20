import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Loader2, Search, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { filterFolderTree } from '../../lib/bulkJobs';
import Modal from '../Modal';

/** "+ Create New Folder" dialog. Calls onCreated(folder) after the server created it. */
export function CreateFolderModal({ open, onClose, onCreated, parent = null }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setError(null);
    }
  }, [open]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim()) {
      setError('Enter a folder name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.createFolder({ folder_name: name, description, parent_folder_id: parent?.id || null });
      onCreated?.(r.folder);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title="Create new folder"
      description={parent ? `Inside “${parent.folder_name}”` : 'In My Verification Files'}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="folder-name" className="label">Folder name</label>
          <input id="folder-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. November Campaign" />
          <p className="mt-1 text-xs text-slate-500">Up to 80 characters. Not allowed: / \ : * ? " &lt; &gt; |</p>
        </div>
        <div>
          <label htmlFor="folder-desc" className="label">Description <span className="font-normal text-slate-400">(optional)</span></label>
          <textarea id="folder-desc" className="input min-h-[72px]" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/**
 * Destination folder picker: browse/search the user's folders (job output folders are hidden),
 * select one, or create a new folder / subfolder.
 */
export default function FolderPicker({ value, onChange }) {
  const [state, setState] = useState({ loading: true, folders: [], error: null });
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [creating, setCreating] = useState(null); // null | { parent }

  const load = useCallback(async () => {
    try {
      const r = await api.folders();
      setState({ loading: false, folders: r.folders.filter((f) => !f.is_job_folder), error: null });
      return r.folders;
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tree = useMemo(() => filterFolderTree(state.folders, search), [state.folders, search]);
  const selected = state.folders.find((f) => f.id === value) || null;
  const searching = Boolean(search.trim());

  const toggle = (id) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const onCreated = async (folder) => {
    await load();
    if (folder.parent_folder_id) setExpanded((s) => new Set(s).add(folder.parent_folder_id));
    onChange(folder.id);
  };

  const renderNode = (f, depth) => {
    const open = searching || expanded.has(f.id);
    const isSel = f.id === value;
    return (
      <li key={f.id}>
        <div
          className={`group flex items-center gap-1 rounded-lg pr-2 text-sm ${isSel ? 'bg-indigo-50 text-indigo-800 ring-1 ring-inset ring-indigo-200' : 'hover:bg-slate-50'}`}
          style={{ paddingLeft: `${depth * 18 + 4}px` }}
        >
          <button
            type="button"
            className={`rounded p-1 text-slate-400 hover:text-slate-700 ${f.children.length ? '' : 'invisible'}`}
            onClick={() => toggle(f.id)}
            aria-label={open ? `Collapse ${f.folder_name}` : `Expand ${f.folder_name}`}
          >
            <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" onClick={() => onChange(f.id)} aria-pressed={isSel}>
            {isSel ? <FolderOpen className="h-4 w-4 shrink-0 text-indigo-600" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
            <span className="truncate font-medium">{f.folder_name}</span>
            {f.description && <span className="hidden truncate text-xs text-slate-400 sm:inline">— {f.description}</span>}
          </button>
          <button
            type="button"
            onClick={() => setCreating({ parent: f })}
            className="rounded p-1 text-slate-400 opacity-0 hover:bg-white hover:text-indigo-600 focus:opacity-100 group-hover:opacity-100"
            title="New subfolder"
            aria-label={`New subfolder in ${f.folder_name}`}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          {isSel && <Check className="h-4 w-4 shrink-0 text-indigo-600" />}
        </div>
        {open && f.children.length > 0 && <ul>{f.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input py-2 pl-9" placeholder="Search folders…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search folders" />
        </div>
        <button type="button" className="btn-secondary shrink-0" onClick={() => setCreating({ parent: null })}>
          <FolderPlus className="h-4 w-4" /> Create New Folder
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <p className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          <FolderOpen className="h-4 w-4 text-slate-400" /> My Verification Files
        </p>
        <div className="max-h-72 overflow-y-auto p-2">
          {state.loading ? (
            <p className="flex items-center gap-2 px-2 py-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading folders…</p>
          ) : state.error ? (
            <p className="px-2 py-4 text-sm text-red-700">{state.error} <button className="underline" onClick={load}>Retry</button></p>
          ) : tree.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-slate-500">{searching ? 'No folder matches your search.' : 'No folders yet. Create one to store your results.'}</p>
          ) : (
            <ul>{tree.map((f) => renderNode(f, 0))}</ul>
          )}
        </div>
      </div>

      <p className="text-sm text-slate-600">
        {selected ? (
          <>Results will be saved to <span className="font-medium text-slate-900">{selected.path}</span> / <span className="font-mono text-xs">Job_YYYYMMDD_NNN</span></>
        ) : (
          <span className="text-amber-700">Select a destination folder.</span>
        )}
      </p>

      <CreateFolderModal open={Boolean(creating)} parent={creating?.parent} onClose={() => setCreating(null)} onCreated={onCreated} />
    </div>
  );
}
