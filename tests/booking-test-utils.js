import { makeRequest, makeResponse, installFullConfig } from "./helpers.js";
import {
  setBookingRequestStoreForTests,
  resetBookingRequestStoreForTests,
} from "../lib/store.js";

export const REQUEST_KEY = "req_test_abcdef123456";
export const BASE_URL = "https://preview.example.invalid";

export function futureSlot() {
  const d = new Date(Date.now() + 3 * 86400000);
  d.setUTCHours(14, 0, 0, 0);
  return d.toISOString();
}

export const SLOT = futureSlot();

export function futureSlotAt(minutesFromNow) {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function makeBody(overrides = {}) {
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

export function installGateEnv() {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
}

export function installEmailEnv() {
  process.env.EMAIL_ENABLED = "true";
  process.env.EMAIL_MODE = "sandbox";
  process.env.RESEND_API_KEY = "test_resend_key";
  process.env.EMAIL_FROM = "Kai Lani Sandbox <onboarding@resend.dev>";
  process.env.EMAIL_SANDBOX_RECIPIENT = "sandbox@example.invalid";
  process.env.EMAIL_REPLY_TO = "reply@example.invalid";
  process.env.PUBLIC_SITE_URL = BASE_URL;
}

export function clearAllEnv() {
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
    "EMAIL_REPLY_TO",
    "BOOKING_APPROVAL_TOKEN_TTL_MINUTES",
  ]) {
    delete process.env[key];
  }
}

/**
 * Square client mock with idempotent booking create (same idempotency key
 * returns the same booking, as the real API does) and configurable customer
 * search/create. The state object exposes call recording for assertions.
 */
export function makeSquareMock({
  available = true,
  bookingStatus = "ACCEPTED",
  customers,
  bookingsCreate,
} = {}) {
  const state = {
    createCalls: [],
    availabilityCalls: 0,
    customerSearchCalls: [],
    customerCreateCalls: [],
    customerByKey: new Map(),
    available,
  };
  const bookingsByKey = new Map();
  const client = {
    bookings: {
      searchAvailability: async (query) => {
        state.availabilityCalls += 1;
        if (!state.available) return { availabilities: [] };
        const requestedStart = query?.query?.filter?.startAtRange?.startAt || SLOT;
        return {
          availabilities: [
            { startAt: requestedStart, appointmentSegments: [{ serviceVariationVersion: 3 }] },
          ],
        };
      },
      create: async (request) => {
        state.createCalls.push(request);
        if (bookingsByKey.has(request.idempotencyKey)) {
          return bookingsByKey.get(request.idempotencyKey);
        }
        const result = bookingsCreate
          ? await bookingsCreate(request, state)
          : { booking: { id: "BK_APPROVED_1", status: bookingStatus, version: 1 } };
        bookingsByKey.set(request.idempotencyKey, result);
        return result;
      },
    },
    customers: {
      search: async (request) => {
        state.customerSearchCalls.push(request);
        if (customers?.search) return customers.search(request, state);
        return { customers: [] };
      },
      create: async (request) => {
        state.customerCreateCalls.push(request);
        if (state.customerByKey.has(request.idempotencyKey)) {
          return state.customerByKey.get(request.idempotencyKey);
        }
        const result = customers?.create
          ? await customers.create(request, state)
          : { customer: { id: "CUST_APPROVE_1" } };
        state.customerByKey.set(request.idempotencyKey, result);
        return result;
      },
    },
  };
  return { client, state };
}

/**
 * Captures Resend fetches. An optional responder can return per-call fetch
 * responses (e.g. fail only the provider confirmation subject).
 */
export function captureEmailCalls(responder) {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const parsed = { options, body: JSON.parse(options.body) };
    calls.push(parsed);
    if (responder) return responder(parsed, calls);
    return { ok: true };
  };
  return calls;
}

export function failEmailBySubject(includesText) {
  return (call) => {
    if (String(call.body.subject).includes(includesText)) {
      return { ok: false, status: 422, json: async () => ({}) };
    }
    return { ok: true };
  };
}

export function approvalTokenFromEmails(calls) {
  const approval = calls.find((call) =>
    String(call.body.subject).includes("awaiting approval"),
  );
  const match = approval?.body.html.match(/approve\?token=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

export async function call(handler, req) {
  const res = makeResponse();
  await handler(req, res);
  return res;
}

export function post(handler, body) {
  return call(handler, makeRequest({ method: "POST", body }));
}

export function get(handler, query) {
  return call(handler, makeRequest({ method: "GET", query }));
}

export function setupBookingTest(store) {
  clearAllEnv();
  installFullConfig();
  resetBookingRequestStoreForTests();
  delete globalThis.fetch;
  setBookingRequestStoreForTests(store);
}

export function teardownBookingTest() {
  resetBookingRequestStoreForTests();
  delete globalThis.fetch;
}
