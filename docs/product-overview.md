# Product overview — broker-free rental platform (Ethiopia)

This document records every product and technical decision made so far. Sections marked
**(to design)** are agreed in direction but not yet detailed. The order of work and the launch
scope are in `roadmap.md`; each phase is detailed in its own spec (`phase-N-spec.md`).

---

## 1. The problem

- Tenants in Addis Ababa typically pay a broker (delala) about **one month's rent**, plus
  several months of rent in advance to the landlord.
- Listings are scattered across Telegram channels, Facebook groups, street signs and word of
  mouth. Many are stale, fake, or posted by brokers pretending to be owners.
- Existing apps are either agent-led (brokers moved online), focused on expensive housing, or new
  "no broker" apps with little traction and **no owner verification**.
- Addis Ababa now requires rent contracts to be registered at the woreda (Directive 7/2024).

## 2. Positioning

**The verified, owner-direct rental platform with always-fresh listings.**

Differentiators:
1. **Verified identities** — every lister and every tenant who requests contact is ID-verified.
2. **Always-fresh listings** — weekly "still available?" checks; silent listings are hidden.
3. **Tenant feedback after viewings** — the real ownership/honesty check.
4. **Mass-market focus** — rooms, condos and small houses, not only luxury housing.
5. **Fair monetization** — never sell search ranking to brokers.

## 3. Users and roles

- **App users** have one account type. "Landlord" and "tenant" are **not roles** — they are
  activity. A user with listings is acting as a landlord; a user making contact requests is
  acting as a tenant. The same person can be both.
- **What a user can do** depends on state, not role: verified or not, account status
  (`active` / `suspended` / `banned`), ownership of the listing, quotas.
- **Staff** are a separate system: `admin_users` table, separate login and JWT secret.
  Roles: `support` (read-only), `moderator` (verifications, reports, strikes, hiding listings),
  `super_admin` (everything + staff management + lifting bans).
- Every staff action that changes data is logged in `admin_actions`.

### Permission rules (by action)

| Action | Rule |
| --- | --- |
| Browse listings | Anyone, no account |
| Draft a listing | Logged in |
| Publish a listing | Verified + active + under active-listing limit; goes live only after staff review |
| Edit/remove a listing | Verified + is the lister |
| Request a contact | Verified + active + has quota |
| Report a listing | A tenant (who exactly counts as one: to design) |
| Give viewing feedback | Is the tenant on that contact request |
| Confirm a rental | Is the landlord or tenant on that listing |

## 4. Trust model

Three separate layers:

| Layer | Question | How |
| --- | --- | --- |
| Phone | Real, reachable account? | SMS OTP at sign-up |
| Identity | Real person, and who? | Didit KYC: ID document + passive liveness + face match |
| Trust | Honest on this platform? | Behaviour rules, viewing feedback, reports, strikes |

- **Ownership documents are NOT required.** Ethiopian ownership papers are too varied (title
  deed, condo certificate, kebele house, power of attorney). Instead:
  - the verified lister's real name is shown on listings,
  - tenants confirm after a viewing who they met (owner / representative / broker / unsure),
  - behaviour rules flag suspicious listers,
  - bans attach to the verified identity (ID number hash), so a new phone number doesn't help.
- **Representatives** (e.g. a brother listing for an owner abroad) list honestly with
  `lister_relation = representative`; the listing shows it. A mismatch between what the listing
  claims and what the tenant reports is itself a flag.

### Anti-fraud layers for listings (to design in detail)

At launch (decided 2026-11-09): photo hashing and the 2-active-listings rule. Camera-only photos
are not at launch, and probation is covered by staff reviewing every listing.

- **Not at launch:** camera-only photos in the app (no gallery uploads); record capture time and GPS.
- **At launch:** perceptual hash (`phash`) on every photo to catch reused images; later, seed
  hashes from public Telegram rental channels.
- **At launch:** behaviour rule: one person with more than 2 active listings in different areas →
  review. (Whether at launch this is a review flag or a hard limit of 2: to confirm in the
  Phase 2 spec.)
- **Not at launch (covered by staff reviewing every listing):** probation for new listers: first
  listing labelled "New lister" with limited contact requests until a positive feedback arrives.

## 5. Identity verification (Phase 1 — see spec)

- Provider: **Didit**. Self-serve, no government relying-party process needed. 500 free
  checks/month per feature; ~USD 0.33 per full KYC afterwards (paid by virtual dollar card once
  past the free tier).
- **Accepted documents:** the **Fayda** national ID is the primary document. **Passports**
  (Ethiopian or foreign) are the single alternative, for diaspora and foreigners. Kebele IDs and
  driving licences are **not** accepted: kebele numbers aren't nationally unique and the formats
  vary too much to anchor a ban or a duplicate check on.
- **Lazy verification:** nobody verifies at sign-up. Landlords verify before a listing goes live;
  tenants verify before their first contact request.
