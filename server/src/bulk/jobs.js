/**
 * Bulk Verification Jobs: imports, job creation, views, and the job state machine.
 *
 * Job statuses:   draft -> queued -> processing -> completed | completed_with_errors
 *                 processing -> pausing -> paused -> queued (resume)
 *                 processing -> cancelling -> cancelled;  draft|queued|paused|failed -> cancelled
 *                 processing -> failed (a batch failed permanently) -> queued (resume / retry batch)
 *                 completed* -> queued only through an explicit batch retry of failed records
 * Batch statuses: pending -> processing -> saving -> completed
 *                 processing|saving -> failed -> retrying -> processing ...;  pending -> cancelled
 *
 * Processing itself happens in runner.js; this module only changes state in the database and
 * hands jobs to the runner.
 */
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import {
  BATCH_SIZES, DEFAULT_BATCH_SIZE, MAX_LEADS, batchPlans, classifyRows, detectEmailColumn, parseLeadsCsv, planBatches, safeFilename,
} from './importer.js';

export const JOB_STATUSES = ['draft', 'queued', 'processing', 'pausing', 'paused', 'completed', 'completed_with_errors', 'failed', 'cancelling', 'cancelled'];
export const ACTIVE_STATUSES = ['queued', 'processing', 'pausing', 'cancelling'];
const TERMINAL = ['completed', 'completed_with_errors', 'cancelled'];
const IMPORT_TTL_MS = 24 * 60 * 60_000;
const MAX_BATCH_RETRIES = 5;
const PROVIDER_NAMES = { millionverifier: 'MillionVerifier', neverbounce: 'NeverBounce' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const now = () => new Date().toISOString();

export function defaultJobName(filename, date = new Date()) {
  const base = safeFilename(filename).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Leads';
  return `${base}_${MONTHS[date.getMonth()]}_${date.getDate()}_${date.getFullYear()}`;
}

function cleanJobName(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 120) throw new ApiError(422, 'invalid_job_name', 'Job names can be at most 120 characters.', { job_name: ['At most 120 characters.'] });
  return s;
}

