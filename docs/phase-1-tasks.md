# Phase 1 tasks

Work through these **in order, one task per Claude Code session**. For each task: ask Claude Code
to plan first, review the plan, let it implement with tests, read the explanation, then commit.

Tick each box when it's merged and you've understood the code.

---

## Step 0 — Foundation

- [ ] **T0.1 Finish the scaffold.** The NestJS 12 scaffold already exists (ESM, Vitest, oxlint,
      Prettier) — keep it, don't add ESLint or Jest. Confirm TypeScript strict mode, create the
      folder layout from `CLAUDE.md`, `.env.example`, `.gitignore`.
      *Done when:* `npm run start:dev` serves "Hello" and `npm run lint` passes.
- [ ] **T0.2 Docker Compose.** Postgres with PostGIS and Redis, with named volumes.
      *Done when:* `docker compose up -d` starts both and they survive a restart with data intact.
- [ ] **T0.3 Config with validation.** Load env, validate all variables from the spec.
      *Done when:* removing a required variable makes the app refuse to start with a clear message.
- [ ] **T0.4 TypeORM + migrations.** **First prove that the TypeORM migration CLI works under ESM**
      (generate, run, revert with `data-source.ts`). If it fights us, stop and report — we may
      switch the project to CommonJS. Then: migration scripts in `package.json`, first migration
      enabling `postgis` and `pgcrypto`.
      *Done when:* `migration:run` and `migration:revert` both work.
- [ ] **T0.5 Health, validation, Swagger, throttling.** `GET /health` (DB + Redis), global
      `ValidationPipe`, Swagger at `/docs` (off in production unless `SWAGGER_ENABLED`; the
      admin-auth protection is added in T3.1), `@nestjs/throttler`.
      *Done when:* `/health` reports both services; `/docs` loads.
- [ ] **T0.6 Test setup.** Vitest unit and e2e configs (`vitest.config.ts`,
      `vitest.config.e2e.ts`) with a separate test database.
      *Done when:* one sample unit test and one e2e test (`/health`) pass.

## Step 1 — Accounts

- [ ] **T1.1 Users module.** `users` entity, enums, migration.
- [ ] **T1.2 Phone normalisation utility.** E.164 for Ethiopian mobile numbers, with tests for
      `09…`, `9…`, `+2519…`, `2519…`, `07…`, and invalid input.
- [ ] **T1.3 SMS interface.** `SmsSender` interface + `ConsoleSmsSender`.
- [ ] **T1.4 OTP request + verify.** `otp_codes` entity and migration; rules A1–A4, A7–A9 (per-IP
      throttling, HMAC with `OTP_HASH_SECRET`); tests. Add `OTP_REQUEST_IP_LIMIT_PER_HOUR`
      (default 30) to config for A8. The per-phone limit (A3) must be counted from the `otp_codes`
      table, **not** the in-memory throttler, so it survives restarts.
- [ ] **T1.5 JWT tokens.** Access + refresh, `refresh_tokens` table, rotation, logout, rules A5–A6; tests.
- [ ] **T1.6 Guards + `/me`.** Global `JwtAuthGuard` + `ActiveAccountGuard` with a `@Public()`
      opt-out, `VerifiedGuard`, `@CurrentUser()` decorator, `GET /me`, `PATCH /me`
      (`preferredLanguage` only, V9); tests.

## Step 2 — Identity verification

