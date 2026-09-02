import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bookingRequestsHandler from "../api/square/booking-requests/index.js";
import lookupHandler from "../api/square/booking-requests/lookup.js";
import approveHandler from "../api/square/booking-requests/approve.js";
import declineHandler from "../api/square/booking-requests/decline.js";
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
import { publicRequestReference } from "../src/lib/request-reference.js";

const REQUEST_KEY = "req_test_abcdef123456";
const BASE_URL = "https://preview.example.invalid";

function futureSlot() {
  const d = new Date(Date.now() + 3 * 86400000);
  d.setUTCHours(14, 0, 0, 0);
  return d.toISOString();
}

const SLOT = futureSlot();

function slotPlus(minutes) {
  return new Date(new Date(SLOT).getTime() + minutes * 60000).toISOString();
}

let store;

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
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
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

function makeSquareMock({ available = true, bookingStatus = "ACCEPTED" } = {}) {
  const state = { createCalls: [], getCalls: [], availabilityCalls: 0, available };
  const bookingsByKey = new Map();
  const bookingsById = new Map();
  const client = {
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
        const result = { booking: { id: "BK_APPROVED_1", status: bookingStatus, version: 1 } };
        bookingsByKey.set(request.idempotencyKey, result);
        bookingsById.set(result.booking.id, result);
        return result;
      },
      get: async (request) => {
        state.getCalls.push(request);
        return bookingsById.get(request.bookingId) || { booking: { id: request.bookingId, status: bookingStatus, version: 1 } };
      },
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async () => ({ customer: { id: "CUST_APPROVE_1" } }),
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

test("all booking-request endpoints fail closed when approval is not enabled", async () => {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_ENABLED = "false";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";

  assert.equal((await post(bookingRequestsHandler, makeBody())).statusCode, 503);
  assert.equal(
    (await get(bookingRequestsHandler, { requestKey: REQUEST_KEY })).statusCode,
    503,
  );
  assert.equal(
    (await get(lookupHandler, { requestKey: REQUEST_KEY })).statusCode,
    503,
  );
  assert.equal(
    (await get(approveHandler, { token: "unused" })).statusCode,
    503,
  );
  assert.equal((await post(approveHandler, { token: "unused" })).statusCode, 503);
  assert.equal((await post(declineHandler, { token: "unused" })).statusCode, 503);
});

test("create validates the payload before storing anything", async () => {
  installGateEnv();

  const badEmail = await post(bookingRequestsHandler, makeBody({ email: "nope" }));
  assert.equal(badEmail.statusCode, 400);

  const badService = await post(bookingRequestsHandler, makeBody({ serviceKey: "nope" }));
  assert.equal(badService.statusCode, 400);

  const missingKey = await post(bookingRequestsHandler, makeBody({ requestKey: "short" }));
  assert.equal(missingKey.statusCode, 400);
});

test("create stores a pending request, returns the required wording, and never leaks the token", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const logs = [];
  const originalInfo = console.info;
  console.info = (message) => logs.push(String(message));

  let res;
  try {
    res = await post(bookingRequestsHandler, makeBody());
  } finally {
    console.info = originalInfo;
  }

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.status, "pending");
  assert.equal(
    res.body.message,
    "Your appointment request was sent. Chelsea will review your requested time. Your appointment is not confirmed until you receive an approval email.",
  );
  assert.ok(res.body.requestId);
  assert.equal(res.body.requestId, REQUEST_KEY);
  assert.equal(res.body.requestKey, REQUEST_KEY);
  assert.equal(res.body.notification.requestReceipt, "sent");
  assert.equal(res.body.notification.approval, "sent");
  assert.equal(state.availabilityCalls, 1);
  assert.equal(emails.length, 2);
  assert.match(emails[0].body.subject, /We received your appointment request/i);
  assert.match(emails[1].body.subject, /awaiting approval/i);

  const token = approvalTokenFromEmails(emails);
  assert.ok(token && token.length >= 24);

  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, new RegExp(token, "i"));
  assert.doesNotMatch(serialized, /approvalUrl|approve\?token/);
  for (const log of logs) {
    assert.doesNotMatch(log, new RegExp(token, "i"));
  }

  const receiptEmail = emails[0];
  assert.doesNotMatch(receiptEmail.body.html, /approve\?token/);
  const approvalEmail = emails[1];
  assert.match(approvalEmail.body.html, new RegExp(`approve\\?token=${token}`));
});

