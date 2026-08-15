import { getSquareClient } from "./square.js";
import { getBookingRequestStore, WebhookReconcileError } from "./store.js";
import { bookingVersion, safeString, validateSquareWebhookQueueMessage } from "./square-webhook-message.js";

const CANCELED_STATUSES = new Set([
  "DECLINED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
]);
const CANCELLED_WITH_TIMESTAMP = new Set([
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
]);

// Worker-side Square fetch remains bounded even though Square is no longer waiting.
export const SQUARE_RETRIEVE_TIMEOUT_SECONDS = 2;

function bookingSuffix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) return "";
  return value.slice(-6);
}

function logStage(stage, eventType, bookingId, startedAt, errorCode = null) {
  console.info(
    `webhook-worker stage=${stage} eventType=${eventType} bookingSuffix=${bookingSuffix(bookingId)} elapsedMs=${Date.now() - startedAt}${errorCode ? ` error=${errorCode}` : ""}`,
  );
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

export async function reconcileSquareWebhookMessage(message, options = {}) {
  validateSquareWebhookQueueMessage(message);
  const startedAt = options.startedAt || Date.now();
  const eventId = message.eventId;
  const eventType = message.eventType;
  const squareBookingId = message.bookingId;
  const embeddedVersion = bookingVersion(message.bookingVersion);
  const store = options.store || getBookingRequestStore();
  const squareClient = options.squareClient || getSquareClient();

  let claim;
  try {
    claim = await store.claimWebhookEvent({
      eventId,
      eventType,
      merchantId: null,
      squareBookingId,
      squareBookingVersion: embeddedVersion,
    });
  } catch {
    logStage("failed", eventType, squareBookingId, startedAt, "claim_failed");
    return { statusCode: 503, body: { error: "Could not reconcile Square booking right now." } };
  }
  if (!claim.claimed) {
    return {
      statusCode: 200,
      body: { received: true, duplicate: true, status: claim.event?.processingStatus || "unknown" },
    };
  }
  logStage("claimed", eventType, squareBookingId, startedAt);

  let authoritative;
  try {
    logStage("square_fetch", eventType, squareBookingId, startedAt);
    authoritative = await fetchAuthoritativeBooking(squareClient, squareBookingId);
  } catch {
    await store.markWebhookFailed(eventId, "square_fetch_failed");
    logStage("failed", eventType, squareBookingId, startedAt, "square_fetch_failed");
    return { statusCode: 503, body: { error: "Could not reconcile Square booking right now." } };
  }
  if (!authoritative) {
    await store.markWebhookFailed(eventId, "square_booking_missing");
    logStage("failed", eventType, squareBookingId, startedAt, "square_booking_missing");
    return { statusCode: 503, body: { error: "Could not reconcile Square booking right now." } };
  }
  logStage("square_fetched", eventType, squareBookingId, startedAt);

  let row;
  try {
    row = await store.findRequestBySquareBookingId(squareBookingId);
  } catch {
    await store.markWebhookFailed(eventId, "local_lookup_failed");
    logStage("failed", eventType, squareBookingId, startedAt, "local_lookup_failed");
    return { statusCode: 503, body: { error: "Could not reconcile Square booking right now." } };
  }
  if (!row) {
    await store.markWebhookIgnored(eventId, "unknown_booking_id");
    logStage("ignored", eventType, squareBookingId, startedAt, "unknown_booking_id");
    return { statusCode: 200, body: { received: true, ignored: true } };
  }
  logStage("local_lookup", eventType, squareBookingId, startedAt);

  let normalized;
  try {
    normalized = normalizedAuthoritativeBooking(authoritative, row);
  } catch (error) {
    const code = safeString(error.code || "invalid_booking");
    await store.markWebhookFailed(eventId, code);
    logStage("failed", eventType, squareBookingId, startedAt, code);
    return { statusCode: 503, body: { error: "Could not reconcile Square booking right now." } };
  }

  if (
    row.squareBookingVersion != null &&
    Number(normalized.squareBookingVersion) <= Number(row.squareBookingVersion)
  ) {
    await store.markWebhookProcessed(eventId);
    logStage("stale", eventType, squareBookingId, startedAt);
    return { statusCode: 200, body: { received: true, stale: true } };
  }

  try {
    const result = await store.reconcileSquareBooking({
      requestId: row.id,
      ...normalized,
    });
    if (result?.reconciled === false) {
      await store.markWebhookProcessed(eventId);
      logStage("stale", eventType, squareBookingId, startedAt);
      return { statusCode: 200, body: { received: true, stale: true } };
    }
    await store.markWebhookProcessed(eventId);
    logStage("processed", eventType, squareBookingId, startedAt);
    return { statusCode: 200, body: { received: true } };
  } catch (error) {
    const code = error instanceof WebhookReconcileError ? error.code : "reconcile_failed";
    const safeCode = safeString(code);
    await store.markWebhookFailed(eventId, safeCode);
    logStage("failed", eventType, squareBookingId, startedAt, safeCode);
    return { statusCode: 503, body: { error: "Could not reconcile Square booking right now." } };
  }
}

export const squareWebhookReconcileTestInternals = {
  CANCELED_STATUSES,
  CANCELLED_WITH_TIMESTAMP,
  normalizedAuthoritativeBooking,
  syncStatusFor,
  fetchAuthoritativeBooking,
};
