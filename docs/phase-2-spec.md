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
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| city | varchar unique | `Addis Ababa` |
| boundary | geography(MultiPolygon, 4326) | never returned by the API |
| source | varchar | where the boundary came from, with version and licence |
| created_at | timestamptz | |

One row at launch, loaded by a migration (G1). A newer boundary is a new migration.

### `out_of_area_demand` — refused pins, for seeing demand outside the city (G1)
| Column | Type | Notes |
| --- | --- | --- |
| lat_rounded, lng_rounded | numeric(5,2), numeric(6,2) | the refused pin rounded to 0.01° (about 1.1 km) |
| day | date | Africa/Addis_Ababa date, no time |
| refusals | int | how many pins in that cell on that day |

Primary key (`lat_rounded`, `lng_rounded`, `day`). **No user, listing, device or exact time** is
stored, so a row can't be linked back to anyone.

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

**Drafts may be half-filled** (decided 2026-11-23): the app saves the form step by step and needs
a draft before it can upload photos, so the fields a lister fills in are nullable until they
submit, and submitting checks them (L2, `LISTING_INCOMPLETE`). Null on a yes/no field means "not
answered yet", never "no". Past `draft`, the database also requires the listing's own fields
(rent, advance months, negotiable, available-from). `location` and `landmark` are never loaded
unless a query asks for them by name (G3).

### `property_photos`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | |
| property_id | uuid FK → properties | |
| storage_key | varchar | the re-encoded file in object storage (P1) |
| thumbnail_key | varchar | the thumbnail (480 px, T3.4); every photo has one |
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
| version | int | starts at 1; +1 on every edit of the listing, its property or its photos. A review decision names the version it looked at (R2) (added 2026-11-23) |
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
Rows are never changed (a trigger refuses UPDATE); deleting a draft deletes its rows with it.

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
| session_id | uuid | the sign-in session it was registered under (T6.1) |
| fcm_token | varchar(4096) unique | |
| platform | enum `android`, `ios` | |
| created_at, last_seen_at | timestamptz | |

**A device ends with its sign-in session** (decided 2026-11-24): logout deletes that session's
devices; revoking all of a user's sessions (a reused refresh token, A5; a ban; later the lost-SIM
move) deletes all their devices, in the same transaction. A session that simply expires sends no
more pushes (`PushService` sends only to devices of live sessions and deletes the rest). At most
10 devices per user: an 11th replaces the least recently seen.

### Changes to Phase 1 tables and code
- `refresh_tokens.session_id` (T6.1): the id of a sign-in session's first token, copied to every
  token rotated from it, so a session keeps one id through rotation (existing rows filled in by
  walking the rotation chains). Access tokens carry it as `sid`.
- `admin_actions`: new action types `listing.approve`, `listing.reject`, `listing.takedown`,
  `listing.reveal_lister_phone` (T4.1), `neighbourhood.create`, `neighbourhood.update`, `neighbourhood.deactivate`,
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
  to draft (lazy verification, overview §5). At most `MAX_DRAFT_LISTINGS` (default 10) drafts per
  user at once: 409 `DRAFT_LISTING_LIMIT` with `max` (decided 2026-11-23). Only drafts count.
