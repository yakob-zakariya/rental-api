# Phase 1 spec — Foundation, accounts, identity verification

**Goal:** a user can sign up with their phone, verify their identity with an Ethiopian ID and a
selfie, and see "Approved" in the app. Staff can handle manual reviews and bans.

**Done when:** you sign up with your own phone, verify with your own Fayda ID (or a passport),
and your account shows `approved` — and every business rule below has a passing test.

**Accepted documents:** the **Fayda** national ID (primary) and **passports** (Ethiopian or
foreign — for diaspora and foreigners). Nothing else: no kebele IDs, no driving licences. The
Didit workflow (`DIDIT_WORKFLOW_ID`) must be configured to accept only national ID and passport.

**Out of scope:** listings, properties, contact requests, search, maps, photos, notifications/push,
payments, chat, Telegram, public web pages, a web admin panel, a real SMS provider, setting
`users.status = suspended` (comes with moderation later), moving an account to a new SIM.

---

## 1. Foundation

- NestJS 12 app, TypeScript strict mode, **ESM** (`"type": "module"`). Tests use **Vitest**, linting
  uses **oxlint**, formatting uses Prettier. (The scaffold already exists; keep it.)
- Docker Compose: `postgis/postgis` image (Postgres + PostGIS) and Redis.
- TypeORM with a single `src/database/data-source.ts` used by both the app and the migration CLI.
  `synchronize: false`. First migration enables the `postgis` and `pgcrypto` extensions.
  **Prove first that the TypeORM migration CLI works under ESM**; if it doesn't, stop and decide
  whether to switch the project to CommonJS.
- Config module with validation: the app refuses to start if a required env variable is missing.
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- Swagger at `/docs`. Disabled in production unless `SWAGGER_ENABLED=true`, and in production it is
  only served behind admin auth (see section 5).
- Rate limiting with `@nestjs/throttler`.
- `GET /health` — checks database and Redis.

### Environment variables

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://rental:rental@localhost:5432/rental
REDIS_URL=redis://localhost:6379
SWAGGER_ENABLED=false      # only read in production; always on in development

JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
ADMIN_JWT_SECRET=
ADMIN_JWT_TTL=8h
REFRESH_REUSE_GRACE_SECONDS=60   # rule A5 grace window

ID_HASH_PEPPER=            # long random secret; never change after launch

OTP_TTL_SECONDS=300
OTP_REQUEST_IP_LIMIT_PER_HOUR=30   # rule A8
OTP_HASH_SECRET=           # long random secret for HMAC of OTP codes
SMS_PROVIDER=console       # 'console' logs codes in development

