import { isBookingApprovalEnabled } from "../../../lib/approval-config.js";
import { getSquareClient } from "../../../lib/square.js";
import { requireBookingConfig, ConfigError } from "../../../lib/config.js";
import {
  buildCustomerIdempotencyKey,
  buildSquareIdempotencyKey,
  findSlotAvailability,
  normalizePhoneForMatch,
  requestReference,
} from "../../../lib/booking-requests.js";
import { getBookingRequestStore } from "../../../lib/store.js";
import { hashToken } from "../../../lib/tokens.js";
import {
  buildGoogleCalendarUrl,
  buildIcsAttachment,
} from "../../../lib/calendar.js";
import {
  sendApprovedClientEmail,
  sendApprovedProviderEmail,
  sendNeedsRescheduleEmail,
} from "../../../lib/email.js";
import { readJsonBody, BodyReadError } from "../../../lib/read-json-body.js";
import { getServiceConfig } from "../../../lib/services.js";

const INVALID_OR_EXPIRED = "This approval link is invalid or has expired.";
const TOKEN_REQUIRED = "An approval token is required.";
const CUSTOMER_CONFLICT_MESSAGE =
  "The email and phone resolve to different customer profiles. Manual review is required before this request can be approved.";

/**
 * Approval pivot.
 *
 * State machine:
 *   pending    -> approving   atomic claim (before any Square call)
 *   approving  -> approving   safe resume (recordApprovalAttempt)
 *   approving  -> approved    after Square returns a booking id
 *   approving  -> needs_reschedule  slot no longer available (fresh claim only)
 *   approving  -> failed      Square/customer/server error (failure_code)
 *
 * Crash recovery: the Square booking create and customer create both use
 * deterministic idempotency keys derived from the request id, so a resume of
 * an 'approving' request (e.g. the function crashed after Square ACCEPTED but
 * before DB finalization) reuses the same keys and Square returns the original
 * booking/customer instead of creating a second one. Availability is NOT
 * re-checked on resume because a successfully created booking would now occupy
 * the slot and would be misread as "slot gone".
 *
 * Email retry: finalization (approved status + Square ids + calendar data) is
 * persisted BEFORE any confirmation email is sent. Emails are sent only when
 * their persisted status is not 'sent', so a resubmitted token retries a
 * failed notification without ever duplicating a delivered one, and an email
 * failure never marks the appointment failed or needs_reschedule.
 */
