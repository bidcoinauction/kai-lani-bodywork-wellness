import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import webhookHandler from "../api/square/webhook.js";
import { makeRequest, makeResponse, setSquareClientForTests, resetSquareClientForTests } from "./helpers.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import {
  createNeonPool,
  setBookingRequestStoreForTests,
  resetBookingRequestStoreForTests,
} from "../lib/store.js";
import { webhookTestInternals } from "../api/square/webhook.js";
import { isSquareBookingActive } from "../lib/booking-requests.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";

const NOTIFICATION_URL = "https://preview.example.vercel.app/api/square/webhook";
const SIGNATURE_KEY = "test-signature-key";
const BOOKING_ID = "bk-webhook-1";

let store;
let eventCounter = 0;

function installEnv() {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_ENABLED = "true";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = SIGNATURE_KEY;
  process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = NOTIFICATION_URL;
}

function clearEnv() {
  for (const key of [
    "SQUARE_ENVIRONMENT",
    "BOOKING_APPROVAL_ENABLED",
    "BOOKING_APPROVAL_MODE",
    "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_NOTIFICATION_URL",
  ]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  installEnv();
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
  store = new MemoryBookingRequestStore();
  setBookingRequestStoreForTests(store);
});

afterEach(() => {
  clearEnv();
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
});

function computeSignature(rawBody, url = NOTIFICATION_URL, key = SIGNATURE_KEY) {
  return crypto.createHmac("sha256", key).update(url + rawBody).digest("base64");
}

function makeEvent({
  eventId,
  type = "booking.updated",
  bookingId = BOOKING_ID,
  version = 1,
} = {}) {
  eventCounter += 1;
  return JSON.stringify({
    merchant_id: "merchant-safe",
    location_id: "LOC_SAFE",
    type,
    event_id: eventId || `evt-${eventCounter}`,
    created_at: "2026-07-30T12:00:00Z",
    data: {
      type: "booking",
      id: bookingId,
      object: { booking: { id: bookingId, version } },
    },
  });
}

function makeCompositeTestEvent({
  eventId,
  canonicalBookingId,
  version = 0,
  type = "booking.created",
} = {}) {
  eventCounter += 1;
  return JSON.stringify({
    merchant_id: "merchant-safe",
    location_id: "LOC_SAFE",
    type,
    event_id: eventId || `evt-composite-${eventCounter}`,
    created_at: "2026-08-12T16:31:01Z",
    data: {
      type: "booking",
      id: `${canonicalBookingId}:${version}`,
      object: {
        booking: {
          id: canonicalBookingId,
          status: "ACCEPTED",
          version,
        },
      },
    },
  });
}

function makeBooking({
  id = BOOKING_ID,
  version = 1,
  status = "ACCEPTED",
  startAt = "2026-11-01T15:00:00.000Z",
  durationMinutes = 60,
  serviceVariationId = "VAR_60",
  locationId = "LOC_SAFE",
  teamMemberId = "TM_SAFE",
} = {}) {
  return {
    id,
    version,
    status,
    startAt,
    locationId,
    appointmentSegments: [
      {
        durationMinutes,
        serviceVariationId,
        teamMemberId,
        serviceVariationVersion: 2,
      },
    ],
  };
}

function setBookingMock(booking, log = { get: 0 }) {
  setSquareClientForTests({
    bookings: {
      get: async ({ bookingId }) => {
        log.get += 1;
        assert.equal(bookingId, booking.id);
        return { booking };
      },
      searchAvailability: async () => ({ availabilities: [] }),
      create: async () => ({ booking: { id: "unused" } }),
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async () => ({ customer: { id: "unused" } }),
    },
  });
  return log;
}

async function createApprovedRequest({
  requestKey = "req-webhook-base",
  startAt = "2026-11-01T15:00:00.000Z",
  durationMinutes = 60,
  squareBookingVersion = 0,
  squareBookingStatus = "ACCEPTED",
  squareSyncStatus = "created",
  squareBookingId = BOOKING_ID,
} = {}) {
  const token = generateApprovalToken();
  const row = await store.createRequest({
    requestKey,
    serviceKey: durationMinutes === 90 ? "customized_90" : "customized_60",
    firstName: "Safe",
    lastName: "Client",
    email: `${requestKey}@example.invalid`,
    phone: "+19805550100",
    startAt,
    durationMinutes,
    approvalTokenHash: hashToken(token),
    approvalTokenExpiresAt: new Date(Date.now() + 600_000),
  });
  const internal = store._findById(row.id);
  internal.status = "approved";
  internal.squareBookingId = squareBookingId;
  internal.squareBookingVersion = squareBookingVersion;
  internal.squareBookingStatus = squareBookingStatus;
  internal.squareSyncStatus = squareSyncStatus;
  internal.decidedAt = new Date();
  return store.getRequestById(row.id);
}

