import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import webhookHandler from "../api/square/webhook.js";
import workerHandler, {
  resetQStashReceiverForTests,
  setQStashReceiverForTests,
} from "../api/square/webhook-worker.js";
import { makeRequest, makeResponse, setSquareClientForTests, resetSquareClientForTests } from "./helpers.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import {
  createNeonPool,
  setBookingRequestStoreForTests,
  resetBookingRequestStoreForTests,
} from "../lib/store.js";
import { webhookTestInternals } from "../api/square/webhook.js";
import { SQUARE_RETRIEVE_TIMEOUT_SECONDS } from "../lib/square-webhook-reconcile.js";
import { isSquareBookingActive } from "../lib/booking-requests.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";
import {
  resetQStashPublisherForTests,
  setQStashPublisherForTests,
} from "../lib/qstash-publisher.js";
import {
  MAX_APPOINTMENT_SEGMENTS,
  validateSquareWebhookQueueMessage,
} from "../lib/square-webhook-message.js";

const NOTIFICATION_URL = "https://preview.example.vercel.app/api/square/webhook";
const WORKER_URL = "https://preview.example.vercel.app/api/square/webhook-worker";
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
    "QSTASH_TOKEN",
    "QSTASH_CURRENT_SIGNING_KEY",
    "QSTASH_NEXT_SIGNING_KEY",
    "QSTASH_WORKER_URL",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
  ]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  installEnv();
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
  resetQStashPublisherForTests();
  resetQStashReceiverForTests();
  store = new MemoryBookingRequestStore();
  setBookingRequestStoreForTests(store);
});

afterEach(() => {
  clearEnv();
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
  resetQStashPublisherForTests();
  resetQStashReceiverForTests();
});

function computeSignature(rawBody, url = NOTIFICATION_URL, key = SIGNATURE_KEY) {
  return crypto.createHmac("sha256", key).update(url + rawBody).digest("base64");
}

function makeEvent({ eventId, type = "booking.updated", bookingId = BOOKING_ID, version = 1, status = "ACCEPTED", startAt = "2026-11-01T15:00:00.000Z", dataId } = {}) {
  eventCounter += 1;
  return JSON.stringify({
    merchant_id: "merchant-safe",
    location_id: "LOC_SAFE",
    type,
    event_id: eventId || `evt-${eventCounter}`,
    created_at: "2026-07-30T12:00:00Z",
    data: {
      type: "booking",
      id: dataId || bookingId,
      object: {
        booking: {
          id: bookingId,
          status,
          version,
          startAt,
          locationId: "LOC_SAFE",
          appointmentSegments: [
            {
              durationMinutes: 60,
              serviceVariationId: "VAR_60",
              serviceVariationVersion: 2,
              teamMemberId: "TM_SAFE",
            },
          ],
        },
      },
    },
  });
}

function makeBooking({ id = BOOKING_ID, version = 1, status = "ACCEPTED", startAt = "2026-11-01T15:00:00.000Z", durationMinutes = 60, serviceVariationId = "VAR_60", locationId = "LOC_SAFE", teamMemberId = "TM_SAFE" } = {}) {
  return {
    id,
    version,
    status,
    startAt,
    locationId,
    appointmentSegments: [{ durationMinutes, serviceVariationId, teamMemberId, serviceVariationVersion: 2 }],
  };
}

