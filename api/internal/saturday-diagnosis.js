import { timingSafeEqual } from "node:crypto";
import { requireBookingConfig } from "../../lib/config.js";
import { getSquareClient } from "../../lib/square.js";
import { addDays, startOfDayInTimeZone } from "../../lib/time.js";

const TOKEN_ENV = "SATURDAY_DIAGNOSIS_TOKEN";
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DATES = [
  { date: "2026-09-17", note: "working weekday comparison" },
  { date: "2026-09-19", note: "Saturday with existing bookings" },
  { date: "2026-09-26", note: "Saturday in public window" },
];
const SERVICES = ["customized_60", "customized_90"];

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

function weekdayNumber(dateStr) {
  return new Date(`${dateStr}T12:00:00.000Z`).getUTCDay();
}

function weekdayName(dateStr) {
  return WEEKDAYS[weekdayNumber(dateStr)];
}

function isSaturday(dateStr) {
  return weekdayNumber(dateStr) === 6;
}

function timeLabel(local) {
  if (!local || local.length < 4) return local || null;
  const hh = Number(local.slice(0, 2));
  const mm = local.slice(2, 4);
  const period = hh >= 12 ? "PM" : "AM";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${mm} ${period}`;
}

function buildAvailabilityRequest(config, date) {
  const dayStart = startOfDayInTimeZone(date);
  const dayEnd = addDays(dayStart, 1);
  return {
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
  };
}

async function availabilityFor(client, config, date) {
  const request = buildAvailabilityRequest(config, date);
  const response = await client.bookings.searchAvailability(request);
  const availabilities = response.availabilities || [];
  return {
    count: availabilities.length,
    slots: availabilities
      .map((entry) => entry.startAt)
      .filter((value) => typeof value === "string")
      .sort(),
    serviceVariationId: config.service.serviceVariationId,
  };
}

async function runDiagnosis() {
  const client = getSquareClient();
  const primary = requireBookingConfig("customized_60");

  const location = await client.locations.get({ locationId: primary.locationId });
  const teamMember = await client.teamMembers.get({ teamMemberId: primary.teamMemberId });
  const teamProfileResponse = await client.bookings.teamMemberProfiles.get({ teamMemberId: primary.teamMemberId });
  const locationProfileList = await client.bookings.locationProfiles.list({});
  const locationProfile = (locationProfileList?.data || []).find((entry) => entry.locationId === primary.locationId) || null;

  const locationPeriods = (location?.businessHours?.periods || []).map((period) => ({
    weekday: WEEKDAYS[Number(period.weekday_number || 0) - 1] || null,
    weekdayNumber: period.weekday_number,
    startLocalTime: period.start_local_time,
    startLabel: timeLabel(period.start_local_time),
    endLocalTime: period.end_local_time,
    endLabel: timeLabel(period.end_local_time),
  }));

  const weeklyLocationHours = {};
  for (let i = 0; i < 7; i += 1) {
    const periods = locationPeriods.filter((period) => period.weekdayNumber === i + 1);
    weeklyLocationHours[WEEKDAYS[i]] = periods.length
      ? periods.map((period) => `${period.startLabel} - ${period.endLabel}`)
      : [];
  }

  const dates = [];
  for (const { date, note } of DATES) {
    const services = {};
    for (const serviceKey of SERVICES) {
      const config = requireBookingConfig(serviceKey);
      services[serviceKey] = await availabilityFor(client, config, date);
    }
    dates.push({ date, weekday: weekdayName(date), isSaturday: isSaturday(date), note, services });
  }

  const saturday = dates.find((entry) => entry.isSaturday);
  const weekday = dates.find((entry) => !entry.isSaturday);

  return {
    locationId: primary.locationId,
    teamMemberId: primary.teamMemberId,
    location: {
      name: location?.name || null,
      status: location?.status || null,
      mcc: location?.mcc || null,
      timezone: location?.timezone || null,
    },
    businessHoursPeriods: locationPeriods,
    weeklyLocationHours,
    locationBookingProfile: locationProfile
      ? { onlineBookingEnabled: locationProfile.onlineBookingEnabled, bookingSiteUrl: locationProfile.bookingSiteUrl }
      : null,
    teamMember: {
      status: teamMember?.status || null,
      givenName: teamMember?.givenName || null,
      familyName: teamMember?.familyName || null,
      suffix: suffix(teamMember?.id),
    },
    teamMemberBookingProfile: teamProfileResponse?.teamMemberBookingProfile
      ? {
          isBookable: teamProfileResponse.teamMemberBookingProfile.isBookable,
          displayName: teamProfileResponse.teamMemberBookingProfile.displayName,
          description: teamProfileResponse.teamMemberBookingProfile.description || null,
        }
      : null,
    requestShape: buildAvailabilityRequest(primary, DATES[0].date),
    dates,
    checks: {
      locationOnlineBookingEnabled: locationProfile?.onlineBookingEnabled === true,
      teamMemberBookable: teamProfileResponse?.teamMemberBookingProfile?.isBookable === true,
      saturdayLocationHoursConfigured: (weeklyLocationHours.Saturday || []).length > 0,
      saturdaySearchAvailabilityReturnsOpenings: saturday?.services?.customized_60?.count > 0 || saturday?.services?.customized_90?.count > 0,
      weekdaySearchAvailabilityReturnsOpenings: (weekday?.services?.customized_60?.count || 0) + (weekday?.services?.customized_90?.count || 0) > 0,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!assertProduction()) return res.status(409).json({ error: "production_only" });
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const result = await runDiagnosis();
    return res.status(200).json(result);
  } catch (error) {
    const status = error && typeof error === "object" ? error.statusCode : null;
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(200).json({ error: `square_${status}`, detail: "read-only diagnosis failed with a Square client error" });
    }
    return res.status(500).json({ error: "saturday_diagnosis_failed" });
  }
}