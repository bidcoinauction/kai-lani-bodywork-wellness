import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig, ConfigError } from "../../lib/config.js";
import { isServiceKey } from "../../lib/services.js";
import { readJsonBody, BodyReadError } from "../../lib/read-json-body.js";
import {
  getNewYorkDateString,
  addDays,
  startOfDayInTimeZone,
  addMinutes,
} from "../../lib/time.js";

export const MAX_DAYS_AHEAD = 13;

/**
 * SANDBOX-ONLY best-effort rate limiter.
 *
 * In-memory state does not survive cold starts and is not shared across Vercel
 * function instances, so this is NOT production-safe. It exists only to dampen
 * accidental abuse during Sandbox testing. Durable, distributed rate limiting
 * is an explicit launch blocker for production.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 10;
const rateLimitMap = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.start >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { start: now, count: 1 });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX_PER_WINDOW) return true;
  entry.count += 1;
  return false;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._-]+$/;

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

function normalizePhone(value) {
  if (!isString(value)) return null;
  const cleaned = value.replace(/[\s().-]/g, "");
  if (!/^\+?\d{10,15}$/.test(cleaned)) return null;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith("1")) return `+${cleaned}`;
  return null;
}

function normalizeIdempotencyKey(value) {
  if (!isString(value)) return null;
  const cleaned = value.trim();
  if (cleaned.length < 8 || cleaned.length > 64) return null;
  if (!IDEMPOTENCY_PATTERN.test(cleaned)) return null;
  return cleaned;
}

function validateStartAt(value, today) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Please try again shortly." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }

  const serviceKey = body.serviceKey;
  const firstName = normalizeName(body.firstName, 100);
  const lastName = normalizeName(body.lastName, 100);
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
  const today = getNewYorkDateString();
  const { start, error: startError } = validateStartAt(body.startAt, today);

  if (!isServiceKey(serviceKey)) {
    return res.status(400).json({ error: "Unknown service" });
  }
  if (!firstName) {
    return res.status(400).json({ error: "Valid first name is required" });
  }
  if (!lastName) {
    return res.status(400).json({ error: "Valid last name is required" });
  }
  if (!email) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  if (!phone) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }
  if (!idempotencyKey) {
    return res.status(400).json({ error: "A valid idempotency key is required" });
  }
  if (startError) {
    return res.status(400).json({ error: startError });
  }

  let config;
  try {
    config = requireBookingConfig(serviceKey);
  } catch (error) {
    if (error instanceof ConfigError) {
      return res.status(500).json({ error: error.message });
    }
    throw error;
  }

  try {
    const client = getSquareClient();

    const recheckResponse = await client.bookings.searchAvailability({
      query: {
        filter: {
          startAtRange: {
            startAt: start.toISOString(),
            endAt: addMinutes(start, config.service.durationMinutes).toISOString(),
          },
          locationId: config.locationId,
          segmentFilters: [
            {
              serviceVariationId: config.service.serviceVariationId,
              teamMemberIdFilter: { any: [config.teamMemberId] },
            },
          ],
        },
      },
    });

    const matched = (recheckResponse.availabilities || []).find(
      (availability) =>
        availability.startAt && new Date(availability.startAt).getTime() === start.getTime(),
    );

    if (!matched) {
      return res.status(409).json({ error: "That time is no longer available. Please pick another." });
    }

    const serviceVariationVersion = matched.appointmentSegments?.[0]?.serviceVariationVersion;
    if (
      typeof serviceVariationVersion !== "bigint" &&
      typeof serviceVariationVersion !== "number"
    ) {
      throw new Error("service_variation_version_missing");
    }

    const customerId = await findOrCreateCustomer(client, {
      firstName,
      lastName,
      email,
      phone,
    });

    const response = await client.bookings.create({
      idempotencyKey,
      booking: {
        startAt: start.toISOString(),
        locationId: config.locationId,
        customerId,
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

    const booking = response.booking;
    if (!booking || !booking.id) {
      throw new Error("booking_missing");
    }

    return res.status(201).json({
      bookingId: booking.id,
      status: booking.status || "PENDING",
      startAt: booking.startAt || start.toISOString(),
      serviceName: config.service.name,
      duration: String(config.service.durationMinutes),
      customerName: `${firstName} ${lastName}`,
    });
  } catch (error) {
    const safeStatus = normalizeBookingError(error);
    console.error(`Create booking failed status=${safeStatus}`);
    return res.status(safeStatus).json({ error: clientFacingMessage(safeStatus) });
  }
}

async function findOrCreateCustomer(client, { firstName, lastName, email, phone }) {
  if (email) {
    const emailSearch = await client.customers.search({
      query: {
        filter: {
          emailAddress: { exact: email },
        },
      },
    });
    if (emailSearch.customers?.length > 0) {
      return emailSearch.customers[0].id;
    }
  }

  const phoneSearch = await client.customers.search({
    query: {
      filter: {
        phoneNumber: { exact: phone },
      },
    },
  });
  if (phoneSearch.customers?.length > 0) {
    return phoneSearch.customers[0].id;
  }

  const created = await client.customers.create({
    givenName: firstName,
    familyName: lastName,
    emailAddress: email,
    phoneNumber: phone,
  });
  if (!created.customer || !created.customer.id) {
    throw new Error("customer_missing");
  }
  return created.customer.id;
}

function normalizeBookingError(error) {
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
      return "The appointment could not be created. Please review the details.";
    case 409:
      return "That time is no longer available. Please pick another.";
    case 429:
      return "Too many requests. Please try again shortly.";
    default:
      return "Could not create the appointment right now. Please try again.";
  }
}