function setBookingMock(booking, log = { get: 0 }) {
  setSquareClientForTests({
    bookings: {
      get: async ({ bookingId }, requestOptions) => {
        log.get += 1;
        log.bookingId = bookingId;
        log.requestOptions = requestOptions;
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

async function createApprovedRequest({ requestKey = "req-webhook-base", startAt = "2026-11-01T15:00:00.000Z", durationMinutes = 60, squareBookingVersion = 0, squareBookingStatus = "ACCEPTED", squareSyncStatus = "created", squareBookingId = BOOKING_ID } = {}) {
  const row = await store.createRequest({
    requestKey,
    serviceKey: durationMinutes === 90 ? "customized_90" : "customized_60",
    firstName: "Safe",
    lastName: "Client",
    email: `${requestKey}@example.invalid`,
    phone: "+19805550100",
    startAt,
    durationMinutes,
    approvalTokenHash: hashToken(generateApprovalToken()),
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

function installPublisher({ fail = false, delayMs = 0, response = { messageId: "msg_1" } } = {}) {
  const calls = [];
  setQStashPublisherForTests({
    publishSquareWebhook: async (message) => {
      calls.push(message);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (fail) throw new Error("publish failed");
      return response;
    },
  });
  return calls;
}

async function runIntake({ method = "POST", rawBody, body, headers = {} }) {
  const res = makeResponse();
  await webhookHandler(makeRequest({ method, rawBody, body, headers }), res);
  return res;
}

async function signedIntake(rawBody, headers = {}) {
  return runIntake({ rawBody, headers: { "x-square-hmacsha256-signature": computeSignature(rawBody), ...headers } });
}

function makeQueueMessage(overrides = {}) {
  return webhookTestInternals.buildSquareWebhookQueueMessage(JSON.parse(makeEvent(overrides)));
}

async function runWorker({ rawBody, headers = { "upstash-signature": "sig" }, receiver } = {}) {
  if (receiver === null) resetQStashReceiverForTests();
  else setQStashReceiverForTests(receiver || { verify: async () => true });
  const res = makeResponse();
  await workerHandler(makeRequest({ method: "POST", rawBody, headers }), res);
  return res;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signQStashJwt({ body, url, key }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      exp: now + 300,
      nbf: now - 10,
      iat: now,
      jti: "jwt-test",
      body: crypto.createHash("sha256").update(body).digest("base64url"),
    }),
  );
  const signature = crypto.createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

test("intake: valid signed booking.created publishes once and returns 202", async () => {
  const calls = installPublisher();
  const res = await signedIntake(makeEvent({ eventId: "evt-created", type: "booking.created" }));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { received: true, queued: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventId, "evt-created");
  assert.equal(calls[0].eventType, "booking.created");
});

test("intake: valid signed booking.updated publishes once", async () => {
  const calls = installPublisher();
  const res = await signedIntake(makeEvent({ eventId: "evt-updated", type: "booking.updated" }));
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventType, "booking.updated");
});

test("intake: response does not await reconciliation or touch Square/Neon/email", async () => {
  const calls = installPublisher({ delayMs: 10 });
  let squareCalls = 0;
  setSquareClientForTests({
    bookings: { get: async () => { squareCalls += 1; return { booking: null }; } },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const beforeEvents = store.webhookEvents.size;
  const res = await signedIntake(makeEvent({ eventId: "evt-intake-only" }));
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 1);
  assert.equal(squareCalls, 0);
  assert.equal(store.webhookEvents.size, beforeEvents);
  assert.equal(store.rows.size, 0);
  assert.equal(store.subscriptions.size, 0);
});

test("intake: canonical booking ID only, composite data.id ignored, version 0 accepted", async () => {
  const calls = installPublisher();
  const res = await signedIntake(
    makeEvent({ eventId: "evt-zero", bookingId: "bk-canonical-zero", dataId: "bk-composite:0", version: 0 }),
  );
  assert.equal(res.statusCode, 202);
  assert.equal(calls[0].bookingId, "bk-canonical-zero");
  assert.equal(calls[0].bookingId.includes(":"), false);
  assert.equal(calls[0].bookingVersion, 0);
});

test("intake: invalid signature, malformed JSON, malformed event and unsupported event handling", async () => {
  const calls = installPublisher();
  const invalid = await runIntake({ rawBody: makeEvent(), headers: { "x-square-hmacsha256-signature": "bad" } });
  assert.equal(invalid.statusCode, 401);
  const malformedJson = await signedIntake("{not json");
  assert.equal(malformedJson.statusCode, 400);
  const badEvent = JSON.parse(makeEvent({ eventId: "evt-bad" }));
  delete badEvent.data.object.booking.id;
  const malformedEvent = await signedIntake(JSON.stringify(badEvent));
  assert.equal(malformedEvent.statusCode, 400);
  const unsupported = await signedIntake(makeEvent({ eventId: "evt-unsupported", type: "booking.canceled" }));
  assert.equal(unsupported.statusCode, 200);
  assert.deepEqual(unsupported.body, { received: true, ignored: true });
  assert.equal(calls.length, 0);
});

test("intake: missing queue config and publish failure return retryable 503", async () => {
  const missing = await signedIntake(makeEvent({ eventId: "evt-no-queue" }));
  assert.equal(missing.statusCode, 503);
  installPublisher({ fail: true });
  const failed = await signedIntake(makeEvent({ eventId: "evt-publish-fail" }));
  assert.equal(failed.statusCode, 503);
});

test("intake: duplicate publication response returns truthful 202 and dedupe ID equals event ID", async () => {
  const calls = installPublisher({ response: { messageId: "msg_original", deduplicated: true } });
  const res = await signedIntake(makeEvent({ eventId: "evt-dedupe" }));
  assert.equal(res.statusCode, 202);
  assert.equal(calls[0].eventId, "evt-dedupe");
});

test("intake: message excludes raw body, signatures, notes and PII; logs stay safe", async () => {
  const calls = installPublisher();
  const event = JSON.parse(makeEvent({ eventId: "evt-pii" }));
  event.data.object.booking.customerNote = "client private note";
  event.data.object.booking.sellerNote = "seller private note";
  event.data.object.booking.customerId = "CUSTOMER_SECRET";
  event.data.object.booking.customer = { emailAddress: "client@example.invalid", phoneNumber: "+19805550100" };
  const rawBody = JSON.stringify(event);
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args.join(" "));
  try {
    const res = await signedIntake(rawBody);
    assert.equal(res.statusCode, 202);
  } finally {
    console.info = originalInfo;
  }
  const serialized = JSON.stringify(calls[0]);
  assert.equal(serialized.includes(rawBody), false);
  assert.doesNotMatch(serialized, /client private|seller private|client@example|980555|CUSTOMER_SECRET/i);
  const joined = logs.join("\n");
  assert.doesNotMatch(joined, new RegExp(SIGNATURE_KEY));
  assert.equal(joined.includes(rawBody), false);
  assert.doesNotMatch(joined, /client@example|980555|signature|hmac/i);
});

test("message schema: strict allowlist rejects extra keys and sensitive Square fields", async () => {
  const calls = installPublisher();
  const event = JSON.parse(makeEvent({ eventId: "evt-schema" }));
  event.data.id = "bk-composite:1";
  event.merchant_id = "merchant-not-published";
  event.data.object.booking.customerId = "customer-not-published";
  event.data.object.booking.extraSensitive = "not allowed";
  event.data.object.booking.appointmentSegments[0].sellerNote = "not allowed";
  const bad = await signedIntake(JSON.stringify(event));
  assert.equal(bad.statusCode, 400);

  delete event.data.object.booking.extraSensitive;
  delete event.data.object.booking.appointmentSegments[0].sellerNote;
  const good = await signedIntake(JSON.stringify(event));
  assert.equal(good.statusCode, 202);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "appointmentSegments",
    "bookingId",
    "bookingStartAt",
    "bookingStatus",
    "bookingVersion",
    "eventCreatedAt",
    "eventId",
    "eventType",
    "locationId",
  ].sort());
  assert.deepEqual(Object.keys(calls[0].appointmentSegments[0]).sort(), [
    "durationMinutes",
    "serviceVariationId",
    "serviceVariationVersion",
    "teamMemberId",
  ].sort());
  assert.equal(JSON.stringify(calls[0]).includes("merchant-not-published"), false);
  assert.equal(JSON.stringify(calls[0]).includes("customer-not-published"), false);
  assert.equal(JSON.stringify(calls[0]).includes("bk-composite:1"), false);
});

test("message schema: validates version zero, booking id, dates, duration, segment count and size", async () => {
  const message = makeQueueMessage({ eventId: "evt-schema-valid", version: 0 });
  assert.equal(validateSquareWebhookQueueMessage(message), message);
  for (const patch of [
    { bookingId: "" },
    { bookingId: "bk-invalid:0" },
    { eventCreatedAt: "not-a-date" },
    { bookingStartAt: "not-a-date" },
    { appointmentSegments: [{ ...message.appointmentSegments[0], durationMinutes: 30 }] },
    { appointmentSegments: Array.from({ length: MAX_APPOINTMENT_SEGMENTS + 1 }, () => message.appointmentSegments[0]) },
    { extraTopLevel: "not allowed" },
    { appointmentSegments: [{ ...message.appointmentSegments[0], extraSegment: "not allowed" }] },
    { bookingId: "b".repeat(20_000) },
  ]) {
    assert.throws(() => validateSquareWebhookQueueMessage({ ...message, ...patch }));
  }
});

test("intake timing: delayed reconciliation cannot affect response", async () => {
  installPublisher();
  setSquareClientForTests({
    bookings: { get: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return { booking: null }; } },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const started = Date.now();
  const res = await signedIntake(makeEvent({ eventId: "evt-fast-intake" }));
  const elapsedMs = Date.now() - started;
  assert.equal(res.statusCode, 202);
  assert.ok(elapsedMs < 100, `expected intake under 100ms, got ${elapsedMs}ms`);
});

test("worker: missing/invalid QStash signature rejected before parsing, DB or Square", async () => {
  let verifiedBody = null;
  let squareCalls = 0;
  setSquareClientForTests({ bookings: { get: async () => { squareCalls += 1; return { booking: null }; } } });
  const rawBody = JSON.stringify(makeQueueMessage({ eventId: "evt-worker-invalid" }));
  const invalid = await runWorker({
    rawBody,
    receiver: { verify: async ({ body }) => { verifiedBody = body; return false; } },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(verifiedBody, rawBody);
  assert.equal(squareCalls, 0);
  assert.equal(store.webhookEvents.size, 0);
  const missing = await runWorker({ rawBody, headers: {} });
  assert.equal(missing.statusCode, 401);
});

test("worker: bypass header alone cannot invoke reconciliation", async () => {
  const rawBody = JSON.stringify(makeQueueMessage({ eventId: "evt-bypass-only" }));
  const missing = await runWorker({
    rawBody,
    headers: { "x-vercel-protection-bypass": "bypass-secret" },
  });
  assert.equal(missing.statusCode, 401);
  const invalid = await runWorker({
    rawBody,
    headers: { "upstash-signature": "sig", "x-vercel-protection-bypass": "bypass-secret" },
    receiver: { verify: async () => false },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(store.webhookEvents.size, 0);
});

test("worker: configured receiver requires current and next signing keys and exact URL", async () => {
  resetQStashReceiverForTests();
  process.env.QSTASH_WORKER_URL = WORKER_URL;
  process.env.QSTASH_CURRENT_SIGNING_KEY = "current-key";
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  const missingNext = await runWorker({
    rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-missing-next" })),
    receiver: null,
  });
  assert.equal(missingNext.statusCode, 401);
});

test("worker: official Receiver accepts current key, next key, and rejects exact URL mismatch", async () => {
  await createApprovedRequest({ squareBookingVersion: null });
  setBookingMock(makeBooking({ version: 1 }));
  process.env.QSTASH_WORKER_URL = WORKER_URL;
  process.env.QSTASH_CURRENT_SIGNING_KEY = "current-signing-key";
  process.env.QSTASH_NEXT_SIGNING_KEY = "next-signing-key";

  const currentBody = JSON.stringify(makeQueueMessage({ eventId: "evt-current-key", version: 1 }));
  const current = await runWorker({
    rawBody: currentBody,
    headers: { "upstash-signature": signQStashJwt({ body: currentBody, url: WORKER_URL, key: "current-signing-key" }) },
    receiver: null,
  });
  assert.equal(current.statusCode, 200);

  const nextBody = JSON.stringify(makeQueueMessage({ eventId: "evt-next-key", version: 2 }));
  setBookingMock(makeBooking({ version: 2 }));
  const next = await runWorker({
    rawBody: nextBody,
    headers: { "upstash-signature": signQStashJwt({ body: nextBody, url: WORKER_URL, key: "next-signing-key" }) },
    receiver: null,
  });
  assert.equal(next.statusCode, 200);

  const mismatchBody = JSON.stringify(makeQueueMessage({ eventId: "evt-url-mismatch", version: 3 }));
  const mismatch = await runWorker({
    rawBody: mismatchBody,
    headers: {
      "upstash-signature": signQStashJwt({
        body: mismatchBody,
        url: "https://preview.example.vercel.app/api/square/other-worker",
        key: "current-signing-key",
      }),
    },
    receiver: null,
  });
  assert.equal(mismatch.statusCode, 401);
  assert.equal(store.webhookEvents.has("evt-url-mismatch"), false);
});

test("worker: Receiver gets the exact raw body before JSON parsing", async () => {
  const rawBody = JSON.stringify(makeQueueMessage({ eventId: "evt-exact-raw" }));
  const seen = [];
  await runWorker({
    rawBody,
    receiver: {
      verify: async ({ body, signature }) => {
        seen.push({ body, signature });
        return false;
      },
    },
  });
  assert.deepEqual(seen, [{ body: rawBody, signature: "sig" }]);
  assert.equal(store.webhookEvents.size, 0);
});

test("worker: malformed normalized message is non-retryable", async () => {
  const res = await runWorker({ rawBody: JSON.stringify({ eventId: "evt-bad" }) });
  assert.equal(res.statusCode, 489);
  assert.equal(res.headers["Upstash-NonRetryable-Error"], "true");
  assert.equal(store.webhookEvents.size, 0);
});

test("worker: transient failures are retryable and do not set non-retryable header", async () => {
  await createApprovedRequest({ squareBookingId: "bk-transient" });
  setSquareClientForTests({
    bookings: { get: async () => { throw new Error("temporary"); } },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-transient", bookingId: "bk-transient" })) });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Upstash-NonRetryable-Error"], undefined);
});

test("worker: first durable claim, duplicate processed event and failed retry", async () => {
  await createApprovedRequest();
  let fail = true;
  const calls = { get: 0 };
  setSquareClientForTests({
    bookings: {
      get: async () => {
        calls.get += 1;
        if (fail) throw new Error("temporary fetch failure");
        return { booking: makeBooking({ version: 1 }) };
      },
    },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const rawBody = JSON.stringify(makeQueueMessage({ eventId: "evt-retry", version: 1 }));
  const first = await runWorker({ rawBody });
  assert.equal(first.statusCode, 503);
  assert.equal(store.webhookEvents.get("evt-retry").processingStatus, "failed");
  fail = false;
  const retry = await runWorker({ rawBody });
  assert.equal(retry.statusCode, 200);
  assert.equal(store.webhookEvents.get("evt-retry").processingStatus, "processed");
  const duplicate = await runWorker({ rawBody });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(store.webhookEvents.get("evt-retry").attemptCount, 2);
  assert.equal(calls.get, 2);
});

for (const [status, syncStatus, active] of [
  ["ACCEPTED", "created", true],
  ["PENDING", "created", false],
  ["DECLINED", "canceled", false],
  ["CANCELLED_BY_CUSTOMER", "canceled", false],
  ["CANCELLED_BY_SELLER", "canceled", false],
  ["NO_SHOW", "no_show", false],
]) {
  test(`worker: status reconciliation ${status}`, async () => {
    await createApprovedRequest({ squareBookingVersion: 0 });
    setBookingMock(makeBooking({ version: 1, status }));
    const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: `evt-status-${status}`, version: 1, status })) });
    assert.equal(res.statusCode, 200);
    const row = await store.findRequestBySquareBookingId(BOOKING_ID);
    assert.equal(row.squareBookingStatus, status);
    assert.equal(row.squareSyncStatus, syncStatus);
    assert.equal(isSquareBookingActive(row), active);
    if (status.startsWith("CANCELLED")) assert.ok(row.squareCanceledAt);
    else assert.equal(row.squareCanceledAt, null);
  });
}

test("worker: authoritative Square booking missing remains retryable", async () => {
  setSquareClientForTests({
    bookings: {
      get: async () => ({ booking: null }),
      searchAvailability: async () => ({ availabilities: [] }),
      create: async () => ({ booking: { id: "unused" } }),
    },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-square-missing", bookingId: "bk-square-missing", version: 0 })) });
  assert.equal(res.statusCode, 503);
  const event = store.webhookEvents.get("evt-square-missing");
  assert.equal(event.processingStatus, "failed");
  assert.equal(event.safeErrorCode, "square_booking_missing");
  assert.equal(event.processedAt, null);
  assert.equal(event.attemptCount, 1);
});

test("worker: stale processing recovery claims old processing event", async () => {
  await createApprovedRequest();
  setBookingMock(makeBooking({ version: 1 }));
  const event = await store.claimWebhookEvent({
    eventId: "evt-stale-processing",
    eventType: "booking.updated",
    squareBookingId: BOOKING_ID,
    squareBookingVersion: 1,
  });
  assert.equal(event.claimed, true);
  store.webhookEvents.get("evt-stale-processing").processingStartedAt = new Date(Date.now() - 11 * 60 * 1000);
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-stale-processing" })) });
  assert.equal(res.statusCode, 200);
  assert.equal(store.webhookEvents.get("evt-stale-processing").attemptCount, 2);
  assert.equal(store.webhookEvents.get("evt-stale-processing").processingStatus, "processed");
});

test("worker: canonical ID, version 0, successful reconcile and Square timeout options", async () => {
  const canonicalBookingId = "bk-canonical-zero";
  await createApprovedRequest({ requestKey: "req-zero", squareBookingId: canonicalBookingId, squareBookingVersion: null, squareSyncStatus: "creating" });
  const calls = setBookingMock(makeBooking({ id: canonicalBookingId, version: 0 }));
  const res = await runWorker({
    rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-zero-worker", bookingId: canonicalBookingId, dataId: `${canonicalBookingId}:0`, version: 0 })),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.bookingId, canonicalBookingId);
  assert.equal(calls.bookingId.includes(":"), false);
  assert.equal(calls.requestOptions.timeoutInSeconds, SQUARE_RETRIEVE_TIMEOUT_SECONDS);
  assert.equal(calls.requestOptions.maxRetries, 0);
  const row = await store.findRequestBySquareBookingId(canonicalBookingId);
  assert.equal(row.squareBookingVersion, 0);
  assert.equal(row.squareBookingStatus, "ACCEPTED");
});

test("worker: out-of-order version ignored as stale", async () => {
  await createApprovedRequest({ squareBookingVersion: 3, startAt: "2026-11-01T15:00:00.000Z" });
  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-01T18:00:00.000Z" }));
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-old", version: 2 })) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stale, true);
  const row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(new Date(row.startAt).toISOString(), "2026-11-01T15:00:00.000Z");
});

test("worker: Square retrieval timeout/failure persists safe failed state", async () => {
  await createApprovedRequest({ squareBookingId: "bk-timeout" });
  setSquareClientForTests({
    bookings: { get: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); throw new Error("timeout"); } },
    customers: { search: async () => ({ customers: [] }), create: async () => ({ customer: { id: "unused" } }) },
  });
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-timeout", bookingId: "bk-timeout" })) });
  assert.equal(res.statusCode, 503);
  const event = store.webhookEvents.get("evt-timeout");
  assert.equal(event.processingStatus, "failed");
  assert.equal(event.safeErrorCode, "square_fetch_failed");
  assert.equal(event.processedAt, null);
});

test("worker: cancellation, no-show and unknown local booking handling", async () => {
  await createApprovedRequest({ squareBookingVersion: 0 });
  setBookingMock(makeBooking({ version: 1, status: "CANCELLED_BY_CUSTOMER" }));
  const canceled = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-cancel", version: 1, status: "CANCELLED_BY_CUSTOMER" })) });
  assert.equal(canceled.statusCode, 200);
  let row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareSyncStatus, "canceled");
  assert.ok(row.squareCanceledAt);

  setBookingMock(makeBooking({ version: 2, status: "NO_SHOW" }));
  const noShow = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-noshow", version: 2, status: "NO_SHOW" })) });
  assert.equal(noShow.statusCode, 200);
  row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareSyncStatus, "no_show");
  assert.equal(isSquareBookingActive(row), false);

  setBookingMock(makeBooking({ id: "bk-unknown", version: 1 }));
  const unknown = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-unknown", bookingId: "bk-unknown" })) });
  assert.equal(unknown.statusCode, 200);
  assert.equal(unknown.body.ignored, true);
  assert.equal(store.webhookEvents.get("evt-unknown").processingStatus, "ignored");
});

test("worker: unknown status fails safely without email or business-record creation", async () => {
  await createApprovedRequest({ squareBookingVersion: 0 });
  setBookingMock(makeBooking({ version: 1, status: "ALIEN_STATUS" }));
  const beforeRows = store.rows.size;
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-unknown-status", status: "ALIEN_STATUS" })) });
  assert.equal(res.statusCode, 200);
  const row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareSyncStatus, "failed");
  assert.match(row.squareSyncError, /unknown_status/);
  assert.equal(store.rows.size, beforeRows);
  assert.equal(store.subscriptions.size, 0);
});

test("worker: Square reschedule moves pending hold but does not create records or email", async () => {
  await createApprovedRequest({ startAt: "2026-11-01T15:00:00.000Z", squareBookingVersion: 1 });
  const pending = await createPendingRequest("pending-overlap", "2026-11-01T17:30:00.000Z", 60);
  const adjacent = await createPendingRequest("pending-adjacent", "2026-11-01T19:00:00.000Z", 60);
  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-01T18:00:00.000Z" }));
  const beforeRows = store.rows.size;
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-reschedule", version: 2, startAt: "2026-11-01T18:00:00.000Z" })) });
  assert.equal(res.statusCode, 200);
  const row = await store.findRequestBySquareBookingId(BOOKING_ID);
  assert.equal(row.squareSyncStatus, "rescheduled");
  assert.equal((await store.getRequestById(pending.id)).status, "needs_reschedule");
  assert.equal((await store.getRequestById(adjacent.id)).status, "pending");
  assert.equal(store.rows.size, beforeRows);
  assert.equal(store.subscriptions.size, 0);
});

test("worker: approving overlap race fails safely and remains retryable", async () => {
  await createApprovedRequest({ startAt: "2026-11-03T15:00:00.000Z", squareBookingVersion: 1 });
  const race = await createPendingRequest("approving-race", "2026-11-03T18:30:00.000Z", 60);
  await store.claimForApproval(race.id);
  setBookingMock(makeBooking({ version: 2, startAt: "2026-11-03T18:00:00.000Z" }));
  const res = await runWorker({ rawBody: JSON.stringify(makeQueueMessage({ eventId: "evt-approving-race", version: 2, startAt: "2026-11-03T18:00:00.000Z" })) });
  assert.equal(res.statusCode, 503);
  assert.equal(store.webhookEvents.get("evt-approving-race").processingStatus, "failed");
  assert.equal(store.webhookEvents.get("evt-approving-race").safeErrorCode, "approving_overlap");
  assert.equal((await store.getRequestById(race.id)).status, "approving");
});

test("worker: safe logs only", async () => {
  await createApprovedRequest();
  setBookingMock(makeBooking({ version: 1 }));
  const rawBody = JSON.stringify(makeQueueMessage({ eventId: "evt-safe-logs" }));
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args.join(" "));
  try {
    const res = await runWorker({ rawBody });
    assert.equal(res.statusCode, 200);
  } finally {
    console.info = originalInfo;
  }
  const joined = logs.join("\n");
  assert.equal(joined.includes(rawBody), false);
  assert.equal(joined.includes(BOOKING_ID), false);
  assert.doesNotMatch(joined, /signature|upstash|client@example|980555/i);
});

test("webhook external dependencies use conservative bounded budgets", async () => {
  assert.equal(webhookTestInternals.SQUARE_RETRIEVE_TIMEOUT_SECONDS, 2);
  assert.equal(webhookTestInternals.QSTASH_PUBLISH_TIMEOUT_MS, 2500);
  const pool = createNeonPool("postgres://user:pass@localhost/db");
  try {
    assert.equal(pool.options.statement_timeout, 500);
    assert.equal(pool.options.connectionTimeoutMillis, 1000);
  } finally {
    await pool.end().catch(() => {});
  }
});

test("fails safe when the raw body is unavailable (pre-parsed JSON)", async () => {
  const parsedEvent = JSON.parse(makeEvent());
  const res = await runIntake({ body: parsedEvent, headers: { "x-square-hmacsha256-signature": "unused" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /raw request body/i);
});
