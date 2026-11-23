# rental-api for the mobile app

The contract the Flutter app (`rental-app`) builds against, for Phases 1 and 2 (so far). Source
of truth: `docs/phase-1-spec.md`, `docs/phase-2-spec.md` and the running API's Swagger at `/docs`. If this page and the API ever
disagree, the API wins — report it so this page gets fixed.

- **Base URL (development, physical phone):** connect the phone by USB, run
  `adb reverse tcp:3000 tcp:3000` on the computer (again after each reconnect), then use
  `http://localhost:3000` on the phone. Wireless alternative: the ngrok tunnel URL
  (e.g. `https://<your-domain>.ngrok-free.dev`).
- **Format:** JSON in and out (`Content-Type: application/json`). Unknown fields in a body are
  rejected (`400 VALIDATION_FAILED`).
- **Times:** ISO 8601 in UTC (`2026-10-31T09:12:33.123Z`); show them in Africa/Addis_Ababa.
  Dates of birth are plain `YYYY-MM-DD` strings — never parse them into a `DateTime` with a time
  zone.
- Staff (`/admin/...`) and webhook (`/webhooks/...`) routes are not for the app.

## Errors: always switch on `code`

Every error body has a stable `code`; never match on the HTTP message text.

```json
{ "code": "OTP_INVALID", "attemptsRemaining": 3 }
```

Validation errors also list the fields (values are never echoed back):

```json
{ "code": "VALIDATION_FAILED", "errors": [{ "field": "phone", "messages": ["phone must be a string"] }] }
```

