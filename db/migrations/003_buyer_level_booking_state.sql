-- 003_buyer_level_booking_state.sql
-- Adds the buyer-level Square pending-acceptance state.
--
-- Applied manually by the operator after review. This migration is additive and
-- assumes 001_booking_requests.sql and 002_square_reconciliation.sql have run.

DO $$
DECLARE
  status_constraint_name text;
BEGIN
  SELECT conname INTO status_constraint_name
    FROM pg_constraint
   WHERE conrelid = 'booking_requests'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%'
     AND pg_get_constraintdef(oid) LIKE '%needs_reschedule%'
   ORDER BY conname
   LIMIT 1;

  IF status_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE booking_requests DROP CONSTRAINT %I', status_constraint_name);
  END IF;
END $$;

ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_status_check
  CHECK (status IN (
    'pending',
    'approving',
    'awaiting_square_acceptance',
    'approved',
    'declined',
    'expired',
    'failed',
    'needs_reschedule'
  ));

DO $$
DECLARE
  overlap_constraint_name text;
BEGIN
  SELECT conname INTO overlap_constraint_name
    FROM pg_constraint
   WHERE conrelid = 'booking_requests'::regclass
     AND contype = 'x'
     AND conname = 'no_overlapping_active_requests';

  IF overlap_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE booking_requests DROP CONSTRAINT %I', overlap_constraint_name);
  END IF;
END $$;

ALTER TABLE booking_requests
  ADD CONSTRAINT no_overlapping_active_requests
  EXCLUDE USING gist (
    (CASE WHEN status IN ('pending', 'approving', 'awaiting_square_acceptance') THEN 'hold' END) WITH =,
    tsrange(
      start_at AT TIME ZONE 'UTC',
      (start_at AT TIME ZONE 'UTC') + (duration_minutes + 30) * interval '1 minute',
      '[)'
    ) WITH &&
  );
