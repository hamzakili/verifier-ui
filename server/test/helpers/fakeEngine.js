/**
 * Controllable stand-in for the verification engine (`central`): same interface the bulk runner
 * uses (createBulkJob / resumeBulkJob / bulkStatus / bulkResults), deterministic results, and
 * hooks to inject failures, slow batches and restarts.
 */
export function createFakeEngine({ polls = 1 } = {}) {
  const state = {
    polls, // bulkStatus calls before a job completes
    createErrors: [], // errors thrown by the next createBulkJob calls
    failEmails: new Set(), // emails returned as "unfinished"
    hold: false, // when true, jobs never complete (simulates a long provider job)
    calls: [], // { type, emails?, rawId?, at }
    onCreate: null, // (rows) => void, runs inside createBulkJob (assertions about ordering)
  };
  const jobs = new Map();
  let seq = 0;

  const resultFor = (email) => {
    const e = email.toLowerCase();
    if (e.startsWith('invalid')) return 'invalid';
    if (e.startsWith('catchall')) return 'catchall';
    if (e.endsWith('@mailinator.com')) return 'disposable';
    if (e.startsWith('unknown')) return 'unknown';
    return 'valid';
  };

  return {
    state,
    jobs,
    async createBulkJob(rows, filename, mode, { provider = 'millionverifier' } = {}) {
      state.calls.push({ type: 'create', emails: rows.map((r) => r.email), mode, provider, filename, at: Date.now() });
      state.onCreate?.(rows);
      if (state.createErrors.length) throw state.createErrors.shift();
      seq += 1;
      const id = `fake_${seq}`;
      const rawId = mode === 'live' ? `raw_${seq}` : null;
      jobs.set(id, { rows, n: 0, provider, mode });
      return { jobId: id, provider, mode, providerJobRef: rawId, duplicate: false };
    },
    async resumeBulkJob({ provider, rawId, rows }) {
      state.calls.push({ type: 'resume', rawId, emails: rows.map((r) => r.email), at: Date.now() });
      seq += 1;
      const id = `fake_${seq}`;
      jobs.set(id, { rows, n: 0, provider, mode: 'live' });
      return { jobId: id, provider, mode: 'live', providerJobRef: rawId, duplicate: false };
    },
    async bulkStatus(id) {
      const j = jobs.get(id);
      if (!j) throw Object.assign(new Error('Unknown job id'), { status: 404, code: 'job_not_found' });
      j.n += 1;
      const done = !state.hold && j.n >= state.polls;
      return { stage: done ? 'complete' : 'verifying', processed: done ? j.rows.length : Math.floor(j.rows.length / 2), total: j.rows.length };
    },
    async bulkResults(id) {
      const j = jobs.get(id);
      return {
        results: j.rows.map((r) =>
          state.failEmails.has(r.email)
            ? { email: r.email, result: 'unknown', flags: [], note: 'Not returned by provider', cached: false }
            : { email: r.email, result: resultFor(r.email), flags: ['has_dns'], suggestedCorrection: '', cached: r.email.startsWith('reused'), provider: j.provider },
        ),
      };
    },
  };
}
