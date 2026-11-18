import express from 'express';
import cors from 'cors';
import { ApiError } from './errors.js';
import { createProviderRegistry } from './providers/registry.js';
import { createVerificationService } from './verification.js';
import { createCentralVerification } from './central.js';
import { fromRegistryRecord, isUsable } from './services/registryMapping.js';
import { createEmailRegistryService } from './services/emailRegistryService.js';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Minimal fixed-window rate limiter (per IP) to protect credits from runaway clients. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) {
      return next(new ApiError(429, 'rate_limited', 'Too many verification requests. Please slow down and retry in a minute.'));
    }
    next();
  };
}

/** Normalized, provider-independent view of a single result (spec format). */
function verificationSummary(result, flags, availableFlags, providerDetails) {
  const has = (f) => (availableFlags.includes(f) ? flags.includes(f) : null);
  return {
    status: result,
    is_valid: result === 'valid',
    is_disposable: result === 'disposable',
    is_role: has('role_account'),
    is_free: has('free_email_host'),
    is_catchall: result === 'catchall',
    subresult: providerDetails?.subresult ?? null,
    quality: providerDetails?.quality ?? null,
  };
}

const SOURCES = ['manual', 'api', 'csv_import'];
const sourceOf = (req, fallback) => (SOURCES.includes(req.body?.source) ? req.body.source : fallback);

/**
 * @param config  from loadConfig()
 * @param options.store  optional registry client (tests inject one); otherwise the Laravel Email
 *                       Registry API client is used when EMAIL_REGISTRY_API_URL / _TOKEN are set.
 */
