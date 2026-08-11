import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bookingRequestsHandler from "../api/square/booking-requests/index.js";
import approveHandler from "../api/square/booking-requests/approve.js";
import declineHandler from "../api/square/booking-requests/decline.js";
import lookupHandler from "../api/square/booking-requests/lookup.js";
import {
  buildCustomerIdempotencyKey,
  buildSquareIdempotencyKey,
} from "../lib/booking-requests.js";
import { approvalTokenTtlMinutes } from "../lib/tokens.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import { setSquareClientForTests } from "./helpers.js";
import {
  SLOT,
  REQUEST_KEY,
  makeBody,
  installGateEnv,
  installEmailEnv,
  makeSquareMock,
  captureEmailCalls,
  failEmailBySubject,
  approvalTokenFromEmails,
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

test("BOOKING_APPROVAL_TOKEN_TTL_MINUTES defaults to 120 and honors the override", () => {
  delete process.env.BOOKING_APPROVAL_TOKEN_TTL_MINUTES;
  assert.equal(approvalTokenTtlMinutes(), 120);
  process.env.BOOKING_APPROVAL_TOKEN_TTL_MINUTES = "45";
  assert.equal(approvalTokenTtlMinutes(), 45);
  process.env.BOOKING_APPROVAL_TOKEN_TTL_MINUTES = "not-a-number";
  assert.equal(approvalTokenTtlMinutes(), 120);
});

test("contact consent is explicit and required: missing or false consent is rejected with 400", async () => {
  installGateEnv();
  const { contactConsent, ...withoutConsent } = makeBody();
  assert.equal((await post(bookingRequestsHandler, withoutConsent)).statusCode, 400);
  assert.equal((await post(bookingRequestsHandler, makeBody({ contactConsent: false }))).statusCode, 400);
  assert.equal((await post(bookingRequestsHandler, makeBody({ contactConsent: 1 }))).statusCode, 400);
});

test("consent is never inferred: a consent-free payload never reaches Square", async () => {
  installGateEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const { contactConsent, ...withoutConsent } = makeBody();
  const res = await post(bookingRequestsHandler, withoutConsent);
  assert.equal(res.statusCode, 400);
  assert.equal(state.availabilityCalls, 0);
});

test("expired pending requests are swept to expired and release their hold before a new request", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  assert.equal(a.statusCode, 201);
  await store.setApprovalTokenExpiry(a.body.requestId, new Date(Date.now() - 60_000));

  const b = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_second_key_123456" }),
  );
  assert.equal(b.statusCode, 201, JSON.stringify(b.body));

  const rowA = await store.getRequestById(a.body.requestId);
  assert.equal(rowA.status, "expired");
  assert.ok(rowA.decidedAt);

  const rowB = await store.getRequestById(b.body.requestId);
  assert.equal(rowB.status, "pending");
  assert.equal(new Date(rowB.startAt).getTime(), new Date(SLOT).getTime());
});

test("an expired approval token cannot approve or decline", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.ok(token);
  await store.setApprovalTokenExpiry(a.body.requestId, new Date(Date.now() - 1000));

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /invalid or has expired/i);
  assert.equal(state.createCalls.length, 0);

  const decline = await post(declineHandler, { token });
  assert.equal(decline.statusCode, 404);
  // The approve attempt's expiry sweep already moved the row to expired; it
  // was never decided by either action.
  assert.equal((await store.getRequestById(a.body.requestId)).status, "expired");
});

test("an approved request no longer holds the slot (Square availability is the source of truth)", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.equal((await post(approveHandler, { token })).statusCode, 200);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "approved");

  const b = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_after_approve_123" }),
  );
  assert.equal(b.statusCode, 201, "approved row must not block a new request");
});

test("an approving request still holds the slot", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  await store.claimForApproval(a.body.requestId);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "approving");

  const b = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_approving_hold_1" }),
  );
  assert.equal(b.statusCode, 409);
  assert.match(b.body.error, /no longer available/);
});

test("a declined request releases its hold", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  assert.equal((await post(declineHandler, { token })).statusCode, 200);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "declined");

  const b = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_after_decline_12" }),
  );
  assert.equal(b.statusCode, 201, "declined row must not block a new request");
});

