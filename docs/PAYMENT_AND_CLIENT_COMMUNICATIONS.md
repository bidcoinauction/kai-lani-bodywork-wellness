# Payment and Client Communications

Status: **optional prepayment implemented for confirmed appointments**. Launch
still supports pay-at-appointment and manual Square handling. Optional
prepayment uses Square-hosted Checkout Payment Links only; Kai Lani servers never
receive raw card numbers, CVV, expiration dates, or card-entry data. Square SDK
facts below were verified against installed `square@44.2.1` types under
`/node_modules/square/api/resources/*` and `/node_modules/square/api/types/*`.

## 0. Optional Square Prepayment

- Payment is optional and never required to confirm, preserve, or keep an
  appointment.
- Payment is offered only after the existing booking flow reaches local
  `status='approved'` and authoritative Square `square_booking_status='ACCEPTED'`.
- Clients may choose `Pay now securely with Square` or pay at the appointment.
- The payment endpoint is `POST /api/square/booking-requests/prepay` and accepts
  only the client-held `requestKey` capability. It ignores browser-supplied
  amounts, customer IDs, booking IDs, location IDs, service variation IDs, and
  order totals.
- Authoritative service prices come from `lib/services.js` and are converted to
  integer cents for Square: `$93 = 9300`, `$97 = 9700`, `$123 = 12300`, currency
  `USD`.
- Square-hosted checkout is created with
  `client.checkout.paymentLinks.create({ idempotencyKey, order,
  checkoutOptions, prePopulatedData, paymentNote })`.
- The deterministic idempotency key is `kai-lani.prepay.{requestId}`.
- Persistence stores only Square references and safe status fields:
  `square_payment_link_id`, `square_order_id`, `payment_link_url`,
  `payment_status`, `payment_created_at`, `payment_completed_at`.
- Payment status is read on demand from Square Orders via
  `client.orders.get({ orderId })`. The site displays `Payment received` only
  when Square returns authoritative paid evidence (`COMPLETED` order or zero net
  amount due). Returning from Square never implies payment by itself.
- No payment webhook is enabled in Phase 1. If live operations show that
  webhook-based reconciliation is required, stop and design that change before
  enabling it in Production.
- Refunds, changed services, changed prices, additional charges, and adjustments
  remain manually handled by Chelsea in Square.
- Pre-service tipping is disabled by request (`allowTipping: false`).

Required Square capabilities/scopes for the access token are the Checkout/Payment
Links write capability, Orders write capability for the hosted-checkout order,
and Orders read capability for payment-status checks. Confirm exact naming in the
Square Developer Console before enabling Production payment writes.

Square checkout branding is controlled by Square Online Checkout location
settings (`retrieveLocationSettings` / `updateLocationSettings`). Supported
fields include showing the location logo, button color, and button shape. The Kai
Lani primary brand color is `#0a1f24`. Do not silently mutate Square seller
account identity or branding in Production; review Sandbox checkout first and
only update settings when the displayed business identity matches Kai Lani.

Sandbox proof still required before Production payment writes:

1. Confirmed sandbox booking -> payment link created.
2. Square-hosted checkout opens.
3. Sandbox payment succeeds.
4. Square authoritative order state shows payment.
5. Kai Lani recognizes paid state.
6. Confirmed booking -> payment link created -> client does not pay -> appointment remains confirmed.
7. Repeated payment-link calls reuse one checkout and do not create duplicate payable orders.

## 1. Current State

- Kai Lani launches on **Square Appointments Free**. Website approval creates a
  buyer-level Square **Appointment (Booking)** and a Square **Customer** only;
  no Square Plus/Premium subscription is required for this workflow.
- The buyer-level booking is initially `PENDING`. Chelsea must accept it in
  Square Dashboard and then click `Check Square status` on the approval page.
  Only after Square reports `ACCEPTED` does the website send client/provider
  confirmation emails, ICS attachments, and Google Calendar links.
- Before appointment confirmation, no order, invoice, payment link, payment,
  receipt, refund, cancellation charge, or stored card is created. After Square
  confirms the appointment, the client may optionally create one Square-hosted
  payment link for the service price only.
- `booking_requests` stores `square_customer_id`, `square_booking_id`,
  `square_location_id`, `square_service_variation_id`, `square_team_member_id`,
  plus service selectable at booking time (`service_key`, `duration_minutes`).
  Prices exist in `lib/services.js` only (`price`: 93 / 93 / 97 / 123).
- **Post-approval today:** approve → Square customer + pending appointment
  created → Chelsea accepts in Square Dashboard → `Check Square status` →
  client/provider confirmation emails with `.ics` + Google Calendar link →
  client may optionally prepay through Square-hosted checkout or pay at the
  appointment.
