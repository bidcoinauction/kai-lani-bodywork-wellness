import { timingSafeEqual } from "node:crypto";
import { requireBookingConfig } from "../../lib/config.js";
import { getSquareClient } from "../../lib/square.js";
import { hasTurnoverConflict, listSquareBlockingBookings } from "../../lib/booking-requests.js";
import { addDays, addMinutes, formatTimeLabel, getNewYorkDateString, startOfDayInTimeZone } from "../../lib/time.js";

const TOKEN_ENV = "SATURDAY_AVAILABILITY_AUDIT_TOKEN";
const AUDIT_DATES = ["2026-09-19", "2026-09-23", "2026-09-26"];
const SERVICE_KEYS = ["customized_60", "customized_90"];
const KNOWN = Object.freeze({
  saturdayBookings: ["...sucvdx", "...gqd6me", "...jtq87k"],
  angelaBooking: "...ir8w4e",
  kaylaBooking: "...72tic6",
});
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

function authorized(req) {
  const configured = process.env[TOKEN_ENV];
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(configured) && safeEqual(token, configured);
}

function assertProduction() {
  return process.env.SQUARE_ENVIRONMENT === "production" && process.env.BOOKING_APPROVAL_MODE === "production";
}

function isSaturday(date) {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay() === 6;
}

function startAt(date, time) {
  const [hours, minutes] = time.split(":").map(Number);
  return addMinutes(startOfDayInTimeZone(date), hours * 60 + minutes).toISOString();
}

function segmentDuration(segment) {
  return Number(segment?.durationMinutes || 0);
}