export default async function handler(req, res) {
  if (!isBookingApprovalEnabled()) {
    return res
      .status(503)
      .json({ error: "Booking requests are not available right now." });
  }

  if (req.method === "GET") {
    return handleSummary(req, res);
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  return handleApprove(req, res);
}

function tokenFromQuery(req) {
  const token = typeof req.query?.token === "string" ? req.query.token : "";
  return token.trim();
}

function tokenFromBody(body) {
  const token = body && typeof body.token === "string" ? body.token.trim() : "";
  return token;
}

function isTokenExpired(row) {
  if (!row.approvalTokenExpiresAt) return true;
  return new Date(row.approvalTokenExpiresAt).getTime() <= Date.now();
}

function serviceNameFor(row) {
  const service = getServiceConfig(row.serviceKey);
  return service ? service.name : row.serviceKey;
}

function appointmentFor(row, bookingId) {
  return {
    bookingId,
    serviceName: serviceNameFor(row),
    duration: row.durationMinutes,
    startAt: row.startAt,
  };
}

function approvedOutcome(row, { bookingId, calendarUrl, confirmation, provider }) {
  return {
    status: "approved",
    requestId: row.id,
    bookingId,
    calendarUrl,
    serviceName: serviceNameFor(row),
    startAt: row.startAt,
    message: "Your appointment is confirmed.",
    notification: { confirmation, provider },
  };
}

function declinedOutcome(row) {
  return {
    status: "declined",
    requestId: row.id,
    message: "This appointment request was declined.",
  };
}

function needsRescheduleOutcome(row, { emailStatus }) {
  return {
    status: "needs_reschedule",
    requestId: row.id,
    message: "That time is no longer available. The client has been asked to request a new time.",
    notification: { needsReschedule: emailStatus },
  };
}

function failedOutcome(row) {
  return {
    status: "failed",
    requestId: row.id,
    failureCode: row.failureCode || null,
    message: "This appointment request could not be processed.",
  };
}

async function handleSummary(req, res) {
  const token = tokenFromQuery(req);
  if (!token) {
    return res.status(400).json({ error: TOKEN_REQUIRED });
  }

  const store = getBookingRequestStore();
  const row = await store.getRequestByApprovalTokenHash(hashToken(token));
  if (!row) {
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }
  if (row.status === "pending" || row.status === "approving") {
    if (isTokenExpired(row)) {
      return res.status(404).json({ error: INVALID_OR_EXPIRED });
    }
  }
  if (row.status === "expired") {
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }

  let calendarUrl = null;
  if (row.status === "approved" && row.squareBookingId) {
    calendarUrl = buildApprovedCalendarUrl(row);
  }

  return res.status(200).json({
    requestId: row.id,
    status: row.status,
    decided: row.status !== "pending" && row.status !== "approving",
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    serviceName: serviceNameFor(row),
    durationMinutes: row.durationMinutes,
    startAt: row.startAt,
    bookingId: row.squareBookingId || null,
    calendarUrl,
    failureCode: row.failureCode || null,
    decidedAt: row.decidedAt || null,
  });
}

async function handleApprove(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }

  const token = tokenFromBody(body);
  if (!token) {
    return res.status(400).json({ error: TOKEN_REQUIRED });
  }

  const store = getBookingRequestStore();
  await store.expirePendingRequests();

  const row = await store.getRequestByApprovalTokenHash(hashToken(token));
  if (!row) {
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }

  if (row.status === "pending" || row.status === "approving") {
    if (isTokenExpired(row)) {
      return res.status(404).json({ error: INVALID_OR_EXPIRED });
    }
  }

  if (row.status === "approved") {
    return res.status(200).json(await approvedIdempotentOutcome(store, row));
  }
  if (row.status === "declined") {
    return res.status(200).json(declinedOutcome(row));
  }
  if (row.status === "needs_reschedule") {
    return res.status(200).json(needsRescheduleOutcome(row, {
      emailStatus: row.needsRescheduleEmailStatus,
    }));
  }
  if (row.status === "failed") {
    return res.status(200).json(failedOutcome(row));
  }
  if (row.status === "expired") {
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }

  if (row.status === "approving") {
    // Crash recovery: a previous attempt started this approval. Resuming is
    // safe because the Square calls reuse deterministic idempotency keys, and
    // availability is NOT re-checked here (the prior attempt's booking, if
    // any, already occupies the slot).
    await store.recordApprovalAttempt(row.id);
    return createAndFinalize(req, res, store, row, undefined);
  }

  // pending: atomic claim, committed BEFORE any Square or Resend call.
  const claimed = await store.claimForApproval(row.id);
  if (!claimed) {
    const current = await store.getRequestById(row.id);
    if (!current) {
      return res
        .status(500)
        .json({ error: "Could not approve the appointment right now. Please try again." });
    }
    if (current.status === "approving") {
      await store.recordApprovalAttempt(current.id);
      return createAndFinalize(req, res, store, current, undefined);
    }
    if (current.status === "approved") {
      return res.status(200).json(await approvedIdempotentOutcome(store, current));
    }
    if (current.status === "declined") {
      return res.status(200).json(declinedOutcome(current));
    }
    if (current.status === "failed") {
      return res.status(200).json(failedOutcome(current));
    }
    if (current.status === "needs_reschedule") {
      return res.status(200).json(needsRescheduleOutcome(current, {
        emailStatus: current.needsRescheduleEmailStatus,
      }));
    }
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }

  return performFreshApproval(req, res, store, claimed);
}

