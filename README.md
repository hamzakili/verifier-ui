# MailVerify — Email Verification SaaS

A React (Vite + Tailwind CSS + Lucide) app for verifying single emails and bulk CSV lists, backed by a small Node.js/Express proxy. Two providers are supported:

- **MillionVerifier** (default)
- **NeverBounce** v4.2 (alternative)

You can switch between them at any time from the sidebar. API keys stay on the server.

The app works without any key: a provider with no key runs in the **Mock Sandbox**, which returns realistic simulated results and keeps its own simulated credit balance.

## Quick start

Requires Node.js 18.17+.

```bash
# from this folder
npm run setup          # installs root, server and client dependencies
cp server/.env.example server/.env   # then add your keys (optional)
npm run dev            # starts the API on :4000 and the UI on :5173
```

Open http://localhost:5173.

### Configuration (`server/.env`)

```env
DEFAULT_VERIFICATION_PROVIDER=millionverifier   # or neverbounce; missing/invalid → millionverifier
MILLIONVERIFIER_API_KEY=...
MILLIONVERIFIER_API_URL=https://api.millionverifier.com/api/v3/
NEVERBOUNCE_API_KEY=...
PORT=4000
CORS_ORIGIN=http://localhost:5173
MOCK_STARTING_CREDITS=10000
MAX_BULK_EMAILS=25000

# Laravel Email Registry API (server-side only)
EMAIL_REGISTRY_API_URL=http://127.0.0.1:8000/api   # http only for localhost; https otherwise
EMAIL_REGISTRY_API_TOKEN=...                       # = REGISTRY_API_TOKEN in the Laravel .env
EMAIL_REGISTRY_TIMEOUT=15000                       # full request timeout (ms)
EMAIL_REGISTRY_CONNECT_TIMEOUT=5000                # no-response-yet timeout (ms)
EMAIL_REGISTRY_ENABLED=true                        # false = switch the registry off
EMAIL_REGISTRY_FALLBACK=block                      # or provider
EMAIL_REGISTRY_MAX_AGE_DAYS=0                      # 0 = reuse stored results forever
EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE=90             # keep below Laravel API_RATE_LIMIT
```

On startup the server checks this config. It logs which providers are live, warns about missing keys or invalid values, and sets the active provider to `DEFAULT_VERIFICATION_PROVIDER`.

> Never put API keys in `client/` or in any `VITE_*` variable. Vite bundles those into public JavaScript.

## Providers

| | MillionVerifier | NeverBounce |
|---|---|---|
| Single | `GET api/v3/?api=&email=&timeout=20` | `GET v4.2/single/check` |
| Credits | `GET api/v3/credits` | `GET v4.2/account/info` |
| Bulk | `POST bulkapi/v2/upload` → `fileinfo` (poll) → `download?filter=all` (CSV) | `jobs/create` → `jobs/status` (+ `jobs/start`) → `jobs/results` |
| Flags reported | free email, role account | free, role, DNS, MX, SMTP |
| Typo suggestions | `didyoumean` | `suggested_correction` |

Both providers' statuses are mapped to the same five app statuses: `valid`, `invalid`, `disposable`, `catchall`, `unknown`. MillionVerifier `ok` maps to `valid`, `catch_all` to `catchall`, and `unverified` (or anything unrecognized) to `unknown`. Unclear results are never guessed as valid or invalid.

If a provider doesn't report a check (for example DNS/MX on MillionVerifier), the UI shows "Not provided" instead of "No".

**There is no automatic fallback.** If the active provider fails, you get an error that names that provider, and you can switch providers manually. This prevents unexpected credit use on the other account.

Credits are tracked per provider. The header and dashboard show only the active provider's balance, and balances are never combined. Each provider also has its own separate mock sandbox.

## Email registry (email-first verification)

Verification results are shared through the **Laravel Email Registry API**, a separate project (`C:\wamp64\www\email-registry-api`, `http://127.0.0.1:8000/api`). This app never connects to its database. Only the Node backend talks to the registry, using a bearer token from `server/.env`; the browser only calls this app's backend.

