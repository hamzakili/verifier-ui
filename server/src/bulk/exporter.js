/**
 * CSV exports for Bulk Verification Jobs and the private file storage behind them.
 *
 *  - Files live under a private storage root (BULK_STORAGE_DIR); the API only ever exposes file
 *    ids and file names, never paths. Storage keys are generated here and validated so they can
 *    never escape the root (no path traversal).
 *  - Writes are atomic (temp file + rename) and verified (size + SHA-256 read back) before the
 *    file is recorded, so a batch is only marked complete once its export really exists.
 *  - Exports are idempotent: one file per (job, batch, kind) with a deterministic storage key;
 *    regenerating replaces the file and its record instead of creating a duplicate.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import Papa from 'papaparse';
import { ApiError } from '../errors.js';

const STATUS_REASON = {
  valid: 'Safe to send: the mailbox exists and accepts mail.',
  invalid: 'Will bounce: the address or domain does not exist.',
  disposable: 'Temporary inbox from a throwaway provider.',
  catchall: 'Domain accepts all mail; the mailbox cannot be confirmed.',
  unknown: 'The mail server did not give a definitive answer.',
};
const PROVIDER_NAMES = { millionverifier: 'MillionVerifier', neverbounce: 'NeverBounce' };

export const VERIFICATION_COLUMNS = [
  'verification_status',
  'verification_reason',
  'verified_at',
  'provider',
  'is_valid',
  'is_disposable',
  'is_catch_all',
  'is_role_based',
  'is_free_email',
  'suggested_correction',
  'from_registry',
];

export function createStorage(rootDir) {
  const root = resolve(rootDir);
  const KEY_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/;

  function pathFor(key) {
    if (!KEY_RE.test(key) || key.split('/').some((p) => p === '..' || p === '.')) {
      throw new ApiError(500, 'invalid_storage_key', 'Invalid storage key.');
    }
    const p = resolve(root, ...key.split('/'));
    if (!p.startsWith(root + sep)) throw new ApiError(500, 'invalid_storage_key', 'Invalid storage key.');
    return p;
  }

  return {
    root,
    /** Atomically write and verify. Returns { size, sha256 }. */
    async write(key, buffer) {
      const target = pathFor(key);
      const dir = target.slice(0, target.lastIndexOf(sep));
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.tmp-${randomUUID()}`);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      try {
        await writeFile(tmp, buffer);
        await rename(tmp, target);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      const check = await readFile(target);
      const checkSha = createHash('sha256').update(check).digest('hex');
      if (check.length !== buffer.length || checkSha !== sha256) {
        throw Object.assign(new Error('Export verification failed: the written file does not match.'), { code: 'export_verify_failed' });
      }
      return { size: check.length, sha256 };
    },
    async exists(key) {
      try {
        return (await stat(pathFor(key))).isFile();
      } catch {
        return false;
      }
    },
    stream: (key) => createReadStream(pathFor(key)),
  };
}

/** Neutralize spreadsheet formulas (CSV injection) without touching ordinary values like "+1 555". */
export function safeCell(v) {
  const s = v == null ? '' : String(v);
  if (/^[=@\t\r]/.test(s) || /^[+-][^\d\s.]/.test(s)) return `'${s}`;
  return s;
}

function toCsv(columns, rows) {
  const data = rows.map((r) => columns.map((c) => safeCell(r[c])));
  // BOM + CRLF so Excel opens UTF-8 (accents, non-Latin names) correctly.
  return Buffer.from(`﻿${Papa.unparse({ fields: columns, data }, { newline: '\r\n', quotes: false })}\r\n`, 'utf8');
}

/** Columns: every imported column (in order), then the verification columns (renamed if they clash). */
export function outputColumns(importedColumns) {
  const taken = new Set(importedColumns.map((c) => c.toLowerCase()));
  const extra = VERIFICATION_COLUMNS.map((c) => (taken.has(c) ? `${c}_result` : c));
  return { columns: [...importedColumns, ...extra], extra };
}

/** One lead (DB row) -> one CSV row. `original` is the lead a duplicate points to. */
export function leadToRow(lead, extra, original = null) {
  const data = JSON.parse(lead.original_data_json);
  const src = original || lead;
  const res = src.verification_result_json ? JSON.parse(src.verification_result_json) : null;
  const flags = res?.flags || [];
  const avail = res?.availableFlags || [];
  const flag = (f) => (avail.includes(f) ? (flags.includes(f) ? 'true' : 'false') : '');
  const status = src.verification_status || '';
  let reason;
  if (lead.eligibility === 'empty') reason = 'No email address in this row (not verified).';
  else if (lead.eligibility === 'invalid_format') reason = 'Invalid email format (not verified).';
  else if (src.processing_status !== 'completed') reason = src.error_message || 'Not verified yet.';
  else reason = [STATUS_REASON[status] || '', res?.note || '', res?.cached ? 'Reused from the email registry.' : ''].filter(Boolean).join(' ');
  if (lead.eligibility === 'duplicate') reason = `Duplicate of row ${lead.duplicate_of_row}. ${reason}`.trim();

  const values = [
    lead.eligibility === 'invalid_format' ? 'invalid' : status,
    reason,
    src.verified_at || '',
    res?.provider ? `${PROVIDER_NAMES[res.provider] || res.provider}${res.mode === 'mock' ? ' (mock sandbox)' : ''}` : '',
    status ? String(status === 'valid') : '',
    status ? String(status === 'disposable') : '',
    status ? String(status === 'catchall') : '',
    flag('role_account'),
    flag('free_email_host'),
    res?.suggestedCorrection || '',
    res ? String(Boolean(res.cached)) : '',
  ];
  const row = { ...data };
  extra.forEach((c, i) => {
    row[c] = values[i];
  });
  return row;
}