export function createJobService({ db, folders, providers, resolveMode, registryEnabled = false, logger = console }) {
  let runner = null; // attached by the runner (it needs this service too)

  // ------------------------------------------------------------------ imports

  function importView(imp, emailColumn = imp.email_column) {
    const fields = JSON.parse(imp.columns_json);
    const rows = JSON.parse(imp.rows_json);
    const detected = detectEmailColumn(fields, rows);
    const base = {
      import_id: imp.id,
      source_filename: imp.source_filename,
      columns: fields,
      headerless: Boolean(imp.headerless),
      detected_email_column: detected,
      email_column: emailColumn,
      total_rows: imp.total_rows,
      max_leads: MAX_LEADS,
      batch_sizes: BATCH_SIZES,
      default_batch_size: DEFAULT_BATCH_SIZE,
      expires_at: imp.expires_at,
      job_id: imp.job_id,
    };
    if (!emailColumn) {
      return { ...base, email_column_required: true, summary: null, batch_plans: null, preview: rows.map((data, i) => ({ row_number: i + 1, data })) };
    }
    const { leads, summary } = classifyRows(rows, emailColumn);
    return {
      ...base,
      email_column_required: false,
      summary,
      batch_plans: batchPlans(summary.eligible),
      preview: leads.map((l) => ({ row_number: l.row_number, email: l.email, eligibility: l.eligibility, duplicate_of_row: l.duplicate_of_row, data: l.data })),
    };
  }

  function requireImport(ownerId, importId) {
    const imp = typeof importId === 'string' ? db.get('SELECT * FROM bulk_verification_imports WHERE id = ? AND owner_id = ?', importId, ownerId) : null;
    if (!imp) throw new ApiError(404, 'import_not_found', 'Import not found. Upload the file again.');
    if (!imp.job_id && Date.parse(imp.expires_at) < Date.now()) throw new ApiError(410, 'import_expired', 'This import has expired. Upload the file again.');
    return imp;
  }

  function checkColumn(imp, column) {
    if (column == null || column === '') return null;
    const fields = JSON.parse(imp.columns_json);
    if (!fields.includes(column)) {
      throw new ApiError(422, 'invalid_email_column', `The file has no column named "${String(column).slice(0, 100)}".`, { email_column: ['Choose one of the file\'s columns.'] });
    }
    return column;
  }

  // ------------------------------------------------------------------ views

  function batchView(b, live) {
    const inFlight = live?.get(b.id);
    const done = b.verified_count + b.failed_count;
    const liveProcessed = inFlight ? Math.min(b.total_emails, done + inFlight.processed) : done;
    return {
      id: b.id,
      batch_number: b.batch_number,
      total_emails: b.total_emails,
      processed_count: liveProcessed,
      verified_count: b.verified_count,
      failed_count: b.failed_count,
      valid_count: b.valid_count,
      invalid_count: b.invalid_count,
      disposable_count: b.disposable_count,
      catchall_count: b.catchall_count,
      unknown_count: b.unknown_count,
      reused_count: b.reused_count,
      status: b.status,
      stage: inFlight?.stage ?? null,
      retry_count: b.retry_count,
      error_kind: b.error_kind,
      error_message: b.error_message,
      provider: b.provider,
      started_at: b.started_at,
      completed_at: b.completed_at,
      duration_ms: b.duration_ms,
      output_file: b.output_file_id ? fileView(db.get('SELECT * FROM verification_files WHERE id = ?', b.output_file_id)) : null,
      can_retry: canRetryBatch(b),
    };
  }

  const canRetryBatch = (b) => b.retry_count < MAX_BATCH_RETRIES && (b.status === 'failed' || (b.status === 'completed' && b.failed_count > 0));

  function fileView(f) {
    if (!f) return null;
    return { id: f.id, kind: f.kind, file_name: f.file_name, size_bytes: f.size_bytes, row_count: f.row_count, created_at: f.created_at, updated_at: f.updated_at };
  }

  function jobView(job, { withBatches = false } = {}) {
    const live = runner?.liveProgress();
    const batches = db.all('SELECT * FROM bulk_verification_batches WHERE job_id = ? ORDER BY batch_number', job.id);
    const views = batches.map((b) => batchView(b, live));
    const processed = views.reduce((n, b) => n + b.processed_count, 0);
    const conf = JSON.parse(job.configuration_json);
    const dest = folders.find(job.owner_id, job.destination_folder_id);
    const jobFolder = job.job_folder_id ? folders.find(job.owner_id, job.job_folder_id) : null;
    const current = views.find((b) => ['processing', 'saving', 'retrying'].includes(b.status)) || (ACTIVE_STATUSES.includes(job.status) ? views.find((b) => b.status === 'pending') : null);
    const files = db.all("SELECT * FROM verification_files WHERE job_id = ? AND kind != 'batch' ORDER BY kind", job.id).map(fileView);
    const status = job.status;
    const percent = job.total_eligible ? Math.min(100, Math.floor((processed / job.total_eligible) * 1000) / 10) : 0;

    return {
      id: job.id,
      job_name: job.job_name,
      source_filename: job.source_filename,
      status,
      email_column: job.email_column,
      destination_folder: dest ? { id: dest.id, folder_name: dest.folder_name, path: folders.pathOf(job.owner_id, dest) } : null,
      job_folder: jobFolder ? { id: jobFolder.id, folder_name: jobFolder.folder_name, path: folders.pathOf(job.owner_id, jobFolder) } : null,
      total_imported: job.total_imported,
      total_eligible: job.total_eligible,
      total_duplicates: job.total_duplicates,
      total_empty: job.total_empty,
      total_invalid_format: job.total_invalid_format,
      batch_size: job.batch_size,
      total_batches: job.total_batches,
      completed_batches: job.completed_batches,
      failed_batches: job.failed_batches,
      pending_batches: batches.filter((b) => ['pending', 'retrying', 'processing', 'saving'].includes(b.status)).length,
      cancelled_batches: batches.filter((b) => b.status === 'cancelled').length,
      current_batch: current ? current.batch_number : null,
      progress: { processed, total: job.total_eligible, remaining: Math.max(0, job.total_eligible - processed), percent: status === 'completed' ? 100 : percent },
      counts: {
        verified: job.verified_count,
        failed: job.failed_count,
        valid: job.valid_count,
        invalid: job.invalid_count,
        disposable: job.disposable_count,
        catchall: job.catchall_count,
        unknown: job.unknown_count,
        reused: job.reused_count,
      },
      configuration: { provider: conf.provider, provider_name: PROVIDER_NAMES[conf.provider] || conf.provider, mode: conf.mode, registry: conf.registry, auto_save: true, auto_continue: true },
      pause_requested: Boolean(job.pause_requested),
      cancel_requested: Boolean(job.cancel_requested),
      error_message: job.error_message,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      updated_at: job.updated_at,
      files,
      actions: {
        can_start: status === 'draft',
        can_pause: ['queued', 'processing'].includes(status),
        can_resume: ['paused', 'pausing', 'failed'].includes(status),
        can_cancel: ['draft', 'queued', 'processing', 'pausing', 'paused', 'failed'].includes(status),
        can_download: files.some((f) => f.kind === 'all_results') || views.some((b) => b.output_file),
      },
      ...(withBatches ? { batches: views } : {}),
    };
  }

  function requireJob(ownerId, jobId) {
    const job = typeof jobId === 'string' ? db.get('SELECT * FROM bulk_verification_jobs WHERE id = ? AND owner_id = ?', jobId, ownerId) : null;
    if (!job) throw new ApiError(404, 'job_not_found', 'Bulk verification job not found.');
    return job;
  }

  function requireBatch(job, batchId) {
    const b = typeof batchId === 'string' ? db.get('SELECT * FROM bulk_verification_batches WHERE id = ? AND job_id = ?', batchId, job.id) : null;
    if (!b) throw new ApiError(404, 'batch_not_found', 'Batch not found.');
    return b;
  }

  /** Recompute job + batch counters from the leads (cheap at <= 1,000 leads; one source of truth). */
  function refreshCounters(jobId) {
    db.tx(() => {
      const t = now();
      db.run(
        `UPDATE bulk_verification_batches AS b SET
           verified_count   = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed'),
           failed_count     = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'failed'),
           valid_count      = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed' AND l.verification_status = 'valid'),
           invalid_count    = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed' AND l.verification_status = 'invalid'),
           disposable_count = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed' AND l.verification_status = 'disposable'),
           catchall_count   = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed' AND l.verification_status = 'catchall'),
           unknown_count    = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed' AND l.verification_status = 'unknown'),
           reused_count     = (SELECT COUNT(*) FROM bulk_verification_job_leads l WHERE l.batch_id = b.id AND l.processing_status = 'completed' AND json_extract(l.verification_result_json, '$.cached') = 1),
           updated_at = ?
         WHERE b.job_id = ?`,
        t, jobId,
      );
      const s = db.get(
        `SELECT SUM(verified_count) v, SUM(failed_count) f, SUM(valid_count) va, SUM(invalid_count) iv, SUM(disposable_count) d,
                SUM(catchall_count) c, SUM(unknown_count) u, SUM(reused_count) r,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) cb, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) fb
           FROM bulk_verification_batches WHERE job_id = ?`,
        jobId,
      );
      const job = db.get('SELECT total_eligible FROM bulk_verification_jobs WHERE id = ?', jobId);
      const processed = (s.v || 0) + (s.f || 0);
      db.run(
        `UPDATE bulk_verification_jobs SET verified_count = ?, failed_count = ?, valid_count = ?, invalid_count = ?, disposable_count = ?,
           catchall_count = ?, unknown_count = ?, reused_count = ?, completed_batches = ?, failed_batches = ?, progress_percentage = ?, updated_at = ?
         WHERE id = ?`,
        s.v || 0, s.f || 0, s.va || 0, s.iv || 0, s.d || 0, s.c || 0, s.u || 0, s.r || 0, s.cb || 0, s.fb || 0,
        job.total_eligible ? Math.round((processed / job.total_eligible) * 1000) / 10 : 0, t, jobId,
      );
    });
  }

  // ------------------------------------------------------------------ public API

  return {
    attachRunner(r) {
      runner = r;
    },
    refreshCounters,
    jobView,
    requireJob,

    /** Parse + validate an uploaded CSV and keep it (24 h) until a job is created from it. */
    createImport(ownerId, { filename, content, email_column: requestedColumn }) {
      const name = safeFilename(filename);
      const { fields, rows, headerless } = parseLeadsCsv(content, name);
      db.run("DELETE FROM bulk_verification_imports WHERE job_id IS NULL AND expires_at < ?", now());
      const id = randomUUID();
      const detected = detectEmailColumn(fields, rows);
      const t = new Date();
      db.run(
        `INSERT INTO bulk_verification_imports (id, owner_id, source_filename, columns_json, rows_json, email_column, headerless, total_rows, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ownerId, name, JSON.stringify(fields), JSON.stringify(rows), null, headerless ? 1 : 0, rows.length, t.toISOString(), new Date(t.getTime() + IMPORT_TTL_MS).toISOString(),
      );
      const imp = db.get('SELECT * FROM bulk_verification_imports WHERE id = ?', id);
      const column = checkColumn(imp, requestedColumn) ?? detected;
      db.run('UPDATE bulk_verification_imports SET email_column = ? WHERE id = ?', column, id);
      return importView({ ...imp, email_column: column });
    },

    getImport(ownerId, importId) {
      return importView(requireImport(ownerId, importId));
    },

    /** Manually choose the email column when detection failed (or was wrong). */
    setImportColumn(ownerId, importId, column) {
      const imp = requireImport(ownerId, importId);
      if (imp.job_id) throw new ApiError(409, 'import_used', 'A job was already created from this import.');
      const col = checkColumn(imp, column);
      if (!col) throw new ApiError(422, 'invalid_email_column', 'Choose the column that contains email addresses.', { email_column: ['Required.'] });
      db.run('UPDATE bulk_verification_imports SET email_column = ? WHERE id = ?', col, imp.id);
      return importView({ ...imp, email_column: col });
    },

    /**
     * Create a job (and its batches and leads) from an import, atomically. Idempotent: the same
     * import (or the same client_request_id) never creates a second job.
     * Returns { job, created }.
     */
    createJob(ownerId, body, { requestedMode }) {
      const clientRequestId = body.client_request_id == null ? null : String(body.client_request_id).slice(0, 100);
      if (clientRequestId) {
        const prior = db.get('SELECT * FROM bulk_verification_jobs WHERE owner_id = ? AND client_request_id = ?', ownerId, clientRequestId);
        if (prior) return { job: jobView(prior, { withBatches: true }), created: false };
      }
      const imp = requireImport(ownerId, body.import_id);
      if (imp.job_id) {
        const prior = db.get('SELECT * FROM bulk_verification_jobs WHERE id = ? AND owner_id = ?', imp.job_id, ownerId);
        if (prior) return { job: jobView(prior, { withBatches: true }), created: false };
      }

      const errors = {};
      const emailColumn = checkColumn(imp, body.email_column) ?? imp.email_column;
      if (!emailColumn) errors.email_column = ['Choose the column that contains email addresses.'];
      const batchSize = Number(body.batch_size ?? DEFAULT_BATCH_SIZE);
      if (!BATCH_SIZES.includes(batchSize)) errors.batch_size = [`Choose one of ${BATCH_SIZES.join(', ')}.`];
      if (!body.destination_folder_id) errors.destination_folder_id = ['Select a destination folder.'];
      if (Object.keys(errors).length) throw new ApiError(422, 'validation_failed', 'Please fix the highlighted fields.', errors);

      const dest = folders.find(ownerId, body.destination_folder_id);
      if (!dest) throw new ApiError(422, 'invalid_destination_folder', 'The destination folder does not exist or is not yours.', { destination_folder_id: ['Folder not found.'] });
      if (dest.is_job_folder) throw new ApiError(422, 'invalid_destination_folder', 'Choose one of your folders, not a job output folder.', { destination_folder_id: ['Not allowed.'] });

      // Verification settings: the existing provider + live/mock mode, pinned for the whole job.
      const v = body.verification && typeof body.verification === 'object' ? body.verification : {};
      const provider = v.provider == null || v.provider === '' ? providers.getActive() : String(v.provider).toLowerCase();
      if (!providers.isValid(provider)) throw new ApiError(422, 'unsupported_provider', `Unsupported provider "${String(v.provider).slice(0, 40)}".`, { 'verification.provider': ['Unsupported provider.'] });
      const wantMode = v.mode === 'mock' || v.mode === 'live' ? v.mode : requestedMode;
      const mode = resolveMode(wantMode, provider);
      if (wantMode === 'live' && mode !== 'live') {
        throw new ApiError(409, 'provider_not_configured', `${PROVIDER_NAMES[provider]} has no API key on the server. Choose Mock mode or configure the provider.`);
      }

      const rows = JSON.parse(imp.rows_json);
      const { leads, summary } = classifyRows(rows, emailColumn);
      if (summary.eligible === 0) {
        throw new ApiError(422, 'no_eligible_leads', 'No row in this file has a valid email address, so there is nothing to verify.');
      }
      const plan = planBatches(summary.eligible, batchSize);
      const jobName = cleanJobName(body.job_name) || defaultJobName(imp.source_filename);
      const startNow = body.start !== false;
      const columns = JSON.parse(imp.columns_json);

      const jobId = randomUUID();
      const t = now();
      db.tx(() => {
        const jobFolder = folders.createJobFolder(ownerId, dest.id);
        db.run(
          `INSERT INTO bulk_verification_jobs (id, owner_id, import_id, client_request_id, job_name, source_filename, destination_folder_id, job_folder_id,
             email_column, columns_json, total_imported, total_eligible, total_duplicates, total_empty, total_invalid_format, batch_size, total_batches,
             status, configuration_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          jobId, ownerId, imp.id, clientRequestId, jobName, imp.source_filename, dest.id, jobFolder.id, emailColumn, JSON.stringify(columns),
          summary.total_imported, summary.eligible, summary.duplicates, summary.empty, summary.invalid_format, plan.batch_size, plan.total_batches,
          startNow ? 'queued' : 'draft',
          JSON.stringify({ provider, mode, registry: registryEnabled && mode === 'live', requested_batch_size: batchSize }),
          t, t,
        );
        const batchIds = plan.batches.map((size, i) => {
          const id = randomUUID();
          db.run(
            `INSERT INTO bulk_verification_batches (id, job_id, batch_number, total_emails, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            id, jobId, i + 1, size, t, t,
          );
          return id;
        });
        let eligibleIndex = 0;
        for (const l of leads) {
          const eligible = l.eligibility === 'eligible';
          const batchId = eligible ? batchIds[Math.floor(eligibleIndex++ / plan.batch_size)] : null;
          db.run(
            `INSERT INTO bulk_verification_job_leads (job_id, batch_id, original_row_number, email, normalized_email, original_data_json, eligibility,
               duplicate_of_row, processing_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            jobId, batchId, l.row_number, l.email, l.normalized_email, JSON.stringify(l.data), l.eligibility, l.duplicate_of_row,
            eligible ? 'pending' : 'skipped', t, t,
          );
        }
        db.run('UPDATE bulk_verification_imports SET job_id = ?, rows_json = ? WHERE id = ?', jobId, '[]', imp.id); // rows now live in leads
      });

      logger.info?.(`[bulk] job ${jobId} created: ${summary.eligible} eligible leads in ${plan.total_batches} batch(es) of ${plan.batch_size}, ${provider}/${mode}`);
      if (startNow) runner?.enqueue(jobId);
      return { job: jobView(db.get('SELECT * FROM bulk_verification_jobs WHERE id = ?', jobId), { withBatches: true }), created: true };
    },

    list(ownerId, q = {}) {
      const where = ['owner_id = ?'];
      const params = [ownerId];
      if (q.status) {
        const statuses = String(q.status).split(',').filter((s) => JOB_STATUSES.includes(s));
        if (!statuses.length) throw new ApiError(422, 'invalid_status', 'Unknown status filter.');
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
      if (q.search) {
        where.push("(job_name LIKE ? ESCAPE '!' OR source_filename LIKE ? ESCAPE '!')");
        const s = `%${String(q.search).slice(0, 100).replace(/[!%_]/g, (c) => `!${c}`)}%`;
        params.push(s, s);
      }
      for (const [k, op] of [['from', '>='], ['to', '<=']]) {
        if (!q[k]) continue;
        const d = Date.parse(q[k]);
        if (!Number.isFinite(d)) throw new ApiError(422, 'invalid_date', `"${k}" is not a valid date.`);
        where.push(`created_at ${op} ?`);
        params.push(new Date(k === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(q[k]) ? d + 86_399_999 : d).toISOString());
      }
      const sortCols = { created_at: 'created_at', job_name: 'lower(job_name)', status: 'status', total_eligible: 'total_eligible', progress: 'progress_percentage' };
      const sort = sortCols[q.sort] || 'created_at';
      const dir = q.direction === 'asc' ? 'ASC' : 'DESC';
      const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit, 10) || 20));
      const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
      const total = db.get(`SELECT COUNT(*) n FROM bulk_verification_jobs WHERE ${where.join(' AND ')}`, ...params).n;
      const rows = db.all(
        `SELECT * FROM bulk_verification_jobs WHERE ${where.join(' AND ')} ORDER BY ${sort} ${dir}, id ${dir} LIMIT ? OFFSET ?`,
        ...params, limit, (page - 1) * limit,
      );
      const o = db.get(
        `SELECT COUNT(*) total,
           SUM(CASE WHEN status IN ('completed','completed_with_errors') THEN 1 ELSE 0 END) completed,
           SUM(CASE WHEN status IN ('queued','processing','pausing','cancelling') THEN 1 ELSE 0 END) processing,
           SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) paused,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed
         FROM bulk_verification_jobs WHERE owner_id = ?`,
        ownerId,
      );
      return {
        jobs: rows.map((j) => jobView(j)),
        meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
        overview: { total: o.total || 0, completed: o.completed || 0, processing: o.processing || 0, paused: o.paused || 0, failed: o.failed || 0 },
      };
    },

    detail(ownerId, jobId) {
      return jobView(requireJob(ownerId, jobId), { withBatches: true });
    },

    /** Batch + (paginated) per-lead results for "View results". */
    batchDetail(ownerId, jobId, batchId, { page = 1, limit = 100 } = {}) {
      const job = requireJob(ownerId, jobId);
      const b = requireBatch(job, batchId);
      const lim = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
      const pg = Math.max(1, Number.parseInt(page, 10) || 1);
      const leads = db.all(
        'SELECT * FROM bulk_verification_job_leads WHERE batch_id = ? ORDER BY original_row_number LIMIT ? OFFSET ?',
        b.id, lim, (pg - 1) * lim,
      );
      return {
        batch: batchView(b, runner?.liveProgress()),
        results: leads.map((l) => {
          const r = l.verification_result_json ? JSON.parse(l.verification_result_json) : null;
          return {
            row_number: l.original_row_number,
            email: l.email,
            processing_status: l.processing_status,
            verification_status: l.verification_status,
            flags: r?.flags || [],
            suggested_correction: r?.suggestedCorrection || '',
            from_registry: Boolean(r?.cached),
            note: r?.note || null,
            error_message: l.error_message,
            verified_at: l.verified_at,
          };
        }),
        meta: { current_page: pg, per_page: lim, total: b.total_emails, last_page: Math.max(1, Math.ceil(b.total_emails / lim)) },
      };
    },

    start(ownerId, jobId) {
      const job = requireJob(ownerId, jobId);
      if (ACTIVE_STATUSES.includes(job.status)) return jobView(job, { withBatches: true }); // idempotent
      if (job.status !== 'draft') throw new ApiError(409, 'invalid_transition', `A ${job.status.replace(/_/g, ' ')} job cannot be started.`);
      db.run("UPDATE bulk_verification_jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'draft'", now(), job.id);
      runner?.enqueue(job.id);
      return jobView(requireJob(ownerId, jobId), { withBatches: true });
    },

    pause(ownerId, jobId) {
      const job = requireJob(ownerId, jobId);
      if (job.status === 'paused' || job.status === 'pausing') return jobView(job, { withBatches: true });
      if (!['queued', 'processing'].includes(job.status)) throw new ApiError(409, 'invalid_transition', `A ${job.status.replace(/_/g, ' ')} job cannot be paused.`);
      // A running batch is allowed to finish and save; the runner then stops at that safe point.
      const next = runner?.isActive(job.id) ? 'pausing' : 'paused';
      db.run('UPDATE bulk_verification_jobs SET status = ?, pause_requested = ?, updated_at = ? WHERE id = ?', next, next === 'pausing' ? 1 : 0, now(), job.id);
      return jobView(requireJob(ownerId, jobId), { withBatches: true });
    },

    resume(ownerId, jobId) {
      const job = requireJob(ownerId, jobId);
      if (['queued', 'processing'].includes(job.status)) return jobView(job, { withBatches: true });
      if (job.status === 'pausing') {
        // Pause not reached yet: just withdraw the request.
        db.run("UPDATE bulk_verification_jobs SET status = 'processing', pause_requested = 0, updated_at = ? WHERE id = ?", now(), job.id);
        return jobView(requireJob(ownerId, jobId), { withBatches: true });
      }
      if (!['paused', 'failed'].includes(job.status)) throw new ApiError(409, 'invalid_transition', `A ${job.status.replace(/_/g, ' ')} job cannot be resumed.`);
      db.tx(() => {
        // Failed batches are retried from their unfinished records; completed records are kept.
        for (const b of db.all("SELECT * FROM bulk_verification_batches WHERE job_id = ? AND status = 'failed'", job.id)) {
          if (b.retry_count >= MAX_BATCH_RETRIES) throw new ApiError(409, 'retry_limit_reached', `Batch ${b.batch_number} has been retried ${MAX_BATCH_RETRIES} times; it cannot be retried again.`);
          db.run("UPDATE bulk_verification_job_leads SET processing_status = 'pending', error_message = NULL, updated_at = ? WHERE batch_id = ? AND processing_status = 'failed'", now(), b.id);
          db.run("UPDATE bulk_verification_batches SET status = 'retrying', retry_count = retry_count + 1, error_kind = NULL, error_message = NULL, updated_at = ? WHERE id = ?", now(), b.id);
        }
        db.run(
          "UPDATE bulk_verification_jobs SET status = 'queued', pause_requested = 0, error_message = NULL, retry_count = retry_count + ?, updated_at = ? WHERE id = ?",
          job.status === 'failed' ? 1 : 0, now(), job.id,
        );
      });
      refreshCounters(job.id);
      runner?.enqueue(job.id);
      return jobView(requireJob(ownerId, jobId), { withBatches: true });
    },

    async cancel(ownerId, jobId) {
      const job = requireJob(ownerId, jobId);
      if (job.status === 'cancelled' || job.status === 'cancelling') return jobView(job, { withBatches: true });
      if (TERMINAL.includes(job.status)) throw new ApiError(409, 'invalid_transition', `A ${job.status.replace(/_/g, ' ')} job cannot be cancelled.`);
      if (runner?.isActive(job.id)) {
        // The running batch finishes and is saved (its credits are already spent), then the rest is cancelled.
        db.run("UPDATE bulk_verification_jobs SET status = 'cancelling', cancel_requested = 1, updated_at = ? WHERE id = ?", now(), job.id);
      } else {
        await runner?.finalizeCancel(job.id);
      }
      return jobView(requireJob(ownerId, jobId), { withBatches: true });
    },

    retryBatch(ownerId, jobId, batchId) {
      const job = requireJob(ownerId, jobId);
      const b = requireBatch(job, batchId);
      if (['cancelled', 'cancelling'].includes(job.status)) throw new ApiError(409, 'invalid_transition', 'Batches of a cancelled job cannot be retried.');
      if (b.status === 'retrying' || (b.status === 'pending' && ACTIVE_STATUSES.includes(job.status))) return jobView(job, { withBatches: true }); // repeated click
      if (!canRetryBatch(b)) {
        if (b.retry_count >= MAX_BATCH_RETRIES) throw new ApiError(409, 'retry_limit_reached', `This batch has been retried ${MAX_BATCH_RETRIES} times; it cannot be retried again.`);
        throw new ApiError(409, 'nothing_to_retry', 'Only failed batches, or completed batches with failed records, can be retried.');
      }
      db.tx(() => {
        const t = now();
        db.run("UPDATE bulk_verification_job_leads SET processing_status = 'pending', error_message = NULL, updated_at = ? WHERE batch_id = ? AND processing_status = 'failed'", t, b.id);
        db.run("UPDATE bulk_verification_batches SET status = 'retrying', retry_count = retry_count + 1, error_kind = NULL, error_message = NULL, completed_at = NULL, updated_at = ? WHERE id = ?", t, b.id);
        if (!ACTIVE_STATUSES.includes(job.status)) {
          db.run(
            "UPDATE bulk_verification_jobs SET status = 'queued', pause_requested = 0, error_message = NULL, completed_at = NULL, retry_count = retry_count + 1, updated_at = ? WHERE id = ?",
            t, job.id,
          );
        }
      });
      refreshCounters(job.id);
      runner?.enqueue(job.id);
      return jobView(requireJob(ownerId, jobId), { withBatches: true });
    },

    /** File record for a download, after ownership checks. */
    batchFile(ownerId, jobId, batchId) {
      const job = requireJob(ownerId, jobId);
      const b = requireBatch(job, batchId);
      const f = b.output_file_id && db.get('SELECT * FROM verification_files WHERE id = ? AND owner_id = ?', b.output_file_id, ownerId);
      if (!f) throw new ApiError(409, 'file_not_ready', 'This batch has no saved results yet.');
      return f;
    },

    jobFile(ownerId, jobId) {
      const job = requireJob(ownerId, jobId);
      const f = db.get("SELECT * FROM verification_files WHERE job_id = ? AND owner_id = ? AND kind = 'all_results'", job.id, ownerId);
      if (!f) throw new ApiError(409, 'file_not_ready', 'The complete results file is created when the job finishes. Download individual batches until then.');
      return f;
    },

    fileById(ownerId, fileId) {
      const f = typeof fileId === 'string' ? db.get('SELECT * FROM verification_files WHERE id = ? AND owner_id = ?', fileId, ownerId) : null;
      if (!f) throw new ApiError(404, 'file_not_found', 'File not found.');
      return f;
    },
  };
}
