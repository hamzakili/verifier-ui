# API Endpoints & Payloads

MailVerify uses two APIs:

| API | Runs on | Base URL | Used by |
|---|---|---|---|
| **[Email Registry API](#part-1--email-registry-api-laravel-separate-project)** (Laravel, separate project) | `C:\wamp64\www\email-registry-api` | `http://127.0.0.1:8000/api` | The Node backend only (server-to-server, bearer token) |
| **[Verifier Backend API](#part-2--verifier-backend-api-nodejs-server)** (Node.js, `server/`) | Your PC | `http://localhost:4000/api` (or `/api` via the Vite proxy) | The React frontend |

```
React UI ──▶ Node backend (/api/verify/…, /api/registry/…) ──Bearer──▶ Laravel registry (/api/email-verifications/…) ──▶ MySQL
                    └──▶ MillionVerifier / NeverBounce / Mock (only for emails the registry can't answer)
```

---

# Part 1 — Email Registry API (Laravel, separate project)

Owned by the Laravel project; this app doesn't change it. Documented here only as far as this app uses it. Client: `server/src/services/emailRegistryService.js`.

| | |
|---|---|
| Auth | `Authorization: Bearer <EMAIL_REGISTRY_API_TOKEN>` (= Laravel `REGISTRY_API_TOKEN`) on everything except `GET /health` |
| Headers | `Accept: application/json`, `Content-Type: application/json` for bodies |
| Envelope | Success `{ success: true, message, data, meta? }` · Failure `{ success: false, message, errors }` |
| Rate limit | `API_RATE_LIMIT` requests/min per IP (default 120) |
| Normalization | Emails are `trim` + lowercase; one record per email |

| Endpoint | Used by this app for | Notes |
|---|---|---|
| `GET /health` | Status check: tells "registry down" apart from "token rejected" (public, no token) | `data: { api, database, … }`; 503 when degraded |
| `GET /health/registry` | Sidebar status, `/api/registry/stats` | `data: { total, by_status, by_result, by_provider, last_updated_at }` |
| `GET /email-verifications` | Registry page list | `page`, `limit` (≤ 500; this app caps at 100), `search`, `domain`, `status`, `result`, `provider`, `sort` (`created_at`/`verified_at`/`updated_at`), `direction`; `meta: { current_page, per_page, total, last_page, from, to }` |
| `GET /email-verifications/{id}` | `/api/registry/records/:id` | 404 if missing |
| `POST /email-verifications/lookup` | Before every verification; bulk preview; batch lookup | `{ emails: [...] }` (≤ 1,000 per call; chunked) → `data: { found: [record], missing: [email], invalid: [raw], summary }`. `invalid` (fails PHP `FILTER_VALIDATE_EMAIL`) is never sent to a provider |
| `POST /email-verifications` | Saving each new result | Upsert by email: 201 created / 200 updated. Body below |
| `PUT /email-verifications/{id}` | Client method `update()` (not exposed to the browser) | Partial update; `email` can't change |
| `DELETE /email-verifications/{id}` | Client method `remove()` (integration-test cleanup) | |

**Save body sent by this app**
```json
{
  "email": "user@example.com",
  "status": "completed",
  "result": "valid",
  "provider": "millionverifier",
  "reason": "MillionVerifier: valid (ok)",
  "metadata": {
    "source": "verifier-ui",
    "origin": "manual",
    "app_result": "valid",
    "flags": ["free_email_host"],
    "available_flags": ["free_email_host", "role_account"],
    "suggested_correction": "",
    "provider_details": { "result": "ok", "subresult": "ok", "quality": "good" },
    "credits_used": 1
  }
}
```
`result` mapping: valid→`valid`, invalid→`invalid`, disposable→`risky`, catchall→`risky`, unknown→`unknown`. `metadata.app_result` keeps the exact value.

**How registry errors reach the browser** (via the Node backend):

| Registry reply | Backend error |
|---|---|
| Network error, timeout, 5xx, non-JSON | 503 `registry_unavailable` |
| 401 | 503 `registry_unauthorized` (server token wrong; a configuration problem) |
| 404 | 404 `registry_not_found` |
| 422 | 422 `registry_validation`, field messages in `error.details.errors` |
| 429 (after honouring `Retry-After`) | 429 `registry_rate_limited` |

---

# Part 2 — Verifier Backend API (Node.js, `server/`)

The React frontend calls these endpoints. Provider keys and the registry secret stay on this server.

## Conventions

| | |
|---|---|
| Base URL | `http://localhost:4000/api` (dev UI uses `/api` through the Vite proxy) |
| Mode header | `x-verifier-mode: live` (default) or `mock` |
| Request body | `Content-Type: application/json`, max 5 MB |
| Rate limit | 60 verification requests/min per IP (`/verify/single`, `/verify/bulk`) |
| Error format | `{ "success": false, "provider": "millionverifier", "error": { "code": "…", "message": "…", "details"?: {…} } }` |

| HTTP | `code` | When |
|---|---|---|
| 400 | `missing_email`, `invalid_email`, `missing_emails`, `no_valid_emails`, `missing_provider`, `unsupported_provider`, `bad_json` | Bad input |
| 401 | `auth_failure` | Provider rejected its API key |
| 402 | `insufficient_credits` | Provider (or sandbox) out of credits |
| 404 | `job_not_found`, `not_found` | Unknown job or route |
| 409 | `provider_not_configured`, `verification_in_progress`, `job_not_complete`, `job_failed` | Conflict |
| 413 | `too_many_emails`, `payload_too_large` | Over `MAX_BULK_EMAILS` / body limit |
| 429 | `rate_limited` | Too many requests (local limit, provider or registry) |
| 503 | `provider_unavailable` | MillionVerifier / NeverBounce down; switch manually (no automatic fallback) |
| 503 | `registry_unavailable` | Email registry could not be checked (down, timeout, 5xx, or wrong token); **nothing was sent to a provider** |
| 503 | `registry_unauthorized`, `registry_not_configured` | Registry routes: wrong server token / registry not configured |
| 404 / 422 / 429 | `registry_not_found`, `registry_validation`, `registry_rate_limited` | Registry routes |

---

## `GET /health`
```json
{ "ok": true }
```

## `GET /status`
```json
{
  "liveAvailable": true,
  "mode": "live",
  "keyHint": "••••9k2T",
  "maxBulkEmails": 25000,
  "provider": "millionverifier",
  "providerName": "MillionVerifier",
  "defaultProvider": "millionverifier",
  "centralDb": { "enabled": true, "connected": true, "reachable": true, "tableExists": true, "error": null, "total": 1520,
                 "saveQueue": { "queued": 0, "saved": 12, "failed": 0 }, "fallback": "block", "maxAgeDays": 0 }
}
```

## `GET /providers`
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

## `POST /providers/switch`
**Request**
```json
{ "provider": "neverbounce" }
```
**Response `200`**
```json
{
  "success": true,
  "message": "Verification provider switched successfully.",
  "active_provider": "neverbounce",
  "providers": [ "…same shape as GET /providers…" ]
}
```
Errors: `400 unsupported_provider`, `409 provider_not_configured`.

## `GET /account`
Credit balance of the **active** provider (balances are never combined).

**MillionVerifier**
```json
{
  "mode": "live", "provider": "millionverifier", "providerName": "MillionVerifier",
  "creditsRemaining": 25487, "bulkCredits": 25487, "renewingCredits": 0, "plan": 4
}
```
**NeverBounce**
```json
{
  "mode": "live", "provider": "neverbounce", "providerName": "NeverBounce",
  "creditsRemaining": 943, "paidCreditsRemaining": 943, "freeCreditsRemaining": 0,
  "paidCreditsUsed": 0, "freeCreditsUsed": 0, "jobCounts": { "completed": 4, "queued": 5 }
}
```

---

## `POST /verify/single`

Checks the registry first; calls the provider only if needed.

**Request**
```json
{ "email": "user@example.com", "source": "manual" }
```
| Field | Required | Notes |
|---|---|---|
| `email` | yes | ≤ 254 chars |
| `source` | no | `manual` (default), `api`, `csv_import` |

**Response `200`: verified now**
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
  "creditsRemaining": 25486,
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
  "error": null,

  "cached": false,
  "verifiedAt": null,
  "stored": true,
  "registry": { "lookup": "miss", "saved": true, "recordId": "42" }
}
```
`registry.lookup`: `hit` (reused), `miss` (verified now), `unavailable` (registry skipped because `EMAIL_REGISTRY_FALLBACK=provider`), `shared` (joined a concurrent check of the same email), `skipped` (Mock mode), `disabled` (no registry configured). `saved: false` means the result is queued for retry.

**Response `200`: reused from the registry** (no provider call, 0 credits)
```json
{
  "email": "user@example.com",
  "result": "valid",
  "creditsUsed": 0,
  "creditsRemaining": null,
  "provider": "neverbounce",
  "cached": true,
  "verifiedAt": "2026-11-16 19:39:17",
  "stored": true,
  "…": "other fields as above"
}
```

| Field | Notes |
|---|---|
| `result` | `valid` · `invalid` · `disposable` · `catchall` · `unknown` |
| `flags` | e.g. `free_email_host`, `role_account`, `has_dns`, `has_dns_mx`, `smtp_connectable`, `disposable_email`, `bad_syntax` |
| `availableFlags` | Flags the provider actually reports; others mean "not provided", not "no" |
| `provider` | Which provider produced the result (may differ from the active one when `cached`) |
| `cached` | `true` = answered from the central registry |

Errors: `409 verification_in_progress` (another request is verifying this email right now), `503 registry_unavailable`, `503 provider_unavailable`, `402 insufficient_credits`.

---

## `POST /verify/bulk/preview`

Read-only credit estimate before a bulk run. It claims and charges nothing.

**Request**
```json
{ "emails": ["a@corp.com", "A@corp.com", "b@corp.com", "c@corp.com"] }
```
**Response `200`**
```json
{
  "centralDb": true,
  "total": 3,
  "reusable": 1,
  "pendingElsewhere": 0,
  "invalid": 0,
  "toVerify": 2,
  "estimatedCredits": 2
}
```
`invalid`: addresses the registry rejects as malformed. They are skipped (not charged) and appear in bulk results as `invalid` with the note *Invalid email format (not submitted)*. A single check of such an address returns 400 `invalid_email`.

## `POST /verify/bulk`

Starts a bulk job. Emails are de-duplicated; reused and in-progress emails are never sent to the provider.

**Request**
```json
{
  "emails": ["a@corp.com", "A@corp.com", "b@corp.com", "not-an-email"],
  "filename": "contacts.csv",
  "source": "csv_import"
}
```
**Response `201`** (`200` with `duplicate: true` if the same list is already running)
```json
{
  "mode": "live",
  "jobId": "cj_3f2a9c1e-…",
  "submitted": 4,
  "uniqueEmails": 2,
  "skipped": 2,
  "provider": "millionverifier",
  "providerName": "MillionVerifier",
  "duplicate": false,
  "reused": 1,
  "pendingElsewhere": 0,
  "toVerify": 1
}
```
Job IDs start with `cj_` when the registry is enabled. Without it, they are `mv_…`, `nb_…`, `mv-mock_…` or `nb-mock_…`.

## `GET /verify/bulk/{jobId}`

Poll every ~1.5 s.

```json
{
  "provider": "millionverifier",
  "mode": "live",
  "jobId": "cj_3f2a9c1e-…",
  "rawStatus": "in_progress",
  "stage": "verifying",
  "percent": 60,
  "total": 2,
  "processed": 1,
  "billable": 0,
  "counts": { "valid": 1, "invalid": 0, "disposable": 0, "catchall": 0, "unknown": 0 },
  "failureReason": null,
  "reused": 1,
  "pendingElsewhere": 0,
  "toVerify": 1
}
```
`stage`: `uploading` → `parsing` → `queued` → `verifying` → `complete` (or `failed`, with `failureReason`).

## `GET /verify/bulk/{jobId}/results`

Available once `stage` is `complete` (otherwise `409`).

```json
{
  "provider": "millionverifier",
  "mode": "live",
  "jobId": "cj_3f2a9c1e-…",
  "results": [
    { "id": "0", "email": "a@corp.com", "result": "valid", "flags": [], "suggestedCorrection": "",
      "cached": true, "provider": "neverbounce", "verifiedAt": "2026-11-16 19:39:17" },
    { "id": "1", "email": "b@corp.com", "result": "invalid", "flags": ["free_email_host"], "suggestedCorrection": "",
      "cached": false, "provider": "millionverifier" }
  ],
  "creditsUsed": 1,
  "creditsRemaining": 25485,
  "reused": 1,
  "pendingElsewhere": 0,
  "toVerify": 1
}
```
A result may also include a `note`, e.g. `"Verification by another request did not finish; re-run to retry"`.

## `GET /registry/stats`
```json
{ "success": true,
  "stats": { "total": 1520, "by_status": { "pending": 3, "completed": 1510, "failed": 7 },
             "by_result": { "valid": 1200, "invalid": 200, "risky": 80, "unverifiable": 0, "unknown": 30 },
             "by_provider": { "millionverifier": 1400, "neverbounce": 120 }, "last_updated_at": "…", "timestamp": "…" },
  "saveQueue": { "queued": 0, "saved": 12, "failed": 0 }, "fallback": "block", "maxAgeDays": 0 }
```

## `GET /registry/records`
Query: `page`, `limit` (default 25, max 100), `search`, `domain`, `status` (`pending|completed|failed`), `result` (`valid|invalid|risky|unverifiable|unknown`), `provider` (`millionverifier|neverbounce|other`), `sort` (`created_at|verified_at|updated_at`), `direction` (`asc|desc`).
```json
{ "success": true,
  "records": [ { "id": 7, "email": "user@gmail.com", "domain": "gmail.com", "status": "completed", "result": "risky",
                 "provider": "millionverifier", "reason": "MillionVerifier: disposable", "verified_at": "…", "metadata": { "…": "…" },
                 "app_result": "disposable", "usable": true } ],
  "meta": { "current_page": 1, "per_page": 25, "total": 1520, "last_page": 61, "from": 1, "to": 25 } }
```
`app_result` is the app's reading of the record; `usable` says whether verification would reuse it.

## `GET /registry/records/{id}`
`{ "success": true, "record": { … } }`, or 404 `registry_not_found`.

## `POST /registry/lookup`
Read-only. Body `{ "emails": [...] }` (≤ 5,000).
```json
{ "success": true, "found": [ record ], "missing": ["new@x.com"], "invalid": ["not-an-email"],
  "summary": { "requested": 3, "found": 1, "usable": 1, "missing": 1, "invalid": 1 } }
```

## `POST /mock/reset`
Resets both mock sandbox balances.
```json
{ "ok": true }
```

---

# Part 3 — Bulk Verification Jobs

Base URL `/api`, same conventions as Part 2: success responses have `success: true`, and errors are `{ success: false, error: { code, message, details? } }`. All routes are scoped to the caller's owner ID (single local owner in this app); another owner's resources return 404.

## Folders and files

### `POST /verification-folders`
```json
{ "folder_name": "November Campaign", "description": "Q4 leads", "parent_folder_id": null }
```
201:
```json
{ "success": true, "message": "Folder created.", "folder": { "id": "…", "folder_name": "November Campaign", "description": "Q4 leads",
  "parent_folder_id": null, "is_job_folder": false, "path": "My Verification Files / November Campaign", "subfolder_count": 0, "file_count": 0,
  "created_at": "…", "updated_at": "…" } }
```
Errors:
- 422 `invalid_folder_name`: empty, more than 80 characters, or contains `/ \ : * ? " < > |`, control characters, `.` or `..`.
- 409 `folder_exists`: a folder with that name already exists in the same parent (case-insensitive).
- 404 `parent_folder_not_found`.

### `GET /verification-folders`
`{ "success": true, "folders": [folder, …] }`. The list is flat; build the tree from `parent_folder_id`. Add `?include_job_folders=false` to hide job output folders.

### `GET /verification-folders/{id}`
`{ "success": true, "folder": {…}, "subfolders": [...], "files": [{ "id", "kind", "file_name", "size_bytes", "row_count", "job_id", "batch_id", … }], "breadcrumb": [{ "id", "folder_name" }], "job": { "id", "job_name", "status" } | null }`

`kind` is one of `batch`, `summary` or `all_results`.

### `DELETE /verification-folders/{id}`
Only empty folders that no job uses can be deleted. Otherwise the response is 409 `folder_not_empty` or `folder_in_use`.

### `GET /verification-files/{id}/download`
Returns the CSV (`text/csv; charset=utf-8`, UTF-8 BOM, CRLF) as an attachment. Returns 404 for unknown or foreign files, and 410 `file_missing` if the stored file was removed from disk.

## Import

### `POST /bulk-verification/import`
```json
{ "filename": "Campaign Leads.csv", "content": "first_name,email\nAva,ava@x.com\n…" }
```
201:
```json
{ "success": true, "import": {
  "import_id": "…", "source_filename": "Campaign Leads.csv", "columns": ["first_name", "email"], "headerless": false,
  "detected_email_column": "email", "email_column": "email", "email_column_required": false, "total_rows": 1000, "max_leads": 1000,
  "summary": { "total_imported": 1000, "unique_emails": 985, "duplicates": 15, "empty": 0, "invalid_format": 0, "eligible": 985 },
  "batch_sizes": [100, 250, 500, 1000], "default_batch_size": 500,
  "batch_plans": { "500": { "batch_size": 500, "total_batches": 2, "batches": [500, 485] } },
  "preview": [{ "row_number": 1, "email": "ava@x.com", "eligibility": "eligible", "duplicate_of_row": null, "data": { "first_name": "Ava", "email": "ava@x.com" } }],
  "expires_at": "…" } }
```
- **Row eligibility:** `eligibility` is one of `eligible`, `duplicate`, `empty` or `invalid_format`. Only eligible rows are verified. A duplicate gets the result of its first occurrence.
- **Email column not detected:** the response has `email_column_required: true` and `summary: null`. Set the column with `PUT /bulk-verification/imports/{id}` and the body `{ "email_column": "…" }`.
- **Errors:**
  - 413 `too_many_leads`: more than 1,000 rows.
  - 413 `file_too_large`: more than 10 MB.
  - 415 `unsupported_format`: Excel or other non-CSV files.
  - 422 `empty_file` or `corrupted_file`.
- Imports expire after 24 hours unless a job was created from them.

### `GET /bulk-verification/plan?eligible=750&batch_size=500`
`{ "success": true, "plan": { "batch_size": 500, "total_batches": 2, "batches": [500, 250] } }`

## Jobs

### `POST /bulk-verification/jobs`
```json
{ "import_id": "…", "batch_size": 500, "destination_folder_id": "…", "job_name": "November leads",
  "verification": { "provider": "millionverifier", "mode": "live" }, "client_request_id": "a1b2c3" }
```
- **Response:** 201 with `{ success, message, duplicate: false, job }`. The job is created and queued, and verification runs in the background.
- **Idempotency:** the same `import_id` or `client_request_id` returns the existing job with status 200 and `duplicate: true`.
- **Optional fields:**
  - `start: false` creates a `draft` job; start it later with `POST /bulk-verification/jobs/{id}/start`.
  - If `job_name` is omitted, a name like `Campaign_Leads_November_20_2026` is generated.
  - `verification` defaults to the active provider and the `x-verifier-mode` header.
- **Errors:**
  - 422 `validation_failed`: missing folder or bad batch size; field errors are in `details`.
  - 422 `invalid_destination_folder`: the folder is not yours, or it is a job output folder.
  - 422 `no_eligible_leads`.
  - 409 `provider_not_configured`: live mode was requested for a provider without an API key.
  - 404 `import_not_found`; 410 `import_expired`.

### Job object (`GET /bulk-verification/jobs/{id}`, `GET …/progress`)
```json
{ "id": "…", "job_name": "…", "source_filename": "…", "status": "processing",
  "destination_folder": { "id": "…", "folder_name": "November Campaign", "path": "My Verification Files / November Campaign" },
  "job_folder": { "id": "…", "folder_name": "Job_20261120_001", "path": "… / Job_20261120_001" },
  "total_imported": 1000, "total_eligible": 985, "total_duplicates": 15, "total_empty": 0, "total_invalid_format": 0,
  "batch_size": 500, "total_batches": 2, "completed_batches": 1, "failed_batches": 0, "pending_batches": 1, "current_batch": 2,
  "progress": { "processed": 650, "total": 985, "remaining": 335, "percent": 65.9 },
  "counts": { "verified": 500, "failed": 0, "valid": 450, "invalid": 30, "disposable": 5, "catchall": 10, "unknown": 5, "reused": 120 },
  "configuration": { "provider": "millionverifier", "provider_name": "MillionVerifier", "mode": "live", "registry": true, "auto_save": true, "auto_continue": true },
  "error_message": null, "created_at": "…", "started_at": "…", "completed_at": null,
  "files": [ { "id": "…", "kind": "all_results", "file_name": "all_results.csv", "size_bytes": 123, "row_count": 1000 } ],
  "actions": { "can_start": false, "can_pause": true, "can_resume": false, "can_cancel": true, "can_download": true },
  "batches": [ { "id": "…", "batch_number": 1, "total_emails": 500, "processed_count": 500, "verified_count": 500, "failed_count": 0,
                 "valid_count": 450, "invalid_count": 30, "disposable_count": 5, "catchall_count": 10, "unknown_count": 5, "reused_count": 120,
                 "status": "completed", "stage": null, "retry_count": 0, "error_kind": null, "error_message": null,
                 "started_at": "…", "completed_at": "…", "duration_ms": 41230,
                 "output_file": { "id": "…", "file_name": "batch_001_verified.csv", "size_bytes": 81234, "row_count": 500 }, "can_retry": false } ] }
```
- **Progress:** `progress` counts verified records, including the batch in flight, not batches.
- **Polling:** poll `…/progress` while `status` is `queued`, `processing`, `pausing` or `cancelling`.
- **Job status:** `draft`, `queued`, `processing`, `pausing`, `paused`, `completed`, `completed_with_errors`, `failed`, `cancelling` or `cancelled`.
- **Batch status:** `pending`, `processing`, `saving`, `completed`, `failed`, `retrying` or `cancelled`.
- **`error_kind`:** `verification`, `network`, `provider`, `queue` or `storage`.

### `GET /bulk-verification/jobs`
Query parameters:
- `page`, `limit` (≤ 100).
- `search`: matches the job name or file name.
- `status`: one status or a comma-separated list.
- `from`, `to`: creation dates.
- `sort`: `created_at`, `job_name`, `status`, `total_eligible` or `progress`.
- `direction`: `asc` or `desc`.

Response: `{ success, jobs: [job], meta: { current_page, per_page, total, last_page }, overview: { total, completed, processing, paused, failed } }`

### `GET /bulk-verification/jobs/{id}/batches/{batchId}?page=1&limit=100`
`{ success, batch, results: [{ row_number, email, processing_status, verification_status, flags, suggested_correction, from_registry, note, error_message, verified_at }], meta }`

### Controls
| Route | Effect |
|---|---|
| `POST …/jobs/{id}/start` | `draft` → `queued`. Calling it again is safe. |
| `POST …/jobs/{id}/pause` | `queued` → `paused`. `processing` → `pausing` → `paused` once the running batch is saved. |
| `POST …/jobs/{id}/resume` | `paused` or `failed` → `queued`. Failed batches retry their unfinished records only. |
| `POST …/jobs/{id}/cancel` | Running: → `cancelling`; the running batch is saved and the rest are cancelled. Otherwise: → `cancelled` immediately. |
| `POST …/jobs/{id}/batches/{batchId}/retry` | A failed batch, or a completed batch with failed records: only those records are verified again, and the file is regenerated in place. Up to 5 retries. |

Invalid transitions return 409 `invalid_transition`. Retry also returns 409 `nothing_to_retry` or `retry_limit_reached`.

### Downloads
`GET …/jobs/{id}/batches/{batchId}/download` returns the batch CSV, and `GET …/jobs/{id}/download` returns `all_results.csv`. Before the file exists, both return 409 `file_not_ready`.

**Output columns:** every imported column, followed by `verification_status`, `verification_reason`, `verified_at`, `provider`, `is_valid`, `is_disposable`, `is_catch_all`, `is_role_based`, `is_free_email`, `suggested_correction` and `from_registry`. Imported columns with the same name are kept, and the added column gets a `_result` suffix. In mock mode, `provider` reads e.g. `MillionVerifier (mock sandbox)`.

**Format:** values that start with `=`, `@` or similar formula characters are prefixed with `'` so Excel won't run them as formulas.
