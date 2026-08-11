import { randomUUID } from "node:crypto";
import { StoreConflictError } from "../lib/store.js";
import { isOverlap } from "../lib/overlap.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";

/**
 * In-memory booking-request + subscription store implementing the same
 * interface as lib/store.js NeonStore, including the state machine and the
 * invariants the database enforces:
 *   - request_key is unique (duplicate_request_key)
 *   - only ACTIVE (pending/approving) requests hold their time window
 *   - transitions are atomic guards on status (pending->approving,
 *     approving->approved/needs_reschedule/failed, pending->declined/expired)
 *   - approval-token expiry is honored; the sweep releases holds
 *   - email_subscriptions: normalized email unique, unsubscribe never
 *     re-subscribes, only the token hash is stored
 *
 * Test-only. Never imported by production code.
 */
export class MemoryBookingRequestStore {
  constructor() {
    this.rows = new Map();
    this.subscriptions = new Map();
    this.nextId = 1;
  }

  _active(status) {
    return status === "pending" || status === "approving";
  }

  _overlapConflict(startAt, durationMinutes) {
    const start = new Date(startAt).getTime();
    const end = start + durationMinutes * 60000;
    for (const row of this.rows.values()) {
      if (!this._active(row.status)) continue;
      const rowStart = new Date(row.startAt).getTime();
      const rowEnd = rowStart + row.durationMinutes * 60000;
      if (
        isOverlap(new Date(start), new Date(end), new Date(rowStart), new Date(rowEnd), {
          bufferMs: 0,
        })
      ) {
        return true;
      }
    }
    return false;
  }

  _row(id) {
    for (const row of this.rows.values()) {
      if (row.id === String(id)) return { ...row };
    }
    return null;
  }

  _findByHash(hash) {
    for (const row of this.rows.values()) {
      if (row.approvalTokenHash === hash) return row;
    }
    return null;
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
    if (this.rows.has(String(requestKey))) {
      throw new StoreConflictError("duplicate_request_key", "23505");
    }
    if (this._overlapConflict(startAt, durationMinutes)) {
      throw new StoreConflictError(
        "That time is no longer available. Please pick another.",
        "23P01",
      );
    }
    const now = new Date();
    const row = {
      id: randomUUID(),
      requestKey: String(requestKey),
      serviceKey,
      firstName,
      lastName,
      email,
      phone,
      startAt: new Date(startAt),
      durationMinutes,
      status: "pending",
      approvalTokenHash,
      approvalTokenExpiresAt: approvalTokenExpiresAt
        ? new Date(approvalTokenExpiresAt)
        : null,
      approvalStartedAt: null,
      approvalAttemptCount: 0,
      failureCode: null,
      squareCustomerId: null,
      squareBookingId: null,
      squareBookingStatus: null,
      calendarUrl: null,
      requestReceiptEmailStatus: "none",
      approvalEmailStatus: "none",
      confirmationEmailStatus: "none",
      providerConfirmationEmailStatus: "none",
      declineEmailStatus: "none",
      needsRescheduleEmailStatus: "none",
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    };
    this.rows.set(row.requestKey, row);
    return this._row(row.id);
  }

  async getRequestByKey(requestKey) {
    return this._row(this.rows.get(String(requestKey))?.id);
  }

  async getRequestByApprovalTokenHash(hash) {
    const row = this._findByHash(hash);
    return row ? this._row(row.id) : null;
  }

  async getRequestById(id) {
    return this._row(String(id));
  }

  async _updateEmailStatus(id, field, status) {
    const row = this._findById(String(id));
    if (row) {
      row[field] = status;
      row.updatedAt = new Date();
    }
  }

  _findById(id) {
    for (const row of this.rows.values()) {
      if (row.id === String(id)) return row;
    }
    return null;
  }

  async setRequestReceiptEmailStatus(id, status) {
    await this._updateEmailStatus(id, "requestReceiptEmailStatus", status);
  }

  async setApprovalEmailStatus(id, status) {
    await this._updateEmailStatus(id, "approvalEmailStatus", status);
  }

  async setConfirmationEmailStatus(id, status) {
    await this._updateEmailStatus(id, "confirmationEmailStatus", status);
  }

  async setProviderConfirmationEmailStatus(id, status) {
    await this._updateEmailStatus(id, "providerConfirmationEmailStatus", status);
  }

  async setDeclineEmailStatus(id, status) {
    await this._updateEmailStatus(id, "declineEmailStatus", status);
  }

  async setNeedsRescheduleEmailStatus(id, status) {
    await this._updateEmailStatus(id, "needsRescheduleEmailStatus", status);
  }

