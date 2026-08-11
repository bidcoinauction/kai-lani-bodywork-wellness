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

export function createNeonPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }
  return new Pool({ connectionString });
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
    squareBookingStatus,
    calendarUrl,
  }) {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'approved',
             square_customer_id = $2,
             square_booking_id = $3,
             square_booking_status = $4,
             calendar_url = $5,
             decided_at = now(),
             updated_at = now()
       WHERE id = $1 AND status = 'approving'
       RETURNING *`,
      [id, squareCustomerId, squareBookingId, squareBookingStatus, calendarUrl],
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
       WHERE id = $1 AND status = 'approving'
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

  /**
   * Atomic sweep: every pending request whose approval token has expired is
   * marked expired (releasing its website hold). Runs before availability
   * filtering and before creating a new request.
   */
  async expirePendingRequests() {
    const result = await this.poolClient.query(
      `UPDATE booking_requests
         SET status = 'expired', decided_at = now(), updated_at = now()
       WHERE status = 'pending' AND approval_token_expires_at <= now()
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
