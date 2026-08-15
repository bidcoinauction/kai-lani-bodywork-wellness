import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMode,
  squareEnvironment,
  bookingApprovalMode,
  emailMode,
  isBookingApprovalEnabled,
  activeApprovalMode,
  emailDeliveryMode,
} from "../lib/environment.js";
import {
  getSquareClient,
  resetSquareClientForTests,
  squareEnvironmentForTests,
  normalizeSquareModeForTests,
} from "../lib/square.js";

function clearAll() {
  for (const key of [
    "SQUARE_ENVIRONMENT",
    "BOOKING_APPROVAL_ENABLED",
    "BOOKING_APPROVAL_MODE",
    "EMAIL_ENABLED",
    "EMAIL_MODE",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "EMAIL_SANDBOX_RECIPIENT",
    "CHELSEA_NOTIFICATION_EMAIL",
    "SQUARE_ACCESS_TOKEN",
  ]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearAll();
  resetSquareClientForTests();
});

afterEach(() => {
  clearAll();
  resetSquareClientForTests();
});

function installSandboxSquare() {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
}

function installProductionSquare() {
  process.env.SQUARE_ENVIRONMENT = "production";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.BOOKING_APPROVAL_MODE = "production";
}

test("normalizeMode accepts only exact sandbox or production", () => {
  assert.equal(normalizeMode("sandbox"), "sandbox");
  assert.equal(normalizeMode("production"), "production");
  assert.equal(normalizeMode("Sandbox"), null);
  assert.equal(normalizeMode("PRODUCTION"), null);
  assert.equal(normalizeMode(" staging "), null);
  assert.equal(normalizeMode("prod"), null);
  assert.equal(normalizeMode(""), null);
  assert.equal(normalizeMode(undefined), null);
  assert.equal(normalizeMode(null), null);
});

test("normalizeSquareModeForTests mirrors the client-mode normalization", () => {
  assert.equal(normalizeSquareModeForTests("sandbox"), "sandbox");
  assert.equal(normalizeSquareModeForTests("production"), "production");
  assert.equal(normalizeSquareModeForTests("prod"), null);
  assert.equal(normalizeSquareModeForTests("Production"), null);
});

test("squareEnvironment and bookingApprovalMode read their exact variables", () => {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_MODE = "production";
  assert.equal(squareEnvironment(), "sandbox");
  assert.equal(bookingApprovalMode(), "production");

  process.env.SQUARE_ENVIRONMENT = "unknown";
  assert.equal(squareEnvironment(), null);
});

test("sandbox Square + sandbox approval enables the booking workflow", () => {
  installSandboxSquare();
  assert.equal(isBookingApprovalEnabled(), true);
  assert.equal(activeApprovalMode(), "sandbox");
  assert.equal(squareEnvironmentForTests(), "sandbox");
});

test("production Square + production approval enables the booking workflow", () => {
  installProductionSquare();
  assert.equal(isBookingApprovalEnabled(), true);
  assert.equal(activeApprovalMode(), "production");
  assert.equal(squareEnvironmentForTests(), "production");
});

test("missing mode fails closed", () => {
  delete process.env.SQUARE_ENVIRONMENT;
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
  assert.equal(isBookingApprovalEnabled(), false);
  assert.equal(activeApprovalMode(), null);

  installSandboxSquare();
  delete process.env.BOOKING_APPROVAL_MODE;
  assert.equal(isBookingApprovalEnabled(), false);
  assert.equal(activeApprovalMode(), null);
});

test("unknown mode fails closed", () => {
  installSandboxSquare();
  process.env.BOOKING_APPROVAL_MODE = "staging";
  assert.equal(isBookingApprovalEnabled(), false);

  process.env.BOOKING_APPROVAL_MODE = "sandbox";
  process.env.SQUARE_ENVIRONMENT = "staging";
  assert.equal(isBookingApprovalEnabled(), false);
});

test("mismatched modes fail closed", () => {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_MODE = "production";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  assert.equal(isBookingApprovalEnabled(), false);
});

test("BOOKING_APPROVAL_ENABLED must be exactly true", () => {
  installSandboxSquare();
  process.env.BOOKING_APPROVAL_ENABLED = "1";
  assert.equal(isBookingApprovalEnabled(), false);
  process.env.BOOKING_APPROVAL_ENABLED = "";
  assert.equal(isBookingApprovalEnabled(), false);
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  assert.equal(isBookingApprovalEnabled(), true);
});

test("getSquareClient never constructs a client while the gate fails", () => {
  process.env.SQUARE_ACCESS_TOKEN = "test_token_placeholder";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_MODE = "production";
  assert.throws(() => getSquareClient(), /BOOKING_APPROVAL_MODE/i);

  process.env.BOOKING_APPROVAL_MODE = "sandbox";
  delete process.env.SQUARE_ACCESS_TOKEN;
  assert.throws(() => getSquareClient(), /not configured/i);
});

test("getSquareClient throws before constructing when configuration is missing", () => {
  assert.throws(() => getSquareClient(), /SQUARE_ENVIRONMENT|BOOKING_APPROVAL_MODE/i);
});

test("production never silently defaults to sandbox and vice versa", () => {
  assert.equal(squareEnvironmentForTests(), null);
  process.env.SQUARE_ENVIRONMENT = "production";
  assert.equal(squareEnvironmentForTests(), "production");
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  assert.equal(squareEnvironmentForTests(), "sandbox");
  assert.equal(normalizeSquareModeForTests(undefined), null);
});

test("emailDeliveryMode requires EMAIL_ENABLED and a mode matching the active environment", () => {
  installSandboxSquare();
  process.env.EMAIL_ENABLED = "true";
  process.env.EMAIL_MODE = "sandbox";
  assert.equal(emailDeliveryMode(), "sandbox");

  process.env.EMAIL_MODE = "production";
  assert.equal(emailDeliveryMode(), null);

  installProductionSquare();
  process.env.EMAIL_ENABLED = "true";
  process.env.EMAIL_MODE = "production";
  assert.equal(emailDeliveryMode(), "production");

  process.env.EMAIL_ENABLED = "false";
  assert.equal(emailDeliveryMode(), null);
});

test("emailMode is exact-only", () => {
  process.env.EMAIL_MODE = "sandbox";
  assert.equal(emailMode(), "sandbox");
  process.env.EMAIL_MODE = "Sandbox";
  assert.equal(emailMode(), null);
  delete process.env.EMAIL_MODE;
  assert.equal(emailMode(), null);
});