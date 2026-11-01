# Didit integration notes

What we confirmed from Didit's documentation (read 2026-10-30), how our Didit applications are
configured, and what is still open. The spec (`docs/phase-1-spec.md`) and `CLAUDE.md` win over
anything here; Didit's generic "Integrate Didit" onboarding prompt is reference only.

Code: `src/modules/verification/didit/`.

---

## 1. API basics (confirmed)

| | Value | Source |
| --- | --- | --- |
| Base URL | `https://verification.didit.me` (all `/v3/...` endpoints) | [Create session](https://docs.didit.me/sessions-api/create-session) |
| Auth | `x-api-key: <DIDIT_API_KEY>` header, server-side only | [API authentication](https://docs.didit.me/getting-started/api-authentication) |
| Bad / expired / wrong-app key | **403** `{ "detail": "You do not have permission…" }` on session endpoints (401 on some management endpoints). We treat any 401/403 as "check `DIDIT_API_KEY`". | Didit onboarding guide; [Create session](https://docs.didit.me/sessions-api/create-session) |
| Rate limit | 600 successful calls/min per key or IP; 429 with `Retry-After` | [Create session](https://docs.didit.me/sessions-api/create-session) |
| OpenAPI | `https://docs.didit.me/openapi-25.json` | |

### Create a session — `POST /v3/session/`

Request (what we send):

```json
{
  "workflow_id": "<DIDIT_WORKFLOW_ID>",
  "vendor_data": "<users.id>",
  "callback": "<APP_VERIFICATION_CALLBACK_URL>",
  "expected_details": { "expected_document_types": ["ID", "P"] }
}
```

`expected_document_types` restricts which documents the user may present (`P` passport,
`ID` identity card), on top of the workflow's own document settings.

Response `201`: `session_id`, `session_number`, `session_token` (12-character URL-safe token,
not a JWT — treat as a secret), `url` (hosted flow, `https://verify.didit.me/...`; note: `url`,
not `verification_url`), `status` (`"Not Started"`), plus echoed `workflow_id`,
`workflow_version`, `vendor_data`, `metadata`, `callback`. After the flow Didit redirects to
`callback` with `?verificationSessionId=…&status=…`.

**Session reuse:** only one unfinished session exists per (`workflow_id`, `vendor_data`). While it
is `Not Started`, `In Progress`, `Resubmitted` or `Awaiting User`, "create" returns **that same
session** (still `201`). Finished sessions (`In Review`, `Approved`, `Declined`, `Expired`,
`Abandoned`, `Kyc Expired`) are never reused. Our handling: a returned `session_id` we already
have is a resume — refresh `verification_url` / `session_token`, no new attempt, not counted
toward V3 (spec V2, V14).

### Get the decision — `GET /v3/session/{session_id}/decision/`

Top level: `session_id`, `status`, `vendor_data`, `workflow_id`, …, and per-feature **plural
arrays** (`id_verifications[]`, `liveness_checks[]`, `face_matches[]`, `ip_analyses[]`, …), each
item with a `node_id` and its own feature-level `status`. Source:
[Retrieve session](https://docs.didit.me/sessions-api/retrieve-session),
[Data models](https://docs.didit.me/reference/data-models).

`id_verifications[]` fields we use:

| Field | Format | Notes |
| --- | --- | --- |
| `document_type` | `"Passport"`, `"Identity Card"`, … | Human-readable class |
| `document_subtype` | e.g. `"PASSPORT_GENERIC"`, `"ID_CARD_GENERIC"` | Unknown values → treat as unclassified ([subtypes](https://docs.didit.me/core-technology/id-verification/document-subtypes-id-verification)) |
| `document_number` | string | OCR |
| `personal_number` | string | OCR "personal/national identifier" |
| `issuing_state` | **ISO 3166-1 alpha-3** (e.g. `"ESP"`, `"ETH"`) | No conversion needed for V10 |
| `date_of_birth` | `YYYY-MM-DD` | Gregorian, also for Fayda (T2.9) |
| `full_name`, `first_name`, `last_name` | string | |

**Hard rule 1:** the decision also carries short-lived presigned media URLs (`portrait_image`,
`front_image`, `back_image`, `reference_image`, `video_url`, …) and much more personal data
(address, MRZ, …). `HttpDiditClient` keeps only the fields above plus `status` / `vendor_data`
and drops everything else before returning. Raw decisions are never logged or stored.

---

## 2. Session statuses (exact strings)

Case-sensitive, from [Verification statuses](https://docs.didit.me/integration/verification-statuses).

| Didit status | Final at Didit? | Our attempt outcome (spec §4) |
| --- | --- | --- |
| `Not Started` | No | `pending` |
| `In Progress` | No | `pending` |
| `In Review` | No (Didit's own manual review) | `pending` |
| `Resubmitted` | No (user redoing steps) | `pending` |
| `Awaiting User` | No (KYB only; not expected) | `pending` |
| `Approved` | Yes | run V4–V8 |
| `Declined` | Yes | `declined` |
| `Abandoned` | Yes | `abandoned` |
| `Expired` | Yes | `expired` |
| `Kyc Expired` | Yes (approved document passed its expiry date) | no change: record `provider_status` only; user stays `approved`, no flag |

Documented transitions: `Not Started → In Progress | Expired`; `In Progress → Approved |
Declined | In Review | Awaiting User | Abandoned`; `In Review → Approved | Declined |
Resubmitted`; `Declined → Resubmitted`; `Resubmitted → Approved | Declined | In Review`;
`Approved → Kyc Expired`. Didit staff can also change a finished session with
[`PATCH /v3/session/{id}/update-status/`](https://docs.didit.me/sessions-api/update-status)
(`Approved` / `Declined` / `Resubmitted`), so `Approved → Declined` is possible (spec V15).

---

## 3. Webhooks

Source: [Webhooks](https://docs.didit.me/integration/webhooks).

**Envelope:** `event_id` (UUID, **the same on every retry** — our V11 key), `webhook_type`
(`status.updated`, `data.updated`, …), `timestamp` (refreshed on retry), `created_at`,
`application_id`, `environment` (`"live"` / `"sandbox"`), `session_id`, `status`, `vendor_data`,
`metadata`, `workflow_id`, `workflow_version`, `decision` (present for Approved, Declined,
In Review, Abandoned), `resubmit_info` (for Resubmitted).

**Delivery:** 5-second timeout; retried on 5xx, 404, timeouts and connection errors, at most
2 retries (≈1 min, then ≈4 min); 3xx/other 4xx are not retried. Retries are re-signed with a
fresh `X-Timestamp`. Return 2xx quickly.

**We subscribe to:** `status.updated` (decision processing) and `data.updated` (re-fetch the
decision and flag the attempt `DATA_UPDATED`; never change `full_name` / `date_of_birth`, V9).

### Signature recipe (implemented in `didit/webhook-signature.ts`)

1. `X-Timestamp` (Unix seconds): reject if `abs(now - X-Timestamp) > 300`.
2. Parse the JSON body, then build the **canonical JSON**:
   - whole-valued floats become integers (`100.0` → `100`; automatic in JavaScript),
   - object keys sorted recursively (arrays keep their order),
   - compact (no spaces), Unicode **unescaped** (`JSON.stringify` does both).
3. `expected = HMAC-SHA256(DIDIT_WEBHOOK_SECRET, canonical)` as lowercase hex.
4. Compare with `X-Signature-V2` in constant time. During the 24 hours after a secret rotation
   Didit also sends `X-Signature-V2-Previous` (same payload, old secret): accept a match on either.
5. Then check `environment` against `DIDIT_ENVIRONMENT` and reject a mismatch.

The secret is the destination's `secret_shared_key` (shown once when the destination is created).
Other headers: `X-Signature` signs the raw bytes (only usable before any body parser runs) and
`X-Signature-Simple` signs only `{timestamp}:{session_id}:{status}:{webhook_type}` — deprecated
and does **not** cover `decision`; if ever used, the decision must be re-fetched from the API.
Caveat: `JSON.parse` loses precision on integers above 2^53; Didit payloads aren't expected to
contain any.

Our processing order differs from Didit's sample handler on purpose: `processed_at` is set only
**after** processing succeeds (spec V11), so a failed attempt is retried.

**Our responses** (`POST /webhooks/didit`): 200 processed or duplicate; 401
`WEBHOOK_SIGNATURE_INVALID` (bad, missing or stale signature); 400 `WEBHOOK_ENVIRONMENT_MISMATCH` or
`WEBHOOK_INVALID_PAYLOAD` (Didit doesn't retry 4xx); 500 `WEBHOOK_PROCESSING_FAILED` (Didit retries).

**Test vector:** `didit/__fixtures__/webhook-wire.txt` holds a payload serialised by Python exactly
as Didit does; `webhook-signature.spec.ts` checks our V2 and raw signatures against hashes
computed in Python (Unicode, U+2028, nested objects, a whole-valued float).

---

## 4. Console configuration (record, as of 2026-10-30)

Configured by the project owner and verified through the Didit API.

- **Application used for development:** "yakobRental (Sandbox)". Ignore the live app's
  "Compliance workflow" (it includes paid AML).
- **Live application** ("My Application", `15a852d3-2554-4de8-9c38-f2f1724a7c06`), set up for
  T2.9 on 2026-11-01: its "Free KYC" workflow `bd8242af-f0d5-4da0-b09c-6d2ac4185d03` is
  **published** as an exact copy of the sandbox one (same steps, settings, accepted documents and
  fixed branch rule; compared setting by setting: 0 differences). Webhook destination: the dev
  tunnel `/webhooks/didit` (v3, `status.updated` + `data.updated`); its events were received and
  processed with `DIDIT_ENVIRONMENT=live`. For everyday development `.env` points back at the
  sandbox.
- **Workflow:** "Free KYC", ID `5d5368e7-3151-4cd6-b92d-d3efd0b4b00b`, **published**.
  Features: OCR (ID verification) → passive liveness → face match → IP analysis. All within the
  free tier; no AML.
- **Accepted documents:**
  - Ethiopia: identity card, subtype `ID_CARD_GENERIC` only (the physical Fayda card; confirmed in T2.9),
    and passports.
  - All other countries (212): passports only.
  - Disabled: Ethiopian driving licences, tax cards, refugee IDs, residence permits, and the
    Addis Ababa / Oromia regional ID card variants.
- **Fixed:** the workflow's final-status branch rule `location.status` → `ip_analysis.status`.
- **Webhook destination:** not created yet — created in T2.5 once the tunnel URL is known.
- **Secrets:** `DIDIT_API_KEY` (sandbox app), `DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET` live
  only in the developer's `.env`, never in tracked files or chat.

### Sandbox vs live: the sandbox app performs no real checks

Didit's test mode **simulates** verifications ("no real checks are performed"): the sandbox app
mocks every provider and never bills. It is right for development and for testing our webhook and
state handling, but it **cannot** answer anything about real documents. The real Fayda card test
(T2.9) must therefore run in the **LIVE** app, with its workflow and webhook destination
configured the same way as the sandbox's (checklist below), and `DIDIT_ENVIRONMENT=live`,
`DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID` pointing at the live app for that test. Live sessions are
billed (within the free tier for "Free KYC").

### Checklist for the LIVE application (before T2.9, and again before launch)

- [x] Recreate the workflow in the live app with the same features (OCR → passive liveness →
      face match → IP analysis; no AML) and the same accepted documents (Ethiopia:
      `ID_CARD_GENERIC` + passports; elsewhere passports only; everything else disabled).
      Done 2026-11-01; T2.9 needed no changes to it.
- [x] Check the final-status branch rules (no `location.status`).
- [x] Publish it (done). Put its ID (`bd8242af-f0d5-4da0-b09c-6d2ac4185d03`) in production's
      `DIDIT_WORKFLOW_ID`.
- [ ] Create the live webhook destination for **production** (T2.9 used one pointing at the dev
      tunnel; replace or add one): production URL `/webhooks/didit`,
      `webhook_version: "v3"`, `subscribed_events: ["status.updated", "data.updated"]`; store the
      `secret_shared_key` as production's `DIDIT_WEBHOOK_SECRET`.
- [ ] Production `DIDIT_API_KEY` = the live app's key; `DIDIT_ENVIRONMENT=live`.
- [ ] Add the production `APP_VERIFICATION_CALLBACK_URL` domain to the app's allowed callback
      domains.
- [ ] If behind Cloudflare or a strict firewall, allow Didit's webhook IP `18.203.201.92`.

---

## 5. Real-document findings (T2.9, LIVE app, 2026-11-01)

Answered from two live sessions with one physical Fayda card on two accounts.

Answer them with `npm run didit:inspect -- --latest` (or an attempt / session id). It uses the
Didit app in `.env` and prints only the decision's **shape**:
- document type and subtype, country, check statuses and scores, warning codes;
- numbers as masks (`"999999999999" (12 chars)`), including any inside `extra_fields` /
  `extracted_data`;
- the date of birth's format and the age it implies if Gregorian, next to Didit's own `age`;
- what our decision code would read from it (identifier kinds and problems).

Never names, numbers, dates of birth, addresses, image URLs or warning descriptions; other fields
are listed by name only.

- [x] **Fayda subtype:** the physical card is `document_type: "Identity Card"`,
      `document_subtype: "ID_CARD_GENERIC"`, `issuing_state: "ETH"`. The workflow's Ethiopian
      ID-card entry is right; no change.
- [x] **Fayda numbers:** **FAN only.** `document_number` is 16 digits; `personal_number` is
      absent; no 12-digit FIN anywhere (`extra_fields` has only `first_surname`,
      `full_name_non_latin` and `state`). Same on both sessions. The rule stays: 16 digits →
      `fayda_fan`; the 12 → `fayda_fin` branch is kept (harmless, and covers a FIN appearing in
      `personal_number` later); anything else → V8. V6 therefore matches Fayda users on the FAN.
- [x] **Fayda date of birth:** **Gregorian.** `YYYY-MM-DD`; the owner confirmed it matches their
      Gregorian birthday (Didit's own `age` agrees with ours). V4 needs no conversion.
- [ ] **Paper credential / digital Fayda:** not tested in T2.9 (pre-launch checklist in
      `docs/product-overview.md` §14). These are genuine Fayda documents many people use, so
      **we want them accepted**; the test is whether Didit does. Risk: Didit's document liveness
      rejects "screen captures of digital documents", "photos of documents displayed on screens"
      and "printed document copies"
      ([ID verification overview](https://docs.didit.me/core-technology/id-verification/overview)).
      If it rejects them, that needs a product decision before launch.
- [ ] **Kebele / regional IDs, driving licences:** not tested in T2.9 (pre-launch checklist).
      These must be rejected: they're disabled in the workflow, and at worst one would land in
      `manual_review` (its number isn't 16 or 12 digits, V8).

Also confirmed:
- **V6:** the second account with the same card ended `blocked` (`DUPLICATE_IDENTITY`), with
  the first account still `approved`.
- **Hard rule 1:** `identity_hashes` holds only 64-hex HMACs (`fayda_fan`); no 12- or 16-digit
  number appears in any text/JSON column of `identity_verifications`, `identity_hashes`,
  `verification_webhook_events`, `users`, `banned_identities` or `admin_actions`.
- **Webhooks in live:** every `status.updated` (Not Started → In Progress → Approved) arrived
  within seconds and was processed without error.
- **Warnings seen:** only information-level duplicate signals (`POSSIBLE_DUPLICATED_USER`,
  `POSSIBLE_FRONT_CAMERA_DUPLICATED_FACE` on the document; `DUPLICATED_FACE` on liveness;
  `DUPLICATED_DEVICE_FINGERPRINT` / `DUPLICATED_IP_ADDRESS` on IP analysis), all `NO_ACTION`
  in the workflow. No real decline was seen, so `reasonCode` still maps every Didit decline to
  `DOCUMENT_NOT_VERIFIED`.
- **Amharic name:** returned as `extra_fields.full_name_non_latin`, but its OCR varied between
  the two scans of the same card (5 vs 10 characters). Not used.

Background: Ethiopia/Fayda isn't mentioned in Didit's developer docs. Didit's marketing pages
list Fayda as supported ("while enrollment expands" in some languages) and say there is no
government-database lookup for Ethiopia, so Fayda checks are document-based
([Didit: Ethiopia](https://didit.me/solutions/countries/ethiopia/)).

### Open option (not decided, nothing built)

- Restrict document capture to the live camera only (no file upload).
- **Passport + Fayda limitation:** V6 matches on ID numbers, so one person with both a passport
  and a Fayda card can verify two accounts (the identifiers differ). Didit's face-based duplicate
  signals could close this.
- **Idea:** a `DUPLICATED_FACE` signal from Didit could send the session to `manual_review`
  instead of approving it. Not now; just recorded.

---

## 6. For the Flutter app (`rental-app`)

- Didit's Flutter SDK is `didit_sdk`; start it with the `session_token` our API returns (never the
  API key).
- Queue token refreshes (see spec §6) — unrelated to Didit but easy to miss.
