import { isBookingApprovalEnabled } from "../../../lib/approval-config.js";
import { getSquareClient } from "../../../lib/square.js";
import { getBookingRequestStore } from "../../../lib/store.js";
import { readJsonBody, BodyReadError } from "../../../lib/read-json-body.js";
import {
  buildPaymentLinkRequest,
  isOrderPaid,
  isPaymentEligible,
  summarizePayment,
} from "../../../lib/payment.js";

const REQUEST_KEY_REQUIRED = "requestKey is required";
const NOT_ELIGIBLE = "Prepayment is available only for confirmed appointments.";

function validHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function safeSquareError(error) {
  const first = Array.isArray(error?.body?.errors) ? error.body.errors[0] : null;
  return {
    status: validHttpStatus(error?.statusCode) ?? validHttpStatus(error?.status) ?? null,
    category: typeof first?.category === "string" ? first.category : null,
    code: typeof first?.code === "string" ? first.code : null,
  };
}

export default async function handler(req, res) {
  if (!isBookingApprovalEnabled()) {
    return res.status(503).json({ error: "Booking requests are not available right now." });
  }

  if (req.method === "GET") return handleStatus(req, res);
  if (req.method === "POST") return handleCreate(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

function requestKeyFromQuery(req) {
  return typeof req.query?.requestKey === "string" ? req.query.requestKey.trim() : "";
}

function requestKeyFromBody(body) {
  return body && typeof body.requestKey === "string" ? body.requestKey.trim() : "";
}

async function loadEligibleRow(res, requestKey) {
  if (!requestKey) {
    res.status(400).json({ error: REQUEST_KEY_REQUIRED });
    return null;
  }
  const store = getBookingRequestStore();
  await store.expirePendingRequests();
  const row = await store.getRequestByKey(requestKey);
  if (!row) {
    res.status(404).json({ error: "Request not found" });
    return null;
  }
  if (!isPaymentEligible(row)) {
    res.status(409).json({ error: NOT_ELIGIBLE, status: row.status });
    return null;
  }
  return { store, row };
}

async function refreshPaidState(store, row) {
  if (row.paymentStatus === "paid") return { row, paid: true };
  if (!row.squareOrderId) return { row, paid: false };

  const client = getSquareClient();
  const response = await client.orders.get({ orderId: row.squareOrderId });
  if (isOrderPaid(response.order)) {
    const paidRow = await store.markPaymentPaid({ id: row.id });
    return { row: paidRow || row, paid: true };
  }
  return { row, paid: false };
}

async function handleStatus(req, res) {
  const loaded = await loadEligibleRow(res, requestKeyFromQuery(req));
  if (!loaded) return undefined;

  try {
    const current = await refreshPaidState(loaded.store, loaded.row);
    return res.status(200).json(summarizePayment(current.row, current.paid));
  } catch {
    return res.status(200).json({
      ...summarizePayment(loaded.row, false),
      paymentStatus: loaded.row.paymentStatus || "not_started",
      paymentStatusPending: true,
    });
  }
}

async function handleCreate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }

  const loaded = await loadEligibleRow(res, requestKeyFromBody(body));
  if (!loaded) return undefined;

  const { store, row } = loaded;
  const current = await refreshPaidState(store, row);
  if (current.paid) {
    return res.status(200).json(summarizePayment(current.row, true));
  }
  if (current.row.paymentLinkUrl) {
    return res.status(200).json(summarizePayment(current.row, false));
  }

  const paymentRequest = buildPaymentLinkRequest(current.row);
  if (!paymentRequest) {
    return res.status(500).json({ error: "Could not prepare payment right now." });
  }

  let response;
  try {
    const client = getSquareClient();
    response = await client.checkout.paymentLinks.create(paymentRequest);
  } catch (error) {
    const safe = safeSquareError(error);
    console.error(
      `Payment link create failed bookingSuffix=${current.row.id.slice(-6)} status=${safe.status ?? "none"} category=${safe.category ?? "none"} code=${safe.code ?? "none"}`,
    );
    return res.status(502).json({ error: "Could not create a Square payment link right now." });
  }

  const link = response.paymentLink;
  const order = response.relatedResources?.orders?.[0];
  const orderId = link?.orderId || order?.id;
  if (!link?.id || !link?.url || !orderId) {
    return res.status(502).json({ error: "Square did not return a usable payment link." });
  }

  const updated = await store.recordPaymentLink({
    id: current.row.id,
    squarePaymentLinkId: link.id,
    squareOrderId: orderId,
    paymentLinkUrl: link.url,
  });

  return res.status(200).json(summarizePayment(updated || current.row, false));
}