- **Precondition facts:** a Square Appointment (Bookings API) is **not** an
  order. Square Invoices can only be created for an order created with the
  Orders API (`order_id` required on `CreateInvoice`). There is no direct
  "Appointment ID" field on an invoice. **Launch decision:** because optional
  prepayment uses Payment Links rather than invoices, invoice preparation remains
  handled manually inside the Square Dashboard by Chelsea.

## 2. Verified Square Invoice Capabilities

Verified from official docs + SDK types:

- **Order required:** Yes. `CreateInvoice` requires `order_id`; the order must
  exist, be `OPEN`, and have been created with the Orders API (not a Square
  product). One order ↔ one invoice.
- **Invoice → customer:** `primary_recipient.customer_id` (Customer Directory).
  Required to **publish**; optional to create the draft.
- **Invoice → order:** `order_id`. Invoice line items come from the order;
  amount-locking fields (`line_items`, `taxes`, `discounts`) can't be changed
  after association.
- **Invoice → location:** `location_id` must match the order's location.
- **Invoice → appointment/booking:** **No direct field.** Booking context must
  be placed on the order or invoice text.
- **Supported invoice features:** custom fields (max 2, subset below),
  `title`, `description`, payment requests (`BALANCE` / `DEPOSIT` /
  `INSTALLMENT`), `due_date`, accepted payment methods, `tipping_enabled` on
  the final payment request, taxes + discounts (via order), `sale_or_service_date`,
  partial payments (deposit + balance; installments require Invoices Plus).
- **Accepted payment methods:** `card`, `square_gift_card`, `bank_account`,
  `buy_now_pay_later`, `cash_app_pay`; at least one must be `true`.
- **Draft → published:** `CreateInvoice` returns `status: DRAFT` and takes no
  action; `PublishInvoice(invoiceId, version, idempotencyKey)` publishes.
  Draft invoices can stay in the account until published.
- **Automatic email:** With `delivery_method: EMAIL`, publishing emails the
  invoice to the recipient immediately (or on `scheduled_at`). With
  `SHARE_MANUALLY`, Square sends nothing (seller shares the payment link).
- **Receipts:** Square emails a receipt after a payment (payment page,
  automatic payment, or seller-recorded payment with "Send receipt").
- **Payment status:** Managed entirely by Square. APIs cannot pay an invoice.
  Reading status: `GetInvoice` (`status`, `next_payment_amount_money`) or
  resolve the order tender → `GetPayment`.
- **OAuth scopes:** `INVOICES_READ`, `INVOICES_WRITE`, `ORDERS_WRITE`;
  `CUSTOMERS_READ` + `PAYMENTS_WRITE` added only when publishing card-on-file.
- **Idempotency:** `CreateOrder` has `idempotency_key`; `CreateInvoice`,
  `PublishInvoice`, and `UpdateInvoice` accept deterministic `idempotency_key`.
  `PublishInvoice` also requires the current invoice `version`.
- **Webhooks:** Creating/publishing does **not require** webhooks. Optional
  events exist (`invoice.created`, `invoice.published`, `invoice.updated`,
  `invoice.payment_made`, `invoice.scheduled_charge_failed`, `invoice.canceled`,
  `invoice.refunded`, `invoice.deleted`). The launch workflow requires none.

These capabilities are documented for a **future automation phase**. At
launch, Chelsea uses the Square Dashboard / Square Invoices app directly; the
website does not call the Invoices API. Optional prepayment uses Checkout Payment
Links, which creates a Square-hosted checkout order for confirmed appointments
only.

## 3. Recommended Launch Workflow — OPTION A (MANUAL)

**The invoice workflow remains Option A: Chelsea manually creates, reviews, and
sends any Square invoice after the appointment.**

- Open the completed appointment in Square.
- Create the invoice in the Square Dashboard / Square Invoices app.
- Review amount, client, service, and license text.
- Send it only after the appointment.
- The website never creates invoices or handles card entry. Optional prepayment
  creates a Square-hosted Payment Link only after appointment confirmation.

Reasons:

- The final payment flow is not settled.
- Chelsea must review every amount before sending.
- No operator-authentication system exists for new server-side invoice routes.
- No automatic charge or invoice should occur at launch.
- Avoids adding API routes, database fields, migrations, or webhook
  dependencies before launch.
- Website invoice automation stays a documented future enhancement
  (Option B and later).

**Option B (website prepares a draft; Chelsea reviews and sends) is a future
automation phase, not part of launch.** It remains documented below and in
§12–§14 as deferred. Demo-flight Option B (or C) only after: operator auth is
designed, exact API field limits are confirmed, and Chelsea/Tyler explicitly
opt in.

## 4. Invoice Lifecycle (launch — manual)

1. Chelsea approves the website request, creating a buyer-level Square booking
   that is pending acceptance.
2. Chelsea accepts the pending appointment in Square Dashboard and clicks
   `Check Square status`; only then is the appointment confirmed by the website.
