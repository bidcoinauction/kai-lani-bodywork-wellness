# Kai Lani Square Appointments — Sandbox Setup

This document explains how to configure the Square Sandbox environment used by the
`feature/square-booking` branch. The native booking calendar is **sandbox-only**
during this milestone and never runs against production Square.

All credential values live only in the Vercel **Preview** environment (and, if
you want local testing, a gitignored `.env` file). Nothing is committed to the
repository.

---

## 1. Developer application setup

1. Sign in at <https://developer.squareup.com>.
2. Create a new application. Recommended name: **Kai Lani Booking**.
3. Open the application and note its **Sandbox** section.
4. Keep the **Sandbox Application ID** handy for reference only. It is **not**
   required by this server-only milestone and must not be used as the access
   token.

## 2. Sandbox seller setup

1. In the Developer Console, open **Sandbox** for the application. This opens
   the Sandbox Seller Dashboard (a fake seller account for testing).
2. Under **Sandbox → Credentials**, copy the value explicitly labeled
   **Sandbox Access Token**. This is `SQUARE_ACCESS_TOKEN`.
   - Sandbox personal access tokens begin with `EAAAl`. Production personal
     access tokens begin with `EAAA` (no `l`) — never use one here.
   - The token is saved only in a gitignored `.env` file (or Vercel Preview).
     It is never printed, logged, committed, or shared.
3. Set `SQUARE_ENVIRONMENT=sandbox`. The API refuses to start otherwise.

## 3. Square Appointments onboarding

This is a one-time, manual step in the Sandbox Square Dashboard. It cannot be
done through the API. Verified against Square's official "Onboard to Square
Appointments" guide:

1. Developer Console → **Sandbox Test Accounts** → **Open** next to
   **Default Test Account**. This opens the Sandbox Square Dashboard.
2. Choose **Appointments** → **Get started** to initialize Appointments.
3. Complete the business-details page (name, phone, time zone).
4. (Optional) Subscribe to **Appointments Plus/Premium** with the test card
   `4111 1111 1111 1111`, CVV `111`, expiry `12/40`, postal `22222` if you want
   to test seller-level writes.
5. On the Appointments page, create the services and add the staff member
   (see sections 5 and 6) — or use the Catalog/Team APIs instead.

Until this onboarding is done, Square returns `401 UNAUTHORIZED / Merchant not
onboarded to Appointments` and `SearchAvailability` fails. **This sandbox
account is not onboarded yet** — confirmed by live API calls.

## 4. Location creation

1. In the Sandbox Seller Dashboard, create or confirm the **location** where
   appointments are held (e.g., 107 West 1st Street, Suite 102, Mount Holly, NC).
   - The Default Test Account's only location is `L4Z326HP8W2SH` (already
     populated in `.env` from live discovery).
2. Copy the **Location ID** from the location details. This is
   `SQUARE_LOCATION_ID`.
3. In the app's Sandbox credentials/API explorer you can also confirm the
   location ID via the Locations API if needed.

## 5. Bookable Chelsea team member

1. In the Sandbox Seller Dashboard, add **Chelsea Teller** as a team member and
   grant her Appointments/booking access.
   - **No team members exist yet in this sandbox** — confirmed by live API
     (`/team-members` returns `404 NOT_FOUND`).
2. Mark her as available to fulfill Appointments.
3. Copy her **Team Member ID**. This is `SQUARE_TEAM_MEMBER_ID`. Every
   availability search and booking is scoped to her.

## 6. Five service variations

Create one **Service** catalog item per bookable service, each with a price and
duration. Copy each **Service Variation ID** to the matching variable.

> **Note:** The sandbox catalog is currently empty — confirmed by live API
> (`/catalog/list` returns no objects). Create the five services with
> **"Bookable by Customers Online"** enabled so `SearchAvailability` can find
> them. You can create them in the Sandbox Dashboard or via the Catalog API
> (set `available_for_booking: true` on each variation).

| Service | Duration | Price | Environment variable |
|---|---|---|---|
| 60 Min Customized Massage | 60 min | $93 | `SQUARE_SERVICE_CUSTOMIZED_60_ID` |
| 60 Min Customized Deep Tissue Massage | 60 min | $93 | `SQUARE_SERVICE_DEEP_TISSUE_60_ID` |
| 60 Min Customized Prenatal Massage | 60 min | $97 | `SQUARE_SERVICE_PRENATAL_60_ID` |
| 90 Min Customized Massage | 90 min | $123 | `SQUARE_SERVICE_CUSTOMIZED_90_ID` |
| 90 Min Customized Deep Tissue Massage | 90 min | $123 | `SQUARE_SERVICE_DEEP_TISSUE_90_ID` |

The service variation IDs are **server-owned** and read from the environment.
They are never sent by the browser and never invented in code. If any variable
is missing, the API returns a safe configuration error naming the missing
variable.

## 7. Availability setup

1. In the Sandbox Seller Dashboard → Appointments, set Chelsea's working hours
   (e.g., Mon–Fri 9:00–18:00) and booking window.
2. Assign each service to the location and to Chelsea.
3. Publish so the calendar generates real bookable slots. The website shows only
   real slots returned by `SearchAvailability` — never fabricated times.

## 8. Environment variables (Vercel Preview)

Set these in the Vercel project **Preview** environment
(Settings → Environment Variables). Use the exact names; never commit values.

