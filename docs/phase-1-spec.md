# Phase 1 spec — Foundation, accounts, identity verification

**Goal:** a user can sign up with their phone, verify their identity with an Ethiopian ID and a
selfie, and see "Approved" in the app. Staff can handle manual reviews and bans.

**Done when:** you sign up with your own phone, verify with your own Fayda card or kebele ID,
and your account shows `approved` — and every business rule below has a passing test.

**Out of scope:** listings, properties, contact requests, search, maps, photos, notifications/push,
payments, chat, Telegram, public web pages, a web admin panel, a real SMS provider.

---

## 1. Foundation

- NestJS app, TypeScript strict mode.
- Docker Compose: `postgis/postgis` image (Postgres + PostGIS) and Redis.
- TypeORM with a single `src/database/data-source.ts` used by both the app and the migration CLI.
  `synchronize: false`. First migration enables the `postgis` and `pgcrypto` extensions.
- Config module with validation: the app refuses to start if a required env variable is missing.
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- Swagger at `/docs` (disabled in production unless explicitly enabled).
- Rate limiting with `@nestjs/throttler`.
- `GET /health` — checks database and Redis.

### Environment variables

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://rental:rental@localhost:5432/rental
REDIS_URL=redis://localhost:6379

JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
ADMIN_JWT_SECRET=
ADMIN_JWT_TTL=8h

ID_HASH_PEPPER=            # long random secret; never change after launch

OTP_TTL_SECONDS=300
SMS_PROVIDER=console       # 'console' logs codes in development

DIDIT_API_KEY=
DIDIT_WEBHOOK_SECRET=
DIDIT_WORKFLOW_ID=
DIDIT_BASE_URL=https://verification.didit.me
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
| preferred_language | enum `am`,`om`,`en` | default `am` |
| status | enum `active`,`suspended`,`banned` | default `active` |
| verification_status | enum `not_verified`,`pending`,`approved`,`declined`,`manual_review`,`blocked` | default `not_verified` |
| verified_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### `otp_codes`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| phone | varchar | E.164, indexed |
| code_hash | varchar | Hash of the 6-digit code; never store the code |
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
| provider_status | varchar | Didit's latest status, as received |
| outcome | enum `pending`,`approved`,`declined`,`manual_review`,`blocked`,`abandoned`,`expired` | Our decision |
| decline_reason | varchar null | Internal reason code |
| document_type | varchar null | e.g. national ID, passport |
| verified_name | varchar null | |
| date_of_birth | date null | |
| id_number_hash | varchar null | HMAC-SHA256 with `ID_HASH_PEPPER`; indexed |
| completed_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### `verification_webhook_events` (idempotency + audit)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| provider_session_id | varchar | indexed |
| event_key | varchar unique | Derived from session ID + status (+ timestamp if provided) |
| provider_status | varchar | |
| received_at | timestamptz | |
| processed_at | timestamptz null | |
| error | text null | |

Store **no images and no raw ID numbers** in this table. Do not store the full raw payload.

### `banned_identities`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| id_number_hash | varchar unique | |
| reason | varchar | |
| banned_by_admin_id | uuid FK → admin_users | |
| lifted_at | timestamptz null | |
| lifted_by_admin_id | uuid null | |
| created_at | timestamptz | |

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
| details | jsonb | Reason, note — never personal documents |
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

### Rules
- **A1** OTP is 6 digits, valid for `OTP_TTL_SECONDS` (default 5 minutes).
- **A2** Max 5 wrong attempts per code; then the code is dead.
- **A3** Max 3 OTP requests per phone per 10 minutes.
- **A4** Requesting a new code invalidates older unconsumed codes for that phone.
- **A5** Refresh token reuse (a revoked token used again) revokes **all** of that user's tokens.
- **A6** `suspended` and `banned` users cannot log in or refresh; return a neutral error.
- **A7** In development, `SMS_PROVIDER=console` logs the code instead of sending it.

