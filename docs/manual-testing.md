# Manual testing

A hands-on pass through the API with Swagger UI, as a real client would use it. The automated
tests use fakes for SMS and Didit; this is where the real wiring gets seen. Keep it up to date:
every new endpoint gets a step here.

## Setup

1. `docker compose up -d --wait`
2. `.env` has real **sandbox** Didit values (never commit them):
   - `DIDIT_API_KEY`: the "yakobRental (Sandbox)" app's key
   - `DIDIT_WORKFLOW_ID=5d5368e7-3151-4cd6-b92d-d3efd0b4b00b` ("Free KYC")
   - `APP_VERIFICATION_CALLBACK_URL`: any https URL for now
   - `DIDIT_WEBHOOK_SECRET`: the sandbox webhook destination's secret
   - `DIDIT_ENVIRONMENT=sandbox`

   With placeholders, starting verification returns 503 `VERIFICATION_PROVIDER_UNAVAILABLE`.
3. `npm run migration:run` (no-op if up to date), then `npm run start:dev`. Keep this terminal
   visible: OTP codes are printed here (`SMS_PROVIDER=console`).
4. Open **http://localhost:3000/docs**.

Restart `start:dev` after editing `.env`.

## How to use the Postman collection

The same journey as below, ready to click through: `docs/postman/`.

1. In Postman: **Import** → select both `rental-api.postman_collection.json` and
   `local.postman_environment.json`. Choose the **rental-api local** environment (top right).
2. Run the folders in order: **1. Health → 2. Auth → 3. Me → 4. Verification**, then
   **5. Expected failures**.
3. After **OTP request**, copy the 6-digit code from the `npm run start:dev` terminal into the
   environment variable `otpCode`, then send **OTP verify**. It saves `accessToken` and
   `refreshToken` into the environment; every protected request sends `Bearer {{accessToken}}`,
   and **Refresh** keeps both up to date. **Logout** clears `refreshToken`.
4. Each request's description says what to expect; its **Tests** tab checks the status (and the
   error `code` for the expected failures).

Notes:
- `phone` in the environment is a sample number (`0911234567`); use your own if you like (codes
  only go to the console until a real SMS provider exists).
- Access tokens expire after 15 minutes (401 `ACCESS_TOKEN_EXPIRED`): send **Refresh**.
- At most 3 OTP requests per phone per 10 minutes (A3); the failures folder uses one
  ("Fresh OTP code").
- **Start session** needs the sandbox Didit values in `.env`; otherwise it returns 503.
- The webhook isn't in the collection: Didit signs it, so it can't be sent by hand (see
  "Webhooks" below).
- **6. Admin:** set `adminEmail`/`adminPassword` (from `npm run admin:create`), then **Admin login**
  saves `adminToken`; admin requests use it instead of the app token.
- Never save real tokens or passwords back into the exported files: they're committed to git.

## Walkthrough

| # | Request | Expect |
| --- | --- | --- |
| 1 | `GET /health` | 200, `database` and `redis` both `up` |
| 1a | `GET /areas` (no token) | 200, 11 sub-cities (Addis Ketema … Yeka), each with neighbourhoods in English and Amharic; 70 neighbourhoods in all |
| 2 | `POST /auth/otp/request` `{ "phone": "0911234567" }` | 200 `{ "expiresInSeconds": 300 }`; terminal shows `[SMS] To +251911234567: Your rental code is …` |
| 3 | `POST /auth/otp/verify` `{ "phone": "0911234567", "code": "<code>", "deviceName": "laptop" }` | 200 `{ accessToken, refreshToken, accessTokenExpiresIn: 900 }` — copy both tokens |
| 4 | **Authorize** (top of Swagger) → paste the access token into **app** (not admin) | |
| 5 | `GET /me` | 200, your profile, `verificationStatus: "not_verified"` |
| 6 | `PATCH /me` `{ "preferredLanguage": "en" }` | 200, `preferredLanguage: "en"` |
| 7 | `PATCH /me` `{ "preferredLanguage": "en", "fullName": "x" }` | 400 `VALIDATION_FAILED` (V9) |
| 8 | `POST /verification/sessions` | 201 `{ verificationUrl, sessionToken }`; open the URL to see Didit's flow |
| 9 | `POST /verification/sessions` again (within 30 min) | 201, the same URL (V2 resume) |
| 9a | `GET /verification/status` | `status: "pending"`, `canRetry: true`, `retriesLeftToday: 2`, `canRequestManualReview: false`, `retryAvailableAt: null` |
| 10 | `POST /auth/refresh` `{ "refreshToken": "<refresh>" }` | 200, a new pair |
| 11 | Repeat step 10 with the **old** refresh token, within 60 s | 200 (A5 grace for a lost response) |
| 12 | Repeat step 10 with the old token after the replacement was used | 401 `INVALID_REFRESH_TOKEN`, and every session of the user is revoked (A5) |
| 13 | `POST /auth/logout` `{ "refreshToken": "<current refresh>" }` | 204 |