- **L2** Submitting (and any other move into an active state from a non-active one: reopen, L6)
  needs:
  - `verification_status = approved` (403 `VERIFICATION_REQUIRED`, as `VerifiedGuard`);
  - every required field filled (400 `LISTING_INCOMPLETE` with `missing: [...]`);
  - at least 3 photos (400 `NOT_ENOUGH_PHOTOS` with `min`);
  - fewer than `LISTING_MAX_ACTIVE_PER_USER` (default 10) active listings already (409
    `ACTIVE_LISTING_LIMIT` with `max`).

  Checked in that order, in one transaction with the user and the listing locked. An
  available-from date that has passed since it was set doesn't block submitting (decided
  2026-11-23; L13 checks it only when set or changed, and the app shows a past date as "Available
  now"). Withdrawing (`pending_review` → `draft`) is allowed even at the draft limit (L1).
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

  Outside `draft`, a change that would empty a required field (L2's list) is refused: 400
  `LISTING_INCOMPLETE` with `missing`, nothing changed (decided 2026-11-24). Every real change
  adds 1 to `version`, in every state.
- **L6** An `expired` listing is reopened by the lister confirming its details. Edits to an
  expired listing are allowed; one that needs review under L5 sets `needs_review`. Reopening
  then goes to `pending_review` if `needs_review`, or straight back to `live` if not. Rent and
  available-from changes are recorded as in L5. Reopening checks L2 and counts as a confirmation
  (`last_confirmed_at`).

  Decided 2026-11-24, so that nothing unreviewed goes live (L4):
  - Reopening also goes to `pending_review` if the listing was **never approved**
    (`published_at` empty).
  - Whenever a listing moves from `pending_review` to `expired` (a ban, L8, or any other path),
    `needs_review` is set. A database trigger does it, so every code path is covered.
  - Reopening straight to `live` keeps the original `published_at`, so a reopened listing
    doesn't jump to the top of "newest".
- **L7** The listing shows the lister's first name, the initial of their father's name and a
  verified badge (for example "Abebe K."), taken from the verified `full_name` (first word, and
  the first letter of the second word; one word only → that word). The full name is never
  public. A word written all in capitals or all in small letters (passports) is shown with only
  its first letter capital; mixed case is kept; Ge'ez passes through (T5.2). Checked 2026-11-24
  on the user's Fayda ID card: "Yakob Zekariya Aman" (given, father's, grandfather's name) →
  "Yakob Z."; passports are checked in the live Didit test.
- **L8** Banning a user (S5) moves their `pending_review`, `live` and `stale` listings to
  `expired` in the same transaction (`listing_history` actor: the admin). Drafts stay drafts.
  Unban doesn't change listings, so they come back as `expired` and the lister must reopen them
  (L6). Browse and detail also show only listings of `active` listers.
- **L10** At most one open listing (`draft`, active or `expired`) per property: 409
  `PROPERTY_HAS_OPEN_LISTING`.
- **L11** Relisting creates a new listing on the same property after `rented` or `removed`, so
  history is kept (overview §6). It starts as a `draft` with the old listing's fields copied.
  Decided 2026-11-24: it copies rent, advance months and negotiable from the latest closed
  listing, and available-from only if it's today or later (the property's fields are shared).
  A `rejected` listing blocks relisting like an open one: fix and resubmit it, or close it,
  first. Blocked: 409 `PROPERTY_HAS_OPEN_LISTING` with `listingId`. Someone else's property:
  404 `PROPERTY_NOT_FOUND`. The draft limit (L1) applies.
- **L12** Closing needs a reason: `rented_in_app` or `rented_elsewhere` → `rented`;
  `no_longer_for_rent` → `removed`. The reason is stored on the listing and in
  `listing_history`. ("Rented in the app" doesn't pick the tenant yet; that comes with contact
  requests in Phase 3.) `rented_in_app` needs a listing that was published at some point
  (`published_at` set): otherwise 400 `RENTED_IN_APP_NEVER_PUBLISHED` (decided 2026-11-24, so
  that number can be trusted). A lister can't use `staff_takedown`. A draft can't be closed
  (delete it instead).
