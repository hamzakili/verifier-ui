/**
 * HTTP-level tests against the real Express app on a random port.
 * Upstream MillionVerifier calls are answered by a stubbed fetch; nothing real is called.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const realFetch = globalThis.fetch;
const upstreamCalls = [];
let server;
let base;

before(async () => {
  // Stub only provider hosts; local requests to the test server pass through.
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.millionverifier.com') {
      upstreamCalls.push(u);
      if (u.pathname.endsWith('/credits')) return Response.json({ credits: 777, bulk_credits: 777, renewing_credits: 0, plan: 1 });
      return Response.json({
        email: u.searchParams.get('email'), quality: 'good', result: 'ok', resultcode: 1, subresult: 'ok',
        free: false, role: false, didyoumean: '', credits: 776, executiontime: 1, error: '', livemode: true,
      });
    }
    if (u.hostname.endsWith('neverbounce.com')) throw new Error('NeverBounce must not be called in these tests');
    return realFetch(url, init);
  };

  const config = loadConfig({ MILLIONVERIFIER_API_KEY: 'TESTKEY_mv_abcd', MOCK_STARTING_CREDITS: '500' });
  const created = createApp(config);
  await new Promise((r) => {
    server = created.app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});

const get = (p, headers = {}) => realFetch(`${base}${p}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body, headers = {}) =>
  realFetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  );

test('GET /api/providers: MillionVerifier is default and active', async () => {
  const { status, body } = await get('/providers');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.default_provider, 'millionverifier');
  assert.equal(body.active_provider, 'millionverifier');
  assert.deepEqual(body.providers.map((p) => [p.id, p.available]), [['millionverifier', true], ['neverbounce', false]]);
  assert.ok(!JSON.stringify(body).includes('TESTKEY'));
});

test('POST /api/providers/switch validation', async () => {
  let r = await post('/providers/switch', { provider: 'mailchimp' });
  assert.equal(r.status, 400);
  assert.equal(r.body.success, false);
  r = await post('/providers/switch', { provider: 'neverbounce' }); // no key configured
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'provider_not_configured');
  r = await post('/providers/switch', { provider: 'millionverifier' });
  assert.equal(r.status, 200);
  assert.equal(r.body.active_provider, 'millionverifier');
});

test('credits come from the active provider (live) and mock stays separate', async () => {
  const live = await get('/account');
  assert.equal(live.body.provider, 'millionverifier');
  assert.equal(live.body.mode, 'live');
  assert.equal(live.body.creditsRemaining, 777);
  const mock = await get('/account', { 'x-verifier-mode': 'mock' });
  assert.equal(mock.body.mode, 'mock');
  assert.equal(mock.body.creditsRemaining, 500);
});

test('single verification via MillionVerifier keeps the old fields and adds normalized ones', async () => {
  const { status, body } = await post('/verify/single', { email: 'kim@corp.com' });
  assert.equal(status, 200);
  // existing shape
  assert.equal(body.result, 'valid');
  assert.equal(body.email, 'kim@corp.com');
  assert.equal(body.creditsUsed, 1);
  assert.equal(body.creditsRemaining, 776);
  assert.ok(Array.isArray(body.flags));
  // additions
  assert.equal(body.success, true);
  assert.equal(body.provider, 'millionverifier');
  assert.equal(body.verification.status, 'valid');
  assert.equal(body.verification.is_valid, true);
  assert.equal(body.verification.is_free, false);
  assert.equal(body.credits_used, 1);
  assert.equal(body.error, null);
  assert.ok(!JSON.stringify(body).includes('TESTKEY'));
  assert.equal(upstreamCalls.at(-1).searchParams.get('email'), 'kim@corp.com');
});

test('invalid input is rejected before any credit is spent', async () => {
  const before = upstreamCalls.length;
  assert.equal((await post('/verify/single', { email: 'not-an-email' })).status, 400);
  assert.equal((await post('/verify/single', {})).status, 400);
  assert.equal((await post('/verify/bulk', { emails: ['nope', ''] })).status, 400);
  assert.equal(upstreamCalls.length, before);
});

test('mock bulk flow: duplicate submission is reused, results cached, job ids routed', { timeout: 40_000 }, async () => {
  const h = { 'x-verifier-mode': 'mock' };
  const emails = ['a@corp.com', 'A@corp.com', 'b@mailinator.com', 'c@gmial.com', 'bad'];
  const first = await post('/verify/bulk', { emails, filename: 't.csv' }, h);
  assert.equal(first.status, 201);
  assert.equal(first.body.uniqueEmails, 3);
  assert.equal(first.body.provider, 'millionverifier');
  assert.match(first.body.jobId, /^mv-mock_/);

  const dup = await post('/verify/bulk', { emails: [...emails].reverse(), filename: 't.csv' }, h);
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.jobId, first.body.jobId);

  let s;
  for (let i = 0; i < 30; i++) {
    s = (await get(`/verify/bulk/${first.body.jobId}`)).body;
    if (s.stage === 'complete') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(s.stage, 'complete');

  const [r1, r2] = await Promise.all([get(`/verify/bulk/${first.body.jobId}/results`), get(`/verify/bulk/${first.body.jobId}/results`)]);
  assert.equal(r1.body.results.length, 3);
  assert.deepEqual(r1.body, r2.body);
  assert.equal(r1.body.creditsUsed, 3);
  const byEmail = Object.fromEntries(r1.body.results.map((r) => [r.email, r.result]));
  assert.equal(byEmail['b@mailinator.com'], 'disposable');
  assert.equal(byEmail['c@gmial.com'], 'invalid');

  // Mock credits only debited once, and only from the MillionVerifier sandbox.
  const mock = await get('/account', h);
  assert.equal(mock.body.creditsRemaining, 497);

  // After completion, the same list may be submitted again as a new job.
  const again = await post('/verify/bulk', { emails, filename: 't.csv' }, h);
  assert.notEqual(again.body.jobId, first.body.jobId);
});

test('unknown job ids return a clean 404', async () => {
  const r = await get('/verify/bulk/mock_1001');
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
});
