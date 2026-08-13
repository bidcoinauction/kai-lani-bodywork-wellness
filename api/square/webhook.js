import { isBookingApprovalEnabled } from "../../lib/approval-config.js";
import { getSquareClient, WebhooksHelper } from "../../lib/square.js";
import { getBookingRequestStore, WebhookReconcileError } from "../../lib/store.js";
import { readRawBody } from "../../lib/read-raw-body.js";

const SUPPORTED_EVENTS = new Set(["booking.created", "booking.updated"]);
const CANCELED_STATUSES = new Set([
  "DECLINED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
]);
const CANCELLED_WITH_TIMESTAMP = new Set([
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
]);

function safeString(value, max = 120) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(cleaned)) return "redacted";
  return cleaned.slice(0, max);
}

// Square classifies responses taking longer than 10 seconds as http_timeout.
// This synchronous reconciliation path is Sandbox-only; a durable queue/worker
// is required before Production webhook activation. A non-2xx synthetic test
// result is acceptable when Square's fake booking does not exist; a 504 is not.
// The SDK only enforces a timeout when timeoutInSeconds is supplied, and aborts
// the underlying fetch on timeout, so no uncontrolled work continues.
const SQUARE_RETRIEVE_TIMEOUT_SECONDS = 2;

function bookingSuffix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) return "";
  return value.slice(-6);
}

function logStage(stage, eventType, bookingId, startedAt, errorCode = null) {
  console.info(
    `webhook stage=${stage} eventType=${eventType} bookingSuffix=${bookingSuffix(bookingId)} elapsedMs=${Date.now() - startedAt}${errorCode ? ` error=${errorCode}` : ""}`,
  );
}

function bookingIdFromEvent(event) {
  if (typeof event.data?.object?.booking?.id !== "string") return "";
  const bookingId = event.data.object.booking.id.trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(bookingId)) return "";
  return bookingId;
}

