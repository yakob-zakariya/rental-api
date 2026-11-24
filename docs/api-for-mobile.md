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
| `INVALID_LISTING_STATE` | 409 | listing edit / delete / submit / withdraw / reopen / close | The listing moved on (for example it was already submitted, or staff decided): refresh "My listings" |
| `VERIFICATION_REQUIRED` | 403 | submit | Start identity verification first ("Verify your ID to publish"), then submit again |
| `LISTING_INCOMPLETE` | 400 | submit, reopen, edit | Fields still empty (or an edit that would empty them after submitting): `missing` lists them; jump to the first |
| `NOT_ENOUGH_PHOTOS` | 400 / 409 | submit, reopen (400); photo delete (409) | "Add at least `min` photos" / "A listing in review or live needs at least `min` photos: add one before deleting" |
| `RENTED_IN_APP_NEVER_PUBLISHED` | 400 | close | Don't offer "Rented through the app" for a listing that was never live (`publishedAt` empty) |
| `PROPERTY_HAS_OPEN_LISTING` | 409 | relist | The home already has a listing that isn't closed (`listingId`): open that one instead (fix and resubmit a rejected one, or close it) |
| `PROPERTY_NOT_FOUND` | 404 | relist | Gone: refresh "My listings" |
| `PHOTO_REQUIRED` | 400 | photo upload | A bug in the app's request (no `photo` part): log it |
| `PHOTO_UPLOAD_INVALID` | 400 | photo upload | A bug in the app's request (another field name, or more than one file): log it |
| `PHOTO_TYPE_NOT_ALLOWED` | 400 | photo upload | "Only JPEG, PNG or WebP photos" |
| `PHOTO_TOO_MANY_PIXELS` | 400 | photo upload | The app didn't resize first (see "Photos"): resize and retry |
| `PHOTO_UNREADABLE` | 400 | photo upload | "This photo couldn't be read; try another" |
| `PHOTO_TOO_LARGE` | 413 | photo upload | Over `max` bytes: the app should have compressed it first; compress and retry |
| `TOO_MANY_PHOTOS` | 409 | photo upload | "At most `max` photos" |
| `PHOTO_NOT_FOUND` | 404 | photo delete | Gone (deleted on another device): refresh |
| `PHOTO_ORDER_MISMATCH` | 400 | photo reorder | The list changed meanwhile: refresh and reorder again |
| `ACTIVE_LISTING_LIMIT` | 409 | submit | "You already have `max` listings in review or live: close one first" |

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

Signed in (app token). **No verification is needed to make a draft**; it's needed to submit. A draft can be saved half-filled, so the app can save the form step by step.
Photos are uploaded to the listing's property (see "Photos" below), so create the draft first.

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

**A tip on the form, near the description** (decided 2026-11-24): *"Tenants contact you through
the app. Don't put your phone number, Telegram or links in the description."* Show it as a
general tip only, always the same. **The app must not check the text as the lister types, or
tell them what was found**: staff see such details on review, and a live check would only teach
people how to hide them.

### `POST /listings`

Body: any of the fields above (`{}` is fine). → `201` with the listing (below). Errors:
`VALIDATION_FAILED`, the `…_ABOVE_LIMIT` codes, `AVAILABLE_FROM_IN_PAST`,
`LOCATION_OUTSIDE_SERVICE_AREA`, `NEIGHBOURHOOD_NOT_FOUND`, `NEIGHBOURHOOD_INACTIVE`,
`DRAFT_LISTING_LIMIT` (at most 10 drafts at once, with `max`).

### `PATCH /listings/:id`

Body: the fields to change. → `200` with the listing. **Always read `status` from the answer**:
an edit can move a live listing back to review. What an edit does depends on the state:

