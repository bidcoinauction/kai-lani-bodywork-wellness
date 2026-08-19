import { isBookingApprovalEnabled } from "../../../lib/approval-config.js";
import { getBookingRequestStore } from "../../../lib/store.js";
import { hashToken } from "../../../lib/tokens.js";
import { sendDeclinedClientEmail } from "../../../lib/email.js";
import { readJsonBody, BodyReadError } from "../../../lib/read-json-body.js";
import { getServiceConfig } from "../../../lib/services.js";

const INVALID_OR_EXPIRED = "This approval link is invalid or has expired.";
const TOKEN_REQUIRED = "An approval token is required.";

/**
 * POST /api/square/booking-requests/decline
 *
 * Declines a still-pending booking request identified by its emailed approval
 * token. Idempotent: declining an already-declined request returns the same
 * safe outcome. The transition is atomic (pending -> declined), so a
 * concurrent approve and decline can never both succeed; once a request is
 * approving, awaiting Square acceptance, approved, failed or expired it can never be declined.
 */
export default async function handler(req, res) {
  if (!isBookingApprovalEnabled()) {
    return res
      .status(503)
      .json({ error: "Booking requests are not available right now." });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return res.status(400).json({ error: TOKEN_REQUIRED });
  }

  const store = getBookingRequestStore();
  await store.expirePendingRequests();

  const row = await store.getRequestByApprovalTokenHash(hashToken(token));
  if (!row) {
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }

  if (row.status === "pending") {
    if (!row.approvalTokenExpiresAt || new Date(row.approvalTokenExpiresAt).getTime() <= Date.now()) {
      return res.status(404).json({ error: INVALID_OR_EXPIRED });
    }
  }

  if (row.status === "approved") {
    return res
      .status(409)
      .json({ status: "approved", error: "This appointment request has already been approved." });
  }
  if (row.status === "approving") {
    return res
      .status(409)
      .json({ status: "approving", error: "This appointment request is being processed. It can no longer be declined." });
  }
  if (row.status === "awaiting_square_acceptance") {
    return res
      .status(409)
      .json({ status: "awaiting_square_acceptance", error: "This appointment request is pending acceptance in Square. It can no longer be declined here." });
  }
  if (row.status === "declined") {
    return res.status(200).json({
      status: "declined",
      requestId: row.id,
      message: "This appointment request was declined.",
    });
  }
  if (row.status === "needs_reschedule") {
    return res.status(200).json({
      status: "needs_reschedule",
      requestId: row.id,
      message: "That time is no longer available. The client has been asked to request a new time.",
    });
  }
  if (row.status === "failed") {
    return res
      .status(409)
      .json({ status: "failed", error: "This appointment request could not be processed and can no longer be declined." });
  }
  if (row.status === "expired") {
    return res.status(404).json({ error: INVALID_OR_EXPIRED });
  }

  const updated = await store.markDeclined({ id: row.id });
  if (!updated) {
    const current = await store.getRequestById(row.id);
    if (current?.status === "approved") {
      return res
        .status(409)
        .json({ status: "approved", error: "This appointment request has already been approved." });
    }
    if (current?.status === "approving") {
      return res
        .status(409)
        .json({ status: "approving", error: "This appointment request is being processed. It can no longer be declined." });
    }
    if (current?.status === "awaiting_square_acceptance") {
      return res
        .status(409)
        .json({ status: "awaiting_square_acceptance", error: "This appointment request is pending acceptance in Square. It can no longer be declined here." });
    }
    if (current?.status === "declined") {
      return res.status(200).json({
        status: "declined",
        requestId: current.id,
        message: "This appointment request was declined.",
      });
    }
    return res
      .status(409)
      .json({ error: "This appointment request was already decided." });
  }

  const service = getServiceConfig(row.serviceKey);
  const declineStatus = await sendDeclinedClientEmail({
    requestId: row.id,
    requestKey: row.requestKey,
    serviceKey: row.serviceKey,
    serviceName: service ? service.name : row.serviceKey,
    durationMinutes: row.durationMinutes,
    startAt: row.startAt,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
  });
  await store.setDeclineEmailStatus(row.id, declineStatus);

  return res.status(200).json({
    status: "declined",
    requestId: row.id,
    message: "This appointment request was declined.",
    notification: { decline: declineStatus },
  });
}
