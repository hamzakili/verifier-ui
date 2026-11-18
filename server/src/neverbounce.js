/**
 * Thin client for the NeverBounce v4.2 REST API.
 * Docs: https://developers.neverbounce.com/reference
 *
 * The secret key lives only here (server-side) and is never sent to the browser.
 */
import { ApiError, fromNeverBounce } from './errors.js';

const BASE_URL = 'https://api.neverbounce.com/v4.2';
const REQUEST_TIMEOUT_MS = 60_000;

export function createNeverBounceClient(apiKey) {
  async function call(path, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(`${BASE_URL}/${path}`);
    const init = { method, headers: { Accept: 'application/json' } };

    if (method === 'GET') {
      url.searchParams.set('key', apiKey);
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ key: apiKey, ...body });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'NeverBounce request timed out.' : 'Could not reach NeverBounce.';
      throw new ApiError(504, 'network_error', msg);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new ApiError(429, 'rate_limited', 'NeverBounce rate limit reached. Please wait a moment and retry.');
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(502, 'upstream_error', `NeverBounce returned a non-JSON response (HTTP ${res.status}).`);
    }

    if (data.status !== 'success') throw fromNeverBounce(data);
    return data;
  }

  return {
    accountInfo() {
      return call('account/info');
    },

    singleCheck(email) {
      return call('single/check', {
        query: { email, address_info: 1, credits_info: 1, timeout: 30 },
      });
    },

    /** rows: array of { email, id } */
    createJob(rows, filename) {
      return call('jobs/create', {
        method: 'POST',
        body: {
          input_location: 'supplied',
          input: rows.map((r) => ({ id: r.id, email: r.email })),
          filename,
          auto_parse: 1,
          auto_start: 1,
        },
      });
    },

    startJob(jobId) {
      return call('jobs/start', { method: 'POST', body: { job_id: jobId } });
    },

    jobStatus(jobId) {
      return call('jobs/status', { query: { job_id: jobId } });
    },

    jobResults(jobId, page = 1, itemsPerPage = 1000) {
      return call('jobs/results', {
        query: { job_id: jobId, page, items_per_page: itemsPerPage },
      });
    },
  };
}
