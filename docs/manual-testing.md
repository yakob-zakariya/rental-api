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

## Walkthrough

| # | Request | Expect |
| --- | --- | --- |
| 1 | `GET /health` | 200, `database` and `redis` both `up` |
| 2 | `POST /auth/otp/request` `{ "phone": "0911234567" }` | 200 `{ "expiresInSeconds": 300 }`; terminal shows `[SMS] To +251911234567: Your rental code is …` |
| 3 | `POST /auth/otp/verify` `{ "phone": "0911234567", "code": "<code>", "deviceName": "laptop" }` | 200 `{ accessToken, refreshToken, accessTokenExpiresIn: 900 }` — copy both tokens |
| 4 | **Authorize** (top of Swagger) → paste the access token into **app** (not admin) | |
| 5 | `GET /me` | 200, your profile, `verificationStatus: "not_verified"` |
| 6 | `PATCH /me` `{ "preferredLanguage": "en" }` | 200, `preferredLanguage: "en"` |
| 7 | `PATCH /me` `{ "preferredLanguage": "en", "fullName": "x" }` | 400 `VALIDATION_FAILED` (V9) |
| 8 | `POST /verification/sessions` | 201 `{ verificationUrl, sessionToken }`; open the URL to see Didit's flow |
| 9 | `POST /verification/sessions` again (within 30 min) | 201, the same URL (V2 resume) |
| 9a | `GET /verification/status` | `status: "pending"`, `canRetry: true`, `retriesLeftToday: 2`, `canRequestManualReview: false` |
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
| Three Didit declines in 24 h (finish three flows that Didit declines; or seed them in the dev DB), then `GET /verification/status` | `canRetry: false`, `retriesLeftToday: 0`, `canRequestManualReview: true`, `reasonCode: "DOCUMENT_NOT_VERIFIED"` |
| Then `POST /verification/manual-review-request` | 200, `status: "manual_review"`; a second request → 409 `VERIFICATION_IN_REVIEW`; starting a session → 409 `VERIFICATION_IN_REVIEW` |
| `POST /verification/manual-review-request` below the limit | 409 `MANUAL_REVIEW_NOT_AVAILABLE` |

## Useful while testing

- Look at the data: `docker compose exec postgres psql -U rental -d rental`, e.g.
  `SELECT phone, verification_status FROM users;`
  `SELECT outcome, provider_status, created_at FROM identity_verifications;`
- Start over: `TRUNCATE refresh_tokens, otp_codes, identity_hashes, identity_verifications,
  verification_webhook_events, banned_identities, users;` (dev database only)
- To test a banned account: `UPDATE users SET status = 'banned' WHERE phone = '+251911234567';`
  then any request with that user's token → 403 `ACCOUNT_UNAVAILABLE` (A6).