```
Browser ──▶ Node backend (/api/verify/…, /api/registry/…) ──Bearer token──▶ Laravel Email Registry API ──▶ MySQL
                  └──▶ MillionVerifier / NeverBounce — only for emails the registry can't answer
```

**Workflow (single and bulk):**
1. Normalize (`trim + lowercase`) and de-duplicate.
2. `POST /email-verifications/lookup` (chunks of 1,000) **before** any provider call.
3. A usable record (`status=completed` with a `result`, and not older than `EMAIL_REGISTRY_MAX_AGE_DAYS` if set) is returned as is: `cached: true`, 0 credits.
4. Addresses the registry rejects as malformed are skipped: 400 `invalid_email` for a single check, *invalid (not submitted)* in bulk, no credits.
5. Everything else is verified with the active provider. `pending` and `failed` records are re-verified.
6. Each new result is saved with `POST /email-verifications`, an upsert by email, so there are never duplicate rows.

**Result mapping.** The registry stores `result` = `valid | invalid | risky | unverifiable | unknown`. This app maps valid→valid, invalid→invalid, disposable→**risky**, catchall→**risky**, unknown→unknown. The exact app result, flags, typo suggestion and provider details go in `metadata` (`source: "verifier-ui"`, `app_result`, …), so results read back exactly. Records written by other clients use the coarse mapping (risky→Catch-all, unverifiable→Unknown).

**Saving.** Single checks save right away and report `stored`. Bulk results go through a background queue limited to `EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE` (default 90), because the registry allows **120 requests/min per IP** (Laravel `API_RATE_LIMIT`) and has no batch save. For large lists, raise both together. Failed saves are retried with backoff; the job status shows `registrySave { saved, pending, failed }`. Until a result is saved, a repeat request in the same server process reuses it instead of paying again.

**Duplicates.** Concurrent single checks of the same email share one provider call. A bulk job waits for emails another running job is verifying.

**Registry unavailable.**
- `EMAIL_REGISTRY_FALLBACK=block` (default): the request fails with 503 `registry_unavailable` and nothing is sent to a paid provider.
- `EMAIL_REGISTRY_FALLBACK=provider`: emails are verified anyway, the response is flagged `registry.lookup: "unavailable"` (the UI shows a warning), and results are saved when the registry is back.
- A rejected token (401) always blocks, since it's a configuration error.

**Mock Sandbox** never reads or writes the registry, so simulated results can't pollute shared data. If no registry is configured, the app behaves as it did without one.

The **Email Registry** page (`/registry`) shows registry statistics, a searchable and filterable list of records (search, domain, status, result, provider, sort, pagination), and a read-only batch lookup.

## Bulk Verification Jobs

**Bulk Verification Jobs** (`/bulk-jobs`) verifies up to **1,000 leads per import** in the background, batch by batch, and saves every finished batch to a folder you choose. You don't need to keep the page open or export anything by hand:

**Import → split into batches → verify batch → save results → next batch → … → summary → completed**

1. **Import.** Upload a CSV. The server parses and validates it and enforces the 1,000-lead limit; 1,001+ rows are rejected. The email column is detected automatically and you can change it. The preview shows each row's format and duplicate status, plus a summary of imported, unique, duplicate, empty, invalid-format and eligible rows. Every column is kept in the results. Excel files must be saved as CSV first.
2. **Batches.** Choose 100, 250, 500 (default) or 1,000 emails per batch. The server calculates the batches; the last one may be smaller.
3. **Destination folder.** Choose a folder, or create one or a subfolder. Each job writes into its own subfolder, e.g. `November Campaign / Job_20261120_001 /`.
4. **Settings.** The job uses the current provider and live/mock mode, fixed for the whole job. Optionally give the job a name.
5. **Review and start.** The job is saved, queued and returned immediately. Verification runs on the server.

