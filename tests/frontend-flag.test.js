import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bookingRequestsEnabled,
  legacySandboxFlagPresent,
} from "../src/lib/booking-flag.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test("VITE_ENABLE_BOOKING_REQUESTS=true enables the request flow", () => {
  assert.equal(
    bookingRequestsEnabled({ VITE_ENABLE_BOOKING_REQUESTS: "true" }),
    true,
  );
});

test("false or missing VITE_ENABLE_BOOKING_REQUESTS disables the request flow", () => {
  assert.equal(
    bookingRequestsEnabled({ VITE_ENABLE_BOOKING_REQUESTS: "false" }),
    false,
  );
  assert.equal(
    bookingRequestsEnabled({ VITE_ENABLE_BOOKING_REQUESTS: "TRUE" }),
    false,
  );
  assert.equal(
    bookingRequestsEnabled({ VITE_ENABLE_BOOKING_REQUESTS: "1" }),
    false,
  );
  assert.equal(bookingRequestsEnabled({}), false);
  assert.equal(bookingRequestsEnabled(), false);
});

test("the legacy VITE_ENABLE_SQUARE_SANDBOX flag is ignored", () => {
  assert.equal(
    bookingRequestsEnabled({ VITE_ENABLE_SQUARE_SANDBOX: "true" }),
    false,
  );
  assert.equal(
    bookingRequestsEnabled({
      VITE_ENABLE_SQUARE_SANDBOX: "true",
      VITE_ENABLE_BOOKING_REQUESTS: "true",
    }),
    true,
  );
  assert.equal(legacySandboxFlagPresent({ VITE_ENABLE_SQUARE_SANDBOX: "true" }), true);
  assert.equal(legacySandboxFlagPresent({ VITE_ENABLE_BOOKING_REQUESTS: "true" }), false);
});

test("Booking renders the request flow only when the flag is enabled", () => {
  const source = fs.readFileSync(path.join(SRC_ROOT, "components", "Booking.jsx"), "utf8");

  assert.match(source, /bookingRequestsEnabled\(import\.meta\.env\)/);
  assert.doesNotMatch(source, /VITE_ENABLE_SQUARE_SANDBOX/);
  assert.match(source, /\? \(\s*<div data-reveal>\s*<SquareBooking \/>/);
  assert.doesNotMatch(source, /VITE_ENABLE_SQUARE_SANDBOX/);
});

test("rendered booking UI source contains no Sandbox or test-bookings wording", () => {
  const componentsDir = path.join(SRC_ROOT, "components");
  const targets = [
    path.join(componentsDir, "Booking.jsx"),
    path.join(componentsDir, "calendar", "SquareBooking.jsx"),
  ];
  for (const file of targets) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /Sandbox preview|test bookings|Square Sandbox for testing|test appointment|VITE_ENABLE_SQUARE_SANDBOX/,
      `${file} must not contain Sandbox/test-bookings UI wording`,
    );
  }
});