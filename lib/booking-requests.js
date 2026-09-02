import { getServiceConfig, isServiceKey } from "./services.js";
import { addDays, addMinutes, getNewYorkDateString, startOfDayInTimeZone } from "./time.js";
import { isOverlap } from "./overlap.js";

export const MAX_DAYS_AHEAD = 13;
export const TURNOVER_BUFFER_MINUTES = 30;
export const TURNOVER_BUFFER_MS = TURNOVER_BUFFER_MINUTES * 60_000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function isString(value) {
  return typeof value === "string";
}

function normalizeName(value, maxLength) {
  if (!isString(value)) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > maxLength) return null;
  if (!/^[\p{L}\p{M}'.\-\s]+$/u.test(cleaned)) return null;
  return cleaned;
}

function normalizeEmail(value) {
  if (!isString(value)) return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned.length > 254) return null;
  if (!EMAIL_PATTERN.test(cleaned)) return null;
  return cleaned;
}

function isValidNanpNumber(digits) {
  return /^[2-9]\d{2}[2-9]\d{2}\d{4}$/.test(digits);
}

function normalizePhone(value) {
  if (!isString(value)) return null;
  const cleaned = value.replace(/[\s().-]/g, "");
  if (!/^\+?\d{10,15}$/.test(cleaned)) return null;
  if (cleaned.startsWith("+")) {
    if (cleaned.startsWith("+1")) {
      return isValidNanpNumber(cleaned.slice(2)) ? cleaned : null;
    }
    return cleaned;
  }
  if (cleaned.length === 10) {
    return isValidNanpNumber(cleaned) ? `+1${cleaned}` : null;
  }
  if (cleaned.length === 11 && cleaned.startsWith("1")) {
    return isValidNanpNumber(cleaned.slice(1)) ? `+${cleaned}` : null;
  }
  return null;
}

/**
 * The client-supplied request key is the idempotency key for the booking
 * request: strict dedupe rejects a second use of the same key, so a client
 * retry after a lost response must reuse the SAME key and payload.
 */
function normalizeRequestKey(value) {
  if (!isString(value)) return null;
  const cleaned = value.trim();
  if (cleaned.length < 8 || cleaned.length > 64) return null;
  if (!REQUEST_KEY_PATTERN.test(cleaned)) return null;
  return cleaned;
}

export function validateStartAt(value, today = getNewYorkDateString()) {
  if (!isString(value)) return { error: "startAt is required" };
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) {
    return { error: "Invalid start time" };
  }
  if (start.getTime() <= Date.now()) {
    return { error: "Selected time is in the past" };
  }
  const startDate = getNewYorkDateString(start);
  if (startDate < today) {
    return { error: "Selected time is in the past" };
  }
  const latestDate = getNewYorkDateString(
    addDays(startOfDayInTimeZone(today), MAX_DAYS_AHEAD),
  );
  if (startDate > latestDate) {
    return { error: "Selected time is outside the booking window" };
  }
  return { start };
}

const SIGNATURE_SEPARATOR = "\u0001";

export function payloadSignature({ serviceKey, firstName, lastName, email, phone, startMs }) {
  return [serviceKey, firstName, lastName, email, phone, String(startMs)].join(SIGNATURE_SEPARATOR);
}

/**
 * Validates and normalizes the booking-request payload. Returns either
 * `{ error }` with a safe client-facing message or `{ data }` with normalized,
 * server-owned values (duration comes from the server service config, never
 * from the client).
 */
/**
 * Contact consent is explicit and required: it is never inferred from form
 * submission. Without `contactConsent === true` the request is rejected with
 * HTTP 400. Marketing consent is separate, optional and never required; a
 * false or absent value never creates a subscription.
 */
const CONTACT_CONSENT_REQUIRED = "Consent to be contacted about this appointment is required.";

