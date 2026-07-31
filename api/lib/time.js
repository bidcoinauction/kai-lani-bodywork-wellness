export const BOOKING_TIMEZONE = "America/New_York";

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: BOOKING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatParts(date) {
  const parts = {};
  for (const part of PARTS_FORMATTER.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return parts;
}

/**
 * The current calendar date in America/New_York as YYYY-MM-DD.
 */
export function getNewYorkDateString(date = new Date()) {
  const parts = formatParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * UTC offset (in minutes) of America/New_York at the given instant.
 */
export function getNewYorkOffsetMinutes(utcDate) {
  const parts = formatParts(utcDate);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - utcDate.getTime()) / 60000;
}

/**
 * Returns a Date representing 00:00 America/New_York on the given YYYY-MM-DD date.
 */
export function startOfDayInTimeZone(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = getNewYorkOffsetMinutes(probe);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60000);
}

/**
 * Adds calendar days to a Date (safe across DST because arithmetic is UTC-based).
 */
export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

/**
 * Validates a strict YYYY-MM-DD calendar date string.
 */
export function isValidDateString(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const probe = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(probe.getTime())) return false;
  return probe.toISOString().slice(0, 10) === value;
}

/**
 * Formats an RFC 3339 timestamp as a clock label in America/New_York, e.g. "9:30 AM".
 */
export function formatTimeLabel(startAt) {
  const date = new Date(startAt);
  if (Number.isNaN(date.getTime())) return "";
  const parts = formatParts(date);
  let hour = Number(parts.hour);
  const minute = parts.minute;
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}