**How a batch runs:** each batch goes through the **existing verification engine** (`central.js`): registry lookup and reuse, one provider bulk job, and results saved back to the registry. Every lead's result is stored in the database, then `batch_NNN_verified.csv` is written and checked. Only then is the batch marked completed and the next batch started. When the last batch finishes, `all_results.csv` (every imported row in original order, duplicates included) and `verification_summary.csv` are generated.

**Controls:**
- **Pause:** the running batch finishes and is saved, then the job stops.
- **Resume:** continues with the next unfinished batch.
- **Cancel:** the running batch is saved and the rest are cancelled. Results and files are kept.
- **Retry:** re-verifies only the failed records of a batch, or only re-saves its file if saving failed. Up to 5 retries per batch.

**Errors:** a failure on one email doesn't fail its batch. Network, registry and provider rate-limit or 5xx errors are retried automatically with backoff. Permanent errors (for example no credits) stop the job with a clear message.

**Restarts:** job state is persisted, so jobs survive a server restart. On start, interrupted jobs resume automatically. A batch that was in flight in live mode is re-attached to its provider job, so nothing is paid for twice, and completed records are never verified again.

**Storage:**
- Job state is stored in a local SQLite database (`server/data/bulk-verification.sqlite`) using Node's built-in `node:sqlite` (Node ≥ 22.13), so no extra dependency is needed.
- Result files are stored in `server/storage/bulk-files/`. They are downloaded through the API only; file paths are never exposed.
- Both folders are git-ignored.
- Settings: `BULK_DB_FILE`, `BULK_STORAGE_DIR`, `BULK_MAX_CONCURRENT_JOBS` (default 1) and `BULK_POLL_MS` in `server/.env`.

**Access:** this app has no user accounts. Every job, folder and file is still stored with an owner ID, and every query is scoped to it. To support multiple users, replace `resolveOwner` in `server/src/bulk/index.js` with the authenticated user or organization.

**Related pages:** **Folders / Files** (`/files`) browses the folders and downloads any saved file. **Verification History** lists finished bulk jobs.

## Project structure

```
├── package.json                    # root scripts (setup / dev / build / start)
├── server/
│   ├── .env.example
│   ├── test/                       # node:test suites (npm test) — stubbed upstream APIs
│   └── src/
│       ├── index.js                # loads config, starts the server
│       ├── app.js                  # Express routes, validation, rate limiting, error handling
│       ├── config.js               # env parsing + startup validation
│       ├── verification.js         # unified service: routes to active provider, job ids, dedupe, result cache
│       ├── providers/
│       │   ├── registry.js         # supported providers, active/default provider, availability
│       │   ├── millionverifier.js  # MillionVerifier adapter (single, credits, bulk)
│       │   └── neverbounceAdapter.js # wraps neverbounce.js / mock.js into the same interface
│       ├── central.js              # email-first workflow: registry lookup → provider → save
│       ├── bulk/                   # Bulk Verification Jobs (1,000-lead imports, batches, folders)
│       │   ├── db.js               # SQLite schema + migrations (jobs, batches, leads, folders, files, imports)
│       │   ├── importer.js         # CSV parsing, email-column detection, classification, batch plans
│       │   ├── jobs.js             # job creation, views, pause/resume/cancel/retry state machine
│       │   ├── runner.js           # background batch processor, retries, restart recovery
│       │   ├── exporter.js         # CSV exports + private file storage (atomic, verified, idempotent)
│       │   ├── folders.js          # logical folders (owner-scoped)
│       │   ├── routes.js           # /api/bulk-verification/* and /api/verification-folders|files/*
│       │   └── index.js            # wiring + owner resolution
│       ├── services/
│       │   ├── emailRegistryService.js # Laravel Email Registry API client (timeouts, retries, errors)
│       │   ├── registryMapping.js      # app result ⇄ registry record mapping, normalization
│       │   └── registrySaveQueue.js    # rate-limited background saves with retry
│       ├── neverbounce.js          # NeverBounce v4.2 REST client
│       ├── mock.js                 # Mock sandbox (one instance per provider)
│       └── errors.js
└── client/src/
    ├── context/                    # AppContext (providers, mode, credits, history), BulkContext, ToastContext
    ├── components/                 # Layout, Sidebar, ProviderSelector, Header, StatusBadge, …
    ├── pages/                      # Dashboard, SingleVerifier, BulkVerifier, BulkJobs, NewBulkJob, BulkJobDetail, Files, History, Registry
    └── lib/                        # api client, CSV helpers, status metadata, formatters
```

