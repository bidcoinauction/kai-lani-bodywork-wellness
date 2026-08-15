-- 002_square_reconciliation.sql
-- Durable Square booking reconciliation and webhook event tracking.
--
-- Applied manually by the operator after review. This migration is additive
-- and assumes 001_booking_requests.sql has already created booking_requests.

ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS square_service_variation_id text,
  ADD COLUMN IF NOT EXISTS square_location_id text,
  ADD COLUMN IF NOT EXISTS square_team_member_id text,
  ADD COLUMN IF NOT EXISTS square_booking_version bigint,
  ADD COLUMN IF NOT EXISTS square_sync_status text NOT NULL DEFAULT 'not_created'
    CHECK (square_sync_status IN (
      'not_created',
      'creating',
      'created',
      'rescheduled',
      'canceled',
      'no_show',
      'failed'
    )),
  ADD COLUMN IF NOT EXISTS square_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS square_sync_error text,
  ADD COLUMN IF NOT EXISTS square_canceled_at timestamptz;

CREATE INDEX IF NOT EXISTS booking_requests_square_booking_id_idx
  ON booking_requests (square_booking_id)
  WHERE square_booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_requests_square_booking_version_idx
  ON booking_requests (square_booking_version)
  WHERE square_booking_version IS NOT NULL;

CREATE TABLE IF NOT EXISTS square_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  merchant_id text,
  square_booking_id text,
  square_booking_version bigint,
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN (
      'received',
      'processing',
      'processed',
      'ignored',
      'failed'
    )),
  attempt_count integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  safe_error_code text
);

CREATE INDEX IF NOT EXISTS square_webhook_events_booking_idx
  ON square_webhook_events (square_booking_id)
  WHERE square_booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS square_webhook_events_processing_idx
  ON square_webhook_events (processing_status, received_at);
