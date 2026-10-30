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
      implementation (create session, get decision) + `FakeDiditClient` for tests. Confirm status
      strings, decision field names, the webhook signature scheme and the base URL from the docs;
      note them in the code. Configure the Didit workflow to accept only national ID (Fayda) and
      passport. Also find out: which Fayda numbers Didit returns (FIN, FAN, both), how document
      types map to our `kind` enum, which field holds a passport's issuing country (and its
      format — convert to ISO 3166-1 alpha-3 if needed), whether a Fayda date of birth comes back in the Gregorian or
      Ethiopian calendar, and whether Didit accepts the printed paper credential and the digital
      Fayda, not only the physical card.
- [ ] **T2.2 Entities + migration.** `identity_verifications`, `identity_hashes` (with the partial
      unique index), `verification_webhook_events`, `banned_identities`.
- [ ] **T2.3 ID hashing utility.** Normalise + `kind:`-prefixed HMAC, with the issuing
      country for passports (V10); tests.
- [ ] **T2.4 Start a session.** `POST /verification/sessions` with V1–V3, V13, V14 (resume,
      superseding); `recomputeVerificationStatus` with tests for every branch.
- [ ] **T2.5 Webhook endpoint.** Signature check, timestamp freshness, idempotency (V11);
      re-processing an event whose `processed_at` is null; tests with self-signed payloads,
      including a forged one.
- [ ] **T2.6 Decision processing.** Status mapping + V4–V8, V12, V15, shared by webhook and polling;
      row locking (`SELECT … FOR UPDATE`), storing `identity_hashes`; tests for
      every rule, including a race on the unique index.
- [ ] **T2.7 Polling job.** Scheduled check for stuck sessions, 24-hour expiry (V16); tests.
- [ ] **T2.8 Status + manual review request.** `GET /verification/status`,
      `POST /verification/manual-review-request`; tests.
- [ ] **T2.9 Real-world check.** Tunnel + Didit sandbox + your own ID (spec section 8). Note any
      Fayda form that fails (card, paper credential, digital), which identifiers Didit returned,
      and the Fayda DOB calendar; confirm other documents are rejected; update V4/V10 and the
      `kind` enum if needed.

## Step 3 — Staff side

- [ ] **T3.1 Admin users + auth.** `admin_users` entity, separate JWT, `@Roles()` + `RolesGuard`,
      CLI/seed to create the first `super_admin`, admin auth in front of `/docs` in production;
      S3 tests.
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