/**
 * Fresh approval (this attempt won the atomic claim): re-check Square
 * availability before creating the booking.
 */
async function performFreshApproval(req, res, store, row) {
  let config;
  try {
    config = requireBookingConfig(row.serviceKey);
  } catch (error) {
    if (error instanceof ConfigError) {
      await store.markFailed({ id: row.id, failureCode: "server_config" });
      return res.status(500).json({ error: error.message });
    }
    throw error;
  }

  let client;
  try {
    client = getSquareClient();
  } catch {
    return res
      .status(500)
      .json({ error: "Could not approve the appointment right now. Please try again." });
  }

  const start = new Date(row.startAt);
  let matched;
  try {
    matched = await findSlotAvailability(client, {
      locationId: config.locationId,
      teamMemberId: config.teamMemberId,
      service: config.service,
      start,
    });
  } catch (error) {
    console.error("Booking request availability recheck failed");
    return res
      .status(500)
      .json({ error: "Could not verify availability right now. Please try again." });
  }

  if (!matched) {
    const updated = await store.markNeedsReschedule({ id: row.id });
    const needsReschedule = await sendNeedsRescheduleEmail(requestEmailData(row));
    const current = updated || row;
    if (current.id === row.id) {
      await store.setNeedsRescheduleEmailStatus(row.id, needsReschedule);
    }
    return res.status(200).json(needsRescheduleOutcome(current, { emailStatus: needsReschedule }));
  }

  const serviceVariationVersion = matched.appointmentSegments?.[0]?.serviceVariationVersion;
  if (
    typeof serviceVariationVersion !== "bigint" &&
    typeof serviceVariationVersion !== "number"
  ) {
    console.error("Booking request approval missing service variation version");
    await store.markFailed({ id: row.id, failureCode: "server_config" });
    return res
      .status(500)
      .json({ error: "Could not approve the appointment right now. Please try again." });
  }

  return createAndFinalize(req, res, store, row, serviceVariationVersion);
}

/**
 * Shared create-and-finalize used by both fresh approvals and resumes. Square
 * is called with the deterministic booking idempotency key; the result is
 * finalized to 'approved' BEFORE any email is sent.
 */