- **L13** Money fields are integers of birr; anything else is 400 (hard rule 6).
  `advance_months` is 1–12. `available_from` can't be in the past (Addis Ababa date) when it is
  set or changed: 400 `AVAILABLE_FROM_IN_PAST`. Upper limits (decided 2026-11-23, generous so no
  real home is refused; in one constants file, `listing-limits.ts`): bedrooms ≤ 20, bathrooms
  ≤ 20, floor ≤ 60, size ≤ 5000 m², rent ≤ 2,000,000 birr. Over a limit: 400 with the field's own
  code (`BEDROOMS_ABOVE_LIMIT`, `BATHROOMS_ABOVE_LIMIT`, `FLOOR_ABOVE_LIMIT`, `SIZE_ABOVE_LIMIT`,
  `RENT_ABOVE_LIMIT`) and `max`. A neighbourhood id that doesn't exist: 400
  `NEIGHBOURHOOD_NOT_FOUND`.

## 4. Photos

- **P1** Accepted: JPEG, PNG, WebP, at most `PHOTO_MAX_BYTES` each, at most 12 per property
  (409 `TOO_MANY_PHOTOS`). Files go to S3-compatible object storage behind a `PhotoStorage`
  interface (SeaweedFS in Docker Compose for development, decided 2026-11-24 because MinIO no
  longer publishes community images; the production provider is chosen before
  deploying, with Cloudflare R2 in the comparison).
- **P2** Every upload is **re-encoded** (resized to at most `PHOTO_MAX_DIMENSION` pixels, saved as
  JPEG) and **all metadata is removed**, including EXIF GPS. Only the re-encoded file is stored.
  Reason: listing photos are public, and a GPS tag would reveal the exact location, which stays
  hidden until a contact request is accepted (decided 2026-11-09).
  - **How (T3.2):** phone photos carry location not only in EXIF GPS but also in XMP, the EXIF
    thumbnail, extra images (MPF: depth maps, HDR layers) and data after the image (motion-photo
    videos). Rather than deleting known tags, the photo is decoded to pixels and a new JPEG is
    written from the pixels alone (sharp; no `keepMetadata`/`keepExif`/`withMetadata`), so no
    byte of the upload is copied. It is turned upright from its EXIF orientation first, then
    shrunk (never enlarged) and converted to sRGB.
  - **Input checks:** the type comes from the content (JPEG, PNG or WebP; otherwise 400
    `PHOTO_TYPE_NOT_ALLOWED`); only those three decoders may run at all; at most
    `PHOTO_MAX_INPUT_PIXELS` (50 MP, decided 2026-11-24) before decoding (400
    `PHOTO_TOO_MANY_PIXELS`, against decompression bombs); strict decoding (400
    `PHOTO_UNREADABLE`); animated WebP: the first frame only. Over `PHOTO_MAX_BYTES`: 413
    `PHOTO_TOO_LARGE`.
  - **Tests:** a real phone photo with GPS, and generated JPEG/PNG/WebP files with metadata in
    every place above, are uploaded and the stored file is checked byte by byte: no GPS, EXIF,
    XMP, IPTC, ICC, MPF or other segment, nothing after the end of the image.
  - Not covered: what the picture itself shows (a street sign, a shop name). That's for the
    reviewer (R1).
  - **Thumbnails (T3.4, decided 2026-11-24):** each upload also stores a thumbnail, at most 480 px
    on the longest side (JPEG), written the same way from the same decoded pixels, so P2 applies
    to it too (the tests check it byte by byte). A photo and its thumbnail are one unit: stored,
    published, unpublished, purged and deleted together (`photoFiles()`), and the reconciliation
    job keeps or removes both. Browse cards (G5) use the thumbnail; the detail (G6) and the
    lister's and staff's views use the full photo. Reason: a page of 20 full photos would be
    several MB on mobile data.
- **P3** Each stored photo gets a 64-bit perceptual hash, compared with the photos of every
  property **of other listers**. A Hamming distance ≤ `PHOTO_HASH_MAX_DISTANCE` is a match. A
  match never refuses the upload: it is shown to the reviewer (R1). The library is chosen in the
  photo-hash task, after reading its docs and testing it on resized and recompressed copies.
