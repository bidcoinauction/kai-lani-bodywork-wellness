import { timingSafeEqual } from "node:crypto";
import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig } from "../../lib/config.js";
import {
  classifyExistingBooking,
  mapMassageBookService,
  startAtFromDateTime,
} from "../../lib/massagebook-migration.js";
import { formatSquarePhoneE164, listSquareBlockingBookings } from "../../lib/booking-requests.js";
import { addDays, startOfDayInTimeZone } from "../../lib/time.js";
import { BodyReadError, readJsonBody } from "../../lib/read-json-body.js";

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

function normalizedName(customer) {
  return `${clean(customer?.givenName)} ${clean(customer?.familyName)}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedEmail(value) {
  return clean(value).toLowerCase();
}

function normalizedPhone(value) {
  return formatSquarePhoneE164(value) || "";
}

function suffix(id) {
  return typeof id === "string" && id ? `...${id.slice(-6)}` : null;
}

function candidateEvidence(customer, row) {
  const nameMatch = normalizedName(customer) === clean(row.client_name).toLowerCase();
  const emailMatch = normalizedEmail(customer?.emailAddress) === normalizedEmail(row.email);
  const phoneMatch = normalizedPhone(customer?.phoneNumber) === normalizedPhone(row.mobile);
  const fieldsDisagree = [];
  if (!nameMatch) fieldsDisagree.push("name");
  if (!emailMatch) fieldsDisagree.push("email");
  if (!phoneMatch) fieldsDisagree.push("phone");
  return {
    customerSuffix: suffix(customer?.id),
    nameMatch,
    normalizedEmailMatch: emailMatch,
    normalizedPhoneMatch: phoneMatch,
    fieldsDisagree,
    confidence: nameMatch && emailMatch && phoneMatch ? "exact_name_email_phone" : nameMatch && (emailMatch || phoneMatch) ? "name_plus_contact" : emailMatch || phoneMatch ? "contact_only" : "weak",
  };
}

function classifyCandidates(candidates) {
  const exact = candidates.filter((candidate) => candidate.nameMatch && candidate.normalizedEmailMatch && candidate.normalizedPhoneMatch);
  if (exact.length === 1) return { classification: "EXACT_EXISTING_CUSTOMER", candidate: exact[0], reason: "one_candidate_matches_name_email_phone" };
  const namePlusContact = candidates.filter((candidate) => candidate.nameMatch && (candidate.normalizedEmailMatch || candidate.normalizedPhoneMatch));
  if (namePlusContact.length === 1) {
    return {
      classification: namePlusContact[0].normalizedEmailMatch ? "UNIQUE_EMAIL_MATCH" : "UNIQUE_PHONE_MATCH",
      candidate: namePlusContact[0],
      reason: "one_candidate_matches_name_plus_one_contact_field",
    };
  }
  if (candidates.length === 0) return { classification: "WOULD_CREATE_NEW_CUSTOMER", candidate: null, reason: "no_email_or_phone_candidates" };
  return { classification: "AMBIGUOUS_CUSTOMER", candidate: null, reason: "multiple_candidates_without_unique_name_contact_support" };
}

async function searchLane(client, row) {
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

export default async function handler(req, res) {
  if (!productionOnly()) return res.status(404).json({ error: "Not found" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!safeEqualToken(bearerToken(req), process.env.MASSAGEBOOK_MIGRATION_AUDIT_TOKEN)) {
    return res.status(404).json({ error: "Not found" });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) return res.status(error.statusCode).json({ error: error.message });
    throw error;
  }

  const row = body.row;
  if (!row || clean(row.client_name) !== "Lane Ellison") return res.status(400).json({ error: "Lane Ellison row is required" });

  const client = getSquareClient();
  const rawCandidates = await searchLane(client, row);
  const candidates = rawCandidates.map((customer) => candidateEvidence(customer, row));
  const customer = classifyCandidates(candidates);
  const mapping = mapMassageBookService(row.service);

  let booking = { classification: "NOT_CHECKED", bookingSuffix: null };
  if (["EXACT_EXISTING_CUSTOMER", "UNIQUE_EMAIL_MATCH", "UNIQUE_PHONE_MATCH", "WOULD_CREATE_NEW_CUSTOMER"].includes(customer.classification)) {
    const config = requireBookingConfig(mapping.serviceKey);
    const dayStart = startOfDayInTimeZone(row.date);
    const bookings = await listSquareBlockingBookings(client, {
      locationId: config.locationId,
      teamMemberId: config.teamMemberId,
      dayStart,
      dayEnd: addDays(dayStart, 1),
    });
    const rawCustomer = rawCandidates.find((candidate) => suffix(candidate.id) === customer.candidate?.customerSuffix) || null;
    const classification = classifyExistingBooking(row, config, rawCustomer, bookings);
    booking = {
      classification: classification.classification,
      bookingSuffix: suffix(classification.booking?.id),
    };
  }

  return res.status(200).json({
    row: {
      date: row.date,
      time: row.time,
      client: row.client_name,
      service: row.service,
      startAt: startAtFromDateTime(row.date, row.time),
    },
    candidateCount: candidates.length,
    candidates,
    customerClassification: customer.classification,
    customerSuffix: customer.candidate?.customerSuffix || null,
    reason: customer.reason,
    bookingClassification: booking.classification,
    bookingSuffix: booking.bookingSuffix,
    writes: {
      squareCustomerWrites: 0,
      squareBookingWrites: 0,
      squareOrderWrites: 0,
      squarePaymentWrites: 0,
      neonWrites: 0,
      emailsSent: 0,
    },
  });
}

export const laneAuditEndpointForTests = { safeEqualToken, candidateEvidence, classifyCandidates };