function bookingDuration(booking) {
  const segments = Array.isArray(booking?.appointmentSegments) ? booking.appointmentSegments : [];
  const total = segments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function bookingEnd(startAt, durationMinutes) {
  return addMinutes(new Date(startAt), durationMinutes).toISOString();
}

function sanitizeBooking(booking) {
  const durationMinutes = bookingDuration(booking);
  return {
    bookingSuffix: suffix(booking?.id),
    customerSuffix: suffix(booking?.customerId),
    status: booking?.status || null,
    startAt: booking?.startAt || null,
    label: booking?.startAt ? formatTimeLabel(booking.startAt) : null,
    durationMinutes,
    endAt: booking?.startAt && durationMinutes ? bookingEnd(booking.startAt, durationMinutes) : null,
    segmentCount: booking?.appointmentSegments?.length || 0,
    segments: (booking?.appointmentSegments || []).map((segment, index) => ({
      position: index + 1,
      durationMinutes: segmentDuration(segment),
      serviceVariationSuffix: suffix(segment?.serviceVariationId),
      teamMemberMatch: segment?.teamMemberId === process.env.SQUARE_TEAM_MEMBER_ID,
    })),
  };
}

function active(bookings) {
  return bookings.filter((booking) => !INACTIVE.has(booking.status));
}

async function serviceAudit(client, date, serviceKey, bookings) {
  const config = requireBookingConfig(serviceKey);
  const dayStart = startOfDayInTimeZone(date);
  const dayEnd = addDays(dayStart, 1);
  const response = await client.bookings.searchAvailability({
    query: {
      filter: {
        startAtRange: { startAt: dayStart.toISOString(), endAt: dayEnd.toISOString() },
        locationId: config.locationId,
        segmentFilters: [{
          serviceVariationId: config.service.serviceVariationId,
          teamMemberIdFilter: { any: [config.teamMemberId] },
        }],
      },
    },
  });
  const squareSlots = (response.availabilities || [])
    .map((availability) => availability.startAt)
    .filter((startAt) => typeof startAt === "string")
    .sort();
  const websiteSlots = squareSlots.filter((startAt) => !hasTurnoverConflict({
    startAt,
    durationMinutes: config.service.durationMinutes,
    existing: bookings,
  }));
  const blockedReturnedSlots = squareSlots
    .filter((startAt) => !websiteSlots.includes(startAt))
    .map((startAt) => ({ startAt, label: formatTimeLabel(startAt), reason: "blocked_by_existing_square_booking_or_30_min_turnover" }));
  return {
    serviceKey,
    serviceDurationMinutes: config.service.durationMinutes,
    squareAvailableSlots: squareSlots.map((startAt) => ({ startAt, label: formatTimeLabel(startAt) })),
    websiteAvailableSlots: websiteSlots.map((startAt) => ({ startAt, label: formatTimeLabel(startAt) })),
    blockedReturnedSlots,
  };
}

async function dateAudit(client, date) {
  const config = requireBookingConfig("customized_60");
  const dayStart = startOfDayInTimeZone(date);
  const dayEnd = addDays(dayStart, 1);
  const bookings = await listSquareBlockingBookings(client, {
    locationId: config.locationId,
    teamMemberId: config.teamMemberId,
    dayStart,
    dayEnd,
  });
  return {
    date,
    isSaturday: isSaturday(date),
    existingBookings: active(bookings).map(sanitizeBooking).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt))),
    turnoverProbes: ["10:00", "11:15", "12:15", "14:00"].map((time) => ({
      time,
      label: formatTimeLabel(startAt(date, time)),
      sixtyMinuteConflicts: hasTurnoverConflict({ startAt: startAt(date, time), durationMinutes: 60, existing: bookings }),
      ninetyMinuteConflicts: hasTurnoverConflict({ startAt: startAt(date, time), durationMinutes: 90, existing: bookings }),
    })),
    services: await Promise.all(SERVICE_KEYS.map((serviceKey) => serviceAudit(client, date, serviceKey, bookings))),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!assertProduction()) return res.status(409).json({ error: "production_only" });
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const client = getSquareClient();
    const dates = await Promise.all(AUDIT_DATES.map((date) => dateAudit(client, date)));
    const sep19 = dates.find((entry) => entry.date === "2026-09-19");
    const sep23 = dates.find((entry) => entry.date === "2026-09-23");
    const saturdaySuffixes = new Set((sep19?.existingBookings || []).map((booking) => booking.bookingSuffix));
    const angela = (sep23?.existingBookings || []).find((booking) => booking.bookingSuffix === KNOWN.angelaBooking) || null;
    const kayla = (sep23?.existingBookings || []).find((booking) => booking.bookingSuffix === KNOWN.kaylaBooking) || null;
    return res.status(200).json({
      today: getNewYorkDateString(),
      publicWindowDays: 14,
      squareIsAuthorityForConfirmedOccupancy: true,
      localPendingRequestsOnlyAddTemporaryHolds: true,
      noSquareWrites: true,
      noNeonWrites: true,
      dates,
      checks: {
        sep19IsSaturday: sep19?.isSaturday === true,
        knownSep19BookingsFound: KNOWN.saturdayBookings.every((bookingSuffix) => saturdaySuffixes.has(bookingSuffix)),
        saturdaySupported: dates.filter((entry) => entry.isSaturday).every((entry) => entry.services.every((service) => Array.isArray(service.squareAvailableSlots) && Array.isArray(service.websiteAvailableSlots))),
        existingSquareBookingsBlockSite: dates.some((entry) => entry.services.some((service) => service.blockedReturnedSlots.length > 0)) || (sep19?.existingBookings || []).length > 0,
        validSaturdaySlotsCanAppear: dates.filter((entry) => entry.isSaturday).some((entry) => entry.services.some((service) => service.websiteAvailableSlots.length > 0)),
        angelaFound: Boolean(angela),
        angelaDurationMinutes: angela?.durationMinutes || null,
        angelaSegmentCount: angela?.segmentCount || 0,
        angelaOccupies105Minutes: angela?.durationMinutes === 105,
        kaylaFound: Boolean(kayla),
        kaylaStartPreserved: kayla?.label === "12:00 PM",
        invalidLegacyGapPrevented: (sep23?.turnoverProbes || []).some((probe) => probe.label === "11:15 AM" && probe.sixtyMinuteConflicts) &&
          (sep23?.turnoverProbes || []).some((probe) => probe.label === "12:15 PM" && probe.sixtyMinuteConflicts),
      },
    });
  } catch {
    return res.status(500).json({ error: "saturday_availability_audit_failed" });
  }
}
