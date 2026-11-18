/**
 * Email-first verification against the Laravel Email Registry API.
 * Real Express app + real emailRegistryService over HTTP to an in-process double of the Laravel API
 * (test/helpers/fakeRegistry.js), with stubbed MillionVerifier / NeverBounce APIs that count every call.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { startFakeRegistry } from './helpers/fakeRegistry.js';

const realFetch = globalThis.fetch;
let reg; // fake Laravel registry
const apps = [];
let calls; // provider calls

const resultFor = (email) => (email.includes('bad') ? 'invalid' : email.includes('tmp') ? 'disposable' : email.includes('maybe') ? 'unknown' : 'ok');
const resetCalls = () => {
  calls = { mvSingle: [], mvUploads: [], nbSingle: [] };
};

async function startApp(env = {}) {
  const config = loadConfig({
    MILLIONVERIFIER_API_KEY: 'MVKEY_test', NEVERBOUNCE_API_KEY: 'private_nbtest', MOCK_STARTING_CREDITS: '1000',
    EMAIL_REGISTRY_API_URL: reg.url, EMAIL_REGISTRY_API_TOKEN: reg.token, EMAIL_REGISTRY_TIMEOUT: '3000', EMAIL_REGISTRY_CONNECT_TIMEOUT: '2000',
    EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE: '6000',
    ...env,
  });
  const created = createApp(config, { centralTiming: { pollMs: 50 } });
  const server = await new Promise((r) => {
    const s = created.app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const a = {
    ...created,
    server,
    base,
    post: (p, body, headers = {}) =>
      realFetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json(), raw: r })),
    get: (p, headers = {}) => realFetch(`${base}${p}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() })),
  };
  apps.push(a);
  return a;
}

let A; // default app (fallback = block)

before(async () => {
  resetCalls();
  reg = await startFakeRegistry();
  const files = new Map();
  let fileSeq = 100;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.millionverifier.com') {
      if (u.pathname.endsWith('/credits')) return Response.json({ credits: 5000, bulk_credits: 5000, renewing_credits: 0, plan: 1 });
      const email = u.searchParams.get('email');
      calls.mvSingle.push(email);
      await new Promise((r) => setTimeout(r, 30));
      const r = resultFor(email);
      return Response.json({ email, quality: 'good', result: r, resultcode: 1, subresult: r, free: email.endsWith('gmail.com'), role: false, didyoumean: '', credits: 4999, executiontime: 1, error: '', livemode: true });
    }
    if (u.hostname === 'bulkapi.millionverifier.com') {
      if (u.pathname.endsWith('/upload')) {
        const text = await init.body.get('file_contents').text();
        const emails = Papa.parse(text, { header: true, skipEmptyLines: true }).data.map((r) => r.email);
        const id = String(++fileSeq);
        files.set(id, emails);
        calls.mvUploads.push(emails);
        return Response.json({ file_id: id, status: 'in_progress', error: '' });
      }
      const id = u.searchParams.get('file_id');
      const emails = files.get(id);
      if (u.pathname.endsWith('/fileinfo')) {
        return Response.json({ file_id: id, status: 'finished', percent: 100, total_rows: emails.length, verified: emails.length, credit: emails.length, ok: 0, catch_all: 0, disposable: 0, invalid: 0, unknown: 0, error: '' });
      }
      if (u.pathname.endsWith('/download')) {
        const csv = Papa.unparse({ fields: ['email', 'quality', 'result', 'free', 'role'], data: emails.map((e) => [e, 'good', resultFor(e), 'no', 'no']) });
        return new Response(csv, { headers: { 'content-type': 'application/octet-stream' } });
      }
    }
    if (u.hostname === 'api.neverbounce.com') {
      if (u.pathname.endsWith('/account/info')) return Response.json({ status: 'success', credits_info: { paid_credits_remaining: 900, free_credits_remaining: 0 } });
      calls.nbSingle.push(u.searchParams.get('email'));
      return Response.json({ status: 'success', result: 'valid', flags: ['has_dns', 'has_dns_mx'], suggested_correction: '', credits_info: { paid_credits_used: 1, free_credits_used: 0, paid_credits_remaining: 899, free_credits_remaining: 0 }, execution_time: 120 });
    }
    return realFetch(url, init);
  };
  A = await startApp();
});

after(async () => {
  for (const a of apps) {
    a.central.shutdown();
    a.server.close();
  }
  globalThis.fetch = realFetch;
  await reg.close();
});

beforeEach(async () => {
  resetCalls();
  reg.reset();
  for (const a of apps) await a.post('/providers/switch', { provider: 'millionverifier' });
});

async function runBulk(a, emails, headers = {}) {
  const created = await a.post('/verify/bulk', { emails, filename: 'x.csv' }, headers);
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  let s;
  for (let i = 0; i < 200; i++) {
    s = (await a.get(`/verify/bulk/${created.body.jobId}`)).body;
    if (s.stage === 'complete' || s.stage === 'failed') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(s.stage, 'complete', JSON.stringify(s));
  const results = (await a.get(`/verify/bulk/${created.body.jobId}/results`)).body;
  return { created: created.body, status: s, results };
}
const regCalls = (method, path) => reg.state.calls.filter((c) => c.method === method && c.path === path);

// ---------------------------------------------------------------------------- single

test('single: registry lookup happens BEFORE the provider; a new result is saved with the mapped fields', async () => {
  const r = await A.post('/verify/single', { email: ' New.Person@Corp.com ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.mvSingle, ['New.Person@Corp.com']);
  const order = reg.state.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(order, ['POST /api/email-verifications/lookup', 'POST /api/email-verifications']);
  assert.deepEqual(regCalls('POST', '/api/email-verifications/lookup')[0].body, { emails: ['new.person@corp.com'] });
  assert.equal(reg.state.calls[0].auth, `Bearer ${reg.token}`);

  const rec = reg.byEmail('new.person@corp.com');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.result, 'valid');
  assert.equal(rec.provider, 'millionverifier');
  assert.equal(rec.metadata.source, 'verifier-ui');
  assert.equal(rec.metadata.origin, 'manual');
  assert.equal(rec.metadata.app_result, 'valid');
  assert.match(rec.reason, /MillionVerifier: valid/);

  assert.equal(r.body.result, 'valid');
  assert.equal(r.body.cached, false);
  assert.equal(r.body.stored, true);
  assert.equal(r.body.creditsUsed, 1);
  assert.deepEqual(r.body.registry, { lookup: 'miss', saved: true, recordId: String(rec.id) });
});

test('single: a usable registry record is returned without a provider call or credits', async () => {
  reg.seed({ email: 'known@corp.com', status: 'completed', result: 'invalid', provider: 'neverbounce', verified_at: '2026-10-01T10:00:00Z' });
  const r = await A.post('/verify/single', { email: 'Known@Corp.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.mvSingle, []);
  assert.equal(r.body.result, 'invalid');
  assert.equal(r.body.cached, true);
  assert.equal(r.body.creditsUsed, 0);
  assert.equal(r.body.provider, 'neverbounce');
  assert.equal(r.body.verifiedAt, '2026-10-01T10:00:00Z');
  assert.equal(r.body.registry.lookup, 'hit');
  assert.equal(regCalls('POST', '/api/email-verifications').length, 0); // nothing re-saved
});

test('single: results written by this app read back exactly (disposable/catchall survive the "risky" mapping)', async () => {
  const first = await A.post('/verify/single', { email: 'tmp@mailinator.com' });
  assert.equal(first.body.result, 'disposable');
  const rec = reg.byEmail('tmp@mailinator.com');
  assert.equal(rec.result, 'risky');
  assert.equal(rec.metadata.app_result, 'disposable');

  // A different app instance (no in-process memory) must read it from the registry.
  const B = await startApp();
  const again = await B.post('/verify/single', { email: 'TMP@mailinator.com' });
  assert.equal(again.body.cached, true);
  assert.equal(again.body.result, 'disposable');
  assert.deepEqual(calls.mvSingle, ['tmp@mailinator.com']);
});

test('single: records from other clients — risky/unverifiable map coarsely; pending/failed are re-verified', async () => {
  reg.seed({ email: 'r@corp.com', status: 'completed', result: 'risky', provider: 'other', verified_at: '2026-10-01T00:00:00Z' });
  reg.seed({ email: 'u@corp.com', status: 'completed', result: 'unverifiable', provider: 'other', verified_at: '2026-10-01T00:00:00Z' });
  reg.seed({ email: 'p@corp.com', status: 'pending' });
  reg.seed({ email: 'f@corp.com', status: 'failed', reason: 'timeout' });
  assert.equal((await A.post('/verify/single', { email: 'r@corp.com' })).body.result, 'catchall');
  assert.equal((await A.post('/verify/single', { email: 'u@corp.com' })).body.result, 'unknown');
  const p = await A.post('/verify/single', { email: 'p@corp.com' });
  const f = await A.post('/verify/single', { email: 'f@corp.com' });
  assert.equal(p.body.cached, false);
  assert.equal(f.body.cached, false);
  assert.deepEqual(calls.mvSingle, ['p@corp.com', 'f@corp.com']);
  assert.equal(reg.byEmail('f@corp.com').status, 'completed'); // upsert updated the existing row
  assert.equal(reg.records.size, 4); // no duplicates created
});

test('single: outdated records are re-verified when EMAIL_REGISTRY_MAX_AGE_DAYS is set', async () => {
  const B = await startApp({ EMAIL_REGISTRY_MAX_AGE_DAYS: '30' });
  reg.seed({ email: 'old@corp.com', status: 'completed', result: 'valid', provider: 'neverbounce', verified_at: '2020-01-01T00:00:00Z' });
  reg.seed({ email: 'fresh@corp.com', status: 'completed', result: 'valid', provider: 'neverbounce', verified_at: new Date().toISOString() });
  assert.equal((await B.post('/verify/single', { email: 'old@corp.com' })).body.cached, false);
  assert.equal((await B.post('/verify/single', { email: 'fresh@corp.com' })).body.cached, true);
  assert.deepEqual(calls.mvSingle, ['old@corp.com']);
  assert.equal(reg.records.size, 2);
});

test('single: concurrent requests for the same email cause one provider call', async () => {
  const rs = await Promise.all([1, 2, 3].map(() => A.post('/verify/single', { email: 'same@corp.com' })));
  assert.ok(rs.every((r) => r.status === 200 && r.body.result === 'valid'));
  assert.deepEqual(calls.mvSingle, ['same@corp.com']);
  assert.equal(rs.filter((r) => r.body.creditsUsed === 1).length, 1);
});

test('single: NeverBounce results are saved as provider=neverbounce and reused after switching to MillionVerifier', async () => {
  await A.post('/providers/switch', { provider: 'neverbounce' });
  await A.post('/verify/single', { email: 'nb@corp.com' });
  assert.equal(reg.byEmail('nb@corp.com').provider, 'neverbounce');
  await A.post('/providers/switch', { provider: 'millionverifier' });
  const r = await A.post('/verify/single', { email: 'nb@corp.com' });
  assert.equal(r.body.cached, true);
  assert.deepEqual(calls.mvSingle, []);
  assert.deepEqual(calls.nbSingle, ['nb@corp.com']);
});

test('single: Mock Sandbox never reads or writes the shared registry', async () => {
  const r = await A.post('/verify/single', { email: 'sim@corp.com' }, { 'x-verifier-mode': 'mock' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'mock');
  assert.deepEqual(r.body.registry, { lookup: 'skipped', saved: false, reason: 'mock_mode' });
  const b = await runBulk(A, ['s1@corp.com', 's2@corp.com'], { 'x-verifier-mode': 'mock' });
  assert.equal(b.results.results.length, 2);
  assert.equal(reg.state.calls.length, 0);
  assert.equal(reg.records.size, 0);
});

// ---------------------------------------------------------------------------- bulk

test('bulk: reused emails are skipped, duplicates verified once, all new results saved (upsert, no duplicates)', async () => {
  reg.seed({ email: 'old@corp.com', status: 'completed', result: 'valid', provider: 'neverbounce', verified_at: '2026-10-01T00:00:00Z' });
  const { created, status, results } = await runBulk(A, ['old@corp.com', 'A@corp.com', 'a@corp.com', 'bad@corp.com', 'maybe@corp.com']);
  assert.equal(created.reused, 1);
  assert.equal(created.toVerify, 3);
  assert.deepEqual(calls.mvUploads, [['A@corp.com', 'bad@corp.com', 'maybe@corp.com']]);
  assert.deepEqual(status.counts, { valid: 2, invalid: 1, disposable: 0, catchall: 0, unknown: 1 });
  assert.equal(results.results.find((x) => x.email === 'old@corp.com').cached, true);

  await A.central.savesIdle();
  assert.equal(reg.records.size, 4);
  assert.equal(reg.byEmail('bad@corp.com').result, 'invalid');
  assert.equal(reg.byEmail('a@corp.com').metadata.origin, 'csv_import');
  const s = (await A.get(`/verify/bulk/${created.jobId}`)).body;
  assert.deepEqual(s.registrySave, { total: 3, saved: 3, failed: 0, pending: 0 });
});

test('bulk: lookups are chunked to the registry limit of 1000 emails', async () => {
  const emails = Array.from({ length: 1500 }, (_, i) => `u${i}@corp.com`);
  const p = await A.post('/verify/bulk/preview', { emails });
  assert.equal(p.status, 200);
  assert.deepEqual(regCalls('POST', '/api/email-verifications/lookup').map((c) => c.body.emails.length), [1000, 500]);
  assert.deepEqual([p.body.total, p.body.reusable, p.body.toVerify], [1500, 0, 1500]);
});

test('bulk: overlapping imports never send the same email to the provider twice', async () => {
  const [one, two] = await Promise.all([
    runBulk(A, ['x1@corp.com', 'shared@corp.com']),
    runBulk(A, ['shared@corp.com', 'x2@corp.com']),
  ]);
  const uploaded = calls.mvUploads.flat();
  assert.equal(uploaded.filter((e) => e === 'shared@corp.com').length, 1);
  for (const r of [one, two]) assert.equal(r.results.results.find((x) => x.email === 'shared@corp.com').result, 'valid');
});

test('bulk: a just-verified result is reused even before its save reaches the registry', async () => {
  reg.state.delayMs = 0;
  const first = await runBulk(A, ['quick@corp.com']);
  assert.equal(first.results.results[0].cached, false);
  const second = await runBulk(A, ['quick@corp.com']);
  assert.equal(second.results.results[0].cached, true);
  assert.equal(calls.mvUploads.length, 1);
});

test('registry-invalid addresses are never sent to the provider (single 400, bulk "not submitted")', async () => {
  // Passes the app's syntax check but not the registry's (PHP FILTER_VALIDATE_EMAIL).
  const single = await A.post('/verify/single', { email: 'john..doe@corp.com' });
  assert.equal(single.status, 400);
  assert.equal(single.body.error.code, 'invalid_email');
  assert.deepEqual(calls.mvSingle, []);

  const p = await A.post('/verify/bulk/preview', { emails: ['john..doe@corp.com', 'ok1@corp.com'] });
  assert.deepEqual([p.body.total, p.body.invalid, p.body.toVerify, p.body.estimatedCredits], [2, 1, 1, 1]);

  const { created, status, results } = await runBulk(A, ['john..doe@corp.com', 'ok1@corp.com']);
  assert.equal(created.invalid, 1);
  assert.deepEqual(calls.mvUploads, [['ok1@corp.com']]);
  assert.equal(status.counts.invalid, 1);
  assert.equal(status.processed, 2);
  const bad = results.results.find((r) => r.email === 'john..doe@corp.com');
  assert.deepEqual([bad.result, bad.cached, bad.note], ['invalid', false, 'Invalid email format (not submitted)']);
  await A.central.savesIdle();
  assert.equal(reg.byEmail('john..doe@corp.com'), undefined); // nothing saved for it
});

test('EMAIL_REGISTRY_ENABLED=false switches the registry off even when URL and token are set', async () => {
  const B = await startApp({ EMAIL_REGISTRY_ENABLED: 'false' });
  const r = await B.post('/verify/single', { email: 'off@corp.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.registry, { lookup: 'disabled', saved: false });
  assert.equal((await B.get('/status')).body.centralDb.enabled, false);
  assert.equal(reg.state.calls.length, 0);
});

test('status: GET /health tells "registry down" apart from "token rejected"', async () => {
  const B = await startApp({ EMAIL_REGISTRY_API_TOKEN: 'wrong-token-for-status' });
  const wrong = (await B.get('/status')).body.centralDb;
  assert.deepEqual([wrong.connected, wrong.reachable], [false, true]);
  reg.state.down = true;
  const C = await startApp();
  const down = (await C.get('/status')).body.centralDb;
  assert.deepEqual([down.connected, down.reachable], [false, false]);
  assert.ok(reg.state.calls.some((c) => c.path === '/api/health'));
});

// ---------------------------------------------------------------------------- failures

test('registry down (default fallback=block): 503 registry_unavailable and nothing is sent to the provider', async () => {
  reg.state.down = true;
  const single = await A.post('/verify/single', { email: 'down@corp.com' });
  assert.equal(single.status, 503);
  assert.equal(single.body.error.code, 'registry_unavailable');
  assert.match(single.body.error.message, /nothing was sent to the verification provider/);
  const bulk = await A.post('/verify/bulk', { emails: ['d1@corp.com'] });
  assert.equal(bulk.status, 503);
  assert.deepEqual([calls.mvSingle, calls.mvUploads], [[], []]);
  const status = (await A.get('/status')).body.centralDb;
  assert.equal(status.connected, false);
});

test('registry down with EMAIL_REGISTRY_FALLBACK=provider: verified, clearly flagged, saved once the registry is back', async () => {
  const B = await startApp({ EMAIL_REGISTRY_FALLBACK: 'provider' });
  reg.state.down = true;
  const r = await B.post('/verify/single', { email: 'later@corp.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'valid');
  assert.equal(r.body.cached, false);
  assert.equal(r.body.stored, false);
  assert.equal(r.body.registry.lookup, 'unavailable');
  assert.equal(r.body.registry.saved, false);
  assert.equal(r.body.registry.error, 'registry_unavailable');
  reg.state.down = false; // queued save is retried in the background
  for (let i = 0; i < 100 && !reg.byEmail('later@corp.com'); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(reg.byEmail('later@corp.com')?.result, 'valid');
});

test('wrong registry token: requests are refused (even with fallback) and the token is reported as the cause', async () => {
  const B = await startApp({ EMAIL_REGISTRY_API_TOKEN: 'wrong-token', EMAIL_REGISTRY_FALLBACK: 'provider' });
  const r = await B.post('/verify/single', { email: 'x@corp.com' });
  assert.equal(r.status, 503);
  assert.match(r.body.error.message, /EMAIL_REGISTRY_API_TOKEN/);
  assert.deepEqual(calls.mvSingle, []);
  assert.ok(reg.state.authFailures >= 1);
  const s = await B.get('/registry/stats');
  assert.equal(s.status, 503);
  assert.equal(s.body.error.code, 'registry_unauthorized');
});

test('registry 429: requests honour Retry-After and succeed', async () => {
  reg.state.rateLimitNext = 1;
  const r = await A.post('/verify/single', { email: 'rl@corp.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, true);
  assert.equal(regCalls('POST', '/api/email-verifications/lookup').length, 2); // 429, then retry
});

// ---------------------------------------------------------------------------- registry routes for the UI

test('registry routes: stats, list with search/filters/sort, get by id, 404, batch lookup', async () => {
  for (const [email, result] of [['a1@gmail.com', 'valid'], ['a2@gmail.com', 'invalid'], ['b1@yahoo.com', 'valid']]) {
    reg.seed({ email, status: 'completed', result, provider: 'millionverifier', verified_at: '2026-10-01T00:00:00Z' });
  }
  reg.seed({ email: 'c1@yahoo.com', status: 'pending' });

  const stats = await A.get('/registry/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.stats.total, 4);
  assert.ok(stats.body.saveQueue);

  const all = await A.get('/registry/records?limit=2&page=1&sort=created_at&direction=asc');
  assert.equal(all.body.records.length, 2);
  assert.deepEqual([all.body.meta.total, all.body.meta.last_page, all.body.meta.per_page], [4, 2, 2]);
  const gmail = await A.get('/registry/records?domain=GMAIL.com&result=valid');
  assert.deepEqual(gmail.body.records.map((x) => x.email), ['a1@gmail.com']);
  assert.equal(gmail.body.records[0].app_result, 'valid');
  assert.equal(gmail.body.records[0].usable, true);
  const search = await A.get('/registry/records?search=yahoo&status=pending');
  assert.deepEqual(search.body.records.map((x) => [x.email, x.usable]), [['c1@yahoo.com', false]]);
  assert.deepEqual(Object.keys(all.body.meta).sort(), ['current_page', 'from', 'last_page', 'per_page', 'to', 'total']);
  const big = await A.get('/registry/records?limit=10000');
  assert.equal(big.body.meta.per_page, 100); // capped here

  const bad = await A.get('/registry/records?status=nope');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'registry_validation');
  assert.deepEqual(bad.body.error.details.errors.status, ['The selected status is invalid.']);

  const id = all.body.records[0].id;
  const one = await A.get(`/registry/records/${id}`);
  assert.equal(one.body.record.id, id);
  assert.equal((await A.get('/registry/records/999999')).status, 404);
  assert.equal((await A.get('/registry/records/abc')).status, 404);

  const look = await A.post('/registry/lookup', { emails: ['A1@gmail.com', 'c1@yahoo.com', 'new@x.com', 'not-an-email'] });
  assert.equal(look.status, 200);
  assert.deepEqual(look.body.summary, { requested: 4, found: 2, usable: 1, missing: 1, invalid: 1 });
  assert.deepEqual(look.body.missing, ['new@x.com']);
  assert.equal(regCalls('POST', '/api/email-verifications').length, 0); // read-only
});

test('the registry token never reaches the browser (responses, headers, errors)', async () => {
  reg.seed({ email: 'leak@corp.com', status: 'completed', result: 'valid', provider: 'neverbounce' });
  const bodies = [];
  const keep = async (p) => {
    const r = await p;
    bodies.push(JSON.stringify(r.body));
    if (r.raw) bodies.push(JSON.stringify([...r.raw.headers]));
  };
  await keep(A.get('/status'));
  await keep(A.get('/registry/stats'));
  await keep(A.get('/registry/records'));
  await keep(A.post('/registry/lookup', { emails: ['leak@corp.com'] }));
  await keep(A.post('/verify/single', { email: 'leak@corp.com' }));
  await keep(A.post('/verify/single', { email: 'fresh2@corp.com' }));
  await keep(A.get('/registry/records?status=bad'));
  reg.state.down = true;
  await keep(A.post('/verify/single', { email: 'zzz@corp.com' }));
  for (const b of bodies) assert.ok(!b.includes(reg.token), `token leaked in ${b.slice(0, 120)}`);
});

test('registry not configured: verification works as before and registry routes say not configured', async () => {
  const B = await startApp({ EMAIL_REGISTRY_API_URL: '', EMAIL_REGISTRY_API_TOKEN: '' });
  const r = await B.post('/verify/single', { email: 'plain@corp.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.registry, { lookup: 'disabled', saved: false });
  assert.equal((await B.get('/registry/records')).body.error.code, 'registry_not_configured');
  assert.equal(reg.state.calls.length, 0);
});
