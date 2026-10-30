# Phase 1 tasks

Work through these **in order, one task per Claude Code session**. For each task: ask Claude Code
to plan first, review the plan, let it implement with tests, read the explanation, then commit.

Tick each box when it's merged and you've understood the code.

---

## Step 0 — Foundation

- [ ] **T0.1 Scaffold the project.** New NestJS app, TypeScript strict, ESLint + Prettier,
      folder layout from `CLAUDE.md`, `.env.example`, `.gitignore`.
      *Done when:* `npm run start:dev` serves "Hello" and `npm run lint` passes.
- [ ] **T0.2 Docker Compose.** Postgres with PostGIS and Redis, with named volumes.
      *Done when:* `docker compose up -d` starts both and they survive a restart with data intact.
- [ ] **T0.3 Config with validation.** Load env, validate all variables from the spec.
      *Done when:* removing a required variable makes the app refuse to start with a clear message.
- [ ] **T0.4 TypeORM + migrations.** `data-source.ts`, migration scripts in `package.json`, first
      migration enabling `postgis` and `pgcrypto`.
      *Done when:* `migration:run` and `migration:revert` both work.
- [ ] **T0.5 Health, validation, Swagger, throttling.** `GET /health` (DB + Redis), global
      `ValidationPipe`, Swagger at `/docs`, `@nestjs/throttler`.
      *Done when:* `/health` reports both services; `/docs` loads.
- [ ] **T0.6 Test setup.** Unit and e2e test configs with a separate test database.
      *Done when:* one sample unit test and one e2e test (`/health`) pass.

## Step 1 — Accounts

- [ ] **T1.1 Users module.** `users` entity, enums, migration.
- [ ] **T1.2 Phone normalisation utility.** E.164 for Ethiopian mobile numbers, with tests for
      `09…`, `9…`, `+2519…`, `2519…`, `07…`, and invalid input.
- [ ] **T1.3 SMS interface.** `SmsSender` interface + `ConsoleSmsSender`.
- [ ] **T1.4 OTP request + verify.** `otp_codes` entity and migration; rules A1–A4, A7; tests.
- [ ] **T1.5 JWT tokens.** Access + refresh, `refresh_tokens` table, rotation, logout, rules A5–A6; tests.
- [ ] **T1.6 Guards + `/me`.** `JwtAuthGuard`, `ActiveAccountGuard`, `VerifiedGuard`, `@CurrentUser()`
      decorator, `GET /me`; tests.

## Step 2 — Identity verification

- [ ] **T2.1 Read Didit's docs and write the client.** `DiditClient` interface + real
      implementation (create session, get decision) + `FakeDiditClient` for tests. Confirm status
      strings, decision field names and the webhook signature scheme from the docs; note them in
      the code.
- [ ] **T2.2 Entities + migration.** `identity_verifications`, `verification_webhook_events`,
      `banned_identities`.
- [ ] **T2.3 ID hashing utility.** Normalise + HMAC (V10); tests.
- [ ] **T2.4 Start a session.** `POST /verification/sessions` with V1–V3; tests.
- [ ] **T2.5 Webhook endpoint.** Signature check, timestamp freshness, idempotency (V11);
      tests with self-signed payloads, including a forged one.
- [ ] **T2.6 Decision processing.** Status mapping + V4–V8 + V12, shared by webhook and polling; tests
      for every rule.
- [ ] **T2.7 Polling job.** Scheduled check for stuck sessions; test.
- [ ] **T2.8 Status + manual review request.** `GET /verification/status`,
      `POST /verification/manual-review-request`; tests.
- [ ] **T2.9 Real-world check.** Tunnel + Didit sandbox + your own ID (spec section 8). Note any
      Ethiopian document that fails.

## Step 3 — Staff side

- [ ] **T3.1 Admin users + auth.** `admin_users` entity, separate JWT, `@Roles()` + `RolesGuard`,
      CLI/seed to create the first `super_admin`; S3 tests.
- [ ] **T3.2 Audit log.** `admin_actions` entity + a small service every admin action calls (S1).
- [ ] **T3.3 Verification queue + approve/decline.** Including re-running V4–V6 on approve; tests.
- [ ] **T3.4 Ban / unban.** Including token revocation and `banned_identities`; S2 tests.

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
