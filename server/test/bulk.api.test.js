/**
 * Bulk Verification Jobs over HTTP: import, folders, job creation, sequential batch processing,
 * auto-save, pause / resume / cancel / retry, recovery after restart, idempotency and security.
 * The verification engine is a controllable fake (test/helpers/fakeEngine.js); the real engine
 * is exercised end-to-end in bulk.e2e.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFakeEngine } from './helpers/fakeEngine.js';
import { leadsCsv } from './helpers/leads.js';

const quiet = { info() {}, warn() {}, error() {} };

async function startApp({ engine = createFakeEngine(), env = {}, dbFile = ':memory:', storageDir, runner = {} } = {}) {
  const dir = storageDir ?? mkdtempSync(join(tmpdir(), 'bulk-api-'));
  const config = loadConfig({ MOCK_STARTING_CREDITS: '500', ...env });
  const created = createApp(config, {
    bulk: {
      engine,
      dbFile,
      storageDir: dir,
      resolveOwner: (req) => req.get('x-owner') ?? 'alice',
      logger: quiet,
      runner: { pollMs: 5, verifyBackoffMs: [20, 20, 20], exportBackoffMs: [5, 5, 5], ...runner },
    },
  });
  const server = await new Promise((r) => {
    const s = created.app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function call(method, path, body, { owner = 'alice', mode = 'mock', raw = false } = {}) {
    const headers = { 'x-verifier-mode': mode, ...(body ? { 'content-type': 'application/json' } : {}) };
    if (owner !== null) headers['x-owner'] = owner;
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    // ignoreBOM: keep the byte-order mark so tests can check it (res.text() strips it).
    if (raw) return { status: res.status, headers: res.headers, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()) };
    return { status: res.status, body: await res.json() };
  }
  const api = {
    get: (p, o) => call('GET', p, null, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, o) => call('DELETE', p, null, o),
    raw: (p, o) => call('GET', p, null, { ...o, raw: true }),
  };

  async function folder(name = 'November Campaign', owner = 'alice') {
    const r = await api.post('/verification-folders', { folder_name: name }, { owner });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.folder.id;
  }
  async function importCsv(csv, filename = 'Campaign Leads.csv', owner = 'alice') {
    const r = await api.post('/bulk-verification/import', { filename, content: csv }, { owner });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.import;
  }
  async function newJob({ n = 1000, batch = 500, csv, owner = 'alice', mode = 'mock', extra = {} } = {}) {
    const dest = await folder(`Dest ${Math.random().toString(36).slice(2, 8)}`, owner);
    const imp = await importCsv(csv ?? leadsCsv(n), 'Campaign Leads.csv', owner);
    const r = await api.post('/bulk-verification/jobs', { import_id: imp.import_id, batch_size: batch, destination_folder_id: dest, ...extra }, { owner, mode });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.job;
  }
  async function waitFor(jobId, pred, { owner = 'alice', timeout = 10_000 } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = (await api.get(`/bulk-verification/jobs/${jobId}/progress`, { owner })).body.job;
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out; last state: ${JSON.stringify({ status: last?.status, batches: last?.batches?.map((b) => b.status) })}`);
  }
  const done = (j) => ['completed', 'completed_with_errors', 'failed', 'cancelled', 'paused'].includes(j.status);

  return {
    api, engine, bulk: created.bulk, storageDir: dir, folder, importCsv, newJob, waitFor, done,
    async close() {
      server.close();
      await created.bulk.close();
    },
  };
}

// ---------------------------------------------------------------------------- import

test('import: preview, summary, batch plans, 1,001 rejected, manual email column', async () => {
  const t = await startApp();
  try {
    const csv = 'Name,Email Address,Company\nAva,ava@x.com,"Acme, Inc."\nAva2,AVA@x.com,Dup\nNo,,Empty\nBad,not-an-email,Bad\nLiam,liam@x.com,Contoso';
    const imp = await t.importCsv(csv, '../../evil/Leads.csv');
    assert.equal(imp.source_filename, 'Leads.csv');
    assert.equal(imp.detected_email_column, 'Email Address');
    assert.deepEqual(imp.summary, { total_imported: 5, unique_emails: 2, duplicates: 1, empty: 1, invalid_format: 1, eligible: 2 });
    assert.deepEqual(imp.preview.map((p) => p.eligibility), ['eligible', 'duplicate', 'empty', 'invalid_format', 'eligible']);
    assert.equal(imp.preview[0].data.Company, 'Acme, Inc.');
    assert.deepEqual(imp.batch_plans['500'].batches, [2]);

    const tooMany = await t.api.post('/bulk-verification/import', { filename: 'big.csv', content: leadsCsv(1001) });
    assert.equal(tooMany.status, 413);
    assert.equal(tooMany.body.error.code, 'too_many_leads');
    assert.match(tooMany.body.error.message, /at most 1,000/);

    const xlsx = await t.api.post('/bulk-verification/import', { filename: 'leads.xlsx', content: 'x' });
    assert.equal(xlsx.status, 415);

    const noEmail = await t.importCsv('name,contact\nAva,see notes\nLiam,n/a');
    assert.equal(noEmail.email_column_required, true);
    assert.equal(noEmail.summary, null);
    const bad = await t.api.put(`/bulk-verification/imports/${noEmail.import_id}`, { email_column: 'nope' });
    assert.equal(bad.status, 422);
    const set = await t.api.put(`/bulk-verification/imports/${noEmail.import_id}`, { email_column: 'contact' });
    assert.equal(set.status, 200);
    assert.equal(set.body.import.summary.invalid_format, 2);

    const plan = await t.api.get('/bulk-verification/plan?eligible=750&batch_size=500');
    assert.deepEqual(plan.body.plan.batches, [500, 250]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------- folders

test('folders: create, nest, validate, list, delete only when empty', async () => {
  const t = await startApp();
  try {
    const root = await t.folder('Clients');
    const child = await t.api.post('/verification-folders', { folder_name: 'Client A', parent_folder_id: root, description: 'Key account' });
    assert.equal(child.status, 201);
    assert.equal(child.body.folder.path, 'My Verification Files / Clients / Client A');

    const dup = await t.api.post('/verification-folders', { folder_name: 'clients' });
    assert.equal(dup.status, 409);
    for (const name of ['../etc', 'a/b', '', 'x'.repeat(81)]) {
      assert.equal((await t.api.post('/verification-folders', { folder_name: name })).status, 422, name);
    }
    const list = await t.api.get('/verification-folders');
    assert.deepEqual(list.body.folders.map((f) => f.folder_name).sort(), ['Client A', 'Clients']);

    assert.equal((await t.api.del(`/verification-folders/${root}`)).status, 409); // has a subfolder
    assert.equal((await t.api.del(`/verification-folders/${child.body.folder.id}`)).status, 200);
    assert.equal((await t.api.del(`/verification-folders/${root}`)).status, 200);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------- happy path

test('1,000 leads / batch 500: sequential batches, auto-saved before the next starts, summary, downloads', async () => {
  const engine = createFakeEngine({ polls: 3 });
  const t = await startApp({ engine });
  const violations = [];
  engine.state.onCreate = (rows) => {
    // Batch N may only start once batch N-1 is completed AND its file exists on disk.
    const lead = t.bulk.db.get('SELECT l.batch_id, b.batch_number, b.job_id FROM bulk_verification_job_leads l JOIN bulk_verification_batches b ON b.id = l.batch_id WHERE l.email = ?', rows[0].email);
    const earlier = t.bulk.db.all('SELECT b.*, f.storage_key FROM bulk_verification_batches b LEFT JOIN verification_files f ON f.id = b.output_file_id WHERE b.job_id = ? AND b.batch_number < ?', lead.job_id, lead.batch_number);
    for (const b of earlier) {
      if (b.status !== 'completed' || !b.storage_key || !existsSync(join(t.storageDir, ...b.storage_key.split('/')))) violations.push(`batch ${lead.batch_number} started before batch ${b.batch_number} was saved`);
    }
    const running = t.bulk.db.all("SELECT batch_number FROM bulk_verification_batches WHERE job_id = ? AND status IN ('processing','saving') AND id != ?", lead.job_id, lead.batch_id);
    if (running.length) violations.push('two batches in flight');
  };
  try {
    const job = await t.newJob({ n: 1000, batch: 500 });
    assert.equal(job.total_batches, 2);
    assert.deepEqual(job.batches.map((b) => b.total_emails), [500, 500]);
    assert.match(job.job_name, /^Campaign_Leads_[A-Z][a-z]+_\d+_\d{4}$/);
    assert.match(job.job_folder.folder_name, /^Job_\d{8}_001$/);

    const final = await t.waitFor(job.id, t.done);
    assert.deepEqual(violations, []);
    assert.equal(final.status, 'completed');
    assert.equal(final.progress.percent, 100);
    assert.equal(final.progress.processed, 1000);
    assert.equal(final.completed_batches, 2);
    assert.equal(final.counts.verified, 1000);
    assert.equal(final.counts.valid, 1000);
    assert.ok(final.started_at && final.completed_at);
    assert.equal(engine.state.calls.filter((c) => c.type === 'create').length, 2);
    assert.deepEqual(engine.state.calls.map((c) => c.emails.length), [500, 500]);

    // Output structure: destination / Job_YYYYMMDD_001 / batch files + summary + all results
    const folder = await t.api.get(`/verification-folders/${final.job_folder.id}`);
    assert.deepEqual(folder.body.files.map((f) => f.file_name).sort(), ['all_results.csv', 'batch_001_verified.csv', 'batch_002_verified.csv', 'verification_summary.csv']);
    assert.equal(folder.body.breadcrumb.length, 2);
    assert.ok(!JSON.stringify(folder.body).includes(t.storageDir), 'no server paths exposed');
    assert.ok(!JSON.stringify(final).includes('storage_key'));

    const b1 = await t.api.raw(`/bulk-verification/jobs/${job.id}/batches/${final.batches[0].id}/download`);
    assert.equal(b1.status, 200);
    assert.match(b1.headers.get('content-type'), /text\/csv/);
    assert.match(b1.headers.get('content-disposition'), /batch_001_verified\.csv/);
    assert.equal(b1.text.charCodeAt(0), 0xfeff, 'UTF-8 BOM for Excel');
    const lines = b1.text.slice(1).trim().split('\r\n');
    assert.equal(lines.length, 501);
    assert.ok(lines[0].startsWith('first_name,email,company,verification_status,verification_reason,verified_at,provider,is_valid'), lines[0]);
    assert.match(lines[1], /^Name 1,user1@example.com,Co 1,valid,/);

    const all = await t.api.raw(`/bulk-verification/jobs/${job.id}/download`);
    assert.equal(all.text.trim().split('\r\n').length, 1001);
    const summary = folder.body.files.find((f) => f.file_name === 'verification_summary.csv');
    const s = await t.api.raw(`/verification-files/${summary.id}/download`);
    assert.match(s.text, /Total verified,1000/);
    assert.match(s.text, /Processing duration \(seconds\),\d+/);

    // History / list
    const list = await t.api.get('/bulk-verification/jobs?status=completed');
    assert.equal(list.body.jobs.length, 1);
    assert.equal(list.body.overview.completed, 1);
  } finally {
    await t.close();
  }
});

test('duplicates are verified once; empty/invalid rows are reported in the complete results', async () => {
  const engine = createFakeEngine();
  const t = await startApp({ engine });
  try {
    const csv = 'email,name\nA@x.com,first\na@x.com,dup\n,empty\nbad-email,bad\ninvalid.b@x.com,b\ncatchall@x.com,c';
    const job = await t.newJob({ csv, batch: 100 });
    assert.equal(job.total_eligible, 3);
    const final = await t.waitFor(job.id, t.done);
    assert.equal(final.status, 'completed');
    assert.deepEqual(engine.state.calls[0].emails, ['A@x.com', 'invalid.b@x.com', 'catchall@x.com']);
    assert.deepEqual([final.counts.valid, final.counts.invalid, final.counts.catchall], [1, 1, 1]);
    const all = (await t.api.raw(`/bulk-verification/jobs/${job.id}/download`)).text.trim().split('\r\n');
    assert.equal(all.length, 7);
    assert.match(all[2], /^a@x\.com,dup,valid,Duplicate of row 1\./);
    assert.match(all[3], /^,empty,,No email address/);
    assert.match(all[4], /^bad-email,bad,invalid,Invalid email format/);
  } finally {
    await t.close();
  }
});

test('progress is based on verified records, including the batch in flight', async () => {
  const engine = createFakeEngine();
  engine.state.hold = true;
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 750, batch: 500 });
    const mid = await t.waitFor(job.id, (j) => j.batches[0].processed_count > 0);
    assert.equal(mid.status, 'processing');
    assert.equal(mid.current_batch, 1);
    assert.equal(mid.progress.processed, 250); // half of batch 1 (fake engine), not "0 of 2 batches"
    assert.equal(mid.progress.total, 750);
    assert.equal(mid.progress.percent, 33.3);
    engine.state.hold = false;
    const final = await t.waitFor(job.id, t.done);
    assert.equal(final.progress.processed, 750);
    assert.deepEqual(final.batches.map((b) => b.total_emails), [500, 250]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------- controls

test('pause lets the running batch finish and save, then stops; resume continues without re-verifying', async () => {
  const engine = createFakeEngine({ polls: 20 });
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 300, batch: 100 });
    await t.waitFor(job.id, (j) => j.batches[0].status === 'processing');
    const p = await t.api.post(`/bulk-verification/jobs/${job.id}/pause`);
    assert.equal(p.status, 200);
    assert.equal(p.body.job.status, 'pausing');
    const paused = await t.waitFor(job.id, (j) => j.status === 'paused');
    assert.deepEqual(paused.batches.map((b) => b.status), ['completed', 'pending', 'pending']);
    assert.ok(paused.batches[0].output_file, 'the finished batch was saved');
    assert.equal(engine.state.calls.length, 1);
    assert.equal(paused.actions.can_resume, true);

    // still paused a moment later
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await t.api.get(`/bulk-verification/jobs/${job.id}`)).body.job.status, 'paused');

    engine.state.polls = 1;
    const r = await t.api.post(`/bulk-verification/jobs/${job.id}/resume`);
    assert.equal(r.status, 200);
    const final = await t.waitFor(job.id, (j) => j.status === 'completed');
    assert.equal(final.counts.verified, 300);
    assert.equal(engine.state.calls.length, 3, 'batch 1 was not verified again');
  } finally {
    await t.close();
  }
});

test('cancel finishes the running batch, keeps its results and files, cancels the rest', async () => {
  const engine = createFakeEngine({ polls: 20 });
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 300, batch: 100 });
    await t.waitFor(job.id, (j) => j.batches[0].status === 'processing');
    const c = await t.api.post(`/bulk-verification/jobs/${job.id}/cancel`);
    assert.equal(c.body.job.status, 'cancelling');
    const final = await t.waitFor(job.id, (j) => j.status === 'cancelled');
    assert.deepEqual(final.batches.map((b) => b.status), ['completed', 'cancelled', 'cancelled']);
    assert.equal(final.counts.verified, 100);
    assert.ok(final.files.some((f) => f.kind === 'all_results'), 'partial results file saved');
    const dl = await t.api.raw(`/bulk-verification/jobs/${job.id}/batches/${final.batches[0].id}/download`);
    assert.equal(dl.status, 200);
    assert.equal((await t.api.post(`/bulk-verification/jobs/${job.id}/resume`)).status, 409);
    assert.equal((await t.api.get('/bulk-verification/jobs?status=cancelled')).body.jobs.length, 1, 'cancelled jobs stay in history');

    // A paused job is cancelled immediately.
    engine.state.polls = 1;
    const j2 = await t.newJob({ n: 100, batch: 100, extra: { start: false } });
    assert.equal(j2.status, 'draft');
    const c2 = await t.api.post(`/bulk-verification/jobs/${j2.id}/cancel`);
    assert.equal(c2.body.job.status, 'cancelled');
    assert.equal(c2.body.job.batches[0].status, 'cancelled');
  } finally {
    await t.close();
  }
});

test('transient engine errors are retried automatically with backoff', async () => {
  const engine = createFakeEngine();
  engine.state.createErrors.push(Object.assign(new Error('Registry unreachable'), { status: 503, code: 'registry_unavailable' }));
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 100, batch: 100 });
    const final = await t.waitFor(job.id, t.done);
    assert.equal(final.status, 'completed');
    assert.equal(engine.state.calls.length, 2);
  } finally {
    await t.close();
  }
});

test('permanent provider error fails the batch and stops the job; retry continues without re-verifying', async () => {
  const engine = createFakeEngine();
  let n = 0;
  engine.state.onCreate = () => {
    if (++n === 2) throw Object.assign(new Error('Insufficient credits'), { status: 402, code: 'insufficient_credits' });
  };
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 300, batch: 100 });
    const failed = await t.waitFor(job.id, t.done);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.batches.map((b) => b.status), ['completed', 'failed', 'pending'], 'batch 3 did not start');
    assert.equal(failed.batches[1].error_kind, 'provider');
    assert.match(failed.error_message, /Batch 2 failed.*Insufficient credits/);
    assert.equal(failed.batches[1].can_retry, true);

    const r = await t.api.post(`/bulk-verification/jobs/${job.id}/batches/${failed.batches[1].id}/retry`);
    assert.equal(r.status, 200);
    const final = await t.waitFor(job.id, (j) => j.status === 'completed');
    assert.equal(final.counts.verified, 300);
    assert.equal(final.batches[1].retry_count, 1);
    const creates = engine.state.calls.filter((c) => c.type === 'create');
    assert.equal(creates.length, 4); // b1, b2 (failed), b2 retry, b3
    assert.equal(creates[2].emails[0], 'user101@example.com');
  } finally {
    await t.close();
  }
});

test('unfinished records: job completes with errors; batch retry re-verifies only those records and replaces the file', async () => {
  const engine = createFakeEngine();
  engine.state.failEmails.add('user3@example.com');
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 100, batch: 100 });
    const first = await t.waitFor(job.id, t.done);
    assert.equal(first.status, 'completed_with_errors');
    assert.equal(first.counts.failed, 1);
    assert.equal(first.batches[0].status, 'completed');
    assert.equal(first.batches[0].can_retry, true);
    const fileId = first.batches[0].output_file.id;

    engine.state.failEmails.clear();
    await t.api.post(`/bulk-verification/jobs/${job.id}/batches/${first.batches[0].id}/retry`);
    const second = await t.waitFor(job.id, (j) => j.status === 'completed');
    assert.equal(second.counts.failed, 0);
    assert.deepEqual(engine.state.calls[1].emails, ['user3@example.com']);
    assert.equal(second.batches[0].output_file.id, fileId, 'same file record, regenerated in place');
    const files = t.bulk.db.get('SELECT COUNT(*) n FROM verification_files WHERE job_id = ?', job.id).n;
    assert.equal(files, 3, 'no duplicate export files');
    const results = await t.api.get(`/bulk-verification/jobs/${job.id}/batches/${first.batches[0].id}?limit=5`);
    assert.equal(results.body.results.length, 5);
    assert.equal(results.body.results[2].processing_status, 'completed');
  } finally {
    await t.close();
  }
});

test('storage failure: the batch is not marked complete; retry re-exports without re-verifying', async () => {
  const engine = createFakeEngine();
  const base = mkdtempSync(join(tmpdir(), 'bulk-store-fail-'));
  const storageDir = join(base, 'storage');
  writeFileSync(storageDir, 'not a directory'); // every write fails
  const t = await startApp({ engine, storageDir });
  try {
    const job = await t.newJob({ n: 200, batch: 100 });
    const failed = await t.waitFor(job.id, t.done);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.batches[0].status, 'failed');
    assert.equal(failed.batches[0].error_kind, 'storage');
    assert.equal(failed.batches[0].output_file, null);
    assert.equal(failed.batches[0].verified_count, 100, 'results persisted in the database');
    assert.equal(failed.batches[1].status, 'pending', 'next batch did not start');

    rmSync(storageDir);
    await t.api.post(`/bulk-verification/jobs/${job.id}/batches/${failed.batches[0].id}/retry`);
    const final = await t.waitFor(job.id, (j) => j.status === 'completed');
    assert.ok(final.batches[0].output_file);
    assert.equal(engine.state.calls.length, 2, 'batch 1 was exported again, not verified again');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------- recovery

test('restart: in-flight batch is re-attached to its provider job; completed batches are not re-verified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bulk-restart-'));
  const dbFile = join(dir, 'bulk.sqlite');
  const storageDir = join(dir, 'files');
  const env = { MILLIONVERIFIER_API_KEY: 'TESTKEY_mv_abcd' }; // live mode: provider job refs exist

  const engineA = createFakeEngine();
  let creates = 0;
  engineA.state.onCreate = () => {
    if (++creates === 2) engineA.state.hold = true; // batch 2 never finishes in "process A"
  };
  const a = await startApp({ engine: engineA, env, dbFile, storageDir });
  const job = await a.newJob({ n: 200, batch: 100, mode: 'live' });
  await a.waitFor(job.id, (j) => j.batches[1].status === 'processing' && j.batches[0].status === 'completed');
  const firstFile = (await a.api.get(`/bulk-verification/jobs/${job.id}`)).body.job.batches[0].output_file.id;
  await a.close(); // "crash": the process stops mid-batch

  const engineB = createFakeEngine();
  const b = await startApp({ engine: engineB, env, dbFile, storageDir });
  try {
    const before = (await b.api.get(`/bulk-verification/jobs/${job.id}`)).body.job;
    assert.equal(before.status, 'processing');
    assert.equal(b.bulk.runner.recover(), 1);
    const final = await b.waitFor(job.id, b.done);
    assert.equal(final.status, 'completed');
    assert.deepEqual(engineB.state.calls.map((c) => c.type), ['resume'], 'no new provider job, nothing paid twice');
    assert.equal(engineB.state.calls[0].rawId, 'raw_2');
    assert.equal(engineB.state.calls[0].emails.length, 100);
    assert.equal(final.batches[0].output_file.id, firstFile);
    assert.equal(b.bulk.db.get('SELECT COUNT(*) n FROM verification_files WHERE job_id = ?', job.id).n, 4);
  } finally {
    await b.close();
  }
});

test('recovery after an interruption while saving: re-exports without verifying again or duplicating files', async () => {
  const engine = createFakeEngine();
  const t = await startApp({ engine });
  try {
    const job = await t.newJob({ n: 200, batch: 100 });
    await t.waitFor(job.id, (j) => j.status === 'completed');
    // Simulate a worker that died after persisting batch 2's results but before saving its file.
    t.bulk.db.run("UPDATE bulk_verification_batches SET status = 'saving', lease_owner = 'dead-worker' WHERE job_id = ? AND batch_number = 2", job.id);
    t.bulk.db.run("UPDATE bulk_verification_jobs SET status = 'processing', completed_at = NULL WHERE id = ?", job.id);
    t.bulk.runner.recover();
    const final = await t.waitFor(job.id, (j) => j.status === 'completed');
    assert.equal(final.batches[1].status, 'completed');
    assert.equal(engine.state.calls.length, 2);
    assert.equal(t.bulk.db.get('SELECT COUNT(*) n FROM verification_files WHERE job_id = ?', job.id).n, 4);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------- idempotency

test('duplicate protection: same import or client_request_id never creates a second job; repeated start is safe', async () => {
  const engine = createFakeEngine();
  const t = await startApp({ engine });
  try {
    const dest = await t.folder('Dest');
    const imp = await t.importCsv(leadsCsv(150));
    const body = { import_id: imp.import_id, batch_size: 100, destination_folder_id: dest, start: false, client_request_id: 'req-1' };
    const [r1, r2] = await Promise.all([t.api.post('/bulk-verification/jobs', body), t.api.post('/bulk-verification/jobs', body)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 201]);
    assert.equal(r1.body.job.id, r2.body.job.id);
    assert.equal(t.bulk.db.get('SELECT COUNT(*) n FROM bulk_verification_jobs').n, 1);

    const id = r1.body.job.id;
    await Promise.all([1, 2, 3].map(() => t.api.post(`/bulk-verification/jobs/${id}/start`)));
    t.bulk.runner.enqueue(id);
    t.bulk.runner.enqueue(id);
    const final = await t.waitFor(id, t.done);
    assert.equal(final.status, 'completed');
    assert.equal(engine.state.calls.length, 2, 'each batch verified exactly once');
  } finally {
    await t.close();
  }
});

test('validation: destination folder required, batch size options, live mode needs a configured provider', async () => {
  const t = await startApp();
  try {
    const imp = await t.importCsv(leadsCsv(10));
    const noFolder = await t.api.post('/bulk-verification/jobs', { import_id: imp.import_id, batch_size: 500 });
    assert.equal(noFolder.status, 422);
    assert.ok(noFolder.body.error.details.destination_folder_id);
    const dest = await t.folder('Dest');
    const badSize = await t.api.post('/bulk-verification/jobs', { import_id: imp.import_id, batch_size: 300, destination_folder_id: dest });
    assert.equal(badSize.status, 422);
    const live = await t.api.post('/bulk-verification/jobs', { import_id: imp.import_id, batch_size: 100, destination_folder_id: dest }, { mode: 'live' });
    assert.equal(live.status, 409);
    assert.equal(live.body.error.code, 'provider_not_configured');
    const missingImport = await t.api.post('/bulk-verification/jobs', { import_id: 'nope', batch_size: 100, destination_folder_id: dest });
    assert.equal(missingImport.status, 404);
    const noneEligible = await t.importCsv('email\nnot-an-email');
    const r = await t.api.post('/bulk-verification/jobs', { import_id: noneEligible.import_id, batch_size: 100, destination_folder_id: dest });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'no_eligible_leads');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------- security

test("owners are isolated: no access to another owner's jobs, batches, files, folders or imports", async () => {
  const t = await startApp();
  try {
    const job = await t.newJob({ n: 100, batch: 100 });
    const final = await t.waitFor(job.id, t.done);
    const batchId = final.batches[0].id;
    const fileId = final.batches[0].output_file.id;
    const aliceFolder = final.destination_folder.id;
    const bob = { owner: 'bob' };

    for (const path of [
      `/bulk-verification/jobs/${job.id}`,
      `/bulk-verification/jobs/${job.id}/progress`,
      `/bulk-verification/jobs/${job.id}/batches/${batchId}`,
      `/bulk-verification/jobs/${job.id}/batches/${batchId}/download`,
      `/bulk-verification/jobs/${job.id}/download`,
      `/verification-files/${fileId}/download`,
      `/verification-folders/${aliceFolder}`,
    ]) {
      const r = await t.api.get(path, bob);
      assert.equal(r.status, 404, path);
    }
    for (const action of ['pause', 'resume', 'cancel', 'start']) {
      assert.equal((await t.api.post(`/bulk-verification/jobs/${job.id}/${action}`, {}, bob)).status, 404, action);
    }
    assert.equal((await t.api.post(`/bulk-verification/jobs/${job.id}/batches/${batchId}/retry`, {}, bob)).status, 404);
    assert.equal((await t.api.del(`/verification-folders/${aliceFolder}`, bob)).status, 404);
    assert.equal((await t.api.get('/bulk-verification/jobs', bob)).body.jobs.length, 0);
    assert.equal((await t.api.get('/verification-folders', bob)).body.folders.length, 0);

    // Bob cannot write into Alice's folder or use Alice's import.
    const imp = await t.importCsv(leadsCsv(5), 'x.csv', 'alice');
    const bobImp = await t.importCsv(leadsCsv(5), 'x.csv', 'bob');
    const intoAlice = await t.api.post('/bulk-verification/jobs', { import_id: bobImp.import_id, batch_size: 100, destination_folder_id: aliceFolder }, bob);
    assert.equal(intoAlice.status, 422);
    assert.equal(intoAlice.body.error.code, 'invalid_destination_folder');
    const sub = await t.api.post('/verification-folders', { folder_name: 'x', parent_folder_id: aliceFolder }, bob);
    assert.equal(sub.status, 404);
    assert.equal((await t.api.get(`/bulk-verification/imports/${imp.import_id}`, bob)).status, 404);

    // Job output folders cannot be used as a destination.
    const intoJobFolder = await t.api.post('/bulk-verification/jobs', { import_id: imp.import_id, batch_size: 100, destination_folder_id: final.job_folder.id });
    assert.equal(intoJobFolder.status, 422);

    // No owner -> 401
    assert.equal((await t.api.get('/bulk-verification/jobs', { owner: '' })).status, 401);
  } finally {
    await t.close();
  }
});
