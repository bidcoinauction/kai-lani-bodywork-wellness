import { randomUUID } from "node:crypto";
import { StoreConflictError, WebhookReconcileError } from "../lib/store.js";
import { isOverlap } from "../lib/overlap.js";
import { generateApprovalToken, hashToken } from "../lib/tokens.js";

/**
 * In-memory booking-request + subscription store implementing the same
 * interface as lib/store.js NeonStore, including the state machine and the
 * invariants the database enforces:
 *   - request_key is unique (duplicate_request_key)
   *   - only ACTIVE (pending/approving/awaiting_square_acceptance) requests hold their time window
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
    this.webhookEvents = new Map();
    this.nextId = 1;
  }

  _active(status) {
    return status === "pending" || status === "approving" || status === "awaiting_square_acceptance";
  }

  _overlapConflict(startAt, durationMinutes) {
    const start = new Date(startAt).getTime();
    const end = start + durationMinutes * 60000;
    for (const row of this.rows.values()) {
      if (!this._active(row.status)) continue;
      const rowStart = new Date(row.startAt).getTime();
      const rowEnd = rowStart + row.durationMinutes * 60000;
      if (
        isOverlap(new Date(start), new Date(end), new Date(rowStart), new Date(rowEnd))
      ) {
        return true;
      }
    }
    return false;
  }

  _row(id) {
    for (const row of this.rows.values()) {
      if (row.id === String(id) || row.requestKey === String(id)) return { ...row };
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
      squareServiceVariationId: null,
      squareLocationId: null,
      squareTeamMemberId: null,
      squareBookingVersion: null,
      squareSyncStatus: "not_created",
      squareLastSyncedAt: null,
      squareSyncError: null,
      squareCanceledAt: null,
      squarePaymentLinkId: null,
      squareOrderId: null,
      paymentLinkUrl: null,
      paymentStatus: null,
      paymentCreatedAt: null,
      paymentCompletedAt: null,
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

  async findRequestBySquareBookingId(squareBookingId) {
    for (const row of this.rows.values()) {
      if (row.squareBookingId === String(squareBookingId)) return { ...row };
    }
    return null;
  }

  async recordPaymentLink({ id, squarePaymentLinkId, squareOrderId, paymentLinkUrl }) {
    const row = this._findById(String(id));
    if (!row || row.status !== "approved" || row.squareBookingStatus !== "ACCEPTED") return null;
    row.squarePaymentLinkId ||= squarePaymentLinkId || null;
    row.squareOrderId ||= squareOrderId || null;
    row.paymentLinkUrl ||= paymentLinkUrl || null;
    if (row.paymentStatus !== "paid") row.paymentStatus = "link_created";
    row.paymentCreatedAt ||= new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async markPaymentPaid({ id }) {
    const row = this._findById(String(id));
    if (!row || row.status !== "approved") return null;
    row.paymentStatus = "paid";
    row.paymentCompletedAt ||= new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async claimWebhookEvent({ eventId, eventType, merchantId, squareBookingId, squareBookingVersion }) {
    let event = this.webhookEvents.get(eventId);
    const now = new Date();
    if (!event) {
      event = {
        id: randomUUID(),
        eventId,
        eventType,
        merchantId: merchantId || null,
        squareBookingId: squareBookingId || null,
        squareBookingVersion: squareBookingVersion ?? null,
        processingStatus: "received",
        attemptCount: 0,
        receivedAt: now,
        processingStartedAt: null,
        processedAt: null,
        safeErrorCode: null,
      };
      this.webhookEvents.set(eventId, event);
    }
    const processingStartedAt = event.processingStartedAt ? new Date(event.processingStartedAt).getTime() : null;
    const staleProcessing =
      event.processingStatus === "processing" &&
      processingStartedAt != null &&
      processingStartedAt < now.getTime() - 10 * 60 * 1000;
    if (event.processingStatus === "received" || event.processingStatus === "failed" || staleProcessing) {
      event.processingStatus = "processing";
      event.processingStartedAt = now;
      event.attemptCount += 1;
      event.safeErrorCode = null;
      return { claimed: true, event: { ...event } };
    }
    return { claimed: false, event: { ...event } };
  }

  async markWebhookProcessed(eventId) {
    const event = this.webhookEvents.get(eventId);
    if (!event) return null;
    event.processingStatus = "processed";
    event.processedAt = new Date();
    event.safeErrorCode = null;
    return { ...event };
  }

  async markWebhookIgnored(eventId, safeErrorCode = null) {
    const event = this.webhookEvents.get(eventId);
    if (!event) return null;
    event.processingStatus = "ignored";
    event.processedAt = new Date();
    event.safeErrorCode = safeErrorCode;
    return { ...event };
  }

  async markWebhookFailed(eventId, safeErrorCode) {
    const event = this.webhookEvents.get(eventId);
    if (!event) return null;
    event.processingStatus = "failed";
    event.safeErrorCode = safeErrorCode;
    return { ...event };
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
      if (row.id === String(id) || row.requestKey === String(id)) return row;
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

  async _claimEmailSend(id, field) {
    const row = this._findById(String(id));
    if (!row || row[field] === "sent") return false;
    if (row[field] === "sending" && row.updatedAt.getTime() > Date.now() - 5 * 60 * 1000) {
      return false;
    }
    row[field] = "sending";
    row.updatedAt = new Date();
    return true;
  }

  async claimConfirmationEmailSend(id) {
    return this._claimEmailSend(id, "confirmationEmailStatus");
  }

  async claimProviderConfirmationEmailSend(id) {
    return this._claimEmailSend(id, "providerConfirmationEmailStatus");
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
    if (!row || (row.status !== "approving" && row.status !== "awaiting_square_acceptance")) return null;
    row.approvalStartedAt = new Date();
    row.approvalAttemptCount += 1;
    row.updatedAt = new Date();
    return this._row(row.id);
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
    const row = this._findById(id);
    if (!row || row.status !== "approving") return null;
    row.status = "awaiting_square_acceptance";
    row.squareCustomerId = squareCustomerId;
    row.squareBookingId = squareBookingId;
    row.squareBookingVersion = squareBookingVersion == null ? null : Number(squareBookingVersion);
    row.squareBookingStatus = squareBookingStatus;
    row.squareServiceVariationId = squareServiceVariationId || null;
    row.squareLocationId = squareLocationId || null;
    row.squareTeamMemberId = squareTeamMemberId || null;
    row.squareSyncStatus = "creating";
    row.squareLastSyncedAt = new Date();
    row.calendarUrl = null;
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async updateAwaitingSquareAcceptance({ id, squareBookingVersion, squareBookingStatus }) {
    const row = this._findById(id);
    if (!row || row.status !== "awaiting_square_acceptance") return null;
    row.squareBookingVersion = squareBookingVersion == null ? null : Number(squareBookingVersion);
    row.squareBookingStatus = squareBookingStatus;
    row.squareSyncStatus = "creating";
    row.squareLastSyncedAt = new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
  }

  async markSquareAcceptanceTerminal({ id, squareBookingVersion, squareBookingStatus }) {
    const row = this._findById(id);
    if (!row || row.status !== "awaiting_square_acceptance") return null;
    row.status = "needs_reschedule";
    row.squareBookingVersion = squareBookingVersion == null ? null : Number(squareBookingVersion);
    row.squareBookingStatus = squareBookingStatus;
    row.squareSyncStatus = "canceled";
    row.squareLastSyncedAt = new Date();
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    return this._row(row.id);
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
    const row = this._findById(id);
    if (!row || (row.status !== "approving" && row.status !== "awaiting_square_acceptance")) return null;
    row.status = "approved";
    row.squareCustomerId = squareCustomerId;
    row.squareBookingId = squareBookingId;
    row.squareBookingVersion = squareBookingVersion == null ? null : Number(squareBookingVersion);
    row.squareBookingStatus = squareBookingStatus;
    row.squareServiceVariationId = squareServiceVariationId || null;
    row.squareLocationId = squareLocationId || null;
    row.squareTeamMemberId = squareTeamMemberId || null;
    row.squareSyncStatus = squareBookingStatus === "ACCEPTED" ? "created" : "creating";
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

  async findPendingOverlaps({ startAt, durationMinutes, excludeId = null, status = "pending" }) {
    const start = new Date(startAt).getTime();
    const end = start + durationMinutes * 60000;
    const rows = [];
    for (const row of this.rows.values()) {
      if (row.status !== status) continue;
      if (excludeId && row.id === String(excludeId)) continue;
      const rowStart = new Date(row.startAt).getTime();
      const rowEnd = rowStart + row.durationMinutes * 60000;
      if (isOverlap(new Date(start), new Date(end), new Date(rowStart), new Date(rowEnd))) {
        rows.push({ ...row });
      }
    }
    return rows;
  }

  async movePendingOverlapToNeedsReschedule(id) {
    const row = this._findById(String(id));
    if (!row || row.status !== "pending") return null;
    row.status = "needs_reschedule";
    row.decidedAt = new Date();
    row.updatedAt = new Date();
    return { ...row };
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
    const row = this._findById(String(requestId));
    if (!row) return null;
    if (
      row.squareBookingVersion != null &&
      Number(squareBookingVersion) <= Number(row.squareBookingVersion)
    ) {
      return { reconciled: false, reason: "stale_version", row: { ...row }, movedPending: [] };
    }

    const start = new Date(startAt);
    const startChanged =
      new Date(row.startAt).getTime() !== start.getTime() ||
      Number(row.durationMinutes) !== Number(durationMinutes);
    const shouldProtectSquareTime = squareBookingStatus === "ACCEPTED" && startChanged;
    if (shouldProtectSquareTime) {
      const approving = await this.findPendingOverlaps({
        startAt,
        durationMinutes,
        excludeId: row.id,
        status: "approving",
      });
      if (approving.length > 0) throw new WebhookReconcileError("approving_overlap");
    }

    row.startAt = start;
    row.durationMinutes = Number(durationMinutes);
    row.squareBookingId = squareBookingId;
    row.squareBookingVersion = Number(squareBookingVersion);
    row.squareBookingStatus = squareBookingStatus;
    row.squareServiceVariationId = squareServiceVariationId || null;
    row.squareLocationId = squareLocationId || null;
    row.squareTeamMemberId = squareTeamMemberId || null;
    row.squareSyncStatus = squareSyncStatus;
    row.squareLastSyncedAt = new Date();
    row.squareSyncError = squareSyncError;
    if (squareCanceledAt) row.squareCanceledAt = new Date(squareCanceledAt);
    row.updatedAt = new Date();

    const movedPending = [];
    if (shouldProtectSquareTime) {
      const pending = await this.findPendingOverlaps({
        startAt,
        durationMinutes,
        excludeId: row.id,
        status: "pending",
      });
      for (const overlap of pending) {
        const moved = await this.movePendingOverlapToNeedsReschedule(overlap.id);
        if (moved) movedPending.push(moved);
      }
      const approvingAfter = await this.findPendingOverlaps({
        startAt,
        durationMinutes,
        excludeId: row.id,
        status: "approving",
      });
      if (approvingAfter.length > 0) throw new WebhookReconcileError("approving_overlap");
    }

    return { reconciled: true, row: { ...row }, movedPending };
  }

  async expirePendingRequests() {
    let count = 0;
    const now = Date.now();
    for (const row of this.rows.values()) {
      if (row.status !== "pending") continue;
      if (!row.approvalTokenExpiresAt || row.approvalTokenExpiresAt.getTime() <= now) {
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
