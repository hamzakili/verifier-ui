/**
 * Unified verification service. Routes every request to the adapter for the
 * active provider + mode, so routes never deal with provider-specific APIs.
 *
 * No automatic fallback: if the active provider fails, the error is returned and
 * the user decides whether to switch providers (prevents surprise credit spend).
 */
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';
import { createMockClient } from './mock.js';
import { createNeverBounceClient } from './neverbounce.js';
import { createNeverBounceAdapter } from './providers/neverbounceAdapter.js';
import { createMillionVerifierAdapter, MILLIONVERIFIER_FLAGS } from './providers/millionverifier.js';

// Public bulk job ids carry their provider + mode so status/results always reach the
// right backend, even after the user switches provider mid-job: e.g. "mv_32585142",
// "nb_123456", "mv-mock_mock_1001".
const JOB_PREFIX = { millionverifier: 'mv', neverbounce: 'nb' };
const PREFIX_PROVIDER = { mv: 'millionverifier', nb: 'neverbounce' };
const JOB_ID_RE = /^(mv|nb)(-mock)?_(.+)$/;

const INFLIGHT_TTL_MS = 6 * 60 * 60 * 1000;
const RESULTS_CACHE_MAX = 20;

export function createVerificationService({ config, registry }) {
  const live = {
    millionverifier: registry.isConfigured('millionverifier')
      ? createMillionVerifierAdapter(config.providers.millionverifier)
      : null,
    neverbounce: registry.isConfigured('neverbounce')
      ? createNeverBounceAdapter(createNeverBounceClient(config.providers.neverbounce.apiKey))
      : null,
  };

  // Separate sandbox per provider: balances are never shared or combined.
  const mock = {
    millionverifier: createNeverBounceAdapter(createMockClient({ startingCredits: config.mockStartingCredits }), {
      availableFlags: MILLIONVERIFIER_FLAGS,
    }),
    neverbounce: createNeverBounceAdapter(createMockClient({ startingCredits: config.mockStartingCredits })),
  };

  const inflight = new Map(); // submission fingerprint -> { jobId, at }
  const jobFingerprints = new Map(); // jobId -> fingerprint
  const resultsCache = new Map(); // jobId -> results payload
  const finalizing = new Map(); // jobId -> Promise (dedupes concurrent results fetches)

  /**
   * Mode for the active provider: mock if requested, or if the provider has no key.
   * `providerOverride` pins a specific provider (bulk verification jobs keep the provider
   * they were created with, even if the active provider is switched mid-job).
   */
  function resolve(requestedMode, providerOverride) {
    const provider = providerOverride && registry.isValid(providerOverride) ? providerOverride : registry.getActive();
    const mode = !registry.isConfigured(provider) || requestedMode === 'mock' ? 'mock' : 'live';
    return { provider, mode, adapter: mode === 'live' ? live[provider] : mock[provider] };
  }

  function resolveJob(jobId) {
    const m = JOB_ID_RE.exec(String(jobId));
    if (!m) throw new ApiError(404, 'job_not_found', 'Unknown job id. It may have been created before the server was updated.');
    const provider = PREFIX_PROVIDER[m[1]];
    const mode = m[2] ? 'mock' : 'live';
    const adapter = mode === 'live' ? live[provider] : mock[provider];
    if (!adapter) {
      throw new ApiError(409, 'provider_not_configured', `This job belongs to ${registry.nameOf(provider)}, which is no longer configured.`);
    }
    return { provider, mode, rawId: m[3], adapter };
  }

  const fingerprint = (provider, mode, rows) =>
    createHash('sha256')
      .update(`${provider}|${mode}|`)
      .update(rows.map((r) => r.email.toLowerCase()).sort().join('\n'))
      .digest('hex');

  function releaseJob(jobId) {
    const fp = jobFingerprints.get(jobId);
    if (fp) inflight.delete(fp);
    jobFingerprints.delete(jobId);
  }

  return {
    resolve,

    /** The adapter for a provider + mode, or null when that provider has no key (live). */
    adapterFor: (provider, mode) => (mode === 'live' ? live[provider] : mock[provider]) || null,

    /**
     * Re-attach to a live provider job created earlier (e.g. before a server restart). Provider
     * jobs are stateless from this service's point of view, so this only rebuilds the public id.
     */
    resumeBulkJob({ provider, rawId }) {
      if (!live[provider]) {
        throw new ApiError(409, 'provider_not_configured', `${registry.nameOf(provider)} is no longer configured; the job cannot be resumed.`);
      }
      return { provider, mode: 'live', jobId: `${JOB_PREFIX[provider]}_${rawId}`, duplicate: false };
    },

    async credits(requestedMode) {
      const { provider, mode, adapter } = resolve(requestedMode);
      const c = await adapter.getCredits();
      return { provider, mode, ...c };
    },

    async verifySingle(email, requestedMode) {
      const { provider, mode, adapter } = resolve(requestedMode);
      const r = await adapter.verifySingle(email);
      return { provider, mode, ...r };
    },

    /**
     * rows: [{ id, email }] — already de-duplicated and validated.
     * options.provider pins the provider (default: the active one).
     * Returns providerJobRef (the provider's own job id) for live jobs so callers can re-attach.
     */
    async createBulkJob(rows, filename, requestedMode, { provider: pinned } = {}) {
      const { provider, mode, adapter } = resolve(requestedMode, pinned);

      // Prevent duplicate submissions of the same list while a job for it is still running.
      const fp = fingerprint(provider, mode, rows);
      const existing = inflight.get(fp);
      if (existing && Date.now() - existing.at < INFLIGHT_TTL_MS) {
        const m = JOB_ID_RE.exec(existing.jobId);
        return { provider, mode, jobId: existing.jobId, duplicate: true, providerJobRef: mode === 'live' && m ? m[3] : null };
      }

      const rawId = await adapter.createJob(rows, filename);
      const jobId = `${JOB_PREFIX[provider]}${mode === 'mock' ? '-mock' : ''}_${rawId}`;
      inflight.set(fp, { jobId, at: Date.now() });
      jobFingerprints.set(jobId, fp);
      return { provider, mode, jobId, duplicate: false, providerJobRef: mode === 'live' ? rawId : null };
    },

    async bulkStatus(jobId) {
      const { provider, mode, rawId, adapter } = resolveJob(jobId);
      const s = await adapter.jobStatus(rawId);
      if (s.stage === 'failed') releaseJob(jobId);
      return { provider, mode, jobId, ...s };
    },

    async bulkResults(jobId) {
      const cached = resultsCache.get(jobId);
      if (cached) return cached;
      if (finalizing.has(jobId)) return finalizing.get(jobId);

      const { provider, mode, rawId, adapter } = resolveJob(jobId);
      const task = (async () => {
        const { results, creditsUsed } = await adapter.jobResults(rawId);
        let creditsRemaining = null;
        try {
          creditsRemaining = (await adapter.getCredits()).creditsRemaining;
        } catch {
          /* balance is optional here; the UI can refresh it */
        }
        const payload = { provider, mode, jobId, results, creditsUsed, creditsRemaining };
        resultsCache.set(jobId, payload);
        if (resultsCache.size > RESULTS_CACHE_MAX) resultsCache.delete(resultsCache.keys().next().value);
        releaseJob(jobId);
        return payload;
      })();

      finalizing.set(jobId, task);
      try {
        return await task;
      } finally {
        finalizing.delete(jobId);
      }
    },

    resetMock() {
      mock.millionverifier.reset?.();
      mock.neverbounce.reset?.();
    },
  };
}
