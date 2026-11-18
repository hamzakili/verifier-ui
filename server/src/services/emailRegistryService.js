/**
 * Client for the Laravel Email Registry API (separate project, e.g. http://127.0.0.1:8000/api).
 *
 * Server-side only: the bearer token lives in server/.env (EMAIL_REGISTRY_API_TOKEN) and is sent
 * only in the Authorization header of requests made here. It is never logged, never put in an
 * error message and never returned to the browser.
 *
 * Laravel envelope:  success -> { success: true, message, data, meta? }
 *                    failure -> { success: false, message, errors }
 *
 * Reliability:
 *  - connectTimeoutMs: abort when the server has not started responding (headers) in time.
 *  - timeoutMs: abort the whole request (including the body) after this long.
 *  - Every operation used here is idempotent (GET, PUT, DELETE, read-only lookup, and
 *    POST /email-verifications which is an upsert by email), so network errors, 5xx and 429
 *    are retried with backoff; 429 honours Retry-After.
 *  - Failures become ApiError with a stable code:
 *      registry_unavailable (503)   network error, timeout, 5xx, non-JSON reply
 *      registry_unauthorized (503)  401: the server's token is wrong (a configuration problem)
 *      registry_not_found (404)     404 from show/update/delete
 *      registry_validation (422)    422, with Laravel's field errors in `details`
 *      registry_rate_limited (429)  429 after retries
 */
import { ApiError } from '../errors.js';
import { normalizeEmail } from './registryMapping.js';

