import { beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../api/square/booking-requests/prepay.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import { makeRequest, makeResponse, installFullConfig, clearSquareEnv, setSquareClientForTests, resetSquareClientForTests } from "./helpers.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";
import { setBookingRequestStoreForTests, resetBookingRequestStoreForTests } from "../lib/store.js";
import { buildPaymentLinkRequest, isPaymentEligible, paymentAmountForService } from "../lib/payment.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

beforeEach(() => {
  installFullConfig();
  process.env.PUBLIC_SITE_URL = "https://www.kailanibodywork.com";
});

afterEach(() => {
  clearSquareEnv();
  delete process.env.PUBLIC_SITE_URL;
  resetSquareClientForTests();
  resetBookingRequestStoreForTests();
});

async function createRow(store, status = "approved", overrides = {}) {
  const token = generateApprovalToken();
  const row = await store.createRequest({
    requestKey: overrides.requestKey || `req-${status}-${Math.random().toString(36).slice(2)}`,
    serviceKey: overrides.serviceKey || "customized_90",
    firstName: "Ava",
    lastName: "Client",
    email: "ava@example.invalid",
    phone: "+19805550100",
    startAt: "2026-10-01T15:00:00.000Z",
    durationMinutes: overrides.durationMinutes || 90,
    approvalTokenHash: hashToken(token),
    approvalTokenExpiresAt: new Date(Date.now() + 86_400_000),
  });

  if (status === "pending") return row;
  if (status === "expired") {
    await store.setApprovalTokenExpiry(row.id, new Date(Date.now() - 1000));
    await store.expirePendingRequests();
    return store.getRequestById(row.id);
  }
  if (status === "declined") return store.markDeclined({ id: row.id });
  await store.claimForApproval(row.id);
  if (status === "approving") return store.getRequestById(row.id);
  if (status === "awaiting_square_acceptance") {
    return store.markAwaitingSquareAcceptance({
      id: row.id,
      squareCustomerId: "CUST_1",
      squareBookingId: "BOOKING_1",
      squareBookingVersion: 1,
      squareBookingStatus: "PENDING",
      squareServiceVariationId: "VAR_CUSTOMIZED_90",
      squareLocationId: "LOC_SANDBOX",
      squareTeamMemberId: "TM_CHELSEA",
    });
  }
  if (status === "failed") return store.markFailed({ id: row.id, failureCode: "test" });
  if (status === "needs_reschedule") return store.markNeedsReschedule({ id: row.id });

  const approved = await store.markApproved({
    id: row.id,
    squareCustomerId: "CUST_1",
    squareBookingId: "BOOKING_1",
    squareBookingVersion: 1,
    squareBookingStatus: "ACCEPTED",
    squareServiceVariationId: "VAR_CUSTOMIZED_90",
    squareLocationId: "LOC_SANDBOX",
    squareTeamMemberId: "TM_CHELSEA",
    calendarUrl: "https://calendar.example.invalid",
  });
  if (status === "canceled") {
    const mutable = store._findById(approved.id);
    mutable.squareSyncStatus = "canceled";
    mutable.squareCanceledAt = new Date();
    return store.getRequestById(approved.id);
  }
  return approved;
}

function installStore(store) {
  setBookingRequestStoreForTests(store);
}

test("confirmed accepted booking is eligible and other states are denied", async () => {
  const store = new MemoryBookingRequestStore();
  assert.equal(isPaymentEligible(await createRow(store, "approved")), true);

  for (const status of ["pending", "approving", "awaiting_square_acceptance", "expired", "declined", "failed", "needs_reschedule", "canceled"]) {
    const nextStore = new MemoryBookingRequestStore();
    assert.equal(isPaymentEligible(await createRow(nextStore, status)), false, status);
  }
});

test("payment link endpoint denies non-confirmed states", async () => {
  for (const status of ["pending", "approving", "awaiting_square_acceptance", "expired", "declined", "failed", "needs_reschedule", "canceled"]) {
    const store = new MemoryBookingRequestStore();
    const row = await createRow(store, status);
    installStore(store);
    const res = makeResponse();
    await handler(makeRequest({ method: "POST", body: { requestKey: row.requestKey } }), res);
    assert.equal(res.statusCode, status === "expired" ? 409 : 409, status);
  }
});

test("browser-supplied amount is ignored and server price is used in cents", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRow(store, "approved", { serviceKey: "customized_90" });
  installStore(store);
  let squareRequest;
  setSquareClientForTests({
    orders: { get: async () => ({ order: { state: "OPEN", netAmountDueMoney: { amount: BigInt(12300), currency: "USD" } } }) },
    checkout: {
      paymentLinks: {
        create: async (request) => {
          squareRequest = request;
          return { paymentLink: { id: "plink_1", orderId: "order_1", url: "https://square.example/checkout" }, relatedResources: { orders: [{ id: "order_1" }] } };
        },
      },
    },
  });

  const res = makeResponse();
  await handler(makeRequest({ method: "POST", body: { requestKey: row.requestKey, amount: 1 } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(squareRequest.order.lineItems[0].basePriceMoney.amount, BigInt(12300));
  assert.equal(res.body.amount, 12300);
  assert.equal(paymentAmountForService("customized_60"), 9300);
  assert.equal(paymentAmountForService("deep_tissue_60"), 9300);
  assert.equal(paymentAmountForService("prenatal_60"), 9700);
  assert.equal(paymentAmountForService("customized_90"), 12300);
  assert.equal(paymentAmountForService("deep_tissue_90"), 12300);
});

test("repeated calls reuse one payment link and do not create duplicates", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRow(store, "approved");
  installStore(store);
  let creates = 0;
  setSquareClientForTests({
    orders: { get: async () => ({ order: { state: "OPEN", netAmountDueMoney: { amount: BigInt(12300), currency: "USD" } } }) },
    checkout: { paymentLinks: { create: async () => { creates += 1; return { paymentLink: { id: "plink_1", orderId: "order_1", url: "https://square.example/checkout" } }; } } },
  });

  for (let i = 0; i < 2; i += 1) {
    const res = makeResponse();
    await handler(makeRequest({ method: "POST", body: { requestKey: row.requestKey } }), res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(creates, 1);
  assert.equal((await store.getRequestById(row.id)).status, "approved");
});

test("return-page status does not imply paid without authoritative Square evidence", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRow(store, "approved");
  await store.recordPaymentLink({ id: row.id, squarePaymentLinkId: "plink_1", squareOrderId: "order_1", paymentLinkUrl: "https://square.example/checkout" });
  installStore(store);
  setSquareClientForTests({ orders: { get: async () => ({ order: { state: "OPEN", netAmountDueMoney: { amount: BigInt(12300), currency: "USD" } } }) } });

  const res = makeResponse();
  await handler(makeRequest({ method: "GET", query: { requestKey: row.requestKey, paid: "true" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paid, false);
  assert.notEqual(res.body.paymentStatus, "paid");
});

test("paid state appears only after Square order is paid", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRow(store, "approved");
  await store.recordPaymentLink({ id: row.id, squarePaymentLinkId: "plink_1", squareOrderId: "order_1", paymentLinkUrl: "https://square.example/checkout" });
  installStore(store);
  setSquareClientForTests({ orders: { get: async () => ({ order: { state: "COMPLETED", netAmountDueMoney: { amount: BigInt(0), currency: "USD" } } }) } });

  const res = makeResponse();
  await handler(makeRequest({ method: "GET", query: { requestKey: row.requestKey } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paid, true);
  assert.equal(res.body.paymentStatus, "paid");
  assert.equal(res.body.paymentLinkUrl, null);
  assert.equal((await store.getRequestById(row.id)).status, "approved");
});

test("payment request uses safe Square-hosted checkout fields only", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRow(store, "approved");
  const request = buildPaymentLinkRequest(row);
  const serialized = JSON.stringify(request, (_key, value) => typeof value === "bigint" ? value.toString() : value);

  assert.match(serialized, /Kai Lani Bodywork & Wellness/);
  assert.match(serialized, /allowTipping":false/);
  assert.match(serialized, /askForShippingAddress":false/);
  assert.doesNotMatch(serialized, /card|cvv|expiration|intake|medical|health/i);
});

test("payment UI and email preserve optional language", () => {
  const paymentPage = fs.readFileSync(path.join(ROOT, "src/components/PaymentPage.jsx"), "utf8");
  const email = fs.readFileSync(path.join(ROOT, "lib/email.js"), "utf8");

  assert.match(paymentPage, /Payment received/);
  assert.match(paymentPage, /pay at your appointment/i);
  assert.match(email, /You can securely prepay through Square, or pay at your appointment/);
  assert.doesNotMatch(paymentPage + email, /Complete your booking|Secure your appointment|Payment required|Reserve your spot/);
});