- [ ] **T2.1 Read Didit's docs and write the client.** `DiditClient` interface + real
      implementation (create session, get decision) + `FakeDiditClient` for tests (including
      Didit's "returns the existing unfinished session" behaviour). Findings, status strings,
      decision field names, the webhook signature recipe and the console configuration are recorded
      in `docs/didit-integration.md`. The client sends `expected_document_types = ["ID", "P"]`,
      treats 401/403 as "check `DIDIT_API_KEY`", and drops image URLs and unneeded fields before
      anything else sees a decision (hard rule 1). Done in the console (sandbox app): workflow
      "Free KYC" accepts Ethiopian `ID_CARD_GENERIC` + passports, passports only elsewhere.
      Fayda specifics (subtype, FIN/FAN, DOB calendar, paper/digital) move to T2.9.
- [ ] **T2.2 Entities + migration.** `identity_verifications`, `identity_hashes` (with the partial
      unique index), `verification_webhook_events`, `banned_identities`.
- [ ] **T2.3 ID hashing utility.** Normalise + `kind:`-prefixed HMAC, with the issuing
      country for passports (V10); tests.
- [ ] **T2.4 Start a session.** `POST /verification/sessions` with V1–V3, V13, V14 (resume,
      superseding); `recomputeVerificationStatus` with tests for every branch.
- [ ] **T2.5 Webhook endpoint.** Signature check (`X-Signature-V2` + `-Previous` during secret
      rotation), timestamp freshness (±300 s), environment check (new `DIDIT_ENVIRONMENT`, default
      `sandbox` outside production; events from the other environment rejected), idempotency on
      Didit's `event_id` (V11); re-processing an event whose `processed_at` is null; tests with
      self-signed payloads, including a forged one and a wrong-environment one. Create the Didit
      webhook destination once the tunnel URL is known (its secret goes into `DIDIT_WEBHOOK_SECRET`).
- [ ] **T2.6 Decision processing.** Status mapping (including `Kyc Expired`, `Resubmitted`,
      `Awaiting User`) + V4–V8, V12, V15, shared by webhook and polling; row locking
      (`SELECT … FOR UPDATE`), storing `identity_hashes`; `data.updated` re-fetches the decision and
      flags the attempt (`DATA_UPDATED`) without touching `full_name` / `date_of_birth` (V9).
      Fayda numbers: 12 digits → `fayda_fin`, 16 → `fayda_fan` as a starting point; anything else →
      V8 `manual_review`, never guessed. Tests for every rule, including a race on the unique index.
- [ ] **T2.7 Polling job.** Scheduled check for stuck sessions, 24-hour expiry (V16); tests.
- [ ] **T2.8 Status + manual review request.** `GET /verification/status`,
      `POST /verification/manual-review-request`; tests.
- [ ] **T2.9 Real-world check.** Tunnel + Didit sandbox + your own ID (spec section 8). Answer the
      open questions in `docs/didit-integration.md`: is the physical Fayda card classified as
      `ID_CARD_GENERIC`; which Fayda numbers come back (FIN, FAN, both), in which field and with
      what lengths; the DOB calendar; whether the paper credential or digital Fayda is accepted.
      Confirm other documents are rejected; update V4/V10, the FIN/FAN rule and the `kind` enum if needed.

## Step 3 — Staff side

- [ ] **T3.1 Admin users + auth.** `admin_users` entity, separate JWT, `@Roles()` + `RolesGuard`,
      CLI/seed to create the first `super_admin`, admin auth in front of `/docs` in production;
      S3 tests. Add foreign keys from identity_verifications.decided_by_admin_id,
      banned_identities.banned_by_admin_id and banned_identities.lifted_by_admin_id
      to admin_users.
- [ ] **T3.2 Audit log.** `admin_actions` entity + a small service every admin action calls (S1).
- [ ] **T3.3 Verification queue + approve/decline.** Including manual entry of document data and
      re-running V4–V6 on approve (S4); tests.
- [ ] **T3.4 Ban / unban.** Token revocation, copying hashes into `banned_identities`, lifting and
      recomputing on unban (S5); S2 tests.

## Step 4 — Thin Flutter app (repo: `rental-app`)

- [ ] **T4.1 Project setup.** Flutter project, its own `CLAUDE.md`, API client, secure token storage,
      auto refresh.
- [ ] **T4.2 Login.** Phone entry + OTP screens.
- [ ] **T4.3 Verification.** Status screen, start verification (Didit SDK or hosted page), result
      screens for each state.
- [ ] **T4.4 End-to-end on a real phone** through the tunnel.

---

## Phase 1 is done when

- Every box above is ticked.
- You verified yourself end to end with a real Ethiopian ID.
- A second account with the same ID ends up `blocked`.
- You can explain every module out loud, as you would in a job interview.