export const LOOKUP_MAX = 1000; // LookupEmailVerificationRequest::MAX_EMAILS
const LIST_PARAMS = ['page', 'limit', 'search', 'status', 'result', 'provider', 'domain', 'sort', 'direction'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UNAVAILABLE = 'The email registry is temporarily unavailable.';

export function createEmailRegistryService({
  url,
  token,
  timeoutMs = 15_000,
  connectTimeoutMs = 5_000,
  retries = 2,
  maxRetryWaitMs = 10_000,
  fetchImpl = (...a) => fetch(...a),
  logger = console,
}) {
  if (!url || !token) throw new Error('createEmailRegistryService requires url and token');
  const base = url.replace(/\/+$/, '');

  /** Structured log line without secrets or query strings (which may contain emails). */
  function log(level, event, fields) {
    logger[level]?.(`[registry] ${JSON.stringify({ event, ...fields })}`);
  }

  async function request(method, path, { query, body, retry = true } = {}) {
    const qs = query ? new URLSearchParams(query).toString() : '';
    const target = `${base}${path}${qs ? `?${qs}` : ''}`;
    const attempts = retry ? retries + 1 : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      let phase = 'connect';
      const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      let text;
      let failure = null;
      try {
        res = await fetchImpl(target, {
          method,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        clearTimeout(connectTimer);
        phase = 'body';
        text = await res.text();
      } catch (err) {
        failure = err.name === 'AbortError' ? (phase === 'connect' ? 'connect_timeout' : 'timeout') : 'network_error';
      } finally {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
      }

      const ms = Date.now() - started;
      if (failure) {
        if (attempt < attempts) {
          await sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        log('warn', 'registry_request_failed', { method, path, reason: failure, attempt, ms });
        const e = new ApiError(503, 'registry_unavailable', UNAVAILABLE);
        e.reason = failure;
        throw e;
      }

      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* e.g. an HTML error page from a proxy */
      }
      if (res.ok && data && data.success !== false) return { status: res.status, data };

      const status = res.status;
      const retryable = status === 429 || status >= 500 || !data;
      if (retryable && attempt < attempts) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, maxRetryWaitMs) : 300 * 2 ** (attempt - 1));
        continue;
      }

      log(status >= 500 || status === 401 ? 'error' : 'warn', 'registry_request_failed', { method, path, status, attempt, ms });
      throw toError(status, data);
    }
    throw new ApiError(503, 'registry_unavailable', UNAVAILABLE); // not reached
  }

  function toError(status, data) {
    if (status === 401) {
      return new ApiError(503, 'registry_unauthorized', 'The email registry rejected the server\'s API token. Check EMAIL_REGISTRY_API_TOKEN in server/.env.');
    }
    if (status === 404) return new ApiError(404, 'registry_not_found', data?.message || 'Email record not found.');
    if (status === 422) {
      return new ApiError(422, 'registry_validation', data?.message || 'The email registry rejected the data.', sanitizeErrors(data?.errors));
    }
    if (status === 429) return new ApiError(429, 'registry_rate_limited', 'The email registry is rate limiting requests. Please retry shortly.');
    if (status >= 500 || !data) return new ApiError(503, 'registry_unavailable', UNAVAILABLE);
    return new ApiError(502, 'registry_error', `The email registry rejected the request (HTTP ${status}).`);
  }

  /** Only field -> [string] validation messages are passed on (never exception details). */
  function sanitizeErrors(errors) {
    if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(errors)) {
      if (k === 'exception') continue;
      if (Array.isArray(v)) out[k] = v.filter((m) => typeof m === 'string').slice(0, 5);
    }
    return Object.keys(out).length ? { errors: out } : undefined;
  }

  const expect = (cond, what) => {
    if (!cond) throw new ApiError(503, 'registry_unavailable', `Unexpected response from the email registry (${what}).`);
  };

  return {
    enabled: true,

    /** GET /health/registry — statistics; used as the authenticated connectivity check. */
    async stats() {
      const { data } = await request('GET', '/health/registry', { retry: false });
      expect(data.data && typeof data.data.total === 'number', 'stats');
      return data.data;
    },

    /** GET /health — public liveness check of the Laravel app and its database (no token needed). */
    async ping() {
      const { data } = await request('GET', '/health', { retry: false });
      return data.data;
    },

    /**
     * Connectivity for the status endpoint. `connected` means the authenticated registry works;
     * `reachable` tells "Laravel is down" apart from "Laravel is up but rejects our token".
     */
    async health() {
      try {
        const stats = await this.stats();
        return { connected: true, reachable: true, tableExists: true, error: null, stats };
      } catch (err) {
        let reachable = err.code === 'registry_unauthorized';
        if (!reachable) reachable = await this.ping().then(() => true, () => false);
        return { connected: false, reachable, tableExists: false, error: err.message, code: err.code };
      }
    },

    /** GET /email-verifications — pagination, search, filters, sorting (unknown params are dropped). */
    async list(params = {}) {
      const query = {};
      for (const k of LIST_PARAMS) {
        const v = params[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') query[k] = String(v).trim();
      }
      const { data } = await request('GET', '/email-verifications', { query });
      expect(Array.isArray(data.data) && data.meta, 'list');
      return { records: data.data, meta: data.meta };
    },

    /** GET /email-verifications/{id} */
    async get(id) {
      const { data } = await request('GET', `/email-verifications/${encodeURIComponent(id)}`);
      return data.data;
    },

    /**
     * POST /email-verifications/lookup (read-only), chunked to the server's 1000-email limit.
     * Returns { found: Map(normalizedEmail -> record), missing: string[], invalid: string[] }.
     */
    async lookup(emails) {
      const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
      const found = new Map();
      const missing = [];
      const invalid = [];
      for (let i = 0; i < unique.length; i += LOOKUP_MAX) {
        const { data } = await request('POST', '/email-verifications/lookup', { body: { emails: unique.slice(i, i + LOOKUP_MAX) } });
        const d = data.data;
        expect(d && Array.isArray(d.found) && Array.isArray(d.missing), 'lookup');
        for (const rec of d.found) found.set(normalizeEmail(rec.email), rec);
        missing.push(...d.missing);
        invalid.push(...(d.invalid || []));
      }
      return { found, missing, invalid };
    },

    /** POST /email-verifications — create, or update the existing record for that email. */
    async save(payload) {
      const { status, data } = await request('POST', '/email-verifications', { body: payload });
      return { record: data.data, created: status === 201 };
    },

    /** PUT /email-verifications/{id} */
    async update(id, fields) {
      const { data } = await request('PUT', `/email-verifications/${encodeURIComponent(id)}`, { body: fields });
      return data.data;
    },

    /** DELETE /email-verifications/{id} */
    async remove(id) {
      const { data } = await request('DELETE', `/email-verifications/${encodeURIComponent(id)}`);
      return data.data;
    },
  };
}