| Code | Status | Where | What the app should do |
| --- | --- | --- | --- |
| `VALIDATION_FAILED` | 400 | any body | A bug in the app's request: log it |
| `INVALID_PHONE` | 400 | OTP request | "Enter an Ethiopian mobile number" |
| `OTP_INVALID` | 400 | OTP verify | Wrong code; show `attemptsRemaining` if present |
| `OTP_EXPIRED` | 400 | OTP verify | Code used or expired: offer "send a new code" |
| `OTP_ATTEMPTS_EXCEEDED` | 400 | OTP verify | 5 wrong tries: offer "send a new code" |
| `OTP_RATE_LIMITED` | 429 | OTP request | Wait `retryAfterSeconds` (3 codes per phone per 10 min) |
| `RATE_LIMITED` | 429 | anywhere | Too many requests from this IP: back off (`Retry-After` header) |
| `SMS_SEND_FAILED` | 503 | OTP request | "Couldn't send the SMS, try again" |
| `UNAUTHENTICATED` | 401 | protected routes | No/invalid token: go to sign-in |
| `ACCESS_TOKEN_EXPIRED` | 401 | protected routes | Refresh (below), then retry the request once |
| `INVALID_REFRESH_TOKEN` | 401 | refresh | Session is over: clear tokens, go to sign-in |
| `ACCOUNT_UNAVAILABLE` | 403 | sign-in, refresh, any protected route | Neutral "account unavailable, contact support" screen; never say why |
| `ALREADY_VERIFIED` | 409 | start verification | Already approved: show the approved state |
| `VERIFICATION_IN_REVIEW` | 409 | start verification, manual review | Show "in review" |
| `VERIFICATION_UNAVAILABLE` | 403 | start verification, manual review | Neutral "contact support" (the user is blocked; never explain) |
| `VERIFICATION_RETRY_LIMIT` | 429 | start verification | Out of tries for 24 h: show `retryAfterSeconds`; offer manual review if `manualReviewAvailable` |
| `VERIFICATION_PROVIDER_UNAVAILABLE` | 503 | start verification | "Try again in a moment" (`retryAfterSeconds` if present) |
| `MANUAL_REVIEW_NOT_AVAILABLE` | 409 | manual review | Refresh the status screen |
| `LOCATION_OUTSIDE_SERVICE_AREA` | 400 | listing create / edit | Friendly, not an error screen: **"We're only in Addis Ababa for now"**; let them move the pin |
| `BEDROOMS_ABOVE_LIMIT`, `BATHROOMS_ABOVE_LIMIT`, `FLOOR_ABOVE_LIMIT`, `SIZE_ABOVE_LIMIT`, `RENT_ABOVE_LIMIT` | 400 | listing create / edit | "At most `max`" on that field (the app's form should stop it first) |
| `AVAILABLE_FROM_IN_PAST` | 400 | listing create / edit | "Pick today or a later date" |
| `NEIGHBOURHOOD_INACTIVE` | 400 | listing create / edit | The neighbourhood was removed from the list: fetch `GET /areas` again and ask them to pick |
| `NEIGHBOURHOOD_NOT_FOUND` | 400 | listing create / edit | As above (a stale id) |
| `DRAFT_LISTING_LIMIT` | 409 | listing create | "You have `max` unfinished listings: finish or delete one first" |
| `NO_FIELDS_TO_UPDATE` | 400 | listing edit | A bug in the app's request (empty PATCH): log it |
| `LISTING_NOT_FOUND` | 404 | listing edit / delete | Gone (deleted on another device): refresh "My listings" |
| `INVALID_LISTING_STATE` | 409 | listing edit / delete | The listing moved on (for now only drafts can be edited or deleted): refresh "My listings" |

## Sign-in (phone + SMS code)

Only Ethiopian mobile numbers (`+2519…`, `+2517…`). The API accepts `09…`, `9…`, `07…`, `7…`,
`251…`, `+251…` and `00251…`, with spaces or dashes — send what the user typed; it normalises.

### `POST /auth/otp/request`
```json
{ "phone": "0911 234 567" }
```
→ `200 { "expiresInSeconds": 300 }` — the same whether or not the account exists. The 6-digit code
arrives by SMS (in development it's printed in the API's console). Errors: `INVALID_PHONE`,
`OTP_RATE_LIMITED`, `SMS_SEND_FAILED`, `RATE_LIMITED` (30 requests per IP per hour).

### `POST /auth/otp/verify`
```json
{ "phone": "0911 234 567", "code": "123456", "deviceName": "Samsung A14" }
```
`deviceName` is optional (≤ 100 characters). The first successful verify creates the account.

→ `200`
```json
{ "accessToken": "eyJ…", "refreshToken": "eyJ…", "accessTokenExpiresIn": 900 }
```
Errors: `OTP_INVALID` (+ `attemptsRemaining`), `OTP_EXPIRED`, `OTP_ATTEMPTS_EXCEEDED`,
`ACCOUNT_UNAVAILABLE`.

## Tokens

- **Access token:** 15 minutes. Send it as `Authorization: Bearer <accessToken>` on every
  protected route.
- **Refresh token:** 30 days. Store **both** in secure storage (Keychain / Keystore), never in
  plain preferences or logs.

### `POST /auth/refresh`
```json
{ "refreshToken": "eyJ…" }
```
→ `200` with a **new pair** (same shape as verify). The old refresh token is now revoked: always
replace both stored tokens.

**Refresh rules the app must follow:**
1. **Refresh on `401 ACCESS_TOKEN_EXPIRED` only** (not on every 401), then retry the original
   request once. `401 UNAUTHENTICATED` / `INVALID_REFRESH_TOKEN` → sign-in screen.
2. **Queue refreshes: never send two at once with the same refresh token.** If several requests
   hit `ACCESS_TOKEN_EXPIRED` together, one refresh runs and the others wait for its result.
   Reusing an already-rotated refresh token logs the user out on **all** devices (theft
   protection). There is a 60-second grace for a lost response (retrying the old token after a
   dropped connection works once), but it is a safety net, not something to rely on.
3. `403 ACCOUNT_UNAVAILABLE` on refresh → neutral "account unavailable" screen.

### `POST /auth/logout`
```json
{ "refreshToken": "eyJ…" }
```
→ `204` always. Then delete both tokens locally.

## The signed-in user

### `GET /me`
→ `200`
```json
{
  "id": "9a1f0905-…",
  "phone": "+251911234567",
  "fullName": null,
  "dateOfBirth": null,
  "preferredLanguage": "am",
  "verificationStatus": "not_verified",
  "verifiedAt": null,
  "createdAt": "2026-10-31T09:12:33.123Z"
}
```
`fullName` and `dateOfBirth` come from identity verification and can't be edited by the user.

### `PATCH /me`
```json
{ "preferredLanguage": "en" }
```
`am`, `om` or `en` — the **only** editable field. Anything else (e.g. `fullName`) → `400
VALIDATION_FAILED`. → `200` with the updated profile.

## Identity verification

### The flow
1. Show the status screen from `GET /verification/status`.
2. When the user taps "Verify my identity": `POST /verification/sessions` → `{ verificationUrl,
   sessionToken }`.
3. Start Didit's Flutter SDK (`didit_sdk`, `flutter pub add didit_sdk`) with **`sessionToken`**
   (never an API key — the app has none). Fallback: open `verificationUrl` in the browser.
4. When the SDK returns, **don't trust its result**: the decision reaches the API by webhook (or
   polling, within ~15 minutes). Show "checking…" and poll `GET /verification/status` (e.g. every
   5 s for the first minute, then every 30 s), and again whenever the app returns to the foreground.

