/**
 * Write-behind queue for POST /email-verifications (one request per email: the registry has no
 * batch save). Keeps bulk jobs within the registry's per-IP rate limit and leaves headroom for
 * interactive requests (lookups, the registry page).
 *
 *  - ratePerMinute: max saves started per minute (token bucket, EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE).
 *  - Transient failures (unavailable / rate limited) are retried with exponential backoff
 *    (store.save itself already retries quickly); 4xx validation errors are dropped and logged.
 *  - Until a save is confirmed, the result is held in `pending` so a repeat request in this
 *    process reuses it instead of paying the provider again.
 */
const TRANSIENT = new Set(['registry_unavailable', 'registry_rate_limited']);

export function createSaveQueue({ store, ratePerMinute = 90, concurrency = 4, maxAttempts = 8, baseDelayMs = 2_000, logger = console }) {
  const queue = []; // { payload, attempts, onDone }
  const pending = new Map(); // normalized email -> payload (not yet confirmed saved)
  const stats = { saved: 0, failed: 0 };
  let active = 0;
  let tokens = Math.max(1, ratePerMinute);
  let lastRefill = Date.now();
  let timer = null;
  let idleWaiters = [];

  function refill() {
    const now = Date.now();
    tokens = Math.min(ratePerMinute, tokens + ((now - lastRefill) / 60_000) * ratePerMinute);
    lastRefill = now;
  }

  function schedule(ms) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, ms);
    timer.unref?.();
  }

  function settleIdle() {
    if (active === 0 && queue.length === 0 && !timer) {
      for (const w of idleWaiters) w();
      idleWaiters = [];
    }
  }

  function pump() {
    refill();
    while (active < concurrency && queue.length) {
      const now = Date.now();
      const idx = queue.findIndex((it) => it.notBefore <= now);
      if (idx === -1) break;
      if (tokens < 1) {
        schedule(Math.ceil(((1 - tokens) / ratePerMinute) * 60_000));
        return;
      }
      tokens -= 1;
      const item = queue.splice(idx, 1)[0];
      active += 1;
      run(item).finally(() => {
        active -= 1;
        pump();
      });
    }
    if (queue.length && active < concurrency) {
      const next = Math.min(...queue.map((it) => it.notBefore));
      schedule(Math.max(10, next - Date.now()));
      return;
    }
    settleIdle();
  }

  async function run(item) {
    item.attempts += 1;
    try {
      const { record } = await store.save(item.payload);
      pending.delete(item.payload.email);
      stats.saved += 1;
      item.onDone?.(true, record);
    } catch (err) {
      if (TRANSIENT.has(err.code) && item.attempts < maxAttempts) {
        item.notBefore = Date.now() + baseDelayMs * 2 ** (item.attempts - 1);
        queue.push(item);
        return;
      }
      pending.delete(item.payload.email);
      stats.failed += 1;
      logger.error?.(`[registry] ${JSON.stringify({ event: 'registry_save_failed', code: err.code, status: err.status, attempts: item.attempts, domain: item.payload.email.split('@')[1] })}`);
      item.onDone?.(false, null, err);
    }
  }

  return {
    pending,
    /** Queue a save; onDone(ok, record, err) is called when it is saved or given up. */
    enqueue(payload, onDone) {
      pending.set(payload.email, payload);
      queue.push({ payload, attempts: 0, notBefore: 0, onDone });
      pump();
    },
    /** Save now (single verifications). On a transient failure the save is queued for retry and the error rethrown. */
    async saveNow(payload) {
      pending.set(payload.email, payload);
      refill();
      tokens -= 1; // counts against the same budget (may go briefly negative)
      try {
        const r = await store.save(payload);
        pending.delete(payload.email);
        stats.saved += 1;
        return r;
      } catch (err) {
        if (TRANSIENT.has(err.code)) {
          queue.push({ payload, attempts: 1, notBefore: Date.now() + baseDelayMs, onDone: null });
          pump();
        } else {
          pending.delete(payload.email);
          stats.failed += 1;
        }
        throw err;
      }
    },
    stats: () => ({ queued: queue.length + active, saved: stats.saved, failed: stats.failed }),
    /** Resolves when nothing is queued or running (tests, graceful shutdown). */
    idle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    },
    stop() {
      clearTimeout(timer);
      timer = null;
      queue.length = 0;
    },
  };
}