async function createPendingRequest(requestKey, startAt, durationMinutes = 60) {
  return store.createRequest({
    requestKey,
    serviceKey: durationMinutes === 90 ? "customized_90" : "customized_60",
    firstName: "Pending",
    lastName: "Client",
    email: `${requestKey}@example.invalid`,
    phone: "+19805550100",
    startAt,
    durationMinutes,
    approvalTokenHash: hashToken(generateApprovalToken()),
    approvalTokenExpiresAt: new Date(Date.now() + 600_000),
  });
}

async function run({ method = "POST", rawBody, body, headers = {} }) {
  const res = makeResponse();
  await webhookHandler(makeRequest({ method, rawBody, body, headers }), res);
  return res;
}

async function signedRun(rawBody, headers = {}) {
  return run({
    rawBody,
    headers: { "x-square-hmacsha256-signature": computeSignature(rawBody), ...headers },
  });
}

test("signature: valid signature accepted; missing/invalid rejected; JSON parsed only after verification", async () => {
  await createApprovedRequest();
  const booking = makeBooking({ version: 1 });
  const log = setBookingMock(booking);
  const rawBody = makeEvent({ version: 1 });

  const valid = await signedRun(rawBody);
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.body, { received: true });
  assert.equal(log.get, 1);

  const missing = await run({ rawBody: makeEvent() });
  assert.equal(missing.statusCode, 401);

  const invalid = await run({
    rawBody: makeEvent(),
    headers: { "x-square-hmacsha256-signature": "not-the-signature" },
  });
  assert.equal(invalid.statusCode, 401);

  const malformed = await signedRun("{not valid json");
  assert.equal(malformed.statusCode, 400);
});

test("signature: no raw secrets, signatures, tokens or PII are logged", async () => {
  await createApprovedRequest();
  setBookingMock(makeBooking({ version: 1 }));
  const rawBody = makeEvent({ version: 1 });
  const logs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await signedRun(rawBody);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
  const joined = logs.join("\n");
  assert.doesNotMatch(joined, new RegExp(SIGNATURE_KEY));
  assert.doesNotMatch(joined, /Safe|Client|example\.invalid|980555|x-square/i);
});

test("event durability: new event claimed once, duplicate processed event idempotent", async () => {
  await createApprovedRequest();
  const log = setBookingMock(makeBooking({ version: 1 }));
  const rawBody = makeEvent({ eventId: "evt-dedupe", version: 1 });
  const signature = computeSignature(rawBody);

  const first = await run({ rawBody, headers: { "x-square-hmacsha256-signature": signature } });
  const second = await run({ rawBody, headers: { "x-square-hmacsha256-signature": signature } });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(log.get, 1);
  assert.equal(store.webhookEvents.get("evt-dedupe").processingStatus, "processed");
  assert.equal(store.webhookEvents.get("evt-dedupe").attemptCount, 1);
});

