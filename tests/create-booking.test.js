import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import createBookingHandler, {
  resetIdempotencyCacheForTests,
} from "../api/square/create-booking.js";
import { resetSquareClientForTests } from "../lib/square.js";
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
  setSquareClientForTests,
} from "./helpers.js";

beforeEach(() => {
  resetSquareClientForTests();
  resetIdempotencyCacheForTests();
});

afterEach(() => {
  clearSquareEnv();
  resetSquareClientForTests();
  resetIdempotencyCacheForTests();
});

let requestCounter = 0;
function freshIp() {
  requestCounter += 1;
  return `test-${requestCounter}`;
}

function slotInDays(days, hour = 14) {
  const start = startOfDayInTimeZone(getNewYorkDateString());
  return addMinutes(addDays(start, days), hour * 60).toISOString();
}

const VALID_BODY = {
  serviceKey: "customized_60",
  startAt: slotInDays(1),
  firstName: "Test",
  lastName: "Client",
  email: "test-client@example.invalid",
  phone: "(980) 555-0100",
  idempotencyKey: "idem-test-0001",
};

async function run(body, overrides, { ip } = {}) {
  const res = makeResponse();
  const req = makeRequest({
    method: "POST",
    body,
    ip: ip || freshIp(),
  });
  await createBookingHandler(req, res);
  return res;
}

function makeEchoAvailabilityMock(createLog) {
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

function makeIdempotencyMock(log, { delayMs = 0 } = {}) {
  const delay =
    (fn) =>
    async (...args) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fn(...args);
    };
  return {
    bookings: {
      searchAvailability: delay(async (request) => {
        log.searchAvailability += 1;
        return {
          availabilities: [
            {
              startAt: request.query.filter.startAtRange.startAt,
              appointmentSegments: [{ serviceVariationVersion: 1785474196673n }],
            },
          ],
        };
      }),
      create: delay(async (request) => {
        log.create += 1;
        return {
          booking: { id: "BK_123", status: "ACCEPTED", startAt: request.booking.startAt },
        };
      }),
    },
    customers: {
      search: delay(async () => {
        log.customerSearch += 1;
        return { customers: [] };
      }),
      create: delay(async (customer) => {
        log.customerCreate += 1;
        return { customer: { id: "CUST_NEW", ...customer } };
      }),
    },
  };
}

test("rejects non-POST methods with 405", async () => {
  const res = makeResponse();
  await createBookingHandler(makeRequest({ method: "GET", body: VALID_BODY }), res);
  assert.equal(res.statusCode, 405);
});

test("rejects missing required fields", async () => {
  const requiredFields = [
    "serviceKey",
    "startAt",
    "firstName",
    "lastName",
    "email",
    "phone",
    "idempotencyKey",
  ];
  for (const field of requiredFields) {
    const body = { ...VALID_BODY, [field]: undefined };
    const res = await run(body, {});
    assert.equal(res.statusCode, 400, `${field} should be required`);
    assert.equal(typeof res.body.error, "string");
  }
});

test("rejects an unknown service key", async () => {
  const res = await run({ ...VALID_BODY, serviceKey: "customized-60" }, {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Unknown service");
});

test("rejects invalid emails", async () => {
  for (const email of ["not-an-email", "a@b", "a b@c.com", "@x.com", ""]) {
    const res = await run({ ...VALID_BODY, email }, {});
    assert.equal(res.statusCode, 400, `email ${email} should be rejected`);
  }
});

test("rejects invalid phone numbers", async () => {
  for (const phone of [
    "123",
    "abcdefghij",
    "98055501001",
    "(980) 555-0100 x2",
    "000-111-2222",
    "(000) 555-0123",
    "+1 (000) 111-2222",
  ]) {
    const res = await run({ ...VALID_BODY, phone }, {});
    assert.equal(res.statusCode, 400, `phone ${phone} should be rejected`);
    assert.equal(res.body.error, "A valid phone number is required");
  }
});

test("normalizes a valid NANP phone before sending to Square", async () => {
  installFullConfig();
  const customerCalls = [];
  const res = await withSquareMock(
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
        create: async (request) => ({
          booking: { id: "BK_1", status: "ACCEPTED", startAt: request.booking.startAt },
        }),
      },
      customers: {
        search: async () => ({ customers: [] }),
        create: async (customer) => {
          customerCalls.push(customer);
          return { customer: { id: "CUST_NEW" } };
        },
      },
    },
    () => run({ ...VALID_BODY, phone: "202-555-0111" }, {}),
  );

  assert.equal(res.statusCode, 201);
  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0].phoneNumber, "+12025550111");
});

