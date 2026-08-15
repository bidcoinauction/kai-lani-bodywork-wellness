-- 001_booking_requests.sql
-- Booking-request approval workflow for Kai Lani bodywork appointments.
--
-- Applied manually by the operator, never automatically:
--   npm run db:booking-requests:apply
--
-- Notes:
--  * approval_token_hash stores ONLY the SHA-256 hash of the emailed token.
--  * unsubscribe_token_hash stores ONLY the SHA-256 hash of the unsubscribe
--    token; the raw token is never persisted.
--  * No medical or sensitive fields are ever stored.
--  * The btree_gist exclusion constraint prevents two ACTIVE (pending or
--    approving) requests from overlapping in time. The hold covers only the
--    website review window: once a request is approved, Square availability
--    becomes the source of truth, so an approved (or declined / expired /
--    failed / needs-reschedule) row never blocks the slot permanently.
--  * No dynamic now() expression is used inside a partial-index predicate
--    (volatile expressions are invalid there); expiry is always checked with
--    a WHERE clause in queries.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS booking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key text NOT NULL UNIQUE,
  service_key text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  start_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes IN (60, 90)),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'approving',
      'approved',
      'declined',
      'expired',
      'failed',
      'needs_reschedule'
    )),
  approval_token_hash text,
  approval_token_expires_at timestamptz,
  approval_started_at timestamptz,
  approval_attempt_count integer NOT NULL DEFAULT 0,
  failure_code text,
  square_customer_id text,
  square_booking_id text,
  square_booking_status text,
  calendar_url text,
  request_receipt_email_status text NOT NULL DEFAULT 'none',
  approval_email_status text NOT NULL DEFAULT 'none',
  confirmation_email_status text NOT NULL DEFAULT 'none',
  provider_confirmation_email_status text NOT NULL DEFAULT 'none',
  decline_email_status text NOT NULL DEFAULT 'none',
  needs_reschedule_email_status text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

-- The exclusion constraint only "holds" time for ACTIVE statuses (pending and
-- approving). The CASE expression is NULL for every other status, and btree_gist
-- '=' on a NULL value never matches, so approved / declined / expired / failed /
-- needs-reschedule rows never block a slot or each other. This is intentional:
-- once Square returns ACCEPTED, Square availability is the source of truth, so
-- a later Square cancellation/reschedule is never hidden by a stale database
-- hold.
--
-- The time range is built as a UTC timestamp-without-time-zone range so every
-- function in the index expression is IMMUTABLE: timezone('UTC', tstz) and
-- timestamp + interval are both immutable, and timestamp-without-time-zone
-- arithmetic is DST/timezone independent. (tstz + interval is STABLE in
-- PostgreSQL and cannot appear in an index expression; a plain IMMUTABLE
-- wrapper around it would misrepresent its volatility and is not used.)
ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS no_overlapping_active_requests;

ALTER TABLE booking_requests
  ADD CONSTRAINT no_overlapping_active_requests
  EXCLUDE USING gist (
    (CASE WHEN status IN ('pending', 'approving') THEN 'hold' END) WITH =,
    tsrange(
      start_at AT TIME ZONE 'UTC',
      (start_at AT TIME ZONE 'UTC') + duration_minutes * interval '1 minute',
      '[)'
    ) WITH &&
  );

-- Request idempotency: request_key is already UNIQUE (backed by a unique
-- index). Approval-token lookup by hash, and the expiry sweep over pending
-- rows, use partial indexes whose predicates are immutable.
CREATE INDEX IF NOT EXISTS booking_requests_email_idx ON booking_requests (email);
CREATE INDEX IF NOT EXISTS booking_requests_start_at_idx ON booking_requests (start_at);
CREATE INDEX IF NOT EXISTS booking_requests_approval_token_hash_idx
  ON booking_requests (approval_token_hash) WHERE approval_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS booking_requests_pending_expiry_idx
  ON booking_requests (approval_token_expires_at) WHERE status = 'pending';

-- Email marketing subscriptions. Consent is opt-in only and is never inferred
-- from a booking submission: a row is created only when the booking form
-- explicitly sent marketingConsent === true with consent source
-- 'kai-lani-booking-form'. Unsubscribed rows are never re-subscribed.
CREATE TABLE IF NOT EXISTS email_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email text NOT NULL UNIQUE,
  square_customer_id text,
  status text NOT NULL DEFAULT 'subscribed'
    CHECK (status IN ('subscribed', 'unsubscribed')),
  consent_source text NOT NULL DEFAULT 'kai-lani-booking-form',
  consent_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz,
  unsubscribe_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_subscriptions_unsubscribe_token_hash_idx
  ON email_subscriptions (unsubscribe_token_hash)
  WHERE unsubscribe_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_subscriptions_customer_idx
  ON email_subscriptions (square_customer_id)
  WHERE square_customer_id IS NOT NULL;