  async claimForApproval(id) {
    const row = this._findById(id);
    if (!row) return null;
    if (row.status !== "pending") return null;
    if (!row.approvalTokenExpiresAt || row.approvalTokenExpiresAt.getTime() <= Date.now()) {
      return null;
    }
    row.status = "approving";
    row.approvalStartedAt = new Date();
    row.approvalAttemptCount += 1;
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async recordApprovalAttempt(id) {
    const row = this._findById(id);
    if (!row || row.status !== "approving") return null;
    row.approvalStartedAt = new Date();
    row.approvalAttemptCount += 1;
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async markApproved({
    id,
    squareCustomerId,
    squareBookingId,
    squareBookingStatus,
    calendarUrl,
  }) {
    const row = this._findById(id);
    if (!row || row.status !== "approving") return null;
    row.status = "approved";
    row.squareCustomerId = squareCustomerId;
    row.squareBookingId = squareBookingId;
    row.squareBookingStatus = squareBookingStatus;
    row.calendarUrl = calendarUrl || null;
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async markDeclined({ id }) {
    const row = this._findById(id);
    if (!row || row.status !== "pending") return null;
    row.status = "declined";
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async markNeedsReschedule({ id }) {
    const row = this._findById(id);
    if (!row || row.status !== "approving") return null;
    row.status = "needs_reschedule";
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async markFailed({ id, failureCode }) {
    const row = this._findById(id);
    if (!row || row.status !== "approving") return null;
    row.status = "failed";
    row.failureCode = failureCode || null;
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async expirePendingRequests() {
    let count = 0;
    const now = Date.now();
    for (const row of this.rows.values()) {
      if (row.status !== "pending") continue;
      if (row.approvalTokenExpiresAt && row.approvalTokenExpiresAt.getTime() <= now) {
        row.status = "expired";
        row.decidedAt = new Date();
        row.updatedAt = new Date();
        count += 1;
      }
    }
    return count;
  }

  async subscribeEmail({ normalizedEmail, squareCustomerId }) {
    const key = String(normalizedEmail).trim().toLowerCase();
    const existing = this.subscriptions.get(key);
    if (existing && existing.status === "unsubscribed") {
      return { created: false, status: "unsubscribed", rawToken: null };
    }

    const rawToken = generateApprovalToken();
    const unsubscribeTokenHash = hashToken(rawToken);
    const now = new Date();
    if (existing) {
      existing.status = "subscribed";
      existing.consentSource = "kai-lani-booking-form";
      existing.consentAt = now;
      existing.unsubscribedAt = null;
      existing.unsubscribeTokenHash = unsubscribeTokenHash;
      existing.squareCustomerId =
        existing.squareCustomerId || squareCustomerId || null;
      existing.updatedAt = now;
      return {
        created: false,
        status: "subscribed",
        rawToken,
        subscription: { ...existing },
      };
    }

    const subscription = {
      id: randomUUID(),
      normalizedEmail: key,
      squareCustomerId: squareCustomerId || null,
      status: "subscribed",
      consentSource: "kai-lani-booking-form",
      consentAt: now,
      unsubscribedAt: null,
      unsubscribeTokenHash,
      createdAt: now,
      updatedAt: now,
    };
    this.subscriptions.set(key, subscription);
    return {
      created: true,
      status: "subscribed",
      rawToken,
      subscription: { ...subscription },
    };
  }

  async getSubscriptionByEmail(normalizedEmail) {
    const sub = this.subscriptions.get(String(normalizedEmail).trim().toLowerCase());
    return sub ? { ...sub } : null;
  }

  async getSubscriptionByUnsubscribeTokenHash(hash) {
    for (const sub of this.subscriptions.values()) {
      if (sub.unsubscribeTokenHash === hash) return { ...sub };
    }
    return null;
  }

  async unsubscribeByTokenHash(hash) {
    for (const sub of this.subscriptions.values()) {
      if (sub.unsubscribeTokenHash === hash && sub.status === "subscribed") {
        sub.status = "unsubscribed";
        sub.unsubscribedAt = new Date();
        sub.updatedAt = new Date();
        return { ...sub };
      }
    }
    return null;
  }

  async backfillSubscriptionCustomer(normalizedEmail, squareCustomerId) {
    const sub = this.subscriptions.get(String(normalizedEmail).trim().toLowerCase());
    if (sub && sub.squareCustomerId == null) {
      sub.squareCustomerId = squareCustomerId;
      sub.updatedAt = new Date();
    }
  }

  // --- test-only helpers (not part of the NeonStore interface) -------------

  /** Forces a request's approval token to expire for expiry/sweep tests. */
  async setApprovalTokenExpiry(requestId, date) {
    const row = this._findById(String(requestId));
    if (row) row.approvalTokenExpiresAt = new Date(date);
  }
}