| Status | An edit… |
| --- | --- |
| `draft`, `rejected` | applies; fields may be cleared in a draft only |
| `pending_review` | applies; it stays in review |
| `live`, `stale` | `monthlyRentBirr`, `availableFrom`, `negotiable`: apply at once, it stays live. **Any other field (including the pin, and adding or deleting a photo; reordering photos doesn't count): the listing goes back to `pending_review` and is hidden until staff approve it again** |
| `expired` | applies; a field that needs review sets `needsReview` (reopening then goes to review) |
| `rented`, `removed` | refused (`409 INVALID_LISTING_STATE`): relist instead |

- Before saving a change to a live listing that needs review, **warn the lister**: "Changing
  this sends your listing back for review. It will be hidden until it's approved." Rent,
  available-from and negotiable don't need the warning.
- Outside a draft, a required field can't be emptied: `400 LISTING_INCOMPLETE` with `missing`.
- Sending values that are already there changes nothing (no review, no new `version`).

Errors: as POST, plus `NO_FIELDS_TO_UPDATE`, `LISTING_INCOMPLETE`, `LISTING_NOT_FOUND`,
`INVALID_LISTING_STATE`.

### `DELETE /listings/:id`

→ `204`. Only drafts. Errors: `LISTING_NOT_FOUND`, `INVALID_LISTING_STATE`.

### `POST /listings/:id/submit`

No body. Sends a draft, or a rejected listing you've fixed, to staff review. → `200` with the
listing, now `status: "pending_review"` (hidden from everyone else until staff approve it). The
checks, in this order:

1. verified identity, else `403 VERIFICATION_REQUIRED`;
2. nothing `missing`, else `400 LISTING_INCOMPLETE` with `missing`;
3. at least 3 photos, else `400 NOT_ENOUGH_PHOTOS` with `min`;
4. fewer than 10 listings already in review, live or stale, else `409 ACTIVE_LISTING_LIMIT` with
   `max`.

Other states: `409 INVALID_LISTING_STATE`. An available-from date that has passed since it was set doesn't block
submitting: show a past date as "Available now".

A rejected listing keeps `staffReasonCode` and `listerNote` (the last decision) after it's
resubmitted; show them only while `status` is `rejected`.

### Staff decisions, as the lister sees them

- **Approved:** `status: "live"`, `publishedAt` set. The listing is public, and so are its photos.
- **Rejected:** `status: "rejected"`, with `staffReasonCode` and maybe `listerNote` (staff's note
  to the lister, at most 300 characters). Show the reason in the app's words and the note as it
  is; the lister fixes the listing and submits again.
- **Taken down by staff:** `status: "removed"` with `closeReason: "staff_takedown"`, a
  `staffReasonCode` and maybe a `listerNote`. It can't be edited or reopened; the lister may
  relist the home.

Reason codes and suggested texts:

| `staffReasonCode` | Show |
| --- | --- |
| `PHOTOS_UNCLEAR` | "The photos are too dark or unclear" |
| `PHOTOS_DONT_MATCH` | "The photos don't match the description" |
| `WRONG_LOCATION` | "The location looks wrong" |
| `MISSING_INFORMATION` | "Some information is missing" |
| `DUPLICATE_LISTING` | "This home is already listed" |
| `GUIDELINES` | "This listing didn't meet our guidelines" (nothing more: there is never a note with it) |

### `POST /listings/:id/withdraw`

No body. Takes a listing in review back to `draft` (to fix something before staff look at it).
→ `200` with the listing. Not in review: `409 INVALID_LISTING_STATE`.

### `POST /listings/:id/reopen`

No body. For an `expired` listing ("Is this still available? Confirm the details to reopen it").
→ `200` with the listing: `live` again, or `pending_review` if `needsReview` was set or it was
never approved. Show which before they confirm: `needsReview: true` → "It will be reviewed again
before it's live". The same checks as submit (`VERIFICATION_REQUIRED`, `NOT_ENOUGH_PHOTOS`,
`ACTIVE_LISTING_LIMIT`…); not expired: `409 INVALID_LISTING_STATE`.

### `POST /listings/:id/close`