test("rejects names that are too long or empty", async () => {
  const tooLong = "A".repeat(101);
  const emptyName = await run({ ...VALID_BODY, firstName: "   " }, {});
  assert.equal(emptyName.statusCode, 400);
  const longName = await run({ ...VALID_BODY, lastName: tooLong }, {});
  assert.equal(longName.statusCode, 400);
});

test("rejects invalid idempotency keys", async () => {
  for (const key of ["short", "spaces not allowed", "key-with-invalid-#hash"]) {
    const res = await run({ ...VALID_BODY, idempotencyKey: key }, {});
    assert.equal(res.statusCode, 400, `idempotencyKey ${key} should be rejected`);
  }
});

test("rejects a start time in the past", async () => {
  const res = await run(
    { ...VALID_BODY, startAt: new Date(Date.now() - 60000).toISOString() },
    {},
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /past/i);
});

test("rejects a start time outside the 14-day window", async () => {
  const res = await run({ ...VALID_BODY, startAt: slotInDays(15) }, {});
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /booking window/i);
});

test("returns a safe 500 when configuration is missing", async () => {
  clearSquareEnv();
  const res = await run(VALID_BODY, {});
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /SQUARE_LOCATION_ID|SQUARE_TEAM_MEMBER_ID|SQUARE_SERVICE_CUSTOMIZED_60_ID/);
});

test("returns 409 when the slot is no longer available at recheck", async () => {
  installFullConfig();
  const res = await withSquareMock(
    {
      searchAvailability: async () => ({ availabilities: [] }),
    },
    () => run(VALID_BODY, {}),
  );
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /no longer available/i);
});

test("creates a booking and returns only the safe confirmation shape", async () => {
  installFullConfig();
  const createLog = [];
  const res = await withSquareMock(makeEchoAvailabilityMock(createLog), () =>
    run(VALID_BODY, {}),
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(Object.keys(res.body).sort(), [
    "bookingId",
    "customerName",
    "duration",
    "serviceName",
    "startAt",
    "status",
  ]);
  assert.equal(res.body.bookingId, "BK_123");
  assert.equal(res.body.status, "ACCEPTED");
  assert.equal(res.body.serviceName, "60 Min Customized Massage");
  assert.equal(res.body.duration, "60");
  assert.equal(res.body.customerName, "Test Client");
  assert.equal(createLog.length, 1);
  assert.equal(createLog[0].idempotencyKey, "idem-test-0001");
  assert.equal(createLog[0].booking.appointmentSegments[0].serviceVariationId, "VAR_CUSTOMIZED_60");
  assert.equal(createLog[0].booking.appointmentSegments[0].teamMemberId, "TM_CHELSEA");
  assert.equal(createLog[0].booking.appointmentSegments[0].serviceVariationVersion, 1785474196673n);
});

test("returns a safe 500 when the availability lacks a variation version", async () => {
  installFullConfig();
  const res = await withSquareMock(
    {
      searchAvailability: async (request) => ({
        availabilities: [{ startAt: request.query.filter.startAtRange.startAt }],
      }),
    },
    () => run(VALID_BODY, {}),
  );
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, "string");
});

