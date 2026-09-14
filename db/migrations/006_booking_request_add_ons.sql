-- 006_booking_request_add_ons.sql
-- Optional booking add-ons selected by the client. Stores only stable server
-- identifiers; price, duration, and Square variation IDs remain server-owned.

ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS add_on_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_add_on_keys_array_check;

ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_add_on_keys_array_check
  CHECK (jsonb_typeof(add_on_keys) = 'array');
