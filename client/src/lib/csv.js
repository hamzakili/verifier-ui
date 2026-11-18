import Papa from 'papaparse';

export const EMAIL_RE = /^[^\s@"(),:;<>[\\\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export const isEmailSyntax = (v) => EMAIL_RE.test(String(v ?? '').trim());

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Parse a CSV File in the browser. Handles header and header-less files.
 * Resolves to { fields, rows } where rows are plain objects keyed by field.
 */
export function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    const name = file.name.toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.txt') && file.type !== 'text/csv') {
      return reject(new Error('Please upload a .csv file.'));
    }
    if (file.size === 0) return reject(new Error('The file is empty.'));
    if (file.size > MAX_FILE_BYTES) return reject(new Error('File is larger than 20 MB. Split it into smaller files.'));

    Papa.parse(file, {
      header: false,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const matrix = res.data.filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== ''));
        if (matrix.length === 0) {
          const firstErr = res.errors?.[0];
          return reject(new Error(firstErr ? `Malformed CSV: ${firstErr.message} (row ${firstErr.row + 1})` : 'No rows found in the file.'));
        }

        const width = Math.max(...matrix.map((r) => r.length));
        const first = matrix[0].map((c) => String(c ?? '').trim());

        // If any cell in the first row is an email, the file has no header row.
        const headerless = first.some(isEmailSyntax);
        let fields;
        let body;
        if (headerless) {
          fields = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
          body = matrix;
        } else {
          const seen = new Map();
          fields = Array.from({ length: width }, (_, i) => {
            let f = first[i] || `Column ${i + 1}`;
            const n = seen.get(f) || 0;
            seen.set(f, n + 1);
            if (n) f = `${f} (${n + 1})`;
            return f;
          });
          body = matrix.slice(1);
        }

        if (body.length === 0) return reject(new Error('The file only contains a header row.'));

        const rows = body.map((r) => {
          const o = {};
          fields.forEach((f, i) => {
            o[f] = r[i] === undefined || r[i] === null ? '' : String(r[i]);
          });
          return o;
        });

        const badRows = res.errors?.filter((e) => e.type !== 'Delimiter').length || 0;
        resolve({ fields, rows, headerless, warnings: badRows });
      },
      error: (err) => reject(new Error(`Could not read file: ${err.message}`)),
    });
  });
}

/** Score each column by how many sampled values look like emails; prefer header names containing "email". */
export function detectEmailColumn(fields, rows) {
  const sample = rows.slice(0, 200);
  let best = null;
  let bestScore = 0;
  for (const f of fields) {
    const vals = sample.map((r) => r[f]).filter((v) => String(v).trim() !== '');
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

/** Stats for a chosen column. */
export function analyzeColumn(rows, field) {
  const unique = new Map(); // lower -> original
  let validSyntax = 0;
  let invalidSyntax = 0;
  let empty = 0;
  for (const r of rows) {
    const v = String(r[field] ?? '').trim();
    if (!v) {
      empty++;
      continue;
    }
    if (!isEmailSyntax(v)) {
      invalidSyntax++;
      continue;
    }
    validSyntax++;
    const k = v.toLowerCase();
    if (!unique.has(k)) unique.set(k, v);
  }
  return {
    totalRows: rows.length,
    validSyntax,
    invalidSyntax,
    empty,
    duplicates: validSyntax - unique.size,
    uniqueEmails: [...unique.values()],
  };
}

export function downloadCsv(rows, filename, columns) {
  const csv = Papa.unparse(rows, columns ? { columns } : undefined);
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sampleCsv() {
  const rows = [
    ['first_name', 'last_name', 'email', 'company'],
    ['Ava', 'Patel', 'ava.patel@gmail.com', 'Northwind'],
    ['Liam', 'Chen', 'liam.chen@gmial.com', 'Contoso'],
    ['Noah', 'Garcia', 'noah@mailinator.com', 'Fabrikam'],
    ['Mia', 'Kim', 'catchall@acme-corp.io', 'Acme'],
    ['Ethan', 'Brown', 'unknown.user@legacy-mail.net', 'Legacy'],
    ['Sofia', 'Rossi', 'sofia.rossi@outlook.com', 'Initech'],
    ['Lucas', 'Müller', 'invalid.lucas@globex.com', 'Globex'],
    ['Zoe', 'Martin', 'zoe.martin@yahoo.com', 'Umbrella'],
    ['Omar', 'Haddad', 'info@hooli.com', 'Hooli'],
    ['Ava', 'Patel', 'AVA.PATEL@gmail.com', 'Northwind (duplicate)'],
    ['Broken', 'Row', 'not-an-email', 'n/a'],
    ['Ivy', 'Nguyen', 'ivy@yopmail.com', 'Stark'],
    ['Leo', 'Silva', 'leo.silva@hotmial.com', 'Wayne'],
    ['Ella', 'Johnson', 'ella.j@company.dev', 'Pied Piper'],
    ['Max', 'Weber', 'max.weber@proton.me', 'Vandelay'],
  ];
  return Papa.unparse(rows);
}