Body: `{ "reason": "rented_in_app" | "rented_elsewhere" | "no_longer_for_rent" }`. → `200` with
the listing: `rented` (the first two) or `removed`, with `closeReason` and `closedAt`. Ask why
when the lister closes ("Rented through the app", "Rented elsewhere", "No longer for rent").

- Offer **"Rented through the app" only if `publishedAt` is set**; otherwise the API answers
  `400 RENTED_IN_APP_NEVER_PUBLISHED`.
- From any state except a draft (delete it) or one already closed (`409 INVALID_LISTING_STATE`).
- A closed listing can't be edited, submitted or reopened: relist it.

### `POST /properties/:id/listings` (relist)

No body; `:id` is the listing's `property.id`. For a home whose listings are all rented or
removed ("List it again"). → `201` with a new draft on the same home: the home's details and
photos are the same ones; rent, advance months and negotiable are copied from the last listing,
available-from only if it isn't past (otherwise it shows in `missing`). The old listing stays in
"My listings". Then edit and submit it as usual (it's reviewed again).

Errors: `409 PROPERTY_HAS_OPEN_LISTING` (with `listingId`: open that listing instead; a
rejected one must be fixed and resubmitted, or closed, first), `409 DRAFT_LISTING_LIMIT`,
`404 PROPERTY_NOT_FOUND`.

Editing the home's details in the new draft changes them for the old listings too (they share
the home).

### Photos

A listing's photos belong to its property: `property.id` in the listing. 3 to 12 photos; the
first is the cover.

**Before uploading, the app resizes and compresses every photo** (decided 2026-11-24), to save
the lister's mobile data: at most **2048 px** on the longest side, as **JPEG, quality about 80**.
A 12 MP phone photo goes from about 4 MB to about 400 KB. The server re-encodes every photo
anyway and removes all metadata, GPS included, so the app doesn't need to strip anything; but
**don't send the original file**: it's slower and costs the user data. Upload one photo per
request, and show progress per photo.

#### `POST /properties/:id/photos`

`multipart/form-data` with one file in the field **`photo`** (JPEG, PNG or WebP; at most 10 MB and
50 megapixels). → `201` with the listing; the new photo is last in `property.photos`. On a
`live` or `stale` listing the listing goes back to review (warn before uploading, as for other
edits); on an `expired` one, `needsReview` is set.

#### `DELETE /properties/:id/photos/:photoId`

→ `200` with the listing; the photos after it move up. In review, live or stale, a listing keeps
at least 3: deleting the third-last is `409 NOT_ENOUGH_PHOTOS` (add the new photo first, then
delete the old one). Live or stale: back to review.

#### `PUT /properties/:id/photos/order`

Body: `{ "photoIds": ["…", "…"] }`, every photo of the property once, in the new order. → `200`
with the listing. Applies at once, even on a live listing (no review). A list that isn't
exactly the photos: `400 PHOTO_ORDER_MISMATCH`.

#### In the listing

`property.photos`: `[{ "id", "position", "width", "height", "url" }]`, in order. `url` is a
**signed link valid for 15 minutes**: show it right away, don't store it; fetch the listing again
for fresh links (an expired link answers 403).

Photos of a rented or removed listing can't change (`409 INVALID_LISTING_STATE`): relist first.

### `GET /me/listings`

→ `200` with all of your listings in every state, newest first (no paging: a lister has only a
few).

### The listing (your own view)

```json
{
  "id": "…", "status": "draft", "version": 3,
  "missing": ["landmark", "availableFrom"],
  "monthlyRentBirr": 25000, "advanceMonths": 2, "negotiable": true, "availableFrom": null,
  "closeReason": null, "staffReasonCode": null, "listerNote": null, "needsReview": false,
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
    "landmark": null, "listerRelation": "owner",
    "photos": [
      { "id": "…", "position": 0, "width": 2048, "height": 1536, "url": "https://…(signed, 15 min)" }
    ]
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
- **`needsReview`** (expired listings): reopening will send it to review instead of straight
  back to live.
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