test("approval URL is built from PUBLIC_SITE_URL and appears only in the approval email", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const res = await post(bookingRequestsHandler, makeBody());
  assert.equal(res.statusCode, 201);

  const approval = emails.find((call) =>
    String(call.body.subject).includes("awaiting approval"),
  );
  assert.ok(approval);
  assert.match(approval.body.html, new RegExp(`${BASE_URL}/approve\\?token=`));
  assert.match(approval.body.text, new RegExp(`${BASE_URL}/approve\\?token=`));
  assert.deepEqual(approval.body.to, ["sandbox@example.invalid"]);
});

test("same request key with a different payload is a strict 409 conflict", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const first = await post(bookingRequestsHandler, makeBody());
  assert.equal(first.statusCode, 201);

  const conflict = await post(
    bookingRequestsHandler,
    makeBody({ email: "different@example.invalid" }),
  );
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.body.error, /request key/i);
});

test("replay with the same request key and payload returns the pending outcome idempotently", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const first = await post(bookingRequestsHandler, makeBody());
  assert.equal(first.statusCode, 201);

  const replay = await post(bookingRequestsHandler, makeBody());
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.requestId, first.body.requestId);
  assert.equal(state.availabilityCalls, 1, "no new availability check on replay");
});

test("an overlapping active request is rejected with 409", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const first = await post(bookingRequestsHandler, makeBody());
  assert.equal(first.statusCode, 201);

  const overlap = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_overlap_789" }),
  );
  assert.equal(overlap.statusCode, 409);
  assert.match(overlap.body.error, /no longer available/);
});

test("pending holds require a 30-minute turnaround buffer without double-buffering", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const first = await post(bookingRequestsHandler, makeBody());
  assert.equal(first.statusCode, 201);

  const immediate = await post(bookingRequestsHandler, makeBody({
    requestKey: "req_test_buffer_zero",
    startAt: slotPlus(60),
  }));
  assert.equal(immediate.statusCode, 409);

  const twentyNine = await post(bookingRequestsHandler, makeBody({
    requestKey: "req_test_buffer_29",
    startAt: slotPlus(89),
  }));
  assert.equal(twentyNine.statusCode, 409);

  const exactThirty = await post(bookingRequestsHandler, makeBody({
    requestKey: "req_test_buffer_30",
    startAt: slotPlus(90),
  }));
  assert.equal(exactThirty.statusCode, 201);
});

test("a proposed appointment cannot end less than 30 minutes before a later hold", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const later = await post(bookingRequestsHandler, makeBody({ startAt: slotPlus(90) }));
  assert.equal(later.statusCode, 201);

  const tooCloseBefore = await post(bookingRequestsHandler, makeBody({
    requestKey: "req_test_before_29",
    startAt: slotPlus(1),
  }));
  assert.equal(tooCloseBefore.statusCode, 409);

  const exactThirtyBefore = await post(bookingRequestsHandler, makeBody({
    requestKey: "req_test_before_30",
    startAt: SLOT,
  }));
  assert.equal(exactThirtyBefore.statusCode, 201);
});

test("GET status and lookup return safe request details without the token", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const created = await post(bookingRequestsHandler, makeBody());
  assert.equal(created.statusCode, 201);

  const status = await get(bookingRequestsHandler, { requestKey: REQUEST_KEY });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.status, "pending");
  assert.equal(status.body.requestId, created.body.requestId);
  assert.equal(status.body.requestKey, REQUEST_KEY);
  assert.doesNotMatch(JSON.stringify(status.body), /token/i);

  const lookup = await get(lookupHandler, { requestKey: REQUEST_KEY });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.body.requestId, REQUEST_KEY);
  assert.equal(lookup.body.requestKey, REQUEST_KEY);
  assert.equal(lookup.body.serviceName, "60 Min Customized Massage");
  assert.equal(lookup.body.durationMinutes, 60);
  assert.equal(lookup.body.emailStatuses.requestReceipt, "sent");
  assert.equal(lookup.body.emailStatuses.approval, "sent");
  assert.doesNotMatch(JSON.stringify(lookup.body), /approval_token_hash|token/i);
});