### `GET /verification/status`
→ `200`
```json
{
  "status": "declined",
  "canRetry": true,
  "retriesLeftToday": 2,
  "canRequestManualReview": false,
  "retryAvailableAt": null,
  "reasonCode": "PHOTO_UNCLEAR"
}
```
- `canRetry`: "Verify" would start or resume a session right now. Show the button only if true.
- `retriesLeftToday`: new sessions left in the rolling 24 hours (max 3).
- `canRequestManualReview`: show "Ask for a manual review" only if true.
- `retryAvailableAt`: ISO UTC timestamp or `null` — always present. Set **only** when the user is
  out of tries (3 sessions in the rolling 24 hours, nothing to resume): the moment a new session
  can start. Show it in Africa/Addis_Ababa ("You can try again after 14:30"), offering manual
  review alongside if `canRequestManualReview`. When that moment passes, re-fetch the status
  rather than assuming `canRetry` changed. `null` otherwise (including `approved`,
  `manual_review` and `blocked`).
- `reasonCode`: only when `status` is `declined`.

| `status` | Screen |
| --- | --- |
| `not_verified` | Intro + "Verify my identity" |
| `pending` | "Checking your identity…" (+ "Continue verification" if `canRetry`: it resumes the same session) |
| `approved` | Verified ✓ (name and date of birth from `GET /me`) |
| `declined` | Why (`reasonCode`, below) + "Try again" if `canRetry` + manual review if offered |
| `manual_review` | "Our team is reviewing your documents" |
| `blocked` | Neutral "Please contact support" — **never** show a reason |

| `reasonCode` | Message idea |
| --- | --- |
| `PHOTO_UNCLEAR` | The photo wasn't clear enough; retake it in good light |
| `DOCUMENT_EXPIRED` | The document has expired |
| `DOCUMENT_NOT_ACCEPTED` | Use your Fayda ID card or a passport |
| `UNDERAGE` | You must be 18 or older |
| `DOCUMENT_NOT_VERIFIED` | We couldn't verify your document; try again |

Accepted documents: the **Fayda** national ID card and **passports** only.

