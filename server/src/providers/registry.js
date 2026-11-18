/**
 * Central provider management: which providers exist, which are configured,
 * and which one is active.
 *
 * The active provider is held in memory (single-user app) and is initialised from
 * DEFAULT_VERIFICATION_PROVIDER on every start. To support per-organization settings
 * later, swap `state.active` for a lookup keyed by org id — callers only use the
 * methods below.
 */
import { ApiError } from '../errors.js';

export const PROVIDER_IDS = ['millionverifier', 'neverbounce'];
export const FALLBACK_DEFAULT_PROVIDER = 'millionverifier';

export const PROVIDER_NAMES = {
  millionverifier: 'MillionVerifier',
  neverbounce: 'NeverBounce',
};

export function createProviderRegistry(config) {
  const state = { active: config.defaultProvider };

  const isValid = (id) => PROVIDER_IDS.includes(id);
  const isConfigured = (id) => isValid(id) && Boolean(config.providers[id]?.apiKey);

  return {
    isValid,
    isConfigured,
    getDefault: () => config.defaultProvider,
    getActive: () => state.active,
    nameOf: (id) => PROVIDER_NAMES[id] || id,

    /** Masked key hint, e.g. "private_••••e656". Never the key itself. */
    keyHint(id) {
      const key = config.providers[id]?.apiKey;
      if (!key) return null;
      const prefix = /^[a-z]+_/i.test(key) ? key.split('_')[0] + '_' : '';
      return `${prefix}••••${key.slice(-4)}`;
    },

    setActive(id) {
      const pid = String(id ?? '').trim().toLowerCase();
      if (!pid) throw new ApiError(400, 'missing_provider', 'Please specify a provider.');
      if (!isValid(pid)) {
        throw new ApiError(400, 'unsupported_provider', `Unsupported provider "${String(id).slice(0, 40)}". Use one of: ${PROVIDER_IDS.join(', ')}.`);
      }
      if (!isConfigured(pid)) {
        throw new ApiError(409, 'provider_not_configured', `${PROVIDER_NAMES[pid]} is not configured on the server. Add its API key to server/.env and restart.`);
      }
      state.active = pid;
      return pid;
    },

    list() {
      return PROVIDER_IDS.map((id) => ({
        id,
        name: PROVIDER_NAMES[id],
        available: isConfigured(id),
        is_active: id === state.active,
        is_default: id === config.defaultProvider,
      }));
    },
  };
}
