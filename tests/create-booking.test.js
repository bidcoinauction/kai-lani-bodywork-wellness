import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import createBookingHandler, {
  BOOKING_FLOW_REPLACED,
  createBookingFlow,
  findOrCreateCustomer,
  resetIdempotencyCacheForTests,
} from "../api/square/create-booking.js";
import {
  resetSquareClientForTests,
  setSquareClientForTests,
} from "../lib/square.js";
import {
  addDays,
  addMinutes,
  getNewYorkDateString,
  startOfDayInTimeZone,
} from "../lib/time.js";
import {
  makeRequest,
  makeResponse,
  installFullConfig,
  clearSquareEnv,
  withSquareMock,
} from "./helpers.js";

function clearEmailEnv() {
  for (const key of [
    "EMAIL_ENABLED",
    "EMAIL_MODE",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "EMAIL_SANDBOX_RECIPIENT",
    "CHELSEA_NOTIFICATION_EMAIL",
    "EMAIL_REPLY_TO",
    "PUBLIC_SITE_URL",
  ]) {
    delete process.env[key];
  }
}

function installEmailEnv() {
  process.env.EMAIL_ENABLED = "true";
  process.env.EMAIL_MODE = "sandbox";
  process.env.RESEND_API_KEY = "test_resend_key";
  process.env.EMAIL_FROM = "Kai Lani Sandbox <onboarding@resend.dev>";
  process.env.EMAIL_SANDBOX_RECIPIENT = "sandbox@example.invalid";
  process.env.CHELSEA_NOTIFICATION_EMAIL = "chelsea@example.invalid";
  process.env.EMAIL_REPLY_TO = "reply@example.invalid";
}

beforeEach(() => {
  resetSquareClientForTests();
  resetIdempotencyCacheForTests();
  clearEmailEnv();
  delete globalThis.fetch;
  process.env.SQUARE_ENVIRONMENT = "sandbox";
});

afterEach(() => {
  clearSquareEnv();
  clearEmailEnv();
  resetSquareClientForTests();
  resetIdempotencyCacheForTests();
  delete globalThis.fetch;
});

function slotInDays(days, hour = 14) {
  const start = startOfDayInTimeZone(getNewYorkDateString());
  return addMinutes(addDays(start, days), hour * 60).toISOString();
}

const VALID_BOOKING = {
  serviceKey: "customized_60",
  start: new Date(slotInDays(1)),
  firstName: "Test",
  lastName: "Client",
  email: "test-client@example.invalid",
  phone: "+19805550100",
  idempotencyKey: "idem-test-0001",
};

async function createViaEngine(overrides = {}) {
  return createBookingFlow({ ...VALID_BOOKING, ...overrides });
}

function makeEchoAvailabilityMock(createLog = []) {
  return {
    bookings: {
      searchAvailability: async (request) => ({
        availabilities: [
          {
            startAt: request.query.filter.startAtRange.startAt,
            appointmentSegments: [{ serviceVariationVersion: 1785474196673n }],
          },
        ],
      }),
      create: async (request) => {
        createLog.push(request);
        return {
          booking: {
            id: "BK_123",
            status: "ACCEPTED",
            startAt: request.booking.startAt,
            version: 7,
          },
        };
      },
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async (customer) => {
        return { customer: { id: "CUST_NEW", ...customer } };
      },
    },
  };
}

test("legacy create-booking HTTP handler fails closed and cannot create a booking", async () => {
  const calls = { square: 0, email: 0 };
  setSquareClientForTests({
    bookings: {
      searchAvailability: async () => {
        calls.square += 1;
        return { availabilities: [] };
      },
      create: async () => {
        calls.square += 1;
        return { booking: { id: "should-not-happen" } };
      },
    },
    customers: {
      search: async () => {
        calls.square += 1;
        return { customers: [] };
      },
      create: async () => {
        calls.square += 1;
        return { customer: { id: "should-not-happen" } };
      },
    },
  });
  globalThis.fetch = async () => {
    calls.email += 1;
    return { ok: true };
  };

  for (const method of ["GET", "POST"]) {
    const res = makeResponse();
    await createBookingHandler(makeRequest({ method, body: { anything: true } }), res);
    assert.equal(res.statusCode, 410);
    assert.equal(res.body.error, BOOKING_FLOW_REPLACED);
  }
  assert.equal(calls.square, 0, "public handler must not call Square");
  assert.equal(calls.email, 0, "public handler must not send email");
});

