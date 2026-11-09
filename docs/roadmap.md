# Roadmap — from Phase 1 to launch

Draft, 2026-11-09. This file sets the **order of work** and **what is in scope at launch**.
Product decisions live in `product-overview.md`; when a question below is answered, the answer
goes there and this file is updated to match.

## How phases work

- Before any code, each phase gets `docs/phase-N-spec.md` and `docs/phase-N-tasks.md`.
- A phase covers both the API (this repo) and its screens in the Flutter app (`rental-app`).
- The split below is a proposal, ordered by dependency: contact needs listings, and feedback,
  chat and reports need contact requests or listings to exist.

## Phases until launch

| Phase | Purpose | Main features |
| --- | --- | --- |
| **1 — Accounts and verification** (done) | Know who everyone is | Phone OTP, access/refresh tokens, Didit KYC, staff accounts, bans, audit log |
| **2 — Listings** (active) | Landlords publish homes; anyone can find them | Areas, properties, photos, listing states, weekly "still available?" checks, exact + approximate location, browse / filters / "near me", staff review of listings |
| **3 — Contact, chat and feedback** | A tenant reaches a landlord without a broker | Contact requests and quota, landlord accepts or declines, **chat from an accepted contact request**, revealing the phone number and exact location, viewing feedback, "Rented" + the tenant's confirmation |
| **4 — Reports and trust** | Dishonest listers lose access | Reports, the landlord's response, moderator decision, strikes (three → ban on the verified identity), anti-fraud rules (overview §4) |
| **5 — Launch preparation** | Safe to run in public | Deployment checklist (overview §14), lost-SIM account move (overview §5, not built in Phase 1), pre-launch review with you (below), live tests of the remaining documents |

Phase 4 is on the launch path only if question Q8 says so.

## How the main entities connect

```
users ──(as lister)──► properties ──► listings ──► availability_checks
                         ├─► property_photos  │
                         └─► areas            ├─► rentals (landlord + tenant confirm)
                                              │
users ──(as tenant)──► contact_requests ◄─────┘
                         ├─► chat              (starts once the request is accepted)
                         ├─► viewings          (only if scheduling is in — Q1)
                         └─► viewing_feedback

reports (about a listing and/or a user) ──► strikes (upheld reports only)
    ──► 3 strikes: ban on the verified identity (banned_identities, Phase 1)
```

- **Landlord and tenant are activities, not roles:** one account can do both (overview §3).
- **A property is the physical home; a listing is one period of availability.** Relisting
  creates a new listing on the same property, so history is kept (overview §6).
- **A contact request links one tenant to one listing.** Chat, viewings and feedback hang off
  it, so every conversation and every piece of feedback belongs to a specific listing.
- **Bans attach to the verified identity (ID hash), not the phone number.** A ban hides the
  user's listings (overview §6).
- Chat's tables are not designed yet; overview §12 gives the technical direction
  (WebSocket gateway, Redis, FCM).

## Needed for launch vs later

| Needed for launch | Later |
| --- | --- |
| Phases 1, 2, 3 and 5 | Public reviews from confirmed rentals (much later, if ever) |
| Chat (decided 2026-11-09 — overview §10 still says "later") | Contract + woreda registration kit |
| Phase 4 — **if Q8 says so** | Landlord tools (rent tracking, receipts) |
| A way to notify users — **Q4** | Tenant Search Pass, featured listings |
| | Commission, assisted rental, rent collection, payments (Chapa / Telebirr). A lawyer must check brokerage licensing (Proclamation 1357/2024) before any per-deal commission. |
| | Public listing web pages (sharing, Google), Telegram channel |
| | Saved searches, favourites |

**Not yet placed:**
- viewing scheduling and preset messages (Q1);
- push notifications (Q4);
- the Next.js web admin (Q9).

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

## Questions for you

**Contact and viewings**
- **Q1.** Are viewing scheduling and preset messages needed at launch? The overview disagrees
  with itself: §8 puts them in the first version of contact requests, but the §10 table says
  "Phase after MVP".
- **Q2.** When does a tenant get the landlord's phone number, and when the exact location?
  Both are currently tied to a "confirmed viewing". With chat at launch: on acceptance, after a
  viewing is agreed, or never (chat only)?
- **Q3.** Is there a contact quota at launch, and how big? The "3 contacts per month" free tier
  is in the monetization section, which comes later.

**Chat**
- **C1.** What does accepting look like? Can the landlord also decline? Does an unanswered
  request expire, and after how long? Is there a limit on open requests per listing?
- **C2.** What can be sent: text only, or also photos, voice notes or a location?
- **C3.** Phone numbers and links typed into chat: allowed, or hidden until a later point?
  Brokers and scammers try to move conversations off the app.
- **C4.** Can staff read a chat always, or only when a report about it is opened?
- **C5.** What happens to a chat when the listing is rented or removed, or when a user is
  banned? How long are messages kept?
- **C6.** Can a user block the other person, or report a message, from inside the chat?
- **C7.** Do the preset messages (§8) become quick replies inside chat?

**Notifications**
- **Q4.** How do we reach users at launch? Weekly freshness checks, feedback prompts and new chat
  messages all need a channel, but push (FCM) is listed as "later". Push, SMS (paid per
  message), or in-app only? Phase 2 already needs this for the freshness checks.

**Listings**
- **Q5.** Does every listing go through staff review (`pending_review`), or only flagged ones?
- **Q6.** Which anti-fraud rules are needed at launch? Camera-only photos, photo hashing to catch
  reused images, the "more than 2 active listings in different areas" rule, "New lister"
  probation.
- **Q7.** Is the launch city Addis Ababa only? This decides which areas we load.

**Launch scope**
- **Q8.** Are reports and strikes needed at launch? The overview doesn't say.
- **Q9.** Is Swagger enough as the staff tool at launch, or is the web admin needed?
- **Q10.** Which app languages at launch? The OTP SMS is English only today.
- **Q11.** Lost SIM: re-verifying with the same ID moves the account to the new number
  (overview §5). Today that person would end up `blocked` as a duplicate ID. What happens to
  the old number and its logins?
