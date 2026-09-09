import { NeonDbError, Pool } from "@neondatabase/serverless";
import { generateApprovalToken, hashToken } from "./tokens.js";

/**
 * Persistence layer for booking requests and email subscriptions. All SQL
 * lives here so API handlers stay thin and testable. A NeonStore is created
 * lazily from DATABASE_URL; tests inject an in-memory store via
 * setBookingRequestStoreForTests().
 *
 * State machine (encoded in the atomic UPDATE ... WHERE status=... guards):
 *   pending -> approving (claimForApproval, on token approval)
 *   pending -> declined (markDeclined, on decline)
 *   pending -> expired  (expirePendingRequests, token TTL elapsed)
 *   approving -> approved          (markApproved, after Square ACCEPTED)
 *   approving -> awaiting_square_acceptance  (markAwaitingSquareAcceptance, after Square PENDING)
 *   awaiting_square_acceptance -> approved   (markApproved, after Square ACCEPTED)
 *   awaiting_square_acceptance -> needs_reschedule (markSquareAcceptanceTerminal)
 *   approving -> needs_reschedule  (markNeedsReschedule, slot gone)
 *   approving -> failed            (markFailed, Square/customer/server error)
 *   approving -> approving         (recordApprovalAttempt, safe resume)
 * Every transition is a single self-contained statement; no transaction is
 * ever held open across a Square or Resend call.
 */

export class StoreConflictError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StoreConflictError";
    this.code = code;
  }
}

let pool = null;
let testStore = null;

// Keep individual Neon operations inside Square's 10-second delivery window.
// Synchronous reconciliation is Sandbox-only; a durable queue/worker is
// required before Production webhook activation. Long SQL is server-canceled;
// cold pooled connection attempts are allowed a small separate budget.
const NEON_QUERY_TIMEOUT_MS = 500;
const NEON_CONNECTION_TIMEOUT_MS = 1000;

export function createNeonPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }
  return new Pool({
    connectionString,
    statement_timeout: NEON_QUERY_TIMEOUT_MS,
    connectionTimeoutMillis: NEON_CONNECTION_TIMEOUT_MS,
  });
}

export function getBookingRequestStore() {
  if (testStore) return testStore;
  if (!pool) pool = createNeonPool();
  return new NeonStore(pool);
}

/**
 * Test-only seam. Injects an in-memory store so unit tests never touch Neon.
 * Must never be called from production code.
 */
export function setBookingRequestStoreForTests(store) {
  testStore = store;
}

export function resetBookingRequestStoreForTests() {
  testStore = null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestKey: row.request_key,
    serviceKey: row.service_key,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    startAt: row.start_at,
    durationMinutes: row.duration_minutes,
    status: row.status,
    approvalTokenHash: row.approval_token_hash,
    approvalTokenExpiresAt: row.approval_token_expires_at,
    approvalStartedAt: row.approval_started_at,
    approvalAttemptCount: row.approval_attempt_count,
    failureCode: row.failure_code,
    squareCustomerId: row.square_customer_id,
    squareBookingId: row.square_booking_id,
    squareBookingStatus: row.square_booking_status,
    squareServiceVariationId: row.square_service_variation_id,
    squareLocationId: row.square_location_id,
    squareTeamMemberId: row.square_team_member_id,
    squareBookingVersion: row.square_booking_version == null ? null : Number(row.square_booking_version),
    squareSyncStatus: row.square_sync_status || null,
    squareLastSyncedAt: row.square_last_synced_at,
    squareSyncError: row.square_sync_error,
    squareCanceledAt: row.square_canceled_at,
    squarePaymentLinkId: row.square_payment_link_id,
    squareOrderId: row.square_order_id,
    paymentLinkUrl: row.payment_link_url,
    paymentStatus: row.payment_status || null,
    paymentCreatedAt: row.payment_created_at,
    paymentCompletedAt: row.payment_completed_at,
    calendarUrl: row.calendar_url,
    requestReceiptEmailStatus: row.request_receipt_email_status,
    approvalEmailStatus: row.approval_email_status,
    confirmationEmailStatus: row.confirmation_email_status,
    providerConfirmationEmailStatus: row.provider_confirmation_email_status,
    declineEmailStatus: row.decline_email_status,
    needsRescheduleEmailStatus: row.needs_reschedule_email_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

function mapWebhookEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    merchantId: row.merchant_id,
    squareBookingId: row.square_booking_id,
    squareBookingVersion: row.square_booking_version == null ? null : Number(row.square_booking_version),
    processingStatus: row.processing_status,
    attemptCount: row.attempt_count,
    receivedAt: row.received_at,
    processingStartedAt: row.processing_started_at,
    processedAt: row.processed_at,
    safeErrorCode: row.safe_error_code,
  };
}

