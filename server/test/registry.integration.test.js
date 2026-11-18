/**
 * Integration test against the REAL Laravel Email Registry API.
 * Skipped unless these are set (never in CI by default):
 *   REGISTRY_IT_URL    e.g. http://127.0.0.1:8000/api
 *   REGISTRY_IT_TOKEN  the Laravel REGISTRY_API_TOKEN
 *
 * Writes only addresses under a unique per-run domain (…@verifier-it-<run>.example.com) and deletes
 * every record it created at the end. Provider APIs are stubbed: no credits are spent.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailRegistryService } from '../src/services/emailRegistryService.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const URL_ = process.env.REGISTRY_IT_URL;
const TOKEN = process.env.REGISTRY_IT_TOKEN;
const skip = !URL_ || !TOKEN ? 'set REGISTRY_IT_URL and REGISTRY_IT_TOKEN to run against the real Laravel API' : false;

const run = Math.random().toString(36).slice(2, 8);
const D = `verifier-it-${run}.example.com`;
const realFetch = globalThis.fetch;
let registry;
let server;
let base;
let central;
const providerCalls = [];

before(async () => {
  if (skip) return;
  registry = createEmailRegistryService({ url: URL_, token: TOKEN });
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.millionverifier.com') {
      if (u.pathname.endsWith('/credits')) return Response.json({ credits: 100, bulk_credits: 100, renewing_credits: 0, plan: 1 });
      const email = u.searchParams.get('email');
      providerCalls.push(email);
      const r = email.startsWith('bad') ? 'invalid' : email.startsWith('tmp') ? 'disposable' : 'ok';
      return Response.json({ email, quality: 'good', result: r, resultcode: 1, subresult: r, free: false, role: false, didyoumean: '', credits: 99, executiontime: 1, error: '', livemode: true });
    }
    if (u.hostname.endsWith('millionverifier.com') || u.hostname.endsWith('neverbounce.com')) throw new Error(`unexpected provider call ${u.host}`);
    return realFetch(url, init);
  };
  const config = loadConfig({ MILLIONVERIFIER_API_KEY: 'mv', EMAIL_REGISTRY_API_URL: URL_, EMAIL_REGISTRY_API_TOKEN: TOKEN });
  const created = createApp(config);
  central = created.central;
  await new Promise((r) => {
    server = created.app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  // Clean up everything this run created.
  const { records } = await registry.list({ domain: D, limit: 500 });
  for (const r of records) await registry.remove(r.id);
  const left = await registry.list({ domain: D });
  assert.equal(left.meta.total, 0);
  central.shutdown();
  server.close();
  globalThis.fetch = realFetch;
});

const raw = (path, init = {}) => realFetch(`${URL_}${path}`, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}) } });

test('authentication: no token / wrong token -> 401; correct token -> 200', { skip }, async () => {
  assert.equal((await raw('/email-verifications')).status, 401);
  assert.equal((await raw('/email-verifications', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await raw('/email-verifications', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  const bad = createEmailRegistryService({ url: URL_, token: 'wrong-token', logger: { warn() {}, error() {} } });
  await assert.rejects(bad.stats(), (e) => e.code === 'registry_unauthorized');
});

test('stats (GET /health/registry)', { skip }, async () => {
  const s = await registry.stats();
  assert.equal(typeof s.total, 'number');
  assert.ok(s.by_status && s.by_result);
});

test('save (upsert), get, update, list with search/domain/status filters, lookup', { skip }, async () => {
  const a = await registry.save({ email: `Alice@${D}`, status: 'completed', result: 'valid', provider: 'millionverifier', reason: 'it', metadata: { source: 'verifier-ui', run } });
  assert.equal(a.created, true);
  assert.equal(a.record.email, `alice@${D}`);
  assert.equal(a.record.domain, D);

  const again = await registry.save({ email: `alice@${D}`, status: 'completed', result: 'invalid', provider: 'neverbounce' });
  assert.equal(again.created, false);
  assert.equal(again.record.id, a.record.id); // duplicate prevention

  const got = await registry.get(a.record.id);
  assert.equal(got.result, 'invalid');

  const upd = await registry.update(a.record.id, { result: 'risky', reason: 'updated by integration test' });
  assert.deepEqual([upd.result, upd.reason], ['risky', 'updated by integration test']);
  await assert.rejects(registry.update(a.record.id, { email: `other@${D}` }), (e) => e.code === 'registry_validation');

  await registry.save({ email: `pending@${D}`, status: 'pending' });
  const byDomain = await registry.list({ domain: D, sort: 'created_at', direction: 'asc' });
  assert.equal(byDomain.meta.total, 2);
  const pending = await registry.list({ domain: D, status: 'pending' });
  assert.deepEqual(pending.records.map((r) => r.email), [`pending@${D}`]);
  const search = await registry.list({ search: `alice@${D}` });
  assert.deepEqual(search.records.map((r) => r.id), [a.record.id]);
  await assert.rejects(registry.list({ status: 'bogus' }), (e) => e.status === 422);

  const look = await registry.lookup([`ALICE@${D}`, `nobody@${D}`, 'not-an-email', `john..doe@${D}`]);
  assert.deepEqual([...look.found.keys()], [`alice@${D}`]);
  assert.deepEqual(look.missing, [`nobody@${D}`]);
  assert.deepEqual(look.invalid.sort(), [`john..doe@${D}`, 'not-an-email'].sort()); // FILTER_VALIDATE_EMAIL
  assert.equal((await registry.ping()).database, 'ok'); // public GET /health

  await assert.rejects(registry.get(999999999), (e) => e.code === 'registry_not_found');
});

test('app workflow: lookup -> verify -> save -> next request served from the registry', { skip }, async () => {
  const post = (p, body) => realFetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const first = await post('/verify/single', { email: `tmp.user@${D}` });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.cached, false);
  assert.equal(first.body.stored, true);
  assert.equal(first.body.result, 'disposable');
  const rec = (await registry.lookup([`tmp.user@${D}`])).found.get(`tmp.user@${D}`);
  assert.deepEqual([rec.status, rec.result, rec.provider, rec.metadata.app_result], ['completed', 'risky', 'millionverifier', 'disposable']);

  // A fresh app instance (no in-process memory) gets it from Laravel without a provider call.
  const config = loadConfig({ MILLIONVERIFIER_API_KEY: 'mv', EMAIL_REGISTRY_API_URL: URL_, EMAIL_REGISTRY_API_TOKEN: TOKEN });
  const other = createApp(config);
  const s2 = await new Promise((r) => {
    const s = other.app.listen(0, () => r(s));
  });
  const second = await realFetch(`http://127.0.0.1:${s2.address().port}/api/verify/single`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `TMP.User@${D}` }),
  }).then((r) => r.json());
  s2.close();
  other.central.shutdown();
  assert.equal(second.cached, true);
  assert.equal(second.result, 'disposable');
  assert.equal(second.creditsUsed, 0);
  assert.deepEqual(providerCalls, [`tmp.user@${D}`]);
});