- The provider answers "is this a real person?"; **our system** answers "is this person allowed
  here?" (age 18+, duplicate ID, banned ID).
- Verified name and date of birth are locked after approval.
- Lost SIM / new phone: re-verify; matching ID hash moves the account to the new number.
  Decided 2026-11-09: this logs out every session on the old number and frees the old number.
  Needed at launch; not built in Phase 1 (today the second sign-up ends up `blocked` as a
  duplicate ID).
- We never build our own liveness or document-fraud detection.

## 6. Listings (to design)

- **Property vs listing:** a property is the physical unit; a listing is one period of
  availability. Relisting creates a new listing on the same property, keeping history.
- **Listing states:** `draft → pending_review → live → stale → expired`, plus `rented`,
  `removed`, `rejected`. Every transition is timestamped.
- **Staff review (decided 2026-11-09):** at launch, every listing goes through staff review
  (`pending_review`) before it goes live.
- **Freshness rule:** every 7 days, ask the lister "still available?". No answer in 48 hours →
  `stale` (hidden; one tap restores it). Stale for 30 days → `expired` (must re-check details).
  The question is sent by push notification (see §12).
- **Launch city (decided 2026-11-09):** Addis Ababa only.
- **Rented:** lister taps "Rented" and picks the tenant; the tenant confirms → a `rentals` row.
- Price: `monthly_rent_birr` (integer) and `advance_months` (integer) are separate fields.
- Banning a user must hide all their listings.

## 7. Location and maps (to design)

- The landlord sets the location by GPS ("I'm at the property now") or by dragging a pin, plus a
  plain-language **landmark** field.
- Two points stored on the property: `location` (exact) and `approx_location` (randomly shifted
  200–400 m, generated **once** and stored).
- The API returns the exact point only to a tenant whose **contact request the landlord has
  accepted** (decided 2026-11-09; previously "confirmed viewing"); everyone else sees the
  approximate area.
- Directions: open Google Maps via URL (`https://www.google.com/maps/dir/?api=1&destination=LAT,LNG`)
  with `url_launcher`. No API key needed.
- In-app map: `flutter_map` + an OpenStreetMap-based tile provider (avoid Google billing early).
- Areas: a clean `areas` table (city, sub-city, neighbourhood) for filters; PostGIS for "near me".

## 8. Contact requests, viewings and feedback (to design)

- A verified tenant requests contact; the landlord sees the tenant's verified name.
- **At launch (decided 2026-11-09):**
  - the landlord accepts the contact request; acceptance reveals the landlord's phone number and
    the exact location to the tenant, and a chat starts from the accepted request;
  - requests are limited by a **contact quota**; the number is a config value.
- **After launch:** viewing scheduling + preset messages ("Is it still available?",
  "Is water included?", "Running late").
- **Viewing feedback:** 24–48 h after a viewing, three one-tap questions: Did you view it? Who
  did you meet (owner / representative / broker / unsure)? Was it as described? Repeat once at day 5.
  Prompts are sent by push notification. Without viewing scheduling at launch, what starts the
  24–48 h clock is still to decide.
- **Getting feedback answered:** before revealing the next contact, ask about the last viewing;
  answering can earn back a free contact. A landlord marking "Rented" triggers a confirmation
  request to the tenant.
- One negative feedback never punishes automatically; it opens a report.

## 9. Reports, moderation and strikes (to design)

- **At launch, kept simple (decided 2026-11-09):** a tenant reports a listing, staff decide, and
  staff can use the existing ban (Phase 1, S5). **Automatic strikes come later.**
- Reports have a reason (fake listing, broker, wrong price, already rented, scam, other).
- The landlord can respond; a moderator decides (`upheld` / `dismissed`).
- Later: only an upheld report creates a strike. **Three strikes → ban** on the verified identity.

## 10. Future features (roadmap)

Order of work and the full launch scope: `roadmap.md`.

| Feature | When |
| --- | --- |
| Viewing feedback (private) | Launch |
| Full in-app chat (WebSocket gateway, Redis, FCM), starting from an accepted contact request | Launch (decided 2026-11-09) |
| Push notifications (FCM): freshness checks, feedback prompts, chat messages | Launch (decided 2026-11-09) |
| Reports, decided by staff (no automatic strikes) | Launch (decided 2026-11-09) |
| Viewing scheduling + preset messages | After launch (decided 2026-11-09) |
| Automatic strikes (three upheld reports → ban) | Later |
| Public reviews, only from confirmed rentals, double-blind | Much later, if ever |
| Contract + woreda registration kit | After launch |
| Landlord tools (rent tracking, receipts) | Later |

## 11. Monetization (later)

- The contact quota exists at launch, free, with the number as a config value (decided
  2026-11-09); paid passes come later.
- Free until trusted. Then: **Tenant Search Pass** (~Br 199–399 / 30 days; free tier of 3
  contacts/month), contract kit (~Br 150–300), featured listing for verified owners only
  (~Br 100–200/week).
