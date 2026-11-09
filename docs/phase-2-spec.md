# Phase 2 spec — Listings

**Status:** final, 2026-11-09. Open questions P2-1–P2-15 and T-1–T-4 are answered (section 12).
The four follow-up defaults and the missing-neighbourhood case were settled the same day (section
12, "Follow-ups").

**Goal:** a verified landlord in Addis Ababa creates a listing with photos and a location; staff
review it on a small web page; once approved, anyone can find it by area, price or "near me",
and it stays fresh through weekly "still available?" push notifications.

**Done when:** you create a listing on your phone with real photos, approve it on the review
page, find it in the app without an account, receive the weekly check as a push notification,
and see it go stale and come back — and every rule below has a passing test.

**Out of scope (later phases):** contact requests and the contact quota, accepting a request,
revealing the phone number, exact location or landmark to tenants, chat, viewing feedback,
`rentals` rows (picking the tenant), reports, strikes, camera-only photos, "New lister"
probation, the Next.js web admin, public web pages, Telegram, saved searches, favourites, other
cities, non-residential properties, payments.

---

## 1. What Phase 2 adds

| Module | What |
| --- | --- |
| `areas` | Addis Ababa's 11 sub-cities and their neighbourhoods; `GET /areas`; staff add neighbourhoods |
| `listings` | Properties, listings, the state machine, the landlord's endpoints, public browse and search |
| `photos` | Upload, re-encoding (metadata stripped), perceptual hashing, S3-compatible storage |
| `freshness` | The weekly check job, stale and expired transitions |
| `push` | `PushSender` interface (console in development, FCM in production), device tokens |
| `admin` | Listing review queue, approve / reject / take down, the review web page |

Existing pieces reused: `JwtAuthGuard` + `ActiveAccountGuard` (app routes), `@Public()`
(browse), `VerifiedGuard` (submitting), admin guards and `@Roles()` (S2, S3), `admin_actions`
(S1), the ban (S5), `@nestjs/schedule` jobs and `JOBS_ENABLED` (as the verification polling job).

## 2. Data model

### `sub_cities`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| city | varchar | `Addis Ababa` only at launch |
| name_en, name_am | varchar | |
| created_at, updated_at | timestamptz | |

Seeded with the 11 sub-cities. Unique (`city`, `name_en`).

### `neighbourhoods`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| sub_city_id | uuid FK → sub_cities | |
| name_en, name_am | varchar | |
| created_by_admin_id | uuid FK → admin_users, null | null for the seeded ones |
| deactivated_at | timestamptz null | null = active; set by staff (G8) |
| created_at, updated_at | timestamptz | |

Seeded from `docs/addis-ababa-neighbourhoods.md` (reviewed 2026-11-09, seeded as it is: mostly
correct, not complete). Unique (`sub_city_id`, `lower(name_en)`), deactivated rows included, so
a deactivated name is reactivated rather than added again. **Never hard-deleted** (G8).

### `service_area`
One row: the Addis Ababa city boundary as `geography(MultiPolygon, 4326)`, loaded by a migration
(source: section 5, G1).

### `properties` — the physical home
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| lister_id | uuid FK → users | |
| neighbourhood_id | uuid FK → neighbourhoods | required (the sub-city follows from it); the nearest one if the real one isn't listed (G1) |
| unlisted_neighbourhood_name | varchar(100) null | the real name, typed by the lister when it isn't in our list (G1); never public |
| type | enum `condominium`, `apartment`, `villa_house`, `compound_room`, `studio` | residential only |
| bedrooms | int | ≥ 0 |
| bathrooms | int | ≥ 0; 0 = shared bathroom (the app shows "Shared bathroom") |
| furnished | boolean | |
| separate_water_meter | boolean | |
| separate_electricity_meter | boolean | |
| size_m2 | int null | optional, > 0 |
| floor | int null | optional, ≥ 0 (0 = ground floor) |
| amenities | enum array (`parking`, `gated_compound`, `guard`) | fixed list, no duplicates |
| description | text | 1–2000 characters |
| location | geography(Point, 4326) | exact; see G3 for who can see it |
| approx_location | geography(Point, 4326) | shifted 200–400 m (G2) |
| landmark | varchar(200) | private, like `location` (G3) |
| lister_relation | enum `owner`, `representative` | shown on the listing (overview §4) |
| created_at, updated_at | timestamptz | |

