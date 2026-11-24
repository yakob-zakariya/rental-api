# Manual testing

A hands-on pass through the API with Swagger UI, as a real client would use it. The automated
tests use fakes for SMS and Didit; this is where the real wiring gets seen. Keep it up to date:
every new endpoint gets a step here.

## Setup

1. `docker compose up -d --wait` (Postgres, Redis and SeaweedFS, the local photo storage: S3 API
   on `localhost:8333`, with the two development buckets created on start). `.env` needs the
   `S3_…` and `PHOTO_…` lines from `.env.example` (the development keys match
   `docker/seaweedfs/s3.json`); without them the API refuses to start.
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
- **8. Listings:** uses the app token. **Create a full draft** saves `listingId` (and fills in
  `neighbourhoodId` from `GET /areas` first, so run **7. Areas → GET /areas** before it).
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

### Listing review (read: any staff role; reveal phone: moderator+)

Submit a listing first (app token, 3 photos), then with the admin token:

| Try | Expect |
| --- | --- |
| `GET /admin/listings` | the listings in review, oldest submission first, with a summary, `photoCount`, a signed `coverUrl` and `flags` |
| `… ?status=live` | live ones instead; `?status=draft` → 400 (drafts are never listed) |
| `GET /admin/listings/<id>` | everything: the exact `location` and `landmark`, photos (signed links), the lister's verified name and statuses, other listings, the history; **no phone number** |
| A listing whose description says `Telegram @AddisHomes` or `t.me/addishomes`, or `0911 23 45 67` | `flags`: `CONTACT_IN_TEXT` with `{ field: "description", kinds: ["telegram"] }` (or `phone`, `email`, `url`) |
| A lister with 3 listings in review, live or stale | `MANY_ACTIVE_LISTINGS`, `activeListings: 3` |
| "My neighbourhood isn't listed" (`unlistedNeighbourhoodName`) | `UNLISTED_NEIGHBOURHOOD` with the typed name |
| `POST /admin/listings/<id>/reveal-lister-phone { "note": "Calling to check" }` as moderator | 200 `{ phone }`; `GET /admin/actions` shows `listing.reveal_lister_phone` with the note (no number) |
| The same as support | 403 `INSUFFICIENT_ROLE` |
| The app token on `/admin/listings` | 401 |

**Decisions (moderator+).** Open the listing's detail first: approve and reject need its `version`.

| Try | Expect |
| --- | --- |
| `POST /admin/listings/<id>/approve { "version": <v> }` | 200, `live`; the photos open at their public URLs (`S3_PUBLIC_BASE_URL/<storage key>`, no credentials); the lister's `GET /me/listings` shows `live` |
| The lister edits the description, then approve with the old version | 409 `LISTING_CHANGED` with the new `version` |
| Approve twice, or approve then reject | 409 `ALREADY_DECIDED` |
| In psql: `UPDATE users SET status = 'banned' WHERE id = '<lister>';` then approve | 409 `LISTER_NOT_ELIGIBLE` |
| `POST /admin/listings/<id>/reject { "version": <v>, "reasonCode": "PHOTOS_UNCLEAR", "listerNote": "…", "note": "…" }` | 200, `rejected`; the lister sees `staffReasonCode` and `listerNote` (not the staff note) |
| Reject with `"reasonCode": "GUIDELINES"` and a `listerNote` | 400 `LISTER_NOTE_NOT_ALLOWED` |
| A live listing: `POST /admin/listings/<id>/takedown { "reasonCode": "GUIDELINES", "note": "…" }` | 200, `removed`; its public photo URLs now 404; the API log says what it would purge from the CDN |
| Take down a listing in review | 409 `LISTING_NOT_REVIEWABLE` |
| As support, any decision | 403 `INSUFFICIENT_ROLE` |
| `GET /admin/actions` | `listing.approve` / `listing.reject` / `listing.takedown` rows with the notes |

**Public photo clean-up (T4.4).** Runs hourly when `JOBS_ENABLED=true`, or now with
`npm run photos:reconcile` (prints a summary: checked, kept, removed, recent, foreign, errors).
To see it remove something: approve a listing (its photos open at their public URLs), then
bypass the normal unpublish in psql: `UPDATE listings SET status = 'expired', expired_at = now()
WHERE id = '<id>';`. **Wait 15 minutes** (copies younger than that are skipped on purpose), run the
command: `removed: 3`, the public URLs answer 404, and the log names each removed key. A file you
put in the public bucket outside `properties/` is counted as `foreign` and left alone.