function bookingVersion(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function firstSegment(booking) {
  return Array.isArray(booking.appointmentSegments) ? booking.appointmentSegments[0] || null : null;
}

function durationMinutesFromBooking(booking) {
  const segment = firstSegment(booking);
  const duration = Number(segment?.durationMinutes);
  if (duration === 60 || duration === 90) return duration;
  return null;
}

function syncStatusFor(booking, row) {
  const status = String(booking.status || "");
  if (status === "ACCEPTED") {
    const duration = durationMinutesFromBooking(booking);
    const startChanged =
      new Date(row.startAt).getTime() !== new Date(booking.startAt).getTime() ||
      Number(row.durationMinutes) !== Number(duration);
    return startChanged ? "rescheduled" : "created";
  }
  if (status === "PENDING") return "created";
  if (CANCELED_STATUSES.has(status)) return "canceled";
  if (status === "NO_SHOW") return "no_show";
  return "failed";
}

function normalizedAuthoritativeBooking(booking, row) {
  const status = String(booking.status || "");
  const version = bookingVersion(booking.version);
  const durationMinutes = durationMinutesFromBooking(booking);
  const segment = firstSegment(booking);

  if (!booking.id) throw new WebhookReconcileError("booking_missing_id");
  if (version == null) throw new WebhookReconcileError("booking_missing_version");
  if (!booking.startAt || Number.isNaN(new Date(booking.startAt).getTime())) {
    throw new WebhookReconcileError("booking_missing_start_at");
  }
  if (!durationMinutes) throw new WebhookReconcileError("booking_missing_duration");

  const syncStatus = syncStatusFor(booking, row);
  return {
    squareBookingId: booking.id,
    squareBookingVersion: version,
    squareBookingStatus: status,
    startAt: new Date(booking.startAt).toISOString(),
    durationMinutes,
    squareServiceVariationId: segment?.serviceVariationId || null,
    squareLocationId: booking.locationId || null,
    squareTeamMemberId: segment?.teamMemberId || null,
    squareSyncStatus: syncStatus,
    squareCanceledAt: CANCELLED_WITH_TIMESTAMP.has(status) ? new Date().toISOString() : null,
    squareSyncError: syncStatus === "failed" ? `unknown_status:${safeString(status, 40)}` : null,
  };
}

async function fetchAuthoritativeBooking(client, bookingId) {
  const response = await client.bookings.get(
    { bookingId },
    { timeoutInSeconds: SQUARE_RETRIEVE_TIMEOUT_SECONDS, maxRetries: 0 },
  );
  return response?.booking || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isBookingApprovalEnabled()) {
    return res.status(503).json({ error: "Square webhook processing is not available right now." });
  }

  const signature = req.headers["x-square-hmacsha256-signature"];
  const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!signature || !notificationUrl || !signatureKey) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    return res.status(400).json({
      error: "Could not read the raw request body. Verify the platform does not pre-parse JSON bodies.",
    });
  }

  const isFromSquare = await WebhooksHelper.verifySignature({
    requestBody: rawBody,
    signatureHeader: signature,
    signatureKey,
    notificationUrl,
  });
  if (!isFromSquare) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid payload" });
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const eventType = typeof event.type === "string" ? event.type : "";
  if (!SUPPORTED_EVENTS.has(eventType)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const eventId = typeof event.event_id === "string" ? event.event_id : "";
  const squareBookingId = bookingIdFromEvent(event);
  if (!eventId) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const startedAt = Date.now();
  const merchantId = typeof event.merchant_id === "string" ? event.merchant_id : "";
  const embeddedVersion = bookingVersion(event.data?.object?.booking?.version);
  const store = getBookingRequestStore();

  let claim;
  try {
    claim = await store.claimWebhookEvent({
      eventId,
      eventType,
      merchantId,
      squareBookingId: squareBookingId || null,
      squareBookingVersion: embeddedVersion,
    });
  } catch {
    logStage("failed", eventType, squareBookingId, startedAt, "claim_failed");
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }
  if (!claim.claimed) {
    return res.status(200).json({
      received: true,
      duplicate: true,
      status: claim.event?.processingStatus || "unknown",
    });
  }
  logStage("claimed", eventType, squareBookingId, startedAt);

  if (!squareBookingId) {
    await store.markWebhookFailed(eventId, "booking_id_missing");
    logStage("failed", eventType, squareBookingId, startedAt, "booking_id_missing");
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }

  let authoritative;
  try {
    logStage("square_fetch", eventType, squareBookingId, startedAt);
    authoritative = await fetchAuthoritativeBooking(getSquareClient(), squareBookingId);
  } catch {
    await store.markWebhookFailed(eventId, "square_fetch_failed");
    logStage("failed", eventType, squareBookingId, startedAt, "square_fetch_failed");
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }
  if (!authoritative) {
    await store.markWebhookFailed(eventId, "square_booking_missing");
    logStage("failed", eventType, squareBookingId, startedAt, "square_booking_missing");
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }
  logStage("square_fetched", eventType, squareBookingId, startedAt);

  let row;
  try {
    row = await store.findRequestBySquareBookingId(squareBookingId);
  } catch {
    await store.markWebhookFailed(eventId, "local_lookup_failed");
    logStage("failed", eventType, squareBookingId, startedAt, "local_lookup_failed");
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }
  if (!row) {
    await store.markWebhookIgnored(eventId, "unknown_booking_id");
    logStage("ignored", eventType, squareBookingId, startedAt, "unknown_booking_id");
    return res.status(200).json({ received: true, ignored: true });
  }
  logStage("local_lookup", eventType, squareBookingId, startedAt);

  let normalized;
  try {
    normalized = normalizedAuthoritativeBooking(authoritative, row);
  } catch (error) {
    const code = safeString(error.code || "invalid_booking");
    await store.markWebhookFailed(eventId, code);
    logStage("failed", eventType, squareBookingId, startedAt, code);
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }

  if (
    row.squareBookingVersion != null &&
    Number(normalized.squareBookingVersion) <= Number(row.squareBookingVersion)
  ) {
    await store.markWebhookProcessed(eventId);
    logStage("stale", eventType, squareBookingId, startedAt);
    return res.status(200).json({ received: true, stale: true });
  }

  try {
    const result = await store.reconcileSquareBooking({
      requestId: row.id,
      ...normalized,
    });
    if (result?.reconciled === false) {
      await store.markWebhookProcessed(eventId);
      logStage("stale", eventType, squareBookingId, startedAt);
      return res.status(200).json({ received: true, stale: true });
    }
    await store.markWebhookProcessed(eventId);
    logStage("processed", eventType, squareBookingId, startedAt);
    return res.status(200).json({ received: true });
  } catch (error) {
    const code = error instanceof WebhookReconcileError ? error.code : "reconcile_failed";
    const safeCode = safeString(code);
    await store.markWebhookFailed(eventId, safeCode);
    logStage("failed", eventType, squareBookingId, startedAt, safeCode);
    return res.status(500).json({ error: "Could not reconcile Square booking right now." });
  }
}

export const webhookTestInternals = {
  SUPPORTED_EVENTS,
  SQUARE_RETRIEVE_TIMEOUT_SECONDS,
  normalizedAuthoritativeBooking,
  syncStatusFor,
};
