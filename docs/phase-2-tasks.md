# Phase 2 tasks

Spec: `docs/phase-2-spec.md`. One task at a time, each with a plan first and tests for its rules
(see `CLAUDE.md`). Every task that adds or changes an endpoint also updates
`docs/manual-testing.md`, the Postman collection and `docs/api-for-mobile.md`. After each task:
a detailed explanation of how it works and why (CLAUDE.md "Current mode").

Before writing integration code, read the real docs: the AWS SDK v3 S3 client and MinIO, `sharp`,
the perceptual-hash library, `firebase-admin` / FCM HTTP v1.

## Step 0 — Inputs from you

- [x] **T0.1 Review the neighbourhood list.** `docs/addis-ababa-neighbourhoods.md`: sub-city
      assignments, spellings, Amharic names. Done 2026-11-09: mostly correct, not complete;
      seeded as it is.

## Step 1 — Areas

- [x] **T1.1 Sub-cities and neighbourhoods.** Entities, migration, seed from the reviewed list;
      `GET /areas` (G7); tests.
- [x] **T1.2 Staff manage neighbourhoods.** Add, list, rename, deactivate, reactivate; never
      delete; new audit types and detail keys (G7, G8, S1); tests. (`propertyId` on add moved to
      T4.3: properties don't exist yet.)
- [x] **T1.3 Service area.** Get the Addis Ababa boundary from OpenStreetMap, check the licence and
      the attribution it needs, load it in a migration (`service_area`); an `isInsideServiceArea`
      check (G1); tests with points inside, outside and near the edge. Done 2026-11-10: relation
      1707699 v25, strict (no margin); `ServiceAreaService.isInside(lat, lng)`.

## Step 2 — Properties and listings

- [x] **T2.1 Entities and migration.** `properties`, `listings`, `listing_history`, all enums as
      Postgres enums, the L10 partial unique index, the GiST index on `approx_location`.
      Done 2026-11-23: drafts may be half-filled; `listings.version` added (R2); history rows
      can't be updated.
- [x] **T2.2 Drafts.** `POST /listings`, `PATCH` (draft only for now), `DELETE` a draft,
      `GET /me/listings`; field validation (section 2, L13), ownership (L3), the service-area check
      and `approx_location`, "my neighbourhood isn't listed" (G1, G2); tests.
      - `LOCATION_OUTSIDE_SERVICE_AREA`: record the refused pin in `out_of_area_demand` (table and
        migration here), rounded to 0.01° by day, no user link; `api-for-mobile.md` tells the app
        to show "We're only in Addis Ababa for now". Tests: the row is written, rounded, and holds
        nothing that identifies the user.
      - Done 2026-11-23: also the draft limit (`MAX_DRAFT_LISTINGS`, 409 `DRAFT_LISTING_LIMIT`),
        upper limits with their own codes (`listing-limits.ts`), `missing` on every listing.
- [x] **T2.3 Submit and withdraw.** L2 (verified, complete, 3+ photos — tested with a fake photo
      count until Step 3 — and the cap), L4, `listing_history` rows; tests.
      Done 2026-11-23: `PhotoCounter` answers 0 until T3.2 (which must replace `NoPhotosYet`).
- [x] **T2.4 Editing after submission.** L5 and L6 (which fields send a listing back to review,
      rent and available-from recorded, `needs_review` on expired, reopen); tests for each field
      group and state. Done 2026-11-24, with the never-approved and expired-in-review rules (L6).
- [x] **T2.5 Close and relist.** L11, L12 (`close`, the three reasons, relist copying fields);
      tests.
      Done 2026-11-24, with `rented_in_app` only after publishing (400
      `RENTED_IN_APP_NEVER_PUBLISHED`) and a rejected listing blocking relisting.

## Step 3 — Photos

- [ ] **T3.1 Storage.** `PhotoStorage` interface, the S3-compatible implementation, MinIO in
      Docker Compose (with a healthcheck, like Postgres and Redis), public URLs for live photos and
      signed links otherwise (P5), new env variables in `.env.example` and config validation;
      tests against MinIO.
- [ ] **T3.2 Upload pipeline.** Upload, delete, reorder; type and size checks, at most 12, the
      3-photo floor on delete (P1, P4); re-encoding and removing all metadata (P2); tests,
      including a JPEG with EXIF GPS. Replace `NoPhotosYet` (T2.3) with a count of
      `property_photos`. Photo changes follow L5 like any field that needs review: +1 `version`;
      a live or stale listing goes back to review, an expired one gets `needs_review`.
- [ ] **T3.3 Photo hashing.** Choose the library after reading its docs; test it on resized and
      recompressed copies and on different photos; set `PHOTO_HASH_MAX_DISTANCE` from the results;
      match only other listers' photos (P3); tests.

## Step 4 — Staff review

- [ ] **T4.1 Queue and detail.** `GET /admin/listings`, `GET /admin/listings/:id` with the four
      flags (R1), the exact point, landmark and history; tests.
- [ ] **T4.2 Approve, reject, take down.** R2–R6, reason codes, `version` check, `listerNote`
      added to the audit allow-list (S1); tests.
- [ ] **T4.3 Review web page.** The static page at `/admin/review`, including "add
      neighbourhood" for an unlisted one, with `propertyId` on `POST /admin/neighbourhoods`
      moving that property to the new neighbourhood and clearing its typed name (G7); checked by
      hand with real photos.

## Step 5 — Browse and search

- [ ] **T5.1 Browse.** `GET /listings` with filters, sorts, near me and cursor pagination (G4,
      G5); tests, including that results and distances come only from `approx_location`.
- [ ] **T5.2 Detail and the lister's name.** `GET /listings/:id` (G3, G6) and the public name
      (L7). First check, on your own approved account, the word order and letter case of
      `users.full_name` as Didit returned it (so "first name + father's initial" picks the right
      words); tests.

## Step 6 — Push and freshness

- [ ] **T6.1 Push foundation.** `PushSender`, the console sender, `POST /me/devices`,
      `DELETE /me/devices/:id`, the text file in English and Amharic (Claude drafts the Amharic;
      you review it) (N1–N4); tests.
- [ ] **T6.2 FCM sender.** Before this task, Claude gives you the exact Firebase setup steps
      (project, Android and iOS apps, service account) (T-4). Then the FCM implementation,
      deleting invalid tokens (N2); checked on a real phone.
- [ ] **T6.3 Freshness job.** F1–F6: checks, the answer endpoint with closing reasons, stale,
      restore, expiry; tests with the clock moved and the job run twice.
- [ ] **T6.4 Review notices.** Push on approve, reject and takedown, with the reason code (N5);
      tests.
- [ ] **T6.5 Clean up untouched drafts** (added 2026-11-23). Drafts nobody has edited for a long
      time hold photos in storage (from Step 3). Before this task, decide with the user: after
      how long, whether the lister is warned first (push), and whether `updated_at` is the right
      "last touched". Then a job that deletes them with their photos (from storage too); tests
      with the clock moved and the job run twice.

## Step 7 — Bans

- [ ] **T7.1 Ban and unban with listings.** The ban expires open listings and deletes devices;
      unban leaves listings expired (L8, N2); browse hides non-active listers; tests. The T2.4
      test "live → edit → pending_review → ban → unban → reopen" expires the listing with SQL
      for now: drop that line once the ban does it.

## Step 8 — Flutter app (repo: `rental-app`)

- [ ] **T8.1 Create and manage listings.** Form, photos, pin / GPS, area pickers, submit, my
      listings with all actions.
- [ ] **T8.2 Browse.** List, map, filters, near me, detail.
- [ ] **T8.3 Push.** Token registration, the weekly-check screen, notices.
- [ ] **T8.4 Amharic.** All Phase 2 strings (Claude drafts, you review).
- [ ] **T8.5 End to end on a real phone**, through the tunnel.

---

## Phase 2 is done when

- Every box above is ticked.
- You created a listing on your phone with real photos, approved it on the review page, and
  found it in the app without an account.
- You received a weekly check as a push notification, let a listing go stale, and restored it.
- A downloaded public photo has no metadata, and nothing public reveals the exact point or the
  landmark.
