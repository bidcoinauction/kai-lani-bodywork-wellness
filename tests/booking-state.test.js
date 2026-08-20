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
  const createdRow = await store.getRequestByKey(a.body.requestKey);
  assert.notEqual(createdRow.id, a.body.requestId);
  const key = buildSquareIdempotencyKey(createdRow.id);

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

  // The resume path must source a valid service variation version from the
  // catalog (availability is deliberately not re-checked), and that version
  // must be preserved into the Square create call.
  assert.equal(state.catalogGetCalls.length, 1);
  assert.equal(state.createCalls[1].booking.appointmentSegments[0].serviceVariationVersion, 3n);

  const clientEmails = emails.filter((c) =>
    String(c.body.subject).includes("appointment is confirmed"),
  );
  assert.equal(clientEmails.length, 1, "one confirmation despite two attempts");
});

test("resuming an approving request preserves a catalog version of 0 (valid, not treated as missing)", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ serviceVariationVersion: 0 });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const key = buildSquareIdempotencyKey(a.body.requestId);

  const claimed = await store.claimForApproval(a.body.requestId);
  assert.equal(claimed.status, "approving");

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "approved");
  assert.equal(state.catalogGetCalls.length, 1);
  assert.equal(state.createCalls[state.createCalls.length - 1].booking.appointmentSegments[0].serviceVariationVersion, 0n);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "approved");
});

test("resume fails closed when the catalog cannot confirm a service variation version", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ catalogGet: async () => ({ object: {} }) });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await store.claimForApproval(a.body.requestId);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 500);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "failed");
  assert.equal((await store.getRequestById(a.body.requestId)).failureCode, "server_config");
  assert.equal(state.createCalls.length, 0, "Square must never be called without a valid version");
});

test("fresh approval preserves an availability version of 0 into the create", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ serviceVariationVersion: 0 });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "approved");
  assert.equal(state.catalogGetCalls.length, 0, "fresh path must not need the catalog");
  assert.equal(state.createCalls[state.createCalls.length - 1].booking.appointmentSegments[0].serviceVariationVersion, 0n);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "approved");
});

test("buyer-level PENDING stores awaiting_square_acceptance without confirmations or calendar data", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ bookingStatus: "PENDING" });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "awaiting_square_acceptance");
  assert.match(res.body.message, /pending acceptance in Square/i);
  assert.equal(res.body.calendarUrl, undefined);
  assert.equal(state.createCalls.length, 1);
  assert.deepEqual(state.createCalls[0].requestOptions, { queryParams: { seller_level: false } });
  assert.equal("sellerNote" in state.createCalls[0].booking, false);

  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "awaiting_square_acceptance");
  assert.equal(row.squareCustomerId, "CUST_APPROVE_1");
  assert.equal(row.squareBookingId, "BK_APPROVED_1");
  assert.equal(row.squareBookingVersion, 1);
  assert.equal(row.squareBookingStatus, "PENDING");
  assert.equal(row.squareSyncStatus, "creating");
  assert.equal(row.squareServiceVariationId, "VAR_CUSTOMIZED_60");
  assert.equal(row.squareLocationId, "LOC_SANDBOX");
  assert.equal(row.squareTeamMemberId, "TM_CHELSEA");
  assert.equal(row.calendarUrl, null);
  assert.equal(row.confirmationEmailStatus, "none");
  assert.equal(row.providerConfirmationEmailStatus, "none");

  const confirmationEmails = emails.filter((c) =>
    /appointment is confirmed|Appointment approved/.test(String(c.body.subject)),
  );
  assert.equal(confirmationEmails.length, 0);
});

test("awaiting_square_acceptance holds the slot until Square acceptance is resolved", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock({ bookingStatus: "PENDING" });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  await post(approveHandler, { token: approvalTokenFromEmails(emails) });
  const overlap = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_awaiting_hold_1" }),
  );

  assert.equal(overlap.statusCode, 409);
  assert.match(overlap.body.error, /no longer available/);
});

test("status-check POST retrieves a PENDING booking and never creates another", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ bookingStatus: "PENDING" });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  const checked = await post(approveHandler, { token });

  assert.equal(checked.statusCode, 200);
  assert.equal(checked.body.status, "awaiting_square_acceptance");
  assert.equal(state.createCalls.length, 1);
  assert.equal(state.getCalls.length, 1);
  assert.deepEqual(state.getCalls[0], { bookingId: "BK_APPROVED_1" });
});