async function createAndFinalize(req, res, store, row, serviceVariationVersion) {
  let client;
  try {
    client = getSquareClient();
  } catch {
    return res
      .status(500)
      .json({ error: "Could not approve the appointment right now. Please try again." });
  }

  let config;
  try {
    config = requireBookingConfig(row.serviceKey);
  } catch (error) {
    if (error instanceof ConfigError) {
      await store.markFailed({ id: row.id, failureCode: "server_config" });
      return res.status(500).json({ error: error.message });
    }
    throw error;
  }

  let customerId;
  try {
    customerId = await findOrCreateCustomer(client, {
      requestId: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
    });
  } catch (error) {
    if (error instanceof CustomerMatchConflict) {
      await store.markFailed({ id: row.id, failureCode: "customer_conflict" });
      return res.status(409).json({ error: CUSTOMER_CONFLICT_MESSAGE });
    }
    if (error instanceof CustomerCreateError) {
      await store.markFailed({ id: row.id, failureCode: "customer_create" });
    } else {
      await store.markFailed({ id: row.id, failureCode: "customer_lookup" });
    }
    console.error("Booking request customer lookup failed");
    return res
      .status(500)
      .json({ error: "Could not approve the appointment right now. Please try again." });
  }

  let response;
  try {
    response = await client.bookings.create({
      idempotencyKey: buildSquareIdempotencyKey(row.id),
      booking: {
        startAt: new Date(row.startAt).toISOString(),
        locationId: config.locationId,
        customerId,
        sellerNote: `Kai Lani website approval request: ${requestReference(row.id)}`,
        appointmentSegments: [
          {
            durationMinutes: config.service.durationMinutes,
            serviceVariationId: config.service.serviceVariationId,
            teamMemberId: config.teamMemberId,
            serviceVariationVersion,
          },
        ],
      },
    });
  } catch (error) {
    await store.markFailed({ id: row.id, failureCode: "square_error" });
    console.error(`Booking request square create failed status=${squareErrorStatus(error)}`);
    const status = squareErrorStatus(error);
    return res.status(status).json({ error: clientFacingMessage(status) });
  }

  const booking = response.booking;
  if (!booking || !booking.id) {
    await store.markFailed({ id: row.id, failureCode: "booking_missing" });
    console.error("Booking request square create returned no booking");
    return res
      .status(500)
      .json({ error: "Could not approve the appointment right now. Please try again." });
  }

  const calendarUrl = buildApprovedCalendarUrlFor(row, booking.id);
  const updated = await store.markApproved({
    id: row.id,
    squareCustomerId: customerId,
    squareBookingId: booking.id,
    squareBookingStatus: booking.status || "PENDING",
    calendarUrl,
  });

  if (!updated) {
    // A concurrent resume finalized first; answer with the current state.
    const current = await store.getRequestById(row.id);
    if (!current) {
      return res
        .status(500)
        .json({ error: "Could not approve the appointment right now. Please try again." });
    }
    if (current.status === "approved") {
      return res.status(200).json(await approvedIdempotentOutcome(store, current));
    }
    if (current.status === "declined") {
      return res.status(200).json(declinedOutcome(current));
    }
    if (current.status === "failed") {
      return res.status(200).json(failedOutcome(current));
    }
    return res.status(200).json(needsRescheduleOutcome(current, {
      emailStatus: current.needsRescheduleEmailStatus,
    }));
  }

  await store.backfillSubscriptionCustomer(updated.email, customerId);

  if (booking.status !== "ACCEPTED") {
    console.info(
      `Booking request bookingSuffix=${booking.id.slice(-6)} status=square_pending`,
    );
    return res.status(200).json(approvedOutcome(updated, {
      bookingId: booking.id,
      calendarUrl,
      confirmation: "none",
      provider: "none",
    }));
  }

  const appointment = appointmentFor(updated, booking.id);
  const confirmedCalendarUrl = buildGoogleCalendarUrl(appointment);
  const { confirmation, provider } = await ensureConfirmationsSent(
    store,
    updated,
    booking.id,
    confirmedCalendarUrl,
  );

  return res.status(200).json(approvedOutcome(updated, {
    bookingId: booking.id,
    calendarUrl: confirmedCalendarUrl,
    confirmation,
    provider,
  }));
}

/**
 * Idempotent answer for an already-approved token. Never re-decides and never
 * creates a booking; it only retries confirmation emails whose persisted
 * status is not 'sent' (no duplicate client/provider confirmation).
 */
async function approvedIdempotentOutcome(store, row) {
  let confirmation = row.confirmationEmailStatus;
  let provider = row.providerConfirmationEmailStatus;
  if (row.squareBookingStatus === "ACCEPTED" && row.squareBookingId) {
    const calendarUrl = buildApprovedCalendarUrl(row) || "";
    if (confirmation !== "sent" || provider !== "sent") {
      const result = await ensureConfirmationsSent(
        store,
        row,
        row.squareBookingId,
        calendarUrl,
      );
      confirmation = result.confirmation;
      provider = result.provider;
    }
  }
  return approvedOutcome(row, {
    bookingId: row.squareBookingId,
    calendarUrl: buildApprovedCalendarUrl(row),
    confirmation,
    provider,
  });
}

/**
 * Sends only confirmation emails that were not already delivered, persisting
 * each outcome. Email failure here can never mark the request failed or
 * needs_reschedule.
 */
async function ensureConfirmationsSent(store, row, bookingId, calendarUrl) {
  let confirmation = row.confirmationEmailStatus;
  let provider = row.providerConfirmationEmailStatus;
  if (confirmation !== "sent") {
    confirmation = await sendApprovedClientEmail({
      ...requestEmailData(row),
      bookingId,
      calendarUrl,
    });
    await store.setConfirmationEmailStatus(row.id, confirmation);
  }
  if (provider !== "sent") {
    provider = await sendApprovedProviderEmail({
      ...requestEmailData(row),
      bookingId,
      calendarUrl,
    });
    await store.setProviderConfirmationEmailStatus(row.id, provider);
  }
  return { confirmation, provider };
}

