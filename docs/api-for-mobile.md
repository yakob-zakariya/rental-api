# rental-api for the mobile app

The contract the Flutter app (`rental-app`) builds against, for Phase 1. Source of truth:
`docs/phase-1-spec.md` and the running API's Swagger at `/docs`. If this page and the API ever
disagree, the API wins — report it so this page gets fixed.

- **Base URL:** local `http://localhost:3000` (emulator: `http://10.0.2.2:3000`); on a real phone
  use the tunnel URL (e.g. `https://<your-domain>.ngrok-free.dev`), or the computer's LAN IP.
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
  "reasonCode": "PHOTO_UNCLEAR"
}
```
- `canRetry`: "Verify" would start or resume a session right now. Show the button only if true.
- `retriesLeftToday`: new sessions left in the rolling 24 hours (max 3).
- `canRequestManualReview`: show "Ask for a manual review" only if true.
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

## Health

`GET /health` (no token) → `200` when the API, database and Redis are up; `503` otherwise.
Useful for a "can't reach the server" check.

## Testing tips

- In development every SMS code is printed in the API's console (`[SMS] To +2519…: Your rental
  code is …`), so any Ethiopian-looking number works — use a different number per test account.
- The Postman collection (`docs/postman/`) shows every request with working bodies.
- The **sandbox** Didit app simulates verification (no real checks). Real documents are only
  checked by the **live** app (spec section 8 / task T2.9).