## API

| Method | Route | Notes |
|---|---|---|
| GET | `/api/providers` | `{ success, default_provider, active_provider, providers: [{ id, name, available, is_active, is_default }] }` |
| POST | `/api/providers/switch` | Body `{ provider }`. Returns 400 for an unsupported name, 409 if that provider has no key |
| GET | `/api/status` | Active `provider`, `liveAvailable`, effective `mode`, masked key hint |
| GET | `/api/account` | Active provider's credit balance (`creditsRemaining`, plus provider-specific fields) |
| POST | `/api/verify/single` | Body `{ email }`. Keeps the original fields (`result`, `flags`, `creditsUsed`, …) and adds `provider`, `verification { status, is_valid, is_disposable, is_role, is_free, is_catchall }`, `availableFlags`, `credits_used`, `error` |
| POST | `/api/verify/bulk` | Body `{ emails[], filename }`. De-duplicated. Resubmitting a list that is still running returns the existing job (`duplicate: true`) |
| GET | `/api/verify/bulk/:jobId` | Normalized `stage`: uploading → parsing → queued → verifying → complete / failed |
| GET | `/api/verify/bulk/:jobId/results` | Results + `creditsUsed` + new balance. Never downloaded before the provider reports completion; cached after the first fetch |
| POST | `/api/verify/bulk/preview` | Body `{ emails[] }` → `{ total, reusable, pendingElsewhere, toVerify, estimatedCredits }`. Read-only registry check |
| GET | `/api/registry/stats` | Registry statistics (`GET /health/registry`) + local save-queue counters |
| GET | `/api/registry/records` | Query `page, limit (≤100), search, domain, status, result, provider, sort, direction` → `{ records, meta }` |
| GET | `/api/registry/records/:id` | One record, or 404 |
| POST | `/api/registry/lookup` | Body `{ emails[] }` (≤ 5,000) → `{ found, missing, invalid, summary }`. Read-only |
| POST | `/api/mock/reset` | Resets both sandbox balances |
| GET / POST | `/api/verification-folders` | List folders / create `{ folder_name, description?, parent_folder_id? }` |
| GET / DELETE | `/api/verification-folders/:id` | Folder, subfolders, files and breadcrumb / delete (empty, unused folders only) |
| GET | `/api/verification-files/:id/download` | Download a saved result file |
| POST | `/api/bulk-verification/import` | Body `{ filename, content }` (CSV text, ≤ 10 MB, ≤ 1,000 rows) → preview, summary, detected column, `batch_plans` |
| GET / PUT | `/api/bulk-verification/imports/:id` | Get an import / set `{ email_column }` |
| GET | `/api/bulk-verification/plan` | `?eligible=&batch_size=` → batch sizes |
| POST | `/api/bulk-verification/jobs` | Body `{ import_id, batch_size, destination_folder_id, job_name?, email_column?, verification?: { provider, mode }, start?, client_request_id? }`. Idempotent |
| GET | `/api/bulk-verification/jobs` | Query `page, limit, search, status, from, to, sort, direction` → `{ jobs, meta, overview }` |
| GET | `/api/bulk-verification/jobs/:id` and `…/progress` | Job, live progress and batches |
| GET | `/api/bulk-verification/jobs/:id/batches/:batchId` | Batch + paginated per-lead results |
| POST | `/api/bulk-verification/jobs/:id/{start,pause,resume,cancel}` | Job controls (409 for invalid transitions) |
| POST | `/api/bulk-verification/jobs/:id/batches/:batchId/retry` | Retry failed records of a batch |
| GET | `/api/bulk-verification/jobs/:id/batches/:batchId/download` / `/api/bulk-verification/jobs/:id/download` | Batch CSV / complete results CSV |

