import { getServiceConfig, isServiceKey } from "./services.js";
import { addDays, addMinutes, getNewYorkDateString, startOfDayInTimeZone } from "./time.js";

export const MAX_DAYS_AHEAD = 13;

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
  return matched || null;
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
 * A safe, short request reference for Square's seller_note. Contains no
 * medical information and no client contact details.
 */
export function requestReference(requestId) {
  return String(requestId || "").slice(0, 36) || "unknown";
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

/**
 * Digits-only form of a phone number used for exact Square customer matching.
 * Square stores phone numbers in a normalized form; we compare the digit
 * string so formatting differences never produce a duplicate customer.
 */
export function normalizePhoneForMatch(phone) {
  if (typeof phone !== "string") return "";
  return phone.replace(/\D/g, "");
}