test("creates a minimal customer when none matches", async () => {
  installFullConfig();
  const customerCalls = [];
  const createLog = [];
  const res = await withSquareMock(
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
        create: async (request) => {
          createLog.push(request);
          return { booking: { id: "BK_1", status: "ACCEPTED", startAt: request.booking.startAt } };
        },
      },
      customers: {
        search: async () => ({ customers: [] }),
        create: async (customer) => {
          customerCalls.push(customer);
          return { customer: { id: "CUST_NEW" } };
        },
      },
    },
    () => run(VALID_BODY, {}),
  );

  assert.equal(res.statusCode, 201);
  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0].givenName, "Test");
  assert.equal(customerCalls[0].familyName, "Client");
  assert.equal(customerCalls[0].emailAddress, "test-client@example.invalid");
  assert.equal(customerCalls[0].phoneNumber, "+19805550100");
  assert.equal(createLog[0].booking.customerId, "CUST_NEW");
});

test("reuses an existing customer found by email", async () => {
  installFullConfig();
  const customerCalls = [];
  const res = await withSquareMock(
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
        create: async (request) => ({
          booking: { id: "BK_1", status: "ACCEPTED", startAt: request.booking.startAt },
        }),
      },
      customers: {
        search: async () => ({ customers: [{ id: "CUST_EXISTING" }] }),
        create: async () => {
          customerCalls.push(1);
          return { customer: { id: "CUST_NEW" } };
        },
      },
    },
    () => run(VALID_BODY, {}),
  );

  assert.equal(res.statusCode, 201);
  assert.equal(customerCalls.length, 0);
});

test("idempotent retry returns the original safe response without a second booking", async () => {
  installFullConfig();
  const log = { searchAvailability: 0, create: 0, customerSearch: 0, customerCreate: 0 };
  const mock = makeIdempotencyMock(log);

  const first = await withSquareMock(mock, () => run(VALID_BODY, {}));
  const second = await withSquareMock(mock, () => run(VALID_BODY, {}));

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.body.bookingId, "BK_123");
  assert.equal(log.create, 1, "Square bookings.create must run exactly once");
  assert.equal(log.customerCreate, 1, "Square customers.create must run exactly once");
  assert.equal(log.customerSearch, 2, "one flow runs one email + one phone search");
  assert.equal(log.searchAvailability, 1, "availability recheck must not run on replay");
});

test("rejects reusing the same idempotency key with a different payload", async () => {
  installFullConfig();
  const log = { searchAvailability: 0, create: 0, customerSearch: 0, customerCreate: 0 };
  const mock = makeIdempotencyMock(log);

  const first = await withSquareMock(mock, () => run(VALID_BODY, {}));
  assert.equal(first.statusCode, 201);

  const variants = [
    { ...VALID_BODY, serviceKey: "deep_tissue_60" },
    { ...VALID_BODY, startAt: slotInDays(2) },
    { ...VALID_BODY, email: "other-client@example.invalid" },
    { ...VALID_BODY, firstName: "Different" },
    { ...VALID_BODY, phone: "(212) 555-0143" },
  ];
  for (const variant of variants) {
    const res = await withSquareMock(mock, () => run(variant, {}));
    assert.equal(res.statusCode, 409, `variant should be rejected: ${JSON.stringify(variant)}`);
    assert.match(res.body.error, /idempotency key/i);
  }
  assert.equal(log.create, 1, "no additional booking may be created");
  assert.equal(log.customerCreate, 1, "no additional customer may be created");
});

test("a genuinely new request for an occupied slot still returns 409", async () => {
  installFullConfig();
  const res = await withSquareMock(
    {
      searchAvailability: async () => ({ availabilities: [] }),
    },
    () => run({ ...VALID_BODY, idempotencyKey: "idem-fresh-occupied-01" }, {}),
  );
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /no longer available/i);
});

