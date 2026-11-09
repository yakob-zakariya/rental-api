# Roadmap — from Phase 1 to launch

Updated 2026-11-09. This file sets the **order of work** and **what is in scope at launch**.
Product decisions live in `product-overview.md`; when a question below is answered, the answer
goes there and this file is updated to match.

## How phases work

- Before any code, each phase gets `docs/phase-N-spec.md` and `docs/phase-N-tasks.md`.
- A phase covers both the API (this repo) and its screens in the Flutter app (`rental-app`).
- Every screen ships in **English and Amharic**.
- The split below is ordered by dependency: contact needs listings, and feedback, chat and
  reports need contact requests or listings to exist.

## Phases until launch

| Phase | Purpose | Main features |
| --- | --- | --- |
| **1 — Accounts and verification** (done) | Know who everyone is | Phone OTP, access/refresh tokens, Didit KYC, staff accounts, bans, audit log |
| **2 — Listings** (active) | Landlords publish homes; anyone can find them | Addis Ababa areas, properties, photos with photo hashing (reused images), listing states, **staff review of every listing** with a small review web page, the 2-active-listings rule, weekly "still available?" checks by **push (FCM)**, exact + approximate location, browse / filters / "near me" |
| **3 — Contact, chat and feedback** | A tenant reaches a landlord without a broker | Contact requests with a **quota** (config value); the landlord accepts, which reveals the **phone number and exact location** and **starts a chat**; push for new messages; viewing feedback prompts by push; "Rented" + the tenant's confirmation |
| **4 — Reports** | Tenants can flag a bad listing to staff | A tenant reports a listing, staff decide, staff can use the existing ban (Phase 1). No automatic strikes. |
| **5 — Launch preparation** | Safe to run in public | Deployment checklist (overview §14, including a real SMS provider); lost-SIM account move; pre-launch review with you (below); live tests of the remaining documents |

## How the main entities connect

```
users ──(as lister)──► properties ──► listings ──► availability_checks
  │                      ├─► property_photos  │
  │                      └─► areas            ├─► rentals (landlord + tenant confirm)
  │                                           │
  ├──(as tenant)──► contact_requests ◄────────┘
  │                   ├─► chat              (starts when the landlord accepts)
  │                   └─► viewing_feedback
  │
  └─► devices (push tokens)

reports (a tenant, about a listing) ──► staff decision ──► optionally the existing ban
    (bans attach to the verified identity: banned_identities, Phase 1)
```

- **Landlord and tenant are activities, not roles:** one account can do both (overview §3).
- **A property is the physical home; a listing is one period of availability.** Relisting
  creates a new listing on the same property, so history is kept (overview §6).
- **A contact request links one tenant to one listing.** Acceptance, chat and feedback hang off
  it, so every conversation and every piece of feedback belongs to a specific listing.
- **Bans attach to the verified identity (ID hash), not the phone number.** A ban hides the
  user's listings (overview §6).
- Chat's tables are not designed yet; overview §12 gives the technical direction
  (WebSocket gateway, Redis, FCM).

## Needed for launch vs later

| Needed for launch | Later |
| --- | --- |
| Phases 1–5 | Viewing scheduling + preset messages |
| Chat, from an accepted contact request | Automatic strikes (three upheld reports → ban) |
| Push notifications (FCM); SMS for OTP only | Camera-only photos; "New lister" probation (covered by reviewing every listing) |
| Staff review of every listing; Swagger + a small listing-review page | Next.js web admin |
| Photo hashing; the 2-active-listings rule | Seeding photo hashes from Telegram rental channels |
| Simple reports decided by staff | Public reviews from confirmed rentals (much later, if ever) |
| Contact quota (free, config value) | Tenant Search Pass, featured listings |
| English and Amharic | Other languages (`om` is already in `preferred_language`); other cities |
| Addis Ababa only | Contract + woreda registration kit; landlord tools |
| Lost-SIM account move | Commission, assisted rental, rent collection, payments (Chapa / Telebirr). A lawyer must check brokerage licensing (Proclamation 1357/2024) before any per-deal commission. |
| | Public listing web pages, Telegram channel, saved searches, favourites |

## Pre-launch review with you (Phase 5)

A focused session where we walk through the two pieces of code that are hardest to fix after
launch, until you can explain them out loud. This also closes Phase 1's last "done when" item.

- **Didit webhook** (`src/modules/verification/webhook.controller.ts`, `webhook.service.ts`,
  `didit/`, `decision/`):
  - signature check (`X-Signature-V2`, plus `-Previous` while the secret is being rotated);
  - processing each event once;
  - turning Didit's decision into our statuses;
  - the polling job that backs the webhook up.
- **ID hashing** (`src/modules/verification/identity-hasher.ts`): normalisation and the
  `kind:`-prefixed HMAC (hard rule 2, spec V10). It must never change after launch, or existing
  hashes stop matching and duplicate and ban checks fail silently.

## Decided 2026-11-09

Details are in `product-overview.md`.

- **Q1** Viewing scheduling and preset messages: after launch.
- **Q2** Phone number and exact location: revealed when the landlord accepts the contact request.
- **Q3** Contact quota: yes at launch; the number is a config value.
- **Q4** Notifications: push (FCM) for freshness checks, feedback prompts and chat; SMS for OTP only.
- **Q5** Every listing goes through staff review.
- **Q6** Anti-fraud: photo hashing and the 2-active-listings rule; no camera-only photos;
  probation covered by staff review.
- **Q7** Addis Ababa only.
- **Q8** Simple reports (a tenant reports a listing, staff decide, existing ban); automatic
  strikes later.
- **Q9** Swagger plus a very small listing-review web page with photos.
- **Q10** English and Amharic.
- **Q11** Lost SIM: re-verifying with the same ID on a new number logs out every session on the
  old number and frees it.
- Chat is needed at launch and starts from an accepted contact request.

## Open questions

**Chat (Phase 3)**
- **C1.** What does accepting look like? Can the landlord also decline? Does an unanswered
  request expire, and after how long? Is there a limit on open requests per listing?
- **C2.** What can be sent: text only, or also photos, voice notes or a location?
- **C3.** Phone numbers and links typed into chat: allowed, or hidden until a later point?
  Brokers and scammers try to move conversations off the app.
- **C4.** Can staff read a chat always, or only when a report about it is opened?
- **C5.** What happens to a chat when the listing is rented or removed, or when a user is
  banned? How long are messages kept?
- **C6.** Can a user block the other person, or report a message, from inside the chat?
- **C7.** Do the preset messages (§8) become quick replies inside chat? (Preset messages are
  after launch, Q1.)

**Raised by the answers above**
- **Q12 (Phase 3).** Feedback is asked "24–48 h after a viewing", but without scheduling there
  is no viewing record. What starts the clock: the landlord's acceptance, or something else?
- **Q13 (Phase 5).** The OTP SMS is English only. Should it be in Amharic too? When someone
  requests a code for the first time we don't know their language yet.
- **Q14 (Phase 4).** Who can report a listing: any signed-in user, a verified one, or only a
  tenant with a contact request on it? Can the landlord respond to a report?
- Phase 2 questions (for example the exact meaning of the 2-active-listings rule) are in
  `phase-2-spec.md`.