function buildApprovedCalendarUrl(row) {
  if (row.status !== "approved" || !row.squareBookingId) return null;
  return buildApprovedCalendarUrlFor(row, row.squareBookingId);
}

function buildApprovedCalendarUrlFor(row, bookingId) {
  try {
    return buildGoogleCalendarUrl(appointmentFor(row, bookingId));
  } catch {
    return null;
  }
}

function requestEmailData(row) {
  return {
    requestId: row.id,
    requestKey: row.requestKey,
    serviceKey: row.serviceKey,
    serviceName: serviceNameFor(row),
    durationMinutes: row.durationMinutes,
    startAt: row.startAt,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
  };
}

class CustomerMatchConflict extends Error {
  constructor() {
    super("customer_match_conflict");
    this.name = "CustomerMatchConflict";
  }
}

class CustomerCreateError extends Error {
  constructor() {
    super("customer_create_failed");
    this.name = "CustomerCreateError";
  }
}

/**
 * Square Customer Directory matching audit:
 *  - normalize email and phone before searching
 *  - search Square by exact email, then by exact phone
 *  - both resolve to the same customer  -> reuse it
 *  - one resolves, the other does not   -> reuse the resolved customer without
 *    overwriting its populated fields (we never pass a note)
 *  - email and phone resolve to DIFFERENT customers -> stop for manual review
 *  - neither resolves -> create exactly one customer with a deterministic
 *    idempotency key so retries never create duplicates
 * No Customer Directory note is ever written, and no health/medical note is
 * added. The Square seller_note remains a safe website request reference.
 */
async function findOrCreateCustomer(client, { requestId, firstName, lastName, email, phone }) {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const normalizedPhone = normalizePhoneForMatch(phone);

  let emailCustomer = null;
  if (normalizedEmail) {
    const emailSearch = await client.customers.search({
      query: {
        filter: { emailAddress: { exact: normalizedEmail } },
      },
    });
    emailCustomer = emailSearch.customers?.[0] || null;
  }

  let phoneCustomer = null;
  if (normalizedPhone) {
    const phoneSearch = await client.customers.search({
      query: {
        filter: { phoneNumber: { exact: normalizedPhone } },
      },
    });
    phoneCustomer = phoneSearch.customers?.[0] || null;
  }

  if (emailCustomer && phoneCustomer) {
    if (emailCustomer.id === phoneCustomer.id) return emailCustomer.id;
    throw new CustomerMatchConflict();
  }
  if (emailCustomer) return emailCustomer.id;
  if (phoneCustomer) return phoneCustomer.id;

  const created = await client.customers.create({
    idempotencyKey: buildCustomerIdempotencyKey(requestId),
    customer: {
      givenName: firstName,
      familyName: lastName,
      emailAddress: email,
      phoneNumber: phone,
    },
  });
  if (!created.customer || !created.customer.id) {
    throw new CustomerCreateError();
  }
  return created.customer.id;
}

function squareErrorStatus(error) {
  if (
    error &&
    typeof error === "object" &&
    typeof error.statusCode === "number"
  ) {
    const code = error.statusCode;
    if (code === 400) return 400;
    if (code === 404) return 400;
    if (code === 409) return 409;
    if (code === 429) return 429;
    if (code >= 500) return 500;
  }
  return 500;
}

function clientFacingMessage(statusCode) {
  switch (statusCode) {
    case 400:
      return "The appointment could not be approved. Please review the details.";
    case 409:
      return "That time is no longer available. Please pick another.";
    case 429:
      return "Too many requests. Please try again shortly.";
    default:
      return "Could not approve the appointment right now. Please try again.";
  }
}
