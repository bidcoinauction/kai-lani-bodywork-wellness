import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig } from "../../lib/config.js";
import { addMinutes } from "../../lib/time.js";
import { sendBookingNotifications } from "../../lib/email.js";
import { formatSquarePhoneE164 } from "../../lib/booking-requests.js";

export const BOOKING_FLOW_REPLACED = "BOOKING_FLOW_REPLACED";

/**
 * Backward-compatible test seam from the removed direct-booking endpoint.
 * Must never be called from production code.
 */
export function resetIdempotencyCacheForTests() {
}

export default async function handler(req, res) {
  return res.status(410).json({
    error: BOOKING_FLOW_REPLACED,
    message:
      "Direct booking has been replaced by the appointment-request approval workflow.",
  });
}

export async function createBookingFlow({
  serviceKey,
  firstName,
  lastName,
  email,
  phone,
  idempotencyKey,
  start,
}) {
  const config = requireBookingConfig(serviceKey);
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
    throw new HttpError(409);
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

  const response = await client.bookings.create(
    {
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
    },
    { queryParams: { seller_level: false } },
  );

  const booking = response.booking;
  if (!booking || !booking.id) {
    throw new Error("booking_missing");
  }

  const safeResponse = {
    bookingId: booking.id,
    status: booking.status || "PENDING",
    startAt: booking.startAt || start.toISOString(),
    serviceName: config.service.name,
    duration: String(config.service.durationMinutes),
    price: String(config.service.price),
    customerName: `${firstName} ${lastName}`,
  };

  try {
    safeResponse.notification = await sendBookingNotifications({
      ...safeResponse,
      firstName,
      lastName,
      email,
      phone,
      price: config.service.price,
    });
  } catch {
    console.info(`Email notification type=all bookingSuffix=${booking.id.slice(-6)} status=failed`);
    safeResponse.notification = { client: "failed", provider: "failed" };
  }

  return safeResponse;
}

class HttpError extends Error {
  constructor(statusCode) {
    super(`http_${statusCode}`);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export async function findOrCreateCustomer(client, { firstName, lastName, email, phone }) {
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

  const squarePhone = formatSquarePhoneE164(phone);
  if (!squarePhone) {
    throw new Error("invalid_square_phone");
  }

  const phoneSearch = await client.customers.search({
    query: {
      filter: {
        phoneNumber: { exact: squarePhone },
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
    phoneNumber: squarePhone,
  });
  if (!created.customer || !created.customer.id) {
    throw new Error("customer_missing");
  }
  return created.customer.id;
}