GiST index on `approx_location` (search). `location` is never searched.

### `property_photos`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| property_id | uuid FK → properties | |
| storage_key | varchar | the re-encoded file in object storage (P1) |
| phash | varchar(16) | 64-bit perceptual hash, hex (P3) |
| width, height, bytes | int | of the stored file |
| position | int | display order, unique per property |
| created_at | timestamptz | |

No capture time or capture GPS: camera-only photos are not at launch, and P2 strips metadata.

### `listings` — one period of availability
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| property_id | uuid FK → properties | |
| monthly_rent_birr | int | > 0 (hard rule 6) |
| advance_months | int | 1–12 |
| negotiable | boolean | |
| available_from | date | |
| status | enum `draft`, `pending_review`, `live`, `stale`, `expired`, `rented`, `removed`, `rejected` | |
| close_reason | enum `rented_in_app`, `rented_elsewhere`, `no_longer_for_rent`, `staff_takedown`, null | set when the listing is closed (L12) |
| staff_reason_code | enum, null | the last rejection or takedown reason (R4) |
| lister_note | varchar(300) null | staff's note to the lister with that decision (R4) |
| needs_review | boolean | an `expired` listing changed in a way that needs review (L6) |
| submitted_at, published_at, last_confirmed_at, stale_at, expired_at, closed_at | timestamptz null | |
| reviewed_by_admin_id | uuid FK → admin_users, null | |
| created_at, updated_at | timestamptz | |

`staff_reason_code` values: `PHOTOS_UNCLEAR`, `PHOTOS_DONT_MATCH`, `WRONG_LOCATION`,
`MISSING_INFORMATION`, `DUPLICATE_LISTING`, `GUIDELINES` ("didn't meet our guidelines").

Partial unique index: at most one listing per property in `draft`, `pending_review`, `live`,
`stale` or `expired` (L10).

### `listing_history` — every transition and every price / date change (overview §6)
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| listing_id | uuid FK → listings | |
| event | enum `status`, `monthly_rent`, `available_from` | |
| old_status, new_status | enum (as `listings.status`) null | `event = status`; `old_status` null on creation |
| old_monthly_rent_birr, new_monthly_rent_birr | int null | `event = monthly_rent` |
| old_available_from, new_available_from | date null | `event = available_from` |
| close_reason, staff_reason_code | enum null | when the change closed, rejected or took down the listing |
| actor_type | enum `user`, `admin`, `system` | `system` = a scheduled job |
| actor_id | uuid null | user or admin id |
| created_at | timestamptz | |

Written in the same transaction as the change. Staff changes are also in `admin_actions` (S1).

### `availability_checks`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| listing_id | uuid FK → listings | |
| sent_at | timestamptz | when the check was created and the push attempted |
| responded_at | timestamptz null | |
| response | enum `available`, `not_available`, null | |
| push_result | enum `sent`, `no_device`, `failed` | for support; the 48 h window runs either way |

### `devices` — push tokens
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| user_id | uuid FK → users | |
| fcm_token | varchar unique | |
| platform | enum `android`, `ios` | |
| created_at, last_seen_at | timestamptz | |

### Changes to Phase 1 tables and code
- `admin_actions`: new action types `listing.approve`, `listing.reject`, `listing.takedown`,
  `neighbourhood.create`, `neighbourhood.update`, `neighbourhood.deactivate`,
  `neighbourhood.reactivate`; new target types `listing`, `neighbourhood`. The `details`
  allow-list gains `listerNote` and, for renames, `oldNameEn`, `newNameEn`, `oldNameAm`,
  `newNameAm` (all free text, so the S1 ID-number check applies).
- The ban (S5) also closes the user's open listings and deletes their devices (L8, N2).

## 3. Listings

### Endpoints (app)
- `POST /listings` — create a property and its first listing as a `draft` (L1).
- `PATCH /listings/:id` — edit your listing and its property (L5, L6).
- `DELETE /listings/:id` — delete a `draft` (never reviewed, so nothing is kept).
- `POST /properties/:id/photos` (multipart), `DELETE /properties/:id/photos/:photoId`,
  `PUT /properties/:id/photos/order` — photos of your property (section 4).