test("internal engine returns 409 when the slot is no longer available at recheck", async () => {
  installFullConfig();
  await assert.rejects(
    withSquareMock({ bookings: { searchAvailability: async () => ({ availabilities: [] }) } }, () =>
      createViaEngine(),
    ),
    { statusCode: 409 },
  );
});

test("internal engine creates a booking and returns only the safe confirmation shape", async () => {
  installFullConfig();
  const createLog = [];
  const result = await withSquareMock(makeEchoAvailabilityMock(createLog), () => createViaEngine());

  assert.deepEqual(Object.keys(result).sort(), [
    "bookingId",
    "customerName",
    "duration",
    "notification",
    "price",
    "serviceName",
    "startAt",
    "status",
  ]);
  assert.equal(result.bookingId, "BK_123");
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.serviceName, "60 Min Customized Massage");
  assert.equal(result.duration, "60");
  assert.equal(result.price, "93");
  assert.equal(result.customerName, "Test Client");
  assert.deepEqual(result.notification, { client: "disabled", provider: "disabled" });
  assert.equal(createLog.length, 1);
  assert.equal(createLog[0].idempotencyKey, "idem-test-0001");
  assert.equal(createLog[0].booking.appointmentSegments[0].serviceVariationId, "VAR_CUSTOMIZED_60");
  assert.equal(createLog[0].booking.appointmentSegments[0].teamMemberId, "TM_CHELSEA");
  assert.equal(createLog[0].booking.appointmentSegments[0].serviceVariationVersion, 1785474196673n);
});

test("internal engine returns a safe error when the availability lacks a variation version", async () => {
  installFullConfig();
  await assert.rejects(
    withSquareMock(
      {
        bookings: {
          searchAvailability: async (request) => ({
            availabilities: [{ startAt: request.query.filter.startAtRange.startAt }],
          }),
        },
      },
      () => createViaEngine(),
    ),
    /service_variation_version_missing/,
  );
});

test("internal engine creates a minimal customer when none matches", async () => {
  installFullConfig();
  const customerCalls = [];
  const createLog = [];
  await withSquareMock(
    {
      ...makeEchoAvailabilityMock(createLog),
      customers: {
        search: async () => ({ customers: [] }),
        create: async (customer) => {
          customerCalls.push(customer);
          return { customer: { id: "CUST_NEW" } };
        },
      },
    },
    () => createViaEngine(),
  );

  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0].givenName, "Test");
  assert.equal(customerCalls[0].familyName, "Client");
  assert.equal(customerCalls[0].emailAddress, "test-client@example.invalid");
  assert.equal(customerCalls[0].phoneNumber, "+19805550100");
  assert.equal(createLog[0].booking.customerId, "CUST_NEW");
});

test("internal customer matching reuses an existing customer found by email", async () => {
  const customerCalls = [];
  const customerId = await findOrCreateCustomer(
    {
      customers: {
        search: async () => ({ customers: [{ id: "CUST_EXISTING" }] }),
        create: async () => {
          customerCalls.push(1);
          return { customer: { id: "CUST_NEW" } };
        },
      },
    },
    VALID_BOOKING,
  );

  assert.equal(customerId, "CUST_EXISTING");
  assert.equal(customerCalls.length, 0);
});

test("internal customer matching reuses an existing customer found by phone", async () => {
  const calls = [];
  const customerId = await findOrCreateCustomer(
    {
      customers: {
        search: async ({ query }) => {
          calls.push(query.filter);
          if (query.filter.phoneNumber) return { customers: [{ id: "CUST_PHONE" }] };
          return { customers: [] };
        },
        create: async () => ({ customer: { id: "CUST_NEW" } }),
      },
    },
    VALID_BOOKING,
  );

  assert.equal(customerId, "CUST_PHONE");
  assert.equal(calls.length, 2);
});

test("internal customer matching creates a customer only after email and phone miss", async () => {
  const calls = { search: 0, create: 0 };
  const customerId = await findOrCreateCustomer(
    {
      customers: {
        search: async () => {
          calls.search += 1;
          return { customers: [] };
        },
        create: async () => {
          calls.create += 1;
          return { customer: { id: "CUST_NEW" } };
        },
      },
    },
    VALID_BOOKING,
  );

  assert.equal(customerId, "CUST_NEW");
  assert.equal(calls.search, 2);
  assert.equal(calls.create, 1);
});

