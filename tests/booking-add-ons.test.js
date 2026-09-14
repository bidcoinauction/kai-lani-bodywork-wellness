import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import availabilityHandler from "../api/square/availability.js";
import bookingRequestsHandler from "../api/square/booking-requests/index.js";
import approveHandler from "../api/square/booking-requests/approve.js";
import {
  makeRequest,
  makeResponse,
  installFullConfig,
  setSquareClientForTests,
  resetSquareClientForTests,
} from "./helpers.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import {
  setBookingRequestStoreForTests,
  resetBookingRequestStoreForTests,
} from "../lib/store.js";
import {
  addOnsDurationMinutes,
  addOnsPriceCents,
  getAddOnConfig,
  normalizeAddOnKeys,
} from "../lib/add-ons.js";
import {
  totalDurationMinutes,
  totalPriceCents,
} from "../lib/booking-requests.js";
import { getServiceConfig } from "../lib/services.js";
import { paymentAmountForRequest } from "../lib/payment.js";

const REQUEST_KEY = "req_addon_abcdef123456";
const BASE_URL = "https://preview.example.invalid";

function futureSlot() {
  const d = new Date(Date.now() + 3 * 86400000);
  d.setUTCHours(14, 0, 0, 0);
  return d.toISOString();
}

const SLOT = futureSlot();

function makeBody(overrides = {}) {
  return {
    serviceKey: "customized_60",
    firstName: "Ava",
    lastName: "Test",
    email: "ava@example.invalid",
    phone: "+19805550100",
    startAt: SLOT,
    requestKey: REQUEST_KEY,
    contactConsent: true,
    ...overrides,
  };
}

function installGateEnv() {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
}

function installEmailEnv() {
  process.env.EMAIL_ENABLED = "true";
  process.env.EMAIL_MODE = "sandbox";
  process.env.RESEND_API_KEY = "test_resend_key";
  process.env.EMAIL_FROM = "Kai Lani Sandbox <onboarding@resend.dev>";
  process.env.EMAIL_SANDBOX_RECIPIENT = "sandbox@example.invalid";
  process.env.EMAIL_REPLY_TO = "reply@example.invalid";
  process.env.PUBLIC_SITE_URL = BASE_URL;
}

function clearAllEnv() {
  for (const key of [
    "SQUARE_ENVIRONMENT",
    "BOOKING_APPROVAL_ENABLED",
    "BOOKING_APPROVAL_MODE",
    "PUBLIC_SITE_URL",
    "EMAIL_ENABLED",
    "EMAIL_MODE",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "EMAIL_SANDBOX_RECIPIENT",
    "BOOKING_APPROVAL_TOKEN_TTL_MINUTES",
  ]) {
    delete process.env[key];
  }
}

function makeSquareMock({ available = true, bookingStatus = "ACCEPTED", bookingsCreate } = {}) {
  const state = { createCalls: [], availabilityCalls: 0, available };
  const bookingsByKey = new Map();
  const bookingsById = new Map();
  const client = {
    catalog: {
      object: {
        get: async ({ objectId }) => ({ object: { version: objectId === "VAR_FACIAL_15" ? 4 : 3 } }),
      },
    },
    bookings: {
      searchAvailability: async (query) => {
        state.availabilityCalls += 1;
        const requestedStart = query?.query?.filter?.startAtRange?.startAt || SLOT;
        return {
          availabilities: state.available
            ? [{ startAt: requestedStart, appointmentSegments: [{ serviceVariationVersion: 3 }] }]
            : [],
        };
      },
      create: async (request, requestOptions) => {
        state.createCalls.push({ ...request, requestOptions });
        if (bookingsByKey.has(request.idempotencyKey)) return bookingsByKey.get(request.idempotencyKey);
        const result = bookingsCreate
          ? await bookingsCreate(request, state)
          : { booking: { id: "BK_ADDON_1", status: bookingStatus, version: 1 } };
        bookingsByKey.set(request.idempotencyKey, result);
        bookingsById.set(result.booking.id, result);
        return result;
      },
      get: async (request) => {
        state.getCalls = state.getCalls || [];
        state.getCalls.push(request);
        return bookingsById.get(request.bookingId) || { booking: { id: request.bookingId, status: bookingStatus, version: 1 } };
      },
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async () => ({ customer: { id: "CUST_ADDON_1" } }),
    },
  };
  return { client, state };
}

function captureEmailCalls() {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push({ options, body: JSON.parse(options.body) });
    return { ok: true };
  };
  return calls;
}

