import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMillionVerifierAdapter, mapMillionVerifierResult } from '../src/providers/millionverifier.js';

const KEY = 'TEST_KEY_123';

/** Fake fetch that routes by URL path and records calls. Shapes copied from real API responses. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const handler = routes[u.pathname];
    if (!handler) throw new Error(`unexpected ${u.pathname}`);
    const out = await handler(u, init);
    const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return new Response(body, {
      status: out.status || 200,
      headers: { 'content-type': out.contentType || 'application/json; charset=utf-8' },
    });
  };
  fn.calls = calls;
  return fn;
}

const single = (over) => ({
  email: 'john@gmail.com', quality: 'good', result: 'ok', resultcode: 1, subresult: 'ok',
  free: true, role: false, didyoumean: '', credits: 25488, executiontime: 1, error: '', livemode: true, ...over,
});

const adapter = (fetchImpl) =>
  createMillionVerifierAdapter({
    apiKey: KEY,
    apiUrl: 'https://api.millionverifier.com/api/v3/',
    bulkApiUrl: 'https://bulkapi.millionverifier.com/bulkapi/v2/',
    fetchImpl,
  });

test('maps every MillionVerifier result without guessing', () => {
  assert.equal(mapMillionVerifierResult('ok'), 'valid');
  assert.equal(mapMillionVerifierResult('catch_all'), 'catchall');
  assert.equal(mapMillionVerifierResult('invalid'), 'invalid');
  assert.equal(mapMillionVerifierResult('disposable'), 'disposable');
  assert.equal(mapMillionVerifierResult('unknown'), 'unknown');
  assert.equal(mapMillionVerifierResult('unverified'), 'unknown');
  assert.equal(mapMillionVerifierResult('something_new'), 'unknown');
  assert.equal(mapMillionVerifierResult(undefined), 'unknown');
});

test('single verification: request params and normalized response', async () => {
  const f = fakeFetch({ '/api/v3/': () => ({ body: single({ role: true, didyoumean: 'john@gmail.com' }) }) });
  const r = await adapter(f).verifySingle('john@gmial.com');
  const u = f.calls[0].url;
  assert.equal(u.searchParams.get('api'), KEY);
  assert.equal(u.searchParams.get('email'), 'john@gmial.com');
  assert.equal(u.searchParams.get('timeout'), '20');
  assert.equal(r.result, 'valid');
  assert.deepEqual(r.flags, ['free_email_host', 'role_account']);
  assert.deepEqual(r.availableFlags, ['free_email_host', 'role_account']);
  assert.equal(r.suggestedCorrection, 'john@gmail.com');
  assert.equal(r.creditsUsed, 1);
  assert.equal(r.creditsRemaining, 25488);
  assert.equal(r.providerDetails.subresult, 'ok');
});

test('single verification: disposable / unverified / catch_all', async () => {
  for (const [raw, expected] of [['disposable', 'disposable'], ['unverified', 'unknown'], ['catch_all', 'catchall'], ['invalid', 'invalid']]) {
    const f = fakeFetch({ '/api/v3/': () => ({ body: single({ result: raw, free: false }) }) });
    const r = await adapter(f).verifySingle('a@b.com');
    assert.equal(r.result, expected, raw);
    if (raw === 'disposable') assert.ok(r.flags.includes('disposable_email'));
  }
});

test('single verification: errors returned as HTTP 200 are mapped (and never leak the key)', async () => {
  const cases = [
    ['Apikey not found', 401, 'auth_failure'],
    ['Insufficient credits', 402, 'insufficient_credits'],
    ['Internal error', 503, 'provider_unavailable'],
  ];
  for (const [msg, status, code] of cases) {
    const f = fakeFetch({ '/api/v3/': () => ({ body: { email: 'a@b.com', result: '', resultcode: 4, error: msg, livemode: false } }) });
    await assert.rejects(adapter(f).verifySingle('a@b.com'), (err) => {
      assert.equal(err.status, status, msg);
      assert.equal(err.code, code);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  }
});

test('network failure and HTTP 429 are reported, not retried on another provider', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(adapter(down).verifySingle('a@b.com'), (e) => e.status === 503 && /MillionVerifier/.test(e.message));
  const limited = fakeFetch({ '/api/v3/': () => ({ status: 429, body: {} }) });
  await assert.rejects(adapter(limited).verifySingle('a@b.com'), (e) => e.status === 429);
});

test('credits endpoint', async () => {
  const f = fakeFetch({ '/api/v3/credits': () => ({ body: { credits: 25489, bulk_credits: 25489, renewing_credits: 0, plan: 4 } }) });
  const c = await adapter(f).getCredits();
  assert.equal(c.creditsRemaining, 25489);
  assert.equal(c.details.bulkCredits, 25489);
  assert.equal(f.calls[0].url.searchParams.get('api'), KEY);

  const bad = fakeFetch({ '/api/v3/credits': () => ({ body: { result: 'error', error: 'apikey_not_found' } }) });
  await assert.rejects(adapter(bad).getCredits(), (e) => e.status === 401);
});

test('bulk: upload sends a multipart CSV in "file_contents"', async () => {
  let uploaded;
  const f = fakeFetch({
    '/bulkapi/v2/upload': async (u, init) => {
      const file = init.body.get('file_contents');
      uploaded = { name: file.name, text: await file.text(), key: u.searchParams.get('key') };
      return { body: { file_id: '940', status: 'in_progress', error: '' } };
    },
  });
  const id = await adapter(f).createJob([{ id: '0', email: 'a@x.com' }, { id: '1', email: 'b,"q"@x.com' }], '../evil name?.xlsx');
  assert.equal(id, '940');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(uploaded.key, KEY);
  assert.equal(uploaded.name, '.._evil name_.csv');
  assert.equal(uploaded.text.split(/\r?\n/)[0], 'email');
  assert.match(uploaded.text, /"b,""q""@x\.com"/); // properly CSV-escaped
});

test('bulk: fileinfo status mapping', async () => {
  const info = (status, extra = {}) => ({
    file_id: '940', status, percent: 60, total_rows: 500, verified: 300, ok: 200, catch_all: 50, disposable: 10,
    invalid: 30, unknown: 10, credit: 300, error: '', ...extra,
  });
  const expect = { in_queue_to_start: 'queued', in_progress: 'verifying', finished: 'complete', paused: 'failed', canceled: 'failed', error: 'failed' };
  for (const [raw, stage] of Object.entries(expect)) {
    const f = fakeFetch({ '/bulkapi/v2/fileinfo': () => ({ body: info(raw) }) });
    const s = await adapter(f).jobStatus('940');
    assert.equal(s.stage, stage, raw);
    if (stage === 'failed') assert.ok(s.failureReason);
  }
  const f = fakeFetch({ '/bulkapi/v2/fileinfo': () => ({ body: info('in_progress') }) });
  const s = await adapter(f).jobStatus('940');
  assert.deepEqual(s.counts, { valid: 200, invalid: 30, disposable: 10, catchall: 50, unknown: 10 });
  assert.equal(s.percent, 60);
  assert.equal(s.processed, 300);
});

test('bulk: results are never downloaded before the file is finished', async () => {
  const f = fakeFetch({
    '/bulkapi/v2/fileinfo': () => ({ body: { file_id: '940', status: 'in_progress', error: '' } }),
    '/bulkapi/v2/download': () => {
      throw new Error('download must not be called');
    },
  });
  await assert.rejects(adapter(f).jobResults('940'), (e) => e.status === 409);
});

test('bulk: downloads and parses the report CSV', async () => {
  const report = [
    '"email","quality","result","free","role"',
    '"good@x.com","good","ok","no","yes"',
    '"free@gmail.com","good","ok","yes","no"',
    '"cc@corp.com","risky","catch_all","no","no"',
    '"tmp@mailinator.com","bad","disposable","no","no"',
    '"x@nope.com","bad","invalid","no","no"',
    '"u@slow.com","risky","unknown","no","no"',
    '"","bad","invalid","no","no"',
  ].join('\n');
  const f = fakeFetch({
    '/bulkapi/v2/fileinfo': () => ({ body: { file_id: '940', status: 'finished', credit: 6, error: '' } }),
    '/bulkapi/v2/download': (u) => {
      assert.equal(u.searchParams.get('filter'), 'all');
      return { body: report, contentType: 'application/octet-stream' };
    },
  });
  const { results, creditsUsed } = await adapter(f).jobResults('940');
  assert.equal(creditsUsed, 6);
  assert.equal(results.length, 6); // blank email row dropped
  assert.deepEqual(
    results.map((r) => r.result),
    ['valid', 'valid', 'catchall', 'disposable', 'invalid', 'unknown'],
  );
  assert.deepEqual(results[0].flags, ['role_account']);
  assert.deepEqual(results[1].flags, ['free_email_host']);
});

test('bulk: download error body is surfaced', async () => {
  const f = fakeFetch({
    '/bulkapi/v2/fileinfo': () => ({ body: { file_id: '1', status: 'finished', error: '' } }),
    '/bulkapi/v2/download': () => ({ body: { error: 'file_not_found' } }),
  });
  await assert.rejects(adapter(f).jobResults('1'), (e) => e.status === 404);
});
