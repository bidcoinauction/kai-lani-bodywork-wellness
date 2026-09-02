-- 004_turnover_buffer.sql
-- Enforce the 30-minute private turnaround buffer for active local holds.
-- Applied manually by the operator after review.

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