## Webhooks (needs a tunnel)

1. Start a tunnel to `localhost:3000` (e.g. `ngrok http --url=<your-static-domain> 3000`).
2. In the Didit console (sandbox app), the webhook destination points at
   `https://<tunnel>/webhooks/didit`, version v3, events `status.updated` + `data.updated`; its
   secret is `DIDIT_WEBHOOK_SECRET`.
3. Trigger events: finish the hosted flow from step 8, or use the console's **Try Webhook**.

| Check | Expect |
| --- | --- |
| Didit console → destination → **Deliveries** | 200 for each event |
| `start:dev` log | `[Decisions] Attempt …: approved` (or the outcome and reason/flag) |
| `SELECT event_key, webhook_type, provider_status, processed_at, error FROM verification_webhook_events;` | one row per event, `processed_at` set, `error` null |
| Resend the same delivery from the console | 200 again, still one row (V11) |
| Change `DIDIT_WEBHOOK_SECRET` to something wrong, restart, resend | 401 in Deliveries; log `Rejected a Didit webhook: bad_signature`; no new row |

After an approval, `GET /me` shows `verificationStatus: "approved"` with `fullName` and
`dateOfBirth` filled in. In the **sandbox** app every outcome is simulated (e.g. Didit's
`sandbox_scenario`); real documents are only checked in the live app (T2.9).

| Look at | Expect |
| --- | --- |
| `SELECT outcome, provider_status, decline_reason, flag_reason, verified_name, date_of_birth FROM identity_verifications;` | the attempt's outcome; `verification_url`/`session_token` cleared once final |
| `SELECT kind, is_approved FROM identity_hashes;` | one row per identifier, `is_approved = true` only for an approved attempt; **no raw numbers** (only 64-hex hashes) |
| `SELECT verification_status, verified_at, full_name, date_of_birth FROM users;` | matches `/me` |
| `POST /verification/sessions` after approval | 409 `ALREADY_VERIFIED` (V1) |

## Polling (the webhook backstop)

Runs every 5 minutes when `JOBS_ENABLED=true` (the default in `.env`).

