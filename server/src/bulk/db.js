/**
 * Persistent store for Bulk Verification Jobs (jobs, batches, leads, folders, files, imports).
 *
 * Uses Node's built-in SQLite (node:sqlite, Node >= 22.13): no extra dependency, transactional,
 * and the state survives restarts. The database is the authoritative copy of every result; the
 * CSV files written to folders are exports of it.
 *
 * Schema changes are applied as numbered migrations recorded in schema_migrations.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  {
    id: 1,
    name: 'create_bulk_verification_tables',
    sql: `
      CREATE TABLE verification_folders (
        id               TEXT PRIMARY KEY,
        owner_id         TEXT NOT NULL,
        parent_folder_id TEXT REFERENCES verification_folders(id) ON DELETE RESTRICT,
        folder_name      TEXT NOT NULL,
        description      TEXT,
        is_job_folder    INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      -- Folder names are unique (case-insensitively) within their parent, per owner.
      CREATE UNIQUE INDEX ux_folders_owner_parent_name
        ON verification_folders (owner_id, IFNULL(parent_folder_id, ''), lower(folder_name));
      CREATE INDEX ix_folders_owner ON verification_folders (owner_id);

      CREATE TABLE bulk_verification_imports (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        columns_json    TEXT NOT NULL,
        rows_json       TEXT NOT NULL,
        email_column    TEXT,
        headerless      INTEGER NOT NULL DEFAULT 0,
        total_rows      INTEGER NOT NULL,
        job_id          TEXT,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL
      );
      CREATE INDEX ix_imports_owner ON bulk_verification_imports (owner_id);

      CREATE TABLE bulk_verification_jobs (
        id                    TEXT PRIMARY KEY,
        owner_id              TEXT NOT NULL,
        organization_id       TEXT,
        import_id             TEXT UNIQUE,
        client_request_id     TEXT,
        job_name              TEXT NOT NULL,
        source_filename       TEXT NOT NULL,
        destination_folder_id TEXT NOT NULL REFERENCES verification_folders(id) ON DELETE RESTRICT,
        job_folder_id         TEXT REFERENCES verification_folders(id) ON DELETE RESTRICT,
        email_column          TEXT NOT NULL,
        columns_json          TEXT NOT NULL,
        total_imported        INTEGER NOT NULL,
        total_eligible        INTEGER NOT NULL,
        total_duplicates      INTEGER NOT NULL DEFAULT 0,
        total_empty           INTEGER NOT NULL DEFAULT 0,
        total_invalid_format  INTEGER NOT NULL DEFAULT 0,
        batch_size            INTEGER NOT NULL,
        total_batches         INTEGER NOT NULL,
        completed_batches     INTEGER NOT NULL DEFAULT 0,
        failed_batches        INTEGER NOT NULL DEFAULT 0,
        verified_count        INTEGER NOT NULL DEFAULT 0,
        failed_count          INTEGER NOT NULL DEFAULT 0,
        valid_count           INTEGER NOT NULL DEFAULT 0,
        invalid_count         INTEGER NOT NULL DEFAULT 0,
        disposable_count      INTEGER NOT NULL DEFAULT 0,
        catchall_count        INTEGER NOT NULL DEFAULT 0,
        unknown_count         INTEGER NOT NULL DEFAULT 0,
        reused_count          INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL,
        progress_percentage   REAL NOT NULL DEFAULT 0,
        pause_requested       INTEGER NOT NULL DEFAULT 0,
        cancel_requested      INTEGER NOT NULL DEFAULT 0,
        retry_count           INTEGER NOT NULL DEFAULT 0,
        error_message         TEXT,
        configuration_json    TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        started_at            TEXT,
        completed_at          TEXT,
        updated_at            TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ux_jobs_owner_client_request
        ON bulk_verification_jobs (owner_id, client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE INDEX ix_jobs_owner_created ON bulk_verification_jobs (owner_id, created_at);
      CREATE INDEX ix_jobs_status ON bulk_verification_jobs (status);

      CREATE TABLE bulk_verification_batches (
        id                TEXT PRIMARY KEY,
        job_id            TEXT NOT NULL REFERENCES bulk_verification_jobs(id) ON DELETE CASCADE,
        batch_number      INTEGER NOT NULL,
        total_emails      INTEGER NOT NULL,
        verified_count    INTEGER NOT NULL DEFAULT 0,
        failed_count      INTEGER NOT NULL DEFAULT 0,
        valid_count       INTEGER NOT NULL DEFAULT 0,
        invalid_count     INTEGER NOT NULL DEFAULT 0,
        disposable_count  INTEGER NOT NULL DEFAULT 0,
        catchall_count    INTEGER NOT NULL DEFAULT 0,
        unknown_count     INTEGER NOT NULL DEFAULT 0,
        reused_count      INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL,
        retry_count       INTEGER NOT NULL DEFAULT 0,
        attempt_count     INTEGER NOT NULL DEFAULT 0,
        error_kind        TEXT,
        error_message     TEXT,
        provider          TEXT,
        engine_job_id     TEXT,
        provider_job_ref  TEXT,
        lease_owner       TEXT,
        output_file_id    TEXT,
        started_at        TEXT,
        completed_at      TEXT,
        duration_ms       INTEGER,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE (job_id, batch_number)
      );
      CREATE INDEX ix_batches_job_status ON bulk_verification_batches (job_id, status);

      CREATE TABLE bulk_verification_job_leads (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id              TEXT NOT NULL REFERENCES bulk_verification_jobs(id) ON DELETE CASCADE,
        batch_id            TEXT REFERENCES bulk_verification_batches(id) ON DELETE CASCADE,
        original_row_number INTEGER NOT NULL,
        email               TEXT NOT NULL,
        normalized_email    TEXT NOT NULL,
        original_data_json  TEXT NOT NULL,
        eligibility         TEXT NOT NULL,          -- eligible | duplicate | empty | invalid_format
        duplicate_of_row    INTEGER,
        processing_status   TEXT NOT NULL,          -- pending | completed | failed | skipped
        verification_status TEXT,                   -- valid | invalid | disposable | catchall | unknown
        verification_result_json TEXT,
        verified_at         TEXT,
        error_message       TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (job_id, original_row_number)
      );
      -- One eligible lead per normalized email per job: duplicates are never verified twice.
      CREATE UNIQUE INDEX ux_leads_job_email_eligible
        ON bulk_verification_job_leads (job_id, normalized_email) WHERE eligibility = 'eligible';
      CREATE INDEX ix_leads_batch_status ON bulk_verification_job_leads (batch_id, processing_status);

      CREATE TABLE verification_files (
        id           TEXT PRIMARY KEY,
        owner_id     TEXT NOT NULL,
        folder_id    TEXT NOT NULL REFERENCES verification_folders(id) ON DELETE RESTRICT,
        job_id       TEXT REFERENCES bulk_verification_jobs(id) ON DELETE CASCADE,
        batch_id     TEXT REFERENCES bulk_verification_batches(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,                 -- batch | summary | all_results
        file_name    TEXT NOT NULL,
        storage_key  TEXT NOT NULL UNIQUE,          -- private, relative to the storage root
        size_bytes   INTEGER NOT NULL,
        row_count    INTEGER,
        sha256       TEXT NOT NULL,
        mime_type    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      -- Export idempotency: one file per (job, batch, kind). Re-exports replace it in place.
      CREATE UNIQUE INDEX ux_files_job_batch_kind ON verification_files (job_id, IFNULL(batch_id, ''), kind);
      CREATE INDEX ix_files_folder ON verification_files (folder_id);
    `,
  },
];

export function openBulkDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Small helper layer: cached prepared statements + transactions. */
function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    /** Run fn inside one transaction (nested calls join the outer one). */
    tx(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth += 1;
      try {
        const r = fn();
        depth -= 1;
        db.exec('COMMIT');
        return r;
      } catch (err) {
        depth -= 1;
        db.exec('ROLLBACK');
        throw err;
      }
    },
    migrations: () => db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all(),
    close: () => db.close(),
  };
}
