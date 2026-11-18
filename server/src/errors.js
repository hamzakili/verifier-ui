/**
 * A normalized error the routes can turn into a clean JSON response.
 * `code` is a stable machine-readable identifier the UI can switch on.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// NeverBounce returns HTTP 200 with a `status` field for most failures.
// Map those to meaningful HTTP status codes for the frontend.
const NB_STATUS_MAP = {
  auth_failure: [401, 'auth_failure', 'NeverBounce rejected the API key. Check NEVERBOUNCE_API_KEY.'],
  bad_referrer: [403, 'bad_referrer', 'NeverBounce rejected the request origin (bad referrer).'],
  throttle_triggered: [429, 'rate_limited', 'NeverBounce rate limit reached. Please wait a moment and retry.'],
  temp_unavail: [503, 'temp_unavailable', 'NeverBounce is temporarily unavailable. Please retry shortly.'],
  general_failure: [502, 'general_failure', 'NeverBounce returned a general failure.'],
};

export function fromNeverBounce(body) {
  const mapped = NB_STATUS_MAP[body?.status];
  const message = body?.message ? `${mapped?.[2] ?? 'NeverBounce error'} (${body.message})` : mapped?.[2];
  if (mapped) return new ApiError(mapped[0], mapped[1], message);
  return new ApiError(502, 'upstream_error', body?.message || 'Unexpected response from NeverBounce.');
}