export class WebhookReconcileError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebhookReconcileError";
    this.code = code;
  }
}

const WEBHOOK_PROCESSING_STALE_MINUTES = 10;

function mapSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    normalizedEmail: row.normalized_email,
    squareCustomerId: row.square_customer_id,
    status: row.status,
    consentSource: row.consent_source,
    consentAt: row.consent_at,
    unsubscribedAt: row.unsubscribed_at,
    unsubscribeTokenHash: row.unsubscribe_token_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "23505";

export class NeonStore {
  constructor(poolClient) {
    this.poolClient = poolClient;
  }

  /**
   * Transaction hook: reserves a connection and runs fn(client) inside
   * BEGIN/COMMIT, rolling back on error. Used only for genuinely atomic
   * multi-statement work; the approval flow itself never wraps Square or
   * Resend calls in a transaction.
   */
  async withTransaction(fn) {
    const client = await this.poolClient.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createRequest({
    requestKey,
    serviceKey,
    firstName,
    lastName,
    email,
    phone,
    startAt,
    durationMinutes,
    approvalTokenHash,
    approvalTokenExpiresAt,
  }) {
    try {
      const result = await this.poolClient.query(
        `INSERT INTO booking_requests
           (request_key, service_key, first_name, last_name, email, phone,
            start_at, duration_minutes, approval_token_hash, approval_token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          requestKey,
          serviceKey,
          firstName,
          lastName,
          email,
          phone,
          startAt,
          durationMinutes,
          approvalTokenHash,
          approvalTokenExpiresAt,
        ],
      );
      return mapRow(result.rows[0]);
    } catch (error) {
      if (error instanceof NeonDbError && error.code === EXCLUSION_VIOLATION) {
        throw new StoreConflictError("That time is no longer available. Please pick another.", error.code);
      }
      if (error instanceof NeonDbError && error.code === UNIQUE_VIOLATION) {
        throw new StoreConflictError("duplicate_request_key", error.code);
      }
      throw error;
    }
  }

  async getRequestByKey(requestKey) {
    const result = await this.poolClient.query(
      "SELECT * FROM booking_requests WHERE request_key = $1",
      [requestKey],
    );
    return mapRow(result.rows[0] || null);
  }

  /**
   * Looks up a request by its approval-token hash WITHOUT filtering on expiry:
   * the handler decides how to answer an expired token (404) vs a valid one.
   */
  async getRequestByApprovalTokenHash(hash) {
    const result = await this.poolClient.query(
      "SELECT * FROM booking_requests WHERE approval_token_hash = $1",
      [hash],
    );
    return mapRow(result.rows[0] || null);
  }

  async getRequestById(id) {
    const result = await this.poolClient.query(
      "SELECT * FROM booking_requests WHERE id = $1",
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  async findRequestBySquareBookingId(squareBookingId) {
    const result = await this.poolClient.query(
      "SELECT * FROM booking_requests WHERE square_booking_id = $1",
      [squareBookingId],
    );
    return mapRow(result.rows[0] || null);
  }

  async recordPaymentLink({ id, squarePaymentLinkId, squareOrderId, paymentLinkUrl }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET square_payment_link_id = COALESCE(square_payment_link_id, $2),
              square_order_id = COALESCE(square_order_id, $3),
              payment_link_url = COALESCE(payment_link_url, $4),
              payment_status = CASE
                WHEN payment_status = 'paid' THEN payment_status
                ELSE 'link_created'
              END,
              payment_created_at = COALESCE(payment_created_at, now()),
              updated_at = now()
        WHERE id = $1
          AND status = 'approved'
          AND square_booking_status = 'ACCEPTED'
        RETURNING *`,
      [id, squarePaymentLinkId || null, squareOrderId || null, paymentLinkUrl || null],
    );
    return mapRow(result.rows[0] || null);
  }

  async markPaymentPaid({ id }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET payment_status = 'paid',
              payment_completed_at = COALESCE(payment_completed_at, now()),
              updated_at = now()
        WHERE id = $1
          AND status = 'approved'
        RETURNING *`,
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  async claimWebhookEvent({ eventId, eventType, merchantId, squareBookingId, squareBookingVersion }) {
    await this.poolClient.query(
      `INSERT INTO square_webhook_events
         (event_id, event_type, merchant_id, square_booking_id, square_booking_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO UPDATE
         SET event_type = EXCLUDED.event_type,
             merchant_id = COALESCE(square_webhook_events.merchant_id, EXCLUDED.merchant_id),
             square_booking_id = COALESCE(square_webhook_events.square_booking_id, EXCLUDED.square_booking_id),
             square_booking_version = COALESCE(square_webhook_events.square_booking_version, EXCLUDED.square_booking_version)`,
      [eventId, eventType, merchantId || null, squareBookingId || null, squareBookingVersion ?? null],
    );

    const claimed = await this.poolClient.query(
      `UPDATE square_webhook_events
          SET processing_status = 'processing',
              processing_started_at = now(),
              attempt_count = attempt_count + 1,
              safe_error_code = NULL
        WHERE event_id = $1
          AND (
            processing_status IN ('received', 'failed')
            OR (
              processing_status = 'processing'
              AND processing_started_at < now() - $2::integer * interval '1 minute'
            )
          )
        RETURNING *`,
      [eventId, WEBHOOK_PROCESSING_STALE_MINUTES],
    );
    if (claimed.rows[0]) {
      return { claimed: true, event: mapWebhookEvent(claimed.rows[0]) };
    }

    const existing = await this.poolClient.query(
      "SELECT * FROM square_webhook_events WHERE event_id = $1",
      [eventId],
    );
    return { claimed: false, event: mapWebhookEvent(existing.rows[0] || null) };
  }

  async markWebhookProcessed(eventId) {
    const result = await this.poolClient.query(
      `UPDATE square_webhook_events
          SET processing_status = 'processed',
              processed_at = now(),
              safe_error_code = NULL
        WHERE event_id = $1
        RETURNING *`,
      [eventId],
    );
    return mapWebhookEvent(result.rows[0] || null);
  }

  async markWebhookIgnored(eventId, safeErrorCode = null) {
    const result = await this.poolClient.query(
      `UPDATE square_webhook_events
          SET processing_status = 'ignored',
              processed_at = now(),
              safe_error_code = $2
        WHERE event_id = $1
        RETURNING *`,
      [eventId, safeErrorCode],
    );
    return mapWebhookEvent(result.rows[0] || null);
  }

  async markWebhookFailed(eventId, safeErrorCode) {
    const result = await this.poolClient.query(
      `UPDATE square_webhook_events
          SET processing_status = 'failed',
              safe_error_code = $2
        WHERE event_id = $1
        RETURNING *`,
      [eventId, safeErrorCode],
    );
    return mapWebhookEvent(result.rows[0] || null);
  }

  async setRequestReceiptEmailStatus(id, status) {
    await this.poolClient.query(
      `UPDATE booking_requests SET request_receipt_email_status = $2, updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
  }

  async setApprovalEmailStatus(id, status) {
    await this.poolClient.query(
      `UPDATE booking_requests SET approval_email_status = $2, updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
  }

  async setConfirmationEmailStatus(id, status) {
    await this.poolClient.query(
      `UPDATE booking_requests SET confirmation_email_status = $2, updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
  }

  async setProviderConfirmationEmailStatus(id, status) {
    await this.poolClient.query(
      `UPDATE booking_requests SET provider_confirmation_email_status = $2, updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
  }

  async setDeclineEmailStatus(id, status) {
    await this.poolClient.query(
      `UPDATE booking_requests SET decline_email_status = $2, updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
  }

  async setNeedsRescheduleEmailStatus(id, status) {
    await this.poolClient.query(
      `UPDATE booking_requests SET needs_reschedule_email_status = $2, updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
  }

  /**
   * Atomic claim: pending -> approving. Increments the attempt counter and
   * records approval_started_at BEFORE any Square or Resend call. Fails
   * (returns null) when the request is not pending or the token already
   * expired, so a concurrent approver or an expired row is never overrun.
   */
  async claimForApproval(id) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'approving',
             approval_started_at = now(),
             approval_attempt_count = approval_attempt_count + 1,
             updated_at = now()
       WHERE id = $1
         AND status = 'pending'
         AND approval_token_expires_at > now()
       RETURNING *`,
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  /**
   * Resume of an in-flight approval (status is already 'approving'). Safe
   * because the Square booking and customer calls use deterministic
   * idempotency keys derived from the request id, so a resumed attempt can
   * never create a second independent booking.
   */
  async recordApprovalAttempt(id) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET approval_started_at = now(),
             approval_attempt_count = approval_attempt_count + 1,
             updated_at = now()
       WHERE id = $1 AND status = 'approving'
       RETURNING *`,
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  async markApproved({
    id,
    squareCustomerId,
    squareBookingId,
    squareBookingVersion,
    squareBookingStatus,
    squareServiceVariationId,
    squareLocationId,
    squareTeamMemberId,
    calendarUrl,
  }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'approved',
              square_customer_id = $2,
              square_booking_id = $3,
              square_booking_version = $4,
              square_booking_status = $5,
              square_service_variation_id = $6,
              square_location_id = $7,
              square_team_member_id = $8,
              square_sync_status = CASE WHEN $5 = 'ACCEPTED' THEN 'created' ELSE 'creating' END,
              square_last_synced_at = now(),
              calendar_url = $9,
              decided_at = now(),
              updated_at = now()
        WHERE id = $1 AND status IN ('approving', 'awaiting_square_acceptance')
        RETURNING *`,
      [
        id,
        squareCustomerId,
        squareBookingId,
        squareBookingVersion == null ? null : Number(squareBookingVersion),
        squareBookingStatus,
        squareServiceVariationId || null,
        squareLocationId || null,
        squareTeamMemberId || null,
        calendarUrl,
      ],
    );
    return mapRow(result.rows[0] || null);
  }

  async claimConfirmationEmailSend(id) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET confirmation_email_status = 'sending', updated_at = now()
        WHERE id = $1
          AND confirmation_email_status <> 'sent'
          AND (
            confirmation_email_status <> 'sending'
            OR updated_at < now() - interval '5 minutes'
          )
        RETURNING id`,
      [id],
    );
    return result.rowCount === 1;
  }

  async claimProviderConfirmationEmailSend(id) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET provider_confirmation_email_status = 'sending', updated_at = now()
        WHERE id = $1
          AND provider_confirmation_email_status <> 'sent'
          AND (
            provider_confirmation_email_status <> 'sending'
            OR updated_at < now() - interval '5 minutes'
          )
        RETURNING id`,
      [id],
    );
    return result.rowCount === 1;
  }

  async markAwaitingSquareAcceptance({
    id,
    squareCustomerId,
    squareBookingId,
    squareBookingVersion,
    squareBookingStatus,
    squareServiceVariationId,
    squareLocationId,
    squareTeamMemberId,
  }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'awaiting_square_acceptance',
             square_customer_id = $2,
             square_booking_id = $3,
             square_booking_version = $4,
             square_booking_status = $5,
             square_service_variation_id = $6,
             square_location_id = $7,
             square_team_member_id = $8,
             square_sync_status = 'creating',
             square_last_synced_at = now(),
             calendar_url = NULL,
             updated_at = now()
       WHERE id = $1 AND status = 'approving'
       RETURNING *`,
      [
        id,
        squareCustomerId,
        squareBookingId,
        squareBookingVersion == null ? null : Number(squareBookingVersion),
        squareBookingStatus,
        squareServiceVariationId || null,
        squareLocationId || null,
        squareTeamMemberId || null,
      ],
    );
    return mapRow(result.rows[0] || null);
  }

  async updateAwaitingSquareAcceptance({ id, squareBookingVersion, squareBookingStatus }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET square_booking_version = $2,
              square_booking_status = $3,
              square_sync_status = 'creating',
              square_last_synced_at = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'awaiting_square_acceptance'
        RETURNING *`,
      [id, squareBookingVersion == null ? null : Number(squareBookingVersion), squareBookingStatus],
    );
    return mapRow(result.rows[0] || null);
  }

  async markSquareAcceptanceTerminal({ id, squareBookingVersion, squareBookingStatus }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET status = 'needs_reschedule',
              square_booking_version = $2,
              square_booking_status = $3,
              square_sync_status = 'canceled',
              square_last_synced_at = now(),
              decided_at = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'awaiting_square_acceptance'
        RETURNING *`,
      [id, squareBookingVersion == null ? null : Number(squareBookingVersion), squareBookingStatus],
    );
    return mapRow(result.rows[0] || null);
  }

  async markDeclined({ id }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'declined', decided_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  async markNeedsReschedule({ id }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'needs_reschedule', decided_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('approving', 'awaiting_square_acceptance')
       RETURNING *`,
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  async markFailed({ id, failureCode }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'failed',
             failure_code = $2,
             decided_at = now(),
             updated_at = now()
       WHERE id = $1 AND status = 'approving'
       RETURNING *`,
      [id, failureCode],
    );
    return mapRow(result.rows[0] || null);
  }

  async findPendingOverlaps({ startAt, durationMinutes, excludeId = null, status = "pending" }) {
    const result = await this.poolClient.query(
      `SELECT *
         FROM booking_requests
        WHERE status = $4
          AND ($3::uuid IS NULL OR id <> $3::uuid)
          AND tsrange(
                start_at AT TIME ZONE 'UTC',
                 (start_at AT TIME ZONE 'UTC') + (duration_minutes + 30) * interval '1 minute',
                '[)'
              ) && tsrange(
                $1::timestamptz AT TIME ZONE 'UTC',
                 ($1::timestamptz AT TIME ZONE 'UTC') + ($2::integer + 30) * interval '1 minute',
                '[)'
              )
        ORDER BY start_at`,
      [startAt, durationMinutes, excludeId, status],
    );
    return result.rows.map(mapRow);
  }

  async movePendingOverlapToNeedsReschedule(id) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
          SET status = 'needs_reschedule', decided_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [id],
    );
    return mapRow(result.rows[0] || null);
  }

  async reconcileSquareBooking({
    requestId,
    squareBookingId,
    squareBookingVersion,
    squareBookingStatus,
    startAt,
    durationMinutes,
    squareServiceVariationId,
    squareLocationId,
    squareTeamMemberId,
    squareSyncStatus,
    squareCanceledAt = null,
    squareSyncError = null,
  }) {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query(
        "SELECT * FROM booking_requests WHERE id = $1 FOR UPDATE",
        [requestId],
      );
      const current = currentResult.rows[0] ? mapRow(currentResult.rows[0]) : null;
      if (!current) return null;

      if (
        current.squareBookingVersion != null &&
        Number(squareBookingVersion) <= Number(current.squareBookingVersion)
      ) {
        return { reconciled: false, reason: "stale_version", row: current, movedPending: [] };
      }

      const start = new Date(startAt);
      const startChanged =
        new Date(current.startAt).getTime() !== start.getTime() ||
        Number(current.durationMinutes) !== Number(durationMinutes);
      const shouldProtectSquareTime =
        squareBookingStatus === "ACCEPTED" && startChanged;

      if (shouldProtectSquareTime) {
        const approving = await client.query(
          `SELECT id
             FROM booking_requests
            WHERE status = 'approving'
              AND id <> $3::uuid
              AND tsrange(
                    start_at AT TIME ZONE 'UTC',
                    (start_at AT TIME ZONE 'UTC') + (duration_minutes + 30) * interval '1 minute',
                    '[)'
                  ) && tsrange(
                    $1::timestamptz AT TIME ZONE 'UTC',
                    ($1::timestamptz AT TIME ZONE 'UTC') + ($2::integer + 30) * interval '1 minute',
                    '[)'
                  )`,
          [start.toISOString(), durationMinutes, requestId],
        );
        if (approving.rowCount > 0) {
          throw new WebhookReconcileError("approving_overlap");
        }
      }

      const update = await client.query(
        `UPDATE booking_requests
            SET start_at = $2,
                duration_minutes = $3,
                square_booking_id = $4,
                square_booking_version = $5,
                square_booking_status = $6,
                square_service_variation_id = $7,
                square_location_id = $8,
                square_team_member_id = $9,
                square_sync_status = $10,
                square_last_synced_at = now(),
                square_sync_error = $11,
                square_canceled_at = COALESCE($12::timestamptz, square_canceled_at),
                updated_at = now()
          WHERE id = $1
            AND (
              square_booking_version IS NULL
              OR $5::bigint > square_booking_version
            )
          RETURNING *`,
        [
          requestId,
          start.toISOString(),
          durationMinutes,
          squareBookingId,
          squareBookingVersion,
          squareBookingStatus,
          squareServiceVariationId || null,
          squareLocationId || null,
          squareTeamMemberId || null,
          squareSyncStatus,
          squareSyncError,
          squareCanceledAt,
        ],
      );
      if (!update.rows[0]) {
        return { reconciled: false, reason: "stale_version", row: current, movedPending: [] };
      }

      const movedPending = [];
      if (shouldProtectSquareTime) {
        const pending = await client.query(
          `UPDATE booking_requests
              SET status = 'needs_reschedule', decided_at = now(), updated_at = now()
            WHERE status = 'pending'
              AND id <> $3::uuid
              AND tsrange(
                    start_at AT TIME ZONE 'UTC',
                    (start_at AT TIME ZONE 'UTC') + (duration_minutes + 30) * interval '1 minute',
                    '[)'
                  ) && tsrange(
                    $1::timestamptz AT TIME ZONE 'UTC',
                    ($1::timestamptz AT TIME ZONE 'UTC') + ($2::integer + 30) * interval '1 minute',
                    '[)'
                  )
            RETURNING *`,
          [start.toISOString(), durationMinutes, requestId],
        );
        movedPending.push(...pending.rows.map(mapRow));

        const approvingAfter = await client.query(
          `SELECT id
             FROM booking_requests
            WHERE status = 'approving'
              AND id <> $3::uuid
              AND tsrange(
                    start_at AT TIME ZONE 'UTC',
                    (start_at AT TIME ZONE 'UTC') + (duration_minutes + 30) * interval '1 minute',
                    '[)'
                  ) && tsrange(
                    $1::timestamptz AT TIME ZONE 'UTC',
                    ($1::timestamptz AT TIME ZONE 'UTC') + ($2::integer + 30) * interval '1 minute',
                    '[)'
                  )`,
          [start.toISOString(), durationMinutes, requestId],
        );
        if (approvingAfter.rowCount > 0) {
          throw new WebhookReconcileError("approving_overlap");
        }
      }

      return {
        reconciled: true,
        row: mapRow(update.rows[0]),
        movedPending,
      };
    });
  }

  /**
   * Atomic sweep: every pending request whose approval token has expired is
   * marked expired (releasing its website hold). Runs before availability
   * filtering and before creating a new request.
   */
  async expirePendingRequests() {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'expired', decided_at = now(), updated_at = now()
       WHERE status = 'pending'
         AND (approval_token_expires_at IS NULL OR approval_token_expires_at <= now())
       RETURNING id`,
    );
    return result.rowCount || 0;
  }

  /**
   * Records explicit marketing consent from the booking form. Never creates
   * a row for consent_source other than 'kai-lani-booking-form' at the call
   * site, never re-subscribes an unsubscribed address, and always (re)issues
   * a fresh unsubscribe token whose hash is the only thing stored. Returns
   * the raw token ONCE to the caller so it can be placed in a future
   * List-Unsubscribe header; the API never returns or logs it.
   */
  async subscribeEmail({ normalizedEmail, squareCustomerId }) {
    const existing = await this.getSubscriptionByEmail(normalizedEmail);
    if (existing && existing.status === "unsubscribed") {
      return { created: false, status: "unsubscribed", rawToken: null };
    }

    const rawToken = generateApprovalToken();
    const unsubscribeTokenHash = hashToken(rawToken);
    const result = await this.poolClient.query(
      `INSERT INTO email_subscriptions
         (normalized_email, square_customer_id, status, consent_source,
          consent_at, unsubscribe_token_hash)
       VALUES ($1, $2, 'subscribed', 'kai-lani-booking-form', now(), $3)
       ON CONFLICT (normalized_email) DO UPDATE
         SET status = 'subscribed',
             consent_source = 'kai-lani-booking-form',
             consent_at = now(),
             unsubscribed_at = NULL,
             unsubscribe_token_hash = EXCLUDED.unsubscribe_token_hash,
             square_customer_id = COALESCE(email_subscriptions.square_customer_id, EXCLUDED.square_customer_id),
             updated_at = now()
       RETURNING *`,
      [normalizedEmail, squareCustomerId || null, unsubscribeTokenHash],
    );
    return {
      created: !existing,
      status: "subscribed",
      rawToken,
      subscription: mapSubscription(result.rows[0]),
    };
  }

  async getSubscriptionByEmail(normalizedEmail) {
    const result = await this.poolClient.query(
      "SELECT * FROM email_subscriptions WHERE normalized_email = $1",
      [normalizedEmail],
    );
    return mapSubscription(result.rows[0] || null);
  }

  async getSubscriptionByUnsubscribeTokenHash(hash) {
    const result = await this.poolClient.query(
      "SELECT * FROM email_subscriptions WHERE unsubscribe_token_hash = $1",
      [hash],
    );
    return mapSubscription(result.rows[0] || null);
  }

  async unsubscribeByTokenHash(hash) {
    const result = await this.poolClient.query(
      `UPDATE email_subscriptions
         SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
       WHERE unsubscribe_token_hash = $1 AND status = 'subscribed'
       RETURNING *`,
      [hash],
    );
    return mapSubscription(result.rows[0] || null);
  }

  /**
   * Best-effort backfill: once Square creates a customer at approval time,
   * link any matching subscription so future marketing can reference it.
   */
  async backfillSubscriptionCustomer(normalizedEmail, squareCustomerId) {
    await this.poolClient.query(
      `UPDATE email_subscriptions
         SET square_customer_id = $2, updated_at = now()
       WHERE normalized_email = $1 AND square_customer_id IS NULL`,
      [normalizedEmail, squareCustomerId],
    );
  }
}