test("resuming an approving request reuses the deterministic booking key and never creates a duplicate", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const key = buildSquareIdempotencyKey(a.body.requestId);

  const claimed = await store.claimForApproval(a.body.requestId);
  assert.equal(claimed.status, "approving");
  assert.equal(claimed.approvalAttemptCount, 1);

  // Crash window: Square ACCEPTED the booking but the function died before DB
  // finalization.
  await client.bookings.create({ idempotencyKey: key, booking: {} });
  let row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "approving");
  assert.equal(row.squareBookingId, null);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "approved");
  row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "approved");
  assert.equal(row.squareBookingId, "BK_APPROVED_1");
  assert.equal(row.approvalAttemptCount, 2);

  assert.equal(state.createCalls.length, 2);
  assert.equal(state.createCalls[0].idempotencyKey, key);
  assert.equal(state.createCalls[1].idempotencyKey, key);

  const clientEmails = emails.filter((c) =>
    String(c.body.subject).includes("appointment is confirmed"),
  );
  assert.equal(clientEmails.length, 1, "one confirmation despite two attempts");
});

test("email failure after approval never marks the request failed; resubmit retries only the unsent notification", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);

  const firstCalls = captureEmailCalls(failEmailBySubject("Appointment approved"));
  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(firstCalls);

  const first = await post(approveHandler, { token });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.notification.confirmation, "sent");
  assert.equal(first.body.notification.provider, "failed");

  let row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "approved", "email failure must not fail the appointment");
  assert.equal(row.squareBookingId, "BK_APPROVED_1");
  assert.equal(row.confirmationEmailStatus, "sent");
  assert.equal(row.providerConfirmationEmailStatus, "failed");

  const secondCalls = captureEmailCalls();
  const second = await post(approveHandler, { token });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.notification.confirmation, "sent");
  assert.equal(second.body.notification.provider, "sent");

  row = await store.getRequestById(a.body.requestId);
  assert.equal(row.providerConfirmationEmailStatus, "sent");

  assert.equal(state.createCalls.length, 1, "no duplicate Square booking on retry");

  const clientEmailCount = [...firstCalls, ...secondCalls].filter((c) =>
    String(c.body.subject).includes("appointment is confirmed"),
  ).length;
  const providerEmailCount = [...firstCalls, ...secondCalls].filter((c) =>
    String(c.body.subject).includes("Appointment approved"),
  ).length;
  assert.equal(clientEmailCount, 1, "client confirmation never duplicated");
  assert.equal(providerEmailCount, 2, "provider retried once after failure");
  const retryClientAttempts = secondCalls.filter((c) =>
    String(c.body.subject).includes("appointment is confirmed"),
  ).length;
  assert.equal(retryClientAttempts, 0);
});