test("public request reference is the persisted request key through create, lookup, pending, and approved states", async () => {
  installGateEnv();
  installEmailEnv();
  const frontendKey = "33333333-3333-4333-8333-333333c0ffee";
  const approvalTokenSentinel = "approval-token-must-not-appear";
  const squareBookingId = "BK_APPROVED_1";
  const { client } = makeSquareMock({
    bookingStatus: "PENDING",
    bookingsCreate: async () => ({
      booking: { id: squareBookingId, status: "PENDING", version: 0 },
    }),
  });
  client.bookings.get = async () => ({
    booking: { id: squareBookingId, status: "ACCEPTED", version: 0 },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const created = await post(bookingRequestsHandler, makeBody({ requestKey: frontendKey }));
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.requestKey, frontendKey);
  assert.equal(created.body.requestId, frontendKey);
  assert.equal(publicRequestReference(created.body), frontendKey);
  assert.doesNotMatch(JSON.stringify(created.body), new RegExp(approvalTokenSentinel, "i"));

  const stored = await store.getRequestByKey(frontendKey);
  assert.ok(stored?.id);
  assert.notEqual(stored.id, frontendKey);
  assert.doesNotMatch(JSON.stringify(created.body), new RegExp(stored.id, "i"));

  const lookup = await get(lookupHandler, { requestKey: frontendKey });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.body.requestKey, frontendKey);
  assert.equal(lookup.body.requestId, frontendKey);
  assert.equal(publicRequestReference(lookup.body), frontendKey);
  assert.doesNotMatch(JSON.stringify(lookup.body), new RegExp(stored.id, "i"));

  const token = approvalTokenFromEmails(emails);
  assert.ok(token);
  const summary = await get(approveHandler, { token });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.body.requestKey, frontendKey);
  assert.equal(summary.body.requestId, frontendKey);
  assert.equal(publicRequestReference(summary.body), frontendKey);

  const pending = await post(approveHandler, { token });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.body.status, "awaiting_square_acceptance");
  assert.equal(pending.body.requestKey, frontendKey);
  assert.equal(pending.body.requestId, frontendKey);
  assert.equal(publicRequestReference(pending.body), frontendKey);

  const approved = await post(approveHandler, { token });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.requestKey, frontendKey);
  assert.equal(approved.body.requestId, frontendKey);
  assert.equal(publicRequestReference(approved.body), frontendKey);
  assert.equal(approved.body.bookingId, squareBookingId);
  assert.doesNotMatch(JSON.stringify(approved.body), new RegExp(stored.id, "i"));
  assert.doesNotMatch(JSON.stringify(approved.body), new RegExp(token, "i"));

  const receipt = emails.find((call) => String(call.body.subject).includes("We received"));
  const approval = emails.find((call) => String(call.body.subject).includes("awaiting approval"));
  assert.match(receipt.body.text, new RegExp(frontendKey));
  assert.match(approval.body.text, new RegExp(frontendKey));
  assert.doesNotMatch(receipt.body.text, new RegExp(stored.id, "i"));
  assert.doesNotMatch(approval.body.text, new RegExp(stored.id, "i"));
});

test("approve creates the Square booking with a deterministic idempotency key and buyer-level option, then confirms", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const created = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "approved");
  assert.equal(res.body.requestId, created.body.requestId);
  assert.equal(res.body.requestKey, REQUEST_KEY);
  assert.equal(res.body.bookingId, "BK_APPROVED_1");
  assert.match(res.body.calendarUrl, /calendar\.google\.com\/calendar\/render/);
  assert.equal(res.body.message, "Your appointment is confirmed.");

  assert.equal(state.createCalls.length, 1);
  const createReq = state.createCalls[0];
  const stored = await createStoreRow(created.body.requestKey);
  assert.notEqual(stored.id, created.body.requestId);
  assert.equal(createReq.idempotencyKey, `kai-lani.request.${stored.id}`);
  assert.equal(createReq.booking.startAt, SLOT);
  assert.deepEqual(state.createCalls[0].booking.sellerNote, undefined);
  assert.equal("sellerNote" in state.createCalls[0].booking, false);
  assert.equal(
    createReq.booking.appointmentSegments[0].serviceVariationVersion,
    3n,
    "fresh approval preserves the availability-sourced version into the create",
  );
  assert.deepEqual(createReq.requestOptions, { queryParams: { seller_level: false } });

  assert.equal(stored.status, "approved");
  assert.equal(stored.squareBookingId, "BK_APPROVED_1");
  assert.equal(stored.squareBookingVersion, 1);
  assert.equal(stored.squareBookingStatus, "ACCEPTED");
  assert.equal(stored.squareSyncStatus, "created");
  assert.equal(stored.squareServiceVariationId, "VAR_CUSTOMIZED_60");
  assert.equal(stored.squareLocationId, "LOC_SANDBOX");
  assert.equal(stored.squareTeamMemberId, "TM_CHELSEA");
  assert.equal(stored.confirmationEmailStatus, "sent");
  assert.equal(stored.providerConfirmationEmailStatus, "sent");

  const clientEmail = emails.find((call) =>
    String(call.body.subject).includes("appointment is confirmed"),
  );
  assert.ok(clientEmail);
  assert.match(clientEmail.body.html, /Add this appointment to Google Calendar/);
  assert.match(clientEmail.body.text, /Add this appointment to Google Calendar/);
  assert.equal(clientEmail.body.attachments[0].filename, "kai-lani-appointment.ics");
  assert.ok(clientEmail.body.attachments[0].content);

  const providerEmail = emails.find((call) =>
    String(call.body.subject).includes("Appointment approved"),
  );
  assert.ok(providerEmail);
  assert.equal(providerEmail.body.attachments[0].filename, "kai-lani-appointment.ics");
});