test("event durability: failed event remains retryable and processes on retry", async () => {
  await createApprovedRequest();
  let fail = true;
  const log = { get: 0 };
  setSquareClientForTests({
    bookings: {
      get: async () => {
        log.get += 1;
        if (fail) throw new Error("temporary fetch failure");
        return { booking: makeBooking({ version: 1 }) };
      },
    },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const rawBody = makeEvent({ eventId: "evt-retry", version: 1 });
  const first = await signedRun(rawBody);
  assert.equal(first.statusCode, 500);
  assert.equal(store.webhookEvents.get("evt-retry").processingStatus, "failed");

  fail = false;
  const retry = await signedRun(rawBody);
  assert.equal(retry.statusCode, 200);
  assert.equal(store.webhookEvents.get("evt-retry").processingStatus, "processed");
  assert.equal(log.get, 2);
});

test("event durability: concurrent claims do not double-process", async () => {
  const first = await store.claimWebhookEvent({
    eventId: "evt-race",
    eventType: "booking.updated",
    squareBookingId: BOOKING_ID,
    squareBookingVersion: 1,
  });
  const second = await store.claimWebhookEvent({
    eventId: "evt-race",
    eventType: "booking.updated",
    squareBookingId: BOOKING_ID,
    squareBookingVersion: 1,
  });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(first.event.processingStatus, "processing");
});

test("event durability: event is marked processed only after successful reconciliation", async () => {
  await createApprovedRequest();
  setBookingMock(makeBooking({ version: 1, durationMinutes: 30 }));
  const rawBody = makeEvent({ eventId: "evt-bad-duration", version: 1 });
  const failed = await signedRun(rawBody);
  assert.equal(failed.statusCode, 500);
  assert.equal(store.webhookEvents.get("evt-bad-duration").processingStatus, "failed");
  assert.equal(store.webhookEvents.get("evt-bad-duration").processedAt, null);
});

test("ordering: older and equal booking versions are idempotent no-ops", async () => {
  await createApprovedRequest({ squareBookingVersion: 3, startAt: "2026-11-01T15:00:00.000Z" });
  const olderLog = setBookingMock(makeBooking({ version: 2, startAt: "2026-11-01T16:00:00.000Z" }));
  const older = await signedRun(makeEvent({ eventId: "evt-older", version: 2 }));
  assert.equal(older.statusCode, 200);
  assert.equal(older.body.stale, true);
  assert.equal(new Date((await store.findRequestBySquareBookingId(BOOKING_ID)).startAt).toISOString(), "2026-11-01T15:00:00.000Z");

  setBookingMock(makeBooking({ version: 3, startAt: "2026-11-01T17:00:00.000Z" }), olderLog);
  const equal = await signedRun(makeEvent({ eventId: "evt-equal", version: 3 }));
  assert.equal(equal.statusCode, 200);
  assert.equal(equal.body.stale, true);
  assert.equal(new Date((await store.findRequestBySquareBookingId(BOOKING_ID)).startAt).toISOString(), "2026-11-01T15:00:00.000Z");
});

test("ordering: newer version reconciles and out-of-order delivery cannot restore stale state", async () => {
  await createApprovedRequest({ squareBookingVersion: 1, startAt: "2026-11-01T15:00:00.000Z" });
  setBookingMock(makeBooking({ version: 4, startAt: "2026-11-01T18:00:00.000Z" }));
  const newer = await signedRun(makeEvent({ eventId: "evt-newer", version: 4 }));
  assert.equal(newer.statusCode, 200);
  let row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareBookingVersion, 4);
  assert.equal(new Date(row.startAt).toISOString(), "2026-11-01T18:00:00.000Z");

  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-01T15:00:00.000Z" }));
  const stale = await signedRun(makeEvent({ eventId: "evt-stale-after", version: 2 }));
  assert.equal(stale.statusCode, 200);
  row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareBookingVersion, 4);
  assert.equal(new Date(row.startAt).toISOString(), "2026-11-01T18:00:00.000Z");
});

for (const [status, syncStatus, active] of [
  ["ACCEPTED", "created", true],
  ["PENDING", "created", false],
  ["DECLINED", "canceled", false],
  ["CANCELLED_BY_CUSTOMER", "canceled", false],
  ["CANCELLED_BY_SELLER", "canceled", false],
  ["NO_SHOW", "no_show", false],
]) {
  test(`status reconciliation: booking.updated ${status}`, async () => {
    await createApprovedRequest({ squareBookingVersion: 0 });
    setBookingMock(makeBooking({ version: 1, status }));
    const res = await signedRun(makeEvent({ eventId: `evt-status-${status}`, version: 1 }));
    assert.equal(res.statusCode, 200);
    const row = await store.findRequestBySquareBookingId(BOOKING_ID);
    assert.equal(row.squareBookingStatus, status);
    assert.equal(row.squareSyncStatus, syncStatus);
    assert.equal(isSquareBookingActive(row), active);
    if (status.startsWith("CANCELLED")) {
      assert.ok(row.squareCanceledAt);
    } else {
      assert.equal(row.squareCanceledAt, null);
    }
  });
}

test("status reconciliation: booking.created ACCEPTED", async () => {
  await createApprovedRequest({ squareBookingVersion: null, squareSyncStatus: "creating" });
  setBookingMock(makeBooking({ version: 1, status: "ACCEPTED" }));
  const res = await signedRun(makeEvent({ eventId: "evt-created-accepted", type: "booking.created", version: 1 }));
  assert.equal(res.statusCode, 200);
  const row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareBookingStatus, "ACCEPTED");
  assert.equal(row.squareSyncStatus, "created");
  assert.equal(row.squareBookingVersion, 1);
});

