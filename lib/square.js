import square from "square";
import {
  isBookingApprovalEnabled,
  squareEnvironment,
  normalizeMode,
} from "./environment.js";

const { SquareClient, SquareEnvironment, WebhooksHelper } = square;

let client = null;
let testClient = null;

export { WebhooksHelper };

/**
 * Server-only Square client.
 *
 * - Reads the access token strictly from process.env.SQUARE_ACCESS_TOKEN.
 * - Explicit modes only: SQUARE_ENVIRONMENT must be exactly "sandbox" or
 *   "production", and BOOKING_APPROVAL_MODE must exactly match it with
 *   BOOKING_APPROVAL_ENABLED=true (see isBookingApprovalEnabled).
 * - Every missing/malformed/mismatched combination throws and NEVER constructs
 *   a network client. Production is never defaulted to.
 * - The SDK is configured with the matching official Sandbox or Production
 *   environment.
 * - Never import this module from browser code.
 */
export function getSquareClient() {
  if (testClient) return testClient;
  if (client) return client;

  if (!isBookingApprovalEnabled()) {
    throw new Error(
      "Square booking requires SQUARE_ENVIRONMENT and BOOKING_APPROVAL_MODE to match, with BOOKING_APPROVAL_ENABLED=true",
    );
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("Square booking is not configured");
  }

  const mode = squareEnvironment();
  const sdkEnvironment =
    mode === "sandbox" ? SquareEnvironment.Sandbox : SquareEnvironment.Production;

  client = new SquareClient({
    token: accessToken,
    environment: sdkEnvironment,
  });
  return client;
}

/**
 * Test-only seam. Injects a mock client so unit tests never hit the Square API.
 * Must never be called from production code.
 */
export function setSquareClientForTests(mockClient) {
  testClient = mockClient;
}

/**
 * Test-only cleanup. Clears the injected mock client.
 */
export function resetSquareClientForTests() {
  testClient = null;
  client = null;
}

/**
 * Test-only introspection of the exact mode normalization used by the client.
 * Pure, no network. Exported only so gate tests can assert the fail-closed
 * matrix without constructing a real client.
 */
export function squareEnvironmentForTests() {
  return squareEnvironment();
}

export function normalizeSquareModeForTests(value) {
  return normalizeMode(value);
}
