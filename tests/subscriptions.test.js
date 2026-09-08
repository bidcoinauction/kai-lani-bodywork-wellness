import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bookingRequestsHandler from "../api/square/booking-requests/index.js";
import unsubscribeHandler from "../api/square/unsubscribe.js";
import { hashToken } from "../lib/tokens.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import { setSquareClientForTests } from "./helpers.js";
import {
  makeBody,
  futureSlotAt,
  installGateEnv,
  installEmailEnv,
  makeSquareMock,
  captureEmailCalls,
  post,
  get,
  setupBookingTest,
  teardownBookingTest,
} from "./booking-test-utils.js";

let store;

beforeEach(() => {
  store = new MemoryBookingRequestStore();
  setupBookingTest(store);
});

afterEach(() => {
  teardownBookingTest();
});

test("marketing consent is optional, unchecked by default, and separate from appointment communication", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  // No marketingConsent field at all.
  const res = await post(bookingRequestsHandler, makeBody());
  assert.equal(res.statusCode, 201);
  assert.equal(await store.getSubscriptionByEmail("ava@example.invalid"), null);

  // Explicit false creates nothing.
  await post(
    bookingRequestsHandler,
    makeBody({
      requestKey: "req_test_consent_false_1",
      startAt: futureSlotAt(7200),
      marketingConsent: false,
    }),
  );
  assert.equal(await store.getSubscriptionByEmail("ava@example.invalid"), null);

  // True creates a subscription with the booking-form source.
  await post(
    bookingRequestsHandler,
    makeBody({
      requestKey: "req_test_consent_true_12",
      startAt: futureSlotAt(8640),
      marketingConsent: true,
    }),
  );
  const sub = await store.getSubscriptionByEmail("ava@example.invalid");
  assert.ok(sub);
  assert.equal(sub.status, "subscribed");
  assert.equal(sub.consentSource, "kai-lani-booking-form");
  assert.ok(sub.consentAt);
  assert.ok(sub.unsubscribeTokenHash);
});

test("consent false never subscribes and never returns a subscription token to the API", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();
  const logs = [];
  const originalInfo = console.info;
  console.info = (message) => logs.push(String(message));

  try {
    const res = await post(
      bookingRequestsHandler,
      makeBody({ requestKey: "req_test_no_mkt_consent" }),
    );
    assert.equal(res.statusCode, 201);
    assert.doesNotMatch(JSON.stringify(res.body), /unsubscribe|subscription|rawToken/i);
    assert.equal(await store.getSubscriptionByEmail("ava@example.invalid"), null);
    for (const log of logs) {
      assert.doesNotMatch(log, /unsubscribe|rawToken|subscription/i);
    }
  } finally {
    console.info = originalInfo;
  }
});

test("an unsubscribed address is never re-subscribed by a later booking", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const { rawToken } = await store.subscribeEmail({
    normalizedEmail: "ava@example.invalid",
  });
  assert.equal((await store.unsubscribeByTokenHash(hashToken(rawToken))).status, "unsubscribed");

  // A later booking with marketing consent must not re-subscribe.
  const res = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_unsub_again_2", marketingConsent: true }),
  );
  assert.equal(res.statusCode, 201);
  const sub = await store.getSubscriptionByEmail("ava@example.invalid");
  assert.equal(sub.status, "unsubscribed");
});

test("unsubscribe GET is read-only, never mutates, and returns no private subscriber information", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  await post(bookingRequestsHandler, makeBody({ marketingConsent: true }));
  const { rawToken } = await store.subscribeEmail({
    normalizedEmail: "ava@example.invalid",
  });

  const res = await get(unsubscribeHandler, { token: rawToken });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /subscribed/i);
  assert.doesNotMatch(res.body, /ava@example\.invalid|980555/i);

  const sub = await store.getSubscriptionByEmail("ava@example.invalid");
  assert.equal(sub.status, "subscribed", "GET must not mutate");
});

test("unsubscribe POST unsubscribes idempotently and returns no PII", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  await post(bookingRequestsHandler, makeBody({ marketingConsent: true }));
  const { rawToken } = await store.subscribeEmail({
    normalizedEmail: "ava@example.invalid",
  });
  const token = rawToken;

  const first = await post(unsubscribeHandler, { token });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.status, "unsubscribed");
  assert.doesNotMatch(JSON.stringify(first.body), /ava@example|980555|rawToken|email/i);

  const sub = await store.getSubscriptionByEmail("ava@example.invalid");
  assert.equal(sub.status, "unsubscribed");
  assert.ok(sub.unsubscribedAt);

  const again = await post(unsubscribeHandler, { token });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.status, "unsubscribed");
});

test("unsubscribe with an invalid token returns 404", async () => {
  installGateEnv();
  const res = await post(unsubscribeHandler, { token: "not-a-real-unsubscribe-token" });
  assert.equal(res.statusCode, 404);
  const getRes = await get(unsubscribeHandler, { token: "not-a-real-unsubscribe-token" });
  assert.equal(getRes.statusCode, 404);
});

test("unsubscribe endpoints fail closed when booking approval is disabled", async () => {
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  process.env.BOOKING_APPROVAL_ENABLED = "false";
  process.env.BOOKING_APPROVAL_MODE = "sandbox";
  assert.equal((await get(unsubscribeHandler, { token: "x" })).statusCode, 503);
  assert.equal((await post(unsubscribeHandler, { token: "x" })).statusCode, 503);
});
