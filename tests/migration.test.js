import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MemoryBookingRequestStore } from "./memory-store.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const sql = readFileSync(resolve(here, "../db/migrations/001_booking_requests.sql"), "utf8");
const reconciliationSql = readFileSync(
  resolve(here, "../db/migrations/002_square_reconciliation.sql"),
  "utf8",
);

const STATUSES = [
  "pending",
  "approving",
  "approved",
  "declined",
  "expired",
  "failed",
  "needs_reschedule",
];

test("migration defines all seven request statuses", () => {
  for (const status of STATUSES) {
    assert.match(sql, new RegExp(`'${status}'`), `missing status ${status}`);
  }
});

test("migration holds the slot only for pending and approving via an immutable UTC tsrange", () => {
  const constraintMatch = sql.match(
    /no_overlapping_active_requests[\s\S]*?EXCLUDE USING gist[\s\S]*?;/,
  );
  assert.ok(constraintMatch, "exclusion constraint missing");
  const constraint = constraintMatch[0];
  assert.match(constraint, /pending/);
  assert.match(constraint, /approving/);
  assert.doesNotMatch(constraint, /'approved'/);
  assert.match(constraint, /tsrange\(/);
  assert.match(constraint, /start_at AT TIME ZONE 'UTC'/);
  assert.match(constraint, /'\[\)'/);
  assert.match(constraint, /&&/);
});

test("migration replaces the STABLE timestamptz + interval expression with UTC timestamp arithmetic", () => {
  assert.match(sql, /tsrange\(/);
  assert.match(sql, /AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(sql, /tstzrange\s*\(\s*start_at\s*,\s*start_at\s*\+/);
  assert.doesNotMatch(sql, /start_at\s*,\s*start_at\s*\+\s*duration_minutes/);
});

test("migration declares no custom function (nothing falsely marked IMMUTABLE)", () => {
  assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  assert.doesNotMatch(sql, /\bLANGUAGE\s+sql\b/i);
});

test("migration adds approval timing/attempt/failure columns and decided_at", () => {
  assert.match(sql, /approval_started_at timestamptz/);
  assert.match(sql, /approval_attempt_count integer NOT NULL DEFAULT 0/);
  assert.match(sql, /failure_code text/);
  assert.match(sql, /decided_at timestamptz/);
  assert.match(sql, /calendar_url text/);
});

test("migration uses btree_gist and immutable partial-index predicates only", () => {
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  assert.doesNotMatch(
    sql,
    /(?:CREATE INDEX[^;]*now\(\)[^;]*;|CREATE INDEX[^;]*>=? now\(\))/,
    "dynamic now() must never appear inside a partial-index predicate",
  );
  assert.match(sql, /approval_token_hash\) WHERE approval_token_hash IS NOT NULL/);
  assert.match(sql, /approval_token_expires_at\) WHERE status = 'pending'/);
});

test("migration defines email_subscriptions with unique normalized email and token-hash index", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS email_subscriptions/);
  assert.match(sql, /normalized_email text NOT NULL UNIQUE/);
  assert.match(sql, /status text NOT NULL DEFAULT 'subscribed'/);
  assert.match(sql, /consent_source text NOT NULL DEFAULT 'kai-lani-booking-form'/);
  assert.match(sql, /unsubscribe_token_hash text/);
  assert.match(sql, /unsubscribed_at timestamptz/);
  assert.match(sql, /email_subscriptions_unsubscribe_token_hash_idx/);
});

test("migration is idempotent (CREATE IF NOT EXISTS / ADD CONSTRAINT guards) for a clean or re-run", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS booking_requests/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS no_overlapping_active_requests/);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
});

test("migration 002 is additive and leaves migration 001 untouched", () => {
  assert.match(reconciliationSql, /ALTER TABLE booking_requests/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_service_variation_id text/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_location_id text/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_team_member_id text/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_booking_version bigint/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_sync_status text NOT NULL DEFAULT 'not_created'/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_last_synced_at timestamptz/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_sync_error text/);
  assert.match(reconciliationSql, /ADD COLUMN IF NOT EXISTS square_canceled_at timestamptz/);
  assert.doesNotMatch(reconciliationSql, /DROP TABLE|DROP COLUMN|ALTER TABLE booking_requests\s+DROP/i);
});

