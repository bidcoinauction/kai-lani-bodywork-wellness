import { randomUUID, timingSafeEqual } from "node:crypto";
import { getAddOnConfig, isExactFacialMassageAddOnVariation } from "../../lib/add-ons.js";
import { requireBookingConfig } from "../../lib/config.js";
import { getSquareClient } from "../../lib/square.js";
import { formatSquarePhoneE164, hasTurnoverConflict, listSquareBlockingBookings } from "../../lib/booking-requests.js";
import { addDays, addMinutes, startOfDayInTimeZone } from "../../lib/time.js";

const TOKEN_ENV = "MASSAGEBOOK_ANGELA_FINALIZE_TOKEN";
const ADD_ON_KEY = "facial_massage_15";
const ANGELA = Object.freeze({
  client: "Angela Cummings",
  email: "stylist.angelawilliams@gmail.com",
  phone: "(803) 526-0238",
  customerSuffix: "...CD0X3G",
  date: "2026-09-23",
  time: "10:00",
  primaryServiceKey: "customized_90",
  primaryDurationMinutes: 90,
  addOnDurationMinutes: 15,
  totalDurationMinutes: 105,
});
const KAYLA = Object.freeze({ date: "2026-09-23", time: "12:00", bookingSuffix: "...72tic6", customerSuffix: "...6455DW" });
const INACTIVE = new Set(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED", "NO_SHOW"]);

function suffix(id) {
  return id ? `...${String(id).slice(-6)}` : null;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? Number(entry) : entry)));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authorized(req) {
  const configured = process.env[TOKEN_ENV];
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(configured) && safeEqual(token, configured);
}

function assertProduction() {
  return process.env.SQUARE_ENVIRONMENT === "production" && process.env.BOOKING_APPROVAL_MODE === "production";
}

function startAt(date = ANGELA.date, time = ANGELA.time) {
  const [hours, minutes] = time.split(":").map(Number);
  return addMinutes(startOfDayInTimeZone(date), hours * 60 + minutes).toISOString();
}

function durationFromVariation(variation) {
  const value = variation?.itemVariationData?.serviceDuration;
  return value == null ? null : Math.round(Number(value) / 60000);
}

function priceCents(variation) {
  const value = variation?.itemVariationData?.priceMoney?.amount;
  return value == null ? null : Number(value);
}

function segmentDuration(segment) {
  return Number(segment?.durationMinutes || 0);
}

function totalBookingDuration(booking) {
  return (booking?.appointmentSegments || []).reduce((sum, segment) => sum + segmentDuration(segment), 0);
}

function active(bookings) {
  return bookings.filter((booking) => !INACTIVE.has(booking.status));
}

