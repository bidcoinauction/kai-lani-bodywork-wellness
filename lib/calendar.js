import { addMinutes, BOOKING_TIMEZONE } from "./time.js";

export const GOOGLE_CALENDAR_URL_BASE =
  "https://calendar.google.com/calendar/render";

export const BOOKING_LOCATION = "106 S Main St, Suite F, Mount Holly, NC 28120";
export const BUSINESS_PHONE = "(980) 224-2462";
export const ARRIVAL_INSTRUCTIONS =
  "Kai Lani is located behind Bolton's Curbside Cookery in Downtown Mount Holly. Google Maps will bring you to 106 S Main St. From South Main Street, enter the narrow drive beside Uptown Salon and follow it behind the building. Look for the black metal staircase at the rear. The Suite F entrance is the ground-level door just beyond the staircase. Do not go up the stairs.";

export const ICS_FILENAME = "kai-lani-appointment.ics";
const PRODID = "-//Kai Lani Bodywork & Wellness//Appointments//EN";
const UID_DOMAIN = "kai-lani-bodywork-wellness.com";
const EVENT_TITLE_PREFIX = "Kai Lani Bodywork & Wellness \u2014";

export class CalendarError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalendarError";
  }
}

function normalizeDuration(value) {
  const minutes = Number(value);
  if (minutes !== 60 && minutes !== 90) return null;
  return minutes;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates and normalizes server-owned appointment data. Only fields required
 * for a calendar event are read; client medical information, private notes or
 * any other extra input is ignored so it can never leak into the output.
 */
export function normalizeAppointment(appointment) {
  if (!appointment || typeof appointment !== "object" || Array.isArray(appointment)) {
    throw new CalendarError("appointment is required");
  }

  const bookingId = appointment.bookingId;
  if (!isNonEmptyString(bookingId)) {
    throw new CalendarError("bookingId is required");
  }

  const serviceName = appointment.serviceName;
  if (!isNonEmptyString(serviceName)) {
    throw new CalendarError("serviceName is required");
  }

  const duration = normalizeDuration(appointment.duration);
  if (!duration) {
    throw new CalendarError("duration must be 60 or 90 minutes");
  }

  const start = new Date(appointment.startAt);
  if (Number.isNaN(start.getTime())) {
    throw new CalendarError("startAt must be a valid date");
  }

  return { bookingId, serviceName, duration, start };
}

function eventTitle(serviceName) {
  return `${EVENT_TITLE_PREFIX} ${serviceName}`;
}

function buildUid(bookingId) {
  return `kai-lani-${bookingId}@${UID_DOMAIN}`;
}

function formatDateTime(start) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(start);
}

function descriptionFor(data) {
  return [
    "Confirmed appointment: Kai Lani Bodywork & Wellness",
    `Service: ${data.serviceName} (${data.duration} minutes)`,
    `Booking reference: ${data.bookingId}`,
    `Date and time: ${formatDateTime(data.start)}`,
    `Location: ${BOOKING_LOCATION}`,
    `Phone: ${BUSINESS_PHONE}`,
    "",
    "Arrival instructions:",
    ARRIVAL_INSTRUCTIONS,
  ].join("\n");
}

/**
 * Human-readable confirmed-appointment description. Contains only the booking
 * reference, service, time, business phone, location and arrival instructions.
 */
export function buildDescription(appointment) {
  return descriptionFor(normalizeAppointment(appointment));
}

/**
 * Formats a Date as an iCalendar UTC timestamp: YYYYMMDDTHHMMSSZ.
 */
export function toIcsDateTime(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * RFC 5545 text escaping for backslashes, semicolons, commas and newlines.
 */
export function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Folds a content line at 75 octets with CRLF + space continuations, never
 * splitting a multi-byte UTF-8 character. Lines already within the limit are
 * returned unchanged.
 */
export function foldIcsLine(line, limit = 75) {
  if (Buffer.byteLength(line, "utf8") <= limit) return line;
  const segments = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (currentBytes + charBytes > limit && current.length > 0) {
      segments.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current.length > 0) segments.push(current);
  return segments.join("\r\n ");
}

function percentEncode(value) {
  // Keep the slash unencoded so the dates parameter uses Google's documented
  // literal form: YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ.
  return encodeURIComponent(String(value)).replace(/%2F/gi, "/");
}

/**
 * Builds an "Add to Google Calendar" link (action=TEMPLATE) with the event
 * dates expressed in UTC (YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ).
 */
export function buildGoogleCalendarUrl(appointment) {
  const data = normalizeAppointment(appointment);
  const start = toIcsDateTime(data.start);
  const end = toIcsDateTime(addMinutes(data.start, data.duration));
  const params = [
    ["action", "TEMPLATE"],
    ["text", eventTitle(data.serviceName)],
    ["dates", `${start}/${end}`],
    ["location", BOOKING_LOCATION],
    ["details", descriptionFor(data)],
  ];
  const query = params
    .map(([key, value]) => `${key}=${percentEncode(value)}`)
    .join("&");
  return `${GOOGLE_CALENDAR_URL_BASE}?${query}`;
}

/**
 * Builds a valid RFC 5545 ICS calendar with CRLF line endings. The UID is
 * deterministic: it is derived from the Square booking ID, so retries never
 * create a duplicate event identity.
 */
export function buildIcsCalendar(appointment, { now = new Date() } = {}) {
  const data = normalizeAppointment(appointment);
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new CalendarError("now must be a valid date");
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${buildUid(data.bookingId)}`,
    `DTSTAMP:${toIcsDateTime(nowDate)}`,
    `DTSTART:${toIcsDateTime(data.start)}`,
    `DTEND:${toIcsDateTime(addMinutes(data.start, data.duration))}`,
    `SUMMARY:${escapeIcsText(eventTitle(data.serviceName))}`,
    `DESCRIPTION:${escapeIcsText(descriptionFor(data))}`,
    `LOCATION:${escapeIcsText(BOOKING_LOCATION)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map((line) => foldIcsLine(line)).join("\r\n") + "\r\n";
}

/**
 * Builds a Resend-ready base64 attachment for the appointment ICS file.
 * email.js has no attachment plumbing today; approved client/provider
 * confirmation emails can pass this object into the Resend attachments array.
 */
export function buildIcsAttachment(appointment, options) {
  const content = Buffer.from(buildIcsCalendar(appointment, options), "utf8").toString("base64");
  return { filename: ICS_FILENAME, content };
}

export const calendarTestInternals = {
  ARRIVAL_INSTRUCTIONS,
  BOOKING_LOCATION,
  BUSINESS_PHONE,
  EVENT_TITLE_PREFIX,
  GOOGLE_CALENDAR_URL_BASE,
  ICS_FILENAME,
  PRODID,
  buildDescription,
  buildUid,
  escapeIcsText,
  foldIcsLine,
  normalizeAppointment,
  toIcsDateTime,
};
