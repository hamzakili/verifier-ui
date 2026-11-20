import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, registry, store, bulk } = createApp(config);

const server = app.listen(config.port, async () => {
  console.log(`\n  Verifier API listening on http://localhost:${config.port}`);
  for (const p of registry.list()) {
    const tag = p.available ? `LIVE (key ${registry.keyHint(p.id)})` : 'not configured — mock only';
    console.log(`  ${p.is_active ? '●' : '○'} ${p.name.padEnd(16)} ${tag}${p.is_default ? '  [default]' : ''}`);
  }

  if (store) {
    const h = await store.health();
    const where = config.registryApi.url;
    if (!h.connected) {
      console.warn(`  ✗ Email registry API  UNAVAILABLE (${where}): ${h.error}`);
      console.warn(config.registryOptions.fallback === 'provider'
        ? '    EMAIL_REGISTRY_FALLBACK=provider: emails will be verified without the registry until it is reachable.'
        : '    Verification requests will be refused until it is reachable (no paid provider calls without a registry lookup).');
    } else {
      console.log(`  ● Email registry API  connected (${where}) — ${h.stats.total.toLocaleString()} records — email-first verification ON`);
    }
  }

  if (bulk) {
    // Resume bulk verification jobs that were running when the server last stopped.
    const resumed = bulk.runner.recover();
    console.log(`  ● Bulk verification jobs  ready${resumed ? ` — resuming ${resumed} interrupted job(s)` : ''}`);
  }

  for (const w of config.warnings) console.warn(`  ! ${w}`);
  console.log('');
});

// Graceful shutdown: stop scheduling batches; job state stays in the database and is resumed on the next start.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${signal}: shutting down…`);
    server.close();
    const force = setTimeout(() => process.exit(0), 5_000);
    force.unref();
    await bulk?.close().catch(() => {});
    process.exit(0);
  });
}
