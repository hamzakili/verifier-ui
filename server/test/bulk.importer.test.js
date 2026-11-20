/**
 * Bulk Verification Jobs: import parsing, limits, classification and batch splitting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadsCsv, classifyRows, detectEmailColumn, planBatches, batchPlans, safeFilename, MAX_LEADS } from '../src/bulk/importer.js';
import { validateFolderName } from '../src/bulk/folders.js';
import { createStorage, safeCell, outputColumns } from '../src/bulk/exporter.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leadsCsv } from './helpers/leads.js';


test('import 100 and 1,000 leads; reject 1,001', () => {
  assert.equal(parseLeadsCsv(leadsCsv(100), 'a.csv').rows.length, 100);
  assert.equal(parseLeadsCsv(leadsCsv(MAX_LEADS), 'a.csv').rows.length, 1000);
  assert.throws(() => parseLeadsCsv(leadsCsv(1001), 'a.csv'), (e) => e.status === 413 && e.code === 'too_many_leads' && /1,001/.test(e.message));
});

test('preserves extra columns, quoted commas, quotes, line breaks and UTF-8', () => {
  const csv = 'email,Full Name,Notes\r\n"a@x.com","Müller, Jörg","He said ""hi""\nsecond line"\r\nb@x.com,李雷,plain';
  const { fields, rows } = parseLeadsCsv(csv, 'a.csv');
  assert.deepEqual(fields, ['email', 'Full Name', 'Notes']);
  assert.equal(rows[0]['Full Name'], 'Müller, Jörg');
  assert.equal(rows[0].Notes, 'He said "hi"\nsecond line');
  assert.equal(rows[1]['Full Name'], '李雷');
});

test('rejects empty, header-only, binary and Excel files', () => {
  assert.throws(() => parseLeadsCsv('', 'a.csv'), { code: 'empty_file' });
  assert.throws(() => parseLeadsCsv('email,name\n', 'a.csv'), { code: 'empty_file' });
  assert.throws(() => parseLeadsCsv('PK\u0003\u0004\u0000\u0000', 'a.csv'), { code: 'corrupted_file' });
  assert.throws(() => parseLeadsCsv('x', 'leads.xlsx'), (e) => e.status === 415 && /CSV/.test(e.message));
  assert.throws(() => parseLeadsCsv('x', 'leads.pdf'), { code: 'unsupported_format' });
});

test('detects duplicates, empty and invalid emails; duplicates are case-insensitive', () => {
  const csv = 'email,n\nA@x.com,1\na@X.com ,2\n,3\nnot-an-email,4\nb@x.com,5';
  const { rows, fields } = parseLeadsCsv(csv, 'a.csv');
  const col = detectEmailColumn(fields, rows);
  assert.equal(col, 'email');
  const { leads, summary } = classifyRows(rows, col);
  assert.deepEqual(summary, { total_imported: 5, unique_emails: 2, duplicates: 1, empty: 1, invalid_format: 1, eligible: 2 });
  assert.equal(leads[1].eligibility, 'duplicate');
  assert.equal(leads[1].duplicate_of_row, 1);
  assert.equal(leads[2].eligibility, 'empty');
  assert.equal(leads[3].eligibility, 'invalid_format');
});

test('missing email column is detected as null; headerless files get generated names', () => {
  const noEmail = parseLeadsCsv('name,phone\nAva,123\nLiam,456', 'a.csv');
  assert.equal(detectEmailColumn(noEmail.fields, noEmail.rows), null);
  const headerless = parseLeadsCsv('ava@x.com,Ava\nliam@x.com,Liam', 'a.csv');
  assert.equal(headerless.headerless, true);
  assert.deepEqual(headerless.fields, ['Column 1', 'Column 2']);
  assert.equal(headerless.rows.length, 2);
});

test('batch splitting', () => {
  const cases = [
    [1000, 500, [500, 500]],
    [1000, 250, [250, 250, 250, 250]],
    [1000, 100, Array(10).fill(100)],
    [750, 500, [500, 250]],
    [600, 250, [250, 250, 100]],
    [320, 100, [100, 100, 100, 20]],
    [501, 500, [500, 1]],
    [100, 100, [100]],
    [75, 100, [75]],
    [1, 100, [1]],
  ];
  for (const [eligible, size, expected] of cases) {
    const p = planBatches(eligible, size);
    assert.deepEqual(p.batches, expected, `${eligible}/${size}`);
    assert.equal(p.total_batches, expected.length);
    assert.ok(p.batch_size <= eligible, 'batch size never exceeds eligible leads');
    assert.equal(p.batches.reduce((a, b) => a + b, 0), eligible);
  }
  assert.deepEqual(Object.keys(batchPlans(985)), ['100', '250', '500', '1000']);
  assert.deepEqual(batchPlans(985)[500].batches, [500, 485]);
});

test('names are sanitized: no path traversal through file or folder names', () => {
  assert.equal(safeFilename('../../etc/passwd.csv'), 'passwd.csv');
  assert.equal(safeFilename('..\\..\\evil.csv'), 'evil.csv');
  assert.equal(safeFilename('...'), 'leads.csv');
  for (const bad of ['../etc', 'a/b', 'a\\b', '..', '.', 'x:y', 'a*b', '', '   ', 'x'.repeat(81)]) {
    assert.throws(() => validateFolderName(bad), { code: 'invalid_folder_name' }, bad);
  }
  assert.equal(validateFolderName('  November   Campaign '), 'November Campaign');
});

test('storage keys cannot escape the storage root', async () => {
  const s = createStorage(mkdtempSync(join(tmpdir(), 'bulk-store-')));
  for (const key of ['../x.csv', 'jobs/../../x.csv', '/abs.csv', 'jobs\\x.csv', 'jobs/./x.csv', '']) {
    await assert.rejects(() => s.write(key, Buffer.from('x')), { code: 'invalid_storage_key' }, key);
  }
  const r = await s.write('jobs/abc/batch_001_verified.csv', Buffer.from('ok'));
  assert.equal(r.size, 2);
  assert.equal(await s.exists('jobs/abc/batch_001_verified.csv'), true);
});

test('CSV export helpers: formula injection neutralized, column clashes renamed', () => {
  assert.equal(safeCell('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(safeCell('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(safeCell('+1 555 0100'), '+1 555 0100');
  assert.equal(safeCell('-42'), '-42');
  assert.equal(safeCell('-cmd'), `'-cmd`);
  const { columns, extra } = outputColumns(['email', 'verification_status']);
  assert.equal(columns[0], 'email');
  assert.ok(extra.includes('verification_status_result'));
});
