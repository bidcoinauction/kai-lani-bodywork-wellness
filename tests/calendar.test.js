import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleCalendarUrl,
  buildIcsCalendar,
  buildIcsAttachment,
  CalendarError,
  calendarTestInternals,
} from "../lib/calendar.js";

const FIXED_NOW = new Date("2026-08-05T17:00:00.000Z");

const BOOKING = {
  bookingId: "BK_123456",
  serviceName: "60 Min Customized Massage",
  duration: "60",
  startAt: "2026-08-05T18:00:00.000Z",
};

function icsLines(ics) {
  return ics.split("\r\n");
}

// Unfolds RFC 5545 continuation lines (CRLF + space) for content assertions.
function unfold(ics) {
  return ics.replace(/\r\n /g, "");
}

test("Google URL uses the render base with action=TEMPLATE", () => {
  const url = buildGoogleCalendarUrl(BOOKING);

  assert.ok(url.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE&"));
  assert.match(url, /^https:\/\/calendar\.google\.com\//);
  assert.ok(url.includes("action=TEMPLATE"));
});

test("Google URL includes the expected event title with an em dash", () => {
  const url = buildGoogleCalendarUrl(BOOKING);

  assert.ok(
    url.includes("text=Kai%20Lani%20Bodywork%20%26%20Wellness%20%E2%80%94%2060%20Min%20Customized%20Massage"),
  );
});

test("Google URL URL-encodes values", () => {
  const url = buildGoogleCalendarUrl(BOOKING);

  assert.ok(url.includes("%26"));
  assert.ok(url.includes("%0A"));
  assert.ok(url.includes("%E2%80%94"));
  assert.ok(url.includes("%2C"));
  assert.ok(url.includes("location=106%20S%20Main%20St%2C%20Suite%20F%2C%20Mount%20Holly%2C%20NC%2028120"));
  assert.ok(url.includes("(980)%20224-2462"));
  assert.ok(!url.includes("?action=TEMPLATE&action="));
});

test("Google URL uses the literal dates slash and UTC timestamps", () => {
  const url = buildGoogleCalendarUrl(BOOKING);

  assert.ok(url.includes("dates=20260805T180000Z/20260805T190000Z"));
  assert.doesNotMatch(url, /dates=[^&]*%2F/);
});

test("60-minute appointment ends one hour after start (Google and ICS)", () => {
  const url = buildGoogleCalendarUrl(BOOKING);
  const ics = buildIcsCalendar(BOOKING, { now: FIXED_NOW });

  assert.ok(url.includes("dates=20260805T180000Z/20260805T190000Z"));
  assert.match(ics, /DTSTART:20260805T180000Z/);
  assert.match(ics, /DTEND:20260805T190000Z/);
});

test("90-minute appointment ends 90 minutes after start (Google and ICS)", () => {
  const ninety = { ...BOOKING, serviceName: "90 Min Customized Massage", duration: "90" };
  const url = buildGoogleCalendarUrl(ninety);
  const ics = buildIcsCalendar(ninety, { now: FIXED_NOW });

  assert.ok(url.includes("dates=20260805T180000Z/20260805T193000Z"));
  assert.match(ics, /DTSTART:20260805T180000Z/);
  assert.match(ics, /DTEND:20260805T193000Z/);
});

test("daylight-saving spring-forward keeps the correct wall-clock duration", () => {
  // 2026-03-08T07:00Z is 2:00 AM EST; a 90-minute session ends at 3:30 AM EDT.
  const booking = {
    ...BOOKING,
    startAt: "2026-03-08T07:00:00.000Z",
    duration: "90",
  };

  const url = buildGoogleCalendarUrl(booking);
  const ics = buildIcsCalendar(booking, { now: FIXED_NOW });

  assert.ok(url.includes("dates=20260308T070000Z/20260308T083000Z"));
  assert.match(ics, /DTSTART:20260308T070000Z/);
  assert.match(ics, /DTEND:20260308T083000Z/);
});

test("daylight-saving fall-back keeps the correct wall-clock duration", () => {
  // 2026-11-01T06:00Z is 2:00 AM EDT; a 60-minute session ends at 3:00 AM EST.
  const booking = {
    ...BOOKING,
    startAt: "2026-11-01T06:00:00.000Z",
    duration: "60",
  };

  const url = buildGoogleCalendarUrl(booking);
  const ics = buildIcsCalendar(booking, { now: FIXED_NOW });

  assert.ok(url.includes("dates=20261101T060000Z/20261101T070000Z"));
  assert.match(ics, /DTSTART:20261101T060000Z/);
  assert.match(ics, /DTEND:20261101T070000Z/);
});

test("UTC date formatting matches YYYYMMDDTHHMMSSZ", () => {
  assert.equal(
    calendarTestInternals.toIcsDateTime(new Date("2026-08-05T18:00:00.000Z")),
    "20260805T180000Z",
  );
  assert.equal(
    calendarTestInternals.toIcsDateTime(new Date("2026-01-01T00:00:00.000Z")),
    "20260101T000000Z",
  );
});

test("ICS UID is deterministic and derived from the booking ID", () => {
  const first = buildIcsCalendar(BOOKING, { now: FIXED_NOW });
  const second = buildIcsCalendar(BOOKING, { now: FIXED_NOW });
  const other = buildIcsCalendar(
    { ...BOOKING, bookingId: "BK_999999" },
    { now: FIXED_NOW },
  );

  assert.match(first, /UID:kai-lani-BK_123456@kai-lani-bodywork-wellness\.com/);
  assert.equal(first, second);
  assert.notEqual(
    calendarTestInternals.buildUid("BK_123456"),
    calendarTestInternals.buildUid("BK_999999"),
  );
  assert.match(other, /UID:kai-lani-BK_999999@kai-lani-bodywork-wellness\.com/);
});

test("ICS uses CRLF line endings only", () => {
  const ics = buildIcsCalendar(BOOKING, { now: FIXED_NOW });

  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("\r\n"));
  assert.doesNotMatch(ics, /[^\r]\n/);
});

test("ICS contains all required RFC 5545 structural lines", () => {
  const lines = icsLines(buildIcsCalendar(BOOKING, { now: FIXED_NOW }));

  for (const line of [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ]) {
    assert.ok(lines.includes(line), `missing line: ${line}`);
  }
  assert.equal(lines[lines.length - 2], "END:VCALENDAR");
  assert.equal(lines[lines.length - 1], "");
  assert.match(lines.join("\n"), /PRODID:-?\/\/Kai Lani Bodywork & Wellness\/\/Appointments\/\/EN/);
  assert.match(lines.join("\n"), /DTSTAMP:\d{8}T\d{6}Z/);
});

test("ICS escapes backslashes, commas, semicolons and newlines", () => {
  const booking = {
    ...BOOKING,
    serviceName: "60 Min Customized Massage, Deluxe; Premium \\ Special",
  };
  const ics = buildIcsCalendar(booking, { now: FIXED_NOW });
  const unfolded = unfold(ics);

  assert.match(
    unfolded,
    /SUMMARY:Kai Lani Bodywork & Wellness \u2014 60 Min Customized Massage\\, Deluxe\\; Premium \\\\ Special/,
  );
  assert.match(ics, /LOCATION:106 S Main St\\, Suite F\\, Mount Holly\\, NC 28120/);
  assert.match(unfolded, /Booking reference: BK_123456\\n/);

  assert.equal(
    calendarTestInternals.escapeIcsText("a,b;c\\d\ne"),
    "a\\,b\\;c\\\\d\\ne",
  );
});

test("ICS description includes confirmed wording, reference, phone, and instructions", () => {
  const unfolded = unfold(buildIcsCalendar(BOOKING, { now: FIXED_NOW }));

  assert.match(unfolded, /Confirmed appointment: Kai Lani Bodywork & Wellness/);
  assert.match(unfolded, /Booking reference: BK_123456/);
  assert.match(unfolded, /Phone: \(980\) 224-2462/);
  assert.match(unfolded, /106 S Main St\\, Suite F\\, Mount Holly\\, NC 28120/);
  assert.match(unfolded, /behind Bolton's Curbside Cookery/);
  assert.match(unfolded, /narrow drive beside Uptown Salon/);
  assert.match(unfolded, /black metal staircase/);
  assert.match(unfolded, /ground-level door just beyond the staircase/);
  assert.match(unfolded, /Do not go up the stairs/);
  assert.match(unfolded, /Date and time: Wednesday\\, August 5\\, 2026 at 2:00 PM EDT/);
});

test("appointment requires bookingId, serviceName, startAt, and 60/90 duration", () => {
  const cases = [
    { ...BOOKING, bookingId: "" },
    { ...BOOKING, bookingId: undefined },
    { ...BOOKING, serviceName: "" },
    { ...BOOKING, serviceName: undefined },
    { ...BOOKING, startAt: undefined },
    { ...BOOKING, startAt: "not-a-date" },
    { ...BOOKING, duration: "45" },
    { ...BOOKING, duration: 120 },
    { ...BOOKING, duration: "60 min" },
  ];

  for (const booking of cases) {
    assert.throws(
      () => buildGoogleCalendarUrl(booking),
      (error) => error instanceof CalendarError,
    );
    assert.throws(
      () => buildIcsCalendar(booking, { now: FIXED_NOW }),
      (error) => error instanceof CalendarError,
    );
  }
});

test("invalid appointment shapes are rejected", () => {
  for (const value of [null, undefined, "BK_123456", 42, [], [BOOKING]]) {
    assert.throws(
      () => buildGoogleCalendarUrl(value),
      (error) => error instanceof CalendarError,
    );
  }
});

test("no client medical information, private notes, or sensitive data leak into output", () => {
  const withSensitive = {
    ...BOOKING,
    firstName: "Ava",
    lastName: "Client",
    email: "customer@example.invalid",
    phone: "+19805550100",
    customerName: "Ava Client",
    notes: "medical condition details",
    rawSquareData: "SECRET_RAW_SQUARE",
  };

  const url = buildGoogleCalendarUrl(withSensitive);
  const ics = buildIcsCalendar(withSensitive, { now: FIXED_NOW });
  const unfolded = unfold(ics);

  for (const output of [url, unfolded]) {
    assert.doesNotMatch(output, /Ava/);
    assert.doesNotMatch(output, /customer@example/i);
    assert.doesNotMatch(output, /980555/);
    assert.doesNotMatch(output, /medical/);
    assert.doesNotMatch(output, /SECRET/i);
  }
  assert.match(url, /\(980\)%20224-2462/);
  assert.match(unfolded, /Phone: \(980\) 224-2462/);
});

test("base64 attachment has the exact filename and decodes back to the ICS", () => {
  const attachment = buildIcsAttachment(BOOKING, { now: FIXED_NOW });

  assert.equal(attachment.filename, "kai-lani-appointment.ics");
  assert.equal(typeof attachment.content, "string");
  assert.match(attachment.content, /^[A-Za-z0-9+/]+={0,2}$/);

  const decoded = Buffer.from(attachment.content, "base64").toString("utf8");
  assert.equal(decoded, buildIcsCalendar(BOOKING, { now: FIXED_NOW }));
  assert.ok(decoded.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(decoded.endsWith("END:VCALENDAR\r\n"));
});

test("invalid now in buildIcsCalendar is rejected", () => {
  assert.throws(
    () => buildIcsCalendar(BOOKING, { now: "not-a-date" }),
    (error) => error instanceof CalendarError,
  );
});
