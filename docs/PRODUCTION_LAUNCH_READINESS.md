# Kai Lani Production Launch Readiness

Read-only production launch-readiness audit for the Square appointment-request
approval workflow on `feature/square-booking`.

**Overall status: CONDITIONAL GO — code blockers RESOLVED; still NOT LAUNCH-READY
until owner decisions + controlled Production smoke takes place.**

The Sandbox end-to-end path is proven and every automated check is green. The
three code blockers recorded by the previous audit (Production Square mode,
Production email routing, frontend flag) are now implemented in
`lib/environment.js`/`lib/square.js`/`lib/email.js` and the renamed frontend
flag. The workflow still fails closed unless every explicit-environment
variable is present and mutually matching. **Do not push or deploy the
workflow to Production until Square Production readiness is confirmed.** With
the workflow **disabled**, the public fallback is the neutral call/email
fallback (no third-party booking links). Remaining work is entirely
operator-side: set Production
values, run the controlled smoke test, then flip the flags. No code change is
required to get to a safe Production state; the frontend flag
`VITE_ENABLE_BOOKING_REQUESTS` must be added to the Vercel **Preview**
environment (item 14) before any Preview push.

---

## 1. Executive status

| Area | Status |
|---|---|
| Automated verification | PASS (baseline 275 tests; current local validation required before push) |
| Square plan | Launches on Square Appointments Free using buyer-level booking creation |
| Sandbox E2E booking | Two-stage flow: website creates Square PENDING, Chelsea accepts in Dashboard, then status check sends confirmations |
| Production code blockers (B1/B2/B3) | RESOLVED (environment gates, email routing, frontend flag) |
| Production merge readiness | WAITING ON OWNER DECISIONS + controlled smoke (sections 9/16/18) |
| Guidance | **CONDITIONAL GO**. Do not enable Production without the smoke test. |

### Release blockers (resolved in this milestone)

1. **Production Square mode — RESOLVED** (`lib/environment.js`,
   `lib/square.js`, `lib/approval-config.js`): `getSquareClient()` now accepts
   exactly `sandbox` or `production` for `SQUARE_ENVIRONMENT` and constructs the
   matching official SDK environment. The workflow enables only when
   `BOOKING_APPROVAL_ENABLED === "true"` and `BOOKING_APPROVAL_MODE` exactly
   equals `SQUARE_ENVIRONMENT`. Every missing, malformed, mixed-case, or
   mismatched combination fails closed; Production is never defaulted to. Tests:
   `tests/environment.test.js`.
2. **Email routing — RESOLVED** (`lib/email.js`): routing is decided once by
   `resolveEmailRouting()`. Sandbox forces every recipient to
   `EMAIL_SANDBOX_RECIPIENT` with a `[SANDBOX]` subject prefix and a visible
   test banner. Production sends client messages to the validated client email
   and approval/provider messages to `CHELSEA_NOTIFICATION_EMAIL` only, with no
   Sandbox marker; `EMAIL_SANDBOX_RECIPIENT` is never used in Production.
   Missing/mismatched configuration fails closed (status `disabled`) before any
   send. Tests: `tests/email.test.js`, `tests/booking-emails.test.js`.