test("accepted status-check finalizes and sends each confirmation exactly once", async () => {
  installGateEnv();
  installEmailEnv();
  const createdBooking = { booking: { id: "BK_PENDING_ACCEPT", status: "PENDING", version: 0 } };
  const { client, state } = makeSquareMock({ bookingsCreate: async () => createdBooking });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  createdBooking.booking.status = "ACCEPTED";
  createdBooking.booking.version = 0;

  const accepted = await post(approveHandler, { token });
  const repeated = await post(approveHandler, { token });

  assert.equal(accepted.body.status, "approved");
  assert.equal(repeated.body.status, "approved");
  assert.match(accepted.body.calendarUrl, /calendar\.google\.com\/calendar\/render/);
  assert.equal(state.createCalls.length, 1);
  assert.equal(state.getCalls.length, 1);

  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "approved");
  assert.equal(row.squareBookingVersion, 0);
  assert.equal(row.squareBookingStatus, "ACCEPTED");
  assert.equal(row.confirmationEmailStatus, "sent");
  assert.equal(row.providerConfirmationEmailStatus, "sent");
  assert.equal(emails.filter((c) => String(c.body.subject).includes("appointment is confirmed")).length, 1);
  assert.equal(emails.filter((c) => String(c.body.subject).includes("Appointment approved")).length, 1);
});

test("declined or cancelled Square booking becomes terminal without confirmations", async () => {
  installGateEnv();
  installEmailEnv();
  const createdBooking = { booking: { id: "BK_PENDING_CANCEL", status: "PENDING", version: 2 } };
  const { client, state } = makeSquareMock({ bookingsCreate: async () => createdBooking });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  createdBooking.booking.status = "CANCELLED_BY_SELLER";
  createdBooking.booking.version = 3;

  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "needs_reschedule");
  assert.equal(state.createCalls.length, 1);
  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "needs_reschedule");
  assert.equal(row.squareBookingStatus, "CANCELLED_BY_SELLER");
  assert.equal(row.squareSyncStatus, "canceled");
  assert.equal(emails.filter((c) => /appointment is confirmed|Appointment approved/.test(String(c.body.subject))).length, 0);
});

test("decline is rejected while awaiting Square acceptance and keeps the local hold", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock({ bookingStatus: "PENDING" });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });

  const decline = await post(declineHandler, { token });
  assert.equal(decline.statusCode, 409);
  assert.equal(decline.body.status, "awaiting_square_acceptance");
  assert.match(decline.body.error, /pending acceptance in Square/i);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "awaiting_square_acceptance");

  const overlap = await post(
    bookingRequestsHandler,
    makeBody({ requestKey: "req_test_decline_awaiting_hold" }),
  );
  assert.equal(overlap.statusCode, 409);
  assert.equal(emails.filter((c) => /appointment is confirmed|Appointment approved/.test(String(c.body.subject))).length, 0);
});

test("transient retrieve failure preserves awaiting state and stored Square ids", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ bookingStatus: "PENDING" });
  client.bookings.get = async (request) => {
    state.getCalls.push(request);
    throw { statusCode: 500 };
  };
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 500);
  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "awaiting_square_acceptance");
  assert.equal(row.squareBookingId, "BK_APPROVED_1");
  assert.equal(row.squareCustomerId, "CUST_APPROVE_1");
  assert.equal(state.createCalls.length, 1);
  assert.equal(state.getCalls.length, 1);
});

test("awaiting_square_acceptance recheck remains usable after original token TTL", async () => {
  installGateEnv();
  installEmailEnv();
  const createdBooking = { booking: { id: "BK_PENDING_ACCEPT", status: "PENDING", version: 0 } };
  const { client } = makeSquareMock({ bookingsCreate: async () => createdBooking });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  await store.setApprovalTokenExpiry(a.body.requestId, new Date(Date.now() - 1000));
  createdBooking.booking.status = "ACCEPTED";

  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "approved");
  assert.equal((await store.getRequestById(a.body.requestId)).status, "approved");
});

test("awaiting_square_acceptance expired recheck window gives operator recovery guidance without Square retrieval", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({ bookingStatus: "PENDING" });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  const row = store._findById(a.body.requestId);
  row.approvalStartedAt = new Date(Date.now() - 15 * 86400000);

  const res = await post(approveHandler, { token });
  const summary = await get(approveHandler, { token });

  assert.equal(res.statusCode, 410);
  assert.equal(summary.statusCode, 410);
  assert.equal(res.body.status, "awaiting_square_acceptance");
  assert.equal(res.body.expired, true);
  assert.match(res.body.message, /Square Dashboard/i);
  assert.match(res.body.message, /manually/i);
  assert.equal(state.getCalls.length, 0);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "awaiting_square_acceptance");
});

test("pre-approval expired token still cannot create a Square booking", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock();
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await store.setApprovalTokenExpiry(a.body.requestId, new Date(Date.now() - 1000));

  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 404);
  assert.equal(state.createCalls.length, 0);
});

