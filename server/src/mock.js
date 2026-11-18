/**
 * Mock NeverBounce sandbox.
 *
 * Produces responses with the same shape as the real v4.2 API so the rest of the
 * server treats live and mock identically. Results are deterministic per address
 * (same email -> same result), with a few recognizable patterns for testing:
 *
 *   valid@anything        -> valid
 *   *@gmial.com, etc.     -> invalid + suggested_correction
 *   *@mailinator.com, etc -> disposable
 *   catchall@... / *@catchall.test -> catchall
 *   unknown@... / *@unknown.test   -> unknown
 *   invalid@..., bounce@..., fake@... -> invalid
 */
import { ApiError } from './errors.js';

const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'hotmial.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'iclod.com': 'icloud.com',
  'icloud.co': 'icloud.com',
};

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com',
  'throwawaymail.com', 'maildrop.cc', 'fakeinbox.com',
]);

const FREE_HOSTS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'protonmail.com', 'proton.me', 'live.com', 'msn.com', 'gmx.com', 'mail.com', 'zoho.com',
]);

const ROLE_LOCALS = new Set([
  'admin', 'info', 'support', 'sales', 'contact', 'noreply', 'no-reply', 'hello', 'team',
  'billing', 'office', 'help', 'marketing', 'webmaster', 'postmaster', 'hr', 'jobs',
]);

