import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSquarePhoneE164 } from "../lib/booking-requests.js";

test("formatSquarePhoneE164 converts a 10-digit NANP number to E.164", () => {
  assert.equal(formatSquarePhoneE164("2025550147"), "+12025550147");
});

test("formatSquarePhoneE164 converts a formatted (202) 555-0147 input to E.164", () => {
  assert.equal(formatSquarePhoneE164("(202) 555-0147"), "+12025550147");
});

test("formatSquarePhoneE164 converts an 11-digit national NANP number to E.164", () => {
  assert.equal(formatSquarePhoneE164("12025550147"), "+12025550147");
});

test("formatSquarePhoneE164 preserves an already canonical +1XXXXXXXXXX number", () => {
  assert.equal(formatSquarePhoneE164("+12025550147"), "+12025550147");
});

test("formatSquarePhoneE164 returns null for non-NANP phone numbers", () => {
  assert.equal(formatSquarePhoneE164("+442071838750"), null);
  assert.equal(formatSquarePhoneE164("800555"), null);
  assert.equal(formatSquarePhoneE164("+15551234"), null);
  assert.equal(formatSquarePhoneE164("112345"), null);
  assert.equal(formatSquarePhoneE164(""), null);
  assert.equal(formatSquarePhoneE164(null), null);
  assert.equal(formatSquarePhoneE164(undefined), null);
});

test("formatSquarePhoneE164 rejects numbers whose NANP area/exchange code is invalid", () => {
  assert.equal(formatSquarePhoneE164("15550147"), null);
  assert.equal(formatSquarePhoneE164("11111111111"), null);
});

test("formatSquarePhoneE164 never returns the raw digits without the leading plus", () => {
  const out = formatSquarePhoneE164("2025550147");
  assert.equal(out.startsWith("+"), true);
  assert.equal(out, "+12025550147");
});