test("status reconciliation: unknown status fails safely without becoming active", async () => {
  await createApprovedRequest();
  setBookingMock(makeBooking({ version: 1, status: "ALIEN_STATUS" }));
  const res = await signedRun(makeEvent({ eventId: "evt-unknown-status", version: 1 }));
  assert.equal(res.statusCode, 200);
  const row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareSyncStatus, "failed");
  assert.match(row.squareSyncError, /unknown_status/);
  assert.equal(isSquareBookingActive(row), false);
});

test("overlaps: Square reschedule wins over pending hold and moves pending to needs_reschedule", async () => {
  await createApprovedRequest({ startAt: "2026-11-01T15:00:00.000Z", squareBookingVersion: 1 });
  const pending = await createPendingRequest("pending-overlap", "2026-11-01T17:30:00.000Z", 60);
  const adjacent = await createPendingRequest("pending-adjacent", "2026-11-01T19:00:00.000Z", 60);
  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-01T18:00:00.000Z", durationMinutes: 60 }));

  const res = await signedRun(makeEvent({ eventId: "evt-reschedule-overlap", version: 2 }));
  assert.equal(res.statusCode, 200);
  const row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareSyncStatus, "rescheduled");
  assert.equal(new Date(row.startAt).toISOString(), "2026-11-01T18:00:00.000Z");
  assert.equal((await store.getRequestById(pending.id)).status, "needs_reschedule");
  assert.equal((await store.getRequestById(adjacent.id)).status, "pending");
});

test("overlaps: 90-minute boundaries preserved on Square reschedule", async () => {
  await createApprovedRequest({ startAt: "2026-11-02T15:00:00.000Z", durationMinutes: 90, squareBookingVersion: 1 });
  const overlapping = await createPendingRequest("pending-90-overlap", "2026-11-02T15:30:00.000Z", 60);
  const adjacent = await createPendingRequest("pending-90-adjacent", "2026-11-02T17:30:00.000Z", 60);
  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-02T16:00:00.000Z", durationMinutes: 90 }));
  const res = await signedRun(makeEvent({ eventId: "evt-reschedule-90", version: 2 }));
  assert.equal(res.statusCode, 200);
  assert.equal((await store.getRequestById(overlapping.id)).status, "needs_reschedule");
  assert.equal((await store.getRequestById(adjacent.id)).status, "pending");
});

test("overlaps: approving race fails safely and records retryable safe error", async () => {
  await createApprovedRequest({ startAt: "2026-11-03T15:00:00.000Z", squareBookingVersion: 1 });
  const race = await createPendingRequest("approving-race", "2026-11-03T18:30:00.000Z", 60);
  await store.claimForApproval(race.id);
  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-03T18:00:00.000Z", durationMinutes: 60 }));
  const res = await signedRun(makeEvent({ eventId: "evt-approving-race", version: 2 }));
  assert.equal(res.statusCode, 500);
  assert.equal(store.webhookEvents.get("evt-approving-race").processingStatus, "failed");
  assert.equal(store.webhookEvents.get("evt-approving-race").safeErrorCode, "approving_overlap");
  assert.equal((await store.getRequestById(race.id)).status, "approving");
});

test("unknown local booking ids are durably ignored without creating rows", async () => {
  setBookingMock(makeBooking({ id: "bk-unknown", version: 1 }));
  const res = await signedRun(makeEvent({ eventId: "evt-unknown-booking", bookingId: "bk-unknown", version: 1 }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(store.webhookEvents.get("evt-unknown-booking").processingStatus, "ignored");
});

test("unsupported event types are accepted but ignored; booking.canceled is not invented", async () => {
  const rawBody = makeEvent({ eventId: "evt-unsupported", type: "booking.canceled", version: 1 });
  const res = await signedRun(rawBody);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true, ignored: true });
  assert.equal(store.webhookEvents.has("evt-unsupported"), false);
});