1. Stop the tunnel (so the webhook can't arrive), start verification and finish the flow.
2. Within ~15 minutes (10 minutes pending + up to 5 for the next pass) the `start:dev` log shows
   `[VerificationPolling] Pass: 1 polled, …` and `/me` shows the outcome.
3. Attempts still pending 24 h after `pending_since` are expired; a session Didit no longer knows
   (404) is expired at once with `provider_status = 'NOT_FOUND'`.

## Staff (admin) sign-in

1. Create your staff account once: `npm run admin:create -- --email you@example.com`
   (role defaults to `super_admin`; the password is asked for twice, hidden, at least 12 characters).
2. `POST /admin/auth/login` `{ "email": "you@example.com", "password": "…" }` → 200
   `{ accessToken, accessTokenExpiresIn: 28800 }` (8 hours, no refresh: sign in again).
3. In Swagger, **Authorize** → paste it into **admin** (not app). `GET /admin/auth/me` → your
   `{ id, email, role }`.

| Try | Expect |
| --- | --- |
| Wrong password, unknown email, or a deactivated account | the same 401 `INVALID_CREDENTIALS` |
| 10 wrong passwords for one email, then the right one | still 401 `INVALID_CREDENTIALS` for 15 minutes (per-email limit in Redis) |
| More than 10 logins from one IP in 15 minutes | 429 `RATE_LIMITED` |
| The admin token on `GET /me`, or an app token on `GET /admin/auth/me` | 401 `UNAUTHENTICATED` (S3) |
| `UPDATE admin_users SET is_active = false …`, then `GET /admin/auth/me` | 401 at once |
| `GET /admin/actions` (any staff role) | newest first, your `admin.login` rows included; `?limit=2` then `?before=<nextCursor>` pages on |
| `GET /admin/actions?targetId=<uuid>` | only actions on that target |
| In psql: `UPDATE admin_actions SET details = '{}';` or `DELETE FROM admin_actions;` | rejected: `admin_actions is append-only` |

### Reviewing verifications (moderator or super_admin to change; support can read)

| Try | Expect |
| --- | --- |
| `GET /admin/verifications` | undecided `manual_review` + `blocked` attempts, oldest first, with `providerSessionId` (open it in the Didit console) |
| `GET /admin/verifications/<attemptId>` | `verifiedName`/`dateOfBirth` beside `providerVerifiedName`/`providerDateOfBirth`, `identities` (kinds only), `history` |
| Approve with Didit's data: `POST …/approve { "note": "…" }` | 200, `outcome: approved`; the user's `/me` → `approved` |
| Approve a `MISSING_DATA` attempt: `{ "note": "…", "documentType": "fayda_fin", "idNumber": "<12 digits>", "dateOfBirth": "…" }` | 200; `identity_hashes` gets a hash, the number appears nowhere (tables, audit, logs, response) |
| Enter an `idNumber` on an attempt that already has Didit's | 409 `IDENTIFIER_ALREADY_PRESENT` |
| Correct `fullName`/`dateOfBirth` | effective values change; `provider*` keep Didit's |
| Decline: `POST …/decline { "reasonCode": "PHOTO_UNCLEAR", "note": "…" }` | 200; the user's `GET /verification/status` → `declined`, `reasonCode: PHOTO_UNCLEAR` |
| Decline a `blocked` attempt | 409 `ATTEMPT_NOT_REVIEWABLE` |
| The same as support | 403 `INSUFFICIENT_ROLE` |

### Bans (ban: moderator+; unban: super_admin only)

| Try | Expect |
| --- | --- |
| `GET /admin/users/<userId>` (any staff role) | status, identity kinds, active bans, attempts; no hashes or numbers |
| `POST /admin/users/<userId>/ban { "reason": "…" }` | 200 `{ status: banned, identitiesBanned }`; that user's app token → 403 `ACCOUNT_UNAVAILABLE`, refresh → 401, sign-in → 403 |
| Another account verifying with the banned person's Fayda/passport | its attempt → `blocked` (V5) |
| Same name + date of birth on a different document | `manual_review`, flag `POSSIBLE_BANNED_DUPLICATE` |
| Ban again | 409 `ALREADY_BANNED` |
| `POST /admin/users/<userId>/unban { "note": "…" }` as moderator | 403 `INSUFFICIENT_ROLE` |
| … as super_admin | 200, `status: active`; the user signs in again (old tokens stay revoked) |

### Neighbourhoods (change: moderator+; support can read)

Staff manage the list behind `GET /areas` (spec G8). Nothing is ever deleted.

| Try | Expect |
| --- | --- |
| `GET /admin/neighbourhoods` (any staff role) | 70 active ones, sorted by sub-city then name, each with `subCityNameEn`, `active`, `createdByAdminId` (null for seeded ones) |
| `… ?subCityId=<id>&includeInactive=true` | that sub-city only, deactivated ones included (`active: false`) |
| `POST /admin/neighbourhoods { "subCityId": "<Bole's id>", "nameEn": "Test place", "nameAm": "የሙከራ ሰፈር" }` | 201; it appears in `GET /areas`; `GET /admin/actions` shows `neighbourhood.create` with the names |
| The same again, or `"nameEn": "PIASSA"` in Arada | 409 `NEIGHBOURHOOD_EXISTS` |
| `PATCH /admin/neighbourhoods/<id> { "nameEn": "Piazza" }` | 200; `GET /areas` shows the new name; the audit row has `oldNameEn` / `newNameEn` |
| `PATCH …` with `{}` | 400 `NO_FIELDS_TO_UPDATE` |
| `POST /admin/neighbourhoods/<id>/deactivate { "note": "…" }` | 200 `active: false`; gone from `GET /areas`, still in the admin list with `includeInactive=true` |
| Deactivate again | 409 `NEIGHBOURHOOD_ALREADY_INACTIVE` |
| `POST /admin/neighbourhoods/<id>/reactivate` | 200 `active: true`; back in `GET /areas` |
| A note like `owner 123456789012` | 400 `NOTE_CONTAINS_ID_NUMBER`; nothing changes |
| `DELETE /admin/neighbourhoods/<id>` | 404 (there is no delete) |
| Any change as support | 403 `INSUFFICIENT_ROLE` |

## Worth trying on purpose

| Try | Expect |
| --- | --- |
| A wrong OTP code 5 times | `OTP_INVALID` with `attemptsRemaining` 4…1, then `OTP_ATTEMPTS_EXCEEDED`; the right code no longer works (A2) |
| A 4th OTP request for one phone within 10 minutes | 429 `OTP_RATE_LIMITED` with `retryAfterSeconds` (A3) |
| A landline (`0111234567`) or foreign number (`+447700900123`) | 400 `INVALID_PHONE` |
| `GET /me` without Authorize, or with a garbage token | 401 `UNAUTHENTICATED` |
| `GET /me` 15+ minutes after sign-in | 401 `ACCESS_TOKEN_EXPIRED` → refresh |
| A refresh token pasted as the access token | 401 `UNAUTHENTICATED` |
| An unknown field in any body | 400 `VALIDATION_FAILED` |
| Three Didit declines in 24 h (finish three flows that Didit declines; or seed them in the dev DB), then `GET /verification/status` | `canRetry: false`, `retriesLeftToday: 0`, `canRequestManualReview: true`, `retryAvailableAt` = the oldest of the three attempts' `created_at` + 24 h (UTC; matches the 429's `retryAfterSeconds` from `POST /verification/sessions`), `reasonCode: "DOCUMENT_NOT_VERIFIED"` |
| Then `POST /verification/manual-review-request` | 200, `status: "manual_review"`; a second request → 409 `VERIFICATION_IN_REVIEW`; starting a session → 409 `VERIFICATION_IN_REVIEW` |
| `POST /verification/manual-review-request` below the limit | 409 `MANUAL_REVIEW_NOT_AVAILABLE` |

