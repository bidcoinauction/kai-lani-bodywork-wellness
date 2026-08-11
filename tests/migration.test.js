import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const sql = readFileSync(resolve(here, "../db/migrations/001_booking_requests.sql"), "utf8");

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

test("migration holds the slot only for pending and approving, never approved", () => {
  const constraintMatch = sql.match(
    /no_overlapping_active_requests[\s\S]*?EXCLUDE USING gist[\s\S]*?;/, 
  );
  assert.ok(constraintMatch, "exclusion constraint missing");
  const constraint = constraintMatch[0];
  assert.match(constraint, /pending/);
  assert.match(constraint, /approving/);
  assert.doesNotMatch(constraint, /'approved'/);
  assert.match(constraint, /tstzrange/);
  assert.match(constraint, /&&/);
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
