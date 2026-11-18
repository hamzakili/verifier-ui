# MailVerify — Setup & Architecture Guide

This guide covers how the MailVerify email verification app is put together, how to install and configure it, how verification providers work, and how to troubleshoot it.

---

## Contents

1. [What the app does](#1-what-the-app-does)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Installation](#4-installation)
5. [Configuration (`server/.env`)](#5-configuration-serverenv)
6. [Running the app](#6-running-the-app)
7. [Verification providers](#7-verification-providers)
8. [Live mode vs. Mock Sandbox](#8-live-mode-vs-mock-sandbox)
9. [Feature walkthrough](#9-feature-walkthrough)
10. [Backend API reference](#10-backend-api-reference)
11. [Bulk verification lifecycle](#11-bulk-verification-lifecycle)
12. [Credits](#12-credits)
13. [Security](#13-security)
14. [Testing](#14-testing)
15. [Project structure](#15-project-structure)
16. [Troubleshooting](#16-troubleshooting)
17. [Extending the app](#17-extending-the-app)

---

## 1. What the app does

MailVerify checks whether email addresses are deliverable. It supports:

- **Single email verification:** check one address in real time, with typo suggestions such as "Did you mean `user@gmail.com`?".
- **Bulk CSV verification:** upload a CSV, pick the email column, verify every unique address, then export the full results or a clean list of valid emails only.
- **Two verification providers:** **MillionVerifier** (default) and **NeverBounce** (alternative). You can switch between them from the UI without restarting.
- **Mock Sandbox:** simulated results and credits, so you can use the app without spending real credits or having API keys.
- **Dashboard and history:** credit balance, deliverability rate, status breakdown, and a log of every check and bulk job.

Every result is normalized to one of five statuses:

| Status | Meaning |
|---|---|
| `valid` | Mailbox exists and accepts mail. Safe to send. |
| `invalid` | Address or domain does not exist. Will bounce. |
| `disposable` | Temporary / throwaway inbox provider. |
| `catchall` | Domain accepts all mail, so the mailbox can't be confirmed. |
| `unknown` | The provider couldn't get a definitive answer. |

---

## 2. Architecture

```
┌──────────────────────────┐        /api/*         ┌──────────────────────────────────┐
│  Browser (React + Vite)  │ ────────────────────▶ │  Express proxy  (server/, :4000) │
│  client/, :5173          │ ◀──────────────────── │                                  │
│                          │   normalized JSON     │  app.js            routes        │
│  • Sidebar provider pick │                       │  verification.js   unified svc   │
│  • Live / Mock toggle    │                       │  providers/registry.js  active   │
│  • CSV parsed in-browser │                       │       │                          │
└──────────────────────────┘                       │       ├─▶ millionverifier.js ──────┼──▶ api.millionverifier.com
                                                   │       │                           │    bulkapi.millionverifier.com
     API keys NEVER reach                          │       ├─▶ neverbounceAdapter.js    │
     the browser                                   │       │      └─▶ neverbounce.js ───┼──▶ api.neverbounce.com/v4.2
                                                   │       └─▶ mock.js (per provider)   │
                                                   │  central.js  email-first layer     │
                                                   │       └─▶ services/emailRegistryService.js ──Bearer──▶ Laravel Email Registry API
                                                   └──────────────────────────────────┘                     (127.0.0.1:8000/api)
```

**Key design points**

- **Proxy pattern:** the browser only talks to the Express server, and only the server holds API keys. In development, Vite forwards `/api` requests to `http://localhost:4000`.
- **Provider adapters:** each provider is wrapped in an adapter that exposes the same interface (`getCredits`, `verifySingle`, `createJob`, `jobStatus`, `jobResults`). Routes never call provider APIs directly.
- **Unified verification service** (`verification.js`): picks the correct adapter based on the active provider and the requested mode (live/mock), then returns one normalized response format.
- **Server is the source of truth** for which provider is active. The UI reads it from `GET /api/providers` and changes it through `POST /api/providers/switch`.
- **Email registry first:** before any paid verification, `central.js` looks the emails up in the Laravel Email Registry API and reuses stored results; new results are saved back. Only the server holds the registry token (see §7.4).
- **No automatic fallback:** if the active provider fails, the error is returned to the user. The app never silently switches providers and spends another account's credits.

---

## 3. Prerequisites

| Requirement | Version / notes |
|---|---|
| Node.js | **18.17 or newer** (developed on Node 22). Needed for built-in `fetch`, `FormData` and `node --watch`. |
| npm | Comes with Node (10.x tested). |
| MillionVerifier account | Optional. API key from https://app.millionverifier.com/api |
| NeverBounce account | Optional. API key from NeverBounce → *Apps → Custom Integration* |

Without any keys, the app runs entirely in the Mock Sandbox.

---

## 4. Installation

From the project folder (`verifier-ui/`):

```bash
npm run setup
```

This installs dependencies in three places:

| Folder | Installs |
|---|---|
| `./` (root) | `concurrently`, which runs both servers with one command |
| `server/` | `express`, `cors`, `dotenv`, `papaparse` |
| `client/` | `react`, `react-dom`, `react-router-dom`, `lucide-react`, `papaparse`, `vite`, `tailwindcss` |

Then create your environment file:

```bash
cp server/.env.example server/.env
```

On Windows PowerShell: `Copy-Item server/.env.example server/.env`

---

## 5. Configuration (`server/.env`)

```env
# Default verification provider (millionverifier | neverbounce)
DEFAULT_VERIFICATION_PROVIDER=millionverifier

# MillionVerifier API
MILLIONVERIFIER_API_KEY=
MILLIONVERIFIER_API_URL=https://api.millionverifier.com/api/v3/
# Optional: MILLIONVERIFIER_BULK_API_URL=https://bulkapi.millionverifier.com/bulkapi/v2/

# NeverBounce API (key starts with "private_" or "secret_")
NEVERBOUNCE_API_KEY=

# Express configuration
PORT=4000
CORS_ORIGIN=http://localhost:5173

# Mock sandbox configuration
MOCK_STARTING_CREDITS=10000

# Bulk verification configuration
MAX_BULK_EMAILS=25000
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DEFAULT_VERIFICATION_PROVIDER` | No | `millionverifier` | Provider that is active when the server starts. Missing or invalid values fall back to `millionverifier`. |
| `MILLIONVERIFIER_API_KEY` | For live MillionVerifier | — | If empty, MillionVerifier runs in mock mode only and can't be selected as a live provider. |
| `MILLIONVERIFIER_API_URL` | No | `https://api.millionverifier.com/api/v3/` | Real-time + credits API base. Must be `https`. |
| `MILLIONVERIFIER_BULK_API_URL` | No | `https://bulkapi.millionverifier.com/bulkapi/v2/` | Bulk API base. |
| `NEVERBOUNCE_API_KEY` | For live NeverBounce | — | If empty, NeverBounce runs in mock mode only. |
| `PORT` | No | `4000` | Express port. The Vite proxy targets this port. |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed browser origin(s), comma-separated. |
| `MOCK_STARTING_CREDITS` | No | `10000` | Starting balance of each provider's sandbox. |
| `MAX_BULK_EMAILS` | No | `25000` | Max unique emails per bulk job. |
| `EMAIL_REGISTRY_API_URL` | For the registry | — | Laravel Email Registry API base URL, e.g. `http://127.0.0.1:8000/api`. `http` is accepted only for localhost/127.0.0.1; any other host must use `https`. Empty disables the registry. |
| `EMAIL_REGISTRY_API_TOKEN` | For the registry | — | Bearer token; must equal `REGISTRY_API_TOKEN` in the Laravel project's `.env`. Server-side only. |
| `EMAIL_REGISTRY_TIMEOUT` | No | `15000` | Full request timeout (ms). |
| `EMAIL_REGISTRY_CONNECT_TIMEOUT` | No | `5000` | Abort if the registry hasn't started responding within this time (ms). |
| `EMAIL_REGISTRY_ENABLED` | No | `true` | `false` switches the registry off without removing the URL or token. |
| `EMAIL_REGISTRY_FALLBACK` | No | `block` | `block`: refuse to verify when the registry can't be checked. `provider`: verify anyway, flag the response, save later. |
| `EMAIL_REGISTRY_MAX_AGE_DAYS` | No | `0` | Re-verify stored results older than this (0 = reuse forever). |
| `EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE` | No | `90` | Max registry saves per minute. Keep below Laravel's `API_RATE_LIMIT` (default 120 per IP per minute). |

The app never connects to the registry's database; it only uses the Laravel API.

**Startup validation:** when the server starts, it prints which providers are live, which one is active and which is the default. It also warns about anything wrong:

```
  Verifier API listening on http://localhost:4000
  ● MillionVerifier  LIVE (key ••••abcd)  [default]
  ○ NeverBounce      LIVE (key private_••••wxyz)
```

Keys are always masked in logs and API responses. `server/.env` is listed in `.gitignore`, so it is never committed.

---

## 6. Running the app

### Development

```bash
npm run dev
```

This starts both processes:

| Process | URL | Notes |
|---|---|---|
| Express API | http://localhost:4000 | Auto-restarts on file changes (`node --watch`) |
| Vite UI | **http://localhost:5173** | Hot reload; `/api` is proxied to :4000 |

Open **http://localhost:5173**.

To run them separately:

```bash
cd server && npm run dev
cd client && npm run dev
```

### Production

```bash
npm run build                 # builds client/dist
npm start                     # starts the API (server/src/index.js)
```

Serve `client/dist` from any static host. If the API is on a different origin, build the client with `VITE_API_BASE=https://your-api.example.com` and set `CORS_ORIGIN` on the server to the UI's origin.

---

## 7. Verification providers

### 7.1 Switching providers

- **In the UI:** use the **Verification provider** section in the sidebar (visible on every page).
  - MillionVerifier is labeled *Default* and NeverBounce *Alternative*.
  - A green dot means the provider is configured. Providers without a key show as *not configured* and can't be selected.
  - A spinner shows while the switch is in progress, then a toast confirms it. The header and dashboard reload the new provider's balance.
  - Switching is **locked while a bulk job is running**.
- **Via the API:** `POST /api/providers/switch` with `{ "provider": "neverbounce" }`.
- **Scope:** the active provider is stored in server memory and applies to every later request: single checks, bulk jobs and credit lookups. It resets to `DEFAULT_VERIFICATION_PROVIDER` when the server restarts.

### 7.2 MillionVerifier (default)

| Operation | Endpoint |
|---|---|
| Single check | `GET https://api.millionverifier.com/api/v3/?api=KEY&email=…&timeout=20` |
| Credits | `GET https://api.millionverifier.com/api/v3/credits?api=KEY` → `{ credits, bulk_credits, renewing_credits, plan }` |
| Bulk upload | `POST https://bulkapi.millionverifier.com/bulkapi/v2/upload?key=KEY` (multipart field `file_contents`, a CSV with an `email` header) |
| Bulk status | `GET …/bulkapi/v2/fileinfo?key=KEY&file_id=…` |
| Bulk results | `GET …/bulkapi/v2/download?key=KEY&file_id=…&filter=all` (CSV report) |

**Result mapping**

| MillionVerifier `result` | App status |
|---|---|
| `ok` | `valid` |
| `catch_all` | `catchall` |
| `invalid` | `invalid` |
| `disposable` | `disposable` |
| `unknown` | `unknown` |
| `unverified` | `unknown` |
| anything else | `unknown` (never guessed as valid/invalid) |

**Other fields:** `free` becomes the *Free email host* flag, `role` becomes *Role account*, and `didyoumean` becomes the typo suggestion. The raw `quality`, `subresult`, `resultcode` and `livemode` values are returned in `providerDetails` for troubleshooting.

**Not reported by MillionVerifier:** DNS, MX and SMTP checks. The UI shows these as *Not provided*, not *No*.

**Errors:** MillionVerifier returns most errors as **HTTP 200** with an `error` string, so every response body is checked:

| Error text | App response |
|---|---|
| `Apikey not found`, `invalid_api_key` | 401 `auth_failure` |
| `Insufficient credits` | 402 `insufficient_credits` |
| `IP address blocked` | 403 `ip_blocked` |
| `file_not_found` | 404 `job_not_found` |
| HTTP 429 | 429 `rate_limited` |
| Network failure, timeout, 5xx, `Internal error` | 503 `provider_unavailable`: *"MillionVerifier is temporarily unavailable … switch to NeverBounce manually."* |

**Bulk file statuses:** `in_queue_to_start` (queued) → `in_progress` (verifying) → `finished` (complete). `paused`, `canceled` and `error` show as a failed job with an explanation and a **Retry** button. A paused file usually means insufficient credits; resume it in the MillionVerifier dashboard, then press Retry.

### 7.3 NeverBounce (alternative)

| Operation | Endpoint (v4.2) |
|---|---|
| Single check | `GET single/check` with `address_info=1`, `credits_info=1` |
| Credits | `GET account/info` |
| Bulk | `POST jobs/create` (`auto_parse=1`, `auto_start=0`) → `GET jobs/status` (the server calls `POST jobs/start` once parsing finishes) → `GET jobs/results` (paged, 1000 per page) |

NeverBounce returns its own five statuses directly, along with flags such as `has_dns`, `has_dns_mx`, `smtp_connectable`, `free_email_host`, `role_account` and `accepts_all`. The original client (`server/src/neverbounce.js`) is unchanged; `neverbounceAdapter.js` wraps it.

---

### 7.4 Email registry (email-first verification)

The registry is the separate **Laravel Email Registry API** project (`C:\wamp64\www\email-registry-api`, served at `http://127.0.0.1:8000/api`). This app doesn't contain or modify it. All registry calls go through one server-side client, `server/src/services/emailRegistryService.js`, which sends `Authorization: Bearer <EMAIL_REGISTRY_API_TOKEN>`. The browser calls only this app's backend.

```
email ─▶ normalize (trim + lowercase) ─▶ POST /email-verifications/lookup
            │
            ├─ status=completed with a result (and not older than MAX_AGE_DAYS) ─▶ return stored result, 0 credits
            └─ missing / pending / failed / outdated ─▶ active provider ─▶ POST /email-verifications (upsert) ─▶ result
```

| Laravel endpoint | Used for |
|---|---|
| `POST /email-verifications/lookup` | Before every single and bulk verification (chunks of 1,000), the bulk credit preview, and the Registry page batch lookup |
| `POST /email-verifications` | Saving each new result (upsert by email: no duplicates) |
| `GET /email-verifications` | Registry page list: `page, limit, search, domain, status, result, provider, sort, direction` |
| `GET /email-verifications/{id}` | Record detail (`/api/registry/records/:id`) |
| `GET /health` | Public liveness check, so the status can tell "registry down" apart from "token rejected" |
| `GET /health/registry` | Statistics, plus the connectivity check behind the sidebar status |
| `PUT` / `DELETE /email-verifications/{id}` | Implemented in the client (`update`, `remove`) and covered by tests. Not exposed to the browser |

**Result mapping:** valid→`valid`, invalid→`invalid`, disposable→`risky`, catchall→`risky`, unknown→`unknown`. Saved with `status: completed`, `provider` and a short `reason`. The exact result, flags, typo suggestion and provider details are stored in `metadata` (`source: "verifier-ui"`, `origin`, `app_result`, …) and read back exactly. Records from other clients map `risky`→Catch-all and `unverifiable`→Unknown.

**Rules:**
- Results are reused across providers: an email verified by NeverBounce is answered from the registry when MillionVerifier is active.
- Addresses the registry rejects as malformed (PHP `FILTER_VALIDATE_EMAIL`, stricter than the app's own syntax check) are never sent to a provider: 400 `invalid_email` for a single check, *invalid (not submitted)* in bulk.
- Provider errors are not saved (the record stays as it was) and are never retried on the other provider.
- **Duplicates:** concurrent single checks of one email share one provider call. A bulk job waits for emails another running job is verifying. Saves are upserts.
- **Rate limit:** Laravel allows `API_RATE_LIMIT` (default 120) requests/min per IP and has no batch save. Bulk saves therefore run in a background queue capped at `EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE`, retried with backoff; 429 responses honour `Retry-After`. Results are shown as soon as the provider finishes, and the job status reports `registrySave { saved, pending, failed }`. Until a result is saved, the same server process reuses it instead of paying again. For large lists, raise `API_RATE_LIMIT` in the Laravel `.env` and `EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE` together.
- **Mock Sandbox** never reads or writes the registry.

**Setup**

1. Start the Laravel API (`php artisan serve` in `C:\wamp64\www\email-registry-api`, port 8000).
2. In `server/.env`, set `EMAIL_REGISTRY_API_URL=http://127.0.0.1:8000/api` and `EMAIL_REGISTRY_API_TOKEN` to the Laravel `REGISTRY_API_TOKEN`.
3. Restart `npm run dev`. The server prints `● Email registry API connected (…) — N records — email-first verification ON`, and the sidebar shows **Email registry: Connected / Unavailable / Not configured**.

**Registry unavailable:** with the default `EMAIL_REGISTRY_FALLBACK=block`, a network error, timeout, 5xx or 401 refuses the verification with HTTP 503 `registry_unavailable` and calls no provider. A lookup failure is never reported as a result. With `provider`, verification continues: the single response carries `registry.lookup: "unavailable"`, the UI shows a warning, and the result is saved once the registry is back. A wrong token (401) always blocks.

**In the UI:**
- Results reused from the registry show *Reused from the email registry · verified … · no credit used*. If a fresh result couldn't be saved yet, or the registry was skipped, a warning says so.
- Before a bulk run, the Bulk page shows how many emails are already in the registry and the real credit estimate. Reused rows get a **DB** tag, and exports include a `verification_source` column.
- The **Email Registry** page lists, searches and filters records, shows statistics, and runs read-only batch lookups.

## 8. Live mode vs. Mock Sandbox

The **API mode** toggle sits in the sidebar under the provider selector.

| | Live | Mock Sandbox |
|---|---|---|
| Calls real provider API | Yes | No |
| Spends real credits | Yes | No (simulated balance) |
| Available when | The active provider has an API key | Always |
| Labeled in UI | "MillionVerifier · Live" | "MillionVerifier · Mock Sandbox" (amber) |

- If the active provider has **no key**, the server automatically uses mock mode for it.
- **Each provider has its own sandbox** with its own balance. Mock MillionVerifier results also mimic MillionVerifier's flag set.
- Mock results are always tagged **Mock** in results and history. They are never presented as real verifications.
- The sandbox balance resets when the server restarts, or via `POST /api/mock/reset`.

**Test addresses that give predictable mock results**

| Input | Result |
|---|---|
| `valid@…` or most ordinary addresses | `valid` (deterministic per address) |
| `…@gmial.com`, `@yaho.com`, `@hotmial.com`, `@outlok.com` | `invalid` + suggested correction |
| `…@mailinator.com`, `@yopmail.com`, `@guerrillamail.com` | `disposable` |
| `catchall@…` or `…@catchall.test` | `catchall` |
| `unknown@…` or `…@unknown.test` | `unknown` |
| `invalid@…`, `bounce@…`, `fake@…` | `invalid` |

The Bulk page's **Sample CSV** button downloads a file that covers all of these, plus a duplicate and a bad-syntax row.

---

## 9. Feature walkthrough

### Header (every page)
- **Status pill:** active provider and mode, e.g. "MillionVerifier · Live". Shows "Server offline" if the API can't be reached.
- **Credit pill:** the active provider's remaining credits, credits used this browser session for that provider, and a refresh button. Shows "Balance unavailable" if the balance can't be fetched.

### Dashboard
- KPI cards: remaining credits, total credits used (active provider), deliverability rate, and the count of invalid + disposable addresses blocked.
- Status breakdown bar with legend and hover details.
- Quick actions: *Verify a single email* and *Upload a CSV file*.
- Recent activity: the last 8 checks and jobs, each tagged with provider and mode (e.g. `MV · Live`).

### Single Email Verifier
- Type an address and click **Verify Email**. Obviously malformed input is rejected in the browser, so no credit is spent on it.
- Sample buttons fill in test addresses. In live mode they spend real credits.
- The result card shows a color-coded status, the provider and mode, `Credits Used: 1 | Remaining: N`, a typo suggestion with one-click re-verify, detail flags, and execution time.

### Bulk CSV Verifier
1. **Upload:** drag and drop a `.csv` file (up to 20 MB). It is parsed in the browser with papaparse, and files without a header row are detected.
2. **Review:** the email column is auto-detected and can be changed from a dropdown. You see a 5-row preview; counts of total rows, valid syntax, duplicates and bad/empty cells; the estimated credits (1 per unique email); and which provider will be used.
3. **Verify:** a progress bar shows *Uploading → Parsing → Verifying X% → Complete* with a live tally. You can leave the page while it runs; the sidebar shows the percentage.
4. **Results:** a summary of rows, unique emails processed, credits used and remaining balance, plus the status breakdown and a filterable, searchable, paginated table.
   - **Download Full CSV:** your original columns plus `verification_status`, `suggested_correction`, `verification_flags` and `verification_note`.
   - **Download Clean List:** valid emails only, one row per unique address.

### Verification History
- Every check and job, with filters (All / Single / Bulk), search, per-row delete, clear-all, and CSV export (including a `provider` column).
- Stored in the browser's `localStorage` (up to 500 entries). Entries from before provider support was added count as NeverBounce.

---

## 10. Backend API reference

All endpoints are under `/api`. Errors always look like this:

```json
{ "success": false, "provider": "millionverifier", "error": { "code": "rate_limited", "message": "…" } }
```

Requests may include the header `x-verifier-mode: live | mock`.

### Provider management

**`GET /api/providers`**
```json
{
  "success": true,
  "default_provider": "millionverifier",
  "active_provider": "millionverifier",
  "providers": [
    { "id": "millionverifier", "name": "MillionVerifier", "available": true, "is_active": true,  "is_default": true },
    { "id": "neverbounce",     "name": "NeverBounce",     "available": true, "is_active": false, "is_default": false }
  ]
}
```

**`POST /api/providers/switch`**, body `{ "provider": "neverbounce" }`
```json
{ "success": true, "message": "Verification provider switched successfully.", "active_provider": "neverbounce", "providers": [ … ] }
```
| Case | Status | Code |
|---|---|---|
| Missing provider | 400 | `missing_provider` |
| Unsupported name | 400 | `unsupported_provider` |
| Provider has no API key | 409 | `provider_not_configured` |

### Status & credits

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/status` | `provider`, `providerName`, `defaultProvider`, `liveAvailable`, `mode`, `keyHint` (masked), `maxBulkEmails` |
| `GET /api/account` | `provider`, `mode`, `creditsRemaining`, plus provider fields (MillionVerifier: `bulkCredits`, `renewingCredits`, `plan`; NeverBounce: `paidCreditsRemaining`, `freeCreditsRemaining`, `jobCounts`, …) |

### Single verification

**`POST /api/verify/single`**, body `{ "email": "user@example.com" }`

```json
{
  "mode": "live",
  "email": "user@example.com",
  "result": "valid",
  "flags": ["free_email_host"],
  "suggestedCorrection": "",
  "addressInfo": null,
  "executionTime": 262,
  "creditsUsed": 1,
  "creditsRemaining": 25487,
  "checkedAt": "2026-11-16T09:30:00.000Z",

  "success": true,
  "provider": "millionverifier",
  "providerName": "MillionVerifier",
  "availableFlags": ["free_email_host", "role_account"],
  "verification": {
    "status": "valid",
    "is_valid": true,
    "is_disposable": false,
    "is_role": false,
    "is_free": true,
    "is_catchall": false,
    "subresult": "ok",
    "quality": "good"
  },
  "credits_used": 1,
  "providerDetails": { "result": "ok", "resultcode": 1, "subresult": "ok", "quality": "good", "livemode": true },
  "error": null
}
```

The first block holds the original fields the frontend already used. `result` stays a plain string for backward compatibility. The second block holds the provider-aware additions. A field the provider doesn't report is `null`; for example, `is_role` is `null` if the provider has no role flag.

### Bulk verification

| Route | Body / result |
|---|---|
| `POST /api/verify/bulk` | Body `{ emails: string[], filename?: string }` → `{ jobId, provider, mode, submitted, uniqueEmails, skipped, duplicate }`. 201 for a new job, 200 if `duplicate: true` (the same list is already running). |
| `GET /api/verify/bulk/:jobId` | `{ stage, rawStatus, percent, total, processed, billable, counts: {valid, invalid, disposable, catchall, unknown}, failureReason }` |
| `GET /api/verify/bulk/:jobId/results` | `{ results: [{ id, email, result, flags, suggestedCorrection }], creditsUsed, creditsRemaining, provider, mode }`. Returns 409 if the job isn't complete. |
| `POST /api/mock/reset` | Resets both sandbox balances. |

**Job ID format:** `mv_<id>`, `nb_<id>`, `mv-mock_<id>` or `nb-mock_<id>`. Because the provider and mode are part of the ID, status and results requests always reach the right backend, even if you switch provider or mode mid-job.

---

## 11. Bulk verification lifecycle

```
Browser                                Server                                  Provider
───────                                ──────                                  ────────
parse CSV (papaparse)
dedupe + syntax check
POST /verify/bulk  ───────────────▶  validate, dedupe, cap at MAX_BULK_EMAILS
                                     duplicate check (same list running?) ──▶ reuse jobId
                                     adapter.createJob()  ───────────────────▶ MV: upload CSV
                                                                               NB: jobs/create
                    ◀───────────────  { jobId: "mv_123" }
poll every 1.5s
GET /verify/bulk/:id ─────────────▶  adapter.jobStatus() ────────────────────▶ MV: fileinfo
                                                                               NB: jobs/status (+ jobs/start once)
                    ◀───────────────  { stage, percent, counts }
… until stage = complete …
GET /…/results     ───────────────▶  confirm complete, then download ───────▶ MV: download CSV
                                                                               NB: jobs/results (all pages)
                                     normalize, cache, fetch new balance
                    ◀───────────────  { results, creditsUsed, creditsRemaining }
map results back to every CSV row
record in history, offer exports
```

**Safeguards**
- **Duplicate submissions:** a list that is still running is not submitted twice; the server returns the existing job. The browser also ignores double-clicks.
- **No early download:** results are only downloaded after the provider reports the job as complete.
- **No double processing:** finished results are cached on the server (last 20 jobs), concurrent results requests share one download, and the browser processes each job only once.
- **Failures:** failed, paused or canceled jobs show the reason with **Retry** and **Start over** buttons. Network errors and rate limits during polling are retried with exponential backoff (up to 6 consecutive failures).
- **Non-blocking:** all provider calls are async with timeouts (30s for normal calls, 120s for bulk upload/download). The server never blocks while waiting on a job.

---

## 12. Credits

- **Cost:** 1 credit per **unique, syntactically valid** email. Duplicates (case-insensitive), bad-syntax and empty cells are filtered out before submission and cost nothing.
- **Shown balance:** always the **active provider's** balance as reported by that provider's API. It is updated after each verification and refreshed whenever you switch provider.
- **Never combined:** MillionVerifier and NeverBounce balances, usage counters and mock sandboxes are kept separate.
- **"Used this session":** per provider, stored in `sessionStorage` (clears when the tab closes).
- **"Total credits used" on the dashboard:** the active provider's total from local history.
- **Insufficient credits:** the server returns 402 with a clear message. The Bulk page also warns, and disables the start button, if the estimate is larger than your balance.

---

## 13. Security

| Concern | How it's handled |
|---|---|
| API key exposure | Keys exist only in `server/.env` and server memory. They are never sent in responses or written to browser storage. The UI only sees a masked hint (`••••abcd`). |
| Logging | Keys and request URLs containing keys are never logged. Error messages are rewritten so they never include provider URLs. |
| Version control | `server/.env` is gitignored; only `.env.example` (with no values) is committed. |
| Client env vars | Keys must never go in `client/` or any `VITE_*` variable, because Vite embeds those in public JavaScript. |
| Input validation | Email syntax and length are checked on the client and server, provider names are validated against an allow-list, and JSON bodies are limited to 5 MB. |
| File uploads | CSV only, up to 20 MB, parsed in the browser. Only the email column is sent, as a JSON array. |
| Abuse / runaway spend | Per-IP rate limit of 60 verification requests per minute, duplicate-job prevention, and no automatic provider fallback. |
| Timeouts | Every outbound request has an abort timeout. |
| CORS | Restricted to `CORS_ORIGIN`. |
| Registry token | `EMAIL_REGISTRY_API_TOKEN` lives only in `server/.env`. It is sent only in the `Authorization` header of server-to-registry requests. It never appears in responses, errors or logs (logs contain method, path and status only, never query strings or emails). Registry errors passed to the browser are generic, except 422 field messages. Plain `http` is allowed only to localhost. |

> **Key hygiene:** if an API key has ever been pasted into chat, email or a ticket, replace it with a new one in the provider's dashboard and update `server/.env`.

---

## 14. Testing

```bash
cd server
npm test
```

This runs the suites below with Node's built-in test runner. Upstream APIs are **stubbed**, so no credits are spent. The registry is replaced by an in-process HTTP double of the Laravel API (`test/helpers/fakeRegistry.js`).

| Suite | Covers |
|---|---|
| `test/providers.test.js` | Default provider fallback, startup URL validation, switching, rejecting invalid or unconfigured providers, keys never exposed |
| `test/millionverifier.test.js` | Result mapping, request parameters, HTTP-200 error mapping, network/429 handling, credits, multipart upload, fileinfo status mapping, no download before completion, CSV report parsing |
| `test/central.test.js` | Email-first workflow through the real registry client: lookup before provider, reuse without credits, save/upsert and mapping (incl. disposable/catchall round trip), other clients' records, outdated records, concurrent duplicates, overlapping bulk jobs, 1,000-email lookup chunks, mock isolation, registry down (block / provider fallback), wrong token, 429, registry routes for the UI, token never exposed |
| `test/emailRegistryService.test.js` | Laravel client: create/update/get/remove, 422 field errors, 401 not retried and never logged, lookup chunking, parameter allow-list, retries on network/5xx, connect and total timeouts, Retry-After |
| `test/registry.integration.test.js` | **Opt-in**, against the real Laravel API (`REGISTRY_IT_URL`, `REGISTRY_IT_TOKEN`): auth 401/200, stats, upsert, update, list filters, lookup, full app workflow. Creates records under a throwaway `example.com` subdomain and deletes them |
| `test/api.test.js` | Real Express app on a random port: `/api/providers`, switch validation, live vs. mock credits, backward-compatible single response, input rejection with zero upstream calls, full mock bulk flow with duplicate reuse and result caching, 404 for unknown jobs |

**Manual live check** (spends a few real credits): with `npm run dev` running, verify one address on each provider and run a small CSV through each. Then confirm the header balance and history tags match the provider you used.

---

## 15. Project structure

```
verifier-ui/
├── package.json                 # root scripts: setup, dev, build, start
├── README.md                    # quick reference
├── SETUP.md                     # this guide
├── scripts/
│   └── test-registry-api.ps1    # read-only smoke test: Laravel registry + backend registry routes
├── server/
│   ├── .env                     # your keys (gitignored)
│   ├── .env.example             # template
│   ├── package.json             # scripts: dev, start, test
│   ├── src/
│   │   ├── index.js             # loads config, starts server, prints provider status
│   │   ├── app.js               # Express app: routes, validation, rate limit, error handler
│   │   ├── config.js            # env parsing + startup validation
│   │   ├── verification.js      # unified service: adapter routing, job ids, dedupe, result cache
│   │   ├── central.js           # email-first layer: registry lookup → provider → save; bulk job runner
│   │   ├── services/
│   │   │   ├── emailRegistryService.js # the ONLY registry access: Laravel API client
│   │   │   ├── registryMapping.js   # normalization, reuse rules, registry ↔ app mapping
│   │   │   └── registrySaveQueue.js # rate-limited background saves with retry
│   │   ├── errors.js            # ApiError + NeverBounce status mapping
│   │   ├── neverbounce.js       # NeverBounce v4.2 REST client (unchanged)
│   │   ├── mock.js              # Mock sandbox factory (one per provider)
│   │   └── providers/
│   │       ├── registry.js          # supported providers, active/default, availability, key hints
│   │       ├── millionverifier.js   # MillionVerifier adapter
│   │       └── neverbounceAdapter.js# NeverBounce/mock → normalized interface
│   └── test/                    # node:test suites
└── client/
    ├── vite.config.js           # dev proxy /api → :4000
    ├── tailwind.config.js
    └── src/
        ├── App.jsx              # context providers + routes
        ├── context/
        │   ├── AppContext.jsx   # providers, mode, credits, history, stats
        │   ├── BulkContext.jsx  # CSV workflow + job polling (lives at app root)
        │   └── ToastContext.jsx
        ├── components/          # Layout, Sidebar, ProviderSelector, ModeToggle, Header,
        │                        # StatusBadge, StatusBreakdown, KpiCard, ActivityTable, EmptyState
        ├── pages/               # Dashboard, SingleVerifier, BulkVerifier, History
        └── lib/                 # api.js, csv.js, status.js, format.js
```

---

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Red "Can't reach the verifier server" banner | The API isn't running. Start it with `npm run dev` from `verifier-ui/`. |
| `EADDRINUSE` on port 4000 or 5173 | An old instance is still running. Stop it (Windows: `netstat -ano \| findstr :4000`, then `taskkill /PID <pid> /F`) or change `PORT`. |
| Provider shows *not configured* | Its key is missing from `server/.env`. Add it and restart the server. |
| Header says "Balance unavailable" | The provider rejected the key or is unreachable. Hover the pill to see the reason. |
| "MillionVerifier rejected the API key" | Wrong or revoked `MILLIONVERIFIER_API_KEY`. |
| "Your MillionVerifier account does not have enough credits" | Top up the account, or switch to NeverBounce manually. |
| Bulk job shows "paused" | MillionVerifier paused the file (often low credits). Resume it in their dashboard, then click **Retry**. |
| "Unknown job id" after restarting the server | Mock jobs live in memory and are lost on restart. Live jobs survive a restart, but jobs created before the provider update use an old ID format. Start the job again. |
| Live toggle is greyed out | The active provider has no API key; mock mode is the only option. |
| Provider switch is greyed out | A bulk job is running. Wait for it to finish. |
| App started on the wrong provider | Check `DEFAULT_VERIFICATION_PROVIDER`; the active provider resets to it on every restart. |
| Sidebar shows **Email registry: Unavailable** | The Laravel API isn't running or isn't reachable at `EMAIL_REGISTRY_API_URL`. Start it (`php artisan serve`), then restart this server or wait 30 s. Hover the status for the reason. |
| 503 "rejected the server's API token" | `EMAIL_REGISTRY_API_TOKEN` doesn't match `REGISTRY_API_TOKEN` in the Laravel `.env`. If Laravel's config is cached, run `php artisan config:clear` there. |
| 429 / saves pending for a long time | Laravel's per-IP rate limit (`API_RATE_LIMIT`, default 120/min). Raise it, together with `EMAIL_REGISTRY_SAVE_RATE_PER_MINUTE`. |
| `npm install` warns about vulnerabilities | They come from dev tooling dependencies. Review with `npm audit` before deploying. |

---

## 17. Extending the app

**Adding another provider (e.g. ZeroBounce)**
1. Create `server/src/providers/zerobounce.js` that implements `getCredits`, `verifySingle`, `createJob`, `jobStatus` and `jobResults`, returning the normalized shapes documented at the top of `neverbounceAdapter.js`.
2. Add the ID and display name to `PROVIDER_IDS` / `PROVIDER_NAMES` in `registry.js`, and its env vars to `config.js` and `.env.example`.
3. Register live and mock adapters in `verification.js` and add a job ID prefix (`JOB_PREFIX` / `PREFIX_PROVIDER` / `JOB_ID_RE`).
4. Add the label to `PROVIDER_LABELS` in `client/src/context/AppContext.jsx`.
5. Add tests modeled on `test/millionverifier.test.js`.

**Per-organization provider settings:** the active provider is stored in a single variable inside `registry.js`. Replace it with a lookup keyed by organization or user, and pass that key from the routes. No other code needs to change.

**Persisting the active provider across restarts:** this is intentionally not done, so the app always starts on the configured default. To persist it, save `state.active` in `registry.setActive()` and load it at startup.