## Listings: drafts (app token)

Signed in with the app token (verification isn't needed to draft, L1). A draft may be
half-filled; `missing` in every answer lists what still has to be filled in before submitting
(submitting comes in T2.3). Get a neighbourhood id from `GET /areas`.

| Try | Expect |
| --- | --- |
| `POST /listings` with `{}` | 201, `status: draft`, `version: 1`, `missing` lists all 15 required fields |
| `POST /listings` with every field (Postman: **Create a full draft**; `location` `{ "lat": 9.0102, "lng": 38.7606 }` is Meskel Square) | 201, `missing: []`; `property.subCity` and `property.neighbourhood` named in both languages; `approxLocation` is near, not equal to, `location` |
| `PATCH /listings/<id> { "monthlyRentBirr": 18000 }` | 200, `version` + 1 |
| The same PATCH again | 200, `version` unchanged (nothing changed) |
| `PATCH … { "sizeM2": null, "amenities": [] }` | both cleared; fields not sent are kept |
| `PATCH … { "bedrooms": 3 }`, then compare `approxLocation` | the same as before: it's only made again when the exact point moves |
| `PATCH … { "location": { "lat": 8.9792, "lng": 38.7966 } }` (the airport) | a new `approxLocation`, 200–400 m from the new point |
| `PATCH … {}` | 400 `NO_FIELDS_TO_UPDATE` |
| `location` at Burayu `{ "lat": 9.036, "lng": 38.6608 }` | 400 `LOCATION_OUTSIDE_SERVICE_AREA`; in psql, `SELECT * FROM out_of_area_demand;` shows `9.04, 38.66`, today's date, `refusals` 1 (send it again: 2) |
| `"bedrooms": 21` (or bathrooms 21, floor 61, `sizeM2` 5001, rent 2000001) | 400 `BEDROOMS_ABOVE_LIMIT` with `max: 20` (each field has its own code) |
| `"monthlyRentBirr": 1500.5` or `"1500"` | 400 `VALIDATION_FAILED` (whole birr only) |
| `"availableFrom"` yesterday | 400 `AVAILABLE_FROM_IN_PAST` |
| `"neighbourhoodId"` of a deactivated neighbourhood (deactivate one as staff first) | 400 `NEIGHBOURHOOD_INACTIVE` |
| `"status": "live"` in the body | 400 `VALIDATION_FAILED` (the status can't be set) |
| An 11th draft | 409 `DRAFT_LISTING_LIMIT`, `max: 10` |
| `GET /me/listings` | your listings, newest first, with the exact point and landmark (only you see them) |
| Someone else's listing id (sign in with a second phone) in PATCH or DELETE | 404 `LISTING_NOT_FOUND` |
| `DELETE /listings/<id>` | 204; gone from `GET /me/listings`, its property too |
| PATCH or DELETE a listing that isn't a draft (in psql: `UPDATE listings SET status = 'pending_review', …`) | 409 `INVALID_LISTING_STATE` |

**Photos (P1, P2, P4).** In Postman: **Create a full draft** (saves `listingPropertyId`), then
**Upload a photo** (pick the file in the Body tab). Try a photo from your phone with location on:

| Try | Expect |
| --- | --- |
| Upload a phone photo (JPEG) | 201; `property.photos` has it with a signed `url` (works for 15 minutes) and its stored size (at most 2048 px) |
| Open the `url`, save the file, and check it with `exiftool <file>` (or any EXIF viewer) | no GPS, no camera make or model, no date: only the image size and type |
| A portrait photo | stored upright |
| A GIF, a PDF, or a text file renamed to `.jpg` | 400 `PHOTO_TYPE_NOT_ALLOWED` |
| A file over 10 MB | 413 `PHOTO_TOO_LARGE` with `max` |
| A 13th photo | 409 `TOO_MANY_PHOTOS` |
| **Delete a photo** in a draft | 200; the later photos move up |
| **Reorder photos** with every id, reversed | 200, new order; the same order again: `version` unchanged |
| Reorder with one id missing | 400 `PHOTO_ORDER_MISMATCH` |
| With the listing live (psql: `UPDATE listings SET status = 'live', published_at = now() WHERE id = '<id>';`) upload or delete a photo | `status: pending_review` (back to review); reordering keeps it `live` |
| In review, live or stale with exactly 3 photos: delete one | 409 `NOT_ENOUGH_PHOTOS` |

**Submit and withdraw.** A submit needs 3 photos; upload them first.

| Try | Expect |
| --- | --- |
| `POST /listings/<id>/submit` as a user who isn't verified | 403 `VERIFICATION_REQUIRED` (checked first) |
| … verified (in psql: `UPDATE users SET verification_status = 'approved' WHERE phone = '+2519…';`), on an empty draft | 400 `LISTING_INCOMPLETE` with `missing` (the same list the draft shows) |
| … on a complete draft with fewer than 3 photos | 400 `NOT_ENOUGH_PHOTOS`, `min: 3` |
| … with 3 photos | 200, `status: pending_review` |
| `POST /listings/<id>/withdraw` on a draft | 409 `INVALID_LISTING_STATE` (only a listing in review can be withdrawn) |
| To try withdraw: in psql `UPDATE listings SET status = 'pending_review' WHERE id = '<id>';`, then withdraw | 200, `status: draft`; `SELECT * FROM listing_history WHERE listing_id = '<id>';` shows the change |
| Submit or withdraw someone else's listing | 404 `LISTING_NOT_FOUND` |

**Editing after submitting, and reopening (L5, L6).** Put a complete listing into a state with
psql first, e.g. live: `UPDATE listings SET status = 'live', published_at = now() WHERE id = '<id>';`
(expired: `status = 'expired'`). `SELECT event, old_status, new_status, old_monthly_rent_birr,
new_monthly_rent_birr FROM listing_history WHERE listing_id = '<id>' ORDER BY created_at;` shows
what was recorded.

| Try | Expect |
| --- | --- |
| Live: `PATCH { "monthlyRentBirr": 23000 }` | 200, still `live`; a `monthly_rent` history row (old and new rent) |
| Live: `PATCH { "negotiable": false }` | 200, still `live`; nothing recorded |
| Live: `PATCH { "description": "…" }` (or any other field, or the pin) | 200, `status: pending_review` (hidden until approved); a status history row |
| Live: `PATCH` with its own current values | 200, still `live`, `version` unchanged |
| In review: `PATCH { "bedrooms": 3 }` | 200, stays `pending_review`, `version` + 1 |
| Live or in review: `PATCH { "description": null }` | 400 `LISTING_INCOMPLETE`, `missing: ["description"]` |
| Rented or removed: any PATCH | 409 `INVALID_LISTING_STATE` |
| Expired: `PATCH { "bedrooms": 4 }` | 200, stays `expired`, `needsReview: true` |
| Expired, nothing that needs review changed: `POST /listings/<id>/reopen` (verified user) | 200 `live` (with 3 photos), `last_confirmed_at` set, `published_at` unchanged |
| Expired with `needsReview`, or never approved (`published_at` empty): reopen | 200 `pending_review` |
| In psql: `UPDATE listings SET status = 'pending_review' WHERE id = '<id>';` then `… SET status = 'expired' …` | `needs_review` becomes true by itself (database trigger) |
| Reopen a listing that isn't expired | 409 `INVALID_LISTING_STATE` |

**Closing and relisting (L11, L12).**

| Try | Expect |
| --- | --- |
| Live: `POST /listings/<id>/close { "reason": "rented_elsewhere" }` | 200, `status: rented`, `closeReason`, `closedAt`; a history row with the reason |
| `{ "reason": "no_longer_for_rent" }` | `status: removed` |
| `{ "reason": "rented_in_app" }` on a listing that was never published (`published_at` empty) | 400 `RENTED_IN_APP_NEVER_PUBLISHED` |
| `{ "reason": "staff_takedown" }` | 400 `VALIDATION_FAILED` (staff only) |
| Close a draft, or a closed listing | 409 `INVALID_LISTING_STATE` |
| `POST /properties/<property.id>/listings` after closing | 201, a new draft with rent, advance months and negotiable copied (available-from only if not past); the old listing stays in `GET /me/listings` |
| Relist while the property has a draft, live, in-review, expired or rejected listing | 409 `PROPERTY_HAS_OPEN_LISTING` with that `listingId` |
| Relist someone else's property | 404 `PROPERTY_NOT_FOUND` |

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
