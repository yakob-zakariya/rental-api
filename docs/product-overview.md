# Product overview — broker-free rental platform (Ethiopia)

This document records every product and technical decision made so far. Sections marked
**(to design)** are agreed in direction but not yet detailed. Phase 1 only builds a small part
of this — see `phase-1-spec.md`.

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
| Publish a listing | Verified + active + under active-listing limit |
| Edit/remove a listing | Verified + is the lister |
| Request a contact | Verified + active + has quota |
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

- Camera-only photos in the app (no gallery uploads); record capture time and GPS.
- Perceptual hash (`phash`) on every photo to catch reused images; later, seed hashes from
  public Telegram rental channels.
- Behaviour rule: one person with more than 2 active listings in different areas → review.
- Probation for new listers: first listing labelled "New lister" with limited contact requests
  until a positive feedback arrives.

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
- We never build our own liveness or document-fraud detection.

## 6. Listings (to design)

- **Property vs listing:** a property is the physical unit; a listing is one period of
  availability. Relisting creates a new listing on the same property, keeping history.
- **Listing states:** `draft → pending_review → live → stale → expired`, plus `rented`,
  `removed`, `rejected`. Every transition is timestamped.
- **Freshness rule:** every 7 days, ask the lister "still available?". No answer in 48 hours →
  `stale` (hidden; one tap restores it). Stale for 30 days → `expired` (must re-check details).
- **Rented:** lister taps "Rented" and picks the tenant; the tenant confirms → a `rentals` row.
- Price: `monthly_rent_birr` (integer) and `advance_months` (integer) are separate fields.

## 7. Location and maps (to design)

- The landlord sets the location by GPS ("I'm at the property now") or by dragging a pin, plus a
  plain-language **landmark** field.
- Two points stored on the property: `location` (exact) and `approx_location` (randomly shifted
  200–400 m, generated **once** and stored).
- The API returns the exact point only to a tenant with a **confirmed viewing**; everyone else
  sees the approximate area.
- Directions: open Google Maps via URL (`https://www.google.com/maps/dir/?api=1&destination=LAT,LNG`)
  with `url_launcher`. No API key needed.
- In-app map: `flutter_map` + an OpenStreetMap-based tile provider (avoid Google billing early).
- Areas: a clean `areas` table (city, sub-city, neighbourhood) for filters; PostGIS for "near me".

## 8. Contact requests, viewings and feedback (to design)

- A verified tenant requests contact; the landlord sees the tenant's verified name.
- **Phase 1 of this feature:** viewing scheduling + preset messages ("Is it still available?",
  "Is water included?", "Running late"). Phone number revealed once a viewing is confirmed.
- **Viewing feedback:** 24–48 h after a viewing, three one-tap questions: Did you view it? Who
  did you meet (owner / representative / broker / unsure)? Was it as described? Repeat once at day 5.
- **Getting feedback answered:** before revealing the next contact, ask about the last viewing;
  answering can earn back a free contact. A landlord marking "Rented" triggers a confirmation
  request to the tenant.
- One negative feedback never punishes automatically; it opens a report.

## 9. Reports, moderation and strikes (to design)

- Reports have a reason (fake listing, broker, wrong price, already rented, scam, other).
- The landlord can respond; a moderator decides (`upheld` / `dismissed`).
- Only an upheld report creates a strike. **Three strikes → ban** on the verified identity.

## 10. Future features (roadmap)

| Feature | When |
| --- | --- |
| Viewing feedback (private) | MVP |
| Viewing scheduling + preset messages | Phase after MVP |
| Full in-app chat (WebSocket gateway, Redis, FCM) | Later |
| Public reviews, only from confirmed rentals, double-blind | Much later, if ever |
| Contract + woreda registration kit | After MVP |
| Landlord tools (rent tracking, receipts) | Later |

## 11. Monetization (later)

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
- **Mobile:** one Flutter app for both landlords and tenants (separate repo)
- **Admin:** Swagger UI in Phase 1; a proper web admin (Next.js) later
- **Public listing pages:** server-rendered web pages for sharing links and Google indexing (later)
- **Telegram:** a channel that auto-posts new verified listings, for marketing only (later)
- **Push:** Firebase Cloud Messaging (later)
- **SMS OTP:** local SMS gateway behind an interface; logged to console in development
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
- `viewings` — contact_request_id, proposed/confirmed times, status
- `viewing_feedback` — contact_request_id, viewed, met_person, as_described
- `rentals` — listing_id, tenant_id, landlord_confirmed_at, tenant_confirmed_at
- `reports` — reporter_id, listing_id, reported_user_id, reason, details, status,
  landlord_response, decision, handled_by, handled_at
- `strikes` — user_id, report_id, issued_by, created_at
- `saved_searches`, `favorites`, `devices` (push tokens), `amenities` + pivot
- Later: `subscriptions`, `payments`