- `POST /listings/:id/submit` — `draft` or `rejected` → `pending_review` (L2).
- `POST /listings/:id/withdraw` — `pending_review` → `draft`.
- `POST /listings/:id/still-available { available, reason? }` — answer the weekly check (F2).
- `POST /listings/:id/restore` — `stale` → `live` (F4).
- `POST /listings/:id/reopen` — `expired` → `live` or `pending_review` (L6).
- `POST /listings/:id/close { reason }` — close with one of the three lister reasons (L12).
- `POST /properties/:id/listings` — relist: a new `draft` on the same property (L11).
- `GET /me/listings` — your listings with status, any pending check, and the last staff
  decision (`staff_reason_code`, `lister_note`).
- `GET /listings`, `GET /listings/:id` — public browse and detail (section 5).

### States and transitions (L9)

| From | To | Who | When |
| --- | --- | --- | --- |
| — | `draft` | lister | creates a listing or relists |
| `draft`, `rejected` | `pending_review` | lister | submits (L2) |
| `pending_review` | `draft` | lister | withdraws |
| `pending_review` | `live` | staff | approves (R4) |
| `pending_review` | `rejected` | staff | rejects (R4) |
| `live`, `stale` | `pending_review` | lister | edits a field that needs review (L5) |
| `live` | `stale` | system | no answer to a check in 48 h (F3) |
| `stale` | `live` | lister | restores (F4) |
| `stale` | `expired` | system | 30 days stale (F5) |
| `pending_review`, `live`, `stale` | `expired` | staff | the lister is banned (L8) |
| `expired` | `live` | lister | reopens with no change that needs review (L6) |
| `expired` | `pending_review` | lister | reopens after a change that needs review (L6) |
| `pending_review`, `live`, `stale`, `expired`, `rejected` | `rented` | lister | closes: rented in the app or elsewhere (L12) |
| `pending_review`, `live`, `stale`, `expired`, `rejected` | `removed` | lister | closes: no longer for rent (L12) |
| `live`, `stale` | `removed` | staff | takes it down (R5) |

Any other transition: 409 `INVALID_LISTING_STATE`. **Active** means `pending_review`, `live` or
`stale`.

### Rules
- **L1** Any signed-in, active user can create a draft (overview §3). Verification is not needed
  to draft (lazy verification, overview §5).
- **L2** Submitting (and any other move into an active state from a non-active one: reopen, L6)
  needs:
  - `verification_status = approved` (403 `VERIFICATION_REQUIRED`, as `VerifiedGuard`);
  - every required field filled (400 `LISTING_INCOMPLETE` with `missing: [...]`);
  - at least 3 photos (400 `NOT_ENOUGH_PHOTOS`);
  - fewer than `LISTING_MAX_ACTIVE_PER_USER` (default 10) active listings already (409
    `ACTIVE_LISTING_LIMIT`).
- **L3** Only the lister can change a listing or its property. Someone else's listing answers
  404 `LISTING_NOT_FOUND`, the same as a listing that doesn't exist.
- **L4** Every listing goes through staff review before it first goes live (decided
  2026-11-09), including relists (L11) and resubmitted rejected listings.
- **L5** Editing by state:
  - `draft`, `rejected`: any field, freely.
  - `pending_review`: any field; it stays in the queue. A reviewer's decision on an older version
    is refused (R2).
  - `live`, `stale`: changing **monthly rent**, **available-from** or **negotiable** applies at
    once; rent and available-from changes are written to `listing_history`. Changing **any other
    field** (photos, location, landmark, description, type, neighbourhood or unlisted
    neighbourhood name, bedrooms, bathrooms, furnished, meters, size, floor, amenities, advance
    months, relation) sends the listing back to `pending_review`, **hidden from browse until
    approved**.
  - `rented`, `removed`: no edits; relist instead (L11).
  - `expired`: see L6.
- **L6** An `expired` listing is reopened by the lister confirming its details. Edits to an
  expired listing are allowed; one that needs review under L5 sets `needs_review`. Reopening
  then goes to `pending_review` if `needs_review`, or straight back to `live` if not. Rent and
  available-from changes are recorded as in L5. Reopening checks L2 and counts as a confirmation
  (`last_confirmed_at`).
- **L7** The listing shows the lister's first name, the initial of their father's name and a
  verified badge (for example "Abebe K."), taken from the verified `full_name` (first word, and
  the first letter of the second word; one word only → that word). The full name is never
  public.
