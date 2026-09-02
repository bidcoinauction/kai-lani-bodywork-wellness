import { isBookingApprovalEnabled } from "../../../lib/approval-config.js";
import { getSquareClient } from "../../../lib/square.js";
import { requireBookingConfig, ConfigError } from "../../../lib/config.js";
import {
  buildApprovalUrl,
  findSlotAvailability,
  validateBookingRequest,
} from "../../../lib/booking-requests.js";
import {
  getBookingRequestStore,
  StoreConflictError,
} from "../../../lib/store.js";
import {
  approvalTokenTtlMinutes,
  generateApprovalToken,
  hashToken,
} from "../../../lib/tokens.js";
import { addMinutes } from "../../../lib/time.js";
import {
  sendApprovalEmail,
  sendBookingRequestReceivedEmail,
} from "../../../lib/email.js";
import { readJsonBody, BodyReadError } from "../../../lib/read-json-body.js";

export const PENDING_MESSAGE =
  "Your appointment request was sent. Chelsea will review your requested time. Your appointment is not confirmed until you receive an approval email.";

const CONFLICT_MESSAGE =
  "This request key was already used for a different appointment request.";

function replayMessage(status) {
  switch (status) {
    case "approved":
      return "Your appointment is confirmed.";
    case "declined":
      return "This appointment request was declined.";
    case "needs_reschedule":
      return "That time is no longer available. The client has been asked to request a new time.";
    case "expired":
      return "This appointment request has expired.";
    case "failed":
      return "This appointment request could not be processed.";
    case "approving":
      return "This appointment request is being processed. Please check your email for an update.";
    case "awaiting_square_acceptance":
      return "This appointment is pending acceptance in Square.";
    default:
      return PENDING_MESSAGE;
  }
}

export default async function handler(req, res) {
  if (!isBookingApprovalEnabled()) {
    return res
      .status(503)
      .json({ error: "Booking requests are not available right now." });
  }

  if (req.method === "GET") {
    return handleGetStatus(req, res);
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  return handleCreate(req, res);
}

/**
 * GET /api/square/booking-requests?requestKey=... — safe status lookup used by
 * the pending confirmation step to report whether a decision has been made.
 */
async function handleGetStatus(req, res) {
  const requestKey = typeof req.query?.requestKey === "string" ? req.query.requestKey : "";
  if (!requestKey) {
    return res.status(400).json({ error: "requestKey is required" });
  }

  const store = getBookingRequestStore();
  const row = await store.getRequestByKey(requestKey);
  if (!row) {
    return res.status(404).json({ error: "Request not found" });
  }

  return res.status(200).json({
    requestId: row.requestKey,
    requestKey: row.requestKey,
    status: row.status,
    decidedAt: row.decidedAt || null,
  });
}

async function handleCreate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }

  const validation = validateBookingRequest(body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }
  const input = validation.data;

  let config;
  try {
    config = requireBookingConfig(input.serviceKey);
  } catch (error) {
    if (error instanceof ConfigError) {
      return res.status(500).json({ error: error.message });
    }
    throw error;
  }

  const store = getBookingRequestStore();

  // Release any expired pending holds before checking availability or creating
  // a new request, so an unexpired request never sees a stale website hold.
  await store.expirePendingRequests();

  const existing = await store.getRequestByKey(input.requestKey);
  if (existing) {
    if (existing.requestKey === input.requestKey && existing.serviceKey === input.serviceKey) {
      // Same key, same payload: idempotent replay. Explicit contact consent is
      // required for every submission, so a replayed body has already passed
      // the consent check above.
      if (
        existing.firstName === input.firstName &&
        existing.lastName === input.lastName &&
        existing.email === input.email &&
        existing.phone === input.phone &&
        new Date(existing.startAt).getTime() === input.start.getTime()
      ) {
        if (input.marketingConsent) {
          await recordMarketingConsent(store, input.email);
        }
        return res.status(200).json({
          requestId: existing.requestKey,
          requestKey: existing.requestKey,
          status: existing.status,
          message: replayMessage(existing.status),
        });
      }
    }
    return res.status(409).json({ error: CONFLICT_MESSAGE });
  }

  let matched;
  try {
    const client = getSquareClient();
    matched = await findSlotAvailability(client, {
      locationId: config.locationId,
      teamMemberId: config.teamMemberId,
      service: config.service,
      start: input.start,
    });
  } catch (error) {
    console.error("Booking request availability check failed");
    return res
      .status(500)
      .json({ error: "Could not check availability right now. Please try again." });
  }
  if (!matched) {
    return res
      .status(409)
      .json({ error: "That time is no longer available. Please pick another." });
  }

  for (const status of ["pending", "approving", "awaiting_square_acceptance"]) {
    const overlaps = await store.findPendingOverlaps({
      startAt: input.start,
      durationMinutes: input.durationMinutes,
      status,
    });
    if (overlaps.length > 0) {
      return res
        .status(409)
        .json({ error: "That time is no longer available. Please pick another." });
    }
  }

  const token = generateApprovalToken();
  const approvalTokenHash = hashToken(token);
  const approvalTokenExpiresAt = addMinutes(
    new Date(),
    approvalTokenTtlMinutes(),
  );

  let row;
  try {
    row = await store.createRequest({
      requestKey: input.requestKey,
      serviceKey: input.serviceKey,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      startAt: input.start,
      durationMinutes: input.durationMinutes,
      approvalTokenHash,
      approvalTokenExpiresAt,
    });
  } catch (error) {
    if (error instanceof StoreConflictError) {
      if (error.code === "duplicate_request_key") {
        return res.status(409).json({ error: CONFLICT_MESSAGE });
      }
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }

  if (input.marketingConsent) {
    await recordMarketingConsent(store, input.email);
  }

  const request = {
    requestId: row.requestKey,
    requestKey: row.requestKey,
    serviceKey: row.serviceKey,
    serviceName: input.serviceName,
    durationMinutes: row.durationMinutes,
    startAt: row.startAt,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    price: input.price,
  };

  const requestReceipt = await sendBookingRequestReceivedEmail(request);
  await store.setRequestReceiptEmailStatus(row.id, requestReceipt);

  const approvalUrl = buildApprovalUrl(token);
  let approval = "failed";
  if (approvalUrl) {
    approval = await sendApprovalEmail({ ...request, approvalUrl });
  } else {
    console.info(
      `Email notification type=approval bookingSuffix=${row.id.slice(-6)} status=failed reason=public_site_url_missing`,
    );
  }
  await store.setApprovalEmailStatus(row.id, approval);

  return res.status(201).json({
    requestId: row.requestKey,
    requestKey: row.requestKey,
    status: row.status,
    message: PENDING_MESSAGE,
    serviceName: input.serviceName,
    startAt: row.startAt,
    notification: {
      requestReceipt,
      approval,
    },
  });
}

/**
 * Records explicit marketing consent from the booking form. Never inferred,
 * never returned, never sent a marketing email. The returned raw unsubscribe
 * token is intentionally discarded here: it will only ever be placed in a
 * future List-Unsubscribe header by the marketing sender.
 */
async function recordMarketingConsent(store, email) {
  try {
    await store.subscribeEmail({ normalizedEmail: email, squareCustomerId: null });
  } catch (error) {
    console.info(
      `Email subscription type=marketing-consent emailStatus=failed reason=store_error bookingSuffix=none`,
    );
  }
}
