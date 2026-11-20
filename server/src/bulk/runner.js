/**
 * Background processor for Bulk Verification Jobs.
 *
 * For each job, batches run strictly one after another:
 *   claim batch -> verify its pending leads with the EXISTING engine (central.createBulkJob:
 *   registry lookup/reuse, provider bulk job, registry saves, rate limits) -> persist every
 *   lead's result in one transaction -> export batch_NNN_verified.csv to the job folder
 *   (atomic + verified) -> mark the batch completed -> next batch.
 * A batch is never marked completed before its results are persisted AND its file is saved,
 * and the next batch never starts before that.
 *
 * Reliability:
 *  - State lives in SQLite; on startup recover() re-queues every active job. A batch that was
 *    in flight is re-attached to its provider job (provider_job_ref) instead of re-submitted,
 *    so nothing is paid for twice; leads that already have results are never re-verified.
 *  - Batches are claimed with an atomic UPDATE carrying this process's lease id; a job runs in
 *    at most one loop at a time.
 *  - Transient failures (network, registry unavailable, provider 429/5xx, lost engine job) are
 *    retried with backoff; permanent ones (e.g. no credits, bad key) fail the batch and stop the
 *    job, which the user can resume / retry.
 *  - BULK_MAX_CONCURRENT_JOBS (default 1) limits how many jobs verify at once, on top of the
 *    engine's own provider protections.
 */
import { randomUUID } from 'node:crypto';
import { availableFlagsFor } from '../services/registryMapping.js';
import { normalizeEmail } from './importer.js';

const DEFAULTS = {
  pollMs: 3_000,
  maxConcurrentJobs: 1,
  verifyAttempts: 3,
  verifyBackoffMs: [10_000, 30_000, 90_000],
  exportAttempts: 3,
  exportBackoffMs: [1_000, 3_000, 9_000],
  maxPollErrors: 5,
};

const TRANSIENT_CODES = new Set(['registry_unavailable', 'registry_rate_limited', 'network_error', 'rate_limited', 'temp_unavailable', 'job_not_found', 'provider_job_failed']);

/** Which kind of failure this is, and whether retrying can help. */
export function classifyError(err) {
  const code = err?.code;
  const status = err?.status;
  if (code === 'export_verify_failed' || code === 'export_row_mismatch' || ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EROFS', 'EMFILE'].includes(code)) {
    return { kind: 'storage', transient: true };
  }
  if (code === 'job_not_found') return { kind: 'queue', transient: true };
  if (code === 'registry_unavailable' || code === 'registry_rate_limited' || code === 'network_error' || err?.name === 'TypeError' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return { kind: 'network', transient: true };
  }
  if (TRANSIENT_CODES.has(code) || status === 429 || (status >= 500 && status < 600)) return { kind: 'provider', transient: true };
  if (status >= 400 && status < 500) return { kind: 'provider', transient: false };
  return { kind: 'verification', transient: false };
}

const humanKind = { storage: 'Saving the results file failed', queue: 'The verification task was lost', network: 'A network error occurred', provider: 'The verification provider returned an error', verification: 'Verification failed' };

