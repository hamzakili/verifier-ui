/**
 * Email-first verification on top of the existing provider service, using the Laravel
 * Email Registry API as the shared store of results.
 *
 *   1. Normalize + de-duplicate.
 *   2. POST /email-verifications/lookup BEFORE any provider call.
 *   3. Reuse usable records (status=completed with a result, not older than maxAgeDays): 0 credits.
 *   4. Verify only the rest with the active provider (MillionVerifier / NeverBounce) — the
 *      verification engine stays in this app.
 *   5. Save every new result with POST /email-verifications (an upsert: no duplicate rows).
 *
 * Registry unavailable:
 *   fallback = 'block'    (default) the request fails with 503 registry_unavailable and nothing is
 *                         sent to a paid provider (a lookup failure is never reported as a result).
 *   fallback = 'provider' verification continues without the registry; the response says
 *                         registry.lookup = 'unavailable' and results are queued for saving.
 *
 * Mock mode never reads or writes the registry, so simulated results can't pollute shared data.
 *
 * Duplicate provider calls inside this process are prevented: concurrent single checks of the
 * same email share one call, and a bulk job waits for emails another running job is verifying.
 */
import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './errors.js';
import { normalizeEmail, toRegistryPayload, fromRegistryRecord, isUsable, availableFlagsFor } from './services/registryMapping.js';
import { createSaveQueue } from './services/registrySaveQueue.js';

const POLL_PROVIDER_MS = 3_000;
const WAIT_ELSEWHERE_MAX_MS = 30 * 60_000;
const MAX_TICK_ERRORS = 10;
const JOB_TTL_MS = 6 * 60 * 60_000;
const RECENT_TTL_MS = 60 * 60_000;

const UNAVAILABLE_MSG =
  'The email registry could not be checked, so nothing was sent to the verification provider (no credits used). Please retry shortly.';