test("internal customer matching fails safely when Square returns no created customer id", async () => {
  await assert.rejects(
    findOrCreateCustomer(
      {
        customers: {
          search: async () => ({ customers: [] }),
          create: async () => ({ customer: {} }),
        },
      },
      VALID_BOOKING,
    ),
    /customer_missing/,
  );
});

test("internal engine passes deterministic idempotency key through to Square", async () => {
  installFullConfig();
  const createLog = [];
  await withSquareMock(makeEchoAvailabilityMock(createLog), () =>
    createViaEngine({ idempotencyKey: "idem-deterministic-01" }),
  );
  assert.equal(createLog.length, 1);
  assert.equal(createLog[0].idempotencyKey, "idem-deterministic-01");
});

test("internal engine normalizes Square errors without leaking raw details", async () => {
  installFullConfig();
  await assert.rejects(
    withSquareMock(
      {
        bookings: {
          searchAvailability: async (request) => ({
            availabilities: [
              {
                startAt: request.query.filter.startAtRange.startAt,
                appointmentSegments: [{ serviceVariationVersion: 1785474196673n }],
              },
            ],
          }),
          create: async () => {
            throw { statusCode: 500, body: { errors: [{ detail: "SERVER_SECRET" }] } };
          },
        },
        customers: {
          search: async () => ({ customers: [] }),
          create: async () => ({ customer: { id: "CUST_NEW" } }),
        },
      },
      () => createViaEngine(),
    ),
    (err) => JSON.stringify(err).includes("SERVER_SECRET"),
  );
});

test("internal engine booking failure sends no email", async () => {
  installFullConfig();
  installEmailEnv();
  let emailCalls = 0;
  globalThis.fetch = async () => {
    emailCalls += 1;
    return { ok: true };
  };

  await assert.rejects(
    withSquareMock(
      {
        bookings: {
          searchAvailability: async (request) => ({
            availabilities: [
              {
                startAt: request.query.filter.startAtRange.startAt,
                appointmentSegments: [{ serviceVariationVersion: 1785474196673n }],
              },
            ],
          }),
          create: async () => {
            throw { statusCode: 500, body: { errors: [{ detail: "fail" }] } };
          },
        },
        customers: {
          search: async () => ({ customers: [] }),
          create: async () => ({ customer: { id: "CUST_NEW" } }),
        },
      },
      () => createViaEngine(),
    ),
  );

  assert.equal(emailCalls, 0);
});

test("internal engine email failure does not change booking success or leak recipients", async () => {
  installFullConfig();
  installEmailEnv();
  globalThis.fetch = async () => ({ ok: false });
  const result = await withSquareMock(makeEchoAvailabilityMock([]), () => createViaEngine());

  assert.equal(result.bookingId, "BK_123");
  assert.deepEqual(result.notification, { client: "failed", provider: "failed" });
  assert.doesNotMatch(
    JSON.stringify(result),
    /sandbox@example\.invalid|reply@example\.invalid|test_resend_key/,
  );
});

test("internal engine preserves Square status fallback when Square omits status", async () => {
  installFullConfig();
  const result = await withSquareMock(
    {
      ...makeEchoAvailabilityMock([]),
      bookings: {
        searchAvailability: async (request) => ({
          availabilities: [
            {
              startAt: request.query.filter.startAtRange.startAt,
              appointmentSegments: [{ serviceVariationVersion: 1785474196673n }],
            },
          ],
        }),
        create: async (request) => ({ booking: { id: "BK_PENDING", startAt: request.booking.startAt } }),
      },
    },
    () => createViaEngine(),
  );

  assert.equal(result.status, "PENDING");
});

test("internal engine surfaces missing booking id safely", async () => {
  installFullConfig();
  await assert.rejects(
    withSquareMock(
      {
        ...makeEchoAvailabilityMock([]),
        bookings: {
          searchAvailability: async (request) => ({
            availabilities: [
              {
                startAt: request.query.filter.startAtRange.startAt,
                appointmentSegments: [{ serviceVariationVersion: 1785474196673n }],
              },
            ],
          }),
          create: async () => ({ booking: {} }),
        },
      },
      () => createViaEngine(),
    ),
    /booking_missing/,
  );
});
