import { isBookingApprovalEnabled } from "../../../lib/approval-config.js";
import { getBookingRequestStore } from "../../../lib/store.js";
import { getServiceConfig } from "../../../lib/services.js";

/**
 * GET /api/square/booking-requests/lookup?requestKey=...
 *
 * Full safe details for a request identified by its client-generated request
 * key. Never returns the approval token, raw provider responses, or anything
 * the client did not already submit.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isBookingApprovalEnabled()) {
    return res
      .status(503)
      .json({ error: "Booking requests are not available right now." });
  }

  const requestKey = typeof req.query?.requestKey === "string" ? req.query.requestKey : "";
  if (!requestKey) {
    return res.status(400).json({ error: "requestKey is required" });
  }

  const store = getBookingRequestStore();
  const row = await store.getRequestByKey(requestKey);
  if (!row) {
    return res.status(404).json({ error: "Request not found" });
  }

  const service = getServiceConfig(row.serviceKey);
  const serviceName = service ? service.name : row.serviceKey;

  return res.status(200).json({
    requestId: row.id,
    requestKey: row.requestKey,
    status: row.status,
    serviceKey: row.serviceKey,
    serviceName,
    durationMinutes: row.durationMinutes,
    startAt: row.startAt,
    bookingId: row.squareBookingId || null,
    squareBookingStatus: row.squareBookingStatus || null,
    failureCode: row.failureCode || null,
    decidedAt: row.decidedAt || null,
    emailStatuses: {
      requestReceipt: row.requestReceiptEmailStatus,
      approval: row.approvalEmailStatus,
      confirmation: row.confirmationEmailStatus,
      providerConfirmation: row.providerConfirmationEmailStatus,
      decline: row.declineEmailStatus,
      needsReschedule: row.needsRescheduleEmailStatus,
    },
  });
}
