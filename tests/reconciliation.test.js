import { test } from "node:test";
import assert from "node:assert/strict";
import { isSquareBookingActive } from "../lib/booking-requests.js";
import { WebhookReconcileError } from "../lib/store.js";
import { MemoryBookingRequestStore } from "./memory-store.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";

function activeRow(overrides = {}) {
  return {
    status: "approved",
    squareSyncStatus: "created",
    squareBookingStatus: "ACCEPTED",
    ...overrides,
  };
}

async function createRequest(store, key, startAt, durationMinutes = 60) {
  return store.createRequest({
    requestKey: key,
    serviceKey: durationMinutes === 90 ? "customized_90" : "customized_60",
    firstName: "Test",
    lastName: "Client",
    email: `${key}@example.invalid`,
    phone: "+19805550100",
    startAt,
    durationMinutes,
    approvalTokenHash: hashToken(generateApprovalToken()),
    approvalTokenExpiresAt: new Date(Date.now() + 600_000),
  });
}

function approveInternally(store, row, overrides = {}) {
  const internal = store._findById(row.id);
  internal.status = "approved";
  internal.squareBookingId = overrides.squareBookingId || "bk-read-model";
  internal.squareBookingVersion = Object.hasOwn(overrides, "squareBookingVersion")
    ? overrides.squareBookingVersion
    : 1;
  internal.squareBookingStatus = overrides.squareBookingStatus || "ACCEPTED";
  internal.squareSyncStatus = overrides.squareSyncStatus || "created";
  internal.decidedAt = new Date();
  return internal;
}

test("active read model: approved ACCEPTED created is active", () => {
  assert.equal(isSquareBookingActive(activeRow()), true);
});

test("active read model: approved ACCEPTED rescheduled is active", () => {
  assert.equal(isSquareBookingActive(activeRow({ squareSyncStatus: "rescheduled" })), true);
});

for (const status of ["pending", "approving", "declined", "expired", "failed", "needs_reschedule"]) {
  test(`active read model: request status ${status} is inactive`, () => {
    assert.equal(isSquareBookingActive(activeRow({ status })), false);
  });
}

for (const squareSyncStatus of ["not_created", "creating", "canceled", "no_show", "failed", "unknown"]) {
  test(`active read model: sync status ${squareSyncStatus} is inactive`, () => {
    assert.equal(isSquareBookingActive(activeRow({ squareSyncStatus })), false);
  });
}

for (const squareBookingStatus of [
  "PENDING",
  "DECLINED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_SELLER",
  "NO_SHOW",
  "UNKNOWN",
  null,
]) {
  test(`active read model: Square status ${squareBookingStatus ?? "null"} is inactive`, () => {
    assert.equal(isSquareBookingActive(activeRow({ squareBookingStatus })), false);
  });
}

test("memory store: findRequestBySquareBookingId locates only persisted Square ids", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRequest(store, "find-square", "2026-12-01T15:00:00Z");
  approveInternally(store, row, { squareBookingId: "bk-find" });
  assert.equal((await store.findRequestBySquareBookingId("bk-find")).id, row.id);
  assert.equal(await store.findRequestBySquareBookingId("bk-missing"), null);
});

test("memory store: reconcile accepts null existing version as first authoritative version", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRequest(store, "null-version", "2026-12-01T15:00:00Z");
  approveInternally(store, row, { squareBookingVersion: null });
  const result = await store.reconcileSquareBooking({
    requestId: row.id,
    squareBookingId: "bk-read-model",
    squareBookingVersion: 1,
    squareBookingStatus: "ACCEPTED",
    startAt: "2026-12-01T15:00:00Z",
    durationMinutes: 60,
    squareSyncStatus: "created",
  });
  assert.equal(result.reconciled, true);
  assert.equal((await store.getRequestById(row.id)).squareBookingVersion, 1);
});

test("memory store: reconcile returns stale_version for equal version", async () => {
  const store = new MemoryBookingRequestStore();
  const row = await createRequest(store, "equal-version", "2026-12-01T15:00:00Z");
  approveInternally(store, row, { squareBookingVersion: 3 });
  const result = await store.reconcileSquareBooking({
    requestId: row.id,
    squareBookingId: "bk-read-model",
    squareBookingVersion: 3,
    squareBookingStatus: "ACCEPTED",
    startAt: "2026-12-01T16:00:00Z",
    durationMinutes: 60,
    squareSyncStatus: "rescheduled",
  });
  assert.equal(result.reconciled, false);
  assert.equal(result.reason, "stale_version");
  assert.equal(new Date((await store.getRequestById(row.id)).startAt).toISOString(), "2026-12-01T15:00:00.000Z");
});

test("memory store: reconcile returns null for an unknown local request id", async () => {
  const store = new MemoryBookingRequestStore();
  const result = await store.reconcileSquareBooking({
    requestId: "missing",
    squareBookingId: "bk-missing",
    squareBookingVersion: 1,
    squareBookingStatus: "ACCEPTED",
    startAt: "2026-12-01T15:00:00Z",
    durationMinutes: 60,
    squareSyncStatus: "created",
  });
  assert.equal(result, null);
});

test("memory store: findPendingOverlaps excludes adjacent ranges", async () => {
  const store = new MemoryBookingRequestStore();
  await createRequest(store, "adjacent-left", "2026-12-02T15:00:00Z", 60);
  await createRequest(store, "adjacent-right", "2026-12-02T16:00:00Z", 60);
  const overlaps = await store.findPendingOverlaps({
    startAt: "2026-12-02T16:00:00Z",
    durationMinutes: 60,
  });
  assert.deepEqual(overlaps.map((row) => row.requestKey), ["adjacent-right"]);
});

test("memory store: movePendingOverlapToNeedsReschedule only mutates pending rows", async () => {
  const store = new MemoryBookingRequestStore();
  const pending = await createRequest(store, "move-pending", "2026-12-03T15:00:00Z");
  const approving = await createRequest(store, "move-approving", "2026-12-03T16:00:00Z");
  await store.claimForApproval(approving.id);
  assert.equal((await store.movePendingOverlapToNeedsReschedule(pending.id)).status, "needs_reschedule");
  assert.equal(await store.movePendingOverlapToNeedsReschedule(approving.id), null);
  assert.equal((await store.getRequestById(approving.id)).status, "approving");
});

test("memory store: approving overlap throws a retryable reconcile error before mutating", async () => {
  const store = new MemoryBookingRequestStore();
  const approved = await createRequest(store, "approved-race", "2026-12-04T15:00:00Z");
  approveInternally(store, approved, { squareBookingVersion: 1 });
  const race = await createRequest(store, "approving-race-read", "2026-12-04T18:30:00Z");
  await store.claimForApproval(race.id);

  await assert.rejects(
    store.reconcileSquareBooking({
      requestId: approved.id,
      squareBookingId: "bk-read-model",
      squareBookingVersion: 2,
      squareBookingStatus: "ACCEPTED",
      startAt: "2026-12-04T18:00:00Z",
      durationMinutes: 60,
      squareSyncStatus: "rescheduled",
    }),
    (err) => err instanceof WebhookReconcileError && err.code === "approving_overlap",
  );
  assert.equal(new Date((await store.getRequestById(approved.id)).startAt).toISOString(), "2026-12-04T15:00:00.000Z");
});