| Variable | Source |
|---|---|
| `SQUARE_ACCESS_TOKEN` | Square Developer Console → Kai Lani Booking → Sandbox → Credentials → "Sandbox Access Token" |
| `SQUARE_ENVIRONMENT` | `sandbox` |
| `SQUARE_LOCATION_ID` | Sandbox location details |
| `SQUARE_TEAM_MEMBER_ID` | Sandbox team member (Chelsea) |
| `SQUARE_SERVICE_CUSTOMIZED_60_ID` | Catalog service variation ID |
| `SQUARE_SERVICE_DEEP_TISSUE_60_ID` | Catalog service variation ID |
| `SQUARE_SERVICE_PRENATAL_60_ID` | Catalog service variation ID |
| `SQUARE_SERVICE_CUSTOMIZED_90_ID` | Catalog service variation ID |
| `SQUARE_SERVICE_DEEP_TISSUE_90_ID` | Catalog service variation ID |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Developer Console → Webhooks → signature key |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | Full webhook URL (see below) |
| `VITE_ENABLE_SQUARE_SANDBOX` | `true` for the Preview branch; `false`/unset everywhere else |

- Do **not** set `VITE_ENABLE_SQUARE_SANDBOX=true` in the Production environment.
- Credentials stored only in Vercel Preview are not available to a local
  process. For local testing, create a gitignored `.env` file with the same
  names.

### Optional, unverified: raw webhook body on Vercel

Vercel pre-parses `application/json` request bodies, which prevents the webhook
from reading the exact raw string Square signed. Setting `NODEJS_HELPERS=0` in
the Vercel environment exposes the raw request stream, but it changes behavior
for **all** Node functions. This is an **unverified requirement**: validate it
with a real signed Square Sandbox webhook before relying on it. Without it, the
webhook endpoint fails safe (rejects the request).

## 9. Webhook registration

1. Developer Console → Kai Lani Booking → **Webhooks**.
2. Add a subscription endpoint:
   `https://{preview-url}.vercel.app/api/square/webhook`.
3. Subscribe to event types: `booking.created`, `booking.updated`,
   `booking.cancelled`.
4. Square shows the **Signature Key**. Copy it to
   `SQUARE_WEBHOOK_SIGNATURE_KEY`.
5. Set `SQUARE_WEBHOOK_NOTIFICATION_URL` to the exact URL registered above —
   the signature check uses the raw body, the signature header, and this exact
   URL string.
6. Signature verification uses the official `WebhooksHelper.verifySignature`
   and happens **before** any JSON parsing.

Webhook event *processing* is intentionally a stub until a durable datastore is
selected. Only operational metadata (event ID, type, booking ID, status) is
logged.

## 10. Vercel Preview deployment

1. Push `feature/square-booking` and create a Vercel Preview deployment.
2. Confirm the `/api/*` routes stay outside the SPA fallback rewrite
   (`vercel.json` already handles this) and that functions run on a supported
   Node runtime.
3. Confirm the four-step flow renders with the visible **"Sandbox test mode"**
   label only on the Preview URL.

## 11. Testing in Sandbox

Use only fake test data, never real Chelsea or client information:

- Name: `Test Client`
- Email: `test-client@example.invalid`
- Phone: `(980) 555-0100`

1. Open the Preview URL, walk through Service → Date → Time → Contact.
2. Confirm the availability list matches Chelsea's Sandbox calendar.
3. Create a test booking and confirm it appears in the Sandbox Dashboard →
   **Bookings**.
4. Confirm a `booking.created` webhook hits the endpoint and the signature
   verifies.

## 12. Production launch blockers

The following must be resolved before anything runs against Chelsea's live
Square account:

1. **Durable, distributed rate limiting** (e.g., a managed service) — the
   in-memory limiter is a documented Sandbox-only best effort and is not
   production-safe on Vercel. Do not add Redis/Upstash/Vercel KV without
   explicit approval.
2. **Durable webhook event storage** — the in-memory dedupe does not survive
   cold starts or multiple instances. A durable datastore is required before
   webhook processing is enabled.
3. **Secure customer-initiated cancellation** — disabled (HTTP 501) until a
   future client-verification design. Cancellation by booking ID alone is
   forbidden.
4. **Production IDs and access token** — set the production `SQUARE_*`
   variables and production service variation IDs only when authorized.
5. **Validate `NODEJS_HELPERS=0`** against a signed Sandbox webhook before
   enabling webhooks on Vercel.
6. **Confirm Square confirmation emails/SMS** in the real environment before
   advertising them — this milestone never claims Square sends confirmations.

## 13. Production migration checklist

- [ ] Re-verify all `SQUARE_SERVICE_*_ID` values against the production catalog.
- [ ] Set production `SQUARE_ACCESS_TOKEN` / `SQUARE_LOCATION_ID` /
      `SQUARE_TEAM_MEMBER_ID` in the Production environment only.
- [ ] Keep `VITE_ENABLE_SQUARE_SANDBOX` unset (or `false`) in Production.
- [ ] Add durable rate limiting before opening to the public.
- [ ] Add durable webhook storage and enable webhook processing.
- [ ] Implement secure cancellation.
- [ ] Validate webhook raw-body handling on Vercel with a real signed event.
- [ ] Update the gift certificate flow only if Square gift certificates are
      separately approved.
- [ ] Remove the "Sandbox test mode" label.