export function createExporter({ db, storage }) {
  const now = () => new Date().toISOString();

  /** Write + verify + upsert the file record. Idempotent per (job, batch, kind). */
  async function saveFile({ job, batchId = null, kind, fileName, buffer, rowCount }) {
    const storageKey = `jobs/${job.id}/${fileName}`;
    const { size, sha256 } = await storage.write(storageKey, buffer);
    const t = now();
    return db.tx(() => {
      const existing = db.get('SELECT id FROM verification_files WHERE job_id = ? AND IFNULL(batch_id, \'\') = ? AND kind = ?', job.id, batchId || '', kind);
      if (existing) {
        db.run(
          'UPDATE verification_files SET file_name = ?, storage_key = ?, size_bytes = ?, row_count = ?, sha256 = ?, folder_id = ?, updated_at = ? WHERE id = ?',
          fileName, storageKey, size, rowCount, sha256, job.job_folder_id, t, existing.id,
        );
        return existing.id;
      }
      const id = randomUUID();
      db.run(
        `INSERT INTO verification_files (id, owner_id, folder_id, job_id, batch_id, kind, file_name, storage_key, size_bytes, row_count, sha256, mime_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text/csv', ?, ?)`,
        id, job.owner_id, job.job_folder_id, job.id, batchId, kind, fileName, storageKey, size, rowCount, sha256, t, t,
      );
      return id;
    });
  }

  return {
    /** batch_001_verified.csv: exactly the batch's eligible leads, in original row order. */
    async exportBatch(job, batch) {
      const { columns, extra } = outputColumns(JSON.parse(job.columns_json));
      const leads = db.all('SELECT * FROM bulk_verification_job_leads WHERE batch_id = ? ORDER BY original_row_number', batch.id);
      if (leads.length !== batch.total_emails) {
        throw Object.assign(new Error(`Batch has ${leads.length} leads but expected ${batch.total_emails}.`), { code: 'export_row_mismatch' });
      }
      const rows = leads.map((l) => leadToRow(l, extra));
      const fileName = `batch_${String(batch.batch_number).padStart(3, '0')}_verified.csv`;
      return saveFile({ job, batchId: batch.id, kind: 'batch', fileName, buffer: toCsv(columns, rows), rowCount: rows.length });
    },

    /** all_results.csv: every imported row in original order (duplicates get their original's result). */
    async exportAllResults(job) {
      const { columns, extra } = outputColumns(JSON.parse(job.columns_json));
      const leads = db.all('SELECT * FROM bulk_verification_job_leads WHERE job_id = ? ORDER BY original_row_number', job.id);
      const byRow = new Map(leads.map((l) => [l.original_row_number, l]));
      const rows = leads.map((l) => leadToRow(l, extra, l.eligibility === 'duplicate' ? byRow.get(l.duplicate_of_row) : null));
      return saveFile({ job, kind: 'all_results', fileName: 'all_results.csv', buffer: toCsv(columns, rows), rowCount: rows.length });
    },

    /** verification_summary.csv: one metric per row. */
    async exportSummary(job) {
      const started = job.started_at ? Date.parse(job.started_at) : null;
      const completed = job.completed_at ? Date.parse(job.completed_at) : null;
      const seconds = started && completed ? Math.max(0, Math.round((completed - started) / 1000)) : '';
      const metrics = [
        ['Job name', job.job_name],
        ['Job ID', job.id],
        ['Source file', job.source_filename],
        ['Status', job.status],
        ['Total imported', job.total_imported],
        ['Total eligible', job.total_eligible],
        ['Total duplicates', job.total_duplicates],
        ['Empty email rows', job.total_empty],
        ['Invalid format rows', job.total_invalid_format],
        ['Total verified', job.verified_count],
        ['Valid', job.valid_count],
        ['Invalid', job.invalid_count],
        ['Disposable', job.disposable_count],
        ['Catch-all', job.catchall_count],
        ['Unknown', job.unknown_count],
        ['Failed', job.failed_count],
        ['Reused from email registry', job.reused_count],
        ['Batch size', job.batch_size],
        ['Total batches', job.total_batches],
        ['Completed batches', job.completed_batches],
        ['Failed batches', job.failed_batches],
        ['Start time', job.started_at || ''],
        ['Completion time', job.completed_at || ''],
        ['Processing duration (seconds)', seconds],
      ].map(([metric, value]) => ({ metric, value }));
      return saveFile({ job, kind: 'summary', fileName: 'verification_summary.csv', buffer: toCsv(['metric', 'value'], metrics), rowCount: metrics.length });
    },
  };
}