async function createStoreRow(requestKey) {
  return store.getRequestByKey(requestKey);
}

test("approve is idempotent and never creates a duplicate Square booking", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const first = await post(approveHandler, { token });
  const second = await post(approveHandler, { token });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.status, "approved");
  assert.equal(second.body.bookingId, first.body.bookingId);
  assert.equal(state.createCalls.length, 1);
});

test("approve with an invalid token returns 404 and creates nothing", async () => {
  installGateEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);

  const res = await post(approveHandler, { token: "not-a-real-token-1234567890" });
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /invalid or has expired/i);
  assert.equal(state.createCalls.length, 0);
});

test("approve when the slot is gone marks needs_reschedule and emails the client", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const created = await post(bookingRequestsHandler, makeBody());
  assert.equal(created.statusCode, 201);
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  state.available = false;

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "needs_reschedule");

  const row = await createStoreRow(created.body.requestKey);
  assert.equal(row.status, "needs_reschedule");

  const rescheduleEmail = emails.find((call) =>
    String(call.body.subject).includes("no longer available"),
  );
  assert.ok(rescheduleEmail);
  assert.match(rescheduleEmail.body.text, /Please request a new time/);
  assert.equal(rescheduleEmail.body.attachments, undefined);
});

test("decline marks the request declined and emails the client", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const created = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(declineHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "declined");

  const row = await createStoreRow(created.body.requestKey);
  assert.equal(row.status, "declined");
  assert.equal(row.declineEmailStatus, "sent");

  const declined = emails.find((call) =>
    String(call.body.subject).includes("was not approved"),
  );
  assert.ok(declined);
  assert.deepEqual(declined.body.to, ["sandbox@example.invalid"]);
});

test("decline after approve returns 409 and never touches an approved booking", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  await post(approveHandler, { token });
  const res = await post(declineHandler, { token });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already been approved/i);
  assert.equal(state.createCalls.length, 1);
});

test("approve after decline answers with the declined outcome and never re-approves", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  await post(declineHandler, { token });
  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "declined");
  assert.equal(state.createCalls.length, 0);
});

test("approval summary GET serves the request without the token; after approval it includes the calendar link", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const summary = await get(approveHandler, { token });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.body.status, "pending");
  assert.equal(summary.body.decided, false);
  assert.equal(summary.body.firstName, "Ava");
  assert.equal(summary.body.serviceName, "60 Min Customized Massage");
  assert.doesNotMatch(JSON.stringify(summary.body), new RegExp(token, "i"));

  await post(approveHandler, { token });

  const decided = await get(approveHandler, { token });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.body.status, "approved");
  assert.equal(decided.body.decided, true);
  assert.match(decided.body.calendarUrl, /calendar\.google\.com\/calendar\/render/);
});

test("approval GET without a token returns 400", async () => {
  installGateEnv();
  const res = await get(approveHandler, {});
  assert.equal(res.statusCode, 400);
});

test("approval customer search receives only the E.164 phone value", async () => {
  installGateEnv();
  installEmailEnv();
  const searchFilters = [];
  const client = {
    bookings: {
      searchAvailability: async () => ({
        availabilities: [{ startAt: SLOT, appointmentSegments: [{ serviceVariationVersion: 3 }] }],
      }),
      create: async () => ({ booking: { id: "BK_E164", status: "ACCEPTED", version: 1 } }),
    },
    customers: {
      search: async ({ query }) => {
        searchFilters.push(query.filter);
        return { customers: [] };
      },
      create: async () => ({ customer: { id: "CUST_E164" } }),
    },
  };
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "approved");

  const phoneFilter = searchFilters.find((f) => f.phoneNumber);
  assert.ok(phoneFilter, "must issue a phone search");
  assert.equal(phoneFilter.phoneNumber.exact, "+19805550100");
  assert.doesNotMatch(JSON.stringify(searchFilters), /"exact":"19805550100"/);
});