- **P4** Photo changes follow L5 (for a `live` or `stale` listing they send it back to review;
  for an `expired` one they set `needs_review`; rented and removed: 409). **Reordering applies at
  once, without review** (decided 2026-11-24). A delete that would leave a listing in
  `pending_review`, `live` or `stale` with fewer than 3 photos is refused (409
  `NOT_ENOUGH_PHOTOS`); `rejected` and `expired` listings may delete freely, since resubmitting
  and reopening check for 3 again (decided 2026-11-24).
- **P5** Photos of a `live` listing are served from public URLs. All other photos are visible only
  to the lister and staff, through short-lived signed links (15 minutes,
  `PHOTO_SIGNED_URL_TTL_SECONDS`).
  - **Two buckets** (decided 2026-11-24; R2 can make only a whole bucket public, with no object
    ACLs or bucket policies): the private bucket holds every photo; the public bucket holds
    copies of live listings' photos only, added when a listing goes live and removed when it
    stops being live (`PhotoStorage.publish` / `unpublish`).
  - **Caches** (decided 2026-11-24): public photos carry `Cache-Control: public, max-age=86400`
    (`PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS`, 1 day). Removing a photo from the public bucket doesn't
    reach copies already in phone or CDN caches: they stay reachable until their max-age runs
    out. That's acceptable for ordinary changes; for a **staff takedown** (R5) the CDN cache for
    the listing's photos is purged as well (T4.2, deployment checklist). Private photos carry
    `Cache-Control: private`, so no shared cache keeps them.

## 5. Location, browse and search

