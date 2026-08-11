# Payment and Client Communications

Status: **design / addendum** — no payment code exists in this task.

## Payment

- **Recommended initial flow:** Chelsea completes checkout in Square after the
  appointment, in person (card present) or via a Square invoice/request sent to
  the client afterward. The website never takes payment.
- **Square is the payment source of truth.** The `booking_requests` table and
  the rest of the site store no payment fields, no amounts owed, and no card or
  bank data. Square's Dashboard/reports are the record of what was charged.
- **No card data is stored by the website or Neon.** The site never collects,
  transmits, or persists PANs, CVV, or expiration dates. Square handles PCI;
  the site stays out of scope.
- **Future: invoice / payment-link option.** Chelsea can send a Square payment
  link after approval (or later, at booking time) so clients can pay online.
  This is a Square Dashboard/Seller capability, not a new website integration.
- **Future: deposit / no-show policy decision.** Undecided. Before any deposit
  is charged, this repo needs a policy decision and an explicit Square
  implementation (prepaid vs. card-on-file deposit), plus a client-facing
  disclosure in the booking flow.
- **Future: payment reconciliation / webhook requirement.** If payment is ever
  automated, Square payment webhooks should reconcile paid/refunded events
  against a payment-status column. This is a separate, future task.

## Client communications (already implemented)

- **Contact consent is explicit and required** (`contactConsent === true` in the
  request payload; the checkbox is required, unchecked by default, and scoped to
  appointment-related communication). It is never inferred from submission.
- **Approval workflow emails** (request receipt, approval link to Chelsea,
  approved client/provider confirmations with Google Calendar link and
  `kai-lani-appointment.ics`, decline, needs-reschedule) are currently
  sandbox-only and forced to `EMAIL_SANDBOX_RECIPIENT`.
- **Marketing consent is optional and separate** (`marketingConsent`). Opt-in
  only; a false/absent value creates no subscription; existing clients are never
  auto-subscribed; an unsubscribed address is never re-subscribed. Consent
  source `kai-lani-booking-form` is stored on the `email_subscriptions` row.
- **Unsubscribe** is prepared at `api/square/unsubscribe.js` (GET preference
  page read-only; POST performs the unsubscribe; only the token hash is stored;
  no private subscriber information returned; idempotent). Future marketing
  emails should point `List-Unsubscribe` / `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` at this endpoint.
- **No marketing email is sent by this task.**

## See also

- `docs/REMINDER_ARCHITECTURE.md` — durable appointment reminders (design only).
