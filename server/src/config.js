/**
 * Reads and validates server configuration once at startup.
 * API keys are kept here and in the provider adapters only — never sent to the client.
 */
import { PROVIDER_IDS, FALLBACK_DEFAULT_PROVIDER } from './providers/registry.js';

const DEFAULT_MV_API_URL = 'https://api.millionverifier.com/api/v3/';
const DEFAULT_MV_BULK_URL = 'https://bulkapi.millionverifier.com/bulkapi/v2/';

function httpsUrl(value, fallback, name, warnings) {
  const raw = (value || '').trim();
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') throw new Error('must use https');
    return u.href.endsWith('/') ? u.href : `${u.href}/`;
  } catch {
    warnings.push(`${name} is not a valid https URL; using ${fallback}`);
    return fallback;
  }
}

function positiveInt(value, fallback, allowZero = false) {
  const n = Number(value);
  return Number.isInteger(n) && (n > 0 || (allowZero && n === 0)) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const warnings = [];

  let defaultProvider = (env.DEFAULT_VERIFICATION_PROVIDER || '').trim().toLowerCase();
  if (!defaultProvider) {
    defaultProvider = FALLBACK_DEFAULT_PROVIDER;
  } else if (!PROVIDER_IDS.includes(defaultProvider)) {
    warnings.push(
      `DEFAULT_VERIFICATION_PROVIDER="${defaultProvider}" is not supported (use ${PROVIDER_IDS.join(' or ')}); using ${FALLBACK_DEFAULT_PROVIDER}`,
    );
    defaultProvider = FALLBACK_DEFAULT_PROVIDER;
  }

  const config = {
    port: Number(env.PORT) || 4000,
    corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    maxBulkEmails: Number(env.MAX_BULK_EMAILS) || 25_000,
    mockStartingCredits: Number(env.MOCK_STARTING_CREDITS) || 10_000,
    defaultProvider,
    providers: {
      millionverifier: {
        apiKey: (env.MILLIONVERIFIER_API_KEY || '').trim(),
        apiUrl: httpsUrl(env.MILLIONVERIFIER_API_URL, DEFAULT_MV_API_URL, 'MILLIONVERIFIER_API_URL', warnings),
        bulkApiUrl: httpsUrl(env.MILLIONVERIFIER_BULK_API_URL, DEFAULT_MV_BULK_URL, 'MILLIONVERIFIER_BULK_API_URL', warnings),
      },
      neverbounce: {
        apiKey: (env.NEVERBOUNCE_API_KEY || '').trim(),
      },
    },
    // Centralized email registry: the Laravel Email Registry API (server-side only; the token never reaches the browser).
    registryApi: {
      url: (env.EMAIL_REGISTRY_API_URL || '').trim().replace(/\/+$/, ''),
      token: (env.EMAIL_REGISTRY_API_TOKEN || '').trim(),
      timeoutMs: positiveInt(env.EMAIL_REGISTRY_TIMEOUT, 15_000),
      connectTimeoutMs: positiveInt(env.EMAIL_REGISTRY_CONNECT_TIMEOUT, 5_000),
    },
    registryOptions: {
      // block (default): refuse to verify when the registry can't be checked; provider: verify anyway.
      fallback: (env.EMAIL_REGISTRY_FALLBACK || 'block').trim().toLowerCase() === 'provider' ? 'provider' : 'block',
      // Re-verify stored results older than this many days (0 = reuse forever).
      maxAgeDays: positiveInt(env.EMAIL_REGISTRY_MAX_AGE_DAYS, 0, true),
      // Saves per minute; keep below the registry's API_RATE_LIMIT (Laravel default 120/min per IP).
      saveRatePerMinute: positiveInt(env.EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE, 90),
    },
    warnings,
  };

  const reg = config.registryApi;
  config.registryEnabled = false;
  const enabledFlag = (env.EMAIL_REGISTRY_ENABLED ?? '').trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(enabledFlag)) {
    warnings.push('EMAIL_REGISTRY_ENABLED=false: the email registry is switched off; every email goes straight to the provider');
  } else if (reg.url || reg.token) {
    let ok = true;
    try {
      const u = new URL(reg.url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
        warnings.push('EMAIL_REGISTRY_API_URL must use https:// unless it points to this machine (the token is sent with every request); registry DISABLED');
        ok = false;
      }
    } catch {
      warnings.push('EMAIL_REGISTRY_API_URL is not a valid URL; registry DISABLED');
      ok = false;
    }
    if (!reg.token) {
      warnings.push(
        env.EMAIL_REGISTRY_API_KEY
          ? 'EMAIL_REGISTRY_API_KEY is no longer used: set EMAIL_REGISTRY_API_TOKEN (the Laravel REGISTRY_API_TOKEN); registry DISABLED'
          : 'EMAIL_REGISTRY_API_TOKEN is missing; registry DISABLED',
      );
      ok = false;
    }
    config.registryEnabled = ok;
  } else {
    warnings.push('Email registry is not configured (EMAIL_REGISTRY_API_URL / EMAIL_REGISTRY_API_TOKEN); every email goes straight to the provider');
  }

  for (const id of PROVIDER_IDS) {
    if (!config.providers[id].apiKey) {
      warnings.push(`${id} has no API key configured; it will run in Mock Sandbox mode only`);
    }
  }
  if (!config.providers[defaultProvider].apiKey) {
    warnings.push(`The default provider (${defaultProvider}) is not configured — requests will use the Mock Sandbox until a key is added`);
  }

  return config;
}
