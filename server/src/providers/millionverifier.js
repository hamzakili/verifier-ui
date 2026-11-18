/**
 * MillionVerifier adapter (https://developer.millionverifier.com/).
 *
 *   Single:  GET  {apiUrl}?api=KEY&email=…&timeout=…           (Real-Time API v3)
 *   Credits: GET  {apiUrl}credits?api=KEY
 *   Bulk:    POST {bulkApiUrl}upload?key=KEY   (multipart field "file_contents")
 *            GET  {bulkApiUrl}fileinfo?key=KEY&file_id=…
 *            GET  {bulkApiUrl}download?key=KEY&file_id=…&filter=all   (CSV report)
 *
 * MillionVerifier returns most errors as HTTP 200 with an "error" string, so every
 * response body is checked. Implements the same normalized interface as
 * neverbounceAdapter.js. The API key is only ever placed in outbound request URLs.
 */
import Papa from 'papaparse';
import { ApiError } from '../errors.js';

/** Flags MillionVerifier actually reports. Others (DNS/MX/SMTP) are "not provided", not "No". */
export const MILLIONVERIFIER_FLAGS = ['free_email_host', 'role_account'];

// MillionVerifier result -> app status. Inconclusive results stay "unknown", never guessed.
const RESULT_MAP = {
  ok: 'valid',
  catch_all: 'catchall',
  unknown: 'unknown',
  disposable: 'disposable',
  invalid: 'invalid',
  unverified: 'unknown',
};
export const mapMillionVerifierResult = (r) => RESULT_MAP[String(r ?? '').trim().toLowerCase()] || 'unknown';

// Bulk file status -> app stage
const BULK_STAGE = {
  in_queue_to_start: 'queued',
  in_progress: 'verifying',
  finished: 'complete',
  paused: 'failed',
  canceled: 'failed',
  error: 'failed',
};

const SINGLE_TIMEOUT_S = 20; // MillionVerifier allows 2–60s
const REQUEST_TIMEOUT_MS = 30_000;
const SINGLE_REQUEST_TIMEOUT_MS = (SINGLE_TIMEOUT_S + 10) * 1000;
const BULK_TRANSFER_TIMEOUT_MS = 120_000;

const UNAVAILABLE_HINT = 'You can retry shortly, or switch to NeverBounce manually.';

/** Map a MillionVerifier error string to a clean ApiError (never includes the key). */
export function millionVerifierError(message) {
  const m = String(message || '').toLowerCase();
  if (/api ?key|invalid_api_key|apikey_not_found/.test(m)) {
    return new ApiError(401, 'auth_failure', 'MillionVerifier rejected the API key. Check MILLIONVERIFIER_API_KEY.');
  }
  if (m.includes('insufficient')) {
    return new ApiError(402, 'insufficient_credits', 'Your MillionVerifier account does not have enough credits for this request.');
  }
  if (m.includes('ip address') || m.includes('blocked')) {
    return new ApiError(403, 'ip_blocked', 'MillionVerifier blocked requests from this server’s IP address.');
  }
  if (m.includes('file_not_found') || m.includes('file not found')) {
    return new ApiError(404, 'job_not_found', 'MillionVerifier could not find this bulk file.');
  }
  if (m.includes('no email')) return new ApiError(400, 'missing_email', 'Please provide an email address.');
  if (m.includes('limit') || m.includes('too many')) {
    return new ApiError(429, 'rate_limited', 'MillionVerifier rate limit reached. Please wait a moment and retry.');
  }
  return new ApiError(503, 'provider_unavailable', `MillionVerifier is temporarily unavailable (${String(message).slice(0, 120)}). ${UNAVAILABLE_HINT}`);
}

function safeFilename(name) {
  const base = String(name || 'upload').replace(/[^\w.\- ]+/g, '_').replace(/\.[^.]*$/, '').slice(0, 80) || 'upload';
  return `${base}.csv`;
}

