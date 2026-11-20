/**
 * Lead import for Bulk Verification Jobs: CSV parsing (papaparse, already a server dependency),
 * header / email-column detection, per-row classification and batch planning.
 *
 * The 1,000-lead limit is enforced here, server-side; the UI check is only a convenience.
 */
import Papa from 'papaparse';
import { ApiError } from '../errors.js';

export const MAX_LEADS = 1000;
export const BATCH_SIZES = [100, 250, 500, 1000];
export const DEFAULT_BATCH_SIZE = 500;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

// Same syntax check the client uses (client/src/lib/csv.js) and the mock sandbox applies.
const EMAIL_RE = /^[^\s@"(),:;<>[\\\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;
export const isEmailSyntax = (v) => {
  const s = String(v ?? '').trim();
  return s.length <= 254 && EMAIL_RE.test(s);
};
export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();

/** "../../etc/leads.CSV" -> "leads.CSV"; strips control characters; never empty. */
export function safeFilename(name, fallback = 'leads.csv') {
  const base = String(name ?? '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || fallback;
}

/**
 * Parse CSV text into { fields, rows, headerless }. Rows are objects keyed by field.
 * @throws ApiError for unsupported/empty/corrupted files and for more than MAX_LEADS rows.
 */
export function parseLeadsCsv(content, filename) {
  const name = String(filename || '').toLowerCase();
  if (/\.(xlsx|xls|xlsm|ods|numbers)$/.test(name)) {
    throw new ApiError(415, 'unsupported_format', 'Excel files are not supported. Save the sheet as CSV (File → Save As → CSV) and upload that.');
  }
  if (name && !/\.(csv|txt)$/.test(name)) {
    throw new ApiError(415, 'unsupported_format', 'Unsupported file type. Upload a .csv file.');
  }
  if (typeof content !== 'string') throw new ApiError(400, 'missing_file', 'No file content was received.');
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    throw new ApiError(413, 'file_too_large', 'The file is larger than 10 MB.');
  }
  if (content.includes('\u0000')) {
    throw new ApiError(422, 'corrupted_file', 'The file looks binary or corrupted. Upload a plain-text CSV file.');
  }
  const text = content.replace(/^﻿/, '');
  if (!text.trim()) throw new ApiError(422, 'empty_file', 'The file is empty.');

  const res = Papa.parse(text, { header: false, skipEmptyLines: 'greedy' });
  const matrix = res.data.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  if (!matrix.length) throw new ApiError(422, 'empty_file', 'No rows were found in the file.');
  const fatal = res.errors.find((e) => e.type === 'Quotes');
  if (fatal) throw new ApiError(422, 'corrupted_file', `The CSV is malformed (${fatal.message} near row ${fatal.row + 1}).`);

  const width = Math.max(...matrix.map((r) => r.length));
  const first = matrix[0].map((c) => String(c ?? '').trim());
  // If any cell in the first row is an email address, the file has no header row.
  const headerless = first.some(isEmailSyntax);
  let fields;
  let body;
  if (headerless) {
    fields = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    body = matrix;
  } else {
    const seen = new Map();
    fields = Array.from({ length: width }, (_, i) => {
      let f = (first[i] || `Column ${i + 1}`).slice(0, 100);
      const n = seen.get(f.toLowerCase()) || 0;
      seen.set(f.toLowerCase(), n + 1);
      if (n) f = `${f} (${n + 1})`;
      return f;
    });
    body = matrix.slice(1);
  }
  if (!body.length) throw new ApiError(422, 'empty_file', 'The file only contains a header row.');
  if (body.length > MAX_LEADS) {
    throw new ApiError(
      413,
      'too_many_leads',
      `This file has ${body.length.toLocaleString('en-US')} leads. A bulk verification job accepts at most ${MAX_LEADS.toLocaleString('en-US')} leads per import; split the file and import it in parts.`,
      { total_rows: body.length, max_leads: MAX_LEADS },
    );
  }

  const rows = body.map((r) => {
    const o = {};
    fields.forEach((f, i) => {
      o[f] = r[i] === undefined || r[i] === null ? '' : String(r[i]);
    });
    return o;
  });
  return { fields, rows, headerless };
}

/** Column whose sampled values look most like emails; header names containing "email" get a bonus. */
export function detectEmailColumn(fields, rows) {
  const sample = rows.slice(0, 200);
  let best = null;
  let bestScore = 0;
  for (const f of fields) {
    const vals = sample.map((r) => r[f]).filter((v) => String(v ?? '').trim() !== '');
    if (!vals.length) continue;
    let score = vals.filter(isEmailSyntax).length / vals.length;
    if (/e-?mail/i.test(f)) score += 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return bestScore >= 0.2 ? best : null;
}

/**
 * Classify every row for the chosen column.
 * Returns { leads: [{ row_number, email, normalized_email, eligibility, duplicate_of_row, data }], summary }.
 * eligibility: eligible | duplicate | empty | invalid_format. Only "eligible" rows are verified;
 * duplicates are verified once (via their first occurrence) and keep their own imported fields.
 */
export function classifyRows(rows, emailColumn) {
  const firstRow = new Map(); // normalized -> row number of its first valid occurrence
  const leads = rows.map((data, i) => {
    const row_number = i + 1;
    const email = String(data[emailColumn] ?? '').trim();
    const normalized_email = normalizeEmail(email);
    let eligibility;
    let duplicate_of_row = null;
    if (!email) eligibility = 'empty';
    else if (!isEmailSyntax(email)) eligibility = 'invalid_format';
    else if (firstRow.has(normalized_email)) {
      eligibility = 'duplicate';
      duplicate_of_row = firstRow.get(normalized_email);
    } else {
      eligibility = 'eligible';
      firstRow.set(normalized_email, row_number);
    }
    return { row_number, email, normalized_email, eligibility, duplicate_of_row, data };
  });
  const count = (e) => leads.filter((l) => l.eligibility === e).length;
  const eligible = count('eligible');
  return {
    leads,
    summary: {
      total_imported: rows.length,
      unique_emails: eligible,
      duplicates: count('duplicate'),
      empty: count('empty'),
      invalid_format: count('invalid_format'),
      eligible,
    },
  };
}

/** Batch sizes for `eligible` leads, e.g. (750, 500) -> [500, 250]. Never larger than `eligible`. */
export function planBatches(eligible, batchSize) {
  const n = Math.max(0, Math.floor(eligible));
  const size = Math.max(1, Math.min(Math.floor(batchSize), n || 1));
  const sizes = [];
  for (let left = n; left > 0; left -= size) sizes.push(Math.min(size, left));
  return { batch_size: n ? size : batchSize, total_batches: sizes.length, batches: sizes };
}

export const batchPlans = (eligible) => Object.fromEntries(BATCH_SIZES.map((s) => [s, planBatches(eligible, s)]));
