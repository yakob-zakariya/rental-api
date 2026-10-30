# CLAUDE.md — rental-api

Read this file fully at the start of every session.

## What this project is

A broker-free house rental platform for Ethiopia. Landlords list homes directly; tenants find them
without paying a broker (delala) one month's rent. Trust comes from **verified identities**,
**always-fresh listings**, and **tenant feedback after viewings** — not from ownership documents.

- Full product context and all decisions: `docs/product-overview.md`
- What we are building right now: `docs/phase-1-spec.md`
- Task breakdown for this phase: `docs/phase-1-tasks.md`

## Current phase: Phase 1 — Foundation, accounts, identity verification

Only build what `docs/phase-1-spec.md` describes. Listings, contact requests, search, maps,
payments, chat and notifications are **out of scope** for now. If a task seems to need them, stop
and ask instead of building them.

## Stack

- **Backend:** NestJS 12 (TypeScript, strict mode, **ESM** — `"type": "module"`), Node.js LTS
- **Tests:** Vitest (`vitest.config.ts` for unit, `vitest.config.e2e.ts` for e2e) — not Jest
- **Lint / format:** oxlint (type-aware) + Prettier — not ESLint
- **Database:** PostgreSQL with PostGIS, via **TypeORM**
- **Queues / cache:** Redis (BullMQ via `@nestjs/bullmq` when queues are needed)
- **Scheduling:** `@nestjs/schedule`
- **Identity verification (KYC):** Didit (https://docs.didit.me) — ID document + passive liveness + face match.
  Accepted documents: Fayda national ID (primary) and passports only.
- **Mobile app:** Flutter, in a separate repo (`rental-app`), not this one
- **Local infrastructure:** Docker Compose (Postgres + PostGIS, Redis)
- **API docs:** `@nestjs/swagger` (Swagger UI also serves as the temporary admin UI in Phase 1)

## Repository layout

```
src/
  main.ts
  app.module.ts
  config/            # env loading + validation (app must refuse to start on missing/invalid env)
  database/
    data-source.ts   # the ONE TypeORM DataSource, shared by the app and the migration CLI
    migrations/
  common/            # guards, decorators, filters, interceptors, utils
  modules/
    health/
    auth/            # phone OTP, JWT access/refresh tokens
    users/
    verification/    # Didit client, webhook, state machine, background jobs
    admin/           # staff auth, roles, manual review, bans, audit log
test/
docs/
```

## Commands

Keep these accurate. The `docker compose` and `migration:*` commands don't exist yet (added in
T0.2 and T0.4).

```
docker compose up -d          # start Postgres + Redis
npm run start:dev             # run the API
npm run test                  # unit tests (Vitest)
npm run test:e2e              # end-to-end tests (Vitest)
npm run lint                  # oxlint
npm run format                # Prettier
npm run migration:generate -- src/database/migrations/<Name>
npm run migration:run
npm run migration:revert
```

## Hard rules — never break these

1. **Never store ID document images, selfies, face data or raw ID numbers.** Store only: the
   provider's session ID, status, decline reason, document type, verified name, date of birth,
   and HMAC hashes of the ID numbers (`identity_hashes`). Images stay with Didit. Raw ID numbers
   typed in by staff are hashed immediately and never stored or logged, not even in `admin_actions`.
2. **ID numbers are hashed with HMAC-SHA256 using the `ID_HASH_PEPPER` secret**, as
   `HMAC(ID_HASH_PEPPER, kind + ":" + normalise(number))` where `kind` is the identifier type
   (`fayda_fin`, `fayda_fan`, `passport`) and `normalise` uppercases and strips spaces and hyphens.
   Passports also include the ISO 3166-1 alpha-3 issuing country:
   `HMAC(ID_HASH_PEPPER, "passport:" + country + ":" + normalise(number))`, e.g. `passport:ETH:EP1234567`.
   Never plain SHA-256 — ID numbers are short and guessable. OTP codes are likewise stored only as
   an HMAC (`OTP_HASH_SECRET`).
3. **`synchronize: false` always.** Every schema change goes through a generated migration.
4. **Never trust a webhook without verifying its signature.** Use Didit's documented scheme
   exactly. Process each event once (idempotency).
5. **Never commit secrets.** All keys live in `.env`; keep `.env.example` up to date with dummy values.
6. **Money is always an integer number of birr.** Never floats. (Not used in Phase 1, but applies everywhere.)
7. **Phone numbers are stored in E.164 format** (`+2519XXXXXXXX` or `+2517XXXXXXXX`).
8. **Staff and app users are completely separate.** Separate tables, separate JWT secrets,
   separate guards. An app-user token must never work on an admin route.
9. **A verified user's `full_name` and `date_of_birth` cannot be edited** through any user-facing endpoint.
10. **Never tell a blocked user why they were blocked.** Return a neutral message.
11. **Every staff action that changes data writes a row to `admin_actions`.**

## Conventions

- Feature modules own their entities, DTOs, services and controllers.
- Validate every request body with DTOs (`class-validator`); enable the global `ValidationPipe`
  with `whitelist` and `forbidNonWhitelisted`.
- Business rules live in services, not controllers. Ownership checks happen where the entity is loaded.
- Use enums for every status field; mirror them as Postgres enums in migrations.
- Use UUID primary keys (`uuid` type) for all user-facing entities.
- Timestamps: `created_at`, `updated_at` with `timestamptz`. Store UTC; the app shows Africa/Addis_Ababa.
- Wrap external services (Didit, SMS) behind an interface in their module so they can be faked in tests.
- `JwtAuthGuard` + `ActiveAccountGuard` are global for app routes; mark exceptions with `@Public()`.
  Admin routes use the admin guards instead.
- `users.verification_status` is derived: only `recomputeVerificationStatus(userId)` writes it.
- Errors: throw Nest HTTP exceptions with stable error codes in the body, e.g. `{ code: 'VERIFICATION_RETRY_LIMIT' }`.

## How to work in this repo

1. **Plan before coding.** For any task, first propose a short plan (files to touch, entities,
   migrations, tests) and wait for approval.
2. **One small task at a time**, from `docs/phase-1-tasks.md`. Don't start the next task unprompted.
3. **Tests for business rules come with the code**, not later. Every rule in the spec's
   "Business rules" section must have a test.
4. **Read the real docs** for Didit (https://docs.didit.me) before writing integration code.
   Don't guess endpoint paths, field names or the signature scheme.
5. **After each task, explain** what you did and why in plain language, list anything uncertain,
   and suggest a commit message.
6. If the spec is unclear or seems wrong, **ask** — don't invent behaviour.
