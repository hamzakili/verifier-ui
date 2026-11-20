import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Folder, FolderOpen, FolderPlus, FileText, Download, Trash2, ChevronRight, Loader2, Layers } from 'lucide-react';
import { api, downloadFromApi, downloadPaths } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { formatBytes } from '../lib/bulkJobs';
import { formatDateTime, formatNumber } from '../lib/format';
import { CreateFolderModal } from '../components/bulk/FolderPicker';
import { JobStatusPill } from '../components/bulk/StatusPill';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';

/** "Folders / Files": browse the logical folders that hold verification results. */
export default function Files() {
  const { folderId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState({ loading: true, error: null, folder: null, subfolders: [], files: [], breadcrumb: [], job: null });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      if (folderId) {
        const r = await api.folder(folderId);
        setState({ loading: false, error: null, folder: r.folder, subfolders: r.subfolders, files: r.files, breadcrumb: r.breadcrumb, job: r.job });
      } else {
        const r = await api.folders();
        setState({ loading: false, error: null, folder: null, subfolders: r.folders.filter((f) => !f.parent_folder_id), files: [], breadcrumb: [], job: null });
      }
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err }));
    }
  }, [folderId]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    const f = deleting;
    setDeleting(null);
    try {
      await api.deleteFolder(f.id);
      toast.success(`Folder “${f.folder_name}” deleted.`);
      if (f.id === folderId) navigate(state.folder?.parent_folder_id ? `/files/${state.folder.parent_folder_id}` : '/files');
      else load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const isEmpty = !state.loading && state.subfolders.length === 0 && state.files.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
            <Link to="/files" className="hover:text-slate-800">My Verification Files</Link>
            {state.breadcrumb.map((b) => (
              <span key={b.id} className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5" />
                <Link to={`/files/${b.id}`} className="hover:text-slate-800">{b.folder_name}</Link>
              </span>
            ))}
          </nav>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-slate-900">{state.folder?.folder_name ?? 'Folders / Files'}</h1>
          {state.folder?.description && <p className="text-sm text-slate-500">{state.folder.description}</p>}
        </div>
        <div className="flex gap-2">
          {state.folder && !state.folder.is_job_folder && isEmpty && (
            <button className="btn-secondary text-red-700" onClick={() => setDeleting(state.folder)}><Trash2 className="h-4 w-4" /> Delete folder</button>
          )}
          {!state.folder?.is_job_folder && (
            <button className="btn-primary" onClick={() => setCreating(true)}><FolderPlus className="h-4 w-4" /> {state.folder ? 'New Subfolder' : 'Create New Folder'}</button>
          )}
        </div>
      </div>

      {state.job && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-sm">
          <span className="flex items-center gap-2 text-slate-700"><Layers className="h-4 w-4 text-indigo-600" /> Output of bulk job <span className="font-medium text-slate-900">{state.job.job_name}</span> <JobStatusPill status={state.job.status} /></span>
          <Link to={`/bulk-jobs/${state.job.id}`} className="font-medium text-indigo-700 hover:underline">Open job</Link>
        </div>
      )}

      <section className="card overflow-hidden">
        {state.loading ? (
          <p className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        ) : state.error ? (
          <EmptyState icon={Folder} title={state.error.status === 404 ? 'Folder not found' : 'Could not load folders'} description={state.error.message} action={<Link to="/files" className="btn-secondary">My Verification Files</Link>} />
        ) : isEmpty ? (
          <EmptyState
            icon={FolderOpen}
            title={state.folder ? 'This folder is empty' : 'No folders yet'}
            description={state.folder ? 'Choose it as the destination of a bulk verification job, or add a subfolder.' : 'Create a folder, then pick it as the destination of a bulk verification job.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Name</th>
                  <th className="th">Contents</th>
                  <th className="th">Updated</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.subfolders.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-50/60">
                    <td className="td">
                      <Link to={`/files/${f.id}`} className="flex items-center gap-2 font-medium text-slate-900 hover:text-indigo-700">
                        {f.is_job_folder ? <Layers className="h-4 w-4 text-indigo-500" /> : <Folder className="h-4 w-4 text-amber-500" />}
                        {f.folder_name}
                      </Link>
                      {f.description && <p className="ml-6 text-xs text-slate-500">{f.description}</p>}
                    </td>
                    <td className="td text-slate-500">{formatNumber(f.subfolder_count)} folders · {formatNumber(f.file_count)} files</td>
                    <td className="td whitespace-nowrap text-slate-500">{formatDateTime(f.updated_at)}</td>
                    <td className="td text-right">
                      {!f.is_job_folder && f.subfolder_count === 0 && f.file_count === 0 && (
                        <button className="btn-ghost px-2 py-1 text-slate-500 hover:text-red-700" onClick={() => setDeleting(f)} aria-label={`Delete ${f.folder_name}`} title="Delete empty folder">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {state.files.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-50/60">
                    <td className="td"><span className="flex items-center gap-2 text-slate-900"><FileText className="h-4 w-4 text-slate-400" />{f.file_name}</span></td>
                    <td className="td text-slate-500">{formatBytes(f.size_bytes)}{f.row_count != null && ` · ${formatNumber(f.row_count)} rows`}</td>
                    <td className="td whitespace-nowrap text-slate-500">{formatDateTime(f.updated_at)}</td>
                    <td className="td text-right">
                      <button className="btn-ghost px-2 py-1" onClick={() => downloadFromApi(downloadPaths.file(f.id), f.file_name).catch((e) => toast.error(e.message))} aria-label={`Download ${f.file_name}`} title="Download">
                        <Download className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CreateFolderModal
        open={creating}
        parent={state.folder}
        onClose={() => setCreating(false)}
        onCreated={(f) => {
          toast.success(`Folder “${f.folder_name}” created.`);
          load();
        }}
      />
      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete folder?"
        description={deleting ? `“${deleting.folder_name}” is empty and will be removed.` : ''}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn bg-red-600 text-white hover:bg-red-700" onClick={remove}>Delete</button>
          </>
        }
      />
    </div>
  );
}
