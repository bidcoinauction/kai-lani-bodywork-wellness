import {
  setSquareClientForTests,
  resetSquareClientForTests,
} from "../lib/square.js";

export { setSquareClientForTests, resetSquareClientForTests };

export function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

/**
 * Builds a minimal request. Pass `body` as a parsed object/string (platform
 * pre-parsed) and/or `rawBody` to simulate a readable stream.
 */
export function makeRequest({ method = "GET", query = {}, body, headers = {}, rawBody, ip } = {}) {
  const chunks = rawBody != null ? [Buffer.from(rawBody, "utf8")] : [];
  let index = 0;
  const forwarded = headers["x-forwarded-for"];
  return {
    method,
    query,
    headers: forwarded ? headers : { ...headers, "x-forwarded-for": ip },
    socket: { remoteAddress: ip || "127.0.0.1" },
    body,
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          index < chunks.length
            ? { value: chunks[index++], done: false }
            : { value: undefined, done: true },
      };
    },
  };
}

export function installFullConfig() {
  process.env.SQUARE_LOCATION_ID = "LOC_SANDBOX";
  process.env.SQUARE_TEAM_MEMBER_ID = "TM_CHELSEA";
  process.env.SQUARE_SERVICE_CUSTOMIZED_60_ID = "VAR_CUSTOMIZED_60";
  process.env.SQUARE_SERVICE_DEEP_TISSUE_60_ID = "VAR_DEEP_TISSUE_60";
  process.env.SQUARE_SERVICE_PRENATAL_60_ID = "VAR_PRENATAL_60";
  process.env.SQUARE_SERVICE_CUSTOMIZED_90_ID = "VAR_CUSTOMIZED_90";
  process.env.SQUARE_SERVICE_DEEP_TISSUE_90_ID = "VAR_DEEP_TISSUE_90";
}

export function clearSquareEnv() {
  for (const key of [
    "SQUARE_LOCATION_ID",
    "SQUARE_TEAM_MEMBER_ID",
    "SQUARE_SERVICE_CUSTOMIZED_60_ID",
    "SQUARE_SERVICE_DEEP_TISSUE_60_ID",
    "SQUARE_SERVICE_PRENATAL_60_ID",
    "SQUARE_SERVICE_CUSTOMIZED_90_ID",
    "SQUARE_SERVICE_DEEP_TISSUE_90_ID",
    "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_NOTIFICATION_URL",
  ]) {
    delete process.env[key];
  }
}

export function makeSquareMock(overrides = {}) {
  if (overrides.bookings || overrides.customers) {
    return {
      bookings: {
        searchAvailability:
          overrides.bookings?.searchAvailability || (async () => ({ availabilities: [] })),
        create:
          overrides.bookings?.create ||
          (async () => ({ booking: { id: "BK_1", status: "ACCEPTED" } })),
      },
      customers: {
        search: overrides.customers?.search || (async () => ({ customers: [] })),
        create:
          overrides.customers?.create || (async () => ({ customer: { id: "CUST_1" } })),
      },
    };
  }
  return {
    bookings: {
      searchAvailability: overrides.searchAvailability || (async () => ({ availabilities: [] })),
      create: overrides.create || (async () => ({ booking: { id: "BK_1", status: "ACCEPTED" } })),
    },
    customers: {
      search: overrides.searchCustomers || (async () => ({ customers: [] })),
      create: overrides.createCustomer || (async () => ({ customer: { id: "CUST_1" } })),
    },
  };
}

export async function withSquareMock(overrides, fn) {
  setSquareClientForTests(makeSquareMock(overrides));
  try {
    return await fn();
  } finally {
    resetSquareClientForTests();
  }
}