export function createApp(config, { store: injectedStore, centralTiming } = {}) {
  const registry = createProviderRegistry(config);
  const service = createVerificationService({ config, registry });
  const store =
    injectedStore === undefined ? (config.registryEnabled ? createEmailRegistryService(config.registryApi) : null) : injectedStore;
  const central = createCentralVerification({ service, store, options: config.registryOptions, timing: centralTiming });
  const requestedMode = (req) => (req.get('x-verifier-mode') === 'mock' ? 'mock' : 'live');

  let healthCache = { at: 0, value: null };
  async function dbHealth() {
    if (!store) return { enabled: false, connected: false, tableExists: false, error: null };
    if (Date.now() - healthCache.at > 30_000 || !healthCache.value?.connected) {
      const h = await store.health();
      healthCache = { at: Date.now(), value: { enabled: true, connected: h.connected, reachable: h.reachable, tableExists: h.tableExists, error: h.error, total: h.stats?.total ?? null } };
    }
    return { ...healthCache.value, ...central.registryStatus() };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '5mb' }));

  // --- health & status ----------------------------------------------------------

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  /** Connection status for the active provider. Never returns a key. */
  app.get(
    '/api/status',
    asyncRoute(async (req, res) => {
      const { provider, mode } = service.resolve(requestedMode(req));
      res.json({
        liveAvailable: registry.isConfigured(provider),
        mode,
        keyHint: registry.keyHint(provider),
        maxBulkEmails: config.maxBulkEmails,
        provider,
        providerName: registry.nameOf(provider),
        defaultProvider: registry.getDefault(),
        centralDb: await dbHealth(),
      });
    }),
  );

  // --- provider management -----------------------------------------------------

  app.get('/api/providers', (req, res) => {
    res.json({
      success: true,
      default_provider: registry.getDefault(),
      active_provider: registry.getActive(),
      providers: registry.list(),
    });
  });

  app.post('/api/providers/switch', (req, res) => {
    const active = registry.setActive(req.body?.provider);
    console.log(`[providers] active provider -> ${active}`);
    res.json({
      success: true,
      message: 'Verification provider switched successfully.',
      active_provider: active,
      providers: registry.list(),
    });
  });

  // --- credits -----------------------------------------------------------------

  app.get(
    '/api/account',
    asyncRoute(async (req, res) => {
      req.verificationProvider = registry.getActive();
      const c = await service.credits(requestedMode(req));
      res.json({
        mode: c.mode,
        provider: c.provider,
        providerName: registry.nameOf(c.provider),
        creditsRemaining: c.creditsRemaining,
        ...c.details,
      });
    }),
  );

  // --- verification ------------------------------------------------------------

  const verifyLimiter = rateLimit({ windowMs: 60_000, max: 60 });

  app.post(
    '/api/verify/single',
    verifyLimiter,
    asyncRoute(async (req, res) => {
      req.verificationProvider = registry.getActive();
      const email = String(req.body?.email ?? '').trim();
      if (!email) throw new ApiError(400, 'missing_email', 'Please provide an email address.');
      if (email.length > 254) throw new ApiError(400, 'invalid_email', 'Email address is too long.');
      if (!EMAIL_SHAPE.test(email)) throw new ApiError(400, 'invalid_email', 'That is not a valid email address.');

      // Email-first: the central registry is checked before any provider call.
      const r = await central.verifySingle(email, requestedMode(req), { source: sourceOf(req, 'manual') });
      res.json({
        // Existing fields (unchanged for the current frontend)
        mode: r.mode,
        email,
        result: r.result,
        flags: r.flags,
        suggestedCorrection: r.suggestedCorrection,
        addressInfo: r.addressInfo,
        executionTime: r.executionTime,
        creditsUsed: r.creditsUsed,
        creditsRemaining: r.creditsRemaining,
        checkedAt: new Date().toISOString(),
        // Provider-aware additions
        success: true,
        provider: r.provider,
        providerName: r.provider ? registry.nameOf(r.provider) : 'Central database',
        availableFlags: r.availableFlags,
        verification: verificationSummary(r.result, r.flags, r.availableFlags, r.providerDetails),
        credits_used: r.creditsUsed,
        providerDetails: r.providerDetails,
        error: null,
        // Central registry additions
        cached: Boolean(r.cached),
        verifiedAt: r.verifiedAt ?? null,
        stored: r.cached ? true : Boolean(r.stored),
        registry: r.registry ?? { lookup: 'disabled', saved: false },
      });
    }),
  );

  /** Validate, trim and de-duplicate (case-insensitive) a bulk email list. */
  function uniqueEmails(input) {
    if (!Array.isArray(input) || input.length === 0) {
      throw new ApiError(400, 'missing_emails', 'Provide a non-empty "emails" array.');
    }
    const seen = new Set();
    const rows = [];
    for (const raw of input) {
      const email = String(raw ?? '').trim();
      const key = email.toLowerCase();
      if (!email || email.length > 254 || !EMAIL_SHAPE.test(email) || seen.has(key)) continue;
      seen.add(key);
      rows.push({ id: String(rows.length), email });
    }
    if (rows.length === 0) throw new ApiError(400, 'no_valid_emails', 'No syntactically valid email addresses were found.');
    if (rows.length > config.maxBulkEmails) {
      throw new ApiError(413, 'too_many_emails', `This proxy accepts up to ${config.maxBulkEmails.toLocaleString()} unique emails per job.`);
    }
    return rows;
  }

  /**
   * Read-only estimate before a bulk run: how many emails are already in the central
   * registry (free) vs. need a provider call. Never claims or charges anything.
   */
  app.post(
    '/api/verify/bulk/preview',
    asyncRoute(async (req, res) => {
      const rows = uniqueEmails(req.body?.emails);
      if (!central.enabled) {
        return res.json({ centralDb: false, total: rows.length, reusable: 0, pendingElsewhere: 0, toVerify: rows.length, estimatedCredits: rows.length });
      }
      const p = await central.preview(rows.map((r) => r.email), requestedMode(req));
      res.json({ centralDb: p.registry !== 'skipped', ...p, estimatedCredits: p.toVerify });
    }),
  );

  /**
   * Create a bulk job. Body: { emails: string[], filename?: string }
   * Emails are de-duplicated (case-insensitive) so each unique address costs 1 credit.
   */
  app.post(
    '/api/verify/bulk',
    verifyLimiter,
    asyncRoute(async (req, res) => {
      req.verificationProvider = registry.getActive();
      const input = req.body?.emails;
      const rows = uniqueEmails(input);

      const filename = String(req.body?.filename || `upload-${Date.now()}.csv`).slice(0, 120);
      // Email-first: reused / in-progress emails are never sent to the provider.
      const job = await central.createBulkJob(rows, filename, requestedMode(req), { source: sourceOf(req, 'csv_import') });

      res.status(job.duplicate ? 200 : 201).json({
        mode: job.mode,
        jobId: job.jobId,
        submitted: input.length,
        uniqueEmails: rows.length,
        skipped: input.length - rows.length,
        provider: job.provider,
        providerName: registry.nameOf(job.provider),
        duplicate: job.duplicate,
        // Central registry additions (absent when no database is configured)
        reused: job.reused ?? 0,
        pendingElsewhere: job.pendingElsewhere ?? 0,
        invalid: job.invalid ?? 0, // rejected as malformed by the registry; not sent to the provider
        toVerify: job.toVerify ?? rows.length,
      });
    }),
  );

  app.get(
    '/api/verify/bulk/:jobId',
    asyncRoute(async (req, res) => {
      const s = await central.bulkStatus(req.params.jobId);
      req.verificationProvider = s.provider;
      res.json(s);
    }),
  );

  app.get(
    '/api/verify/bulk/:jobId/results',
    asyncRoute(async (req, res) => {
      const r = await central.bulkResults(req.params.jobId);
      res.json(r);
    }),
  );

  // --- email registry (browser -> this server -> Laravel; the token stays here) ---------

  const registryLimiter = rateLimit({ windowMs: 60_000, max: 120 });
  const requireRegistry = (req, res, next) =>
    store ? next() : next(new ApiError(503, 'registry_not_configured', 'The email registry is not configured on the server (EMAIL_REGISTRY_API_URL / EMAIL_REGISTRY_API_TOKEN).'));

  /** Registry statistics (GET /health/registry). */
  app.get(
    '/api/registry/stats',
    registryLimiter,
    requireRegistry,
    asyncRoute(async (req, res) => {
      res.json({ success: true, stats: await store.stats(), ...central.registryStatus() });
    }),
  );

  /** List/search records: page, limit (<= 100 here), search, status, result, provider, domain, sort, direction. */
  app.get(
    '/api/registry/records',
    registryLimiter,
    requireRegistry,
    asyncRoute(async (req, res) => {
      const q = req.query;
      const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit, 10) || 25));
      const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
      const pick = (k) => (typeof q[k] === 'string' ? q[k].slice(0, 254) : undefined);
      const r = await store.list({
        page, limit, search: pick('search'), status: pick('status'), result: pick('result'), provider: pick('provider'),
        domain: pick('domain'), sort: pick('sort'), direction: pick('direction'),
      });
      // Drop next/prev_page_url: they point at the internal Laravel URL, which the browser never needs.
      const { current_page, per_page, total, last_page, from, to } = r.meta;
      res.json({ success: true, records: r.records.map(registryView), meta: { current_page, per_page, total, last_page, from, to } });
    }),
  );

  app.get(
    '/api/registry/records/:id',
    registryLimiter,
    requireRegistry,
    asyncRoute(async (req, res) => {
      if (!/^\d{1,19}$/.test(req.params.id)) throw new ApiError(404, 'registry_not_found', 'Email record not found.');
      res.json({ success: true, record: registryView(await store.get(req.params.id)) });
    }),
  );

  /** Batch lookup (read-only): which of these emails already have a record. */
  app.post(
    '/api/registry/lookup',
    registryLimiter,
    requireRegistry,
    asyncRoute(async (req, res) => {
      const input = req.body?.emails;
      if (!Array.isArray(input) || input.length === 0) throw new ApiError(400, 'missing_emails', 'Provide a non-empty "emails" array.');
      if (input.length > 5000) throw new ApiError(413, 'too_many_emails', 'Look up at most 5,000 emails at a time.');
      const emails = input.map((e) => String(e ?? '').trim()).filter((e) => e && e.length <= 254);
      if (!emails.length) throw new ApiError(400, 'no_valid_emails', 'No email addresses were provided.');
      const { found, missing, invalid } = await store.lookup(emails);
      const records = [...found.values()].map(registryView);
      res.json({
        success: true,
        found: records,
        missing,
        invalid,
        summary: { requested: input.length, found: records.length, usable: records.filter((r) => r.usable).length, missing: missing.length, invalid: invalid.length },
      });
    }),
  );

  /** Registry record + the app's interpretation (exact result, usable for reuse or not). */
  function registryView(rec) {
    const app = fromRegistryRecord(rec);
    return { ...rec, app_result: app.result, usable: isUsable(rec, { maxAgeDays: config.registryOptions.maxAgeDays }) };
  }

  /** Reset the mock sandbox balances. */
  app.post('/api/mock/reset', (req, res) => {
    service.resetMock();
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: { code: 'not_found', message: `No route for ${req.method} ${req.originalUrl}` } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const send = (status, code, message, details) =>
      res.status(status).json({
        success: false,
        provider: req.verificationProvider ?? undefined,
        error: { code, message, ...(details ? { details } : {}) },
      });

    if (err.type === 'entity.too.large') return send(413, 'payload_too_large', 'Upload is too large for a single request.');
    if (err instanceof SyntaxError && 'body' in err) return send(400, 'bad_json', 'Malformed JSON body.');
    const isApi = err instanceof ApiError;
    if (!isApi || err.status >= 500) console.error('[error]', isApi ? `${err.code}: ${err.message}` : err);
    send(isApi ? err.status : 500, err.code || 'internal_error', isApi ? err.message : 'Unexpected server error.', isApi && err.status === 422 ? err.details : undefined);
  });

  return { app, registry, service, central, store };
}