export function validateBookingRequest(body) {
  const serviceKey = body.serviceKey;
  const firstName = normalizeName(body.firstName, 100);
  const lastName = normalizeName(body.lastName, 100);
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  const requestKey = normalizeRequestKey(body.requestKey);
  const contactConsent = body.contactConsent === true;
  const marketingConsent = body.marketingConsent === true;
  const { start, error: startError } = validateStartAt(body.startAt);

  if (!isServiceKey(serviceKey)) return { error: "Unknown service" };
  if (!firstName) return { error: "Valid first name is required" };
  if (!lastName) return { error: "Valid last name is required" };
  if (!email) return { error: "A valid email address is required" };
  if (!phone) return { error: "A valid phone number is required" };
  if (!requestKey) return { error: "A valid request key is required" };
  if (startError) return { error: startError };
  if (!contactConsent) return { error: CONTACT_CONSENT_REQUIRED };

  const config = getServiceConfig(serviceKey);

  return {
    data: {
      serviceKey,
      serviceName: config.name,
      durationMinutes: config.durationMinutes,
      price: config.price,
      firstName,
      lastName,
      email,
      phone,
      requestKey,
      contactConsent,
      marketingConsent,
      start,
      signature: payloadSignature({
        serviceKey,
        firstName,
        lastName,
        email,
        phone,
        startMs: start.getTime(),
      }),
    },
  };
}

/**
 * Confirms the exact requested start time is still open in Square, and returns
 * the matching availability entry (needed for serviceVariationVersion on
 * approve). Returns null when the slot is gone. Never throws for a
 * "not available" result.
 */
function appointmentEnd(startAt, durationMinutes) {
  return new Date(new Date(startAt).getTime() + durationMinutes * 60000);
}

