import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig } from "../../lib/config.js";
import {
  classifyExistingBooking,
  mapMassageBookService,
  startAtFromDateTime,
} from "../../lib/massagebook-migration.js";
import {
  formatSquarePhoneE164,
  hasTurnoverConflict,
  listSquareBlockingBookings,
} from "../../lib/booking-requests.js";
import { addDays, startOfDayInTimeZone } from "../../lib/time.js";
import { BodyReadError, readJsonBody } from "../../lib/read-json-body.js";

const CANARY_ONLY = "27";
const EXPECTED_CUSTOMER_SUFFIX = "...PAV7VG";
const CANARY_ROW = Object.freeze({
  row: 27,
  date: "2026-09-28",
  time: "11:30",
  client_name: "Lane Ellison",
  email: "lanefellison@gmail.com",
  mobile: "(704) 496-1168",
  service: "60 MIN CUSTOMIZED MASSAGE",
});
const IDEMPOTENCY_KEY = "kai-lani.migration.canary.lane-ellison.row-27";

function safeEqualToken(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function productionOnly() {
  return process.env.VERCEL_ENV === "production" && process.env.SQUARE_ENVIRONMENT === "production";
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function suffix(id) {
  return typeof id === "string" && id ? `...${id.slice(-6)}` : null;
}

function normalizedName(customer) {
  return `${clean(customer?.givenName)} ${clean(customer?.familyName)}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedEmail(value) {
  return clean(value).toLowerCase();
}

function normalizedPhone(value) {
  return formatSquarePhoneE164(value) || "";
}

function squareVersionForCreate(version) {
  if (typeof version === "bigint") return version;
  if (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) return BigInt(version);
  return version;
}

function candidateEvidence(customer, row = CANARY_ROW) {
  const nameMatch = normalizedName(customer) === clean(row.client_name).toLowerCase();
  const emailMatch = normalizedEmail(customer?.emailAddress) === normalizedEmail(row.email);
  const phoneMatch = normalizedPhone(customer?.phoneNumber) === normalizedPhone(row.mobile);
  return {
    customerSuffix: suffix(customer?.id),
    nameMatch,
    normalizedEmailMatch: emailMatch,
    normalizedPhoneMatch: phoneMatch,
  };
}

function classifyLaneCandidates(rawCandidates, row = CANARY_ROW) {
  const candidates = rawCandidates.map((customer) => ({ customer, evidence: candidateEvidence(customer, row) }));
  const exact = candidates.filter(({ evidence }) => evidence.nameMatch && evidence.normalizedEmailMatch && evidence.normalizedPhoneMatch);
  if (exact.length === 1 && exact[0].evidence.customerSuffix === EXPECTED_CUSTOMER_SUFFIX) {
    return {
      classification: "EXACT_EXISTING_CUSTOMER",
      customer: exact[0].customer,
      customerSuffix: exact[0].evidence.customerSuffix,
      candidateCount: candidates.length,
      reason: "one_expected_candidate_matches_name_email_phone",
    };
  }
  return {
    classification: "ABORT_CUSTOMER_MISMATCH",
    customer: null,
    customerSuffix: null,
    candidateCount: candidates.length,
    reason: "expected_exact_customer_not_unique",
  };
}

async function searchLane(client, row = CANARY_ROW) {
  const squarePhone = normalizedPhone(row.mobile);
  const [emailSearch, phoneSearch] = await Promise.all([
    client.customers.search({ query: { filter: { emailAddress: { exact: normalizedEmail(row.email) } } } }),
    squarePhone ? client.customers.search({ query: { filter: { phoneNumber: { exact: squarePhone } } } }) : { customers: [] },
  ]);
  const byId = new Map();
  for (const customer of [...(emailSearch.customers || []), ...(phoneSearch.customers || [])]) {
    if (customer?.id) byId.set(customer.id, customer);
  }
  return [...byId.values()];
}

function readCheckpointLane() {
  const reportPath = resolve(process.cwd(), "migration/massagebook-migration-dry-run.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return report.rows.find((row) => row.row === CANARY_ROW.row) || null;
}

function assertSelected(body) {
  if (body?.only !== CANARY_ONLY) return { ok: false, error: "only row 27 is allowed" };
  if (!["dry_run", "execute"].includes(body?.mode)) return { ok: false, error: "mode must be dry_run or execute" };
  return { ok: true };
}

function verifyCheckpointRow(row) {
  return Boolean(
    row &&
    row.row === CANARY_ROW.row &&
    row.date === CANARY_ROW.date &&
    row.time === CANARY_ROW.time &&
    row.client === CANARY_ROW.client_name &&
    row.service === CANARY_ROW.service &&
    row.serviceMapping === "customized_60" &&
    row.occupiedDurationMinutes === 60
  );
}

async function catalogVersion(client, serviceVariationId) {
  const response = await client.catalog.object.get({ objectId: serviceVariationId });
  const version = response?.object?.version ?? null;
  return typeof version === "bigint" || typeof version === "number" ? version : null;
}

function matchingBookings(bookings, row, config, customer) {
  const classified = classifyExistingBooking(row, config, customer, bookings);
  const exact = bookings.filter((booking) => {
    const segment = booking?.appointmentSegments?.[0];
    return booking?.customerId === customer?.id &&
      booking?.locationId === config.locationId &&
      booking?.startAt && new Date(booking.startAt).getTime() === new Date(startAtFromDateTime(row.date, row.time)).getTime() &&
      segment?.serviceVariationId === config.service.serviceVariationId &&
      segment?.teamMemberId === config.teamMemberId &&
      Number(segment?.durationMinutes) === config.service.durationMinutes;
  });
  return { classified, exact };
}

function bookingVerification(booking, config, customer) {
  const segment = booking?.appointmentSegments?.[0];
  return {
    exists: Boolean(booking?.id),
    bookingSuffix: suffix(booking?.id),
    status: booking?.status || null,
    customerSuffix: suffix(booking?.customerId),
    date: CANARY_ROW.date,
    time: CANARY_ROW.time,
    service: CANARY_ROW.service,
    durationMinutes: Number(segment?.durationMinutes),
    locationMatch: booking?.locationId === config.locationId,
    teamMemberMatch: segment?.teamMemberId === config.teamMemberId,
    serviceVariationMatch: segment?.serviceVariationId === config.service.serviceVariationId,
    customerMatch: booking?.customerId === customer?.id,
    startMatch: booking?.startAt && new Date(booking.startAt).getTime() === new Date(startAtFromDateTime(CANARY_ROW.date, CANARY_ROW.time)).getTime(),
  };
}

async function availabilityState(client, config) {
  const dayStart = startOfDayInTimeZone(CANARY_ROW.date);
  const dayEnd = addDays(dayStart, 1);
  const response = await client.bookings.searchAvailability({
    query: {
      filter: {
        startAtRange: { startAt: dayStart.toISOString(), endAt: dayEnd.toISOString() },
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
  const bookings = await listSquareBlockingBookings(client, {
    locationId: config.locationId,
    teamMemberId: config.teamMemberId,
    dayStart,
    dayEnd,
  });
  const targetStartAt = startAtFromDateTime(CANARY_ROW.date, CANARY_ROW.time);
  const slots = (response.availabilities || [])
    .map((availability) => availability.startAt)
    .filter((startAt) => typeof startAt === "string")
    .sort();
  const nearby = slots.filter((startAt) => {
    const delta = Math.abs(new Date(startAt).getTime() - new Date(targetStartAt).getTime());
    return delta <= 2 * 60 * 60 * 1000;
  });
  return {
    targetBookableRaw: slots.some((startAt) => new Date(startAt).getTime() === new Date(targetStartAt).getTime()),
    targetBookableAfterTurnover: slots.some((startAt) => new Date(startAt).getTime() === new Date(targetStartAt).getTime()) && !hasTurnoverConflict({
      startAt: targetStartAt,
      durationMinutes: config.service.durationMinutes,
      existing: bookings,
    }),
    nearby,
  };
}

async function executeCanary(body) {
  const selected = assertSelected(body);
  if (!selected.ok) return { status: 400, body: { error: selected.error, selectedRows: 0 } };
  const selectedRows = 1;
  const checkpointLane = readCheckpointLane();
  if (!verifyCheckpointRow(checkpointLane)) return { status: 409, body: { error: "checkpoint row mismatch", selectedRows } };

  const mapping = mapMassageBookService(CANARY_ROW.service);
  if (mapping.serviceKey !== "customized_60" || mapping.service?.durationMinutes !== 60) {
    return { status: 409, body: { error: "service mapping mismatch", selectedRows } };
  }
  const config = requireBookingConfig(mapping.serviceKey);
  const client = getSquareClient();

  const beforeAvailability = await availabilityState(client, config);
  const customer = classifyLaneCandidates(await searchLane(client));
  if (customer.classification !== "EXACT_EXISTING_CUSTOMER" || customer.customerSuffix !== EXPECTED_CUSTOMER_SUFFIX) {
    return { status: 409, body: { error: "customer precondition failed", selectedRows, customerClassification: customer.classification, customerSuffix: customer.customerSuffix } };
  }

  const dayStart = startOfDayInTimeZone(CANARY_ROW.date);
  const bookings = await listSquareBlockingBookings(client, {
    locationId: config.locationId,
    teamMemberId: config.teamMemberId,
    dayStart,
    dayEnd: addDays(dayStart, 1),
  });
  const beforeMatch = matchingBookings(bookings, CANARY_ROW, config, customer.customer);
  if (beforeMatch.classified.classification === "EXACT_BOOKING_ALREADY_EXISTS") {
    const afterAvailability = await availabilityState(client, config);
    return {
      status: 200,
      body: safeResponse({
        selectedRows,
        mode: body.mode,
        customer,
        bookingClassification: "EXACT_BOOKING_ALREADY_EXISTS",
        bookingSuffix: suffix(beforeMatch.classified.booking?.id),
        matchingBookingCount: beforeMatch.exact.length,
        squareBookingWrites: 0,
        beforeAvailability,
        afterAvailability,
      }),
    };
  }
  if (beforeMatch.classified.classification !== "NO_EXISTING_BOOKING") {
    return { status: 409, body: { error: "booking precondition failed", selectedRows, bookingClassification: beforeMatch.classified.classification } };
  }
  if (body.mode === "dry_run") {
    return {
      status: 200,
      body: safeResponse({
        selectedRows,
        mode: body.mode,
        customer,
        bookingClassification: "NO_EXISTING_BOOKING",
        matchingBookingCount: beforeMatch.exact.length,
        squareBookingWrites: 0,
        beforeAvailability,
        afterAvailability: beforeAvailability,
      }),
    };
  }

  const version = await catalogVersion(client, config.service.serviceVariationId);
  if (version == null) return { status: 409, body: { error: "service variation version missing", selectedRows } };

  const createResponse = await client.bookings.create(
    {
      idempotencyKey: IDEMPOTENCY_KEY,
      booking: {
        startAt: startAtFromDateTime(CANARY_ROW.date, CANARY_ROW.time),
        locationId: config.locationId,
        customerId: customer.customer.id,
        appointmentSegments: [
          {
            durationMinutes: config.service.durationMinutes,
            serviceVariationId: config.service.serviceVariationId,
            teamMemberId: config.teamMemberId,
            serviceVariationVersion: squareVersionForCreate(version),
          },
        ],
      },
    },
    { queryParams: { seller_level: false } },
  );
  const bookingId = createResponse?.booking?.id;
  if (!bookingId) return { status: 502, body: { error: "square booking create returned no booking", selectedRows } };

  const retrieved = await client.bookings.get({ bookingId });
  const verified = bookingVerification(retrieved?.booking, config, customer.customer);
  const afterBookings = await listSquareBlockingBookings(client, {
    locationId: config.locationId,
    teamMemberId: config.teamMemberId,
    dayStart,
    dayEnd: addDays(dayStart, 1),
  });
  const afterMatch = matchingBookings(afterBookings, CANARY_ROW, config, customer.customer);
  const afterAvailability = await availabilityState(client, config);

  return {
    status: 200,
    body: safeResponse({
      selectedRows,
      mode: body.mode,
      customer,
      bookingClassification: afterMatch.classified.classification,
      bookingSuffix: suffix(bookingId),
      squareBookingStatus: verified.status,
      matchingBookingCount: afterMatch.exact.length,
      squareBookingWrites: 1,
      verification: verified,
      beforeAvailability,
      afterAvailability,
    }),
  };
}

function safeResponse(result) {
  return {
    executionSurface: "lane_ellison_row_27_canary_only",
    selectedRows: result.selectedRows,
    mode: result.mode,
    row: {
      row: CANARY_ROW.row,
      date: CANARY_ROW.date,
      time: CANARY_ROW.time,
      client: CANARY_ROW.client_name,
      service: CANARY_ROW.service,
      durationMinutes: 60,
      startAt: startAtFromDateTime(CANARY_ROW.date, CANARY_ROW.time),
    },
    customerClassification: result.customer.classification,
    customerSuffix: result.customer.customerSuffix,
    customerCandidateCount: result.customer.candidateCount,
    bookingClassification: result.bookingClassification,
    bookingSuffix: result.bookingSuffix || null,
    squareBookingStatus: result.squareBookingStatus || null,
    matchingBookingCount: result.matchingBookingCount,
    verification: result.verification || null,
    availability: {
      before: result.beforeAvailability,
      after: result.afterAvailability,
    },
    writes: {
      squareCustomerWrites: 0,
      squareBookingWrites: result.squareBookingWrites,
      squareOrderWrites: 0,
      squarePaymentWrites: 0,
      neonWrites: 0,
      emailsSent: 0,
    },
  };
}

export default async function handler(req, res) {
  if (!productionOnly()) return res.status(404).json({ error: "Not found" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!safeEqualToken(bearerToken(req), process.env.MASSAGEBOOK_MIGRATION_EXECUTE_TOKEN)) {
    return res.status(404).json({ error: "Not found" });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) return res.status(error.statusCode).json({ error: error.message });
    throw error;
  }

  const result = await executeCanary(body);
  return res.status(result.status).json(result.body);
}

export const laneEllisonCanaryForTests = {
  CANARY_ONLY,
  CANARY_ROW,
  EXPECTED_CUSTOMER_SUFFIX,
  assertSelected,
  candidateEvidence,
  classifyLaneCandidates,
  safeEqualToken,
  verifyCheckpointRow,
};