- **L8** Banning a user (S5) moves their `pending_review`, `live` and `stale` listings to
  `expired` in the same transaction (`listing_history` actor: the admin). Drafts stay drafts.
  Unban doesn't change listings, so they come back as `expired` and the lister must reopen them
  (L6). Browse and detail also show only listings of `active` listers.
- **L10** At most one open listing (`draft`, active or `expired`) per property: 409
  `PROPERTY_HAS_OPEN_LISTING`.
- **L11** Relisting creates a new listing on the same property after `rented` or `removed`, so
  history is kept (overview §6). It starts as a `draft` with the old listing's fields copied.
- **L12** Closing needs a reason: `rented_in_app` or `rented_elsewhere` → `rented`;
  `no_longer_for_rent` → `removed`. The reason is stored on the listing and in
  `listing_history`. ("Rented in the app" doesn't pick the tenant yet; that comes with contact
  requests in Phase 3.)
- **L13** Money fields are integers of birr; anything else is 400 (hard rule 6).
  `advance_months` is 1–12. `available_from` can't be in the past when it is set or changed.

## 4. Photos

- **P1** Accepted: JPEG, PNG, WebP, at most `PHOTO_MAX_BYTES` each, at most 12 per property
  (409 `TOO_MANY_PHOTOS`). Files go to S3-compatible object storage behind a `PhotoStorage`
  interface (MinIO in Docker Compose for development; the production provider is chosen before
  deploying, with Cloudflare R2 in the comparison).
- **P2** Every upload is **re-encoded** (resized to at most `PHOTO_MAX_DIMENSION` pixels, saved as
  JPEG) and **all metadata is removed**, including EXIF GPS. Only the re-encoded file is stored.
  Reason: listing photos are public, and a GPS tag would reveal the exact location, which stays
  hidden until a contact request is accepted (decided 2026-11-09).
- **P3** Each stored photo gets a 64-bit perceptual hash, compared with the photos of every
  property **of other listers**. A Hamming distance ≤ `PHOTO_HASH_MAX_DISTANCE` is a match. A
  match never refuses the upload: it is shown to the reviewer (R1). The library is chosen in the
  photo-hash task, after reading its docs and testing it on resized and recompressed copies.
- **P4** Photo changes follow L5 (for a `live` or `stale` listing they send it back to review).
  A delete that would leave a submitted listing with fewer than 3 photos is refused (409
  `NOT_ENOUGH_PHOTOS`).
- **P5** Photos of a `live` listing are served from public URLs. All other photos are visible only
  to the lister and staff, through short-lived signed links.

## 5. Location, browse and search

- **G1** The lister sets the location by GPS or by dragging a pin, and picks the sub-city and the
  neighbourhood from our list (the neighbourhood is required). The pin must be inside the Addis
  Ababa boundary (`service_area`, 400 `LOCATION_OUTSIDE_SERVICE_AREA`). The boundary comes from
  OpenStreetMap; its licence (ODbL) needs attribution, which the app shows anyway for the
  OpenStreetMap-based map tiles. There's no check that the pin is inside the chosen sub-city
  (we have no sub-city boundaries); the reviewer sees both on a map.
  - **"My neighbourhood isn't listed":** the lister picks the nearest neighbourhood and types the
    real name (`unlisted_neighbourhood_name`, 1–100 characters). The reviewer sees it (R1) and can
    add the neighbourhood (G7).
- **G2** `approx_location` is the exact point moved by a random distance of 200–400 m in a random
  direction, generated **once** and stored (overview §7). It is regenerated only when the lister
  changes the exact location, never on read, so repeated requests can't be averaged back to the
  real point.
- **G3** The exact `location` and the `landmark` are returned only to the lister and to staff.
  (Phase 3 adds a tenant whose contact request was accepted.) The public sees the neighbourhood
  and the approximate point.
- **G4** Search never uses the exact point. "Near me", distance sorting and any distance shown
  are computed from `approx_location` and rounded to 100 m, so the exact point can't be worked
  out by searching from several places.
- **G5** `GET /listings` (public): only `live` listings of `active` listers. Filters: sub-city,
  neighbourhood, `minRent`/`maxRent`, `type`, `minBedrooms`, `furnished`; near me: `lat`, `lng`,
  `radiusKm` (at most `SEARCH_MAX_RADIUS_KM`). Sort: newest (`published_at`), rent, distance (only
  with near me). Cursor pagination with a composite cursor, as the admin queues.
