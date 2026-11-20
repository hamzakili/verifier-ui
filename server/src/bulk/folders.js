/**
 * Logical folders for verification output ("My Verification Files"). Folders exist only in the
 * database; files are stored under a private storage root and are never addressed by path.
 * Every operation is scoped to the owner, and a folder that is not the caller's is reported as
 * "not found" so other owners' folders cannot even be probed.
 */
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';

const MAX_DEPTH = 8;
const INVALID_CHARS = /[\u0000-\u001f\u007f\\/:*?"<>|]/;

export function validateFolderName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new ApiError(422, 'invalid_folder_name', 'Enter a folder name.', { folder_name: ['Enter a folder name.'] });
  if (name.length > 80) throw new ApiError(422, 'invalid_folder_name', 'Folder names can be at most 80 characters.', { folder_name: ['At most 80 characters.'] });
  if (INVALID_CHARS.test(name) || name === '.' || name === '..') {
    throw new ApiError(422, 'invalid_folder_name', 'Folder names cannot contain / \\ : * ? " < > | or control characters.', {
      folder_name: ['Contains characters that are not allowed.'],
    });
  }
  return name;
}

export function createFolderService(db) {
  const now = () => new Date().toISOString();

  function find(ownerId, id) {
    if (typeof id !== 'string' || !id) return null;
    return db.get('SELECT * FROM verification_folders WHERE id = ? AND owner_id = ?', id, ownerId) || null;
  }

  function requireOwned(ownerId, id, { message = 'Folder not found.', code = 'folder_not_found' } = {}) {
    const f = find(ownerId, id);
    if (!f) throw new ApiError(404, code, message);
    return f;
  }

  /** "My Verification Files / Clients / Client A" */
  function pathOf(ownerId, folder) {
    const parts = [folder.folder_name];
    let cur = folder;
    for (let i = 0; i < MAX_DEPTH + 2 && cur.parent_folder_id; i++) {
      cur = find(ownerId, cur.parent_folder_id);
      if (!cur) break;
      parts.unshift(cur.folder_name);
    }
    return ['My Verification Files', ...parts].join(' / ');
  }

  function depthOf(ownerId, folderId) {
    let d = 0;
    let cur = find(ownerId, folderId);
    while (cur?.parent_folder_id && d <= MAX_DEPTH) {
      d += 1;
      cur = find(ownerId, cur.parent_folder_id);
    }
    return d;
  }

  function view(ownerId, f) {
    const counts = db.get(
      `SELECT (SELECT COUNT(*) FROM verification_folders c WHERE c.parent_folder_id = ?) AS subfolders,
              (SELECT COUNT(*) FROM verification_files v WHERE v.folder_id = ?) AS files`,
      f.id,
      f.id,
    );
    return {
      id: f.id,
      folder_name: f.folder_name,
      description: f.description,
      parent_folder_id: f.parent_folder_id,
      is_job_folder: Boolean(f.is_job_folder),
      path: pathOf(ownerId, f),
      subfolder_count: counts.subfolders,
      file_count: counts.files,
      created_at: f.created_at,
      updated_at: f.updated_at,
    };
  }

  function insert(ownerId, { name, description = null, parentId = null, isJobFolder = false }) {
    const id = randomUUID();
    const t = now();
    try {
      db.run(
        `INSERT INTO verification_folders (id, owner_id, parent_folder_id, folder_name, description, is_job_folder, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ownerId, parentId, name, description, isJobFolder ? 1 : 0, t, t,
      );
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) {
        throw new ApiError(409, 'folder_exists', `A folder named "${name}" already exists here.`, { folder_name: ['A folder with this name already exists here.'] });
      }
      throw err;
    }
    return find(ownerId, id);
  }

  return {
    find,
    requireOwned,
    pathOf,
    view: (ownerId, f) => view(ownerId, f),

    /** All of the owner's folders (flat; the UI builds the tree from parent_folder_id). */
    list(ownerId, { includeJobFolders = true } = {}) {
      const rows = db.all(
        `SELECT * FROM verification_folders WHERE owner_id = ? ${includeJobFolders ? '' : 'AND is_job_folder = 0'} ORDER BY lower(folder_name)`,
        ownerId,
      );
      return rows.map((f) => view(ownerId, f));
    },

    create(ownerId, { folder_name, description, parent_folder_id }) {
      const name = validateFolderName(folder_name);
      const desc = description == null || description === '' ? null : String(description).trim().slice(0, 500) || null;
      let parentId = null;
      if (parent_folder_id) {
        parentId = requireOwned(ownerId, parent_folder_id, { message: 'The parent folder was not found.', code: 'parent_folder_not_found' }).id;
        if (depthOf(ownerId, parentId) >= MAX_DEPTH - 1) throw new ApiError(422, 'folder_too_deep', `Folders can be nested at most ${MAX_DEPTH} levels deep.`);
      }
      return view(ownerId, insert(ownerId, { name, description: desc, parentId }));
    },

    /** Folder with its subfolders, files and breadcrumb trail. */
    detail(ownerId, id) {
      const f = requireOwned(ownerId, id);
      const children = db.all('SELECT * FROM verification_folders WHERE owner_id = ? AND parent_folder_id = ? ORDER BY lower(folder_name)', ownerId, f.id);
      const files = db.all(
        `SELECT id, kind, file_name, size_bytes, row_count, mime_type, job_id, batch_id, created_at, updated_at
           FROM verification_files WHERE owner_id = ? AND folder_id = ? ORDER BY file_name`,
        ownerId,
        f.id,
      );
      const breadcrumb = [];
      let cur = f;
      for (let i = 0; cur && i < MAX_DEPTH + 2; i++) {
        breadcrumb.unshift({ id: cur.id, folder_name: cur.folder_name });
        cur = cur.parent_folder_id ? find(ownerId, cur.parent_folder_id) : null;
      }
      const job = f.is_job_folder ? db.get('SELECT id, job_name, status FROM bulk_verification_jobs WHERE job_folder_id = ? AND owner_id = ?', f.id, ownerId) : null;
      return { folder: view(ownerId, f), subfolders: children.map((c) => view(ownerId, c)), files, breadcrumb, job: job || null };
    },

    /** Only empty folders that no job writes to can be deleted (results are never deleted implicitly). */
    remove(ownerId, id) {
      const f = requireOwned(ownerId, id);
      const v = view(ownerId, f);
      if (v.subfolder_count > 0 || v.file_count > 0) {
        throw new ApiError(409, 'folder_not_empty', 'Only empty folders can be deleted. This folder still contains files or subfolders.');
      }
      const inUse = db.get(
        'SELECT COUNT(*) AS n FROM bulk_verification_jobs WHERE owner_id = ? AND (destination_folder_id = ? OR job_folder_id = ?)',
        ownerId, f.id, f.id,
      ).n;
      if (inUse) throw new ApiError(409, 'folder_in_use', 'This folder is the destination of a bulk verification job and cannot be deleted.');
      db.run('DELETE FROM verification_folders WHERE id = ? AND owner_id = ?', f.id, ownerId);
    },

    /** Create the per-job output folder inside the destination, e.g. "Job_20261120_001". Never reuses an existing folder. */
    createJobFolder(ownerId, parentId, date = new Date()) {
      const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      const existing = db
        .all(`SELECT folder_name FROM verification_folders WHERE owner_id = ? AND parent_folder_id = ? AND folder_name LIKE ?`, ownerId, parentId, `Job_${stamp}_%`)
        .map((r) => Number.parseInt(r.folder_name.slice(`Job_${stamp}_`.length), 10))
        .filter(Number.isFinite);
      let seq = existing.length ? Math.max(...existing) + 1 : 1;
      for (let attempt = 0; attempt < 50; attempt++, seq++) {
        try {
          return insert(ownerId, { name: `Job_${stamp}_${String(seq).padStart(3, '0')}`, parentId, isJobFolder: true });
        } catch (err) {
          if (err.code !== 'folder_exists') throw err;
        }
      }
      throw new ApiError(500, 'folder_create_failed', 'Could not create a unique job folder.');
    },
  };
}
