/**
 * End-to-end: Bulk Verification Jobs driven by the REAL verification engine.
 *  1. Live mode: real central engine + MillionVerifier adapter (bulk API stubbed at fetch level)
 *     + the in-process double of the Laravel Email Registry API. Proves registry reuse, one
 *     provider upload per batch in order, results saved back to the registry.
 *  2. Mock sandbox mode: no stubs at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Papa from 'papaparse';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { startFakeRegistry } from './helpers/fakeRegistry.js';
import { leadsCsv } from './helpers/leads.js';

const quiet = { info() {}, warn() {}, error() {} };

async function listen(app) {
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}/api` };
}

async function json(base, method, path, body, mode) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-verifier-mode': mode, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function runJob(base, csv, mode, batchSize) {
  const folder = await json(base, 'POST', '/verification-folders', { folder_name: 'November Campaign' }, mode);
  const imp = await json(base, 'POST', '/bulk-verification/import', { filename: 'leads.csv', content: csv }, mode);
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  const created = await json(
    base, 'POST', '/bulk-verification/jobs',
    { import_id: imp.body.import.import_id, batch_size: batchSize, destination_folder_id: folder.body.folder.id, job_name: 'E2E job' },
    mode,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.job.id;
  const end = Date.now() + 60_000;
  for (;;) {
    const j = (await json(base, 'GET', `/bulk-verification/jobs/${id}/progress`, null, mode)).body.job;
    if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(j.status)) return j;
    if (Date.now() > end) throw new Error(`timeout: ${j.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('live: real engine + registry reuse + MillionVerifier bulk API, batch by batch', async () => {
  const reg = await startFakeRegistry();
  // Already verified by another app: must be reused, not paid for again.
  reg.seed({ email: 'user7@example.com', status: 'completed', result: 'invalid', provider: 'neverbounce', verified_at: new Date().toISOString() });

  const uploads = []; // emails per MillionVerifier upload, in order
  const files = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'bulkapi.millionverifier.com') {
      if (u.pathname.endsWith('/upload')) {
        const csv = await init.body.get('file_contents').text();
        const emails = Papa.parse(csv, { header: true }).data.map((r) => r.email).filter(Boolean);
        uploads.push(emails);
        const id = String(900 + uploads.length);
        files.set(id, { emails, polls: 0 });
        return Response.json({ file_id: id, file_name: 'x.csv', status: 'in_queue_to_start' });
      }
      const f = files.get(u.searchParams.get('file_id'));
      if (u.pathname.endsWith('/fileinfo')) {
        f.polls += 1;
        const finished = f.polls >= 2;
        return Response.json({ file_id: '1', status: finished ? 'finished' : 'in_progress', percent: finished ? 100 : 50, total_rows: f.emails.length, verified: finished ? f.emails.length : Math.floor(f.emails.length / 2), credit: f.emails.length, error: '' });
      }
      if (u.pathname.endsWith('/download')) {
        const rows = f.emails.map((e) => [e, 'good', e.startsWith('user1') ? 'catch_all' : 'ok', 'no', e.startsWith('info') ? 'yes' : 'no']);
        return new Response(Papa.unparse({ fields: ['email', 'quality', 'result', 'free', 'role'], data: rows }), { headers: { 'content-type': 'application/octet-stream' } });
      }
    }
    if (u.hostname.endsWith('millionverifier.com') && u.pathname.endsWith('/credits')) return Response.json({ credits: 1000, bulk_credits: 1000, renewing_credits: 0, plan: 1 });
    if (u.hostname.endsWith('millionverifier.com') || u.hostname.endsWith('neverbounce.com')) throw new Error(`unexpected provider call ${u.href}`);
    return realFetch(url, init);
  };

  const config = loadConfig({
    MILLIONVERIFIER_API_KEY: 'TESTKEY_mv_abcd',
    EMAIL_REGISTRY_API_URL: reg.url,
    EMAIL_REGISTRY_API_TOKEN: reg.token,
    EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE: '6000',
  });
  const created = createApp(config, {
    centralTiming: { pollMs: 20 },
    bulk: { storageDir: mkdtempSync(join(tmpdir(), 'bulk-e2e-')), logger: quiet, runner: { pollMs: 20 } },
  });
  const { server, base } = await listen(created.app);
  try {
    const csv = leadsCsv(150, { row: (i) => (i === 150 ? 'Info,info@example.com,Co' : `Name ${i},user${i}@example.com,Co ${i}`) });
    const job = await runJob(base, csv, 'live', 100);

    assert.equal(job.status, 'completed');
    assert.equal(job.configuration.mode, 'live');
    assert.equal(job.configuration.registry, true);
    assert.deepEqual(job.batches.map((b) => [b.status, b.total_emails]), [['completed', 100], ['completed', 50]]);
    assert.equal(job.counts.verified, 150);
    assert.equal(job.counts.reused, 1);
    // One provider upload per batch, in order; the registry hit was never sent to the provider.
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].length, 99);
    assert.ok(!uploads[0].includes('user7@example.com'));
    assert.equal(uploads[1][0], 'user101@example.com');

    const dl = await fetch(`${base}/bulk-verification/jobs/${job.id}/batches/${job.batches[0].id}/download`);
    const rows = Papa.parse((await dl.text()).replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data;
    assert.equal(rows.length, 100);
    const u7 = rows.find((r) => r.email === 'user7@example.com');
    assert.equal(u7.verification_status, 'invalid');
    assert.equal(u7.from_registry, 'true');
    const u2 = rows.find((r) => r.email === 'user2@example.com');
    assert.equal(u2.verification_status, 'valid');
    assert.equal(u2.provider, 'MillionVerifier');
    assert.equal(u2.from_registry, 'false');
    assert.equal(rows.find((r) => r.email === 'user10@example.com').verification_status, 'catchall');

    // New results were saved to the central registry by the existing save queue.
    await created.central.savesIdle();
    assert.equal(reg.records.size, 150);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    await created.bulk.close();
    created.central.shutdown();
    await reg.close?.();
  }
});

test('mock sandbox: real engine, no stubs', { timeout: 90_000 }, async () => {
  const config = loadConfig({ MOCK_STARTING_CREDITS: '1000' });
  const created = createApp(config, { bulk: { storageDir: mkdtempSync(join(tmpdir(), 'bulk-e2e-mock-')), logger: quiet, runner: { pollMs: 200 } } });
  const { server, base } = await listen(created.app);
  try {
    const csv = leadsCsv(120, { row: (i) => (i === 3 ? 'Noah,noah@mailinator.com,Fab' : i === 4 ? 'Liam,liam.chen@gmial.com,Con' : `Name ${i},person${i}@example.com,Co`) });
    const job = await runJob(base, csv, 'mock', 100);
    assert.equal(job.status, 'completed');
    assert.equal(job.configuration.mode, 'mock');
    assert.deepEqual(job.batches.map((b) => b.total_emails), [100, 20]);
    assert.equal(job.counts.verified, 120);
    assert.equal(job.counts.disposable, 1);
    assert.ok(job.counts.invalid >= 1);
    assert.equal(job.files.length, 2);
    // Simulated results are labelled as such in the export.
    const csvText = await (await fetch(`${base}/bulk-verification/jobs/${job.id}/download`)).text();
    const rows = Papa.parse(csvText.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data;
    assert.equal(rows.length, 120);
    assert.equal(rows[0].provider, 'MillionVerifier (mock sandbox)');
  } finally {
    server.close();
    await created.bulk.close();
  }
});