test("customer matching: both email and phone resolve to the same customer -> reuse, no create", async () => {
  installGateEnv();
  installEmailEnv();
  const customer = { id: "CUST_SAME", emailAddress: "ava@example.invalid" };
  const { client, state } = makeSquareMock({
    customers: {
      search: async (request) => {
        const filter = request.query.filter;
        if (filter.emailAddress || filter.phoneNumber) return { customers: [customer] };
        return { customers: [] };
      },
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.createCalls[0].booking.customerId, "CUST_SAME");
  assert.equal(state.customerCreateCalls.length, 0);
});

test("customer matching: email resolves, phone does not -> reuse email customer without overwriting", async () => {
  installGateEnv();
  installEmailEnv();
  const emailCustomer = { id: "CUST_EMAIL" };
  const { client, state } = makeSquareMock({
    customers: {
      search: async (request) => {
        const filter = request.query.filter;
        if (filter.emailAddress) return { customers: [emailCustomer] };
        return { customers: [] };
      },
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(state.createCalls[0].booking.customerId, "CUST_EMAIL");
  assert.equal(state.customerCreateCalls.length, 0);
});

test("customer matching: phone resolves, email does not -> reuse phone customer", async () => {
  installGateEnv();
  installEmailEnv();
  const phoneCustomer = { id: "CUST_PHONE" };
  const { client, state } = makeSquareMock({
    customers: {
      search: async (request) => {
        const filter = request.query.filter;
        if (filter.phoneNumber) return { customers: [phoneCustomer] };
        return { customers: [] };
      },
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(state.createCalls[0].booking.customerId, "CUST_PHONE");
  assert.equal(state.customerCreateCalls.length, 0);
});

test("customer matching: email and phone resolve to different customers -> stop for manual review (409, failed)", async () => {
  installGateEnv();
  installEmailEnv();
  const emailCustomer = { id: "CUST_EMAIL" };
  const phoneCustomer = { id: "CUST_PHONE" };
  const { client, state } = makeSquareMock({
    customers: {
      search: async (request) => {
        const filter = request.query.filter;
        if (filter.emailAddress) return { customers: [emailCustomer] };
        if (filter.phoneNumber) return { customers: [phoneCustomer] };
        return { customers: [] };
      },
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /manual review/i);
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.customerCreateCalls.length, 0);

  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "customer_conflict");
});

test("customer matching: neither resolves -> exactly one customer is created, no note, deterministic key", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.customerCreateCalls.length, 1);
  const createReq = state.customerCreateCalls[0];
  assert.equal(createReq.idempotencyKey, buildCustomerIdempotencyKey(a.body.requestId));
  assert.equal(createReq.customer.givenName, "Ava");
  assert.equal(createReq.customer.emailAddress, "ava@example.invalid");
  assert.equal("note" in createReq.customer, false, "never writes a Customer Directory note");
  assert.equal(state.createCalls[0].booking.customerId, "CUST_APPROVE_1");
});

test("customer matching: retries never create duplicate customers (idempotent create key)", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const key = buildCustomerIdempotencyKey(a.body.requestId);

  await store.claimForApproval(a.body.requestId);
  await client.customers.create({ idempotencyKey: key, customer: {} });

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.createCalls[0].booking.customerId, "CUST_APPROVE_1");
  const usedKeys = state.customerCreateCalls.map((c) => c.idempotencyKey);
  assert.ok(usedKeys.length >= 2);
  for (const usedKey of usedKeys) {
    assert.equal(usedKey, key, "every customer create uses the same key");
  }
});

test("a Square create error marks the request failed and it cannot re-approve", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({
    bookingsCreate: async () => {
      throw { statusCode: 429 };
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 429);
  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "square_error");

  const again = await post(approveHandler, { token });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.status, "failed");
  assert.equal(state.createCalls.length, 1);

  const summary = await get(approveHandler, { token });
  assert.equal(summary.body.status, "failed");
  assert.equal(summary.body.failureCode, "square_error");
});

test("concurrent approve and decline cannot both succeed", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);

  // Decline races after approval already claimed: must lose.
  const row = await store.getRequestByKey(REQUEST_KEY);
  await store.claimForApproval(row.id);
  const declined = await post(declineHandler, { token });
  assert.equal(declined.statusCode, 409);
  assert.match(declined.body.error, /being processed/);

  const approved = await post(approveHandler, { token });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(state.createCalls.length, 1);
});

test("approve/decline responses and GET endpoints never leak the raw token and GET never mutates", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);

  const summary = await get(approveHandler, { token });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.body.status, "pending");
  assert.doesNotMatch(JSON.stringify(summary.body), new RegExp(token, "i"));
  assert.equal((await store.getRequestById(a.body.requestId)).status, "pending", "GET must not mutate");

  const approved = await post(approveHandler, { token });
  assert.doesNotMatch(JSON.stringify(approved.body), new RegExp(token, "i"));

  const declined = await post(declineHandler, { token });
  assert.doesNotMatch(JSON.stringify(declined.body), new RegExp(token, "i"));

  const lookup = await get(lookupHandler, { requestKey: REQUEST_KEY });
  assert.doesNotMatch(JSON.stringify(lookup.body), /token|approvalTokenHash/i);
});

test("approval summary reports decided=false for approving and a failure code for failed", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const row = await store.getRequestByKey(REQUEST_KEY);
  await store.claimForApproval(row.id);

  const summary = await get(approveHandler, { token });
  assert.equal(summary.body.status, "approving");
  assert.equal(summary.body.decided, false);
});
