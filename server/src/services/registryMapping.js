/**
 * Mapping between this app's verification results and Laravel Email Registry records.
 *
 * App results:       valid | invalid | disposable | catchall | unknown
 * Registry `result`: valid | invalid | risky | unverifiable | unknown   (status: pending | completed | failed)
 *
 *   valid -> valid, invalid -> invalid, disposable -> risky, catchall -> risky, unknown -> unknown
 *
 * `risky` is lossy, so the exact app result (plus flags, suggestion and provider details) is also
 * stored in `metadata`. Records written by this app therefore read back exactly; records written
 * by other clients fall back to the coarse mapping in fromRegistryRecord().
 */
import { MILLIONVERIFIER_FLAGS } from '../providers/millionverifier.js';
import { NEVERBOUNCE_FLAGS } from '../providers/neverbounceAdapter.js';

export const APP_RESULTS = ['valid', 'invalid', 'disposable', 'catchall', 'unknown'];
export const REGISTRY_PROVIDERS = ['millionverifier', 'neverbounce', 'other'];
const TO_REGISTRY = { valid: 'valid', invalid: 'invalid', disposable: 'risky', catchall: 'risky', unknown: 'unknown' };
const FROM_REGISTRY = { valid: 'valid', invalid: 'invalid', risky: 'catchall', unverifiable: 'unknown', unknown: 'unknown' };
const PROVIDER_NAMES = { millionverifier: 'MillionVerifier', neverbounce: 'NeverBounce' };

/** One normalization everywhere — identical to Laravel's EmailVerification::normalizeEmail(). */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function availableFlagsFor(provider) {
  return provider === 'millionverifier' ? MILLIONVERIFIER_FLAGS : NEVERBOUNCE_FLAGS;
}

/**
 * Body for POST /email-verifications (an upsert by normalized email).
 * @param r        provider result { result, flags, availableFlags, suggestedCorrection, providerDetails, creditsUsed }
 * @param context  { email, provider, source }
 */
export function toRegistryPayload(r, { email, provider, source = 'manual' }) {
  const result = APP_RESULTS.includes(r.result) ? r.result : 'unknown';
  const native = r.providerDetails?.subresult || r.providerDetails?.result || result;
  return {
    email: normalizeEmail(email),
    status: 'completed',
    result: TO_REGISTRY[result],
    provider: REGISTRY_PROVIDERS.includes(provider) ? provider : 'other',
    reason: `${PROVIDER_NAMES[provider] || 'Provider'}: ${result}${native && native !== result ? ` (${native})` : ''}`.slice(0, 500),
    metadata: {
      source: 'verifier-ui',
      origin: source, // manual | csv_import | api
      app_result: result,
      flags: r.flags || [],
      available_flags: r.availableFlags || availableFlagsFor(provider),
      suggested_correction: r.suggestedCorrection || '',
      provider_details: r.providerDetails || null,
      credits_used: Number(r.creditsUsed ?? 1),
    },
  };
}

/** A record the app may reuse instead of paying for a new verification. */
export function isUsable(record, { maxAgeDays = 0, now = Date.now() } = {}) {
  if (!record || record.status !== 'completed' || !record.result) return false;
  if (maxAgeDays > 0) {
    const at = Date.parse(record.verified_at || record.updated_at || '');
    if (!Number.isFinite(at) || now - at > maxAgeDays * 86_400_000) return false; // outdated -> re-verify
  }
  return true;
}

/** Registry record -> the app's result shape (works for records written by other clients too). */
export function fromRegistryRecord(record) {
  const m = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const result = APP_RESULTS.includes(m.app_result) ? m.app_result : FROM_REGISTRY[record.result] || 'unknown';
  const provider = PROVIDER_NAMES[record.provider] ? record.provider : null;
  return {
    result,
    flags: Array.isArray(m.flags) ? m.flags : [],
    availableFlags: Array.isArray(m.available_flags) ? m.available_flags : [],
    suggestedCorrection: typeof m.suggested_correction === 'string' ? m.suggested_correction : '',
    providerDetails: { ...(m.provider_details || {}), registry_result: record.result, registry_reason: record.reason ?? null },
    provider,
    mode: 'live',
    verifiedAt: record.verified_at || record.updated_at || null,
    registryId: record.id != null ? String(record.id) : null,
  };
}