3. **Frontend flag — RESOLVED** (`Booking.jsx`/`SquareBooking.jsx`,
   `.env.example`, `src/lib/booking-flag.js`): `VITE_ENABLE_SQUARE_SANDBOX`
   removed. The flow renders only when `VITE_ENABLE_BOOKING_REQUESTS === "true"`;
   any other value renders the neutral call/email fallback (no MassageBook
   integration). The old flag is ignored. All
   Sandbox-only UI wording ("Sandbox preview — test bookings only", "sent in
   Square Sandbox for testing", "Book another test appointment") is removed from
   rendered output. Tests: `tests/frontend-flag.test.js`.

### Owner decisions still required before launch

- Rate limiting (section 9).
- Manual invoicing & payment handling in Square Dashboard (documented workflow).
- Google-Calendar sync responsibility (Square Dashboard side vs client-side link).
- Webhook activation timeline and QStash provisioning (deferred; section 10).

---

## 2. Repository and merge scope

- Branch `feature/square-booking`, HEAD `f2826a0` («fix: source service variation
  version on approval resume»), push target only `feature/square-booking`.
- `origin/main` = `e4ff023`; commit range `origin/main..HEAD` = 14 commits
  (`f2826a0` … `cf8edf8`). The old checkout
  `/Users/powwow/Projects/kai-lani-canonical/../kai-lani-bodywork-wellness`
  (commit `f66e513`) is an ancestor of `main` and remains untouched.
- The feature replaces the direct-booking endpoint with an approval workflow:
  - API surface (removed): `cancel-booking.js`, `customers.js`,
    `dashboard/appointments.js`, `dashboard/auth.js`; `create-booking.js` is now
    a 410 stub (`BOOKING_FLOW_REPLACED`) with a backward-compatible test seam.
  - API surface (added/updated): `availability.js`,
    `api/square/booking-requests/{index,lookup,approve,decline}.js`,
    `api/square/unsubscribe.js`, `api/square/webhook.js`,
    `api/square/webhook-worker.js`.
  - Shared logic: `lib/{services,config,square,tokens,store,email,calendar,
    time,booking-requests,approval-config,overlap,read-json-body,read-raw-body,
    qstash-publisher,square-webhook-message,square-webhook-reconcile}.js`.
- DB: `db/migrations/001_booking_requests.sql`, `002_square_reconciliation.sql`,
  `003_buyer_level_booking_state.sql`;
    applied only by `npm run db:booking-requests:apply`.
  - Frontend: new `src/components/ApprovalPage.{jsx,css}`, new booking UI
    `src/components/calendar/SquareBooking.jsx`, `App.jsx` routes `/approve`.
  - Tests: 16+ new/modified test files (+`environment.test.js`, `frontend-flag.test.js`); `tests/disabled-endpoints.test.js` removed.

### Vercel serverless function count

9 functions under `api/` (verified against `vercel.json` which sets no
`functions` block, so each `api/**/*.js` becomes one function):

1. `api/square/availability.js`
2. `api/square/booking-requests/approve.js`
3. `api/square/booking-requests/decline.js`
4. `api/square/booking-requests/index.js`
5. `api/square/booking-requests/lookup.js`
6. `api/square/create-booking.js` (410 stub)
7. `api/square/unsubscribe.js`
8. `api/square/webhook.js`
9. `api/square/webhook-worker.js`

---

## 3. Verification runs (this audit)

Run once, read-only, no mutations:

- `npm test` → **275 pass / 0 fail** (was 247; +14 environment-matrix,
  +9 sandbox/production email-routing, +5 frontend flag/wording).
- `npm run build` → passes.
- `git diff --check` → **clean** (no whitespace errors).
- Working tree clean except the untracked 0-byte `Fetching`
  (left untouched; never staged). `dist/` and `.env.local` are gitignored.

---

## 4. Environment requirements matrix

Names and status only — **no values were inspected.** `PUBLIC` = must be
configured in Vercel app settings; `SYSTEM` = Vercel-provided; `GITIGNORED` =
local file (`.env.local`) never committed.

| Variable | Scope | Required for launch? | Status / notes |
|---|---|---|---|
| `SQUARE_ACCESS_TOKEN` | PUBLIC, server | Yes | Must switch to **Production** token |
| `SQUARE_ENVIRONMENT` | PUBLIC, server | Yes | Exactly `sandbox` \| `production`; must equal `BOOKING_APPROVAL_MODE`; anything else fails closed (resolved B1) |
| `SQUARE_LOCATION_ID` | PUBLIC, server | Yes | Production location |
| `SQUARE_TEAM_MEMBER_ID` | PUBLIC, server | Yes | Chelsea's Production team member |
| `SQUARE_SERVICE_CUSTOMIZED_60_ID` … `_90_ID` etc. (5 IDs) | PUBLIC, server | Yes | Production catalog variation IDs |
| `DATABASE_URL` | PUBLIC, server | Yes | Neon **Production** DB; migrations 001+002 applied |
| `PUBLIC_SITE_URL` | PUBLIC, server/frontend | Yes | Production site URL. **Authoritative approval-link base** (`PUBLIC_SITE_URL/approve?token=...`). There is no `BOOKING_APPROVAL_BASE_URL` variable |
| `BOOKING_APPROVAL_ENABLED` | PUBLIC, server | Yes | Must be exactly `true`; gate requires `BOOKING_APPROVAL_MODE === SQUARE_ENVIRONMENT` |
| `BOOKING_APPROVAL_MODE` | PUBLIC, server | Yes | Must exactly equal `SQUARE_ENVIRONMENT` (sandbox or production) |
| `BOOKING_APPROVAL_TOKEN_TTL_MINUTES` | PUBLIC, server | Optional | Default 120; operator decision |
| `EMAIL_ENABLED` | PUBLIC, server | Yes | Must be exactly `true` for any delivery |
| `EMAIL_MODE` | PUBLIC, server | Yes | `sandbox` \| `production`; must exactly equal `SQUARE_ENVIRONMENT`; else fail closed (resolved B2) |
| `RESEND_API_KEY` | PUBLIC, server | Yes | Production Resend key |
| `EMAIL_FROM` | PUBLIC, server | Yes | Production verified sender |
| `EMAIL_REPLY_TO` | PUBLIC, server | Yes | Production reply-to address |
| `EMAIL_SANDBOX_RECIPIENT` | PUBLIC, server | Sandbox only | Sandbox forces **every** recipient here; never used in Production (resolved B2) |
| `CHELSEA_NOTIFICATION_EMAIL` | PUBLIC, server | **Yes (production)** | **Required in Production.** Recipient for approval + provider messages; unused in Sandbox |
| `BOOKING_APPROVAL_BASE_URL` | — | No | **Does not exist in code.** Not referenced anywhere. Approval URL uses `PUBLIC_SITE_URL`. Do not configure. |
| `VITE_ENABLE_BOOKING_REQUESTS` | PUBLIC, frontend build | Yes | Exactly `true` renders the request flow; any other value renders the neutral call/email fallback. Must be set in **Preview** (item 14) before any Preview redeploy; set `true` in Production only with the workflow enabled (resolved B3) |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `QSTASH_URL` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `QSTASH_TOKEN` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `QSTASH_CURRENT_SIGNING_KEY` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `QSTASH_NEXT_SIGNING_KEY` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `QSTASH_WORKER_URL` | PUBLIC, server | No (deferred) | **Keep unset** while webhooks disabled |
| `NODEJS_HELPERS` | PUBLIC, server | No | Only for raw-body webhook HMAC; must not be set at launch |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | SYSTEM | No (deferred) | Vercel system var for QStash automation; not needed while webhooks disabled |
| `LOCAL_API_PORT` | local only | No | `scripts/local-api-server.mjs` only |
| `.env.local` | GITIGNORED | No | Present locally; covered by `.env*` ignore; never commit |

**Confirmation:** webhook endpoint failure is fail-closed even if webhook env
vars are mistakenly set — `/api/square/webhook` requires `isBookingApprovalEnabled`,
the Square signing key, notification URL, *and* a configured QStash publisher
before it will process anything; `/api/square/webhook-worker` requires the QStash
receiver signing keys. With webhook/QStash vars omitted in Production, both
endpoints respond 401/503 and can never reconcile. **Do not set webhook or
QStash variables at launch.**

---

## 5. Database plan

- Migrations are **manual only**: `npm run db:booking-requests:apply`
  (`scripts/db-apply-booking-requests.mjs`). No auto-migration on deploy.
- Order: `001_booking_requests.sql`, `002_square_reconciliation.sql`, then
  `003_buyer_level_booking_state.sql`. `002` and `003` are additive and assume
  earlier migrations ran. Do not auto-apply migrations on deploy.
- Production DB is Neon via `@neondatabase/serverless`. Store enforces strict
  timeouts (`statement_timeout` 500 ms, connect 1000 ms) so DB work stays within
  Square's 10-second delivery pace; cold-pool behavior is a known consideration.
- Schema (documented in the migrations + `lib/store.js`):
  - `booking_requests` with request idempotency (`request_key` unique),
    exclusion constraint preventing overlapping *active*
    (pending/approving/awaiting_square_acceptance) holds, and email-status
    audit columns.
  - `email_subscriptions` (opt-in marketing consent only) and
    `square_webhook_events` (durable webhook tracking; dormant until webhooks
    are activated).
- No sensitive fields are stored: only SHA-256 hashes of approval/unsubscribe
  tokens; no medical or private notes.

---

## 6. Square configuration

- Square SDK `square@^44` client construction is explicit-mode now
  (`lib/square.js:28-52`): `SQUARE_ENVIRONMENT` must be exactly `sandbox` or
  `production`, `BOOKING_APPROVAL_MODE` must exactly match it, and
  `BOOKING_APPROVAL_ENABLED=true`; the SDK is configured with the matching
  `SquareEnvironment.Sandbox`/`.Production`. Any missing/malformed/mismatched
  combination throws and never constructs a network client; Production is never
  defaulted to (resolved B1).
- The catalog availability lookup and booking creation require the 5 service
  variation IDs, location ID, and team member ID to resolve in the **Production**
  catalog. Sandbox IDs must not leak into Production env.
- Customer matching is email-exact then phone-exact (E.164, NANP-validated);
  email/phone resolving to *different* customers stops for manual review
  (`customer_conflict`). No Customer Directory notes are written.
- Booking creation uses deterministic idempotency keys derived from the request
  id and calls Square as a buyer-level booking (`seller_level=false`) so no
  Square Plus/Premium subscription is required. Seller-level writes, automatic
  one-click final acceptance, and broad calendar reconciliation remain future
  paid-plan capabilities.
- Buyer-level creation can return `PENDING`. In that case the website stores
  `awaiting_square_acceptance`, holds the requested slot locally, sends no
  client/provider confirmation emails, and exposes no confirmed calendar data.
  Chelsea must open Square Dashboard, accept the pending appointment, return to
  the approval page, and click `Check Square status`. Only after Square returns
  `ACCEPTED` does the website finalize `approved` and send confirmation emails
  with ICS/Google Calendar data.
- Resume paths source an authoritative `service_variation_version` from the
  catalog (`catalog.object.get`) when needed, failing closed (`server_config`)
  before Square is called if the version cannot be resolved.
- **Calendaring:** confirm whether the Square **Dashboard‑side** integration
  writes the accepted booking to Google Calendar, or whether the client-side
  "Add to Google Calendar" link plus ICS attachment (both already built and
  verified in Sandbox) is the accepted Production behavior. This is an owner
  decision.
- **Payments:** no invoice/payment is created by this code; **manual Square
  Dashboard invoicing is the approved launch workflow** (see
  `PAYMENT_AND_CLIENT_COMMUNICATIONS.md`).

---

## 7. Email routing (resolved — was blocker B2)

Implemented in `lib/email.js`, decided once by `resolveEmailRouting()`:

- **Sandbox** (`EMAIL_MODE=sandbox`, matching `SQUARE_ENVIRONMENT=sandbox`):
  every message routes **only** to `EMAIL_SANDBOX_RECIPIENT`. Subjects gain a
  `[SANDBOX]` prefix and bodies carry the `TEST MESSAGE - NO REAL APPOINTMENT`
  banner. The real client address and `CHELSEA_NOTIFICATION_EMAIL` are never
  used.
- **Production** (`EMAIL_MODE=production`, matching `SQUARE_ENVIRONMENT=production`):
  client messages go **only** to the validated client email on the approved
  request; approval + provider messages go **only** to
  `CHELSEA_NOTIFICATION_EMAIL` (required). No `[SANDBOX]` prefix, no test
  banner, and `EMAIL_SANDBOX_RECIPIENT` is never used.
- **Fail closed:** any missing/invalid/mismatched variable (`EMAIL_ENABLED`,
  `EMAIL_MODE`, `RESEND_API_KEY`, `EMAIL_FROM`, sandbox recipient in sandbox,
  `CHELSEA_NOTIFICATION_EMAIL` in production, or a missing/invalid client email in
  production) results in status `disabled` and **no fetch is made**.
- Idempotency keys are deterministic per message kind + suffix, ICS attachments
  are retained on approved client + provider confirmations in both modes, and
  log lines never include recipient addresses, PII, tokens, or credentials.

Regression coverage: `tests/email.test.js`, `tests/booking-emails.test.js`
(sandbox-only routing, production routing matrix, ICS retention, idempotency,
no-PII logs).

---

## 8. Approval security model

Current protections (verified in SANDBOX):

- Approval tokens: 32 random bytes, base64url; stored **only as SHA-256**;
  returned once at creation, never logged, never returned by any API
  (`lib/tokens.js`). Unsubscribe tokens the same.
- TTL: default 120 minutes (`BOOKING_APPROVAL_TOKEN_TTL_MINUTES`); pending
  requests expire and release their website hold via `expirePendingRequests()`.
- Approve/decline are atomic claims (`pending -> approving`, `pending ->
  declined`) guarded by token-lookup; a request cannot be re-decided after the
  claim, and declining is blocked once approving or awaiting Square acceptance.
- Rechecking an `awaiting_square_acceptance` row is a POST to the existing
  approval endpoint with the same token. It retrieves the persisted Square
  booking by ID and never calls `CreateBooking` again.
- After Square has created the pending booking, the approval token remains
  usable for Square-status rechecks for 14 days from the approval attempt. This
  is intentionally broader than the initial approval TTL so an accepted Square
  booking is not stranded before Chelsea can click `Check Square status`; it is
  still limited and still requires the same unguessable token.
- If that 14-day status-check window expires, the website does not retrieve
  Square or send confirmations. The approval page tells Chelsea to review the
  appointment in Square Dashboard and handle client communication manually; the
  local hold remains until an explicit operational cleanup is chosen.
- Idempotent approve and client/server retry paths reuse deterministic Square
  keys; no duplicate customer/booking is created.
- Referrer policy `no-referrer` on `index.html:6` prevents approval tokens from
  leaking through Referer headers.
- `ApprovalPage.jsx` strips the token from the address bar
  (`history.replaceState`) after reading it.

Privacy consideration for Production: the **GET** summary request sends the token
as a query parameter (`/api/square/booking-requests/approve?token=...`) and
fetches PII (client name/email/phone/service/time). Vercel access/function logs
record request URLs, so the token could appear in logs. Mitigations: leave Vercel
log scrubbing on, prefer POST for the decision pivot (already done), and confirm
the operator is comfortable with the token-in-log exposure or mask the query
string in Vercel. The token remains protected (hash-only in DB), but its value
in access logs is a durability risk to acknowledge.

---

## 9. Rate limiting decision

**No rate limiting is implemented in code.** There is no throttling on
`booking-requests` creation, `approve`, `decline`, or `unsubscribe`. Protection
relies on:

- strictly validated, normalized payloads;
- an unguessable per-request idempotency key (UUID) and token (224-bit entropy);
- atomic DB claims and Square idempotency keys;
- fail-closed environment gating.

Owner decision: for a single-therapist studio with manual approval, unrate-limited
endpoints are low risk (an attacker cannot create real bookings without Chelsea's
approval, and Square availability re-checks are authoritative), but they permit
unbounded junk `booking_requests` rows and spam emails. Recommend either (a)
accepting the current model with an ops note to monitor Neon row growth, or
(b) adding a lightweight token-bucket on `booking-requests` POST and `unsubscribe`
before go-live. This is a deliberate decision, not an omission.

---

## 10. Webhook & QStash disposition (deferred — NOT launch-required)

- Webhook intake, QStash queue, worker, and reconciliation (booking.updated ->
  cancel/reschedule/no-show handling with version-gated reconciler and pending
  hold reallocation) are **implemented, Sandbox-tested, and intentionally
  dormant**.
- Production launch does **not** require webhooks: with webhook/QStash env vars
  absent, both endpoints fail closed and nothing reconciles.
- Remaining work for a future milestone: provision QStash (URL/token/signing
  keys), set `SQUARE_WEBHOOK_NOTIFICATION_URL`, validate raw-body HMAC
  (`NODEJS_HELPERS=0`) with a signed Square Sandbox webhook, subscribe in the
  Square Dashboard (`booking.created`/`booking.updated`), and confirm retry
  behavior + Square-to-Google calendar sync. See
  `QSTASH_WEBHOOK_PREVIEW_RUNBOOK.md`.

---

## 11. Frontend gating and UX (resolved — was flag contradiction)

- The new booking flow (`SquareBooking.jsx`) renders only when
  `VITE_ENABLE_BOOKING_REQUESTS === "true"`; any other value renders the neutral
  call/email fallback (`Booking.jsx`). The legacy `VITE_ENABLE_SQUARE_SANDBOX`
  flag is gone, and the flag is **not** a security gate (the server gates
  independently). The flag logic lives in `src/lib/booking-flag.js` for shared
  UI + test use. The flag must be `true` in the Preview environment (item 14)
  and in Production once the workflow is enabled (resolved B3).
- All Sandbox-only render wording was removed: the "Sandbox preview — test
  bookings only" pill, "Your appointment request was sent in Square Sandbox for
  testing", and "Book another test appointment" are gone. Production-facing
  confirmations say "Your appointment request was sent." / "Your booking details
  are below." The `[SANDBOX]` marker lives only in the (sandbox) email layer.
- Booking form requires explicit `contactConsent` (rejected 400 without it) and
  collects separate optional `marketingConsent`; marketing consent only ever
  writes an `email_subscriptions` row (no marketing email is sent).
- `/approve` is a client-side SPA route (`App.jsx`); the emailed approval link
  is `PUBLIC_SITE_URL/approve?token=...`. The approval summary page shows
  client PII (name/email/phone/service/time) to whoever holds the token — used
  by Chelsea only.
- New-booking UI includes arrival instructions, booking reference, ICS
  attachment, and Google-Calendar link — all verified in Sandbox.
- Anything in the public confirm status endpoints (`lookup?requestKey`) returns
  only safe status fields, not tokens or raw provider responses.

---

## 12. Privacy & data handling

Strengths verified:

- No medical or health information is stored or sent to Square (segment-only
  booking; seller note = request reference).
- Tokens hashed; PII not logged by application code (all log lines use suffix
  IDs, never names/email/phone).
- Contact consent is explicit and required; marketing consent is opt-in and
  never inferred.
- ICS and Google-Calendar payloads contain only service/time/reference/location/
  arrival instructions.
- Unsubscribe endpoint never returns the subscriber's address.

Plan items for Production:

- Reconfirm Square Customer Directory contents are limited to the fields this
  flow writes (given/family name, email, phone) and that no customer notes are
  ever created.
- Decide approval-token visibility in Vercel access logs (query-string token).
- Ensure Resend production keys and sender domain are allow-listed and that
  emails carry correct From/Reply-To for delivery in Production.

---

## 13. Operational runbook (checklist)

- [ ] Code blockers B1/B2/B3 resolved in this milestone (sections 4/7/11).
- [ ] Apply `001` + `002` to the **Production Neon** DB (manual, reviewed).
- [ ] Configure Production env vars per section 4 (`SQUARE_ENVIRONMENT=production`,
      `BOOKING_APPROVAL_MODE=production`, `EMAIL_MODE=production`,
      `CHELSEA_NOTIFICATION_EMAIL`, Production tokens/IDs); do **not** set
      webhook or QStash vars.
- [ ] Add `VITE_ENABLE_BOOKING_REQUESTS` to the **Preview** environment before
      any Preview redeploy (item 14).
- [ ] Deploy from `main` after the feature merge; verify `/approve` route and
      API functions; confirm `Vercel.json` rewrites still serve the SPA.
- [ ] Perform a controlled Production smoke test (section 16).
- [ ] Keep webhooks disabled until the QStash milestone completes.

---

## 14. Staged launch sequence (recommended)

1. **Code milestone — DONE:** Production mode in `lib/square.js`/
   `lib/approval-config.js`, production email routing in `lib/email.js`, and the
   frontend flag renamed to `VITE_ENABLE_BOOKING_REQUESTS` (all in this branch).
2. **DB migration** to Production Neon (manual apply).
3. **Environments:** switch `SQUARE_*`, `DATABASE_URL`, `PUBLIC_SITE_URL`,
   email vars to Production values (with `CHELSEA_NOTIFICATION_EMAIL`); leave
   webhook/QStash unset.
4. **Feature deploy to Production** with the workflow still disabled
   (`BOOKING_APPROVAL_ENABLED=false`, `EMAIL_ENABLED=false`, frontend flag
   false/missing) until the Production smoke test is run.
5. **Owner smoke test** (section 16) using a single replacement test in
   Production Square with Chelsea, then delete/handle the test booking.
6. Enable `BOOKING_APPROVAL_ENABLED`/`EMAIL_ENABLED` and
   `VITE_ENABLE_BOOKING_REQUESTS=true`.
7. Post-launch: monitor Neon row growth (rate-limit decision), Resend delivery,
   Square ACCEPTED rate. Run the next-launch remediation audit (section 19).

---

## 15. Rollback plan

- Roll back by restoring a prior deployment in Vercel (git revert on `main` then
  re-deploy) and flipping the feature flags off (`BOOKING_APPROVAL_ENABLED=false`,
  `EMAIL_ENABLED=false`, frontend flag false). With the flags off, the workflow
  endpoints 503 and the site renders the neutral call/email fallback — no
  behavior regression for public visitors.
- The DB migrations are additive; no destructive data. Booking requests created
  under the feature are retained; none block the public call/email fallback
  because holds only cover active (pending/approving) rows.
- Approved Square bookings before rollback are real Square records already in
  the Dashboard; management reverts to the manual/approval-runbook path.

---

## 16. Verification / acceptance test plan for Production

Repeat the Sandbox-approved test sequence against Production **only after** B1/B2
are completed and only with Chelsea's involvement:

1. Submit a one-off booking request for a single service and confirmed slot.
2. Verify request created; request-receipt + approval emails reach **Chelsea**
   (production routing).
3. Approve the request; verify Square booking created (single, ACCEPTED), client
   + provider confirmations with ICS reach **the real client** address and Chelsea.
4. Verify Google Calendar link dates and location text; verify no duplicate
   customer/booking (idempotency on retry).
5. Decline path and needs-reschedule path each once (sandbox mailbox earlier, but
   in production direct to client).
6. Unsubscribe path: subscribe then unsubscribe via token; confirm one-click.
7. Verify no webhook events processed (webhook env unset).
8. Clean up test data/booking.

---

## 17. Known gaps and code changes required before production merge

- **RESOLVED**: `lib/square.js` / `lib/approval-config.js` accept
  `SQUARE_ENVIRONMENT`/`BOOKING_APPROVAL_MODE` production values with an
  exact-match, fail-closed gate (resolved B1).
- **RESOLVED**: `lib/email.js` production recipient routing + mode enum;
  `CHELSEA_NOTIFICATION_EMAIL` is now required-and-used in Production (resolved B2).
- **RESOLVED**: frontend flag renamed `VITE_ENABLE_SQUARE_SANDBOX` ->
  `VITE_ENABLE_BOOKING_REQUESTS`, `.env.example` updated, old flag ignored,
  Sandbox UI wording removed (resolved B3).
- Rate limiting (decision first; section 9).
- Approval-token-in-log review (section 8).
- Confirm Square Dashboard-to-Google calendar sync configuration for Production.
- Confirm the accepted Production pricing matches `lib/services.js` (60 min $93,
  prenatal $97, 90 min $123) and the catalog variation mapping in Production.
- **Preview env:** `VITE_ENABLE_BOOKING_REQUESTS=true` must be added to the
  Vercel Preview environment before pushing this branch to a Preview (item 14);
  without it the Preview renders the neutral call/email fallback.

---

## 18. Owner manual decisions needed (Tyler / Chelsea)

- [ ] Invoice/payment: manual Square Dashboard invoicing is the launch workflow —
      owner confirms each accepted appointment is invoiced.
- [ ] Calendar: rely on client-side Google-Calendar link + ICS, or enable a
      Square-side sync.
- [ ] Rate limiting: accept current model or add throttling (section 9).
- [ ] Webhook/QStash activation timeline (deferred milestone; section 10).
- [ ] Approval-token TTL (default 120 min) acceptable?
- [ ] Production service availability window is 14 days ahead (`MAX_DAYS_AHEAD`).
- [ ] Confirm public `lookup?requestKey` status exposure is acceptable.

---

## 19. Next-launch remediation prompt

Re-run this audit once the following are true, before flipping the workflow on in
Production:

1. `getSquareClient`/approval-config returns a Production-capable client for
   `SQUARE_ENVIRONMENT=production` **and the gate matrix tests pass** (done here:
   `tests/environment.test.js`).
2. Email routing is production-capable and a real test email to Chelsea was
   delivered (routing matrix done here: `tests/email.test.js`,
   `tests/booking-emails.test.js`).
3. Frontend flag `VITE_ENABLE_BOOKING_REQUESTS` demoed in a
   Production-environment preview.
4. Migration 001+002 applied to Production Neon and verified with a single
   seed test row that is then removed.
5. Rate-limit decision recorded here.
6. The runbook (section 13) checklist fully green.

Prompt: "Re-run the Kai Lani Production launch-readiness audit on this repo with
the same constraints, using the new code as the target, and produce an updated
`docs/PRODUCTION_LAUNCH_READINESS.md` and 20-item final report."

---

## 20. Audit limitations and no-mutation confirmation

- **Constraints honored:** read-only audit plus the now-completed B1/B2/B3 code
  milestone; no merge/deploy/migrate/configure/delete; no environment *values*
  inspected (names/scopes only); no Vercel env change (the required Preview
  `VITE_ENABLE_BOOKING_REQUESTS=true` addition is **item 14 of the next step**,
  not performed here); no new Sandbox request; the successful Sandbox
  booking/customer and the failed `…87e42c` row were not modified; webhooks
  remained disabled; the accidental Vercel project `kai-lani-canonical`
  (`prj_CSkTnAs5ivhKI0Abx60Q0rgXL6q7`) was not deleted; `Fetching` (untracked)
  was not touched.
- Production `main` (`e4ff023`) is untouched; the old checkout clone is untouched.
- No secrets, tokens, connection strings, or PII are included in this document
  or in any log output.
- Verification commands (`npm test`, `npm run build`, `git diff --check`) were run
  once and produced no repository changes beyond this milestone's intended source,
  test, and documentation edits. `git status` shows only `?? Fetching`
  (untracked, pre-existing) outside the staged milestone changes.
- The `BOOKING_APPROVAL_BASE_URL` variable referenced in prior context does not
  exist anywhere in the codebase; the approval URL derives from `PUBLIC_SITE_URL`.
- All deployment chains (stable alias -> `6o22z14o0`, GitHub auto-deploy
  `8ixnlfoe2`) and the earlier Sandbox verification remain as previously recorded;
  nothing in this audit redeployed or re-verified live endpoints.
