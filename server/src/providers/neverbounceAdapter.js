/**
 * NeverBounce adapter: wraps the existing v4.2 client (../neverbounce.js) and the
 * NeverBounce-shaped mock sandbox, and converts their responses to the app's
 * normalized provider interface:
 *
 *   getCredits()            -> { creditsRemaining, details }
 *   verifySingle(email)     -> { result, flags, availableFlags, suggestedCorrection, addressInfo,
 *                                executionTime, creditsUsed, creditsRemaining, providerDetails }
 *   createJob(rows, name)   -> rawJobId
 *   jobStatus(rawJobId)     -> { rawStatus, stage, percent, total, processed, billable, counts, failureReason }
 *   jobResults(rawJobId)    -> { results: [{ id, email, result, flags, suggestedCorrection }], creditsUsed }
 *
 * (The normalization below is the same logic that previously lived in the Express routes.)
 */
import { ApiError } from '../errors.js';

// NeverBounce reports all of these flags, so the UI can show "No" when one is absent.
export const NEVERBOUNCE_FLAGS = ['free_email_host', 'role_account', 'has_dns', 'has_dns_mx', 'smtp_connectable'];

const STAGE_MAP = {
  uploading: 'uploading',
  parsing: 'parsing',
  waiting: 'queued',
  waiting_analyzed: 'queued',
  under_review: 'queued',
  queued: 'queued',
  running: 'verifying',
  complete: 'complete',
  failed: 'failed',
};

const totalRemaining = (ci = {}) => (ci.paid_credits_remaining ?? 0) + (ci.free_credits_remaining ?? 0);

export function createNeverBounceAdapter(client, { availableFlags = NEVERBOUNCE_FLAGS } = {}) {
  const startedJobs = new Set();
  const startFailures = new Map();
  const allowed = new Set(availableFlags);

  return {
    async getCredits() {
      const info = await client.accountInfo();
      const ci = info.credits_info || {};
      return {
        creditsRemaining: totalRemaining(ci),
        details: {
          paidCreditsRemaining: ci.paid_credits_remaining ?? 0,
          freeCreditsRemaining: ci.free_credits_remaining ?? 0,
          paidCreditsUsed: ci.paid_credits_used ?? 0,
          freeCreditsUsed: ci.free_credits_used ?? 0,
          jobCounts: info.job_counts || {},
        },
      };
    },

    async verifySingle(email) {
      const r = await client.singleCheck(email);
      const ci = r.credits_info || {};
      const used = (ci.paid_credits_used ?? 0) + (ci.free_credits_used ?? 0);
      return {
        result: r.result || 'unknown',
        flags: (r.flags || []).filter((f) => allowed.has(f) || !NEVERBOUNCE_FLAGS.includes(f)),
        availableFlags,
        suggestedCorrection: r.suggested_correction || '',
        addressInfo: r.address_info || null,
        executionTime: r.execution_time ?? null,
        creditsUsed: used || 1,
        creditsRemaining: totalRemaining(ci),
        providerDetails: { result: r.result, flags: r.flags || [] },
      };
    },

    async createJob(rows, filename) {
      const job = await client.createJob(rows, filename);
      return String(job.job_id);
    },

    async jobStatus(jobId) {
      const s = await client.jobStatus(jobId);

      // Created with auto_start=0: once parsed and waiting, kick off verification (once).
      if ((s.job_status === 'waiting' || s.job_status === 'waiting_analyzed') && !startedJobs.has(jobId)) {
        try {
          await client.startJob(jobId);
          startedJobs.add(jobId);
        } catch (err) {
          const attempts = (startFailures.get(jobId) || 0) + 1;
          startFailures.set(jobId, attempts);
          if (attempts >= 3) throw err;
          console.warn(`[bulk] jobs/start failed for ${jobId} (attempt ${attempts}): ${err.message}`);
        }
      }

      const t = s.total || {};
      return {
        rawStatus: s.job_status,
        stage: STAGE_MAP[s.job_status] || 'queued',
        percent: Number(s.percent_complete) || 0,
        total: t.records ?? 0,
        processed: t.processed ?? 0,
        billable: t.billable ?? 0,
        counts: {
          valid: t.valid ?? 0,
          invalid: t.invalid ?? 0,
          disposable: t.disposable ?? 0,
          catchall: t.catchall ?? 0,
          unknown: t.unknown ?? 0,
        },
        failureReason: s.failure_reason || null,
      };
    },

    async jobResults(jobId) {
      const status = await client.jobStatus(jobId);
      if (status.job_status !== 'complete') {
        throw new ApiError(409, 'job_not_complete', `Job is ${status.job_status}; results are not ready yet.`);
      }

      const results = [];
      let page = 1;
      let totalPages = 1;
      do {
        const r = await client.jobResults(jobId, page, 1000);
        totalPages = r.total_pages || 1;
        for (const item of r.results || []) {
          const v = item.verification || {};
          results.push({
            id: item.data?.id ?? null,
            email: item.data?.email ?? v.address_info?.original_email ?? '',
            result: v.result || 'unknown',
            flags: (v.flags || []).filter((f) => allowed.has(f) || !NEVERBOUNCE_FLAGS.includes(f)),
            suggestedCorrection: v.suggested_correction || '',
          });
        }
        page += 1;
      } while (page <= totalPages && page <= 100);

      startedJobs.delete(jobId);
      startFailures.delete(jobId);
      return { results, creditsUsed: status.total?.billable ?? results.length };
    },

    reset: client.reset ? () => client.reset() : undefined,
  };
}