function namesMatch(customer) {
  const full = `${customer?.givenName || ""} ${customer?.familyName || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  return full === ANGELA.client.toLowerCase();
}

function variationSummary(variation, itemName = null) {
  const data = variation?.itemVariationData || {};
  return {
    itemSuffix: suffix(data.itemId),
    variationSuffix: suffix(variation?.id),
    itemName,
    variationName: data.name || null,
    durationMinutes: durationFromVariation(variation),
    priceCents: priceCents(variation),
    currency: data.priceMoney?.currency || null,
    locationEnabled: variation?.presentAtAllLocations === true || (variation?.presentAtLocationIds || []).includes(process.env.SQUARE_LOCATION_ID),
    availableForBooking: data.availableForBooking === true,
    chelseaEnabled: Array.isArray(data.teamMemberIds) ? data.teamMemberIds.includes(process.env.SQUARE_TEAM_MEMBER_ID) : true,
    versionPresent: typeof variation?.version === "bigint" || typeof variation?.version === "number",
  };
}

async function searchCustomer(client) {
  const squarePhone = formatSquarePhoneE164(ANGELA.phone);
  const [emailResult, phoneResult] = await Promise.all([
    client.customers.search({ query: { filter: { emailAddress: { exact: ANGELA.email } } } }),
    client.customers.search({ query: { filter: { phoneNumber: { exact: squarePhone } } } }),
  ]);
  const emailCustomer = (emailResult.customers || []).find(namesMatch) || (emailResult.customers || [])[0] || null;
  const phoneCustomer = (phoneResult.customers || []).find(namesMatch) || (phoneResult.customers || [])[0] || null;
  const customer = emailCustomer || phoneCustomer;
  if (customer && namesMatch(customer) && (!emailCustomer || !phoneCustomer || emailCustomer.id === phoneCustomer.id)) {
    return { classification: "EXACT_EXISTING_CUSTOMER", customer };
  }
  return { classification: customer ? "DATA_CONFLICT" : "WOULD_CREATE_NEW_CUSTOMER", customer: null };
}

async function getPrimary(client) {
  const config = requireBookingConfig(ANGELA.primaryServiceKey);
  const response = await client.catalog.object.get({ objectId: config.service.serviceVariationId });
  return { config, object: response.object, summary: variationSummary(response.object, "Customized Massage") };
}

async function searchCatalog(client) {
  const response = await client.catalog.search({ objectTypes: ["ITEM"], includeRelatedObjects: true, limit: 100 });
  const objects = [...(response?.data?.objects || []), ...(response?.data?.relatedObjects || [])];
  const variations = [];
  for (const object of objects) {
    if (object.type !== "ITEM") continue;
    for (const variation of object.itemData?.variations || []) variations.push({ item: object, variation });
  }
  const facialRelated = variations.filter(({ item, variation }) => {
    const text = `${item.itemData?.name || ""} ${variation.itemVariationData?.name || ""}`.toUpperCase();
    return text.includes("FACIAL") || text.includes("ADD-ON") || text.includes("ADD ON");
  });
  const exact = variations.find(({ item, variation }) => isExactFacialMassageAddOnVariation({ itemName: item.itemData?.name, variation })) || null;
  return {
    exact,
    related: facialRelated.map(({ item, variation }) => variationSummary(variation, item.itemData?.name)),
  };
}

function addOnUsable(entry) {
  if (!entry) return false;
  const summary = variationSummary(entry.variation, entry.item.itemData?.name);
  return summary.durationMinutes === 15 && summary.priceCents === 3000 && summary.currency === "USD" &&
    summary.locationEnabled && summary.availableForBooking && summary.chelseaEnabled && summary.versionPresent;
}

async function createAddOnIfMissing(client) {
  const before = await searchCatalog(client);
  if (before.exact && addOnUsable(before.exact)) return { action: "EXACT_ADDON_ALREADY_EXISTS", writes: 0, addOn: before.exact, related: before.related };
  const config = requireBookingConfig(ANGELA.primaryServiceKey);
  const addOn = getAddOnConfig(ADD_ON_KEY);
  const itemId = "#KL_ITEM_facial_massage_add_on";
  const variationId = "#KL_VAR_facial_massage_15";
  const response = await client.catalog.batchUpsert({
    idempotencyKey: randomUUID(),
    batches: [{
      objects: [{
        type: "ITEM",
        id: itemId,
        presentAtAllLocations: false,
        presentAtLocationIds: [config.locationId],
        itemData: {
          name: addOn.itemName,
          productType: "APPOINTMENTS_SERVICE",
          variations: [{
            type: "ITEM_VARIATION",
            id: variationId,
            presentAtAllLocations: false,
            presentAtLocationIds: [config.locationId],
            itemVariationData: {
              itemId,
              name: addOn.variationName,
              pricingType: "FIXED_PRICING",
              priceMoney: { amount: BigInt(addOn.priceCents), currency: addOn.currency },
              serviceDuration: BigInt(addOn.durationMinutes * 60000),
              availableForBooking: true,
              sellable: true,
              stockable: true,
              teamMemberIds: [config.teamMemberId],
            },
          }],
        },
      }],
    }],
  });
  if (response.errors?.length) return { action: "CATALOG_CREATE_FAILED", writes: 0, errors: response.errors.map((error) => error.code || "ERROR") };
  const after = await searchCatalog(client);
  if (!after.exact || !addOnUsable(after.exact)) return { action: "CATALOG_CREATE_VERIFICATION_FAILED", writes: 1, related: after.related };
  return { action: "ADDON_CREATED", writes: 1, addOn: after.exact, related: after.related };
}

async function dayBookings(client, config) {
  const dayStart = startOfDayInTimeZone(ANGELA.date);
  return listSquareBlockingBookings(client, { locationId: config.locationId, teamMemberId: config.teamMemberId, dayStart, dayEnd: addDays(dayStart, 1) });
}

function findAngelaBooking(bookings, customerId, primaryId, addOnId) {
  const expected = startAt();
  return active(bookings).find((booking) => {
    const segments = booking.appointmentSegments || [];
    return booking.customerId === customerId && suffix(booking.customerId) === ANGELA.customerSuffix &&
      booking.startAt && new Date(booking.startAt).getTime() === new Date(expected).getTime() &&
      segments.length === 2 &&
      segments[0]?.serviceVariationId === primaryId && segmentDuration(segments[0]) === 90 &&
      segments[1]?.serviceVariationId === addOnId && segmentDuration(segments[1]) === 15 &&
      totalBookingDuration(booking) === 105;
  }) || null;
}

function findKayla(bookings) {
  const expected = startAt(KAYLA.date, KAYLA.time);
  return active(bookings).find((booking) => suffix(booking.id) === KAYLA.bookingSuffix && suffix(booking.customerId) === KAYLA.customerSuffix && booking.startAt && new Date(booking.startAt).getTime() === new Date(expected).getTime()) || null;
}

function sameStartCount(bookings) {
  const expected = startAt();
  return active(bookings).filter((booking) => booking.startAt && new Date(booking.startAt).getTime() === new Date(expected).getTime()).length;
}

async function collect(client) {
  const [primary, catalog, customer] = await Promise.all([getPrimary(client), searchCatalog(client), searchCustomer(client)]);
  const bookings = await dayBookings(client, primary.config);
  const exactAddOn = catalog.exact && addOnUsable(catalog.exact) ? catalog.exact : null;
  const angelaBooking = customer.customer && exactAddOn ? findAngelaBooking(bookings, customer.customer.id, primary.config.service.serviceVariationId, exactAddOn.variation.id) : null;
  const kayla = findKayla(bookings);
  return { primary, catalog, exactAddOn, customer, bookings, angelaBooking, kayla };
}

function auditShape(state, catalogAction = "AUDIT_ONLY", catalogWrites = 0) {
  const addOn = state.exactAddOn ? variationSummary(state.exactAddOn.variation, state.exactAddOn.item.itemData?.name) : null;
  return {
    catalogAction,
    catalogWrites,
    representationSupported: Boolean(addOn),
    primaryService: state.primary.summary,
    addOnService: addOn,
    facialRelatedCandidates: state.catalog.related,
    customerClassification: state.customer.classification,
    customerSuffix: suffix(state.customer.customer?.id),
    existingAngelaBooking: state.angelaBooking ? "EXACT_BOOKING_ALREADY_EXISTS" : sameStartCount(state.bookings) > 0 ? "SAME_START_CONFLICT" : "NO_EXISTING_BOOKING",
    angelaBookingSuffix: suffix(state.angelaBooking?.id),
    angelaBookingStatus: state.angelaBooking?.status || null,
    kaylaPreserved: Boolean(state.kayla),
    kaylaBookingSuffix: suffix(state.kayla?.id),
    availability: {
      serverSumsSegments: true,
      angelaOccupies: state.angelaBooking ? "10:00-11:45" : null,
      newBookingAt1115Conflicts: hasTurnoverConflict({ startAt: startAt(ANGELA.date, "11:15"), durationMinutes: 60, existing: state.bookings }),
      newBookingAt1215Conflicts: hasTurnoverConflict({ startAt: startAt(ANGELA.date, "12:15"), durationMinutes: 60, existing: state.bookings }),
      legacyBufferException: "LEGACY_BUFFER_EXCEPTION_ACCEPTED",
    },
    writes: { customers: 0, bookings: 0, orders: 0, payments: 0, paymentLinks: 0, neon: 0, emails: 0 },
  };
}

function squareVersion(value) {
  return typeof value === "number" ? BigInt(value) : value;
}

async function executeAngela(client) {
  const state = await collect(client);
  const failures = [];
  if (!state.exactAddOn || !addOnUsable(state.exactAddOn)) failures.push("exact_addon_missing_or_unusable");
  if (state.customer.classification !== "EXACT_EXISTING_CUSTOMER" || suffix(state.customer.customer?.id) !== ANGELA.customerSuffix) failures.push("angela_customer_not_exact");
  if (!state.kayla) failures.push("kayla_noon_booking_missing");
  if (state.angelaBooking) return { ...auditShape(state), bookingCreated: false, bookingWrites: 0, postCreateClassification: "EXACT_BOOKING_ALREADY_EXISTS", postCreateBookingWrites: 0 };
  if (sameStartCount(state.bookings) > 0) failures.push("same_start_booking_exists");
  if (failures.length) return { ...auditShape(state), bookingCreated: false, bookingWrites: 0, gateFailures: failures };

  const response = await client.bookings.create({
    idempotencyKey: `massagebook-angela-cummings-row-19-${ANGELA.date}-${ANGELA.time}`,
    booking: {
      startAt: startAt(),
      locationId: state.primary.config.locationId,
      customerId: state.customer.customer.id,
      appointmentSegments: [
        { durationMinutes: 90, serviceVariationId: state.primary.config.service.serviceVariationId, teamMemberId: state.primary.config.teamMemberId, serviceVariationVersion: squareVersion(state.primary.object.version) },
        { durationMinutes: 15, serviceVariationId: state.exactAddOn.variation.id, teamMemberId: state.primary.config.teamMemberId, serviceVariationVersion: squareVersion(state.exactAddOn.variation.version) },
      ],
    },
  }, { queryParams: { seller_level: false } });
  const createdId = response?.booking?.id;
  if (!createdId) return { ...auditShape(state), bookingCreated: false, bookingWrites: 0, gateFailures: ["square_create_missing_booking_id"] };
  const after = await collect(client);
  const matches = after.customer.customer && after.exactAddOn ? active(after.bookings).filter((booking) => findAngelaBooking([booking], after.customer.customer.id, after.primary.config.service.serviceVariationId, after.exactAddOn.variation.id)).length : 0;
  return { ...auditShape(after), bookingCreated: true, bookingWrites: 1, createdBookingSuffix: suffix(createdId), matchingAngelaBookings: matches, postCreateClassification: matches === 1 ? "EXACT_BOOKING_ALREADY_EXISTS" : "RECONCILIATION_FAILED", postCreateBookingWrites: 0 };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!assertProduction()) return res.status(409).json({ error: "production_only" });
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  const mode = req.body?.mode;
  if (!["audit", "setup_addon", "execute_angela"].includes(mode)) return res.status(400).json({ error: "invalid_mode" });
  try {
    const client = getSquareClient();
    if (mode === "setup_addon") {
      const result = await createAddOnIfMissing(client);
      const state = await collect(client);
      return res.status(200).json(jsonSafe({ mode, ...auditShape(state, result.action, result.writes) }));
    }
    if (mode === "execute_angela") return res.status(200).json(jsonSafe({ mode, ...(await executeAngela(client)) }));
    return res.status(200).json(jsonSafe({ mode, ...auditShape(await collect(client)) }));
  } catch {
    return res.status(500).json({ error: "angela_finalize_failed" });
  }
}