- **G1** The lister sets the location by GPS or by dragging a pin, and picks the sub-city and the
  neighbourhood from our list (the neighbourhood is required). The pin must be inside the Addis
  Ababa boundary (`service_area`, 400 `LOCATION_OUTSIDE_SERVICE_AREA`): **strict, no margin**
  (decided 2026-11-10), a point exactly on the boundary counts as inside. The boundary is
  OpenStreetMap relation 1707699 (version 25, fetched 2026-11-10; 538 km²), unmodified; its licence
  (ODbL) needs attribution, which the app shows anyway for the OpenStreetMap-based map tiles.
  - **A refused pin** (decided 2026-11-10): the app shows a friendly message ("We're only in
    Addis Ababa for now"). The API records it in `out_of_area_demand`, rounded to about 1 km, by
    day, with no link to the user, so staff can later see where demand is outside the city. Viewing
    it is a database query for now; no endpoint. There's no check that the pin is inside the chosen sub-city
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
  neighbourhood, `minRent`/`maxRent`, `maxAdvanceMonths` (1–12, decided 2026-11-24: many tenants
  can pay the rent but not a long advance), `type`, `minBedrooms`, `furnished`; near me: `lat`,
  `lng`, `radiusKm` (default 5 km, at most `SEARCH_MAX_RADIUS_KM`). Sort: `newest`
  (`published_at`), `rent_asc`, `rent_desc`, `distance` (only with near me). Cursor pagination
  (20 a page, at most 50): the cursor holds its sort, the last value and the id, so ties page
  without gaps and a cursor can't be replayed against another sort. Errors (400):
  `RENT_RANGE_INVALID`, `LOCATION_INCOMPLETE`, `RADIUS_TOO_LARGE`,
  `DISTANCE_SORT_NEEDS_LOCATION`, `INVALID_CURSOR`. Cards carry the cover's **thumbnail** (T3.4)
  as a public URL, the approximate point, and never the exact point, the landmark, the typed
  neighbourhood name or the lister (the public name comes with T5.2). The app draws the
  approximate point as a circle of about 500 m, never a pin (decided 2026-11-24): the home can be
  up to 400 m away.
- **G6** `GET /listings/:id` (public): a listing that isn't `live` (or whose lister isn't
  `active`, or no longer verified) is 404 `LISTING_NOT_FOUND` for everyone except its lister.
  Shown: listing and property fields except the landmark and the unlisted neighbourhood name,
  photos (full size; browse cards have thumbnails), sub-city and neighbourhood (the picked one),
  the approximate point, the lister's name with the verified badge (L7) and `lister_relation`.
  - **Who sees it (decided 2026-11-24):** public browse and detail show only `live` listings of
    listers who are `active` **and** whose verification is `approved`. A lister whose
    verification is revoked is hidden at once, like a banned one; T7.1 also expires their open
    listings (photos unpublished, weekly checks stop), and reopening re-checks verification.
  - **Optional sign-in on public routes (T5.2):** a valid app token identifies the viewer; a
    missing, invalid or expired one leaves the request anonymous (a public route never answers
    401). The lister, signed in, sees their own listing in any state in this same public view (a
    preview; photos as signed links while it isn't live), with `viewerIsLister: true`. Phase 3
    uses the same to show the viewer's contact request state.
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
- **N2** `POST /me/devices { fcmToken, platform }` registers a token under the current sign-in
  session (an existing token moves to the current user and session, for a shared phone);
  `DELETE /me/devices/:id` removes one (the app calls it on logout; 404 `DEVICE_NOT_FOUND`).
  Tokens FCM reports as invalid are deleted. Devices end with their session (section 2), which
  covers logout, revoke-all and the ban. An access token from before sessions had ids gets 401
  `ACCESS_TOKEN_EXPIRED` (refresh and retry); an ended session, 401 `UNAUTHENTICATED`.
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
  (any staff role). Another status on request (e.g. `live`, to find one to take down); **drafts
  are never listed** (decided 2026-11-24: unfinished and private), though one can be opened by id.
- `GET /admin/listings/:id` — the listing and property, the exact location and landmark, photos,
  flags (R1), the lister's verified full name, verification status, account status and other
  listings, and the listing's history. **Not the lister's phone number.**
- `POST /admin/listings/:id/reveal-lister-phone { note? }` — moderator+: returns the lister's
  phone, for a reviewer who wants to call about a suspicious listing. Every reveal writes an
  `admin_actions` row (who, which listing, the note; never the number) in the same transaction
  (decided 2026-11-24).
- `POST /admin/listings/:id/approve { version, note? }` — moderator+.
- `POST /admin/listings/:id/reject { version, reasonCode, listerNote?, note }` — moderator+.
- `POST /admin/listings/:id/takedown { reasonCode, listerNote?, note }` — moderator+.
- `POST /admin/neighbourhoods`, `PATCH /admin/neighbourhoods/:id`, deactivate, reactivate — see
  G7, G8.

### Rules
- **R1 Flags on the review page** (they never block anything by themselves):
  - `PHOTO_MATCH` — a photo matches another lister's photo (P3), with a link to that listing.
    Hashing only compares photos on our platform; for a suspicious listing the reviewer also
    runs a reverse image search (Google Lens) to catch photos copied from elsewhere (reviewer
    checklist, decided 2026-11-24);
  - `MANY_ACTIVE_LISTINGS` — the lister has more than 2 active listings, in any area, counting
    this one (decided 2026-11-09);
  - `UNLISTED_NEIGHBOURHOOD` — the lister typed a neighbourhood that isn't in our list (G1), with
    the typed name and an "add neighbourhood" action (G7);
  - `CONTACT_IN_TEXT` (widened from `PHONE_IN_TEXT`, decided 2026-11-24) — the description,
    landmark or unlisted neighbourhood name contains contact details that would bypass contact
    requests: an Ethiopian mobile number, a Telegram username (`@name`) or link (`t.me/…`),
    an email address or another link. Brokers in Addis pull people off-platform this way,
    mostly through Telegram. The details say which kind was found in which field. A hint, not a
    guarantee: deliberately disguised details (digits as words, "O" for zero, "t . me") get
    through.
- **R2** S1–S3 apply: every change is audited in the same transaction, `support` is read-only,
  admin and app tokens don't cross. Only `pending_review` listings can be approved or rejected:
  the row is locked; a second decision is 409 `ALREADY_DECIDED`, other states 409
  `LISTING_NOT_REVIEWABLE`; a `version` that isn't the listing's current one (the lister edited it
  meanwhile) is 409 `LISTING_CHANGED` (with the current `version`). Locks are taken lister first,
  then the listing, as in the lister's own changes, so the two can't deadlock (T4.2).
- **R3** Approving checks again that the lister is `active`, `approved` and under the L2 cap (409
  `LISTER_NOT_ELIGIBLE` / `ACTIVE_LISTING_LIMIT`), since these may have changed since submitting.
- **R4** Approve → `live`, `published_at` set, the freshness clock starts (decided 2026-11-24:
  `published_at` only on the first approval, so a re-approved listing doesn't jump to the top of
  "newest"; every approval sets `last_confirmed_at`, restarting the clock). Reject → `rejected`
  with a `reasonCode` (section 2 list) and an optional `listerNote` (at most 300 characters)
  that the lister sees, plus a staff-only `note` (1–1000 characters). Suspected fraud uses
  `GUIDELINES` and no lister note that hints at why (hard rule 10): a `GUIDELINES` decision with
  a `listerNote` is refused, 400 `LISTER_NOTE_NOT_ALLOWED` (decided 2026-11-24). The S1 ID-number
  check applies to both notes.
- **R5** Takedown: a `live` or `stale` listing → `removed` with `close_reason = staff_takedown`,
  a `reasonCode` from the same list, and the same notes as R4.
- **R6** Staff see the photos of non-live listings only through short-lived signed links (P5).
- **R7 Public photos follow `live`** (T4.2, P5): every move into `live` (approve, reopen; later
  restore from stale) publishes the listing's photos inside its transaction, so a listing never
  goes live without them (a storage failure: 503 `STORAGE_UNAVAILABLE`, nothing changes); every
  move out of `live` (back to review, close, takedown; later stale, expiry, ban) unpublishes them
  after the commit, best effort. A takedown also purges them from the CDN (`PublicCache`; a
  do-nothing one until production is chosen). Anything a failed step leaves public is removed by
  an hourly reconciliation job (T4.4; also `npm run photos:reconcile`):
  - it lists the public bucket and removes every copy under `properties/` whose photo record is
    gone or whose listing isn't `live`, logs each removal with the reason, and asks the CDN to
    forget the removed URLs;
  - copies written in the last 15 minutes are left alone (an approval publishes a moment before
    it commits); keys outside `properties/` are logged, never deleted; the private bucket is never
    touched; one instance runs a pass at a time (advisory lock);
  - **no overlap with publishing** (decided 2026-11-24): for each property with suspicious
    copies, the job locks the property row (the lock every publishing path already holds),
    checks again, deletes, and commits. An approval or reopen of that listing waits for the job
    and publishes after the delete; or the job waits for it and then finds the listing live and
    keeps the copies.

### Review web page
One static HTML page served by the API at `/admin/review`, using the existing admin login and the
admin endpoints above: the queue, one listing with its photos, flags and both points on a map, and
the approve / reject / takedown buttons, and "add neighbourhood" for an unlisted one. No framework, no build step; the Next.js admin stays for
later.

## 9. Environment variables (new)

```
PUSH_PROVIDER=console              # console | fcm (fcm: T6.2); production refuses console
FCM_SERVICE_ACCOUNT_FILE=          # path to the Firebase service-account JSON; never committed
S3_ENDPOINT=http://localhost:8333  # SeaweedFS in development
S3_REGION=auto
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PRIVATE_BUCKET=rental-photos-private  # every photo (P5)
S3_PUBLIC_BUCKET=rental-photos-public    # copies of live listings' photos only (P5)
S3_PUBLIC_BASE_URL=                # where the public bucket is served from (its custom domain)
S3_FORCE_PATH_STYLE=true
PHOTO_SIGNED_URL_TTL_SECONDS=900   # P5: private photos' signed links
PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS=86400  # P5: Cache-Control on public photos
PHOTO_MAX_BYTES=10485760           # 10 MB per upload
PHOTO_MAX_DIMENSION=2048           # longest side after re-encoding
PHOTO_MAX_INPUT_PIXELS=50000000    # P2: width × height of an upload (decompression bombs)
PHOTO_HASH_MAX_DISTANCE=           # Hamming distance for a match; set after testing (P3)
LISTING_MAX_ACTIVE_PER_USER=10     # L2 hard cap
MAX_DRAFT_LISTINGS=10              # L1: drafts per user at once
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
the local SeaweedFS (its own test buckets) or a fake `PhotoStorage`; tests never call FCM.

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
- **Service area (2026-11-10):** strict, no margin outside the OpenStreetMap boundary. A refused
  pin gets a friendly message in the app and is recorded rounded to about 1 km, with no user
  link. → G1
- **Push devices (2026-11-24):** at most 10 per user; each device belongs to the sign-in session
  it was registered under and is deleted when that session ends; Amharic texts in the polite form
  (እርስዎ). → N2, N3
- **Detail and names (2026-11-24):** the optional sign-in on public routes, for the lister's
  preview (and Phase 3); public views require an active **and** verified lister, and a revoked
  verification expires the lister's open listings like a ban (T7.1); passport name order is
  handled after the live Didit test. → G6, L7, L8
- **Review decisions (2026-11-24):** re-approval keeps `published_at` and restarts the freshness
  clock; no lister note with `GUIDELINES`; CDN purge on takedown through `PublicCache`
  (Cloudflare when production is chosen); an hourly job removes public photos of listings that
  aren't live (T4.4). → R4, R5, R7
- **Photos (2026-11-24):** at most 50 MP per upload; reordering a live listing's photos applies
  without review; the 3-photo floor on delete applies to `pending_review`, `live` and `stale`
  only; the app resizes and compresses before uploading (the server still re-encodes). → P2, P4
- **Close and relist (2026-11-24):** `rented_in_app` only for a listing that was published; a
  rejected listing blocks relisting; relisting copies available-from only if it's today or
  later. Raised for Phase 4: staff can't yet see what a listing looked like when it was live
  (roadmap Q15). → L11, L12
- **Editing after submitting (2026-11-24):** outside draft a required field can't be emptied
  (`LISTING_INCOMPLETE`); reopening goes to review if the listing needs review or was never
  approved; a listing that expires while in review is marked `needs_review` (database trigger);
  reopening keeps the original `published_at`. → L5, L6
- **Submit and withdraw (2026-11-23):** until photos exist (T3.2), the API counts 0 photos for
  every property, so nothing can be submitted outside the tests. Withdrawing is allowed at the
  draft limit; a passed available-from date doesn't block submitting. → L1, L2, L13
- **Drafts (2026-11-23):** a draft may be half-filled; everything is required to submit except
  size, floor, amenities and the typed neighbourhood name (landmark and owner/representative are
  required). At most 10 drafts per user (config). Generous upper limits on bedrooms, bathrooms,
  floor, size and rent, each with its own error code. A later task cleans up drafts untouched for
  a long time (T6.5). → L1, L2, L13
- **Neighbourhood management (2026-11-09):** the reviewed list is seeded as it is; staff add,
  rename (English and Amharic) and deactivate neighbourhoods (hidden from the picker, existing
  listings keep them); never hard-deleted; all audited. → G7, G8
- **T-1** S3-compatible storage, MinIO for development (changed 2026-11-24 to SeaweedFS: MinIO
  stopped publishing community images, and two buckets for P5), Cloudflare R2 in the production
  comparison. **T-2** The review page is one static page. **T-3** "Rented" without picking the
  tenant until Phase 3. **T-4** You create the Firebase project; Claude gives you the exact setup
  steps at that task.
