# Appointment Reminder Architecture (design only)

Status: **documented, NOT implemented.** No reminder code exists in this task
and no in-memory timers are used anywhere in the site.

## Goals

- Send one durable reminder per eligible appointment (e.g. the day before).
- Survive function restarts, cold starts, and concurrent runs without duplicates.
- Never remind for appointments that are cancelled, declined, no-show, or
  rescheduled.

## Proposed schema

`appointment_notifications` (new table, future migration):

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` PK | `gen_random_uuid()` |
| `booking_id` | `text` | Square booking id |
| `request_id` | `uuid` FK | `booking_requests.id` when known |
| `scheduled_for` | `timestamptz` | when the reminder should fire |
| `type` | `text` | e.g. `reminder-24h` |
| `status` | `text` | `pending \| sent \| failed \| skipped` |
| `attempts` | `integer` | default 0, incremented per attempt |
| `idempotency_key` | `text` unique | deterministic, e.g. `kai-lani/reminder/{bookingId}/{type}` |
| `sent_at` | `timestamptz` | |
| `created_at` / `updated_at` | `timestamptz` | |

## Behavior

- **Deterministic idempotency key** per booking+type prevents duplicate sends:
  an INSERT `ON CONFLICT DO NOTHING` plus a `pending -> sent` atomic update is
  the same pattern the approval workflow already uses.
- **Square status recheck before send:** re-fetch the booking; only send when
  status is `ACCEPTED` (and the appointment is in the future). Skip when
  cancelled / declined / no-show / rescheduled (Square returns the new time;
  the reminder is not sent against stale data).
- **No reminders for** cancelled, declined, no-show, or rescheduled
  appointments.
- **Delivery:** reuse the sandbox email pipeline; persist per-email status and
  only retry rows whose status is not `sent` (same rule as confirmation email
  retries today).

## Scheduling

- **Future Vercel Cron** (preferred): a cron-triggered function that selects
  due `pending` reminders, claims them atomically, rechecks Square, and sends.
  Cron cadence (e.g. hourly) defines precision; no long-running timers.
- **No in-memory timers:** `setTimeout`/`setInterval` are unreliable on
  serverless and are never used for reminders.

## Out of scope

- Sending the reminder itself.
- SMS reminders.
- Consent handling for reminders (must follow the existing contact-consent rule).