test("approval customer creation receives only the E.164 phone value", async () => {
  installGateEnv();
  installEmailEnv();
  let createdCustomer = null;
  const client = {
    bookings: {
      searchAvailability: async () => ({
        availabilities: [{ startAt: SLOT, appointmentSegments: [{ serviceVariationVersion: 3 }] }],
      }),
      list: async () => ({ data: [] }),
      create: async () => ({ booking: { id: "BK_E164C", status: "ACCEPTED", version: 1 } }),
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async (request) => {
        createdCustomer = request;
        return { customer: { id: "CUST_E164C" } };
      },
    },
  };
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.ok(createdCustomer, "customer create must be called");
  assert.equal(createdCustomer.phoneNumber, "+19805550100");
  assert.equal(createdCustomer.emailAddress, "ava@example.invalid");
});

test("approval preserves email-first search order and never creates when a customer matches", async () => {
  installGateEnv();
  installEmailEnv();
  const searchFilters = [];
  let createCalls = 0;
  const client = {
    bookings: {
      searchAvailability: async () => ({
        availabilities: [{ startAt: SLOT, appointmentSegments: [{ serviceVariationVersion: 3 }] }],
      }),
      create: async () => ({ booking: { id: "BK_EMAIL", status: "ACCEPTED", version: 1 } }),
    },
    customers: {
      search: async ({ query }) => {
        searchFilters.push(query.filter);
        return { customers: [{ id: "CUST_EMAIL_MATCH" }] };
      },
      create: async () => {
        createCalls += 1;
        return { customer: { id: "SHOULD_NOT_CREATE" } };
      },
    },
  };
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "approved");
  assert.equal(createCalls, 0, "existing customer must be reused, never created");
  assert.ok(searchFilters.length >= 1);
  const first = searchFilters[0];
  assert.ok(first.emailAddress, "first search must be by email");
  assert.equal(first.emailAddress.exact, "ava@example.invalid");
});

test("approval reproduces the real Square E.164 contract offline: a mock rejecting non-E.164 phone searches passes after the correction", async () => {
  installGateEnv();
  installEmailEnv();
  const searchedPhones = [];
  const client = {
    bookings: {
      searchAvailability: async () => ({
        availabilities: [{ startAt: SLOT, appointmentSegments: [{ serviceVariationVersion: 3 }] }],
      }),
      create: async () => ({ booking: { id: "BK_CONTRACT", status: "ACCEPTED", version: 1 } }),
    },
    customers: {
      search: async ({ query }) => {
        const phone = query.filter?.phoneNumber?.exact;
        if (phone !== undefined) {
          searchedPhones.push(phone);
          if (!/^\+[1-9]\d{1,14}$/.test(phone)) {
            const err = new Error("INVALID_VALUE phone");
            err.statusCode = 400;
            throw err;
          }
          return { customers: [] };
        }
        return { customers: [] };
      },
      create: async () => ({ customer: { id: "CUST_CONTRACT" } }),
    },
  };
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "approved");
  assert.ok(searchedPhones.length >= 1, "phone search must have been attempted");
  for (const phone of searchedPhones) {
    assert.match(phone, /^\+/, "every phone search must carry the leading +");
  }
});

test("approval never logs or returns the phone number or PII", async () => {
  installGateEnv();
  installEmailEnv();
  const logs = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (...args) => logs.push(args.map((a) => String(a)).join(" "));
  console.info = (...args) => logs.push(args.map((a) => String(a)).join(" "));

  let createCalls = 0;
  let res;
  const client = {
    bookings: {
      searchAvailability: async () => ({
        availabilities: [{ startAt: SLOT, appointmentSegments: [{ serviceVariationVersion: 3 }] }],
      }),
    },
    customers: {
      search: async () => {
        const err = new Error("customer lookup failed");
        throw err;
      },
      create: async () => {
        createCalls += 1;
        return { customer: { id: "SHOULD_NOT_CREATE" } };
      },
    },
  };
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  try {
    await post(bookingRequestsHandler, makeBody());
    const token = approvalTokenFromEmails(emails);
    assert.ok(token);
    res = await post(approveHandler, { token });
    assert.equal(res.statusCode, 500);
    assert.equal(createCalls, 0);
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }

  const allLogs = logs.join("\n");
  assert.doesNotMatch(allLogs, /9805550100|19805550100|ava@example|Ava\s+Test/i, "logs must not contain the phone or PII");
  assert.doesNotMatch(res.body ? JSON.stringify(res.body) : "", /ava@example|9805550100/i, "response must not contain PII");
});