### `POST /verification/sessions`
No body. → `201 { "verificationUrl": "https://verify.didit.me/…", "sessionToken": "…" }`.
Calling it again while a session is open returns the **same** session (it doesn't use a retry).
Errors: `ALREADY_VERIFIED`, `VERIFICATION_IN_REVIEW`, `VERIFICATION_UNAVAILABLE`,
`VERIFICATION_RETRY_LIMIT` (`manualReviewAvailable`, `retryAfterSeconds`),
`VERIFICATION_PROVIDER_UNAVAILABLE`. The `sessionToken` is a secret: don't log it.

### `POST /verification/manual-review-request`
No body. → `200` with the new status (`manual_review`). Only works when `canRequestManualReview`
was true. Errors: `MANUAL_REVIEW_NOT_AVAILABLE`, `VERIFICATION_IN_REVIEW`, `ALREADY_VERIFIED`,
`VERIFICATION_UNAVAILABLE`.

## Areas (sub-cities and neighbourhoods)

### `GET /areas`

No token. → `200` with Addis Ababa's 11 sub-cities, each with its **active** neighbourhoods, in
English and Amharic, both sorted by English name:

```json
[
  {
    "id": "…", "nameEn": "Arada", "nameAm": "አራዳ",
    "neighbourhoods": [
      { "id": "…", "nameEn": "Arat Kilo", "nameAm": "አራት ኪሎ" },
      { "id": "…", "nameEn": "Piassa", "nameAm": "ፒያሳ" }
    ]
  }
]
```

- Use it for the sub-city → neighbourhood picker and the browse filters. Show `nameAm` when the
  app is in Amharic, `nameEn` otherwise (also for Afaan Oromo, until it's added), and re-sort
  for Amharic if you want Amharic alphabetical order.
- A sub-city can come back with an empty `neighbourhoods` list.
- Staff can add, rename and deactivate neighbourhoods at any time, so fetch the list fresh (for
  example once per app start) rather than shipping a copy in the app. A deactivated one
  disappears from this list, but a listing that already uses it keeps it.

## Listings: drafts (the lister)

Signed in (app token). **No verification is needed to make a draft**; it's needed to submit
(coming next). A draft can be saved half-filled, so the app can save the form step by step.
Photos come in a later step: they're uploaded to a draft, so create the draft first.

### Fields (`POST /listings` and `PATCH /listings/:id`)

Every field is optional in both. In a PATCH, a field you don't send is left as it is, and `null`
clears it (for amenities, send `[]`).

| Field | Type | Notes |
| --- | --- | --- |
| `neighbourhoodId` | uuid | From `GET /areas`. If the real one isn't listed, the nearest one… |
| `unlistedNeighbourhoodName` | string, 1–100 | …plus the real name ("my neighbourhood isn't listed"). Optional; never shown publicly |
| `type` | `condominium`, `apartment`, `villa_house`, `compound_room`, `studio` | |
| `bedrooms` | int 0–20 | |
| `bathrooms` | int 0–20 | **0 = shared bathroom**: show "Shared bathroom" |
| `furnished`, `separateWaterMeter`, `separateElectricityMeter` | boolean | `null` = not answered yet (don't show it as "No") |
| `sizeM2` | int 1–5000 | optional, even to submit |
| `floor` | int 0–60 | 0 = ground floor; optional, even to submit |
| `amenities` | array of `parking`, `gated_compound`, `guard` | no duplicates; `[]` = none; optional |
| `description` | string, 1–2000 | |
| `location` | `{ "lat": 9.0102, "lng": 38.7606 }` | the exact point (GPS or pin), **latitude first**; must be inside Addis Ababa |
| `landmark` | string, 1–200 | e.g. "Blue gate behind the pharmacy"; private like the exact point |
| `listerRelation` | `owner`, `representative` | shown on the listing |
| `monthlyRentBirr` | int 1–2,000,000 | whole birr only (no decimals, not a string) |
| `advanceMonths` | int 1–12 | |
| `negotiable` | boolean | |
| `availableFrom` | `YYYY-MM-DD` | today (Addis Ababa) or later |

Text is trimmed. Lengths count characters the way the server does (an emoji counts as one). The
status, version and ids can't be sent: they're rejected as unknown fields.

### `POST /listings`

Body: any of the fields above (`{}` is fine). → `201` with the listing (below). Errors:
`VALIDATION_FAILED`, the `…_ABOVE_LIMIT` codes, `AVAILABLE_FROM_IN_PAST`,
`LOCATION_OUTSIDE_SERVICE_AREA`, `NEIGHBOURHOOD_NOT_FOUND`, `NEIGHBOURHOOD_INACTIVE`,
`DRAFT_LISTING_LIMIT` (at most 10 drafts at once, with `max`).

### `PATCH /listings/:id`

Body: the fields to change. → `200` with the listing. Only drafts for now (other states come
with submitting and editing after review). Errors: as POST, plus `NO_FIELDS_TO_UPDATE`,
`LISTING_NOT_FOUND`, `INVALID_LISTING_STATE`.

### `DELETE /listings/:id`

→ `204`. Only drafts. Errors: `LISTING_NOT_FOUND`, `INVALID_LISTING_STATE`.

### `GET /me/listings`

→ `200` with all of your listings in every state, newest first (no paging: a lister has only a
few).

### The listing (your own view)

```json
{
  "id": "…", "status": "draft", "version": 3,
  "missing": ["landmark", "availableFrom"],
  "monthlyRentBirr": 25000, "advanceMonths": 2, "negotiable": true, "availableFrom": null,
  "closeReason": null, "staffReasonCode": null, "listerNote": null,
  "property": {
    "id": "…",
    "subCity": { "id": "…", "nameEn": "Bole", "nameAm": "ቦሌ" },
    "neighbourhood": { "id": "…", "nameEn": "Gerji", "nameAm": "ገርጂ", "active": true },
    "unlistedNeighbourhoodName": null,
    "type": "apartment", "bedrooms": 2, "bathrooms": 1, "furnished": false,
    "separateWaterMeter": true, "separateElectricityMeter": false,
    "sizeM2": 85, "floor": 3, "amenities": ["parking", "guard"],
    "description": "…",
    "location": { "lat": 9.0102, "lng": 38.7606 },
    "approxLocation": { "lat": 9.0121, "lng": 38.7631 },
    "landmark": null, "listerRelation": "owner"
  },
  "createdAt": "…", "updatedAt": "…", "submittedAt": null, "publishedAt": null, "closedAt": null
}
```

- **`missing`**: the fields still needed before submitting, in form order. Use it for "2 things
  left" and to jump to the first one. Photos are counted separately.
- **`location`, `landmark`, `unlistedNeighbourhoodName`** are private: only you (and staff) get
  them. **`approxLocation`** is what the public will see: the exact point moved 200–400 m in a
  random direction. Show the public view as a circle around it, never as a pin on the house. It
  changes only when the exact point moves.
- **`neighbourhood.active: false`**: staff removed it from the list. The listing keeps it, but it
  can't be picked again.
- **`version`** goes up on every real change (sending the same values again doesn't count).
- Amenities come back in a fixed order (`parking`, `gated_compound`, `guard`).

### A pin outside Addis Ababa

`400 LOCATION_OUTSIDE_SERVICE_AREA`: show a friendly message, **"We're only in Addis Ababa for
now"**, and let them move the pin. Nothing is saved. The server counts refused pins by area
(rounded to about 1 km, with no link to the user) to see where people want the service next.

## Health

`GET /health` (no token) → `200` when the API, database and Redis are up; `503` otherwise.
Useful for a "can't reach the server" check.

## Testing tips

- In development every SMS code is printed in the API's console (`[SMS] To +2519…: Your rental
  code is …`), so any Ethiopian-looking number works — use a different number per test account.
- The Postman collection (`docs/postman/`) shows every request with working bodies.
- The **sandbox** Didit app simulates verification (no real checks). Real documents are only
  checked by the **live** app (spec section 8 / task T2.9).
