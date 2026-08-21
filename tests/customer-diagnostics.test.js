import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrCreateCustomer, safeSquareCustomerError } from "../api/square/booking-requests/approve.js";
import { buildCustomerIdempotencyKey } from "../lib/booking-requests.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_KEY = "public-request-safe-123456";
const CONTACT = {
  requestId: REQUEST_ID,
  requestKey: REQUEST_KEY,
  firstName: "Taylor",
  lastName: "Example",
  email: "taylor@example.invalid",
  phone: "(202) 555-0147",
};

async function captureCustomerLogs(fn) {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.map((arg) => String(arg)).join(" "));
  try {
    const result = await fn(logs);
    return { result, logs };
  } finally {
    console.info = originalInfo;
  }
}

function squareError({ statusCode = 400, category = "INVALID_REQUEST_ERROR", code = "BAD_REQUEST", field = "email_address" } = {}) {
  return {
    statusCode,
    errors: [
      {
        category,
        code,
        field,
        detail: "unsafe detail taylor@example.invalid +12025550147 SENSITIVE_MARKER CUST_ABC",
      },
    ],
    message: "unsafe message Taylor Example request body response body",
    body: { unsafe: "taylor@example.invalid" },
    rawResponse: { unsafe: "raw" },
  };
}

function makeClient({ search, create } = {}) {
  return {
    customers: {
      search: search || (async () => ({ customers: [] })),
      create: create || (async () => ({ customer: { id: "CUST_CREATED" } })),
    },
  };
}

function joined(logs) {
  return logs.join("\n");
}

test("customer diagnostics report email-search failures safely", async () => {
  const error = squareError({ statusCode: 401, code: "UNAUTHORIZED", field: "email_address" });
  const client = makeClient({ search: async () => { throw error; } });

  await assert.rejects(
    captureCustomerLogs(() => findOrCreateCustomer(client, CONTACT)),
    error,
  );

  const { logs } = await captureCustomerLogs(async () => {
    await assert.rejects(findOrCreateCustomer(client, CONTACT), error);
  });
  const output = joined(logs);
  assert.match(output, /stage=customer_email_search_started/);
  assert.match(output, /stage=customer_email_search_failed/);
  assert.match(output, /bookingSuffix=123456/);
  assert.match(output, /classification=provider_rejected/);
  assert.match(output, /httpStatus=401/);
  assert.match(output, /category=INVALID_REQUEST_ERROR/);
  assert.match(output, /code=UNAUTHORIZED/);
  assert.match(output, /field=email_address/);
  assert.doesNotMatch(output, /Taylor|Example|taylor@example\.invalid|202|555|0147|SENSITIVE_MARKER|CUST_/);
});

test("customer diagnostics report phone-search failures safely", async () => {
  let calls = 0;
  const error = squareError({ statusCode: 403, code: "FORBIDDEN", field: "phone_number" });
  const client = makeClient({
    search: async () => {
      calls += 1;
      if (calls === 2) throw error;
      return { customers: [] };
    },
  });

  const { logs } = await captureCustomerLogs(async () => {
    await assert.rejects(findOrCreateCustomer(client, CONTACT), error);
  });
  const output = joined(logs);
  assert.match(output, /stage=customer_email_search_succeeded/);
  assert.match(output, /stage=customer_phone_search_started/);
  assert.match(output, /stage=customer_phone_search_failed/);
  assert.match(output, /httpStatus=403/);
  assert.match(output, /field=phone_number/);
});

test("customer diagnostics report customer-create failures safely", async () => {
  const error = squareError({ statusCode: 409, code: "CONFLICT", field: "idempotency_key" });
  const client = makeClient({ create: async () => { throw error; } });

  const { logs } = await captureCustomerLogs(async () => {
    await assert.rejects(findOrCreateCustomer(client, CONTACT), error);
  });
  const output = joined(logs);
  assert.match(output, /stage=customer_create_started/);
  assert.match(output, /stage=customer_create_failed/);
  assert.match(output, /httpStatus=409/);
  assert.match(output, /field=idempotency_key/);
  assert.doesNotMatch(output, /request body|response body|unsafe detail|unsafe message|raw/);
});

