import square from "square";

const { SquareClient, SquareEnvironment, WebhooksHelper } = square;

let client = null;
let testClient = null;

export { WebhooksHelper };

/**
 * Server-only Square client.
 *
 * - Reads the access token strictly from process.env.SQUARE_ACCESS_TOKEN.
 * - Sandbox only during this milestone: throws a safe error unless
 *   SQUARE_ENVIRONMENT is exactly "sandbox".
 * - Never import this module from browser code.
 */
export function getSquareClient() {
  if (testClient) return testClient;
  if (client) return client;

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("Square booking is not configured");
  }
  if (process.env.SQUARE_ENVIRONMENT !== "sandbox") {
    throw new Error("Square booking is enabled only in sandbox");
  }

  client = new SquareClient({
    token: accessToken,
    environment: SquareEnvironment.Sandbox,
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
}