function approvalTokenFromEmails(calls) {
  const approval = calls.find((call) =>
    String(call.body.subject).includes("awaiting approval"),
  );
  const match = approval?.body.html.match(/approve\?token=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function call(handler, req) {
  const res = makeResponse();
  await handler(req, res);
  return res;
}

function post(handler, body) {
  return call(handler, makeRequest({ method: "POST", body }));
}

function get(handler, query) {
  return call(handler, makeRequest({ method: "GET", query }));
}

let store;

beforeEach(() => {
  clearAllEnv();
  installFullConfig();
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
  delete globalThis.fetch;
  store = new MemoryBookingRequestStore();
  setBookingRequestStoreForTests(store);
});

afterEach(() => {
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
  delete globalThis.fetch;
});

test("authoritative add-on config is exactly 15 minutes and $30", () => {
  const addOn = getAddOnConfig("facial_massage_15");
  assert.equal(addOn.key, "facial_massage_15");
  assert.equal(addOn.name, "Facial Massage");
  assert.equal(addOn.durationMinutes, 15);
  assert.equal(addOn.price, 30);
  assert.equal(addOn.priceCents, 3000);
  assert.equal(addOn.currency, "USD");
  assert.equal(addOn.serviceVariationId, "VAR_FACIAL_15");
});

test("normalizeAddOnKeys maps the public id and rejects unknown add-ons", () => {
  assert.deepEqual(normalizeAddOnKeys(["facial-massage"]), ["facial_massage_15"]);
  assert.deepEqual(normalizeAddOnKeys(["facial_massage_15"]), ["facial_massage_15"]);
  assert.deepEqual(normalizeAddOnKeys([]), []);
  assert.deepEqual(normalizeAddOnKeys(null), []);
  assert.deepEqual(normalizeAddOnKeys(undefined), []);
  assert.equal(normalizeAddOnKeys(["hot-stone"]), null);
  assert.equal(normalizeAddOnKeys("facial-massage"), null);
  assert.deepEqual(normalizeAddOnKeys(["facial-massage", "facial-massage"]), ["facial_massage_15"]);
});

test("duration and price helpers use server-owned add-on values", () => {
  const sixty = getServiceConfig("customized_60");
  const ninety = getServiceConfig("customized_90");
  const prenatal = getServiceConfig("prenatal_60");
  const keys = ["facial_massage_15"];

  assert.equal(addOnsDurationMinutes(keys), 15);
  assert.equal(addOnsPriceCents(keys), 3000);

  assert.equal(totalDurationMinutes(sixty, keys), 75);
  assert.equal(totalDurationMinutes(ninety, keys), 105);
  assert.equal(totalDurationMinutes(sixty, []), 60);

  assert.equal(totalPriceCents(sixty, keys), 12300);
  assert.equal(totalPriceCents(prenatal, keys), 12700);
  assert.equal(totalPriceCents(ninety, keys), 15300);
  assert.equal(totalPriceCents(sixty, []), 9300);
});

test("booking request create ignores client price/duration and persists server-owned add-on keys", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const res = await post(bookingRequestsHandler, makeBody({
    addons: ["facial-massage"],
    price: 1,
    durationMinutes: 5,
  }));
  assert.equal(res.statusCode, 201);

  const row = await store.getRequestByKey(REQUEST_KEY);
  assert.ok(row);
  assert.deepEqual(row.addOnKeys, ["facial_massage_15"]);
  assert.equal(row.durationMinutes, 75);
  assert.equal(row.status, "pending");
});

test("booking request create rejects unknown add-on identifiers", async () => {
  installGateEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const res = await post(bookingRequestsHandler, makeBody({ addons: ["hot-stone"] }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /add-on/i);
});

test("no-add-on requests remain fully compatible", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const res = await post(bookingRequestsHandler, makeBody());
  assert.equal(res.statusCode, 201);
  const row = await store.getRequestByKey(REQUEST_KEY);
  assert.deepEqual(row.addOnKeys, []);
  assert.equal(row.durationMinutes, 60);
});

test("approve creates two Square segments for a facial add-on request with the real variation", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const created = await post(bookingRequestsHandler, makeBody({ addons: ["facial-massage"] }));
  assert.equal(created.statusCode, 201);
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "approved");
  assert.deepEqual(res.body.addOns, [{ name: "Facial Massage", durationMinutes: 15, price: 30 }]);

  assert.equal(state.createCalls.length, 1);
  const createReq = state.createCalls[0];
  const segments = createReq.booking.appointmentSegments;
  assert.equal(segments.length, 2);
  assert.equal(segments[0].serviceVariationId, "VAR_CUSTOMIZED_60");
  assert.equal(segments[0].durationMinutes, 60);
  assert.equal(segments[0].serviceVariationVersion, 3n);
  assert.equal(segments[1].serviceVariationId, "VAR_FACIAL_15");
  assert.equal(segments[1].durationMinutes, 15);
  assert.equal(segments[1].serviceVariationVersion, 4n);
  assert.equal(segments[0].teamMemberId, "TM_CHELSEA");
  assert.equal(segments[1].teamMemberId, "TM_CHELSEA");
  assert.deepEqual(createReq.requestOptions, { queryParams: { seller_level: false } });
});

