// Temporary one-time execution surface for the MassageBook -> Square migration.
// Removed after the migration completes; never used for live booking requests.
import { timingSafeEqual } from "node:crypto";
import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig } from "../../lib/config.js";
import {
  classifyExistingBooking,
  mapMassageBookService,
  splitClientName,
  startAtFromDateTime,
} from "../../lib/massagebook-migration.js";
import {
  formatSquarePhoneE164,
  listSquareBlockingBookings,
} from "../../lib/booking-requests.js";
import { addDays, startOfDayInTimeZone } from "../../lib/time.js";
import { BodyReadError, readJsonBody } from "../../lib/read-json-body.js";

const MAX_BATCH = 10;
const LANE_CLIENT = "Lane Ellison";
const MANUAL_CLIENT = "Angela Cummings";
const LEGACY_BUFFER_EXCEPTION_ROWS = new Set([20, 39, 40]);

const SOURCE_COLUMNS = ["date", "time", "client_name", "email", "mobile", "service"];
const SOURCE_ROWS = [
  ["2026-09-14", "10:00", "Robyn Engle", "robynengle0305@gmail.com", "(410) 370-5530", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-14", "13:00", "Ruth Neely", "rhneely94@bellsouth.net", "(704) 564-4794", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-14", "17:30", "Connie Trull", "cgtrull@yahoo.com", "(704) 860-0466", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-15", "10:00", "Phillip Elting", "jpelting@gmail.com", "(704) 617-2560", "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-16", "10:00", "Crystal Orr", "orrg@aol.com", "(704) 601-5330", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-16", "11:30", "Gary Orr", "orrg1@aol.com", "(704) 747-1904", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-16", "13:00", "Andrew Tanner", "andrew.m.tanner2@gmail.com", "(304) 216-3456", "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-16", "14:30", "Joshua Hall", "jwh1801@gmail.com", "(828) 358-7770", "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-17", "10:00", "Danielle Hall", "mrsdhall526@gmail.com", "(828) 446-9341", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-17", "11:30", "Leila Noll", "leilanoll21@gmail.com", "(850) 661-9953", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-17", "14:30", "Jason Shoemaker", "jason.r.shoemaker@gmail.com", "(704) 616-4806", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-18", "10:00", "Robyn Reid", "robrobreid@gmail.com", "(704) 813-8684", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-18", "11:30", "Tyler McCurdy", "mccurdytyler21@yahoo.com", "(704) 214-0224", "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-18", "15:00", "Callie Horne", "calliehorne86@yahoo.com", "(704) 813-7598", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-19", "10:00", "Sheilak Kuss", "skuss1218@gmail.com", "(765) 621-9111", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-19", "11:30", "Justin Wilcox", "jwilcox30@yahoo.com", "(704) 472-7336", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-19", "13:00", "Jordan Warren", "crimsoncrayon02@gmail.com", "(919) 610-1490", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-22", "17:30", "Sara Glance", "sglance9@gmail.com", "(814) 218-6643", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-23", "10:00", "Angela Cummings", "stylist.angelawilliams@gmail.com", "(803) 526-0238", "90 MIN CUSTOMIZED MASSAGE + 15 MIN FACIAL MASSAGE ADD-ON"],
  ["2026-09-23", "12:00", "Kayla Cook", "cookkaylam@gmail.com", "(704) 747-4635", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-24", "11:00", "Tara Louiselle", "tlouiselle@gmail.com", "(248) 660-3074", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-24", "14:30", "Jason Shoemaker", "jason.r.shoemaker@gmail.com", "(704) 616-4806", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-09-25", "10:00", "Sarah Williamson", "sbenson21@yahoo.com", "(863) 234-1567", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-25", "11:30", "Richard Langholz", "randk829@msn.com", "(515) 450-9749", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-25", "14:00", "Gilbert Omollo", "gilbertolonde@gmail.com", "(301) 624-9930", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-28", "10:00", "Amanda Jonas", "anjonas1011@gmail.com", "(704) 564-7079", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-28", "11:30", "Lane Ellison", "lanefellison@gmail.com", "(704) 496-1168", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-28", "15:30", "Joshua Castle", "leilanoll21@gmail.com", "(850) 496-3737", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-29", "11:00", "Leyna Brown", "leynabug@hotmail.com", "(704) 517-7562", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-29", "13:00", "Bert McCurdy", "bmccurdy1@carolina.rr.com", "(704) 718-8117", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-29", "14:30", "Karen Geer", "myhorsesport@gmail.com", "(704) 458-9105", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-09-30", "10:00", "Jessi McGinnis", "jessimcginnis@yahoo.com", "(980) 251-4751", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-01", "12:30", "Connie Trull", "cgtrull@yahoo.com", "(704) 860-0466", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-01", "14:30", "Jason Shoemaker", "jason.r.shoemaker@gmail.com", "(704) 616-4806", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-10-02", "11:00", "Geremie Desha", "gdesha@gmail.com", "(704) 678-3085", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-10-02", "14:00", "Terry Oates", "spunkytj65@aol.com", "(704) 957-4067", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-03", "10:30", "Paula Atkins", "tankroswell@gmail.com", "(704) 718-2517", "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-10-03", "12:00", "Jane Owens", "jane.owens88@gmail.com", "(704) 689-2916", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-03", "13:30", "Annika Tarfur", "annika_droste@hotmail.com", "(704) 616-7131", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-03", "14:45", "Julia Triplett", "juliak413@yahoo.com", "(704) 661-0852", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-05", "10:00", "Courtney Williams", "courtneyhaggins@yahoo.com", "(704) 671-8840", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-06", "10:00", "Lauren Mccotter", "lmmccotter@gmail.com", "(704) 740-7778", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-07", "11:30", "Jennifer Stiles", "jen.stiles332@gmail.com", "(704) 913-6340", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-07", "13:30", "Karen Cornett", "kcccards@aol.com", "(704) 258-9143", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-08", "14:30", "Jason Shoemaker", "jason.r.shoemaker@gmail.com", "(704) 616-4806", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-10-09", "13:00", "Richard Langholz", "randk829@msn.com", "(515) 450-9749", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-10", "10:00", "Sherri Lowe", "sherrilplowe@gmail.com", "(828) 450-0213", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-13", "11:30", "Valorie Franklin", "v.zambito@gmail.com", "(400) 580-8323", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-14", "13:00", "Margaret Collier", "davidbcollier@hotmail.com", "(540) 256-4204", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-15", "09:30", "Tesia Maney", "tmaney050816@yahoo.com", "(980) 677-2250", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-15", "14:30", "Jason Shoemaker", "jason.r.shoemaker@gmail.com", "(704) 616-4806", "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-10-20", "17:30", "Sara Glance", "sglance9@gmail.com", "(814) 218-6643", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-22", "14:30", "Connie Trull", "cgtrull@yahoo.com", "(704) 860-0466", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-23", "11:30", "Sean Holleran", "holleransd28@gmail.com", "(980) 358-7907", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-10-24", "10:00", "Leyna Brown", "leynabug@hotmail.com", "(704) 517-7562", "90 MIN CUSTOMIZED MASSAGE"],
  ["2026-11-06", "16:00", "Logan Russell", "loganrussell00@gmail.com", "(828) 553-2718", "60 MIN CUSTOMIZED MASSAGE"],
  ["2026-11-07", "10:30", "Paula Atkins", "tankroswell@gmail.com", "(704) 718-2517", "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE"],
  ["2026-11-21", "10:00", "Leyna Brown", "leynabug@hotmail.com", "(704) 517-7562", "90 MIN CUSTOMIZED MASSAGE"],
];

const ROWS = SOURCE_ROWS.map((tuple, index) => {
  const row = { row: index + 1 };
  SOURCE_COLUMNS.forEach((column, colIndex) => { row[column] = tuple[colIndex]; });
  return row;
});

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

function suffix(id) {
  return typeof id === "string" && id ? `...${id.slice(-6)}` : null;
}

function isLegacyBufferException(row) {
  return LEGACY_BUFFER_EXCEPTION_ROWS.has(row.row);
}

function fullName(customer) {
  return `${customer?.givenName || ""} ${customer?.familyName || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function namesMatch(customer, row) {
  const full = fullName(customer);
  return Boolean(full && full === row.client_name.toLowerCase());
}

function squareVersionForCreate(version) {
  if (typeof version === "bigint") return version;
  if (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) return BigInt(version);
  return version;
}

function customerIdempotencyKey(row) {
  return `kai-lani.migration.customer.${row.row}`;
}

function bookingIdempotencyKey(row) {
  return `kai-lani.migration.booking.${row.row}`;
}

function scopeCheck() {
  const total = ROWS.length;
  const laneCount = ROWS.filter((row) => row.client_name === LANE_CLIENT).length;
  const manualCount = ROWS.filter((row) => row.client_name === MANUAL_CLIENT).length;
  const eligible = ROWS.filter((row) => row.client_name !== LANE_CLIENT && row.client_name !== MANUAL_CLIENT);
  return {
    valid: total === 58 && laneCount === 1 && manualCount === 1 && eligible.length === 56,
    total,
    laneCount,
    manualCount,
    eligibleCount: eligible.length,
    eligible,
  };
}

async function searchPhone(client, squarePhone) {
  if (!squarePhone) return [];
  const result = await client.customers.search({ query: { filter: { phoneNumber: { exact: squarePhone } } } });
  return result.customers || [];
}

async function searchEmail(client, email) {
  if (!email) return [];
  const result = await client.customers.search({ query: { filter: { emailAddress: { exact: email } } } });
  return result.customers || [];
}

async function resolveCustomer(client, row) {
  const squarePhone = formatSquarePhoneE164(row.mobile);
  const email = row.email.toLowerCase();

  if (row.client_name === "Joshua Castle") {
    const phoneMatches = await searchPhone(client, squarePhone);
    const nameMatch = phoneMatches.find((customer) => namesMatch(customer, row));
    if (nameMatch) return { classification: "EXACT_EXISTING_CUSTOMER", customer: nameMatch, created: false };
    if (phoneMatches.length > 0) return { classification: "DATA_CONFLICT", customer: null, created: false };
    return { classification: "WOULD_CREATE_NEW_CUSTOMER", customer: null, created: false, emailSkip: true };
  }

  const [emailMatches, phoneMatches] = await Promise.all([
    searchEmail(client, email),
    searchPhone(client, squarePhone),
  ]);
  const emailCustomer = emailMatches.find((customer) => namesMatch(customer, row)) || emailMatches[0] || null;
  const phoneCustomer = phoneMatches.find((customer) => namesMatch(customer, row)) || phoneMatches[0] || null;
  if (emailCustomer && phoneCustomer) {
    if (emailCustomer.id === phoneCustomer.id) return { classification: "EXACT_EXISTING_CUSTOMER", customer: emailCustomer, created: false };
    return { classification: "DATA_CONFLICT", customer: null, created: false };
  }
  if (emailCustomer) {
    if (namesMatch(emailCustomer, row)) return { classification: "EXACT_EXISTING_CUSTOMER", customer: emailCustomer, created: false };
    return { classification: "AMBIGUOUS_CUSTOMER", customer: null, created: false };
  }
  if (phoneCustomer) {
    if (namesMatch(phoneCustomer, row)) return { classification: "EXACT_EXISTING_CUSTOMER", customer: phoneCustomer, created: false };
    return { classification: "AMBIGUOUS_CUSTOMER", customer: null, created: false };
  }
  return { classification: "WOULD_CREATE_NEW_CUSTOMER", customer: null, created: false };
}

function isInvalidPhoneError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    Array.isArray(error.errors) &&
    error.errors.some((entry) => entry && entry.code === "INVALID_PHONE_NUMBER")
  );
}

async function createCustomer(client, row) {
  const { firstName, lastName } = splitClientName(row.client_name);
  const squarePhone = formatSquarePhoneE164(row.mobile);
  const payload = {
    idempotencyKey: customerIdempotencyKey(row),
    givenName: firstName,
    familyName: lastName,
    emailAddress: row.email.toLowerCase(),
  };
  let created;
  try {
    created = await client.customers.create({ ...payload, phoneNumber: squarePhone });
  } catch (error) {
    if (isInvalidPhoneError(error)) {
      created = await client.customers.create(payload);
      if (!created.customer || !created.customer.id) return { customer: null, phoneOmitted: true };
      return { customer: created.customer, phoneOmitted: true };
    }
    throw error;
  }
  if (!created.customer || !created.customer.id) return { customer: null, phoneOmitted: false };
  return { customer: created.customer, phoneOmitted: false };
}

async function catalogVersion(client, serviceVariationId) {
  const response = await client.catalog.object.get({ objectId: serviceVariationId });
  const version = response?.object?.version ?? null;
  return typeof version === "bigint" || typeof version === "number" ? version : null;
}

function verifyBooking(booking, config, customerId, row) {
  const segment = booking?.appointmentSegments?.[0];
  const expectedStart = startAtFromDateTime(row.date, row.time);
  return {
    exists: Boolean(booking?.id),
    bookingSuffix: suffix(booking?.id),
    status: booking?.status || null,
    customerSuffix: suffix(booking?.customerId),
    customerMatch: booking?.customerId === customerId,
    locationMatch: booking?.locationId === config.locationId,
    teamMemberMatch: segment?.teamMemberId === config.teamMemberId,
    serviceVariationMatch: segment?.serviceVariationId === config.service.serviceVariationId,
    durationMatch: Number(segment?.durationMinutes) === config.service.durationMinutes,
    startMatch: booking?.startAt && new Date(booking.startAt).getTime() === new Date(expectedStart).getTime(),
  };
}

function verifyAll(verification) {
  return verification.customerMatch && verification.locationMatch && verification.teamMemberMatch &&
    verification.serviceVariationMatch && verification.durationMatch && verification.startMatch &&
    verification.status === "ACCEPTED";
}

async function listDayBookings(client, config, row) {
  const dayStart = startOfDayInTimeZone(row.date);
  return listSquareBlockingBookings(client, {
    locationId: config.locationId,
    teamMemberId: config.teamMemberId,
    dayStart,
    dayEnd: addDays(dayStart, 1),
  });
}

function countExactMatches(bookings, row, config, customerId) {
  const expectedStart = startAtFromDateTime(row.date, row.time);
  return bookings.filter((booking) => {
    const segment = booking?.appointmentSegments?.[0];
    return booking?.customerId === customerId &&
      booking?.locationId === config.locationId &&
      booking?.startAt && new Date(booking.startAt).getTime() === new Date(expectedStart).getTime() &&
      segment?.serviceVariationId === config.service.serviceVariationId &&
      segment?.teamMemberId === config.teamMemberId &&
      Number(segment?.durationMinutes) === config.service.durationMinutes;
  }).length;
}

async function processRow(client, row, config) {
  const resolveResult = await resolveCustomer(client, row);
  if (resolveResult.classification === "AMBIGUOUS_CUSTOMER" || resolveResult.classification === "DATA_CONFLICT") {
    return { row: row.row, client: row.client_name, migrationStatus: "BLOCKED_CONFLICT", customerClassification: resolveResult.classification, customerCreated: false, wrote: false };
  }

  const bookings = await listDayBookings(client, config, row);
  const resolvedCustomer = resolveResult.customer ? { id: resolveResult.customer.id } : null;
  const existing = classifyExistingBooking(row, config, resolvedCustomer, bookings);
  const effective = isLegacyBufferException(row) && existing.classification === "TIME_CONFLICT"
    ? { classification: "NO_EXISTING_BOOKING", booking: null }
    : existing;
  if (effective.classification === "EXACT_BOOKING_ALREADY_EXISTS") {
    return { row: row.row, client: row.client_name, migrationStatus: "ALREADY_EXISTED", customerClassification: resolveResult.classification, customerCreated: false, bookingSuffix: suffix(effective.booking?.id), wrote: false };
  }
  if (effective.classification !== "NO_EXISTING_BOOKING") {
    return { row: row.row, client: row.client_name, migrationStatus: "BLOCKED_CONFLICT", customerClassification: resolveResult.classification, bookingClassification: effective.classification, customerCreated: false, wrote: false };
  }

  let customer = resolveResult.customer;
  let customerCreated = false;
  let phoneOmitted = false;
  if (resolveResult.classification === "WOULD_CREATE_NEW_CUSTOMER") {
    const createdCustomer = await createCustomer(client, row);
    customer = createdCustomer.customer;
    phoneOmitted = createdCustomer.phoneOmitted;
    if (!customer || !customer.id) {
      return { row: row.row, client: row.client_name, migrationStatus: "FAILED", customerClassification: resolveResult.classification, customerCreated: false, error: "customer_create_missing_id", wrote: false };
    }
    customerCreated = true;
  }

  let version;
  try {
    version = await catalogVersion(client, config.service.serviceVariationId);
  } catch {
    version = null;
  }
  if (version == null) {
    return { row: row.row, client: row.client_name, migrationStatus: "FAILED", customerClassification: resolveResult.classification, customerCreated, error: "service_variation_version_missing", wrote: customerCreated };
  }

  let createResponse;
  try {
    createResponse = await client.bookings.create(
      {
        idempotencyKey: bookingIdempotencyKey(row),
        booking: {
          startAt: startAtFromDateTime(row.date, row.time),
          locationId: config.locationId,
          customerId: customer.id,
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
  } catch (error) {
    return { row: row.row, client: row.client_name, migrationStatus: "FAILED", customerClassification: resolveResult.classification, customerCreated, error: "booking_create_rejected", wrote: customerCreated };
  }
  const bookingId = createResponse?.booking?.id;
  if (!bookingId) {
    return { row: row.row, client: row.client_name, migrationStatus: "FAILED", customerClassification: resolveResult.classification, customerCreated, error: "booking_create_missing_id", wrote: customerCreated };
  }

  const retrieved = await client.bookings.get({ bookingId });
  const verification = verifyBooking(retrieved?.booking, config, customer.id, row);
  if (!verifyAll(verification)) {
    return { row: row.row, client: row.client_name, migrationStatus: "FAILED", customerClassification: resolveResult.classification, customerCreated, error: "verification_failed", verification, wrote: true, halt: true, haltReason: "booking_verification_failed" };
  }

  const finalBookings = await listDayBookings(client, config, row);
  const matchCount = countExactMatches(finalBookings, row, config, customer.id);
  if (matchCount !== 1) {
    return { row: row.row, client: row.client_name, migrationStatus: "FAILED", customerClassification: resolveResult.classification, customerCreated, matchingBookingCount: matchCount, wrote: true, halt: true, haltReason: "duplicate_booking_count" };
  }

  return { row: row.row, client: row.client_name, migrationStatus: "MIGRATED", customerClassification: resolveResult.classification, customerSuffix: suffix(customer.id), customerCreated, phoneOmitted, bookingSuffix: suffix(bookingId), squareBookingStatus: verification.status, wrote: true };
}

async function runMigration(body) {
  const scope = scopeCheck();
  if (!scope.valid) {
    return { status: 409, body: { error: "scope_mismatch", scope: { total: scope.total, laneCount: scope.laneCount, manualCount: scope.manualCount, eligibleCount: scope.eligibleCount } } };
  }

  const mode = body.mode;
  if (!["dry_run", "execute"].includes(mode)) return { status: 400, body: { error: "mode must be dry_run or execute" } };

  const requestedOffset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
  const requestedLimit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : MAX_BATCH;
  const batchSize = Math.min(requestedLimit, MAX_BATCH);
  const offset = Math.min(requestedOffset, scope.eligible.length);

  const selected = scope.eligible.slice(offset, offset + batchSize);
  const client = getSquareClient();

  const writes = { squareCustomerWrites: 0, squareBookingWrites: 0, squareOrderWrites: 0, squarePaymentWrites: 0, squarePaymentLinkWrites: 0, neonWrites: 0, emailsSent: 0 };
  const results = [];
  let halted = false;
  let haltReason = null;

  for (const row of selected) {
    if (halted) break;
    const mapping = mapMassageBookService(row.service);
    if (!mapping.serviceKey || mapping.status !== "MAPPED") {
      results.push({ row: row.row, client: row.client_name, migrationStatus: "BLOCKED_CONFLICT", error: "service_mapping" });
      continue;
    }
    const config = requireBookingConfig(mapping.serviceKey);
    if (mode === "dry_run") {
      const resolveResult = await resolveCustomer(client, row);
      const bookings = await listDayBookings(client, config, row);
      const resolvedCustomer = resolveResult.customer ? { id: resolveResult.customer.id } : null;
      const existing = classifyExistingBooking(row, config, resolvedCustomer, bookings);
      const effectiveClassification = isLegacyBufferException(row) && existing.classification === "TIME_CONFLICT"
        ? "NO_EXISTING_BOOKING"
        : existing.classification;
      const status = resolveResult.classification === "AMBIGUOUS_CUSTOMER" || resolveResult.classification === "DATA_CONFLICT"
        ? "BLOCKED_CONFLICT"
        : effectiveClassification === "EXACT_BOOKING_ALREADY_EXISTS"
          ? "ALREADY_EXISTED"
          : effectiveClassification === "NO_EXISTING_BOOKING"
            ? "PENDING"
            : "BLOCKED_CONFLICT";
      results.push({ row: row.row, client: row.client_name, migrationStatus: status, customerClassification: resolveResult.classification, bookingClassification: effectiveClassification, wrote: false });
      continue;
    }
    const result = await processRow(client, row, config).catch((error) => ({
      row: row.row,
      client: row.client_name,
      migrationStatus: "FAILED",
      customerCreated: false,
      error: "row_processing_error",
      wrote: false,
    }));
    if (result.customerCreated) writes.squareCustomerWrites += 1;
    if (result.migrationStatus === "MIGRATED") writes.squareBookingWrites += 1;
    if (result.halt) { halted = true; haltReason = result.haltReason; }
    results.push(result);
  }

  return {
    status: 200,
    body: {
      mode,
      offset,
      batchSize,
      eligibleTotal: scope.eligible.length,
      remainingAfterOffset: Math.max(scope.eligible.length - offset - batchSize, 0),
      results,
      writes,
      halted,
      haltReason,
      scope: { total: scope.total, laneCount: scope.laneCount, manualCount: scope.manualCount, eligibleCount: scope.eligibleCount },
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
  const result = await runMigration(body);
  return res.status(result.status).json(result.body);
}

export const massagebookMigrationExecutionForTests = {
  MAX_BATCH,
  scopeCheck,
  resolveCustomer,
  verifyBooking,
  verifyAll,
  countExactMatches,
  namesMatch,
  isLegacyBufferException,
  isInvalidPhoneError,
  createCustomer,
  ROWS,
};