test("safe Square customer error extraction captures allowed statuses and tokens", () => {
  for (const statusCode of [400, 401, 403, 409, 429, 500]) {
    assert.equal(safeSquareCustomerError(squareError({ statusCode })).httpStatus, statusCode);
  }
  assert.deepEqual(
    safeSquareCustomerError(squareError({ category: "INVALID_REQUEST_ERROR", code: "VALUE_TOO_LONG", field: "reference_id" })),
    { classification: "provider_rejected", httpStatus: 400, category: "INVALID_REQUEST_ERROR", code: "VALUE_TOO_LONG", field: "reference_id" },
  );
  assert.equal(safeSquareCustomerError(squareError({ statusCode: 429 })).classification, "provider_retryable");
  assert.equal(safeSquareCustomerError(squareError({ statusCode: 500 })).classification, "provider_retryable");
});

test("safe Square customer error extraction omits unsafe fields and arbitrary strings", () => {
  const diagnostic = safeSquareCustomerError(squareError({
    statusCode: 422,
    category: "INVALID REQUEST",
    code: "BAD-EMAIL",
    field: "email_address: taylor@example.invalid",
  }));
  assert.deepEqual(diagnostic, { classification: "provider_rejected", httpStatus: 422 });
  assert.equal(safeSquareCustomerError({ statusCode: 99, errors: [] }).httpStatus, undefined);
  assert.equal(safeSquareCustomerError({ statusCode: 600, errors: [] }).httpStatus, undefined);
  assert.equal(safeSquareCustomerError({}).classification, "unknown_error");
});

test("successful customer searches log only match true or false", async () => {
  const { logs } = await captureCustomerLogs(() => findOrCreateCustomer(makeClient({
    search: async (request) => {
      if (request.query.filter.emailAddress) return { customers: [{ id: "CUST_EMAIL" }] };
      return { customers: [] };
    },
  }), CONTACT));
  const output = joined(logs);
  assert.match(output, /stage=customer_email_search_succeeded .*match=true/);
  assert.doesNotMatch(output, /CUST_EMAIL|taylor@example\.invalid|phoneNumber|emailAddress/);
});

test("existing-customer reuse behavior is unchanged", async () => {
  const customer = { id: "CUST_SAME" };
  let createCalls = 0;
  const customerId = await findOrCreateCustomer(makeClient({
    search: async () => ({ customers: [customer] }),
    create: async () => {
      createCalls += 1;
      return { customer: { id: "CUST_CREATED" } };
    },
  }), CONTACT);
  assert.equal(customerId, "CUST_SAME");
  assert.equal(createCalls, 0);
});

test("new-customer request shape remains unchanged and uses deterministic idempotency key", async () => {
  const createCalls = [];
  await findOrCreateCustomer(makeClient({
    create: async (request) => {
      createCalls.push(request);
      return { customer: { id: "CUST_CREATED" } };
    },
  }), CONTACT);

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].idempotencyKey, buildCustomerIdempotencyKey(REQUEST_ID));
  assert.equal(createCalls[0].idempotencyKey.length, 54);
  assert.deepEqual(createCalls[0].customer, {
    givenName: "Taylor",
    familyName: "Example",
    emailAddress: "taylor@example.invalid",
    phoneNumber: "+12025550147",
  });
  assert.equal("referenceId" in createCalls[0].customer, false);
  assert.equal("note" in createCalls[0].customer, false);
});

test("diagnostic fixtures use fictional identities only", () => {
  const fixtureText = JSON.stringify({ REQUEST_ID, REQUEST_KEY, CONTACT });
  assert.match(fixtureText, /example\.invalid/);
  assert.doesNotMatch(fixtureText, /approval/i);
});
