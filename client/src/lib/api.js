/**
 * Browser -> Express proxy. The browser never sees the NeverBounce secret key.
 * The preferred mode (live/mock) is sent as a header; the server falls back to
 * mock automatically if no API key is configured.
 */
const API_BASE = import.meta.env.VITE_API_BASE || '';

let preferredMode = 'live';
export function setApiMode(mode) {
  preferredMode = mode;
}

export class ApiRequestError extends Error {
  constructor(message, { status = 0, code = 'unknown', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        'x-verifier-mode': preferredMode,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiRequestError('Cannot reach the verifier server. Make sure it is running (npm run dev).', {
      code: 'network_error',
      retryable: true,
    });
  }

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON: usually the Vite proxy reporting the backend is down.
  }

  if (!res.ok) {
    const fallback =
      res.status === 502 || res.status === 503 || res.status === 504 || (res.status === 500 && !data)
        ? 'The verifier server is unavailable. Make sure it is running on port 4000.'
        : `Request failed (HTTP ${res.status}).`;
    throw new ApiRequestError(data?.error?.message || fallback, {
      status: res.status,
      code: data?.error?.code || (data ? 'http_error' : 'server_unavailable'),
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  return data;
}

export const api = {
  status: () => request('/api/status'),
  account: () => request('/api/account'),
  verifySingle: (email) => request('/api/verify/single', { method: 'POST', body: { email, source: 'manual' } }),
  createBulkJob: (emails, filename) => request('/api/verify/bulk', { method: 'POST', body: { emails, filename, source: 'csv_import' } }),
  previewBulk: (emails) => request('/api/verify/bulk/preview', { method: 'POST', body: { emails } }),
  bulkStatus: (jobId, signal) => request(`/api/verify/bulk/${encodeURIComponent(jobId)}`, { signal }),
  bulkResults: (jobId) => request(`/api/verify/bulk/${encodeURIComponent(jobId)}/results`),
  resetMock: () => request('/api/mock/reset', { method: 'POST' }),
  providers: () => request('/api/providers'),
  switchProvider: (provider) => request('/api/providers/switch', { method: 'POST', body: { provider } }),
  // Email registry — always through this app's backend; the registry token never reaches the browser.
  registryStats: () => request('/api/registry/stats'),
  registryRecords: (params = {}, signal) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return request(`/api/registry/records${qs ? `?${qs}` : ''}`, { signal });
  },
  registryRecord: (id) => request(`/api/registry/records/${encodeURIComponent(id)}`),
  registryLookup: (emails) => request('/api/registry/lookup', { method: 'POST', body: { emails } }),
};
