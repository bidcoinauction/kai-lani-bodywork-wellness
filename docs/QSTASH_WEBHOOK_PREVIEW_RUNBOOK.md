# QStash Webhook Preview Runbook

Square webhook intake must verify Square's signature, durably publish the normalized event to QStash, and only then return `202`. Queue publication is the durable handoff required before Square is told the event was accepted.

## Preview Variables

Configure these user-managed variables for Preview only until the controlled retest passes:

- `QSTASH_URL`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`
- `QSTASH_WORKER_URL`

Preview uses QStash US region only. `QSTASH_URL` must be exactly `https://qstash-us-east-1.upstash.io`. Omitting `QSTASH_URL` would let QStash tooling default to a European endpoint, so the application fails closed when it is missing or not the approved US origin. `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY` must all come from the same US-region QStash configuration.

Use a clean HTTPS worker URL with no query string, for example `/api/square/webhook-worker` on the exact Preview deployment URL. Production secrets must be separate from Preview secrets.

Vercel supplies `VERCEL_AUTOMATION_BYPASS_SECRET` as a runtime system variable when Protection Bypass for Automation is enabled. It is not expected in `vercel env ls`, and you should not create a duplicate project environment variable for it.

Do not reuse Preview QStash credentials, signing keys, Square settings, or Vercel bypass secrets in Production.

## Deployment Protection

The worker URL must not contain the Vercel bypass secret. QStash publishes to `QSTASH_WORKER_URL` and forwards `x-vercel-protection-bypass` from `VERCEL_AUTOMATION_BYPASS_SECRET` as a destination header. The worker verifies the QStash signature against the clean exact `QSTASH_WORKER_URL` and never reads or logs the bypass header. A bypass header alone is not sufficient to run the worker; `Upstash-Signature` verification is still mandatory.

## QStash Limits

Current QStash free-tier limits to keep in mind:

- 1,000 messages/day.
- Free max message size: 1 MB.
- Deduplication window: 10 minutes.
- Free-tier DLQ retention: 3 days.
- The free tier does not include a production uptime SLA. Before Production launch, decide whether to use a paid QStash plan/Prod Pack or another queue provider.

Neon's `square_webhook_events.event_id` uniqueness remains the long-term dedupe authority after QStash's short dedupe window expires.

## Signing-Key Rotation

QStash provides current and next signing keys. Keep both configured. Rotate by updating the next key first, deploying, rotating in Upstash, then updating the old current key after deliveries signed by the previous key have drained. Retest both current-key and next-key verification after rotation.

## Worker Authentication

The worker reads the exact raw body and verifies `Upstash-Signature` with `Receiver` before JSON parsing, database access, Square API access, or reconciliation. Malformed normalized messages return QStash's documented non-retryable status/header and move to DLQ instead of retrying indefinitely.

## Retry And DLQ

The intake uses Square `event_id` as QStash's deduplication ID and requests QStash retries for worker failures. QStash retries non-2xx worker responses and moves exhausted failures to DLQ. Inspect QStash logs/DLQ for message state, retry or delete DLQ entries after diagnosis, and reconcile with `square_webhook_events` in Neon before manual retry.

The publish request asks QStash to redact the queue message body and forwarded bypass header in QStash logs/APIs. Redaction is dashboard/API redaction; redacted values remain usable for delivery and are not end-to-end encrypted from Upstash. Do not store raw Square payloads, signatures, notes, customer contact data, or bypass secrets in queue bodies.

## Controlled Retest Gate

The Kai Lani Preview Booking Sync subscription remains disabled until Tyler approves provisioning, Preview variables, deployment, and a controlled Square Sandbox retest.

Controlled Preview test procedure:

1. Provision QStash Preview credentials and Vercel Preview variables.
2. Deploy Preview from the reviewed branch.
3. Confirm the worker URL is the exact clean Preview URL with no bypass query.
4. Enable only the controlled Square Sandbox webhook subscription after approval.
5. Send one controlled Square Sandbox event.
6. Confirm intake returns `202` only after QStash publish acceptance.
7. Confirm worker state in Neon: claimed, processed/ignored/failed as expected, no raw payload stored.
8. Confirm QStash logs/DLQ show redacted body and bypass header.
9. Disable the Square Sandbox subscription again unless the next test is explicitly approved.

Production launch checklist:

1. Decide whether QStash free tier is acceptable for Production or upgrade/use another queue.
2. Create separate Production QStash and Vercel secrets.
3. Configure the Production worker URL with no query string.
4. Run the same controlled test in Sandbox/Preview first.
5. Review DLQ monitoring and manual retry ownership.
6. Enable Production Square webhook only after Tyler approval.