See [API_ENDPOINTS.md](API_ENDPOINTS.md#part-3--bulk-verification-jobs) for payloads.

The UI sends `x-verifier-mode: mock|live`. Bulk job IDs include the provider and mode (`mv_…`, `nb_…`, `mv-mock_…`), so a job keeps working even if you switch provider or mode while it runs. In the UI, switching provider is locked while a bulk job is running.

Errors are returned as `{ success: false, provider, error: { code, message, details? } }`. Registry errors use `registry_unavailable` (503), `registry_unauthorized` (503, wrong server token), `registry_not_found` (404), `registry_validation` (422, with field errors in `details`), `registry_rate_limited` (429) and `registry_not_configured` (503). The `/verify/single` response includes `registry: { lookup: hit|miss|unavailable|skipped|disabled, saved, recordId }`.

## Tests

```bash
cd server && npm test
cd client && npm test      # display helpers (folder tree, statuses)

# against the real Laravel API (creates and then deletes records under a throwaway example.com subdomain)
REGISTRY_IT_URL=http://127.0.0.1:8000/api REGISTRY_IT_TOKEN=<token> node --test test/registry.integration.test.js

# smoke test of the running stack (Laravel + backend), read-only
pwsh -File scripts/test-registry-api.ps1
```

The tests cover the registry workflow against an in-process double of the Laravel API (lookup-before-provider, reuse, save/upsert, mapping, outdated records, duplicates, mock isolation, registry down/429/401, token never exposed), the registry client (timeouts, retries, error mapping), provider selection and validation, MillionVerifier response and error mapping, the bulk upload/status/download flow, HTTP routes, duplicate-job prevention, and mock credit isolation.

The Bulk Verification Jobs tests (`test/bulk.*.test.js`) cover:
- import limits (100 / 1,000 / 1,001 rows), duplicates, empty and invalid emails, and batch splitting;
- sequential processing where each batch is saved before the next starts, and progress reporting;
- pause, resume, cancel and retry;
- transient errors, permanent errors and storage failures;
- recovery after a restart, including re-attaching to the provider job;
- duplicate-job protection, owner isolation and path traversal;
- end-to-end runs through the real engine, both live (stubbed MillionVerifier plus the registry double) and in the mock sandbox.

Upstream APIs are stubbed, so no credits are spent.

## Mock sandbox patterns

| Input | Result |
|---|---|
| `valid@…` or most normal addresses | `valid` (deterministic per address) |
| `…@gmial.com`, `@yaho.com`, `@hotmial.com`, `@outlok.com` | `invalid` + suggested correction |
| `…@mailinator.com`, `@yopmail.com`, `@guerrillamail.com` | `disposable` |
| `catchall@…` or `…@catchall.test` | `catchall` |
| `unknown@…` or `…@unknown.test` | `unknown` |
| `invalid@…`, `bounce@…`, `fake@…` | `invalid` |

Mock results are always labeled **Mock** in the UI and history, and are never presented as real provider results.

## Notes

- **Credits:** 1 per unique, syntactically valid email. Bad-syntax and empty cells are flagged locally and never sent.
- **The active provider** is held in server memory and resets to `DEFAULT_VERIFICATION_PROVIDER` on restart. The registry is the single place to add per-organization settings later.
- **History** lives in the browser's `localStorage`. Each entry records its provider and mode. Entries from before this update count as NeverBounce.
- **Production:** run `npm run build`, serve `client/dist`, set `VITE_API_BASE=https://your-api` at build time, and set `CORS_ORIGIN` on the server to match.