test("does not cache failed requests; a later retry re-attempts and succeeds", async () => {
  installFullConfig();
  const log = { searchAvailability: 0, create: 0, customerSearch: 0, customerCreate: 0 };
  const mock = makeIdempotencyMock(log);
  let createCalls = 0;
  mock.bookings.create = async (request) => {
    createCalls += 1;
    if (createCalls === 1) {
      throw { statusCode: 500, body: { errors: [{ detail: "flaky" }] } };
    }
    return { booking: { id: "BK_123", status: "ACCEPTED", startAt: request.booking.startAt } };
  };

  const first = await withSquareMock(mock, () => run(VALID_BODY, {}));
  assert.equal(first.statusCode, 500);

  const second = await withSquareMock(mock, () => run(VALID_BODY, {}));
  assert.equal(second.statusCode, 201);
  assert.equal(second.body.bookingId, "BK_123");
  assert.equal(createCalls, 2, "a failed request must not be treated as completed");
});

test("concurrent identical retries share one booking and customer", async () => {
  installFullConfig();
  const log = { searchAvailability: 0, create: 0, customerSearch: 0, customerCreate: 0 };
  setSquareClientForTests(makeIdempotencyMock(log, { delayMs: 5 }));
  try {
    const [r1, r2] = await Promise.all([run(VALID_BODY, {}), run(VALID_BODY, {})]);
    assert.equal(r1.statusCode, 201);
    assert.equal(r2.statusCode, 201);
    assert.equal(r1.body.bookingId, r2.body.bookingId);
    assert.equal(log.create, 1, "only one Square booking may be created");
    assert.equal(log.customerCreate, 1, "only one Square customer may be created");
    assert.equal(log.searchAvailability, 1, "availability recheck must run once");
  } finally {
    resetSquareClientForTests();
  }
});

test("normalizes Square errors without leaking raw details", async () => {
  installFullConfig();
  for (const thrown of [
    { statusCode: 409, body: { errors: [{ detail: "CONFLICT_SECRET" }] } },
    { statusCode: 400, body: { errors: [{ detail: "BAD_REQUEST_SECRET" }] } },
    { statusCode: 500, body: { errors: [{ detail: "SERVER_SECRET" }] } },
    new Error("raw network secret"),
  ]) {
    const res = await withSquareMock(
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
            throw thrown;
          },
        },
        customers: {
          search: async () => ({ customers: [] }),
          create: async () => ({ customer: { id: "CUST_NEW" } }),
        },
      },
      () => run(VALID_BODY, {}),
    );
    assert.equal(res.statusCode, thrown?.statusCode && thrown.statusCode < 500 ? thrown.statusCode : 500);
    assert.equal(typeof res.body.error, "string");
    assert.doesNotMatch(JSON.stringify(res.body), /SECRET|raw network/i);
  }
});

test("returns 413 for an oversized request body", async () => {
  installFullConfig();
  const bigPayload = JSON.stringify({ ...VALID_BODY, firstName: "A".repeat(40 * 1024) });
  const res = makeResponse();
  await createBookingHandler(
    makeRequest({ method: "POST", body: undefined, rawBody: bigPayload, ip: freshIp() }),
    res,
  );
  assert.equal(res.statusCode, 413);
});

test("rejects malformed JSON", async () => {
  installFullConfig();
  const res = makeResponse();
  await createBookingHandler(
    makeRequest({ method: "POST", body: undefined, rawBody: "{not json", ip: freshIp() }),
    res,
  );
  assert.equal(res.statusCode, 400);
});

test("rate limiter rejects requests beyond the window (sandbox-only)", async () => {
  const ip = "ratelimit-test";
  installFullConfig();
  setSquareClientForTests(makeEchoAvailabilityMock([]));
  let lastStatus;
  for (let i = 0; i < 11; i += 1) {
    const res = makeResponse();
    await createBookingHandler(
      makeRequest({ method: "POST", body: VALID_BODY, ip }),
      res,
    );
    lastStatus = res.statusCode;
  }
  assert.equal(lastStatus, 429);
});