const EMAIL_RE = /^[^\s@"(),:;<>[\\\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Small deterministic hash (FNV-1a) -> [0, 1). */
function hash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Core classifier. Returns a NeverBounce-shaped verification object. */
export function classify(rawEmail) {
  const email = String(rawEmail ?? '').trim();
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf('@');
  const local = at > 0 ? lower.slice(0, at) : lower;
  const domain = at > 0 ? lower.slice(at + 1) : '';
  const r = hash01(lower);

  const addressInfo = {
    original_email: email,
    normalized_email: lower,
    addr: local,
    alias: local.includes('+') ? local.split('+')[1] : '',
    host: domain,
    fqdn: domain,
    domain: domain.split('.').slice(-2, -1)[0] ?? '',
    subdomain: domain.split('.').length > 2 ? domain.split('.').slice(0, -2).join('.') : '',
    tld: domain.split('.').pop() ?? '',
  };

  if (!EMAIL_RE.test(email)) {
    return { result: 'invalid', flags: ['bad_syntax'], suggested_correction: '', address_info: addressInfo };
  }

  const flags = [];
  const baseLocal = local.split('+')[0];
  if (FREE_HOSTS.has(domain)) flags.push('free_email_host');
  if (ROLE_LOCALS.has(baseLocal)) flags.push('role_account');

  // Typo domain -> no MX, invalid, with a correction
  if (TYPO_DOMAINS[domain]) {
    return {
      result: 'invalid',
      flags: [...flags, 'has_dns'],
      suggested_correction: `${local}@${TYPO_DOMAINS[domain]}`,
      address_info: addressInfo,
    };
  }

  const dnsFlags = ['has_dns', 'has_dns_mx'];
  let result;

  if (DISPOSABLE_DOMAINS.has(domain)) {
    result = 'disposable';
    flags.push('disposable_email');
  } else if (/^(invalid|bounce|bounced|fake|nobody|doesnotexist)\b/.test(baseLocal)) {
    result = 'invalid';
  } else if (baseLocal.startsWith('catchall') || baseLocal.startsWith('catch-all') || domain === 'catchall.test') {
    result = 'catchall';
  } else if (baseLocal.startsWith('unknown') || domain === 'unknown.test') {
    result = 'unknown';
  } else if (baseLocal.startsWith('valid')) {
    result = 'valid';
  } else if (r < 0.74) {
    result = 'valid';
  } else if (r < 0.86) {
    result = 'invalid';
  } else if (r < 0.95) {
    result = 'catchall';
  } else {
    result = 'unknown';
  }

  if (result === 'invalid' && r > 0.5) {
    // Some invalids are dead domains with no MX
    flags.push('has_dns');
  } else {
    flags.push(...dnsFlags);
  }
  if (result === 'valid' || result === 'catchall') flags.push('smtp_connectable');

  return { result, flags, suggested_correction: '', address_info: addressInfo };
}

// --- API surface (mirrors neverbounce.js) -----------------------------------

/**
 * Create an isolated sandbox (own balance + jobs). One instance exists per
 * provider so mock balances are never shared or combined across providers.
 */
export function createMockClient({ startingCredits = 10_000 } = {}) {
  const state = {
    creditsRemaining: startingCredits,
    creditsUsed: 0,
    jobs: new Map(), // jobId -> job
    jobSeq: 1000,
    completedJobs: 0,
  };

  function creditsInfo(used) {
    return {
      paid_credits_used: used,
      free_credits_used: 0,
      paid_credits_remaining: state.creditsRemaining,
      free_credits_remaining: 0,
    };
  }

  function spend(n) {
    if (state.creditsRemaining < n) {
      throw new ApiError(402, 'insufficient_credits', `Mock sandbox has ${state.creditsRemaining} credits left; ${n} required. Restart the server to reset it.`);
    }
    state.creditsRemaining -= n;
    state.creditsUsed += n;
  }

  function getJob(jobId) {
    const job = state.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'job_not_found', `Mock job ${jobId} not found (the server may have restarted).`);
    return job;
  }

  return {
  async accountInfo() {
    await sleep(150);
    return {
      status: 'success',
      credits_info: {
        paid_credits_used: state.creditsUsed,
        free_credits_used: 0,
        paid_credits_remaining: state.creditsRemaining,
        free_credits_remaining: 0,
      },
      job_counts: {
        completed: state.completedJobs,
        under_review: 0,
        queued: 0,
        processing: [...state.jobs.values()].filter((j) => !j.finished).length,
      },
    };
  },

  async singleCheck(email) {
    const started = Date.now();
    await sleep(300 + Math.floor(hash01(email + 't') * 600));
    spend(1);
    const v = classify(email);
    return {
      status: 'success',
      ...v,
      credits_info: creditsInfo(1),
      execution_time: Date.now() - started,
    };
  },

  async createJob(rows, filename) {
    await sleep(250);
    const jobId = `mock_${++state.jobSeq}`;
    // Simulated duration scales with size: 6s minimum, up to ~20s.
    const durationMs = Math.min(20_000, 6_000 + rows.length * 4);
    state.jobs.set(jobId, {
      id: jobId,
      filename,
      rows,
      createdAt: Date.now(),
      startedAt: null,
      durationMs,
      results: rows.map((row) => ({ row, verification: classify(row.email) })),
      finished: false,
      billed: false,
    });
    return { status: 'success', job_id: jobId };
  },

  async startJob(jobId) {
    const job = getJob(jobId);
    if (!job.startedAt) job.startedAt = Date.now();
    return { status: 'success', queue_id: `q_${jobId}` };
  },

  async jobStatus(jobId) {
    await sleep(80);
    const job = getJob(jobId);
    const now = Date.now();
    const sinceCreate = now - job.createdAt;
    const total = job.rows.length;

    let jobStatus;
    let percent = 0;
    if (sinceCreate < 1200) {
      jobStatus = 'uploading';
    } else if (sinceCreate < 2500) {
      jobStatus = 'parsing';
    } else if (!job.startedAt) {
      jobStatus = 'waiting'; // parsed, awaiting jobs/start
    } else {
      const elapsed = now - job.startedAt;
      percent = Math.min(100, Math.floor((elapsed / job.durationMs) * 100));
      jobStatus = percent >= 100 ? 'complete' : 'running';
    }

    if (jobStatus === 'complete' && !job.finished) {
      job.finished = true;
      state.completedJobs += 1;
    }
    if (jobStatus === 'complete' && !job.billed) {
      spend(total);
      job.billed = true;
    }

    const processed = Math.floor((percent / 100) * total);
    const counts = { valid: 0, invalid: 0, disposable: 0, catchall: 0, unknown: 0, bad_syntax: 0 };
    for (let i = 0; i < processed; i++) {
      const v = job.results[i].verification;
      counts[v.result] += 1;
      if (v.flags.includes('bad_syntax')) counts.bad_syntax += 1;
    }

    return {
      status: 'success',
      id: jobId,
      filename: job.filename,
      job_status: jobStatus,
      total: {
        records: total,
        billable: total,
        processed,
        ...counts,
        duplicates: 0,
      },
      percent_complete: percent,
      bounce_estimate: processed ? (counts.invalid / processed) * 100 : 0,
    };
  },

  async jobResults(jobId, page = 1, itemsPerPage = 1000) {
    await sleep(120);
    const job = getJob(jobId);
    if (!job.finished) throw new ApiError(409, 'job_not_complete', 'Job is not complete yet.');
    const start = (page - 1) * itemsPerPage;
    const slice = job.results.slice(start, start + itemsPerPage);
    return {
      status: 'success',
      total_results: job.results.length,
      total_pages: Math.max(1, Math.ceil(job.results.length / itemsPerPage)),
      query: { job_id: jobId, page, items_per_page: itemsPerPage },
      results: slice.map(({ row, verification }) => ({
        data: { id: row.id, email: row.email },
        verification: { ...verification, address_info: undefined },
      })),
    };
  },

  reset() {
    state.creditsRemaining = startingCredits;
    state.creditsUsed = 0;
    state.jobs.clear();
    state.completedJobs = 0;
  },
  };
}