test("approve for a primary-only request still creates exactly one Square segment", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(state.createCalls.length, 1);
  assert.equal(state.createCalls[0].booking.appointmentSegments.length, 1);
  assert.equal(state.createCalls[0].booking.appointmentSegments[0].serviceVariationId, "VAR_CUSTOMIZED_60");
});

test("approve is idempotent with add-ons and never duplicates the booking", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody({ addons: ["facial-massage"] }));
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const first = await post(approveHandler, { token });
  const second = await post(approveHandler, { token });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.bookingId, first.body.bookingId);
  assert.equal(state.createCalls.length, 1);
});

test("availability uses combined add-on duration for turnover filtering", async () => {
  installGateEnv();
  const date = SLOT.slice(0, 10);
  const existingStart = `${date}T14:00:00.000Z`;
  const blocked = `${date}T16:00:00.000Z`;
  const valid = `${date}T16:30:00.000Z`;
  setSquareClientForTests({
    bookings: {
      searchAvailability: async () => ({ availabilities: [{ startAt: blocked }, { startAt: valid }] }),
      list: async () => ({ data: [{
        id: "BK_90_PLUS_15",
        status: "ACCEPTED",
        startAt: existingStart,
        appointmentSegments: [{ teamMemberId: "TM_CHELSEA", durationMinutes: 90 }, { teamMemberId: "TM_CHELSEA", durationMinutes: 15 }],
      }] }),
    },
  });
  const res = await call(availabilityHandler, makeRequest({ method: "GET", query: {
    serviceKey: "customized_90",
    date,
    addons: "facial-massage",
  } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.addOnKeys, ["facial_massage_15"]);
  assert.deepEqual(res.body.slots.map((slot) => slot.startAt), [valid]);
});

test("availability passes add-on segment filters to Square and keeps no-add-on behavior unchanged", async () => {
  installGateEnv();
  const date = SLOT.slice(0, 10);
  const filters = [];
  const client = {
    bookings: {
      searchAvailability: async (request) => {
        filters.push(request.query.filter.segmentFilters.map((f) => f.serviceVariationId));
        return { availabilities: [{ startAt: `${date}T15:00:00.000Z` }] };
      },
      list: async () => ({ data: [] }),
    },
  };
  setSquareClientForTests(client);

  const withAddOn = await call(availabilityHandler, makeRequest({ method: "GET", query: {
    serviceKey: "customized_60",
    date,
    addons: "facial-massage",
  } }));
  assert.equal(withAddOn.statusCode, 200);
  assert.deepEqual(filters.at(-1), ["VAR_CUSTOMIZED_60", "VAR_FACIAL_15"]);

  const withoutAddOn = await call(availabilityHandler, makeRequest({ method: "GET", query: {
    serviceKey: "customized_60",
    date,
  } }));
  assert.equal(withoutAddOn.statusCode, 200);
  assert.deepEqual(filters.at(-1), ["VAR_CUSTOMIZED_60"]);
});

test("prepayment amount uses the server-authoritative combined total", () => {
  assert.equal(paymentAmountForRequest({ serviceKey: "customized_60", addOnKeys: ["facial_massage_15"], id: "1" }), 12300);
  assert.equal(paymentAmountForRequest({ serviceKey: "customized_90", addOnKeys: ["facial_massage_15"], id: "2" }), 15300);
  assert.equal(paymentAmountForRequest({ serviceKey: "prenatal_60", addOnKeys: ["facial_massage_15"], id: "3" }), 12700);
  assert.equal(paymentAmountForRequest({ serviceKey: "customized_60", addOnKeys: [], id: "4" }), 9300);
});

test("approval summary surfaces the selected add-on", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody({ addons: ["facial-massage"] }));
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const summary = await get(approveHandler, { token });
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(summary.body.addOns, [{ name: "Facial Massage", durationMinutes: 15, price: 30 }]);
  assert.equal(summary.body.durationMinutes, 75);
});