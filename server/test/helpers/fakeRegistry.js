/**
 * In-process HTTP double of the Laravel Email Registry API (C:\wamp64\www\email-registry-api),
 * mirroring its routes, Bearer auth, validation rules, upsert-by-email, lookup limits, pagination
 * and JSON envelope. Lets the real emailRegistryService run over real HTTP in tests.
 */
import express from 'express';

const STATUSES = ['pending', 'completed', 'failed'];
const RESULTS = ['valid', 'invalid', 'risky', 'unverifiable', 'unknown'];
const PROVIDERS = ['millionverifier', 'neverbounce', 'other'];
// Approximates PHP FILTER_VALIDATE_EMAIL, which is stricter than the app's syntax check
// (e.g. it rejects consecutive dots or a dot right before "@").
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_RFC = { test: (e) => EMAIL_SHAPE.test(e) && !/\.\./.test(e) && !/^\.|\.@/.test(e) };

export async function startFakeRegistry({ token = 'fake-registry-token-0123456789abcdef' } = {}) {
  const records = new Map(); // id -> record
  let seq = 0;
  const state = { down: false, rateLimitNext: 0, delayMs: 0, calls: [], authFailures: 0 };
  const now = () => new Date().toISOString();
  const norm = (e) => String(e ?? '').trim().toLowerCase();
  const byEmail = (email) => [...records.values()].find((r) => r.email === email);
  const ok = (res, message, data, status = 200, meta) => res.status(status).json({ success: true, message, data, ...(meta ? { meta } : {}) });
  const fail = (res, message, status, errors = {}) => res.status(status).json({ success: false, message, errors });

  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    state.calls.push({ method: req.method, path: req.path, query: { ...req.query }, auth: req.get('authorization') || null, body: req.body });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.down) return res.socket.destroy(); // connection reset
    if (state.rateLimitNext > 0) {
      state.rateLimitNext -= 1;
      res.set('Retry-After', '1');
      return fail(res, 'Too many requests. Please slow down.', 429);
    }
    next();
  });
  app.get('/api/health', (req, res) => ok(res, 'API is healthy.', { api: 'ok', database: 'ok' }));
  app.use('/api', (req, res, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
    if (!m || m[1] !== token) {
      state.authFailures += 1;
      return res.status(401).json({ success: false, message: 'Unauthorized. Invalid API token.' });
    }
    next();
  });

  app.get('/api/health/registry', (req, res) => {
    const all = [...records.values()];
    const count = (k, v) => all.filter((r) => r[k] === v).length;
    ok(res, 'Registry statistics retrieved successfully.', {
      total: all.length,
      by_status: Object.fromEntries(STATUSES.map((s) => [s, count('status', s)])),
      by_result: Object.fromEntries(RESULTS.map((s) => [s, count('result', s)])),
      by_provider: {},
      last_updated_at: null,
      timestamp: now(),
    });
  });

  app.get('/api/email-verifications', (req, res) => {
    const q = req.query;
    const errors = {};
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) errors.limit = ['The limit must be between 1 and 500.'];
    if (q.status && !STATUSES.includes(q.status)) errors.status = ['The selected status is invalid.'];
    if (q.result && !RESULTS.includes(q.result)) errors.result = ['The selected result is invalid.'];
    if (q.sort && !['created_at', 'verified_at', 'updated_at'].includes(q.sort)) errors.sort = ['The selected sort is invalid.'];
    if (Object.keys(errors).length) return fail(res, 'The given data was invalid.', 422, errors);
    let list = [...records.values()];
    if (q.search) list = list.filter((r) => r.email.includes(String(q.search).toLowerCase()));
    for (const f of ['status', 'result', 'provider']) if (q[f]) list = list.filter((r) => r[f] === q[f]);
    if (q.domain) list = list.filter((r) => r.domain === norm(q.domain));
    const dir = q.direction === 'asc' ? 1 : -1;
    const sort = q.sort || 'created_at';
    list.sort((a, b) => (String(a[sort]).localeCompare(String(b[sort])) || a.id - b.id) * dir);
    const page = Math.max(1, Number(q.page) || 1);
    const items = list.slice((page - 1) * limit, page * limit);
    ok(res, 'Email records retrieved successfully.', items, 200, {
      current_page: page, per_page: limit, total: list.length, last_page: Math.max(1, Math.ceil(list.length / limit)),
      from: items.length ? (page - 1) * limit + 1 : null, to: items.length ? (page - 1) * limit + items.length : null,
    });
  });

  app.post('/api/email-verifications/lookup', (req, res) => {
    const emails = req.body?.emails;
    if (!Array.isArray(emails) || emails.length < 1 || emails.length > 1000) {
      return fail(res, 'The given data was invalid.', 422, { emails: ['The emails must be an array of 1 to 1000 items.'] });
    }
    const valid = new Set();
    const invalid = new Set();
    for (const raw of emails) {
      const e = norm(raw);
      if (EMAIL_RFC.test(e)) valid.add(e);
      else invalid.add(raw);
    }
    const found = [...valid].map(byEmail).filter(Boolean);
    const missing = [...valid].filter((e) => !byEmail(e));
    ok(res, 'Lookup completed successfully.', {
      found, missing, invalid: [...invalid],
      summary: { requested: emails.length, unique: valid.size, found: found.length, missing: missing.length, invalid: invalid.size },
    });
  });

  function validateFields(b, { create }) {
    const errors = {};
    if (create && (typeof b.email !== 'string' || !EMAIL_RFC.test(norm(b.email)) || b.email.length > 254)) errors.email = ['The email must be a valid email address.'];
    if ((create || 'status' in b) && !STATUSES.includes(b.status)) errors.status = ['The selected status is invalid.'];
    if (b.result != null && !RESULTS.includes(b.result)) errors.result = ['The selected result is invalid.'];
    if (create && b.status === 'completed' && !b.result) errors.result = ['The result field is required when status is completed.'];
    if (b.provider != null && !PROVIDERS.includes(b.provider)) errors.provider = ['The selected provider is invalid.'];
    if (create && b.status === 'completed' && !b.provider) errors.provider = ['The provider field is required when status is completed.'];
    if (b.metadata != null && (typeof b.metadata !== 'object' || Array.isArray(b.metadata))) errors.metadata = ['The metadata must be an array.'];
    if (!create && ('email' in b || 'id' in b || 'domain' in b)) errors.email = ['The email address cannot be modified.'];
    return errors;
  }
  const fields = (b) => {
    const out = {};
    for (const k of ['status', 'result', 'reason', 'provider', 'provider_reference', 'metadata', 'verified_at']) if (k in b) out[k] = b[k] ?? null;
    return out;
  };

  app.post('/api/email-verifications', (req, res) => {
    const b = req.body || {};
    const errors = validateFields(b, { create: true });
    if (Object.keys(errors).length) return fail(res, 'The given data was invalid.', 422, errors);
    const email = norm(b.email);
    const at = now();
    const verified = b.verified_at || (b.status === 'completed' ? at : null);
    let rec = byEmail(email);
    if (rec) {
      Object.assign(rec, { result: null, reason: null, provider: null, provider_reference: null, metadata: null }, fields(b), { verified_at: verified, updated_at: at });
      return ok(res, 'Email record updated successfully.', rec, 200);
    }
    rec = { id: ++seq, email, domain: email.split('@')[1], status: 'pending', result: null, reason: null, provider: null, provider_reference: null, metadata: null, ...fields(b), verified_at: verified, created_at: at, updated_at: at };
    records.set(rec.id, rec);
    ok(res, 'Email record created successfully.', rec, 201);
  });

  const find = (req, res) => {
    const rec = records.get(Number(req.params.id));
    if (!rec) fail(res, 'Email record not found.', 404);
    return rec;
  };
  app.get('/api/email-verifications/:id(\\d+)', (req, res) => {
    const rec = find(req, res);
    if (rec) ok(res, 'Email record retrieved successfully.', rec);
  });
  app.put('/api/email-verifications/:id(\\d+)', (req, res) => {
    const rec = find(req, res);
    if (!rec) return;
    const errors = validateFields(req.body || {}, { create: false });
    if (Object.keys(errors).length) return fail(res, 'The given data was invalid.', 422, errors);
    Object.assign(rec, fields(req.body), { updated_at: now() });
    ok(res, 'Email record updated successfully.', rec);
  });
  app.delete('/api/email-verifications/:id(\\d+)', (req, res) => {
    const rec = find(req, res);
    if (!rec) return;
    records.delete(rec.id);
    ok(res, 'Email record deleted successfully.', { id: rec.id });
  });
  app.use('/api', (req, res) => fail(res, 'Resource not found.', 404));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/api`,
    token,
    records,
    state,
    /** Insert a record as another client would. */
    seed(rec) {
      const at = now();
      const full = { id: ++seq, domain: rec.email.split('@')[1], result: null, reason: null, provider: null, provider_reference: null, metadata: null, verified_at: null, created_at: at, updated_at: at, ...rec };
      records.set(full.id, full);
      return full;
    },
    byEmail,
    reset() {
      records.clear();
      Object.assign(state, { down: false, rateLimitNext: 0, delayMs: 0, calls: [], authFailures: 0 });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