test("Square test event shape uses canonical booking id and accepts version zero", async () => {
  const canonicalBookingId = "bk-canonical-zero";
  await createApprovedRequest({
    requestKey: "req-composite-zero",
    squareBookingId: canonicalBookingId,
    squareBookingVersion: null,
    squareSyncStatus: "creating",
  });

  const calls = { get: 0, bookingId: null, requestOptions: null, created: 0, customers: 0 };
  setSquareClientForTests({
    bookings: {
      get: async ({ bookingId }, requestOptions) => {
        calls.get += 1;
        calls.bookingId = bookingId;
        calls.requestOptions = requestOptions;
        return { booking: makeBooking({ id: canonicalBookingId, version: 0, status: "ACCEPTED" }) };
      },
      searchAvailability: async () => ({ availabilities: [] }),
      create: async () => {
        calls.created += 1;
        return { booking: { id: "unused" } };
      },
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async () => {
        calls.customers += 1;
        return { customer: { id: "unused" } };
      },
    },
  });

  const res = await signedRun(
    makeCompositeTestEvent({
      eventId: "evt-composite-zero",
      canonicalBookingId,
      version: 0,
    }),
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(calls.get, 1);
  assert.equal(calls.bookingId, canonicalBookingId);
  assert.equal(calls.bookingId.includes(":"), false);
  assert.equal(
    calls.requestOptions.timeoutInSeconds,
    webhookTestInternals.SQUARE_RETRIEVE_TIMEOUT_SECONDS,
  );
  assert.equal(calls.requestOptions.maxRetries, 0);
  assert.equal(calls.created, 0);
  assert.equal(calls.customers, 0);

  const row = await store.findRequestBySquareBookingId(canonicalBookingId);
  assert.equal(row.squareBookingVersion, 0);
  assert.equal(row.squareBookingStatus, "ACCEPTED");
  assert.equal(store.webhookEvents.get("evt-composite-zero").processingStatus, "processed");
});

test("Square test event shape for nonexistent booking fails safely and remains retryable", async () => {
  const canonicalBookingId = "bk-does-not-exist";
  const calls = {
    get: 0,
    bookingIds: [],
    requestOptions: [],
    created: 0,
    searchedAvailability: 0,
    customerSearches: 0,
    customersCreated: 0,
  };
  setSquareClientForTests({
    bookings: {
      get: async ({ bookingId }, requestOptions) => {
        calls.get += 1;
        calls.bookingIds.push(bookingId);
        calls.requestOptions.push(requestOptions);
        return { booking: null };
      },
      searchAvailability: async () => {
        calls.searchedAvailability += 1;
        return { availabilities: [] };
      },
      create: async () => {
        calls.created += 1;
        return { booking: { id: "unused" } };
      },
    },
    customers: {
      search: async () => {
        calls.customerSearches += 1;
        return { customers: [] };
      },
      create: async () => {
        calls.customersCreated += 1;
        return { customer: { id: "unused" } };
      },
    },
  });

  const rawBody = makeCompositeTestEvent({
    eventId: "evt-missing-composite-zero",
    canonicalBookingId,
    version: 0,
  });
  const signature = computeSignature(rawBody);
  const beforeRows = store.rows.size;
  const logs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  let first;
  let retry;
  try {
    first = await run({ rawBody, headers: { "x-square-hmacsha256-signature": signature } });
    retry = await run({ rawBody, headers: { "x-square-hmacsha256-signature": signature } });
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  assert.equal(first.statusCode, 500);
  assert.equal(retry.statusCode, 500);
  assert.match(first.body.error, /Could not reconcile Square booking right now/);
  assert.deepEqual(calls.bookingIds, [canonicalBookingId, canonicalBookingId]);
  assert.equal(calls.bookingIds.some((id) => id.includes(":")), false);
  for (const requestOptions of calls.requestOptions) {
    assert.equal(
      requestOptions.timeoutInSeconds,
      webhookTestInternals.SQUARE_RETRIEVE_TIMEOUT_SECONDS,
    );
    assert.equal(requestOptions.maxRetries, 0);
  }

  const event = store.webhookEvents.get("evt-missing-composite-zero");
  assert.equal(event.processingStatus, "failed");
  assert.equal(event.safeErrorCode, "square_booking_missing");
  assert.equal(event.processedAt, null);
  assert.equal(event.squareBookingVersion, 0);
  assert.equal(event.squareBookingId, canonicalBookingId);
  assert.equal(event.attemptCount, 2);

  assert.equal(store.rows.size, beforeRows);
  assert.equal(store.subscriptions.size, 0);
  assert.equal(calls.searchedAvailability, 0);
  assert.equal(calls.created, 0);
  assert.equal(calls.customerSearches, 0);
  assert.equal(calls.customersCreated, 0);

  const joined = logs.join("\n");
  assert.doesNotMatch(joined, new RegExp(SIGNATURE_KEY));
  assert.equal(joined.includes(canonicalBookingId), false);
  assert.equal(joined.includes(rawBody), false);
  assert.doesNotMatch(joined, /x-square|hmac|signature/i);
});

test("webhook external dependencies use conservative bounded budgets", async () => {
  assert.equal(webhookTestInternals.SQUARE_RETRIEVE_TIMEOUT_SECONDS, 2);

  const pool = createNeonPool("postgres://user:pass@localhost/db");
  try {
    assert.equal(pool.options.statement_timeout, 500);
    assert.equal(pool.options.connectionTimeoutMillis, 1000);
  } finally {
    await pool.end().catch(() => {});
  }
});

test("delayed Square retrieval failure returns before total budget and stays retryable", async () => {
  const canonicalBookingId = "bk-delayed-fetch";
  const calls = { get: 0, requestOptions: null, created: 0, customersCreated: 0 };
  setSquareClientForTests({
    bookings: {
      get: async ({ bookingId }, requestOptions) => {
        assert.equal(bookingId, canonicalBookingId);
        calls.get += 1;
        calls.requestOptions = requestOptions;
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("simulated_square_timeout");
      },
      searchAvailability: async () => ({ availabilities: [] }),
      create: async () => {
        calls.created += 1;
        return { booking: { id: "unused" } };
      },
    },
    customers: {
      search: async () => ({ customers: [] }),
      create: async () => {
        calls.customersCreated += 1;
        return { customer: { id: "unused" } };
      },
    },
  });

  const started = Date.now();
  const res = await signedRun(
    makeCompositeTestEvent({
      eventId: "evt-delayed-fetch",
      canonicalBookingId,
      version: 0,
    }),
  );
  const elapsedMs = Date.now() - started;

  assert.equal(res.statusCode, 500);
  assert.ok(elapsedMs < 1000, `expected safe failure under 1000ms, got ${elapsedMs}ms`);
  assert.equal(calls.get, 1);
  assert.equal(
    calls.requestOptions.timeoutInSeconds,
    webhookTestInternals.SQUARE_RETRIEVE_TIMEOUT_SECONDS,
  );
  assert.equal(calls.requestOptions.maxRetries, 0);
  assert.equal(calls.created, 0);
  assert.equal(calls.customersCreated, 0);

  const event = store.webhookEvents.get("evt-delayed-fetch");
  assert.equal(event.processingStatus, "failed");
  assert.equal(event.safeErrorCode, "square_fetch_failed");
  assert.equal(event.processedAt, null);
  assert.equal(event.attemptCount, 1);
});

test("missing or malformed canonical booking id never falls back to composite data.id", async () => {
  for (const [name, bookingObject] of [
    ["missing", { status: "ACCEPTED", version: 0 }],
    ["malformed", { id: "bk-malformed:0", status: "ACCEPTED", version: 0 }],
  ]) {
    let fetches = 0;
    setSquareClientForTests({
      bookings: {
        get: async () => {
          fetches += 1;
          return { booking: null };
        },
        searchAvailability: async () => ({ availabilities: [] }),
        create: async () => ({ booking: { id: "unused" } }),
      },
      customers: {
        search: async () => ({ customers: [] }),
        create: async () => ({ customer: { id: "unused" } }),
      },
    });

    const eventId = `evt-${name}-canonical-id`;
    const rawBody = JSON.stringify({
      merchant_id: "merchant-safe",
      location_id: "LOC_SAFE",
      type: "booking.created",
      event_id: eventId,
      created_at: "2026-08-12T16:31:01Z",
      data: {
        type: "booking",
        id: "bk-composite-only:0",
        object: { booking: bookingObject },
      },
    });
    const res = await signedRun(rawBody);
    const event = store.webhookEvents.get(eventId);

    assert.equal(res.statusCode, 500);
    assert.equal(fetches, 0);
    assert.equal(event.processingStatus, "failed");
    assert.equal(event.safeErrorCode, "booking_id_missing");
    assert.equal(event.squareBookingId, null);
    assert.equal(event.squareBookingVersion, 0);
  }
});

test("fails safe when the raw body is unavailable (pre-parsed JSON)", async () => {
  const parsedEvent = JSON.parse(makeEvent());
  const res = await run({
    body: parsedEvent,
    headers: { "x-square-hmacsha256-signature": "unused" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /raw request body/i);
});