## Resetting verification data (development only)

The sandbox returns the **same fake identity** for every session, so after the first approval
V6 blocks every new test account ("identifier already approved for another user"). To start the
verification side over without losing your accounts:

```
npm run dev:reset-verifications
```

1. Stop `npm run start:dev` first, so the polling job isn't mid-run.
2. It prints the database name and how many rows it will delete, then asks you to type
   `reset` (anything else aborts with nothing changed).
3. Deletes **every** row of `identity_hashes`, `banned_identities`,
   `verification_webhook_events` and `identity_verifications`, and sets every user to
   `verification_status = 'not_verified'` with `verified_at`, `full_name` and `date_of_birth`
   cleared, in one transaction.
4. **Kept:** users and their `status`, sign-in sessions (refresh tokens), staff accounts and
   `admin_actions` (append-only; old rows now point at deleted attempts). A **banned** user stays
   banned: unban them with `POST /admin/users/:id/unban` (6. Admin in Postman) if needed.

It refuses to run unless `NODE_ENV` is exactly `development` and the database name doesn't end
in `_prod` (checked both in `DATABASE_URL` and on the connected database). A late Didit webhook
for a deleted session is ignored (`Ignored a Didit decision for unknown session …` in the log).

| Check | Expect |
| --- | --- |
| Approve one account, then a second one in the sandbox | the second ends `blocked` (V6) |
| `npm run dev:reset-verifications`, type `reset` | the counts it removed |
| `GET /verification/status` (any account) | `status: "not_verified"`, `retriesLeftToday: 3` |
| Verify another account | `approved` again |
| `NODE_ENV=test npm run dev:reset-verifications` | `Refusing to reset: NODE_ENV must be "development" …`, nothing deleted |

## Inspecting a Didit decision (no personal data)

`npm run didit:inspect -- --latest` (or `-- <attempt id>` / `-- <Didit session id>`) fetches the
decision from the Didit app in `.env` and prints only its shape: document type/subtype, country,
check statuses, warning codes, numbers as masks (`"999999999999" (12 chars)`), the age the date
of birth implies, and what our decision code would read (identifier kinds, problems). Safe to
paste into chat. Used for the real-document questions in T2.9 (`docs/didit-integration.md` §5).

## Useful while testing

- Look at the data: `docker compose exec postgres psql -U rental -d rental`, e.g.
  `SELECT phone, verification_status FROM users;`
  `SELECT outcome, provider_status, created_at FROM identity_verifications;`
- Start over: `TRUNCATE refresh_tokens, otp_codes, identity_hashes, identity_verifications,
  verification_webhook_events, banned_identities, users;` (dev database only)
- To test a banned account: `UPDATE users SET status = 'banned' WHERE phone = '+251911234567';`
  then any request with that user's token → 403 `ACCOUNT_UNAVAILABLE` (A6).
