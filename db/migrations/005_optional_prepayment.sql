-- 005_optional_prepayment.sql
-- Optional Square-hosted prepayment for confirmed appointments.
-- Applied manually by the operator after review. Additive only; no card data or
-- raw Square payloads are stored.

ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS square_payment_link_id text,
  ADD COLUMN IF NOT EXISTS square_order_id text,
  ADD COLUMN IF NOT EXISTS payment_link_url text,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'not_started'
    CHECK (payment_status IN ('not_started', 'link_created', 'paid')),
  ADD COLUMN IF NOT EXISTS payment_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS booking_requests_square_payment_link_id_idx
  ON booking_requests (square_payment_link_id)
  WHERE square_payment_link_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_requests_square_order_id_idx
  ON booking_requests (square_order_id)
  WHERE square_order_id IS NOT NULL;