### Guards
- `JwtAuthGuard` — valid app-user access token.
- `ActiveAccountGuard` — `users.status = active`.
- `VerifiedGuard` — `users.verification_status = approved`. (No Phase 1 route needs it except a
  test route; it's built now for later phases.)

---

## 4. Identity verification

### Flow
1. **Start:** `POST /verification/sessions` (JwtAuth + ActiveAccount).
   - Check eligibility (rules V1–V3).
   - Call Didit to create a session with our `DIDIT_WORKFLOW_ID`, passing our `user.id` as
     `vendor_data` and `APP_VERIFICATION_CALLBACK_URL` as the callback.
   - Save an `identity_verifications` row (`outcome = pending`); set `users.verification_status = pending`.
   - Return `{ verificationUrl, sessionToken }` to the app.
2. **User completes the flow** in the app (Didit SDK or hosted page): document front/back,
   then a selfie with passive liveness.
3. **Webhook:** `POST /webhooks/didit` (public; no JWT).
   - Verify the signature exactly as Didit documents it (prefer `X-Signature-V2`). Reject invalid
     signatures with 401. If a timestamp header is provided, reject events older than 5 minutes.
   - Build an `event_key`; if already seen, return 200 and do nothing.
   - Store the event row, respond 200 quickly, and process the decision (inline is fine in
     Phase 1; move to a BullMQ job if processing grows).
4. **Processing a decision** (shared by the webhook and the polling job):
   - Look up the attempt by `provider_session_id`.
   - Map Didit's status (see table below).
   - If Didit approved, fetch or read the decision data and run our own checks (rules V4–V8).
   - Update the attempt row and `users.verification_status`; on final approval set
     `verified_at`, `full_name`, `date_of_birth`.
5. **Polling fallback:** a scheduled job every 5 minutes finds attempts still `pending` for more
   than 10 minutes and fetches their decision from Didit (`GET` session decision endpoint).
   This makes webhooks a speed-up, not a single point of failure.
6. **Status:** `GET /verification/status` → `{ status, canRetry, retriesLeftToday, reasonCode? }`.
   `reasonCode` is user-safe (e.g. `PHOTO_UNCLEAR`, `DOCUMENT_EXPIRED`); never reveal blocking reasons.
7. **Manual review request:** `POST /verification/manual-review-request` — allowed only after the
   daily retry limit is reached with declines. Sets `verification_status = manual_review`.

### Status mapping (Didit → ours)

Confirm Didit's exact status strings in their docs before coding.

| Didit status | Our attempt outcome | User verification_status |
| --- | --- | --- |
| Not Started / In Progress | `pending` | `pending` |
| In Review (Didit's own review) | `pending` | `pending` |
| Approved | run V4–V8 → `approved` / `declined` / `blocked` / `manual_review` | same as outcome |
| Declined | `declined` | `declined` |
| Abandoned | `abandoned` | back to previous state (`not_verified` or `declined`) |
| Expired | `expired` | back to previous state |

### Business rules

- **V1 — Already approved:** an approved user cannot start a new session (`ALREADY_VERIFIED`).
- **V2 — One at a time:** if a session is already `pending` and younger than 30 minutes, return
  that session instead of creating a new one.
- **V3 — Retry limit:** max **3 attempts per rolling 24 hours** (counting every created session).
  The 4th returns `VERIFICATION_RETRY_LIMIT` and, if the last attempts were declined, offers
  manual review.
- **V4 — Age:** under 18 on the decision date → `declined`, reason `UNDERAGE`.
- **V5 — Banned identity:** `id_number_hash` matches an active row in `banned_identities` →
  attempt `blocked`, user `blocked`. The user sees a neutral message.
- **V6 — Duplicate identity:** `id_number_hash` matches an **approved** verification belonging to
  a **different** user → attempt `blocked`, user `blocked`, flagged for staff. (Later: staff can
  convert this into an account move for a user who lost their SIM.)
- **V7 — Weak duplicate signal:** same `verified_name` + `date_of_birth` as another approved user
  but a different `id_number_hash` (e.g. Fayda then passport) → `manual_review`, not blocked.
- **V8 — Missing data:** Didit approved but no document number or date of birth in the decision
  → `manual_review`.
- **V9 — Locked identity:** once approved, `full_name` and `date_of_birth` cannot change via any
  user endpoint.
- **V10 — Hashing:** `id_number_hash = HMAC_SHA256(ID_HASH_PEPPER, normalise(id_number))`, where
  `normalise` uppercases and strips spaces and hyphens.
- **V11 — Idempotency:** processing the same webhook event twice changes nothing the second time.
- **V12 — Out-of-order events:** a late "In Progress" event must never overwrite a final outcome.

---

## 5. Staff (admin) side

Temporary UI: Swagger at `/docs` with the admin bearer token. A web admin comes later.

### Endpoints
- `POST /admin/auth/login { email, password }` → admin access token (`ADMIN_JWT_SECRET`).
- `GET /admin/verifications?status=manual_review|blocked` — queue, oldest first. Shows user
  phone, attempt history, Didit session IDs (staff open images in the Didit console, never in our system).
- `POST /admin/verifications/:attemptId/approve { note }` — moderator+. Runs V4–V6 again before
  approving; then sets user `approved`.
- `POST /admin/verifications/:attemptId/decline { reasonCode, note }` — moderator+.
- `POST /admin/users/:userId/ban { reason }` — moderator+. Sets `users.status = banned`, revokes
  all refresh tokens, and adds the user's approved `id_number_hash` to `banned_identities`.
- `POST /admin/users/:userId/unban { note }` — super_admin only.
- `GET /admin/actions?targetId=` — audit log.
- A CLI command or seed script creates the first `super_admin` (never an open endpoint).

### Rules
- **S1** Every endpoint above that changes data writes to `admin_actions`.
- **S2** `support` can read everything here but change nothing.
- **S3** Admin tokens are rejected on app routes and app tokens on admin routes.

---

## 6. Flutter app (separate repo, thin)

Screens: phone entry → OTP → home showing verification status → "Verify my identity" (opens the
Didit flow) → result screen (approved / declined with a retry option / pending / manual review /
neutral "contact support" for blocked). Tokens stored in secure storage; access token refreshed
automatically.

---

## 7. Testing checklist

Unit or e2e tests must cover: A1–A7, V1–V12, S1–S3, webhook signature rejection, and the polling
job picking up a stuck session. Use a fake Didit client and self-signed fake webhook payloads —
tests must not call the real Didit API.

## 8. Manual end-to-end check

1. `docker compose up -d`, run migrations, start the API.
2. Start a tunnel (ngrok or `cloudflared tunnel --url http://localhost:3000`) and set
   `https://<tunnel>/webhooks/didit` as the webhook URL in the Didit console.
3. Sign up with your phone (code appears in the console), start verification, complete it on
   your phone with your real ID.
4. Confirm `GET /me` shows `approved`, and `identity_verifications` contains **no images and no
   raw ID number**.
5. Repeat with a second phone and the same ID → must end `blocked` (V6).