export function createBulkRunner({ db, jobs, central, providers, exporter, options = {}, logger = console }) {
  const T = { ...DEFAULTS, ...options };
  const instanceId = randomUUID();
  const queue = [];
  const running = new Map(); // jobId -> Promise
  const live = new Map(); // batchId -> { processed, stage }
  let stopped = false;
  const now = () => new Date().toISOString();

  const getJob = (id) => db.get('SELECT * FROM bulk_verification_jobs WHERE id = ?', id);
  const getBatch = (id) => db.get('SELECT * FROM bulk_verification_batches WHERE id = ?', id);

  /** Sleep that wakes early when the job is cancelled or the runner stops. */
  async function wait(ms, jobId) {
    const end = Date.now() + ms;
    while (!stopped && Date.now() < end) {
      if (jobId && getJob(jobId)?.cancel_requested) return;
      await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
    }
  }

  function enqueue(jobId) {
    if (stopped || running.has(jobId) || queue.includes(jobId)) return;
    queue.push(jobId);
    pump();
  }

  function pump() {
    while (!stopped && running.size < T.maxConcurrentJobs && queue.length) {
      const id = queue.shift();
      const p = runJob(id)
        .catch((err) => logger.error?.(`[bulk] job ${id} crashed: ${err.stack || err.message}`))
        .finally(() => {
          running.delete(id);
          pump();
        });
      running.set(id, p);
    }
  }

  // ---------------------------------------------------------------- job loop

  async function runJob(jobId) {
    for (;;) {
      if (stopped) return;
      const job = getJob(jobId);
      if (!job) return;
      if (job.cancel_requested || job.status === 'cancelling') return finalizeCancel(jobId);
      if (job.pause_requested || job.status === 'pausing') {
        db.run("UPDATE bulk_verification_jobs SET status = 'paused', pause_requested = 0, updated_at = ? WHERE id = ?", now(), jobId);
        logger.info?.(`[bulk] job ${jobId} paused`);
        return;
      }
      if (!['queued', 'processing'].includes(job.status)) return; // draft / paused / failed / finished
      if (job.status === 'queued') {
        db.run("UPDATE bulk_verification_jobs SET status = 'processing', started_at = COALESCE(started_at, ?), completed_at = NULL, updated_at = ? WHERE id = ?", now(), now(), jobId);
      }

      // Lowest-numbered batch that still needs work. 'processing'/'saving' here are leftovers of a
      // previous process (this loop never leaves a batch in those states).
      const batch = db.get(
        `SELECT * FROM bulk_verification_batches WHERE job_id = ? AND status IN ('pending','retrying','processing','saving')
         ORDER BY batch_number LIMIT 1`,
        jobId,
      );
      if (!batch) return finalizeJob(jobId);

      const claimed = db.run(
        `UPDATE bulk_verification_batches SET status = 'processing', lease_owner = ?, attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND (status IN ('pending','retrying') OR (status IN ('processing','saving') AND IFNULL(lease_owner, '') != ?))`,
        instanceId, now(), now(), batch.id, instanceId,
      );
      if (claimed.changes !== 1) {
        logger.warn?.(`[bulk] batch ${batch.id} could not be claimed; stopping this loop`);
        return;
      }

      const ok = await processBatch(getJob(jobId), getBatch(batch.id));
      if (!ok) return; // batch failed permanently: job is marked failed (resumable)
    }
  }

  async function processBatch(job, batch) {
    const started = Date.now();
    const label = `job ${job.id} batch ${batch.batch_number}/${job.total_batches}`;
    logger.info?.(`[bulk] ${label}: processing`);

    // 1-2. Verify pending leads (with retries for transient failures) and persist results.
    let attempt = 0;
    for (;;) {
      const pending = db.all("SELECT * FROM bulk_verification_job_leads WHERE batch_id = ? AND processing_status = 'pending' ORDER BY original_row_number", batch.id);
      if (!pending.length) break;
      attempt += 1;
      try {
        await verifyLeads(job, getBatch(batch.id), pending);
        break;
      } catch (err) {
        // Shutting down: leave the batch as it is; recover() picks it up on the next start.
        if (stopped) return false;
        const { kind, transient } = classifyError(err);
        const msg = `${humanKind[kind]}: ${err.message}`.slice(0, 500);
        logger.warn?.(`[bulk] ${label}: attempt ${attempt} failed (${kind}${transient ? ', transient' : ''}): ${err.message}`);
        db.run('UPDATE bulk_verification_batches SET error_kind = ?, error_message = ?, updated_at = ? WHERE id = ?', kind, msg, now(), batch.id);
        if (!transient || attempt >= T.verifyAttempts) return failBatch(job, batch, kind, msg);
        await wait(T.verifyBackoffMs[Math.min(attempt - 1, T.verifyBackoffMs.length - 1)], job.id);
        if (stopped) return false;
        if (getJob(job.id)?.cancel_requested) return finalizeCancel(job.id).then(() => false);
      } finally {
        live.delete(batch.id);
      }
    }
    jobs.refreshCounters(job.id);

    // 3. Save the batch file. Never mark the batch complete unless the file was written and verified.
    db.run("UPDATE bulk_verification_batches SET status = 'saving', updated_at = ? WHERE id = ?", now(), batch.id);
    let fileId = null;
    for (let i = 1; i <= T.exportAttempts; i++) {
      try {
        fileId = await exporter.exportBatch(getJob(job.id), getBatch(batch.id));
        break;
      } catch (err) {
        if (stopped) return false; // stays 'saving'; recovery re-exports (results are already persisted)
        logger.warn?.(`[bulk] ${label}: export attempt ${i} failed: ${err.message}`);
        if (i === T.exportAttempts) {
          return failBatch(job, batch, 'storage', `Saving the results file failed: ${err.message}`.slice(0, 500));
        }
        await wait(T.exportBackoffMs[Math.min(i - 1, T.exportBackoffMs.length - 1)]);
      }
    }

    // 4. Completed.
    const t = now();
    db.run(
      `UPDATE bulk_verification_batches SET status = 'completed', output_file_id = ?, error_kind = NULL, error_message = NULL, lease_owner = NULL,
         completed_at = ?, duration_ms = COALESCE(duration_ms, 0) + ?, updated_at = ? WHERE id = ?`,
      fileId, t, Date.now() - started, t, batch.id,
    );
    jobs.refreshCounters(job.id);
    logger.info?.(`[bulk] ${label}: completed and saved`);
    return true;
  }

  function failBatch(job, batch, kind, message) {
    const t = now();
    db.tx(() => {
      db.run(
        "UPDATE bulk_verification_batches SET status = 'failed', error_kind = ?, error_message = ?, lease_owner = NULL, updated_at = ? WHERE id = ?",
        kind, message, t, batch.id,
      );
      db.run(
        "UPDATE bulk_verification_jobs SET status = 'failed', error_message = ?, pause_requested = 0, updated_at = ? WHERE id = ? AND status NOT IN ('cancelling','cancelled')",
        `Batch ${batch.batch_number} failed. ${message}`.slice(0, 600), t, job.id,
      );
    });
    jobs.refreshCounters(job.id);
    logger.error?.(`[bulk] job ${job.id} batch ${batch.batch_number} failed (${kind}): ${message}`);
    // A cancel requested meanwhile still completes.
    if (getJob(job.id)?.cancel_requested) return finalizeCancel(job.id).then(() => false);
    return false;
  }

  /** Run the pending leads through the existing verification engine and persist the results. */
  async function verifyLeads(job, batch, pending) {
    const conf = JSON.parse(job.configuration_json);
    if (conf.mode === 'live' && !providers.isConfigured(conf.provider)) {
      throw Object.assign(new Error(`${conf.provider} is no longer configured on the server.`), { status: 409, code: 'provider_not_configured' });
    }
    const rows = pending.map((l, i) => ({ id: String(i), email: l.email }));
    let engine;
    if (batch.provider_job_ref && conf.mode === 'live') {
      // Re-attach to the provider job this batch already submitted (e.g. before a restart).
      engine = await central.resumeBulkJob({ provider: conf.provider, rawId: batch.provider_job_ref, rows, source: 'csv_import' });
      logger.info?.(`[bulk] job ${job.id} batch ${batch.batch_number}: re-attached to provider job ${batch.provider_job_ref}`);
    } else {
      const filename = `${job.job_name}_batch_${String(batch.batch_number).padStart(3, '0')}.csv`.slice(0, 120);
      engine = await central.createBulkJob(rows, filename, conf.mode, { source: 'csv_import', provider: conf.provider });
    }
    db.run(
      'UPDATE bulk_verification_batches SET engine_job_id = ?, provider_job_ref = ?, provider = ?, updated_at = ? WHERE id = ?',
      engine.jobId, engine.providerJobRef ?? null, engine.provider ?? conf.provider, now(), batch.id,
    );

    // Poll the engine (in-memory for registry-backed jobs) until it finishes.
    live.set(batch.id, { processed: 0, stage: 'queued' });
    let pollErrors = 0;
    for (;;) {
      if (stopped) throw Object.assign(new Error('The server is shutting down.'), { code: 'job_not_found' });
      let s;
      try {
        s = await central.bulkStatus(engine.jobId);
        pollErrors = 0;
      } catch (err) {
        pollErrors += 1;
        if (err.code === 'job_not_found' || pollErrors >= T.maxPollErrors) throw err;
        await wait(T.pollMs * 2 ** pollErrors);
        continue;
      }
      live.set(batch.id, { processed: Math.min(pending.length, s.processed ?? Math.round(((s.percent || 0) / 100) * pending.length)), stage: s.stage });
      if (s.stage === 'failed') throw Object.assign(new Error(s.failureReason || 'The provider reported that the verification job failed.'), { code: 'provider_job_failed' });
      if (s.stage === 'complete') break;
      await wait(T.pollMs);
    }
    const out = await central.bulkResults(engine.jobId);
    persistResults(job, batch, pending, out.results || [], conf);
  }

  function persistResults(job, batch, pending, results, conf) {
    const byEmail = new Map(results.map((r) => [normalizeEmail(r.email), r]));
    const t = now();
    db.tx(() => {
      for (const lead of pending) {
        const r = byEmail.get(lead.normalized_email);
        // The engine reports emails it could not finish as result "unknown" with a note.
        const unfinished = !r || (r.note && r.result === 'unknown' && !r.cached);
        if (unfinished) {
          db.run(
            "UPDATE bulk_verification_job_leads SET processing_status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
            (r?.note || 'No result was returned for this email.').slice(0, 300), t, lead.id,
          );
          continue;
        }
        const provider = r.provider || conf.provider;
        const result = {
          result: r.result,
          flags: r.flags || [],
          availableFlags: availableFlagsFor(provider),
          suggestedCorrection: r.suggestedCorrection || '',
          provider,
          cached: Boolean(r.cached),
          note: r.note || null,
          mode: conf.mode,
        };
        db.run(
          `UPDATE bulk_verification_job_leads SET processing_status = 'completed', verification_status = ?, verification_result_json = ?,
             verified_at = ?, error_message = NULL, updated_at = ? WHERE id = ?`,
          r.result, JSON.stringify(result), r.verifiedAt || t, t, lead.id,
        );
      }
      db.run('UPDATE bulk_verification_batches SET provider_job_ref = NULL, engine_job_id = NULL, updated_at = ? WHERE id = ?', t, batch.id);
    });
  }

  // ---------------------------------------------------------------- finishing

  async function exportFinal(job) {
    for (let i = 1; i <= T.exportAttempts; i++) {
      try {
        await exporter.exportAllResults(job);
        await exporter.exportSummary(job);
        return null;
      } catch (err) {
        logger.warn?.(`[bulk] job ${job.id}: final export attempt ${i} failed: ${err.message}`);
        if (i === T.exportAttempts) return err;
        await wait(T.exportBackoffMs[Math.min(i - 1, T.exportBackoffMs.length - 1)]);
      }
    }
    return null;
  }

  async function finalizeJob(jobId) {
    jobs.refreshCounters(jobId);
    const job = getJob(jobId);
    const final = job.failed_count > 0 ? 'completed_with_errors' : 'completed';
    const completedAt = now();
    // The summary is generated with the final values; the status flips only once it is saved.
    const err = await exportFinal({ ...job, status: final, completed_at: completedAt });
    if (err) {
      db.run(
        "UPDATE bulk_verification_jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
        `All batches finished, but saving the final summary failed: ${err.message}`.slice(0, 600), now(), jobId,
      );
      return;
    }
    db.run(
      'UPDATE bulk_verification_jobs SET status = ?, completed_at = ?, progress_percentage = 100, pause_requested = 0, updated_at = ? WHERE id = ?',
      final, completedAt, now(), jobId,
    );
    logger.info?.(`[bulk] job ${jobId} ${final}`);
  }

  /** Cancel what has not started; keep every completed result and saved file. */
  async function finalizeCancel(jobId) {
    const t = now();
    db.run(
      "UPDATE bulk_verification_batches SET status = 'cancelled', lease_owner = NULL, updated_at = ? WHERE job_id = ? AND status IN ('pending','retrying','failed','processing','saving')",
      t, jobId,
    );
    jobs.refreshCounters(jobId);
    const job = getJob(jobId);
    // Save the partial results + summary first, so the files exist once the job reads "cancelled".
    if (job.verified_count > 0 || job.failed_count > 0) {
      const err = await exportFinal({ ...job, status: 'cancelled', completed_at: t });
      if (err) logger.warn?.(`[bulk] job ${jobId}: cancelled, but the partial summary could not be saved: ${err.message}`);
    }
    db.run(
      "UPDATE bulk_verification_jobs SET status = 'cancelled', cancel_requested = 0, pause_requested = 0, completed_at = ?, updated_at = ? WHERE id = ?",
      t, now(), jobId,
    );
    logger.info?.(`[bulk] job ${jobId} cancelled`);
  }

  // ---------------------------------------------------------------- recovery

  /** After a (re)start: resume every job that was active when the process stopped. */
  function recover() {
    const active = db.all("SELECT id, status FROM bulk_verification_jobs WHERE status IN ('queued','processing','pausing','cancelling') ORDER BY created_at");
    for (const j of active) {
      const inFlight = db.get(
        "SELECT batch_number, status, provider_job_ref FROM bulk_verification_batches WHERE job_id = ? AND status IN ('processing','saving') AND IFNULL(lease_owner,'') != ?",
        j.id, instanceId,
      );
      if (inFlight) {
        logger.info?.(
          `[bulk] recovering job ${j.id}: batch ${inFlight.batch_number} was ${inFlight.status}${inFlight.provider_job_ref ? ` (provider job ${inFlight.provider_job_ref} will be re-attached)` : ''}`,
        );
      } else {
        logger.info?.(`[bulk] recovering job ${j.id} (${j.status})`);
      }
      enqueue(j.id);
    }
    return active.length;
  }

  return {
    instanceId,
    enqueue,
    recover,
    finalizeCancel,
    isActive: (jobId) => running.has(jobId),
    /** Map(batchId -> { processed, stage }) for batches being verified right now. */
    liveProgress: () => live,
    /** Resolves when no job is running or queued (tests). */
    async idle() {
      while (running.size || queue.length) await Promise.all([...running.values()]);
    },
    /** Stop scheduling; running loops exit at their next check (state stays resumable in the DB). */
    async stop() {
      stopped = true;
      queue.length = 0;
      await Promise.allSettled([...running.values()]);
    },
  };
}
