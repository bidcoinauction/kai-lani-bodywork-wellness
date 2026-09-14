import { timingSafeEqual } from "node:crypto";
import { requireBookingConfig } from "../../lib/config.js";
import { getSquareClient } from "../../lib/square.js";
import { formatSquarePhoneE164, hasTurnoverConflict, listSquareBlockingBookings } from "../../lib/booking-requests.js";
import { addDays, addMinutes, startOfDayInTimeZone } from "../../lib/time.js";

const TOKEN_ENV = "ANGELA_MIGRATION_EXECUTE_TOKEN";
// Temporary Angela-only migration surface; remove immediately after reconciliation.
const TARGET = Object.freeze({
  row: 19,
  client: "Angela Cummings",
  firstName: "Angela",
  lastName: "Cummings",
  email: "stylist.angelawilliams@gmail.com",
  phone: "(803) 526-0238",
  date: "2026-09-23",
  time: "10:00",
  primaryServiceKey: "customized_90",
  primaryDurationMinutes: 90,
  addOnDurationMinutes: 15,
  totalDurationMinutes: 105,
});
const KAYLA = Object.freeze({ date: "2026-09-23", time: "12:00", customerSuffix: "...6455DW", bookingSuffix: "...72tic6", durationMinutes: 90 });
const INACTIVE = new Set(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED", "NO_SHOW"]);

function suffix(id) {
  return id ? `...${String(id).slice(-6)}` : null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function assertProduction() {
  return process.env.SQUARE_ENVIRONMENT === "production" && process.env.BOOKING_APPROVAL_MODE === "production";
}

function authorized(req) {
  const configured = process.env[TOKEN_ENV];
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return configured && safeEqual(token, configured);
}

function startAt(date = TARGET.date, time = TARGET.time) {
  const [hours, minutes] = time.split(":").map(Number);
  return addMinutes(startOfDayInTimeZone(date), hours * 60 + minutes).toISOString();
}

function segmentDuration(segment) {
  return Number(segment?.durationMinutes || 0);
}

function totalDuration(booking) {
  return (booking?.appointmentSegments || []).reduce((sum, segment) => sum + segmentDuration(segment), 0);
}

function objectDurationMinutes(object) {
  const value = object?.itemVariationData?.serviceDuration;
  if (value == null) return null;
  return Math.round(Number(value) / 60000);
}

function namesMatch(customer) {
  const full = `${customer?.givenName || ""} ${customer?.familyName || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  return full === TARGET.client.toLowerCase();
}

async function searchCustomer(client) {
  const squarePhone = formatSquarePhoneE164(TARGET.phone);
  const [emailResult, phoneResult] = await Promise.all([
    client.customers.search({ query: { filter: { emailAddress: { exact: TARGET.email } } } }),
    client.customers.search({ query: { filter: { phoneNumber: { exact: squarePhone } } } }),
  ]);
  const emailMatches = emailResult.customers || [];
  const phoneMatches = phoneResult.customers || [];
  const emailCustomer = emailMatches.find(namesMatch) || emailMatches[0] || null;
  const phoneCustomer = phoneMatches.find(namesMatch) || phoneMatches[0] || null;
  if (emailCustomer && phoneCustomer && emailCustomer.id === phoneCustomer.id && namesMatch(emailCustomer)) {
    return { classification: "EXACT_EXISTING_CUSTOMER", customer: emailCustomer };
  }
  if (!emailCustomer && phoneCustomer && namesMatch(phoneCustomer)) return { classification: "EXACT_EXISTING_CUSTOMER", customer: phoneCustomer };
  if (emailCustomer && !phoneCustomer && namesMatch(emailCustomer)) return { classification: "EXACT_EXISTING_CUSTOMER", customer: emailCustomer };
  return { classification: emailCustomer || phoneCustomer ? "DATA_CONFLICT" : "WOULD_CREATE_NEW_CUSTOMER", customer: null };
}

async function catalogObject(client, objectId) {
  const response = await client.catalog.object.get({ objectId });
  return response?.object || null;
}

function catalogVariationSummary(object, itemName = null) {
  return {
    itemName,
    variationName: object?.itemVariationData?.name || object?.itemData?.name || null,
    suffix: suffix(object?.id),
    durationMinutes: objectDurationMinutes(object),
    availableForBooking: object?.itemVariationData?.availableForBooking === true,
    teamMemberUsable: Array.isArray(object?.itemVariationData?.teamMemberIds)
      ? object.itemVariationData.teamMemberIds.includes(process.env.SQUARE_TEAM_MEMBER_ID)
      : true,
    versionPresent: typeof object?.version === "bigint" || typeof object?.version === "number",
  };
}

async function findFacialAddOn(client) {
  const response = await client.catalog.search({ objectTypes: ["ITEM"], includeRelatedObjects: true, limit: 100 });
  const objects = [...(response?.data?.objects || []), ...(response?.data?.relatedObjects || [])];
  const variations = [];
  for (const object of objects) {
    if (object.type === "ITEM") {
      for (const variation of object.itemData?.variations || []) variations.push({ itemName: object.itemData?.name || null, variation });
    } else if (object.type === "ITEM_VARIATION") {
      variations.push({ itemName: null, variation: object });
    }
  }
  const candidates = variations
    .map(({ itemName, variation }) => ({ itemName, variation, text: `${itemName || ""} ${variation?.itemVariationData?.name || ""}`.toUpperCase() }))
    .filter((entry) => entry.text.includes("FACIAL") && objectDurationMinutes(entry.variation) === TARGET.addOnDurationMinutes)
    .map((entry) => ({ ...catalogVariationSummary(entry.variation, entry.itemName), id: entry.variation.id, version: entry.variation.version }));
  const exact = candidates.find((candidate) => candidate.availableForBooking && candidate.teamMemberUsable && candidate.versionPresent) || null;
  return { exact, candidates: candidates.map(({ id, version, ...safe }) => safe) };
}

function activeBookings(bookings) {
  return bookings.filter((booking) => !INACTIVE.has(booking.status));
}

function findAngelaBooking(bookings, customerId, primaryId, addOnId) {
  const expectedStart = startAt();
  return activeBookings(bookings).find((booking) => {
    const segments = booking.appointmentSegments || [];
    return booking.customerId === customerId &&
      booking.startAt && new Date(booking.startAt).getTime() === new Date(expectedStart).getTime() &&
      segments.length === 2 &&
      segments[0]?.serviceVariationId === primaryId &&
      segmentDuration(segments[0]) === TARGET.primaryDurationMinutes &&
      segments[1]?.serviceVariationId === addOnId &&
      segmentDuration(segments[1]) === TARGET.addOnDurationMinutes &&
      totalDuration(booking) === TARGET.totalDurationMinutes;
  }) || null;
}

function findSameStart(bookings) {
  const expectedStart = startAt();
  return activeBookings(bookings).filter((booking) => booking.startAt && new Date(booking.startAt).getTime() === new Date(expectedStart).getTime());
}

function findKaylaBooking(bookings) {
  const kaylaStart = startAt(KAYLA.date, KAYLA.time);
  return activeBookings(bookings).find((booking) =>
    suffix(booking.id) === KAYLA.bookingSuffix &&
    suffix(booking.customerId) === KAYLA.customerSuffix &&
    booking.startAt && new Date(booking.startAt).getTime() === new Date(kaylaStart).getTime()
  ) || null;
}

async function collectState(client) {
  const primaryConfig = requireBookingConfig(TARGET.primaryServiceKey);
  const primaryObject = await catalogObject(client, primaryConfig.service.serviceVariationId);
  const facial = await findFacialAddOn(client);
  const customer = await searchCustomer(client);
  const dayStart = startOfDayInTimeZone(TARGET.date);
  const bookings = await listSquareBlockingBookings(client, { locationId: primaryConfig.locationId, teamMemberId: primaryConfig.teamMemberId, dayStart, dayEnd: addDays(dayStart, 1) });
  const primary = catalogVariationSummary(primaryObject, "Customized Massage");
  const angelaBooking = customer.customer && facial.exact
    ? findAngelaBooking(bookings, customer.customer.id, primaryConfig.service.serviceVariationId, facial.exact.id)
    : null;
  const sameStartCount = findSameStart(bookings).length;
  const kaylaBooking = findKaylaBooking(bookings);
  const availability = {
    angelaOccupies: "10:00-11:45",
    kaylaStartPreserved: Boolean(kaylaBooking),
    legacyBufferException: "LEGACY_BUFFER_EXCEPTION_ACCEPTED",
    newBookingAt1115Conflicts: hasTurnoverConflict({ startAt: startAt(TARGET.date, "11:15"), durationMinutes: 60, existing: bookings }),
    newBookingAt1400AllowedByTurnover: !hasTurnoverConflict({ startAt: startAt(TARGET.date, "14:00"), durationMinutes: 60, existing: bookings }),
  };
  const canRepresent = primary.durationMinutes === 90 && primary.availableForBooking && primary.teamMemberUsable && primary.versionPresent &&
    facial.exact?.durationMinutes === 15 && facial.exact.availableForBooking && facial.exact.teamMemberUsable && facial.exact.versionPresent;
  return { primaryConfig, primaryObject, primary, facial, customer, bookings, angelaBooking, sameStartCount, kaylaBooking, availability, canRepresent };
}

function squareVersionForCreate(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return value;
}

function safeState(state) {
  return {
    representationSupported: state.canRepresent,
    customerClassification: state.customer.classification,
    customerSuffix: suffix(state.customer.customer?.id),
    primaryService: { ...state.primary, mapped: state.primary.durationMinutes === 90 },
    facialAddOn: state.facial.exact ? { ...state.facial.exact, id: undefined, version: undefined, mapped: true } : null,
    facialCandidates: state.facial.candidates,
    squareSegmentCount: state.canRepresent ? 2 : 0,
    totalDurationMinutes: state.canRepresent ? TARGET.totalDurationMinutes : null,
    existingAngelaBooking: state.angelaBooking ? "EXACT_BOOKING_ALREADY_EXISTS" : state.sameStartCount > 0 ? "SAME_START_CONFLICT" : "NO_EXISTING_BOOKING",
    angelaBookingSuffix: suffix(state.angelaBooking?.id),
    angelaBookingStatus: state.angelaBooking?.status || null,
    kaylaBookingPreserved: Boolean(state.kaylaBooking),
    kaylaBookingSuffix: suffix(state.kaylaBooking?.id),
    availability: state.availability,
    writes: { customers: 0, bookings: 0, orders: 0, payments: 0, paymentLinks: 0, neon: 0, emails: 0 },
  };
}

async function execute(client) {
  const state = await collectState(client);
  const before = safeState(state);
  const gateFailures = [];
  if (!state.canRepresent) gateFailures.push("catalog_representation_missing");
  if (state.customer.classification !== "EXACT_EXISTING_CUSTOMER") gateFailures.push("angela_customer_not_exact_existing");
  if (state.angelaBooking) return { ...before, bookingCreated: false, postCreateClassification: "EXACT_BOOKING_ALREADY_EXISTS", postCreateBookingWrites: 0 };
  if (state.sameStartCount > 0) gateFailures.push("same_start_booking_exists");
  if (!state.kaylaBooking) gateFailures.push("kayla_noon_booking_missing");
  if (gateFailures.length > 0) return { ...before, bookingCreated: false, gateFailures };

  const idempotencyKey = `angela-cummings-massagebook-row-19-${TARGET.date}-${TARGET.time}`;
  const response = await client.bookings.create({
    idempotencyKey,
    booking: {
      startAt: startAt(),
      locationId: state.primaryConfig.locationId,
      customerId: state.customer.customer.id,
      appointmentSegments: [
        {
          durationMinutes: TARGET.primaryDurationMinutes,
          serviceVariationId: state.primaryConfig.service.serviceVariationId,
          teamMemberId: state.primaryConfig.teamMemberId,
          serviceVariationVersion: squareVersionForCreate(state.primaryObject.version),
        },
        {
          durationMinutes: TARGET.addOnDurationMinutes,
          serviceVariationId: state.facial.exact.id,
          teamMemberId: state.primaryConfig.teamMemberId,
          serviceVariationVersion: squareVersionForCreate(state.facial.exact.version),
        },
      ],
    },
  }, { queryParams: { seller_level: false } });
  const createdId = response?.booking?.id;
  if (!createdId) return { ...before, bookingCreated: false, gateFailures: ["square_create_missing_booking_id"] };
  const retrieved = await client.bookings.get({ bookingId: createdId });
  const afterState = await collectState(client);
  const matching = afterState.customer.customer && afterState.facial.exact
    ? activeBookings(afterState.bookings).filter((booking) => findAngelaBooking([booking], afterState.customer.customer.id, afterState.primaryConfig.service.serviceVariationId, afterState.facial.exact.id)).length
    : 0;
  return {
    ...safeState(afterState),
    bookingCreated: true,
    bookingWrites: 1,
    createdBookingSuffix: suffix(createdId),
    retrievedBookingSuffix: suffix(retrieved?.booking?.id),
    retrievedSegmentCount: retrieved?.booking?.appointmentSegments?.length || 0,
    retrievedTotalDurationMinutes: totalDuration(retrieved?.booking),
    matchingAngelaBookings: matching,
    postCreateClassification: matching === 1 ? "EXACT_BOOKING_ALREADY_EXISTS" : "RECONCILIATION_FAILED",
    postCreateBookingWrites: 0,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!assertProduction()) return res.status(409).json({ error: "production_only" });
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  const mode = req.body?.mode;
  if (!["audit", "execute"].includes(mode)) return res.status(400).json({ error: "mode must be audit or execute" });
  try {
    const client = getSquareClient();
    if (mode === "audit") return res.status(200).json({ mode, ...(safeState(await collectState(client))) });
    return res.status(200).json({ mode, ...(await execute(client)) });
  } catch {
    return res.status(500).json({ error: "angela_migration_failed" });
  }
}