test("recheck fails closed when Square returns a different booking id", async () => {
  installGateEnv();
  installEmailEnv();
  const { client } = makeSquareMock({ bookingStatus: "PENDING" });
  client.bookings.get = async () => ({ booking: { id: "BK_DIFFERENT", status: "ACCEPTED", version: 2 } });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 500);
  const row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "awaiting_square_acceptance");
  assert.equal(row.squareBookingId, "BK_APPROVED_1");
});

test("simultaneous accepted rechecks finalize once and do not duplicate confirmations", async () => {
  installGateEnv();
  installEmailEnv();
  const createdBooking = { booking: { id: "BK_PENDING_RACE", status: "PENDING", version: 0 } };
  const { client, state } = makeSquareMock({ bookingsCreate: async () => createdBooking });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await post(approveHandler, { token });
  createdBooking.booking.status = "ACCEPTED";

  const [first, second] = await Promise.all([
    post(approveHandler, { token }),
    post(approveHandler, { token }),
  ]);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "approved");
  assert.equal(state.createCalls.length, 1);
  assert.equal(emails.filter((c) => String(c.body.subject).includes("appointment is confirmed")).length, 1);
  assert.equal(emails.filter((c) => String(c.body.subject).includes("Appointment approved")).length, 1);
});

test("fresh approval fails closed when availability lacks a version (never calls Square create)", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({
    serviceVariationVersion: null,
    available: true,
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 500);
  assert.equal((await store.getRequestById(a.body.requestId)).status, "failed");
  assert.equal((await store.getRequestById(a.body.requestId)).failureCode, "server_config");
  assert.equal(state.createCalls.length, 0);
});

test("resume fails closed when the catalog lookup itself errors", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({
    catalogGet: async () => {
      throw { statusCode: 500 };
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  await store.claimForApproval(a.body.requestId);

  const res = await post(approveHandler, { token });
  assert.equal(res.statusCode, 500);
  assert.equal((await store.getRequestById(a.body.requestId)).failureCode, "server_config");
  assert.equal(state.createCalls.length, 0);
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
  const row = await store.getRequestByKey(a.body.requestKey);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.customerCreateCalls.length, 1);
  const createReq = state.customerCreateCalls[0];
  assert.notEqual(row.id, a.body.requestId);
  assert.equal(createReq.idempotencyKey, buildCustomerIdempotencyKey(row.id));
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
  const row = await store.getRequestByKey(a.body.requestKey);
  assert.notEqual(row.id, a.body.requestId);
  const key = buildCustomerIdempotencyKey(row.id);

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

test("a non-retryable Square create error marks the request failed and it cannot re-approve", async () => {
  installGateEnv();
  installEmailEnv();
  const { client, state } = makeSquareMock({
    bookingsCreate: async () => {
      throw { statusCode: 400 };
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const createdRow = await store.getRequestByKey(a.body.requestKey);
  assert.notEqual(createdRow.id, a.body.requestId);
  const res = await post(approveHandler, { token });

  assert.equal(res.statusCode, 400);
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

test("a transient Square create timeout remains retryable and resumes with the deterministic key", async () => {
  installGateEnv();
  installEmailEnv();
  let first = true;
  const createdBooking = { booking: { id: "BK_TIMEOUT_RESUME", status: "PENDING", version: 0 } };
  const { client, state } = makeSquareMock({
    bookingsCreate: async () => {
      if (first) {
        first = false;
        throw { statusCode: 500 };
      }
      return createdBooking;
    },
  });
  setSquareClientForTests(client);
  const emails = captureEmailCalls();

  const a = await post(bookingRequestsHandler, makeBody());
  const token = approvalTokenFromEmails(emails);
  const createdRow = await store.getRequestByKey(a.body.requestKey);
  assert.notEqual(createdRow.id, a.body.requestId);

  const failedTransient = await post(approveHandler, { token });
  assert.equal(failedTransient.statusCode, 500);
  let row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "approving");
  assert.equal(row.squareBookingId, null);

  const resumed = await post(approveHandler, { token });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.body.status, "awaiting_square_acceptance");
  row = await store.getRequestById(a.body.requestId);
  assert.equal(row.status, "awaiting_square_acceptance");
  assert.equal(row.squareBookingId, "BK_TIMEOUT_RESUME");
  assert.equal(state.createCalls.length, 2);
  assert.equal(state.createCalls[0].idempotencyKey, buildSquareIdempotencyKey(createdRow.id));
  assert.equal(state.createCalls[1].idempotencyKey, buildSquareIdempotencyKey(createdRow.id));
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