export function createCentralVerification({ service, store, options = {}, timing = {} }) {
  const T = { pollMs: POLL_PROVIDER_MS, ...timing };
  const opts = { fallback: 'block', maxAgeDays: 0, saveRatePerMinute: 90, ...options };

  if (!store) {
    return { enabled: false, ...service, isCentralJob: () => false, registryStatus: () => null, shutdown() {} };
  }

  const saver = createSaveQueue({ store, ratePerMinute: opts.saveRatePerMinute, ...(opts.saveQueue || {}) });
  const recent = new Map(); // normalized -> { payload, at }: verified in this process (covers unsaved results)
  const singles = new Map(); // normalized -> Promise of a running single verification
  const bulkOwners = new Map(); // normalized -> jobId verifying it right now
  const jobs = new Map();
  const fingerprints = new Map();

  function remember(payload) {
    recent.set(payload.email, { payload, at: Date.now() });
    if (recent.size > 50_000) {
      const cutoff = Date.now() - RECENT_TTL_MS;
      for (const [k, v] of recent) if (v.at < cutoff || recent.size > 40_000) recent.delete(k);
    }
  }

  /** A payload we produced recently, as if it were a registry record. */
  function recentRecord(norm) {
    const hit = recent.get(norm);
    if (!hit || Date.now() - hit.at > RECENT_TTL_MS) return null;
    return { ...hit.payload, id: null, verified_at: new Date(hit.at).toISOString() };
  }

  /**
   * Usable records for these emails: this process's recent results first, then the registry.
   * Returns { usable: Map(norm -> record), invalid: Set(norm), checked: boolean, error }.
   * `invalid`: addresses the registry rejects as malformed — never sent to a paid provider.
   */
  async function findUsable(norms) {
    const usable = new Map();
    const invalid = new Set();
    const ask = [];
    for (const n of norms) {
      const r = recentRecord(n);
      if (r) usable.set(n, r);
      else ask.push(n);
    }
    if (!ask.length) return { usable, invalid, checked: true, error: null };
    try {
      const res = await store.lookup(ask);
      for (const [n, rec] of res.found) if (isUsable(rec, { maxAgeDays: opts.maxAgeDays })) usable.set(n, rec);
      for (const e of res.invalid || []) invalid.add(normalizeEmail(e));
      return { usable, invalid, checked: true, error: null };
    } catch (err) {
      if (opts.fallback !== 'provider' || err.code === 'registry_unauthorized') {
        // Never pay for a verification the registry might already hold, and never pretend.
        throw new ApiError(503, 'registry_unavailable', err.code === 'registry_unauthorized' ? err.message : UNAVAILABLE_MSG);
      }
      console.warn(`[central] registry lookup failed (${err.code}); continuing without it (EMAIL_REGISTRY_FALLBACK=provider)`);
      return { usable, invalid, checked: false, error: err.code };
    }
  }

  // ---------------------------------------------------------------- single

  function cachedResponse(record) {
    return { ...fromRegistryRecord(record), addressInfo: null, executionTime: 0, creditsUsed: 0, creditsRemaining: null, cached: true, stored: true };
  }

  async function verifySingle(email, requestedMode, { source = 'manual' } = {}) {
    const resolved = service.resolve(requestedMode);
    if (resolved.mode === 'mock') {
      const r = await service.verifySingle(email, requestedMode);
      return { ...r, cached: false, stored: false, registry: { lookup: 'skipped', saved: false, reason: 'mock_mode' } };
    }
    const norm = normalizeEmail(email);
    const running = singles.get(norm);
    if (running) {
      const r = await running; // same email already being verified by another request: share it
      return { ...r, creditsUsed: 0, cached: true, registry: { ...r.registry, lookup: 'shared' } };
    }
    const task = verifySingleUncached(email.trim(), norm, resolved, source);
    singles.set(norm, task);
    try {
      return await task;
    } finally {
      singles.delete(norm);
    }
  }

  async function verifySingleUncached(email, norm, { provider, mode, adapter }, source) {
    const { usable, invalid, checked } = await findUsable([norm]);
    if (invalid.has(norm)) throw new ApiError(400, 'invalid_email', 'That is not a valid email address.');
    const hit = usable.get(norm);
    if (hit) return { ...cachedResponse(hit), registry: { lookup: 'hit', saved: true, recordId: hit.id != null ? String(hit.id) : null } };

    const r = await adapter.verifySingle(email); // provider errors propagate (no automatic fallback)
    const payload = toRegistryPayload(r, { email, provider, source });
    remember(payload);
    let saved = false;
    let recordId = null;
    let saveError = null;
    try {
      const { record } = await saver.saveNow(payload);
      saved = true;
      recordId = record?.id != null ? String(record.id) : null;
    } catch (err) {
      // Credits were already spent: still return the result. Transient failures are retried in the background.
      saveError = err.code;
      console.warn(`[central] result not saved yet (${err.code})`);
    }
    return {
      provider,
      mode,
      ...r,
      cached: false,
      stored: saved,
      registryId: recordId,
      registry: { lookup: checked ? 'miss' : 'unavailable', saved, recordId, ...(saveError ? { error: saveError } : {}) },
    };
  }

  // ---------------------------------------------------------------- bulk

  async function preview(emails, requestedMode) {
    const norms = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (service.resolve(requestedMode).mode === 'mock') {
      return { total: norms.length, reusable: 0, pendingElsewhere: 0, invalid: 0, toVerify: norms.length, registry: 'skipped' };
    }
    const { usable, invalid } = await findUsable(norms);
    let pending = 0;
    let bad = 0;
    for (const n of norms) {
      if (usable.has(n)) continue;
      if (invalid.has(n)) bad++;
      else if (bulkOwners.has(n)) pending++;
    }
    return { total: norms.length, reusable: usable.size, pendingElsewhere: pending, invalid: bad, toVerify: norms.length - usable.size - pending - bad };
  }

  /**
   * options.provider pins the provider (bulk verification jobs); default: the active provider.
   * The result includes providerJobRef (the provider's own job id, live only) so a caller that
   * persists it can re-attach with resumeBulkJob() after a restart instead of paying again.
   */
  async function createBulkJob(rows, filename, requestedMode, { source = 'csv_import', provider: pinned } = {}) {
    const { provider, mode, adapter } = service.resolve(requestedMode, pinned);
    if (mode === 'mock') return service.createBulkJob(rows, filename, requestedMode, { provider }); // sandbox: no registry

    const entries = [];
    const seen = new Set();
    for (const r of rows) {
      const normalized = normalizeEmail(r.email);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      entries.push({ email: r.email.trim(), normalized });
    }

    const fp = createHash('sha256').update(`${provider}|${mode}|`).update([...seen].sort().join('\n')).digest('hex');
    const runningId = fingerprints.get(fp);
    if (runningId && jobs.get(runningId) && !jobs.get(runningId).done) {
      const running = jobs.get(runningId);
      return { provider, mode, jobId: runningId, duplicate: true, providerJobRef: running.providerRawId, ...summary(running) };
    }

    const { usable, invalid, checked } = await findUsable([...seen]);
    const reuse = new Map();
    const waiting = new Map();
    const malformed = new Set();
    const toProvider = [];
    for (const e of entries) {
      if (usable.has(e.normalized)) reuse.set(e.normalized, usable.get(e.normalized));
      else if (invalid.has(e.normalized)) malformed.add(e.normalized);
      else if (bulkOwners.has(e.normalized)) waiting.set(e.normalized, Date.now());
      else toProvider.push(e);
    }

    const job = {
      id: `cj_${randomUUID()}`,
      provider,
      mode,
      adapter,
      source,
      entries,
      reuse,
      waiting,
      malformed,
      toProvider,
      registryChecked: checked,
      resolved: new Map(),
      unresolved: new Map(),
      providerRawId: null,
      providerStatus: null,
      providerResults: null,
      providerDone: toProvider.length === 0,
      creditsUsed: 0,
      creditsRemaining: null,
      save: { total: 0, saved: 0, failed: 0 },
      done: false,
      error: null,
      errors: 0,
      createdAt: Date.now(),
      fingerprint: fp,
    };

    for (const e of toProvider) bulkOwners.set(e.normalized, job.id);
    if (toProvider.length) {
      try {
        job.providerRawId = await adapter.createJob(toProvider.map((e, i) => ({ id: String(i), email: e.email })), filename);
      } catch (err) {
        releaseOwnership(job);
        throw err;
      }
    }

    jobs.set(job.id, job);
    fingerprints.set(fp, job.id);
    schedule(job, toProvider.length ? T.pollMs : 0);
    return { provider, mode, jobId: job.id, duplicate: false, providerJobRef: job.providerRawId, ...summary(job) };
  }

  /**
   * Re-attach to a live provider job created before this process started (the in-memory job is
   * gone after a restart, but the provider still holds the job and its results). The results are
   * fetched and saved to the registry exactly like a new job's, so nothing is paid for twice.
   * rows: the emails of that batch. Emails the registry already holds are reused (they may never
   * have been sent to that provider job); the rest are expected in the provider job's results.
   */
  async function resumeBulkJob({ provider, rawId, rows, source = 'csv_import' }) {
    const adapter = service.adapterFor(provider, 'live');
    if (!adapter) throw new ApiError(409, 'provider_not_configured', 'The provider for this job is no longer configured; it cannot be resumed.');

    const entries = [];
    const seen = new Set();
    for (const r of rows) {
      const normalized = normalizeEmail(r.email);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      entries.push({ email: r.email.trim(), normalized });
    }
    const fp = createHash('sha256').update(`${provider}|live|resume|${rawId}`).digest('hex');
    const runningId = fingerprints.get(fp);
    if (runningId && jobs.get(runningId) && !jobs.get(runningId).done) {
      return { provider, mode: 'live', jobId: runningId, duplicate: true, providerJobRef: String(rawId) };
    }

    const { usable, checked } = await findUsable([...seen]);
    const reuse = new Map();
    const toProvider = [];
    for (const e of entries) {
      if (usable.has(e.normalized)) reuse.set(e.normalized, usable.get(e.normalized));
      else toProvider.push(e);
    }

    const job = {
      id: `cj_${randomUUID()}`,
      provider,
      mode: 'live',
      adapter,
      source,
      entries,
      reuse,
      waiting: new Map(),
      malformed: new Set(),
      toProvider,
      registryChecked: checked,
      resolved: new Map(),
      unresolved: new Map(),
      providerRawId: String(rawId),
      providerStatus: null,
      providerResults: null,
      providerDone: toProvider.length === 0,
      creditsUsed: 0,
      creditsRemaining: null,
      save: { total: 0, saved: 0, failed: 0 },
      done: false,
      error: null,
      errors: 0,
      createdAt: Date.now(),
      fingerprint: fp,
    };
    for (const e of toProvider) bulkOwners.set(e.normalized, job.id);
    jobs.set(job.id, job);
    fingerprints.set(fp, job.id);
    schedule(job, 0);
    return { provider, mode: 'live', jobId: job.id, duplicate: false, providerJobRef: job.providerRawId };
  }

  function releaseOwnership(job) {
    for (const e of job.toProvider) if (bulkOwners.get(e.normalized) === job.id) bulkOwners.delete(e.normalized);
  }

  function summary(job) {
    return {
      reused: job.reuse.size,
      pendingElsewhere: job.waiting.size + job.resolved.size + job.unresolved.size,
      invalid: job.malformed.size,
      toVerify: job.toProvider.length,
      registryChecked: job.registryChecked,
    };
  }

  function schedule(job, ms) {
    job.timer = setTimeout(() => tick(job), ms);
  }

  async function tick(job) {
    if (job.done) return;
    try {
      if (!job.providerDone) {
        const s = await job.adapter.jobStatus(job.providerRawId);
        job.providerStatus = s;
        if (s.stage === 'failed') {
          finish(job, s.failureReason || 'The verification provider reported that the job failed.');
          return;
        }
        if (s.stage === 'complete') {
          const { results, creditsUsed } = await job.adapter.jobResults(job.providerRawId);
          job.providerResults = new Map(results.map((r) => [normalizeEmail(r.email), r]));
          job.creditsUsed = creditsUsed;
          job.providerDone = true;
          persist(job);
          releaseOwnership(job);
        }
      }

      // Emails another job in this process was verifying.
      for (const [norm, since] of job.waiting) {
        const rec = recentRecord(norm);
        if (rec) {
          job.resolved.set(norm, rec);
          job.waiting.delete(norm);
        } else if (!bulkOwners.has(norm) || Date.now() - since > WAIT_ELSEWHERE_MAX_MS) {
          job.unresolved.set(norm, 'not_finished');
          job.waiting.delete(norm);
        }
      }

      job.errors = 0;
      if (job.providerDone && job.waiting.size === 0) {
        try {
          job.creditsRemaining = (await job.adapter.getCredits()).creditsRemaining;
        } catch {
          /* optional */
        }
        finish(job, null);
        return;
      }
    } catch (err) {
      job.errors += 1;
      console.warn(`[central] ${job.id} tick error ${job.errors}: ${err.message}`);
      if (job.errors >= MAX_TICK_ERRORS || (err.status && err.status < 500 && err.status !== 429 && err.status !== 409)) {
        finish(job, err.message);
        return;
      }
    }
    schedule(job, T.pollMs * Math.min(8, 2 ** job.errors));
  }

  /** Queue every provider result for saving (rate-limited, retried; does not block the results). */
  function persist(job) {
    const flags = availableFlagsFor(job.provider);
    for (const e of job.toProvider) {
      const r = job.providerResults.get(e.normalized);
      if (!r) continue;
      const payload = toRegistryPayload({ ...r, availableFlags: flags, creditsUsed: 1 }, { email: e.email, provider: job.provider, source: job.source });
      remember(payload);
      job.save.total += 1;
      saver.enqueue(payload, (ok) => {
        if (ok) job.save.saved += 1;
        else job.save.failed += 1;
      });
    }
  }

  function finish(job, error) {
    job.done = true;
    job.error = error;
    clearTimeout(job.timer);
    releaseOwnership(job);
    fingerprints.delete(job.fingerprint);
    for (const [id, j] of jobs) if (j.done && Date.now() - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }

  function countsFor(job) {
    const counts = { valid: 0, invalid: 0, disposable: 0, catchall: 0, unknown: 0 };
    for (const rec of [...job.reuse.values(), ...job.resolved.values()]) counts[fromRegistryRecord(rec).result] += 1;
    if (job.providerResults) {
      for (const r of job.providerResults.values()) counts[r.result] = (counts[r.result] || 0) + 1;
    } else if (job.providerStatus) {
      for (const k of Object.keys(counts)) counts[k] += job.providerStatus.counts?.[k] || 0;
    }
    counts.unknown += job.unresolved.size;
    counts.invalid += job.malformed.size;
    return counts;
  }

  function getJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new ApiError(404, 'job_not_found', 'Unknown job id (jobs are kept in memory and are lost when the server restarts).');
    return job;
  }

  function bulkStatus(jobId) {
    const job = getJob(jobId);
    const total = job.entries.length;
    const providerTotal = job.toProvider.length;
    const providerProcessed = job.providerDone ? providerTotal : Math.min(providerTotal, job.providerStatus?.processed || 0);
    const doneCount = job.reuse.size + job.resolved.size + job.unresolved.size + job.malformed.size + providerProcessed;

    let stage;
    if (job.error) stage = 'failed';
    else if (job.done) stage = 'complete';
    else if (!job.providerDone) stage = job.providerStatus?.stage === 'complete' ? 'verifying' : job.providerStatus?.stage || 'uploading';
    else stage = 'verifying';

    return {
      provider: job.provider,
      mode: job.mode,
      jobId,
      rawStatus: job.providerStatus?.rawStatus || (providerTotal ? 'submitted' : 'registry'),
      stage,
      percent: job.done && !job.error ? 100 : total ? Math.min(99, Math.floor((doneCount / total) * 100)) : 0,
      total,
      processed: doneCount,
      billable: job.providerStatus?.billable || 0,
      counts: countsFor(job),
      failureReason: job.error,
      registrySave: { ...job.save, pending: job.save.total - job.save.saved - job.save.failed },
      ...summary(job),
    };
  }

  function bulkResults(jobId) {
    const job = getJob(jobId);
    if (!job.done) throw new ApiError(409, 'job_not_complete', 'Job is not complete yet.');
    if (job.error) throw new ApiError(409, 'job_failed', job.error);

    const results = job.entries.map((e, i) => {
      const rec = job.reuse.get(e.normalized) || job.resolved.get(e.normalized);
      if (rec) {
        const r = fromRegistryRecord(rec);
        return { id: String(i), email: e.email, result: r.result, flags: r.flags, suggestedCorrection: r.suggestedCorrection, cached: true, provider: r.provider, verifiedAt: r.verifiedAt };
      }
      if (job.malformed.has(e.normalized)) {
        return { id: String(i), email: e.email, result: 'invalid', flags: ['bad_syntax'], suggestedCorrection: '', cached: false, note: 'Invalid email format (not submitted)' };
      }
      if (job.unresolved.has(e.normalized)) {
        return { id: String(i), email: e.email, result: 'unknown', flags: [], suggestedCorrection: '', cached: false, note: 'Verification by another job did not finish; re-run to retry' };
      }
      const r = job.providerResults?.get(e.normalized);
      return r
        ? { id: String(i), email: e.email, result: r.result, flags: r.flags, suggestedCorrection: r.suggestedCorrection, cached: false, provider: job.provider }
        : { id: String(i), email: e.email, result: 'unknown', flags: [], suggestedCorrection: '', cached: false, note: 'Not returned by provider' };
    });

    return {
      provider: job.provider,
      mode: job.mode,
      jobId,
      results,
      creditsUsed: job.creditsUsed,
      creditsRemaining: job.creditsRemaining,
      registrySave: { ...job.save, pending: job.save.total - job.save.saved - job.save.failed },
      ...summary(job),
    };
  }

  return {
    enabled: true,
    resolve: service.resolve,
    credits: service.credits,
    resetMock: service.resetMock,
    verifySingle,
    preview,
    createBulkJob,
    resumeBulkJob,
    isCentralJob: (id) => String(id).startsWith('cj_'),
    bulkStatus: async (id) => (String(id).startsWith('cj_') ? bulkStatus(id) : service.bulkStatus(id)),
    bulkResults: async (id) => (String(id).startsWith('cj_') ? bulkResults(id) : service.bulkResults(id)),
    registryStatus: () => ({ saveQueue: saver.stats(), fallback: opts.fallback, maxAgeDays: opts.maxAgeDays }),
    /** Tests: wait for queued saves. */
    savesIdle: () => saver.idle(),
    shutdown() {
      for (const j of jobs.values()) clearTimeout(j.timer);
      saver.stop();
    },
  };
}