test("migration 002 defines sync and durable webhook-event state without raw payload storage", () => {
  for (const status of [
    "not_created",
    "creating",
    "created",
    "rescheduled",
    "canceled",
    "no_show",
    "failed",
  ]) {
    assert.match(reconciliationSql, new RegExp(`'${status}'`));
  }
  assert.match(reconciliationSql, /CREATE TABLE IF NOT EXISTS square_webhook_events/);
  assert.match(reconciliationSql, /event_id text NOT NULL UNIQUE/);
  assert.match(reconciliationSql, /square_booking_version bigint/);
  assert.match(reconciliationSql, /processing_status text NOT NULL DEFAULT 'received'/);
  assert.match(reconciliationSql, /attempt_count integer NOT NULL DEFAULT 0/);
  for (const status of ["received", "processing", "processed", "ignored", "failed"]) {
    assert.match(reconciliationSql, new RegExp(`'${status}'`));
  }
  assert.match(reconciliationSql, /safe_error_code text/);
  assert.doesNotMatch(reconciliationSql, /raw_payload|payload json|signature|customer_email|phone/i);
});

// ---------------------------------------------------------------------------
// Functional mirror of the exclusion constraint. MemoryBookingRequestStore
// enforces the same invariants as the database: only ACTIVE (pending and
// approving) rows hold their time window, and adjacency at a range boundary is
// allowed. These tests pin the behavior the migration must guarantee.
// ---------------------------------------------------------------------------

async function createRequestAt(store, key, startAt, durationMinutes = 60) {
  const token = generateApprovalToken();
  return store.createRequest({
    requestKey: key,
    serviceKey: "customized-60",
    firstName: "Test",
    lastName: "User",
    email: `tester-${key}@example.invalid`,
    phone: "+19876543210",
    startAt,
    durationMinutes,
    approvalTokenHash: hashToken(token),
    approvalTokenExpiresAt: new Date(Date.now() + 600_000),
  });
}

test("overlapping pending and approving ranges are rejected", async () => {
  const store = new MemoryBookingRequestStore();

  const pendingOne = await createRequestAt(store, "k-p1", "2026-09-01T10:00:00Z");
  await assert.rejects(
    createRequestAt(store, "k-p2", "2026-09-01T10:30:00Z"),
    (err) => err.code === "23P01",
    "pending overlapping pending must be rejected",
  );

  await store.claimForApproval(pendingOne.id);
  await assert.rejects(
    createRequestAt(store, "k-p3", "2026-09-01T10:15:00Z"),
    (err) => err.code === "23P01",
    "pending overlapping approving must be rejected",
  );
});

test("adjacent ranges are accepted (60- and 90-minute durations)", async () => {
  const store = new MemoryBookingRequestStore();

  const a = await createRequestAt(store, "k-a1", "2026-09-01T10:00:00Z", 60);
  const b = await createRequestAt(store, "k-a2", "2026-09-01T11:00:00Z", 60);
  const c = await createRequestAt(store, "k-a3", "2026-09-01T12:00:00Z", 90);
  const d = await createRequestAt(store, "k-a4", "2026-09-01T13:30:00Z", 90);
  assert.ok(a && b && c && d);
});

test("approved/declined/expired/failed/needs_reschedule rows do not hold slots", async () => {
  const store = new MemoryBookingRequestStore();

  async function moveToTerminal(row, status) {
    if (status === "approved") {
      await store.claimForApproval(row.id);
      await store.markApproved({
        id: row.id,
        squareCustomerId: "cus_test",
        squareBookingId: "bk_test",
        squareBookingStatus: "ACCEPTED",
        calendarUrl: null,
      });
    } else if (status === "declined") {
      await store.markDeclined({ id: row.id });
    } else if (status === "expired") {
      await store.setApprovalTokenExpiry(row.id, new Date(Date.now() - 1000));
      await store.expirePendingRequests();
    } else if (status === "failed") {
      await store.claimForApproval(row.id);
      await store.markFailed({ id: row.id, failureCode: "test_failure" });
    } else {
      await store.claimForApproval(row.id);
      await store.markNeedsReschedule({ id: row.id });
    }
  }

  const terminal = ["approved", "declined", "expired", "failed", "needs_reschedule"];
  const base = new Date("2026-10-01T08:00:00Z");
  let offset = 0;
  for (const status of terminal) {
    const slot = new Date(base.getTime() + offset * 86_400_000).toISOString();
    const row = await createRequestAt(store, `released-${status}`, slot);
    await moveToTerminal(row, status);
    assert.equal(
      (await store.getRequestById(row.id)).status,
      status,
      `${status} should be reachable`,
    );
    const overlap = await createRequestAt(store, `overlap-${status}`, slot);
    assert.ok(overlap, `${status} row must not hold the slot`);
    offset += 1;
  }

  // The constraint is still alive: an active request at any of those slots
  // would now conflict, but a fresh pending one must be blocked by an ACTIVE
  // hold only. Prove active holds still work in this store.
  const blockSlot = "2026-10-20T08:00:00Z";
  await createRequestAt(store, "active-block", blockSlot);
  await assert.rejects(
    createRequestAt(store, "active-block-2", "2026-10-20T08:30:00Z"),
    (err) => err.code === "23P01",
    "active holds must still reject overlaps",
  );
});