3. Appointment occurs. **No invoice is created before the appointment.**
4. Chelsea opens the completed appointment in Square.
5. Chelsea creates the invoice manually with the exact license text.
6. Chelsea reviews recipient, service, amount, due date, accepted payment
   methods, and license text.
7. Chelsea sends the invoice manually (Square emails it via the chosen
   delivery method).
8. Payment is handled by Square. Chelsea confirms the sent state in Square.
9. Never mark paid unless Square or Chelsea confirms the actual payment.

Seller-level writes, automatic one-click final acceptance, and broad calendar
reconciliation are future paid-plan capabilities. Webhook/QStash remain deferred
and unset at launch. Manual invoicing is unchanged.

## 5. Chelsea Review and Send Step (manual)

Every invoice goes through Chelsea's eyes before sending. There is no website
button, no automatic send, and no code path that can charge a client. The
review covers the recipient, service/duration, final amount (with any
discount, tip, tax, cash payment, cancellation fee, or adjustment), due date,
accepted payment methods, and the license text.

## 6. License Text Placement

Required professional identification on **every** invoice, exactly:

```
Chelsea Teller
NC LMBT License No. 19862
```

- **Launch placement:** the Square invoice **description** field, so no
  Invoices Plus subscription is required. Keep the two-line format where
  Square supports line breaks.
- **If the Square Dashboard removes the line break**, use the compliant
  single-line form without changing the wording:
  `Chelsea Teller - NC LMBT License No. 19862`
- **No "Active." No verification URL. No additional license claims.**
- **Do not claim this text automatically appears on Square receipts.** Receipt
  customization is separate and remains unverified (see §7).
- **Optional future enhancement:** a dedicated invoice **custom field**
  (`InvoiceCustomField`, requires Invoices Plus): label
  `Licensed Massage Therapist`, placement `BELOW_LINE_ITEMS`, value exactly
  `Chelsea Teller\nNC LMBT License No. 19862` (`\n` renders a new line). This
  is documented as optional and is **not** required at launch.

## 7. Invoice Versus Receipt Customization

- **Invoice customization:** description, title, custom fields (optional,
  Invoices Plus), line items, payment terms — shown on the hosted invoice
  page and in emailed/PDF invoice copies.
- **Receipts:** Square sends receipts automatically after payment. Official
  docs do **not** promise that invoice custom fields carry over to receipts,
  or that the seller can add this text to receipts via the Invoices API.
  **Receipt customization remains unverified and separate at launch.** Chelsea
  should confirm in the Square Dashboard whether the license text appears on
  receipts after a test send.
- **Separate surfaces that stay separate:**
  - Invoice customization → Square invoice description / custom field.
  - Receipt customization → Square Dashboard receipt settings (unverified).
  - Booking-confirmation email → existing `lib/email.js` content; unchanged.
  - Email signature → not in scope.
- The license text is not added to unrelated client-facing pages in this task.

## 8. Order and Invoice Idempotency (future automation reference)

For the future automation phase only; not required at launch:

- **Order create:** `CreateOrder` with a deterministic `idempotency_key`, e.g.
  `kai-lani.order.{requestId}` — safe on retry.
- **Invoice create:** deterministic `idempotency_key`, `kai-lani.invoice.{requestId}`.
- **Invoice publish:** `PublishInvoice` with `idempotencyKey` + the exact
  current `version` (from `CreateInvoice`) so a repeat cannot double-send.
- One invoice per appointment; avoid duplicates by reviewing Square before
  sending (launch) and by a unique `request_id` binding (future automation).

## 9. Duplicate Prevention (launch)

- Chelsea checks Square shows no existing invoice for the appointment before
  creating a new one.
- Create only one invoice per appointment; **avoid creating a second invoice
  for the same appointment.**
- If an invoice needs correction after sending, use Square's cancel/refund
  controls instead of sending a duplicate.

## 10. Failure and Retry Handling (launch)

- Manual, operator-visible: if a send fails or needs correction, Chelsea
  corrects and resends from the Square Dashboard. No automated retry loop in
  website code. (Future automation must reuse the safe non-2xx status mapping
  and never log tokens, customer data, or full bodies.)

## 11. Payment-State Truthfulness

- The website records `paid` only after authoritative Square order evidence and
  never claims a payment occurred from a redirect URL alone.
- Square is the source of truth. Chelsea only acts on what Square shows, and
  only marks an invoice paid when Square or Chelsea confirms the actual
  payment.
- No client charge happens on Kai Lani servers; optional prepayment is initiated
  only when the client chooses Square-hosted checkout.

## 12. Chelsea's Launch Invoice Checklist

1. Open the completed client appointment in Square.
2. Confirm the client name and completed service.
3. Confirm the final amount.
4. Account for any approved discount, tip, tax, cash payment, cancellation
   fee, or other adjustment.