- **G6** `GET /listings/:id` (public): a listing that isn't `live` (or whose lister isn't
  `active`) is 404 for everyone except its lister. Shown: listing and property fields except the
  landmark and the unlisted neighbourhood name, photos, sub-city and neighbourhood (the picked
  one), the approximate point, the lister's name with the verified badge (L7) and
  `lister_relation`.
- **G7** `GET /areas` (public): sub-cities with their **active** neighbourhoods, both languages.
  `POST /admin/neighbourhoods { subCityId, nameEn, nameAm, propertyId? }` (moderator+, audited)
  adds one; a name already in that sub-city (active or not) is 409 `NEIGHBOURHOOD_EXISTS`. With
  `propertyId` (adding it from the review page), that property is moved to the new neighbourhood
  and its `unlisted_neighbourhood_name` cleared, in the same transaction; this doesn't count as a
  lister edit (L5).
- **G8 Staff manage neighbourhoods** (moderator+; every change audited in the same transaction,
  S1; nothing is ever hard-deleted):
  - `GET /admin/neighbourhoods?subCityId=&includeInactive=` — any staff role.
  - `PATCH /admin/neighbourhoods/:id { nameEn?, nameAm? }` — rename; the S1 audit row records
    the old and new names. A clash is 409 `NEIGHBOURHOOD_EXISTS`. Properties keep their
    neighbourhood id, so they show the new name.
  - `POST /admin/neighbourhoods/:id/deactivate { note? }` — sets `deactivated_at`: hidden from
    the picker (`GET /areas`) and can't be newly chosen (400 `NEIGHBOURHOOD_INACTIVE`), but
    properties that already have it keep it, through their own edits too, and still show its
    name. Already inactive: 409 `NEIGHBOURHOOD_ALREADY_INACTIVE`.
  - `POST /admin/neighbourhoods/:id/reactivate { note? }` — clears `deactivated_at` (a mistaken
    deactivation can't be undone by adding the name again). Already active: 409
    `NEIGHBOURHOOD_ALREADY_ACTIVE`.
  - Sub-cities are fixed (seeded); staff can't change them.

## 6. Freshness checks

- **F1** A `live` listing gets an availability check `LISTING_CHECK_INTERVAL` (default 7 days)
  after `published_at` or the last confirmation, whichever is later. The check is stored and a
  push is sent (section 7).
- **F2** `available: true` sets `last_confirmed_at` and keeps the listing `live`.
  `available: false` needs a `reason` (`rented_in_app`, `rented_elsewhere`,
  `no_longer_for_rent`) and closes the listing as in L12.
- **F3** No answer within `LISTING_CHECK_ANSWER_WINDOW` (default 48 h) → `stale`, hidden from
  browse. The window runs even if the push couldn't be delivered; the pending check is also
  shown in `GET /me/listings`.
- **F4** Restoring a `stale` listing is one tap and needs no review (overview §6): it becomes
  `live` and counts as a confirmation.
- **F5** `stale` for `LISTING_STALE_TO_EXPIRED` (default 30 days) → `expired`, which the lister
  reopens as in L6.
- **F6** The job runs every 15 minutes when `JOBS_ENABLED`, uses the database clock, and is safe
  to run twice: a listing never has two open checks, and each transition happens once, under a
  row lock.

## 7. Push notifications

- **N1** `PushSender` interface, chosen by `PUSH_PROVIDER`: `console` logs messages (development
  and tests), `fcm` sends through Firebase Cloud Messaging (HTTP v1 via `firebase-admin`; read
  the FCM docs before writing it). The app refuses to start in production with `console`.
- **N2** `POST /me/devices { fcmToken, platform }` registers a token (an existing token moves to
  the current user, for a shared phone); `DELETE /me/devices/:id` removes one (the app calls it
  on logout). Tokens FCM reports as invalid are deleted. A ban deletes the user's devices.
- **N3** Texts are in the user's `preferred_language`: English or Amharic; `om` users get English
  until Afaan Oromo is added. All texts live in one file (as `otp-message.ts`). Claude drafts the
  Amharic, you review it.
- **N4** A push never contains a phone number, a name or a location; it names the listing by
  neighbourhood and type and opens it in the app.
- **N5** Phase 2 sends: the weekly check, listing approved, listing rejected (decided). A staff
  takedown also sends a push with the reason code (decided 2026-11-09); suspected fraud uses the
  neutral `GUIDELINES`, as for rejections (R4, R5).

## 8. Staff review

### Endpoints
- `GET /admin/listings?status=pending_review&limit=&after=` — queue, oldest `submitted_at` first
  (any staff role).
- `GET /admin/listings/:id` — the listing and property, the exact location and landmark, photos,
  flags (R1), the lister's verified full name, verification status, account status and other
  listings, and the listing's history.
- `POST /admin/listings/:id/approve { version, note? }` — moderator+.
- `POST /admin/listings/:id/reject { version, reasonCode, listerNote?, note }` — moderator+.
- `POST /admin/listings/:id/takedown { reasonCode, listerNote?, note }` — moderator+.
- `POST /admin/neighbourhoods`, `PATCH /admin/neighbourhoods/:id`, deactivate, reactivate — see
  G7, G8.

### Rules
- **R1 Flags on the review page** (they never block anything by themselves):
  - `PHOTO_MATCH` — a photo matches another lister's photo (P3), with a link to that listing;
  - `MANY_ACTIVE_LISTINGS` — the lister has more than 2 active listings, in any area, counting
    this one (decided 2026-11-09);
  - `UNLISTED_NEIGHBOURHOOD` — the lister typed a neighbourhood that isn't in our list (G1), with
    the typed name and an "add neighbourhood" action (G7);
  - `PHONE_IN_TEXT` — the description, landmark or unlisted neighbourhood name contains
    something that looks like a phone
    number (the phone is meant to be revealed only on acceptance).
- **R2** S1–S3 apply: every change is audited in the same transaction, `support` is read-only,
  admin and app tokens don't cross. Only `pending_review` listings can be approved or rejected:
  the row is locked; a second decision is 409 `ALREADY_DECIDED`, other states 409
  `LISTING_NOT_REVIEWABLE`; a `version` that isn't the listing's current one (the lister edited it
  meanwhile) is 409 `LISTING_CHANGED`.
- **R3** Approving checks again that the lister is `active`, `approved` and under the L2 cap (409
  `LISTER_NOT_ELIGIBLE` / `ACTIVE_LISTING_LIMIT`), since these may have changed since submitting.
- **R4** Approve → `live`, `published_at` set, the freshness clock starts. Reject → `rejected`
  with a `reasonCode` (section 2 list) and an optional `listerNote` (at most 300 characters)
  that the lister sees, plus a staff-only `note` (1–1000 characters). Suspected fraud uses
  `GUIDELINES` and no lister note that hints at why (hard rule 10). The S1 ID-number check applies
  to both notes.
- **R5** Takedown: a `live` or `stale` listing → `removed` with `close_reason = staff_takedown`,
  a `reasonCode` from the same list, and the same notes as R4.
- **R6** Staff see the photos of non-live listings only through short-lived signed links (P5).

### Review web page
One static HTML page served by the API at `/admin/review`, using the existing admin login and the
admin endpoints above: the queue, one listing with its photos, flags and both points on a map, and
the approve / reject / takedown buttons, and "add neighbourhood" for an unlisted one. No framework, no build step; the Next.js admin stays for
later.

## 9. Environment variables (new)

```
PUSH_PROVIDER=console              # console | fcm
FCM_SERVICE_ACCOUNT_FILE=          # path to the Firebase service-account JSON; never committed
S3_ENDPOINT=http://localhost:9000  # MinIO in development
S3_REGION=auto
S3_BUCKET=rental-photos
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE_URL=                # where public (live) photos are served from
PHOTO_MAX_BYTES=10485760           # 10 MB per upload
PHOTO_MAX_DIMENSION=2048           # longest side after re-encoding
PHOTO_HASH_MAX_DISTANCE=           # Hamming distance for a match; set after testing (P3)
LISTING_MAX_ACTIVE_PER_USER=10     # L2 hard cap
LISTING_CHECK_INTERVAL=7d          # F1
LISTING_CHECK_ANSWER_WINDOW=48h    # F3
LISTING_STALE_TO_EXPIRED=30d       # F5
SEARCH_MAX_RADIUS_KM=20            # G5
```

## 10. Flutter app (`rental-app`)

- Create a listing: the form (section 2 fields), photos (camera or gallery, 3–12), the location
  (GPS or a draggable pin on `flutter_map`), the sub-city and neighbourhood pickers with "my
  neighbourhood isn't listed" (pick the nearest, type the real name), submit. Bathrooms = 0 is
  shown as "Shared bathroom".
- My listings: status, the staff reason and note, a pending weekly check with the "still
  available?" answers and the three closing reasons, restore, reopen, close, relist.
- Browse without an account: list and map, filters, near me, listing detail with the
  approximate area as a circle and the lister's name with the verified badge.
- Push: register the FCM token after login and remove it on logout; tapping a weekly check opens
  the answer screen; approve / reject notices open the listing.
- Every screen in English and Amharic (Claude drafts the Amharic, you review).

## 11. Testing

Unit or e2e tests must cover: L1–L13 and every row of the transitions table (and that any other
transition is refused), P1–P5 (including: a JPEG with EXIF GPS comes back without any metadata;
a resized and recompressed copy of another lister's photo is a match, the same lister's is not),
G1–G8 (results and distances come from `approx_location`; the exact point and the landmark
appear only for the lister and staff), F1–F6 (with the clock moved, and the job run twice),
N1–N5, R1–R6, the ban and unban effects (L8), and the audit rows. Use a fake `PushSender` and
MinIO or a fake `PhotoStorage`; tests never call FCM.

## 12. Decisions (2026-11-09)

- **P2-1** No hard limit at 2: a reviewer flag above 2 active listings in any area, plus a hard
  cap as a config value (10). Active = `pending_review`, `live`, `stale`. → L2, R1
- **P2-2** Types: condominium, apartment, villa/house, room in a compound, studio; residential
  only. Fields: bedrooms, bathrooms, furnished, separate water meter, separate electricity meter,
  description; size and floor optional; amenities: parking, gated compound, guard. → section 2
- **P2-3** Monthly rent in whole birr, advance months 1–12, negotiable, available-from date; no
  utilities field. → section 2, L13
- **P2-4** At least 3 photos to submit, at most 12. → L2, P1
- **P2-5** A photo-hash match is a warning to the reviewer; only other listers' photos count. → P3
- **P2-6** Photos, location, landmark or description changes send a live or stale listing back
  to review; price and available-from don't, but are recorded in the history. A rejected listing
  can be edited and resubmitted. An expired listing is reopened by confirming its details, with
  review only if something changed. → L5, L6
- **P2-7** "Not available" asks why: rented through the app, rented elsewhere, no longer for
  rent; each closes the listing and the reason is recorded. → F2, L12
- **P2-8** The landmark is revealed with the exact location; the public sees the neighbourhood
  and the approximate point. → G3, G6
- **P2-9** First name + initial of the father's name + verified badge. → L7
- **P2-10** After an unban, hidden listings come back as expired. → L8
- **P2-11** Staff takedowns in Phase 2, with a reason code, audited. → R5
- **P2-12** Rejection reasons as in section 2; `GUIDELINES` for suspected fraud; an optional
  note to the lister. → R4
- **P2-13** Push on approved and rejected. → N5
- **P2-14** The lister picks the sub-city and neighbourhood (required); the pin must be inside
  Addis Ababa; 11 sub-cities plus a starting neighbourhood list you review; staff add
  neighbourhoods. → G1, G7
- **P2-15** Claude drafts the Amharic, you review; `om` users get English. → N3
- **Follow-ups (same day):** a live or stale listing is hidden while back in review; every field
  except rent, available-from and negotiable sends it back to review (rent and available-from
  are recorded in the history); bathrooms = 0 means a shared bathroom; a takedown sends a push
  with the reason code (neutral `GUIDELINES` for suspected fraud); "my neighbourhood isn't
  listed" lets the lister pick the nearest one and type the real name, which the reviewer sees
  and can add. → L5, G1, G7, N5, R1
- **Neighbourhood management (2026-11-09):** the reviewed list is seeded as it is; staff add,
  rename (English and Amharic) and deactivate neighbourhoods (hidden from the picker, existing
  listings keep them); never hard-deleted; all audited. → G7, G8
- **T-1** S3-compatible storage, MinIO for development, Cloudflare R2 in the production
  comparison. **T-2** The review page is one static page. **T-3** "Rented" without picking the
  tenant until Phase 3. **T-4** You create the Firebase project; Claude gives you the exact setup
  steps at that task.