function squareBookingDurationMinutes(booking) {
  const segment = booking?.appointmentSegments?.[0];
  const duration = Number(segment?.durationMinutes);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function isBlockingSquareBooking(booking, teamMemberId) {
  const status = booking?.status || "ACCEPTED";
  if (["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED", "NO_SHOW"].includes(status)) return false;
  const segment = booking?.appointmentSegments?.[0];
  return Boolean(
    booking?.startAt &&
    squareBookingDurationMinutes(booking) &&
    (!teamMemberId || segment?.teamMemberId === teamMemberId),
  );
}

export function hasTurnoverConflict({ startAt, durationMinutes, existing }) {
  const start = new Date(startAt);
  const end = appointmentEnd(start, durationMinutes);
  return existing.some((booking) => {
    const existingDuration = squareBookingDurationMinutes(booking) ?? Number(booking.durationMinutes);
    if (!Number.isFinite(existingDuration) || existingDuration <= 0) return false;
    const existingStart = new Date(booking.startAt);
    const existingEnd = appointmentEnd(existingStart, existingDuration);
    return isOverlap(start, end, existingStart, existingEnd, { bufferMs: TURNOVER_BUFFER_MS });
  });
}

export async function listSquareBlockingBookings(client, { locationId, teamMemberId, dayStart, dayEnd }) {
  if (typeof client.bookings?.list !== "function") return [];
  const page = await client.bookings.list({
    locationId,
    teamMemberId,
    startAtMin: dayStart.toISOString(),
    startAtMax: dayEnd.toISOString(),
  });
  const bookings = Array.isArray(page?.data)
    ? page.data
    : Array.isArray(page?.bookings)
      ? page.bookings
      : [];
  return bookings.filter((booking) => isBlockingSquareBooking(booking, teamMemberId));
}

export async function findSlotAvailability(client, { locationId, teamMemberId, service, start }) {
  const response = await client.bookings.searchAvailability({
    query: {
      filter: {
        startAtRange: {
          startAt: start.toISOString(),
          endAt: addMinutes(start, service.durationMinutes).toISOString(),
        },
        locationId,
        segmentFilters: [
          {
            serviceVariationId: service.serviceVariationId,
            teamMemberIdFilter: { any: [teamMemberId] },
          },
        ],
      },
    },
  });

  const matched = (response.availabilities || []).find(
    (availability) =>
      availability.startAt && new Date(availability.startAt).getTime() === start.getTime(),
  );
  if (!matched) return null;
  const dayStart = startOfDayInTimeZone(getNewYorkDateString(start));
  const existing = await listSquareBlockingBookings(client, {
    locationId,
    teamMemberId,
    dayStart,
    dayEnd: addDays(dayStart, 1),
  });
  if (hasTurnoverConflict({ startAt: start, durationMinutes: service.durationMinutes, existing })) {
    return null;
  }
  return matched;
}

/**
 * Builds the emailed approval URL from PUBLIC_SITE_URL. Returns null when the
 * site URL is not configured so callers can fail the approval-email send
 * safely instead of emitting a broken link.
 */
export function buildApprovalUrl(token, baseUrl = process.env.PUBLIC_SITE_URL) {
  if (!baseUrl || typeof token !== "string" || token.length === 0) return null;
  try {
    const url = new URL("/approve", baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Deterministic Square idempotency keys. A single key per request means a
 * resume or retry of the same approval reuses the key and Square returns the
 * original booking/customer instead of creating a duplicate. Never include
 * client contact or medical data in these keys.
 */
export function buildSquareIdempotencyKey(requestId) {
  return `kai-lani.request.${requestId}`;
}

export function buildCustomerIdempotencyKey(requestId) {
  return `kai-lani.customer.${requestId}`;
}

export function buildCustomerReferenceId(requestId) {
  return `kai-lani.customer.${requestId}`;
}

/**
 * Server-side Square customer phone formatter.
 *
 * Square requires customer phone numbers and the phoneNumber search filter to
 * be E.164 with a leading "+". This narrow formatter only accepts numbers that
 * already passed the NANP contract enforced by normalizePhone:
 *   - 10 digits       -> "+1" + digits
 *   - 11 digits,      -> "+" + all 11 digits (national leading 1)
 *     starting with 1
 *   - +1XXXXXXXXXX    -> preserved canonical E.164 form
 * Anything else is outside the validated NANP contract and returns null (the
 * caller must not send it to Square). The formatted value is never logged,
 * returned, or otherwise exposed.
 */
export function formatSquarePhoneE164(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return isValidNanpNumber(digits) ? `+1${digits}` : null;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return isValidNanpNumber(digits.slice(1)) ? `+${digits}` : null;
  }
  return null;
}

const INACTIVE_REQUEST_STATUSES = new Set([
  "declined",
  "expired",
  "failed",
  "needs_reschedule",
]);

const INACTIVE_SQUARE_SYNC_STATUSES = new Set([
  "not_created",
  "creating",
  "canceled",
  "no_show",
  "failed",
]);

const ACTIVE_SQUARE_SYNC_STATUSES = new Set(["created", "rescheduled"]);

const INACTIVE_SQUARE_BOOKING_STATUSES = new Set([
  "PENDING",
  "DECLINED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
  "NO_SHOW",
]);

/**
 * Read-model helper: true only when the local request and Square's latest
 * authoritative status describe a currently active appointment. Pending local
 * requests, pending Square-acceptance rows, and Square PENDING bookings are not
 * active confirmed appointments.
 */
export function isSquareBookingActive({
  status,
  requestStatus = status,
  squareSyncStatus,
  squareBookingStatus,
} = {}) {
  if (requestStatus !== "approved") return false;
  if (INACTIVE_REQUEST_STATUSES.has(requestStatus)) return false;
  if (squareSyncStatus && INACTIVE_SQUARE_SYNC_STATUSES.has(squareSyncStatus)) return false;
  if (!ACTIVE_SQUARE_SYNC_STATUSES.has(squareSyncStatus)) return false;
  if (squareBookingStatus && INACTIVE_SQUARE_BOOKING_STATUSES.has(squareBookingStatus)) return false;
  return squareBookingStatus === "ACCEPTED";
}