5. Create the invoice only **after** the appointment.
6. Add exactly:
   ```
   Chelsea Teller
   NC LMBT License No. 19862
   ```
   (If Square's Dashboard removes the line break, use
   `Chelsea Teller - NC LMBT License No. 19862`.)
7. Review the recipient, service, amount, due date, accepted payment methods,
   and license text.
8. Send the invoice manually.
9. Confirm Square shows the invoice as sent.
10. Do not mark it paid unless Square or Chelsea confirms payment.
11. Avoid creating a second invoice for the same appointment.
12. Record cash or offline payments in Square using Chelsea's chosen process.

## 13. Square Dashboard Setup Before Launch

Manual settings Chelsea must confirm in the Square Dashboard / Square Invoices
app before the first client invoice:

- invoice delivery method (email vs. share manually)
- accepted payment methods (card, gift card, ACH/bank, Cash App, buy-now-pay-later)
- default due date
- tips
- taxes
- deposits
- partial payments
- cancellation / no-show fees
- discounts
- refunds
- cash / offline payment recording process
- whether Square supports a reusable invoice template that contains the license
  text (so the text is not typed on every invoice)

## 14. Related Behavior

- **Booking approval uses the Square Free two-stage path.** Chelsea approves the
  request, accepts the pending booking in Square Dashboard, then clicks `Check
  Square status`; only the accepted Square booking sends confirmation emails,
  `.ics` attachment, and Google Calendar link.
- **QStash / webhook reconciliation remains disabled and is not required for
  manual invoicing.** No webhook needs to be enabled for Chelsea to create and
  send an invoice manually, and this task does not enable or depend on webhooks.
- Square webhooks remain disabled.

## 15. Deferred Invoice Automation (not part of launch)

The following remain documented but are **not** initial-launch requirements:

- Operator-authentication mechanism for Chelsea-only invoice actions.
- New invoice API routes (`prepare` / `publish`) and re-enabling them are
  deferred; there is no safe operator-authentication method today.
- Database migration `003_invoice_fields.sql` and the proposed invoice columns
  (`invoice_status`, `square_order_id`, `square_invoice_id`,
  `square_invoice_version`, `invoice_created_at`, `invoice_published_at`,
  `payment_status`, `amount_minor`, `currency`, `invoice_failure_code`, unique
  per `request_id`).
- Website-created orders and draft invoices (Option B) and after-completion
  auto-send (Option C).
- `lib/square-invoice.js` order+invoice+publish helpers and deterministic
  idempotency keys.
- Invoices Plus enhancements (custom-field license text, installments).
- Webhook-based payment reconciliation when the deferred webhook work lands.

**Any future implementation must (a) verify the exact `InvoiceCustomField`
value length against the Square API reference, (b) confirm Invoices Plus
subscription status before relying on custom fields, and (c) solve
operator auth before exposing any operator route.**

## 16. Remaining Launch Decisions Tyler and Chelsea Must Confirm

1. When should Chelsea prepare the invoice? (launch: after the appointment)
2. When should Chelsea send the invoice? (launch: manually after review)
3. Payment due immediately or later? (`due_date` on the balance request)
4. Card payments accepted? (recommended: `card: true`)
5. ACH / other methods? (`bank_account` etc.)
6. Cash payments recorded in Square? (Chelsea's chosen process)
7. Tips enabled?
8. Taxes charged?
9. Deposits required?
10. Partial payments allowed?
11. Cancellation / no-show fees?
12. Discounts?
13. Refunds? (Square-managed; site reads status only)
14. Can Chelsea edit the amount before sending? (launch: yes, manually in Square)
15. Separate website email in addition to Square's invoice email? (booking
    emails stay; decide whether an invoice notice is added later)
16. Whether Square supports a reusable invoice template with the license text.

## 17. Upstream Verified Capability Note

Custom-field `value` line breaks are supported via `\n`; the exact maximum
length lives in the API reference and was not stated on the pages verified
here. Because launch places the text in the invoice `description` (no custom
fields), no Invoices Plus subscription is required at launch.

## See also (preserved)

- `docs/QSTASH_WEBHOOK_PREVIEW_RUNBOOK.md`
- `docs/REMINDER_ARCHITECTURE.md`

## Client communications (already implemented — preserved)

- **Contact consent is explicit and required** (`contactConsent === true`);
  never inferred. Marketing consent is separate/optional.
- Approval workflow emails (request receipt, approval link, confirmed
  client/provider with Google Calendar + `.ics`, decline, needs-reschedule)
  are sandbox-only, forced to `EMAIL_SANDBOX_RECIPIENT`.
- Unsubscribe endpoint ready at `api/square/unsubscribe.js`; only token hashes
  stored.
- **No marketing email is sent.** No license text added to any client-facing
  page in this task.