DIDIT_API_KEY=
DIDIT_WEBHOOK_SECRET=
DIDIT_WORKFLOW_ID=
DIDIT_BASE_URL=https://verification.didit.me   # confirmed (docs/didit-integration.md)
DIDIT_ENVIRONMENT=sandbox  # sandbox | live; webhook events from the other environment are rejected (T2.5)
APP_VERIFICATION_CALLBACK_URL=   # where Didit sends the user back after the flow
```

---

## 2. Data model (Phase 1)

All IDs are UUIDs; all timestamps are `timestamptz`.

### `users`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| phone | varchar unique | E.164 |
| full_name | varchar null | Set from verification; locked once verified |
| date_of_birth | date null | Set from verification; locked once verified |
| preferred_language | enum `am`,`om`,`en` | default `am`; editable via `PATCH /me` |
| status | enum `active`,`suspended`,`banned` | default `active` |
| verification_status | enum `not_verified`,`pending`,`approved`,`declined`,`manual_review`,`blocked` | default `not_verified`; **derived** — only ever written by `recomputeVerificationStatus` |
| verified_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### `otp_codes`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| phone | varchar | E.164, indexed |
| code_hash | varchar | `HMAC_SHA256(OTP_HASH_SECRET, phone + ":" + code)`; never store the code |
| expires_at | timestamptz | now + OTP_TTL |
| attempts | int | default 0 |
| consumed_at | timestamptz null | |
| created_at | timestamptz | |

### `refresh_tokens`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| user_id | uuid FK → users | |
| token_hash | varchar | Never store the raw token |
| device_name | varchar null | e.g. "Samsung A14" |
| expires_at | timestamptz | |
| revoked_at | timestamptz null | |
| replaced_by_id | uuid null | For rotation |
| created_at | timestamptz | |

### `identity_verifications` (one row per attempt)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| user_id | uuid FK → users | indexed |
| provider | varchar | `didit` |
| provider_session_id | varchar unique | |
| provider_status | varchar | Didit's latest status, as received (always recorded, even when it doesn't change the outcome) |
| outcome | enum `pending`,`approved`,`declined`,`manual_review`,`blocked`,`abandoned`,`expired` | Our decision |
| decline_reason | varchar null | Internal reason code |
| document_type | varchar null | e.g. national ID, passport |
| verified_name | varchar null | |
| date_of_birth | date null | |
| verification_url | varchar null | So V2 can resume the session; cleared on a final outcome |
| session_token | varchar null | So V2 can resume the session; cleared on a final outcome |
| manual_review_requested_at | timestamptz null | Set when the user requests manual review on this attempt |
| flagged_at | timestamptz null | Needs staff attention (V6, approved → declined, …) |
| flag_reason | varchar null | Internal code, e.g. `DUPLICATE_IDENTITY`, `APPROVAL_REVERSED`, `DATA_UPDATED` |
| decided_by_admin_id | uuid null FK → admin_users | Set when staff approve/decline; makes the outcome final |
| decided_at | timestamptz null | |
| completed_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

"Final outcome" means anything other than `pending`.

### `identity_hashes` (one row per identifier Didit returns, per attempt)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| verification_id | uuid FK → identity_verifications | indexed |
| user_id | uuid FK → users | indexed |
| kind | enum `fayda_fin`,`fayda_fan`,`passport` | Only accepted documents (which Fayda numbers Didit returns: confirm in T2.9) |
| hash | varchar | See V10 (passports include the issuing country); indexed |
| is_approved | boolean | default false; mirrors whether the attempt's outcome is `approved` (kept in sync in the same transaction) — needed for the partial unique index |
| created_at | timestamptz | |

- **Partial unique index** on `hash` `WHERE is_approved`. All kinds are strong identifiers, so
  this is the database-level guarantee behind V6: two users can never both be approved with the
  same identifier, even under a race. A unique violation on approval is treated as a V6 duplicate.
- Raw ID numbers are never stored, logged, or written to `admin_actions`.

### `verification_webhook_events` (idempotency + audit)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| provider_session_id | varchar | indexed |
| event_key | varchar unique | Didit's `event_id` (stable across retries of the same event) |
| provider_status | varchar | |
| received_at | timestamptz | |
| processed_at | timestamptz null | |
| error | text null | |

Store **no images and no raw ID numbers** in this table. Do not store the full raw payload.

### `banned_identities` (one row per banned hash)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| user_id | uuid FK → users | The user whose ban produced this row |
| kind | same enum as `identity_hashes.kind` | |
| hash | varchar | Same value as in `identity_hashes`; indexed |
| reason | varchar | |
| banned_by_admin_id | uuid FK → admin_users | |
| lifted_at | timestamptz null | |
| lifted_by_admin_id | uuid null | |
| created_at | timestamptz | |

Partial unique index on `hash` `WHERE lifted_at IS NULL` (one active ban per hash; a hash can be
banned again after being lifted).

### `admin_users`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| email | varchar unique | |
| password_hash | varchar | argon2 or bcrypt |
| role | enum `support`,`moderator`,`super_admin` | |
| is_active | boolean | default true |
| last_login_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### `admin_actions` (audit log)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| admin_id | uuid FK → admin_users | |
| action | varchar | e.g. `verification.approve`, `user.ban` |
| target_type | varchar | e.g. `user`, `identity_verification` |
| target_id | uuid | |
| details | jsonb | Reason, note — never personal documents or raw ID numbers |
| created_at | timestamptz | |

---

## 3. Accounts: phone OTP and tokens

### Flow
1. `POST /auth/otp/request { phone }` → normalise to E.164; reject non-Ethiopian mobile numbers
   (`+2519…`, `+2517…`). Create an OTP, send it via the SMS interface. Always respond the same
   way whether or not the phone is registered.
2. `POST /auth/otp/verify { phone, code, deviceName? }` → check the latest unconsumed, unexpired
   code. On success: mark consumed; create the user if new; return access + refresh tokens.
3. `POST /auth/refresh { refreshToken }` → rotate: revoke the old token, issue a new pair.
4. `POST /auth/logout { refreshToken }` → revoke it.
5. `GET /me` → the current user's profile and `verification_status`.
6. `PATCH /me { preferredLanguage }` → the only editable field in Phase 1. Any other field
   (including `fullName`, `dateOfBirth`) is rejected by `forbidNonWhitelisted` (V9).

### Rules
- **A1** OTP is 6 digits, valid for `OTP_TTL_SECONDS` (default 5 minutes).
- **A2** Max 5 wrong attempts per code; then the code is dead.
- **A3** Max 3 OTP requests per phone per 10 minutes.
- **A4** Requesting a new code invalidates older unconsumed codes for that phone.
- **A5** Refresh token reuse (a revoked token used again) revokes **all** of that user's tokens.
  **Grace for lost responses:** Ethiopian mobile networks often drop the response after the server
  has rotated the token, and the app then retries with the old one. If a rotated token is reused
  within `REFRESH_REUSE_GRACE_SECONDS` (default 60) of its first rotation **and** its replacement
  has never been used (not rotated, not revoked), the unused replacement is revoked and a new pair
  is issued; both the old token and the revoked replacement then point (`replaced_by_id`) at the
  new one. Any other reuse — after the window, after the replacement was used, or of a token
  revoked by logout — is full A5. Logout with an already-revoked token is a no-op.
- **A6** `suspended` and `banned` users cannot log in or refresh; return a neutral error.
- **A7** In development, `SMS_PROVIDER=console` logs the code instead of sending it.
- **A8** Per-IP throttling on `POST /auth/otp/request` (default 30 requests per IP per hour,
  configurable). Kept loose because Ethiopian mobile networks put many users behind shared IPs;
  the per-phone limit (A3) is the main protection.
- **A9** OTP codes are stored only as `HMAC_SHA256(OTP_HASH_SECRET, phone + ":" + code)` and
  compared in constant time.

### Guards
- `JwtAuthGuard` and `ActiveAccountGuard` are registered **globally** for all app routes.
  A `@Public()` decorator opts a route out (e.g. `/health`, `/auth/otp/*`, `/auth/refresh`,
  `/auth/logout`, `/webhooks/didit`).
  - `JwtAuthGuard` — valid app-user access token (signed with `JWT_ACCESS_SECRET`).
  - `ActiveAccountGuard` — `users.status = active`, checked against the database on every request,
    so a ban takes effect immediately even while an access token is still valid.
- Admin routes are not app routes: they skip the global app guards and use the admin guards
  instead (section 5, S3).
- `VerifiedGuard` — `users.verification_status = approved`. (No Phase 1 route needs it except a
  test route; it's built now for later phases.)

---

## 4. Identity verification

### Flow
1. **Start:** `POST /verification/sessions`.
   - Check eligibility, in this order: V1, V13, V2 (resume), V3.
   - Mark any older `pending` attempt of this user as `abandoned` (V14).
   - Call Didit to create a session with our `DIDIT_WORKFLOW_ID`, passing our `user.id` as
     `vendor_data`, `APP_VERIFICATION_CALLBACK_URL` as the callback, and
     `expected_details.expected_document_types = ["ID", "P"]` (on top of the workflow's own
     document restriction).
   - Didit keeps at most one unfinished session per (`workflow_id`, `vendor_data`): while one is
     `Not Started`, `In Progress`, `Resubmitted` or `Awaiting User`, "create" returns that same
     session. If the returned `session_id` is one of our attempts, it is a **resume** (V2, V14):
     refresh that attempt's `verification_url` and `session_token`, create no new row, and don't
     count it toward V3.
   - Save an `identity_verifications` row (`outcome = pending`, with `verification_url` and
     `session_token`), then `recomputeVerificationStatus(userId)`.
   - Return `{ verificationUrl, sessionToken }` to the app.
2. **User completes the flow** in the app (Didit SDK or hosted page): document front/back,
   then a selfie with passive liveness.
3. **Webhook:** `POST /webhooks/didit` (`@Public()`; no JWT).
   - Verify the signature exactly as Didit documents it (`X-Signature-V2`; recipe in
     `docs/didit-integration.md`). Reject invalid signatures with 401. Reject events whose
     `X-Timestamp` is more than 5 minutes from now (acceptable because the polling job catches
     anything we reject).
   - **Environment check:** reject events whose `environment` (`live` / `sandbox`) differs from
     `DIDIT_ENVIRONMENT`, so sandbox events can never change production data.
   - The `event_key` is Didit's `event_id`. If an event with that key exists **and `processed_at`
     is set**, return 200 and do nothing. If it exists but was never processed (e.g. an earlier
     error), process it again.
   - `status.updated` events go to decision processing (step 4). `data.updated` events (someone
     edited the extracted data in Didit) re-fetch the decision and flag the attempt for staff
     (`flag_reason = DATA_UPDATED`); they never change `full_name` / `date_of_birth` (V9).
   - Store/update the event row, process the decision inline (fine for Phase 1; move to a BullMQ
     job if processing grows), set `processed_at` (or `error`), return 200.
4. **Processing a decision** (shared by the webhook and the polling job), in one transaction:
   - Load the attempt by `provider_session_id` with `SELECT … FOR UPDATE`, so the webhook and
     the polling job can never process the same session at the same time.
   - Always record `provider_status`.
   - Apply the transition rules (V15). If the transition is allowed, map Didit's status (table
     below); if Didit approved, read the decision data, store `identity_hashes` for every
     identifier returned, and run our own checks (V4–V8).
   - Update the attempt (clear `verification_url`/`session_token` on a final outcome; keep
     `identity_hashes.is_approved` in sync), then `recomputeVerificationStatus(userId)`.
   - When the user ends up `approved`, set `verified_at`, `full_name`, `date_of_birth` from the
     approved attempt.
5. **Polling fallback:** a scheduled job every 5 minutes finds attempts still `pending` for more
   than 10 minutes and fetches their decision from Didit (`GET` session decision endpoint).
   Attempts still `pending` 24 hours after creation are marked `expired` and no longer polled (V16).
   Locally `abandoned` attempts are not polled. This makes webhooks a speed-up, not a single
   point of failure.
6. **Status:** `GET /verification/status` →
   `{ status, canRetry, retriesLeftToday, canRequestManualReview, reasonCode? }`.
   `reasonCode` is user-safe (e.g. `PHOTO_UNCLEAR`, `DOCUMENT_EXPIRED`); never reveal blocking reasons.
7. **Manual review request:** `POST /verification/manual-review-request` — allowed only when the
   V3 limit is reached **and** the most recent attempt was declined by Didit
   (`outcome = declined`, `provider_status` = Didit's declined status). Sets that attempt's
   `outcome = manual_review` and `manual_review_requested_at`, then recomputes. Staff then
   approve or decline that attempt.

### Status mapping (Didit → our attempt outcome)

Exact, case-sensitive strings from Didit's docs (see `docs/didit-integration.md`). The user's
`verification_status` is never set from this table directly — it is always recomputed (V13).

| Didit status | Final at Didit? | Our attempt outcome |
| --- | --- | --- |
| `Not Started`, `In Progress` | No | `pending` |
| `In Review` (Didit's own review) | No | `pending` |
| `Resubmitted` (user redoing steps) | No | `pending` |
| `Awaiting User` (KYB only; not expected) | No | `pending` |
| `Approved` | Yes | run V4–V8 → `approved` / `declined` / `blocked` / `manual_review` |
| `Declined` | Yes | `declined` |
| `Abandoned` | Yes | `abandoned` |
| `Expired` | Yes | `expired` |
| `Kyc Expired` (an approved document passed its expiry date) | Yes | **no change**: record `provider_status` only; the user stays `approved`, no staff flag. An expired document doesn't change who the person is. |

Non-final statuses never overwrite a final outcome (V12).

### `recomputeVerificationStatus(userId)`

The **only** code that writes `users.verification_status`. Called after every change to a user's
attempts (session created, decision processed, polling expiry, manual-review request, staff
approve/decline, unban). It derives the status from the attempt history:

1. any attempt `blocked` → `blocked`
2. else any attempt `approved` → `approved`
3. else the most recent attempt whose outcome is not `abandoned`/`expired` → that outcome
   (`pending`, `declined` or `manual_review`)
4. else → `not_verified`

`manual_review` therefore stays until staff decide on that attempt.

### Business rules

- **V1 — Already approved:** an approved user cannot start a new session (`ALREADY_VERIFIED`).
- **V2 — One at a time / resume:** if the user has a `pending` attempt younger than 30 minutes,
  return its stored `verification_url` and `session_token` instead of creating a new session.
  Resuming does **not** count toward V3. Didit can also force a resume: if "create session"
  returns a `session_id` we already have (Didit reuses an unfinished session for the same
  `vendor_data`), refresh that attempt's `verification_url` and `session_token` and treat it as a
  resume — no new attempt, not counted toward V3.
- **V3 — Retry limit:** max **3 created sessions per rolling 24 hours**. Every created session
  counts, including ones that ended `abandoned` or `expired`. The 4th returns
  `{ code: 'VERIFICATION_RETRY_LIMIT', manualReviewAvailable }`, where `manualReviewAvailable` is
  true when the most recent attempt was declined by Didit. Staff decisions are not attempts and
  don't count.
- **V4 — Age:** under 18 on the decision date → `declined`, reason `UNDERAGE`. (T2.1/T2.9 confirm
  whether Didit returns a Fayda date of birth in the Gregorian or Ethiopian calendar; convert if needed.)
- **V5 — Banned identity:** **any** of the attempt's `identity_hashes` matches an active
  (`lifted_at IS NULL`) row in `banned_identities` → attempt `blocked`, user `blocked`. The user
  sees a neutral message.
- **V6 — Duplicate identity:** any of the attempt's hashes (any kind) matches an approved hash
  (`is_approved = true`) belonging to a **different** user → attempt `blocked`, user `blocked`,
  flagged for staff (`flag_reason = DUPLICATE_IDENTITY`).

  (Later: staff can convert a V6 block into an account move for a user who lost their SIM.)
- **V7 — Weak duplicate signal:** same normalised `verified_name` + `date_of_birth` as another
  approved user, with no matching hash (e.g. Fayda then passport) → `manual_review`, not blocked.
  Name normalisation: lowercase, Latin script, strip punctuation, collapse whitespace; compare the
  full name. False positives are acceptable since this only triggers review.
- **V8 — Missing data:** Didit approved but returned no usable identifier (no number that maps to
  a known `kind`, e.g. an unexpected document type slipped through the workflow), no date of
  birth, or a passport with no issuing country → `manual_review`.
- **V9 — Locked identity:** once approved, `full_name` and `date_of_birth` cannot change via any
  user endpoint.
- **V10 — Hashing:** `normalise` uppercases and strips spaces and hyphens. One hash per identifier
  Didit returns (e.g. both FIN and FAN if both are present).
  - Fayda: `hash = HMAC_SHA256(ID_HASH_PEPPER, kind + ":" + normalise(number))`, e.g. input
    `fayda_fin:123456789012`.
  - Passport: `hash = HMAC_SHA256(ID_HASH_PEPPER, "passport:" + country + ":" + normalise(number))`,
    where `country` is the issuing country as ISO 3166-1 alpha-3, uppercase, taken from Didit's
    decision data (field confirmed in T2.1), e.g. input `passport:ETH:EP1234567`. Passports from
    different countries can share a number, so the country is part of the identity. No issuing
    country → V8.
- **V11 — Idempotency:** processing the same webhook event twice changes nothing the second time.
  Events are keyed by Didit's `event_id`, which is the same on every retry. An event is only
  skipped when its `processed_at` is set, so a failed processing attempt is retried.
- **V12 — Out-of-order events:** a late non-final Didit status (`Not Started` / `In Progress` /
  `In Review` / `Resubmitted` / `Awaiting User`) never changes an attempt that is no longer `pending`.
- **V13 — Blocked or in review can't start:** a user whose status is `manual_review` cannot start
  a new session (`VERIFICATION_IN_REVIEW`). A `blocked` user cannot start one either and gets a
  neutral error (`VERIFICATION_UNAVAILABLE`).
- **V14 — Superseding:** creating a new session marks any older `pending` attempt of the same
  user `abandoned` locally (and stops polling it). If a final Didit decision arrives for it later,
  it is still processed. Exception: when Didit returns a session we already have (see V2), that
  attempt is resumed, not superseded — it isn't marked `abandoned`.
- **V15 — Transitions after a final outcome:**
  - **Staff decisions are final.** If `decided_by_admin_id` is set, later Didit events only update
    `provider_status`.
  - **`blocked` is never lifted automatically.** Later Didit events only update `provider_status`.
  - **`Kyc Expired`** only updates `provider_status`, whatever the outcome (see the status mapping).
  - **`manual_review` waits for staff.** Later Didit events only update `provider_status`.
  - **`abandoned` / `expired`** (locally): a final Didit decision (Approved / Declined) is still
    processed; non-final statuses are ignored (V12).
  - **`approved` / `declined` set from Didit:** Didit may move the attempt between its own
    outcomes (e.g. approved → declined after Didit's review). We accept it (re-running V4–V8 on
    Approved) and recompute. If a user who was `approved` stops being approved this way:
    clear `users.verified_at`, keep `full_name` and `date_of_birth` as history, recompute, and
    flag the attempt for staff (`flag_reason = APPROVAL_REVERSED`).
- **V16 — Polling expiry:** an attempt still `pending` 24 hours after creation is marked
  `expired`, its URL/token are cleared, and it is no longer polled.

---

## 5. Staff (admin) side

Temporary UI: Swagger at `/docs` with the admin bearer token. A web admin comes later.
In production, `/docs` itself is only served behind admin auth (a browser can't attach a bearer
token when loading the page, so the page is protected separately, e.g. HTTP Basic checked against
`admin_users`; the admin API still requires the admin bearer token).

### Endpoints
- `POST /admin/auth/login { email, password }` → admin access token (`ADMIN_JWT_SECRET`).
- `GET /admin/verifications?status=manual_review|blocked&flagged=true` — queue, oldest first. Shows
  user phone, attempt history, flag reason, Didit session IDs (staff open images in the Didit
  console, never in our system).
- `POST /admin/verifications/:attemptId/approve { note, documentType?, idNumber?, issuingCountry?, dateOfBirth?, fullName? }`
  — moderator+. See S4.
- `POST /admin/verifications/:attemptId/decline { reasonCode, note }` — moderator+. Sets the
  attempt `declined` (final, staff decision) and recomputes, so the user goes back to `declined`
  and normal retry rules apply.
- `POST /admin/users/:userId/ban { reason }` — moderator+. See S5.
- `POST /admin/users/:userId/unban { note }` — super_admin only. See S5.
- `GET /admin/actions?targetId=` — audit log.
- A CLI command or seed script creates the first `super_admin` (never an open endpoint).

### Rules
- **S1** Every endpoint above that changes data writes to `admin_actions`.
- **S2** `support` can read everything here but change nothing.
- **S3** Admin tokens are rejected on app routes and app tokens on admin routes.
- **S4 — Staff approval:** approval always requires at least one identity hash and a date of birth
  on the attempt. If Didit didn't return them, staff must enter `documentType`, `idNumber` and
  `dateOfBirth` (read from the Didit console), plus `issuingCountry` (ISO 3166-1 alpha-3) for a
  passport, and `fullName` if Didit returned no name. The number
  is normalised and hashed into `identity_hashes` immediately and never stored raw (not in
  `admin_actions` either). Then V4–V6 run again; a failure rejects the approval with its error code.
  On success the attempt becomes `approved` with `decided_by_admin_id` set, and the user is recomputed.
- **S5 — Ban / unban:**
  - Ban sets `users.status = banned`, revokes all refresh tokens, and copies every hash of the
    user's approved attempt into `banned_identities`. A user with no approved attempt is only set
    to `banned`.
  - Unban sets `users.status = active`, sets `lifted_at`/`lifted_by_admin_id` on that user's active
    `banned_identities` rows, and recomputes the user's verification status.

---

## 6. Flutter app (separate repo, thin)

Screens: phone entry → OTP → home showing verification status → "Verify my identity" (opens the
Didit flow) → result screen (approved / declined with a retry option / pending / manual review /
neutral "contact support" for blocked). Language picker uses `PATCH /me`. Tokens stored in secure
storage; access token refreshed automatically. **Refreshes must be queued:** never send two
`POST /auth/refresh` calls at once with the same refresh token; concurrent callers wait for the one
in flight and use its result. (The A5 grace window covers a lost response, not parallel refreshes.)

---

## 7. Testing checklist

Unit or e2e tests must cover: A1–A9, V1–V16, S1–S5, every branch of
`recomputeVerificationStatus`, the global guards and `@Public()`, `PATCH /me` rejecting identity
fields, webhook signature rejection, re-processing an event whose `processed_at` is null, the
partial unique index rejecting a second approval of the same strong hash, and the polling job
picking up a stuck session and expiring one after 24 hours. Use a fake Didit client and
self-signed fake webhook payloads — tests must not call the real Didit API.

## 8. Manual end-to-end check

1. `docker compose up -d`, run migrations, start the API.
2. Start a tunnel (ngrok or `cloudflared tunnel --url http://localhost:3000`) and set
   `https://<tunnel>/webhooks/didit` as the webhook URL in the Didit console.
3. Sign up with your phone (code appears in the console), start verification, complete it on
   your phone with your real ID.
4. Confirm `GET /me` shows `approved`, and that `identity_verifications` and `identity_hashes`
   contain **no images and no raw ID number**.
5. Note exactly what Didit returned for a Fayda ID: which numbers (FIN, FAN or both), and whether
   the date of birth is Gregorian or Ethiopian calendar. Check whether Didit accepts the printed
   paper Fayda credential and the digital Fayda, not only the physical card. Update V4, V10 and
   the `kind` enum if needed.
6. Confirm the Didit workflow rejects any document other than a national ID or passport.
7. Repeat with a second phone and the same ID → must end `blocked` (V6).
