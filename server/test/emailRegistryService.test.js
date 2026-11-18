/** Unit tests for the Laravel Email Registry API client (src/services/emailRegistryService.js). */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEmailRegistryService } from '../src/services/emailRegistryService.js';
import { startFakeRegistry } from './helpers/fakeRegistry.js';

let reg;
const logs = [];
const logger = { warn: (m) => logs.push(m), error: (m) => logs.push(m) };
const client = (extra = {}) => createEmailRegistryService({ url: reg.url, token: reg.token, timeoutMs: 1000, connectTimeoutMs: 500, logger, ...extra });

before(async () => {
  reg = await startFakeRegistry();
});
after(() => reg.close());
beforeEach(() => {
  reg.reset();
  logs.length = 0;
});

test('save creates, then updates the same email (no duplicate); get, update, remove', async () => {
  const c = client();
  const a = await c.save({ email: 'Mixed@Case.com', status: 'completed', result: 'valid', provider: 'millionverifier', metadata: { source: 'verifier-ui' } });
  assert.equal(a.created, true);
  assert.equal(a.record.email, 'mixed@case.com');
  const b = await c.save({ email: 'mixed@case.com ', status: 'completed', result: 'invalid', provider: 'neverbounce' });
  assert.equal(b.created, false);
  assert.equal(b.record.id, a.record.id);
  assert.equal(reg.records.size, 1);

  assert.equal((await c.get(a.record.id)).result, 'invalid');
  const u = await c.update(a.record.id, { status: 'completed', result: 'risky', reason: 'manual review' });
  assert.deepEqual([u.result, u.reason], ['risky', 'manual review']);
  assert.deepEqual(await c.remove(a.record.id), { id: a.record.id });
  await assert.rejects(c.get(a.record.id), (e) => e.status === 404 && e.code === 'registry_not_found');
  await assert.rejects(c.update(999, { status: 'failed' }), (e) => e.code === 'registry_not_found');
  await assert.rejects(c.remove(999), (e) => e.code === 'registry_not_found');
});

test('422: field errors are passed on, nothing else', async () => {
  await assert.rejects(client().save({ email: 'nope', status: 'completed' }), (e) => {
    assert.equal(e.status, 422);
    assert.equal(e.code, 'registry_validation');
    assert.ok(e.details.errors.email && e.details.errors.result);
    return true;
  });
  await assert.rejects(client().update(1, { email: 'x@y.com' }), (e) => e.code === 'registry_not_found');
});

test('401 is not a user error: mapped to registry_unauthorized, never retried, token never logged', async () => {
  const c = client({ token: 'wrong-token-value-xyz' });
  await assert.rejects(c.stats(), (e) => e.status === 503 && e.code === 'registry_unauthorized');
  await assert.rejects(c.lookup(['a@b.com']), (e) => e.code === 'registry_unauthorized');
  assert.equal(reg.state.calls.length, 2); // no retries on 401
  assert.ok(logs.length >= 2);
  for (const l of logs) {
    assert.ok(!l.includes('wrong-token-value-xyz') && !l.includes(reg.token));
    assert.match(l, /"status":401/);
  }
  const h = await c.health();
  assert.equal(h.connected, false);
  assert.equal(h.code, 'registry_unauthorized');
});

test('lookup normalizes, de-duplicates, chunks by 1000 and merges found/missing/invalid', async () => {
  reg.seed({ email: 'u5@x.com', status: 'completed', result: 'valid', provider: 'other' });
  const emails = [...Array.from({ length: 1200 }, (_, i) => `U${i}@x.com`), 'u5@x.com', ' U5@X.COM '];
  const r = await client().lookup(emails);
  assert.deepEqual(reg.state.calls.map((c) => c.body.emails.length), [1000, 200]);
  assert.deepEqual([...r.found.keys()], ['u5@x.com']);
  assert.equal(r.missing.length, 1199);
  assert.deepEqual(r.invalid, []);
});

test('list forwards only known parameters', async () => {
  await client().list({ page: 2, limit: 5, search: 'gmail', status: '', evil: 'x', sort: 'updated_at', direction: 'asc' });
  const call = reg.state.calls[0];
  assert.equal(call.path, '/api/email-verifications');
  assert.deepEqual(call.query, { page: '2', limit: '5', search: 'gmail', sort: 'updated_at', direction: 'asc' });
});

test('network errors and 5xx are retried, then reported as registry_unavailable', async () => {
  reg.state.down = true;
  await assert.rejects(client().lookup(['a@b.com']), (e) => e.status === 503 && e.code === 'registry_unavailable' && e.reason === 'network_error');
  assert.equal(reg.state.calls.length, 3);

  let n = 0;
  const flaky = async () =>
    ++n < 3
      ? new Response('<html>502</html>', { status: 502 })
      : Response.json({ success: true, message: 'ok', data: { found: [], missing: ['a@b.com'], invalid: [] } });
  const r = await client({ fetchImpl: flaky }).lookup(['a@b.com']);
  assert.equal(n, 3);
  assert.deepEqual(r.missing, ['a@b.com']);

  n = 0;
  const s = await client({ fetchImpl: flaky }).stats().catch((e) => e);
  assert.equal(n, 1); // stats() is a single-shot health probe (no retry)
  assert.equal(s.code, 'registry_unavailable');
});

test('connect timeout (no response headers) and total timeout (slow body) both abort', async () => {
  // Server that accepts the connection but never answers.
  const silent = http.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const c1 = createEmailRegistryService({ url: `http://127.0.0.1:${silent.address().port}/api`, token: 't', connectTimeoutMs: 150, timeoutMs: 5000, retries: 0, logger });
  const t0 = Date.now();
  await assert.rejects(c1.stats(), (e) => e.code === 'registry_unavailable' && e.reason === 'connect_timeout');
  assert.ok(Date.now() - t0 < 2000);

  // Server that sends headers, then stalls the body.
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"success":true,');
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const c2 = createEmailRegistryService({ url: `http://127.0.0.1:${slow.address().port}/api`, token: 't', connectTimeoutMs: 1000, timeoutMs: 300, retries: 0, logger });
  await assert.rejects(c2.stats(), (e) => e.code === 'registry_unavailable' && e.reason === 'timeout');
  silent.closeAllConnections();
  slow.closeAllConnections();
  silent.close();
  slow.close();
});

test('429 honours Retry-After, then succeeds', async () => {
  reg.state.rateLimitNext = 2;
  const t0 = Date.now();
  const r = await client().lookup(['a@b.com']);
  assert.deepEqual(r.missing, ['a@b.com']);
  assert.ok(Date.now() - t0 >= 1900, 'waited for Retry-After: 1 twice');
  reg.state.rateLimitNext = 5;
  await assert.rejects(client().lookup(['a@b.com']), (e) => e.status === 429 && e.code === 'registry_rate_limited');
});
