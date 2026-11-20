/**
 * HTTP API for Bulk Verification Jobs and verification folders/files.
 *
 * Every route resolves the caller's owner id first (resolveOwner) and every lookup is scoped to
 * it, so one owner can never see, change or download another owner's jobs, folders or files.
 * Responses follow this app's conventions: { success: true, ... } and, for errors,
 * { success: false, error: { code, message, details? } } (rendered by the app's error handler).
 */
import express from 'express';
import { ApiError } from '../errors.js';
import { BATCH_SIZES, planBatches } from './importer.js';

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createBulkRouter({ jobs, folders, storage, resolveOwner, limiter, requestedMode }) {
  const r = express.Router();

  r.use((req, res, next) => {
    const owner = resolveOwner(req);
    if (!owner) return next(new ApiError(401, 'unauthenticated', 'Sign in to use bulk verification.'));
    req.ownerId = String(owner);
    next();
  });
  if (limiter) r.use(limiter);

  async function sendFile(res, file, downloadName) {
    if (!(await storage.exists(file.storage_key))) {
      throw new ApiError(410, 'file_missing', 'The file is no longer available in storage. Retry the batch to regenerate it.');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition(downloadName));
    res.setHeader('Content-Length', String(file.size_bytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await new Promise((resolve, reject) => {
      const s = storage.stream(file.storage_key);
      s.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      s.pipe(res);
    });
  }
  const jobFileName = (jobId, ownerId, fileName) => {
    const job = jobs.requireJob(ownerId, jobId);
    const base = job.job_name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    return `${base}_${fileName}`;
  };

  // ------------------------------------------------------------ folders & files

  r.get('/verification-folders', (req, res) => {
    const includeJobFolders = req.query.include_job_folders !== 'false';
    res.json({ success: true, folders: folders.list(req.ownerId, { includeJobFolders }) });
  });

  r.post('/verification-folders', (req, res) => {
    const folder = folders.create(req.ownerId, req.body || {});
    res.status(201).json({ success: true, message: 'Folder created.', folder });
  });

  r.get('/verification-folders/:id', (req, res) => {
    res.json({ success: true, ...folders.detail(req.ownerId, req.params.id) });
  });

  r.delete('/verification-folders/:id', (req, res) => {
    folders.remove(req.ownerId, req.params.id);
    res.json({ success: true, message: 'Folder deleted.' });
  });

  r.get(
    '/verification-files/:id/download',
    asyncRoute(async (req, res) => {
      const f = jobs.fileById(req.ownerId, req.params.id);
      await sendFile(res, f, f.job_id ? jobFileName(f.job_id, req.ownerId, f.file_name) : f.file_name);
    }),
  );

  // ------------------------------------------------------------ import

  r.post('/bulk-verification/import', (req, res) => {
    const b = req.body || {};
    const imp = jobs.createImport(req.ownerId, { filename: b.filename, content: b.content, email_column: b.email_column });
    res.status(201).json({ success: true, import: imp });
  });

  r.get('/bulk-verification/imports/:id', (req, res) => {
    res.json({ success: true, import: jobs.getImport(req.ownerId, req.params.id) });
  });

  r.put('/bulk-verification/imports/:id', (req, res) => {
    res.json({ success: true, import: jobs.setImportColumn(req.ownerId, req.params.id, req.body?.email_column) });
  });

  /** Batch calculation (also included in the import response as batch_plans). */
  r.get('/bulk-verification/plan', (req, res) => {
    const eligible = Number.parseInt(req.query.eligible, 10);
    const size = Number.parseInt(req.query.batch_size, 10);
    if (!Number.isInteger(eligible) || eligible < 0 || eligible > 1000) throw new ApiError(422, 'invalid_eligible', '"eligible" must be between 0 and 1,000.');
    if (!BATCH_SIZES.includes(size)) throw new ApiError(422, 'invalid_batch_size', `"batch_size" must be one of ${BATCH_SIZES.join(', ')}.`);
    res.json({ success: true, plan: planBatches(eligible, size) });
  });

  // ------------------------------------------------------------ jobs

  r.post('/bulk-verification/jobs', (req, res) => {
    const { job, created } = jobs.createJob(req.ownerId, req.body || {}, { requestedMode: requestedMode(req) });
    res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Bulk verification job created.' : 'This job was already created.',
      duplicate: !created,
      job,
    });
  });

  r.get('/bulk-verification/jobs', (req, res) => {
    const pick = (k) => (typeof req.query[k] === 'string' ? req.query[k] : undefined);
    res.json({
      success: true,
      ...jobs.list(req.ownerId, {
        page: pick('page'), limit: pick('limit'), search: pick('search'), status: pick('status'),
        from: pick('from'), to: pick('to'), sort: pick('sort'), direction: pick('direction'),
      }),
    });
  });

  r.get('/bulk-verification/jobs/:id', (req, res) => {
    res.json({ success: true, job: jobs.detail(req.ownerId, req.params.id) });
  });

  /** Polled by the job page while the job is active (this app has no websocket/SSE layer). */
  r.get('/bulk-verification/jobs/:id/progress', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, job: jobs.detail(req.ownerId, req.params.id) });
  });

  r.get('/bulk-verification/jobs/:id/batches/:batchId', (req, res) => {
    res.json({ success: true, ...jobs.batchDetail(req.ownerId, req.params.id, req.params.batchId, { page: req.query.page, limit: req.query.limit }) });
  });

  r.post('/bulk-verification/jobs/:id/start', (req, res) => res.json({ success: true, message: 'Job started.', job: jobs.start(req.ownerId, req.params.id) }));
  r.post('/bulk-verification/jobs/:id/pause', (req, res) => res.json({ success: true, message: 'Pause requested.', job: jobs.pause(req.ownerId, req.params.id) }));
  r.post('/bulk-verification/jobs/:id/resume', (req, res) => res.json({ success: true, message: 'Job resumed.', job: jobs.resume(req.ownerId, req.params.id) }));
  r.post(
    '/bulk-verification/jobs/:id/cancel',
    asyncRoute(async (req, res) => res.json({ success: true, message: 'Cancel requested.', job: await jobs.cancel(req.ownerId, req.params.id) })),
  );
  r.post('/bulk-verification/jobs/:id/batches/:batchId/retry', (req, res) => {
    res.json({ success: true, message: 'Batch queued for retry.', job: jobs.retryBatch(req.ownerId, req.params.id, req.params.batchId) });
  });

  r.get(
    '/bulk-verification/jobs/:id/batches/:batchId/download',
    asyncRoute(async (req, res) => {
      const f = jobs.batchFile(req.ownerId, req.params.id, req.params.batchId);
      await sendFile(res, f, jobFileName(req.params.id, req.ownerId, f.file_name));
    }),
  );

  r.get(
    '/bulk-verification/jobs/:id/download',
    asyncRoute(async (req, res) => {
      const f = jobs.jobFile(req.ownerId, req.params.id);
      await sendFile(res, f, jobFileName(req.params.id, req.ownerId, f.file_name));
    }),
  );

  return r;
}
