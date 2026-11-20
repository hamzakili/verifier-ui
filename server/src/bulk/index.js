/**
 * Bulk Verification Jobs module: wires the database, folders, exporter, job service, background
 * runner and HTTP routes together on top of the app's existing verification engine (`central`).
 */
import { openBulkDatabase } from './db.js';
import { createFolderService } from './folders.js';
import { createExporter, createStorage } from './exporter.js';
import { createJobService } from './jobs.js';
import { createBulkRunner } from './runner.js';
import { createBulkRouter } from './routes.js';

/**
 * This app has no user accounts: it is a single-user tool. Every bulk job, folder and file is
 * still stored with an owner id and every query is scoped to it, so per-user (or per-org)
 * isolation only needs a different resolveOwner — e.g. one that reads the authenticated user
 * from a session or token — without touching the rest of the module.
 */
export const SINGLE_USER_OWNER = 'local';
const defaultResolveOwner = () => SINGLE_USER_OWNER;

export function createBulkModule({ config, central: realCentral, service, providers, limiter, requestedMode, options = {}, logger = options.logger || console }) {
  // options.engine: tests substitute a controllable engine with the same interface as `central`.
  const central = options.engine || realCentral;
  const db = openBulkDatabase(options.dbFile ?? config.bulk.dbFile);
  const storage = createStorage(options.storageDir ?? config.bulk.storageDir);
  const folders = createFolderService(db);
  const exporter = createExporter({ db, storage });
  const jobs = createJobService({
    db,
    folders,
    providers,
    resolveMode: (mode, provider) => service.resolve(mode, provider).mode,
    registryEnabled: Boolean(central.enabled),
    logger,
  });
  const runner = createBulkRunner({
    db,
    jobs,
    central,
    providers,
    exporter,
    options: { pollMs: config.bulk.pollMs, maxConcurrentJobs: config.bulk.maxConcurrentJobs, ...(options.runner || {}) },
    logger,
  });
  jobs.attachRunner(runner);
  const router = createBulkRouter({ jobs, folders, storage, resolveOwner: options.resolveOwner || defaultResolveOwner, limiter, requestedMode });

  return {
    db,
    storage,
    folders,
    jobs,
    runner,
    router,
    async close() {
      await runner.stop();
      db.close();
    },
  };
}