- After trust and a legal check: assisted rental (20–30% of one month's rent), landlord tools
  subscription, rent collection (Chapa / Telebirr).
- Charge before contact, not commission after the deal (commissions leak offline).
- Brokerage licensing (Proclamation 1357/2024) must be checked with a lawyer before any
  per-deal commission.

## 12. Technical stack

- **API:** NestJS + TypeORM + PostgreSQL/PostGIS + Redis
- **Mobile:** one Flutter app for both landlords and tenants (separate repo). Languages at
  launch: English and Amharic (decided 2026-11-09).
- **Admin:** Swagger UI, plus a very small web page for reviewing listings (with photos) before
  launch (decided 2026-11-09); a proper web admin (Next.js) later
- **Public listing pages:** server-rendered web pages for sharing links and Google indexing (later)
- **Telegram:** a channel that auto-posts new verified listings, for marketing only (later)
- **Push:** Firebase Cloud Messaging, at launch (decided 2026-11-09): freshness checks, feedback
  prompts and chat messages
- **SMS:** for OTP only. Local SMS gateway behind an interface; logged to console in development
- **Development webhooks:** ngrok (fixed URL) or Cloudflare quick tunnel; plus a background job
  that polls Didit for stuck sessions, so webhooks are not a single point of failure

## 13. Full data model (direction)

Phase 1 tables are detailed in `phase-1-spec.md`. Later tables:

- `areas` — city, sub_city, neighbourhood
- `properties` — lister_id, area_id, type, bedrooms, `location` (geography point),
  `approx_location`, landmark, `lister_relation` (owner / representative)
- `property_photos` — property_id, path, phash, captured_at, capture_location
- `listings` — property_id, monthly_rent_birr, advance_months, status, published_at,
  last_confirmed_at, expires_at, rented_at
- `availability_checks` — listing_id, sent_at, responded_at, response
- `contact_requests` — listing_id, tenant_id, created_at, requires_feedback
- `viewings` — contact_request_id, proposed/confirmed times, status (after launch, with scheduling)
- `viewing_feedback` — contact_request_id, viewed, met_person, as_described
- `rentals` — listing_id, tenant_id, landlord_confirmed_at, tenant_confirmed_at
- `reports` — reporter_id, listing_id, reported_user_id, reason, details, status,
  landlord_response, decision, handled_by, handled_at
- `strikes` — user_id, report_id, issued_by, created_at (later, with automatic strikes)
- `saved_searches`, `favorites`, `devices` (push tokens), `amenities` + pivot
- Later: `subscriptions`, `payments`

## 14. Deployment checklist

Things that are fine for local development but must be settled before (or when) we deploy.

- **Trust the reverse proxy for client IPs.** The API doesn't trust `X-Forwarded-For` yet. Behind
  Nginx/Caddy (or any load balancer), every request then appears to come from the proxy, so **all
  users share one rate-limit bucket** and per-IP limits (including A8) stop working. Add a
  `TRUST_PROXY` setting and set Express's `trust proxy` to exactly the proxy hop(s) we run —
  never `true` blindly, or clients can spoof their IP.
- **Rate-limit storage is in memory, per process.** Fine for a single instance. With more than one
  instance (or across restarts) each process counts separately, so limits are effectively
  multiplied. Move the throttler to Redis-backed storage before running more than one instance.
  Limits that must survive restarts (e.g. the per-phone OTP limit, A3) are counted from the
  database, not the throttler.
- **Postgres extensions need privileges.** The first migration runs `CREATE EXTENSION postgis`
  and `pgcrypto`, which needs superuser or the host's equivalent (e.g. a managed provider's
  extension allow-list).
- **Choose and integrate a real SMS provider before deploying with NODE_ENV=production.** The app
  refuses to start in production with `SMS_PROVIDER=console`, which logs OTP codes.
- **Verification start holds a DB connection during the Didit call (up to 10 s); review pool size and
  consider moving the Didit call outside the transaction before traffic grows.**
- **Add two-factor authentication (TOTP) for staff accounts before production.**
- **The production DB user must not have TRUNCATE (or UPDATE/DELETE) on admin_actions.**
- **Test the production /docs HTTP Basic login end to end once a real SMS provider allows
  NODE_ENV=production.**
- **Test the documents T2.9 didn't, in the live Didit app** (`docs/didit-integration.md` §5):
  - **The printed paper Fayda credential and the digital Fayda** are genuine Fayda documents
    that many people use, so the goal is for them to be **accepted**. The test finds out whether
    Didit accepts them. If Didit rejects them (its document-liveness check may treat a printout
    or a screen as a copy), we need a **product decision before launch**.
  - **A kebele ID and a driving licence** must be rejected (or at worst land in
    `manual_review`), never `approved`.
- **Swagger in production.** Off unless `SWAGGER_ENABLED=true`; if enabled, the `/docs` page must
  be behind staff auth first (T3.1).