export function createMillionVerifierAdapter({ apiKey, apiUrl, bulkApiUrl, fetchImpl = (...a) => fetch(...a) }) {
  const singleUrl = (params) => {
    const u = new URL(apiUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u;
  };
  const creditsUrl = () => {
    const u = new URL('credits', apiUrl);
    u.searchParams.set('api', apiKey);
    return u;
  };
  const bulkUrl = (path, params = {}) => {
    const u = new URL(path, bulkApiUrl);
    u.searchParams.set('key', apiKey);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u;
  };

  async function call(url, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS, expect = 'json' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method,
        body,
        signal: controller.signal,
        headers: { Accept: expect === 'json' ? 'application/json' : 'text/csv, application/octet-stream, */*' },
      });
      text = await res.text();
    } catch (err) {
      const msg =
        err.name === 'AbortError'
          ? `MillionVerifier did not respond in time. ${UNAVAILABLE_HINT}`
          : `Could not reach MillionVerifier. ${UNAVAILABLE_HINT}`;
      throw new ApiError(503, 'provider_unavailable', msg);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new ApiError(429, 'rate_limited', 'MillionVerifier rate limit reached. Please wait a moment and retry.');
    }

    const contentType = res.headers.get('content-type') || '';
    let data = null;
    if (expect === 'json' || contentType.includes('json')) {
      try {
        data = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }

    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      throw millionVerifierError(data.error);
    }
    if (res.status >= 500) {
      throw new ApiError(503, 'provider_unavailable', `MillionVerifier returned HTTP ${res.status}. ${UNAVAILABLE_HINT}`);
    }
    if (!res.ok) throw new ApiError(502, 'upstream_error', `MillionVerifier returned HTTP ${res.status}.`);

    if (expect === 'json') {
      if (!data || typeof data !== 'object') {
        throw new ApiError(502, 'upstream_error', 'MillionVerifier returned an unexpected (non-JSON) response.');
      }
      return data;
    }
    return text;
  }

  async function fileInfo(fileId) {
    return call(bulkUrl('fileinfo', { file_id: fileId }));
  }

  return {
    async getCredits() {
      const d = await call(creditsUrl());
      if (typeof d.credits !== 'number') {
        throw new ApiError(502, 'upstream_error', 'MillionVerifier did not return a credit balance.');
      }
      return {
        creditsRemaining: d.credits,
        details: {
          bulkCredits: d.bulk_credits ?? null,
          renewingCredits: d.renewing_credits ?? null,
          plan: d.plan ?? null,
        },
      };
    },

    async verifySingle(email) {
      const started = Date.now();
      const d = await call(singleUrl({ api: apiKey, email, timeout: SINGLE_TIMEOUT_S }), { timeoutMs: SINGLE_REQUEST_TIMEOUT_MS });
      if (d.resultcode === 4 || d.result === 'error') throw millionVerifierError(d.error || 'verification error');

      const result = mapMillionVerifierResult(d.result);
      const flags = [];
      if (d.free === true) flags.push('free_email_host');
      if (d.role === true) flags.push('role_account');
      if (result === 'disposable') flags.push('disposable_email');

      return {
        result,
        flags,
        availableFlags: MILLIONVERIFIER_FLAGS,
        suggestedCorrection: d.didyoumean || '',
        addressInfo: null,
        executionTime: Date.now() - started,
        // MillionVerifier charges 1 credit per live verification; demo/test keys report livemode=false.
        creditsUsed: d.livemode === false ? 0 : 1,
        creditsRemaining: typeof d.credits === 'number' ? d.credits : null,
        providerDetails: {
          result: d.result,
          resultcode: d.resultcode,
          subresult: d.subresult,
          quality: d.quality,
          livemode: d.livemode,
        },
      };
    },

    async createJob(rows, filename) {
      const csv = Papa.unparse({ fields: ['email'], data: rows.map((r) => [r.email]) });
      const form = new FormData();
      form.append('file_contents', new Blob([csv], { type: 'text/csv' }), safeFilename(filename));
      const d = await call(bulkUrl('upload'), { method: 'POST', body: form, timeoutMs: BULK_TRANSFER_TIMEOUT_MS });
      if (!d.file_id) throw new ApiError(502, 'upstream_error', 'MillionVerifier did not return a file id for the upload.');
      return String(d.file_id);
    },

    async jobStatus(fileId) {
      const d = await fileInfo(fileId);
      const stage = BULK_STAGE[d.status] || 'queued';
      let failureReason = null;
      if (d.status === 'paused') {
        failureReason =
          'MillionVerifier paused this file (often due to insufficient credits). Resume it in your MillionVerifier dashboard, then press Retry.';
      } else if (d.status === 'canceled') {
        failureReason = 'This file was canceled in MillionVerifier.';
      } else if (d.status === 'error') {
        failureReason = d.error || 'MillionVerifier reported an error while processing this file.';
      }
      return {
        rawStatus: d.status,
        stage,
        percent: stage === 'complete' ? 100 : Number(d.percent) || 0,
        total: Number(d.total_rows) || 0,
        processed: Number(d.verified) || 0,
        billable: Number(d.credit) || 0,
        counts: {
          valid: Number(d.ok) || 0,
          invalid: Number(d.invalid) || 0,
          disposable: Number(d.disposable) || 0,
          catchall: Number(d.catch_all) || 0,
          unknown: Number(d.unknown) || 0,
        },
        failureReason,
      };
    },

    async jobResults(fileId) {
      // Never download before MillionVerifier reports the file as finished.
      const info = await fileInfo(fileId);
      if (info.status !== 'finished') {
        throw new ApiError(409, 'job_not_complete', `File is ${info.status}; results are not ready yet.`);
      }

      const csv = await call(bulkUrl('download', { file_id: fileId, filter: 'all' }), {
        expect: 'text',
        timeoutMs: BULK_TRANSFER_TIMEOUT_MS,
      });
      const parsed = Papa.parse(String(csv).replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' });
      const fields = parsed.meta.fields || [];
      const col = (name) => fields.find((f) => f.trim().toLowerCase() === name);
      const emailCol = col('email');
      const resultCol = col('result');
      const freeCol = col('free');
      const roleCol = col('role');
      const didYouMeanCol = col('didyoumean');
      if (!emailCol || !resultCol) {
        throw new ApiError(502, 'upstream_error', 'MillionVerifier returned a report in an unexpected format.');
      }

      const yes = (v) => String(v ?? '').trim().toLowerCase() === 'yes' || String(v).toLowerCase() === 'true';
      const results = [];
      parsed.data.forEach((row, i) => {
        const email = String(row[emailCol] ?? '').trim();
        if (!email) return;
        const result = mapMillionVerifierResult(row[resultCol]);
        const flags = [];
        if (freeCol && yes(row[freeCol])) flags.push('free_email_host');
        if (roleCol && yes(row[roleCol])) flags.push('role_account');
        if (result === 'disposable') flags.push('disposable_email');
        results.push({
          id: String(i),
          email,
          result,
          flags,
          suggestedCorrection: didYouMeanCol ? String(row[didYouMeanCol] || '') : '',
        });
      });

      return { results, creditsUsed: Number(info.credit) || results.length };
    },
  };
}
